/* =========================================================
   CheckAnnuncio — logica frontend
   ========================================================= */

(function () {
  'use strict';

  var MAX_FOTO = 4;
  var MAX_BYTE = 5 * 1024 * 1024;
  var MAX_TOTALE_BYTE = 12 * 1024 * 1024;
  var TIPI_AMMESSI = ['image/jpeg', 'image/png', 'image/webp'];

  var stato = {
    modo: 'immagine',
    immagini: [], // [{ dataUrl, tipo, nome, byte }] — massimo MAX_FOTO
    categoria: 'auto',
    zona: null,
    neopatentato: null,
    inCorso: false
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
  var modoImmagine = $('modoImmagine');
  var modoLink = $('modoLink');
  var modoTesto = $('modoTesto');
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
      modoImmagine.hidden = stato.modo !== 'immagine';
      modoLink.hidden = stato.modo !== 'link';
      modoTesto.hidden = stato.modo !== 'testo';
      nascondiErrore();
      if (stato.modo === 'link') inputLink.focus();
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
    if (stato.modo !== 'immagine' || !e.clipboardData) return;
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

  function avviaFrasi() {
    var frasi = inputLink.value.trim()
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

  function renderRisultati(dati) {
    renderRischio(dati.rischio);
    renderAffidabilita(dati.affidabilita);
    renderValutazione(dati.valutazione);
    renderDomande(dati.domande);

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

    var testo = inputTesto.value.trim();
    if (testo) corpo.testo = testo;

    var link = inputLink.value.trim();
    if (link) corpo.link = link;

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

  function impostaCaricamento(attivo) {
    stato.inCorso = attivo;
    bottoneAnalizza.disabled = attivo;
    bottoneAnalizza.querySelector('.bottone__testo').textContent = attivo
      ? 'Analisi in corso…'
      : "Analizza l'annuncio";
    caricamento.hidden = !attivo;
    if (attivo) {
      avviaFrasi();
      risultati.hidden = true;
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

    if (stato.immagini.length === 0 && !link && testo.length < 20) {
      if (stato.modo === 'link') {
        mostraErrore("Incolla il link dell'annuncio (es. https://www.subito.it/…).");
      } else if (stato.modo === 'testo') {
        mostraErrore("Incolla il testo dell'annuncio: servono almeno 20 caratteri.");
      } else {
        mostraErrore("Carica almeno una foto dell'annuncio (oppure usa il link o il testo).");
      }
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
  // Nuova analisi
  // ---------------------------------------------------------------

  $('nuovaAnalisi').addEventListener('click', function () {
    risultati.hidden = true;
    nascondiErrore();
    scrollA(zonaForm);
  });
})();
