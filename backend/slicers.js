// Erkennt Slicer (Bambu Studio, OrcaSlicer), liest deren Drucker-, Prozess- und Filamentprofile
// und baut über die Kommandozeile fertige Projekte.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const PLAT = process.platform;
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
const PF = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(Boolean);

function appImages(dir, pattern) {
  try {
    return fs.readdirSync(dir).filter((f) => pattern.test(f)).map((f) => path.join(dir, f));
  } catch { return []; }
}

export const SLICERS = {
  bambu: {
    id: 'bambu',
    name: 'Bambu Studio',
    candidates: () => ({
      darwin: ['/Applications/BambuStudio.app/Contents/MacOS/BambuStudio', path.join(HOME, 'Applications/BambuStudio.app/Contents/MacOS/BambuStudio')],
      win32: PF.map((p) => path.join(p, 'Bambu Studio', 'bambu-studio.exe')),
      linux: ['/usr/bin/bambu-studio', '/usr/local/bin/bambu-studio', '/opt/bambu-studio/bin/bambu-studio',
        ...appImages(path.join(HOME, 'Applications'), /^Bambu.*\.AppImage$/i), ...appImages(path.join(HOME, 'Downloads'), /^Bambu.*\.AppImage$/i)],
    })[PLAT] || [],
    dataDir: () => ({ darwin: path.join(HOME, 'Library/Application Support/BambuStudio'), win32: path.join(APPDATA, 'BambuStudio') })[PLAT]
      || path.join(HOME, '.config/BambuStudio'),
    confName: 'BambuStudio.conf',
  },
  orca: {
    id: 'orca',
    name: 'OrcaSlicer',
    candidates: () => ({
      darwin: ['/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer', path.join(HOME, 'Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer')],
      win32: PF.map((p) => path.join(p, 'OrcaSlicer', 'orca-slicer.exe')),
      linux: ['/usr/bin/orca-slicer', '/usr/local/bin/orca-slicer',
        ...appImages(path.join(HOME, 'Applications'), /^Orca.*\.AppImage$/i), ...appImages(path.join(HOME, 'Downloads'), /^Orca.*\.AppImage$/i)],
    })[PLAT] || [],
    dataDir: () => ({ darwin: path.join(HOME, 'Library/Application Support/OrcaSlicer'), win32: path.join(APPDATA, 'OrcaSlicer') })[PLAT]
      || path.join(HOME, '.config/OrcaSlicer'),
    confName: 'OrcaSlicer.conf',
  },
};

/** Profilordner: zuerst die aktualisierten im Datenordner, dann die mitgelieferten im Programm. */
function profileRoots(slicer, bin) {
  const roots = [path.join(slicer.dataDir(), 'system')];
  if (bin) {
    if (PLAT === 'darwin') roots.push(path.resolve(path.dirname(bin), '../Resources/profiles'));
    else roots.push(path.join(path.dirname(bin), 'resources', 'profiles'), path.resolve(path.dirname(bin), '../share', slicer.id === 'bambu' ? 'BambuStudio' : 'OrcaSlicer', 'profiles'));
  }
  return roots.filter((r) => fs.existsSync(r));
}

export function detect(config = {}) {
  return Object.values(SLICERS).map((s) => {
    const override = config.slicerPaths?.[s.id];
    const bin = [override, ...s.candidates()].find((p) => p && fs.existsSync(p));
    return { id: s.id, name: s.name, bin: bin || null, found: !!bin, profiles: profileRoots(s, bin).length > 0 };
  });
}

// ---------- Profile ----------
const cache = new Map();

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Alle Profile eines Slicers, nach Art und Name indiziert (erster Fund gewinnt = Datenordner vor Programm). */
export function index(slicerId, bin) {
  const key = slicerId + '|' + bin;
  if (cache.has(key)) return cache.get(key);
  const idx = { machine: new Map(), process: new Map(), filament: new Map() };
  for (const root of profileRoots(SLICERS[slicerId], bin)) {
    let vendors = [];
    try { vendors = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* leer */ }
    for (const vendor of vendors) {
      for (const kind of ['machine', 'process', 'filament']) {
        const dir = path.join(root, vendor, kind);
        let files = [];
        try { files = walk(dir); } catch { continue; }
        for (const f of files) {
          const j = readJson(f);
          if (!j || !j.name || idx[kind].has(j.name)) continue;
          j.__vendor = vendor;
          idx[kind].set(j.name, j);
        }
      }
    }
  }
  cache.set(key, idx);
  return idx;
}
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

export function resolve(idx, kind, name, depth = 0) {
  const j = idx[kind].get(name);
  if (!j) throw new Error(`Profil nicht gefunden: ${name}`);
  const base = j.inherits && depth < 20 ? resolve(idx, kind, j.inherits, depth + 1) : {};
  return { ...base, ...j };
}
export function flat(idx, kind, name) {
  const m = resolve(idx, kind, name);
  delete m.inherits;
  delete m.__vendor;
  m.name = name;
  m.from = 'system';
  return m;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
function bedSize(m) {
  const pts = (m.printable_area || []).map((p) => String(p).trim().split('x').map(Number));
  if (!pts.length) return [220, 220];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
}

/** Alle konkreten Drucker (Modell + Düse). */
export function printers(slicerId, bin) {
  const idx = index(slicerId, bin);
  const out = [];
  for (const [name, j] of idx.machine) {
    if (j.instantiation !== 'true') continue;
    let m;
    try { m = flat(idx, 'machine', name); } catch { continue; }
    const nozzles = [].concat(m.nozzle_diameter || ['0.4']);
    const extruders = nozzles.length;
    const mmu = String(first(m.single_extruder_multi_material) ?? '0') === '1';
    const bambu = j.__vendor === 'BBL';
    out.push({
      name,
      vendor: j.__vendor,
      model: m.printer_model || name.replace(/ \d\.\d+ nozzle$/, ''),
      nozzle: String(nozzles[0]),
      bed: bedSize(m),
      height: Number(m.printable_height) || 250,
      extruders,
      // Mehrfarbig: Bambu mit AMS, Drucker mit Farbwechsler (MMU) oder mehreren Düsen
      multicolor: bambu ? true : mmu || extruders > 1,
    });
  }
  out.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model) || a.nozzle.localeCompare(b.nozzle));
  return out;
}

function compatible(p, machineName, machine) {
  const cp = p.compatible_printers;
  if (Array.isArray(cp) && cp.length) return cp.includes(machineName);
  const cond = p.compatible_printers_condition;
  if (cond) {
    // häufigste Form: printer_model=="X" and nozzle_diameter[0]==0.4
    const model = /printer_model\s*==\s*"([^"]+)"/.exec(cond);
    if (model && model[1] !== machine.printer_model) return false;
    const noz = /nozzle_diameter\[0\]\s*==\s*([\d.]+)/.exec(cond);
    if (noz && Number(noz[1]) !== Number(first(machine.nozzle_diameter))) return false;
    return !!(model || noz);
  }
  return false;
}

/** Filamentprofile, die zum Drucker passen; label = Name ohne "@…". */
export function filaments(slicerId, bin, machineName) {
  const idx = index(slicerId, bin);
  const machine = flat(idx, 'machine', machineName);
  const byLabel = new Map();
  for (const [name, j] of idx.filament) {
    if (j.instantiation !== 'true') continue;
    let f;
    try { f = resolve(idx, 'filament', name); } catch { continue; }
    if (!compatible(f, machineName, machine)) continue;
    const label = name.split(' @')[0];
    if (!byLabel.has(label)) byLabel.set(label, { label, preset: name, type: first(f.filament_type) || '' });
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Prozessprofil mit der feinsten Schichthöhe (wird ohnehin überschrieben). */
export function processFor(slicerId, bin, machineName, layerHeight) {
  const idx = index(slicerId, bin);
  const machine = flat(idx, 'machine', machineName);
  let best = null, bd = Infinity;
  for (const [name, j] of idx.process) {
    if (j.instantiation !== 'true') continue;
    let p;
    try { p = resolve(idx, 'process', name); } catch { continue; }
    if (!compatible(p, machineName, machine)) continue;
    const d = Math.abs(Number(p.layer_height) - layerHeight);
    if (d < bd) { bd = d; best = name; }
  }
  if (!best && machine.default_print_profile && idx.process.has(machine.default_print_profile)) best = machine.default_print_profile;
  if (!best) throw new Error('Kein passendes Prozessprofil für ' + machineName);
  return best;
}

/** Was im Slicer gerade als Filamente eingestellt ist (bei Bambu nach "AMS synchronisieren" = was im Drucker steckt). */
export function loadedFilaments(slicerId, bin) {
  const s = SLICERS[slicerId];
  const conf = readJson(path.join(s.dataDir(), s.confName));
  if (!conf) throw new Error(`${s.name}-Einstellungen nicht gefunden.`);
  const p = conf.presets || {};
  let names = p.filaments || [];
  if (typeof names === 'string') names = names.split(/[;,]/).filter(Boolean);
  const cols = String(p.filament_colors || '').split(/[;,]/).map((c) => c.trim()).filter(Boolean);
  const idx = index(slicerId, bin);
  return {
    machine: p.machine || null,
    filaments: names.map((n, i) => {
      let type = '';
      try { type = first(resolve(idx, 'filament', n).filament_type) || ''; } catch { /* Benutzerprofil */ }
      return { preset: n.split(' @')[0], hex: cols[i] || '#888888', type, num: i + 1 };
    }),
  };
}

function fixVariants(fil, machine) {
  const variants = [];
  for (const v of machine.extruder_variant_list || []) variants.push(...String(v).split(',').map((s) => s.trim()).filter(Boolean));
  const n = (fil.filament_flow_ratio || []).length;
  if (variants.length && n === variants.length && (fil.filament_extruder_variant || []).length !== n) fil.filament_extruder_variant = variants;
  return fil;
}

const fmtNum = (v) => String(Number(v.toFixed(3)));
const safeName = (s, d = 'Teil') => (String(s).replace(/[^\p{L}\p{N}_\- ]+/gu, '').trim() || d).slice(0, 60);

/**
 * Baut ein Projekt mit der Slicer-Kommandozeile.
 * meta: { slicer, machine, layerHeight, firstLayer, slice, singleWall, fileName, filaments:[{hex,preset(label)}], parts:[{name, filament}] }
 */
export async function buildProject(bin, meta, blobs, jobDir) {
  const idx = index(meta.slicer, bin);
  const machine = flat(idx, 'machine', meta.machine);
  const proc = flat(idx, 'process', processFor(meta.slicer, bin, meta.machine, meta.layerHeight));
  proc.layer_height = fmtNum(meta.layerHeight);
  proc.initial_layer_print_height = fmtNum(meta.firstLayer);
  if (meta.singleWall) { proc.wall_loops = '1'; proc.detect_thin_wall = '1'; }
  const avail = filaments(meta.slicer, bin, meta.machine);
  const fallback = avail.find((f) => /PLA Basic/.test(f.label)) || avail.find((f) => /PLA/.test(f.label)) || avail[0];
  const w = (name, data) => { const p = path.join(jobDir, name); fs.writeFileSync(p, typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data)); return p; };
  const machinePath = w('machine.json', machine);
  const procPath = w('process.json', proc);
  const filPaths = meta.filaments.map((f, i) => {
    const preset = (avail.find((a) => a.label === f.preset) || fallback)?.preset;
    if (!preset) throw new Error('Kein Filamentprofil für diesen Drucker gefunden.');
    const fil = fixVariants(flat(idx, 'filament', preset), machine);
    fil.filament_colour = [f.hex.toUpperCase()];
    return w(`filament${i + 1}.json`, fil);
  });
  const stlPaths = meta.parts.map((p, i) => w(`${safeName(p.name)}.stl`, blobs[i]));
  const outName = safeName(meta.fileName, 'ChromaStack') + '.3mf';
  const args = ['--load-settings', `${machinePath};${procPath}`, '--load-filaments', filPaths.join(';'),
    '--load-filament-ids', meta.parts.map((p) => p.filament).join(','), '--assemble',
    '--export-3mf', outName, '--outputdir', jobDir];
  if (meta.slice) args.push('--slice', '0');
  args.push(...stlPaths);
  const t0 = Date.now();
  const code = await run(bin, args, jobDir, path.join(jobDir, 'slicer.log'));
  const result = readJson(path.join(jobDir, 'result.json')) || {};
  const outPath = path.join(jobDir, outName);
  if (!fs.existsSync(outPath)) throw new Error(result.error_string && result.error_string !== 'Success.' ? result.error_string : `Der Slicer hat kein Projekt erzeugt (Code ${code}).`);
  const info = { file: outPath, seconds: (Date.now() - t0) / 1000, sliced: !!meta.slice };
  if (meta.slice && result.return_code && result.return_code !== 0) info.warning = result.error_string;
  const pl = (result.sliced_plates || [])[0];
  if (pl) {
    info.printTime = pl.main_predication || pl.total_predication;
    info.filamentChanges = pl.filament_change_times;
    info.flushTime = pl.feature_type_times?.Flush;
    info.filaments = (pl.filaments || []).map((f) => ({ id: f.id, usedG: f.total_used_g, modelG: f.main_used_g }));
  }
  for (const p of [...stlPaths, ...filPaths, machinePath, procPath]) fs.rmSync(p, { force: true });
  return info;
}

function run(bin, args, cwd, logFile) {
  return new Promise((resolveP, reject) => {
    const log = fs.openSync(logFile, 'w');
    const child = spawn(bin, args, { cwd, stdio: ['ignore', log, log], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Der Slicer hat zu lange gebraucht.')); }, 30 * 60 * 1000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); fs.closeSync(log); resolveP(code); });
  });
}

/** Datei im Slicer öffnen. */
export function openInSlicer(bin, file) {
  if (PLAT === 'darwin') {
    const app = bin.replace(/\/Contents\/MacOS\/[^/]+$/, '');
    spawn('open', ['-a', app, file], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(bin, [file], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  }
}
