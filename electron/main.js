// Desktop-App: startet den lokalen Server im Hauptprozess und zeigt die Oberfläche in einem Fenster.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../backend/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let win = null;
let origin = '';

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 960, minHeight: 620,
    title: 'ChromaStack',
    backgroundColor: '#161618',
    icon: path.join(root, 'build', 'icon.png'),
    webPreferences: { preload: path.join(root, 'electron', 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.loadURL(origin + '/');
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
}

// macOS: ausgewähltes .app-Bündel in die ausführbare Datei umwandeln
function resolveExecutable(p) {
  if (process.platform === 'darwin' && p.endsWith('.app')) {
    const dir = path.join(p, 'Contents', 'MacOS');
    const plist = fs.existsSync(path.join(p, 'Contents', 'Info.plist')) ? fs.readFileSync(path.join(p, 'Contents', 'Info.plist'), 'utf8') : '';
    const m = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    if (m && fs.existsSync(path.join(dir, m[1]))) return path.join(dir, m[1]);
    const first = fs.existsSync(dir) ? fs.readdirSync(dir)[0] : null;
    if (first) return path.join(dir, first);
  }
  return p;
}

ipcMain.handle('pick-file', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, {
    title,
    defaultPath: process.platform === 'darwin' ? '/Applications' : undefined,
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Programme', extensions: ['exe'] }] : [],
  });
  return r.canceled ? null : resolveExecutable(r.filePaths[0]);
});
ipcMain.handle('pick-folder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(async () => {
  const server = createServer({ webDir: path.join(root, 'web'), configDir: app.getPath('userData') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
