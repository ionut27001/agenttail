'use strict';

/**
 * Minimal ACP v1 client for an agent that speaks ACP over stdio: dsh, or any
 * harness named in control.json.  The caller says what to run; this class only
 * moves messages.
 *
 * The transport is newline-delimited JSON-RPC 2.0 over stdio.  We deliberately
 * speak the protocol directly instead of depending on the Agent Client
 * Protocol SDK: agenttail has no runtime dependencies and only needs the small
 * subset used here (initialize, session/new, session/set_config_option,
 * session/prompt, session/cancel, session/close and permission replies).
 */

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const MAX_LINE = 8 * 1024 * 1024;
const STDERR_KEEP = 8 * 1024;

function quoteWin(value) {
  const s = String(value ?? '');
  if (!/[\s"&|<>^]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

class AcpClient extends EventEmitter {
  constructor(options) {
    super();
    this.bin = options.bin;
    this.args = Array.isArray(options.args) ? options.args : [];
    this.cwd = options.cwd;
    this.env = options.env || process.env;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
    this.exit = null;
    this.exitWaiters = [];
  }

  /** The last 8 KiB the child wrote to stderr. */
  stderrTail() {
    return this.stderr;
  }

  async start() {
    const args = this.args;
    const shell = process.platform === 'win32'
      && (!/\.(?:exe|com)$/i.test(this.bin) || /\.(?:cmd|bat)$/i.test(this.bin));
    const options = {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell,
    };
    let child;
    if (shell) {
      child = spawn(`${quoteWin(this.bin)} ${args.map(quoteWin).join(' ')}`, options);
    } else {
      child = spawn(this.bin, args, options);
    }
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
    child.stdin.on('error', () => { /* the child may exit before the write */ });
    child.on('exit', (code, signal) => this._onExit(code, signal));

    await new Promise((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    return this;
  }

  _onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) {
      this.emit('error', new Error('ACP output line exceeded the limit'));
      this.kill();
      return;
    }
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit('protocol-error', line);
        continue;
      }
      this._onMessage(message);
    }
  }

  _onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && message.method !== undefined) {
      this.emit('request', message);
      return;
    }
    if (message.method !== undefined) {
      this.emit('notification', message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || 'ACP request failed');
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  _onExit(code, signal) {
    this.exit = { code, signal, at: Date.now() };
    const error = new Error(`ACP agent exited (${signal || code || 'unknown'})`);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('exit', this.exit);
    for (const resolve of this.exitWaiters.splice(0)) resolve(this.exit);
  }

  _write(message) {
    if (this.closed || !this.child || !this.child.stdin.writable) {
      throw new Error('ACP transport is closed');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, options = {}) {
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`ACP ${method} timed out after ${timeoutMs} ms`);
        error.code = 'ETIMEDOUT';
        reject(error);
      }, timeoutMs) : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  respond(id, result) {
    this._write({ jsonrpc: '2.0', id, result });
  }

  respondError(id, code, message) {
    this._write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async close() {
    if (this.closed) return this.exit;
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('ACP transport closed'));
    }
    this.pending.clear();
    if (!this.child) return null;
    try { this.child.stdin.end(); } catch { /* ignore */ }
    const exit = await Promise.race([
      new Promise((resolve) => this.exitWaiters.push(resolve)),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!exit) this.kill();
    return exit;
  }

  kill() {
    this.closed = true;
    const child = this.child;
    if (!child || this.exit) return;
    // `dsh.cmd` runs through cmd.exe, so the pid is the shell; /T also ends
    // the dsh process under it instead of leaving it orphaned.
    if (process.platform === 'win32' && child.pid) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          .on('error', () => { try { child.kill(); } catch { /* ignore */ } });
        return;
      } catch { /* fall back to a plain kill */ }
    }
    try { child.kill(); } catch { /* ignore */ }
  }
}

module.exports = { AcpClient };
