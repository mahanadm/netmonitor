'use strict';

const DEFAULTS = {
  failRounds: 3,          // consecutive all-targets-failed rounds => disconnect
  lossRounds: 3,          // consecutive majority-failed rounds => packet loss
  latencyMs: 150,         // median RTT above this is "slow"
  latencyRounds: 3,       // consecutive slow rounds => high latency
  recoverRounds: 2,       // consecutive good rounds to close an incident
};

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
};

// A "round" is one probe of every target: [{host, ok, rtt}].
// Classifies each round as down / lossy / slow / good and runs a small state
// machine per incident type with hysteresis so brief blips don't create noise.
class IncidentDetector {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.counters = { disconnect: { bad: 0, good: 0 }, packet_loss: { bad: 0, good: 0 }, high_latency: { bad: 0, good: 0 } };
    this.open = {}; // type -> incident
    this.pendingStart = {}; // type -> timestamp of first bad round in current streak
  }

  classify(round) {
    const ok = round.filter((p) => p.ok);
    const failed = round.length - ok.length;
    const med = median(ok.map((p) => p.rtt).filter((r) => r != null));
    return {
      down: round.length > 0 && ok.length === 0,
      lossy: ok.length > 0 && failed * 2 >= round.length,
      slow: med != null && med > this.opts.latencyMs,
      median: med,
      failed,
      total: round.length,
    };
  }

  // Returns events: {type:'open'|'update'|'close', incident}
  process(round, now = Date.now()) {
    const c = this.classify(round);
    const events = [];
    const flags = { disconnect: c.down, packet_loss: c.lossy, high_latency: c.slow };
    const need = { disconnect: this.opts.failRounds, packet_loss: this.opts.lossRounds, high_latency: this.opts.latencyRounds };

    for (const type of Object.keys(flags)) {
      const st = this.counters[type];
      if (flags[type]) {
        if (st.bad === 0) this.pendingStart[type] = now;
        st.bad++; st.good = 0;
        if (!this.open[type] && st.bad >= need[type]) {
          const inc = {
            id: `${this.pendingStart[type]}-${type}`,
            type,
            start: this.pendingStart[type],
            end: null,
            peakLatency: c.median ?? null,
            worstLoss: round.length ? c.failed / round.length : 0,
            targets: round.map((p) => p.host),
          };
          this.open[type] = inc;
          events.push({ type: 'open', incident: { ...inc } });
        } else if (this.open[type]) {
          const inc = this.open[type];
          let changed = false;
          if (c.median != null && (inc.peakLatency == null || c.median > inc.peakLatency)) { inc.peakLatency = c.median; changed = true; }
          const loss = round.length ? c.failed / round.length : 0;
          if (loss > inc.worstLoss) { inc.worstLoss = loss; changed = true; }
          if (changed) events.push({ type: 'update', incident: { ...inc } });
        }
      } else {
        st.bad = 0;
        if (this.open[type]) {
          st.good++;
          if (st.good >= this.opts.recoverRounds) {
            const inc = this.open[type];
            inc.end = now;
            delete this.open[type];
            st.good = 0;
            events.push({ type: 'close', incident: { ...inc } });
          }
        }
      }
    }
    return events;
  }

  // Close anything still open (e.g. on app quit) so history stays consistent.
  flush(now = Date.now()) {
    const events = Object.values(this.open).map((inc) => { inc.end = now; return { type: 'close', incident: { ...inc } }; });
    this.open = {};
    return events;
  }
}

module.exports = { IncidentDetector, DEFAULTS, median };
