'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { isSensitiveName } = require('./roots');

const BLOCK = '▓';
const SCENE_RE = /\b[A-Za-z0-9]{2,12}-[A-Za-z0-9][A-Za-z0-9._-]{4,}\.(?:rar|zip|7z|iso|mkv|mp4|avi|flac|m4a|epub|pdf)\b/gi;

const blocks = (n) => BLOCK.repeat(Math.max(1, n));

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPrivatePathSync(p, privateRoots) {
  if (!p) return false;
  const norm = path.resolve(String(p)).toLowerCase();
  for (const root of privateRoots || []) {
    const r = path.resolve(root).toLowerCase();
    if (norm === r || norm.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) return true;
  }
  SCENE_RE.lastIndex = 0;
  return SCENE_RE.test(String(p));
}

// Same-length block replacement helpers.
function redactMatches(text, re, replacer) {
  return text.replace(re, (...args) => {
    const match = args[0];
    try {
      const out = replacer(...args);
      return out === undefined || out === null ? blocks(match.length) : out;
    } catch {
      return blocks(match.length);
    }
  });
}

/** Keeps names, redacts values, for env / printenv / set / Get-ChildItem env:. */
function redactEnvDump(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      const eq = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line);
      if (eq) return eq[1] + eq[2] + eq[3] + blocks(eq[4].length);
      const table = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s{2,})(\S.*)$/.exec(line);
      if (table) return table[1] + table[2] + table[3] + blocks(table[4].length);
      return line;
    })
    .join('\n');
}

function isAbsolutePath(value) {
  return typeof value === 'string' && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value);
}

/**
 * Keys whose string values reach the page verbatim. Every other string in an
 * event or a response goes through text(), so a field added to a projection
 * later is hidden until someone decides it is safe. The list is kept short on
 * purpose: a key belongs here only when the page matches on its value (or the
 * value is one of the page's own words) and none of it is user data. Names the
 * logs define (models, providers, presets, tool names) are not on it: text()
 * leaves ordinary ones alone, and a name with an address or an id in it is
 * redacted like any other string.
 *
 *   t, type              event kind and tree node kind ("call", "dir"), what the page switches on
 *   seq, time, at        ordering and timestamps (numbers; a string form must still sort)
 *   id, callId,          identifiers the page joins events and sessions by and sends back
 *   toolCallId, jobId,   (session, call, job, approval); UUID-shaped, so text() would block
 *   approvalId, key      them out and break the match. "key" is the opaque file handle.
 *   kind, state, level,  closed vocabularies the page switches on: job kind, session state,
 *   via, certainty,      attention record, file operation
 *   operation
 *
 * A kept value must still look like a token (see KEEP_SHAPE), else it is redacted.
 */
const PROTOCOL_KEYS = [
  't', 'type', 'seq', 'time', 'at',
  'id', 'callId', 'toolCallId', 'jobId', 'approvalId', 'key',
  'kind', 'state', 'level', 'via', 'certainty', 'operation',
];

/** Added for events. */
const EVENT_KEYS = [
  'agent', // a subagent transcript's file name (an id), shown as "↳ agent-x"
];

/** Added for session records, status, meta and files. */
const RECORD_KEYS = [
  'reason', // attention reason ("permission"), or why a file is hidden ("private")
  'agents', // ids of the agents that overlap on a file
];

const EVENT_KEEP = new Set([...PROTOCOL_KEYS, ...EVENT_KEYS]);
const NO_KEYS = new Set();
// A kept value is a token: ids, enum words, hashes. A sentence, a path, an
// address or an email under a protocol key is redacted like anything else.
const KEEP_SHAPE = /^[\w.:-]{0,200}$/;
// Field names are code identifiers; anything else (a path or an email used as
// a map key) is data and is redacted too.
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DEPTH = 24;
const MAX_NODES = 200_000;
const MAX_EVENT_NODES = 5_000;
const TRUNCATED = '[truncated]';

class Redactor {
  constructor({ configPath, enabled = true } = {}) {
    this.configPath = configPath || path.join(__dirname, '..', 'redact.json');
    this.enabled = enabled;
    this.literals = [];
    this.patterns = [];
    this.mtimeMs = -1;
    this.lastCheck = 0;
    this.privateRoots = [];
    this.identities = [];
    this.refresh(true);
    let account = '';
    try { account = os.userInfo().username; } catch { account = ''; }
    const envNames = [process.env.COMPUTERNAME, process.env.USERNAME, process.env.USERDOMAIN,
      process.env.USER, process.env.LOGNAME, process.env.HOSTNAME, account, os.hostname()]
      .filter((v) => v && v.length >= 3 && v !== 'root');
    this.identities = [...new Set(envNames)].map((v) => new RegExp(`\\b${escapeRe(v)}\\b`, 'gi'));
  }

  async setPrivateRoots(list) {
    this.privateRoots = (Array.isArray(list) ? list : []).slice();
  }

  /** Reload redact.json when it changes (checked at most once a second). */
  refresh(force = false) {
    if (!this.enabled) return;
    const now = Date.now();
    if (!force && now - this.lastCheck < 1000) return;
    this.lastCheck = now;
    let st;
    try {
      st = fs.statSync(this.configPath);
    } catch {
      this.literals = [];
      this.patterns = [];
      this.mtimeMs = -1;
      return;
    }
    if (!force && st.mtimeMs === this.mtimeMs) return;
    this.mtimeMs = st.mtimeMs;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch {
      // A broken config (or one caught mid-save) must not fail open: keep the
      // literals and patterns already loaded until it parses again.
      return;
    }
    this.literals = (Array.isArray(raw.literals) ? raw.literals : []).filter((s) => typeof s === 'string' && s.length > 0);
    // One bad pattern is skipped on its own; it does not cost the others.
    this.patterns = (Array.isArray(raw.patterns) ? raw.patterns : [])
      .map((p) => {
        try {
          if (typeof p === 'string') return new RegExp(p, 'g');
          if (p && typeof p.regex === 'string') return new RegExp(p.regex, p.flags || 'g');
        } catch { /* invalid pattern */ }
        return null;
      })
      .filter(Boolean);
  }

  isPrivate(p) {
    return isPrivatePathSync(p, this.privateRoots);
  }

  isSensitiveFile(p) {
    return isSensitiveName(p);
  }

  /**
   * Redact one string. `opts.envDump` keeps environment variable names,
   * `opts.path` marks a file path whose contents are being redacted.
   */
  text(value, opts = {}) {
    if (!this.enabled) return value;
    if (value === null || value === undefined) return value;
    let s = String(value);
    if (!s) return s;
    this.refresh();

    if (opts.path && this.isPrivate(opts.path)) return '[private]';

    // Private roots and scene release names, whole path or token.
    for (const root of this.privateRoots) {
      const re = new RegExp(`${escapeRe(root)}[^\\s"'<>|,;)]*`, 'gi');
      s = redactMatches(s, re, () => '[private]');
    }
    SCENE_RE.lastIndex = 0;
    s = redactMatches(s, SCENE_RE, () => '[private]');

    // User-supplied literals and regexes from redact.json.
    for (const lit of this.literals) {
      s = s.split(lit).join(blocks(lit.length));
    }
    for (const re of this.patterns) {
      re.lastIndex = 0;
      s = redactMatches(s, re, () => undefined);
    }

    if (opts.envDump) s = redactEnvDump(s);

    // --- secrets -----------------------------------------------------------
    s = redactMatches(s, /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi);
    s = redactMatches(s, /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g);
    s = redactMatches(s, /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/g);
    s = redactMatches(s, /\bs[k]-[A-Za-z0-9_-]{12,}\b/g);
    s = redactMatches(s, /\bAKIA[0-9A-Z]{16}\b/g);
    s = redactMatches(s, /\b(Bearer)\s+([A-Za-z0-9\-._~+/]+=*)/gi, (m, word, token) => `${word} ${blocks(token.length)}`);
    s = redactMatches(s, /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
      (m, scheme, user, pass) => `${scheme}${blocks(user.length)}:${blocks(pass.length)}@`);
    s = redactMatches(
      s,
      /\b(["']?)(token|key|secret|password|passwd|apikey|api_key|auth)(["']?)(\s*[:=]\s*)(["']?)([^\s"'&,;}]+)/gi,
      (m, q1, name, q2, sep, q3, value) => `${q1}${name}${q2}${sep}${q3}${blocks(value.length)}`,
    );

    // --- identity ----------------------------------------------------------
    s = redactMatches(s, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g);
    s = redactMatches(s, /([A-Za-z]:[\\/]+Users[\\/]+|[\\/]c[\\/]+Users[\\/]+|[\\/]Users[\\/]+|(?:^|(?<=[\s"'=(:]))[\\/]home[\\/]+)([^\\/\s"'<>|]+)/gi,
      (m, prefix, name) => prefix + blocks(name.length));
    for (const re of this.identities) {
      re.lastIndex = 0;
      s = redactMatches(s, re, () => undefined);
    }
    s = redactMatches(s, /\bS-1-5-21(?:-\d{1,10}){2,}\b/g);

    // --- opaque ids --------------------------------------------------------
    s = redactMatches(s, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi);
    s = redactMatches(s, /\b(?:call|toolu|msg|req)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}\b/gi);
    s = redactMatches(s, /\bpwsh-[0-9a-f]{6,}\b/gi);

    // --- network -----------------------------------------------------------
    // Boundaries keep version strings (v1.2.3.4) and C++ scopes (std::fprintf)
    // from matching inside identifiers.
    s = redactMatches(s, /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, (m) => {
      const ok = m.split('.').every((n) => Number(n) <= 255);
      return ok ? undefined : m;
    });
    s = redactMatches(
      s,
      /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:.])/g,
      (m) => {
        if (net.isIP(m) !== 6) return m;
        if (m === '::1' || m === '::') return undefined;
        if (!m.includes('::')) return m; // full form: isIP already required 8 groups
        const groups = m.split(':').filter(Boolean);
        return groups.some((g) => g.length >= 2) ? undefined : m;
      },
    );
    s = redactMatches(s, /(?<![\w:.])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![\w:.])/g);
    s = redactMatches(s, /\bP[S]5-[A-Za-z0-9_-]+\b/gi);
    s = redactMatches(s, /(^\s*SSID\s*:\s*)(.+)$/gim, (m, prefix, value) => prefix + blocks(value.length));
    s = redactMatches(s, /(\bSSID\s*[:=]\s*)([^\s].*)$/gim, (m, prefix, value) => prefix + blocks(value.length));

    return s;
  }

  /**
   * Redact a response: every string in it goes through text(), at any depth,
   * except the values of protocol keys (PROTOCOL_KEYS plus `opts.keep`) and of
   * keys in `opts.done`, which the caller already redacted. Depth and size are
   * bounded; what lies beyond is replaced, never passed on.
   */
  value(input, opts = {}) {
    if (!this.enabled) return input;
    this.refresh();
    return this._walk(input, null, 0, {
      keep: new Set([...PROTOCOL_KEYS, ...(opts.keep || [])]),
      done: new Set(opts.done || []),
      nodes: opts.maxNodes || MAX_NODES,
    });
  }

  _walk(v, key, depth, ctx) {
    if (typeof v === 'string') {
      if (key !== null && ctx.done.has(key)) return v;
      if (key !== null && ctx.keep.has(key) && KEEP_SHAPE.test(v)) return v;
      return this.text(v);
    }
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return this.text(String(v));
    if (typeof v !== 'object') return undefined; // functions and symbols do not serialise
    if (v instanceof Date) return v;
    if (depth >= MAX_DEPTH || --ctx.nodes < 0) return TRUNCATED;
    // A list inherits its key, so a kept list of ids stays a list of ids.
    if (Array.isArray(v)) return v.map((item) => this._walk(item, key, depth + 1, ctx));
    return this._walkObject(v, depth, ctx, null);
  }

  /** Copy of an object with every field walked, except the string fields named in `skip`. */
  _walkObject(obj, depth, ctx, skip) {
    const out = {};
    for (const [k, val] of Object.entries(obj)) {
      if (k === '__proto__') continue;
      if (skip && skip.has(k) && typeof val === 'string') { out[k] = val; continue; }
      out[SAFE_KEY.test(k) || ctx.keep.has(k) ? k : this.text(k)] = this._walk(val, k, depth + 1, ctx);
    }
    return out;
  }

  /**
   * Redact a projected event. The cases below give known fields their special
   * treatment (private paths, sensitive files, environment dumps); everything
   * else in the event is swept afterwards, so a field added to a projection
   * later is redacted without anyone remembering to list it. Protocol keys
   * (type, seq, ids) stay intact.
   */
  event(ev) {
    if (!this.enabled) return ev;
    this.refresh();
    const out = { ...ev };
    const done = new Set(['t']); // top-level keys a case below redacted itself
    const ctx = { keep: EVENT_KEEP, done: NO_KEYS, nodes: MAX_EVENT_NODES };
    switch (ev.t) {
      case 'session':
        out.cwd = this.text(ev.cwd, { path: ev.cwd });
        out.title = this.text(ev.title);
        done.add('cwd').add('title');
        break;
      case 'title':
        out.title = this.text(ev.title);
        done.add('title');
        break;
      case 'call': {
        if (ev.args && (typeof ev.args !== 'object' || Array.isArray(ev.args))) break; // odd shape: swept whole below
        const args = { ...(ev.args || {}) };
        const handled = new Set();
        const filePath = args.file_path;
        const sensitive = filePath && this.isSensitiveFile(filePath);
        const priv = filePath && this.isPrivate(filePath);
        for (const field of ['command', 'description', 'workdir', 'pattern', 'path', 'include', 'justification']) {
          if (typeof args[field] === 'string') { args[field] = this.text(args[field]); handled.add(field); }
        }
        for (const field of ['old_string', 'new_string', 'content']) {
          if (typeof args[field] !== 'string') continue;
          if (sensitive) args[field] = '[contents hidden]';
          else if (priv) args[field] = '[private]';
          else args[field] = this.text(args[field]);
          handled.add(field);
        }
        // Workspace files arrive as relative display paths; anything still
        // absolute lives outside the workspace and can name the user.
        if (isAbsolutePath(filePath)) { args.file_path = this.text(filePath, { path: filePath }); handled.add('file_path'); }
        out.args = this._walkObject(args, 1, ctx, handled);
        done.add('args');
        break;
      }
      case 'result': {
        const filePath = ev.meta?.path;
        const sensitive = filePath && this.isSensitiveFile(filePath);
        const priv = filePath && this.isPrivate(filePath);
        if (sensitive) out.text = '[contents hidden]';
        else if (priv) out.text = '[private]';
        else out.text = this.text(ev.text, { envDump: !!ev.envDump, path: filePath });
        done.add('text');
        if (ev.meta && typeof ev.meta === 'object' && !Array.isArray(ev.meta)) {
          const meta = { ...ev.meta };
          const handled = new Set();
          if (isAbsolutePath(meta.path)) { meta.path = this.text(meta.path, { path: meta.path }); handled.add('path'); }
          // A command's working directory is an absolute path that can name the user.
          if (typeof meta.cwd === 'string') { meta.cwd = this.text(meta.cwd, { path: meta.cwd }); handled.add('cwd'); }
          out.meta = this._walkObject(meta, 1, ctx, handled);
          done.add('meta');
        }
        break;
      }
      case 'say':
      case 'user':
        out.text = this.text(ev.text);
        done.add('text');
        if (typeof ev.thinking === 'string') { out.thinking = this.text(ev.thinking); done.add('thinking'); }
        if (typeof ev.systemLabel === 'string') { out.systemLabel = this.text(ev.systemLabel); done.add('systemLabel'); }
        break;
      case 'job':
        out.label = this.text(ev.label);
        done.add('label');
        break;
      case 'jobOutput':
        out.text = this.text(ev.text);
        done.add('text');
        break;
      case 'jobEnd':
        out.detail = this.text(ev.detail);
        done.add('detail');
        break;
      case 'approval':
        out.reason = this.text(ev.reason);
        done.add('reason');
        break;
      case 'deleted':
        out.path = this.text(ev.path, { path: ev.path });
        done.add('path');
        break;
      default:
        break;
    }
    for (const k of Object.keys(out)) {
      if (!done.has(k)) out[k] = this._walk(out[k], k, 1, ctx);
    }
    return out;
  }

  /** File contents served by /api/file. */
  fileContent(displayPath, content) {
    if (!this.enabled) return content;
    if (this.isSensitiveFile(displayPath)) return '[contents hidden]';
    if (this.isPrivate(displayPath)) return '[private]';
    return this.text(content, { path: displayPath });
  }

  treeName(name, displayPath) {
    if (!this.enabled) return name;
    if (this.isPrivate(displayPath)) return '[private]';
    return this.text(name);
  }
}

module.exports = { Redactor, isPrivatePathSync, redactEnvDump, safeRedact, PROTOCOL_KEYS, EVENT_KEYS, RECORD_KEYS };

/**
 * Fail-closed wrapper: a redaction failure replaces the event with a marker,
 * it never returns the original payload.
 */
function safeRedact(redactor, ev) {
  try {
    return redactor.event(ev);
  } catch {
    return { seq: ev && ev.seq, time: ev && ev.time, t: 'redactionError', text: '[redaction error]' };
  }
}
