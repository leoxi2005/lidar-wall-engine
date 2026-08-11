// Electron main process.
//
// Owns the three things the renderer must not: the OSC socket, the NDI senders, and the
// only writable copy of the room's configuration.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ndi = require('./ndi/sender');
const osc = require('./osc/receiver');

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('force_high_performance_gpu');

const ROOT = path.join(__dirname, '..');
let win = null;
let config = null;
let roomName = null;
let userCfgPath = null;

function roomsDir() { return path.join(ROOT, 'rooms'); }

function pickRoom() {
  if (process.env.ROOM) return process.env.ROOM;
  try {
    const files = fs.readdirSync(roomsDir()).filter(f => f.endsWith('.json'));
    if (files.length === 1) return files[0].replace(/\.json$/, '');
    if (files.includes('default.json')) return 'default';
    if (files.length) return files[0].replace(/\.json$/, '');
  } catch (_) { /* no rooms dir */ }
  return null;
}

// Shallow per-section merge, plus per-index merge for walls. Deliberately not a deep
// generic merge: the only things written back are small named fields, and a clever merge
// would silently resurrect stale settings after the room file changes.
function applyOverlay(base, over) {
  for (const [k, v] of Object.entries(over)) {
    // `room` is the one nested section the app writes into (calibration lives on walls),
    // so it recurses; everything else is a shallow section merge.
    if (k === 'room' && v && typeof v === 'object' && base.room) {
      applyOverlay(base.room, v);
    } else if (k === 'walls' && Array.isArray(v) && Array.isArray(base.walls)) {
      v.forEach((w, i) => { if (base.walls[i] && w) Object.assign(base.walls[i], w); });
    } else if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      Object.assign(base[k], v);
    } else {
      base[k] = v;
    }
  }
}

function loadConfig() {
  roomName = pickRoom();
  if (!roomName) throw new Error('no room found in rooms/ — run: npm run new-room');
  const p = path.join(roomsDir(), `${roomName}.json`);
  config = JSON.parse(fs.readFileSync(p, 'utf8'));
  config.name = config.name ?? roomName;

  // ANYTHING THE APP WRITES GOES TO userData. In a packaged build the room file lives
  // inside app.asar — a read-only archive — so writing there fails with ENOENT and a
  // calibration done on site is lost the moment the app closes. Found the hard way.
  userCfgPath = path.join(app.getPath('userData'), `room-${roomName}.json`);
  try {
    if (fs.existsSync(userCfgPath)) {
      applyOverlay(config, JSON.parse(fs.readFileSync(userCfgPath, 'utf8')));
      console.log('[config] overlay loaded from', userCfgPath);
    } else {
      console.log('[config] calibration will be saved to', userCfgPath);
    }
  } catch (err) {
    console.error('[config] overlay unreadable, ignoring:', err.message);
  }

  if (process.env.RENDER_SCALE) {
    config.output = { ...(config.output || {}), renderScale: parseFloat(process.env.RENDER_SCALE) };
  }
  if (process.env.NDI_OFF === '1') config.ndi = { ...(config.ndi || {}), enabled: false };
  if (process.env.NDI_RGBA === '1') config.ndi = { ...(config.ndi || {}), bgra: false };
  if (process.env.NDI_PBO) {
    const n = parseInt(process.env.NDI_PBO, 10);
    if (n >= 1 && n <= 8) config.ndi = { ...(config.ndi || {}), pbo: n };
  }
  return config;
}

function createWindow() {
  const kiosk = process.env.KIOSK === '1' || !!config.output?.kiosk;
  win = new BrowserWindow({
    width: 1280, height: 760,
    backgroundColor: '#000000',
    title: `${config.name} — LiDAR Wall Engine`,
    fullscreen: kiosk, frame: !kiosk, kiosk, autoHideMenuBar: kiosk,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // NDI runs INSIDE the renderer (see preload.js): handing a full frame to the main
      // process over IPC measured 36.6 of a 46 ms frame on the reference installation.
      // NDI_IPC=1 restores the old path for an A/B on new hardware.
      contextIsolation: false, nodeIntegration: true, sandbox: false,
      backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  // On a show machine the app is on a projector with no DevTools — this is the only place
  // the [perf] line and renderer errors ever surface.
  win.webContents.on('console-message', (_e, _l, m) => console.log('[renderer]', m));
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[watchdog] renderer gone:', d.reason, '— reloading in 1s');
    setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 1000);
  });
  win.webContents.on('unresponsive', () => {
    console.error('[watchdog] renderer unresponsive — reloading');
    if (win && !win.isDestroyed()) win.reload();
  });

  const snapDir = process.env.SNAP_DIR;
  if (snapDir) {
    (process.env.SNAP_AT || '8000,12000').split(',').map(Number).forEach((t, i) => setTimeout(async () => {
      try {
        fs.writeFileSync(path.join(snapDir, `snap${i + 1}.png`), (await win.webContents.capturePage()).toPNG());
        console.log(`[snap] saved snap${i + 1}.png`);
      } catch (e) { console.error('[snap] failed:', e.message); }
    }, t));
  }
}

app.whenReady().then(() => {
  loadConfig();
  createWindow();
  const ports = [...new Set([config.osc?.port ?? 7000, ...(config.osc?.extraPorts ?? [])])];
  osc.start(ports, (msg) => { if (win && !win.isDestroyed()) win.webContents.send('osc:message', msg); });
});

ipcMain.handle('config:get', () => config);

ipcMain.handle('config:save', (_e, partial) => {
  try {
    let disk = {};
    if (fs.existsSync(userCfgPath)) {
      try { disk = JSON.parse(fs.readFileSync(userCfgPath, 'utf8')); } catch (_) { disk = {}; }
    }
    applyOverlay(disk, partial);
    fs.mkdirSync(path.dirname(userCfgPath), { recursive: true });
    fs.writeFileSync(userCfgPath, JSON.stringify(disk, null, 2));
    applyOverlay(config, partial);
    console.log('[config] saved →', userCfgPath);
    return { ok: true, path: userCfgPath };
  } catch (err) {
    console.error('[config] save failed:', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ndi:available', () => ndi.isAvailable());
ipcMain.handle('ndi:start', async (_e, cfg) => {
  try { await ndi.startSender(cfg); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle('ndi:stop', (_e, name) => { ndi.stopSender(name); return { ok: true }; });
ipcMain.handle('ndi:status', () => ndi.status());
ipcMain.on('ndi:frame', (_e, meta, data) => {
  ndi.sendFrame(meta, Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data));
});

app.on('window-all-closed', () => { ndi.stopAll(); osc.stop(); app.quit(); });
app.on('before-quit', () => { ndi.stopAll(); osc.stop(); });
