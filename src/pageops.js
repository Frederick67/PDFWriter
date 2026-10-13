// Operazioni sulle pagine (come il "Document Builder" di Drawboard) su un documento pdf-lib.
import { PDFDocument, ParseSpeeds, degrees } from 'pdf-lib';

export function insertBlank(lib, at) {
  const ref = lib.getPage(Math.min(Math.max(at - 1, 0), lib.getPageCount() - 1));
  const { width, height } = ref.getSize();
  lib.insertPage(at, [width, height]);
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
