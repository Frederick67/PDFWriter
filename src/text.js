// Geometria del testo della pagina (items di pdf.js getTextContent) in coordinate PDF:
// evidenziatore agganciato alle righe e risultati della ricerca evidenziati sulla pagina.

// Riquadro verticale di un item: dalla discendente all'ascendente approssimate. Solo testo orizzontale.
function itemBox(it) {
  const [a, b, c, d, e, f] = it.transform;
  if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || a <= 0) return null;
  const h = it.height || Math.abs(d) || 0;
  if (!h || !it.width) return null;
  return { x0: e, x1: e + it.width, y0: f - h * 0.24, y1: f + h * 0.92, h };
}

const quad = (x0, y0, x1, y1) => [x0, y1, x1, y1, x0, y0, x1, y0];

// Unisce i pezzi sulla stessa riga che si toccano.
function mergeLine(segs) {
  segs.sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y0 - s.y0) < s.h * 0.35 && s.x0 - last.x1 < s.h * 0.6) {
      last.x1 = Math.max(last.x1, s.x1); last.y0 = Math.min(last.y0, s.y0); last.y1 = Math.max(last.y1, s.y1);
    } else out.push({ ...s });
  }
  return out.map((s) => quad(s.x0, s.y0, s.x1, s.y1));
}

// Righe di testo coperte dal tratto dell'evidenziatore (band = [x0, y0, x1, y1] in coordinate PDF).
// Il taglio orizzontale si allinea ai caratteri (larghezza media dell'item).
export function textQuads(items, [bx0, by0, bx1, by1]) {
  const segs = [];
  for (const it of items) {
    if (!it.str?.trim()) continue;
    const box = itemBox(it);
    if (!box) continue;
    const ov = Math.min(box.y1, by1) - Math.max(box.y0, by0);
    if (ov < Math.min(box.y1 - box.y0, by1 - by0) * 0.4) continue;
    if (box.x1 < bx0 || box.x0 > bx1) continue;
    const n = it.str.length, cw = it.width / n;
    const c0 = Math.max(0, Math.min(n, Math.floor((bx0 - box.x0) / cw + 0.35)));
    const c1 = Math.max(0, Math.min(n, Math.ceil((bx1 - box.x0) / cw - 0.35)));
    if (c1 <= c0) continue;
    segs.push({ x0: box.x0 + c0 * cw, x1: box.x0 + c1 * cw, y0: box.y0, y1: box.y1, h: box.h });
  }
  return mergeLine(segs);
}

// Ricerca nel testo di una pagina: spazi compressi, maiuscole ignorate. Restituisce [{ quads, before, match, after }].
export function findInItems(items, query, limit = Infinity) {
  const needle = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!needle) return [];
  let text = '', orig = '';
  const map = []; // per ogni carattere di `text`: [indice item, indice carattere] oppure null
  const push = (ch, ref) => {
    if (/\s/.test(ch)) { if (text && !text.endsWith(' ')) { text += ' '; orig += ' '; map.push(ref); } } else { text += ch.toLowerCase(); orig += ch; map.push(ref); }
  };
  items.forEach((it, i) => {
    for (let j = 0; j < (it.str || '').length; j++) push(it.str[j], [i, j]);
    push(' ', null);
  });
  const out = [];
  for (let at = text.indexOf(needle); at >= 0 && out.length < limit; at = text.indexOf(needle, at + needle.length)) {
    const per = new Map();
    for (let k = at; k < at + needle.length; k++) {
      const ref = map[k];
      if (!ref) continue;
      const [i, j] = ref, r = per.get(i) || [j, j + 1];
      r[0] = Math.min(r[0], j); r[1] = Math.max(r[1], j + 1);
      per.set(i, r);
    }
    const segs = [];
    for (const [i, [c0, c1]] of per) {
      const it = items[i], box = itemBox(it);
      if (!box) continue;
      const cw = it.width / it.str.length;
      segs.push({ x0: box.x0 + c0 * cw, x1: box.x0 + c1 * cw, y0: box.y0, y1: box.y1, h: box.h });
    }
    // frammento di contesto per l'elenco dei risultati (con le maiuscole originali)
    const a = Math.max(0, at - 28), b = Math.min(orig.length, at + needle.length + 40);
    out.push({ quads: mergeLine(segs), before: orig.slice(a, at), match: orig.slice(at, at + needle.length), after: orig.slice(at + needle.length, b) });
  }
  return out;
}
