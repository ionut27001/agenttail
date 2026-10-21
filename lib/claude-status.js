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

const { execFile } = require('node:child_process');
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

// A "waiting" file puts a session in the inbox, so it must come from the live
// process and not from a pid that was reused after a crash. The file carries
// `procStart`, the process start time; the live process must report the same.
// Where that cannot be checked the wait is trusted only while it is this fresh:
// a question can sit for hours, so it matches QUESTION_MAX_AGE_MS in attention.js.
const WAITING_UNCONFIRMED_MAX_MS = 6 * 60 * 60 * 1000;
const START_RE = /^\d{1,20}$/;
const START_TIMEOUT_MS = 4000;
// A match is re-checked every minute (the process may have exited and its pid
// been reused since); a failed lookup is retried soon but not on every poll.
const START_MATCH_TTL_MS = 60 * 1000;
const START_FAIL_TTL_MS = 15 * 1000;
const START_CACHE_MAX = 500;

let cache = { dir: '', at: 0, data: null };
const startCache = new Map(); // `${pid}:${procStart}` -> { at, result: match | mismatch | unverified }
let startChain = Promise.resolve();

/** The start-time lookup for this platform, or null where there is none. */
function defaultStartTimes() {
  return process.platform === 'win32' ? processStartTimes : null;
}

/** Forget every confirmed start time (tests). */
function resetStartCache() {
  startCache.clear();
  cache = { dir: '', at: 0, data: null };
}

/**
 * Start times of live processes as Windows FILETIME decimal strings (100 ns
 * ticks since 1601, UTC), the form Claude Code writes as `procStart`. One
 * PowerShell call for all pids, asynchronous, killed after `timeoutMs`.
 * Resolves a Map pid -> string (a pid it could not read is left out) and
 * rejects when the lookup itself fails.
 */
function processStartTimes(pids, { timeoutMs = START_TIMEOUT_MS } = {}) {
  const ids = [...new Set((pids || []).filter((p) => Number.isInteger(p) && p > 0))];
  if (process.platform !== 'win32') return Promise.reject(new Error('start times are only read on Windows'));
  if (!ids.length) return Promise.resolve(new Map());
  const script = `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { '' + $_.Id + ' ' + $_.StartTime.ToFileTimeUtc() } catch {} }`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout) => {
        if (err) { reject(err); return; }
        const out = new Map();
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = /^(\d+) (\d+)$/.exec(line.trim());
          if (m) out.set(Number(m[1]), m[2]);
        }
        resolve(out);
      });
  });
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Compare each record's `procStart` with the live process: Map of
 * `${pid}:${procStart}` -> match | mismatch | unverified. Lookups run one at a
 * time, so two overlapping reads never start two PowerShell calls for the same pids.
 */
async function confirmStarts(records, startTimes, timeoutMs) {
  const out = new Map();
  const run = async () => {
    const at = Date.now();
    const todo = [];
    for (const rec of records) {
      const k = `${rec.pid}:${rec.procStart}`;
      const hit = startCache.get(k);
      const ttl = !hit ? 0 : hit.result === 'mismatch' ? Infinity : hit.result === 'match' ? START_MATCH_TTL_MS : START_FAIL_TTL_MS;
      if (hit && at - hit.at < ttl) out.set(k, hit.result);
      else todo.push(rec);
    }
    if (!todo.length) return;
    let answers = null;
    try {
      answers = await withTimeout(Promise.resolve(startTimes([...new Set(todo.map((r) => r.pid))])), timeoutMs);
    } catch {
      answers = null;
    }
    if (startCache.size > START_CACHE_MAX) startCache.clear();
    for (const rec of todo) {
      const live = answers instanceof Map ? answers.get(rec.pid) : undefined;
      const result = typeof live === 'string' && START_RE.test(live)
        ? (BigInt(live) === BigInt(rec.procStart) ? 'match' : 'mismatch')
        : 'unverified';
      const k = `${rec.pid}:${rec.procStart}`;
      startCache.set(k, { at: Date.now(), result });
      out.set(k, result);
    }
  };
  startChain = startChain.then(run).catch(() => {});
  await startChain;
  return out;
}

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
  // The process start time, kept as a plain decimal string (it does not fit a JS number).
  const procStart = typeof raw.procStart === 'string' && START_RE.test(raw.procStart.trim()) ? raw.procStart.trim().replace(/^0+(?=\d)/, '') : null;
  return { pid: raw.pid, sessionId: raw.sessionId, status, waitingFor, since, updated, procStart };
}

/**
 * Live status per session id: only files whose process is alive, whose shape
 * is known and that are not stale. Cached for a second so a page polling the
 * session list does not re-read the folder on every request.
 */
async function readStatuses({ dir = SESSIONS_DIR(), now = Date.now(), alive = pidAlive, fresh = false, startTimes = defaultStartTimes(), startTimeoutMs = START_TIMEOUT_MS } = {}) {
  if (!fresh && cache.data && cache.dir === dir && now - cache.at < CACHE_MS) return cache.data;
  const out = new Map();
  const found = [];
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
      // lstat, not stat: a link named <pid>.json must not lead the reader to
      // another file (a `.key` one, say). Only a regular file is opened.
      st = await fsp.lstat(file);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) continue;
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
    found.push(rec);
  }

  // Waiting files only: is the live process the one that wrote the file?
  const checkable = startTimes ? found.filter((r) => r.status === 'waiting' && r.procStart) : [];
  const starts = checkable.length ? await confirmStarts(checkable, startTimes, startTimeoutMs) : new Map();
  for (const rec of found) {
    if (rec.status === 'waiting') {
      const result = rec.procStart && startTimes ? (starts.get(`${rec.pid}:${rec.procStart}`) || 'unverified') : 'unsupported';
      if (result === 'mismatch') continue; // the pid now belongs to another process
      rec.startCheck = result;
      // What cannot be confirmed is trusted only while it is recent.
      if (result !== 'match' && now - rec.updated > WAITING_UNCONFIRMED_MAX_MS) continue;
    }
    const prev = out.get(rec.sessionId);
    if (!prev || rec.updated > prev.updated) out.set(rec.sessionId, rec);
  }
  cache = { dir, at: now, data: out };
  return out;
}

module.exports = { readStatuses, pidAlive, processStartTimes, resetStartCache, normalize, toMs, SESSIONS_DIR };
