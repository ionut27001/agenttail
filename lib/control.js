'use strict';

/**
 * Control plane for sessions agenttail starts itself.
 *
 * ACP is stdio-only, so agenttail owns one `dsh --profile acp` child per
 * controlled session.  The permission preset and the workspace are
 * process-level in dsh (DSH_PERMISSION_MODE / cwd); the model is a per-session
 * ACP config option.  See docs/dev/input-design.md for the evidence.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AcpClient } = require('./acp');
const { isInside } = require('./util');

const PRESETS = ['read-only', 'workspace-write', 'danger-full-access'];
const DEFAULT_PRESET = 'workspace-write';
const MAX_MESSAGE = 32 * 1024;
const MAX_REASON = 500;
const MAX_SESSIONS = 8;

function controlError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function splitModelValue(value) {
  const raw = String(value ?? '');
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return { provider: String(parsed[0]), model: String(parsed[1]), value: raw };
    }
  } catch { /* older/plain values */ }
  const cut = raw.indexOf('/');
  if (cut > 0) return { provider: raw.slice(0, cut), model: raw.slice(cut + 1), value: raw };
  return { provider: '', model: raw, value: raw };
}

function modelOptions(configOptions) {
  const models = [];
  for (const option of Array.isArray(configOptions) ? configOptions : []) {
    if (option?.id !== 'model' || !Array.isArray(option.options)) continue;
    const flatten = (entries, group) => {
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        if (Array.isArray(entry.options)) {
          flatten(entry.options, entry.group || entry.name || group);
          continue;
        }
        if (entry.value === undefined) continue;
        const split = splitModelValue(entry.value);
        models.push({
          value: String(entry.value),
          name: String(entry.name || split.model || entry.value),
          provider: String(entry.group || group || split.provider || ''),
          model: split.model,
        });
      }
    };
    flatten(option.options, '');
    return {
      models,
      current: option.currentValue !== undefined ? String(option.currentValue) : (models[0]?.value ?? null),
    };
  }
  return { models: [], current: null };
}

function toolText(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'content' && block.content) return toolText(block.content);
  if (typeof block.text === 'string') return block.text;
  return '';
}

function approvalDetails(toolCall) {
  const call = toolCall && typeof toolCall === 'object' ? toolCall : {};
  const raw = call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {};
  const command = typeof raw.command === 'string' ? raw.command : null;
  let diff = null;
  if (typeof raw.old_string === 'string' || typeof raw.new_string === 'string') {
    diff = {
      path: raw.file_path || raw.path || null,
      oldText: typeof raw.old_string === 'string' ? raw.old_string : '',
      newText: typeof raw.new_string === 'string' ? raw.new_string : '',
    };
  }
  const content = (Array.isArray(call.content) ? call.content : []).map(toolText).filter(Boolean).join('\n');
  const keep = ['command', 'file_path', 'path', 'workdir', 'description', 'justification', 'pattern', 'old_string', 'new_string', 'content'];
  const lean = {};
  for (const key of keep) {
    if (raw[key] === undefined) continue;
    const value = raw[key];
    lean[key] = typeof value === 'string' && value.length > 8000 ? `${value.slice(0, 8000)}…` : value;
  }
  return {
    title: String(call.title || call.kind || 'Permission request').slice(0, 300),
    kind: String(call.kind || ''),
    toolCallId: String(call.toolCallId || ''),
    command,
    diff,
    content: content.slice(0, 20000),
    rawInput: Object.keys(lean).length ? lean : null,
  };
}

class ControlConfig {
  constructor(file) {
    this.file = file;
    this.cache = null;
    this.mtimeMs = 0;
  }

  async load() {
    try {
      const stat = await fsp.stat(this.file);
      if (this.cache && stat.mtimeMs === this.mtimeMs) return this.cache;
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      const base = path.dirname(this.file);
      const workspaces = (Array.isArray(raw.workspaces) ? raw.workspaces : [])
        .map((entry) => {
          if (typeof entry === 'string') return { path: path.resolve(base, entry), label: '' };
          if (!entry || typeof entry !== 'object' || !entry.path) return null;
          return { path: path.resolve(base, String(entry.path)), label: entry.label ? String(entry.label) : '' };
        })
        .filter(Boolean);
      this.cache = {
        workspaces,
        dshProfile: typeof raw.dshProfile === 'string' && raw.dshProfile ? raw.dshProfile : 'acp',
        dshCommand: typeof raw.dshCommand === 'string' && raw.dshCommand ? raw.dshCommand : null,
        dshArgs: Array.isArray(raw.dshArgs) ? raw.dshArgs.map(String) : [],
        dshHome: typeof raw.dshHome === 'string' && raw.dshHome ? path.resolve(base, raw.dshHome) : null,
        patch: typeof raw.patch === 'string' && raw.patch ? path.resolve(base, raw.patch) : null,
        maxSessions: Number.isInteger(raw.maxSessions) && raw.maxSessions > 0
          ? Math.min(raw.maxSessions, 32)
          : MAX_SESSIONS,
      };
      this.mtimeMs = stat.mtimeMs;
      return this.cache;
    } catch {
      return this.cache || {
        workspaces: [],
        dshProfile: 'acp',
        dshCommand: null,
        dshArgs: [],
        dshHome: null,
        patch: null,
        maxSessions: MAX_SESSIONS,
      };
    }
  }

  async resolveWorkspace(input) {
    const config = await this.load();
    if (!input) throw controlError('workspace is required');
    let real;
    try {
      real = await fsp.realpath(String(input));
      if (!(await fsp.stat(real)).isDirectory()) throw new Error('not a directory');
    } catch {
      throw controlError('workspace does not exist or is not a directory', 400);
    }
    let hit = null;
    for (const workspace of config.workspaces) {
      let wsReal;
      try { wsReal = await fsp.realpath(workspace.path); } catch { continue; }
      if (isInside(real, wsReal)) { hit = workspace; break; }
    }
    if (!hit) throw controlError('workspace is not in the control allowlist', 403);
    return { config, real, workspace: hit };
  }
}

class AuditLog {
  constructor(file) {
    this.file = file;
    this.chain = Promise.resolve();
  }

  append(action, fields = {}) {
    const record = { ts: new Date().toISOString(), action, ...fields };
    this.chain = this.chain.then(async () => {
      try {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      } catch { /* auditing must not take control down */ }
    });
    return this.chain;
  }
}

class ControlSession extends EventEmitter {
  constructor(options) {
    super();
    this.cwd = options.cwd;
    this.preset = options.preset;
    this.config = options.config;
    this.audit = options.audit;
    this.id = null;
    this.acpId = null;
    this.client = null;
    this.status = 'starting';
    this.running = false;
    this.turnStartedAt = 0;
    this.queued = null;
    this.models = [];
    this.modelValue = null;
    this.provider = '';
    this.model = '';
    this.approvals = new Map();
    this.toolCalls = new Map();
    this.closing = false;
    this.exit = null;
    this.startedAt = Date.now();
    this.lastError = null;
    this.lastStopReason = null;
  }

  async start() {
    const config = this.config;
    const env = {
      ...process.env,
      DSH_PERMISSION_MODE: this.preset,
    };
    if (config.dshHome) env.DSH_HOME = config.dshHome;
    this.client = new AcpClient({
      bin: config.dshCommand || process.env.AGENTTAIL_DSH_BIN || 'dsh',
      prefixArgs: config.dshArgs.length ? config.dshArgs : parseEnvArgs(process.env.AGENTTAIL_DSH_ARGS),
      profile: config.dshProfile,
      patch: config.patch,
      cwd: this.cwd,
      env,
    });
    this.client.on('notification', (message) => this._onNotification(message));
    this.client.on('request', (message) => this._onRequest(message));
    this.client.on('exit', (exit) => this._onExit(exit));
    this.client.on('protocol-error', (line) => {
      this.lastError = `unparseable ACP output: ${String(line).slice(0, 200)}`;
    });

    try {
      await this.client.start();
      await this.client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'agenttail', version: '0.2.0' },
      }, { timeoutMs: 150_000 });
      const created = await this.client.request('session/new', {
        cwd: this.cwd,
        mcpServers: [],
      }, { timeoutMs: 150_000 });
      const sessionId = created && created.sessionId;
      if (!sessionId) throw new Error('dsh ACP did not return a session id');
      this.acpId = String(sessionId);
      this.id = this.acpId;
      const parsed = modelOptions(created.configOptions);
      this.models = parsed.models;
      this.modelValue = parsed.current;
      this._setModelFromValue(this.modelValue);
      this.status = 'idle';
      this.emit('state', this.statePayload());
      return this;
    } catch (err) {
      this.lastError = String(err.message || err);
      this.status = 'error';
      this.emit('state', this.statePayload());
      await this.client.close().catch(() => {});
      throw err;
    }
  }

  _setModelFromValue(value) {
    if (!value) return;
    const split = splitModelValue(value);
    this.provider = split.provider;
    this.model = split.model;
  }

  statePayload() {
    const alive = !!this.client && !this.exit && !this.closing;
    return {
      id: this.id,
      owned: true,
      controllable: alive && (this.status === 'idle' || this.status === 'running'),
      alive,
      status: this.status,
      cwd: this.cwd,
      preset: this.preset,
      provider: this.provider,
      model: this.model,
      running: this.running,
      queued: !!this.queued,
      turnStartedAt: this.turnStartedAt,
      startedAt: this.startedAt,
      approvalCount: this.approvals.size,
      lastStopReason: this.lastStopReason,
      error: this.lastError,
    };
  }

  emitsState() {
    this.emit('state', this.statePayload());
  }

  _onNotification(message) {
    if (message.method !== 'session/update') return;
    const params = message.params || {};
    if (params.sessionId && params.sessionId !== this.acpId) return;
    const update = params.update || {};
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const id = String(update.toolCallId || '');
      if (id) {
        const previous = this.toolCalls.get(id) || {};
        const merged = { ...previous, ...update };
        if (previous.rawInput && update.rawInput === undefined) merged.rawInput = previous.rawInput;
        this.toolCalls.set(id, merged);
        if (this.toolCalls.size > 500) this.toolCalls.delete(this.toolCalls.keys().next().value);
        for (const approval of this.approvals.values()) {
          if (approval.toolCallId === id && !approval.command && !approval.diff && !approval.content) {
            const details = approvalDetails(merged);
            Object.assign(approval, details);
            this.emit('approval-update', publicApproval(approval));
          }
        }
      }
      return;
    }
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
      const parsed = modelOptions(update.configOptions);
      if (parsed.models.length) {
        this.models = parsed.models;
        this.modelValue = parsed.current;
        this._setModelFromValue(parsed.current);
        this.emitsState();
      }
    }
  }

  _onRequest(message) {
    if (message.method !== 'session/request_permission') {
      this.client.respondError(message.id, -32601, 'method not supported by agenttail');
      return;
    }
    const params = message.params || {};
    if (params.sessionId && params.sessionId !== this.acpId) {
      this.client.respond(message.id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    // dsh's permission request carries only the tool-call id. The matching
    // `tool_call` update (title + rawInput) is delivered before this request.
    const requested = params.toolCall || {};
    const requestId = String(requested.toolCallId || '');
    const tracked = requestId ? this.toolCalls.get(requestId) : null;
    const details = approvalDetails({ ...(tracked || {}), ...requested });
    const options = (Array.isArray(params.options) ? params.options : []).map((option) => ({
      optionId: String(option.optionId),
      name: String(option.name || option.optionId),
      kind: String(option.kind || ''),
    }));
    const approval = {
      approvalId: String(message.id),
      ...details,
      options,
      createdAt: Date.now(),
      rpcId: message.id,
    };
    this.approvals.set(approval.approvalId, approval);
    this.emit('approval', publicApproval(approval));
    this.emitsState();
  }

  publicApproval(approvalId) {
    const approval = this.approvals.get(String(approvalId));
    return approval ? publicApproval(approval) : null;
  }

  pendingApprovals() {
    return [...this.approvals.values()].map(publicApproval);
  }

  resolveApproval(approvalId, decision, reason) {
    const approval = this.approvals.get(String(approvalId));
    if (!approval) throw controlError('approval not found', 404);
    if (decision !== 'approve' && decision !== 'reject') throw controlError('invalid decision');
    const kinds = decision === 'approve'
      ? ['allow_once', 'allow_always']
      : ['reject_once', 'reject_always'];
    let option = approval.options.find((entry) => kinds.includes(entry.kind));
    if (!option && decision === 'reject') option = approval.options.find((entry) => /reject/i.test(entry.kind));
    if (!option) {
      this.client.respond(approval.rpcId, { outcome: { outcome: 'cancelled' } });
      this.approvals.delete(approval.approvalId);
      this.emit('approval-done', { approvalId: approval.approvalId, decision: 'cancelled' });
      this.emitsState();
      throw controlError('the agent did not offer a matching permission option', 409);
    }
    const result = { outcome: { outcome: 'selected', optionId: option.optionId } };
    if (decision === 'reject' && reason) result._meta = { reason: String(reason).slice(0, MAX_REASON) };
    this.client.respond(approval.rpcId, result);
    this.approvals.delete(approval.approvalId);
    const payload = {
      approvalId: approval.approvalId,
      decision,
      optionId: option.optionId,
      hadReason: !!reason,
    };
    this.emit('approval-done', payload);
    this.emitsState();
    return payload;
  }

  async applyModel(value) {
    if (!value) return;
    const match = this.models.find((entry) => entry.value === value);
    if (!match) throw controlError('unknown model for this session', 400);
    const result = await this.client.request('session/set_config_option', {
      sessionId: this.acpId,
      configId: 'model',
      value,
    }, { timeoutMs: 30_000 });
    if (result && Array.isArray(result.configOptions)) {
      const parsed = modelOptions(result.configOptions);
      if (parsed.models.length) this.models = parsed.models;
    }
    this.modelValue = value;
    this._setModelFromValue(value);
    this.emitsState();
    return this.statePayload();
  }

  send(text) {
    const body = String(text ?? '');
    if (!body.trim()) throw controlError('message is empty');
    if (body.length > MAX_MESSAGE) throw controlError('message is too large', 413);
    if (!this.id || this.closing || this.exit) throw controlError('session is not controllable', 409);
    if (this.running) {
      if (this.queued) throw controlError('a message is already queued', 409);
      this.queued = { text: body, at: Date.now() };
      this.emitsState();
      return { queued: true, running: true };
    }
    this._runPrompt(body);
    return { queued: false, running: true };
  }

  async _runPrompt(text) {
    this.running = true;
    this.status = 'running';
    this.turnStartedAt = Date.now();
    this.lastError = null;
    this.emitsState();
    try {
      const result = await this.client.request('session/prompt', {
        sessionId: this.acpId,
        prompt: [{ type: 'text', text }],
      });
      this.lastStopReason = result?.stopReason || null;
      this.running = false;
      this.status = this.closing ? 'closed' : 'idle';
      this.emit('turn-end', { stopReason: this.lastStopReason });
      this.emitsState();
    } catch (err) {
      this.running = false;
      this.status = this.closing ? 'closed' : 'idle';
      this.lastError = String(err.message || err);
      this.emit('error', err);
      this.emitsState();
    } finally {
      if (this.queued && !this.closing && !this.exit) {
        const next = this.queued;
        this.queued = null;
        this._runPrompt(next.text);
      }
    }
  }

  cancel() {
    if (this.closing || this.exit) throw controlError('session is not controllable', 409);
    if (this.queued) {
      this.queued = null;
      this.emitsState();
    }
    if (!this.running) return { cancelled: false };
    for (const approval of this.approvals.values()) {
      try { this.client.respond(approval.rpcId, { outcome: { outcome: 'cancelled' } }); } catch { /* ignore */ }
      this.emit('approval-done', { approvalId: approval.approvalId, decision: 'cancelled' });
    }
    this.approvals.clear();
    this.client.notify('session/cancel', { sessionId: this.acpId });
    this.emitsState();
    return { cancelled: true };
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.running = false;
    this.queued = null;
    for (const approval of this.approvals.values()) {
      try { this.client.respond(approval.rpcId, { outcome: { outcome: 'cancelled' } }); } catch { /* ignore */ }
      this.emit('approval-done', { approvalId: approval.approvalId, decision: 'cancelled' });
    }
    this.approvals.clear();
    if (this.client && this.acpId) {
      try {
        await this.client.request('session/close', { sessionId: this.acpId }, { timeoutMs: 5000 });
      } catch { /* process teardown is best-effort */ }
    }
    await this.client?.close().catch(() => {});
    this.status = 'closed';
    this.emitsState();
    this.emit('closed');
  }

  _onExit(exit) {
    this.exit = exit;
    this.running = false;
    if (!this.closing) {
      this.status = 'exited';
      this.lastError = `dsh ACP exited (${exit.signal || exit.code || 'unknown'})`;
    }
    for (const approval of this.approvals.values()) {
      this.emit('approval-done', { approvalId: approval.approvalId, decision: 'cancelled' });
    }
    this.approvals.clear();
    this.emitsState();
    this.emit('exit', exit);
  }
}

function parseEnvArgs(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function publicApproval(approval) {
  return {
    approvalId: approval.approvalId,
    title: approval.title,
    kind: approval.kind,
    toolCallId: approval.toolCallId,
    command: approval.command,
    diff: approval.diff,
    content: approval.content,
    rawInput: approval.rawInput,
    options: approval.options,
    createdAt: approval.createdAt,
  };
}

class ControlManager {
  constructor(options) {
    this.config = new ControlConfig(options.configPath);
    this.audit = new AuditLog(options.auditPath);
    this.sessions = new Map();
  }

  async begin({ cwd, preset, confirmDanger }) {
    const chosen = preset || DEFAULT_PRESET;
    if (!PRESETS.includes(chosen)) throw controlError('unknown permission preset');
    if (chosen === 'danger-full-access' && confirmDanger !== true) {
      throw controlError('danger-full-access requires explicit confirmation', 400);
    }
    const { config, real } = await this.config.resolveWorkspace(cwd);
    if (this.sessions.size >= config.maxSessions) throw controlError('too many controlled sessions', 429);
    const session = new ControlSession({
      cwd: real,
      preset: chosen,
      config,
      audit: this.audit,
    });
    session.on('state', () => this._onSessionState(session));
    session.on('exit', () => {
      if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    });
    try {
      await session.start();
    } catch (err) {
      throw controlError(`could not start dsh ACP: ${err.message || err}`, 502);
    }
    this.sessions.set(session.id, session);
    await this.audit.append('start', {
      sessionId: session.id,
      preset: chosen,
      cwd: real,
      model: session.model,
      provider: session.provider,
    });
    return {
      session: session.statePayload(),
      models: session.models,
      currentModel: session.modelValue,
    };
  }

  async startFirst(id, { model, message }) {
    const session = this.get(id);
    if (model) await session.applyModel(model);
    const result = session.send(message);
    await this.audit.append('message', {
      sessionId: id,
      chars: String(message ?? '').length,
      first: true,
      queued: result.queued,
    });
    return { session: session.statePayload(), ...result };
  }

  async message(id, text) {
    const session = this.get(id);
    const result = session.send(text);
    await this.audit.append('message', {
      sessionId: id,
      chars: String(text ?? '').length,
      queued: result.queued,
    });
    return { session: session.statePayload(), ...result };
  }

  async approval(id, approvalId, decision, reason) {
    const session = this.get(id);
    const result = session.resolveApproval(approvalId, decision, reason);
    await this.audit.append(decision === 'approve' ? 'approve' : 'reject', {
      sessionId: id,
      approvalId,
      hadReason: !!reason,
      reasonLength: reason ? String(reason).length : 0,
    });
    return { session: session.statePayload(), ...result };
  }

  async stop(id) {
    const session = this.get(id);
    const result = session.cancel();
    await this.audit.append('stop', { sessionId: id, cancelled: result.cancelled });
    return { session: session.statePayload(), ...result };
  }

  async close(id) {
    const session = this.get(id);
    await session.close();
    this.sessions.delete(id);
    await this.audit.append('close', { sessionId: id });
    return { closed: true };
  }

  get(id) {
    const session = this.sessions.get(String(id));
    if (!session) throw controlError('session is not owned by agenttail', 404);
    return session;
  }

  has(id) {
    return this.sessions.has(String(id));
  }

  async dispose() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  _onSessionState(session) {
    if (session.status === 'closed' || session.status === 'exited') {
      // Keep the record long enough for the current SSE subscriber to see the
      // final state; new /api/stream requests then treat it as view-only.
      if (this.sessions.get(session.id) === session) {
        setTimeout(() => {
          if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
        }, 2000).unref?.();
      }
    }
  }
}

module.exports = {
  ControlManager,
  ControlConfig,
  AuditLog,
  ControlSession,
  PRESETS,
  DEFAULT_PRESET,
  MAX_MESSAGE,
  splitModelValue,
};
