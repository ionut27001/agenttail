// End-to-end smoke test: fixture session logs, HTTP API, SSE replay + live tail.
// Run: node test/smoke.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildFixture, frame, ev } from './fixture.mjs';
import { LiveTracker } from '../lib/live.js';

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
  check(!!meta && meta.data.prices.offPeak.output === 0.6, 'pricing table is sent to the page');
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
