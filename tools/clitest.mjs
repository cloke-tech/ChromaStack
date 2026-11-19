// Testet den Projektbau über die Slicer-Kommandozeile ohne Oberfläche: node tools/clitest.mjs "<Drucker>" <ausgabeordner>
import { buildPalette, mapImage } from '../web/js/color.js';
import { buildMeshes } from '../web/js/mesh.js';
import * as S from '../backend/slicers.js';
import fs from 'node:fs';

const machine = process.argv[2] || 'Bambu Lab X2D 0.4 nozzle';
const out = process.argv[3] || 'clitest-out';
const W = 60, H = 40;
const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) { const x = i % W, y = (i / W) | 0; rgba.set([x * 4, y * 6, 255 - x * 4, 255], i * 4); }
const cfg = { base: { hex: '#ffffff', td: 2.5 }, colors: [{ hex: '#000000', td: 0.6 }, { hex: '#0086d6', td: 3 }, { hex: '#ec008c', td: 2.5 }, { hex: '#f4ee2a', td: 5 }], layerHeight: 0.08, colorLayers: 6, baseThickness: 0.6 };
const pal = buildPalette(cfg);
const idx = mapImage(rgba, W, H, pal, {});
const meshes = buildMeshes({ W, H, pixel: 0.5, idx, seq: pal.seq, k: 4, N: 6, zBase: 0.6, h: 0.08 });
const stl = (m) => {
  const n = m.indices.length / 3, b = Buffer.alloc(84 + 50 * n);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let v = 0; v < 3; v++) for (let c = 0; c < 3; c++) b.writeFloatLE(m.positions[m.indices[t * 3 + v] * 3 + c] + (c < 2 ? 100 : 0), 84 + t * 50 + 12 + v * 12 + c * 4);
  return b;
};
const bin = S.detect({}).find((s) => s.found).bin;
fs.mkdirSync(out, { recursive: true });
const names = ['Weiss', 'Schwarz', 'Cyan', 'Magenta', 'Gelb'];
const hex = ['#FFFFFF', '#000000', '#0086D6', '#EC008C', '#F4EE2A'];
const info = await S.buildProject(bin, {
  slicer: 'bambu', machine, layerHeight: 0.08, firstLayer: 0.2, slice: true, singleWall: true, fileName: 'clitest',
  filaments: hex.map((h) => ({ hex: h, preset: 'Bambu PLA Basic' })), parts: names.map((n, i) => ({ name: n, filament: i + 1 })),
}, meshes.map(stl), out);
console.log(info);
