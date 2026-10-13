// Componenti dell'interfaccia: suggerimenti (tooltip), notifiche, finestre di conferma. Tutto accessibile da tastiera
// e da lettore di schermo; nessun timer attivo quando non c'è nulla da mostrare.
import { computePosition, flip, shift, offset } from '@floating-ui/dom';
import { ic } from './icons.js';

/* ---------- tooltip: sostituiscono i "title" nativi, mostrano la scorciatoia da tastiera ---------- */
const SHORTCUT = /\s*\(((?:Ctrl|Maiusc|Shift|Alt|Esc|F\d)[^)]*)\)\s*$/;
const tip = document.createElement('div');
tip.id = 'tip'; tip.setAttribute('role', 'tooltip'); tip.hidden = true;
let tipFor = null, tipTimer = 0;

// Sposta "title" in data-tip; se il pulsante ha solo un'icona il testo diventa il suo nome accessibile.
function labelize(el) {
  const t = el.getAttribute('title');
  if (t == null) return;
  el.removeAttribute('title');
  el.dataset.tip = t;
  if (!el.textContent.trim() || el.dataset.tipLabel) {
    el.dataset.tipLabel = '1';
    el.setAttribute('aria-label', t.replace(SHORTCUT, ''));
  }
  const m = t.match(SHORTCUT);
  if (m) el.setAttribute('aria-keyshortcuts', m[1].replace(/Maiusc/g, 'Shift'));
}

function placement(el) {
  if (el.closest('#fav')) return 'left';
  if (el.closest('#rail')) return 'right';
  return 'bottom';
}

function showTip(el) {
  const t = el.dataset.tip;
  if (!t) return;
  const m = t.match(SHORTCUT);
  tip.innerHTML = '';
  const s = document.createElement('span'); s.textContent = t.replace(SHORTCUT, '');
  tip.append(s);
  if (m) for (const k of m[1].split(/\s*·\s*/)) { const kb = document.createElement('kbd'); kb.textContent = k; tip.append(kb); }
  tip.hidden = false;
  tipFor = el;
  computePosition(el, tip, { placement: placement(el), middleware: [offset(8), flip(), shift({ padding: 8 })] })
    .then(({ x, y }) => { if (tipFor === el) Object.assign(tip.style, { left: `${x}px`, top: `${y}px` }); });
}
function hideTip() { clearTimeout(tipTimer); tipFor = null; tip.hidden = true; }

function initTips() {
  document.body.append(tip);
  for (const el of document.querySelectorAll('[title]')) labelize(el);
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'attributes') labelize(m.target);
      else for (const n of m.addedNodes) if (n.nodeType === 1) { labelize(n); for (const el of n.querySelectorAll('[title]')) labelize(el); }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.('[data-tip]');
    if (el === tipFor) return;
    hideTip();
    if (el) tipTimer = setTimeout(() => showTip(el), 450);
  });
  document.addEventListener('pointerout', (e) => { if (tipFor && !tipFor.contains(e.relatedTarget)) hideTip(); else if (!tipFor) clearTimeout(tipTimer); });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-tip]'); hideTip(); if (el?.matches(':focus-visible')) showTip(el); });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
}

/* ---------- notifiche ---------- */
const toasts = document.createElement('div');
toasts.id = 'toasts'; toasts.setAttribute('role', 'status'); toasts.setAttribute('aria-live', 'polite');

const TOAST_ICON = { info: 'info', ok: 'ok', error: 'error', warn: 'warn' };
export function toast(msg, { type = 'info', ms = 3200 } = {}) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = ic(TOAST_ICON[type] || 'info');
  const s = document.createElement('span'); s.textContent = msg; t.append(s);
  const x = document.createElement('button'); x.className = 'toast-x'; x.innerHTML = ic('close'); x.setAttribute('aria-label', 'Chiudi notifica');
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 180); };
  x.addEventListener('click', close);
  t.append(x);
  toasts.append(t);
  if (ms) setTimeout(close, ms);
  return close;
}

// Indicatore di attività ("Apertura…", "Salvataggio…"): una sola pillola, nessuna animazione quando è nascosta.
const busy = document.createElement('div');
busy.id = 'busy'; busy.hidden = true; busy.setAttribute('role', 'status'); busy.setAttribute('aria-live', 'polite');
export function setBusy(text) {
  busy.hidden = !text;
  busy.innerHTML = text ? `<span class="spin" aria-hidden="true"></span><span></span>` : '';
  if (text) busy.lastChild.textContent = text;
}

/* ---------- finestre di dialogo (sostituiscono confirm/alert) ---------- */
export function confirmDialog({ title, message, ok = 'Conferma', cancel = 'Annulla', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `<form method="dialog"><h2></h2><p></p><div class="dlg-row">
      <button value="cancel" class="btn ghost"></button><button value="ok" class="btn ${danger ? 'danger-solid' : 'primary'}"></button></div></form>`;
    d.querySelector('h2').textContent = title;
    d.querySelector('p').textContent = message;
    const [bc, bo] = d.querySelectorAll('button');
    bc.textContent = cancel; bo.textContent = ok;
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
    document.body.append(d);
    d.showModal();
    (danger ? bc : bo).focus();
  });
}

export function initUI() {
  document.body.append(toasts, busy);
  initTips();
}
