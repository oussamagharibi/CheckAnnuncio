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
const MAX_IMMAGINI = 4; // foto per analisi
const MAX_IMMAGINE_BYTE = 5 * 1024 * 1024; // 5 MB per foto
const MAX_TOTALE_IMMAGINI_BYTE = 12 * 1024 * 1024; // 12 MB per richiesta
const MAX_TESTO_CARATTERI = 8000;
const MAX_OGGETTO_CARATTERI = 200;
const TIPI_IMMAGINE_AMMESSI = ['image/jpeg', 'image/png', 'image/webp'];
const LIMITE_ANALISI_GIORNALIERE = 10;
const TENTATIVI_JSON = 3; // 1 tentativo + 2 retry se il JSON non è valido
const MAX_ITERAZIONI_TOOL = 4; // giri di "pause_turn" concessi al web fetch
const MAX_TOKEN_PAGINA = 12000; // tetto al contenuto scaricato da una pagina
const MARCATORE_PAGINA_KO = 'PAGINA_NON_LEGGIBILE';

// Listino claude-sonnet-4-6, dollari per milione di token.
const PREZZI_USD_PER_MILIONE = {
  input: 3.0,
  output: 15.0,
  letturaCache: 0.3,
  scritturaCache: 3.75
};

const app = express();

// Su Railway (e dietro qualunque proxy) l'IP reale arriva in X-Forwarded-For.
app.set('trust proxy', true);
app.disable('x-powered-by');

// Il body contiene le foto in base64: serve un limite più alto dei 12 MB
// complessivi, perché la codifica base64 aggiunge circa il 33%.
app.use(express.json({ limit: '18mb' }));
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

## La data conta

All'inizio del messaggio dell'utente trovi sempre la data di oggi. Non è un dettaglio decorativo: usala e non fidarti della tua idea di "anno corrente", che è quasi sempre indietro rispetto alla realtà.
- Calcola l'età reale del veicolo/oggetto rispetto a OGGI, non rispetto a un anno che ricordi. Un'auto del 2015 nel 2026 ha 11 anni, non 10.
- Deprezzamento: il valore dell'usato cala ogni anno che passa. Un prezzo giusto due anni fa oggi è fuori mercato.
- Scadenze: revisione (in Italia la prima a 4 anni dall'immatricolazione, poi ogni 2), garanzia di fabbrica, bollo. Calcolale sulla data di oggi e di' se sono in scadenza o già scadute.
- Stagionalità dei prezzi, che sposta il valore anche del 10-15%:
  - cabrio, spider e decappottabili: care in primavera/estate, molto più trattabili da ottobre a febbraio
  - 4x4, SUV e fuoristrada: richiesti in autunno/inverno, più trattabili in primavera
  - moto e scooter: idem, picco a marzo-giugno
  - climatizzatori e condizionatori: cari a giugno-agosto; stufe e caldaie: care a ottobre-gennaio
  - gommato invernale/termico incluso vale in autunno, molto meno a maggio
  - fine anno (novembre-dicembre) e agosto: mercato lento, più margine di trattativa
- Se l'annuncio propone un prezzo da alta stagione fuori stagione (o viceversa), dillo: è un margine di trattativa concreto per l'utente.
- Se citi una scadenza o un calcolo di età, mostra il conto ("immatricolata 03/2015, quindi 11 anni a oggi").

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
- per gli altri oggetti (elettronica, bici, elettrodomestici, mobili, strumenti musicali, attrezzi): numero di seriale, scontrino o garanzia mai citati; nessuna foto dei segni d'uso reali; "ancora imballato / mai usato" a prezzo da usato; accessori originali non mostrati; impossibilità di provarlo acceso prima di pagare; per la bici, assenza del numero di telaio (spesso è refurtiva)
Se il materiale non basta per giudicare un aspetto, dillo apertamente invece di inventare.

### 2. VALUTAZIONE DI COERENZA
Prezzo, chilometraggio, anno, stato dichiarato e accessori: tornano tra loro? Il prezzo è in linea con il mercato italiano dell'usato per quel modello? Segnala esplicitamente ciò che non quadra e ciò che invece è ragionevole.

### 3. INCROCIO CON IL PROFILO UTENTE (solo per la categoria "auto", solo se richiesto)
Questa sezione vale SOLO se il messaggio dell'utente contiene un profilo compilato. Se il profilo non c'è, salta del tutto questa parte: niente consigli su altezza, peso o adeguatezza personale, nemmeno accennati.
Quando il profilo c'è, valuta se QUELL'auto è adatta a LUI e includi questi giudizi tra i dettagli della valutazione. Usa solo i dati effettivamente indicati: se un campo è "non indicato", ignoralo invece di ipotizzarlo.
- altezza: oltre ~185 cm servono abitabilità e seduta alta (SUV/crossover/monovolume), attenzione a coupé e citycar basse, e al tetto panoramico che ruba spazio in testa; sotto ~165 cm attenzione a soglie, visibilità e regolazione in altezza del sedile
- peso: oltre ~100 kg conta il supporto del sedile (meglio sedili ampi con regolazione elettrica e lombare), l'accesso a bordo su auto molto basse, e la portata utile se viaggia con più passeggeri o carico; sotto ~55 kg attenzione alla posizione di guida su auto grandi (distanza dai pedali, visibilità)
- altezza e peso insieme: se entrambi sono elevati, evita segmenti A/B e coupé, e privilegia auto con passo lungo e porte ampie
- zona: città = auto compatta, cambio automatico, motore benzina/ibrido (il diesel in città con pochi km si intasa: FAP/DPF); montagna = trazione integrale o buone gomme, coppia sufficiente; campagna/tanti km extraurbani = diesel o ibrido efficiente ancora sensato
- km annui previsti: sotto ~12.000 km/anno il diesel è quasi sempre la scelta sbagliata; sopra ~20.000 km/anno benzina puro diventa costoso
- budget: l'annuncio rientra nel budget? Ricorda i costi accessori (passaggio di proprietà, assicurazione, bollo, tagliando, gomme)
- neopatentato: verifica il limite di legge italiano (per i primi 12 mesi: potenza specifica max 55 kW/t e potenza max 70 kW per le auto). Se il veicolo rischia di sforare, avvisa chiaramente e suggerisci di controllare kW e massa sul libretto.

### 4. AFFIDABILITÀ E PROBLEMI NOTI DEL MODELLO
Questa parte è obbligatoria per la categoria "auto", e va compilata anche quando l'annuncio è pulitissimo e il venditore è serio: un'auto senza truffa può comunque essere una pessima auto.
Identifica il modello, l'allestimento, la motorizzazione e il cambio dal materiale fornito, poi elenca i punti deboli NOTI di QUELLA combinazione — non genericità valide per qualsiasi auto.
Copri, quando pertinenti:
- motore: catena o cinghia di distribuzione (e a che km va sostituita), consumo d'olio, guarnizione testata, pompa acqua, iniettori, candelette, turbina, valvola EGR
- alimentazione diesel: FAP/DPF che si intasa nei percorsi urbani brevi, additivo AdBlue, ricircolo gas
- trasmissione: cambi automatici e robotizzati problematici (es. mecatronica dei doppia frizione a secco), frizione, volano bimassa, giunti omocinetici
- ibride ed elettriche: degrado della batteria ad alta tensione, costo di sostituzione, garanzia residua sulla batteria, inverter
- elettronica e resto: centraline, sensori, infiltrazioni d'acqua, corrosione, sospensioni pneumatiche, catalizzatore
- richiami ufficiali e casi noti che riguardano quel motore o quegli anni di produzione
Per ogni problema indica a quali chilometraggi o età si manifesta di solito e l'ordine di grandezza del costo di riparazione in euro, in Italia. Se non conosci il costo con ragionevole precisione, scrivi che è da preventivare invece di inventare una cifra.
Indica anche come si verifica su QUESTO esemplare: cosa chiedere, cosa guardare, quale documento farsi mostrare.
Se dal materiale non riesci a identificare con certezza la motorizzazione, dillo apertamente e ragiona sul modello in generale, segnalando che serve conferma.
Per le categorie "telefono" e "altro" compila questa sezione solo se conosci difetti ricorrenti di quel prodotto (batteria che degrada, scocca che si crepa, blocco operatore, componenti fuori produzione); altrimenti restituisci un elenco vuoto e un verdetto che lo spiega.

### 5. DOMANDE DA FARE AL VENDITORE
Genera da 5 a 7 domande specifiche su QUESTO annuncio (mai generiche), scritte come le scriverebbe l'utente in chat, pronte da copiare e incollare. Devono servire a smascherare una truffa o a far emergere difetti nascosti: richiesta di dati identificativi, foto aggiuntive con dettaglio richiesto, storia manutentiva, disponibilità a incontrarsi/videochiamare, modalità di pagamento, documenti.
Per la categoria "auto", almeno 2 domande devono puntare dritte ai problemi noti elencati al punto 4 (per esempio: fattura del cambio catena, comportamento del cambio a freddo, rigenerazioni del FAP, stato di salute della batteria).

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
  "affidabilita": {
    "verdetto": "<2-4 frasi: quanto è affidabile questa specifica motorizzazione/modello, cosa aspettarsi ai chilometri attuali>",
    "problemi": [
      {
        "componente": "<max 40 caratteri, es. 'Catena di distribuzione', 'Cambio DSG DQ200', 'FAP'>",
        "gravita": "<alta|media|bassa>",
        "descrizione": "<qual è il problema, a che km o età si presenta, ordine di grandezza del costo in euro>",
        "verifica": "<come capire se QUESTO esemplare ce l'ha: cosa chiedere, guardare o farsi mostrare>"
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
- "affidabilita.problemi": da 3 a 6 elementi per la categoria "auto". Devono riguardare QUELLA motorizzazione, non l'automobile in generale: "controlla i freni" non è un punto debole noto. Per "telefono" e "altro" l'elenco può essere vuoto.
- "affidabilita.verdetto": sempre presente, anche quando l'elenco dei problemi è vuoto.
- "domande": da 5 a 7 stringhe, ognuna una singola domanda, senza numerazione iniziale.
- Nessun campo aggiuntivo, nessun campo mancante.
- Tutto il testo in italiano, con il "tu".
- Se il materiale fornito è illeggibile o non è un annuncio di vendita, restituisci comunque il JSON: punteggio basso, un segnale di livello "giallo" che lo spiega, "affidabilita.problemi" vuoto, e domande generiche ma utili.`;

const MESI = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'
];
const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

function stagioneDi(mese) {
  if (mese <= 1 || mese === 11) return 'inverno';
  if (mese <= 4) return 'primavera';
  if (mese <= 7) return 'estate';
  return 'autunno';
}

/**
 * Data odierna in chiaro per il modello.
 *
 * Serve perché il modello, lasciato a sé, ragiona sull'anno del proprio
 * addestramento: sbaglia l'età dei veicoli, le scadenze di revisione e la
 * stagione di riferimento per i prezzi. Gliela diamo a ogni richiesta.
 */
function dataDiOggi(adesso = new Date()) {
  const giorno = GIORNI[adesso.getDay()];
  const mese = adesso.getMonth();
  return {
    testo: `${giorno} ${adesso.getDate()} ${MESI[mese]} ${adesso.getFullYear()}`,
    iso: `${adesso.getFullYear()}-${String(mese + 1).padStart(2, '0')}-${String(adesso.getDate()).padStart(2, '0')}`,
    anno: adesso.getFullYear(),
    stagione: stagioneDi(mese)
  };
}

function costruisciPromptUtente(dati, adesso) {
  const righe = [];
  const oggi = dataDiOggi(adesso);

  righe.push(`OGGI È ${oggi.testo.toUpperCase()} (${oggi.iso}). Siamo in ${oggi.stagione}.`);
  righe.push(
    `Usa questa data per calcolare l'età dell'oggetto, le scadenze e l'effetto della stagione sul prezzo. L'anno corrente è ${oggi.anno}: non usarne un altro, nemmeno se la tua memoria suggerisce diversamente.`
  );
  righe.push('');
  righe.push('Analizza questo annuncio.');
  righe.push('');
  righe.push(`Categoria dichiarata dall'utente: ${dati.categoria}`);

  if (dati.oggetto) {
    righe.push(`Cosa sta comprando, secondo l'utente: ${dati.oggetto}`);
    righe.push(
      "Usa questa indicazione per capire il valore di mercato di QUEL prodotto e per formulare domande su misura. Se però l'annuncio mostra chiaramente un oggetto diverso da quello che l'utente pensa di comprare, segnalalo: è già di per sé un campanello d'allarme."
    );
  }

  const p = dati.profilo || {};
  const profiloCompilato = dati.categoria === 'auto' && Object.keys(p).length > 0;

  if (profiloCompilato) {
    righe.push('');
    righe.push(
      "L'utente ha chiesto esplicitamente di sapere se quest'auto è adatta a lui. Profilo (usa solo i dati indicati, non inventare quelli mancanti):"
    );
    righe.push(`- Altezza: ${p.altezza ? p.altezza + ' cm' : 'non indicata'}`);
    righe.push(`- Peso: ${p.peso ? p.peso + ' kg' : 'non indicato'}`);
    righe.push(`- Zona di utilizzo prevalente: ${p.zona || 'non indicata'}`);
    righe.push(`- Km annui previsti: ${p.kmAnnui ? p.kmAnnui + ' km/anno' : 'non indicati'}`);
    righe.push(`- Budget massimo: ${p.budget ? p.budget + ' €' : 'non indicato'}`);
    righe.push(`- Neopatentato: ${p.neopatentato === true ? 'sì' : p.neopatentato === false ? 'no' : 'non indicato'}`);
  } else if (dati.categoria === 'auto') {
    righe.push('');
    righe.push(
      "L'utente NON ha chiesto la valutazione personalizzata: non inserire consigli su altezza, peso, zona di utilizzo o adeguatezza personale. Concentrati su rischio truffa, prezzo e coerenza dei dati."
    );
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

  const quante = dati.immagini ? dati.immagini.length : 0;
  if (quante === 1) {
    righe.push('');
    righe.push(
      "Nell'immagine allegata trovi lo screenshot dell'annuncio: leggi con attenzione prezzo, titolo, descrizione, dati del veicolo/oggetto e ogni informazione sul venditore."
    );
  } else if (quante > 1) {
    righe.push('');
    righe.push(
      `Sono allegate ${quante} immagini, numerate da 1 a ${quante}. Possono essere parti diverse dello stesso annuncio (titolo, prezzo, descrizione, scheda tecnica), foto dell'oggetto, oppure screenshot della conversazione con il venditore.`
    );
    righe.push(
      "Esaminale TUTTE e leggile come un unico annuncio. Presta particolare attenzione alle incoerenze fra un'immagine e l'altra (prezzi diversi, km diversi, foto che non sembrano dello stesso oggetto, dettagli che cambiano): sono fra i segnali di truffa più forti. Quando un segnale nasce da una specifica immagine, cita il suo numero nel dettaglio."
    );
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
 * Estrae e valida una foto ricevuta come data URL o base64 puro.
 * `posizione` è il numero della foto (1-based) quando ce n'è più di una:
 * serve solo a scrivere messaggi d'errore che dicano *quale* foto è il problema.
 * @returns {{mediaType: string, dati: string, byte: number} | null}
 */
function validaImmagine(immagine, tipoDichiarato, posizione) {
  if (!immagine) return null;

  const chi = posizione ? `La foto ${posizione}` : 'Lo screenshot';

  if (typeof immagine !== 'string') {
    throw new ErroreUtente('immagine_non_valida', `${chi} non è in un formato valido. Ricaricala.`);
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
      `${chi} è in un formato non supportato: accettiamo solo JPG, PNG o WEBP.`
    );
  }

  base64 = base64.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length < 100) {
    throw new ErroreUtente('immagine_non_valida', `${chi} sembra danneggiata. Prova a ricaricarla.`);
  }

  const byteStimati = Math.floor((base64.length * 3) / 4);
  if (byteStimati > MAX_IMMAGINE_BYTE) {
    throw new ErroreUtente('immagine_troppo_grande', `${chi} supera i 5 MB. Riducila e riprova.`);
  }

  return { mediaType, dati: base64, byte: byteStimati };
}

/**
 * Valida l'elenco di foto della richiesta.
 * Accetta `immagini: []` (nuovo) oppure `immagine` singola (retrocompatibile).
 * @returns {Array<{mediaType: string, dati: string, byte: number}>}
 */
function validaImmagini(corpo) {
  let elenco;
  if (Array.isArray(corpo.immagini)) elenco = corpo.immagini;
  else if (corpo.immagine) elenco = [corpo.immagine];
  else elenco = [];

  elenco = elenco.filter((v) => v !== null && v !== undefined && v !== '');
  if (elenco.length === 0) return [];

  if (elenco.length > MAX_IMMAGINI) {
    throw new ErroreUtente(
      'troppe_immagini',
      `Puoi caricare al massimo ${MAX_IMMAGINI} foto per analisi: ne hai inviate ${elenco.length}.`
    );
  }

  const tipi = Array.isArray(corpo.tipiImmagine) ? corpo.tipiImmagine : [];
  const numerata = elenco.length > 1;
  const immagini = [];
  let totale = 0;

  for (let i = 0; i < elenco.length; i++) {
    const immagine = validaImmagine(
      elenco[i],
      tipi[i] || corpo.tipoImmagine,
      numerata ? i + 1 : null
    );
    if (!immagine) continue;
    totale += immagine.byte;
    immagini.push(immagine);
  }

  if (totale > MAX_TOTALE_IMMAGINI_BYTE) {
    throw new ErroreUtente(
      'immagini_troppo_grandi',
      `Le foto insieme superano i 12 MB (${(totale / 1024 / 1024).toFixed(1)} MB). Caricane meno o riducile.`
    );
  }

  return immagini;
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

  // Cosa sta comprando, scritto dall'utente (usato soprattutto per "altro").
  let oggetto = typeof corpo.oggetto === 'string' ? corpo.oggetto.replace(/\s+/g, ' ').trim() : '';
  if (oggetto.length > MAX_OGGETTO_CARATTERI) {
    oggetto = oggetto.slice(0, MAX_OGGETTO_CARATTERI);
  }

  const immagini = validaImmagini(corpo);
  const link = validaLink(corpo.link);

  if (immagini.length === 0 && !link && testo.length < 20) {
    throw new ErroreUtente(
      'contenuto_mancante',
      "Carica almeno una foto dell'annuncio, incolla il link oppure il testo (almeno 20 caratteri)."
    );
  }

  const profilo = {};
  if (categoria === 'auto' && corpo.profilo && typeof corpo.profilo === 'object') {
    const p = corpo.profilo;
    const altezza = Number(p.altezza);
    if (Number.isFinite(altezza) && altezza >= 120 && altezza <= 230) profilo.altezza = Math.round(altezza);

    const peso = Number(p.peso);
    if (Number.isFinite(peso) && peso >= 30 && peso <= 250) profilo.peso = Math.round(peso);

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
    oggetto,
    testo,
    immagini,
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
function validaSchema(oggetto, categoria) {
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

  // Affidabilità: obbligatoria per le auto, facoltativa per le altre categorie.
  const grezzoAffidabilita = oggetto.affidabilita;
  let affidabilita = null;

  if (grezzoAffidabilita && typeof grezzoAffidabilita === 'object') {
    const verdettoAff = stringaPulita(grezzoAffidabilita.verdetto, 700);
    const gravitaAmmesse = ['alta', 'media', 'bassa'];
    const problemi = (Array.isArray(grezzoAffidabilita.problemi) ? grezzoAffidabilita.problemi : [])
      .filter((p) => p && typeof p === 'object')
      .map((p) => {
        const gravita = typeof p.gravita === 'string' ? p.gravita.toLowerCase() : '';
        return {
          componente: stringaPulita(p.componente, 60),
          gravita: gravitaAmmesse.includes(gravita) ? gravita : 'media',
          descrizione: stringaPulita(p.descrizione, 500),
          verifica: stringaPulita(p.verifica, 400)
        };
      })
      .filter((p) => p.componente && p.descrizione)
      .slice(0, 6);

    if (verdettoAff) affidabilita = { verdetto: verdettoAff, problemi };
  }

  if (categoria === 'auto') {
    if (!affidabilita) throw new Error('Campo "affidabilita" mancante o senza verdetto.');
    if (affidabilita.problemi.length === 0) {
      throw new Error('Per le auto "affidabilita.problemi" non può essere vuoto.');
    }
  }

  if (!Array.isArray(oggetto.domande)) throw new Error('Campo "domande" mancante.');

  const domande = oggetto.domande
    .map((d) => stringaPulita(d, 300).replace(/^\s*\d+[).\-]\s*/, ''))
    .filter(Boolean)
    .slice(0, 7);

  if (domande.length < 3) throw new Error('Servono almeno 3 domande in "domande".');

  const risultato = {
    rischio: { punteggio, segnali },
    valutazione: { verdetto, dettagli },
    domande
  };
  if (affidabilita) risultato.affidabilita = affidabilita;
  return risultato;
}

// ---------------------------------------------------------------------------
// Chiamata all'AI, con retry se il JSON non è valido
// ---------------------------------------------------------------------------

function costruisciContenutoUtente(dati) {
  const contenuto = [];
  const immagini = dati.immagini || [];

  immagini.forEach((immagine, i) => {
    // Con più foto, l'etichetta prima di ognuna permette all'AI di citarle
    // per numero ("nella foto 2 il prezzo è diverso").
    if (immagini.length > 1) {
      contenuto.push({ type: 'text', text: `Immagine ${i + 1} di ${immagini.length}:` });
    }
    contenuto.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: immagine.mediaType,
        data: immagine.dati
      }
    });
  });

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

// ---------------------------------------------------------------------------
// Contabilità dei token
// ---------------------------------------------------------------------------

function nuovoConsumo() {
  return { chiamate: 0, input: 0, output: 0, letturaCache: 0, scritturaCache: 0 };
}

function sommaConsumo(consumo, usage) {
  if (!usage) return;
  consumo.chiamate += 1;
  consumo.input += usage.input_tokens || 0;
  consumo.output += usage.output_tokens || 0;
  consumo.letturaCache += usage.cache_read_input_tokens || 0;
  consumo.scritturaCache += usage.cache_creation_input_tokens || 0;
}

function costoUsd(consumo) {
  const p = PREZZI_USD_PER_MILIONE;
  return (
    (consumo.input * p.input +
      consumo.output * p.output +
      consumo.letturaCache * p.letturaCache +
      consumo.scritturaCache * p.scritturaCache) /
    1e6
  );
}

function registraConsumo(consumo, canale) {
  const costo = costoUsd(consumo);
  console.log(
    `[costo] ${canale} — $${costo.toFixed(4)} | in ${consumo.input} · out ${consumo.output} · ` +
      `cache r/w ${consumo.letturaCache}/${consumo.scritturaCache} | ${consumo.chiamate} chiamata/e`
  );
  return costo;
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

function primoJsonValido(risposta, categoria) {
  let ultimoErrore = new Error('La risposta non contiene testo.');
  for (const candidato of candidatiTesto(risposta)) {
    try {
      return validaSchema(estraiJson(candidato), categoria);
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
async function eseguiTurno(messaggi, strumenti, esitoFetch, consumo) {
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
    sommaConsumo(consumo, risposta.usage);

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

async function analizzaConAI(dati, consumo) {
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
    const risposta = await eseguiTurno(messaggi, strumenti, esitoFetch, consumo);

    if (risposta.stop_reason === 'refusal') {
      throw new ErroreUtente(
        'rifiuto_modello',
        "L'AI non è riuscita ad analizzare questo contenuto. Prova con un altro screenshot."
      );
    }

    // Il link era l'unico materiale ma la pagina non è stata letta: meglio
    // fermarsi che restituire un'analisi inventata sull'URL.
    if (dati.link && dati.immagini.length === 0 && !dati.testo && !esitoFetch.riuscito) {
      throw erroreLinkNonLeggibile(esitoFetch.codiceErrore);
    }

    try {
      const analisi = primoJsonValido(risposta, dati.categoria);

      if (analisi.valutazione.verdetto.startsWith(MARCATORE_PAGINA_KO)) {
        if (dati.immagini.length === 0 && !dati.testo) {
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

  const consumo = nuovoConsumo();
  const canale = dati.link
    ? 'link'
    : dati.immagini.length > 0
      ? `foto x${dati.immagini.length}`
      : 'testo';

  try {
    const analisi = await analizzaConAI(dati, consumo);
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
        messaggio: "Una delle foto non è stata accettata: potrebbe essere danneggiata o in un formato anomalo. Riprova rifacendo lo screenshot, oppure incolla il testo dell'annuncio."
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
  } finally {
    // Anche le analisi fallite consumano token: vanno contate.
    if (consumo.chiamate > 0) registraConsumo(consumo, canale);
  }
});

// Body troppo grande o JSON malformato -> messaggio chiaro invece della pagina di errore di Express.
app.use((errore, req, res, next) => {
  if (errore && errore.type === 'entity.too.large') {
    return res.status(413).json({
      errore: 'immagini_troppo_grandi',
      messaggio: 'Le foto sono troppo pesanti (max 5 MB ciascuna, 12 MB in totale). Riducile e riprova.'
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
