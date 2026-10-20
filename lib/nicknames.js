'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Local session nicknames, stored next to the dashboard (never in .dsh). */
class Nicknames {
  constructor(file) {
    this.file = file;
    this.map = {};
    this.mtimeMs = -1;
  }

  load() {
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs === this.mtimeMs) return this.map;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.map = raw && typeof raw === 'object' ? raw : {};
      this.mtimeMs = st.mtimeMs;
    } catch {
      this.map = {};
      this.mtimeMs = -1;
    }
    return this.map;
  }

  get(key) {
    const value = this.load()[key];
    return typeof value === 'string' && value ? value : null;
  }

  set(key, value) {
    this.load();
    const clean = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean) delete this.map[key];
    else this.map[key] = clean;
    this.write();
    return clean || null;
  }

  write() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.nicknames-${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(this.map, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.file);
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.mtimeMs = -1;
    }
  }
}

module.exports = { Nicknames };
