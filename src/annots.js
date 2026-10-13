// Lettura/scrittura di annotazioni PDF standard (le stesse chiavi che usa Drawboard PDF:
// Subtype, Rect, C, CA, BS, InkList, QuadPoints, L, DA, Contents, NM, AP).
// Le annotazioni esistenti non vengono mai riscritte: si possono solo rimuovere dalla pagina.
// Le nuove ricevono un normale stream /AP, quindi restano visibili in qualunque lettore.
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFString, PDFHexString, PDFRawStream,
  StandardFonts, decodePDFRawStream,
} from 'pdf-lib';

export const SUPPORTED = new Set([
  'Ink', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Square', 'Circle', 'Line', 'FreeText',
]);

const N = (s) => PDFName.of(s);
let seq = 0;
export const newId = () => `oledpdf-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const numsOf = (ctx, arr) => {
  if (!(arr instanceof PDFArray)) return null;
  return arr.asArray().map((o) => {
    const v = ctx.lookup(o);
    return v instanceof PDFNumber ? v.asNumber() : NaN;
  });
};

const textOf = (v) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : '');

function toRgb(c) {
  if (!c || !c.length) return [0, 0, 0];
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 4) return [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
  return c.slice(0, 3);
}

// Interprete minimo dello stream /AP: solo operatori di percorso e colore.
// Drawboard salva l'inchiostro come poligono pieno (la pressione è "cotta" nella forma),
// quindi per mostrarlo fedelmente bisogna eseguire l'AP, non ridisegnare InkList.
const AP_OPS = new Set([
  'q', 'Q', 'rg', 'RG', 'g', 'G', 'k', 'K', 'w', 'm', 'l', 'c', 'v', 'y', 'h', 're',
  'f', 'F', 'f*', 'S', 's', 'B', 'B*', 'b', 'b*', 'n', 'gs', 'J', 'j', 'M', 'i',
]);
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)$/;

function tokenizeAP(text) {
  const ops = [];
  let args = [];
  for (const tok of text.match(/\S+/g) || []) {
    if (NUM.test(tok)) args.push(parseFloat(tok));
    else if (tok[0] === '/') args.push(tok);
    else if (AP_OPS.has(tok)) { ops.push([tok, args]); args = []; }
    else return null; // testo, immagini, matrici...: si usa il disegno di ripiego
  }
  return ops;
}

function parseAP(ctx, d) {
  const ap = d.lookup(N('AP'));
  if (!(ap instanceof PDFDict)) return null;
  const n = ap.lookup(N('N'));
  if (!(n instanceof PDFRawStream)) return null;
  const bbox = numsOf(ctx, n.dict.lookup(N('BBox')));
  if (!bbox || bbox.length < 4 || bbox.some(Number.isNaN)) return null;
  // Matrix affine completa (anche rotazioni di pagina): si applica prima del mapping BBox → Rect.
  const m = numsOf(ctx, n.dict.lookup(N('Matrix'))) || [1, 0, 0, 1, 0, 0];
  if (m.length < 6 || m.some(Number.isNaN)) return null;
  const cx = [bbox[0], bbox[2], bbox[0], bbox[2]], cy = [bbox[1], bbox[1], bbox[3], bbox[3]];
  const tx = cx.map((x, i) => m[0] * x + m[2] * cy[i] + m[4]);
  const ty = cx.map((x, i) => m[1] * x + m[3] * cy[i] + m[5]);
  const tb = [Math.min(...tx), Math.min(...ty), Math.max(...tx), Math.max(...ty)];
  try {
    const ops = tokenizeAP(new TextDecoder('latin1').decode(decodePDFRawStream(n).decode()));
    return ops && ops.length ? { ops, bbox: tb, m } : null;
  } catch {
    return null;
  }
}

export function readAnnots(lib, page) {
  const ctx = lib.context;
  const list = page.node.Annots();
  const out = [];
  if (!list) return out;
  for (const entry of list.asArray()) {
    const d = ctx.lookup(entry);
    if (!(d instanceof PDFDict)) continue;
    const st = d.lookup(N('Subtype'));
    const subtype = st instanceof PDFName ? st.decodeText() : '';
    if (!SUPPORTED.has(subtype)) continue;
    const flags = d.lookup(N('F'));
    if (flags instanceof PDFNumber && (flags.asNumber() & 2)) continue; // Hidden
    const r = numsOf(ctx, d.lookup(N('Rect')));
    if (!r || r.length < 4 || r.some(Number.isNaN)) continue;
    const rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];

    const bs = d.lookup(N('BS'));
    const border = numsOf(ctx, d.lookup(N('Border')));
    let width = 1;
    if (bs instanceof PDFDict && bs.lookup(N('W')) instanceof PDFNumber) width = bs.lookup(N('W')).asNumber();
    else if (border && border.length >= 3 && !Number.isNaN(border[2])) width = border[2];

    const ca = d.lookup(N('CA'));
    const a = {
      id: textOf(d.lookup(N('NM'))) || newId(),
      subtype, rect, existing: true, deleted: false, dict: d,
      color: toRgb(numsOf(ctx, d.lookup(N('C')))),
      ca: ca instanceof PDFNumber ? ca.asNumber() : 1,
      width,
    };
    if (subtype === 'Ink') {
      const il = d.lookup(N('InkList'));
      if (!(il instanceof PDFArray)) continue;
      a.ink = il.asArray().map((s) => numsOf(ctx, ctx.lookup(s))).filter((s) => s && s.length >= 2);
      a.ap = parseAP(ctx, d);
    } else if (['Square', 'Circle', 'Line'].includes(subtype)) {
      a.ap = parseAP(ctx, d);
      if (subtype === 'Line') {
        a.line = numsOf(ctx, d.lookup(N('L')));
        if (!a.line || a.line.length < 4) continue;
      }
    } else if (['Highlight', 'Underline', 'StrikeOut', 'Squiggly'].includes(subtype)) {
      const q = numsOf(ctx, d.lookup(N('QuadPoints')));
      a.quads = [];
      if (q) for (let i = 0; i + 7 < q.length; i += 8) a.quads.push(q.slice(i, i + 8));
      if (!a.quads.length) a.quads.push([r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]]);
    } else if (subtype === 'Line') {
      a.line = numsOf(ctx, d.lookup(N('L')));
      if (!a.line || a.line.length < 4) continue;
    } else if (subtype === 'FreeText') {
      a.text = textOf(d.lookup(N('Contents')));
      const da = textOf(d.lookup(N('DA')));
      const fs = /([\d.]+)\s+Tf/.exec(da);
      a.fontSize = fs ? parseFloat(fs[1]) || 12 : 12;
      const col = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
      if (col) a.color = [+col[1], +col[2], +col[3]];
    }
    out.push(a);
  }
  return out;
}

// Contorno pieno di un tratto a larghezza variabile. tri = [x, y, larghezza, ...] in unità PDF.
export function outline(tri) {
  const pts = [];
  for (let i = 0; i < tri.length; i += 3) {
    const n = pts.length;
    if (n && Math.hypot(tri[i] - pts[n - 1][0], tri[i + 1] - pts[n - 1][1]) < 0.05) continue;
    pts.push([tri[i], tri[i + 1], tri[i + 2]]);
  }
  const poly = [];
  if (pts.length === 1) {
    const [x, y, w] = pts[0];
    for (let k = 0; k < 14; k++) poly.push(x + Math.cos((k / 14) * 2 * Math.PI) * w / 2, y + Math.sin((k / 14) * 2 * Math.PI) * w / 2);
    return poly;
  }
  const L = [], R = [], dirs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, r = pts[i][2] / 2;
    dirs.push([ux, uy]);
    L.push(pts[i][0] - uy * r, pts[i][1] + ux * r);
    R.push(pts[i][0] + uy * r, pts[i][1] - ux * r);
  }
  const cap = (c, d, sign) => {
    const out = [], r = c[2] / 2, nx = -d[1], ny = d[0];
    for (let k = 1; k < 6; k++) {
      const t = (k / 6) * Math.PI;
      out.push(c[0] + sign * (nx * Math.cos(t) + d[0] * Math.sin(t)) * r, c[1] + sign * (ny * Math.cos(t) + d[1] * Math.sin(t)) * r);
    }
    return out;
  };
  const n = pts.length;
  poly.push(...L, ...cap(pts[n - 1], dirs[n - 1], 1));
  for (let i = n - 1; i >= 0; i--) poly.push(R[i * 2], R[i * 2 + 1]);
  // cap iniziale: da R[0] a L[0] passando dietro il punto
  poly.push(...cap(pts[0], dirs[0], -1));
  return poly;
}

// ---- Adattamento a Bézier cubiche (Schneider, "PathFitter"): la stessa famiglia di algoritmi che
// drawboard-ink-lib.dll usa (path_fitter.cpp: tan1/tan2 unitari, bezier.size() == 4) per i suoi contorni.
const vs = (a, b) => [a[0] - b[0], a[1] - b[1]];
const va = (a, b) => [a[0] + b[0], a[1] + b[1]];
const vm = (a, s) => [a[0] * s, a[1] * s];
const vd = (a, b) => a[0] * b[0] + a[1] * b[1];
const vl = (a) => Math.hypot(a[0], a[1]);
const vn = (a) => { const l = vl(a) || 1; return [a[0] / l, a[1] / l]; };
const bez = (c, t) => {
  const m = 1 - t, a = m * m * m, b = 3 * m * m * t, d = 3 * m * t * t, e = t * t * t;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
};
const bez1 = (c, t) => {
  const m = 1 - t;
  return [0, 1].map((k) => 3 * (m * m * (c[1][k] - c[0][k]) + 2 * m * t * (c[2][k] - c[1][k]) + t * t * (c[3][k] - c[2][k])));
};
const bez2 = (c, t) => {
  const m = 1 - t;
  return [0, 1].map((k) => 6 * (m * (c[2][k] - 2 * c[1][k] + c[0][k]) + t * (c[3][k] - 2 * c[2][k] + c[1][k])));
};

export function fitCurve(pts, error) {
  const n = pts.length, out = [];
  if (n < 2) return out;
  const E2 = error * error;

  const gen = (first, last, u, t1, t2) => {
    const p0 = pts[first], p3 = pts[last];
    const C = [[0, 0], [0, 0]], X = [0, 0];
    for (let i = 0; i <= last - first; i++) {
      const m = 1 - u[i], b1 = 3 * u[i] * m * m, b2 = 3 * u[i] * u[i] * m;
      const a1 = vm(t1, b1), a2 = vm(t2, b2);
      C[0][0] += vd(a1, a1); C[0][1] += vd(a1, a2); C[1][1] += vd(a2, a2);
      const tmp = vs(pts[first + i], va(vm(p0, m * m * m + b1), vm(p3, b2 + u[i] ** 3)));
      X[0] += vd(a1, tmp); X[1] += vd(a2, tmp);
    }
    C[1][0] = C[0][1];
    const det = C[0][0] * C[1][1] - C[1][0] * C[0][1];
    const seg = vl(vs(p3, p0)), eps = 1e-6 * seg;
    let aL = 0, aR = 0;
    if (Math.abs(det) > 1e-12) {
      aL = (X[0] * C[1][1] - X[1] * C[0][1]) / det;
      aR = (C[0][0] * X[1] - C[1][0] * X[0]) / det;
    }
    if (aL < eps || aR < eps) aL = aR = seg / 3;
    return [p0, va(p0, vm(t1, aL)), va(p3, vm(t2, aR)), p3];
  };
  const maxErr = (first, last, c, u) => {
    let max = 0, idx = Math.floor((last - first + 1) / 2);
    for (let i = 1; i < last - first; i++) {
      const d = vs(bez(c, u[i]), pts[first + i]), e = vd(d, d);
      if (e >= max) { max = e; idx = i; }
    }
    return [max, idx];
  };
  const reparam = (first, last, u, c) => u.map((ui, i) => {
    const d = vs(bez(c, ui), pts[first + i]), d1 = bez1(c, ui), d2 = bez2(c, ui);
    const den = vd(d1, d1) + vd(d, d2);
    return den ? Math.min(1, Math.max(0, ui - vd(d, d1) / den)) : ui;
  });
  const chord = (first, last) => {
    const u = [0];
    for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + vl(vs(pts[i], pts[i - 1])));
    const tot = u[u.length - 1] || 1;
    return u.map((v) => v / tot);
  };
  const fit = (first, last, t1, t2) => {
    if (last - first === 1) {
      const p0 = pts[first], p3 = pts[last], d = vl(vs(p3, p0)) / 3;
      out.push([p0, va(p0, vm(t1, d)), va(p3, vm(t2, d)), p3]);
      return;
    }
    let u = chord(first, last), c = gen(first, last, u, t1, t2), [e, idx] = maxErr(first, last, c, u);
    if (e < E2) { out.push(c); return; }
    if (e < E2 * 16) {
      for (let k = 0; k < 4; k++) {
        u = reparam(first, last, u, c); c = gen(first, last, u, t1, t2); [e, idx] = maxErr(first, last, c, u);
        if (e < E2) { out.push(c); return; }
      }
    }
    const split = first + idx, tc = vn(vs(pts[split - 1], pts[split + 1]));
    fit(first, split, t1, tc);
    fit(split, last, vm(tc, -1), t2);
  };
  fit(0, n - 1, vn(vs(pts[1], pts[0])), vn(vs(pts[n - 2], pts[n - 1])));
  return out;
}

const bezOps = (curves) => curves.map((c) => ['c', [c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]]]);
const polyToPath = (p) => {
  const ops = [['m', [p[0], p[1]]]];
  for (let i = 2; i < p.length; i += 2) ops.push(['l', [p[i], p[i + 1]]]);
  ops.push(['h', []]);
  return ops;
};

// Contorno pieno di un tratto a larghezza variabile, con i due bordi adattati a Bézier. tri = [x, y, larghezza, ...]
function outlinePath(tri, error) {
  const pts = [];
  for (let i = 0; i < tri.length; i += 3) {
    const n = pts.length;
    if (n && Math.hypot(tri[i] - pts[n - 1][0], tri[i + 1] - pts[n - 1][1]) < 0.05) continue;
    pts.push([tri[i], tri[i + 1], tri[i + 2]]);
  }
  if (pts.length < 4) return polyToPath(outline(tri)); // tratti brevissimi: poligono semplice
  const L = [], R = [], dirs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, r = pts[i][2] / 2;
    dirs.push([dx / len, dy / len]);
    L.push([pts[i][0] - (dy / len) * r, pts[i][1] + (dx / len) * r]);
    R.push([pts[i][0] + (dy / len) * r, pts[i][1] - (dx / len) * r]);
  }
  const cap = (c, d, sign) => {
    const out = [], r = c[2] / 2;
    for (let k = 1; k < 6; k++) {
      const t = (k / 6) * Math.PI;
      out.push([c[0] + sign * (-d[1] * Math.cos(t) + d[0] * Math.sin(t)) * r, c[1] + sign * (d[0] * Math.cos(t) + d[1] * Math.sin(t)) * r]);
    }
    return out;
  };
  const n = pts.length, Rrev = R.slice().reverse();
  const ops = [['m', L[0]], ...bezOps(fitCurve(L, error))];
  for (const p of [...cap(pts[n - 1], dirs[n - 1], 1), Rrev[0]]) ops.push(['l', p]);
  ops.push(...bezOps(fitCurve(Rrev, error)));
  for (const p of [...cap(pts[0], dirs[0], -1), L[0]]) ops.push(['l', p]);
  ops.push(['h', []]);
  return ops;
}

const pathRect = (paths, pad) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const path of paths) {
    for (const [, v] of path) {
      for (let i = 0; i + 1 < v.length; i += 2) {
        x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]);
        y0 = Math.min(y0, v[i + 1]); y1 = Math.max(y1, v[i + 1]);
      }
    }
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
};

// Tutti i sotto-percorsi in un unico riempimento (nonzero): con opacità < 1 le sovrapposizioni non si scuriscono.
const apFromPaths = (color, paths) => [['rg', color], ...paths.flat(), ['f', []]];

// Chaikin: smussa il tratto (come "Ink smoothing" di Drawboard) mantenendo estremi e pressione.
export function chaikin(pts, iterations) {
  let cur = pts;
  for (let k = 0; k < iterations && cur.length > 2; k++) {
    const out = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i], b = cur[i + 1];
      out.push(a.map((v, j) => 0.75 * v + 0.25 * b[j]), a.map((v, j) => 0.25 * v + 0.75 * b[j]));
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

// "Ink to line": se il tratto è quasi rettilineo lo trasforma in un segmento.
function straighten(pts) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 12) return pts;
  let dev = 0;
  for (const p of pts) dev = Math.max(dev, Math.abs((b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0]) / len);
  return dev < len * 0.04 ? [a, b] : pts;
}

// Punta piatta (stilografica/calligrafia): un parallelogramma per segmento, tutti con lo stesso verso.
function nibQuads(pts, w, angle) {
  const hx = (Math.cos(angle) * w) / 2, hy = (Math.sin(angle) * w) / 2;
  const quads = [];
  const seg = pts.length === 1 ? [pts[0], pts[0]] : null;
  const list = seg ? [seg] : pts.slice(1).map((p, i) => [pts[i], p]);
  for (const [p0, p1] of list) {
    const q = [p0[0] + hx, p0[1] + hy, p1[0] + hx, p1[1] + hy, p1[0] - hx, p1[1] - hy, p0[0] - hx, p0[1] - hy];
    const area = (q[2] - q[0]) * (q[5] - q[3]) - (q[3] - q[1]) * (q[4] - q[2]);
    if (area < 0) quads.push([q[6], q[7], q[4], q[5], q[2], q[3], q[0], q[1]]); else quads.push(q);
  }
  return quads;
}

// strokes: [{ pts: [[x, y, pressione 0..1], ...] }] già in coordinate PDF.
// opts: { style: 'pressure'|'fixed'|'calligraphy'|'marker', opacity, smooth, straighten }
export function makeInk(strokes, color, baseWidth, opts = {}) {
  const style = opts.style || 'pressure';
  const centre = [], polys = [];
  for (const s of strokes) {
    let pts = s.pts;
    if (opts.straighten) pts = straighten(pts);
    if (opts.smooth !== false && pts.length > 2) pts = chaikin(pts, 2);
    const flat = [];
    for (const [x, y] of pts) flat.push(x, y);
    const idx = simplifyIdx(flat, 0.15);
    const kept = idx.map((i) => pts[i]);
    centre.push(kept.flatMap((p) => [p[0], p[1]]));
    if (style === 'calligraphy') {
      for (const q of nibQuads(kept, baseWidth * 1.8, Math.PI / 4)) polys.push(polyToPath(q));
    } else {
      const k = style === 'pressure' ? (p) => baseWidth * (0.5 + p[2]) : () => baseWidth; // mouse/dito = 0.5 → larghezza nominale
      polys.push(outlinePath(kept.flatMap((p) => [p[0], p[1], k(p)]), 0.25));
    }
  }
  const rect = pathRect(polys, 0.5);
  const ca = opts.opacity ?? (style === 'marker' ? 0.35 : 1);
  return {
    id: newId(), subtype: 'Ink', color, ca, blend: style === 'marker', width: baseWidth, rect,
    ink: centre, paths: polys, ap: { ops: apFromPaths(color, polys), bbox: rect }, existing: false, deleted: false,
  };
}

// Evidenziatore alla Drawboard: una barra (Highlight/QuadPoints) lungo il tratto.
export function makeHighlight(points, color, thickness) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sy = 0;
  for (const [x, y] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); sy += y; }
  if (y1 - y0 < thickness * 1.5) {
    const cy = sy / points.length;
    y0 = cy - thickness / 2; y1 = cy + thickness / 2;
  }
  const q = [x0, y1, x1, y1, x0, y0, x1, y0];
  return {
    id: newId(), subtype: 'Highlight', color, ca: 1, width: 1, rect: [x0, y0, x1, y1], quads: [q],
    existing: false, deleted: false,
  };
}

// Ramer–Douglas–Peucker su punti piatti [x0,y0,x1,y1,...]: meno punti = file e disegno più leggeri.
export function simplify(flat, eps) {
  const out = [];
  for (const i of simplifyIdx(flat, eps)) out.push(flat[i * 2], flat[i * 2 + 1]);
  return out;
}

export function simplifyIdx(flat, eps) {
  const n = flat.length / 2;
  if (n < 3) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0, idx = -1;
    const ax = flat[a * 2], ay = flat[a * 2 + 1], bx = flat[b * 2], by = flat[b * 2 + 1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * flat[i * 2] - dx * flat[i * 2 + 1] + bx * ay - by * ax) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > eps) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

const pdfDate = () => {
  const d = new Date(), p = (v) => String(v).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};
const f = (v) => +v.toFixed(3);

const fonts = new WeakMap();
async function helv(lib) {
  if (!fonts.has(lib)) fonts.set(lib, await lib.embedFont(StandardFonts.Helvetica));
  return fonts.get(lib);
}

function wrapLines(font, text, fs, maxW) {
  const lines = [];
  for (const para of text.split(/\r?\n/)) {
    let cur = '';
    for (const word of para.split(' ')) {
      const t = cur ? `${cur} ${word}` : word;
      if (cur && font.widthOfTextAtSize(safe(t), fs) > maxW) { lines.push(cur); cur = word; } else cur = t;
    }
    lines.push(cur);
  }
  return lines;
}
// Helvetica standard = WinAnsi: i caratteri fuori dal set vengono sostituiti.
const safe = (s) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

async function buildAnnot(lib, page, a) {
  const ctx = lib.context;
  const [r, g, b] = a.color.map(f);
  const gs = { Type: 'ExtGState', CA: a.ca, ca: a.ca, BM: a.blend || a.subtype === 'Highlight' ? 'Multiply' : 'Normal' };
  const res = { ExtGState: { GS: gs } };
  const base = {
    Type: 'Annot', Subtype: a.subtype, Rect: a.rect.map(f), F: 4, C: [r, g, b], CA: a.ca,
    P: page.ref, NM: PDFHexString.fromText(a.id), M: PDFString.of(pdfDate()),
  };
  let content = '/GS gs\n';

  if (a.subtype === 'Ink') {
    // Come Drawboard: InkList = linea centrale, AP = poligono pieno (larghezza/pressione inclusa).
    base.InkList = a.ink.map((s) => s.map(f));
    base.BS = { W: a.width };
    content += `${r} ${g} ${b} rg\n`;
    for (const path of a.paths) {
      for (const [op, v] of path) content += `${v.map(f).join(' ')} ${op} `.trimStart();
      content += '\n';
    }
    content += 'f\n';
  } else if (a.subtype === 'Square') {
    const [x0, y0, x1, y1] = a.rect, h = a.width / 2;
    base.BS = { W: a.width };
    content += `${r} ${g} ${b} RG ${a.width} w ${f(x0 + h)} ${f(y0 + h)} ${f(x1 - x0 - a.width)} ${f(y1 - y0 - a.width)} re S\n`;
  } else if (a.subtype === 'FreeText') {
    const font = await helv(lib);
    const fs = a.fontSize;
    const [x0, y0, x1, y1] = a.rect;
    const lines = wrapLines(font, safe(a.text), fs, x1 - x0 - 4);
    base.DA = PDFString.of(`/Helv ${fs} Tf ${r} ${g} ${b} rg`);
    base.Contents = PDFHexString.fromText(a.text);
    base.IT = 'FreeTextTypeWriter';
    base.BS = { W: 0 };
    res.Font = { Helv: font.ref };
    content += `BT /Helv ${fs} Tf ${r} ${g} ${b} rg\n`;
    lines.forEach((line, i) => {
      content += `1 0 0 1 ${f(x0 + 2)} ${f(y1 - 2 - fs * 1.15 * (i + 1) + fs * 0.2)} Tm ${font.encodeText(line)} Tj\n`;
    });
    content += 'ET\n';
  } else if (a.subtype === 'Highlight') {
    base.QuadPoints = a.quads.flat().map(f);
    content += `${r} ${g} ${b} rg\n`;
    for (const q of a.quads) content += `${f(q[0])} ${f(q[1])} m ${f(q[2])} ${f(q[3])} l ${f(q[6])} ${f(q[7])} l ${f(q[4])} ${f(q[5])} l h f\n`;
  } else {
    throw new Error(`Creazione non supportata: ${a.subtype}`);
  }

  const ap = ctx.stream(content, { Type: 'XObject', Subtype: 'Form', BBox: a.rect.map(f), Resources: res });
  base.AP = { N: ctx.register(ap) };
  return ctx.register(ctx.obj(base));
}

export async function applyChanges(lib, page, annots) {
  const ctx = lib.context;
  let list = page.node.Annots();
  for (const a of annots) {
    if (a.existing && a.deleted) {
      if (!list) continue;
      const drop = (target) => {
        const i = list.asArray().findIndex((e) => ctx.lookup(e) === target);
        if (i >= 0) list.remove(i);
      };
      const popup = a.dict.get(N('Popup'));
      drop(a.dict);
      if (popup) drop(ctx.lookup(popup));
    } else if (!a.existing && !a.deleted) {
      if (!list) {
        list = ctx.obj([]);
        page.node.set(N('Annots'), list);
      }
      list.push(await buildAnnot(lib, page, a));
    }
  }
}
