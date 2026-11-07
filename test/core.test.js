'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parsePing, pingArgs } = require('../src/core/ping');
const { IncidentDetector } = require('../src/core/detector');
const { IncidentStore } = require('../src/core/store');
const { incidentsToCsv } = require('../src/core/csv');
const { Monitor } = require('../src/core/monitor');

const up = (rtt = 20) => ['a', 'b', 'c'].map((host) => ({ host, ok: true, rtt }));
const down = () => ['a', 'b', 'c'].map((host) => ({ host, ok: false, rtt: null }));

test('parsePing handles linux/mac/windows output', () => {
  assert.deepStrictEqual(parsePing('64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms', 'linux'), { ok: true, rtt: 12.3 });
  assert.deepStrictEqual(parsePing('Reply from 1.1.1.1: bytes=32 time=14ms TTL=57', 'win32'), { ok: true, rtt: 14 });
  assert.deepStrictEqual(parsePing('Reply from 1.1.1.1: bytes=32 time<1ms TTL=57', 'win32'), { ok: true, rtt: 1 });
  assert.strictEqual(parsePing('Reply from 192.168.1.1: Destination host unreachable.', 'win32').ok, false);
  assert.strictEqual(parsePing('Request timed out.', 'win32').ok, false);
  assert.strictEqual(parsePing('', 'darwin').ok, false);
});

test('pingArgs uses correct timeout units per platform', () => {
  assert.deepStrictEqual(pingArgs('h', 2000, 'win32'), ['-n', '1', '-w', '2000', 'h']);
  assert.deepStrictEqual(pingArgs('h', 2000, 'darwin'), ['-c', '1', '-W', '2000', 'h']);
  assert.deepStrictEqual(pingArgs('h', 2000, 'linux'), ['-c', '1', '-W', '2', 'h']);
});

test('disconnect opens after N failed rounds and closes after recovery', () => {
  const d = new IncidentDetector();
  const ev = [];
  let t = 1000;
  for (const r of [up(), down(), down(), down(), down(), up(), up()]) ev.push(...d.process(r, (t += 2000)));
  const open = ev.find((e) => e.type === 'open');
  const close = ev.find((e) => e.type === 'close');
  assert.strictEqual(open.incident.type, 'disconnect');
  assert.strictEqual(open.incident.start, 5000); // first failed round, not the third
  assert.strictEqual(close.incident.end, 15000);
});

test('short blip does not create an incident', () => {
  const d = new IncidentDetector();
  const ev = [up(), down(), down(), up(), up()].flatMap((r, i) => d.process(r, i * 2000));
  assert.strictEqual(ev.length, 0);
});

test('high latency tracks peak and closes', () => {
  const d = new IncidentDetector({ latencyRounds: 2, recoverRounds: 1 });
  const ev = [up(200), up(250), up(400), up(20)].flatMap((r, i) => d.process(r, i * 2000));
  assert.deepStrictEqual(ev.map((e) => e.type), ['open', 'update', 'close']);
  assert.strictEqual(ev[2].incident.peakLatency, 400);
});

test('majority failures count as packet loss, not disconnect', () => {
  const d = new IncidentDetector({ lossRounds: 2 });
  const lossy = [{ host: 'a', ok: true, rtt: 10 }, { host: 'b', ok: false, rtt: null }, { host: 'c', ok: false, rtt: null }];
  const ev = [lossy, lossy].flatMap((r, i) => d.process(r, i));
  assert.strictEqual(ev[0].incident.type, 'packet_loss');
});

test('flush closes open incidents', () => {
  const d = new IncidentDetector({ failRounds: 1 });
  d.process(down(), 1);
  const ev = d.flush(9);
  assert.strictEqual(ev[0].incident.end, 9);
});

test('store persists, upserts, and closes interrupted incidents on reload', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-')), 'i.json');
  const s = new IncidentStore(f);
  s.upsert({ id: 'x', type: 'disconnect', start: 100, end: null, lastSeen: 150 });
  s.upsert({ id: 'y', type: 'high_latency', start: 200, end: 300 });
  const s2 = new IncidentStore(f);
  assert.strictEqual(s2.list().length, 2);
  const x = s2.list().find((i) => i.id === 'x');
  assert.strictEqual(x.end, 150);
  assert.ok(x.interrupted);
  assert.strictEqual(s2.list({ type: 'disconnect' }).length, 1);
});

test('csv export escapes and formats', () => {
  const csv = incidentsToCsv([{ type: 'disconnect', start: 0, end: 61000, peakLatency: null, worstLoss: 1, targets: ['1.1.1.1', '=cmd'] }]);
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[1], /^Disconnect,1970-01-01T00:00:00.000Z,1970-01-01T00:01:01.000Z,61,,100,no,1\.1\.1\.1 =cmd$/);
  assert.ok(incidentsToCsv([{ type: 'x', start: 0, end: null, targets: [] }], 5000).includes(',5,'));
  assert.ok(incidentsToCsv([{ type: "=SUM(1)", start: 0, end: 1 }]).includes("'=SUM(1)"));
});

test('monitor tick emits sample and incidents using injected probe', async () => {
  let n = 0;
  const probe = async (host) => (n < 9 ? { host, ok: false, rtt: null } : { host, ok: true, rtt: 10 });
  const m = new Monitor({ targets: ['a', 'b', 'c'], detector: { failRounds: 2, recoverRounds: 1 } }, async (h) => { const r = await probe(h); return r; });
  const types = [];
  m.on('incident', (e) => types.push(e.type));
  const samples = [];
  m.on('sample', (s) => samples.push(s));
  for (let i = 0; i < 4; i++) { await m.tick(i * 1000); n += 3; }
  assert.deepStrictEqual(types, ['open', 'close']);
  assert.strictEqual(samples[0].online, false);
  assert.strictEqual(samples[3].online, true);
});
