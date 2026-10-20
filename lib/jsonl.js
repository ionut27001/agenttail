'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const { StringDecoder } = require('node:string_decoder');

/** Incremental JSONL reader that never loads a whole transcript into memory. */
class JsonlTail {
  constructor(file, { onObject, onLine } = {}) {
    this.file = file;
    this.offset = 0;
    this.carry = '';
    this.decoder = new StringDecoder('utf8');
    this.onObject = onObject;
    this.onLine = onLine;
    this.reading = null;
    this.lastMtimeMs = 0;
  }

  async stat() {
    try {
      return await fsp.stat(this.file);
    } catch {
      return null;
    }
  }

  /** Read everything appended since the last call. Returns parsed objects. */
  async readNew() {
    if (this.reading) return this.reading;
    this.reading = this._readNew().finally(() => { this.reading = null; });
    return this.reading;
  }

  async _readNew() {
    const st = await this.stat();
    if (!st) return 0;
    this.lastMtimeMs = st.mtimeMs;
    if (st.size < this.offset) {
      // File was rewritten: start over.
      this.offset = 0;
      this.carry = '';
      this.decoder = new StringDecoder('utf8');
    }
    if (st.size === this.offset) return 0;
    let count = 0;
    const fh = await fsp.open(this.file, 'r');
    try {
      let chunks = 0;
      while (this.offset < st.size) {
        const len = Math.min(4 * 1024 * 1024, st.size - this.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const text = this.carry + this.decoder.write(buf.subarray(0, bytesRead));
        const lines = text.split('\n');
        this.carry = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          count++;
          if (this.onLine) this.onLine(line);
          if (this.onObject) {
            try {
              this.onObject(JSON.parse(line));
            } catch {
              /* skip malformed line */
            }
          }
        }
        if (++chunks % 4 === 0) await new Promise((r) => setImmediate(r));
      }
    } finally {
      await fh.close().catch(() => {});
    }
    return count;
  }

  /** Parse whatever remains (a final line without a newline). */
  flush() {
    if (!this.carry.trim()) return;
    const line = this.carry;
    this.carry = '';
    if (this.onObject) {
      try { this.onObject(JSON.parse(line)); } catch { /* ignore */ }
    }
  }
}

module.exports = { JsonlTail };
