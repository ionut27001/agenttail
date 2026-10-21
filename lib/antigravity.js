'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { BaseStream } = require('./base-stream');
const { JsonlTail } = require('./jsonl');
const { deletionsFromCommand } = require('./deletes');
const attention = require('./attention');

const BRAIN_ROOT = () => process.env.ANTIGRAVITY_ROOT || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const TRANSCRIPT = path.join('.system_generated', 'logs', 'transcript.jsonl');
const metaCache = new Map();

function unquote(value) {
  if (typeof value !== 'string') return '';
  let t = value.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    try { t = JSON.parse(t); } catch { t = t.slice(1, -1); }
  }
  return t;
}

function requestText(content) {
  const raw = String(content || '');
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(raw);
  return (m ? m[1] : raw).trim();
}

function usageOf(entry) {
  if (entry.input_tokens === undefined && entry.output_tokens === undefined) return null;
  return {
    input: entry.input_tokens || 0,
    output: entry.output_tokens || 0,
    cacheRead: entry.cache_read_tokens || 0,
    cacheWrite: 0,
  };
}

function isBrainPath(p) {
  const n = String(p || '').replace(/\\/g, '/').toLowerCase();
  return n.includes('/.gemini/antigravity/brain');
}

function commonDir(paths) {
  if (!paths.length) return null;
  if (paths.length === 1) return paths[0];
  const split = paths.map((p) => path.resolve(p).split(path.sep));
  const first = split[0];
  let i = 0;
  while (i < first.length && split.every((parts) => parts[i] === first[i])) i++;
  const joined = first.slice(0, i).join(path.sep);
  return joined || path.parse(paths[0]).root;
}

function deriveCwd(entries) {
  const cwds = [];
  const dirs = [];
  for (const e of entries) {
    for (const call of e.tool_calls || []) {
      const args = call.args || {};
      if (args.Cwd) {
        const c = unquote(args.Cwd);
        if (c && !isBrainPath(c)) cwds.push(c);
      }
      if (args.AbsolutePath || args.TargetFile) {
        const f = unquote(args.AbsolutePath || args.TargetFile);
        if (f && !isBrainPath(f)) dirs.push(path.dirname(f));
      }
    }
  }
  if (cwds.length) return commonDir(cwds);
  if (dirs.length) return commonDir(dirs);
  return null;
}

async function readMeta(file, st) {
  const cached = metaCache.get(file);
  if (cached) return cached;
  let lines = [];
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const size = Math.min(st.size, 256 * 1024);
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      lines = buf.toString('utf8').split('\n');
    } finally {
      await fh.close();
    }
  } catch { /* ignore */ }
  const entries = [];
  let title = null;
  let createdAt = null;
  for (const line of lines.slice(0, 400)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    entries.push(e);
    if (!createdAt && e.created_at) createdAt = Date.parse(e.created_at) || null;
    if (!title && e.type === 'USER_INPUT') {
      const text = requestText(e.content).split('\n').find((l) => l.trim());
      if (text) title = text;
    }
  }
  const meta = {
    cwd: deriveCwd(entries),
    title: String(title || path.basename(path.dirname(path.dirname(path.dirname(path.dirname(file))))) || 'Antigravity conversation').slice(0, 120),
    createdAt: createdAt || st.birthtimeMs || st.mtimeMs,
  };
  metaCache.set(file, meta);
  return meta;
}

const activityCache = new Map();
const AGY_WRITE = new Set(['replace_file_content', 'write_to_file']);
const AGY_NAMES = { run_command: 'pwsh', view_file: 'read', replace_file_content: 'edit', write_to_file: 'write' };

/** Last tool call and recently written files, from the transcript tail. */
async function readActivity(file, st) {
  const cached = activityCache.get(file);
  if (cached && cached.size === st.size) return cached.value;
  let text = '';
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const start = Math.max(0, st.size - 256 * 1024);
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      await fh.close();
    }
  } catch { /* unreadable transcript: no activity */ }
  let lastTool = null;
  let lastEventAt = 0;
  const touched = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const at = Date.parse(e.created_at) || 0;
    if (at) lastEventAt = Math.max(lastEventAt, at);
    for (const call of e.tool_calls || []) {
      const args = call.args || {};
      const target = unquote(args.TargetFile || args.AbsolutePath || '');
      const label = call.name === 'run_command' ? unquote(args.CommandLine || '') : target;
      lastTool = { name: AGY_NAMES[call.name] || String(call.name || 'tool'), label: String(label || '').slice(0, 300), at };
      if (AGY_WRITE.has(call.name) && target && !isBrainPath(target)) touched.set(target, at);
    }
  }
  const value = {
    lastTool,
    lastEventAt,
    touched: [...touched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([p, at]) => ({ path: p, at })),
  };
  activityCache.set(file, { size: st.size, value });
  return value;
}

async function listSessions(ctx) {
  const root = BRAIN_ROOT();
  let dirs = [];
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = path.join(root, d.name, TRANSCRIPT);
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    if (!st.isFile()) continue;
    found.push({ file, conversation: d.name, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const rec of found.slice(0, 40)) {
    const meta = await readMeta(rec.file, rec);
    const activity = await readActivity(rec.file, rec);
    const now = Date.now();
    const lastEventAt = Math.max(activity.lastEventAt || 0, 0) || rec.mtimeMs;
    const state = now - rec.mtimeMs < 30_000 ? 'live' : now - lastEventAt < 10 * 60 * 1000 ? 'idle' : 'finished';
    out.push({
      source: 'antigravity',
      state,
      // No known signal for an open approval prompt in Antigravity's transcript.
      attention: attention.none(),
      stateDetail: state === 'live' ? 'transcript is growing' : state === 'idle' ? 'idle' : 'finished',
      lastEventAt,
      lastTool: activity.lastTool,
      touched: activity.touched,
      id: rec.conversation,
      file: rec.file,
      cwd: meta.cwd,
      title: meta.title,
      createdAt: meta.createdAt,
      size: rec.size,
      mtimeMs: rec.mtimeMs,
      live: Date.now() - rec.mtimeMs < 30_000,
    });
  }
  return out;
}

class AntigravityStream extends BaseStream {
  constructor(session, ctx) {
    super(session, ctx);
    this.tail = new JsonlTail(session.file, { onObject: (e) => this.processEntry(e) });
    this.pending = [];
    this.cwd = session.cwd || null;
  }

  async _poll() {
    const st = await this.tail.stat();
    if (!st) return;
    if (st.size > this.tail.offset) {
      this.markGrowth();
      await this.tail.readNew();
    }
    this.lastWriteAt = st.mtimeMs;
    if (this.cwd && this.cwd !== this.session.cwd) this.session.cwd = this.cwd;
    this.emitStatus();
  }

  hasPending() {
    return this.pending.length > 0;
  }

  processEntry(e) {
    const ts = Date.parse(e.created_at) || Date.now();
    if (e.type === 'USER_INPUT') {
      const text = requestText(e.content);
      if (text) this.add({ t: 'user', text, time: ts });
      return;
    }
    if (e.type === 'PLANNER_RESPONSE') {
      const usage = usageOf(e);
      const calls = e.tool_calls || [];
      const thinking = typeof e.thinking === 'string' && e.thinking.trim() ? e.thinking.slice(0, 20000) : undefined;
      if (e.content && String(e.content).trim()) {
        this.add({ t: 'say', text: e.content, thinking, usage, time: ts });
      } else if (usage || thinking) {
        this.add({ t: 'say', text: '', thinking, usage, time: ts });
      }
      for (const call of calls) this.toolCall(call, ts);
      if (calls.length) this.add({ t: 'step', time: ts });
      return;
    }
    if (e.type === 'GENERIC') {
      const pending = this.pending.shift() || null;
      const text = String(e.content || '');
      const m = /exited with code\s+(-?\d+)/i.exec(text);
      const isError = m ? Number(m[1]) !== 0 : false;
      this.add({
        t: 'result',
        callId: pending ? pending.callId : `generic-${e.step_index}`,
        text,
        isError,
        meta: pending && pending.display ? { path: pending.display, key: pending.key } : null,
        time: ts,
      });
      if (!isError && pending && pending.command) {
        for (const abs of deletionsFromCommand(pending.command, pending.cwd)) {
          const display = this.displayPath(abs) || abs;
          this.addDeleted(display, ts);
        }
      }
      return;
    }
    if (e.type === 'ERROR_MESSAGE') {
      const pending = this.pending.shift() || null;
      this.add({
        t: 'result',
        callId: pending ? pending.callId : `error-${e.step_index}`,
        text: String(e.error || 'error'),
        isError: true,
        time: ts,
      });
    }
  }

  toolCall(call, ts) {
    const args = call.args || {};
    const kind = call.name;
    const callId = `agy-${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let name = null;
    const out = {};
    let ref = null;
    if (kind === 'run_command') {
      name = 'pwsh';
      out.command = unquote(args.CommandLine);
      out.workdir = unquote(args.Cwd);
      if (out.workdir && !isBrainPath(out.workdir)) this.cwd = out.workdir;
    } else if (kind === 'view_file') {
      name = 'read';
      ref = this.fileRef(unquote(args.AbsolutePath));
    } else if (kind === 'replace_file_content') {
      name = 'edit';
      ref = this.fileRef(unquote(args.TargetFile));
      out.old_string = unquote(args.TargetContent);
      out.new_string = unquote(args.ReplacementContent);
    } else if (kind === 'write_to_file') {
      name = 'write';
      ref = this.fileRef(unquote(args.TargetFile));
      out.content = unquote(args.CodeContent);
    } else {
      return;
    }
    if (ref) {
      out.file_path = ref.path;
      out.key = ref.key;
    }
    const pending = {
      callId,
      name,
      display: out.file_path,
      key: out.key,
      command: out.command,
      cwd: out.workdir || this.cwd,
    };
    this.pending.push(pending);
    this.add({ t: 'call', callId, name, args: out, time: ts });
  }
}

function open(record, ctx) {
  return new AntigravityStream(record, ctx);
}

module.exports = {
  readActivity, listSessions, open, _readMeta: readMeta };
