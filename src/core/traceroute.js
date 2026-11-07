'use strict';
const { spawn } = require('node:child_process');

const MAX_HOPS = 15;
const MAX_SILENT_HOPS = 4; // stop after this many consecutive hops with no reply
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f]*:[0-9a-f:]+\b/i;

function traceArgs(host, platform = process.platform) {
  // Short per-hop waits keep a failing path fast: tracert -w is ms, BSD/mac traceroute -w is whole seconds.
  if (platform === 'win32') return ['tracert', ['-d', '-h', String(MAX_HOPS), '-w', '500', host]];
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

// The IP the target resolved to, from the header line ("... to host [1.2.3.4]" / "to host (1.2.3.4)").
function resolvedTarget(output, host) {
  const m = /\bto\s+\S+\s+[[(]([0-9a-f.:]+)[\])]/i.exec(String(output));
  return m ? m[1] : host;
}

function trailingSilent(hops) {
  let n = 0;
  for (let i = hops.length - 1; i >= 0 && hops[i].ip === null; i--) n++;
  return n;
}

// One-line verdict: where the path stops responding.
function summarize(hops, targetIp) {
  if (!hops.length) return 'No traceroute data';
  const responding = hops.filter((h) => h.ip);
  if (!responding.length) return 'No hops responded (likely local network or router down)';
  const last = responding[responding.length - 1];
  if (last.ip === targetIp) return `Reached ${last.ip} in ${last.hop} hops`;
  if (hops[hops.length - 1].ip) return `Hop limit reached at #${last.hop} (${last.ip}) without reaching the target`;
  return `Last responding hop: #${last.hop} (${last.ip}); nothing beyond`;
}

function runTraceroute(host, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const [cmd, args] = traceArgs(host);
    let out = '', error = null, stoppedEarly = false, done = false, child, timer;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const hops = parseTraceroute(out);
      resolve({
        target: host,
        at: startedAt, // kept for older stored incidents
        startedAt,
        finishedAt: Date.now(),
        hops,
        stoppedEarly,
        summary: error && !hops.length ? `Traceroute failed: ${error}` : summarize(hops, resolvedTarget(out, host)),
      });
    };

    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) { error = e.message; return finish(); }
    timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => { error = e.code === 'ENOENT' ? `'${cmd}' not found` : e.message; finish(); });
    child.on('close', finish);
    child.stdout.on('data', (d) => {
      out += d;
      if (!stoppedEarly && trailingSilent(parseTraceroute(out)) >= MAX_SILENT_HOPS) {
        stoppedEarly = true; // path is dead beyond this point; no need to wait out the remaining hops
        child.kill();
      }
    });
  });
}

module.exports = { runTraceroute, parseTraceroute, summarize, traceArgs, resolvedTarget, trailingSilent, MAX_SILENT_HOPS };
