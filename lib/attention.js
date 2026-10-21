'use strict';

/**
 * "Needs you": the one question every agent source answers the same way.
 *
 * An attention record says whether an agent is blocked on a human, ready for
 * the next prompt, or neither, and how sure we are:
 *
 *   level      needs-you | ready | none
 *   reason     permission | question | sandbox | dialog | input | auth | unknown
 *   since      ms since epoch the state began (best effort)
 *   via        acp | status-file | hook | log | transcript
 *   certainty  sure | probable | guess
 *   tool       a tool name only (Bash, AskUserQuestion), never a command
 *   detail     a short fixed phrase ("permission prompt"), never agent text
 *
 * Sources produce records; the server merges them per session so one agent is
 * counted once however many signals saw it. Nothing here reads files or
 * touches the network. Command text and paths never enter a record, so a
 * record is safe to show in stream mode.
 */

const { OPEN_TURN_MS } = require('./live');

const LEVELS = ['needs-you', 'ready', 'none'];
const REASONS = ['permission', 'question', 'sandbox', 'dialog', 'input', 'auth', 'unknown'];
const VIAS = ['acp', 'status-file', 'hook', 'log', 'transcript'];
const CERTAINTIES = ['sure', 'probable', 'guess'];

// How long an unanswered Claude Code question counts when no live process
// confirms it. Questions wait for a person, so this is longer than a turn.
const QUESTION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const NONE = Object.freeze({ level: 'none' });

const LEVEL_RANK = { 'needs-you': 2, ready: 1, none: 0 };
const CERTAINTY_RANK = { sure: 3, probable: 2, guess: 1 };
const VIA_RANK = { acp: 5, 'status-file': 4, hook: 3, log: 2, transcript: 1 };

/** A tool name that is safe to show: short, no spaces, no path or command. */
function safeToolName(value) {
  const s = String(value ?? '').trim();
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/.test(s) ? s : null;
}

/** Fixed phrases only: agent-written text never becomes an attention detail. */
const DETAILS = new Set([
  'permission prompt', 'question', 'plan approval', 'input needed',
  'sandbox request', 'worker request', 'dialog open', 'waiting for you',
]);
function safeDetail(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return DETAILS.has(s) ? s : null;
}

function finiteMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Build a normalized record; unknown values fall back, never throw. */
function make(fields = {}) {
  const level = LEVELS.includes(fields.level) ? fields.level : 'none';
  if (level === 'none') return NONE;
  const out = {
    level,
    reason: level === 'needs-you'
      ? (REASONS.includes(fields.reason) ? fields.reason : 'unknown')
      : null,
    since: finiteMs(fields.since),
    via: VIAS.includes(fields.via) ? fields.via : 'log',
    certainty: CERTAINTIES.includes(fields.certainty) ? fields.certainty : 'probable',
  };
  const tool = safeToolName(fields.tool);
  if (tool && level === 'needs-you') out.tool = tool;
  const detail = safeDetail(fields.detail);
  if (detail) out.detail = detail;
  return out;
}

const none = () => NONE;
const needsYou = (fields) => make({ certainty: 'sure', ...fields, level: 'needs-you' });
const ready = (fields) => make({ certainty: 'sure', ...fields, level: 'ready' });

const isNeedsYou = (att) => !!att && att.level === 'needs-you';
const isReady = (att) => !!att && att.level === 'ready';
/** Desktop notifications fire for these only; a guess stays a quiet label. */
const notifiable = (att) => isNeedsYou(att) && (att.certainty === 'sure' || att.certainty === 'probable');

/** The stronger of two records: level, then certainty, then closeness to the source. */
function better(a, b) {
  const x = a || NONE;
  const y = b || NONE;
  const lx = LEVEL_RANK[x.level] || 0;
  const ly = LEVEL_RANK[y.level] || 0;
  if (lx !== ly) return lx > ly ? x : y;
  const cx = CERTAINTY_RANK[x.certainty] || 0;
  const cy = CERTAINTY_RANK[y.certainty] || 0;
  if (cx !== cy) return cx > cy ? x : y;
  const vx = VIA_RANK[x.via] || 0;
  const vy = VIA_RANK[y.via] || 0;
  if (vx !== vy) return vx > vy ? x : y;
  // Same strength: the one that has waited longer.
  return (x.since || Infinity) <= (y.since || Infinity) ? x : y;
}

/** A short string that changes when the record does, to skip duplicate status events. */
function key(att) {
  const a = att || NONE;
  return a.level === 'none' ? 'none' : [a.level, a.reason, a.since, a.via, a.certainty, a.tool, a.detail].join('~');
}

/** One record per session from any number of signals (acp beats log, and so on). */
function merge(...candidates) {
  let out = NONE;
  for (const c of candidates) out = better(out, c);
  return out;
}

/** Order for lists: needs-you first, then the longest wait first. */
function compareForList(a, b) {
  const x = a || NONE;
  const y = b || NONE;
  const l = (LEVEL_RANK[y.level] || 0) - (LEVEL_RANK[x.level] || 0);
  if (l) return l;
  if (x.level === 'needs-you') return (x.since || Infinity) - (y.since || Infinity);
  return 0;
}

function countNeedsYou(list) {
  let n = 0;
  for (const item of list || []) if (isNeedsYou(item && item.attention !== undefined ? item.attention : item)) n++;
  return n;
}

/** The shape sent to the page: tool and detail pass the redactor once more. */
function forPage(att, text = (s) => s) {
  if (!att || att.level === 'none') return NONE;
  const out = { ...att };
  if (out.tool) out.tool = text(out.tool);
  if (out.detail) out.detail = text(out.detail);
  return out;
}

/* ---------------------------------------------------------------- dsh --- */

/**
 * dsh logs: `approval/asked` opens a prompt, `approval/decided` closes it.
 * `open` is a Map of id -> { id, at, tool }. A prompt left open by a crash or
 * a closed window stops counting once it is older than OPEN_TURN_MS or the
 * session no longer looks live.
 */
function dshAttention({ open, rawState, now = Date.now(), hasOpenJob = false }) {
  if (open && open.size && rawState === 'live') {
    let oldest = null;
    for (const ask of open.values()) {
      if (now - (ask.at || now) >= OPEN_TURN_MS) continue;
      if (!oldest || (ask.at || 0) < (oldest.at || 0)) oldest = ask;
    }
    if (oldest) {
      return needsYou({ reason: 'permission', since: oldest.at, via: 'log', certainty: 'sure', tool: oldest.tool, detail: 'permission prompt' });
    }
  }
  if (rawState === 'idle' && !hasOpenJob) return ready({ via: 'log', certainty: 'sure' });
  return NONE;
}

/** The id a dsh log gives an approval, wherever the log keeps it; null when it has none. */
function approvalRef(ev) {
  const d = (ev && ev.data) || {};
  const value = d.id ?? d.approvalId ?? d.requestId ?? (ev && ev.id);
  return value === undefined || value === null || value === '' ? null : String(value).slice(0, 128);
}

/** Track the ask/decided events of a dsh log into `open` (a Map). */
function trackApproval(open, event) {
  if (!event || !open) return;
  if (event.t === 'approval') {
    const key = event.id || event.callId || `seq:${event.seq}`;
    open.set(key, { id: key, callId: event.callId || null, at: event.time || 0, tool: safeToolName(event.toolName) });
    // A log that never closes its prompts must not grow without bound.
    if (open.size > 50) open.delete(open.keys().next().value);
  } else if (event.t === 'approvalDone') {
    const find = (ref) => {
      if (!ref) return undefined;
      if (open.has(ref)) return ref;
      for (const [key, ask] of open) if (ask.id === ref || ask.callId === ref) return key;
      return undefined;
    };
    const target = find(event.id) ?? find(event.callId);
    if (target !== undefined) open.delete(target);
    // A decision that names nothing closes the oldest prompt.
    else if (!event.id && !event.callId && open.size) open.delete(open.keys().next().value);
  }
}

/* ------------------------------------------------------------- Claude --- */

const WAITING_FOR = {
  'permission prompt': { reason: 'permission', detail: 'permission prompt' },
  'input needed': { reason: 'input', detail: 'input needed' },
  'sandbox request': { reason: 'sandbox', detail: 'sandbox request' },
  'worker request': { reason: 'unknown', detail: 'worker request' },
  'dialog open': { reason: 'dialog', detail: 'dialog open' },
};

function waitingKey(value) {
  return String(value ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Claude Code tools that wait for an answer only a person can give. */
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Claude Code: the status file (when its process is alive) is authoritative;
 * without it the transcript is read for an unanswered question or plan, and
 * for a turn that ended. Any other open tool call says nothing: it looks the
 * same whether a person is deciding or the command is slow.
 *
 * status    { status: busy|idle|waiting, waitingFor, since } or null
 * question  { name, at } (an unanswered AskUserQuestion / ExitPlanMode) or null
 * openTool  name of the newest unanswered tool call, for the label only
 */
function claudeAttention({ status = null, question = null, turnOpen = false, state = 'finished', lastEventAt = 0, openTool = null, now = Date.now() }) {
  if (status && status.status) {
    if (status.status === 'waiting') {
      const known = WAITING_FOR[waitingKey(status.waitingFor)] || { reason: 'unknown', detail: 'waiting for you' };
      // A wait whose process start time could not be checked (the lookup failed
      // or timed out) may belong to a reused pid: a quiet guess, no notification.
      const certainty = status.startCheck === 'unverified' ? 'guess' : 'sure';
      return needsYou({ reason: known.reason, since: status.since, via: 'status-file', certainty, tool: openTool, detail: known.detail });
    }
    if (status.status === 'idle') return state === 'idle' ? ready({ since: status.since, via: 'status-file', certainty: 'sure' }) : NONE;
    return NONE; // busy
  }
  if (question && now - (question.at || now) < QUESTION_MAX_AGE_MS) {
    return needsYou({
      reason: 'question',
      since: question.at,
      via: 'transcript',
      certainty: 'probable',
      tool: question.name,
      detail: question.name === 'ExitPlanMode' ? 'plan approval' : 'question',
    });
  }
  if (state === 'idle' && !turnOpen) return ready({ since: lastEventAt, via: 'transcript', certainty: 'probable' });
  return NONE;
}

/* -------------------------------------------------------- Antigravity --- */

/**
 * Antigravity CLI: a tool confirmation its log shows open (its process alive)
 * whose step the transcript has not written yet; a step that appears there has
 * been answered. The log was seen closing a prompt only in print mode so far,
 * so a confirmed process gives a probable wait and an unchecked one a guess.
 *
 * prompt   { tool, step, since, startCheck: match | unverified } or null
 * maxStep  highest step_index in the transcript (-1 when none)
 */
function antigravityAttention({ prompt = null, maxStep = -1 }) {
  if (!prompt || !Number.isInteger(prompt.step) || maxStep >= prompt.step) return NONE;
  const certainty = prompt.startCheck === 'match' ? 'probable' : 'guess';
  return needsYou({ reason: 'permission', since: prompt.since, via: 'log', certainty, tool: prompt.tool, detail: 'permission prompt' });
}

/* -------------------------------------------------------------- owned --- */

// ACP tool kinds as short labels; unknown kinds are shown as no tool at all.
const KIND_LABEL = {
  execute: 'command', edit: 'edit', delete: 'delete', move: 'move', read: 'read',
  search: 'search', fetch: 'fetch', think: 'think', switch_mode: 'mode',
};

/**
 * A session agenttail owns: its pending approvals are known exactly, so the
 * signal is sure and has no polling delay. Only a kind label is used for the
 * tool, never the title or the command the agent wrote.
 */
function ownedAttention(approvals) {
  const list = Array.isArray(approvals) ? approvals.filter(Boolean) : [];
  if (!list.length) return NONE;
  let first = list[0];
  for (const a of list) if ((a.createdAt || 0) < (first.createdAt || 0)) first = a;
  const named = safeToolName(first.toolName);
  const kind = KIND_LABEL[String(first.toolKind || first.kind || '').toLowerCase()] || null;
  return needsYou({ reason: 'permission', since: first.createdAt, via: 'acp', certainty: 'sure', tool: named || kind, detail: 'permission prompt' });
}

module.exports = {
  LEVELS, REASONS, VIAS, CERTAINTIES, QUESTION_MAX_AGE_MS, QUESTION_TOOLS,
  make, none, key, needsYou, ready, isNeedsYou, isReady, notifiable,
  better, merge, compareForList, countNeedsYou, forPage, safeToolName,
  dshAttention, trackApproval, approvalRef, claudeAttention, antigravityAttention, ownedAttention,
};
