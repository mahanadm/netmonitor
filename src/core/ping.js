'use strict';
const { execFile } = require('node:child_process');

// Parses "time=12.3 ms", "time<1ms", "time=12.3ms" from ping output.
function parsePing(output, platform = process.platform) {
  const m = /time\s*([=<])\s*([\d.,]+)\s*ms/i.exec(output);
  const hasReply = platform === 'win32' ? /ttl=/i.test(output) : /bytes from|ttl=/i.test(output);
  if (!hasReply) return { ok: false, rtt: null };
  if (!m) return { ok: true, rtt: null };
  const rtt = parseFloat(m[2].replace(',', '.'));
  return { ok: true, rtt: m[1] === '<' ? Math.min(rtt, 1) : rtt };
}

function pingArgs(host, timeoutMs, platform = process.platform) {
  if (platform === 'win32') return ['-n', '1', '-w', String(timeoutMs), host];
  if (platform === 'darwin') return ['-c', '1', '-W', String(timeoutMs), host]; // macOS: ms
  return ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host]; // Linux: s
}

// Uses the OS ping binary so no admin/root rights are needed on Windows or macOS.
function pingOnce(host, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    execFile('ping', pingArgs(host, timeoutMs), { timeout: timeoutMs + 2000, windowsHide: true },
      (err, stdout) => {
        const wall = Number(process.hrtime.bigint() - started) / 1e6;
        const out = String(stdout || '');
        const r = parsePing(out);
        if (err && !r.ok) return resolve({ host, ok: false, rtt: null });
        resolve({ host, ok: r.ok, rtt: r.ok ? (r.rtt ?? Math.round(wall * 10) / 10) : null });
      });
  });
}

module.exports = { pingOnce, parsePing, pingArgs };
