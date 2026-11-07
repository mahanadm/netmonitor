'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Tiny JSON file store. Incident volume is low, so a full atomic rewrite on
// each change is fine and avoids native SQLite modules that complicate packaging.
class IncidentStore {
  constructor(file) {
    this.file = file;
    this.incidents = [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) this.incidents = data;
    } catch { /* first run or unreadable file */ }
    // Incidents left open by a crash get closed at their last known time.
    for (const i of this.incidents) if (i.end == null) { i.end = i.lastSeen ?? i.start; i.interrupted = true; }
  }

  upsert(incident) {
    const i = this.incidents.findIndex((x) => x.id === incident.id);
    if (i >= 0) this.incidents[i] = { ...this.incidents[i], ...incident };
    else this.incidents.push({ ...incident });
    this._save();
  }

  list({ from, to, type } = {}) {
    return this.incidents
      .filter((i) => (from == null || i.start >= from) && (to == null || i.start <= to) && (!type || i.type === type))
      .sort((a, b) => b.start - a.start);
  }

  clear() { this.incidents = []; this._save(); }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.incidents));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { IncidentStore };
