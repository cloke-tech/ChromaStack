// Erzeugt build/icon.png (1024 px): weiße abgerundete Fläche mit drei überlagerten Farbkreisen (C, M, Y).
import zlib from 'node:zlib';
import fs from 'node:fs';

const S = 1024, SS = 4; // Kantenglättung durch Überabtastung
const px = new Uint8Array(S * S * 4);
const circles = [
  { x: 410, y: 425, r: 190, c: [0, 166, 224] },
  { x: 614, y: 425, r: 190, c: [229, 0, 126] },
  { x: 512, y: 602, r: 190, c: [255, 222, 0] },
];
const inRoundRect = (x, y) => {
  const m = 100, R = 190, a = m + R, b = S - m - R;
  if (x < m || y < m || x > S - m || y > S - m) return false;
  const cx = Math.min(Math.max(x, a), b), cy = Math.min(Math.max(y, a), b);
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
};
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let r = 0, g = 0, bl = 0, al = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
    if (!inRoundRect(fx, fy)) continue;
    let col = [252, 251, 249];
    for (const c of circles) {
      if ((fx - c.x) ** 2 + (fy - c.y) ** 2 <= c.r * c.r) col = col.map((v, i) => (v * (0.12 * 255 + 0.88 * c.c[i])) / 255); // multiplikativ wie Druckfarbe
    }
    r += col[0]; g += col[1]; bl += col[2]; al += 255;
  }
  const n = SS * SS, i = (y * S + x) * 4;
  const a = al / n;
  px[i] = a ? (r / n) * 255 / a : 0; px[i + 1] = a ? (g / n) * 255 / a : 0; px[i + 2] = a ? (bl / n) * 255 / a : 0; px[i + 3] = a;
}
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log('build/icon.png');
