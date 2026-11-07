'use strict';

const esc = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const LABELS = { disconnect: 'Disconnect', high_latency: 'High latency', packet_loss: 'Packet loss' };

function incidentsToCsv(incidents, now = Date.now()) {
  const rows = [['Type', 'Start (ISO)', 'End (ISO)', 'Duration (s)', 'Peak latency (ms)', 'Worst loss (%)', 'Ongoing', 'Targets', 'Traceroute']];
  for (const i of incidents) {
    const end = i.end ?? now;
    rows.push([
      LABELS[i.type] || i.type,
      new Date(i.start).toISOString(),
      i.end ? new Date(i.end).toISOString() : '',
      Math.round((end - i.start) / 1000),
      i.peakLatency != null ? Math.round(i.peakLatency) : '',
      Math.round((i.worstLoss || 0) * 100),
      i.end ? 'no' : 'yes',
      (i.targets || []).join(' '),
      i.traceroute ? `${i.traceroute.summary} | ${i.traceroute.hops.map((h) => `${h.hop}:${h.ip || '*'}`).join(' ')}` : '',
    ]);
  }
  return rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

module.exports = { incidentsToCsv };
