'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const zlib = require('node:zlib');
const { dshCost } = require('./pricing');
const problems = require('./problems');
const { stateFrom, describe, closeTurn, startTurn } = require('./live');
const { trackApproval, approvalRef } = require('./attention');
const tiers = require('./tiers');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_SCAN = 24 * 1024 * 1024;
const TAIL_SCAN = 8 * 1024 * 1024;
const HEAD_SCAN = 1024 * 1024;
const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'notebook_edit']);

function findFrames(buf) {
  const out = [];
  let i = 0;
  while (i <= buf.length - 4) {
    const at = buf.indexOf(ZSTD_MAGIC, i);
    if (at === -1) break;
    out.push(at);
    i = at + 4;
  }
  return out;
}

function decodeFrames(buf) {
  const frames = findFrames(buf);
  const events = [];
  for (let i = 0; i < frames.length; i++) {
    const end = i + 1 < frames.length ? frames[i + 1] : buf.length;
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(frames[i], end)).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* skip malformed line */
      }
    }
  }
  return events;
}

async function readRange(logPath, start, length) {
  const buf = Buffer.alloc(length);
  let fh;
  try {
    fh = await fsp.open(logPath, 'r');
    let got = 0;
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, start + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function realUserText(text) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  if (one.length < 8) return null;
  if (one.startsWith('<')) return null;
  if (/system-reminder|runtime context|Time sampled while preparing|environment_context|approval policy changed|^\s*\[Request interrupted/i.test(one)) return null;
  return one;
}

function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

/** The display state from log facts; an open step hides its open turn, the page shows one running thing. */
function deriveState({ openJob, openStep, openTurn, lastEventAt, lastEndAt }, now = Date.now()) {
  const step = openStep || null;
  const turn = openTurn != null ? { turn: openTurn } : null;
  const rawState = stateFrom({ openJob: !!openJob, openStep: !!step, openTurn: !!turn, lastEventAt, lastEndAt, now });
  const stateDetail = describe({ state: rawState, openJob, openStep: step, openTurn: turn, lastEventAt, lastEndAt, now });
  return { rawState, stateDetail };
}

/** A cached analysis ages: its state is derived again for `now`, so an open step that went quiet stops being live. */
function restate(analysis, now = Date.now()) {
  return analysis ? { ...analysis, ...deriveState(analysis, now) } : analysis;
}

function analyzeEvents(events, now = Date.now()) {
  const openSteps = new Map();
  const openTurns = new Set();
  // Permission prompts asked and not yet decided, for the "needs you" state.
  const openApprovals = new Map();
  const jobs = new Map();
  let lastEventAt = 0;
  let lastEndAt = 0;
  let sessionTitle = null;
  let fallbackTitle = null;
  let firstUser = null;
  let lastUser = null;
  let steps = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let provider = null;
  let model = null;
  let contextWindow = null;
  let preset = null;
  let sandbox = null;
  let policy = null;
  let problem = null; // the latest provider problem nothing has resolved yet
  const turns = new Map();
  // What the agent did last, and which files it wrote, for the agents overview.
  let lastTool = null;
  const touched = new Map();

  const turnFor = (number) => {
    if (!Number.isInteger(number)) return null;
    if (!turns.has(number)) {
      turns.set(number, {
        turn: number,
        startedAt: null,
        endedAt: null,
        steps: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tokens: 0,
        cost: 0,
      });
    }
    return turns.get(number);
  };

  // Tokens always count; cost only when the reply's own provider and model have a list price.
  const unpriced = new Set();
  let pricedTokens = 0;
  const countUsage = (u, time, turnNo, replyProvider, replyModel) => {
    if (!u) return;
    const usage = {
      input: u.inputTokens || 0,
      output: u.outputTokens || 0,
      cacheRead: u.cacheReadTokens || 0,
      cacheWrite: u.cacheWriteTokens || 0,
    };
    const all = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead;
    cacheWrite += usage.cacheWrite;
    // A reply that names no route was served by the route the request announced.
    const replyCost = dshCost(usage, time, replyProvider || provider, replyModel || model);
    if (replyCost !== null) {
      cost += replyCost;
      pricedTokens += all;
    } else if (all > 0) {
      unpriced.add(String(replyProvider || provider || 'unknown'));
    }
    const turn = turnFor(turnNo);
    if (turn) {
      turn.input += usage.input;
      turn.output += usage.output;
      turn.cacheRead += usage.cacheRead;
      turn.cacheWrite += usage.cacheWrite;
      turn.tokens = turn.input + turn.output + turn.cacheRead + turn.cacheWrite;
      turn.cost += replyCost || 0;
    }
  };

  for (const ev of events) {
    const t = ev && ev.type;
    if (!t) continue;
    if (typeof ev.time === 'number') lastEventAt = Math.max(lastEventAt, ev.time);
    const d = ev.data || {};
    problem = problems.next(problem, ev, { provider, model });
    switch (t) {
      case 'session/title':
        // A `fallback` title is auto-derived from the first prompt; it is not a
        // real session title, so the picker prefers the last user message.
        if (d.title && (d.source?.kind !== 'fallback')) sessionTitle = String(d.title);
        // Still the only name a session has when its prompts are too short to count ("review").
        else if (d.title) fallbackTitle = String(d.title);
        break;
      case 'user/message': {
        const kind = d.source && d.source.kind;
        const text = realUserText(blockText(d.content));
        if (text && (kind === undefined || kind === 'user')) {
          if (!firstUser) firstUser = text;
          lastUser = text;
        }
        break;
      }
      case 'step/start': {
        steps++;
        openSteps.set(`${d.turn}:${d.step}`, { turn: d.turn, step: d.step });
        const turn = turnFor(d.turn);
        if (turn) turn.steps += 1;
        break;
      }
      case 'step/end':
        openSteps.delete(`${d.turn}:${d.step}`);
        lastEndAt = Math.max(lastEndAt, ev.time || 0);
        break;
      case 'turn/start': {
        startTurn(openSteps, openTurns, d.turn);
        const turn = turnFor(d.turn);
        if (turn && turn.startedAt === null) turn.startedAt = ev.time || 0;
        break;
      }
      case 'turn/end': {
        closeTurn(openSteps, openTurns, d.turn);
        const turn = turnFor(d.turn);
        if (turn && turn.endedAt === null) turn.endedAt = ev.time || 0;
        lastEndAt = Math.max(lastEndAt, ev.time || 0);
        break;
      }
      case 'request/context':
        if (d.provider) provider = String(d.provider);
        if (d.model) model = String(d.model);
        if (Number.isFinite(d.contextWindow)) contextWindow = d.contextWindow;
        break;
      case 'permission/preset':
        if (d.preset) preset = String(d.preset);
        break;
      case 'sandbox/mode':
        if (d.mode) sandbox = String(d.mode);
        break;
      case 'approval/policy':
        if (d.policy) policy = String(d.policy);
        break;
      case 'tool/call': {
        let args = {};
        try { args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : (d.arguments || {}); } catch { args = {}; }
        const name = String(d.name || '');
        const file = typeof args.file_path === 'string' ? args.file_path : (typeof args.path === 'string' ? args.path : null);
        const label = typeof args.command === 'string' ? args.command : (file || (typeof args.pattern === 'string' ? args.pattern : ''));
        lastTool = { name, label: String(label).slice(0, 300), at: ev.time || 0 };
        if (file && WRITE_TOOLS.has(name)) touched.set(file, ev.time || 0);
        break;
      }
      case 'approval/asked':
        trackApproval(openApprovals, { t: 'approval', id: approvalRef(ev), callId: d.callId, toolName: d.toolName, time: ev.time || 0, seq: ev.seq });
        break;
      case 'approval/decided':
        trackApproval(openApprovals, { t: 'approvalDone', id: approvalRef(ev), callId: d.callId });
        break;
      case 'job/registered':
        if (d.jobId) jobs.set(d.jobId, { jobId: d.jobId, startedAt: d.startedAt || ev.time, label: d.label || '' });
        break;
      case 'job/settled':
        if (d.jobId) jobs.delete(d.jobId);
        break;
      case 'assistant/message': {
        const src = d.message && d.message.source;
        countUsage(d.usage, ev.time, d.turn, src && src.provider, src && src.model);
        break;
      }
      case 'compaction/summary':
        // A model call of its own, on its own route; it spends tokens and money like a reply.
        countUsage(d.usage, ev.time, d.turn, d.provider ?? d.source?.provider, d.model ?? d.source?.model);
        break;
      default:
        break;
    }
  }

  const openJob = jobs.size ? [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0] : null;
  const openStep = openSteps.size ? [...openSteps.values()][0] : null;
  const openTurn = openTurns.size ? [...openTurns.values()][0] : null;
  const { rawState, stateDetail } = deriveState({ openJob, openStep, openTurn, lastEventAt, lastEndAt }, now);

  return {
    rawState,
    stateDetail,
    openTurn,
    lastEventAt,
    lastEndAt,
    sessionTitle,
    firstUser,
    lastUser,
    title: sessionTitle || (lastUser || firstUser || fallbackTitle || '').slice(0, 60) || null,
    steps,
    input,
    output,
    cacheRead,
    cacheWrite,
    tokens: input + output + cacheRead + cacheWrite,
    // No figure at all when nothing in the session has a list price (not a misleading $0).
    cost: unpriced.size && !pricedTokens ? null : cost,
    unpriced: [...unpriced].sort(),
    problem: problems.forPage(problem),
    provider,
    model,
    contextWindow,
    preset,
    sandbox,
    policy,
    permission: tiers.fromDsh({ preset, sandbox, policy }),
    turns: [...turns.values()].sort((a, b) => a.turn - b.turn),
    lastTool,
    touched: [...touched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([file, at]) => ({ path: file, at })),
    openJobs: [...jobs.values()],
    openApprovals: [...openApprovals.values()],
    openJob,
    openStep,
    complete: true,
  };
}

async function analyzeLog(logPath, now = Date.now()) {
  let st;
  try {
    st = await fsp.stat(logPath);
  } catch {
    return null;
  }
  let buf;
  let complete = true;
  if (st.size > MAX_SCAN) {
    const len = Math.min(st.size, TAIL_SCAN);
    buf = await readRange(logPath, st.size - len, len);
    complete = false;
  } else {
    buf = await readRange(logPath, 0, st.size);
  }
  if (!buf || !buf.length) return null;
  const events = decodeFrames(buf);
  const result = analyzeEvents(events, now);
  if (!complete) {
    result.steps = null;
    result.tokens = null;
    result.cost = null;
    result.turns = null;
    result.complete = false;
    // The mode is set near the start of the log, which the tail does not reach:
    // read the head for it, and let the tail's later values win. Without a whole
    // reading a lone value would mislead, so it stays unknown (never hidden as safe).
    const head = await readRange(logPath, 0, Math.min(st.size, HEAD_SCAN));
    const early = head && head.length ? analyzeEvents(decodeFrames(head), now) : null;
    const perm = {
      preset: result.preset || (early && early.preset) || null,
      sandbox: result.sandbox || (early && early.sandbox) || null,
      policy: result.policy || (early && early.policy) || null,
    };
    result.permission = perm.preset || (perm.sandbox && perm.policy) ? tiers.fromDsh(perm) : tiers.unknown();
  }
  return { result, size: st.size, mtimeMs: st.mtimeMs };
}

module.exports = { analyzeLog, analyzeEvents, restate, realUserText, decodeFrames };
