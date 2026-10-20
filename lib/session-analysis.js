'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const zlib = require('node:zlib');
const { costOf } = require('./pricing');
const { stateFrom, describe } = require('./live');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_SCAN = 24 * 1024 * 1024;
const TAIL_SCAN = 8 * 1024 * 1024;

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

function analyzeEvents(events, now = Date.now()) {
  const openSteps = new Map();
  const openTurns = new Set();
  const jobs = new Map();
  let lastEventAt = 0;
  let lastEndAt = 0;
  let sessionTitle = null;
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
  const turns = new Map();

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

  for (const ev of events) {
    const t = ev && ev.type;
    if (!t) continue;
    if (typeof ev.time === 'number') lastEventAt = Math.max(lastEventAt, ev.time);
    const d = ev.data || {};
    switch (t) {
      case 'session/title':
        // A `fallback` title is auto-derived from the first prompt; it is not a
        // real session title, so the picker prefers the last user message.
        if (d.title && (d.source?.kind !== 'fallback')) sessionTitle = String(d.title);
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
        openTurns.add(d.turn);
        const turn = turnFor(d.turn);
        if (turn && turn.startedAt === null) turn.startedAt = ev.time || 0;
        break;
      }
      case 'turn/end': {
        openTurns.delete(d.turn);
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
      case 'job/registered':
        if (d.jobId) jobs.set(d.jobId, { jobId: d.jobId, startedAt: d.startedAt || ev.time, label: d.label || '' });
        break;
      case 'job/settled':
        if (d.jobId) jobs.delete(d.jobId);
        break;
      case 'assistant/message': {
        const u = d.usage;
        if (u) {
          const usage = {
            input: u.inputTokens || 0,
            output: u.outputTokens || 0,
            cacheRead: u.cacheReadTokens || 0,
            cacheWrite: u.cacheWriteTokens || 0,
          };
          input += usage.input;
          output += usage.output;
          cacheRead += usage.cacheRead;
          cacheWrite += usage.cacheWrite;
          const turnCost = costOf(usage, ev.time);
          cost += turnCost;
          const turn = turnFor(d.turn);
          if (turn) {
            turn.input += usage.input;
            turn.output += usage.output;
            turn.cacheRead += usage.cacheRead;
            turn.cacheWrite += usage.cacheWrite;
            turn.tokens = turn.input + turn.output + turn.cacheRead + turn.cacheWrite;
            turn.cost += turnCost;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const openJob = jobs.size ? [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0] : null;
  const openStep = openSteps.size ? [...openSteps.values()][0] : null;
  const openTurn = openTurns.size ? [...openTurns.values()][0] : null;
  const rawState = stateFrom({
    openJob: !!openJob,
    openStep: !!openStep,
    openTurn: !!openStep ? false : !!openTurn,
    lastEndAt,
    now,
  });
  const stateDetail = describe({
    state: rawState,
    openJob,
    openStep,
    openTurn: !openStep && openTurn ? { turn: openTurn } : null,
    lastEventAt,
    lastEndAt,
    now,
  });

  return {
    rawState,
    stateDetail,
    lastEventAt,
    lastEndAt,
    sessionTitle,
    firstUser,
    lastUser,
    title: sessionTitle || (lastUser || firstUser || '').slice(0, 60) || null,
    steps,
    input,
    output,
    cacheRead,
    cacheWrite,
    tokens: input + output + cacheRead + cacheWrite,
    cost,
    provider,
    model,
    contextWindow,
    preset,
    sandbox,
    policy,
    turns: [...turns.values()].sort((a, b) => a.turn - b.turn),
    openJobs: [...jobs.values()],
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
  }
  return { result, size: st.size, mtimeMs: st.mtimeMs };
}

module.exports = { analyzeLog, analyzeEvents, realUserText, decodeFrames };
