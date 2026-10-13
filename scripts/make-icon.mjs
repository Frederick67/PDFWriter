// Genera build/icon.png (512x512) e electron/icon.png: pagina + tratto d'inchiostro su nero OLED.
import fs from 'node:fs';
import zlib from 'node:zlib';

const S = 512, SS = 3;
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const page = [[150, 76], [316, 76], [388, 148], [388, 436], [150, 436], [150, 76]];
const fold = [[316, 76], [316, 148], [388, 148]];
const wave = Array.from({ length: 40 }, (_, i) => { const x = 190 + i * 5; return [x, 330 + 30 * Math.sin((x - 190) / 26)]; });
const near = (poly, x, y, w) => poly.some((p, i) => i && segDist(x, y, poly[i - 1][0], poly[i - 1][1], p[0], p[1]) <= w / 2);

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  for (let x = 0; x < S; x++) {
    let ink = 0, acc = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      if (near(wave, px, py, 20)) ink++;
      else if (near(page, px, py, 14) || near(fold, px, py, 14)) acc++;
    }
    const n = SS * SS, o = y * (S * 4 + 1) + 1 + x * 4;
    const gray = (acc / n) * 184, teal = ink / n;
    raw[o] = Math.round(gray + teal * 63);
    raw[o + 1] = Math.round(gray + teal * 182);
    raw[o + 2] = Math.round(gray + teal * 168);
    raw[o + 3] = 255;
  }
}

const chunk = (type, data) => {
  const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', png);
fs.writeFileSync('electron/icon.png', png);
console.log('icon ok', png.length, 'bytes');
