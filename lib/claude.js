'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { BaseStream } = require('./base-stream');
const { JsonlTail } = require('./jsonl');
const { deletionsFromCommand } = require('./deletes');
const { LiveTracker, ago } = require('./live');

const PROJECTS_ROOT = () => process.env.CLAUDE_PROJECTS_ROOT || path.join(os.homedir(), '.claude', 'projects');
const TOOL_MAP = { Bash: 'pwsh', PowerShell: 'pwsh', Edit: 'edit', Write: 'write', Read: 'read' };
const metaCache = new Map();
const claudeTracker = new LiveTracker();
const claudeGrowth = new Map();

function isInjectedUserText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (s.startsWith('<')) return true;
  return /system-reminder|runtime context|Time sampled while preparing|approval policy changed|environment_context/i.test(s);
}

function mapUsage(u) {
  if (!u) return null;
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
  };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

async function readChunk(file, start, length) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }
}

async function readMeta(file, st) {
  const cached = metaCache.get(file);
  if (cached) return cached;
  // Titles and agent names are often appended at the end of long transcripts,
  // so scan the head for cwd/createdAt and the tail for titles as well.
  let headText = '';
  let tailText = '';
  try {
    headText = await readChunk(file, 0, Math.min(st.size, 256 * 1024));
    if (st.size > 256 * 1024) {
      const start = Math.max(0, st.size - 256 * 1024);
      tailText = await readChunk(file, start, st.size - start);
      const nl = tailText.indexOf('\n');
      tailText = nl >= 0 ? tailText.slice(nl + 1) : tailText;
    }
  } catch {
    /* ignore */
  }
  let cwd = null;
  let customTitle = null;
  let agentName = null;
  let lastPrompt = null;
  let firstUser = null;
  let createdAt = null;
  let lastEventAt = 0;
  let sessionId = path.basename(file, '.jsonl');
  const uses = new Set();
  const results = new Set();

  const scan = (text) => {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
      if (ts) lastEventAt = Math.max(lastEventAt, ts);
      if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
      if (!createdAt && e.timestamp) createdAt = ts || null;
      if (e.sessionId) sessionId = e.sessionId;
      if (e.type === 'custom-title' && e.customTitle) customTitle = e.customTitle;
      if (e.type === 'agent-name' && e.agentName) agentName = e.agentName;
      if (e.type === 'last-prompt' && e.lastPrompt) lastPrompt = e.lastPrompt;
      if (Array.isArray(e.message?.content)) {
        for (const b of e.message.content) {
          if (b?.type === 'tool_use' && b.id) uses.add(b.id);
          if (b?.type === 'tool_result' && b.tool_use_id) results.add(b.tool_use_id);
        }
      }
      if (!firstUser && e.type === 'user' && typeof e.message?.content === 'string') {
        const text2 = e.message.content.trim();
        if (text2 && !text2.startsWith('<')) firstUser = text2;
      }
    }
  };
  scan(headText);
  scan(tailText);

  // The session folder holds the canonical title and the subagent list.
  const folder = path.join(path.dirname(file), path.basename(file, '.jsonl'));
  let subagents = 0;
  try {
    const titleFile = path.join(folder, 'custom-title.json');
    if (fs.existsSync(titleFile)) {
      const t = JSON.parse(fs.readFileSync(titleFile, 'utf8'));
      if (t && typeof t.customTitle === 'string' && t.customTitle.trim()) customTitle = t.customTitle.trim();
    }
  } catch { /* ignore */ }
  try {
    subagents = fs.readdirSync(path.join(folder, 'subagents')).filter((f) => f.endsWith('.jsonl')).length;
  } catch { /* no subagents */ }

  const title = customTitle || agentName || lastPrompt || firstUser || path.basename(file, '.jsonl');
  const meta = {
    id: sessionId,
    cwd: cwd || null,
    title: String(title).replace(/\s+/g, ' ').slice(0, 120),
    createdAt: createdAt || st.birthtimeMs || st.mtimeMs,
    lastEventAt: lastEventAt || st.mtimeMs,
    pending: [...uses].filter((id) => !results.has(id)).length,
    subagents,
    firstUser: firstUser ? String(firstUser).replace(/\s+/g, ' ').slice(0, 400) : null,
  };
  metaCache.set(file, meta);
  return meta;
}

async function listSessions(ctx) {
  const root = PROJECTS_ROOT();
  let projects = [];
  try {
    projects = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(root, project.name);
    let files = [];
    try {
      files = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, f.name);
      let st;
      try { st = await fsp.stat(file); } catch { continue; }
      found.push({ file, project: project.name, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const rec of found.slice(0, 60)) {
    const meta = await readMeta(rec.file, rec);
    const growth = claudeGrowth.get(rec.file);
    const grew = !!growth && rec.size !== growth.size;
    claudeGrowth.set(rec.file, { size: rec.size, at: grew ? Date.now() : (growth?.at || 0) });
    const lastGrowth = claudeGrowth.get(rec.file).at;
    const now = Date.now();
    const rawState = meta.pending > 0 || now - lastGrowth < 60_000
      ? 'live'
      : now - (meta.lastEventAt || rec.mtimeMs) < 10 * 60 * 1000 ? 'idle' : 'finished';
    const state = claudeTracker.update(`claude:${meta.id}`, rawState);
    const last = meta.lastEventAt ? `${ago(now - meta.lastEventAt)} ago` : 'no events yet';
    const stateDetail = meta.pending > 0
      ? `open tool call, last event ${last}`
      : rawState === 'live'
        ? `receiving output, last event ${last}`
        : rawState === 'idle'
          ? `idle since ${last}`
          : `last event ${last}`;
    out.push({
      source: 'claude',
      id: meta.id,
      file: rec.file,
      project: rec.project,
      cwd: meta.cwd,
      title: meta.title,
      firstUser: meta.firstUser,
      empty: false,
      createdAt: meta.createdAt,
      size: rec.size,
      mtimeMs: rec.mtimeMs,
      lastEventAt: meta.lastEventAt,
      subagents: meta.subagents,
      state,
      stateDetail,
      live: state === 'live',
    });
  }
  return out;
}

class ClaudeStream extends BaseStream {
  constructor(session, ctx) {
    super(session, ctx);
    this.files = [];
    this.pending = new Map();
    this.discovered = false;
    this.subDir = path.join(path.dirname(session.file), session.id, 'subagents');
  }

  async _discover() {
    if (!this.files.some((f) => f.main)) {
      const tail = new JsonlTail(this.session.file);
      // Very large transcripts: read the last 24 MiB instead of tens of MiB of
      // history on first attach. Live lines after that are still streamed.
      const st = await tail.stat();
      if (st && st.size > 24 * 1024 * 1024) tail.offset = st.size - 24 * 1024 * 1024;
      this.files.push({ file: this.session.file, tail, main: true, key: 'main' });
    }
    let subs = [];
    try {
      subs = await fsp.readdir(this.subDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const s of subs) {
      if (!s.isFile() || !s.name.endsWith('.jsonl')) continue;
      const file = path.join(this.subDir, s.name);
      if (this.files.some((f) => f.file === file)) continue;
      this.files.push({
        file,
        tail: new JsonlTail(file, { onObject: (e) => this.processEntry(e, s.name.replace(/\.jsonl$/, '')) }),
        key: s.name.replace(/\.jsonl$/, ''),
      });
    }
  }

  async _poll() {
    await this._discover();
    let latest = this.lastWriteAt;
    for (const f of this.files) {
      const st = await f.tail.stat();
      if (!st) continue;
      latest = Math.max(latest, st.mtimeMs);
      if (st.size > f.tail.offset) {
        this.markGrowth();
        if (f.main) {
          f.tail.onObject = (e) => this.processEntry(e, null);
          await f.tail.readNew();
        } else {
          await f.tail.readNew();
        }
      } else if (f.main) {
        f.tail.onObject = (e) => this.processEntry(e, null);
      }
    }
    this.lastWriteAt = latest;
    this.emitStatus();
  }

  hasPending() {
    return this.pending.size > 0;
  }

  processEntry(e, agent) {
    const ts = Date.parse(e.timestamp) || Date.now();
    if (e.type === 'assistant') {
      this.add({ t: 'step', time: ts, agent });
      const content = e.message?.content;
      const usage = mapUsage(e.message?.usage);
      const texts = [];
      const toolBlocks = [];
      let thinking = '';
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text);
        else if ((b.type === 'thinking' || b.type === 'redacted_thinking') && typeof b.thinking === 'string' && b.thinking.trim()) {
          thinking += (thinking ? '\n\n' : '') + b.thinking;
        } else if (b.type === 'tool_use') {
          toolBlocks.push(b);
        }
      }
      const text = texts.join('\n');
      if (text || thinking || usage) {
        this.add({
          t: 'say',
          text,
          thinking: thinking ? thinking.slice(0, 20000) : undefined,
          usage,
          time: ts,
          agent,
        });
      }
      for (const b of toolBlocks) this.toolCall(b, e, agent, ts);
      return;
    }
    if (e.type === 'user') {
      const content = e.message?.content;
      if (typeof content === 'string') {
        if (content.trim()) {
          const system = isInjectedUserText(content);
          this.add({ t: 'user', text: content, system, systemLabel: system ? '⟐ system' : null, time: ts, agent });
        }
        return;
      }
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'tool_result') this.toolResult(b, e, agent, ts);
        else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const system = isInjectedUserText(b.text);
          this.add({ t: 'user', text: b.text, system, systemLabel: system ? '⟐ system' : null, time: ts, agent });
        }
      }
    }
  }

  toolCall(block, entry, agent, ts) {
    const name = TOOL_MAP[block.name];
    if (!name) return;
    const input = block.input || {};
    const args = {};
    let ref = null;
    if (name === 'pwsh') {
      args.command = String(input.command || '');
      args.description = input.description ? String(input.description) : '';
      args.workdir = entry.cwd || this.session.cwd || '';
    } else {
      ref = this.fileRef(input.file_path);
      if (ref) {
        args.file_path = ref.path;
        args.key = ref.key;
      }
      if (name === 'edit') {
        args.old_string = String(input.old_string ?? '');
        args.new_string = String(input.new_string ?? '');
      } else if (name === 'write') {
        args.content = String(input.content ?? '');
      }
    }
    this.pending.set(block.id, {
      name,
      args,
      display: args.file_path,
      key: args.key,
      command: args.command,
      cwd: entry.cwd || this.session.cwd,
    });
    this.add({ t: 'call', callId: block.id, name, args, time: ts, agent });
  }

  toolResult(block, entry, agent, ts) {
    const pending = this.pending.get(block.tool_use_id);
    if (pending) this.pending.delete(block.tool_use_id);
    let text = textOf(block.content);
    const tr = entry.toolUseResult;
    if (!text) {
      if (typeof tr === 'string') text = tr;
      else if (Array.isArray(tr)) text = textOf(tr);
      else if (tr && typeof tr === 'object') text = [tr.stdout, tr.stderr].filter(Boolean).join('\n');
    }
    const isError = !!block.is_error || !!(tr && tr.interrupted);
    this.add({
      t: 'result',
      callId: block.tool_use_id,
      text,
      isError,
      meta: pending && pending.display ? { path: pending.display, key: pending.key } : null,
      time: ts,
      agent,
    });
    if (!isError && pending && pending.command) {
      for (const abs of deletionsFromCommand(pending.command, pending.cwd)) {
        const display = this.displayPath(abs) || abs;
        this.addDeleted(display, ts);
      }
    }
  }
}

function open(record, ctx) {
  return new ClaudeStream(record, ctx);
}

module.exports = { listSessions, open, _readMeta: readMeta };
