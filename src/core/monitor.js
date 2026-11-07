'use strict';
const { EventEmitter } = require('node:events');
const { pingOnce } = require('./ping');
const { IncidentDetector } = require('./detector');

const DEFAULT_SETTINGS = {
  targets: ['1.1.1.1', '8.8.8.8', '9.9.9.9'],
  intervalMs: 2000,
  timeoutMs: 2000,
  detector: {},
};

class Monitor extends EventEmitter {
  constructor(settings = {}, probe = pingOnce) {
    super();
    this.probe = probe;
    this.setSettings(settings);
    this.timer = null;
    this.running = false;
  }

  setSettings(s) {
    this.settings = { ...DEFAULT_SETTINGS, ...s };
    this.detector = new IncidentDetector(this.settings.detector); // note: resets streaks
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      const t0 = Date.now();
      await this.tick();
      if (this.running) this.timer = setTimeout(loop, Math.max(0, this.settings.intervalMs - (Date.now() - t0)));
    };
    loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    for (const e of this.detector.flush()) this.emit('incident', e);
  }

  async tick(now = Date.now()) {
    const results = await Promise.all(
      this.settings.targets.map((h) => this.probe(h, this.settings.timeoutMs).catch(() => ({ host: h, ok: false, rtt: null }))),
    );
    const okRtts = results.filter((r) => r.ok && r.rtt != null).map((r) => r.rtt);
    const sample = {
      t: now,
      results,
      online: results.some((r) => r.ok),
      latency: okRtts.length ? okRtts.reduce((a, b) => a + b, 0) / okRtts.length : null,
    };
    this.emit('sample', sample);
    for (const e of this.detector.process(results, now)) this.emit('incident', e);
    return sample;
  }
}

module.exports = { Monitor, DEFAULT_SETTINGS };
