// Rechenarbeit außerhalb des UI-Threads: Farbzuordnung, Kalibrierkarte, Netze.
import { buildPalette, mapImage, adjustImage, renderIndex, meanDeltaE, Matcher, srgb8ToLab } from './color.js';
import { buildMeshes } from './mesh.js';

let palKey = '';
let pal = null;
let last = null; // { idx, W, H, cfg }

function palette(cfg) {
  const key = JSON.stringify([cfg.base, cfg.colors, cfg.layerHeight, cfg.colorLayers, cfg.baseThickness, cfg.maxPer, cfg.scatter, cfg.backing, cfg.interleave]);
  if (key !== palKey) { pal = buildPalette(cfg); palKey = key; }
  return pal;
}

function stats(idx, W, H, cfg, pal) {
  const k = pal.k, N = cfg.colorLayers, h = cfg.layerHeight;
  const area = cfg.pixel * cfg.pixel;
  const layerSum = new Float64Array(k);
  // pro Farbschicht: welche Materialien kommen vor
  const present = Array.from({ length: N }, () => new Uint8Array(k + 1));
  const hist = new Uint32Array(pal.n);
  for (let i = 0; i < idx.length; i++) hist[idx[i]]++;
  let whiteFill = 0, distinct = 0;
  for (let j = 0; j < pal.n; j++) {
    if (!hist[j]) continue;
    distinct++;
    let tot = 0;
    for (let c = 0; c < k; c++) { const n = pal.counts[j * k + c]; tot += n; layerSum[c] += hist[j] * n; }
    whiteFill += hist[j] * (N - tot);
    for (let l = 0; l < N; l++) present[l][pal.seq[j * N + l]] = 1;
  }
  let changes = 0;
  const perLayer = present.map((p) => p.reduce((s, v) => s + v, 0));
  for (const m of perLayer) changes += Math.max(0, m - 1);
  const volWhite = (W * H * cfg.baseThickness + whiteFill * h) * area;
  const vols = [volWhite, ...Array.from(layerSum, (s) => s * h * area)];
  return { vols, changes, perLayer, distinct };
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'process') {
      const { W, H, cfg } = msg;
      const rgba = new Uint8ClampedArray(msg.rgba);
      adjustImage(rgba, cfg.adjust);
      const p = palette(cfg);
      const idx = mapImage(rgba, W, H, p, cfg.map);
      const sim = renderIndex(idx, p, new Uint8ClampedArray(W * H * 4));
      last = { idx, W, H, cfg, rgba: rgba.slice() };
      const st = stats(idx, W, H, cfg, p);
      st.deltaE = meanDeltaE(rgba, sim);
      self.postMessage({ type: 'processed', id: msg.id, W, H, target: rgba.buffer, sim: sim.buffer, stats: st, paletteSize: p.n }, [rgba.buffer, sim.buffer]);
    } else if (msg.type === 'calib') {
      const { cfg } = msg;
      const p = palette(cfg);
      const out = calibration(cfg, p);
      const sim = renderIndex(out.idx, p, new Uint8ClampedArray(out.W * out.H * 4));
      last = { idx: out.idx, W: out.W, H: out.H, cfg };
      const st = stats(out.idx, out.W, out.H, cfg, p);
      st.deltaE = 0;
      self.postMessage({ type: 'processed', id: msg.id, W: out.W, H: out.H, target: sim.slice().buffer, sim: sim.buffer, stats: st, paletteSize: p.n, labels: out.labels, calib: true }, [sim.buffer]);
    } else if (msg.type === 'layers') {
      // Materialkarte einer Schicht (0 = erste Farbschicht über der Basis, -1 = Basis)
      if (!last) return;
      const { idx, W, H, cfg } = last;
      const p = palette(cfg);
      const N = cfg.colorLayers;
      const mat = new Uint8Array(W * H);
      const L = msg.layer;
      if (L >= 0) for (let i = 0; i < W * H; i++) mat[i] = p.seq[idx[i] * N + L];
      self.postMessage({ type: 'layer', id: msg.id, W, H, mat: mat.buffer }, [mat.buffer]);
    } else if (msg.type === 'optimize') {
      if (!last || !last.rgba) throw new Error('Erst ein Bild laden');
      self.postMessage({ type: 'optimized', id: msg.id, ranking: optimize(last, msg.cfg, msg.candidates, msg.maxColors) });
    } else if (msg.type === 'mesh') {
      if (!last) throw new Error('Noch nichts berechnet');
      const { idx, W, H, cfg } = last;
      const p = palette(cfg);
      const meshes = buildMeshes({ W, H, pixel: cfg.pixel, idx, seq: p.seq, k: p.k, N: cfg.colorLayers, zBase: cfg.baseThickness, h: cfg.layerHeight });
      const transfer = [];
      for (const m of meshes) transfer.push(m.positions.buffer, m.indices.buffer);
      self.postMessage({ type: 'meshed', id: msg.id, meshes }, transfer);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err && err.stack || err) });
  }
};

// Kalibrierkarte: Stufen jeder Farbe einzeln, Mischungen aus Paaren und Grauwerte aus C+M+Y.
function calibration(cfg, p) {
  const k = p.k, N = cfg.colorLayers;
  const lookup = new Map();
  for (let j = 0; j < p.n; j++) lookup.set(Array.from(p.counts.subarray(j * k, j * k + k)).join(','), j);
  const rows = [];
  for (let c = 0; c < k; c++) {
    const row = [];
    for (let n = 0; n <= N; n++) { const v = new Array(k).fill(0); v[c] = n; row.push({ v, label: `${cfg.colors[c].name} ${n}` }); }
    rows.push(row);
  }
  const half = Math.floor(N / 2);
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
    const row = [];
    for (let n = 0; n <= half; n++) { const v = new Array(k).fill(0); v[a] = n; v[b] = n; row.push({ v, label: `${cfg.colors[a].name}+${cfg.colors[b].name} ${n}` }); }
    rows.push(row);
  }
  const sw = Math.max(2, Math.round(cfg.calibSwatch / cfg.pixel));
  const gap = Math.max(1, Math.round(1 / cfg.pixel));
  const cols = Math.max(...rows.map((r) => r.length));
  const W = cols * (sw + gap) + gap, H = rows.length * (sw + gap) + gap;
  const idx = new Uint16Array(W * H).fill(lookup.get(new Array(k).fill(0).join(',')) ?? 0);
  const labels = [];
  rows.forEach((row, r) => row.forEach((cell, ci) => {
    const j = lookup.get(cell.v.join(','));
    if (j === undefined) return;
    const x0 = gap + ci * (sw + gap), y0 = gap + r * (sw + gap);
    for (let y = y0; y < y0 + sw; y++) idx.fill(j, y * W + x0, y * W + x0 + sw);
    labels.push({ x: x0, y: y0, w: sw, h: sw, text: cell.label, rgb: Array.from(p.rgb.subarray(j * 3, j * 3 + 3)) });
  }));
  return { idx, W, H, labels };
}

// Beste Teilmenge der verfügbaren Farbfilamente für das aktuelle Bild suchen.
// Bewertet jede Kombination mit der mittleren Farbabweichung auf einer Stichprobe des Bildes.
function optimize(last, cfg, candidates, maxColors) {
  const { rgba, W, H } = last;
  const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 2500)));
  const sample = [];
  const t = [0, 0, 0];
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
    const p = (y * W + x) * 4;
    srgb8ToLab(rgba[p], rgba[p + 1], rgba[p + 2], t);
    sample.push(t[0], t[1], t[2]);
  }
  const n = candidates.length;
  const results = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const pick = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) pick.push(i);
    if (pick.length > maxColors) continue;
    const pc = { ...cfg, colors: pick.map((i) => candidates[i]) };
    const pal = buildPalette(pc);
    let Lmin = Infinity, Lmax = -Infinity;
    for (let j = 0; j < pal.n; j++) { Lmin = Math.min(Lmin, pal.lab[j * 3]); Lmax = Math.max(Lmax, pal.lab[j * 3]); }
    const m = new Matcher(pal);
    let err = 0;
    for (let i = 0; i < sample.length; i += 3) {
      const L = cfg.map.fitLightness ? Lmin + (sample[i] / 100) * (Lmax - Lmin) : sample[i];
      const j = m.nearest(L, sample[i + 1], sample[i + 2]);
      err += Math.hypot(sample[i] - pal.lab[j * 3], sample[i + 1] - pal.lab[j * 3 + 1], sample[i + 2] - pal.lab[j * 3 + 2]);
    }
    const dE = err / (sample.length / 3);
    // jede weitere Farbe kostet Filamentwechsel: kleine Strafe, damit gleich gute Lösungen mit weniger Farben gewinnen
    results.push({ pick, dE, score: dE + pick.length * 0.6 });
  }
  results.sort((a, b) => a.score - b.score);
  return results.slice(0, 5);
}
