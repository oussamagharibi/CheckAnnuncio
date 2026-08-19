'use strict';

/**
 * CheckAnnuncio — backend Express
 *
 * Endpoint pubblico:
 *   POST /api/analizza  -> analizza un annuncio (immagine base64 e/o testo) con Claude
 *   GET  /api/stato     -> stato del servizio + analisi rimaste per l'IP corrente
 *
 * Nessun database: tutto stateless, tranne il contatore di rate limit in memoria.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');

const SDK = require('@anthropic-ai/sdk');
const Anthropic = SDK.default || SDK;
const APIError = Anthropic.APIError || SDK.APIError;
const AuthenticationError = Anthropic.AuthenticationError || SDK.AuthenticationError;
const RateLimitError = Anthropic.RateLimitError || SDK.RateLimitError;
const BadRequestError = Anthropic.BadRequestError || SDK.BadRequestError;
const APIConnectionError = Anthropic.APIConnectionError || SDK.APIConnectionError;

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const MODELLO = 'claude-sonnet-4-6';
const MAX_IMMAGINE_BYTE = 5 * 1024 * 1024; // 5 MB
const MAX_TESTO_CARATTERI = 8000;
const TIPI_IMMAGINE_AMMESSI = ['image/jpeg', 'image/png', 'image/webp'];
const LIMITE_ANALISI_GIORNALIERE = 10;
const TENTATIVI_JSON = 3; // 1 tentativo + 2 retry se il JSON non è valido
const MAX_ITERAZIONI_TOOL = 4; // giri di "pause_turn" concessi al web fetch
const MAX_TOKEN_PAGINA = 40000; // tetto al contenuto scaricato da una pagina
const MARCATORE_PAGINA_KO = 'PAGINA_NON_LEGGIBILE';

const app = express();

// Su Railway (e dietro qualunque proxy) l'IP reale arriva in X-Forwarded-For.
app.set('trust proxy', true);
app.disable('x-powered-by');

// Il body contiene l'immagine in base64: serve un limite più alto di 5 MB
// perché la codifica base64 aggiunge circa il 33%.
app.use(express.json({ limit: '8mb' }));
// maxAge 0 + ETag: il browser rivalida a ogni caricamento e riceve 304 se nulla
// è cambiato. Con una cache lunga, dopo un deploy si finisce con l'HTML nuovo e
// il JS vecchio — cioè funzionalità visibili ma inerti.
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: 0,
    etag: true,
    lastModified: true
  })
);

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

// ---------------------------------------------------------------------------
// Rate limit in memoria (si azzera a ogni riavvio / redeploy)
// ---------------------------------------------------------------------------

/** @type {Map<string, {giorno: string, conteggio: number}>} */
const contatori = new Map();

function giornoCorrente() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function chiaveIp(req) {
  const inoltrato = req.headers['x-forwarded-for'];
  if (typeof inoltrato === 'string' && inoltrato.length > 0) {
    return inoltrato.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'sconosciuto';
}

function analisiRimaste(ip) {
  const voce = contatori.get(ip);
  if (!voce || voce.giorno !== giornoCorrente()) return LIMITE_ANALISI_GIORNALIERE;
  return Math.max(0, LIMITE_ANALISI_GIORNALIERE - voce.conteggio);
}

function registraAnalisi(ip) {
  const oggi = giornoCorrente();
  const voce = contatori.get(ip);
  if (!voce || voce.giorno !== oggi) {
    contatori.set(ip, { giorno: oggi, conteggio: 1 });
  } else {
    voce.conteggio += 1;
  }
}

// Pulizia periodica delle voci vecchie, per non far crescere la mappa all'infinito.
setInterval(() => {
  const oggi = giornoCorrente();
  for (const [ip, voce] of contatori) {
    if (voce.giorno !== oggi) contatori.delete(ip);
  }
}, 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const PROMPT_SISTEMA = `Sei l'analista anti-truffa di "CheckAnnuncio", un servizio italiano che aiuta le persone comuni a capire se un annuncio di vendita online (auto, moto, telefoni, elettronica, mobili, ecc.) nasconde una truffa o un pessimo affare, PRIMA che paghino.

L'utente ti fornisce lo screenshot di un annuncio (o il suo testo incollato) e alcune informazioni sul proprio profilo. Il tuo compito è produrre una valutazione onesta, concreta e utile, scritta in italiano semplice, da amico esperto: niente burocratese, niente frasi vuote.

## Cosa devi valutare

### 1. RISCHIO TRUFFA (punteggio da 1 a 10)
1-3 = annuncio che sembra normale; 4-6 = qualche elemento da verificare; 7-10 = forti indizi di truffa.
Cerca attivamente questi segnali (e menziona SOLO quelli che vedi davvero nel materiale fornito):
- prezzo palesemente fuori mercato (troppo basso per modello/anno/km/condizioni: il classico specchietto per allodole)
- urgenza artificiale ("solo oggi", "ho tante richieste", "primo che arriva", "parto domani")
- richieste di pagamento anomale: caparra/acconto prima di vedere l'oggetto, ricarica PostePay, bonifico verso l'estero, buoni regalo, criptovalute, "spedizione con corriere che fa da garante", finti sistemi di protezione acquisti
- rifiuto o elusione dell'incontro di persona / della videochiamata
- foto generiche, palesemente prese dal web, stock, con watermark, poche o di bassa qualità, oppure incoerenti tra loro
- descrizione copiata, vaga, piena di errori, tradotta male, senza dati identificativi (targa, IMEI, seriale, anno)
- venditore appena iscritto, senza recensioni, o che sposta subito la conversazione su WhatsApp/Telegram
- documenti mancanti o "in arrivo", storia dell'oggetto poco credibile
- per i telefoni: possibile blocco iCloud/Google, IMEI non fornito, prezzo da top di gamma nuovo a metà valore
- per le auto: km incoerenti con anno/usura, "unico proprietario" non verificabile, revisione/bollo non citati, auto "in permuta per conto di un amico"
Se il materiale non basta per giudicare un aspetto, dillo apertamente invece di inventare.

### 2. VALUTAZIONE DI COERENZA
Prezzo, chilometraggio, anno, stato dichiarato e accessori: tornano tra loro? Il prezzo è in linea con il mercato italiano dell'usato per quel modello? Segnala esplicitamente ciò che non quadra e ciò che invece è ragionevole.

### 3. INCROCIO CON IL PROFILO UTENTE (solo per la categoria "auto")
Se l'utente ha compilato il profilo, valuta se QUELL'auto è adatta a LUI e includi questi giudizi tra i dettagli della valutazione:
- altezza: oltre ~185 cm servono abitabilità e seduta alta (SUV/crossover/monovolume), attenzione a coupé e citycar basse; sotto ~165 cm attenzione a soglie e visibilità
- zona: città = auto compatta, cambio automatico, motore benzina/ibrido (il diesel in città con pochi km si intasa: FAP/DPF); montagna = trazione integrale o buone gomme, coppia sufficiente; campagna/tanti km extraurbani = diesel o ibrido efficiente ancora sensato
- km annui previsti: sotto ~12.000 km/anno il diesel è quasi sempre la scelta sbagliata; sopra ~20.000 km/anno benzina puro diventa costoso
- budget: l'annuncio rientra nel budget? Ricorda i costi accessori (passaggio di proprietà, assicurazione, bollo, tagliando, gomme)
- neopatentato: verifica il limite di legge italiano (per i primi 12 mesi: potenza specifica max 55 kW/t e potenza max 70 kW per le auto). Se il veicolo rischia di sforare, avvisa chiaramente e suggerisci di controllare kW e massa sul libretto.

### 4. DOMANDE DA FARE AL VENDITORE
Genera da 5 a 7 domande specifiche su QUESTO annuncio (mai generiche), scritte come le scriverebbe l'utente in chat, pronte da copiare e incollare. Devono servire a smascherare una truffa o a far emergere difetti nascosti: richiesta di dati identificativi, foto aggiuntive con dettaglio richiesto, storia manutentiva, disponibilità a incontrarsi/videochiamare, modalità di pagamento, documenti.

## Formato della risposta (OBBLIGATORIO)

Rispondi ESCLUSIVAMENTE con un oggetto JSON valido, senza testo prima o dopo, senza blocchi di codice markdown, senza commenti. Schema esatto:

{
  "rischio": {
    "punteggio": <numero intero da 1 a 10>,
    "segnali": [
      {
        "livello": "<rosso|giallo|verde>",
        "titolo": "<max 60 caratteri, il segnale in sintesi>",
        "dettaglio": "<1-2 frasi che spiegano perché, citando ciò che si vede nell'annuncio>"
      }
    ]
  },
  "valutazione": {
    "verdetto": "<2-4 frasi di sintesi sulla congruenza di prezzo, km e condizioni, e sull'adeguatezza al profilo utente se disponibile>",
    "dettagli": [
      {
        "etichetta": "<max 28 caratteri, es. 'Prezzo', 'Chilometraggio', 'Adatto alla tua altezza'>",
        "stato": "<ok|attenzione|critico|info>",
        "testo": "<1-2 frasi concrete>"
      }
    ]
  },
  "domande": [
    "<domanda 1 pronta da inviare al venditore>"
  ]
}

Regole rigide:
- "segnali": da 3 a 7 elementi. Usa "verde" anche per gli elementi rassicuranti, così l'utente vede un quadro equilibrato.
- "dettagli": da 3 a 8 elementi. Per la categoria "auto" con profilo compilato, almeno 2 devono riguardare l'adeguatezza al profilo dell'utente.
- "domande": da 5 a 7 stringhe, ognuna una singola domanda, senza numerazione iniziale.
- Nessun campo aggiuntivo, nessun campo mancante.
- Tutto il testo in italiano, con il "tu".
- Se il materiale fornito è illeggibile o non è un annuncio di vendita, restituisci comunque il JSON: punteggio basso, un segnale di livello "giallo" che lo spiega, e domande generiche ma utili.`;

function costruisciPromptUtente(dati) {
  const righe = [];
  righe.push('Analizza questo annuncio.');
  righe.push('');
  righe.push(`Categoria dichiarata dall'utente: ${dati.categoria}`);

  if (dati.categoria === 'auto') {
    const p = dati.profilo || {};
    righe.push('');
    righe.push("Profilo dell'utente (usalo per i consigli sull'auto):");
    righe.push(`- Altezza: ${p.altezza ? p.altezza + ' cm' : 'non indicata'}`);
    righe.push(`- Zona di utilizzo prevalente: ${p.zona || 'non indicata'}`);
    righe.push(`- Km annui previsti: ${p.kmAnnui ? p.kmAnnui + ' km/anno' : 'non indicati'}`);
    righe.push(`- Budget massimo: ${p.budget ? p.budget + ' €' : 'non indicato'}`);
    righe.push(`- Neopatentato: ${p.neopatentato === true ? 'sì' : p.neopatentato === false ? 'no' : 'non indicato'}`);
  }

  if (dati.link) {
    righe.push('');
    righe.push(`Link all'annuncio fornito dall'utente: ${dati.link}`);
    righe.push(
      "Apri questo link con lo strumento web_fetch PRIMA di analizzare, e basa la valutazione sul contenuto reale della pagina (titolo, prezzo, anno, km, descrizione, dati del venditore)."
    );
    righe.push(
      `Se la pagina non è raggiungibile, è una schermata di verifica anti-bot ("dimostra di essere umano"), una pagina di login, un 404, un annuncio già rimosso, oppure comunque non contiene un annuncio leggibile, NON inventare nulla e NON dedurre dall'URL: rispondi con il JSON dello schema in cui "valutazione.verdetto" inizia esattamente con "${MARCATORE_PAGINA_KO}:" seguito da una frase che spiega cosa hai trovato al posto dell'annuncio.`
    );
  }

  if (dati.testo) {
    righe.push('');
    righe.push("Testo dell'annuncio incollato dall'utente:");
    righe.push('"""');
    righe.push(dati.testo);
    righe.push('"""');
  }

  if (dati.immagine) {
    righe.push('');
    righe.push("Nell'immagine allegata trovi lo screenshot dell'annuncio: leggi con attenzione prezzo, titolo, descrizione, dati del veicolo/oggetto e ogni informazione sul venditore.");
  }

  righe.push('');
  righe.push('Rispondi solo con il JSON previsto dallo schema.');
  return righe.join('\n');
}

// ---------------------------------------------------------------------------
// Validazione dell'input
// ---------------------------------------------------------------------------

const CATEGORIE = ['auto', 'telefono', 'altro'];
const ZONE = ['citta', 'montagna', 'campagna'];

class ErroreUtente extends Error {
  constructor(codice, messaggio) {
    super(messaggio);
    this.codice = codice;
  }
}

/**
 * Estrae e valida un'immagine ricevuta come data URL o base64 puro.
 * @returns {{mediaType: string, dati: string} | null}
 */
function validaImmagine(immagine, tipoDichiarato) {
  if (!immagine) return null;

  if (typeof immagine !== 'string') {
    throw new ErroreUtente('immagine_non_valida', "Il formato dell'immagine non è valido. Ricarica lo screenshot.");
  }

  let mediaType = typeof tipoDichiarato === 'string' ? tipoDichiarato.toLowerCase() : '';
  let base64 = immagine;

  const corrispondenza = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(immagine.trim());
  if (corrispondenza) {
    mediaType = corrispondenza[1].toLowerCase();
    base64 = corrispondenza[2];
  }

  if (mediaType === 'image/jpg') mediaType = 'image/jpeg';

  if (!TIPI_IMMAGINE_AMMESSI.includes(mediaType)) {
    throw new ErroreUtente(
      'formato_non_supportato',
      'Formato immagine non supportato: accettiamo solo JPG, PNG o WEBP.'
    );
  }

  base64 = base64.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length < 100) {
    throw new ErroreUtente('immagine_non_valida', "L'immagine sembra danneggiata. Prova a ricaricarla.");
  }

  const byteStimati = Math.floor((base64.length * 3) / 4);
  if (byteStimati > MAX_IMMAGINE_BYTE) {
    throw new ErroreUtente(
      'immagine_troppo_grande',
      'Lo screenshot supera i 5 MB. Riducilo o fai uno screenshot più piccolo.'
    );
  }

  return { mediaType, dati: base64 };
}

// Host che non hanno senso per un annuncio pubblico: li rifiutiamo subito.
const HOST_VIETATI = /^(localhost|.*\.local|.*\.internal|\[?::1\]?|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*)$/i;

/**
 * Valida l'URL di un annuncio.
 * @returns {{url: string, host: string} | null}
 */
function validaLink(valore) {
  if (valore === undefined || valore === null || valore === '') return null;

  if (typeof valore !== 'string') {
    throw new ErroreUtente('link_non_valido', "Il link non è valido. Incolla l'indirizzo completo dell'annuncio.");
  }

  let grezzo = valore.trim();
  if (!grezzo) return null;

  // Tolleriamo l'incolla senza schema ("subito.it/...").
  if (!/^[a-z][a-z0-9+.-]*:/i.test(grezzo)) grezzo = 'https://' + grezzo;

  let url;
  try {
    url = new URL(grezzo);
  } catch (_) {
    throw new ErroreUtente('link_non_valido', "Il link non è valido. Incolla l'indirizzo completo dell'annuncio.");
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ErroreUtente('link_non_valido', 'Sono ammessi solo link http o https.');
  }

  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || HOST_VIETATI.test(host)) {
    throw new ErroreUtente('link_non_valido', 'Questo indirizzo non è un annuncio pubblico raggiungibile.');
  }

  if (url.href.length > 2000) {
    throw new ErroreUtente('link_non_valido', 'Il link è troppo lungo: copialo di nuovo dalla barra degli indirizzi.');
  }

  return { url: url.href, host };
}

function validaRichiesta(corpo) {
  if (!corpo || typeof corpo !== 'object') {
    throw new ErroreUtente('richiesta_non_valida', 'Richiesta non valida. Ricarica la pagina e riprova.');
  }

  const categoria = typeof corpo.categoria === 'string' ? corpo.categoria.toLowerCase() : '';
  if (!CATEGORIE.includes(categoria)) {
    throw new ErroreUtente('categoria_mancante', 'Scegli una categoria: Auto, Telefono o Altro.');
  }

  let testo = typeof corpo.testo === 'string' ? corpo.testo.trim() : '';
  if (testo.length > MAX_TESTO_CARATTERI) {
    testo = testo.slice(0, MAX_TESTO_CARATTERI);
  }

  const immagine = validaImmagine(corpo.immagine, corpo.tipoImmagine);
  const link = validaLink(corpo.link);

  if (!immagine && !link && testo.length < 20) {
    throw new ErroreUtente(
      'contenuto_mancante',
      "Carica lo screenshot dell'annuncio, incolla il link oppure il testo (almeno 20 caratteri)."
    );
  }

  const profilo = {};
  if (categoria === 'auto' && corpo.profilo && typeof corpo.profilo === 'object') {
    const p = corpo.profilo;
    const altezza = Number(p.altezza);
    if (Number.isFinite(altezza) && altezza >= 120 && altezza <= 230) profilo.altezza = Math.round(altezza);

    if (typeof p.zona === 'string' && ZONE.includes(p.zona.toLowerCase())) {
      profilo.zona = { citta: 'città', montagna: 'montagna', campagna: 'campagna' }[p.zona.toLowerCase()];
    }

    const kmAnnui = Number(p.kmAnnui);
    if (Number.isFinite(kmAnnui) && kmAnnui >= 0 && kmAnnui <= 200000) profilo.kmAnnui = Math.round(kmAnnui);

    const budget = Number(p.budget);
    if (Number.isFinite(budget) && budget >= 0 && budget <= 5000000) profilo.budget = Math.round(budget);

    if (typeof p.neopatentato === 'boolean') profilo.neopatentato = p.neopatentato;
  }

  return {
    categoria,
    testo,
    immagine,
    profilo,
    link: link ? link.url : null,
    hostLink: link ? link.host : null
  };
}

// ---------------------------------------------------------------------------
// Validazione della risposta dell'AI
// ---------------------------------------------------------------------------

function estraiJson(testo) {
  if (typeof testo !== 'string') return null;

  let grezzo = testo.trim();

  // Rimuove eventuali recinti markdown ```json ... ```
  const recinto = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(grezzo);
  if (recinto) grezzo = recinto[1].trim();

  try {
    return JSON.parse(grezzo);
  } catch (_) {
    // Ultimo tentativo: isola il primo oggetto JSON bilanciato presente nel testo.
  }

  const inizio = grezzo.indexOf('{');
  if (inizio === -1) return null;

  let profondita = 0;
  let dentroStringa = false;
  let escape = false;

  for (let i = inizio; i < grezzo.length; i++) {
    const c = grezzo[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      dentroStringa = !dentroStringa;
      continue;
    }
    if (dentroStringa) continue;
    if (c === '{') profondita++;
    else if (c === '}') {
      profondita--;
      if (profondita === 0) {
        try {
          return JSON.parse(grezzo.slice(inizio, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function stringaPulita(valore, maxLunghezza) {
  if (typeof valore !== 'string') return '';
  const pulita = valore.replace(/\s+/g, ' ').trim();
  return pulita.length > maxLunghezza ? pulita.slice(0, maxLunghezza - 1).trimEnd() + '…' : pulita;
}

/**
 * Verifica che la risposta rispetti lo schema e la normalizza.
 * Lancia un Error se lo schema non è rispettato (così scatta il retry).
 */
function validaSchema(oggetto) {
  if (!oggetto || typeof oggetto !== 'object' || Array.isArray(oggetto)) {
    throw new Error('La risposta non è un oggetto JSON.');
  }

  const rischio = oggetto.rischio;
  if (!rischio || typeof rischio !== 'object') throw new Error('Campo "rischio" mancante.');

  let punteggio = Number(rischio.punteggio);
  if (!Number.isFinite(punteggio)) throw new Error('Campo "rischio.punteggio" non numerico.');
  punteggio = Math.min(10, Math.max(1, Math.round(punteggio)));

  if (!Array.isArray(rischio.segnali) || rischio.segnali.length === 0) {
    throw new Error('Campo "rischio.segnali" mancante o vuoto.');
  }

  const livelliAmmessi = ['rosso', 'giallo', 'verde'];
  const segnali = rischio.segnali
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const livello = typeof s.livello === 'string' ? s.livello.toLowerCase() : '';
      return {
        livello: livelliAmmessi.includes(livello) ? livello : 'giallo',
        titolo: stringaPulita(s.titolo, 80),
        dettaglio: stringaPulita(s.dettaglio, 400)
      };
    })
    .filter((s) => s.titolo || s.dettaglio)
    .slice(0, 8);

  if (segnali.length === 0) throw new Error('Nessun segnale utilizzabile in "rischio.segnali".');

  const valutazione = oggetto.valutazione;
  if (!valutazione || typeof valutazione !== 'object') throw new Error('Campo "valutazione" mancante.');

  const verdetto = stringaPulita(valutazione.verdetto, 700);
  if (!verdetto) throw new Error('Campo "valutazione.verdetto" vuoto.');

  if (!Array.isArray(valutazione.dettagli) || valutazione.dettagli.length === 0) {
    throw new Error('Campo "valutazione.dettagli" mancante o vuoto.');
  }

  const statiAmmessi = ['ok', 'attenzione', 'critico', 'info'];
  const dettagli = valutazione.dettagli
    .filter((d) => d && typeof d === 'object')
    .map((d) => {
      const stato = typeof d.stato === 'string' ? d.stato.toLowerCase() : '';
      return {
        etichetta: stringaPulita(d.etichetta, 40) || 'Dettaglio',
        stato: statiAmmessi.includes(stato) ? stato : 'info',
        testo: stringaPulita(d.testo, 400)
      };
    })
    .filter((d) => d.testo)
    .slice(0, 10);

  if (dettagli.length === 0) throw new Error('Nessun dettaglio utilizzabile in "valutazione.dettagli".');

  if (!Array.isArray(oggetto.domande)) throw new Error('Campo "domande" mancante.');

  const domande = oggetto.domande
    .map((d) => stringaPulita(d, 300).replace(/^\s*\d+[).\-]\s*/, ''))
    .filter(Boolean)
    .slice(0, 7);

  if (domande.length < 3) throw new Error('Servono almeno 3 domande in "domande".');

  return {
    rischio: { punteggio, segnali },
    valutazione: { verdetto, dettagli },
    domande
  };
}

// ---------------------------------------------------------------------------
// Chiamata all'AI, con retry se il JSON non è valido
// ---------------------------------------------------------------------------

function costruisciContenutoUtente(dati) {
  const contenuto = [];
  if (dati.immagine) {
    contenuto.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: dati.immagine.mediaType,
        data: dati.immagine.dati
      }
    });
  }
  contenuto.push({ type: 'text', text: costruisciPromptUtente(dati) });
  return contenuto;
}

const MESSAGGI_FETCH = {
  url_not_accessible:
    "Non riusciamo ad aprire questo link: il sito blocca la lettura automatica oppure l'annuncio non esiste più.",
  unsupported_content_type: 'Questo link non porta a una pagina leggibile (potrebbe essere un file o un video).',
  too_many_requests: 'Il sito dell\'annuncio ci sta limitando le richieste. Riprova tra qualche minuto.',
  url_not_allowed: 'Questo indirizzo non può essere letto automaticamente.',
  max_uses_exceeded: "Non siamo riusciti ad arrivare alla pagina dell'annuncio."
};

/** Errore "link non leggibile", con il consiglio di ripiegare sullo screenshot. */
function erroreLinkNonLeggibile(codice) {
  const base = MESSAGGI_FETCH[codice] || "Non siamo riusciti a leggere l'annuncio da questo link.";
  const errore = new ErroreUtente(
    'link_non_leggibile',
    base + " Fai uno screenshot dell'annuncio e caricalo: funziona sempre."
  );
  errore.dettaglio = codice || 'nessun_fetch';
  return errore;
}

/** Blocchi di testo della risposta: prima l'ultimo da solo, poi tutti uniti. */
function candidatiTesto(risposta) {
  const blocchi = risposta.content
    .filter((blocco) => blocco.type === 'text')
    .map((blocco) => String(blocco.text || '').trim())
    .filter(Boolean);

  if (blocchi.length === 0) return [];
  if (blocchi.length === 1) return [blocchi[0]];
  return [blocchi[blocchi.length - 1], blocchi.join('\n')];
}

function primoJsonValido(risposta) {
  let ultimoErrore = new Error('La risposta non contiene testo.');
  for (const candidato of candidatiTesto(risposta)) {
    try {
      return validaSchema(estraiJson(candidato));
    } catch (errore) {
      ultimoErrore = errore;
    }
  }
  throw ultimoErrore;
}

/**
 * Esegue un turno, riprendendo automaticamente i "pause_turn" del web fetch.
 * Registra in `esitoFetch` come è andato lo scaricamento della pagina.
 */
async function eseguiTurno(messaggi, strumenti, esitoFetch) {
  for (let iterazione = 1; ; iterazione++) {
    const richiesta = {
      model: MODELLO,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: PROMPT_SISTEMA,
      messages: messaggi
    };
    if (strumenti) richiesta.tools = strumenti;

    const risposta = await client.messages.create(richiesta);

    for (const blocco of risposta.content) {
      if (blocco.type !== 'web_fetch_tool_result') continue;
      esitoFetch.tentato = true;
      const contenuto = blocco.content;
      if (contenuto && contenuto.type === 'web_fetch_result') {
        esitoFetch.riuscito = true;
      } else if (contenuto && contenuto.error_code) {
        esitoFetch.codiceErrore = contenuto.error_code;
      }
    }

    if (risposta.stop_reason === 'pause_turn' && iterazione < MAX_ITERAZIONI_TOOL) {
      messaggi.push({ role: 'assistant', content: risposta.content });
      continue;
    }

    return risposta;
  }
}

async function analizzaConAI(dati) {
  const messaggi = [{ role: 'user', content: costruisciContenutoUtente(dati) }];
  const esitoFetch = { tentato: false, riuscito: false, codiceErrore: null };
  const strumenti = dati.link
    ? [
        {
          type: 'web_fetch_20260209',
          name: 'web_fetch',
          max_uses: 3,
          allowed_domains: [dati.hostLink],
          max_content_tokens: MAX_TOKEN_PAGINA
        }
      ]
    : null;

  let ultimoErrore = null;

  for (let tentativo = 1; tentativo <= TENTATIVI_JSON; tentativo++) {
    const risposta = await eseguiTurno(messaggi, strumenti, esitoFetch);

    if (risposta.stop_reason === 'refusal') {
      throw new ErroreUtente(
        'rifiuto_modello',
        "L'AI non è riuscita ad analizzare questo contenuto. Prova con un altro screenshot."
      );
    }

    // Il link era l'unico materiale ma la pagina non è stata letta: meglio
    // fermarsi che restituire un'analisi inventata sull'URL.
    if (dati.link && !dati.immagine && !dati.testo && !esitoFetch.riuscito) {
      throw erroreLinkNonLeggibile(esitoFetch.codiceErrore);
    }

    try {
      const analisi = primoJsonValido(risposta);

      if (analisi.valutazione.verdetto.startsWith(MARCATORE_PAGINA_KO)) {
        if (!dati.immagine && !dati.testo) {
          throw erroreLinkNonLeggibile('contenuto_non_analizzabile');
        }
        // C'è altro materiale: togliamo il marcatore e proseguiamo.
        analisi.valutazione.verdetto = analisi.valutazione.verdetto
          .replace(new RegExp('^' + MARCATORE_PAGINA_KO + '\\s*:?\\s*'), '')
          .trim();
      }

      if (tentativo > 1) {
        console.warn(`[analizza] JSON valido solo al tentativo ${tentativo}`);
      }
      return analisi;
    } catch (errore) {
      if (errore instanceof ErroreUtente) throw errore;

      ultimoErrore = errore;
      console.warn(`[analizza] tentativo ${tentativo}/${TENTATIVI_JSON} scartato: ${errore.message}`);

      if (tentativo === TENTATIVI_JSON) break;

      // Retry: rimettiamo in coda il turno sbagliato (con i risultati del fetch,
      // altrimenti la pagina scaricata andrebbe persa) e chiediamo la correzione.
      messaggi.push({
        role: 'assistant',
        content: risposta.content && risposta.content.length ? risposta.content : '(risposta vuota)'
      });
      messaggi.push({
        role: 'user',
        content:
          `La risposta precedente non è utilizzabile (${errore.message}). ` +
          'Riscrivila ORA come singolo oggetto JSON valido conforme allo schema richiesto, ' +
          'senza testo introduttivo, senza spiegazioni e senza blocchi di codice markdown.'
      });
    }
  }

  const erroreFinale = new ErroreUtente(
    'json_non_valido',
    "L'AI ha risposto in un formato che non siamo riusciti a leggere. Riprova tra qualche secondo."
  );
  erroreFinale.dettaglio = ultimoErrore ? ultimoErrore.message : 'formato sconosciuto';
  throw erroreFinale;
}

// ---------------------------------------------------------------------------
// Rotte
// ---------------------------------------------------------------------------

app.get('/api/stato', (req, res) => {
  res.json({
    ok: true,
    configurato: Boolean(client),
    limiteGiornaliero: LIMITE_ANALISI_GIORNALIERE,
    analisiRimaste: analisiRimaste(chiaveIp(req))
  });
});

app.post('/api/analizza', async (req, res) => {
  const ip = chiaveIp(req);

  if (!client) {
    return res.status(503).json({
      errore: 'chiave_mancante',
      messaggio:
        'Il servizio non è configurato: manca la chiave API. Se sei tu il proprietario, imposta ANTHROPIC_API_KEY.'
    });
  }

  if (analisiRimaste(ip) <= 0) {
    return res.status(429).json({
      errore: 'limite_raggiunto',
      messaggio: `Hai usato tutte le ${LIMITE_ANALISI_GIORNALIERE} analisi gratuite di oggi. Torna domani — nel frattempo, non pagare nulla in anticipo. 🙂`,
      analisiRimaste: 0
    });
  }

  let dati;
  try {
    dati = validaRichiesta(req.body);
  } catch (errore) {
    if (errore instanceof ErroreUtente) {
      return res.status(400).json({ errore: errore.codice, messaggio: errore.message });
    }
    throw errore;
  }

  try {
    const analisi = await analizzaConAI(dati);
    registraAnalisi(ip);
    return res.json({ ...analisi, analisiRimaste: analisiRimaste(ip) });
  } catch (errore) {
    if (errore instanceof ErroreUtente) {
      const stato = errore.codice === 'json_non_valido' ? 502 : 400;
      if (errore.dettaglio) console.error(`[analizza] ${errore.codice}: ${errore.dettaglio}`);
      return res.status(stato).json({ errore: errore.codice, messaggio: errore.message });
    }

    if (AuthenticationError && errore instanceof AuthenticationError) {
      console.error('[analizza] chiave API rifiutata:', errore.message);
      return res.status(502).json({
        errore: 'chiave_non_valida',
        messaggio: 'La chiave API del servizio non è valida. Riprova più tardi.'
      });
    }

    if (RateLimitError && errore instanceof RateLimitError) {
      return res.status(503).json({
        errore: 'ai_sovraccarica',
        messaggio: "Troppe richieste verso l'AI in questo momento. Riprova tra un minuto."
      });
    }

    if (BadRequestError && errore instanceof BadRequestError) {
      console.error('[analizza] richiesta rifiutata dall\'API:', errore.message);
      return res.status(400).json({
        errore: 'richiesta_rifiutata',
        messaggio: "L'immagine o il testo non sono stati accettati. Prova con uno screenshot più leggero o incolla il testo."
      });
    }

    if (APIConnectionError && errore instanceof APIConnectionError) {
      console.error('[analizza] connessione fallita:', errore.message, errore.cause || '');
      return res.status(503).json({
        errore: 'ai_irraggiungibile',
        messaggio: "Non riusciamo a contattare l'AI in questo momento. Riprova tra poco."
      });
    }

    if (APIError && errore instanceof APIError) {
      console.error(`[analizza] errore API ${errore.status}:`, errore.message);
      return res.status(503).json({
        errore: 'ai_non_disponibile',
        messaggio: "Il servizio di analisi non è raggiungibile in questo momento. Riprova tra poco."
      });
    }

    console.error('[analizza] errore inatteso:', errore);
    return res.status(500).json({
      errore: 'errore_interno',
      messaggio: 'Qualcosa è andato storto durante l\'analisi. Riprova tra qualche istante.'
    });
  }
});

// Body troppo grande o JSON malformato -> messaggio chiaro invece della pagina di errore di Express.
app.use((errore, req, res, next) => {
  if (errore && errore.type === 'entity.too.large') {
    return res.status(413).json({
      errore: 'immagine_troppo_grande',
      messaggio: 'Lo screenshot è troppo pesante (max 5 MB). Riducilo e riprova.'
    });
  }
  if (errore && errore.type === 'entity.parse.failed') {
    return res.status(400).json({
      errore: 'richiesta_non_valida',
      messaggio: 'Richiesta non valida. Ricarica la pagina e riprova.'
    });
  }
  if (errore) {
    console.error('[server] errore non gestito:', errore);
    return res.status(500).json({
      errore: 'errore_interno',
      messaggio: 'Errore interno del server. Riprova tra qualche istante.'
    });
  }
  return next();
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ errore: 'non_trovato', messaggio: 'Endpoint inesistente.' });
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CheckAnnuncio in ascolto su http://localhost:${PORT}`);
  if (!client) {
    console.warn('ATTENZIONE: ANTHROPIC_API_KEY non impostata — /api/analizza risponderà con un errore.');
  }
});
