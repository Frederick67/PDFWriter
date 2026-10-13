# OLED PDF

Editor PDF per Windows a nero puro (OLED), pensato per consumare poco batteria e per lavorare sui PDF annotati con
**Drawboard PDF** senza perdere le annotazioni (penne con pressione, evidenziatori, forme).

## Funzioni
- Schede per più documenti, più finestre (Ctrl+N), sessione ripristinata alla riapertura (anche con modifiche non salvate).
- Strumenti a destra: penna a pressione/fissa, stilografica, pennarello, evidenziatore, laser, testo, rettangolo, gomma;
  strumenti personalizzabili (colore, spessore, opacità, smussatura, raddrizza linee).
- Pannelli a sinistra: pagine (aggiungi, elimina, ruota, duplica, riordina), indice, ricerca, annotazioni.
- Pagina intera / adatta alla larghezza, navigazione con frecce e PagSu/PagGiù.
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
```
Il binario di Electron va scaricato con `node node_modules/electron/install.js` se npm blocca lo script di installazione.

## Struttura
- `src/` interfaccia (`main.js`), annotazioni PDF (`annots.js`), operazioni sulle pagine (`pageops.js`), sessione (`session.js`)
- `electron/` processo principale e preload (finestre, file, sessione)
- `scripts/make-icon.mjs` genera l'icona dell'app
