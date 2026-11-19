import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';
import {
  readAnnots, applyChanges, makeInk, makeShape, makeTextHighlight, cloneAnnot, recolor, eraseInk, flattenAnnots,
  simplify, fitCurve, chaikin,
} from '../src/annots.js';
import { writeOutline, removePages, extractPages, insertBlank } from '../src/pageops.js';
import { textQuads, findInItems } from '../src/text.js';
import { fingerprint, serializeDraft, applyDraft } from '../src/session.js';

const RED = [0.9, 0.15, 0.15];
const stroke = (n = 20, y = 100) => Array.from({ length: n }, (_, i) => [50 + i * 5, y + Math.sin(i / 3) * 4, 0.5]);

async function roundTrip(annots, setup) {
  const lib = await PDFDocument.create();
  lib.addPage([600, 800]);
  setup?.(lib);
  await applyChanges(lib, lib.getPage(0), annots);
  const again = await PDFDocument.load(await lib.save());
  return { lib: again, read: readAnnots(again, again.getPage(0)) };
}

describe('geometria', () => {
  it('simplify mantiene gli estremi e riduce i punti allineati', () => {
    const flat = [0, 0, 1, 0, 2, 0, 3, 0, 4, 5];
    expect(simplify(flat, 0.1)).toEqual([0, 0, 3, 0, 4, 5]);
  });
  it('fitCurve restituisce Bézier contigue', () => {
    const pts = Array.from({ length: 30 }, (_, i) => [i, Math.sin(i / 4) * 10]);
    const curves = fitCurve(pts, 0.5);
    expect(curves.length).toBeGreaterThan(0);
    expect(curves[0][0]).toEqual(pts[0]);
    expect(curves.at(-1)[3]).toEqual(pts.at(-1));
    for (let i = 1; i < curves.length; i++) expect(curves[i][0]).toEqual(curves[i - 1][3]);
  });
  it('chaikin conserva gli estremi', () => {
    const out = chaikin([[0, 0, 0.5], [10, 0, 0.5], [10, 10, 0.5]], 2);
    expect(out[0]).toEqual([0, 0, 0.5]);
    expect(out.at(-1)).toEqual([10, 10, 0.5]);
  });
});

describe('copia trasformata', () => {
  it('sposta un tratto: rect, linea centrale e disegno traslati', () => {
    const a = makeInk([{ pts: stroke() }], RED, 2);
    const b = cloneAnnot(a, { s: 1, tx: 10, ty: -20 });
    expect(b.existing).toBe(false);
    expect(b.id).not.toBe(a.id);
    expect(b.ink[0][0]).toBeCloseTo(a.ink[0][0] + 10);
    expect(b.ink[0][1]).toBeCloseTo(a.ink[0][1] - 20);
    expect(b.rect[0]).toBeCloseTo(a.rect[0] + 10, 0);
    expect(b.ap.bbox).toEqual(b.rect);
  });
  it('scala uniforme: spessore e corpo del testo scalati', () => {
    const t = { subtype: 'FreeText', rect: [0, 0, 100, 20], color: [0, 0, 0], ca: 1, width: 0, text: 'ciao', fontSize: 12 };
    const b = cloneAnnot(t, { s: 2, tx: 0, ty: 0 });
    expect(b.fontSize).toBe(24);
    expect(b.rect).toEqual([0, 0, 200, 40]);
    const ink = cloneAnnot(makeInk([{ pts: stroke() }], RED, 2), { s: 3, tx: 0, ty: 0 });
    expect(ink.width).toBe(6);
  });
  it('ricolora anche il disegno /AP', () => {
    const b = recolor(makeInk([{ pts: stroke() }], RED, 2), [0, 0, 1]);
    expect(b.color).toEqual([0, 0, 1]);
    expect(b.ap.ops.find(([op]) => op === 'rg')[1]).toEqual([0, 0, 1]);
  });
});

describe('gomma parziale', () => {
  it('taglia il tratto in due pezzi', () => {
    const a = makeInk([{ pts: stroke(40) }], RED, 2, { smooth: false });
    const mid = a.inkp[0][Math.floor(a.inkp[0].length / 2)];
    const pieces = eraseInk(a, mid[0], mid[1], 6);
    expect(pieces).toHaveLength(2);
    for (const p of pieces) expect(p.subtype).toBe('Ink');
  });
  it('non tocca un tratto lontano', () => {
    const a = makeInk([{ pts: stroke() }], RED, 2);
    expect(eraseInk(a, 500, 500, 5)).toBeNull();
  });
});

describe('salvataggio e rilettura', () => {
  it('forme nuove: ellisse, linea, freccia, evidenziatore sul testo, tratto', async () => {
    const annots = [
      makeShape('ellipse', [100, 100], [200, 160], RED, 2),
      makeShape('line', [100, 300], [300, 300], RED, 1),
      makeShape('arrow', [100, 400], [300, 450], RED, 1.5),
      makeTextHighlight([[100, 520, 300, 520, 100, 505, 300, 505]], [1, 0.87, 0.38]),
      makeInk([{ pts: stroke() }], RED, 2),
    ];
    const { read } = await roundTrip(annots);
    expect(read.map((a) => a.subtype)).toEqual(['Circle', 'Line', 'Line', 'Highlight', 'Ink']);
    expect(read[2].le).toEqual(['None', 'OpenArrow']);
    expect(read[1].line).toEqual([100, 300, 300, 300]);
    for (const a of [read[0], read[4]]) expect(a.ap?.ops.length).toBeGreaterThan(0);
  });
  it('una copia spostata di una forma esistente si riscrive con il suo disegno', async () => {
    const { read } = await roundTrip([makeShape('ellipse', [100, 100], [200, 160], RED, 2)]);
    const moved = cloneAnnot(read[0], { s: 1, tx: 50, ty: 50 });
    const { read: again } = await roundTrip([moved]);
    expect(again[0].subtype).toBe('Circle');
    expect(again[0].rect[0]).toBeGreaterThan(140);
  });
  it('eliminazione di un esistente su una copia ricaricata (riconosciuto dal riferimento)', async () => {
    const { lib } = await roundTrip([makeShape('rect', [10, 10], [60, 60], RED, 1), makeShape('line', [0, 0], [50, 50], RED, 1)]);
    const bytes = await lib.save();
    const a = await PDFDocument.load(bytes), b = await PDFDocument.load(bytes);
    const annots = readAnnots(a, a.getPage(0));
    annots[0].deleted = true;
    await applyChanges(b, b.getPage(0), annots); // dizionari di `a`, documento `b`
    expect(readAnnots(b, b.getPage(0)).map((x) => x.subtype)).toEqual(['Line']);
  });
  it('testo libero con caratteri fuori da WinAnsi non fa fallire il salvataggio (Helvetica)', async () => {
    const t = { id: 'x', subtype: 'FreeText', rect: [50, 50, 300, 80], color: [0, 0, 0], ca: 1, width: 0, text: 'Ciao → Ωμέγα', fontSize: 12, existing: false, deleted: false };
    const { read } = await roundTrip([t]);
    expect(read[0].text).toBe('Ciao → Ωμέγα'); // /Contents conserva il testo originale
  });
  it('testo libero con font incorporato (Inter, non sottoinsieme)', async () => {
    const fs = await import('node:fs');
    const { setTextFont } = await import('../src/annots.js');
    setTextFont(async () => ({ bytes: fs.readFileSync('node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2'), subset: false }));
    try {
      const t = { id: 'y', subtype: 'FreeText', rect: [50, 50, 300, 80], color: [0, 0, 0], ca: 1, width: 0, text: 'Perché costa 5 € – ŁĆ', fontSize: 12, existing: false, deleted: false };
      const { lib, read } = await roundTrip([t]);
      expect(read[0].text).toBe(t.text);
      const ap = lib.context.lookup(read[0].dict.lookup(PDFName.of('AP')).get(PDFName.of('N')));
      const font = ap.dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('Font')).lookup(PDFName.of('Helv'));
      expect(font.lookup(PDFName.of('Subtype')).decodeText()).toBe('Type0'); // font TrueType incorporato, non Helvetica standard
    } finally { setTextFont(null); }
  });
  it('appiattimento: le annotazioni spariscono e il disegno entra nella pagina', async () => {
    const { lib } = await roundTrip([makeInk([{ pts: stroke() }], RED, 2), makeShape('rect', [10, 10], [60, 60], RED, 1)]);
    flattenAnnots(lib);
    const again = await PDFDocument.load(await lib.save());
    expect(readAnnots(again, again.getPage(0))).toHaveLength(0);
    const xo = again.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
    expect(xo.keys().length).toBe(2);
  });
});

describe('bozze', () => {
  it('serializza aggiunte ed eliminazioni e le riapplica', async () => {
    const { read } = await roundTrip([makeShape('rect', [10, 10], [60, 60], RED, 1)]);
    read.forEach((a, i) => { a.ei = i; });
    const pages = [{ index: 0, annots: read }];
    read[0].deleted = true;
    const added = makeShape('ellipse', [0, 0], [10, 10], RED, 1);
    read.push(added);
    const draft = JSON.parse(JSON.stringify(serializeDraft(pages)));
    const fresh = [{ index: 0, annots: read.slice(0, 1).map((a) => ({ ...a, deleted: false })) }];
    applyDraft(fresh, draft);
    expect(fresh[0].annots[0].deleted).toBe(true);
    expect(fresh[0].annots[1].subtype).toBe('Circle');
  });
  it('impronta: stessi byte → stessa chiave, contenuto diverso → chiave diversa', () => {
    const a = new Uint8Array(1000).fill(7), b = a.slice();
    b[999] = 8;
    expect(fingerprint(a)).toBe(fingerprint(a.slice()));
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe('pagine e indice', () => {
  it('scrive un indice annidato e lo rilegge', async () => {
    const lib = await PDFDocument.create();
    for (let i = 0; i < 3; i++) lib.addPage([300, 300]);
    writeOutline(lib, [{ title: 'Uno', page: 0, items: [{ title: 'Uno.a', page: 1, items: [] }] }, { title: 'Due', page: 2, items: [] }]);
    const again = await PDFDocument.load(await lib.save());
    const outlines = again.catalog.lookup(PDFName.of('Outlines'));
    expect(outlines.lookup(PDFName.of('Count')).asNumber()).toBe(3);
    expect(outlines.lookup(PDFName.of('First')).lookup(PDFName.of('Title')).decodeText()).toBe('Uno');
  });
  it('elimina ed estrae più pagine', async () => {
    const lib = await PDFDocument.create();
    for (let i = 0; i < 5; i++) lib.addPage([100 + i, 100]);
    const out = await PDFDocument.load(await extractPages(lib, [3, 1]));
    expect(out.getPages().map((p) => p.getWidth())).toEqual([101, 103]);
    removePages(lib, [0, 2]);
    // pdf-lib non invalida la cache delle pagine dopo removePage: si verifica sul file salvato
    const saved = await PDFDocument.load(await lib.save());
    expect(saved.getPages().map((p) => p.getWidth())).toEqual([101, 103, 104]);
    expect(() => removePages(lib, [0, 1, 2])).toThrow();
  });
  it('pagina a quadretti con contenuto disegnato', async () => {
    const lib = await PDFDocument.create();
    lib.addPage([200, 200]);
    insertBlank(lib, 1, 'grid');
    expect(lib.getPageCount()).toBe(2);
    expect(lib.getPage(1).node.Contents()).toBeTruthy();
    expect(lib.getPage(1).node.Contents() instanceof PDFArray || lib.getPage(1).node.Contents()).toBeTruthy();
  });
});

describe('testo della pagina', () => {
  // due righe: "Hello world" a y=700 e "Second line" a y=680, corpo 10
  const items = [
    { str: 'Hello world', transform: [10, 0, 0, 10, 100, 700], width: 55, height: 10 },
    { str: 'Second line', transform: [10, 0, 0, 10, 100, 680], width: 55, height: 10 },
  ];
  it('evidenziatore agganciato alla riga sotto il tratto, tagliato ai caratteri', () => {
    const q = textQuads(items, [100, 702, 125, 706]);
    expect(q).toHaveLength(1);
    expect(q[0][0]).toBeCloseTo(100);
    expect(q[0][2]).toBeCloseTo(125); // 5 caratteri × 5
    expect(q[0][1]).toBeGreaterThan(705);
  });
  it('ricerca con posizione, contesto e maiuscole originali', () => {
    const hits = findInItems(items, 'WORLD sec');
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe('world Sec');
    expect(hits[0].quads).toHaveLength(2); // due righe
  });
});
