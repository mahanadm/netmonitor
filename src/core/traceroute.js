'use strict';
const { execFile } = require('node:child_process');

const MAX_HOPS = 12;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f]*:[0-9a-f:]+\b/i;

function traceArgs(host, platform = process.platform) {
  if (platform === 'win32') return ['tracert', ['-d', '-h', String(MAX_HOPS), '-w', '1000', host]];
  return ['traceroute', ['-n', '-m', String(MAX_HOPS), '-q', '1', '-w', '1', host]];
}

// Parses tracert / traceroute output into [{hop, ip, rtt}] (ip/rtt null when the hop timed out).
function parseTraceroute(output) {
  const hops = [];
  for (const line of String(output).split(/\r?\n/)) {
    const m = /^\s*(\d{1,2})\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2];
    const ip = IP_RE.exec(rest)?.[0] ?? null;
    const rtts = [...rest.matchAll(/(<?)(\d+(?:[.,]\d+)?)\s*ms/gi)].map((x) => (x[1] ? 1 : parseFloat(x[2].replace(',', '.'))));
    hops.push({
      hop: parseInt(m[1], 10),
      ip,
      rtt: rtts.length ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 10) / 10 : null,
    });
  }
  return hops;
}

// One-line verdict: where the path stops responding.
function summarize(hops, target) {
  if (!hops.length) return 'No traceroute data';
  const responding = hops.filter((h) => h.ip);
  if (!responding.length) return 'No hops responded (likely local network or router down)';
  const last = responding[responding.length - 1];
  if (last.ip === target || hops[hops.length - 1].ip) return `Reached ${last.ip} in ${last.hop} hops`;
  return `Last responding hop: #${last.hop} (${last.ip}); nothing beyond`;
}

function runTraceroute(host, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    const [cmd, args] = traceArgs(host);
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      const hops = parseTraceroute(stdout);
      resolve({
        target: host,
        at: Date.now(),
        hops,
        summary: err && !hops.length ? `Traceroute failed: ${err.code === 'ENOENT' ? `'${cmd}' not found` : 'timed out or errored'}` : summarize(hops, host),
      });
    });
  });
}

module.exports = { runTraceroute, parseTraceroute, summarize, traceArgs };
