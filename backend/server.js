// Lokaler HTTP-Server: liefert die Oberfläche aus und stellt die API bereit.
// Läuft in der Desktop-App (Electron) und auch eigenständig: `node backend/server.js`.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as S from './slicers.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

export function defaultOutDir() {
  return path.join(os.homedir(), 'Documents', 'ChromaStack');
}

export function createServer({ webDir, configDir }) {
  const configFile = path.join(configDir, 'config.json');
  const readConfig = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; } };
  const writeConfig = (c) => { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(configFile, JSON.stringify(c, null, 2)); };
  const outDir = () => readConfig().outDir || defaultOutDir();

  const slicerBin = (id) => {
    const s = S.detect(readConfig()).find((x) => x.id === id);
    if (!s?.found) throw new Error(`${S.SLICERS[id]?.name || id} wurde nicht gefunden.`);
    return s.bin;
  };
  const safeFile = (p) => {
    const real = path.resolve(String(p || ''));
    const base = path.resolve(outDir());
    return real.startsWith(base + path.sep) && fs.existsSync(real) ? real : null;
  };

  const json = (res, obj, code = 200) => {
    const data = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  };
  const body = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const api = {
    'GET /api/status': () => {
      const config = readConfig();
      return { slicers: S.detect(config), config: { ...config, outDir: outDir() }, platform: process.platform };
    },
    'POST /api/config': async (req) => {
      const patch = JSON.parse((await body(req)).toString() || '{}');
      const c = { ...readConfig(), ...patch };
      writeConfig(c);
      return { ok: true, config: c };
    },
    'GET /api/printers': (req, q) => ({ printers: S.printers(q.get('slicer'), slicerBin(q.get('slicer'))) }),
    'GET /api/filaments': (req, q) => ({ filaments: S.filaments(q.get('slicer'), slicerBin(q.get('slicer')), q.get('machine')) }),
    'GET /api/loaded': (req, q) => S.loadedFilaments(q.get('slicer'), slicerBin(q.get('slicer'))),
    'POST /api/project': async (req) => {
      const buf = await body(req);
      const n = buf.readUInt32LE(0);
      const meta = JSON.parse(buf.subarray(4, 4 + n).toString());
      let pos = 4 + n;
      const blobs = meta.parts.map((p) => { const b = buf.subarray(pos, pos + p.bytes); pos += p.bytes; return b; });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const job = path.join(outDir(), `${stamp}_${String(meta.fileName || 'druck').replace(/[^\p{L}\p{N}_-]+/gu, '').slice(0, 40)}`);
      fs.mkdirSync(job, { recursive: true });
      return S.buildProject(slicerBin(meta.slicer), meta, blobs, job);
    },
    'POST /api/save': async (req, q) => {
      const name = (q.get('name') || 'ChromaStack').replace(/[^\p{L}\p{N}_\- ]+/gu, '').slice(0, 60) || 'ChromaStack';
      fs.mkdirSync(outDir(), { recursive: true });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const p = path.join(outDir(), `${stamp}_${name}.3mf`);
      fs.writeFileSync(p, await body(req));
      return { file: p };
    },
    'POST /api/open': async (req) => {
      const { file, slicer } = JSON.parse((await body(req)).toString() || '{}');
      const p = safeFile(file);
      if (!p) throw new Error('Datei nicht gefunden');
      S.openInSlicer(slicerBin(slicer || readConfig().slicer || 'bambu'), p);
      return { ok: true };
    },
    'POST /api/reveal': async (req) => {
      const p = safeFile(JSON.parse((await body(req)).toString() || '{}').file);
      if (!p) throw new Error('Datei nicht gefunden');
      if (process.platform === 'darwin') spawn('open', ['-R', p], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'win32') spawn('explorer.exe', ['/select,', p], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [path.dirname(p)], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    },
  };

  // Profile im Hintergrund vorladen, damit die Druckerliste sofort da ist
  setTimeout(() => {
    for (const sl of S.detect(readConfig())) if (sl.found) { try { S.printers(sl.id, sl.bin); } catch { /* egal */ } }
  }, 50);

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    try {
      const handler = api[`${req.method} ${u.pathname}`];
      if (handler) {
        // Schutz gegen Aufrufe fremder Webseiten: nur Anfragen mit eigenem Header (erzwingt CORS-Preflight)
        if (req.headers['x-chromastack'] !== '1') return json(res, { error: 'verboten' }, 403);
        return json(res, await handler(req, u.searchParams));
      }
      if (u.pathname === '/api/download') {
        const p = safeFile(u.searchParams.get('file'));
        if (!p) return json(res, { error: 'nicht gefunden' }, 404);
        res.writeHead(200, { 'Content-Type': 'model/3mf', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}` });
        return fs.createReadStream(p).pipe(res);
      }
      if (req.method !== 'GET') return json(res, { error: 'unbekannt' }, 404);
      let rel = decodeURIComponent(u.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(webDir, '.' + rel);
      if (!file.startsWith(path.resolve(webDir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); return res.end('Nicht gefunden');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      console.error(err);
      json(res, { error: err.message || String(err) }, 500);
    }
  });
}

// Eigenständig starten
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = Number(process.env.PORT || process.env.CHROMASTACK_PORT || 8790);
  const configDir = path.join(os.homedir(), '.chromastack');
  createServer({ webDir: path.join(root, 'web'), configDir }).listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`ChromaStack läuft auf ${url}  (Beenden mit Ctrl+C)`);
    if (!process.argv.includes('--no-browser')) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
    }
  });
}
