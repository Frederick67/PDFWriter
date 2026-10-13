// Guscio Windows: finestra nera OLED, apertura/salvataggio file nativi, un'unica istanza.
const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const DIST = path.join(__dirname, '..', 'dist');
const isPdf = (p) => typeof p === 'string' && /\.pdf$/i.test(p);
const pdfFromArgv = (argv) => argv.slice(1).find((a) => isPdf(a) && fs.existsSync(a));

// Percorsi che il renderer può leggere/scrivere: solo quelli scelti dall'utente (dialogo, Esplora file) o l'ultimo documento.
const allowed = new Set();
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
const readSession = () => { try { return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); } catch { return {}; } };
function allow(p) {
  allowed.add(path.resolve(p));
}
const guard = (p) => {
  if (!isPdf(p) || !allowed.has(path.resolve(p))) throw new Error('Percorso non autorizzato');
  return path.resolve(p);
};

const wins = new Set();
const cur = () => BrowserWindow.getFocusedWindow() || [...wins][0] || null;
let pending = pdfFromArgv(process.argv);

function createWindow(blank = false) {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 520, minHeight: 400,
    backgroundColor: '#000000', show: false, autoHideMenuBar: true, title: 'OLED PDF',
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: true, spellcheck: false,
    },
  });
  wins.add(win);
  win.loadURL(blank ? 'app://oledpdf/index.html?blank=1' : 'app://oledpdf/index.html');
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => win.webContents.send('max-state', true));
  win.on('unmaximize', () => win.webContents.send('max-state', false));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  // La chiusura non è mai bloccata: la pagina salva bozze e sessione di tutte le schede, poi la finestra si chiude
  // (comunque entro 2,5 s, anche se la pagina non risponde).
  win.on('close', (e) => {
    if (win.__closing) return;
    win.__closing = true;
    e.preventDefault();
    const timer = setTimeout(() => win.destroy(), 2500);
    win.__ack = () => { clearTimeout(timer); win.destroy(); };
    try { win.webContents.send('before-close'); } catch { win.destroy(); }
  });
  win.on('closed', () => wins.delete(win));
  return win;
}

function sendOpen(file) {
  if (!file) return;
  allow(file);
  const w = cur();
  if (w) w.webContents.send('open-path', path.resolve(file));
  else pending = file;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const w = cur(); if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
    sendOpen(pdfFromArgv(argv));
  });

  app.whenReady().then(() => {
    // Solo risorse locali: nessuna rete, nessun contenuto remoto.
    const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
      + "worker-src 'self' blob:; connect-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'";
    protocol.handle('app', async (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.normalize(path.join(DIST, rel));
      if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
      const res = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      return new Response(res.body, { status: res.status, headers });
    });

    ipcMain.handle('dlg-open', async (e) => {
      const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      allow(r.filePaths[0]);
      return { path: path.resolve(r.filePaths[0]), bytes: fs.readFileSync(r.filePaths[0]) };
    });
    ipcMain.handle('file-read', (_e, p) => ({ path: guard(p), bytes: fs.readFileSync(guard(p)) }));
    ipcMain.handle('file-write', (_e, p, bytes) => {
      const target = guard(p), tmp = `${target}.oledpdf.tmp`;
      fs.writeFileSync(tmp, Buffer.from(bytes));
      fs.renameSync(tmp, target); // scrittura atomica: un crash non lascia un PDF a metà
      return true;
    });
    ipcMain.handle('dlg-saveas', async (e, name, bytes) => {
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: name, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (r.canceled || !r.filePath) return null;
      allow(r.filePath);
      fs.writeFileSync(r.filePath, Buffer.from(bytes));
      return path.resolve(r.filePath);
    });
    ipcMain.handle('session-save', (_e, tabs, active) => {
      const clean = (Array.isArray(tabs) ? tabs : [])
        .filter((t) => t && isPdf(t.path) && allowed.has(path.resolve(t.path)))
        .map((t) => ({ path: path.resolve(t.path), scale: Number(t.scale) || 0, ratio: Number(t.ratio) || 0, fit: t.fit === 'page' || t.fit === 'width' ? t.fit : null }));
      try { fs.writeFileSync(sessionFile(), JSON.stringify({ tabs: clean, active: Number(active) || 0 })); } catch { /* ignore */ }
      return true;
    });
    ipcMain.handle('session-restore', () => {
      const s = readSession();
      const tabs = [];
      for (const t of Array.isArray(s.tabs) ? s.tabs : []) {
        if (!isPdf(t.path) || !fs.existsSync(t.path)) continue;
        allowed.add(path.resolve(t.path));
        tabs.push({ path: t.path, scale: t.scale, ratio: t.ratio, fit: t.fit, bytes: fs.readFileSync(t.path) });
      }
      return { tabs, active: s.active || 0 };
    });

    const wOf = (e) => BrowserWindow.fromWebContents(e.sender);
    ipcMain.handle('win-min', (e) => wOf(e)?.minimize());
    ipcMain.handle('win-max', (e) => { const w = wOf(e); if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } });
    ipcMain.handle('win-close', (e) => wOf(e)?.close());
    ipcMain.handle('close-ready', (e) => wOf(e)?.__ack?.());
    ipcMain.handle('new-window', () => { createWindow(true); return true; });
    const first = createWindow();
    first.webContents.on('did-finish-load', () => { if (pending) { sendOpen(pending); pending = null; } });
  });

  app.on('window-all-closed', () => app.quit());
}
