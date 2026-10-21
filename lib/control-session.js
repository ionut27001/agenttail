'use strict';

/**
 * One controlled session: an ACP child agenttail started, the run state of its
 * turns, its permission requests and what the agent said it can do.
 *
 * The permission preset and the workspace are process-level for dsh
 * (DSH_PERMISSION_MODE / cwd); other harnesses apply a mode or config option
 * right after `session/new`.  See docs/dev/input-design.md for the dsh evidence
 * and docs/dev/hub-harness-control.md for the general design.
 */

const { EventEmitter } = require('node:events');
const { AcpClient } = require('./acp');
const {
  chooseOption,
  toolCallFacts,
  hasFacts,
  normalizeApproval,
  publicApproval,
  normalizeConfigOptions,
  findModeOption,
  modelChoices,
  splitModelValue,
  probeCaps,
} = require('./acp-normalize');
const { resolveCommand, buildEnv } = require('./harness');
const { version: VERSION } = require('../package.json');

const MAX_MESSAGE = 32 * 1024;
const MAX_REASON = 500;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function controlError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Validate pasted images: [{ mimeType, data (base64) }] -> ACP image blocks. */
function imageBlocks(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw controlError('images must be a list');
  if (images.length > MAX_IMAGES) throw controlError(`at most ${MAX_IMAGES} images per message`);
  return images.map((image) => {
    const mimeType = String(image && image.mimeType || '');
    const data = String(image && image.data || '');
    if (!IMAGE_TYPES.has(mimeType)) throw controlError('images must be PNG, JPEG, GIF or WebP');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw controlError('image data must be base64');
    if (Math.floor(data.length * 3 / 4) > MAX_IMAGE_BYTES) throw controlError('an image is larger than 5 MB', 413);
    return { type: 'image', mimeType, data };
  });
}

class ControlSession extends EventEmitter {
  constructor(options) {
    super();
    this.cwd = options.cwd;
    this.harness = options.harness;
    this.preset = options.preset;
    this.audit = options.audit;
    this.mcpServers = Array.isArray(options.mcpServers) ? options.mcpServers : [];
    this.id = null;
    this.acpId = null;
    this.client = null;
    this.status = 'starting';
    this.running = false;
    this.turnStartedAt = 0;
    this.queued = null;
    this.caps = null;
    this.config = [];
    this.legacyModes = null;
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

  get label() {
    return this.harness.label;
  }

  async start() {
    const { bin, args } = resolveCommand(this.harness);
    this.client = new AcpClient({
      bin,
      args,
      cwd: this.cwd,
      env: buildEnv(this.harness, this.preset),
    });
    this.client.on('notification', (message) => this._onNotification(message));
    this.client.on('request', (message) => this._onRequest(message));
    this.client.on('exit', (exit) => this._onExit(exit));
    this.client.on('protocol-error', (line) => {
      this.lastError = `unparseable ACP output: ${String(line).slice(0, 200)}`;
    });

    try {
      await this.client.start();
      const init = await this.client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'agenttail', version: VERSION },
      }, { timeoutMs: 150_000 });
      const created = await this.client.request('session/new', {
        cwd: this.cwd,
        mcpServers: this.mcpServers,
      }, { timeoutMs: 150_000 });
      const sessionId = created && created.sessionId;
      if (!sessionId) throw new Error(`${this.label} did not return a session id`);
      this.acpId = String(sessionId);
      this.id = this.acpId;
      // Everything the page gates on comes from what the agent declared here.
      this.caps = probeCaps(init, created);
      this.legacyModes = created.modes && typeof created.modes === 'object' ? created.modes : null;
      this.config = this.caps.config;
      this._refreshModel();
      await this._applyPreset();
      this.status = 'idle';
      this.emit('state', this.statePayload());
      return this;
    } catch (err) {
      this.lastError = String(err.message || err);
      this.status = 'error';
      this.emit('state', this.statePayload());
      await this.client.close().catch(() => {});
      err.details = this.stderrTail();
      throw err;
    }
  }

  /** Last 8 KiB the agent process wrote to stderr: what to read when it dies. */
  stderrTail() {
    return this.client ? this.client.stderrTail() : '';
  }

  /** Mode and config presets are applied right after session/new; env presets before spawn. */
  async _applyPreset() {
    const preset = this.preset;
    if (preset.mode) {
      const option = findModeOption(this.config);
      if (!option) throw controlError(`${this.label} does not offer a mode option, so preset "${preset.id}" cannot be applied`, 400);
      await this.setConfigOption(option.id, preset.mode);
    }
    if (preset.config) {
      await this.setConfigOption(preset.config.configId, preset.config.value);
    }
  }

  _refreshModel() {
    const parsed = modelChoices(this.config);
    this.models = parsed.models;
    this.modelValue = parsed.current;
    if (parsed.current) {
      const split = splitModelValue(parsed.current);
      this.provider = split.provider;
      this.model = split.model;
    }
  }

  _setConfig(rawOptions) {
    this.config = normalizeConfigOptions(rawOptions, this.legacyModes);
    this._refreshModel();
  }

  statePayload() {
    const alive = !!this.client && !this.exit && !this.closing;
    const failed = this.status === 'exited' || this.status === 'error';
    return {
      id: this.id,
      owned: true,
      controllable: alive && (this.status === 'idle' || this.status === 'running'),
      alive,
      status: this.status,
      harness: this.harness.id,
      harnessLabel: this.label,
      cwd: this.cwd,
      preset: this.preset.id,
      provider: this.provider,
      model: this.model,
      modelValue: this.modelValue,
      models: this.models.map((m) => ({ value: m.value, name: m.name, provider: m.provider })),
      // What the agent declared; the page shows controls from this, not from the harness name.
      caps: this.caps ? { ...this.caps, config: this.config } : null,
      images: !!this.caps && this.caps.prompt.image === true,
      running: this.running,
      queued: !!this.queued,
      turnStartedAt: this.turnStartedAt,
      startedAt: this.startedAt,
      approvalCount: this.approvals.size,
      lastStopReason: this.lastStopReason,
      error: this.lastError,
      details: failed ? this.stderrTail() : '',
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
        // A card that already shows something is never rewritten under the
        // reviewer's eyes; only an empty one is filled in.
        for (const approval of this.approvals.values()) {
          if (approval.toolCallId === id && !hasFacts(approval)) {
            Object.assign(approval, toolCallFacts(merged));
            this.emit('approval-update', publicApproval(approval));
          }
        }
      }
      return;
    }
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
      this._setConfig(update.configOptions);
      this.emitsState();
      return;
    }
    if (update.sessionUpdate === 'current_mode_update' && update.currentModeId !== undefined) {
      const legacy = this.config.find((option) => option.legacy);
      if (legacy) {
        legacy.current = String(update.currentModeId);
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
    const approval = {
      ...normalizeApproval({
        harness: this.harness.id,
        requestId: message.id,
        toolCall: { ...(tracked || {}), ...requested },
        options: params.options,
      }),
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
    const option = chooseOption(approval.options, decision);
    if (!option && decision === 'approve') {
      // Never fall back to "always allow": the request stays open so the user
      // can still reject it, or stop the turn.
      throw controlError('this agent offered no allow-once option, so it cannot be approved here; reject it or stop the turn', 409);
    }
    if (!option) {
      this.client.respond(approval.rpcId, { outcome: { outcome: 'cancelled' } });
      this.approvals.delete(approval.approvalId);
      this.emit('approval-done', { approvalId: approval.approvalId, decision: 'cancelled' });
      this.emitsState();
      throw controlError('the agent did not offer a reject option; the request was cancelled', 409);
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

  /**
   * Set one of the agent's select options (model, mode, effort...).  Only
   * values the agent itself listed are accepted.
   */
  async setConfigOption(configId, value) {
    const option = this.config.find((entry) => entry.id === configId);
    if (!option) throw controlError('unknown setting for this session', 400);
    const wanted = String(value ?? '');
    if (option.options.length && !option.options.some((choice) => choice.value === wanted)) {
      throw controlError(`${this.label} does not offer "${wanted.slice(0, 80)}" for ${option.name}`, 400);
    }
    if (option.legacy) {
      await this.client.request('session/set_mode', { sessionId: this.acpId, modeId: wanted }, { timeoutMs: 30_000 });
      option.current = wanted;
      this._refreshModel();
      this.emitsState();
      return this.statePayload();
    }
    const result = await this.client.request('session/set_config_option', {
      sessionId: this.acpId,
      configId,
      value: wanted,
    }, { timeoutMs: 30_000 });
    if (result && Array.isArray(result.configOptions)) this._setConfig(result.configOptions);
    else option.current = wanted;
    this._refreshModel();
    this.emitsState();
    return this.statePayload();
  }

  async applyModel(value) {
    if (!value) return;
    const { models, configId } = modelChoices(this.config);
    if (!configId || !models.some((entry) => entry.value === value)) {
      throw controlError('unknown model for this session', 400);
    }
    return this.setConfigOption(configId, value);
  }

  send(text, images) {
    const body = String(text ?? '');
    const pictures = imageBlocks(images);
    if (!body.trim() && !pictures.length) throw controlError('message is empty');
    if (body.length > MAX_MESSAGE) throw controlError('message is too large', 413);
    if (pictures.length && !(this.caps && this.caps.prompt.image === true)) {
      throw controlError('this agent does not accept images', 400);
    }
    if (!this.id || this.closing || this.exit) throw controlError('session is not controllable', 409);
    if (this.running) {
      if (this.queued) throw controlError('a message is already queued', 409);
      this.queued = { text: body, images: pictures, at: Date.now() };
      this.emitsState();
      return { queued: true, running: true, images: pictures.length };
    }
    this._runPrompt(body, pictures);
    return { queued: false, running: true, images: pictures.length };
  }

  /** Where a finished (or failed) turn leaves the session: a dead child stays `exited`. */
  _settledStatus() {
    if (this.closing) return 'closed';
    return this.exit ? 'exited' : 'idle';
  }

  async _runPrompt(text, images = []) {
    this.running = true;
    this.status = 'running';
    this.turnStartedAt = Date.now();
    this.lastError = null;
    this.emitsState();
    try {
      const result = await this.client.request('session/prompt', {
        sessionId: this.acpId,
        prompt: [...(text ? [{ type: 'text', text }] : []), ...images],
      });
      this.lastStopReason = result?.stopReason || null;
      this.running = false;
      this.status = this._settledStatus();
      this.emit('turn-end', { stopReason: this.lastStopReason });
      this.emitsState();
    } catch (err) {
      this.running = false;
      this.status = this._settledStatus();
      // An exit already said why (with the harness label); keep that text.
      if (!this.exit) this.lastError = String(err.message || err);
      this.emit('error', err);
      this.emitsState();
    } finally {
      if (this.queued && !this.closing && !this.exit) {
        const next = this.queued;
        this.queued = null;
        this._runPrompt(next.text, next.images || []);
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
    // session/close only when the agent declared it; otherwise ending stdin
    // and killing the process (below) is the way out.
    if (this.client && this.acpId && this.caps && this.caps.session.close) {
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
      this.lastError = `${this.label} exited (${exit.signal || exit.code || 'unknown'})`;
    }
    for (const approval of this.approvals.values()) {
      this.emit('approval-done', { approvalId: approval.approvalId, decision: 'cancelled' });
    }
    this.approvals.clear();
    this.emitsState();
    this.emit('exit', exit);
  }
}

module.exports = {
  ControlSession,
  controlError,
  imageBlocks,
  splitModelValue,
  MAX_MESSAGE,
  MAX_IMAGES,
};
