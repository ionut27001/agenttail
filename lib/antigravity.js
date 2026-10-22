'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { BaseStream } = require('./base-stream');
const { JsonlTail } = require('./jsonl');
const { deletionsFromCommand } = require('./deletes');
const attention = require('./attention');
const agyStatus = require('./antigravity-status');
const tiers = require('./tiers');

/** The editor and the CLI keep conversations in separate folders; ANTIGRAVITY_ROOT names one brain folder instead. */
const BRAIN_ROOTS = () => (process.env.ANTIGRAVITY_ROOT
  ? [process.env.ANTIGRAVITY_ROOT]
  : [path.join(os.homedir(), '.gemini', 'antigravity', 'brain'), path.join(agyStatus.cliDir(), 'brain')]);

/** Same folder? Windows paths compare without case. */
function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
const TRANSCRIPT = path.join('.system_generated', 'logs', 'transcript.jsonl');
const FULL_TRANSCRIPT = 'transcript_full.jsonl';
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
  return /\/\.gemini\/antigravity(?:-cli)?\/brain/.test(n);
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

/** The calls of a planner response; a field cut short in the transcript can leave something else behind. */
function toolCallsOf(e) {
  return Array.isArray(e.tool_calls) ? e.tool_calls.filter((c) => c && typeof c === 'object') : [];
}

function deriveCwd(entries) {
  const cwds = [];
  const dirs = [];
  for (const e of entries) {
    for (const call of toolCallsOf(e)) {
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
const AGY_WRITE = new Set(['replace_file_content', 'multi_replace_file_content', 'write_to_file']);
/** Antigravity's tools under the names the page already knows; any other tool keeps its own name. */
const AGY_NAMES = {
  run_command: 'pwsh',
  view_file: 'read',
  replace_file_content: 'edit',
  multi_replace_file_content: 'multi_edit',
  write_to_file: 'write',
  grep_search: 'grep',
  find_by_name: 'glob',
  list_dir: 'list_dir',
  read_url_content: 'web_fetch',
  search_web: 'web_search',
  command_status: 'job_output',
  send_command_input: 'job_input',
  invoke_subagent: 'agent',
  manage_task: 'task',
};
const SUMMARY_KEYS = ['Query', 'query', 'Pattern', 'Url', 'URL', 'TaskName', 'Task', 'Description', 'Prompt', 'Name', 'DirectoryPath', 'SearchPath'];

/** One short line of a tool argument: unquoted, on one line, cut. */
function brief(value, max = 160) {
  const t = unquote(typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * A line about an unmapped tool's arguments, never the whole dump: a known
 * descriptive argument (a query, a URL, a task name), otherwise only the names
 * of the arguments, since an unknown one may hold typed text or a secret.
 */
function genericSummary(args) {
  for (const key of SUMMARY_KEYS) {
    const v = brief(args[key]);
    if (v) return v;
  }
  const names = Object.keys(args).filter((k) => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)).slice(0, 6);
  return names.length ? `args: ${names.join(', ')}` : '';
}

/**
 * The page name and a short description for the tools that are not file or
 * command tools; commandOf(id) names the command a status or input call asks about.
 */
function describeCall(call, commandOf) {
  const a = call.args && typeof call.args === 'object' ? call.args : {};
  const raw = String(call.name || 'tool');
  const name = AGY_NAMES[raw] || raw;
  const args = {};
  if (raw === 'grep_search') {
    args.pattern = brief(a.Query);
    args.description = brief(a.SearchPath);
  } else if (raw === 'find_by_name') {
    args.pattern = brief(a.Pattern);
    args.description = brief(a.SearchDirectory);
  } else if (raw === 'list_dir') {
    args.description = brief(a.DirectoryPath);
  } else if (raw === 'read_url_content') {
    args.description = brief(a.Url);
  } else if (raw === 'search_web') {
    args.pattern = brief(a.query !== undefined ? a.query : a.Query);
  } else if (raw === 'command_status' || raw === 'send_command_input') {
    const id = brief(a.CommandId, 80);
    const command = commandOf ? commandOf(id) : '';
    const input = raw === 'send_command_input' && typeof a.Input === 'string' ? `${unquote(a.Input).length} characters to ` : '';
    args.description = `${raw === 'command_status' ? 'status of ' : 'input: '}${input}${brief(command || id)}`.trim();
  } else if (!AGY_NAMES[raw] || raw === 'invoke_subagent' || raw === 'manage_task') {
    args.description = genericSummary(a);
  }
  for (const key of Object.keys(args)) if (!args[key]) delete args[key];
  return { name, args };
}

/** The error of a step as text: a string, or an object with a message. */
function errorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  try { return JSON.stringify(error).slice(0, 500); } catch { return ''; }
}

/** The id of a command that keeps running, as far as its result text names one. */
function commandIdOf(text) {
  const m = /command id\W+([\w-]{4,})/i.exec(String(text || ''));
  return m ? m[1] : '';
}

/**
 * Results belong to the calls of the planner response before them, in order.
 * A result is only ever paired inside that response, so one call that never
 * answers cannot shift every later pairing.
 */
class CallPairs {
  constructor() {
    this.group = { step: null, calls: [], next: 0 };
    this.commands = new Map();
  }

  plan(step, calls) {
    this.group = { step: Number.isInteger(step) ? step : null, calls, next: 0 };
  }

  /** The next unanswered call of the current response for a result at this step, or null. */
  claim(step) {
    const g = this.group;
    if (g.next >= g.calls.length) return null;
    if (g.step !== null && Number.isInteger(step) && step <= g.step) return null;
    return g.calls[g.next++];
  }

  open() {
    return this.group.calls.length - this.group.next;
  }

  /** Remember which command a long-running result names, for later status and input calls. */
  rememberCommand(call, text) {
    const id = call && call.command ? commandIdOf(text) : '';
    if (!id) return;
    this.commands.set(id, call.command);
    if (this.commands.size > 200) this.commands.delete(this.commands.keys().next().value);
  }

  commandOf(id) {
    return this.commands.get(id) || '';
  }
}

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
  let maxStep = -1;
  const pairs = new CallPairs();
  const touched = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const at = Date.parse(e.created_at) || 0;
    if (at) lastEventAt = Math.max(lastEventAt, at);
    if (Number.isInteger(e.step_index)) maxStep = Math.max(maxStep, e.step_index);
    if (e.type === 'PLANNER_RESPONSE') {
      const calls = toolCallsOf(e);
      pairs.plan(e.step_index, calls.map((call) => ({ command: call.name === 'run_command' ? unquote((call.args || {}).CommandLine) : '' })));
      for (const call of calls) {
        const args = call.args && typeof call.args === 'object' ? call.args : {};
        const target = unquote(args.TargetFile || args.AbsolutePath || '');
        let label = target;
        if (call.name === 'run_command') label = unquote(args.CommandLine || '');
        else if (!target) {
          const d = describeCall(call, (id) => pairs.commandOf(id));
          label = d.args.pattern || d.args.description || '';
        }
        lastTool = { name: AGY_NAMES[call.name] || String(call.name || 'tool'), label: String(label || '').slice(0, 300), at };
        if (AGY_WRITE.has(call.name) && target && !isBrainPath(target)) touched.set(target, at);
      }
    } else if (e.type === 'GENERIC' || e.type === 'ERROR_MESSAGE') {
      const pending = pairs.claim(e.step_index);
      if (e.type === 'GENERIC') pairs.rememberCommand(pending, e.content);
    } else if (e.type === 'USER_INPUT') {
      pairs.plan(null, []);
    }
  }
  const value = {
    lastTool,
    lastEventAt,
    maxStep,
    touched: [...touched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([p, at]) => ({ path: p, at })),
  };
  activityCache.set(file, { size: st.size, value });
  return value;
}

/**
 * How much the conversation's agent may do without asking. A CLI conversation
 * has the settings of the process that served it (from its log, if that is still
 * on disk); an editor conversation has only the editor's settings file, which
 * says what is configured, not what the conversation did.
 */
async function permissionFor(cli, conversation) {
  if (cli) {
    let served = new Map();
    try { served = await agyStatus.readPermissions(); } catch { /* no log: no reading */ }
    const facts = served.get(String(conversation).toLowerCase());
    return facts ? tiers.fromAgyCli(facts) : tiers.unknown();
  }
  let settings = null;
  try { settings = await agyStatus.readEditorSettings(); } catch { settings = null; }
  return settings ? tiers.fromAgyEditor(settings) : tiers.unknown();
}

async function listSessions(ctx) {
  const found = [];
  const seen = new Set();
  const cli = agyStatus.cliDir();
  let cliLogs = false;
  try { cliLogs = (await fsp.stat(path.join(cli, 'log'))).isDirectory(); } catch { cliLogs = false; }
  for (const root of BRAIN_ROOTS()) {
    // Only the CLI logs its approval prompts; the editor's stay invisible. The
    // default folders and ANTIGRAVITY_CLI_DIR name the CLI's folder outright; with
    // ANTIGRAVITY_ROOT alone the CLI folder is only inferred as its parent, so it
    // counts as the CLI's when the CLI's log folder sits there, and a root pointed
    // at the editor's brain still reads as the editor.
    const inferred = !!process.env.ANTIGRAVITY_ROOT && !process.env.ANTIGRAVITY_CLI_DIR;
    const isCli = samePath(path.dirname(root), cli) && (!inferred || cliLogs);
    const promptsVisible = cliLogs && isCli;
    let dirs = [];
    try {
      dirs = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || seen.has(d.name)) continue;
      const file = path.join(root, d.name, TRANSCRIPT);
      let st;
      try { st = await fsp.stat(file); } catch { continue; }
      if (!st.isFile()) continue;
      seen.add(d.name);
      found.push({ file, conversation: d.name, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, promptsVisible, isCli });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let prompts = new Map();
  try { prompts = await agyStatus.readPrompts(); } catch { /* no log: no prompts */ }
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
      // The transcript shows no open prompt; the CLI log does (lib/antigravity-status.js).
      attention: attention.antigravityAttention({ prompt: prompts.get(rec.conversation.toLowerCase()) || null, maxStep: activity.maxStep }),
      promptsVisible: rec.promptsVisible,
      isCli: rec.isCli,
      permission: await permissionFor(rec.isCli, rec.conversation),
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

/**
 * Byte offset just past the first `count` non-empty lines of a file (the lines
 * JsonlTail hands on), or null when the file has fewer. Bounded memory.
 */
async function offsetAfterLines(file, count) {
  if (count <= 0) return 0;
  let fh;
  try { fh = await fsp.open(file, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    let seen = 0;
    let content = false;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) return null;
      for (let i = 0; i < bytesRead; i++) {
        const b = buf[i];
        if (b === 0x0a) {
          if (content && ++seen === count) return pos + i + 1;
          content = false;
        } else if (b !== 0x20 && b !== 0x09 && b !== 0x0d) {
          content = true;
        }
      }
      pos += bytesRead;
    }
  } finally {
    await fh.close().catch(() => {});
  }
}

class AntigravityStream extends BaseStream {
  constructor(session, ctx) {
    super(session, ctx);
    this.linesRead = 0;
    this.tail = this.tailOf(session.file);
    this.pairs = new CallPairs();
    this.cwd = session.cwd || null;
    this.maxStep = -1;
    this.prompt = null;
    this.permission = session.permission || tiers.unknown();
  }

  /** The reading for the page; the list's, refreshed on every poll. */
  permissionNow() {
    return this.permission;
  }

  tailOf(file) {
    return new JsonlTail(file, { onLine: () => { this.linesRead++; }, onObject: (e) => this.processEntry(e) });
  }

  /**
   * transcript.jsonl cuts long fields at about 4 KB and says so;
   * transcript_full.jsonl next to it has the same lines whole. Switch to it
   * as soon as it keeps up with the cut one (it may appear or lag later than
   * the stream opens), resuming after the lines already read.
   */
  async chooseFile() {
    const full = path.join(path.dirname(this.session.file), FULL_TRANSCRIPT);
    if (this.tail.file === full) return;
    let cut;
    let whole;
    try { [cut, whole] = await Promise.all([fsp.stat(this.session.file), fsp.stat(full)]); } catch { return; }
    if (!whole.isFile() || whole.size < cut.size) return;
    const offset = await offsetAfterLines(full, this.linesRead);
    if (offset === null) return;
    const tail = this.tailOf(full);
    tail.offset = offset;
    this.tail = tail;
  }

  async _poll() {
    await this.chooseFile();
    const st = await this.tail.stat();
    if (!st) return;
    if (st.size > this.tail.offset) {
      this.markGrowth();
      await this.tail.readNew();
    }
    this.lastWriteAt = st.mtimeMs;
    if (this.cwd && this.cwd !== this.session.cwd) this.session.cwd = this.cwd;
    try { this.prompt = (await agyStatus.readPrompts()).get(String(this.session.id).toLowerCase()) || null; } catch { this.prompt = null; }
    this.permission = await permissionFor(this.session.isCli, this.session.id);
    this.emitStatus();
  }

  hasPending() {
    return this.pairs.open() > 0;
  }

  /** The same record as the session list, so an open pane never clears the badge. */
  attentionNow() {
    return attention.antigravityAttention({ prompt: this.prompt, maxStep: this.maxStep });
  }

  processEntry(e) {
    const ts = Date.parse(e.created_at) || Date.now();
    if (Number.isInteger(e.step_index)) this.maxStep = Math.max(this.maxStep, e.step_index);
    if (e.type === 'USER_INPUT') {
      this.pairs.plan(null, []);
      const text = requestText(e.content);
      if (text) this.add({ t: 'user', text, time: ts });
      return;
    }
    if (e.type === 'PLANNER_RESPONSE') {
      const usage = usageOf(e);
      const calls = toolCallsOf(e);
      const thinking = typeof e.thinking === 'string' && e.thinking.trim() ? e.thinking.slice(0, 20000) : undefined;
      if (e.content && String(e.content).trim()) {
        this.add({ t: 'say', text: e.content, thinking, usage, time: ts });
      } else if (usage || thinking) {
        this.add({ t: 'say', text: '', thinking, usage, time: ts });
      }
      this.pairs.plan(e.step_index, calls.map((call, i) => this.toolCall(call, ts, e.step_index, i)));
      if (calls.length) this.add({ t: 'step', time: ts });
      return;
    }
    if (e.type === 'GENERIC') {
      const pending = this.pairs.claim(e.step_index);
      const why = errorText(e.error);
      let text = String(e.content || '');
      if (why && !text.includes(why)) text = text ? `${text}\n${why}` : why;
      const m = /exited with code\s+(-?\d+)/i.exec(text);
      const failed = e.status === 'ERROR' || !!why || (m ? Number(m[1]) !== 0 : false);
      // A step still RUNNING is written once and never again: what it holds is partial.
      const running = e.status === 'RUNNING' && !failed;
      // A tool-level refusal, not a command that printed "permission denied".
      const denied = failed && /\b(denied|permission)\b/i.test(why || (e.status === 'ERROR' && !m ? text : ''));
      this.pairs.rememberCommand(pending, text);
      this.add({
        t: 'result',
        callId: pending ? pending.callId : `generic-${e.step_index}`,
        text,
        isError: failed,
        ...(running ? { running: true } : {}),
        ...(denied ? { denied: true } : {}),
        meta: pending && pending.display ? { path: pending.display, key: pending.key } : null,
        time: ts,
      });
      if (!failed && !running && pending && pending.command) {
        for (const abs of deletionsFromCommand(pending.command, pending.cwd)) {
          const display = this.displayPath(abs) || abs;
          this.addDeleted(display, ts);
        }
      }
      return;
    }
    if (e.type === 'ERROR_MESSAGE') {
      const pending = this.pairs.claim(e.step_index);
      this.add({
        t: 'result',
        callId: pending ? pending.callId : `error-${e.step_index}`,
        text: errorText(e.error) || 'error',
        isError: true,
        time: ts,
      });
    }
  }

  /** Every call of a planner response gets an event and a pending entry, mapped or not. */
  toolCall(call, ts, step, index) {
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const kind = call.name;
    const callId = `agy-${Number.isInteger(step) ? step : ts.toString(36)}-${index}`;
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
    } else if (kind === 'multi_replace_file_content') {
      name = 'multi_edit';
      ref = this.fileRef(unquote(args.TargetFile));
    } else if (kind === 'write_to_file') {
      name = 'write';
      ref = this.fileRef(unquote(args.TargetFile));
      out.content = unquote(args.CodeContent);
    } else {
      const d = describeCall(call, (id) => this.pairs.commandOf(id));
      name = d.name;
      Object.assign(out, d.args);
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
    this.add({ t: 'call', callId, name, args: out, time: ts });
    return pending;
  }
}

function open(record, ctx) {
  return new AntigravityStream(record, ctx);
}

module.exports = {
  readActivity, listSessions, open, _readMeta: readMeta };
