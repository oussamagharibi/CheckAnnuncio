# 🛡️ CheckAnnuncio

Sito anti-truffa che analizza con l'AI gli annunci di vendita (auto, telefoni, elettronica, qualunque cosa) e dice all'utente **quanto è rischioso**, **se il prezzo ha senso** e **cosa chiedere al venditore** prima di pagare.

L'annuncio si può fornire in tre modi: **screenshot**, **link** o **testo incollato**.

- **Backend**: Node.js + Express, stateless (nessun database)
- **Frontend**: pagina singola HTML/CSS/JS vanilla, in italiano, mobile-first
- **AI**: API Anthropic, modello `claude-sonnet-4-6`, con supporto immagini (screenshot) e lettura delle pagine web (tool `web_fetch`)

---

## Struttura del progetto

```
CheckAnnuncio/
├── server.js            # Server Express + chiamata all'AI + validazione JSON + rate limit
├── package.json         # Dipendenze e script "start"
├── .env.example         # Modello per il file .env (chiave API)
├── .gitignore           # Esclude .env e node_modules
├── README.md
└── public/
    ├── index.html       # Hero, upload, questionario, risultati
    ├── style.css        # Tema scuro, animazioni, responsive
    └── app.js           # Drag & drop, chip, loader, render dei risultati
```

---

## Avvio in locale

### 1. Requisiti

- Node.js 18 o superiore (testato su Node 24)
- Una chiave API Anthropic → https://console.anthropic.com/

### 2. Installazione

```bash
npm install
```

### 3. Chiave API

Copia `.env.example` in `.env` e inserisci la tua chiave:

```
ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
```

⚠️ La chiave viene letta **solo** da `process.env.ANTHROPIC_API_KEY`: non è mai scritta nel codice e non arriva mai al browser. Il file `.env` è già in `.gitignore` — non committarlo mai.

### 4. Avvio

```bash
npm start
```

Poi apri **http://localhost:3000**.

Se la chiave manca, il server parte comunque ma `/api/analizza` risponde con un messaggio chiaro (utile per lavorare sul frontend senza consumare crediti).

---

## Come testare

### A. Dal browser (test completo)

1. Apri http://localhost:3000
2. Scegli come dare l'annuncio: trascina uno **screenshot** nella dropzone, incolla un **link** (scheda 🔗) o usa la scheda **Testo** con l'annuncio di prova qui sotto
3. Scegli la categoria **Auto**; se vuoi anche il giudizio "è adatta a me?", accendi l'interruttore e compila altezza / peso / zona / km annui / budget / neopatentato
4. Premi **Analizza l'annuncio**

**Annuncio di prova da incollare** (truffa da manuale, dovrebbe dare rischio 9-10):

```
VENDO GOLF 7 1.6 TDI 2015 SOLO 45.000 KM PERFETTA, AFFARE UNICO 3.500 EURO TRATTABILI.
Auto di mia zia tenuta in garage, nessun graffio, gomme nuove, tagliandi tutti fatti.
NON POSSO FARE VIDEOCHIAMATE, sono all'estero per lavoro, la macchina la spedisco io
con corriere assicurato. Serve una caparra di 500 euro su PostePay per bloccarla,
ho già 10 persone interessate, primo che paga se la prende.
Rispondo solo su WhatsApp.
```

Con profilo (interruttore acceso): altezza 192 cm, peso 90 kg, zona città, 8.000 km/anno, budget 5.000 €, neopatentato sì.

Risultato atteso: punteggio 9-10, segnali rossi su prezzo fuori mercato, caparra PostePay, corriere/venditore all'estero, urgenza e rifiuto della videochiamata; nella valutazione compaiono anche i consigli legati al profilo (diesel sconsigliato con 8.000 km/anno in città, limite di potenza per neopatentati, abitabilità a 192 cm).

Prova anche un annuncio onesto (prezzo di mercato, foto reali, incontro di persona): il punteggio deve scendere a 1-3.

### B. Da terminale (PowerShell)

```powershell
$body = @{
  categoria = 'auto'
  testo = 'VENDO GOLF 7 1.6 TDI 2015 SOLO 45.000 KM, 3.500 EURO. Caparra su PostePay, non faccio videochiamate, spedisco con corriere.'
  profilo = @{ altezza = 192; zona = 'citta'; kmAnnui = 8000; budget = 5000; neopatentato = $true }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri 'http://localhost:3000/api/analizza' -Method Post `
  -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 6
```

### B-bis. Analisi da link

```powershell
$body = @{
  categoria = 'auto'
  link = 'https://www.subito.it/auto/…-655983399.htm'
  profilo = @{ altezza = 192; zona = 'citta'; kmAnnui = 8000; budget = 30000; neopatentato = $false }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri 'http://localhost:3000/api/analizza' -Method Post `
  -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 6
```

Se il link non è leggibile ricevi `400 link_non_leggibile` con l'invito a usare lo screenshot: è il comportamento voluto, non un bug. Dettagli in [Analisi da link](#analisi-da-link).

### C. Da terminale (bash / curl)

```bash
curl -s http://localhost:3000/api/analizza \
  -H "Content-Type: application/json" \
  -d '{
    "categoria": "telefono",
    "testo": "iPhone 15 Pro Max 512GB nuovo sigillato 380 euro, pagamento solo con ricarica PostePay, non faccio incontri, scrivimi su Telegram."
  }'
```

### D. Controllo rapido dello stato

```bash
curl -s http://localhost:3000/api/stato
# {"ok":true,"configurato":true,"limiteGiornaliero":10,"analisiRimaste":10}
```

### E. Verifica della sintassi

```bash
node --check server.js
node --check public/app.js
```

---

## API

### `POST /api/analizza`

Body JSON (serve **almeno uno** tra `immagine`, `link` e `testo`):

| Campo               | Tipo    | Note                                                                 |
| ------------------- | ------- | -------------------------------------------------------------------- |
| `categoria`         | string  | **obbligatorio** — `auto` \| `telefono` \| `altro`                    |
| `link`              | string  | URL dell'annuncio (http/https, max 2000 caratteri); lo schema può essere omesso |
| `immagine`          | string  | data URL base64 (`data:image/png;base64,…`) — jpg/png/webp, max 5 MB  |
| `tipoImmagine`      | string  | opzionale, se `immagine` è base64 puro senza prefisso data URL        |
| `testo`             | string  | testo dell'annuncio, min 20 caratteri se non c'è l'immagine, max 8000 |
| `profilo`           | object  | **facoltativo** — inviarlo attiva la valutazione personalizzata; ometterlo la disattiva |
| `profilo.altezza`   | number  | cm (120-230), usato solo per `categoria: auto`                        |
| `profilo.peso`      | number  | kg (30-250)                                                           |
| `profilo.zona`      | string  | `citta` \| `montagna` \| `campagna`                                   |
| `profilo.kmAnnui`   | number  | km previsti all'anno                                                  |
| `profilo.budget`    | number  | euro                                                                  |
| `profilo.neopatentato` | boolean |                                                                    |

Risposta `200`:

```json
{
  "rischio": {
    "punteggio": 9,
    "segnali": [
      { "livello": "rosso|giallo|verde", "titolo": "…", "dettaglio": "…" }
    ]
  },
  "valutazione": {
    "verdetto": "…",
    "dettagli": [
      { "etichetta": "Prezzo", "stato": "ok|attenzione|critico|info", "testo": "…" }
    ]
  },
  "domande": ["…", "…"],
  "analisiRimaste": 9
}
```

Errori (sempre con un messaggio in italiano pronto da mostrare all'utente):

| Codice HTTP | `errore`                                   | Quando                                       |
| ----------- | ------------------------------------------ | -------------------------------------------- |
| 400         | `categoria_mancante`, `contenuto_mancante`, `formato_non_supportato`, `immagine_non_valida`, `immagine_troppo_grande`, `link_non_valido`, `richiesta_rifiutata` | input non valido |
| 400         | `link_non_leggibile`                       | il link è stato aperto ma non conteneva un annuncio leggibile |
| 413         | `immagine_troppo_grande`                   | body oltre il limite                         |
| 429         | `limite_raggiunto`                         | superato il rate limit giornaliero           |
| 502         | `json_non_valido`, `chiave_non_valida`     | l'AI non ha prodotto JSON valido dopo i retry |
| 503         | `chiave_mancante`, `ai_sovraccarica`, `ai_irraggiungibile`, `ai_non_disponibile` | servizio non configurato o API non raggiungibile |
| 500         | `errore_interno`                           | imprevisto                                   |

### `GET /api/stato`

Restituisce `{ ok, configurato, limiteGiornaliero, analisiRimaste }` per l'IP chiamante.

---

## Valutazione personalizzata (opt-in)

Per la categoria **Auto** compare un interruttore — *"Dimmi se quest'auto è adatta a me"* — spento di default. Solo attivandolo si aprono i campi **altezza, peso, km annui, budget, zona d'uso, neopatentato**.

Il comportamento è simmetrico su tutta la catena, non solo nell'interfaccia:

- **Flag spento** → il frontend non invia `profilo`, e il prompt istruisce esplicitamente l'AI a non inserire consigli su altezza, peso o adeguatezza personale. L'analisi resta su truffa, prezzo e coerenza.
- **Flag acceso** → il profilo entra nel prompt e almeno due dei dettagli di valutazione devono riguardare l'adeguatezza all'utente. I campi lasciati vuoti sono marcati `non indicato`: l'AI ha istruzione di ignorarli, non di ipotizzarli.

Verificato sullo stesso annuncio (VW Up! 1.0 del 2016 a 6.500 €):

| | Dettagli prodotti |
| --- | --- |
| Flag spento | Prezzo, Chilometraggio, Stato dichiarato, Revisione e bollo, Documenti, Permuta — **zero riferimenti alla persona** |
| Flag acceso (198 cm, 115 kg, montagna) | Gli stessi più tre voci **critiche**: abitabilità insufficiente a 198 cm, sedili di una city car inadatti a 115 kg, motore 1.0 inadeguato in montagna |

Stesso annuncio, stesso punteggio di rischio (3/10), ma la versione personalizzata sconsiglia l'acquisto per motivi che l'utente non avrebbe visto.

---

## Analisi da link

Quando l'utente incolla un URL, il backend attiva il tool server-side **`web_fetch_20260209`**: è Anthropic a scaricare la pagina, non il nostro server. Perché non produca analisi campate in aria ci sono quattro protezioni:

1. **Validazione dell'URL** — solo http/https, niente `localhost`, IP privati o link oltre 2000 caratteri.
2. **Dominio bloccato sul link dell'utente** — `allowed_domains` viene impostato sull'host dell'URL incollato, così il modello non può andare a leggere altrove.
3. **Controllo del risultato del fetch** — gli errori del web fetch non sollevano eccezioni, arrivano come blocco `web_fetch_tool_result` con un `error_code`: il backend lo legge e, se il link era l'unico materiale, restituisce `link_non_leggibile` invece di proseguire.
4. **Guardia contro il fallimento silenzioso** — è lo scenario peggiore: la pagina risponde ma contiene un muro anti-bot, un login o un annuncio rimosso. Il prompt impone all'AI di iniziare il verdetto con `PAGINA_NON_LEGGIBILE:` in quel caso; il backend intercetta il marcatore e avvisa l'utente di usare lo screenshot.

Il ciclo gestisce anche `stop_reason: "pause_turn"` (fino a `MAX_ITERAZIONI_TOOL` giri), che i tool server-side possono restituire quando il turno è lungo.

### Cosa funziona davvero (verificato)

| Sito | Esito |
| --- | --- |
| `subito.it` — singolo annuncio | ✅ letto correttamente (prezzo, km, anno, allestimento, venditore) |
| `subito.it` — pagina di ricerca | ✅ leggibile |
| `autoscout24.it` | ✅ leggibile; se l'annuncio è scaduto il sito reindirizza alla lista e scatta la guardia `PAGINA_NON_LEGGIBILE` |

Nessuna garanzia che duri: i portali cambiano spesso le protezioni anti-bot. **Lo screenshot resta il canale più affidabile** — passa qualsiasi blocco e cattura anche i messaggi in chat del venditore, che sono spesso la parte più rivelatrice. Il link è una comodità, non un sostituto.

Nota sui costi: con il link, il contenuto della pagina entra nell'input della richiesta, quindi un'analisi da link costa **4 volte** una da screenshot. Vedi [Quanto costa un'analisi](#quanto-costa-unanalisi).

---

## Come funziona l'affidabilità del JSON

1. Il prompt di sistema impone all'AI di rispondere **solo** con un oggetto JSON conforme a uno schema fisso.
2. Il backend estrae il JSON (togliendo eventuali recinti markdown e isolando il primo oggetto bilanciato).
3. Lo valida contro lo schema: tipi, valori ammessi per `livello`/`stato`, punteggio limitato a 1-10, numero minimo di segnali/dettagli/domande; i testi vengono ripuliti e troncati.
4. Se la validazione fallisce, la risposta sbagliata viene rimessa nella conversazione insieme alla richiesta di correzione: **fino a 3 tentativi**. Solo dopo il terzo l'utente riceve `json_non_valido`.

---

## Quanto costa un'analisi

Il server stampa il costo di ogni analisi, calcolato dai token realmente consumati:

```
[costo] screenshot — $0.0302 | in 2338 · out 1544 · cache r/w 0/0 | 1 chiamata/e
```

Misure reali su `claude-sonnet-4-6` ($3,00/M input, $15,00/M output), cambio 1 € = 1,158 $:

| Canale | Token in | Token out | Costo | ~EUR | Tempo |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Screenshot** | 2.338 | 1.544 | $0,030 | €0,026 | ~30 s |
| **Testo incollato** | 2.202 | 2.228 | $0,040 | €0,035 | ~42 s |
| **Link** | 24.337 | 3.702 | $0,129 | €0,111 | ~79 s |

Proiezioni (tutto screenshot / tutto link):

| Volume | Screenshot | Link |
| --- | ---: | ---: |
| 1 utente che satura il limite (10 analisi) | $0,30 | $1,29 |
| 100 analisi/mese | $3,02 | $12,85 |
| 1.000 analisi/mese | $30 | $129 |
| 10.000 analisi/mese | $302 | $1.285 |

### Le leve sul costo

- **Lo screenshot è il canale più economico**, oltre che il più affidabile: è giusto che resti il predefinito.
- **`MAX_TOKEN_PAGINA`** (in `server.js`) è la leva più forte sul canale link. Portandolo da 40.000 a **12.000** il costo è sceso da $0,32 a $0,129 (−60%) **senza perdere qualità**: nella prova di verifica l'analisi leggeva ancora prezzo, km, anno, motorizzazione e allestimento corretti. Non alzarlo senza un motivo.
- **`output_config.effort`** è a `medium`. L'output è la voce di costo dominante sullo screenshot (~$0,023 su $0,030): passare a `low` lo ridurrebbe, ma accorcia anche segnali e domande — da misurare prima di adottarlo.
- **Il prompt caching qui non conviene.** Il prompt di sistema è ~1.800 token: scriverlo in cache costa $3,75/M e rileggerlo $0,30/M, ma la cache dura 5 minuti. Con traffico sporadico si pagherebbe la scrittura senza quasi mai rileggere, cioè più di adesso. Avrebbe senso solo con richieste molto ravvicinate e continue.

Attenzione: **anche le analisi fallite consumano token** e vengono contate nel log (il `finally` nella rotta), ma **non** scalano il rate limit dell'utente.

---

## Rate limit

Massimo **10 analisi per indirizzo IP al giorno**, contate solo per le analisi andate a buon fine.

> ⚠️ **Il contatore è tenuto in memoria (una `Map` nel processo Node): si azzera a ogni riavvio del server e quindi a ogni redeploy su Railway.** Anche uno scale-out su più istanze farebbe partire ogni istanza con il proprio contatore. Va benissimo come freno anti-abuso leggero; se serve un limite reale e persistente, occorre uno store esterno (Redis, database) — che questo progetto volutamente non ha.

Il limite è definito da `LIMITE_ANALISI_GIORNALIERE` in `server.js`.

---

## Deploy su Railway

Il progetto è già predisposto:

- il server ascolta su `process.env.PORT || 3000`;
- `npm start` esegue `node server.js`;
- `app.set('trust proxy', true)` fa leggere l'IP reale da `X-Forwarded-For` dietro il proxy di Railway;
- `.gitignore` esclude `.env` e `node_modules/`.

Passi:

1. Crea un repo Git e fai push del progetto (senza `.env`).
2. Su Railway: **New Project → Deploy from GitHub repo**.
3. In **Variables** aggiungi `ANTHROPIC_API_KEY` con la tua chiave. Non impostare `PORT`: la fornisce Railway.
4. Railway rileva Node, esegue `npm install` e poi `npm start`.
5. In **Settings → Networking** genera il dominio pubblico.

Ricorda: il rate limit in memoria si azzera a ogni redeploy.

---

## Privacy

Nessun database, nessun account, nessun log dei contenuti: screenshot e testo vengono inviati all'API Anthropic per l'analisi e poi scartati. In memoria resta solo il contatore giornaliero per IP.

---

## Disclaimer

> Valutazione indicativa generata da AI, non costituisce garanzia né consulenza legale.
