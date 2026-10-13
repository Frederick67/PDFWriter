// Persistenza della sessione: impostazioni (localStorage) e documento/bozza (IndexedDB).
// Solo scritture legate a eventi (nessun timer periodico): zero lavoro in background.
const DB = 'oledpdf', ST = 'kv';

const open = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(ST);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const run = async (mode, fn) => {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const q = fn(db.transaction(ST, mode).objectStore(ST));
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  } catch {
    return undefined; // modalità privata / storage bloccato: la sessione semplicemente non persiste
  }
};

export const kvGet = (k) => run('readonly', (s) => s.get(k));
export const kvSet = (k, v) => run('readwrite', (s) => s.put(v, k));
export const kvDel = (k) => run('readwrite', (s) => s.delete(k));

export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem('oledpdf.prefs')) || {}; } catch { return {}; }
}
export function savePrefs(p) {
  try { localStorage.setItem('oledpdf.prefs', JSON.stringify(p)); } catch { /* ignore */ }
}

// Bozza = modifiche non ancora salvate: annotazioni nuove + indici delle esistenti eliminate.
export function serializeDraft(pages) {
  const out = {};
  for (const p of pages) {
    const added = p.annots.filter((a) => !a.existing && !a.deleted).map(({ dict, ...rest }) => rest);
    const deleted = p.annots.filter((a) => a.existing && a.deleted).map((a) => a.ei);
    if (added.length || deleted.length) out[p.index] = { added, deleted };
  }
  return out;
}

export function applyDraft(pages, draft) {
  for (const [i, d] of Object.entries(draft)) {
    const p = pages[+i];
    if (!p) continue;
    for (const ei of d.deleted) { const a = p.annots.find((x) => x.ei === ei); if (a) a.deleted = true; }
    for (const a of d.added) p.annots.push({ ...a, existing: false, deleted: false });
  }
}
