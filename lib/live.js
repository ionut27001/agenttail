'use strict';

const RANK = { finished: 0, idle: 1, live: 2 };
const IDLE_MS = 10 * 60 * 1000;
// A turn that never ended (an interrupted or crashed agent) stops counting as live after this.
const OPEN_TURN_MS = 30 * 60 * 1000;

/**
 * Derive the display state from log facts, never from mtime alone.
 * live  = an open turn/step or an open background job
 * idle  = the last turn/step ended less than 10 minutes ago
 * finished = anything else
 */
function stateFrom({ openJob, openStep, openTurn, lastEndAt, now = Date.now() }) {
  // Live means a turn is in progress. A detached background job alone keeps a
  // finished turn in the idle/background state, never live.
  if (openStep || openTurn) return 'live';
  if (openJob) return 'idle';
  if (lastEndAt && now - lastEndAt < IDLE_MS) return 'idle';
  return 'finished';
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

function describe({ state, openJob, openStep, openTurn, lastEventAt, lastEndAt, now = Date.now() }) {
  if (state === 'live' && openStep) return `step ${openStep.step ?? ''} running, last event ${ago(now - (lastEventAt || now))} ago`;
  if (state === 'live' && openTurn) return `turn running, last event ${ago(now - (lastEventAt || now))} ago`;
  if (openJob) return `background job ${String(openJob.jobId || '').slice(0, 9)}…, ${ago(now - (openJob.startedAt || now))}`;
  if (state === 'idle') return `idle since ${ago(now - (lastEndAt || now))} ago`;
  return lastEventAt ? `last event ${ago(now - lastEventAt)} ago` : 'no events';
}

/** Two consecutive agreeing polls are required before downgrading. */
class LiveTracker {
  constructor() {
    this.entries = new Map();
  }

  update(id, computed) {
    if (!RANK[computed]) return computed;
    const prev = this.entries.get(id);
    if (!prev) {
      this.entries.set(id, { state: computed, down: 0 });
      return computed;
    }
    if (computed === prev.state) {
      prev.down = 0;
      return computed;
    }
    if (RANK[computed] > RANK[prev.state]) {
      prev.state = computed;
      prev.down = 0;
      return computed;
    }
    prev.down += 1;
    if (prev.down >= 2) {
      prev.state = computed;
      prev.down = 0;
      return computed;
    }
    return prev.state;
  }

  get(id) {
    return this.entries.get(id)?.state || null;
  }
}

module.exports = { stateFrom, describe, LiveTracker, ago, IDLE_MS, OPEN_TURN_MS, RANK };
