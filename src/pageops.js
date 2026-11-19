// Operazioni sulle pagine (come il "Document Builder" di Drawboard) su un documento pdf-lib.
import { PDFDocument, ParseSpeeds, PDFName, PDFHexString, PDFString, degrees, rgb } from 'pdf-lib';

const MM = 72 / 25.4;

// Pagina vuota, anche con carta a righe, a quadretti o a punti disegnata nel contenuto (resta stampabile).
export function insertBlank(lib, at, template = '') {
  const ref = lib.getPage(Math.min(Math.max(at - 1, 0), lib.getPageCount() - 1));
  const { width, height } = ref.getSize();
  const page = lib.insertPage(at, [width, height]);
  const color = rgb(0.72, 0.78, 0.82), thickness = 0.4;
  if (template === 'lined') {
    const step = 8 * MM;
    for (let y = height - 25 * MM; y > 12 * MM; y -= step) page.drawLine({ start: { x: 12 * MM, y }, end: { x: width - 12 * MM, y }, color, thickness });
  } else if (template === 'grid') {
    const step = 5 * MM;
    for (let y = step; y < height; y += step) page.drawLine({ start: { x: 0, y }, end: { x: width, y }, color, thickness });
    for (let x = step; x < width; x += step) page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, color, thickness });
  } else if (template === 'dots') {
    const step = 5 * MM;
    for (let y = step; y < height; y += step) for (let x = step; x < width; x += step) page.drawCircle({ x, y, size: 0.55, color });
  }
}

export async function insertPdf(lib, at, bytes) {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
  const pages = await lib.copyPages(src, src.getPageIndices());
  pages.forEach((p, i) => lib.insertPage(at + i, p));
  return pages.length;
}

export function removePage(lib, i) {
  if (lib.getPageCount() < 2) throw new Error('Il documento deve avere almeno una pagina.');
  lib.removePage(i);
}

export function removePages(lib, list) {
  if (list.length >= lib.getPageCount()) throw new Error('Il documento deve avere almeno una pagina.');
  for (const i of [...list].sort((a, b) => b - a)) lib.removePage(i);
}

export function rotatePage(lib, i, delta = 90) {
  const p = lib.getPage(i);
  p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
}

export async function duplicatePage(lib, i) {
  const [copy] = await lib.copyPages(lib, [i]);
  lib.insertPage(i + 1, copy);
}

export function movePage(lib, from, to) {
  const page = lib.getPage(from);
  lib.removePage(from);
  lib.insertPage(to, page);
}

// Nuovo PDF con solo le pagine indicate (nell'ordine del documento).
export async function extractPages(lib, list) {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(lib, [...list].sort((a, b) => a - b));
  pages.forEach((p) => out.addPage(p));
  return out.save({ useObjectStreams: false });
}

// Riscrive l'indice (segnalibri). items: [{ title, page (indice 0-based o null), url?, items: [...] }]
export function writeOutline(lib, items) {
  const ctx = lib.context;
  const root = lib.catalog;
  if (!items.length) { root.delete(PDFName.of('Outlines')); return; }
  const outlinesRef = ctx.nextRef();
  const build = (list, parentRef) => {
    const refs = list.map(() => ctx.nextRef());
    let count = 0;
    list.forEach((it, i) => {
      const d = { Title: PDFHexString.fromText(it.title || ''), Parent: parentRef };
      if (it.page != null) {
        const page = lib.getPage(Math.min(Math.max(it.page, 0), lib.getPageCount() - 1));
        d.Dest = [page.ref, 'XYZ', null, null, null];
      } else if (it.url) d.A = { S: 'URI', URI: PDFString.of(it.url) };
      if (i > 0) d.Prev = refs[i - 1];
      if (i < list.length - 1) d.Next = refs[i + 1];
      if (it.items?.length) {
        const kids = build(it.items, refs[i]);
        Object.assign(d, { First: kids.first, Last: kids.last, Count: kids.count });
        count += kids.count;
      }
      ctx.assign(refs[i], ctx.obj(d));
      count++;
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  };
  const top = build(items, outlinesRef);
  ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
  root.set(PDFName.of('Outlines'), outlinesRef);
}
