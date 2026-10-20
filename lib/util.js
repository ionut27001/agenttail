'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

/** Case-insensitive-ish path comparison (Windows semantics). */
function norm(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isInside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  if (!p) return false;
  return c === p || c.startsWith(p + '/');
}

/** Stable opaque handle for a workspace-relative display path. */
function keyFor(sessionId, display) {
  return crypto.createHash('sha1').update(`${sessionId}|${norm(display)}`).digest('hex').slice(0, 12);
}

function toPosix(p) {
  return String(p || '').replace(/\\/g, '/');
}

function relativeInside(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  const rel = path.relative(p, c);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.split(path.sep).join('/');
}

function clip(value, max) {
  const s = String(value ?? '');
  return s.length <= max ? s : s.slice(0, max);
}

module.exports = { norm, isInside, keyFor, toPosix, relativeInside, clip };
