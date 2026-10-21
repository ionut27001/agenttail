'use strict';

/**
 * Control plane for sessions agenttail starts itself.
 *
 * The manager owns the allowlist of workspaces, the audit log and the map of
 * live sessions (`sessions`, session id -> ControlSession).  A session is one
 * ACP child (lib/control-session.js); which programs may be started comes from
 * the harness registry (lib/harness.js).  ACP is stdio-only, so there is one
 * child per controlled session.
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { ControlSession, controlError, MAX_MESSAGE, MAX_IMAGES } = require('./control-session');
const { splitModelValue } = require('./acp-normalize');
const { parseHarnesses, PRESETS } = require('./harness');
const { isInside } = require('./util');

const DEFAULT_PRESET = 'workspace-write';
const MAX_SESSIONS = 8;

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
        harnesses: parseHarnesses(raw, base),
        maxSessions: Number.isInteger(raw.maxSessions) && raw.maxSessions > 0
          ? Math.min(raw.maxSessions, 32)
          : MAX_SESSIONS,
      };
      this.mtimeMs = stat.mtimeMs;
      return this.cache;
    } catch {
      return this.cache || {
        workspaces: [],
        harnesses: parseHarnesses({}, path.dirname(this.file)),
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

class ControlManager {
  constructor(options) {
    this.config = new ControlConfig(options.configPath);
    this.audit = new AuditLog(options.auditPath);
    this.sessions = new Map();
  }

  async begin({ cwd, preset, confirmDanger, harness: harnessId }) {
    const loaded = await this.config.load();
    const harness = loaded.harnesses.get(harnessId);
    if (!harness) throw controlError('unknown harness');
    const chosen = harness.presets.find((entry) => entry.id === (preset || harness.defaultPreset));
    if (!chosen) throw controlError('unknown permission preset');
    if (chosen.danger && confirmDanger !== true) {
      throw controlError(`${chosen.id} requires explicit confirmation`, 400);
    }
    const { config, real } = await this.config.resolveWorkspace(cwd);
    if (this.sessions.size >= config.maxSessions) throw controlError('too many controlled sessions', 429);
    const session = new ControlSession({
      cwd: real,
      harness,
      preset: chosen,
      audit: this.audit,
    });
    session.on('state', () => this._onSessionState(session));
    // A failed turn is reported as an 'error' event; with no page watching
    // there is no other listener, and an unhandled 'error' would end the server.
    session.on('error', () => {});
    session.on('exit', () => {
      if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    });
    try {
      await session.start();
    } catch (err) {
      throw Object.assign(
        controlError(`could not start ${harness.label}: ${err.message || err}`, 502),
        { details: err.details || '' },
      );
    }
    if (this.sessions.has(session.id)) {
      // Two agents can hand out the same id; never let one session replace another.
      await session.close().catch(() => {});
      throw controlError(`${harness.label} returned a session id that is already in use`, 502);
    }
    this.sessions.set(session.id, session);
    await this.audit.append('start', {
      sessionId: session.id,
      harness: harness.id,
      agent: session.caps.agent.name,
      agentVersion: session.caps.agent.version,
      protocol: session.caps.protocolVersion,
      preset: chosen.id,
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

  async message(id, text, images) {
    const session = this.get(id);
    const result = session.send(text, images);
    await this.audit.append('message', {
      sessionId: id,
      chars: String(text ?? '').length,
      images: result.images || 0,
      queued: result.queued,
    });
    return { session: session.statePayload(), ...result };
  }

  async setModel(id, value) {
    const session = this.get(id);
    if (!value) throw controlError('model is required');
    await session.applyModel(String(value));
    await this.audit.append('model', { sessionId: id, model: session.model, provider: session.provider });
    return { session: session.statePayload() };
  }

  /** Set a select option the agent offers (mode, effort...); values are the agent's own ids. */
  async setConfig(id, configId, value) {
    const session = this.get(id);
    if (!configId) throw controlError('setting is required');
    await session.setConfigOption(String(configId), value);
    await this.audit.append('config', { sessionId: id, configId: String(configId), value: String(value ?? '').slice(0, 80) });
    return { session: session.statePayload() };
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
  MAX_IMAGES,
  splitModelValue,
};
