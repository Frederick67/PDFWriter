# OLED PDF

Editor PDF per Windows a nero puro (OLED), pensato per consumare poco batteria e per lavorare sui PDF annotati con
**Drawboard PDF** senza perdere le annotazioni (penne con pressione, evidenziatori, forme).

## Funzioni
- Schede per più documenti, più finestre (Ctrl+N), sessione ripristinata alla riapertura (anche con modifiche non salvate).
- Strumenti a destra: penna a pressione/fissa, stilografica, pennarello, evidenziatore (si aggancia alle righe di testo),
  laser, testo (modificabile), rettangolo, ellisse, linea, freccia, gomma intera o parziale, righello;
  strumenti personalizzabili (colore, spessore, opacità, smussatura, raddrizza linee), scelta rapida con i tasti 1–9.
- Selezione a lazo: sposta, ridimensiona, ricolora, elimina (anche annotazioni di Drawboard).
- Annulla / ripeti (Ctrl+Z / Ctrl+Y) anche per le operazioni sulle pagine e sull'indice.
- Pannelli a sinistra: pagine (aggiungi anche a righe/quadretti/punti, elimina, ruota, duplica, riordina, selezione multipla,
  estrai), indice modificabile, ricerca con risultati evidenziati sulla pagina (F3), annotazioni.
- Testo selezionabile e copiabile, link del PDF cliccabili; timbri, firme, note e campi modulo visualizzati.
- Salva con nome, stampa, esportazione della pagina come PNG e di una copia appiattita.
- Pagina intera / adatta alla larghezza / due pagine affiancate, zoom con due dita, navigazione con frecce e PagSu/PagGiù.
- Pagina scura con opzione per lasciare le immagini a colori reali; testo libero salvato con font incorporato.
- File recenti nella schermata iniziale.
- Rendering solo su richiesta, nessun timer in background, modalità risparmio energetico.

## Come funziona la compatibilità con Drawboard
Drawboard salva le annotazioni come annotazioni PDF standard (`Ink`, `Highlight`, `Square`...), con l'inchiostro come
poligono pieno nello stream `/AP`. Le annotazioni esistenti non vengono riscritte (si possono solo eliminare); le nuove
ricevono un `/AP` standard, quindi restano visibili in qualunque lettore.

## Sviluppo
```
npm install
npm run dev        # versione web (Vite)
npm start          # app Electron
npm run dist       # installer Windows in release/
npm test           # test (vitest) di annotazioni, pagine, indice, testo
```
Il binario di Electron va scaricato con `node node_modules/electron/install.js` se npm blocca lo script di installazione.

## Struttura
- `src/` interfaccia (`main.js`), annotazioni PDF (`annots.js`), operazioni sulle pagine (`pageops.js`), sessione (`session.js`),
  icone Lucide (`icons.js`), tooltip/notifiche/dialoghi (`ui.js`)
- `electron/` processo principale e preload (finestre, file, sessione)
- `scripts/make-icon.mjs` genera l'icona dell'app
