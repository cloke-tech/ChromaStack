// Farbmodell: gestapelte, leicht durchscheinende Filamentschichten über einer weißen Basis.
// So ergibt Cyan über Gelb Grün (subtraktiv), und dünne Schichten wirken heller.

export function srgbToLin(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linToSrgb(v) {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
}

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLin(i);

function fLab(t) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}
export function linToLab(r, g, b, out = [0, 0, 0]) {
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
  return out;
}
export function srgb8ToLab(r, g, b, out) {
  return linToLab(LIN[r], LIN[g], LIN[b], out);
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// Eine Schicht der relativen Dicke d = t / TD über dem Untergrund Rg (ein Farbkanal, linear):
// ein Teil des Lichts wird in der Schicht gestreut und kommt in Filamentfarbe F zurück (Deckkraft),
// der Rest geht zweimal durch die Schicht und wird dabei eingefärbt (subtraktive Mischung).
export const ABSORB = 3;
export function layerReflect(F, d, Rg, scatter) {
  if (d <= 0) return Rg;
  F = F < 0.02 ? 0.02 : F > 1 ? 1 : F;
  const alpha = 1 - Math.exp(-scatter * d);
  return alpha * F + (1 - alpha) * Rg * Math.pow(F, 2 * ABSORB * d);
}

// Deckkraft-Faktor: bei Dicke = TD ist eine Schicht zu ~98 % deckend.
export const DEFAULT_SCATTER = 4;

/**
 * Reihenfolge der Farbschichten einer Säule (unten -> oben), Länge N.
 * 0 = weiße Auffüllung, c+1 = Farbfilament c. Dunkle Filamente (Schwarz) liegen als Block unten,
 * die übrigen Farben werden gleichmäßig verschachtelt (C M Y C M Y …), damit sie sich mischen.
 */
export function columnSequence(cnt, dark, N, interleave = true) {
  const seq = new Uint8Array(N);
  let used = 0;
  for (const n of cnt) used += n;
  let pos = N - used;
  for (let i = 0; i < cnt.length; i++) if (dark[i]) for (let q = 0; q < cnt[i]; q++) seq[pos++] = i + 1;
  const items = [];
  for (let i = 0; i < cnt.length; i++) {
    if (dark[i]) continue;
    for (let q = 0; q < cnt[i]; q++) items.push([interleave ? (q + 0.5) / cnt[i] : i * 1000 + q, i]);
  }
  items.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [, i] of items) seq[pos++] = i + 1;
  return seq;
}

/**
 * Baut alle druckbaren Farbkombinationen.
 * cfg: { base: {hex, td}, colors: [{hex, td}] (Stapelreihenfolge unten -> oben),
 *        layerHeight, colorLayers (N), baseThickness, maxPer, scatter, backing, interleave }
 * Rückgabe: { counts (n*k), seq (n*N), lab, rgb, n, k, N }
 */
export function buildPalette(cfg) {
  const k = cfg.colors.length;
  const N = cfg.colorLayers;
  const maxPer = Math.min(cfg.maxPer ?? N, N);
  const scatter = cfg.scatter ?? DEFAULT_SCATTER;
  const h = cfg.layerHeight;
  const backing = cfg.backing ?? 0.8;
  const baseLin = hexToRgb(cfg.base.hex).map(srgbToLin);
  const cols = cfg.colors.map((c) => ({ lin: hexToRgb(c.hex).map(srgbToLin), td: c.td }));
  const dark = cols.map((c) => linToLab(c.lin[0], c.lin[1], c.lin[2])[0] < 30);
  const tdOf = [cfg.base.td, ...cols.map((c) => c.td)];
  const linOf = [baseLin, ...cols.map((c) => c.lin)];

  const combos = [];
  const cur = new Array(k).fill(0);
  (function rec(i, left) {
    if (i === k) { combos.push(cur.slice()); return; }
    for (let n = 0; n <= Math.min(left, maxPer); n++) { cur[i] = n; rec(i + 1, left - n); }
  })(0, N);

  const n = combos.length;
  const counts = new Uint8Array(n * k);
  const seqAll = new Uint8Array(n * N);
  const lab = new Float32Array(n * 3);
  const rgb = new Uint8Array(n * 3);
  const tmp = [0, 0, 0];
  for (let j = 0; j < n; j++) {
    const c = combos[j];
    for (let i = 0; i < k; i++) counts[j * k + i] = c[i];
    const seq = columnSequence(c, dark, N, cfg.interleave !== false);
    seqAll.set(seq, j * N);
    const R = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      let r = layerReflect(baseLin[ch], cfg.baseThickness / cfg.base.td, backing, scatter);
      for (let l = 0; l < N; l++) { const m = seq[l]; r = layerReflect(linOf[m][ch], h / tdOf[m], r, scatter); }
      R[ch] = r;
    }
    linToLab(R[0], R[1], R[2], tmp);
    lab.set(tmp, j * 3);
    rgb[j * 3] = Math.round(linToSrgb(R[0]));
    rgb[j * 3 + 1] = Math.round(linToSrgb(R[1]));
    rgb[j * 3 + 2] = Math.round(linToSrgb(R[2]));
  }
  return { counts, seq: seqAll, lab, rgb, n, k, N, dark };
}

// Helligkeit etwas schwächer gewichten: Farbton und Sättigung bleiben bei Farben außerhalb des Druckumfangs besser erhalten.
const L_WEIGHT = 0.75;

/** Nächste Palettenfarbe in Lab mit Cache. */
export class Matcher {
  constructor(pal) {
    this.pal = pal;
    this.cache = new Map();
  }
  nearest(L, a, b) {
    const Li = Math.round(Math.max(0, Math.min(100, L)) * 2);
    const ai = Math.round(Math.max(-128, Math.min(128, a))) + 128;
    const bi = Math.round(Math.max(-128, Math.min(128, b))) + 128;
    const key = (Li * 257 + ai) * 257 + bi;
    let r = this.cache.get(key);
    if (r !== undefined) return r;
    const lab = this.pal.lab;
    const n = this.pal.n;
    let best = 0, bd = Infinity;
    const qL = Li / 2, qa = ai - 128, qb = bi - 128;
    for (let j = 0; j < n; j++) {
      const dL = (lab[j * 3] - qL) * L_WEIGHT, da = lab[j * 3 + 1] - qa, db = lab[j * 3 + 2] - qb;
      const d = dL * dL + da * da + db * db;
      if (d < bd) { bd = d; best = j; }
    }
    this.cache.set(key, best);
    return best;
  }
}

/** Bildanpassungen auf sRGB-Bytes (in place). */
export function adjustImage(data, { brightness = 0, contrast = 0, saturation = 0, gamma = 1 }) {
  const cf = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const sat = 1 + saturation / 100;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    v = Math.pow(v, 1 / gamma);
    v = v * 255 + brightness * 1.28;
    v = cf * (v - 128) + 128;
    lut[i] = v;
  }
  for (let p = 0; p < data.length; p += 4) {
    let r = lut[data[p]], g = lut[data[p + 1]], b = lut[data[p + 2]];
    if (sat !== 1) {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      r = y + (r - y) * sat; g = y + (g - y) * sat; b = y + (b - y) * sat;
    }
    data[p] = r; data[p + 1] = g; data[p + 2] = b;
  }
}

/**
 * Ordnet jedem Pixel eine Kombination zu.
 * opts: { dither: 'none'|'fs'|'atkinson', fitLightness: bool, smooth: int }
 */
export function mapImage(rgba, W, H, pal, opts = {}) {
  const m = new Matcher(pal);
  const idx = new Uint16Array(W * H);
  const lab = new Float32Array(W * H * 3);
  const t = [0, 0, 0];
  let Lmin = Infinity, Lmax = -Infinity;
  for (let j = 0; j < pal.n; j++) { Lmin = Math.min(Lmin, pal.lab[j * 3]); Lmax = Math.max(Lmax, pal.lab[j * 3]); }
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    srgb8ToLab(rgba[p], rgba[p + 1], rgba[p + 2], t);
    if (opts.fitLightness) t[0] = Lmin + (t[0] / 100) * (Lmax - Lmin);
    lab[i * 3] = t[0]; lab[i * 3 + 1] = t[1]; lab[i * 3 + 2] = t[2];
  }
  const dither = opts.dither || 'none';
  if (dither === 'none') {
    for (let i = 0; i < W * H; i++) idx[i] = m.nearest(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
  } else {
    const P = pal.lab;
    const strength = opts.ditherStrength ?? 0.85;
    for (let y = 0; y < H; y++) {
      const rev = y & 1;
      for (let xx = 0; xx < W; xx++) {
        const x = rev ? W - 1 - xx : xx;
        const i = y * W + x;
        const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
        const j = m.nearest(L, a, b);
        idx[i] = j;
        const eL = (L - P[j * 3]) * strength, ea = (a - P[j * 3 + 1]) * strength, eb = (b - P[j * 3 + 2]) * strength;
        const dx = rev ? -1 : 1;
        const spread = (x2, y2, w) => {
          if (x2 < 0 || x2 >= W || y2 >= H) return;
          const q = (y2 * W + x2) * 3;
          lab[q] += eL * w; lab[q + 1] += ea * w; lab[q + 2] += eb * w;
        };
        if (dither === 'fs') {
          spread(x + dx, y, 7 / 16); spread(x - dx, y + 1, 3 / 16); spread(x, y + 1, 5 / 16); spread(x + dx, y + 1, 1 / 16);
        } else {
          const w = 1 / 8;
          spread(x + dx, y, w); spread(x + 2 * dx, y, w); spread(x - dx, y + 1, w); spread(x, y + 1, w); spread(x + dx, y + 1, w); spread(x, y + 2, w);
        }
      }
    }
  }
  let out = idx;
  for (let s = 0; s < (opts.smooth || 0); s++) out = modeFilter(out, W, H);
  return out;
}

// 3x3-Mehrheitsfilter: entfernt einzelne Pixelinseln (weniger Mini-Inseln für den Slicer).
function modeFilter(src, W, H) {
  const dst = new Uint16Array(src.length);
  const vals = new Uint16Array(9), cnt = new Uint8Array(9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const v = src[yy * W + xx];
      let f = -1;
      for (let q = 0; q < n; q++) if (vals[q] === v) { f = q; break; }
      if (f < 0) { vals[n] = v; cnt[n] = 1; n++; } else cnt[f]++;
    }
    const self = src[y * W + x];
    let best = self, bc = 0;
    for (let q = 0; q < n; q++) if (cnt[q] > bc || (cnt[q] === bc && vals[q] === self)) { bc = cnt[q]; best = vals[q]; }
    dst[y * W + x] = bc >= 5 ? best : self;
  }
  return dst;
}

/** Vorschaubild aus Indexkarte. */
export function renderIndex(idx, pal, out /* Uint8ClampedArray RGBA */) {
  for (let i = 0; i < idx.length; i++) {
    const j = idx[i];
    out[i * 4] = pal.rgb[j * 3]; out[i * 4 + 1] = pal.rgb[j * 3 + 1]; out[i * 4 + 2] = pal.rgb[j * 3 + 2]; out[i * 4 + 3] = 255;
  }
  return out;
}

/** Mittlere Farbabweichung (ΔE76) zwischen Ziel und Vorschau. */
export function meanDeltaE(rgbaA, rgbaB) {
  const a = [0, 0, 0], b = [0, 0, 0];
  let s = 0, n = 0;
  for (let p = 0; p < rgbaA.length; p += 16) {
    srgb8ToLab(rgbaA[p], rgbaA[p + 1], rgbaA[p + 2], a);
    srgb8ToLab(rgbaB[p], rgbaB[p + 1], rgbaB[p + 2], b);
    s += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); n++;
  }
  return n ? s / n : 0;
}
