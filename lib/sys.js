'use strict';
const os = require('node:os');
const { spawn } = require('node:child_process');

function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, cores: cpus.length };
}

/**
 * Samples CPU/RAM every 2 s and keeps one long-lived `nvidia-smi -l 2`
 * process while at least one SSE client is connected. No hostname is exposed.
 */
class SysMonitor {
  constructor() {
    this.clients = new Set();
    this.timer = null;
    this.prev = cpuSnapshot();
    this.cpuPct = 0;
    this.gpu = null;
    this.gpuProc = null;
    this.gpuUnavailable = false;
    this.buf = '';
  }

  start(cb) {
    if (typeof cb !== 'function') return;
    this.clients.add(cb);
    if (this.clients.size === 1) this.begin();
    cb(this.snapshot());
  }

  stop(cb) {
    this.clients.delete(cb);
    if (this.clients.size === 0) this.end();
  }

  snapshot() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = Math.max(0, total - free);
    return {
      at: Date.now(),
      cpu: { pct: Math.round(this.cpuPct), cores: os.cpus().length },
      ram: {
        pct: Math.round((used / total) * 100),
        used,
        total,
      },
      gpu: this.gpu,
      gpuUnavailable: this.gpuUnavailable,
    };
  }

  begin() {
    this.prev = cpuSnapshot();
    this.sample();
    this.timer = setInterval(() => this.sample(), 2000);
    this.startGpu();
  }

  end() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopGpu();
  }

  sample() {
    const now = cpuSnapshot();
    const idle = now.idle - this.prev.idle;
    const total = now.total - this.prev.total;
    this.prev = now;
    this.cpuPct = total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
    const payload = this.snapshot();
    for (const cb of this.clients) {
      try { cb(payload); } catch { /* client went away */ }
    }
  }

  startGpu() {
    if (this.gpuProc || this.gpuUnavailable) return;
    let proc;
    try {
      proc = spawn('nvidia-smi', [
        '--query-gpu=utilization.gpu,memory.used,memory.total,name',
        '--format=csv,noheader,nounits',
        '-l', '2',
      ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      this.gpuUnavailable = true;
      return;
    }
    this.gpuProc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      const lines = this.buf.split(/\r?\n/);
      this.buf = lines.pop() || '';
      for (const line of lines) this.parseGpu(line);
    });
    proc.on('error', () => {
      this.gpuUnavailable = true;
      this.gpu = null;
      this.gpuProc = null;
    });
    proc.on('exit', () => {
      this.gpuProc = null;
      this.gpu = null;
    });
  }

  parseGpu(line) {
    const parts = String(line).split(',').map((s) => s.trim());
    if (parts.length < 4) return;
    const pct = Number(parts[0]);
    const used = Number(parts[1]);
    const total = Number(parts[2]);
    if (!Number.isFinite(pct) || !Number.isFinite(used) || !Number.isFinite(total)) return;
    this.gpu = {
      pct: Math.round(pct),
      usedMiB: used,
      totalMiB: total,
      name: parts.slice(3).join(', '),
    };
    this.gpuUnavailable = false;
  }

  stopGpu() {
    if (!this.gpuProc) return;
    const proc = this.gpuProc;
    this.gpuProc = null;
    this.gpu = null;
    try { proc.kill(); } catch { /* ignore */ }
  }

  dispose() {
    this.clients.clear();
    this.end();
  }
}

module.exports = { SysMonitor };
