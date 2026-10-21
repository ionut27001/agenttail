'use strict';

/**
 * Open approval prompts of the Antigravity CLI, read from the CLI's own log.
 *
 * Antigravity's transcript has no line for a tool step while it waits for
 * approval; the step appears once it has run. The CLI log does show the wait.
 * Each CLI process writes `log/cli-<start>.log` (local time in the name), whose
 * first line names the process:
 *
 *   I1021 23:37:03.1 25 server.go:1732] Starting language server process with pid 44120
 *
 * then the conversation it serves and, when a prompt opens and closes:
 *
 *   ... server.go:1814] Sending user message to conversation <uuid> (items=1, media=0)
 *   ... tool_confirmation_manager.go:226] Surfacing tool confirmation: "RunCommand" at step 2
 *   ... server.go:2628] Tool confirmation for conversation <uuid> step 2 (... approved=false)
 *
 * A prompt left open by a process that has exited stays open in the log (and in
 * Antigravity's own database), so a prompt counts only while that process is
 * alive, checked by pid and start time where the platform allows. Only uuids,
 * step numbers, tool names, the pid and times are kept: log text is never
 * stored or forwarded. Nothing here writes to Antigravity's folders, and its
 * databases are never opened.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const claudeStatus = require('./claude-status');

/** The CLI's data folder. ANTIGRAVITY_ROOT (a brain folder) implies its parent. */
function cliDir() {
  if (process.env.ANTIGRAVITY_CLI_DIR) return process.env.ANTIGRAVITY_CLI_DIR;
  if (process.env.ANTIGRAVITY_ROOT) return path.dirname(process.env.ANTIGRAVITY_ROOT);
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

const LOG_NAME_RE = /^cli-(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)\.log$/;
const LINE_TIME_RE = /^[IWEF](\d\d)(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?\s/;
const PID_RE = /Starting language server process with pid (\d+)/;
const CONV_RE = /(?:user message to conversation|cascade_id:)\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const NEW_TURN_RE = /user message to conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const OPEN_RE = /Surfacing tool confirmation: "([^"]{1,60})" at step (\d+)/;
const CLOSE_RE = /Tool confirmation for conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) step (\d+)/i;
const SOFT_DENY_RE = /soft-denying tool confirmation "[^"]{1,60}" at step (\d+)/;

// Logs older than this are not read: a process that old has a stale prompt or none.
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_LOGS = 20;
// A log larger than this is read as its head (pid and start) plus its tail.
const MAX_READ_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
// The process starts a moment before it names its log and writes its first line.
const START_TOLERANCE_MS = 15 * 1000;
const CACHE_MS = 1000;
const START_MATCH_TTL_MS = 60 * 1000;
const START_FAIL_TTL_MS = 15 * 1000;

/** Local time of a log line; the year comes from the log's name (glog lines carry none). */
function lineTime(line, year, startMonth) {
  const m = LINE_TIME_RE.exec(line);
  if (!m) return 0;
  const month = Number(m[1]);
  // A process that runs across New Year writes January lines into a December log.
  const y = month < startMonth ? year + 1 : year;
  const ms = Number((m[6] || '0').padEnd(3, '0').slice(0, 3));
  const t = new Date(y, month - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), ms).getTime();
  return Number.isFinite(t) ? t : 0;
}

function newState(name) {
  const m = LOG_NAME_RE.exec(name);
  const year = m ? Number(m[1]) : new Date().getFullYear();
  const startMonth = m ? Number(m[2]) : 1;
  const namedAt = m ? new Date(year, startMonth - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime() : 0;
  return { year, startMonth, namedAt, pid: 0, startAt: 0, conversation: null, open: new Map(), rest: '' };
}

/** Fold log lines into the state: the pid, the current conversation, open prompts by `${conversation}:${step}`. */
function feed(state, text) {
  const lines = (state.rest + text).split(/\r?\n/);
  state.rest = lines.pop() || '';
  for (const line of lines) {
    if (!line) continue;
    const at = lineTime(line, state.year, state.startMonth);
    if (!state.startAt && at) state.startAt = at;
    if (!state.pid) {
      const p = PID_RE.exec(line);
      if (p) state.pid = Number(p[1]);
    }
    const turn = NEW_TURN_RE.exec(line);
    if (turn) {
      const conv = turn[1].toLowerCase();
      // A new message to a conversation ends whatever prompt it had open.
      for (const [k, v] of state.open) if (v.conversation === conv) state.open.delete(k);
    }
    const conv = CONV_RE.exec(line);
    if (conv) state.conversation = conv[1].toLowerCase();
    const opened = OPEN_RE.exec(line);
    if (opened && state.conversation) {
      const step = Number(opened[2]);
      state.open.set(`${state.conversation}:${step}`, { conversation: state.conversation, step, tool: opened[1], since: at || Date.now() });
      continue;
    }
    const closed = CLOSE_RE.exec(line);
    if (closed) {
      state.open.delete(`${closed[1].toLowerCase()}:${Number(closed[2])}`);
      continue;
    }
    const soft = SOFT_DENY_RE.exec(line);
    if (soft && state.conversation) state.open.delete(`${state.conversation}:${Number(soft[1])}`);
  }
  return state;
}

/** Parse a whole log text (tests). */
function parseLog(text, name = 'cli-20000101_000000.log') {
  const state = feed(newState(name), text.endsWith('\n') ? text : text + '\n');
  return { pid: state.pid, startAt: state.startAt || state.namedAt, open: [...state.open.values()] };
}

const logCache = new Map(); // file -> { size, state }

async function readRange(fh, start, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, start);
  return buf.subarray(0, bytesRead).toString('utf8');
}

/** Bring one log's state up to date, reading only what was appended since the last call. */
async function updateLog(file, size) {
  let hit = logCache.get(file);
  if (hit && hit.size === size) return hit.state;
  if (!hit || size < hit.size) hit = { size: 0, state: newState(path.basename(file)) };
  const fh = await fsp.open(file, 'r');
  try {
    if (hit.size === 0 && size > MAX_READ_BYTES) {
      // The head names the process; the prompts that matter are near the end.
      feed(hit.state, await readRange(fh, 0, HEAD_BYTES));
      hit.state.rest = '';
      const tail = await readRange(fh, size - MAX_READ_BYTES, MAX_READ_BYTES);
      feed(hit.state, tail.slice(tail.indexOf('\n') + 1));
    } else if (size - hit.size > MAX_READ_BYTES) {
      // A huge burst since the last read (the server was asleep): only its end matters.
      hit.state.rest = '';
      const tail = await readRange(fh, size - MAX_READ_BYTES, MAX_READ_BYTES);
      feed(hit.state, tail.slice(tail.indexOf('\n') + 1));
    } else if (size > hit.size) {
      feed(hit.state, await readRange(fh, hit.size, size - hit.size));
    }
  } finally {
    await fh.close();
  }
  hit.size = size;
  logCache.set(file, hit);
  return hit.state;
}

const startCache = new Map(); // pid -> { at, ms | null }

/** Start time (ms) of a live process, or null when it cannot be read here. */
async function startOf(pid, startTimes) {
  if (!startTimes) return null;
  const hit = startCache.get(pid);
  const now = Date.now();
  if (hit && now - hit.at < (hit.ms ? START_MATCH_TTL_MS : START_FAIL_TTL_MS)) return hit.ms;
  let ms = null;
  try {
    const answers = await startTimes([pid]);
    const ft = answers instanceof Map ? answers.get(pid) : undefined;
    // Windows FILETIME: 100 ns ticks since 1601-01-01 UTC.
    if (typeof ft === 'string' && /^\d{1,20}$/.test(ft)) ms = Number(BigInt(ft) / 10000n - 11644473600000n);
  } catch { ms = null; }
  if (startCache.size > 200) startCache.clear();
  startCache.set(pid, { at: Date.now(), ms });
  return ms;
}

let cache = { dir: '', at: 0, data: null };
let inflight = null; // { dir, promise }: one pass at a time per folder

/**
 * Open prompts by conversation id: Map uuid -> { tool, step, since, startCheck }
 * where startCheck is `match` (the live process started when the log did) or
 * `unverified` (alive, but its start time cannot be read here). A prompt whose
 * process has exited, or whose pid now belongs to another process, is left out.
 */
function readPrompts(opts = {}) {
  const { dir = cliDir(), now = Date.now(), fresh = false } = opts;
  if (!fresh && cache.dir === dir && cache.data && now - cache.at < CACHE_MS) return Promise.resolve(cache.data);
  // Overlapping requests share one pass, so appended log bytes are folded in once.
  if (inflight && inflight.dir === dir) return inflight.promise;
  const promise = scan({ ...opts, dir, now }).finally(() => {
    if (inflight && inflight.promise === promise) inflight = null;
  });
  inflight = { dir, promise };
  return promise;
}

async function scan({ dir, now, alive = claudeStatus.pidAlive, startTimes = process.platform === 'win32' ? claudeStatus.processStartTimes : null }) {
  const out = new Map();
  const logDir = path.join(dir, 'log');
  let names = [];
  try { names = (await fsp.readdir(logDir)).filter((n) => LOG_NAME_RE.test(n)); } catch { names = []; }
  const logs = [];
  for (const name of names) {
    const file = path.join(logDir, name);
    let st;
    try { st = await fsp.lstat(file); } catch { continue; }
    if (!st.isFile() || now - st.mtimeMs > MAX_LOG_AGE_MS) continue;
    logs.push({ file, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs || 0 });
  }
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const current = logs.slice(0, MAX_LOGS);
  const keep = new Set(current.map((l) => l.file));
  for (const file of logCache.keys()) if (!keep.has(file)) logCache.delete(file);
  for (const log of current) {
    let state;
    try { state = await updateLog(log.file, log.size); } catch { continue; }
    if (!state.open.size || !state.pid || !alive(state.pid)) continue;
    const loggedStart = state.startAt || state.namedAt;
    const started = await startOf(state.pid, startTimes);
    // The log's wall-clock time is ambiguous in the hour a clock goes back, so the
    // file's creation time (a real instant) also confirms the process.
    const near = (t) => !!t && Math.abs(started - t) <= START_TOLERANCE_MS;
    if (started !== null && (loggedStart || log.birthtimeMs) && !near(loggedStart) && !near(log.birthtimeMs)) continue; // a reused pid
    const startCheck = started !== null && (loggedStart || log.birthtimeMs) ? 'match' : 'unverified';
    for (const prompt of state.open.values()) {
      const prev = out.get(prompt.conversation);
      if (!prev || prompt.since < prev.since) out.set(prompt.conversation, { tool: prompt.tool, step: prompt.step, since: prompt.since, startCheck });
    }
  }
  cache = { dir, at: now, data: out };
  return out;
}

/** Forget cached logs and start times (tests). */
function resetCache() {
  logCache.clear();
  startCache.clear();
  cache = { dir: '', at: 0, data: null };
  inflight = null;
}

module.exports = { readPrompts, parseLog, cliDir, resetCache };
