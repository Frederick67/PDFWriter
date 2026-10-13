import '@fontsource-variable/inter';
import './style.css';
import { ic, hydrateIcons } from './icons.js';
import { initUI, toast, setBusy, confirmDialog } from './ui.js';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, ParseSpeeds } from 'pdf-lib';
import { readAnnots, applyChanges, makeInk, makeHighlight, newId } from './annots.js';
import { insertBlank, insertPdf, removePage, rotatePage, duplicatePage, movePage } from './pageops.js';
import { kvGet, kvSet, kvDel, loadPrefs, savePrefs, serializeDraft, applyDraft } from './session.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
hydrateIcons();
initUI();

const $ = (id) => document.getElementById(id);
const hintEl = document.getElementById('hint');
const els = {
  pages: $('pages'), save: $('save'), undo: $('undo'), tabs: $('tabs'), newTab: $('newTab'),
  pager: $('pager'), pageNo: $('pageNo'), pageTot: $('pageTot'), zoomPct: $('zoomPct'), fav: $('fav'),
  slots: $('slots'), pop: $('pop'), popSw: $('popSw'), popW: $('popW'), file: $('file'),
};

const PALETTE = [[0, 0, 0], [0.9, 0.15, 0.15], [1, 0.55, 0], [1, 0.87, 0.38], [0.1, 0.65, 0.25], [0.15, 0.45, 0.9], [0.55, 0.3, 0.85]];
const PALETTE_NAMES = ['Nero (bianco sulla pagina scura)', 'Rosso', 'Arancione', 'Giallo', 'Verde', 'Blu', 'Viola'];
// Tipi di strumento ricavati da Drawboard PDF (PenTool, PenWithPressureTool, CalligraphyInk,
// HighlightPen, TextHighlight, LaserInkTool, EraserTool) con le sue opzioni (spessore, opacità, smussatura, ink-to-line).
const DEFAULT_SLOTS = [
  { type: 'pen', style: 'pressure', color: [0.9, 0.15, 0.15], width: 1.2, opacity: 1, smooth: true, straighten: false },
  { type: 'pen', style: 'pressure', color: [0.9, 0.15, 0.15], width: 3.5, opacity: 1, smooth: true, straighten: false },
  { type: 'pen', style: 'pressure', color: [0.15, 0.45, 0.9], width: 1.8, opacity: 1, smooth: true, straighten: false },
  { type: 'pen', style: 'calligraphy', color: [0.1, 0.2, 0.55], width: 3, opacity: 1, smooth: true, straighten: false },
  { type: 'marker', style: 'marker', color: [1, 0.87, 0.38], width: 14, opacity: 0.35, smooth: true, straighten: false },
  { type: 'highlighter', color: [1, 0.87, 0.38], width: 11 },
  { type: 'laser', color: [0.95, 0.1, 0.1], width: 3 },
  { type: 'text', color: [0, 0, 0], width: 12 },
  { type: 'rect', color: [0.9, 0.15, 0.15], width: 1.5 },
  { type: 'eraser', color: [0.6, 0.6, 0.6], width: 6 },
];
const NAMES = {
  pen: 'Penna', marker: 'Evidenziatore a mano libera', highlighter: 'Evidenziatore testo', laser: 'Puntatore laser',
  text: 'Testo', rect: 'Rettangolo', eraser: 'Gomma',
};
const STYLES = { pressure: 'Penna a pressione', fixed: 'Penna fissa', calligraphy: 'Stilografica (punta piatta)' };
const INK_TOOLS = new Set(['pen', 'marker']);

const state = {
  lib: null, doc: null, pages: [], scale: 1, tool: 'view', slot: -1, slots: loadSlots(), lock: true,
  dark: true, eco: false, userEco: false, finger: false, grid: '', dirty: false, name: 'documento.pdf', handle: null, path: null, fitMode: null,
  undo: [], encrypted: false, ui: 'm', contrast: false,
};

// Interruttore accessibile (role="switch"): stato visivo e aria-checked insieme.
const setSwitch = (el, on) => { el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); };
const applyUi = () => {
  document.documentElement.dataset.ui = state.ui;
  document.documentElement.dataset.contrast = state.contrast ? '1' : '0';
};

// Impostazioni salvate (tema, eco, griglia, blocco strumento, dimensione e contrasto dell'interfaccia)
{
  const pr = loadPrefs();
  if (typeof pr.dark === 'boolean') state.dark = pr.dark;
  if (typeof pr.eco === 'boolean') { state.eco = pr.eco; state.userEco = true; }
  if (typeof pr.lock2 === 'boolean') state.lock = pr.lock2;
  if (typeof pr.grid === 'string') state.grid = pr.grid;
  if (['s', 'm', 'l', 'xl'].includes(pr.ui)) state.ui = pr.ui;
  if (typeof pr.contrast === 'boolean') state.contrast = pr.contrast;
  setSwitch($('dark'), state.dark);
  setSwitch($('eco'), state.eco);
  setSwitch($('contrast'), state.contrast);
  $('grid').value = state.grid;
  $('uiSize').value = state.ui;
  applyUi();
}
const persistPrefs = () => savePrefs({
  dark: state.dark, eco: state.userEco ? state.eco : undefined, lock2: state.lock, grid: state.grid, ui: state.ui, contrast: state.contrast,
});

function loadSlots() {
  try {
    const s = JSON.parse(localStorage.getItem('oledpdf.slots2'));
    if (Array.isArray(s) && s.length) return s;
  } catch { /* storage non disponibile */ }
  return structuredClone(DEFAULT_SLOTS);
}
const saveSlots = () => { try { localStorage.setItem('oledpdf.slots2', JSON.stringify(state.slots)); } catch { /* ignore */ } };

const dpr = () => Math.min(window.devicePixelRatio || 1, state.eco ? 1 : 2);
const perf = (() => { let t0 = performance.now(); return (label) => { if (window.__perf) { const t = performance.now(); console.log('PERF', label, Math.round(t - t0), 'ms'); t0 = t; } }; })();
const docTitle = () => (active ? `${state.name}${state.dirty ? ' •' : ''} · OLED PDF` : 'OLED PDF');
// Stato in corso: titolo della finestra + pillola visibile ("Apertura…"); i messaggi informativi diventano notifiche.
const setStatus = (t) => {
  document.title = t ? `${t} · OLED PDF` : docTitle();
  const working = !!t && t.endsWith('…');
  setBusy(working ? t : '');
  if (t && !working) toast(t, { type: 'warn', ms: 4500 });
};

/* ---------- colori (adattati al nero OLED solo in visualizzazione) ---------- */
function disp(c) {
  if (!state.dark) return c;
  if (Math.max(...c) - Math.min(...c) < 0.15) return c.map((v) => 1 - v); // nero → bianco
  const L = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  return L < 0.3 ? c.map((v) => v + (1 - v) * 0.55) : c; // colori scuri (blu notte...) schiariti per restare leggibili
}
const rgba = (c, a = 1) => { const [r, g, b] = disp(c); return `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`; };

/* ---------- documenti e schede (più PDF aperti, come le schede di Drawboard) ---------- */
const docs = [];
let active = null;
let docSeq = 0;
let userOpened = false; // vero appena l'utente (o Esplora file) apre un PDF: il ripristino della sessione non deve scavalcarlo
const draftKey = (name, size) => `draft:${name}|${size}`;

// Copia lo stato "vivo" della vista nel documento attivo prima di cambiare scheda.
function saveActive() {
  if (!active) return;
  Object.assign(active, {
    scale: state.scale, scroll: els.pages.scrollTop, ratio: els.pages.scrollTop / (els.pages.scrollHeight || 1), undo: state.undo, dirty: state.dirty, fitMode: state.fitMode,
    name: state.name, path: state.path, handle: state.handle,
  });
}

function detachView() {
  for (const p of state.pages) { p.task?.cancel(); p.gen++; if (p.laserRaf) cancelAnimationFrame(p.laserRaf); }
  io.disconnect();
  els.pages.replaceChildren();
}

function showEmpty() {
  detachView();
  Object.assign(state, { lib: null, doc: null, task: null, pages: [], undo: [], dirty: false, name: 'documento.pdf', path: null, handle: null });
  els.pages.append(hintEl);
  els.pager.hidden = true; setChrome(false);
  buildThumbs();
  setDirty(false); els.save.disabled = true; els.undo.disabled = true;
  renderTabs();
  setStatus('');
}

function activate(rec, scrollTop) {
  if (active && active !== rec) { saveActive(); flushDraftOf(active); }
  detachView();
  active = rec;
  Object.assign(state, {
    lib: rec.lib, doc: rec.doc, task: rec.task, pages: rec.pages, scale: rec.scale, undo: rec.undo,
    name: rec.name, path: rec.path, handle: rec.handle, size: rec.size, encrypted: rec.encrypted, fitMode: rec.fitMode ?? null,
  });
  state.dirty = rec.dirty;
  els.undo.disabled = !state.undo.some((o) => o.type !== 'draft');
  els.save.disabled = !state.dirty || state.encrypted;
  buildPages();
  els.pages.scrollTop = scrollTop ?? rec.scroll ?? 0;
  if (rec.pendingRatio != null && scrollTop === undefined) { els.pages.scrollTop = rec.pendingRatio * els.pages.scrollHeight; rec.pendingRatio = null; }
  els.pager.hidden = false; setChrome(true);
  els.pageTot.textContent = String(rec.doc.numPages); els.pageNo.value = '1';
  renderTabs();
  renderFav();
  buildThumbs();
  refreshPanels();
  markFit();
  if (state.fitMode) requestAnimationFrame(() => applyFit(state.fitMode));
  setStatus(state.encrypted ? 'PDF cifrato: sola lettura' : '');
}

function renderTabs() {
  els.tabs.replaceChildren();
  for (const rec of docs) {
    const t = document.createElement('div');
    t.className = `tab${rec === active ? ' on' : ''}`;
    t.title = rec.path || rec.name;
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-selected', String(rec === active));
    t.tabIndex = rec === active ? 0 : -1;
    const dirty = rec === active ? state.dirty : rec.dirty;
    const n = document.createElement('span'); n.className = 'tn'; n.textContent = rec.name;
    const d = document.createElement('i'); d.className = 'tdot'; d.hidden = !dirty; d.title = 'Modifiche non salvate'; d.setAttribute('role', 'img');
    const x = document.createElement('button'); x.className = 'tx'; x.innerHTML = ic('close'); x.title = `Chiudi ${rec.name} (Ctrl+W)`; x.tabIndex = -1;
    x.addEventListener('click', (e) => { e.stopPropagation(); closeDoc(rec); });
    t.insertAdjacentHTML('beforeend', ic('file'));
    t.append(n, d, x);
    t.addEventListener('click', () => { if (rec !== active) activate(rec); });
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (rec !== active) activate(rec); }
      else if (e.key === 'Delete') closeDoc(rec);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault(); e.stopPropagation();
        switchTab(e.key === 'ArrowRight' ? 1 : -1);
        els.tabs.querySelector('.tab.on')?.focus();
      }
    });
    t.addEventListener('auxclick', (e) => { if (e.button === 1) closeDoc(rec); });
    // riordino per trascinamento
    t.draggable = true;
    t.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-oledpdf-tab', String(docs.indexOf(rec))));
    t.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-oledpdf-tab')) e.preventDefault(); });
    t.addEventListener('drop', (e) => {
      const from = +e.dataTransfer.getData('application/x-oledpdf-tab');
      if (Number.isNaN(from)) return;
      e.preventDefault();
      const [m] = docs.splice(from, 1);
      docs.splice(docs.indexOf(rec) + (from < docs.indexOf(rec) ? 1 : 0), 0, m);
      renderTabs();
    });
    els.tabs.append(t);
  }
  document.title = docTitle();
  scheduleSession();
}

async function closeDoc(rec) {
  const dirty = rec === active ? state.dirty : rec.dirty;
  if (dirty && !(await confirmDialog({
    title: 'Chiudere senza salvare?', message: `"${rec.name}" ha modifiche non salvate che andranno perse.`,
    ok: 'Chiudi senza salvare', cancel: 'Annulla', danger: true,
  }))) return;
  const i = docs.indexOf(rec);
  if (i < 0) return;
  if (rec === active) active = null; // evita di risalvare lo stato in un documento rimosso
  docs.splice(i, 1);
  kvDel(draftKey(rec.name, rec.size));
  if (!docs.length) { showEmpty(); rec.task?.destroy(); return; }
  if (!active) activate(docs[Math.min(i, docs.length - 1)]);
  else renderTabs();
  rec.task?.destroy();
}

const switchTab = (dir) => {
  if (docs.length < 2) return;
  activate(docs[(docs.indexOf(active) + dir + docs.length) % docs.length]);
};

async function loadBytes(bytes, opts = {}) {
  // lo stesso file già aperto in una scheda: la riattiva invece di duplicarla
  const same = opts.path && !opts.replace && docs.find((d) => d.path === opts.path);
  if (same) { activate(same); return; }

  if (!opts.background) userOpened = true;
  setStatus('Apertura…');
  const prev = opts.replace ? active : null;
  const name = opts.name ?? prev?.name ?? state.name;
  const origSize = opts.structural ? prev.origSize : bytes.length; // dimensione del file su disco: chiave della bozza
  let edited = opts.structural ? bytes : null;

  // Bozza: modifiche non salvate di una sessione precedente dello stesso file (anche pagine aggiunte/rimosse)
  let draft = null;
  if (!opts.noDraft && !opts.structural) {
    const d = await kvGet(draftKey(name, origSize));
    if (d && d.name === name && d.origSize === origSize) { draft = d; if (d.bytes) { edited = d.bytes; bytes = d.bytes; } }
  }

  let lib;
  perf('load: inizio');
  try {
    lib = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
  } catch (e) {
    setStatus('');
    toast(`PDF non leggibile: ${e.message}`, { type: 'error', ms: 8000 });
    return;
  }
  perf('load: pdf-lib');
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const doc = await task.promise;
  perf('load: pdf.js getDocument');
  const proxies = [];
  for (let i = 1; i <= doc.numPages; i += 50) {
    const batch = [];
    for (let j = i; j < Math.min(i + 50, doc.numPages + 1); j++) batch.push(doc.getPage(j));
    proxies.push(...(await Promise.all(batch)));
  }
  perf('load: getPage x N');
  const pages = proxies.map((proxy, index) => ({
    proxy, index, el: null, base: null, ov: null, gridEl: null, vp: null, annots: readAnnots(lib, lib.getPage(index)),
    key: null, task: null, gen: 0, d: 1, stroke: null, rectStart: null, erased: null, raf: 0,
  }));
  pages.forEach((p) => p.annots.forEach((a, i) => { a.ei = i; }));
  perf('load: readAnnots');

  const path = 'path' in opts ? opts.path : prev?.path ?? null;
  const handle = 'handle' in opts ? opts.handle : prev?.handle ?? null;
  const rec = {
    id: ++docSeq, lib, task, doc, pages, size: bytes.length, origSize, edited, encrypted: lib.isEncrypted, undo: [],
    dirty: !!opts.structural || !!draft, scroll: 0, fitMode: opts.replace ? state.fitMode : opts.view ? opts.view.fit ?? null : 'width', pendingRatio: opts.view?.ratio ?? null, name, path, handle, scale: 1,
    bytes: path || handle ? null : bytes, // senza percorso il contenuto va conservato per ripristinare la sessione
  };
  if (draft) { applyDraft(pages, draft.pages); rec.undo = [{ type: 'draft' }]; }

  const w0 = pages[0].proxy.getViewport({ scale: 1 }).width;
  const pcs = getComputedStyle(els.pages);
  const fit = Math.min(6, Math.max(0.2, (els.pages.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight)) / w0));
  rec.scale = opts.view?.scale || (opts.replace ? state.scale : fit);

  const keep = opts.replace ? els.pages.scrollTop : null;
  if (prev) {
    docs[docs.indexOf(prev)] = rec;
    active = null; // lo stato della scheda sostituita non va riscritto
    prev.task?.destroy();
  } else {
    docs.push(rec);
  }
  if (opts.background) { renderTabs(); setStatus(''); return rec; }
  perf('load: prima di activate');
  activate(rec, keep ?? undefined);
  perf('load: activate');
  if (opts.view?.ratio) els.pages.scrollTop = opts.view.ratio * els.pages.scrollHeight;
  return rec;
}

function buildPages() {
  els.pages.replaceChildren();
  for (const p of state.pages) {
    p.el = document.createElement('div'); p.el.className = 'page';
    p.base = document.createElement('canvas');
    p.ov = document.createElement('canvas'); p.ov.className = 'ov';
    p.gridEl = document.createElement('canvas'); p.gridEl.className = 'gridov';
    p.el.append(p.base, p.gridEl, p.ov);
    p.el.dataset.i = p.index;
    attach(p);
    els.pages.append(p.el);
  }
  layout();
}

function layout() {
  lastPager = -1;
  for (const p of state.pages) {
    p.vp = p.proxy.getViewport({ scale: state.scale });
    p.el.style.width = `${p.vp.width}px`;
    p.el.style.height = `${p.vp.height}px`;
    p.task?.cancel(); p.gen++; p.key = null;
  }
  els.zoomPct.textContent = `${Math.round(state.scale * 100)}%`;
  io.disconnect();
  for (const p of state.pages) io.observe(p.el);
}

/* ---------- rendering a richiesta (nessun ciclo continuo) ---------- */
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const p = state.pages[+e.target.dataset.i];
    if (!p) continue;
    if (e.isIntersecting) render(p); else release(p);
  }
  updatePager();
}, { root: els.pages, rootMargin: '120% 0px', threshold: [0, 0.5] });

async function render(p) {
  const d = dpr();
  const key = `${state.scale}|${state.dark}|${d}`;
  if (p.key === key) return;
  p.task?.cancel();
  const gen = ++p.gen;
  p.key = key; p.d = d;
  const vp = p.proxy.getViewport({ scale: state.scale * d });
  const c = p.base;
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d', { alpha: false });
  try {
    p.task = p.proxy.render({ canvasContext: ctx, canvas: c, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE });
    await p.task.promise;
    if (gen !== p.gen) return;
    if (state.dark) darken(c, ctx);
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
    return;
  }
  p.task = null;
  p.ov.width = c.width; p.ov.height = c.height;
  p.gridEl.width = c.width; p.gridEl.height = c.height;
  draw(p); drawGrid(p);
}

function release(p) {
  p.task?.cancel(); p.gen++; p.key = null;
  p.base.width = p.base.height = 0; p.ov.width = p.ov.height = 0; p.gridEl.width = p.gridEl.height = 0;
}

// Inversione una tantum del bitmap: niente filtri CSS attivi durante lo scorrimento.
function darken(c, ctx) {
  ctx.save();
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.restore();
  if ('filter' in ctx) { // mantiene le tinte originali (rosso resta rosso)
    const tmp = document.createElement('canvas');
    tmp.width = c.width; tmp.height = c.height;
    tmp.getContext('2d').drawImage(c, 0, 0);
    ctx.save();
    ctx.filter = 'hue-rotate(180deg)';
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
    tmp.width = tmp.height = 0;
  }
}

/* ---------- griglia sovrapposta ---------- */
function drawGrid(p) {
  const c = p.gridEl, ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!state.grid || !c.width) return;
  const step = 14.17 * state.scale * p.d * 1.0; // ~5 mm
  ctx.strokeStyle = 'rgba(120,160,170,.28)'; ctx.fillStyle = 'rgba(120,160,170,.5)'; ctx.lineWidth = Math.max(1, p.d * 0.6);
  ctx.beginPath();
  if (state.grid === 'lined' || state.grid === 'grid') for (let y = step; y < c.height; y += step) { ctx.moveTo(0, y); ctx.lineTo(c.width, y); }
  if (state.grid === 'grid') for (let x = step; x < c.width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, c.height); }
  ctx.stroke();
  if (state.grid === 'dots') for (let y = step; y < c.height; y += step) for (let x = step; x < c.width; x += step) ctx.fillRect(x - 1, y - 1, 2, 2);
}

/* ---------- disegno delle annotazioni ---------- */
function draw(p) {
  const c = p.ov;
  if (!c.width) return;
  const ctx = c.getContext('2d');
  ctx.setTransform(p.d, 0, 0, p.d, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  for (const a of p.annots) if (!a.deleted) drawAnnot(ctx, p.vp, a);
  if (p.live) drawLive(ctx, p);
  if (p.trail) drawTrail(ctx, p);
}

// Puntatore laser: traccia temporanea che svanisce (il ciclo rAF vive solo finché c'è una traccia visibile).
const LASER_MS = 700;
function laserLoop(p) {
  if (p.laserRaf) return;
  const step = () => {
    const now = performance.now();
    if (p.laserDown && p.trail?.length) p.trail[p.trail.length - 1].t = now;
    p.trail = p.trail?.filter((q) => now - q.t < LASER_MS);
    if (!p.trail?.length) { p.trail = null; p.laserRaf = 0; draw(p); return; }
    draw(p);
    p.laserRaf = requestAnimationFrame(step);
  };
  p.laserRaf = requestAnimationFrame(step);
}

function drawTrail(ctx, p) {
  const s = state.slots.find((x) => x.type === 'laser') || { color: [1, 0, 0], width: 3 };
  const now = performance.now();
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 1; i < p.trail.length; i++) {
    const a = p.trail[i - 1], b = p.trail[i], k = Math.max(0, 1 - (now - b.t) / LASER_MS);
    ctx.strokeStyle = rgba(s.color, k); ctx.lineWidth = s.width * state.scale * (0.4 + k);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  const h = p.trail[p.trail.length - 1];
  ctx.fillStyle = rgba(s.color, Math.max(0, 1 - (now - h.t) / LASER_MS));
  ctx.beginPath(); ctx.arc(h.x, h.y, s.width * state.scale * 1.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawAP(ctx, vp, a) {
  const { ops, bbox, m = [1, 0, 0, 1, 0, 0] } = a.ap;
  const [rx0, ry0, rx1, ry1] = a.rect;
  const sx = (rx1 - rx0) / (bbox[2] - bbox[0]) || 1, sy = (ry1 - ry0) / (bbox[3] - bbox[1]) || 1;
  const T = (x, y) => vp.convertToViewportPoint(
    rx0 + (m[0] * x + m[2] * y + m[4] - bbox[0]) * sx,
    ry0 + (m[1] * x + m[3] * y + m[5] - bbox[1]) * sy,
  );
  const st = { fill: [0, 0, 0], stroke: [0, 0, 0], w: 1 };
  const stack = [];
  const col = (x) => (x.length === 1 ? [x[0], x[0], x[0]] : x.length === 4 ? [(1 - x[0]) * (1 - x[3]), (1 - x[1]) * (1 - x[3]), (1 - x[2]) * (1 - x[3])] : x);
  let cur = null;
  ctx.beginPath();
  const paint = (fill, stroke) => {
    if (fill) { ctx.fillStyle = rgba(st.fill, a.ca); ctx.fill(); }
    if (stroke) { ctx.strokeStyle = rgba(st.stroke, a.ca); ctx.lineWidth = Math.max(0.6, st.w * vp.scale * Math.sqrt(sx * sy)); ctx.lineJoin = 'round'; ctx.stroke(); }
    ctx.beginPath();
  };
  for (const [op, v] of ops) {
    switch (op) {
      case 'q': stack.push({ ...st }); break;
      case 'Q': Object.assign(st, stack.pop() || st); break;
      case 'rg': case 'g': case 'k': st.fill = col(v); break;
      case 'RG': case 'G': case 'K': st.stroke = col(v); break;
      case 'w': st.w = v[0]; break;
      case 'm': { const [x, y] = T(v[0], v[1]); ctx.moveTo(x, y); cur = v; break; }
      case 'l': { const [x, y] = T(v[0], v[1]); ctx.lineTo(x, y); cur = v; break; }
      case 'c': { const p1 = T(v[0], v[1]), p2 = T(v[2], v[3]), p3 = T(v[4], v[5]); ctx.bezierCurveTo(...p1, ...p2, ...p3); cur = v.slice(4); break; }
      case 'v': { const p2 = T(v[0], v[1]), p3 = T(v[2], v[3]); const p1 = cur ? T(cur[0], cur[1]) : p2; ctx.bezierCurveTo(...p1, ...p2, ...p3); cur = v.slice(2); break; }
      case 'y': { const p1 = T(v[0], v[1]), p3 = T(v[2], v[3]); ctx.bezierCurveTo(...p1, ...p3, ...p3); cur = v.slice(2); break; }
      case 're': { const a0 = T(v[0], v[1]), b0 = T(v[0] + v[2], v[1] + v[3]); ctx.rect(Math.min(a0[0], b0[0]), Math.min(a0[1], b0[1]), Math.abs(b0[0] - a0[0]), Math.abs(b0[1] - a0[1])); break; }
      case 'h': ctx.closePath(); break;
      case 'f': case 'F': case 'f*': paint(true, false); break;
      case 'S': paint(false, true); break;
      case 's': ctx.closePath(); paint(false, true); break;
      case 'B': case 'B*': paint(true, true); break;
      case 'b': case 'b*': ctx.closePath(); paint(true, true); break;
      case 'n': ctx.beginPath(); break;
      default: break;
    }
  }
}

const quadBox = (vp, q) => {
  const xs = [], ys = [];
  for (let i = 0; i < 8; i += 2) { const [x, y] = vp.convertToViewportPoint(q[i], q[i + 1]); xs.push(x); ys.push(y); }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const rectBox = (vp, r) => {
  const a = vp.convertToViewportPoint(r[0], r[1]), b = vp.convertToViewportPoint(r[2], r[3]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
};

function drawAnnot(ctx, vp, a) {
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const s = vp.scale;
  if (a.ap && (a.subtype === 'Ink' || a.subtype === 'Square' || a.subtype === 'Circle' || a.subtype === 'Line')) {
    drawAP(ctx, vp, a);
  } else if (a.subtype === 'Ink') {
    ctx.strokeStyle = rgba(a.color, a.ca); ctx.lineWidth = Math.max(1, a.width * s);
    for (const st of a.ink) {
      ctx.beginPath();
      const [x, y] = vp.convertToViewportPoint(st[0], st[1]); ctx.moveTo(x, y);
      if (st.length === 2) ctx.lineTo(x, y);
      for (let i = 2; i < st.length; i += 2) ctx.lineTo(...vp.convertToViewportPoint(st[i], st[i + 1]));
      ctx.stroke();
    }
  } else if (a.subtype === 'Highlight') {
    ctx.fillStyle = rgba(a.color, 0.4);
    for (const q of a.quads) { const [x0, y0, x1, y1] = quadBox(vp, q); ctx.fillRect(x0, y0, x1 - x0, y1 - y0); }
  } else if (a.subtype === 'Underline' || a.subtype === 'StrikeOut' || a.subtype === 'Squiggly') {
    ctx.strokeStyle = rgba(a.color, 1); ctx.lineWidth = Math.max(1, s);
    for (const q of a.quads) {
      const [x0, y0, x1, y1] = quadBox(vp, q); const y = a.subtype === 'StrikeOut' ? (y0 + y1) / 2 : y1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    }
  } else if (a.subtype === 'Square' || a.subtype === 'Circle') {
    const [x0, y0, x1, y1] = rectBox(vp, a.rect), h = (a.width * s) / 2;
    ctx.strokeStyle = rgba(a.color, a.ca); ctx.lineWidth = Math.max(1, a.width * s);
    ctx.beginPath();
    if (a.subtype === 'Square') ctx.rect(x0 + h, y0 + h, x1 - x0 - 2 * h, y1 - y0 - 2 * h);
    else ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 - h, (y1 - y0) / 2 - h, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (a.subtype === 'Line' && a.line) {
    ctx.strokeStyle = rgba(a.color, a.ca); ctx.lineWidth = Math.max(1, a.width * s);
    ctx.beginPath(); ctx.moveTo(...vp.convertToViewportPoint(a.line[0], a.line[1])); ctx.lineTo(...vp.convertToViewportPoint(a.line[2], a.line[3])); ctx.stroke();
  } else if (a.subtype === 'FreeText') {
    const [x0, y0, x1] = rectBox(vp, a.rect);
    ctx.fillStyle = rgba(a.color, 1); ctx.textBaseline = 'top';
    const fs = a.fontSize * s; ctx.font = `${fs}px Helvetica, Arial, sans-serif`;
    let y = y0 + 2 * s;
    for (const para of (a.text || '').split(/\r?\n/)) {
      let line = '';
      for (const w of para.split(' ')) {
        const t = line ? `${line} ${w}` : w;
        if (line && ctx.measureText(t).width > x1 - x0 - 4 * s) { ctx.fillText(line, x0 + 2 * s, y); y += fs * 1.15; line = w; } else line = t;
      }
      ctx.fillText(line, x0 + 2 * s, y); y += fs * 1.15;
    }
  }
  ctx.restore();
}

function drawLive(ctx, p) {
  const L = p.live;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (L.kind === 'highlighter') {
    const xs = L.pts.map((q) => q[0]), ys = L.pts.map((q) => q[1]);
    const th = L.width * state.scale;
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (y1 - y0 < th * 1.5) { const cy = ys.reduce((a, b) => a + b, 0) / ys.length; y0 = cy - th / 2; y1 = cy + th / 2; }
    ctx.fillStyle = rgba(L.color, 0.4);
    ctx.fillRect(Math.min(...xs), y0, Math.max(...xs) - Math.min(...xs), y1 - y0);
  } else if (L.kind === 'marker') {
    ctx.strokeStyle = rgba(L.color, L.opacity ?? 0.35); ctx.lineWidth = L.width * state.scale;
    ctx.beginPath();
    L.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (L.pts.length === 1) ctx.lineTo(L.pts[0][0] + 0.01, L.pts[0][1]);
    ctx.stroke();
  } else if (L.kind === 'rect') {
    ctx.strokeStyle = rgba(L.color, 1); ctx.lineWidth = Math.max(1, L.width * state.scale);
    ctx.strokeRect(L.x0, L.y0, L.x1 - L.x0, L.y1 - L.y0);
  }
  ctx.restore();
}

const requestDraw = (p) => { if (!p.raf) p.raf = requestAnimationFrame(() => { p.raf = 0; draw(p); }); };

/* ---------- interazione ---------- */
const pos = (p, e) => { const r = p.ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const toPdf = (p, x, y) => p.vp.convertToPdfPoint(x, y);
const slotCur = () => state.slots[state.slot];

const eraserSlot = () => state.slots.find((x) => x.type === 'eraser') || { width: 6 };

function attach(p) {
  const ov = p.ov;
  ov.addEventListener('pointerdown', (e) => onDown(p, e));
  ov.addEventListener('pointermove', (e) => onMove(p, e));
  ov.addEventListener('pointerup', (e) => onUp(p, e));
  // Se il sistema annulla il gesto (Windows Ink, flick...) il tratto raccolto fin qui viene comunque conservato.
  ov.addEventListener('pointercancel', (e) => onUp(p, e));
  // Tenere premuto con la penna (o il tasto laterale) apre il menu contestuale e interrompe il tratto.
  ov.addEventListener('contextmenu', (e) => { if (state.tool !== 'view') e.preventDefault(); });
}

function onDown(p, e) {
  if (state.tool === 'view' || state.encrypted) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.pointerType === 'pen' && e.button === 2) return; // tasto laterale della penna
  if (e.pointerType === 'touch' && !state.finger && state.tool !== 'text') {
    // rifiuto del palmo: con uno strumento attivo il dito sposta il foglio a mano (touch-action è "none")
    p.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: els.pages.scrollLeft, sy: els.pages.scrollTop };
    p.ov.setPointerCapture(e.pointerId);
    return;
  }
  e.preventDefault();
  p.ov.setPointerCapture(e.pointerId);
  p.tool = e.pointerType === 'pen' && (e.buttons & 32) ? 'eraser' : state.tool; // la coda della penna cancella
  const [x, y] = pos(p, e);
  const s = slotCur();
  switch (p.tool) {
    case 'pen': p.stroke = { pts: [[x, y, e.pressure || 0.5]], last: [x, y] }; break;
    case 'marker':
      p.stroke = { pts: [[x, y, 0.5]] };
      p.live = { kind: 'marker', pts: p.stroke.pts, color: s.color, width: s.width, opacity: s.opacity };
      requestDraw(p);
      break;
    case 'laser': p.trail = [{ x, y, t: performance.now() }]; p.laserDown = true; laserLoop(p); break;
    case 'highlighter': p.stroke = { pts: [[x, y]] }; p.live = { kind: 'highlighter', pts: p.stroke.pts, color: s.color, width: s.width }; requestDraw(p); break;
    case 'rect': p.rectStart = [x, y]; p.live = { kind: 'rect', x0: x, y0: y, x1: x, y1: y, color: s.color, width: s.width }; break;
    case 'eraser': p.erased = []; eraseAt(p, x, y); break;
    case 'text': openText(p, x, y); break;
    default: break;
  }
}

function onMove(p, e) {
  if (state.tool === 'view' || !p.ov.hasPointerCapture(e.pointerId)) return; // ignora il semplice passaggio del cursore
  if (p.pan && p.pan.id === e.pointerId) {
    els.pages.scrollLeft = p.pan.sx - (e.clientX - p.pan.x);
    els.pages.scrollTop = p.pan.sy - (e.clientY - p.pan.y);
    return;
  }
  const evs = e.getCoalescedEvents?.() || [e];
  const s = slotCur();
  const tool = p.tool || state.tool;
  if (p.stroke && tool === 'pen') {
    // Anteprima incrementale (un solo segmento per evento): il poligono definitivo si calcola al rilascio.
    const ctx = p.ov.getContext('2d');
    ctx.setTransform(p.d, 0, 0, p.d, 0, 0);
    ctx.lineCap = 'round'; ctx.strokeStyle = rgba(s.color, s.opacity ?? 1); ctx.fillStyle = ctx.strokeStyle;
    for (const ev of evs) {
      const [x, y] = pos(p, ev);
      const pr = ev.pressure || 0.5;
      const [lx, ly] = p.stroke.last;
      if (s.style === 'calligraphy') {
        // Stessa punta del tratto definitivo (nibQuads): inclinata a 45° nello spazio PDF (asse y verso l'alto),
        // quindi sullo schermo il vettore è (hx, -hy). Un solo parallelogramma per segmento, con verso coerente.
        const h = (s.width * 1.8 * state.scale) / 2, hx = Math.cos(Math.PI / 4) * h, hy = -Math.sin(Math.PI / 4) * h;
        const q = [[lx + hx, ly + hy], [x + hx, y + hy], [x - hx, y - hy], [lx - hx, ly - hy]];
        const area = (q[1][0] - q[0][0]) * (q[2][1] - q[1][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[1][0]);
        if (area < 0) q.reverse();
        ctx.beginPath();
        q.forEach(([qx, qy], i) => (i ? ctx.lineTo(qx, qy) : ctx.moveTo(qx, qy)));
        ctx.closePath(); ctx.fill();
      } else {
        ctx.lineWidth = Math.max(0.8, s.width * state.scale * (s.style === 'fixed' ? 1 : 0.5 + pr));
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(x, y); ctx.stroke();
      }
      p.stroke.last = [x, y]; p.stroke.pts.push([x, y, pr]);
    }
  } else if (p.trail) {
    const t = performance.now();
    for (const ev of evs) p.trail.push({ x: pos(p, ev)[0], y: pos(p, ev)[1], t });
  } else if (p.stroke && (tool === 'highlighter' || tool === 'marker')) {
    for (const ev of evs) p.stroke.pts.push(tool === 'marker' ? [...pos(p, ev), 0.5] : pos(p, ev));
    requestDraw(p);
  } else if (p.rectStart) {
    const [x, y] = pos(p, e);
    Object.assign(p.live, { x1: x, y1: y });
    requestDraw(p);
  } else if (p.erased) {
    for (const ev of evs) eraseAt(p, ...pos(p, ev));
  }
}

function onUp(p, e) {
  if (p.pan && p.pan.id === e.pointerId) { p.pan = null; return; }
  if (!p.stroke && !p.rectStart && !p.erased && !p.trail) return; // pointerup di semplice navigazione
  const s = slotCur();
  const tool = p.tool || state.tool;
  let made = null;
  p.tool = null;
  if (p.trail) { p.laserDown = false; return; } // il laser svanisce da solo (laserLoop)
  if (p.stroke && INK_TOOLS.has(tool)) {
    const pts = p.stroke.pts.map(([x, y, pr]) => [...toPdf(p, x, y), pr]);
    made = makeInk([{ pts }], s.color, s.width, { style: s.style, opacity: s.opacity, smooth: s.smooth, straighten: s.straighten });
  } else if (p.stroke && tool === 'highlighter') {
    made = makeHighlight(p.stroke.pts.map(([x, y]) => toPdf(p, x, y)), s.color, s.width);
  } else if (p.rectStart) {
    const [x, y] = pos(p, e);
    if (Math.abs(x - p.rectStart[0]) > 3 && Math.abs(y - p.rectStart[1]) > 3) {
      const a = toPdf(p, p.rectStart[0], p.rectStart[1]), b = toPdf(p, x, y);
      made = { id: newId(), subtype: 'Square', color: s.color, ca: 1, width: s.width, existing: false, deleted: false,
        rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] };
    }
  } else if (p.erased) {
    if (p.erased.length) pushUndo({ type: 'del', p, list: p.erased });
    p.erased = null;
    return;
  }
  p.stroke = null; p.rectStart = null; p.live = null;
  if (made) { p.annots.push(made); pushUndo({ type: 'add', p, a: made }); }
  draw(p);
  if (made && !state.lock) selectTool('view');
}

function eraseAt(p, x, y) {
  const [px, py] = toPdf(p, x, y);
  const tol = Math.max(3, (p.tool === 'eraser' && slotCur()?.type !== 'eraser' ? eraserSlot() : slotCur()).width) / state.scale + 2;
  let hit = false;
  for (const a of p.annots) {
    if (a.deleted || !hitTest(a, px, py, tol)) continue;
    a.deleted = true; p.erased.push(a); hit = true;
  }
  if (hit) draw(p);
}

function hitTest(a, px, py, tol) {
  const [x0, y0, x1, y1] = a.rect;
  if (px < x0 - tol || px > x1 + tol || py < y0 - tol || py > y1 + tol) return false;
  if (a.subtype !== 'Ink') return true;
  const r = tol + Math.max(a.width, 1.5) / 2;
  for (const s of a.ink) {
    if (s.length === 2 && Math.hypot(px - s[0], py - s[1]) <= r) return true;
    for (let i = 0; i + 3 < s.length; i += 2) if (segDist(px, py, s[i], s[i + 1], s[i + 2], s[i + 3]) <= r) return true;
  }
  return false;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function openText(p, x, y) {
  const s = slotCur(), ta = document.createElement('textarea');
  ta.className = 'txt';
  Object.assign(ta.style, { left: `${x}px`, top: `${y}px`, width: `${180 * state.scale}px`, height: `${(s.width * 2.6 + 4) * state.scale}px`, fontSize: `${s.width * state.scale}px` });
  p.el.append(ta);
  setTimeout(() => ta.focus(), 0);
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const text = ta.value.trim();
    if (commit && text) {
      const l = ta.offsetLeft, t = ta.offsetTop, w = ta.offsetWidth, h = ta.offsetHeight;
      const a = toPdf(p, l, t + h), b = toPdf(p, l + w, t);
      const made = { id: newId(), subtype: 'FreeText', color: s.color, ca: 1, width: 0, text, fontSize: s.width, existing: false, deleted: false,
        rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] };
      p.annots.push(made); pushUndo({ type: 'add', p, a: made }); draw(p);
      if (!state.lock) selectTool('view');
    }
    ta.remove();
  };
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) finish(true);
  });
}

/* ---------- annulla / stato ---------- */
function setDirty(v) {
  state.dirty = v;
  els.save.disabled = !v || state.encrypted;
  renderTabs();
}
let draftTimer = 0;
// Bozza = modifiche non salvate (annotazioni nuove/eliminate e, se cambiata la struttura, il PDF modificato).
function flushDraftOf(rec) {
  const pages = serializeDraft(rec.pages);
  const key = draftKey(rec.name, rec.origSize);
  if (Object.keys(pages).length || rec.edited) return kvSet(key, { name: rec.name, origSize: rec.origSize, bytes: rec.edited || undefined, pages });
  return kvDel(key);
}
function flushDraft() { if (active && state.doc) { saveActive(); flushDraftOf(active); } }
async function flushAllDrafts() {
  clearTimeout(draftTimer);
  saveActive();
  await Promise.all(docs.map(flushDraftOf));
}function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 1200);
}
function pushUndo(op) { state.undo.push(op); els.undo.disabled = false; setDirty(true); scheduleDraft(); }
function undo() {
  const op = state.undo.pop();
  if (!op || op.type === 'draft') { els.undo.disabled = !state.undo.length; return; }
  scheduleDraft();
  if (op.type === 'add') { const i = op.p.annots.indexOf(op.a); if (i >= 0) op.p.annots.splice(i, 1); }
  else for (const a of op.list) a.deleted = false;
  draw(op.p);
  els.undo.disabled = !state.undo.length;
  setDirty(state.undo.length > 0 || state.dirty);
}

/* ---------- strumenti a destra: preferiti + strumenti personalizzati ---------- */
const TYPES = {
  pen: 'Penna', marker: 'Evidenziatore a mano libera', highlighter: 'Evidenziatore testo', eraser: 'Gomma',
  laser: 'Puntatore laser', text: 'Testo', rect: 'Rettangolo',
};
const TYPE_DEFAULTS = {
  pen: { style: 'pressure', color: [0, 0, 0], width: 2, opacity: 1, smooth: true, straighten: false },
  marker: { style: 'marker', color: [1, 0.87, 0.38], width: 14, opacity: 0.35, smooth: true, straighten: false },
  highlighter: { color: [1, 0.87, 0.38], width: 11 },
  eraser: { color: [0.6, 0.6, 0.6], width: 6 },
  laser: { color: [0.95, 0.1, 0.1], width: 3 },
  text: { color: [0, 0, 0], width: 12 },
  rect: { color: [0.9, 0.15, 0.15], width: 1.5 },
};
const toolName = (s) => s.name || (s.type === 'pen' ? STYLES[s.style] || TYPES.pen : TYPES[s.type]);
const toHex = (c) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

// Icone degli strumenti: Font Awesome (penna, pennino della stilografica, pennarello, evidenziatore, gomma...).
// Il colore dello strumento colora l'icona.
const toolIcon = (s) => (s.type === 'pen' ? (s.style === 'calligraphy' ? 'nib' : s.style === 'fixed' ? 'pencil' : 'pen') : s.type);
const toolColor = (s) => (s.type === 'eraser' ? '#e7b3b3' : rgba(s.color, 1));
// Icona colorata + pallino che mostra lo spessore: si distinguono a colpo d'occhio due penne dello stesso colore.
function glyph(s) {
  const col = toolColor(s);
  const showW = INK_TOOLS.has(s.type) || s.type === 'highlighter' || s.type === 'rect';
  const w = Math.max(3, Math.min(14, Math.round(2 + Math.sqrt(s.width) * 2.2)));
  return ic(toolIcon(s), { color: col }) + (showW ? `<span class="wdot" style="width:${w}px;height:3px;color:${col}"></span>` : '');
}
function renderFav() {
  els.slots.replaceChildren();
  state.slots.forEach((s, i) => {
    const b = document.createElement('button');
    const on = i === state.slot && state.tool !== 'view';
    b.className = `slot${on ? ' on' : ''}`;
    b.title = on ? `${toolName(s)} — clic per modificare` : toolName(s);
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = glyph(s);
    b.draggable = true;
    b.addEventListener('click', () => {
      if (state.slot === i && state.tool !== 'view') { els.pop.hidden = !els.pop.hidden; fillPop(); } else { state.slot = i; selectTool(s.type); }
    });
    b.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', String(i)));
    b.addEventListener('dragover', (e) => e.preventDefault());
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = +e.dataTransfer.getData('text/plain');
      if (Number.isNaN(from) || from === i) return;
      const cur = state.slots[state.slot];
      const [m] = state.slots.splice(from, 1);
      state.slots.splice(i, 0, m);
      state.slot = state.slots.indexOf(cur);
      saveSlots(); renderFav();
    });
    els.slots.append(b);
  });
  $('view').classList.toggle('on', state.tool === 'view');
  $('view').setAttribute('aria-pressed', String(state.tool === 'view'));
  $('lock').classList.toggle('on', state.lock);
  $('lock').setAttribute('aria-pressed', String(state.lock));
  $('lock').innerHTML = ic(state.lock ? 'lock' : 'unlock');
}

function selectTool(t) {
  state.tool = t;
  if (t === 'view') els.pop.hidden = true;
  document.body.dataset.tool = t;
  document.body.dataset.finger = state.finger && t !== 'view' ? '1' : '0';
  renderFav();
}

// Crea un nuovo strumento (o una copia di uno esistente) e apre subito l'editor.
function addTool(type = 'pen', base = null) {
  const s = { type, name: '', ...structuredClone(TYPE_DEFAULTS[type]), ...(base ? structuredClone(base) : {}) };
  state.slots.push(s);
  state.slot = state.slots.length - 1;
  saveSlots();
  selectTool(s.type);
  els.pop.hidden = false;
  fillPop();
  $('popName').focus();
}

function fillPop() {
  const s = slotCur();
  if (!s) return;
  els.popSw.replaceChildren();
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button');
    const on = c.join() === s.color.join();
    b.className = `sw${on ? ' on' : ''}`;
    b.style.background = rgba(c, 1);
    b.title = PALETTE_NAMES[i];
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', () => { s.color = c; saveSlots(); renderFav(); fillPop(); els.popSw.children[i]?.focus(); });
    els.popSw.append(b);
  });
  const ink = INK_TOOLS.has(s.type);
  $('popIcon').innerHTML = ic(toolIcon(s), { color: toolColor(s) });
  $('popName').value = s.name || '';
  $('popName').placeholder = toolName({ ...s, name: '' });
  $('popType').replaceChildren(...Object.entries(TYPES).map(([k, v]) => new Option(v, k, false, k === s.type)));
  $('popColor').value = toHex(s.color);
  els.popW.value = s.width;
  els.popW.max = s.type === 'text' ? 48 : s.type === 'marker' || s.type === 'highlighter' ? 40 : 20;
  $('popWT').textContent = s.type === 'text' ? 'Corpo' : s.type === 'eraser' ? 'Raggio' : 'Spessore';
  showPopValues();
  $('popStyleL').hidden = s.type !== 'pen';
  $('popOpL').hidden = !ink;
  $('popSmL').hidden = !ink;
  $('popStL').hidden = s.type !== 'pen';
  if (s.type === 'pen') {
    $('popStyle').replaceChildren(...Object.entries(STYLES).map(([k, v]) => new Option(v, k, false, k === s.style)));
  }
  $('popOp').value = s.opacity ?? 1;
  $('popSm').checked = s.smooth !== false;
  $('popSt').checked = !!s.straighten;
}
function showPopValues() {
  const s = slotCur();
  if (!s) return;
  $('popWV').textContent = s.type === 'text' ? `${s.width} pt` : `${(+s.width).toFixed(1).replace(/\.0$/, '')}`;
  $('popOpV').textContent = `${Math.round((s.opacity ?? 1) * 100)}%`;
  $('popIcon').innerHTML = ic(toolIcon(s), { color: toolColor(s) });
}
const editSlot = (fn) => { const s = slotCur(); if (!s) return; fn(s); saveSlots(); renderFav(); showPopValues(); };
els.popW.addEventListener('input', () => editSlot((s) => { s.width = +els.popW.value; }));
$('popName').addEventListener('input', (e) => editSlot((s) => { s.name = e.target.value.trim(); }));
$('popColor').addEventListener('input', (e) => { editSlot((s) => { s.color = fromHex(e.target.value); }); });
$('popType').addEventListener('change', (e) => {
  editSlot((s) => {
    const keep = s.name;
    for (const k of ['style', 'opacity', 'smooth', 'straighten']) delete s[k];
    Object.assign(s, structuredClone(TYPE_DEFAULTS[e.target.value]), { type: e.target.value, name: keep });
  });
  selectTool(slotCur().type);
  els.pop.hidden = false;
  fillPop();
});
$('popStyle').addEventListener('change', (e) => editSlot((s) => { s.style = e.target.value; }));
$('popOp').addEventListener('input', () => editSlot((s) => { s.opacity = +$('popOp').value; }));
$('popSm').addEventListener('change', (e) => editSlot((s) => { s.smooth = e.target.checked; }));
$('popSt').addEventListener('change', (e) => editSlot((s) => { s.straighten = e.target.checked; }));
$('popDup').addEventListener('click', () => { const s = slotCur(); if (s) addTool(s.type, { ...s, name: `${toolName(s)} copia` }); });
$('popDel').addEventListener('click', () => {
  if (state.slot < 0) return;
  state.slots.splice(state.slot, 1);
  state.slot = Math.min(state.slot, state.slots.length - 1);
  saveSlots();
  els.pop.hidden = true;
  if (state.slot < 0) selectTool('view'); else selectTool(state.slots[state.slot].type);
});
$('addTool').addEventListener('click', () => addTool('pen'));
$('resetTools').addEventListener('click', async () => {
  if (!(await confirmDialog({
    title: 'Ripristinare gli strumenti?', message: 'Gli strumenti creati o modificati verranno sostituiti da quelli predefiniti.',
    ok: 'Ripristina', danger: true,
  }))) return;
  state.slots = structuredClone(DEFAULT_SLOTS); state.slot = -1; saveSlots(); els.pop.hidden = true; selectTool('view');
});

$('view').addEventListener('click', () => selectTool('view'));
$('lock').addEventListener('click', () => { state.lock = !state.lock; persistPrefs(); renderFav(); });
els.undo.addEventListener('click', undo);

/* ---------- barra superiore ---------- */
// Pagina corrente = quella che occupa il terzo superiore dell'area visibile (calcolata dalla posizione reale di scorrimento).
function currentPage() {
  const mid = els.pages.getBoundingClientRect(), y = mid.top + mid.height / 3;
  for (const p of state.pages) if (p.el.getBoundingClientRect().bottom > y) return p.index;
  return Math.max(0, state.pages.length - 1);
}
let lastPager = -1;
function updatePager() {
  if (!state.pages.length) return;
  const i = currentPage();
  if (i === lastPager) return;
  lastPager = i;
  if (document.activeElement !== els.pageNo) els.pageNo.value = String(i + 1);
  markThumb(i);
}
let scrollRaf = 0;
els.pages.addEventListener('scroll', () => {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updatePager(); });
}, { passive: true });
function goPage(n) {
  const p = state.pages[Math.max(0, Math.min(state.pages.length - 1, n - 1))];
  if (!p) return;
  // pagina più bassa dell'area: centrata; altrimenti allineata in alto
  p.el.scrollIntoView({ block: p.el.offsetHeight < els.pages.clientHeight ? 'center' : 'start' });
  lastPager = -1;
  updatePager();
}
const step = (d) => goPage(currentPage() + 1 + d);
$('prev').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
els.pageNo.addEventListener('change', () => goPage(parseInt(els.pageNo.value, 10) || 1));
function zoom(f) {
  state.fitMode = null; markFit();
  const ratio = els.pages.scrollTop / (els.pages.scrollHeight || 1);
  state.scale = Math.min(6, Math.max(0.25, state.scale * f));
  layout();
  els.pages.scrollTop = ratio * els.pages.scrollHeight;
}
$('zoomIn').addEventListener('click', () => zoom(1.2));
$('zoomOut').addEventListener('click', () => zoom(1 / 1.2));
const zoomReset = () => { if (state.pages.length) zoom(1 / state.scale); };
els.zoomPct.addEventListener('click', zoomReset);
// Adatta alla larghezza / pagina intera: sono modalità che restano attive e si riapplicano da sole
// quando cambiano finestra, pannelli laterali, scheda o pagina.
function applyFit(mode) {
  if (!state.pages.length) return;
  const i = currentPage(), b = state.pages[i].proxy.getViewport({ scale: 1 });
  const cs = getComputedStyle(els.pages);
  const w = els.pages.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = els.pages.clientHeight - 24;
  const sc = mode === 'page' ? Math.min(w / b.width, h / b.height) : w / b.width;
  state.scale = Math.min(6, Math.max(0.2, sc));
  layout();
  goPage(i + 1);
  markFit();
}
function markFit() {
  for (const [id, m] of [['fit', 'width'], ['fitPage', 'page']]) {
    $(id).classList.toggle('on', state.fitMode === m);
    $(id).setAttribute('aria-pressed', String(state.fitMode === m));
  }
}
$('fit').addEventListener('click', () => { state.fitMode = state.fitMode === 'width' ? null : 'width'; if (state.fitMode) applyFit('width'); else markFit(); });
$('fitPage').addEventListener('click', () => { state.fitMode = state.fitMode === 'page' ? null : 'page'; if (state.fitMode) applyFit('page'); else markFit(); });
let fitRaf = 0;
const refit = () => { if (!state.fitMode || fitRaf) return; fitRaf = requestAnimationFrame(() => { fitRaf = 0; applyFit(state.fitMode); }); };
window.addEventListener('resize', refit);els.pages.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });

function invalidateAll() { layout(); }
$('dark').addEventListener('click', (e) => { state.dark = !state.dark; setSwitch(e.currentTarget, state.dark); persistPrefs(); invalidateAll(); renderFav(); });
function setEco(on) { state.eco = on; setSwitch($('eco'), on); invalidateAll(); }
$('eco').addEventListener('click', () => { state.userEco = true; setEco(!state.eco); persistPrefs(); });
$('grid').addEventListener('change', (e) => { state.grid = e.target.value; persistPrefs(); state.pages.forEach(drawGrid); });
// La dimensione dell'interfaccia cambia i margini dell'area pagine: le modalità "adatta" si ricalcolano.
$('uiSize').addEventListener('change', (e) => { state.ui = e.target.value; applyUi(); persistPrefs(); refit(); });
$('contrast').addEventListener('click', (e) => { state.contrast = !state.contrast; setSwitch(e.currentTarget, state.contrast); applyUi(); persistPrefs(); });

// Risparmio automatico quando la batteria è scarica e non in carica (se il browser espone l'API)
navigator.getBattery?.().then((b) => {
  const f = () => { if (!state.userEco) setEco(b.level < 0.3 && !b.charging); };
  b.addEventListener('levelchange', f); b.addEventListener('chargingchange', f); f();
}).catch(() => {});

/* ---------- apertura / salvataggio ---------- */
async function openFromHandle(h) {
  const f = await h.getFile();
  await loadBytes(new Uint8Array(await f.arrayBuffer()), { name: f.name, handle: h });
}
const baseName = (p) => p.split(/[\\/]/).pop();
async function openNative(r) {
  if (r) await loadBytes(new Uint8Array(r.bytes), { name: baseName(r.path), handle: null, path: r.path });
}
async function openDialog() {
  if (window.native) return openNative(await window.native.open());
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      await openFromHandle(h);
    } catch { /* annullato */ }
  } else els.file.click();
}
$('open').addEventListener('click', openDialog);
$('openBig').addEventListener('click', openDialog);
els.file.addEventListener('change', async () => {
  const f = els.file.files[0]; if (!f) return;
  await loadBytes(new Uint8Array(await f.arrayBuffer()), { name: f.name, handle: null });
  els.file.value = '';
});
// Trascinamento di un file: tutta la finestra diventa la zona di rilascio, con un riquadro ben visibile.
const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f && /pdf$/i.test(f.type || f.name)) await loadBytes(new Uint8Array(await f.arrayBuffer()), { name: f.name, handle: null });
  else if (f) toast('Si possono aprire solo file PDF.', { type: 'warn' });
});
window.launchQueue?.setConsumer(async (lp) => { if (lp.files?.[0]) await openFromHandle(lp.files[0]); });

async function save() {
  if (!state.lib || state.encrypted) return;
  setStatus('Salvataggio…');
  try {
    for (const p of state.pages) await applyChanges(state.lib, state.lib.getPage(p.index), p.annots);
    const bytes = await state.lib.save({ useObjectStreams: false, objectsPerTick: 2000 });
    if (window.native) {
      if (state.path) await window.native.write(state.path, bytes);
      else {
        const p = await window.native.saveAs(state.name, bytes); // file trascinato: percorso ignoto → "Salva con nome"
        if (!p) { setStatus(''); return; }
        state.path = p; state.name = baseName(p);
      }
    } else if (state.handle) {
      const w = await state.handle.createWritable();
      await w.write(bytes); await w.close();
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      a.download = state.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    clearTimeout(draftTimer);
    await kvDel(draftKey(state.name, active.origSize));
    await loadBytes(bytes, { replace: true, noDraft: true, name: state.name, path: state.path, handle: state.handle }); // ricarica: verifica anche che il file prodotto sia leggibile
    toast(`Salvato: ${state.name}`, { type: 'ok', ms: 2200 });
  } catch (e) {
    console.error(e); setStatus('');
    toast(`Salvataggio non riuscito: ${e.message}`, { type: 'error', ms: 9000 });
  }
}
els.save.addEventListener('click', save);

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('textarea,input,select,dialog')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); save(); }
  else if ((e.ctrlKey || e.metaKey) && (k === '+' || k === '=')) { e.preventDefault(); if (state.pages.length) zoom(1.2); }
  else if ((e.ctrlKey || e.metaKey) && k === '-') { e.preventDefault(); if (state.pages.length) zoom(1 / 1.2); }
  else if ((e.ctrlKey || e.metaKey) && k === '0') { e.preventDefault(); zoomReset(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'o') { e.preventDefault(); openDialog(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'w') { e.preventDefault(); if (active) closeDoc(active); }
  else if ((e.ctrlKey || e.metaKey) && k === 't') { e.preventDefault(); openDialog(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'n' && window.native) { e.preventDefault(); window.native.newWindow(); }
  else if (e.ctrlKey && k === 'tab') { e.preventDefault(); switchTab(e.shiftKey ? -1 : 1); }
  else if ((e.ctrlKey || e.metaKey) && k === 'f') { e.preventDefault(); if (sidePanel !== 'search') openPanel('search'); $('q').focus(); }
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && state.pages.length && ['arrowright', 'pagedown', 'arrowleft', 'pageup', 'home', 'end'].includes(k)) {
    e.preventDefault();
    if (k === 'arrowright' || k === 'pagedown') step(1); else if (k === 'arrowleft' || k === 'pageup') step(-1);
    else if (k === 'home') goPage(1); else goPage(state.pages.length);
  }
  else if (k === 'escape') selectTool('view');
});
els.newTab.addEventListener('click', openDialog);

/* ---------- colonna pannelli (stile Drawboard): pagine, indice, ricerca, annotazioni, impostazioni ---------- */
const side = $('side'), rail = $('rail');
let sidePanel = null;
const PANELS = ['pages', 'outline', 'search', 'markups', 'more'];
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const thumbsOpen = () => sidePanel === 'pages';

function openPanel(name) {
  sidePanel = sidePanel === name ? null : name;
  side.hidden = !sidePanel;
  document.body.classList.toggle('side', !!sidePanel);
  for (const n of PANELS) $(`p-${n}`).hidden = n !== sidePanel;
  for (const b of rail.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.panel === sidePanel);
    b.setAttribute('aria-expanded', String(b.dataset.panel === sidePanel));
  }
  if (sidePanel === 'pages') buildThumbs();
  else thumbIO?.disconnect();
  if (sidePanel === 'outline') buildOutline();
  if (sidePanel === 'markups') buildMarkups();
  if (sidePanel === 'search') $('q').focus();
  refit();
}
for (const b of rail.querySelectorAll('button')) b.addEventListener('click', () => openPanel(b.dataset.panel));

// Indice (segnalibri del PDF)
async function buildOutline() {
  const list = $('outlineList');
  list.replaceChildren();
  const outline = await state.doc?.getOutline().catch(() => null);
  if (!outline?.length) { list.innerHTML = '<div class="empty">Questo PDF non ha un indice.</div>'; return; }
  const walk = (items, depth) => {
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'item'; b.style.paddingLeft = `${9 + depth * 14}px`;
      b.innerHTML = `${ic('bookmark')}<span>${esc(it.title || '(senza titolo)')}</span>`;
      b.addEventListener('click', async () => {
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await state.doc.getDestination(dest);
          if (Array.isArray(dest)) goPage((await state.doc.getPageIndex(dest[0])) + 1);
        } catch { /* destinazione non valida */ }
      });
      list.append(b);
      if (it.items?.length) walk(it.items, depth + 1);
    }
  };
  walk(outline, 0);
}

// Ricerca nel testo: solo su richiesta (Invio), una pagina alla volta, annullabile.
let searchRun = 0;
async function runSearch(q) {
  const list = $('searchList'), run = ++searchRun;
  list.replaceChildren();
  q = q.trim();
  if (q.length < 2 || !state.doc) return;
  const needle = q.toLowerCase();
  let found = 0;
  const doc = state.doc;
  for (let i = 1; i <= doc.numPages && found < 300; i++) {
    if (run !== searchRun || doc !== state.doc) return;
    const content = await (await doc.getPage(i)).getTextContent();
    const text = content.items.map((t) => t.str).join(' ').replace(/\s+/g, ' ');
    const low = text.toLowerCase();
    for (let at = low.indexOf(needle); at >= 0 && found < 300; at = low.indexOf(needle, at + needle.length)) {
      found++;
      const a = Math.max(0, at - 28), b = Math.min(text.length, at + needle.length + 40);
      const item = document.createElement('button');
      item.className = 'item';
      item.innerHTML = `<small>p. ${i}</small><span>${esc(text.slice(a, at))}<mark>${esc(text.slice(at, at + needle.length))}</mark>${esc(text.slice(at + needle.length, b))}</span>`;
      item.addEventListener('click', () => goPage(i));
      list.append(item);
    }
  }
  if (run !== searchRun) return;
  if (!found) list.innerHTML = '<div class="empty">Nessun risultato.</div>';
  else {
    const head = document.createElement('div');
    head.className = 'summary';
    head.textContent = found >= 300 ? 'Oltre 300 risultati (mostrati i primi 300)' : `${found} ${found === 1 ? 'risultato' : 'risultati'}`;
    list.prepend(head);
  }
}
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(e.target.value); });

// Elenco delle annotazioni (anche quelle create con Drawboard)
const MARKUP_LABEL = { Ink: ['pen', 'Penna'], Highlight: ['highlighter', 'Evidenziatore'], Underline: ['underline', 'Sottolineatura'], StrikeOut: ['strike', 'Barrato'], Squiggly: ['underline', 'Ondulato'], Square: ['rect', 'Rettangolo'], Circle: ['circle', 'Ellisse'], Line: ['line', 'Linea'], FreeText: ['text', 'Testo'] };
function buildMarkups() {
  const list = $('markupList');
  list.replaceChildren();
  const items = []; // { p, rect, label, icon, color, count, text }
  const counts = {};
  for (const p of state.pages) {
    const live = p.annots.filter((a) => !a.deleted);
    for (const a of live) counts[a.subtype] = (counts[a.subtype] || 0) + 1;
    // i tratti di scrittura a mano vicini diventano un solo elemento
    const inks = live.filter((a) => a.subtype === 'Ink');
    const parent = inks.map((_, i) => i);
    const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    const near = (r, q, g) => r[0] - g <= q[2] && q[0] - g <= r[2] && r[1] - g <= q[3] && q[1] - g <= r[3];
    for (let i = 0; i < inks.length; i++) for (let j = i + 1; j < inks.length; j++) if (near(inks[i].rect, inks[j].rect, 10)) parent[root(j)] = root(i);
    const groups = new Map();
    inks.forEach((a, i) => { const r = root(i); (groups.get(r) || groups.set(r, []).get(r)).push(a); });
    for (const g of groups.values()) {
      const rect = [Math.min(...g.map((a) => a.rect[0])), Math.min(...g.map((a) => a.rect[1])), Math.max(...g.map((a) => a.rect[2])), Math.max(...g.map((a) => a.rect[3]))];
      items.push({ p, rect, y: rect[3], icon: 'pen', label: g.length > 1 ? `Scrittura a mano · ${g.length} tratti` : 'Tratto a mano', color: g[0].color });
    }
    for (const a of live) {
      if (a.subtype === 'Ink') continue;
      const [icon, label] = MARKUP_LABEL[a.subtype] || ['pen', a.subtype];
      items.push({ p, rect: a.rect, y: a.rect[3], icon, label: a.text ? a.text.slice(0, 60) : label, color: a.color });
    }
  }
  if (!items.length) { list.innerHTML = '<div class="empty">Nessuna annotazione.</div>'; return; }
  const head = document.createElement('div');
  head.className = 'summary';
  head.textContent = Object.entries(counts).map(([k, n]) => `${n} ${(MARKUP_LABEL[k] || [, k])[1].toLowerCase()}`).join(' · ');
  list.append(head);
  items.sort((x, y) => x.p.index - y.p.index || y.y - x.y); // per pagina, dall'alto in basso
  for (const it of items.slice(0, 500)) {
    const b = document.createElement('button');
    b.className = 'item';
    b.innerHTML = `${ic(it.icon, { color: rgba(it.color, 1) })}<span>${esc(it.label)}</span><small>p. ${it.p.index + 1}</small>`;
    b.addEventListener('click', () => flashAnnot(it.p, { rect: it.rect }));
    list.append(b);
  }
}function flashAnnot(p, a) {
  const [x, y] = p.vp.convertToViewportPoint(a.rect[0], a.rect[3]);
  p.el.scrollIntoView({ block: 'start' });
  els.pages.scrollTop += y - els.pages.clientHeight / 3;
  render(p);
  setTimeout(() => {
    const ctx = p.ov.getContext('2d');
    if (!p.ov.width) return;
    const [x0, y0, x1, y1] = rectBox(p.vp, a.rect);
    ctx.save(); ctx.setTransform(p.d, 0, 0, p.d, 0, 0);
    ctx.strokeStyle = '#3ddc9f'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8);
    ctx.restore();
    setTimeout(() => draw(p), 1100);
  }, 250);
}

const setChrome = (on) => { rail.hidden = !on; els.fav.hidden = !on; $('zoombar').hidden = !on; if (!on && sidePanel) openPanel(sidePanel); };
const refreshPanels = () => {
  $('railCount').textContent = String(state.doc?.numPages ?? 0);
  if (sidePanel === 'outline') buildOutline();
  if (sidePanel === 'markups') buildMarkups();
  if (sidePanel === 'search') runSearch($('q').value);
};

/* ---------- pagine: miniature + modifica del documento (aggiungi, elimina, ruota, riordina) ---------- */
const thumbList = $('thumbList');
const THUMB_W = 132;
let thumbIO = null, busyOp = false, curThumb = -1;

function buildThumbs() {
  thumbIO?.disconnect();
  thumbList.replaceChildren();
  curThumb = -1;
  if (!thumbsOpen() || !state.doc) return;
  thumbIO = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting && !e.target.dataset.done) renderThumb(e.target);
  }, { root: thumbList, rootMargin: '300px 0px' });
  state.pages.forEach((p, i) => {
    const vp = p.proxy.getViewport({ scale: 1 }), h = Math.round((vp.height * THUMB_W) / vp.width);
    const it = document.createElement('div');
    it.className = 'th'; it.dataset.i = i; it.draggable = true; it.tabIndex = 0;
    it.setAttribute('role', 'button'); it.setAttribute('aria-label', `Vai alla pagina ${i + 1}`);
    const c = document.createElement('canvas');
    c.style.width = `${THUMB_W}px`; c.style.height = `${h}px`;
    const n = document.createElement('span'); n.className = 'tnum'; n.textContent = String(i + 1);
    const bar = document.createElement('div'); bar.className = 'tact';
    const mk = (icon, title, fn, cls = '') => {
      const b = document.createElement('button'); b.innerHTML = ic(icon); b.title = title; b.className = cls;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      b.addEventListener('keydown', (e) => e.stopPropagation());
      bar.append(b);
    };
    mk('rotate', 'Ruota di 90°', () => pageOp((l) => rotatePage(l, i), i));
    mk('copy', 'Duplica la pagina', () => pageOp((l) => duplicatePage(l, i), i + 1));
    mk('plus', 'Inserisci una pagina vuota dopo', () => pageOp((l) => insertBlank(l, i + 1), i + 1));
    mk('trash', 'Elimina la pagina', async () => {
      if (await confirmDialog({ title: `Eliminare la pagina ${i + 1}?`, message: 'La pagina e le sue annotazioni verranno rimosse. Puoi ancora chiudere senza salvare per annullare.', ok: 'Elimina', danger: true })) {
        pageOp((l) => removePage(l, i), Math.max(0, i - 1));
      }
    }, 'del');
    it.append(c, n, bar);
    it.addEventListener('click', () => goPage(i + 1));
    it.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goPage(i + 1); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); thumbList.children[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
    });
    it.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/x-oledpdf-page', String(i)));
    it.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-oledpdf-page')) e.preventDefault(); });
    it.addEventListener('drop', (e) => {
      const from = +e.dataTransfer.getData('application/x-oledpdf-page');
      if (Number.isNaN(from) || from === i) return;
      e.preventDefault();
      pageOp((l) => movePage(l, from, i), i);
    });
    thumbList.append(it);
    thumbIO.observe(it);
  });
}

async function renderThumb(it) {
  const p = state.pages[+it.dataset.i];
  if (!p) return;
  it.dataset.done = '1';
  const c = it.querySelector('canvas'), d = Math.min(2, window.devicePixelRatio || 1);
  const base = p.proxy.getViewport({ scale: 1 });
  const vp = p.proxy.getViewport({ scale: (THUMB_W / base.width) * d });
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d', { alpha: false });
  try {
    await p.proxy.render({ canvasContext: ctx, canvas: c, viewport: vp, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
  } catch { return; }
  if (state.dark) darken(c, ctx);
  for (const a of p.annots) if (!a.deleted) drawAnnot(ctx, vp, a); // anche le annotazioni compaiono nelle miniature
}

function markThumb(i) {
  if (!thumbsOpen() || i === curThumb) return;
  curThumb = i;
  for (const el of thumbList.children) el.classList.toggle('cur', +el.dataset.i === i);
  thumbList.children[i]?.scrollIntoView({ block: 'nearest' });
}

// Applica le annotazioni in sospeso, esegue l'operazione sul PDF e ricarica il documento (modificato, da salvare).
async function pageOp(fn, goto) {
  if (!active || state.encrypted || busyOp) return;
  busyOp = true;
  setStatus('Modifica delle pagine…');
  try {
    perf('start pageOp');
    for (const p of state.pages) await applyChanges(state.lib, state.lib.getPage(p.index), p.annots);
    perf('applyChanges');
    try {
      await fn(state.lib);
    } catch (e) {
      // le annotazioni sono già nel documento: risincronizza la vista prima di segnalare l'errore
      const sync = await state.lib.save({ useObjectStreams: false, objectsPerTick: 2000 });
      await loadBytes(sync, { replace: true, structural: true, noDraft: true, name: state.name, path: state.path, handle: state.handle });
      throw e;
    }
    perf('operazione');
    const bytes = await state.lib.save({ useObjectStreams: false, objectsPerTick: 2000 });
    perf('lib.save');
    await loadBytes(bytes, { replace: true, structural: true, noDraft: true, name: state.name, path: state.path, handle: state.handle });
    perf('loadBytes');
    flushDraft();
    perf('flushDraft');
    if (goto != null) goPage(goto + 1);
  } catch (e) {
    console.error(e);
    toast(`Operazione non riuscita: ${e.message}`, { type: 'error', ms: 8000 });
  } finally {
    busyOp = false;
    setStatus('');
  }
}


const curPage = () => Math.max(0, (parseInt(els.pageNo.value, 10) || 1) - 1);
$('addBlank').addEventListener('click', () => pageOp((l) => insertBlank(l, curPage() + 1), curPage() + 1));
$('addPdf').addEventListener('click', () => $('insFile').click());
$('insFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const bytes = new Uint8Array(await f.arrayBuffer()), at = curPage() + 1;
  await pageOp((l) => insertPdf(l, at, bytes), at);
});

/* ---------- sessione: tutte le schede, con zoom e posizione, ripristinate all'avvio ---------- */
let sessTimer = 0;
function scheduleSession() { clearTimeout(sessTimer); sessTimer = setTimeout(saveSession, 600); }

const isMainWindow = !new URLSearchParams(location.search).has('blank'); // le finestre aggiuntive (Ctrl+N) non sovrascrivono la sessione
async function saveSession() {
  if (!isMainWindow) return;
  if (!docs.length) { await kvDel('session'); window.native?.saveSession([], 0); return; }
  saveActive();
  const tabs = docs.map((d) => ({
    name: d.name, path: d.path || undefined, handle: d.handle || undefined, origSize: d.origSize,
    scale: d.scale, ratio: d.ratio ?? 0, fit: (d === active ? state.fitMode : d.fitMode) ?? null, bytes: !d.path && !d.handle && d.bytes && d.bytes.length < 48e6 ? d.bytes : undefined,
  }));
  const ai = Math.max(0, docs.indexOf(active));
  await kvSet('session', { tabs, active: ai, ui: { panel: sidePanel, slot: state.slot, tool: state.tool } });
  if (window.native) {
    const withPath = tabs.filter((t) => t.path);
    await window.native.saveSession(withPath.map(({ path, scale, ratio, fit }) => ({ path, scale, ratio, fit })), Math.max(0, withPath.indexOf(tabs[ai])));
  }
}
const persistAll = async () => { await flushAllDrafts(); await saveSession(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistAll(); });
window.addEventListener('pagehide', persistAll);
// Electron: prima di chiudere la finestra salva tutto, poi conferma. La finestra si chiude sempre, anche con modifiche non salvate.
window.native?.onBeforeClose(async () => { try { await persistAll(); } finally { window.native.closeReady(); } });

window.native?.onOpen(async (p) => { try { await openNative(await window.native.read(p)); } catch (e) { toast(`Impossibile aprire il file: ${e.message}`, { type: 'error', ms: 8000 }); } });

async function resume() {
  if (new URLSearchParams(location.search).has('blank') || userOpened || docs.length) return; // nuova finestra o PDF già aperto: parte vuota
  const sess = await kvGet('session');
  let nat = null;
  if (window.native) { try { nat = await window.native.restore(); } catch { /* nessuna sessione */ } }
  let tabs = sess?.tabs;
  if (!tabs?.length && nat?.tabs.length) tabs = nat.tabs.map((t) => ({ name: baseName(t.path), path: t.path, scale: t.scale, ratio: t.ratio, fit: t.fit }));
  if (!tabs?.length || userOpened || docs.length) return;

  const loaded = [], needPermission = [];
  for (const t of tabs) {
    const opts = { name: t.name, view: { scale: t.scale, ratio: t.ratio, fit: t.fit }, background: true };
    let bytes = null;
    if (t.path && nat) {
      const n = nat.tabs.find((x) => x.path === t.path);
      if (n) { bytes = new Uint8Array(n.bytes); opts.path = t.path; opts.handle = null; }
    } else if (t.handle) {
      let perm = 'prompt';
      try { perm = await t.handle.queryPermission({ mode: 'readwrite' }); } catch { /* API assente */ }
      if (perm === 'granted') {
        try { bytes = new Uint8Array(await (await t.handle.getFile()).arrayBuffer()); opts.handle = t.handle; opts.path = null; } catch { /* file spostato */ }
      } else needPermission.push(t);
    } else if (t.bytes) { bytes = t.bytes; opts.handle = null; opts.path = null; }
    if (bytes) { const rec = await loadBytes(bytes, opts); if (rec) loaded.push(rec); }
  }
  if (loaded.length && !userOpened) {
    activate(loaded[Math.min(sess?.active ?? nat?.active ?? 0, loaded.length - 1)]);
    // riparte anche con lo stesso pannello e lo stesso strumento di prima
    const ui = sess?.ui;
    if (ui?.panel && ui.panel !== sidePanel) openPanel(ui.panel);
    if (ui && ui.slot >= 0 && state.slots[ui.slot] && ui.tool && ui.tool !== 'view') { state.slot = ui.slot; selectTool(state.slots[ui.slot].type); }
  }
  if (needPermission.length && !loaded.length) {
    const b = document.createElement('button');
    b.className = 'btn soft'; b.innerHTML = `${ic('undo')}<span></span>`;
    b.lastChild.textContent = `Riprendi la sessione precedente (${needPermission.length} file)`;
    b.addEventListener('click', async () => {
      b.remove();
      for (const t of needPermission) {
        try {
          if ((await t.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') continue;
          await loadBytes(new Uint8Array(await (await t.handle.getFile()).arrayBuffer()), { name: t.name, handle: t.handle, path: null, view: { scale: t.scale, ratio: t.ratio } });
        } catch { /* ignora */ }
      }
    });
    $('resumeSlot').append(b);
  }
}
if (!window.launchQueue && !window.native) resume();
else setTimeout(() => { if (!docs.length) resume(); }, 400); // lascia priorità a un PDF aperto da Esplora file

if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('sw.js').catch(() => {});


/* ---------- pulsanti di Windows integrati (riduci, ingrandisci, chiudi) ---------- */
if (window.native) {
  document.body.classList.add('native');
  $('winctl').hidden = false;
  $('wMin').addEventListener('click', () => window.native.winMinimize());
  $('wMax').addEventListener('click', () => window.native.winToggleMax());
  $('wClose').addEventListener('click', () => window.native.winClose());
  window.native.onMaxState((max) => {
    $('wMax').innerHTML = ic(max ? 'restore' : 'maximize');
    $('wMax').title = max ? 'Ripristina' : 'Ingrandisci';
  });
}