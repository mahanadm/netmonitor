'use strict';
const $ = (id) => document.getElementById(id);
const LABELS = { disconnect: 'Disconnect', high_latency: 'High latency', packet_loss: 'Packet loss' };
const WINDOW_MS = 5 * 60 * 1000;
const TARGET_COLORS = ['#38bdf8', '#c084fc', '#fb923c', '#f472b6', '#facc15', '#2dd4bf', '#a3e635', '#94a3b8'];
let samples = [], incidents = [], settings = {};
const expanded = new Set();

const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function renderIncidents() {
  const tbody = $('rows');
  tbody.replaceChildren();
  const now = Date.now();
  for (const i of incidents) {
    const tr = document.createElement('tr');
    const cells = [
      null,
      new Date(i.start).toLocaleString(),
      fmtDur((i.end ?? now) - i.start) + (i.end ? '' : ' (ongoing)') + (i.interrupted ? ' (app closed)' : ''),
      i.peakLatency != null ? `${Math.round(i.peakLatency)} ms` : '–',
      `${Math.round((i.worstLoss || 0) * 100)}%`,
    ];
    cells.forEach((text, idx) => {
      const td = document.createElement('td');
      if (idx === 0) {
        const tag = document.createElement('span');
        tag.className = `tag ${i.type}`;
        tag.textContent = LABELS[i.type] || i.type;
        td.append(tag);
      } else td.textContent = text;
      tr.append(td);
    });
    tr.className = 'clickable';
    tr.title = 'Click for traceroute details';
    tr.onclick = () => { expanded.has(i.id) ? expanded.delete(i.id) : expanded.add(i.id); renderIncidents(); };
    tbody.append(tr);
    if (expanded.has(i.id)) {
      const d = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      const pre = document.createElement('pre');
      const t = i.traceroute;
      pre.textContent = t
        ? `Traceroute to ${t.target} at ${new Date(t.at).toLocaleTimeString()}\n${t.summary}\n\n` + t.hops.map((h) => `${String(h.hop).padStart(2)}  ${(h.ip || '*').padEnd(16)} ${h.rtt != null ? h.rtt + ' ms' : ''}`).join('\n')
        : 'Traceroute not captured yet (it runs when an incident starts and can take a few seconds).';
      td.append(pre); d.append(td); tbody.append(d);
    }
  }
  $('empty').hidden = incidents.length > 0;
  const day = incidents.filter((i) => i.start > now - 864e5);
  $('count24').textContent = day.length;
  $('down24').textContent = fmtDur(day.filter((i) => i.type === 'disconnect').reduce((a, i) => a + (i.end ?? now) - Math.max(i.start, now - 864e5), 0));
}

function renderStatus() {
  const last = samples[samples.length - 1];
  const el = $('status');
  if (!last) return;
  const degraded = incidents.some((i) => i.end == null);
  const down = !last.online || incidents.some((i) => i.end == null && i.type === 'disconnect');
  el.className = `pill ${down ? 'down' : degraded ? 'warn' : 'ok'}`;
  el.textContent = down ? 'Offline' : degraded ? 'Degraded' : 'Online';
  $('lat').textContent = last.latency != null ? Math.round(last.latency) : '–';
  const recent = samples.filter((s) => s.t > Date.now() - WINDOW_MS).flatMap((s) => s.results);
  $('loss').textContent = recent.length ? `${(100 * recent.filter((r) => !r.ok).length / recent.length).toFixed(1)}%` : '–';
}

function drawChart() {
  const c = $('chart'), g = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const now = Date.now(), pts = samples.filter((s) => s.t > now - WINDOW_MS);
  const hosts = [...new Set(pts.flatMap((s) => s.results.map((r) => r.host)))];
  const max = Math.max(100, (settings.detector?.latencyMs || 150) * 1.3, ...pts.flatMap((s) => s.results.map((r) => r.rtt || 0)));
  const x = (t) => ((t - (now - WINDOW_MS)) / WINDOW_MS) * (w - 40) + 40;
  const y = (v) => h - 20 - (v / max) * (h - 30);
  g.font = '11px system-ui'; g.fillStyle = css.getPropertyValue('--muted'); g.strokeStyle = css.getPropertyValue('--line');
  for (let i = 0; i <= 4; i++) { const v = (max / 4) * i; g.beginPath(); g.moveTo(40, y(v)); g.lineTo(w, y(v)); g.stroke(); g.fillText(Math.round(v), 4, y(v) + 4); }
  const th = settings.detector?.latencyMs;
  if (th) { g.strokeStyle = css.getPropertyValue('--warn'); g.setLineDash([4, 4]); g.beginPath(); g.moveTo(40, y(th)); g.lineTo(w, y(th)); g.stroke(); g.setLineDash([]); }
  // red bars where fully offline
  g.fillStyle = 'rgba(239,68,68,.25)';
  pts.forEach((s, i) => { if (!s.online) { const x0 = x(s.t), x1 = i + 1 < pts.length ? x(pts[i + 1].t) : x0 + 4; g.fillRect(x0, 0, Math.max(2, x1 - x0), h - 20); } });
  // One faint line per target, then the bold median on top.
  const line = (color, width, valueOf) => {
    g.strokeStyle = color; g.lineWidth = width; g.beginPath();
    let pen = false;
    for (const s of pts) {
      const v = valueOf(s);
      if (v == null) { pen = false; continue; }
      pen ? g.lineTo(x(s.t), y(v)) : g.moveTo(x(s.t), y(v));
      pen = true;
    }
    g.stroke();
  };
  g.globalAlpha = 0.55;
  hosts.forEach((h, i) => line(TARGET_COLORS[i % TARGET_COLORS.length], 1, (s) => s.results.find((r) => r.host === h)?.rtt ?? null));
  g.globalAlpha = 1;
  line(css.getPropertyValue('--ok'), 2.5, (s) => s.latency);
  g.lineWidth = 1;
  drawLegend(hosts);
}

let legendKey = '';
function drawLegend(hosts) {
  const key = hosts.join('|');
  if (key === legendKey) return;
  legendKey = key;
  const el = $('legend');
  el.replaceChildren();
  const add = (label, color) => {
    const span = document.createElement('span');
    const sw = document.createElement('i');
    sw.style.background = color;
    span.append(sw, label);
    el.append(span);
  };
  add('Median', getComputedStyle(document.documentElement).getPropertyValue('--ok'));
  hosts.forEach((h, i) => add(h, TARGET_COLORS[i % TARGET_COLORS.length]));
}

function fillForm() {
  const f = $('form').elements, d = settings.detector || {};
  f.targets.value = (settings.targets || []).join('\n');
  f.intervalMs.value = settings.intervalMs; f.timeoutMs.value = settings.timeoutMs;
  f.latencyMs.value = d.latencyMs ?? 150; f.failRounds.value = d.failRounds ?? 3;
  f.latencyRounds.value = d.latencyRounds ?? 3; f.lossRounds.value = d.lossRounds ?? 3;
  f.notifications.checked = settings.notifications !== false;
  f.launchAtLogin.checked = !!settings.launchAtLogin;
}

$('settingsBtn').onclick = () => { fillForm(); $('settings').showModal(); };
$('cancelSettings').onclick = () => $('settings').close();
$('form').onsubmit = async () => {
  const f = $('form').elements;
  settings = await window.api.saveSettings({
    targets: f.targets.value.split('\n'), intervalMs: f.intervalMs.value, timeoutMs: f.timeoutMs.value,
    notifications: f.notifications.checked,
    launchAtLogin: f.launchAtLogin.checked,
    detector: { latencyMs: f.latencyMs.value, failRounds: f.failRounds.value, latencyRounds: f.latencyRounds.value, lossRounds: f.lossRounds.value },
  });
};
$('exportBtn').onclick = () => window.api.exportCsv();
$('clearBtn').onclick = () => window.api.clearIncidents();

(async () => {
  const st = await window.api.getState();
  ({ samples, incidents, settings } = st);
  renderIncidents(); renderStatus(); drawChart();
  window.api.onSample((s) => { samples.push(s); if (samples.length > 900) samples.shift(); renderStatus(); drawChart(); });
  window.api.onIncidents((list) => { incidents = list; renderIncidents(); renderStatus(); });
  setInterval(() => { renderIncidents(); drawChart(); }, 5000); // refresh ongoing durations and scroll the chart
})();
