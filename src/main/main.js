'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Monitor, DEFAULT_SETTINGS } = require('../core/monitor');
const { IncidentStore } = require('../core/store');
const { incidentsToCsv } = require('../core/csv');
const { runTraceroute } = require('../core/traceroute');
const { icon } = require('./icons');

if (!app.requestSingleInstanceLock()) app.quit();

const LABELS = { disconnect: 'Internet disconnected', high_latency: 'High latency', packet_loss: 'Packet loss' };
const MAX_SAMPLES = 900; // ~30 min at 2s interval

let win, tray, monitor, store, settingsFile, quitting = false;
let settings = { ...DEFAULT_SETTINGS, notifications: true };
const samples = [];
let lastState = 'idle';
let tracing = false;

// Captures the network path at the start of an incident to show where it breaks.
async function traceFor(incident) {
  if (tracing) return;
  tracing = true;
  try {
    const traceroute = await runTraceroute(settings.targets[0]);
    store.upsert({ id: incident.id, traceroute });
    send('incidents', store.list());
  } finally { tracing = false; }
}

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* defaults */ }
}
function saveSettings() { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); }

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function sanitizeSettings(s) {
  const targets = (Array.isArray(s.targets) ? s.targets : []).map((t) => String(t).trim())
    .filter((t) => /^[A-Za-z0-9.\-:]{1,253}$/.test(t) && !t.startsWith('-')); // no option injection into ping
  const num = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);
  const d = s.detector || {};
  return {
    targets: targets.length ? targets.slice(0, 8) : DEFAULT_SETTINGS.targets,
    intervalMs: num(s.intervalMs, 500, 60000, 2000),
    timeoutMs: num(s.timeoutMs, 500, 10000, 2000),
    notifications: !!s.notifications,
    detector: {
      latencyMs: num(d.latencyMs, 10, 5000, 150),
      failRounds: num(d.failRounds, 1, 20, 3),
      latencyRounds: num(d.latencyRounds, 1, 20, 3),
      lossRounds: num(d.lossRounds, 1, 20, 3),
    },
  };
}

function setTrayState(state, tip) {
  lastState = state;
  tray.setImage(icon(state));
  tray.setToolTip(tip);
}

function notify(title, body) {
  if (settings.notifications && Notification.isSupported()) new Notification({ title, body, silent: false }).show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 980, height: 720, show: true, title: 'Net Monitor',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } }); // keep monitoring in tray
}

function showWindow() { if (!win || win.isDestroyed()) createWindow(); win.show(); win.focus(); }

function startMonitor() {
  monitor = new Monitor(settings);
  let lastSeenSave = 0;
  monitor.on('sample', (s) => {
    samples.push(s);
    if (samples.length > MAX_SAMPLES) samples.shift();
    send('sample', s);
    const open = Object.values(monitor.detector.open);
    const state = !s.online || monitor.detector.open.disconnect ? 'down' : open.length ? 'warn' : 'ok';
    setTrayState(state, `Net Monitor — ${state === 'ok' ? 'online' : state === 'down' ? 'OFFLINE' : 'degraded'}${s.latency != null ? ` (${Math.round(s.latency)} ms)` : ''}`);
    if (open.length && s.t - lastSeenSave > 15000) { // lets us close incidents sanely after a crash
      lastSeenSave = s.t;
      for (const i of open) store.upsert({ ...i, lastSeen: s.t });
    }
  });
  monitor.on('incident', ({ type, incident }) => {
    store.upsert(incident);
    send('incidents', store.list());
    if (type === 'open') { notify(LABELS[incident.type], 'Started — recording incident.'); traceFor(incident); }
    if (type === 'close') notify(`${LABELS[incident.type]} resolved`, `Lasted ${fmtDur(incident.end - incident.start)}.`);
  });
  monitor.start();
}

app.whenReady().then(() => {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  store = new IncidentStore(path.join(app.getPath('userData'), 'incidents.json'));
  loadSettings();

  tray = new Tray(icon('idle'));
  tray.setToolTip('Net Monitor');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);

  ipcMain.handle('state', () => ({ settings, samples, incidents: store.list(), open: Object.values(monitor.detector.open) }));
  ipcMain.handle('save-settings', (_e, s) => {
    settings = { ...settings, ...sanitizeSettings(s) };
    saveSettings();
    monitor.stop();
    startMonitor();
    return settings;
  });
  ipcMain.handle('clear-incidents', async () => {
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Delete all'], defaultId: 0, cancelId: 0, message: 'Delete all recorded incidents?' });
    if (r.response !== 1) return false;
    store.clear();
    send('incidents', store.list());
    return true;
  });
  ipcMain.handle('export-csv', async () => {
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `net-incidents-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, '﻿' + incidentsToCsv(store.list())); // BOM so Excel reads UTF-8
    return r.filePath;
  });

  createWindow();
  startMonitor();
});

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; if (monitor) monitor.stop(); });
app.on('window-all-closed', () => { /* stay alive in tray */ });
app.on('activate', showWindow);
