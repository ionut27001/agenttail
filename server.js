#!/usr/bin/env node
/**
 * agenttail — a local, read-only live viewer for AI coding agent sessions.
 *
 * Supported sources: DeepSeek Harness, Claude Code and Antigravity CLI.
 * Reads (never writes) session logs, decompresses them with Node's built-in
 * zlib, and streams a compact projection of the events to the browser over SSE.
 *
 * Node 24+, zero runtime dependencies. Binds to 127.0.0.1 only.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Roots } = require('./lib/roots');
const { Redactor, safeRedact } = require('./lib/redact');
const { keyFor, relativeInside, isInside } = require('./lib/util');
const { ControlManager, PRESETS, DEFAULT_PRESET, MAX_MESSAGE } = require('./lib/control');
const { buildAgents } = require('./lib/agents');
const claude = require('./lib/claude');
const antigravity = require('./lib/antigravity');
const { deletionsFromCommand } = require('./lib/deletes');
const { jobLogFromCommand } = require('./lib/jobs');
const { PRICES } = require('./lib/pricing');
const { analyzeLog } = require('./lib/session-analysis');
const { stateFrom, describe, LiveTracker } = require('./lib/live');
const { Nicknames } = require('./lib/nicknames');
const { SysMonitor } = require('./lib/sys');

const HOST = '127.0.0.1';
const ARGS = process.argv.slice(2);
const PORT = Number(
  process.env.PORT ||
  ARGS.find((a) => /^\d+$/.test(a)) ||
  8787,
);
const OPEN_BROWSER = !ARGS.includes('--no-open') && process.env.AGENTTAIL_NO_OPEN !== '1';
const CONFIG_DIR = process.env.AGENTTAIL_CONFIG_DIR ||
  (process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'agenttail')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agenttail'));
const envValue = (name) => process.env[`AGENTTAIL_${name}`] ?? process.env[`DSH_${name}`];
const ROOTS_FILE = envValue('ROOTS_FILE') || path.join(CONFIG_DIR, 'roots.json');
const REDACT_FILE = envValue('REDACT_FILE') || path.join(CONFIG_DIR, 'redact.json');
const NICKNAMES_FILE = envValue('NICKNAMES_FILE') || path.join(CONFIG_DIR, 'nicknames.json');
const SESSIONS_ROOT =
  process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), '.dsh', 'sessions');
const PUBLIC_DIR = path.join(__dirname, 'public');
let sea = null;
try { sea = require('node:sea'); } catch { /* not a SEA build */ }
const IS_SEA = !!(sea && typeof sea.isSea === 'function' && sea.isSea());

async function readPublic(rel) {
  if (IS_SEA) return Buffer.from(sea.getAsset(rel));
  return fsp.readFile(path.join(PUBLIC_DIR, rel));
}
const POLL_MS = Number(envValue('POLL_MS') || 700);
const HISTORY_DELAY_MS = Number(envValue('HISTORY_DELAY_MS') || 0);
const MAX_TEXT = 120 * 1024; // per tool result / message kept for the page
const MAX_EVENTS = 40000; // per session, in memory

// Stream mode is on unless the operator starts the server with --no-stream-mode.
const STREAM_MODE = !ARGS.includes('--no-stream-mode') && envValue('STREAM_MODE') !== 'off';

// Control is opt-in. Without --allow-control no control endpoint exists at all.
const ALLOW_CONTROL = ARGS.includes('--allow-control');
const CONTROL_FILE = envValue('CONTROL_FILE') || path.join(CONFIG_DIR, 'control.json');
const CONTROL_AUDIT_FILE = envValue('CONTROL_AUDIT_FILE') || path.join(CONFIG_DIR, 'control-audit.log');
const CONTROL_TOKEN = ALLOW_CONTROL ? crypto.randomBytes(32).toString('base64url') : null;
const CONTROL_TOKEN_HASH = CONTROL_TOKEN
  ? crypto.createHash('sha256').update(CONTROL_TOKEN).digest()
  : null;
const control = ALLOW_CONTROL
  ? new ControlManager({ configPath: CONTROL_FILE, auditPath: CONTROL_AUDIT_FILE })
  : null;

const SOURCE_DEFS = [
  { key: 'dsh', label: 'dsh', description: 'DeepSeek Harness session logs' },
  { key: 'claude', label: 'Claude Code', description: '~/.claude/projects transcripts (with subagents)' },
  { key: 'antigravity', label: 'Antigravity CLI', description: '~/.gemini/antigravity conversation transcripts' },
];

let sourceCache = { at: 0, data: null };

/** Every recent agent across sources, grouped by repository (see lib/agents.js). */
async function agentsPayload() {
  const all = [];
  for (const def of SOURCE_DEFS) {
    try {
      for (const s of await sessionsFor(def.key)) {
        const nickname = nicknames.get(`${def.key}:${s.id}`);
        all.push({ ...s, source: s.source || def.key, nickname: nickname || null });
      }
    } catch { /* a source that cannot be read is skipped */ }
  }
  return buildAgents(all, {
    text: (value) => redactor.text(String(value ?? '')),
    labelFor: (key) => SOURCE_DEFS.find((d) => d.key === key)?.label || key,
  });
}

/** Desktop sessions use `session-<uuid>`; ACP-created sessions use a bare uuid. */
function isSessionId(id) {
  return /^(?:session-)?[0-9a-fA-F-]{8,64}$/.test(String(id || ''));
}

async function sourcesPayload() {
  if (sourceCache.data && Date.now() - sourceCache.at < 10_000) return sourceCache.data;
  const out = [];
  for (const def of SOURCE_DEFS) {
    try {
      const sessions = await sessionsFor(def.key);
      out.push({ ...def, available: true, count: sessions.length });
    } catch {
      out.push({ ...def, available: false, count: 0 });
    }
  }
  sourceCache = { at: Date.now(), data: out };
  return out;
}

const roots = new Roots(ROOTS_FILE);
const redactor = new Redactor({
  configPath: REDACT_FILE,
  enabled: STREAM_MODE,
});
const nicknames = new Nicknames(NICKNAMES_FILE);
roots.config().then((cfg) => {
  rootsCfg = cfg;
  redactor.setPrivateRoots(cfg.privateRoots);
}).catch(() => {});

/** Allowlisted-root config snapshot (refreshed on every session listing). */
let rootsCfg = { roots: [], privateRoots: [] };

function mapPathSync(root, value) {
  if (!root || !value) return null;
  const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const rel = relativeInside(abs, root);
  if (rel) return rel;
  for (const r of rootsCfg.roots) {
    const inner = relativeInside(abs, r.path);
    if (inner) return r.as ? `${r.as}/${inner}` : null;
  }
  return null;
}

function adapterCtx() {
  return {
    redactor,
    maxEvents: MAX_EVENTS,
    pollMs: POLL_MS,
    mapPath: mapPathSync,
  };
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const sessionCache = new Map();

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Positions of zstd frame magic numbers inside a buffer. */
function findFrames(buf) {
  const out = [];
  let i = 0;
  while (i <= buf.length - 4) {
    const at = buf.indexOf(ZSTD_MAGIC, i);
    if (at === -1) break;
    out.push(at);
    i = at + 4;
  }
  return out;
}

/**
 * Decompress the first JSONL line(s) of a log without loading the whole file.
 * Reads up to 1 MiB and decodes the first complete frame that parses.
 */
async function readSessionHead(logPath) {
  let fh;
  try {
    fh = await fsp.open(logPath, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const data = buf.subarray(0, bytesRead);
    const frames = findFrames(data);
    const candidates = frames.length > 1 ? [...frames.slice(1), data.length] : [data.length];
    for (const end of candidates) {
      try {
        const text = zlib.zstdDecompressSync(data.subarray(0, end)).toString('utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev && ev.type === 'session') return ev;
          } catch {
            /* keep trying */
          }
        }
      } catch {
        /* incomplete frame — try a longer slice */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** Open-job cache: logPath -> { size, mtimeMs, open } */
const openJobCache = new Map();

/**
 * Decode the last few hundred KiB of a session log. Frames are independent, so
 * a tail can be decoded without touching the whole file.
 */
async function readTailEvents(logPath, maxBytes = 512 * 1024) {
  let st;
  try {
    st = await fsp.stat(logPath);
  } catch {
    return [];
  }
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return [];
  const buf = Buffer.alloc(len);
  let fh;
  try {
    fh = await fsp.open(logPath, 'r');
    await fh.read(buf, 0, len, start);
  } catch {
    return [];
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  const frames = findFrames(buf);
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const end = i + 1 < frames.length ? frames[i + 1] : buf.length;
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(frames[i], end)).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

/** A session is still live when a registered job has no job/settled yet. */
async function hasOpenJobs(logPath, rec) {
  const cached = openJobCache.get(logPath);
  if (cached && cached.size === rec.size && cached.mtimeMs === rec.mtimeMs) return cached.open;
  if (Date.now() - rec.mtimeMs > 24 * 60 * 60 * 1000) {
    openJobCache.set(logPath, { size: rec.size, mtimeMs: rec.mtimeMs, open: false });
    return false;
  }
  const events = await readTailEvents(logPath);
  const open = new Set();
  for (const ev of events) {
    if (ev.type === 'job/registered' && ev.data?.jobId) open.add(ev.data.jobId);
    else if (ev.type === 'job/settled' && ev.data?.jobId) open.delete(ev.data.jobId);
  }
  const result = open.size > 0;
  openJobCache.set(logPath, { size: rec.size, mtimeMs: rec.mtimeMs, open: result });
  return result;
}

/** Per-session analysis cache (state, title, tokens, cost), keyed by size+mtime. */
const analysisCache = new Map();
const listTracker = new LiveTracker();
const sysMonitor = new SysMonitor();

async function analysisFor(rec) {
  const cached = analysisCache.get(rec.logPath);
  if (cached && cached.size === rec.size && cached.mtimeMs === rec.mtimeMs) return cached.result;
  const data = await analyzeLog(rec.logPath, Date.now());
  if (!data) return cached ? cached.result : null;
  analysisCache.set(rec.logPath, {
    size: data.size,
    mtimeMs: data.mtimeMs,
    at: Date.now(),
    result: data.result,
  });
  return data.result;
}

async function listSessions() {
  let workspaceDirs = [];
  try {
    workspaceDirs = await fsp.readdir(SESSIONS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const ws of workspaceDirs) {
    if (!ws.isDirectory()) continue;
    const wsPath = path.join(SESSIONS_ROOT, ws.name);
    let sessionDirs;
    try {
      sessionDirs = await fsp.readdir(wsPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sd of sessionDirs) {
      if (!sd.isDirectory() || !isSessionId(sd.name)) continue;
      const dir = path.join(wsPath, sd.name);
      const logPath = path.join(dir, 'session.v4.jsonl.zstd');
      let st;
      try {
        st = await fsp.stat(logPath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      found.push({ id: sd.name, dir, logPath, workspaceDir: ws.name, size: st.size, mtimeMs: st.mtimeMs });
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recent = found.slice(0, 60);
  const sessions = await Promise.all(recent.map(async (rec) => {
    const cached = sessionCache.get(rec.id);
    let head = null;
    if (cached && cached.logPath === rec.logPath && cached.cwd) {
      head = cached;
    } else {
      head = await readSessionHead(rec.logPath);
      if (head) sessionCache.set(rec.id, { ...rec, ...head });
    }
    const analysis = await analysisFor(rec);
    const key = `dsh:${rec.id}`;
    const state = analysis ? listTracker.update(key, analysis.rawState) : 'finished';
    const nickname = nicknames.get(key);
    return {
      ...rec,
      ...(head || {}),
      state,
      stateDetail: analysis ? analysis.stateDetail : '',
      lastEventAt: analysis ? analysis.lastEventAt : rec.mtimeMs,
      title: analysis ? analysis.title : null,
      sessionTitle: analysis ? analysis.sessionTitle : null,
      firstUser: analysis ? analysis.firstUser : null,
      lastUser: analysis ? analysis.lastUser : null,
      empty: analysis ? (analysis.steps === 0 && analysis.tokens === 0) : false,
      steps: analysis ? analysis.steps : null,
      tokens: analysis ? analysis.tokens : null,
      cost: analysis ? analysis.cost : null,
      model: analysis ? analysis.model : null,
      provider: analysis ? analysis.provider : null,
      preset: analysis ? analysis.preset : null,
      policy: analysis ? analysis.policy : null,
      sandbox: analysis ? analysis.sandbox : null,
      lastTool: analysis ? analysis.lastTool : null,
      touched: analysis ? analysis.touched : [],
      owned: !!(ALLOW_CONTROL && control && control.has(rec.id)),
      live: state === 'live',
    };
  }));
  const order = { live: 0, idle: 1, finished: 2 };
  sessions.sort((a, b) => (order[a.state] - order[b.state]) || ((b.lastEventAt || 0) - (a.lastEventAt || 0)));
  return sessions;
}

async function findSessionById(id) {
  if (!isSessionId(id)) return null;
  const sessions = await listSessions();
  const hit = sessions.find((s) => s.id === id);
  if (!hit) return null;
  return { ...hit, source: 'dsh' };
}
// ---------------------------------------------------------------------------
// Live log tail: incremental zstd frame decoding
// ---------------------------------------------------------------------------

class SessionStream extends EventTarget {
  constructor(record) {
    super();
    this.record = record;
    this.session = record;
    this.source = 'dsh';
    this.id = record.id;
    record.source = 'dsh';
    this.logPath = record.logPath;
    this.events = [];
    this.lastSeq = -1;
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.carry = '';
    this.started = false;
    this.lastPollAt = 0;
    this.lastWriteAt = record.mtimeMs;
    this.live = false;
    this.pollTimer = null;
    this.statTimer = null;
    this.refs = 0;
    this.failStreak = 0;
    this.idleTimer = null;
    this.keys = new Map(); // opaque tree key -> workspace-relative display path
    this.commands = new Map(); // callId -> {command, workdir}, for environment output + deletes
    this.callCommands = new Map(); // callId -> {command, workdir}, kept for job log discovery
    this.lastCommand = null;
    this.openJobs = new Map(); // jobId -> { jobId, label, startedAt, kind, callId, info }
    this.jobTails = new Map(); // jobId -> { path, offset, skip }
    this.openSteps = new Map();
    this.openTurns = new Set();
    this.lastEndAt = 0;
    this.lastEventAt = 0;
    this.stateTracker = new LiveTracker();
    this.statusKey = '';
    this.rootsCfg = null;
    this.rootsReady = roots.config().then((cfg) => { this.rootsCfg = cfg; });
  }

  /** Map absolute paths (including junction targets) to display paths + keys. */
  mapPaths(ui) {
    const cfg = this.rootsCfg;
    if (!cfg || !this.record.cwd) return;
    const map = (value) => {
      if (!value || typeof value !== 'string') return value;
      const abs = path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.record.cwd, value);
      const rel = relativeInside(abs, this.record.cwd);
      if (rel) return rel;
      for (const r of cfg.roots) {
        const inner = relativeInside(abs, r.path);
        if (inner) return r.as ? `${r.as}/${inner}` : null;
      }
      return value;
    };
    const apply = (obj, field) => {
      if (!obj || typeof obj[field] !== 'string') return;
      const display = map(obj[field]);
      if (display === null) return;
      obj[field] = display;
      obj[`${field}Key`] = keyFor(`${this.source}:${this.id}`, display);
      this.keys.set(obj[`${field}Key`], display);
    };
    if (ui.t === 'call' && ui.args) {
      apply(ui.args, 'file_path');
      if (ui.args.file_pathKey) ui.args.key = ui.args.file_pathKey;
    }
    if (ui.t === 'result' && ui.meta) {
      apply(ui.meta, 'path');
      if (ui.meta.pathKey) ui.meta.key = ui.meta.pathKey;
    }
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  start() {    if (this.started) return;
    this.started = true;
    this.pollTimer = setInterval(() => this.poll().catch(() => {}), POLL_MS);
    this.pollTimer.unref?.();
    this.poll().catch(() => {});
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.started = false;
  }

  reset() {
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.carry = '';
    this.lastSeq = -1;
    this.failStreak = 0;
  }

  async poll() {
    // The interval and an incoming SSE connection can ask at the same time;
    // never read the same byte range twice.
    if (this.polling) return this.polling;
    this.polling = this._poll().finally(() => { this.polling = null; });
    return this.polling;
  }

  async _poll() {
    await this.rootsReady;
    let st;
    try {
      st = await fsp.stat(this.logPath);
    } catch {
      return;
    }
    this.lastPollAt = Date.now();
    this.lastWriteAt = st.mtimeMs;

    if (st.size < this.offset) {
      // Log was rewritten/rotated: replay from scratch on the next connection.
      this.reset();
      this.record.size = st.size;
      this.record.mtimeMs = st.mtimeMs;
      this.emit('reset', { size: st.size });
      return;
    }
    if (st.size === this.offset) {
      await this.pollJobLogs();
      this.emitStatus();
      return;
    }

    const len = st.size - this.offset;
    let buf = Buffer.alloc(len);
    let fh;
    try {
      fh = await fsp.open(this.logPath, 'r');
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, this.offset + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      if (got < len) buf = buf.subarray(0, got);
    } catch {
      return;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    this.offset += buf.length;
    this.pending = Buffer.concat([this.pending, buf]);
    this.drain();
    this.record.size = st.size;
    this.record.mtimeMs = st.mtimeMs;
    await this.pollJobLogs();
    this.emitStatus();
    if (this.pending.length > 16 * 1024 * 1024) this.pending = Buffer.alloc(0);
  }

  /** Tail a background job's redirected log file and stream new output. */
  async pollJobLogs() {
    for (const [jobId, job] of this.openJobs) {
      let tail = this.jobTails.get(jobId);
      if (!tail) {
        const info = job.info || {};
        const allowed = (p) => {
          const abs = path.resolve(String(p || ''));
          if (this.record.cwd && isInside(abs, this.record.cwd)) return true;
          return (this.rootsCfg?.roots || []).some((r) => isInside(abs, r.path));
        };
        const logPath = jobLogFromCommand(info.command || job.label || '', info.workdir || this.record.cwd, allowed);
        if (!logPath) {
          this.jobTails.set(jobId, { skip: true });
          continue;
        }
        let st = null;
        try { st = await fsp.stat(logPath); } catch { /* not created yet */ }
        tail = { path: logPath, offset: st ? Math.max(0, st.size - 2048) : 0, skip: false };
        this.jobTails.set(jobId, tail);
      }
      if (tail.skip) continue;
      let st;
      try {
        st = await fsp.stat(tail.path);
      } catch {
        continue;
      }
      if (st.size <= tail.offset) continue;
      const len = Math.min(st.size - tail.offset, 64 * 1024);
      const buf = Buffer.alloc(len);
      let fh;
      try {
        fh = await fsp.open(tail.path, 'r');
        await fh.read(buf, 0, len, tail.offset);
      } catch {
        continue;
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
      tail.offset += len;
      let text;
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        text = buf.subarray(2).toString('utf16le');
      } else {
        const sample = buf.subarray(0, Math.min(buf.length, 512));
        let zeros = 0;
        for (const byte of sample) if (byte === 0) zeros++;
        text = sample.length > 8 && zeros / sample.length > 0.2 ? buf.toString('utf16le') : buf.toString('utf8');
      }
      text = text.replace(/^\uFEFF/, '');
      if (!text.trim()) continue;
      const ev = this.safeEvent({ t: 'jobOutput', jobId, text, time: Date.now() });
      this.events.push(ev);
      this.emit('event', ev);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  /** Log-derived state, independent of mtime. */
  computeState(now = Date.now()) {
    const openJob = this.openJobs.size
      ? [...this.openJobs.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))[0]
      : null;
    const openStep = this.openSteps.size ? [...this.openSteps.values()][0] : null;
    const openTurn = this.openTurns.size ? [...this.openTurns.values()][0] : null;
    const rawState = stateFrom({
      openJob: !!openJob,
      openStep: !!openStep,
      openTurn: !!openTurn,
      lastEndAt: this.lastEndAt,
      now,
    });
    const state = this.stateTracker.update(`${this.source}:${this.id}`, rawState);
    const stateDetail = describe({
      state: rawState,
      openJob,
      openStep,
      openTurn: openTurn ? { turn: openTurn } : null,
      lastEventAt: this.lastEventAt,
      lastEndAt: this.lastEndAt,
      now,
    });
    return { state, rawState, stateDetail };
  }

  emitStatus() {
    const s = this.computeState();
    this.live = s.state === 'live';
    const key = `${s.state}|${s.stateDetail}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    this.emit('status', { ...statusFor(this), state: s.state, stateDetail: redactor.text(s.stateDetail) });
  }

  setLive(value) {
    if (this.live === value) return;
    this.live = value;
    this.emitStatus();
  }

  drain() {
    const frames = findFrames(this.pending);
    if (!frames.length) {
      // Stream does not start at a frame boundary: resync forward.
      const next = this.pending.indexOf(ZSTD_MAGIC, 1);
      if (next > 0) this.pending = this.pending.subarray(next);
      return;
    }
    if (frames[0] > 0) this.pending = this.pending.subarray(frames[0]);

    let pos = 0; // index into the (recomputed) frame list
    let consumed = 0;
    let progressed = false;

    outer: while (pos < frames.length) {
      const start = frames[pos];
      for (let j = pos + 1; j <= frames.length; j++) {
        const end = j < frames.length ? frames[j] : this.pending.length;
        let text;
        try {
          text = zlib.zstdDecompressSync(this.pending.subarray(start, end)).toString('utf8');
        } catch {
          // Either an incomplete trailing frame (wait for more bytes) or a
          // false frame boundary; try a longer slice, which also decodes
          // concatenated frames.
          continue;
        }
        this.feed(text);
        consumed = end;
        progressed = true;
        pos = j < frames.length ? j : frames.length;
        continue outer;
      }
      break; // no complete frame left
    }

    if (consumed > 0) {
      this.pending = this.pending.subarray(consumed);
      this.failStreak = 0;
    } else if (progressed) {
      this.failStreak = 0;
    } else if (this.pending.length > 0) {
      this.failStreak++;
      if (this.failStreak > 20) this.reset(); // give up on this window
    }
  }

  feed(text) {
    const data = this.carry + text;
    const lines = data.split('\n');
    this.carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const ui = projectEvent(ev);
      if (!ui) continue;
      this.mapPaths(ui);
      if (typeof ui.seq === 'number') {
        if (ui.seq <= this.lastSeq) continue;
        this.lastSeq = ui.seq;
      }
      this.lastEventAt = Math.max(this.lastEventAt, ui.time || 0);
      if (ui.t === 'step' && ui.step !== undefined) {
        this.openSteps.set(`${ui.turn}:${ui.step}`, { turn: ui.turn, step: ui.step });
      } else if (ui.t === 'stepEnd') {
        this.openSteps.delete(`${ui.turn}:${ui.step}`);
        this.lastEndAt = Math.max(this.lastEndAt, ui.time || 0);
      } else if (ui.t === 'turn') {
        this.openTurns.add(ui.turn);
      } else if (ui.t === 'turnEnd') {
        this.openTurns.delete(ui.turn);
        this.lastEndAt = Math.max(this.lastEndAt, ui.time || 0);
      }
      // Environment output keeps variable names and loses the values.
      if (ui.t === 'call' && ui.name === 'pwsh' && ui.callId) {
        const info = {
          command: ui.args.command || '',
          workdir: ui.args.workdir || this.record.cwd,
        };
        this.commands.set(ui.callId, info);
        this.callCommands.set(ui.callId, info);
        if (this.callCommands.size > 200) this.callCommands.delete(this.callCommands.keys().next().value);
      } else if (ui.t === 'result' && ui.callId !== undefined) {
        const info = this.commands.get(ui.callId);
        if (info) {
          ui.envDump = isEnvDumpCommand(info.command);
          this.commands.delete(ui.callId);
          this.lastCommand = info;
        }
      }
      const safe = this.safeEvent(ui);
      this.events.push(safe);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
      this.emit('event', safe);

      if (ui.t === 'job' && ui.jobId) {
        const info = this.commands.get(ui.callId)
          || this.callCommands.get(ui.callId)
          || { command: ui.label, workdir: this.record.cwd };
        this.openJobs.set(ui.jobId, {
          jobId: ui.jobId,
          label: ui.label,
          kind: ui.kind,
          startedAt: ui.startedAt,
          callId: ui.callId,
          info,
        });
        this.jobTails.delete(ui.jobId);
      } else if (ui.t === 'jobEnd' && ui.jobId) {
        this.openJobs.delete(ui.jobId);
        this.jobTails.delete(ui.jobId);
      }
      if (ui.t === 'job' || ui.t === 'jobEnd') this.emitStatus();

      if (ui.t === 'result' && !ui.isError) {
        const info = this.lastCommand;
        this.lastCommand = null;
        if (info) {
          for (const abs of deletionsFromCommand(info.command, info.workdir)) {
            const display = mapPathSync(this.record.cwd, abs) || abs;
            const deleted = this.safeEvent({
              t: 'deleted',
              time: ui.time,
              path: display,
              key: keyFor(`${this.source}:${this.id}`, display),
            });
            this.events.push(deleted);
            this.emit('event', deleted);
          }
        }
      }
    }
  }

  /** Fail closed: a redaction failure drops the event, never passes it raw. */
  safeEvent(ui) {
    return safeRedact(redactor, ui);
  }
}

function isEnvDumpCommand(command) {
  const c = String(command || '').trim();
  if (/^(env|printenv|set)$/i.test(c)) return true;
  return /\b(Get-ChildItem|gci|dir|ls)\s+(env:|\$env:|Env:)/i.test(c);
}

// ---------------------------------------------------------------------------
// Compact projection of log events for the browser
// ---------------------------------------------------------------------------

function clip(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return value ?? null;
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function blockText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function safeJson(str) {  if (typeof str !== 'string') return str && typeof str === 'object' ? str : null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function looksInjectedUserText(text) {
  const s = String(text || '');
  if (!s) return false;
  if (s.startsWith('<')) return true;
  if (/^(?:Current runtime context|Time sampled while preparing|The approval policy changed|\[Request interrupted)/i.test(s)) return true;
  return /system-reminder|runtime-context|Browser time zone|environment_context/i.test(s);
}

function labelForSystem(kind, text) {
  switch (kind) {
    case 'runtime-context': return '⟐ runtime context';
    case 'time-context': return '⏱ time context';
    case 'agent-instructions': return '⌘ instructions';
    case 'skill-catalog': return '☰ skills';
    case 'user-approval': return '⚑ approval';
    default: return '⟐ system';
  }
}

function projectEvent(ev) {
  const t = ev && ev.type;
  if (!t) return null;
  const d = ev.data || {};
  const base = { seq: ev.seq, time: ev.time, t: null };

  switch (t) {
    case 'session':
      return {
        time: ev.createdAt,
        t: 'session',
        id: ev.id,
        cwd: ev.cwd,
        createdAt: ev.createdAt,
        version: ev.version,
      };

    case 'session/title':
      return { ...base, t: 'title', title: clip(d.title, 200) };

    case 'step/start':
      return { ...base, t: 'step', turn: d.turn, step: d.step };

    case 'step/end':
      return { ...base, t: 'stepEnd', turn: d.turn, step: d.step };

    case 'tool/call': {
      const args = safeJson(d.arguments) || {};
      const lean = {};
      const keep = ['command', 'description', 'file_path', 'old_string', 'new_string', 'content', 'pattern', 'path', 'include', 'workdir', 'justification', 'offset', 'limit', 'sandbox_permissions', 'replace_all'];
      for (const k of keep) if (args[k] !== undefined) lean[k] = clip(args[k], k === 'content' || k === 'new_string' || k === 'old_string' ? MAX_TEXT : 4000);
      return { ...base, t: 'call', callId: d.callId, name: d.name, args: lean, turn: d.turn, step: d.step };
    }

    case 'tool/result': {
      const msg = d.message || {};
      const text = blockText(msg.content);
      return {
        ...base,
        t: 'result',
        callId: msg.toolCallId || msg.source?.callId || null,
        text: clip(text),
        chars: text.length,
        isError: !!msg.isError,
        meta: d.meta
          ? { path: d.meta.path ?? null, operation: d.meta.operation ?? null, cwd: d.meta.cwd ?? null }
          : null,
      };
    }

    case 'assistant/message': {
      const msg = d.message || {};
      const text = blockText(msg.content).trim();
      const thinking = Array.isArray(msg.content)
        ? msg.content.filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string' && b.text.trim()).map((b) => b.text).join('\n\n')
        : '';
      const usage = d.usage || null;
      return {
        ...base,
        t: 'say',
        text: clip(text, 20000),
        thinking: thinking ? clip(thinking, 20000) : undefined,
        turn: d.turn,
        step: d.step,
        usage: usage
          ? {
              input: usage.inputTokens || 0,
              output: usage.outputTokens || 0,
              cacheRead: usage.cacheReadTokens || 0,
              cacheWrite: usage.cacheWriteTokens || 0,
            }
          : null,
      };
    }

    case 'user/message': {
      const kind = d.source && d.source.kind ? String(d.source.kind) : null;
      const text = blockText(d.content);
      const injected = (kind !== null && kind !== 'user') || looksInjectedUserText(text);
      return {
        ...base,
        t: 'user',
        text: clip(text, 1200),
        system: injected,
        systemKind: kind,
        systemLabel: injected ? labelForSystem(kind, text) : null,
      };
    }

    case 'job/registered':
      return {
        ...base,
        t: 'job',
        callId: d.toolCall?.callId || null,
        jobId: d.jobId,
        label: clip(d.label, 2000),
        kind: d.kind,
        startedAt: d.startedAt,
      };

    case 'job/settled':
      return {
        ...base,
        t: 'jobEnd',
        callId: d.toolCall?.callId || null,
        jobId: d.jobId,
        status: d.status,
        detail: clip(d.detail, 300),
      };

    case 'approval/asked':
      return { ...base, t: 'approval', callId: d.callId, toolName: d.toolName, reason: clip(d.reason, 300) };

    case 'approval/decided':
      return { ...base, t: 'approvalDone', outcome: d.outcome };

    case 'approval/policy':
      return { ...base, t: 'policy', policy: d.policy || null };

    case 'permission/preset':
      return { ...base, t: 'preset', preset: d.preset || null };

    case 'sandbox/mode':
      return { ...base, t: 'sandbox', mode: d.mode || null };

    case 'request/context':
      return {
        ...base,
        t: 'route',
        provider: d.provider || null,
        model: d.model || null,
        contextWindow: Number.isFinite(d.contextWindow) ? d.contextWindow : null,
      };

    case 'turn/start':
      return { ...base, t: 'turn', turn: d.turn };

    case 'turn/end':
      return { ...base, t: 'turnEnd', turn: d.turn };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Session stream registry + SSE
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} */
const streams = new Map();

const streamKey = (record) => `${record.source || 'dsh'}:${record.id}`;

/** Live status payload shared by every source adapter. */
function statusFor(stream) {
  return {
    live: !!stream.live,
    lastWriteAt: stream.lastWriteAt,
    size: stream.record?.size ?? stream.session?.size,
    jobs: stream.openJobs
      ? [...stream.openJobs.values()].map((j) => ({
          jobId: j.jobId,
          label: redactor.text(j.label),
          startedAt: j.startedAt,
          kind: j.kind,
          callId: j.callId || null,
        }))
      : [],
  };
}

async function getStream(record) {
  const key = streamKey(record);
  let stream = streams.get(key);
  if (!stream) {
    if (record.source === 'claude') stream = claude.open(record, adapterCtx());
    else if (record.source === 'antigravity') stream = antigravity.open(record, adapterCtx());
    else stream = new SessionStream(record);
    stream.__key = key;
    streams.set(key, stream);
    stream.start();
  }
  return stream;
}

async function sessionsFor(source) {
  const key = source || 'dsh';
  if (key === 'claude') return claude.listSessions(adapterCtx());
  if (key === 'antigravity') return antigravity.listSessions(adapterCtx());
  const sessions = await listSessions();
  return sessions.map((s) => ({ ...s, source: 'dsh' }));
}

async function findSession(source, id) {
  const key = source || 'dsh';
  if (!id) return null;
  if (key === 'dsh') {
    if (!isSessionId(id)) return null;
  } else if (!/^[A-Za-z0-9._-]{3,128}$/.test(id)) {
    return null;
  }
  const sessions = await sessionsFor(key);
  return sessions.find((s) => s.id === id) || null;
}

function sseWrite(res, event, data) {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client vanished */
  }
}

/** Capability snapshot for the browser; never contains the token. */
function controlDescriptor(record) {
  if (!ALLOW_CONTROL || !control) return null;
  const base = {
    enabled: true,
    locked: STREAM_MODE,
    source: record.source,
    presets: PRESETS,
    defaultPreset: DEFAULT_PRESET,
  };
  if (record.source !== 'dsh') return { ...base, owned: false, viewOnly: true, reason: 'source' };
  const session = control.sessions.get(record.id);
  if (!session) return { ...base, owned: false, viewOnly: true, reason: 'external' };
  return { ...base, ...session.statePayload() };
}

function safeApproval(approval) {
  if (!approval) return approval;
  const diff = approval.diff
    ? {
        path: approval.diff.path ? redactor.text(approval.diff.path) : null,
        oldText: redactor.text(approval.diff.oldText || ''),
        newText: redactor.text(approval.diff.newText || ''),
      }
    : null;
  const raw = approval.rawInput && typeof approval.rawInput === 'object'
    ? Object.fromEntries(Object.entries(approval.rawInput).map(([key, value]) => [
        key,
        typeof value === 'string' ? redactor.text(value) : value,
      ]))
    : null;
  return {
    ...approval,
    title: redactor.text(approval.title),
    command: redactor.text(approval.command),
    content: redactor.text(approval.content),
    diff,
    rawInput: raw,
  };
}

function authorizedControl(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(header);
  if (!match || !CONTROL_TOKEN_HASH) return false;
  const digest = crypto.createHash('sha256').update(match[1]).digest();
  return digest.length === CONTROL_TOKEN_HASH.length
    && crypto.timingSafeEqual(digest, CONTROL_TOKEN_HASH);
}

async function waitForSessionRecord(id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await findSessionById(id);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

async function serveStream(req, res, record, options = {}) {
  const stream = await getStream(record);
  stream.start();
  // Decode whatever is already on disk before sending history, so the page
  // never sees an empty history followed by a delayed replay.
  try {
    await stream.poll();
  } catch {
    /* keep going */
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': agenttail\n\n');

  const initialState = stream.computeState
    ? stream.computeState()
    : { state: stream.live ? 'live' : 'finished', stateDetail: '' };
  stream.live = initialState.state === 'live';

  const controlSession = ALLOW_CONTROL && control && record.source === 'dsh'
    ? control.sessions.get(record.id)
    : null;

  sseWrite(res, 'meta', {
    session: {
      id: record.id,
      source: record.source,
      title: redactor.text(record.title),
      cwd: redactor.text(record.cwd, { path: record.cwd }),
      createdAt: record.createdAt,
      version: record.version,
      size: record.size,
      mtimeMs: record.mtimeMs,
      state: initialState.state,
      stateDetail: redactor.text(initialState.stateDetail),
      model: record.model || null,
      provider: record.provider || null,
      preset: record.preset || null,
      policy: record.policy || null,
      sandbox: record.sandbox || null,
      owned: record.owned === true,
    },
    streamSafe: redactor.enabled,
    prices: record.source === 'dsh' ? PRICES : null,
    pollMs: POLL_MS,
    historyCount: stream.events.length,
    control: controlDescriptor(record),
  });

  // Live control side channel: approvals and run state only. Commands,
  // messages and results are still rendered from the dsh log.
  if (controlSession) {
    for (const approval of controlSession.pendingApprovals()) sseWrite(res, 'approval', safeApproval(approval));
  }

  sseWrite(res, 'tree', await treePayload(record, stream, { showHidden: options.showHidden === true }));

  // History (everything already decoded). An optional delay is used only by
  // the demo capture to make the loading skeleton visible.
  if (HISTORY_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, HISTORY_DELAY_MS));
  for (const ev of stream.events) sseWrite(res, 'ev', ev);
  sseWrite(res, 'historyEnd', { count: stream.events.length, at: Date.now() });
  sseWrite(res, 'status', {
    ...statusFor(stream),
    state: initialState.state,
    stateDetail: redactor.text(initialState.stateDetail),
  });

  const onEvent = (e) => sseWrite(res, 'ev', e.detail);
  const onStatus = (e) => sseWrite(res, 'status', e.detail);
  const onSys = (sample) => sseWrite(res, 'sys', sample);
  const onReset = () => {
    sseWrite(res, 'reset', { at: Date.now() });
  };
  const onControl = (state) => sseWrite(res, 'control', state);
  const onApproval = (approval) => sseWrite(res, 'approval', safeApproval(approval));
  const onApprovalUpdate = (approval) => sseWrite(res, 'approval', safeApproval(approval));
  const onApprovalDone = (done) => sseWrite(res, 'approvalDone', done);
  const onControlError = (err) => sseWrite(res, 'controlError', { message: redactor.text(String(err.message || err)) });
  stream.addEventListener('event', onEvent);
  stream.addEventListener('status', onStatus);
  stream.addEventListener('reset', onReset);
  if (controlSession) {
    controlSession.on('state', onControl);
    controlSession.on('approval', onApproval);
    controlSession.on('approval-update', onApprovalUpdate);
    controlSession.on('approval-done', onApprovalDone);
    controlSession.on('error', onControlError);
  }
  sysMonitor.start(onSys);

  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(`: ping ${Date.now()}\n\n`);
  }, 20000);

  const cleanup = () => {
    clearInterval(heartbeat);
    sysMonitor.stop(onSys);
    stream.removeEventListener('event', onEvent);
    stream.removeEventListener('status', onStatus);
    stream.removeEventListener('reset', onReset);
    if (controlSession) {
      controlSession.removeListener('state', onControl);
      controlSession.removeListener('approval', onApproval);
      controlSession.removeListener('approval-update', onApprovalUpdate);
      controlSession.removeListener('approval-done', onApprovalDone);
      controlSession.removeListener('error', onControlError);
    }
    stream.refs = Math.max(0, stream.refs - 1);
    if (stream.refs === 0) {
      clearTimeout(stream.idleTimer);
      stream.idleTimer = setTimeout(() => {
        if (stream.refs === 0) {
          stream.stop();
          streams.delete(stream.__key || stream.id);
        }
      }, 30000);
    }
  };
  stream.refs++;
  if (stream.idleTimer) {
    clearTimeout(stream.idleTimer);
    stream.idleTimer = null;
  }
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ---------------------------------------------------------------------------
// Workspace file tree + read-only file access (allowlisted roots)
// ---------------------------------------------------------------------------

/** Redact display names and paths in a built tree (keys stay functional). */
function sanitizeTree(node) {
  if (!node) return node;
  if (node.private) {
    node.name = '[private]';
    node.path = '[private]';
  } else if (node.path !== undefined) {
    node.name = redactor.treeName(node.name, node.path);
    node.path = redactor.text(node.path, { path: node.path });
  }
  if (Array.isArray(node.children)) for (const child of node.children) sanitizeTree(child);
  return node;
}

/**
 * Build the workspace tree. Every node gets an opaque `key` so the page can
 * request files even when stream mode redacts the displayed names.
 */
async function treePayload(record, stream, options = {}) {
  const keyFn = (display) => {
    const key = keyFor(`${record.source}:${record.id}`, display);
    stream.keys.set(key, display);
    return key;
  };
  // Keep touched paths in the tree even if the node budget stopped short.
  const ensure = [];
  for (const ev of stream.events) {
    if (ev.t === 'call' && ev.args && typeof ev.args.file_path === 'string') ensure.push(ev.args.file_path);
    else if (ev.t === 'result' && ev.meta && typeof ev.meta.path === 'string') ensure.push(ev.meta.path);
  }
  const tree = await roots.readTree(record.cwd, keyFn, { ensure, showHidden: options.showHidden === true });
  if (tree) {
    tree.root = redactor.text(record.cwd, { path: record.cwd });
    tree.name = redactor.text(tree.name);
    sanitizeTree(tree);
  }
  return { root: tree ? tree.root : redactor.text(record.cwd), tree };
}


// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

async function handleControlOptions(res) {
  if (STREAM_MODE) {
    sendJson(res, 403, { error: 'control disabled in stream mode' });
    return;
  }
  const config = await control.config.load();
  sendJson(res, 200, {
    workspaces: config.workspaces.map((workspace) => ({
      path: workspace.path,
      label: workspace.label,
    })),
    presets: PRESETS,
    defaultPreset: DEFAULT_PRESET,
    dshProfile: config.dshProfile,
  });
}

async function handleControlPost(req, res, p) {
  if (STREAM_MODE) {
    sendJson(res, 403, { error: 'control disabled in stream mode' });
    return;
  }
  if (!authorizedControl(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    sendJson(res, 401, { error: 'missing or invalid control token' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    sendJson(res, 400, { error: String(err.message || err) });
    return;
  }
  try {
    if (p === '/api/control/session/begin') {
      const result = await control.begin({
        cwd: body.cwd,
        preset: body.preset,
        confirmDanger: body.confirmDanger === true,
      });
      sendJson(res, 200, result);
      return;
    }
    if (p === '/api/control/session/start') {
      const id = String(body.id || '');
      const message = String(body.message ?? '');
      if (!message.trim()) {
        sendJson(res, 400, { error: 'first message is required' });
        return;
      }
      if (message.length > MAX_MESSAGE) {
        sendJson(res, 413, { error: 'message is too large' });
        return;
      }
      const result = await control.startFirst(id, { model: body.model, message });
      sendJson(res, 200, result);
      return;
    }
    if (p === '/api/control/message') {
      const result = await control.message(String(body.id || ''), String(body.text ?? ''));
      sendJson(res, 200, result);
      return;
    }
    if (p === '/api/control/approval') {
      const decision = String(body.decision || '');
      const reason = body.reason === undefined || body.reason === null ? '' : String(body.reason).slice(0, 500);
      const result = await control.approval(
        String(body.id || ''),
        String(body.approvalId || ''),
        decision,
        reason,
      );
      sendJson(res, 200, result);
      return;
    }
    if (p === '/api/control/stop') {
      const result = await control.stop(String(body.id || ''));
      sendJson(res, 200, result);
      return;
    }
    if (p === '/api/control/close') {
      const result = await control.close(String(body.id || ''));
      sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, err.status || 500, { error: String(err.message || err) });
  }
}

async function serveIndex(res) {
  let html;
  try {
    html = await readPublic('index.html');
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('public/index.html is missing');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

async function serveVendor(rel, res) {
  if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('\0') || !/^[A-Za-z0-9_./-]+$/.test(rel)) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  let body;
  try {
    body = await readPublic(`vendor/${rel}`);
  } catch {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    sendJson(res, 403, { error: 'forbidden host' });
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;

  if (!ALLOW_CONTROL && p.startsWith('/api/control/')) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  if (req.method === 'POST') {
    const origin = String(req.headers.origin || '').toLowerCase();
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (origin !== `http://${host}` || type !== 'application/json') {
      sendJson(res, 403, { error: 'forbidden origin or content type' });
      return;
    }
  }

  if (req.method === 'GET' && p === '/api/control/status') {
    sendJson(res, 200, {
      enabled: true,
      streamMode: STREAM_MODE,
      locked: STREAM_MODE,
      presets: PRESETS,
      defaultPreset: DEFAULT_PRESET,
    });
    return;
  }

  if (req.method === 'POST' && p.startsWith('/api/control/')) {
    await handleControlPost(req, res, p);
    return;
  }

  if (req.method === 'POST' && p === '/api/nickname') {
    try {
      const body = await readJsonBody(req, 8 * 1024);
      const source = String(body.source || 'dsh');
      const id = String(body.id || '');
      if (!SOURCE_DEFS.some((s) => s.key === source) || !/^[A-Za-z0-9._-]{3,128}$/.test(id)) {
        sendJson(res, 400, { error: 'bad session' });
        return;
      }
      const nickname = nicknames.set(`${source}:${id}`, body.nickname);
      sendJson(res, 200, { nickname: redactor.text(nickname) });
    } catch (err) {
      sendJson(res, 400, { error: String(err.message || err) });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'read-only' });
    return;
  }

  if (p === '/api/control/options') {
    if (STREAM_MODE) {
      sendJson(res, 403, { error: 'control disabled in stream mode' });
      return;
    }
    if (!authorizedControl(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, { error: 'missing or invalid control token' });
      return;
    }
    await handleControlOptions(res);
    return;
  }

  try {
    if (p === '/' || p === '/index.html') {
      await serveIndex(res);
      return;
    }

    if (p === '/favicon.svg') {
      try {
        const icon = await readPublic('favicon.svg');
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(icon);
      } catch {
        sendJson(res, 404, { error: 'not found' });
      }
      return;
    }

    if (p.startsWith('/vendor/')) {
      await serveVendor(decodeURIComponent(p.slice('/vendor/'.length)), res);
      return;
    }

    if (p === '/api/sources') {
      sendJson(res, 200, { sources: await sourcesPayload() });
      return;
    }

    if (p === '/api/agents') {
      sendJson(res, 200, await agentsPayload());
      return;
    }
    if (p === '/api/sessions') {
      const source = url.searchParams.get('source') || 'dsh';
      try {
        rootsCfg = await roots.config();
        await redactor.setPrivateRoots(rootsCfg.privateRoots);
      } catch { /* keep previous config */ }
      const sessions = await sessionsFor(source);
      sendJson(res, 200, {
        source,
        sessions: sessions.map((s) => {
          const nick = nicknames.get(`${s.source}:${s.id}`) || s.nickname || null;
          return {
            id: s.id,
            source: s.source,
            cwd: redactor.text(s.cwd, { path: s.cwd }),
            title: redactor.text(nick || s.title),
            nickname: redactor.text(nick),
            sessionTitle: redactor.text(s.sessionTitle),
            firstUser: redactor.text(s.firstUser),
            lastUser: redactor.text(s.lastUser),
            empty: s.empty === true,
            state: s.state || (s.live ? 'live' : 'finished'),
            stateDetail: redactor.text(s.stateDetail),
            lastEventAt: s.lastEventAt || s.mtimeMs,
            steps: s.steps ?? null,
            tokens: s.tokens ?? null,
            cost: s.cost ?? null,
            model: s.model ?? null,
            provider: s.provider ?? null,
            preset: s.preset ?? null,
            policy: s.policy ?? null,
            sandbox: s.sandbox ?? null,
            owned: s.owned === true,
            subagents: s.subagents ?? null,
            createdAt: s.createdAt,
            size: s.size,
            mtimeMs: s.mtimeMs,
            live: s.state ? s.state === 'live' : s.live === true,
          };
        }),
      });
      return;
    }

    if (p === '/api/stream') {
      const source = url.searchParams.get('source') || 'dsh';
      const id = url.searchParams.get('id');
      let record = id ? await findSession(source, id) : (await sessionsFor(source))[0];
      if (!record && id && source === 'dsh' && ALLOW_CONTROL && control && control.has(id)) {
        record = await waitForSessionRecord(id, 8000);
      }
      if (!record) {
        sendJson(res, 404, { error: 'session not found' });
        return;
      }
      await serveStream(req, res, record, { showHidden: url.searchParams.get('hidden') === '1' });
      return;
    }

    if (p === '/api/tree') {
      const record = await findSession(url.searchParams.get('source') || 'dsh', url.searchParams.get('id'));
      if (!record) {
        sendJson(res, 404, { error: 'session not found' });
        return;
      }
      const stream = await getStream(record);
      sendJson(res, 200, await treePayload(record, stream, { showHidden: url.searchParams.get('hidden') === '1' }));
      return;
    }

    if (p === '/api/file') {
      const record = await findSession(url.searchParams.get('source') || 'dsh', url.searchParams.get('id'));
      if (!record) {
        sendJson(res, 404, { error: 'session not found' });
        return;
      }
      if (!record.cwd) {
        sendJson(res, 404, { error: 'session has no workspace' });
        return;
      }
      const stream = await getStream(record);
      const key = url.searchParams.get('key');
      let display;
      if (key) {
        display = stream.keys.get(key);
        if (display === undefined) {
          sendJson(res, 404, { error: 'unknown file key' });
          return;
        }
        if (display === '') {
          sendJson(res, 400, { error: 'not a file' });
          return;
        }
      } else {
        display = url.searchParams.get('path') || url.searchParams.get('file') || '';
      }
      const file = await roots.readFile(record.cwd, display, { hideSensitive: redactor.enabled });
      if (!file.hidden) file.content = redactor.fileContent(display, file.content);
      sendJson(res, 200, file);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (res.headersSent) {
      console.error(err);
      res.end();
      return;
    }
    sendJson(res, err.status || 500, { error: String(err.message || err) });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is in use; set PORT to another value`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});

function openBrowser(url) {
  try {
    const command = process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
    spawn(command.file, command.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* opening a browser is best-effort */ }
}

server.listen(PORT, HOST, () => {
  const baseUrl = `http://${HOST}:${PORT}`;
  let openUrl = baseUrl;
  console.log(`agenttail 0.2.0  ${baseUrl}`);
  console.log(`sessions         ${SESSIONS_ROOT}`);
  if (ALLOW_CONTROL) {
    if (STREAM_MODE) {
      console.log('control          disabled in stream mode');
    } else {
      openUrl = `${baseUrl}/#token=${CONTROL_TOKEN}`;
      console.log('control          enabled (token in the URL below)');
      console.log(`open             ${openUrl}`);
    }
  } else {
    console.log('control          off (start with --allow-control to enable)');
  }
  console.log('press Ctrl+C to stop');
  if (OPEN_BROWSER) setTimeout(() => openBrowser(openUrl), 250).unref();
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const s of streams.values()) s.stop();
  sysMonitor.dispose();
  try { await control?.dispose(); } catch { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });
