// Erzeugt ein Testbild, wandelt es um und schreibt ein 3MF (ohne Browser).
import { buildPalette, mapImage } from '../web/js/color.js';
import { buildMeshes, meshVolume } from '../web/js/mesh.js';
import { build3mf } from '../web/js/threemf.js';
import { writeFileSync } from 'node:fs';

const W = +process.argv[3] || 60, H = Math.round(W * 0.75);
const rgba = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const p = (y * W + x) * 4, hue = x / W * 6, v = 1 - y / H;
  const f = hue % 1, i = Math.floor(hue);
  const rgb = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][i % 6];
  for (let c = 0; c < 3; c++) rgba[p + c] = 255 * (y < H / 2 ? 1 - (1 - rgb[c]) * (y / (H / 2)) : rgb[c] * v * 2);
  rgba[p + 3] = 255;
}
const cfg = {
  base: { hex: '#ffffff', td: 2.5 },
  colors: [{ hex: '#1a1a1a', td: 0.6 }, { hex: '#0086d6', td: 3 }, { hex: '#ec008c', td: 2.5 }, { hex: '#f4ee2a', td: 5 }],
  layerHeight: 0.08, colorLayers: 8, baseThickness: 0.6,
};
let t = performance.now();
const pal = buildPalette(cfg);
console.log('palette', pal.n, (performance.now() - t).toFixed(0), 'ms');
t = performance.now();
const idx = mapImage(rgba, W, H, pal, { dither: 'fs', fitLightness: true, smooth: 0 });
console.log('map', (performance.now() - t).toFixed(0), 'ms');
t = performance.now();
const meshes = buildMeshes({ W, H, pixel: 0.5, idx, seq: pal.seq, k: pal.k, N: cfg.colorLayers, zBase: cfg.baseThickness, h: cfg.layerHeight });
console.log('mesh', (performance.now() - t).toFixed(0), 'ms', meshes.map((m) => m.tris));
const vols = meshes.map(meshVolume);
const expect = W * H * 0.25 * (cfg.baseThickness + cfg.colorLayers * cfg.layerHeight);
console.log('volumes', vols.map((v) => v.toFixed(1)), 'sum', vols.reduce((a, b) => a + b).toFixed(2), 'expected', expect.toFixed(2));
// Kantenprüfung: jede gerichtete Kante sollte genau einmal vorkommen, Gegenkante einmal (abgesehen von T-Kreuzungen)
for (const [mi, m] of meshes.entries()) {
  const E = new Map();
  const I = m.indices;
  for (let i = 0; i < I.length; i += 3) for (let e = 0; e < 3; e++) {
    const a = I[i + e], b = I[i + (e + 1) % 3];
    const k = a + ',' + b;
    E.set(k, (E.get(k) || 0) + 1);
  }
  let dup = 0, open = 0;
  for (const [k, c] of E) { if (c > 1) dup++; const [a, b] = k.split(','); if (!E.has(b + ',' + a)) open++; }
  console.log('material', mi, 'dup directed edges', dup, 'unmatched (T-junction) edges', open);
}
const names = ['Weiss', 'Schwarz', 'Cyan', 'Magenta', 'Gelb'];
const ext = [5, 4, 1, 2, 3];
const data = await build3mf(meshes.map((m, i) => ({ ...m, name: names[i], extruder: ext[i] })), { name: 'Selftest', center: [128, 128], layerHeight: 0.08 });
writeFileSync(process.argv[2] || 'selftest.3mf', data);
console.log('3mf bytes', data.length);
