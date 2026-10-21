'use strict';

/**
 * Claude Code writes one small status file per running process:
 * `~/.claude/sessions/<pid>.json`. It says whether that session is busy,
 * idle, or waiting for a person (and for what). It is a signal Claude Code
 * keeps for itself and does not promise a layout, so every read is defensive:
 * anything unexpected means "no signal" and the transcript rules take over.
 *
 * Read-only, and only the numbered `.json` files. The files next to them
 * (`*.key`) are never opened, never read and never named in
 * any output. Only status fields are kept: the pid, the session id, the
 * status, what it waits for and when; nothing else in the file is copied.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SESSIONS_DIR = () => process.env.AGENTTAIL_CLAUDE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');

const FILE_RE = /^(\d{1,10})\.json$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{3,128}$/;
const STATUSES = new Set(['busy', 'idle', 'waiting']);
const MAX_FILE_BYTES = 64 * 1024;
// A status older than this is treated as stale: a pid can be reused after a crash.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 1000;

let cache = { dir: '', at: 0, data: null };

/** True when a process with this pid exists (EPERM still means it exists). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === 'EPERM';
  }
}

/** A timestamp in ms from a number (ms or s) or an ISO string; 0 when unknown. */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * The fields we trust from one parsed file, or null for an unknown shape.
 * The pid inside must match the file name, so a stray file cannot claim
 * another process.
 */
function normalize(raw, filePid, mtimeMs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.pid) || raw.pid !== filePid) return null;
  if (typeof raw.sessionId !== 'string' || !SESSION_ID_RE.test(raw.sessionId)) return null;
  const status = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
  if (!STATUSES.has(status)) return null;
  const waitingFor = status === 'waiting' && typeof raw.waitingFor === 'string' ? raw.waitingFor.slice(0, 60) : null;
  const since = toMs(raw.statusUpdatedAt) || toMs(raw.updatedAt) || mtimeMs || 0;
  const updated = Math.max(toMs(raw.statusUpdatedAt), toMs(raw.updatedAt), mtimeMs || 0);
  return { pid: raw.pid, sessionId: raw.sessionId, status, waitingFor, since, updated };
}

/**
 * Live status per session id: only files whose process is alive, whose shape
 * is known and that are not stale. Cached for a second so a page polling the
 * session list does not re-read the folder on every request.
 */
async function readStatuses({ dir = SESSIONS_DIR(), now = Date.now(), alive = pidAlive, fresh = false } = {}) {
  if (!fresh && cache.data && cache.dir === dir && now - cache.at < CACHE_MS) return cache.data;
  const out = new Map();
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const match = FILE_RE.exec(name);
    if (!match) continue; // not a numbered status file: `*.key` and anything else stays closed
    const pid = Number(match[1]);
    const file = path.join(dir, name);
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const rec = normalize(raw, pid, st.mtimeMs);
    if (!rec) continue;
    if (now - rec.updated > MAX_AGE_MS) continue;
    if (!alive(rec.pid)) continue;
    const prev = out.get(rec.sessionId);
    if (!prev || rec.updated > prev.updated) out.set(rec.sessionId, rec);
  }
  cache = { dir, at: now, data: out };
  return out;
}

module.exports = { readStatuses, pidAlive, normalize, toMs, SESSIONS_DIR };
