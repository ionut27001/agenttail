'use strict';

const { safeRedact } = require('./redact');
const { keyFor } = require('./util');
const { LiveTracker, ago, OPEN_TURN_MS } = require('./live');
const attention = require('./attention');
const tiers = require('./tiers');

const IDLE_MS = 10 * 60 * 1000;

/**
 * Common behaviour for every source adapter. Adapters extend it, call add()
 * for each normalized event and implement _poll() for incremental reads.
 */
class BaseStream extends EventTarget {
  constructor(session, ctx) {
    super();
    this.session = session;
    this.ctx = ctx;
    this.events = [];
    this.seq = 0;
    this.live = false;
    this.keys = new Map();
    this.stopped = false;
    this.polling = null;
    this.timer = null;
    this.refs = 0;
    this.idleTimer = null;
    this.lastWriteAt = session.mtimeMs || Date.now();
    this.lastEventAt = 0;
    this.lastGrowthAt = 0;
    this.turnOpen = false; // set by adapters whose logs say when a turn ends
    this.tracker = new LiveTracker();
    this.statusKey = '';
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setLive(value) {
    if (value === this.live) return;
    this.live = value;
    this.emit('status', { live: value, lastWriteAt: this.lastWriteAt });
  }

  keyFor(display) {
    const key = keyFor(`${this.session.source}:${this.session.id}`, display);
    this.keys.set(key, display);
    return key;
  }

  displayPath(absOrRel) {
    return this.ctx.mapPath(this.session.cwd, absOrRel);
  }

  /** Normalize a file path for the page: display path + opaque key. */
  fileRef(absOrRel) {
    if (!absOrRel) return null;
    const display = this.displayPath(absOrRel);
    if (!display) return { path: String(absOrRel) };
    return { path: display, key: this.keyFor(display) };
  }

  add(ev) {
    ev.seq = ++this.seq;
    if (typeof ev.time === 'number') this.lastEventAt = Math.max(this.lastEventAt, ev.time);
    const safe = safeRedact(this.ctx.redactor, ev);
    this.events.push(safe);
    if (this.events.length > this.ctx.maxEvents) this.events.splice(0, this.events.length - this.ctx.maxEvents);
    this.emit('event', safe);
    return safe;
  }

  /** Live when a tool call is unanswered or the transcript grew recently. */
  hasPending() {
    return false;
  }

  /** A better state than the transcript can give, or null (Claude Code's status file does). */
  forcedState() {
    return null;
  }

  /** How much the agent may do without asking, as lib/tiers.js records it; unknown until an adapter reads it. */
  permissionNow() {
    return tiers.unknown();
  }

  /** This source's "needs you" record. None until an adapter knows a signal. */
  attentionNow() {
    return attention.none();
  }

  computeState(now = Date.now()) {
    const forced = this.forcedState(now);
    const pending = this.hasPending();
    const growing = now - (this.lastGrowthAt || 0) < 60_000;
    // A quiet log is not idle while the turn is still open: the model may be composing.
    const working = this.turnOpen && now - (this.lastEventAt || 0) < OPEN_TURN_MS;
    const rawState = forced ? forced.state : pending || growing || working ? 'live' : now - (this.lastEventAt || 0) < IDLE_MS ? 'idle' : 'finished';
    const state = this.tracker.update(`${this.session.source}:${this.session.id}`, rawState);
    const last = this.lastEventAt ? `${ago(now - this.lastEventAt)} ago` : 'no events yet';
    const stateDetail = forced
      ? forced.detail
      : pending
      ? `open tool call, last event ${last}`
      : growing
        ? `receiving output, last event ${last}`
        : working
          ? `working on a reply, last event ${last}`
        : rawState === 'idle'
          ? `idle since ${last}`
          : `last event ${last}`;
    return { state, rawState, stateDetail };
  }

  emitStatus() {
    const s = this.computeState();
    this.live = s.state === 'live';
    const waiting = this.attentionNow(s);
    const permission = this.permissionNow();
    const key = `${s.state}|${s.stateDetail}|${attention.key(waiting)}|${tiers.key(permission)}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    this.emit('status', {
      live: this.live,
      state: s.state,
      stateDetail: s.stateDetail,
      attention: waiting,
      permission: tiers.forPage(permission),
      lastWriteAt: this.lastWriteAt,
      size: this.session.size,
      jobs: [],
    });
  }

  markGrowth() {
    this.lastGrowthAt = Date.now();
  }

  addDeleted(displayPath, time) {
    if (!displayPath) return;
    this.add({ t: 'deleted', path: displayPath, key: this.keyFor(displayPath), time: time || Date.now() });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll().catch(() => {}), this.ctx.pollMs);
    this.timer.unref?.();
    this.poll().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
  }

  async poll() {
    if (this.polling) return this.polling;
    this.polling = this._poll().finally(() => { this.polling = null; });
    return this.polling;
  }

  async _poll() {}
}

module.exports = { BaseStream };
