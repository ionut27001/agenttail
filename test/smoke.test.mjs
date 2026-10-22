// End-to-end smoke test: fixture session logs, HTTP API, SSE replay + live tail.
// Run: node test/smoke.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildFixture, frame, ev } from './fixture.mjs';
import { LiveTracker, stateFrom, OPEN_TURN_MS } from '../lib/live.js';
import { analyzeEvents, restate } from '../lib/session-analysis.js';
import { dshCost } from '../lib/pricing.js';
import { kindOf, fromEvent, next as nextProblem } from '../lib/problems.js';

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = path.join(import.meta.dirname, '.tmp');
const fixture = buildFixture(tmp);

// A third session: old mtime, but a background job is still open. It also
// redirects output to a log file, which the dashboard tails while it runs.
const jobSessionId = 'session-77777777-6666-5555-4444-333333333333';
const jobSessionDir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', jobSessionId);
fs.mkdirSync(jobSessionDir, { recursive: true });
const jobLogFile = path.join(fixture.workspace, 'build.log');
fs.writeFileSync(jobLogFile, 'ninja: [1/10] compile\n');
const jobCommand = `$log='${jobLogFile}'; cmake --build build *> $log`;
const jobSessionLog = path.join(jobSessionDir, 'session.v4.jsonl.zstd');
fs.writeFileSync(jobSessionLog, frame([
  {
    type: 'session', version: 4, id: jobSessionId, createdAt: Date.now() - 200000,
    cwd: fixture.workspace, isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  },
  ev('step/start', 1, { turn: 1, step: 1 }),
  ev('tool/call', 2, {
    turn: 1, step: 1, callId: 'call_job', name: 'pwsh',
    arguments: JSON.stringify({ command: jobCommand, workdir: fixture.workspace }),
  }),
  {
    type: 'job/registered', seq: 3, time: Date.now() - 90000,
    data: {
      jobId: 'job-open', owner: jobSessionId, kind: 'pwsh', label: jobCommand,
      startedAt: Date.now() - 90000,
      toolCall: { callId: 'call_job', rootCallId: 'call_job' },
    },
  },
]));
const oldTime = new Date(Date.now() - 120000);
fs.utimesSync(jobSessionLog, oldTime, oldTime);

// An idle session: the turn ended two minutes ago.
const idleSessionId = 'session-88888888-7777-6666-5555-444444444444';
const idleDir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', idleSessionId);
fs.mkdirSync(idleDir, { recursive: true });
const idleLog = path.join(idleDir, 'session.v4.jsonl.zstd');
fs.writeFileSync(idleLog, frame([
  { type: 'session', version: 4, id: idleSessionId, createdAt: Date.now() - 300000, cwd: fixture.workspace },
  ev('turn/start', 1, { turn: 1 }),
  ev('step/start', 2, { turn: 1, step: 1 }),
  { ...ev('step/end', 3, { turn: 1, step: 1 }), time: Date.now() - 120000 },
  { ...ev('turn/end', 4, { turn: 1 }), time: Date.now() - 120000 },
]));
fs.utimesSync(idleLog, new Date(Date.now() - 120000), new Date(Date.now() - 120000));

// A session with an open step whose file grows while its mtime stays stale.
const growSessionId = 'session-99999999-0000-1111-2222-333333333333';
const growDir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', growSessionId);
fs.mkdirSync(growDir, { recursive: true });
const growLog = path.join(growDir, 'session.v4.jsonl.zstd');
fs.writeFileSync(growLog, frame([
  { type: 'session', version: 4, id: growSessionId, createdAt: Date.now() - 300000, cwd: fixture.workspace },
  ev('turn/start', 1, { turn: 1 }),
  ev('step/start', 2, { turn: 1, step: 1 }),
]));
fs.appendFileSync(growLog, frame([ev('assistant/message', 3, {
  turn: 1, step: 1,
  message: { role: 'assistant', content: [{ type: 'text', text: 'still working' }] },
  usage: null,
})]));
fs.utimesSync(growLog, new Date(Date.now() - 600000), new Date(Date.now() - 600000));

// A finished turn whose only remaining job is detached (e.g. a started server).
const bgSessionId = 'session-12121212-3434-5656-7878-909090909090';
const bgDir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', bgSessionId);
fs.mkdirSync(bgDir, { recursive: true });
const bgLog = path.join(bgDir, 'session.v4.jsonl.zstd');
fs.writeFileSync(bgLog, frame([
  { type: 'session', version: 4, id: bgSessionId, createdAt: Date.now() - 400000, cwd: fixture.workspace },
  ev('turn/start', 1, { turn: 1 }),
  ev('step/start', 2, { turn: 1, step: 1 }),
  { ...ev('step/end', 3, { turn: 1, step: 1 }), time: Date.now() - 180000 },
  { ...ev('turn/end', 4, { turn: 1 }), time: Date.now() - 180000 },
  {
    type: 'job/registered', seq: 5, time: Date.now() - 3600000,
    data: {
      jobId: 'pwsh-detached', owner: bgSessionId, kind: 'pwsh', label: 'node server.js',
      startedAt: Date.now() - 3600000,
      toolCall: { callId: 'call_detached', rootCallId: 'call_detached' },
    },
  },
]));
fs.utimesSync(bgLog, new Date(Date.now() - 180000), new Date(Date.now() - 180000));

// Open turn and step whose newest event is `agoMs` old, for the open-turn cutoff.
function openStepLog(sessionId, agoMs) {
  const dir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const at = (seq, type, data) => ({ ...ev(type, seq, data), time: Date.now() - agoMs + seq });
  const log = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(log, frame([
    { type: 'session', version: 4, id: sessionId, createdAt: Date.now() - agoMs - 1000, cwd: fixture.workspace },
    at(1, 'turn/start', { turn: 1 }),
    at(2, 'step/start', { turn: 1, step: 1 }),
    at(3, 'tool/call', { turn: 1, step: 1, callId: 'call_wait', name: 'pwsh', arguments: JSON.stringify({ command: 'npm run slow', workdir: fixture.workspace }) }),
  ]));
  return log;
}
// A run that died mid-step three hours ago, and a tool that has been quiet for twenty minutes.
const staleSessionId = 'session-abababab-1111-2222-3333-444444444444';
openStepLog(staleSessionId, 3 * 60 * 60 * 1000);
const quietSessionId = 'session-cdcdcdcd-1111-2222-3333-444444444444';
openStepLog(quietSessionId, 20 * 60 * 1000);

// A step left open by an earlier turn, a later turn that ends cleanly, and a turn that gave up with an
// error without writing step/end: none of them is still running once its turn has ended.
function turnsLog(sessionId, build) {
  const dir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  let seq = 1;
  const at = (agoMs, type, data) => ({ type, seq: seq++, time: Date.now() - agoMs, data });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frame([
    { type: 'session', version: 4, id: sessionId, createdAt: Date.now() - 3 * 60 * 60 * 1000, cwd: fixture.workspace },
    ...build(at),
  ]));
}
const orphanSessionId = 'session-b1b1b1b1-1111-2222-3333-444444444444';
turnsLog(orphanSessionId, (at) => [
  at(50 * 60 * 1000, 'turn/start', { turn: 1 }),
  at(50 * 60 * 1000 - 1, 'step/start', { turn: 1, step: 1 }),
  at(3 * 60 * 1000, 'turn/start', { turn: 2 }),
  at(3 * 60 * 1000 - 1, 'step/start', { turn: 2, step: 1 }),
  at(2 * 60 * 1000, 'step/end', { turn: 2, step: 1 }),
  at(2 * 60 * 1000 - 1, 'turn/end', { turn: 2 }),
]);
const erroredSessionId = 'session-b2b2b2b2-1111-2222-3333-444444444444';
turnsLog(erroredSessionId, (at) => [
  at(25 * 60 * 1000, 'turn/start', { turn: 1 }),
  at(25 * 60 * 1000 - 1, 'step/start', { turn: 1, step: 1 }),
  at(20 * 60 * 1000, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', status: 402 } } }),
]);
// An old open step, but the provider was still answering (and failing) five minutes ago: the list sees
// the attempt, so the stream, which does not project it, has to see it too.
const attemptingSessionId = 'session-b3b3b3b3-1111-2222-3333-444444444444';
turnsLog(attemptingSessionId, (at) => [
  at(40 * 60 * 1000, 'turn/start', { turn: 1 }),
  at(40 * 60 * 1000 - 1, 'step/start', { turn: 1, step: 1 }),
  at(5 * 60 * 1000, 'assistant/attempt', { turn: 1, step: 1, stream: [{ chunk: { reason: { failure: { code: 'RATE_LIMIT', status: 429 } } } }] }),
  at(4 * 60 * 1000, 'llm/retry', { attempt: 1, max: 5, delayMs: 2000 }),
]);

// Cost per provider and model, at a fixed off-peak time (a Saturday): each million-token reply on a
// different route, a compaction call, and a last reply that names no route and takes the request's.
const costAt = Date.UTC(2026, 9, 17, 12, 0, 0);
const MILLION = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
const costEvent = (seq, type, data) => ({ type, seq, time: costAt + seq * 1000, data });
const costReply = (seq, source) => costEvent(seq, 'assistant/message', {
  turn: 1, step: seq,
  message: { role: 'assistant', ...(source ? { source } : {}), content: [{ type: 'text', text: `reply ${seq}` }] },
  usage: MILLION,
});
function costLog(sessionId, events) {
  const dir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frame([
    { type: 'session', version: 4, id: sessionId, createdAt: costAt, cwd: fixture.workspace },
    costEvent(1, 'turn/start', { turn: 1 }),
    ...events,
    costEvent(20, 'turn/end', { turn: 1 }),
  ]));
}
const costSessionId = 'session-efefefef-1111-2222-3333-444444444444';
costLog(costSessionId, [
  costReply(2, { provider: 'deepseek-official', model: 'deepseek-flash' }),
  costReply(3, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
  costReply(4, { provider: 'deepseek-account', model: 'deepseek-flash' }),
  costReply(5, { provider: 'ollama', model: 'minimax-m3.1-flash:cloud' }),
  costEvent(6, 'compaction/summary', { provider: 'deepseek-official', model: 'deepseek-flash', usage: MILLION }),
  costEvent(7, 'request/context', { provider: 'deepseek-official', model: 'deepseek-v4-pro', contextWindow: 1_000_000 }),
  costReply(8, null),
]);
const ollamaSessionId = 'session-fafafafa-1111-2222-3333-444444444444';
costLog(ollamaSessionId, [costReply(2, { provider: 'ollama', model: 'minimax-m3.1-flash:cloud' })]);

// Provider problems. dsh logs them only in assistant/attempt failures, llm/retry and the error of turn/end.
const PROBLEM_SECRET = 'sk-live-PROBLEMSECRET1234567890';
function problemLog(sessionId, agoMs, build) {
  const dir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  let seq = 1;
  const at = (offset, type, data) => ({ type, seq: seq++, time: Date.now() - agoMs + offset, data });
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), frame([
    { type: 'session', version: 4, id: sessionId, createdAt: Date.now() - agoMs - 5000, cwd: fixture.workspace },
    at(0, 'request/context', { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 1_000_000 }),
    at(1, 'turn/start', { turn: 1 }),
    at(2, 'step/start', { turn: 1, step: 1 }),
    ...build(at),
  ]));
}
const failure = (code, status) => ({ code, ...(status ? { status } : {}), message: `${code} for key ${PROBLEM_SECRET}` });
const attemptOf = (at, offset, f) => at(offset, 'assistant/attempt', { turn: 1, step: 1, stream: [{ chunk: { reason: { failure: f } } }] });
const turnError = (at, offset, f) => at(offset, 'turn/end', { turn: 1, reason: { kind: 'error', error: f } });
const okReply = (at, offset, turn = 1) => at(offset, 'assistant/message', {
  turn, step: 1,
  message: { role: 'assistant', source: { provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'text', text: 'done' }] },
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
const MIN = 60 * 1000;
const problemIds = {
  quota: 'session-a1a1a1a1-1111-2222-3333-444444444444',
  retried: 'session-a2a2a2a2-1111-2222-3333-444444444444',
  credential: 'session-a3a3a3a3-1111-2222-3333-444444444444',
  recovered: 'session-a4a4a4a4-1111-2222-3333-444444444444',
  newTurn: 'session-a5a5a5a5-1111-2222-3333-444444444444',
  old: 'session-a6a6a6a6-1111-2222-3333-444444444444',
  timeout: 'session-a7a7a7a7-1111-2222-3333-444444444444',
};
// Out of credit: the attempt fails with 402 and the turn gives up with the same error.
problemLog(problemIds.quota, 5 * MIN, (at) => [
  attemptOf(at, 3, failure('QUOTA', 402)),
  at(4, 'step/end', { turn: 1, step: 1 }),
  turnError(at, 5, failure('QUOTA', 402)),
]);
// Rate limited twice, retried, then it works: nothing is left to resolve.
problemLog(problemIds.retried, 5 * MIN, (at) => [
  attemptOf(at, 3, failure('RATE_LIMIT', 429)),
  at(4, 'llm/retry', { attempt: 1, max: 5, delayMs: 2000 }),
  okReply(at, 8),
  at(9, 'step/end', { turn: 1, step: 1 }),
  at(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
]);
problemLog(problemIds.credential, 5 * MIN, (at) => [
  attemptOf(at, 3, failure('MISSING_CREDENTIAL')),
  at(4, 'step/end', { turn: 1, step: 1 }),
  turnError(at, 5, failure('MISSING_CREDENTIAL')),
]);
// Out of credit, then the person topped up and the next step worked.
problemLog(problemIds.recovered, 5 * MIN, (at) => [
  attemptOf(at, 3, failure('QUOTA', 402)),
  at(4, 'step/end', { turn: 1, step: 1 }),
  turnError(at, 5, failure('QUOTA', 402)),
  at(6, 'turn/start', { turn: 2 }),
  at(7, 'step/start', { turn: 2, step: 1 }),
  okReply(at, 8, 2),
  at(9, 'step/end', { turn: 2, step: 1 }),
  at(10, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
]);
// Out of credit, then only a new turn started: the old failure no longer describes the session.
problemLog(problemIds.newTurn, 5 * MIN, (at) => [
  attemptOf(at, 3, failure('QUOTA', 402)),
  turnError(at, 4, failure('QUOTA', 402)),
  at(5, 'turn/start', { turn: 2 }),
]);
// A failure from the day before: still the latest thing, but no longer a request for the person.
problemLog(problemIds.old, 8 * 60 * MIN, (at) => [
  attemptOf(at, 3, failure('QUOTA', 402)),
  turnError(at, 4, failure('QUOTA', 402)),
]);
problemLog(problemIds.timeout, 5 * MIN, (at) => [
  attemptOf(at, 3, failure('TIMEOUT')),
  turnError(at, 4, failure('TIMEOUT')),
]);

const failures = [];
function check(cond, msg, extra) {
  if (cond) {
    console.log(`  ok    ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL  ${msg}${extra ? ' :: ' + extra : ''}`);
  }
}

async function getJson(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json() };
}

function rawRequest(method, requestPath, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: requestPath,
      method,
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Reads an SSE stream and resolves when `stop(data, event)` returns true. */
async function readSse(url, stop, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const collected = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const eventLine = raw.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!eventLine || !dataLine) continue;
        const ev = { event: eventLine.slice(7).trim(), data: JSON.parse(dataLine.slice(6)) };
        collected.push(ev);
        if (stop(ev, collected)) {
          controller.abort();
          return collected;
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  } finally {
    clearTimeout(timer);
    try { controller.abort(); } catch {}
  }
  return collected;
}

const server = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
      AGENTTAIL_NO_OPEN: '1',
    DSH_SESSIONS_ROOT: fixture.sessionsRoot,
    // Never the machine's own Antigravity folders: a real conversation would join the fixtures.
    ANTIGRAVITY_ROOT: path.join(tmp, 'no-antigravity', 'brain'),
    DSH_NICKNAMES_FILE: path.join(tmp, 'nicknames.json'),
    DSH_POLL_MS: '150',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
server.stdout.on('data', (d) => process.stdout.write('  [server] ' + d));
server.stderr.on('data', (d) => process.stderr.write('  [server:err] ' + d));

let exitCode = 0;
try {
  // Wait for the server to listen.
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + '/api/sessions');
      if (r.ok) { up = true; break; }
    } catch {}
    await sleep(100);
  }
  check(up, 'server listens on 127.0.0.1:' + PORT);
  if (!up) throw new Error('server did not start');

  console.log('\nvendored assets');
  const xtermAsset = await fetch(BASE + '/vendor/xterm/xterm.css');
  check(xtermAsset.status === 200 && (await xtermAsset.text()).includes('.xterm'), 'vendored xterm CSS is served locally');
  const fontAsset = await fetch(BASE + '/vendor/fonts/jetbrains-mono-400.woff2');
  check(fontAsset.status === 200 && (await fontAsset.arrayBuffer()).byteLength > 1000, 'vendored font is served locally');
  const faviconAsset = await fetch(BASE + '/favicon.svg');
  check(faviconAsset.status === 200 && (faviconAsset.headers.get('content-type') || '').includes('image/svg+xml'), 'favicon is served locally');
  const traversalAsset = await fetch(BASE + '/vendor/../server.js');
  check(traversalAsset.status === 404, 'vendor path traversal is rejected');

  console.log('\nrequest origin checks');
  const foreignHost = await rawRequest('GET', '/api/sessions', { Host: 'agenttail.evil.example:8899' });
  check(foreignHost.status === 403, 'foreign Host is rejected', String(foreignHost.status));
  const localhostHost = await rawRequest('GET', '/api/sessions', { Host: `localhost:${PORT}` });
  check(localhostHost.status === 200, 'localhost Host is accepted', String(localhostHost.status));
  const foreignOrigin = await rawRequest('POST', '/api/nickname', {
    Host: `127.0.0.1:${PORT}`,
    Origin: 'http://evil.example',
    'Content-Type': 'application/json',
  }, '{}');
  check(foreignOrigin.status === 403, 'foreign Origin on POST is rejected', String(foreignOrigin.status));
  const missingOrigin = await rawRequest('POST', '/api/nickname', {
    Host: `127.0.0.1:${PORT}`,
    'Content-Type': 'application/json',
  }, '{}');
  check(missingOrigin.status === 403, 'missing Origin on POST is rejected', String(missingOrigin.status));
  const wrongType = await rawRequest('POST', '/api/nickname', {
    Host: `127.0.0.1:${PORT}`,
    Origin: BASE,
    'Content-Type': 'text/plain',
  }, '{}');
  check(wrongType.status === 403, 'non-JSON POST is rejected', String(wrongType.status));
  const foreignHostPost = await rawRequest('POST', '/api/nickname', {
    Host: 'evil.example:8899',
    Origin: BASE,
    'Content-Type': 'application/json',
  }, '{}');
  check(foreignHostPost.status === 403, 'foreign Host is rejected before POST handling', String(foreignHostPost.status));
  const crossHostOrigin = await rawRequest('POST', '/api/nickname', {
    Host: `localhost:${PORT}`,
    Origin: BASE,
    'Content-Type': 'application/json',
  }, '{}');
  check(crossHostOrigin.status === 403, 'Origin must match the Host header', String(crossHostOrigin.status));
  const localhostPost = await rawRequest('POST', '/api/nickname', {
    Host: `localhost:${PORT}`,
    Origin: `http://localhost:${PORT}`,
    'Content-Type': 'application/json',
  }, '{}');
  check(localhostPost.status === 400, 'a matching localhost Origin passes the security gate', String(localhostPost.status));

  console.log('\nsessions');
  const sessions = await getJson('/api/sessions');
  const ids = sessions.body.sessions.map((s) => s.id);
  check(sessions.status === 200, 'GET /api/sessions is 200');
  check(ids.includes(fixture.finishedId), 'finished fixture session is listed');
  check(ids.includes(fixture.liveId), 'live fixture session is listed');
  const finished = sessions.body.sessions.find((s) => s.id === fixture.finishedId);
  check(finished.cwd === fixture.workspace, 'session cwd comes from the log', finished.cwd);
  check(finished.live === false, 'backdated session is reported finished');
  check(sessions.body.sessions[0].state === 'live', 'live sessions sort first', sessions.body.sessions[0].state);
  const srcPayload = await getJson('/api/sources');
  const dshSource = srcPayload.body.sources.find((s) => s.key === 'dsh');
  check(dshSource?.available === true && dshSource.count === sessions.body.sessions.length, 'source picker counts sessions', JSON.stringify(dshSource));
  check(finished.state === 'finished', 'a long-ended turn is finished', finished.state);
  const jobSession = sessions.body.sessions.find((s) => s.id === jobSessionId);
  check(jobSession?.live === true, 'an old log with an open job is still live', JSON.stringify({ live: jobSession?.live, mtimeMs: jobSession?.mtimeMs }));
  check(jobSession?.state === 'live' && /running/.test(jobSession?.stateDetail || ''), 'live state names the running step', jobSession?.stateDetail);
  const idle = sessions.body.sessions.find((s) => s.id === idleSessionId);
  check(idle?.state === 'idle', 'a turn that ended 2 min ago is idle', idle?.state);
  check(/idle since/.test(idle?.stateDetail || ''), 'idle state explains itself', idle?.stateDetail);
  const bg = sessions.body.sessions.find((s) => s.id === bgSessionId);
  check(bg?.state === 'idle', 'a detached background job is not live', JSON.stringify({ state: bg?.state, detail: bg?.stateDetail }));
  check(/background job/.test(bg?.stateDetail || ''), 'detached job state names the background job', bg?.stateDetail);
  const growing = sessions.body.sessions.find((s) => s.id === growSessionId);
  check(growing?.state === 'live', 'a growing log with a stale mtime is still live', JSON.stringify({ state: growing?.state, mtimeMs: growing?.mtimeMs }));
  check(growing?.size > 0, 'size-based activity is visible even when mtime is stale');

  console.log('\nopen-turn cutoff');
  const stale = sessions.body.sessions.find((s) => s.id === staleSessionId);
  check(stale?.state === 'finished' && stale?.live === false, 'an open step whose last event is 3 hours old is not live', JSON.stringify({ state: stale?.state, detail: stale?.stateDetail }));
  check(/stopped without ending its turn/.test(stale?.stateDetail || ''), 'its state detail says it stopped without ending its turn', stale?.stateDetail);
  const quiet = sessions.body.sessions.find((s) => s.id === quietSessionId);
  check(quiet?.state === 'live' && /running/.test(quiet?.stateDetail || ''), 'a tool silent for 20 minutes, under the cutoff, stays live', JSON.stringify({ state: quiet?.state, detail: quiet?.stateDetail }));
  const listOrder = sessions.body.sessions.map((s) => s.id);
  check(listOrder.indexOf(quietSessionId) < listOrder.indexOf(staleSessionId), 'a run that stopped sorts below one still running');
  for (const [label, id, listed] of [['stale', staleSessionId, stale], ['quiet', quietSessionId, quiet]]) {
    const attach = await readSse(`${BASE}/api/stream?id=${id}&lite=1`, (e) => e.event === 'status');
    const status = attach.find((e) => e.event === 'status')?.data;
    const metaState = attach.find((e) => e.event === 'meta')?.data.session;
    check(status?.state === listed?.state && status?.live === (listed?.state === 'live'), `the ${label} stream status agrees with the session list`, JSON.stringify({ status: status?.state, list: listed?.state }));
    check(metaState?.state === listed?.state && metaState?.stateDetail.replace(/\d+ \w+ ago/, '') === listed?.stateDetail.replace(/\d+ \w+ ago/, ''), `the ${label} stream meta carries the same state and detail`, JSON.stringify({ meta: metaState?.stateDetail, list: listed?.stateDetail }));
  }

  console.log('\nopen-turn cutoff, in the library');
  const t0 = 1_800_000_000_000;
  const open = { openStep: true, lastEventAt: t0, lastEndAt: 0 };
  check(stateFrom({ ...open, now: t0 + OPEN_TURN_MS - 1000 }) === 'live', 'an open step just under the cutoff is live');
  check(stateFrom({ ...open, now: t0 + OPEN_TURN_MS }) === 'finished', 'an open step at the cutoff is no longer live');
  check(stateFrom({ openTurn: true, lastEventAt: t0, openJob: true, now: t0 + OPEN_TURN_MS }) === 'idle', 'a stale turn with an open background job is idle, as for any detached job');
  check(stateFrom({ openStep: true, now: t0 }) === 'live', 'an open step with no timestamp stays live');
  const openLog = [
    { type: 'turn/start', seq: 1, time: t0, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: t0 + 1, data: { turn: 1, step: 1 } },
  ];
  const fresh = analyzeEvents(openLog, t0 + 60_000);
  check(fresh.rawState === 'live', 'an analysis a minute after the last event is live', fresh.rawState);
  const aged = restate(fresh, t0 + OPEN_TURN_MS + 60_000);
  check(aged.rawState === 'finished' && /stopped without ending its turn/.test(aged.stateDetail), 'a cached analysis is re-derived as time passes, so a quiet run leaves live', JSON.stringify({ state: aged.rawState, detail: aged.stateDetail }));

  console.log('\nturns that never closed their steps');
  const orphan = sessions.body.sessions.find((s) => s.id === orphanSessionId);
  check(orphan?.state === 'idle' && orphan?.live === false, 'a step an earlier turn left open does not keep a later, cleanly ended turn live', JSON.stringify({ state: orphan?.state, detail: orphan?.stateDetail }));
  check(!/stopped without ending/.test(orphan?.stateDetail || ''), 'and its state detail does not claim the latest turn stopped', orphan?.stateDetail);
  const errored = sessions.body.sessions.find((s) => s.id === erroredSessionId);
  check(errored?.state === 'finished' && errored?.live === false, 'a turn that ended with an error and no step/end is not live', JSON.stringify({ state: errored?.state, detail: errored?.stateDetail }));
  const attempting = sessions.body.sessions.find((s) => s.id === attemptingSessionId);
  check(attempting?.state === 'live', 'an old open step with a provider attempt five minutes ago is live in the list', JSON.stringify({ state: attempting?.state, detail: attempting?.stateDetail }));
  for (const [label, id, listed] of [['orphan', orphanSessionId, orphan], ['errored', erroredSessionId, errored], ['attempting', attemptingSessionId, attempting]]) {
    const attach = await readSse(`${BASE}/api/stream?id=${id}&lite=1`, (e) => e.event === 'status');
    const status = attach.find((e) => e.event === 'status')?.data;
    const metaState = attach.find((e) => e.event === 'meta')?.data.session;
    check(status?.state === listed?.state && metaState?.state === listed?.state, `the ${label} stream agrees with the session list`, JSON.stringify({ status: status?.state, meta: metaState?.state, list: listed?.state }));
  }
  const t1 = 1_800_000_000_000;
  const turnEvents = (...evs) => evs.map(([type, offset, data], i) => ({ type, seq: i + 1, time: t1 + offset, data }));
  const clean = (turn, offset) => [['turn/start', offset, { turn }], ['step/start', offset + 1, { turn, step: 1 }], ['step/end', offset + 2, { turn, step: 1 }], ['turn/end', offset + 3, { turn }]];
  const lateOrphan = analyzeEvents(turnEvents(['turn/start', 0, { turn: 1 }], ['step/start', 1, { turn: 1, step: 1 }], ...clean(2, 600_000)), t1 + 600_000 + 4 * 60_000);
  check(lateOrphan.rawState === 'idle' && lateOrphan.openStep === null && lateOrphan.openTurn === null, 'a later turn starting closes what the earlier turn left open', JSON.stringify({ state: lateOrphan.rawState, step: lateOrphan.openStep, turn: lateOrphan.openTurn }));
  const midRun = analyzeEvents(turnEvents(['turn/start', 0, { turn: 1 }], ['step/start', 1, { turn: 1, step: 1 }], ['turn/start', 600_000, { turn: 2 }], ['step/start', 600_001, { turn: 2, step: 1 }]), t1 + 610_000);
  check(midRun.rawState === 'live' && midRun.openStep?.turn === 2, 'the newer turn is what is running, not the one it replaced', JSON.stringify({ state: midRun.rawState, step: midRun.openStep }));
  const abortedTurn = analyzeEvents(turnEvents(['turn/start', 0, { turn: 1 }], ['step/start', 1, { turn: 1, step: 1 }], ['turn/end', 2, { turn: 1, reason: { kind: 'aborted' } }]), t1 + 60_000);
  check(abortedTurn.rawState === 'idle' && abortedTurn.openStep === null, 'an aborted turn that never wrote step/end is not running', JSON.stringify({ state: abortedTurn.rawState, step: abortedTurn.openStep }));
  const orphanStep = analyzeEvents(turnEvents(['step/start', 0, { turn: 1, step: 1 }]), t1 + OPEN_TURN_MS + 60_000);
  check(orphanStep.rawState === 'finished' && !/stopped without ending its turn/.test(orphanStep.stateDetail), 'a stale step with no open turn does not say its turn was left open', orphanStep.stateDetail);

  console.log('\ncost per provider and model');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const flashCost = 0.15 + 0.003 + 0.6; // one million of each token kind, off-peak
  const proCost = 0.66 + 0.022 + 1.98;
  const usage1m = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 };
  check(near(dshCost(usage1m, costAt, 'deepseek-official', 'deepseek-flash'), flashCost), 'deepseek-flash is priced at the flash rates');
  check(near(dshCost(usage1m, costAt, 'deepseek-official', 'deepseek-v4-flash'), flashCost), 'the legacy name deepseek-v4-flash is billed as flash');
  check(near(dshCost(usage1m, costAt, 'deepseek-official', 'deepseek-v4-pro'), proCost), 'deepseek-v4-pro is priced at the pro rates');
  check(dshCost(usage1m, costAt, 'deepseek-account', 'deepseek-flash') === null, 'the deepseek-account route has no price, whatever its model');
  check(dshCost(usage1m, costAt, 'ollama', 'minimax-m3.1-flash:cloud') === null && dshCost(usage1m, costAt, 'ollama', 'deepseek-flash') === null, 'ollama has no price, even for a model named like a DeepSeek one');
  check(dshCost(usage1m, costAt, undefined, undefined) === null && dshCost(usage1m, costAt, 'constructor', 'toString') === null, 'an unknown or missing route has no price');
  const peakAt = Date.UTC(2026, 9, 19, 2, 0, 0); // a Monday, 02:00 UTC
  check(near(dshCost(usage1m, peakAt, 'deepseek-official', 'deepseek-flash'), 2 * flashCost) && near(dshCost(usage1m, peakAt, 'deepseek-official', 'deepseek-v4-pro'), 2 * proCost), 'peak hours double both tables');

  const mixed = (await getJson('/api/sessions')).body.sessions.find((s) => s.id === costSessionId);
  // flash reply + pro reply + flash compaction + a route-less reply on pro (the request announced it)
  const wantCost = 2 * flashCost + 2 * proCost;
  check(near(mixed?.cost, wantCost), 'the session list prices each reply for its own route, the compaction call and the route-less reply included', `${mixed?.cost} vs ${wantCost}`);
  check(mixed?.tokens === 6 * 3e6, 'every reply and the compaction call count in tokens, priced or not', String(mixed?.tokens));
  check(JSON.stringify(mixed?.unpriced) === JSON.stringify(['deepseek-account', 'ollama']), 'the list names the routes with tokens only', JSON.stringify(mixed?.unpriced));
  const tokensOnly = (await getJson('/api/sessions')).body.sessions.find((s) => s.id === ollamaSessionId);
  check(tokensOnly?.cost === null && tokensOnly?.tokens === 3e6 && JSON.stringify(tokensOnly?.unpriced) === '["ollama"]', 'a session with nothing priced shows tokens and no cost', JSON.stringify({ cost: tokensOnly?.cost, tokens: tokensOnly?.tokens }));
  const costSse = await readSse(`${BASE}/api/stream?id=${costSessionId}&lite=1`, (e) => e.event === 'historyEnd');
  const costEvents = costSse.filter((e) => e.event === 'ev').map((e) => e.data).filter((e) => e.usage);
  const priced = costEvents.filter((e) => typeof e.cost === 'number');
  check(costEvents.length === 6 && priced.length === 4, 'six usage events reach the page, four with a cost', JSON.stringify(costEvents.map((e) => [e.t, e.provider, e.cost])));
  check(near(priced.reduce((sum, e) => sum + e.cost, 0), mixed?.cost), 'the page sums what the server priced: the same number as the list');
  check(costEvents.filter((e) => e.cost === null).map((e) => e.provider).join() === 'deepseek-account,ollama', 'a reply with no price carries no cost, not zero');
  check(costEvents.some((e) => e.t === 'usage' && e.kind === 'compaction' && near(e.cost, flashCost)), 'the compaction call arrives as a usage event with its own cost');
  check(near(costEvents.find((e) => e.provider === 'deepseek-official' && e.model === 'deepseek-v4-pro' && e.t === 'say' && e.step === 8)?.cost, proCost), 'a reply that names no route is priced for the route its request announced');
  const costMeta = costSse.find((e) => e.event === 'meta')?.data.prices;
  check(costMeta?.listEstimate === true && /^\d{4}-\d{2}-\d{2}$/.test(costMeta?.date) && !('offPeak' in costMeta), 'the page gets a labelled list-price estimate with the table date, not a rate table to apply itself', JSON.stringify(costMeta));

  console.log('\nprovider problems');
  const rows = Object.fromEntries((await getJson('/api/sessions')).body.sessions.map((s) => [s.id, s]));
  const problemsOf = async (id) => {
    const sse = await readSse(`${BASE}/api/stream?id=${id}&lite=1`, (e) => e.event === 'status');
    return {
      events: sse.filter((e) => e.event === 'ev' && e.data.t === 'problem').map((e) => e.data),
      meta: sse.find((e) => e.event === 'meta')?.data.session,
      status: sse.find((e) => e.event === 'status')?.data,
      raw: JSON.stringify(sse),
    };
  };
  const quotaRow = rows[problemIds.quota];
  check(quotaRow?.problem?.kind === 'quota' && quotaRow.problem.status === 402 && quotaRow.problem.provider === 'deepseek-official', 'a 402 failure is the session problem: quota, status 402, its provider', JSON.stringify(quotaRow?.problem));
  const quota = await problemsOf(problemIds.quota);
  check(quota.events.length === 1 && quota.events[0].kind === 'quota' && quota.events[0].status === 402 && quota.events[0].provider === 'deepseek-official', 'the failed attempt and the turn that gave up are one problem event', JSON.stringify(quota.events));
  check(!quota.raw.includes(PROBLEM_SECRET) && !quota.raw.includes('for key'), 'the provider message text never reaches the page');
  check(quota.meta?.problem?.kind === 'quota' && quota.status?.problem?.kind === 'quota', 'stream meta and status carry the session problem', JSON.stringify({ meta: quota.meta?.problem, status: quota.status?.problem }));
  check(quotaRow?.attention?.level === 'needs-you' && quotaRow.attention.reason === 'quota' && quotaRow.attention.certainty === 'sure' && quotaRow.attention.detail === 'out of credit', 'out of credit needs you, reason quota, sure', JSON.stringify(quotaRow?.attention));
  check(quota.status?.attention?.reason === 'quota' && quota.meta?.attention?.reason === 'quota', 'the stream says so too', JSON.stringify({ status: quota.status?.attention, meta: quota.meta?.attention }));

  const retried = await problemsOf(problemIds.retried);
  check(retried.events.length === 2 && retried.events[0].kind === 'rate-limit' && retried.events[0].status === 429 && retried.events[1].kind === 'rate-limit' && retried.events[1].attempts === 1, 'a 429 and its retry are shown, the retry with its attempt count', JSON.stringify(retried.events));
  check(rows[problemIds.retried]?.problem === undefined && retried.meta?.problem === null && retried.status?.problem === null, 'a retry that later succeeded leaves no session problem', JSON.stringify(rows[problemIds.retried]?.problem));
  check(rows[problemIds.retried]?.attention?.level !== 'needs-you', 'and nothing needs you', JSON.stringify(rows[problemIds.retried]?.attention));

  const credential = await problemsOf(problemIds.credential);
  check(credential.events.length === 1 && credential.events[0].kind === 'auth' && credential.events[0].status === null, 'a missing credential is an auth problem without a status', JSON.stringify(credential.events));
  const credRow = rows[problemIds.credential];
  check(credRow?.attention?.level === 'needs-you' && credRow.attention.reason === 'auth' && credRow.attention.certainty === 'sure' && credRow.attention.detail === 'sign-in needed', 'a missing credential needs you, reason auth', JSON.stringify(credRow?.attention));

  check(rows[problemIds.recovered]?.problem === undefined && rows[problemIds.recovered]?.attention?.level !== 'needs-you', 'a later successful step clears the problem and the need', JSON.stringify({ problem: rows[problemIds.recovered]?.problem, attention: rows[problemIds.recovered]?.attention }));
  check(rows[problemIds.newTurn]?.problem === undefined && rows[problemIds.newTurn]?.attention?.level !== 'needs-you', 'a new turn clears it as well');
  check(rows[problemIds.old]?.problem?.kind === 'quota' && rows[problemIds.old]?.attention?.level !== 'needs-you', 'a failure from long ago stays visible as a problem but no longer asks for you', JSON.stringify({ problem: rows[problemIds.old]?.problem, attention: rows[problemIds.old]?.attention }));
  const timeout = await problemsOf(problemIds.timeout);
  check(timeout.events[0]?.kind === 'timeout' && rows[problemIds.timeout]?.problem?.kind === 'timeout' && rows[problemIds.timeout]?.attention?.level !== 'needs-you', 'a timeout is a problem, not a request for you', JSON.stringify(timeout.events));

  console.log('\nprovider problems, in the library');
  check(kindOf({ code: 'QUOTA' }) === 'quota' && kindOf({ status: 402 }) === 'quota' && kindOf({ message: 'Insufficient Balance' }) === 'quota', 'quota: its code, HTTP 402 or the balance message');
  check(kindOf({ code: 'RATE_LIMIT' }) === 'rate-limit' && kindOf({ status: 429 }) === 'rate-limit', 'rate limit: its code or HTTP 429');
  check(kindOf({ code: 'TIMEOUT' }) === 'timeout' && kindOf({ status: 504 }) === 'timeout', 'timeout: its code or HTTP 504');
  check(kindOf({ code: 'MISSING_CREDENTIAL' }) === 'auth' && kindOf({ status: 401 }) === 'auth', 'auth: a missing credential or HTTP 401');
  check(kindOf({ code: 'SERVER', status: 503 }) === 'provider-error' && kindOf({ code: 'NO_ADAPTER' }) === 'provider-error' && kindOf({}) === 'provider-error', 'anything else is a provider error');
  const noText = fromEvent({ type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'error', error: { code: 'QUOTA', status: 402, message: `Insufficient Balance ${PROBLEM_SECRET}` } } } }, { provider: 'deepseek official, with spaces' });
  check(JSON.stringify(Object.keys(noText).sort()) === '["attempts","kind","provider","status"]' && noText.provider === null && !JSON.stringify(noText).includes(PROBLEM_SECRET), 'a problem has the fixed fields only, and a route name that is not a plain token is dropped', JSON.stringify(noText));
  check(fromEvent({ type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'aborted' } } }) === null && fromEvent({ type: 'turn/end', time: 1, data: { turn: 1, reason: { kind: 'completed' } } }) === null, 'an aborted or completed turn is not a problem');
  let cur = nextProblem(null, { type: 'assistant/attempt', time: 5, data: { turn: 1, stream: [{ chunk: { reason: { failure: { code: 'QUOTA', status: 402 } } } }] } });
  check(cur?.kind === 'quota' && cur.since === 5, 'a failure becomes the session problem, since its time');
  check(nextProblem(cur, { type: 'assistant/message', time: 6, data: { turn: 1, usage: null } }) === cur, 'a reply that cost no tokens does not resolve it');
  check(nextProblem(cur, { type: 'assistant/message', time: 6, data: { turn: 1, usage: { inputTokens: 1 } } }) === null && nextProblem(cur, { type: 'turn/start', time: 6, data: { turn: 2 } }) === null, 'a reply that cost tokens, or a new turn, resolves it');

  console.log('\nnicknames');
  const nickRes = await fetch(BASE + '/api/nickname', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ source: 'dsh', id: fixture.finishedId, nickname: '  Release build  ' }),
  });
  const nickJson = await nickRes.json();
  check(nickJson.nickname === 'Release build', 'nickname is trimmed', JSON.stringify(nickJson));
  const withNick = await getJson('/api/sessions');
  const ns = withNick.body.sessions.find((s) => s.id === fixture.finishedId);
  check(ns?.nickname === 'Release build' && ns?.title === 'Release build', 'nickname becomes the displayed title', JSON.stringify({ nickname: ns?.nickname, title: ns?.title }));
  check(fs.readFileSync(path.join(tmp, 'nicknames.json'), 'utf8').includes('Release build'), 'nickname is stored in nicknames.json');
  await fetch(BASE + '/api/nickname', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ source: 'dsh', id: fixture.finishedId, nickname: '' }),
  });

  console.log('\nstate hysteresis over polls');
  fs.appendFileSync(growLog, frame([
    ev('step/end', 4, { turn: 1, step: 1 }),
    ev('turn/end', 5, { turn: 1 }),
  ]));
  await sleep(250);
  const h1 = (await getJson('/api/sessions')).body.sessions.find((s) => s.id === growSessionId);
  check(h1?.state === 'live', 'a single poll does not downgrade a live session', h1?.state);
  await sleep(250);
  const h2 = (await getJson('/api/sessions')).body.sessions.find((s) => s.id === growSessionId);
  check(h2?.state === 'idle', 'two agreeing polls downgrade to idle', h2?.state);

  console.log('\nlive hysteresis');
  const tracker = new LiveTracker();
  check(tracker.update('h', 'live') === 'live', 'first observation is live');
  check(tracker.update('h', 'idle') === 'live', 'a single poll does not downgrade');
  check(tracker.update('h', 'idle') === 'idle', 'two agreeing polls downgrade to idle');
  check(tracker.update('h', 'live') === 'live', 'upgrades apply immediately');

  console.log('\nbackground jobs');
  const jobSse = await readSse(
    `${BASE}/api/stream?id=${jobSessionId}`,
    (e) => e.event === 'ev' && e.data.t === 'jobOutput',
    10000,
  );
  const jobEvents = jobSse.filter((e) => e.event === 'ev').map((e) => e.data);
  const jobEv = jobEvents.find((e) => e.t === 'job');
  check(!!jobEv && typeof jobEv.startedAt === 'number', 'job registration carries its start time');
  const firstOutput = jobEvents.find((e) => e.t === 'jobOutput');
  check(!!firstOutput && firstOutput.text.includes('[1/10]'), 'existing job output is sent on attach', JSON.stringify(firstOutput?.text));

  fs.appendFileSync(jobLogFile, 'ninja: [2/10] link\n');
  const jobSse2 = await readSse(
    `${BASE}/api/stream?id=${jobSessionId}`,
    (e) => e.event === 'ev' && e.data.t === 'jobOutput' && e.data.text.includes('[2/10]'),
    10000,
  );
  const secondOutput = jobSse2.filter((e) => e.event === 'ev').map((e) => e.data).find((e) => e.t === 'jobOutput' && e.text.includes('[2/10]'));
  check(!!secondOutput, 'appended job output streams live', JSON.stringify(secondOutput?.text));

  console.log('\ntree + files');
  const tree = await getJson('/api/tree?id=' + fixture.finishedId);
  const paths = [];
  (function walk(nodes) { for (const n of nodes || []) { paths.push(n.path); walk(n.children); } })(tree.body.tree.children);
  check(paths.includes('src'), 'tree lists src/');
  check(paths.includes('src/app.js'), 'tree lists src/app.js');
  check(paths.includes('notes.md'), 'tree lists notes.md');

  const file = await getJson('/api/file?id=' + fixture.finishedId + '&path=' + encodeURIComponent('src/app.js'));
  check(file.status === 200 && file.body.content.includes('export const answer = 42;'), 'file endpoint returns workspace content');

  const escape = await getJson('/api/file?id=' + fixture.finishedId + '&path=' + encodeURIComponent('../../escape.txt'));
  check(escape.status === 403, 'relative path escape is rejected', 'status ' + escape.status);
  const abs = await getJson('/api/file?id=' + fixture.finishedId + '&path=' + encodeURIComponent('C:\\Windows\\win.ini'));
  check(abs.status === 403, 'absolute outside path is rejected', 'status ' + abs.status);

  console.log('\nSSE (finished session)');
  const hist = await readSse(
    `${BASE}/api/stream?id=${fixture.finishedId}`,
    (ev) => ev.event === 'historyEnd',
    10000,
  );
  const events = hist.filter((e) => e.event === 'ev').map((e) => e.data);
  const types = {};
  for (const e of events) types[e.t] = (types[e.t] || 0) + 1;
  check(events.length >= 15, 'history carries the full event stream', String(events.length));
  check(types.step >= 2, 'step events present');
  check(types.say >= 2, 'assistant messages present');
  check(types.user === 2, 'user message present', JSON.stringify(types));
  const userEvents = events.filter((e) => e.t === 'user');
  check(userEvents.some((e) => !e.system && /Patch the answer/.test(e.text)), 'real user message is not system');
  check(userEvents.some((e) => e.system && /time context/.test(e.systemLabel || '')), 'runtime context is marked system', JSON.stringify(userEvents.map((e) => [e.system, e.systemLabel])));
  check(types.call === 4, 'tool calls present', JSON.stringify(types));
  check(types.result === 4, 'tool results present');
  check(types.jobEnd === 2, 'job settlement present');
  check(types.deleted === 1, 'deletions are detected from commands');
  const editCall = events.find((e) => e.t === 'call' && e.name === 'edit');
  check(!!editCall && editCall.args.old_string.includes('41') && editCall.args.new_string.includes('42'), 'edit args carry old/new text');
  const writeCall = events.find((e) => e.t === 'call' && e.name === 'write');
  check(!!writeCall && writeCall.args.content.includes('The agent appends'), 'write args carry file content');
  const pwshCall = events.find((e) => e.t === 'call' && e.name === 'pwsh');
  check(!!pwshCall && pwshCall.args.command === 'node --test', 'pwsh args carry the command');
  const meta = hist.find((e) => e.event === 'meta');
  check(!!meta && meta.data.prices.listEstimate === true, 'a labelled price estimate is sent to the page');
  const historyDone = hist.find((e) => e.event === 'historyEnd');
  check(!!historyDone && historyDone.data.count > 0, 'historyEnd reports a count');
  check(!!meta && meta.data.historyCount === historyDone.data.count, 'meta reports the history count for the loading bar', JSON.stringify({ historyCount: meta?.data.historyCount, count: historyDone?.data.count }));

  // The session event itself is delivered as an ev with t=session.
  const sessionEv = events.find((e) => e.t === 'session');
  check(!!sessionEv && sessionEv.cwd === fixture.workspace, 'session metadata event is streamed');

  console.log('\nsystem SSE');
  const sysEvents = await readSse(
    `${BASE}/api/stream?id=${fixture.finishedId}`,
    (ev) => ev.event === 'sys',
    6000,
  );
  const sysEv = sysEvents.find((e) => e.event === 'sys')?.data;
  check(!!sysEv && sysEv.cpu && sysEv.ram, 'sys samples arrive over the stream', JSON.stringify(sysEv));
  check(sysEv.cpu.pct >= 0 && sysEv.cpu.pct <= 100 && sysEv.cpu.cores > 0, 'CPU usage is a percentage', JSON.stringify(sysEv.cpu));
  check(sysEv.ram.total > 0 && sysEv.ram.used > 0 && sysEv.ram.pct >= 0 && sysEv.ram.pct <= 100, 'RAM usage reports bytes', JSON.stringify(sysEv.ram));
  check(!('hostname' in sysEv) && !('host' in sysEv), 'sys samples do not expose the machine name');

  console.log('\nSSE live tail');
  const tailPromise = readSse(
    `${BASE}/api/stream?id=${fixture.liveId}`,
    (ev) => ev.event === 'ev' && ev.data.t === 'jobEnd',
    12000,
  );
  // Let the stream attach, then append the remaining frames while it is open.
  await sleep(600);
  let chunk = [];
  for (const e of fixture.remainingEvents) {
    chunk.push(e);
    if (chunk.length === 4) {
      fs.appendFileSync(fixture.liveLog, frame(chunk));
      chunk = [];
      await sleep(250);
    }
  }
  if (chunk.length) fs.appendFileSync(fixture.liveLog, frame(chunk));

  const tail = await tailPromise;
  const tailEvents = tail.filter((e) => e.event === 'ev').map((e) => e.data);
  const seqs = tailEvents.map((e) => e.seq).filter((n) => typeof n === 'number');
  check(tailEvents.some((e) => e.t === 'call' && e.name === 'pwsh'), 'live append delivers a new tool call');
  check(tailEvents.some((e) => e.t === 'jobEnd' && e.detail === 'exit code: 1'), 'live append delivers job settlement');
  check(seqs.every((n, i) => i === 0 || n >= seqs[i - 1]), 'event sequence stays ordered');
  check(new Set(seqs).size === seqs.length, 'no duplicate seq values');

  console.log('\nread-only guarantees');
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'server.js'), 'utf8');
  check(!/fs\.(writeFile|appendFile|rm|unlink|mkdir|rename|copyFile)|createWriteStream/.test(source), 'server.js contains no write calls');

  // The log file must be byte-identical after all that reading.
  const before = fs.readFileSync(fixture.finishedLog);
  await getJson('/api/tree?id=' + fixture.finishedId);
  const after = fs.readFileSync(fixture.finishedLog);
  check(before.equals(after), 'reading a session log never modifies it');
} catch (err) {
  console.error(err);
  failures.push(String(err && err.stack || err));
} finally {
  server.kill();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures) console.error(' - ' + f);
  exitCode = 1;
} else {
  console.log('all checks passed');
}
process.exit(exitCode);
