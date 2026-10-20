'use strict';

const path = require('node:path');

const DELETE_RE = /(?:^|[;&|\n]\s*)(?:Remove-Item|remove-item|ri|rm|del|erase|rmdir|rd|git\s+rm)\s+([^\n;&|]+)/g;

function unquote(token) {
  let t = String(token).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  return t;
}

/**
 * Best-effort deletion detection from shell commands. Returns absolute paths.
 * Only used to mark tree rows as deleted; it never touches the filesystem.
 */
function deletionsFromCommand(command, cwd) {
  const out = new Set();
  const text = String(command || '');
  DELETE_RE.lastIndex = 0;
  let m;
  while ((m = DELETE_RE.exec(text))) {
    const args = m[1].split(/\s+/);
    for (const raw of args) {
      if (!raw) continue;
      if (raw.startsWith('-') || /^\/[A-Za-z]+$/.test(raw)) continue; // flags/switches
      if (raw.includes('*') || raw.includes('?')) continue; // globs: too ambiguous
      const token = unquote(raw).replace(/[,;]+$/, '');
      if (!token || token === '.' || token === '..') continue;
      out.add(path.isAbsolute(token) ? path.resolve(token) : path.resolve(cwd || '.', token));
    }
  }
  return [...out];
}

module.exports = { deletionsFromCommand };
