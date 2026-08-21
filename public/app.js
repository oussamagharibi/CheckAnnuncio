/* =========================================================
   Sammy AI — logica frontend
   ========================================================= */

(function () {
  'use strict';

  var MAX_FOTO = 4;
  var MAX_BYTE = 5 * 1024 * 1024;
  var MAX_TOTALE_BYTE = 12 * 1024 * 1024;
  var TIPI_AMMESSI = ['image/jpeg', 'image/png', 'image/webp'];

  var stato = {
    modo: 'link', // 'link' | 'materiale' (foto + descrizione)
    immagini: [], // [{ dataUrl, tipo, nome, byte }] — massimo MAX_FOTO
    categoria: 'auto',
    zona: null,
    neopatentato: null,
    inCorso: false,
    strumento: 'annuncio', // 'annuncio' | 'modello' | 'consiglio'
    tipoModello: 'auto',
    sessione: null,        // id della conversazione aperta dall'analisi
    domandeRimaste: 0,
    domandaInCorso: false
  };

  // ---------------------------------------------------------------
  // Riferimenti DOM
  // ---------------------------------------------------------------

  var $ = function (id) {
    return document.getElementById(id);
  };

  var dropzone = $('dropzone');
  var inputFile = $('inputFile');
  var anteprime = $('anteprime');
  var barraFoto = $('barraFoto');
  var conteggioFoto = $('conteggioFoto');
  var svuotaFoto = $('svuotaFoto');
  var notaFoto = $('notaFoto');
  var dropzoneTitolo = $('dropzoneTitolo');
  var modoLink = $('modoLink');
  var modoMateriale = $('modoMateriale');
  var inputLink = $('inputLink');
  var inputTesto = $('inputTesto');
  var contatoreTesto = $('contatoreTesto');
  var extraAuto = $('extraAuto');
  var extraAltro = $('extraAltro');
  var inputOggetto = $('inputOggetto');
  var zonaProfilo = $('zonaProfilo');
  var flagProfilo = $('flagProfilo');
  var bottoneAnalizza = $('bottoneAnalizza');
  var avvisoErrore = $('avvisoErrore');
  var testoErrore = $('testoErrore');
  var notaLimite = $('notaLimite');
  var badgeCrediti = $('badgeCrediti');
  var caricamento = $('caricamento');
  var fraseCaricamento = $('fraseCaricamento');
  var risultati = $('risultati');
  var zonaForm = $('zonaForm');
  var toast = $('toast');
  var zonaModello = $('zonaModello');
  var zonaConsiglio = $('zonaConsiglio');
  var risultatiModello = $('risultatiModello');
  var risultatiConsiglio = $('risultatiConsiglio');
  var zonaChat = $('zonaChat');
  var zonaRicomincia = $('zonaRicomincia');
  var bottoneModello = $('bottoneModello');
  var bottoneConsiglio = $('bottoneConsiglio');
  var inputProdotto = $('inputProdotto');
  var inputProblema = $('inputProblema');
  var inputBudgetConsiglio = $('inputBudgetConsiglio');
  var contatoreProblema = $('contatoreProblema');
  var cardChat = $('cardChat');
  var chat = $('chat');
  var formChat = $('formChat');
  var inputDomanda = $('inputDomanda');
  var bottoneDomanda = $('bottoneDomanda');
  var notaChat = $('notaChat');
  var suggerimenti = $('suggerimenti');

  // ---------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------

  function mostraToast(messaggio) {
    toast.textContent = messaggio;
    toast.hidden = false;
    // forza il reflow così la transizione parte anche a chiamate ravvicinate
    void toast.offsetWidth;
    toast.classList.add('visibile');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      toast.classList.remove('visibile');
    }, 2200);
  }

  function mostraErrore(messaggio) {
    testoErrore.textContent = messaggio;
    avvisoErrore.hidden = false;
  }

  function nascondiErrore() {
    avvisoErrore.hidden = true;
  }

  function formattaPeso(byte) {
    if (byte < 1024) return byte + ' B';
    if (byte < 1024 * 1024) return (byte / 1024).toFixed(0) + ' KB';
    return (byte / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function scrollA(elemento) {
    var y = elemento.getBoundingClientRect().top + window.pageYOffset - 24;
    window.scrollTo({ top: y, behavior: 'smooth' });
  }

  function numeroValido(input) {
    var v = parseInt(input.value, 10);
    return Number.isFinite(v) ? v : null;
  }

  // ---------------------------------------------------------------
  // Scelta dello strumento
  // ---------------------------------------------------------------

  function mostraErroreIn(strumento, messaggio) {
    if (strumento === 'modello') {
      $('testoErroreModello').textContent = messaggio;
      $('avvisoErroreModello').hidden = false;
    } else if (strumento === 'consiglio') {
      $('testoErroreConsiglio').textContent = messaggio;
      $('avvisoErroreConsiglio').hidden = false;
    } else {
      mostraErrore(messaggio);
    }
  }

  function nascondiErrori() {
    nascondiErrore();
    $('avvisoErroreModello').hidden = true;
    $('avvisoErroreConsiglio').hidden = true;
  }

  Array.prototype.forEach.call(document.querySelectorAll('.strumento'), function (voce) {
    voce.addEventListener('click', function () {
      if (stato.inCorso) return;
      stato.strumento = voce.dataset.strumento;

      Array.prototype.forEach.call(document.querySelectorAll('.strumento'), function (v) {
        var attivo = v === voce;
        v.classList.toggle('attivo', attivo);
        v.setAttribute('aria-selected', attivo ? 'true' : 'false');
      });

      zonaForm.hidden = stato.strumento !== 'annuncio';
      zonaModello.hidden = stato.strumento !== 'modello';
      zonaConsiglio.hidden = stato.strumento !== 'consiglio';

      // Cambiare strumento azzera i risultati precedenti: lasciarli sotto un
      // pannello diverso da quello che li ha prodotti confonderebbe.
      nascondiRisultati();
      nascondiErrori();
    });
  });

  // ---------------------------------------------------------------
  // Selettore screenshot / testo
  // ---------------------------------------------------------------

  Array.prototype.forEach.call(document.querySelectorAll('.selettore__voce'), function (voce) {
    voce.addEventListener('click', function () {
      stato.modo = voce.dataset.modo;
      Array.prototype.forEach.call(document.querySelectorAll('.selettore__voce'), function (v) {
        var attivo = v === voce;
        v.classList.toggle('attivo', attivo);
        v.setAttribute('aria-selected', attivo ? 'true' : 'false');
      });
      modoLink.hidden = stato.modo !== 'link';
      modoMateriale.hidden = stato.modo !== 'materiale';
      nascondiErrore();
      if (stato.modo === 'link') inputLink.focus();
    });
  });

  // Scorciatoie dentro le note ("Passa alle foto"): fanno click sulla
  // linguetta corrispondente, cosi' la logica di cambio scheda resta una sola.
  Array.prototype.forEach.call(document.querySelectorAll('.collegamento-modo'), function (link) {
    link.addEventListener('click', function () {
      var voce = document.querySelector('.selettore__voce[data-modo="' + link.dataset.vai + '"]');
      if (voce) voce.click();
    });
  });

  // ---------------------------------------------------------------
  // Upload foto (fino a MAX_FOTO)
  // ---------------------------------------------------------------

  var ICONA_X =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
    '<path d="m6 6 12 12M18 6 6 18"/></svg>';

  function totaleByte() {
    return stato.immagini.reduce(function (somma, i) {
      return somma + i.byte;
    }, 0);
  }

  function disegnaAnteprime() {
    anteprime.innerHTML = '';

    stato.immagini.forEach(function (immagine, indice) {
      var figura = document.createElement('figure');
      figura.className = 'anteprima';

      var img = document.createElement('img');
      img.src = immagine.dataUrl;
      img.alt = 'Foto ' + (indice + 1) + ': ' + immagine.nome;

      var numero = document.createElement('span');
      numero.className = 'anteprima__numero';
      numero.textContent = String(indice + 1);

      var didascalia = document.createElement('figcaption');
      var nome = document.createElement('span');
      nome.className = 'anteprima__nome';
      nome.textContent = immagine.nome;
      var peso = document.createElement('span');
      peso.className = 'anteprima__peso';
      peso.textContent = formattaPeso(immagine.byte);
      didascalia.appendChild(nome);
      didascalia.appendChild(peso);

      var rimuovi = document.createElement('button');
      rimuovi.type = 'button';
      rimuovi.className = 'anteprima__rimuovi';
      rimuovi.setAttribute('aria-label', 'Rimuovi la foto ' + (indice + 1));
      rimuovi.innerHTML = ICONA_X;
      rimuovi.addEventListener('click', function () {
        stato.immagini.splice(indice, 1);
        disegnaAnteprime();
        nascondiErrore();
      });

      figura.appendChild(img);
      figura.appendChild(numero);
      figura.appendChild(didascalia);
      figura.appendChild(rimuovi);
      anteprime.appendChild(figura);
    });

    var quante = stato.immagini.length;
    anteprime.hidden = quante === 0;
    barraFoto.hidden = quante === 0;
    notaFoto.hidden = quante === 0;
    // La dropzone resta visibile finché c'è posto per un'altra foto.
    dropzone.hidden = quante >= MAX_FOTO;

    if (quante > 0) {
      conteggioFoto.textContent =
        quante + ' di ' + MAX_FOTO + ' foto · ' + formattaPeso(totaleByte());
    }
    dropzoneTitolo.textContent = quante === 0 ? 'Trascina qui le foto' : 'Aggiungi un\'altra foto';
  }

  function caricaFile(file) {
    if (!file) return;

    if (stato.immagini.length >= MAX_FOTO) {
      mostraErrore('Puoi caricare al massimo ' + MAX_FOTO + ' foto. Rimuovine una per aggiungerne un\'altra.');
      return;
    }

    var tipo = (file.type || '').toLowerCase();
    if (tipo === 'image/jpg') tipo = 'image/jpeg';

    if (TIPI_AMMESSI.indexOf(tipo) === -1) {
      mostraErrore('Formato non valido: accettiamo solo JPG, PNG o WEBP.');
      return;
    }

    if (file.size > MAX_BYTE) {
      mostraErrore(
        '"' + (file.name || 'La foto') + '" pesa ' + formattaPeso(file.size) +
          ': il massimo è 5 MB per foto.'
      );
      return;
    }

    if (totaleByte() + file.size > MAX_TOTALE_BYTE) {
      mostraErrore('Le foto insieme supererebbero i 12 MB. Rimuovine una o usane di più leggere.');
      return;
    }

    var lettore = new FileReader();

    lettore.onerror = function () {
      mostraErrore("Non siamo riusciti a leggere il file. Prova con un'altra foto.");
    };

    lettore.onload = function () {
      if (stato.immagini.length >= MAX_FOTO) return; // corsa fra letture parallele
      stato.immagini.push({
        dataUrl: String(lettore.result),
        tipo: tipo,
        nome: file.name || 'foto',
        byte: file.size
      });
      disegnaAnteprime();
      nascondiErrore();
    };

    lettore.readAsDataURL(file);
  }

  /** Carica una lista di file rispettando il posto rimasto. */
  function caricaFileMultipli(elenco) {
    if (!elenco || !elenco.length) return;

    var posti = MAX_FOTO - stato.immagini.length;
    if (posti <= 0) {
      mostraErrore('Hai già ' + MAX_FOTO + ' foto: rimuovine una per aggiungerne un\'altra.');
      return;
    }

    var candidati = Array.prototype.slice.call(elenco, 0, posti);
    if (elenco.length > posti) {
      mostraToast('Aggiunte le prime ' + posti + ' foto (massimo ' + MAX_FOTO + ')');
    }

    // Il totale va verificato qui in modo sincrono: le letture partono in
    // parallelo, quindi dentro caricaFile il conteggio sarebbe ancora fermo.
    var totale = totaleByte();
    var accettati = [];
    for (var i = 0; i < candidati.length; i++) {
      if (candidati[i].size <= MAX_BYTE && totale + candidati[i].size > MAX_TOTALE_BYTE) {
        mostraErrore('Le foto insieme supererebbero i 12 MB: ne ho aggiunte solo alcune.');
        break;
      }
      totale += candidati[i].size;
      accettati.push(candidati[i]);
    }

    accettati.forEach(caricaFile);
  }

  dropzone.addEventListener('click', function () {
    inputFile.click();
  });

  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputFile.click();
    }
  });

  inputFile.addEventListener('change', function () {
    caricaFileMultipli(inputFile.files);
    inputFile.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (evento) {
    dropzone.addEventListener(evento, function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('trascinamento');
    });
  });

  ['dragleave', 'dragend'].forEach(function (evento) {
    dropzone.addEventListener(evento, function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'dragleave' && dropzone.contains(e.relatedTarget)) return;
      dropzone.classList.remove('trascinamento');
    });
  });

  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('trascinamento');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      caricaFileMultipli(e.dataTransfer.files);
    }
  });

  // Evita che il browser apra l'immagine se l'utente sbaglia mira
  ['dragover', 'drop'].forEach(function (evento) {
    window.addEventListener(evento, function (e) {
      if (!dropzone.contains(e.target)) e.preventDefault();
    });
  });

  // Incolla direttamente uno screenshot dagli appunti
  window.addEventListener('paste', function (e) {
    if (stato.modo !== 'materiale' || !e.clipboardData) return;
    var elementi = e.clipboardData.items || [];
    var file = null;
    for (var i = 0; i < elementi.length && !file; i++) {
      if (elementi[i].type && elementi[i].type.indexOf('image/') === 0) {
        file = elementi[i].getAsFile();
      }
    }
    if (!file) return;
    e.preventDefault();
    if (stato.immagini.length >= MAX_FOTO) {
      mostraErrore('Hai già ' + MAX_FOTO + ' foto: rimuovine una per incollarne un\'altra.');
      return;
    }
    caricaFile(file);
    mostraToast('Screenshot incollato ✓');
  });

  svuotaFoto.addEventListener('click', function () {
    stato.immagini = [];
    disegnaAnteprime();
    nascondiErrore();
  });

  disegnaAnteprime();

  // ---------------------------------------------------------------
  // Textarea
  // ---------------------------------------------------------------

  inputTesto.addEventListener('input', function () {
    contatoreTesto.textContent = String(inputTesto.value.length);
    if (inputTesto.value.trim().length > 0) nascondiErrore();
  });

  // ---------------------------------------------------------------
  // Scheda modello e consiglio: campi
  // ---------------------------------------------------------------

  inputProblema.addEventListener('input', function () {
    contatoreProblema.textContent = String(inputProblema.value.length);
    if (inputProblema.value.trim().length > 0) nascondiErrori();
  });

  inputProdotto.addEventListener('input', function () {
    if (inputProdotto.value.trim().length > 0) nascondiErrori();
  });

  inputProdotto.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      bottoneModello.click();
    }
  });

  // Gli esempi riempiono il campo invece di inviare: vanno adattati al caso proprio.
  Array.prototype.forEach.call($('esempiProblema').querySelectorAll('.suggerimento'), function (chip) {
    chip.addEventListener('click', function () {
      inputProblema.value = chip.dataset.testo;
      contatoreProblema.textContent = String(inputProblema.value.length);
      inputProblema.focus();
      nascondiErrori();
    });
  });

  // ---------------------------------------------------------------
  // Link
  // ---------------------------------------------------------------

  inputLink.addEventListener('input', function () {
    if (inputLink.value.trim().length > 0) nascondiErrore();
  });

  inputLink.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      bottoneAnalizza.click();
    }
  });

  // ---------------------------------------------------------------
  // Chip
  // ---------------------------------------------------------------

  function collegaChip(idGruppo, alSelezionare, esclusivo) {
    var gruppo = $(idGruppo);
    if (!gruppo) return;
    Array.prototype.forEach.call(gruppo.querySelectorAll('.chip'), function (chip) {
      chip.addEventListener('click', function () {
        var giaAttivo = chip.classList.contains('attivo');
        Array.prototype.forEach.call(gruppo.querySelectorAll('.chip'), function (c) {
          c.classList.remove('attivo');
        });
        if (giaAttivo && !esclusivo) {
          alSelezionare(null);
          return;
        }
        chip.classList.add('attivo');
        alSelezionare(chip.dataset.valore);
      });
    });
  }

  // Campi che dipendono dalla categoria scelta:
  // - "auto": interruttore del profilo, e i campi solo se l'utente lo attiva
  // - "altro": campo libero per dire di che oggetto si tratta
  function aggiornaCampiCategoria() {
    var eAuto = stato.categoria === 'auto';
    zonaProfilo.hidden = !eAuto;
    extraAuto.classList.toggle('aperto', eAuto && flagProfilo.checked);
    extraAltro.classList.toggle('aperto', stato.categoria === 'altro');
  }

  collegaChip(
    'gruppoCategoria',
    function (valore) {
      stato.categoria = valore || 'auto';
      aggiornaCampiCategoria();
      nascondiErrore();
      if (stato.categoria === 'altro') {
        setTimeout(function () {
          inputOggetto.focus();
        }, 380);
      }
    },
    true
  );

  flagProfilo.addEventListener('change', function () {
    aggiornaCampiCategoria();
    if (flagProfilo.checked) {
      // Lascia finire l'animazione di apertura prima di portare i campi in vista.
      setTimeout(function () {
        var y = extraAuto.getBoundingClientRect().bottom + window.pageYOffset;
        if (y > window.pageYOffset + window.innerHeight) scrollA(extraAuto);
      }, 420);
    }
  });

  collegaChip(
    'gruppoTipoModello',
    function (valore) {
      stato.tipoModello = valore || 'auto';
    },
    true
  );

  collegaChip('gruppoZona', function (valore) {
    stato.zona = valore;
  });

  collegaChip('gruppoNeopatentato', function (valore) {
    stato.neopatentato = valore === null ? null : valore === 'si';
  });

  // Categoria di default "auto": mostra l'interruttore, ma i campi restano chiusi
  // finché l'utente non chiede la valutazione personalizzata.
  aggiornaCampiCategoria();

  // ---------------------------------------------------------------
  // Loader con frasi che ruotano
  // ---------------------------------------------------------------

  var FRASI = [
    "Leggo l'annuncio…",
    'Controllo il prezzo rispetto al mercato…',
    'Cerco segnali di truffa…',
    'Verifico la coerenza dei dati…',
    'Cerco i punti deboli noti di questo modello…',
    'Analizzo le foto e la descrizione…',
    'Incrocio i dati con il tuo profilo…',
    'Preparo le domande per il venditore…',
    'Ci siamo quasi…'
  ];

  var timerFrasi = null;

  var FRASI_MODELLO = [
    'Identifico la versione esatta…',
    'Raccolgo i difetti noti di questo modello…',
    "Controllo i prezzi dell'usato…",
    'Peso pro e contro…',
    'Ci siamo quasi…'
  ];

  var FRASI_CONSIGLIO = [
    'Capisco di cosa hai bisogno davvero…',
    'Cerco le strade possibili…',
    'Confronto i compromessi…',
    'Controllo i prezzi…',
    'Ci siamo quasi…'
  ];

  function avviaFrasi() {
    var frasi;
    if (stato.strumento === 'modello') frasi = FRASI_MODELLO;
    else if (stato.strumento === 'consiglio') frasi = FRASI_CONSIGLIO;
    else
      frasi =
        stato.modo === 'link' && inputLink.value.trim()
          ? ["Apro la pagina dell'annuncio…"].concat(FRASI)
          : FRASI;
    var indice = 0;
    fraseCaricamento.textContent = frasi[0];
    timerFrasi = setInterval(function () {
      indice = (indice + 1) % frasi.length;
      fraseCaricamento.classList.add('uscita');
      setTimeout(function () {
        fraseCaricamento.textContent = frasi[indice];
        fraseCaricamento.classList.remove('uscita');
      }, 260);
    }, 2600);
  }

  function fermaFrasi() {
    if (timerFrasi) clearInterval(timerFrasi);
    timerFrasi = null;
  }

  // ---------------------------------------------------------------
  // Render dei risultati
  // ---------------------------------------------------------------

  var ICONE_SEGNALE = { rosso: '🚩', giallo: '⚠️', verde: '✅' };
  var ETICHETTE_BADGE = {
    ok: 'Ok',
    attenzione: 'Attenzione',
    critico: 'Critico',
    info: 'Info'
  };

  function coloreRischio(punteggio) {
    if (punteggio <= 3) return 'var(--verde)';
    if (punteggio <= 6) return 'var(--giallo)';
    if (punteggio <= 8) return 'var(--arancio)';
    return 'var(--rosso)';
  }

  function etichettaRischio(punteggio) {
    if (punteggio <= 2) return 'Rischio basso';
    if (punteggio <= 4) return 'Rischio contenuto';
    if (punteggio <= 6) return 'Da verificare';
    if (punteggio <= 8) return 'Rischio alto';
    return 'Molto pericoloso';
  }

  var ICONA_COPIA =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="9" y="9" width="11" height="11" rx="2.2"/>' +
    '<path d="M5.5 15H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5h8.5A1.5 1.5 0 0 1 15 5v.5"/></svg>';

  var ICONA_OK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="m5 12.5 4.5 4.5L19 7"/></svg>';

  function copiaNegliAppunti(testo) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(testo);
    }
    return new Promise(function (risolvi, rifiuta) {
      var tmp = document.createElement('textarea');
      tmp.value = testo;
      tmp.setAttribute('readonly', '');
      tmp.style.position = 'fixed';
      tmp.style.opacity = '0';
      document.body.appendChild(tmp);
      tmp.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(tmp);
      ok ? risolvi() : rifiuta(new Error('copia non riuscita'));
    });
  }

  function renderRischio(rischio) {
    var punteggio = rischio.punteggio;
    var colore = coloreRischio(punteggio);
    var card = $('cardRischio');

    card.style.setProperty('--colore-rischio', colore);
    $('punteggioValore').textContent = String(punteggio);
    $('punteggioEtichetta').textContent = etichettaRischio(punteggio);

    var riempimento = $('gaugeRiempimento');
    riempimento.style.width = '0%';
    setTimeout(function () {
      riempimento.style.width = punteggio * 10 + '%';
    }, 260);

    var lista = $('listaSegnali');
    lista.innerHTML = '';
    rischio.segnali.forEach(function (segnale, i) {
      var li = document.createElement('li');
      li.className = 'segnale segnale--' + segnale.livello;
      li.style.setProperty('--ritardo-riga', 320 + i * 80 + 'ms');

      var icona = document.createElement('span');
      icona.className = 'segnale__icona';
      icona.setAttribute('aria-hidden', 'true');
      icona.textContent = ICONE_SEGNALE[segnale.livello] || '•';

      var corpo = document.createElement('div');
      var titolo = document.createElement('p');
      titolo.className = 'segnale__titolo';
      titolo.textContent = segnale.titolo;
      corpo.appendChild(titolo);

      if (segnale.dettaglio) {
        var dettaglio = document.createElement('p');
        dettaglio.className = 'segnale__dettaglio';
        dettaglio.textContent = segnale.dettaglio;
        corpo.appendChild(dettaglio);
      }

      li.appendChild(icona);
      li.appendChild(corpo);
      lista.appendChild(li);
    });
  }

  function renderValutazione(valutazione) {
    $('testoVerdetto').textContent = valutazione.verdetto;

    var lista = $('listaDettagli');
    lista.innerHTML = '';
    valutazione.dettagli.forEach(function (dettaglio, i) {
      var li = document.createElement('li');
      li.className = 'dettaglio';
      li.style.setProperty('--ritardo-riga', 420 + i * 70 + 'ms');

      var badge = document.createElement('span');
      badge.className = 'badge badge--' + dettaglio.stato;
      badge.textContent = ETICHETTE_BADGE[dettaglio.stato] || 'Info';

      var testo = document.createElement('div');
      testo.className = 'dettaglio__testo';
      var etichetta = document.createElement('strong');
      etichetta.textContent = dettaglio.etichetta;
      testo.appendChild(etichetta);
      testo.appendChild(document.createTextNode(dettaglio.testo));

      li.appendChild(badge);
      li.appendChild(testo);
      lista.appendChild(li);
    });
  }

  var ETICHETTE_GRAVITA = { alta: 'Grave', media: 'Da controllare', bassa: 'Minore' };

  function renderAffidabilita(affidabilita) {
    var card = $('cardAffidabilita');

    // La sezione esiste solo quando l'AI la produce (obbligatoria per le auto,
    // facoltativa per telefono/altro): senza dati la card resta nascosta.
    if (!affidabilita || !affidabilita.verdetto) {
      card.hidden = true;
      return;
    }

    card.hidden = false;
    $('testoAffidabilita').textContent = affidabilita.verdetto;

    var lista = $('listaProblemi');
    lista.innerHTML = '';

    (affidabilita.problemi || []).forEach(function (problema, i) {
      var li = document.createElement('li');
      li.className = 'problema problema--' + problema.gravita;
      li.style.setProperty('--ritardo-riga', 480 + i * 80 + 'ms');

      var testata = document.createElement('div');
      testata.className = 'problema__testata';

      var componente = document.createElement('span');
      componente.className = 'problema__componente';
      componente.textContent = problema.componente;

      var gravita = document.createElement('span');
      gravita.className = 'gravita';
      gravita.textContent = ETICHETTE_GRAVITA[problema.gravita] || 'Da valutare';

      testata.appendChild(componente);
      testata.appendChild(gravita);

      var descrizione = document.createElement('p');
      descrizione.className = 'problema__descrizione';
      descrizione.textContent = problema.descrizione;

      li.appendChild(testata);
      li.appendChild(descrizione);

      if (problema.verifica) {
        var verifica = document.createElement('p');
        verifica.className = 'problema__verifica';
        var titolo = document.createElement('strong');
        titolo.textContent = 'Come verificare:';
        verifica.appendChild(titolo);
        verifica.appendChild(document.createTextNode(' ' + problema.verifica));
        li.appendChild(verifica);
      }

      lista.appendChild(li);
    });
  }

  function renderDomande(domande) {
    var lista = $('listaDomande');
    lista.innerHTML = '';

    domande.forEach(function (domanda, i) {
      var li = document.createElement('li');
      li.className = 'domanda';
      li.style.setProperty('--ritardo-riga', 520 + i * 70 + 'ms');

      var testo = document.createElement('p');
      testo.className = 'domanda__testo';
      testo.textContent = domanda;

      var bottone = document.createElement('button');
      bottone.type = 'button';
      bottone.className = 'copia';
      bottone.title = 'Copia questa domanda';
      bottone.setAttribute('aria-label', 'Copia la domanda ' + (i + 1));
      bottone.innerHTML = ICONA_COPIA;

      bottone.addEventListener('click', function () {
        copiaNegliAppunti(domanda)
          .then(function () {
            bottone.classList.add('fatto');
            bottone.innerHTML = ICONA_OK;
            mostraToast('Domanda copiata ✓');
            setTimeout(function () {
              bottone.classList.remove('fatto');
              bottone.innerHTML = ICONA_COPIA;
            }, 1600);
          })
          .catch(function () {
            mostraToast('Copia non riuscita 😕');
          });
      });

      li.appendChild(testo);
      li.appendChild(bottone);
      lista.appendChild(li);
    });

    $('copiaTutte').onclick = function () {
      var tutte = domande
        .map(function (d, i) {
          return i + 1 + '. ' + d;
        })
        .join('\n');
      copiaNegliAppunti(tutte)
        .then(function () {
          mostraToast('Tutte le domande copiate ✓');
        })
        .catch(function () {
          mostraToast('Copia non riuscita 😕');
        });
    };
  }

  // ---------------------------------------------------------------
  // Conversazione di approfondimento
  // ---------------------------------------------------------------

  // Il prompt chiede testo semplice, ma se un asterisco sfugge lo togliamo qui:
  // le bolle usano textContent, quindi il markdown si vedrebbe grezzo.
  function ripulisci(testo) {
    return String(testo)
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(^|\s)\*(\S[^*]*?)\*(?=[\s.,:;!?)]|$)/g, '$1$2')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .trim();
  }

  function aggiungiBolla(testo, tipo) {
    var bolla = document.createElement('div');
    bolla.className = 'bolla bolla--' + tipo;
    bolla.textContent = tipo === 'ai' ? ripulisci(testo) : testo;
    chat.appendChild(bolla);
    bolla.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return bolla;
  }

  function bollaAttesa() {
    var bolla = document.createElement('div');
    bolla.className = 'bolla bolla--ai bolla--attesa';
    bolla.setAttribute('aria-label', 'Sto scrivendo');
    bolla.innerHTML = '<span></span><span></span><span></span>';
    chat.appendChild(bolla);
    bolla.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return bolla;
  }

  function aggiornaStatoChat() {
    var esaurite = stato.domandeRimaste <= 0;
    inputDomanda.disabled = esaurite || stato.domandaInCorso;
    bottoneDomanda.disabled = esaurite || stato.domandaInCorso;
    suggerimenti.hidden =
      stato.strumento !== 'annuncio' || esaurite || chat.children.length > 0;

    if (esaurite) {
      notaChat.textContent =
        'Hai usato tutte le domande di approfondimento. Lancia una nuova analisi per ripartire.';
      inputDomanda.placeholder = 'Domande esaurite';
    } else {
      notaChat.textContent =
        stato.domandeRimaste + (stato.domandeRimaste === 1 ? ' domanda rimasta' : ' domande rimaste');
    }
  }

  function inviaDomanda(testo) {
    if (stato.domandaInCorso || stato.domandeRimaste <= 0) return;

    var domanda = testo.trim();
    if (domanda.length < 3) return;

    aggiungiBolla(domanda, 'utente');
    inputDomanda.value = '';
    stato.domandaInCorso = true;
    aggiornaStatoChat();

    var attesa = bollaAttesa();

    fetch('/api/domanda', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessione: stato.sessione, domanda: domanda })
    })
      .then(function (r) {
        return r
          .json()
          .catch(function () {
            return {};
          })
          .then(function (d) {
            return { ok: r.ok, dati: d };
          });
      })
      .then(function (esito) {
        attesa.remove();
        stato.domandaInCorso = false;

        if (!esito.ok) {
          aggiungiBolla(
            esito.dati.messaggio || 'Non sono riuscito a rispondere. Riprova tra poco.',
            'errore'
          );
          // Una domanda fallita non viene contata dal server: aggiorniamo solo
          // se è il server stesso a dirci quante ne restano.
          if (typeof esito.dati.domandeRimaste === 'number') {
            stato.domandeRimaste = esito.dati.domandeRimaste;
          }
          aggiornaStatoChat();
          return;
        }

        aggiungiBolla(esito.dati.risposta, 'ai');
        stato.domandeRimaste = esito.dati.domandeRimaste;
        aggiornaStatoChat();
      })
      .catch(function () {
        attesa.remove();
        stato.domandaInCorso = false;
        aggiungiBolla('Connessione assente. Controlla la rete e riprova.', 'errore');
        aggiornaStatoChat();
      });
  }

  formChat.addEventListener('submit', function (e) {
    e.preventDefault();
    inviaDomanda(inputDomanda.value);
  });

  // Invio con Enter, a capo con Shift+Enter (come in qualsiasi chat).
  inputDomanda.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      inviaDomanda(inputDomanda.value);
    }
  });

  Array.prototype.forEach.call(suggerimenti.querySelectorAll('.suggerimento'), function (chip) {
    chip.addEventListener('click', function () {
      var testo = chip.dataset.testo;
      // I suggerimenti aperti ("Il venditore mi ha risposto che…") vanno completati
      // dall'utente; quelli che sono già una domanda intera partono subito.
      if (/[?]$/.test(testo)) {
        inviaDomanda(testo);
      } else {
        inputDomanda.value = testo;
        inputDomanda.focus();
        inputDomanda.setSelectionRange(testo.length, testo.length);
      }
    });
  });

  var INTRO_CHAT = {
    annuncio:
      "Il venditore ti ha risposto? Hai notato un dettaglio che nelle foto non c'era? Scrivilo qui: continuo da dove siamo rimasti, senza rifare tutto da capo.",
    modello:
      'Vuoi sapere di una versione diversa, di un allestimento, o come si confronta con un altro modello? Chiedimelo qui.',
    consiglio:
      'Nessuna delle strade ti convince, o hai un vincolo che non ti ho chiesto? Dimmelo e rivedo il consiglio.'
  };

  // I suggerimenti rapidi hanno senso solo sull'analisi di un annuncio.
  function preparaChat(dati) {
    stato.sessione = dati.sessione || null;
    stato.domandeRimaste = typeof dati.domandeRimaste === 'number' ? dati.domandeRimaste : 0;
    chat.innerHTML = '';
    inputDomanda.value = '';
    inputDomanda.placeholder = 'Scrivi qui la tua domanda o quello che hai scoperto…';
    $('introChat').textContent = INTRO_CHAT[stato.strumento] || INTRO_CHAT.annuncio;
    suggerimenti.hidden = stato.strumento !== 'annuncio';
    cardChat.hidden = !stato.sessione;
    zonaChat.hidden = !stato.sessione;
    zonaRicomincia.hidden = !stato.sessione;
    aggiornaStatoChat();
  }

  function renderRisultati(dati) {
    renderRischio(dati.rischio);
    renderAffidabilita(dati.affidabilita);
    renderValutazione(dati.valutazione);
    renderDomande(dati.domande);
    preparaChat(dati);

    risultati.hidden = false;
    // Riavvia le animazioni di ingresso delle card
    Array.prototype.forEach.call(risultati.querySelectorAll('.scheda--risultato'), function (card) {
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = '';
    });

    setTimeout(function () {
      scrollA(risultati);
    }, 80);
  }

  // ---------------------------------------------------------------
  // Render: scheda di un modello
  // ---------------------------------------------------------------

  function etichettaVoto(voto) {
    if (voto <= 3) return 'Da lasciar perdere';
    if (voto <= 5) return 'Con riserva';
    if (voto <= 7) return 'Buon acquisto';
    if (voto <= 8) return 'Ottima scelta';
    return 'Fuoriclasse';
  }

  function coloreVoto(voto) {
    if (voto <= 3) return 'var(--rosso)';
    if (voto <= 5) return 'var(--arancio)';
    if (voto <= 7) return 'var(--giallo)';
    return 'var(--verde)';
  }

  function riempiPunti(lista, voci, ritardoBase) {
    lista.innerHTML = '';
    voci.forEach(function (voce, i) {
      var li = document.createElement('li');
      li.className = 'punto';
      li.style.setProperty('--ritardo-riga', ritardoBase + i * 70 + 'ms');
      var titolo = document.createElement('strong');
      titolo.textContent = voce.titolo;
      li.appendChild(titolo);
      if (voce.dettaglio) {
        var dettaglio = document.createElement('span');
        dettaglio.textContent = voce.dettaglio;
        li.appendChild(dettaglio);
      }
      lista.appendChild(li);
    });
  }

  function riempiProblemi(lista, problemi, ritardoBase) {
    lista.innerHTML = '';
    problemi.forEach(function (problema, i) {
      var li = document.createElement('li');
      li.className = 'problema problema--' + problema.gravita;
      li.style.setProperty('--ritardo-riga', ritardoBase + i * 80 + 'ms');

      var testata = document.createElement('div');
      testata.className = 'problema__testata';
      var componente = document.createElement('span');
      componente.className = 'problema__componente';
      componente.textContent = problema.componente;
      var gravita = document.createElement('span');
      gravita.className = 'gravita';
      gravita.textContent = ETICHETTE_GRAVITA[problema.gravita] || 'Da valutare';
      testata.appendChild(componente);
      testata.appendChild(gravita);

      var descrizione = document.createElement('p');
      descrizione.className = 'problema__descrizione';
      descrizione.textContent = problema.descrizione;

      li.appendChild(testata);
      li.appendChild(descrizione);

      if (problema.verifica) {
        var verifica = document.createElement('p');
        verifica.className = 'problema__verifica';
        var titolo = document.createElement('strong');
        titolo.textContent = 'Come verificare:';
        verifica.appendChild(titolo);
        verifica.appendChild(document.createTextNode(' ' + problema.verifica));
        li.appendChild(verifica);
      }
      lista.appendChild(li);
    });
  }

  function formattaEuro(n) {
    return Math.round(n).toLocaleString('it-IT') + ' €';
  }

  function renderModello(dati) {
    $('titoloModello').textContent = dati.prodotto;
    $('votoValore').textContent = String(dati.voto);
    $('votoEtichetta').textContent = etichettaVoto(dati.voto);
    $('cardModello').style.setProperty('--colore-rischio', coloreVoto(dati.voto));

    var gauge = $('gaugeVoto');
    gauge.style.width = '0%';
    setTimeout(function () {
      gauge.style.width = dati.voto * 10 + '%';
    }, 260);

    $('sintesiModello').textContent = dati.sintesi;
    riempiPunti($('listaPro'), dati.pro, 320);
    riempiPunti($('listaContro'), dati.contro, 360);

    $('cardProblemiModello').hidden = dati.problemi.length === 0;
    riempiProblemi($('listaProblemiModello'), dati.problemi, 420);

    var prezzo = dati.prezzo;
    if (prezzo.max > 0) {
      $('fasciaPrezzo').textContent = formattaEuro(prezzo.min) + ' – ' + formattaEuro(prezzo.max);
      $('fasciaPrezzo').hidden = false;
    } else {
      $('fasciaPrezzo').hidden = true;
    }
    $('notaPrezzo').textContent = prezzo.nota;
    $('consiglioModello').textContent = dati.consiglio;

    risultatiModello.hidden = false;
    preparaChat(dati);
    setTimeout(function () {
      scrollA(risultatiModello);
    }, 80);
  }

  // ---------------------------------------------------------------
  // Render: consiglio a partire da un problema
  // ---------------------------------------------------------------

  function renderConsiglio(dati) {
    $('testoBisogno').textContent = dati.bisogno;

    var lista = $('listaSoluzioni');
    lista.innerHTML = '';
    dati.soluzioni.forEach(function (soluzione, i) {
      var li = document.createElement('li');
      li.className = 'soluzione';
      li.style.setProperty('--ritardo-riga', 320 + i * 90 + 'ms');

      var testata = document.createElement('div');
      testata.className = 'soluzione__testata';
      var tipo = document.createElement('span');
      tipo.className = 'soluzione__tipo';
      tipo.textContent = soluzione.tipo;
      testata.appendChild(tipo);

      if (soluzione.prezzoMax > 0) {
        var prezzo = document.createElement('span');
        prezzo.className = 'soluzione__prezzo';
        prezzo.textContent =
          soluzione.prezzoMin > 0 && soluzione.prezzoMin !== soluzione.prezzoMax
            ? formattaEuro(soluzione.prezzoMin) + ' – ' + formattaEuro(soluzione.prezzoMax)
            : formattaEuro(soluzione.prezzoMax);
        testata.appendChild(prezzo);
      }
      li.appendChild(testata);

      var perche = document.createElement('p');
      perche.className = 'soluzione__perche';
      perche.textContent = soluzione.perche;
      li.appendChild(perche);

      if (soluzione.esempi.length) {
        var esempi = document.createElement('div');
        esempi.className = 'soluzione__esempi';
        soluzione.esempi.forEach(function (e) {
          var chip = document.createElement('span');
          chip.className = 'esempio';
          chip.textContent = e;
          esempi.appendChild(chip);
        });
        li.appendChild(esempi);
      }

      if (soluzione.attenzione) {
        var nota = document.createElement('p');
        nota.className = 'soluzione__attenzione';
        var etichetta = document.createElement('strong');
        etichetta.textContent = 'Attenzione:';
        nota.appendChild(etichetta);
        nota.appendChild(document.createTextNode(' ' + soluzione.attenzione));
        li.appendChild(nota);
      }

      lista.appendChild(li);
    });

    var criteri = $('listaCriteri');
    criteri.innerHTML = '';
    dati.criteri.forEach(function (criterio, i) {
      var li = document.createElement('li');
      li.className = 'dettaglio';
      li.style.setProperty('--ritardo-riga', 420 + i * 70 + 'ms');
      var badge = document.createElement('span');
      badge.className = 'badge badge--info';
      badge.textContent = 'Controlla';
      var testo = document.createElement('div');
      testo.className = 'dettaglio__testo';
      var titolo = document.createElement('strong');
      titolo.textContent = criterio.titolo;
      testo.appendChild(titolo);
      testo.appendChild(document.createTextNode(criterio.dettaglio));
      li.appendChild(badge);
      li.appendChild(testo);
      criteri.appendChild(li);
    });

    $('cardEvitare').hidden = !dati.daEvitare;
    $('testoEvitare').textContent = dati.daEvitare;

    risultatiConsiglio.hidden = false;
    preparaChat(dati);
    setTimeout(function () {
      scrollA(risultatiConsiglio);
    }, 80);
  }

  // ---------------------------------------------------------------
  // Crediti residui
  // ---------------------------------------------------------------

  function aggiornaCrediti(rimaste, limite) {
    if (typeof rimaste !== 'number') return;
    badgeCrediti.hidden = false;
    badgeCrediti.textContent = rimaste + (limite ? '/' + limite : '') + ' analisi oggi';
    notaLimite.textContent =
      rimaste > 0
        ? 'Ti restano ' + rimaste + ' analisi gratuite oggi.'
        : 'Hai finito le analisi gratuite di oggi.';
  }

  fetch('/api/stato')
    .then(function (r) {
      return r.json();
    })
    .then(function (d) {
      aggiornaCrediti(d.analisiRimaste, d.limiteGiornaliero);
      if (d.configurato === false) {
        mostraErrore('Il servizio non è ancora configurato (chiave API mancante).');
      }
    })
    .catch(function () {
      /* non è un problema bloccante */
    });

  // ---------------------------------------------------------------
  // Invio
  // ---------------------------------------------------------------

  function costruisciCorpo() {
    var corpo = { categoria: stato.categoria };

    if (stato.immagini.length > 0) {
      corpo.immagini = stato.immagini.map(function (i) {
        return i.dataUrl;
      });
      corpo.tipiImmagine = stato.immagini.map(function (i) {
        return i.tipo;
      });
    }

    // Solo il materiale della scheda attiva: se uno prova il link, poi passa
    // alle foto, il link rimasto nel campo non deve viaggiare comunque.
    if (stato.modo === 'link') {
      var link = inputLink.value.trim();
      if (link) corpo.link = link;
    } else {
      var testo = inputTesto.value.trim();
      if (testo) corpo.testo = testo;
    }

    var oggetto = inputOggetto.value.trim();
    if (stato.categoria === 'altro' && oggetto) corpo.oggetto = oggetto;

    // Il profilo parte solo se l'utente ha chiesto la valutazione personalizzata.
    if (stato.categoria === 'auto' && flagProfilo.checked) {
      corpo.profilo = {
        altezza: numeroValido($('inputAltezza')),
        peso: numeroValido($('inputPeso')),
        zona: stato.zona,
        kmAnnui: numeroValido($('inputKm')),
        budget: numeroValido($('inputBudget')),
        neopatentato: stato.neopatentato
      };
    }

    return corpo;
  }

  var ETICHETTE_BOTTONE = {
    annuncio: ["Analizza l'annuncio", 'Analisi in corso…'],
    modello: ['Fammi la scheda', 'Ci sto lavorando…'],
    consiglio: ['Consigliami', 'Ci penso…']
  };

  function bottoneDi(strumento) {
    if (strumento === 'modello') return bottoneModello;
    if (strumento === 'consiglio') return bottoneConsiglio;
    return bottoneAnalizza;
  }

  function nascondiRisultati() {
    risultati.hidden = true;
    risultatiModello.hidden = true;
    risultatiConsiglio.hidden = true;
    zonaChat.hidden = true;
    zonaRicomincia.hidden = true;
  }

  function impostaCaricamento(attivo) {
    stato.inCorso = attivo;
    var bottone = bottoneDi(stato.strumento);
    var etichette = ETICHETTE_BOTTONE[stato.strumento];
    bottone.disabled = attivo;
    bottone.querySelector('.bottone__testo').textContent = attivo ? etichette[1] : etichette[0];
    caricamento.hidden = !attivo;
    if (attivo) {
      avviaFrasi();
      nascondiRisultati();
      setTimeout(function () {
        scrollA(caricamento);
      }, 60);
    } else {
      fermaFrasi();
    }
  }

  bottoneAnalizza.addEventListener('click', function () {
    if (stato.inCorso) return;
    nascondiErrore();

    var testo = inputTesto.value.trim();
    var link = inputLink.value.trim();

    // Ogni scheda chiede ciò che le compete: il link nella prima, foto o
    // descrizione (almeno una delle due) nella seconda.
    if (stato.modo === 'link' && !link) {
      mostraErrore("Incolla il link dell'annuncio (es. https://www.subito.it/…).");
      return;
    }

    if (stato.modo === 'materiale' && stato.immagini.length === 0 && testo.length < 20) {
      mostraErrore('Carica almeno una foto, oppure scrivi una descrizione di almeno 20 caratteri.');
      return;
    }

    impostaCaricamento(true);

    fetch('/api/analizza', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(costruisciCorpo())
    })
      .then(function (risposta) {
        return risposta
          .json()
          .catch(function () {
            return {};
          })
          .then(function (dati) {
            return { ok: risposta.ok, stato: risposta.status, dati: dati };
          });
      })
      .then(function (esito) {
        impostaCaricamento(false);

        if (!esito.ok) {
          if (typeof esito.dati.analisiRimaste === 'number') {
            aggiornaCrediti(esito.dati.analisiRimaste);
          }
          mostraErrore(
            esito.dati.messaggio ||
              'Qualcosa è andato storto (errore ' + esito.stato + '). Riprova tra poco.'
          );
          scrollA(zonaForm);
          return;
        }

        aggiornaCrediti(esito.dati.analisiRimaste);
        renderRisultati(esito.dati);
      })
      .catch(function () {
        impostaCaricamento(false);
        mostraErrore('Connessione assente o interrotta. Controlla la rete e riprova.');
      });
  });

  // ---------------------------------------------------------------
  // Invio: scheda modello e consiglio
  // ---------------------------------------------------------------

  /**
   * Percorso comune ai due strumenti che partono da testo: stessa gestione di
   * loader, errori e crediti, cambia solo endpoint, corpo e render.
   */
  function inviaScheda(strumento, percorso, corpo, render) {
    if (stato.inCorso) return;
    nascondiErrori();
    impostaCaricamento(true);

    fetch(percorso, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    })
      .then(function (risposta) {
        return risposta
          .json()
          .catch(function () {
            return {};
          })
          .then(function (dati) {
            return { ok: risposta.ok, stato: risposta.status, dati: dati };
          });
      })
      .then(function (esito) {
        impostaCaricamento(false);

        if (!esito.ok) {
          if (typeof esito.dati.analisiRimaste === 'number') {
            aggiornaCrediti(esito.dati.analisiRimaste);
          }
          mostraErroreIn(
            strumento,
            esito.dati.messaggio ||
              'Qualcosa è andato storto (errore ' + esito.stato + '). Riprova tra poco.'
          );
          return;
        }

        aggiornaCrediti(esito.dati.analisiRimaste);
        render(esito.dati);
      })
      .catch(function () {
        impostaCaricamento(false);
        mostraErroreIn(strumento, 'Connessione assente o interrotta. Controlla la rete e riprova.');
      });
  }

  bottoneModello.addEventListener('click', function () {
    var prodotto = inputProdotto.value.trim();
    if (prodotto.length < 2) {
      mostraErroreIn('modello', 'Scrivi marca e modello, per esempio "Golf 7 1.6 TDI 2016".');
      return;
    }
    inviaScheda(
      'modello',
      '/api/modello',
      { prodotto: prodotto, categoria: stato.tipoModello },
      renderModello
    );
  });

  bottoneConsiglio.addEventListener('click', function () {
    var problema = inputProblema.value.trim();
    if (problema.length < 10) {
      mostraErroreIn('consiglio', 'Racconta il problema in una frase: servono almeno 10 caratteri.');
      return;
    }
    var corpo = { problema: problema };
    var budget = numeroValido(inputBudgetConsiglio);
    if (budget) corpo.budget = budget;
    inviaScheda('consiglio', '/api/consiglio', corpo, renderConsiglio);
  });

  // ---------------------------------------------------------------
  // Nuova analisi
  // ---------------------------------------------------------------

  $('nuovaAnalisi').addEventListener('click', function () {
    nascondiRisultati();
    nascondiErrori();
    var pannello =
      stato.strumento === 'modello'
        ? zonaModello
        : stato.strumento === 'consiglio'
          ? zonaConsiglio
          : zonaForm;
    scrollA(pannello);
  });
})();
