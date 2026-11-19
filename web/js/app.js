import { build3mf } from './threemf.js';
import { t, setLanguage, detectLanguage, getLanguage, LANGUAGES, locale, allTranslations } from './i18n.js';

const $ = (id) => document.getElementById(id);
// Eigener Header für alle API-Aufrufe: fremde Webseiten können die lokale API so nicht ansprechen (CORS-Preflight).
{
  const orig = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    if (String(url).startsWith('/api/')) opts = { ...opts, headers: { ...(opts.headers || {}), 'X-ChromaStack': '1' } };
    return orig(url, opts);
  };
}
const BED = [256, 256];
const DENSITY = 1.24; // PLA g/cm³

// ---------------- Zustand ----------------
const DEFAULT_FILAMENTS = [
  { key: 'W', name: 'Weiß', hex: '#FFFFFF', td: 2.5, num: 5, base: true, on: true, preset: 'Bambu PLA Basic' },
  { key: 'K', name: 'Schwarz', hex: '#000000', td: 0.6, num: 4, on: true, preset: 'Bambu PLA Basic' },
  { key: 'C', name: 'Cyan', hex: '#0086D6', td: 3.0, num: 1, on: true, preset: 'Bambu PLA Basic' },
  { key: 'M', name: 'Magenta', hex: '#EC008C', td: 2.5, num: 2, on: true, preset: 'Bambu PLA Basic' },
  { key: 'Y', name: 'Gelb', hex: '#F4EE2A', td: 5.0, num: 3, on: true, preset: 'Bambu PLA Basic' },
];
function defaultFilaments() {
  return DEFAULT_FILAMENTS.map((f) => ({ ...f, name: t(f.name) }));
}
const state = {
  source: null, // { canvas, name, kind }
  pdf: null,
  calib: false,
  filaments: null,
  server: null,
  last: null,
  meshes: null,
  meshFor: -1,
  version: 0,
  lastProject: null,
};

const store = {
  get(k, d) { try { const v = localStorage.getItem('chromastack:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('chromastack:' + k, JSON.stringify(v)); } catch { /* egal */ } },
};
state.filaments = store.get('filaments', null);

const ids = ['preset', 'width', 'height', 'fit', 'border', 'pixel', 'brightness', 'contrast', 'saturation', 'gamma', 'layerHeight',
  'colorLayers', 'firstLayer', 'baseThickness', 'singleWall', 'dither', 'smooth', 'fitLightness', 'interleave', 'scatter', 'maxPer', 'backing', 'doSlice'];
const saved = store.get('settings', {});
for (const id of ids) {
  const el = $(id);
  if (saved[id] === undefined) continue;
  const def = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'checkbox') el.checked = saved[id]; else el.value = saved[id];
  if (el.tagName === 'SELECT' && el.selectedIndex < 0) el.value = def; // Option gibt es nicht mehr
}
function saveSettings() {
  const s = {};
  for (const id of ids) { const el = $(id); s[id] = el.type === 'checkbox' ? el.checked : el.value; }
  store.set('settings', s);
  store.set('filaments', state.filaments);
}

// ---------------- Worker ----------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let reqId = 0;
function call(msg, transfer = []) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}
worker.onmessage = (e) => {
  const m = e.data;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
};

// ---------------- Hilfen ----------------
const fmt = (v, d = 1) => Number(v).toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });
function toast(text, ms = 3200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}
function busy(on, text = 'Berechne …') {
  $('busy').textContent = text;
  $('busy').classList.toggle('hidden', !on);
}
function num(id) { return parseFloat($(id).value); }

function layerSetup() {
  const h = num('layerHeight');
  const first = num('firstLayer');
  const n = Math.max(0, Math.round((num('baseThickness') - first) / h));
  const base = first + n * h;
  return { h, first, base, N: parseInt($('colorLayers').value, 10), baseLayers: 1 + n };
}

function activeColors() {
  return state.filaments.filter((f) => !f.base && f.on);
}
function baseFilament() { return state.filaments.find((f) => f.base); }

function config(W, H) {
  const L = layerSetup();
  const colors = activeColors();
  return {
    base: { hex: baseFilament().hex, td: +baseFilament().td || 2 },
    colors: colors.map((c) => ({ hex: c.hex, td: Math.max(0.05, +c.td || 1), name: c.name })),
    layerHeight: L.h,
    colorLayers: L.N,
    baseThickness: L.base,
    maxPer: parseInt($('maxPer').value, 10),
    scatter: num('scatter'),
    backing: num('backing'),
    interleave: $('interleave').checked,
    pixel: num('pixel'),
    calibSwatch: 6,
    adjust: { brightness: num('brightness'), contrast: num('contrast'), saturation: num('saturation'), gamma: num('gamma') },
    map: { dither: $('dither').value, smooth: parseInt($('smooth').value, 10), fitLightness: $('fitLightness').checked },
    W, H,
  };
}

// ---------------- Filamentliste ----------------
// Häufige Farben (Bambu PLA Basic, ungefähr) für "+ Farbe"
const LIBRARY = [
  ['Cyan', '#0086D6'], ['Magenta', '#EC008C'], ['Gelb', '#F4EE2A'], ['Schwarz', '#000000'], ['Weiß', '#FFFFFF'],
  ['Rot', '#C12E1F'], ['Orange', '#FF6A13'], ['Grün', '#00AE42'], ['Blau', '#0A2989'], ['Lila', '#5E43B7'],
  ['Pink', '#F55A74'], ['Grau', '#8E9089'], ['Braun', '#9D432C'], ['Beige', '#F7E6DE'],
];
function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function guessTd(hex) {
  const y = luminance(hex);
  return y < 0.06 ? 0.6 : y > 0.85 ? 2.5 : 3;
}
function nameForHex(hex) {
  const t = hex.toLowerCase();
  let best = 'Farbe', bd = Infinity;
  for (const [n, h] of LIBRARY) {
    const d = [1, 3, 5].reduce((s, i) => s + (parseInt(h.slice(i, i + 2), 16) - parseInt(t.slice(i, i + 2), 16)) ** 2, 0);
    if (d < bd) { bd = d; best = n; }
  }
  return t(best);
}
function nextNum() {
  const used = new Set(state.filaments.map((f) => +f.num));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function renderFilaments() {
  const el = $('filaments');
  el.innerHTML = '<div class="fil-head"><span></span><span></span><span>Name</span><span>TD mm</span><span>Nr.</span><span></span></div>';
  const presets = state.filamentPresets || [];
  state.filaments.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'fil' + (f.on || f.base ? '' : ' off');
    const presetOpts = presets.some((p) => p.label === f.preset) ? presets : [{ label: f.preset || 'Bambu PLA Basic' }, ...presets];
    row.innerHTML = `
      ${f.base ? '<span class="base-tag" title="Basis: hellstes Filament, immer aktiv">Basis</span>' : `<input type="checkbox" ${f.on ? 'checked' : ''} title="verwenden" data-k="on">`}
      <input type="color" value="${f.hex}" data-k="hex" title="Farbe">
      <input type="text" value="${f.name}" data-k="name" spellcheck="false">
      <input type="number" value="${f.td}" min="0.1" max="20" step="0.1" data-k="td" title="Transmission Distance (mm)">
      <input type="number" value="${f.num}" min="1" max="16" step="1" data-k="num" title="Filament-Nummer in Bambu Studio">
      <span class="ord">${f.base ? '' : `<button type="button" data-act="del" title="entfernen">×</button>`}</span>
      ${presets.length ? `<select data-k="preset" title="Filamentsorte (Profil in Bambu Studio)">${presetOpts.map((p) => `<option ${p.label === f.preset ? 'selected' : ''}>${p.label}</option>`).join('')}</select>` : ''}`;
    row.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      f[k] = e.target.type === 'checkbox' ? e.target.checked : (k === 'td' || k === 'num') ? parseFloat(e.target.value) : e.target.value;
      if (k === 'on') row.classList.toggle('off', !f.on);
      if (k === 'hex' || k === 'td' || k === 'on' || k === 'name') schedule();
      saveSettings();
    });
    row.addEventListener('click', (e) => {
      if (e.target.dataset?.act !== 'del') return;
      state.filaments.splice(i, 1);
      renderFilaments(); schedule(); saveSettings();
    });
    el.appendChild(row);
  });
  const bar = document.createElement('div');
  bar.className = 'filbar';
  bar.innerHTML = `<select id="addColor"><option value="">+ Farbe hinzufügen …</option>${LIBRARY.map(([n, h]) => `<option value="${h}|${n}">${n}</option>`).join('')}<option value="#888888|Eigene">Eigene Farbe</option></select>
    <button type="button" class="link" id="resetFil">Standard CMYK + Weiß</button>`;
  el.appendChild(bar);
  $('addColor').onchange = (e) => {
    if (!e.target.value) return;
    const [hex, name] = e.target.value.split('|');
    state.filaments.push({ key: 'x' + Date.now(), name: t(name), hex, td: guessTd(hex), num: nextNum(), on: true, preset: 'Bambu PLA Basic' });
    renderFilaments(); schedule(); saveSettings();
  };
  $('resetFil').onclick = () => { state.filaments = defaultFilaments(); renderFilaments(); schedule(); saveSettings(); };
}

// Filamente übernehmen, die gerade in Bambu Studio eingestellt sind (nach "AMS synchronisieren")
async function importLoaded() {
  try {
    const r = await fetch('/api/loaded?slicer=' + encodeURIComponent(state.config.slicer || ''));
    const info = await r.json();
    if (info.error) throw new Error(info.error);
    if (!info.filaments?.length) throw new Error(t('In {slicer} sind keine Filamente eingestellt.', { slicer: slicerName() }));
    const list = info.filaments.map((f) => ({ key: 'b' + f.num, name: nameForHex(f.hex), hex: f.hex.slice(0, 7).toUpperCase(), td: guessTd(f.hex), num: f.num, on: true, preset: f.preset, type: f.type }));
    // hellstes Filament wird die Basis
    let bi = 0;
    list.forEach((f, i) => { if (luminance(f.hex) > luminance(list[bi].hex)) bi = i; });
    const [base] = list.splice(bi, 1);
    base.base = true;
    if (luminance(base.hex) < 0.6) toast(t('Achtung: kein weißes/helles Filament geladen – die Basis wird {name}.', { name: base.name }), 6000);
    state.filaments = [base, ...list];
    renderFilaments(); schedule(); saveSettings();
    toast(t('{n} Filamente aus {slicer} übernommen. TD-Werte sind geschätzt.', { n: info.filaments.length, slicer: slicerName() }));
    return state.filaments;
  } catch (err) {
    toast(t('Übernehmen fehlgeschlagen: {msg}', { msg: t(err.message) }), 6000);
  }
}

// Beste Teilmenge der verfügbaren Farben für dieses Bild
async function findBest() {
  const cands = state.filaments.filter((f) => !f.base);
  if (!cands.length || !state.last || state.calib) { toast('Erst ein Bild laden.'); return; }
  const maxColors = parseInt($('maxColors').value, 10);
  busy(true, 'Suche beste Farbkombination …');
  try {
    const cfg = config(0, 0);
    const res = await call({ type: 'optimize', cfg, maxColors, candidates: cands.map((c) => ({ hex: c.hex, td: Math.max(0.05, +c.td || 1), name: c.name })) });
    const best = res.ranking[0];
    cands.forEach((c, i) => { c.on = best.pick.includes(i); });
    renderFilaments(); schedule(); saveSettings();
    const names = (r) => r.pick.map((i) => cands[i].name).join(' + ');
    toast(t('Beste Kombination: {a} (ΔE {e})', { a: names(best), e: fmt(best.dE, 1) }) + (res.ranking[1] ? t(' · danach: {a} (ΔE {e})', { a: names(res.ranking[1]), e: fmt(res.ranking[1].dE, 1) }) : ''), 8000);
  } catch (err) {
    toast(t('Fehler: {msg}', { msg: t(err.message) }), 6000);
  } finally { busy(false); }
}

// ---------------- Vorlage laden ----------------
async function loadFile(file) {
  if (!file) return;
  try {
    busy(true, 'Lade …');
    state.calib = false;
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      const pdfjs = await import('../vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      state.pdf = { doc, name: file.name };
      const sel = $('pdfPage');
      sel.innerHTML = Array.from({ length: doc.numPages }, (_, i) => `<option value="${i + 1}">${i + 1} / ${doc.numPages}</option>`).join('');
      $('pdfRow').classList.toggle('hidden', doc.numPages < 2);
      await renderPdfPage(1);
    } else {
      state.pdf = null;
      $('pdfRow').classList.add('hidden');
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      let w = img.naturalWidth || 1200, h = img.naturalHeight || 900;
      const s = Math.min(1, 3000 / Math.max(w, h));
      w = Math.round(w * s); h = Math.round(h * s);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      setSource(c, file.name, `${img.naturalWidth} × ${img.naturalHeight} px`);
    }
  } catch (err) {
    console.error(err);
    toast(t('Datei konnte nicht geladen werden: {msg}', { msg: t(err.message) }), 6000);
  } finally {
    busy(false);
  }
}

async function renderPdfPage(n) {
  const page = await state.pdf.doc.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(6, 2600 / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  const mm = (pt) => fmt(pt / 72 * 25.4, 0);
  setSource(c, `${state.pdf.name} · Seite ${n}`, `${mm(vp1.width)} × ${mm(vp1.height)} mm`);
}

function setSource(canvas, name, info) {
  state.source = { canvas, name };
  $('sourceInfo').textContent = `${name} · ${info}`;
  if ($('preset').value === 'custom') {
    // Breite behalten, Höhe aus Seitenverhältnis
    const w = Math.min(num('width'), BED[0]);
    let h = w * canvas.height / canvas.width;
    if (h > BED[1]) { h = BED[1]; $('width').value = Math.round(h * canvas.width / canvas.height); }
    $('height').value = Math.round(h);
  }
  updateEnabled();
  schedule();
}

function sourceAspect() {
  return state.source ? state.source.canvas.width / state.source.canvas.height : 4 / 3;
}

// Vorlage in Zielauflösung rendern
function renderTarget(W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  const src = state.source.canvas;
  const bpx = Math.round(num('border') / num('pixel'));
  const bw = Math.max(1, W - 2 * bpx), bh = Math.max(1, H - 2 * bpx);
  const fit = $('fit').value;
  let sx = 0, sy = 0, sw = src.width, sh = src.height, dx = bpx, dy = bpx, dw = bw, dh = bh;
  const ra = src.width / src.height, rb = bw / bh;
  if (fit === 'cover') {
    if (ra > rb) { sw = src.height * rb; sx = (src.width - sw) / 2; } else { sh = src.width / rb; sy = (src.height - sh) / 2; }
  } else if (fit === 'contain') {
    if (ra > rb) { dh = bw / ra; dy = bpx + (bh - dh) / 2; } else { dw = bh * ra; dx = bpx + (bw - dw) / 2; }
  }
  // schrittweise verkleinern = sauberes Mitteln
  let cur = src, cw = sw, ch = sh, cx = sx, cy = sy;
  while (cw > dw * 2.2 && ch > dh * 2.2) {
    const t = document.createElement('canvas');
    t.width = Math.round(cw / 2); t.height = Math.round(ch / 2);
    const tg = t.getContext('2d');
    tg.imageSmoothingQuality = 'high';
    tg.drawImage(cur, cx, cy, cw, ch, 0, 0, t.width, t.height);
    cur = t; cx = 0; cy = 0; cw = t.width; ch = t.height;
  }
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, cx, cy, cw, ch, dx, dy, dw, dh);
  return g.getImageData(0, 0, W, H);
}

// ---------------- Verarbeitung ----------------
let timer = 0;
function schedule(delay = 140) {
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

async function run() {
  updateSizeInfo();
  if (!state.source && !state.calib) return;
  if (!activeColors().length) { toast('Mindestens ein Farbfilament aktivieren.'); return; }
  const v = ++state.version;
  busy(true);
  try {
    let res;
    if (state.calib) {
      res = await call({ type: 'calib', cfg: config(0, 0) });
    } else {
      const { W, H } = pixelSize();
      const img = renderTarget(W, H);
      res = await call({ type: 'process', W, H, rgba: img.data.buffer, cfg: config(W, H) }, [img.data.buffer]);
    }
    if (v !== state.version) return;
    state.last = res;
    state.meshes = null;
    showResult(res);
    const tab = document.querySelector('.tab.on').dataset.tab;
    if (tab === 'layers') drawLayer();
    if (tab === 'three') draw3D();
  } catch (err) {
    console.error(err);
    toast(t('Fehler: {msg}', { msg: t(err.message) }), 6000);
  } finally {
    if (v === state.version) busy(false);
  }
}

function pixelSize() {
  const p = num('pixel');
  return { W: Math.max(2, Math.round(num('width') / p)), H: Math.max(2, Math.round(num('height') / p)) };
}

function showResult(res) {
  const { W, H } = res;
  for (const [id, buf] of [['cTarget', res.target], ['cSim', res.sim]]) {
    const c = $(id);
    c.width = W; c.height = H;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), W, H), 0, 0);
  }
  $('empty').classList.add('hidden');
  $('frame').classList.remove('hidden');
  layoutFrame();
  // Beschriftung der Kalibrierkarte
  const lab = $('calibLabels');
  lab.innerHTML = '';
  if (res.labels) {
    for (const l of res.labels) {
      const s = document.createElement('span');
      s.style.left = (l.x / W * 100) + '%'; s.style.top = (l.y / H * 100) + '%';
      s.style.width = (l.w / W * 100) + '%';
      const lum = 0.299 * l.rgb[0] + 0.587 * l.rgb[1] + 0.114 * l.rgb[2];
      s.style.color = lum > 140 ? '#000' : '#fff';
      s.textContent = l.text.replace(/^.* /, '');
      s.title = l.text;
      lab.appendChild(s);
    }
  }
  updateStats(res);
  updateEnabled();
  const L = layerSetup();
  $('layerSlider').max = L.N - 1;
  if (+$('layerSlider').value > L.N - 1) $('layerSlider').value = L.N - 1;
  updateLayerOut();
}

function printDims() {
  const p = num('pixel');
  if (state.last) return [state.last.W * p, state.last.H * p];
  return [num('width'), num('height')];
}

function updateStats(res) {
  const L = layerSetup();
  const [wmm, hmm] = printDims();
  const height = L.base + L.N * L.h;
  const layers = L.baseLayers + L.N;
  const st = res.stats;
  const rows = [
    ['Druckgröße', `${fmt(wmm, 1)} × ${fmt(hmm, 1)} mm`],
    ['Pixel', `${res.W} × ${res.H}`],
    ['Dicke', `${fmt(height, 2)} mm`],
    ['Schichten', t('{n} ({b} Basis + {c} Farbe)', { n: layers, b: L.baseLayers, c: L.N })],
    ['Farbtöne im Druck', t('{a} von {b}', { a: st.distinct, b: res.paletteSize })],
  ];
  if (!res.calib) rows.push(['Ø Farbabweichung', `ΔE ${fmt(st.deltaE, 1)}`]);
  rows.push(['Farbwechsel (ca.)', `${st.changes}`]);
  if (state.meshes) rows.push(['Dreiecke', state.meshes.reduce((s, m) => s + m.indices.length / 3, 0).toLocaleString(locale())]);
  if (wmm > BED[0] || hmm > BED[1]) rows.push(['⚠︎', t('größer als die Druckplatte ({w} × {h} mm)', { w: BED[0], h: BED[1] })]);
  $('stats').innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
  const fil = [baseFilament(), ...activeColors()];
  const grams = st.vols.map((v) => v / 1000 * DENSITY);
  const max = Math.max(...grams);
  $('usage').innerHTML = fil.map((f, i) => `<div class="u"><i style="background:${f.hex}"></i><span>${f.name} <span class="muted">· ${t('Nr.')} ${f.num}</span></span><span>${fmt(grams[i], 1)} g</span><span class="bar"><b style="width:${(grams[i] / max * 100).toFixed(1)}%;background:${f.hex}"></b></span></div>`).join('')
    + '<div class="muted small">Ohne Spülmengen und Prime Tower – die genauen Werte liefert das Slicen.</div>';
}

function updateSizeInfo() {
  const p = num('pixel');
  $('pixelOut').textContent = `${fmt(p, 2)} mm`;
  const { W, H } = pixelSize();
  const mp = W * H;
  const noz = parseFloat(state.printer?.nozzle || '0.4');
  let warn = '';
  if (p < noz * 0.9) warn = t(' · feiner als die Düse ({n} mm) – Details können verloren gehen', { n: fmt(noz, 1) });
  if (mp > 500000) warn += t(' · sehr viele Pixel, Slicen dauert lange');
  $('sizeInfo').textContent = state.calib ? 'Kalibrierkarte: Größe ergibt sich aus der Anzahl der Felder.' : t('{w} × {h} Pixel', { w: W, h: H }) + warn;
  for (const el of document.querySelectorAll('label > output[for]')) {
    const inp = $(el.htmlFor.value || el.getAttribute('for'));
    if (inp) el.textContent = inp.value;
  }
}

function updateEnabled() {
  const ready = !!state.last;
  $('buildBtn').disabled = !ready || !canSlice();
  $('quickBtn').disabled = !ready;
  for (const id of ['width', 'height', 'fit', 'preset', 'border']) $(id).disabled = state.calib;
}

// ---------------- Vergleichsansicht ----------------
let split = 0.5;
function layoutFrame() {
  const box = $('compare') || $('frame').parentElement;
  const fr = $('frame');
  const c = $('cTarget');
  if (!c.width) return;
  const aw = box.clientWidth - 36, ah = box.clientHeight - 36;
  const s = Math.min(aw / c.width, ah / c.height);
  fr.style.width = Math.floor(c.width * s) + 'px';
  fr.style.height = Math.floor(c.height * s) + 'px';
  for (const cv of fr.querySelectorAll('canvas')) { cv.style.width = '100%'; cv.style.height = '100%'; }
  const [wmm] = printDims();
  $('scaleInfo').textContent = t('Ansicht ≈ {p} % der echten Größe', { p: fmt((Math.floor(c.width * s) / (wmm / 25.4 * 96)) * 100, 0) });
  applySplit();
}
function applySplit() {
  const on = $('showSplit').checked;
  $('divider').classList.toggle('hidden', !on);
  $('cSim').style.clipPath = on ? `inset(0 0 0 ${split * 100}%)` : 'none';
  $('divider').style.left = `calc(${split * 100}% - 1px)`;
}
{
  const fr = $('frame');
  let drag = false;
  const move = (e) => {
    if (!drag) return;
    const r = fr.getBoundingClientRect();
    split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    applySplit();
  };
  fr.addEventListener('pointerdown', (e) => { if (!$('showSplit').checked) return; drag = true; fr.setPointerCapture(e.pointerId); move(e); });
  fr.addEventListener('pointermove', move);
  fr.addEventListener('pointerup', () => { drag = false; });
}
new ResizeObserver(() => layoutFrame()).observe($('compare'));
$('showSplit').addEventListener('change', applySplit);
$('pixelated').addEventListener('change', () => { $('frame').classList.toggle('pixelated', $('pixelated').checked); $('layerFrame').classList.toggle('pixelated', $('pixelated').checked); });

// ---------------- Schichtansicht ----------------
function updateLayerOut() {
  const L = layerSetup();
  const v = +$('layerSlider').value;
  $('layerOut').textContent = v < 0 ? t('Basis (0 – {z} mm)', { z: fmt(L.base, 2) }) : `${v + 1} / ${L.N}  ·  ${fmt(L.base + v * L.h, 2)} – ${fmt(L.base + (v + 1) * L.h, 2)} mm`;
}
async function drawLayer() {
  if (!state.last) return;
  updateLayerOut();
  const res = await call({ type: 'layers', layer: +$('layerSlider').value });
  const { W, H } = res;
  const mat = new Uint8Array(res.mat);
  const fil = [baseFilament(), ...activeColors()];
  const rgb = fil.map((f) => [parseInt(f.hex.slice(1, 3), 16), parseInt(f.hex.slice(3, 5), 16), parseInt(f.hex.slice(5, 7), 16)]);
  const img = new ImageData(W, H);
  const seen = new Set();
  for (let i = 0; i < W * H; i++) {
    const c = rgb[mat[i]];
    seen.add(mat[i]);
    img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
  }
  const cv = $('cLayer');
  cv.width = W; cv.height = H;
  cv.getContext('2d').putImageData(img, 0, 0);
  const box = $('layerFrame').parentElement;
  const s = Math.min((box.clientWidth - 36) / W, (box.clientHeight - 36) / H);
  cv.style.width = Math.floor(W * s) + 'px';
  cv.style.height = Math.floor(H * s) + 'px';
  $('layerLegend').innerHTML = [...seen].sort().map((m) => `<span><i style="background:${fil[m].hex}"></i>${fil[m].name}</span>`).join('');
}
$('layerSlider').addEventListener('input', drawLayer);

// ---------------- 3D ----------------
let preview3d = null;
async function ensureMeshes() {
  if (state.meshes && state.meshFor === state.version) return state.meshes;
  busy(true, 'Erzeuge 3D-Modell …');
  try {
    const res = await call({ type: 'mesh' });
    state.meshes = res.meshes;
    state.meshFor = state.version;
    updateStats(state.last);
    return state.meshes;
  } finally { busy(false); }
}
async function draw3D() {
  if (!state.last) return;
  const meshes = await ensureMeshes();
  if (!preview3d) {
    const { Preview3D } = await import('./preview3d.js');
    preview3d = new Preview3D($('three'));
  }
  const fil = [baseFilament(), ...activeColors()];
  preview3d.setMeshes(meshes, fil.map((f) => f.hex), printDims());
  preview3d.resize();
}
$('explode').addEventListener('change', () => preview3d?.setExplode($('explode').checked ? 1 : 0));

// ---------------- Tabs ----------------
for (const t of document.querySelectorAll('.tab')) {
  t.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.tab')) x.classList.toggle('on', x === t);
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('on', v.id === 'view-' + t.dataset.tab);
    if (t.dataset.tab === 'layers') drawLayer();
    if (t.dataset.tab === 'three') draw3D().catch((e) => toast(e.message));
    if (t.dataset.tab === 'preview') layoutFrame();
  });
}

// ---------------- Export ----------------
function partList() {
  const fil = [baseFilament(), ...activeColors()];
  return fil.map((f, i) => ({ f, i }));
}

function stlBytes(m, ox, oy) {
  const n = m.indices.length / 3;
  const buf = new ArrayBuffer(84 + 50 * n);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  const P = m.positions, I = m.indices;
  for (let t = 0; t < n; t++) {
    let o = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const q = I[t * 3 + v] * 3;
      dv.setFloat32(o, P[q] + ox, true); dv.setFloat32(o + 4, P[q + 1] + oy, true); dv.setFloat32(o + 8, P[q + 2], true);
      o += 12;
    }
  }
  return new Uint8Array(buf);
}

function fileBase() {
  if (state.calib) return t('Kalibrierkarte');
  const n = (state.source?.name || 'Bild').replace(/\.[a-z0-9]+$/i, '').replace(/[^\p{L}\p{N}_ -]+/gu, ' ').trim();
  const [w, h] = printDims();
  return `${n.slice(0, 40)} ${Math.round(w)}x${Math.round(h)}mm`;
}

// Filament-Nummern prüfen und auf 1..n verdichten (Reihenfolge bleibt)
function filamentNumbers() {
  const fil = [baseFilament(), ...activeColors()];
  const nums = fil.map((f) => Math.round(+f.num) || 1);
  if (new Set(nums).size !== nums.length) throw new Error('Jedes Filament braucht eine eigene Nummer.');
  const sorted = [...nums].sort((a, b) => a - b);
  return { fil, map: nums.map((n) => sorted.indexOf(n) + 1), nums, order: sorted.map((n) => fil[nums.indexOf(n)]) };
}

async function thumbnail(size = 512) {
  const src = $('cSim');
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff00';
  g.clearRect(0, 0, size, size);
  const s = Math.min(size / src.width, size / src.height) * 0.92;
  g.imageSmoothingEnabled = false;
  g.drawImage(src, (size - src.width * s) / 2, (size - src.height * s) / 2, src.width * s, src.height * s);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

function showProject(info, err) {
  const el = $('result');
  el.classList.remove('hidden');
  el.classList.toggle('err', !!err);
  if (err) { el.textContent = err; return; }
  state.lastProject = info;
  const lines = [];
  lines.push(`<strong>${info.sliced ? 'Projekt geslict' : 'Projekt erstellt'}</strong>`);
  if (info.printTime) lines.push(`Druckzeit: <b>${fmtTime(info.printTime)}</b>`);
  if (info.filamentChanges != null) lines.push(t('Filamentwechsel: {n}', { n: info.filamentChanges }) + (info.flushTime ? t(' · Spülen {t}', { t: fmtTime(info.flushTime) }) : ''));
  if (info.filaments?.length) {
    const { order } = filamentNumbers();
    lines.push(info.filaments.map((f) => `<span style="white-space:nowrap"><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${order[f.id - 1]?.hex || '#999'};border:1px solid #0003"></i> ${fmt(f.usedG, 1)} g</span>`).join(' &nbsp; '));
  }
  lines.push(`<span class="muted">${info.file.split('/').slice(-2).join('/')}</span>`);
  el.innerHTML = lines.map((l) => `<div>${l}</div>`).join('') + `<div class="btns">${canSlice() ? `<button class="primary" data-a="open">${t('In {slicer} öffnen', { slicer: slicerName() })}</button>` : ''}<button data-a="reveal">${state.server?.platform === 'darwin' ? 'Im Finder' : 'Im Ordner zeigen'}</button><button data-a="download">Laden</button></div>`;
}
function fmtTime(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
$('result').addEventListener('click', async (e) => {
  const a = e.target.dataset?.a;
  const f = state.lastProject?.file;
  if (!a || !f) return;
  if (a === 'download') { location.href = '/api/download?file=' + encodeURIComponent(f); return; }
  await fetch('/api/' + a, { method: 'POST', body: JSON.stringify({ file: f, slicer: state.config.slicer }) });
  if (a === 'open') toast(t('{slicer} wird geöffnet …', { slicer: slicerName() }));
});

$('buildBtn').addEventListener('click', async () => {
  const btn = $('buildBtn');
  try {
    const { fil, map } = filamentNumbers();
    btn.disabled = true;
    const meshes = await ensureMeshes();
    busy(true, t($('doSlice').checked ? '{slicer} slict …' : '{slicer} baut das Projekt …', { slicer: slicerName() }));
    btn.textContent = $('doSlice').checked ? t('Slice in {slicer} …', { slicer: slicerName() }) : t('Erstelle Projekt …');
    const L = layerSetup();
    const ox = BED[0] / 2, oy = BED[1] / 2;
    const blobs = meshes.map((m) => stlBytes(m, ox, oy));
    const presets = state.filamentPresets || [];
    const presetOf = (label) => (presets.find((p) => p.label === label) || presets.find((p) => p.label === 'Bambu PLA Basic') || presets[0])?.preset;
    // Filamentliste in Bambu-Reihenfolge (Nummer 1..n)
    const order = [];
    fil.forEach((f, i) => { order[map[i] - 1] = { hex: f.hex, name: f.name, preset: presetOf(f.preset) }; });
    const meta = {
      fileName: fileBase(), slicer: state.config.slicer, machine: state.config.machine, layerHeight: L.h, firstLayer: L.first,
      slice: $('doSlice').checked, singleWall: $('singleWall').checked,
      filaments: order,
      parts: fil.map((f, i) => ({ name: f.name, filament: map[i], bytes: blobs[i].length })).filter((_, i) => meshes[i].indices.length),
    };
    const usedBlobs = blobs.filter((_, i) => meshes[i].indices.length);
    const head = new TextEncoder().encode(JSON.stringify(meta));
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, head.length, true);
    const r = await fetch('/api/project', { method: 'POST', body: new Blob([len, head, ...usedBlobs]) });
    const info = await r.json();
    if (!r.ok || info.error) throw new Error(info.error || r.statusText);
    showProject(info);
    toast('Projekt fertig.');
  } catch (err) {
    console.error(err);
    showProject(null, t('Fehler: {msg}', { msg: t(err.message) }));
  } finally {
    busy(false);
    btn.textContent = buildLabel();
    updateEnabled();
  }
});

$('quickBtn').addEventListener('click', async () => {
  try {
    const { fil, nums } = filamentNumbers();
    const meshes = await ensureMeshes();
    busy(true, 'Schreibe 3MF …');
    const L = layerSetup();
    const parts = meshes.map((m, i) => ({ ...m, name: fil[i].name, extruder: nums[i] }));
    const data = await build3mf(parts, { name: fileBase(), center: [BED[0] / 2, BED[1] / 2], layerHeight: L.h, thumbnail: await thumbnail(512), smallThumbnail: await thumbnail(128) });
    if (state.server) {
      const r = await fetch('/api/save?name=' + encodeURIComponent(fileBase()), { method: 'POST', body: data });
      const info = await r.json();
      if (info.error) throw new Error(info.error);
      showProject(info);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([data], { type: 'model/3mf' }));
      a.download = fileBase() + '.3mf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
  } catch (err) {
    toast(t('Fehler: {msg}', { msg: t(err.message) }), 6000);
  } finally { busy(false); }
});

// ---------------- Eingaben ----------------
const drop = $('drop');
$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('file').click(); });
for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === drop) drop.classList.remove('over'); });
document.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
document.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])][0];
  if (f) loadFile(f);
});
$('pdfPage').addEventListener('change', async () => { busy(true, 'Lade Seite …'); await renderPdfPage(+$('pdfPage').value); busy(false); });
$('importLoaded').addEventListener('click', importLoaded);
$('findBest').addEventListener('click', findBest);
$('calibBtn').addEventListener('click', () => {
  state.calib = true;
  $('sourceInfo').textContent = 'Kalibrierkarte: Stufen jeder Farbe (0 … max. Schichten) und Mischungen aus je zwei Farben.';
  updateEnabled();
  schedule(0);
});

// Größe
let lastEdited = 'width';
function applyAspect(from) {
  if ($('preset').value !== 'custom' || !$('lock').classList.contains('on')) return;
  const a = sourceAspect();
  if (from === 'width') $('height').value = Math.round(num('width') / a * 10) / 10;
  else $('width').value = Math.round(num('height') * a * 10) / 10;
}
function clampSize() {
  for (const [id, max] of [['width', BED[0]], ['height', BED[1]]]) if (num(id) > max) {
    const s = max / num(id);
    $(id).value = max;
    const other = id === 'width' ? 'height' : 'width';
    if ($('lock').classList.contains('on') && $('preset').value === 'custom') $(other).value = Math.round(num(other) * s);
  }
}
$('width').addEventListener('input', () => { lastEdited = 'width'; applyAspect('width'); });
$('height').addEventListener('input', () => { lastEdited = 'height'; applyAspect('height'); });
for (const id of ['width', 'height']) $(id).addEventListener('change', () => { clampSize(); schedule(); });
$('lock').addEventListener('click', () => {
  const on = !$('lock').classList.contains('on');
  $('lock').classList.toggle('on', on);
  $('lock').setAttribute('aria-pressed', on);
  if (on) applyAspect(lastEdited);
  schedule();
});
$('preset').addEventListener('change', () => {
  const v = $('preset').value;
  if (v !== 'custom') {
    let [w, h] = v.split('x').map(Number);
    if (state.source && (sourceAspect() > 1) !== (w > h) && w !== h) [w, h] = [h, w];
    $('width').value = w; $('height').value = h;
  } else applyAspect('width');
  schedule();
});
$('rotate').addEventListener('click', () => {
  const w = $('width').value;
  $('width').value = $('height').value; $('height').value = w;
  if ($('preset').value === 'custom') $('lock').classList.remove('on');
  schedule();
});
$('resetAdjust').addEventListener('click', () => {
  $('brightness').value = 0; $('contrast').value = 0; $('saturation').value = 0; $('gamma').value = 1;
  schedule(); saveSettings();
});
for (const id of ids) {
  const el = $(id);
  if (['width', 'height', 'preset'].includes(id)) continue;
  el.addEventListener(el.type === 'range' ? 'input' : 'change', () => { updateSizeInfo(); saveSettings(); if (id !== 'doSlice' && id !== 'singleWall') schedule(); });
}
for (const id of ['width', 'height', 'preset']) $(id).addEventListener('change', saveSettings);


// ---------------- Drucker & Einrichtung ----------------
state.config = {};
state.printers = [];
function slicerName() {
  return state.server?.slicers?.find((s) => s.id === state.config.slicer)?.name || 'Slicer';
}
function canSlice() {
  return !!(state.server?.slicers?.find((s) => s.id === state.config.slicer)?.found && state.config.machine);
}
function buildLabel() {
  return state.printer ? t('Projekt für {model} erstellen', { model: state.printer.model.replace(/^Bambu Lab /, '') }) : t('Projekt erstellen');
}
async function api(pathname, opts) {
  const r = await fetch(pathname, opts);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}
async function loadPrinters(slicer) {
  if (!slicer || !state.server?.slicers?.find((s) => s.id === slicer)?.found) return [];
  if (state.printersFor === slicer) return state.printers;
  state.printers = (await api('/api/printers?slicer=' + slicer)).printers;
  state.printersFor = slicer;
  return state.printers;
}
async function applyPrinter() {
  const c = state.config;
  state.printer = state.printers.find((p) => p.name === c.machine) || null;
  if (state.printer) {
    BED[0] = state.printer.bed[0]; BED[1] = state.printer.bed[1];
    try { state.filamentPresets = (await api(`/api/filaments?slicer=${c.slicer}&machine=${encodeURIComponent(c.machine)}`)).filaments; } catch { state.filamentPresets = []; }
  } else state.filamentPresets = [];
  const pill = $('printerBtn');
  if (state.printer) {
    pill.textContent = `${state.printer.model} · ${state.printer.nozzle} mm`;
    pill.className = 'pill ' + (canSlice() ? 'ok' : 'warn');
    $('printerInfo').textContent = t('{model}, Düse {n} mm, Platte {w} × {h} mm · {slicer}', { model: state.printer.model, n: state.printer.nozzle, w: BED[0], h: BED[1], slicer: slicerName() });
  } else {
    pill.textContent = state.server ? 'Drucker einrichten' : 'Ohne Server – nur 3MF';
    pill.className = 'pill warn';
    $('printerInfo').textContent = 'Kein Drucker gewählt – nur 3MF-Export';
  }
  const warn = state.printer && !state.printer.multicolor ? 'Dieser Drucker hat laut Profil keinen Farbwechsler. Mehrfarbig geht nur mit Toolchanger, MMU oder ähnlichem.' : '';
  $('printerWarn').textContent = warn;
  $('printerWarn').classList.toggle('hidden', !warn);
  $('buildBtn').textContent = buildLabel();
  $('doSlice').disabled = !canSlice();
  $('importLoaded').disabled = !canSlice();
  $('importLoaded').textContent = canSlice() ? t('Was im Drucker ist übernehmen ({slicer})', { slicer: slicerName() }) : t('Was im Drucker ist übernehmen');
  renderFilaments();
  updateSizeInfo();
  updateEnabled();
  clampSize();
}

// Einrichtungsdialog
const draft = {};
function renderSlicers() {
  const el = $('slicerList');
  el.innerHTML = '';
  for (const s of state.server.slicers) {
    const row = document.createElement('label');
    row.className = 'choice' + (draft.slicer === s.id ? ' sel' : '');
    row.innerHTML = `<input type="radio" name="slicer" value="${s.id}" ${draft.slicer === s.id ? 'checked' : ''} ${s.found ? '' : 'disabled'}>
      <span>${s.name}<small>${s.bin || 'nicht gefunden'}</small></span>
      <span class="state ${s.found ? 'ok' : 'no'}">${s.found ? 'gefunden' : `<button type="button" class="link" data-pick="${s.id}">Pfad wählen …</button>`}</span>`;
    el.appendChild(row);
  }
  const none = document.createElement('label');
  none.className = 'choice' + (!draft.slicer ? ' sel' : '');
  none.innerHTML = `<input type="radio" name="slicer" value="" ${!draft.slicer ? 'checked' : ''}><span>Ohne Slicer<small>Nur 3MF-Datei exportieren und selbst öffnen</small></span><span></span>`;
  el.appendChild(none);
}
function renderPrinterChoice() {
  const q = $('printerSearch').value.trim().toLowerCase();
  const models = new Map();
  for (const p of state.printers) {
    if (q && !`${p.vendor} ${p.model}`.toLowerCase().includes(q)) continue;
    if (!models.has(p.model)) models.set(p.model, p);
  }
  const byVendor = new Map();
  for (const p of models.values()) { if (!byVendor.has(p.vendor)) byVendor.set(p.vendor, []); byVendor.get(p.vendor).push(p.model); }
  const cur = state.printers.find((p) => p.name === draft.machine);
  const vendorLabel = (v) => (v === 'BBL' ? 'Bambu Lab' : v);
  const vendors = [...byVendor.keys()].sort((a, b) => (a === 'BBL' ? -1 : b === 'BBL' ? 1 : a.localeCompare(b)));
  $('printerModel').innerHTML = vendors.map((v) => `<optgroup label="${vendorLabel(v)}">${byVendor.get(v).map((m) => `<option ${cur?.model === m ? 'selected' : ''}>${m}</option>`).join('')}</optgroup>`).join('')
    || '<option value="">Kein Drucker gefunden</option>';
  renderNozzles();
}
function renderNozzles() {
  const model = $('printerModel').value;
  const list = state.printers.filter((p) => p.model === model);
  const cur = state.printers.find((p) => p.name === draft.machine);
  const pick = list.find((p) => p.name === cur?.name) || list.find((p) => p.nozzle === '0.4') || list[0];
  $('printerNozzle').innerHTML = list.map((p) => `<option value="${p.name}" ${p === pick ? 'selected' : ''}>${p.nozzle} mm</option>`).join('');
  draft.machine = pick?.name || null;
  printerHint();
}
function printerHint() {
  const p = state.printers.find((x) => x.name === draft.machine);
  $('printerHint').textContent = !p ? (draft.slicer ? '' : 'Ohne Slicer gibt es keine Druckerliste – es wird eine 256 × 256 mm Platte angenommen.')
    : t(p.extruders > 1 ? 'Druckfläche {w} × {h} mm · {n} Düsen' : 'Druckfläche {w} × {h} mm · 1 Düse', { w: p.bed[0], h: p.bed[1], n: p.extruders }) + (p.multicolor ? '' : t(' · kein Farbwechsler im Profil'));
}
function renderSetupFilaments() {
  $('setupFilaments').innerHTML = state.filaments.filter((f) => f.base || f.on).map((f) => `<span><i style="background:${f.hex}"></i>${f.name}${f.base ? ` (${t('Basis')})` : ''}</span>`).join('');
}
async function openSetup() {
  if (!state.server) { toast('Ohne lokalen Server ist nur der 3MF-Export verfügbar.'); return; }
  Object.assign(draft, { slicer: state.config.slicer ?? state.server.slicers.find((s) => s.found)?.id ?? null, machine: state.config.machine, outDir: state.server.config.outDir });
  draft.lang = getLanguage();
  $('langSelect').innerHTML = LANGUAGES.map(([k, n]) => `<option value="${k}" ${k === draft.lang ? 'selected' : ''}>${n}</option>`).join('');
  renderSlicers();
  $('printerSearch').value = '';
  state.printers = await loadPrinters(draft.slicer).catch(() => []);
  renderPrinterChoice();
  renderSetupFilaments();
  $('outDir').textContent = draft.outDir;
  $('outDirBtn').classList.toggle('hidden', !window.chromastack?.pickFolder);
  $('setup').showModal();
}
$('slicerList').addEventListener('change', async (e) => {
  if (e.target.name !== 'slicer') return;
  draft.slicer = e.target.value || null;
  renderSlicers();
  state.printers = await loadPrinters(draft.slicer).catch((err) => { toast(err.message); return []; });
  renderPrinterChoice();
});
$('slicerList').addEventListener('click', async (e) => {
  const id = e.target.dataset?.pick;
  if (!id) return;
  e.preventDefault();
  let p = null;
  if (window.chromastack?.pickFile) p = await window.chromastack.pickFile(t('{slicer} auswählen', { slicer: id === 'bambu' ? 'Bambu Studio' : 'OrcaSlicer' }));
  else p = prompt(t('Pfad zum Programm (ausführbare Datei):'));
  if (!p) return;
  const paths = { ...(state.server.config.slicerPaths || {}), [id]: p };
  await api('/api/config', { method: 'POST', body: JSON.stringify({ slicerPaths: paths }) });
  state.server = await api('/api/status');
  state.printersFor = null;
  draft.slicer = state.server.slicers.find((s) => s.id === id)?.found ? id : draft.slicer;
  if (draft.slicer !== id) toast('Dort wurde kein Slicer gefunden.');
  renderSlicers();
  state.printers = await loadPrinters(draft.slicer).catch(() => []);
  renderPrinterChoice();
});
$('printerSearch').addEventListener('input', renderPrinterChoice);
$('langSelect').addEventListener('change', () => { draft.lang = $('langSelect').value; setLanguage(draft.lang); refreshTexts(); });
$('setup').addEventListener('close', () => {
  // Abbrechen: Sprache zurücksetzen
  if ($('setup').returnValue !== 'ok' && state.config.lang && getLanguage() !== state.config.lang) { setLanguage(state.config.lang); refreshTexts(); }
});
// Texte, die per JavaScript zusammengesetzt werden, nach Sprachwechsel neu aufbauen
function refreshTexts() {
  renameDefaultFilaments();
  renderFilaments();
  if (state.server?.platform && state.server.platform !== 'darwin') $('pasteHint').textContent = t('oder klicken · Einfügen mit Strg+V');
  applyPrinter();
  printerHint();
  renderSlicers();
  if (state.last) { updateStats(state.last); layoutFrame(); }
}
// Standardnamen (Weiß, Cyan …) in die neue Sprache übernehmen, eigene Namen bleiben
function renameDefaultFilaments() {
  const all = ['Cyan', 'Magenta', 'Gelb', 'Schwarz', 'Weiß', 'Rot', 'Orange', 'Grün', 'Blau', 'Lila', 'Pink', 'Grau', 'Braun', 'Beige'];
  for (const f of state.filaments) {
    const src = all.find((de) => allTranslations(de).includes(f.name));
    if (src) f.name = t(src);
  }
  saveSettings();
}
$('printerModel').addEventListener('change', () => { draft.machine = null; renderNozzles(); });
$('printerNozzle').addEventListener('change', () => { draft.machine = $('printerNozzle').value; printerHint(); });
$('setupCmyk').addEventListener('click', () => { state.filaments = defaultFilaments(); renderFilaments(); saveSettings(); schedule(); renderSetupFilaments(); });
$('setupImport').addEventListener('click', async () => {
  if (!draft.slicer) { toast('Erst einen Slicer wählen.'); return; }
  const prev = state.config.slicer;
  state.config.slicer = draft.slicer;
  await importLoaded();
  state.config.slicer = prev;
  renderSetupFilaments();
});
$('outDirBtn').addEventListener('click', async () => {
  const p = await window.chromastack?.pickFolder?.(t('Speicherort für Projekte'));
  if (p) { draft.outDir = p; $('outDir').textContent = p; }
});
$('setupOk').addEventListener('click', async (e) => {
  e.preventDefault();
  const patch = { slicer: draft.slicer, machine: draft.slicer ? draft.machine : null, outDir: draft.outDir, lang: draft.lang, setupDone: true };
  store.set('lang', draft.lang);
  try {
    state.config = (await api('/api/config', { method: 'POST', body: JSON.stringify(patch) })).config;
    state.server.config = { ...state.config, outDir: draft.outDir };
    const p = state.printers.find((x) => x.name === state.config.machine);
    if (p) {
      // Pixelgröße an die Düse anpassen
      const n = parseFloat(p.nozzle);
      if (num('pixel') < n * 0.9 || num('pixel') > n * 2) { $('pixel').value = Math.max(0.2, Math.round(n * 1.25 * 20) / 20); saveSettings(); }
    }
    $('setup').close('ok');
    await applyPrinter();
    schedule();
  } catch (err) { toast(t('Speichern fehlgeschlagen: {msg}', { msg: t(err.message) }), 6000); }
});
$('printerBtn').addEventListener('click', openSetup);
$('printerChange').addEventListener('click', openSetup);

// ---------------- Start ----------------
async function init() {
  setLanguage(store.get('lang', null) || detectLanguage());
  try {
    state.server = await api('/api/status');
    state.config = { ...state.server.config };
    if (state.config.lang && state.config.lang !== getLanguage()) setLanguage(state.config.lang);
  } catch { state.server = null; }
  store.set('lang', getLanguage());
  if (!state.filaments) state.filaments = defaultFilaments();
  if (state.server?.platform && state.server.platform !== 'darwin') $('pasteHint').textContent = t('oder klicken · Einfügen mit Strg+V');
  if (state.server) {
    await loadPrinters(state.config.slicer).catch(() => []);
    await applyPrinter();
    if (!state.config.setupDone) openSetup();
  } else {
    await applyPrinter();
  }
}
init();
