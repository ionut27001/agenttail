// Control-plane tests: opt-in gate, token, stream lockout, ACP driving and audit.
// Run: node test/control.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(__dirname, '.tmp-control');
const workspace = path.join(tmp, 'workspace');
const sessions = path.join(tmp, 'sessions');
const controlFile = path.join(tmp, 'control.json');
const auditFile = path.join(tmp, 'control-audit.log');
const fakeAcp = path.join(__dirname, 'fake-acp.mjs');

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(path.join(workspace, 'note.txt'), 'control workspace\n');
fs.writeFileSync(controlFile, JSON.stringify({
  workspaces: [workspace],
  dshProfile: 'acp',
  maxSessions: 4,
}));

const failures = [];
function check(cond, msg, extra) {
  if (cond) console.log(`  ok    ${msg}`);
  else {
    failures.push(msg);
    console.log(`  FAIL  ${msg}${extra ? ' :: ' + extra : ''}`);
  }
}

const servers = [];
async function launch({ port, allow = false, stream = false, token = true }) {
  const args = ['server.js'];
  if (allow) args.push('--allow-control');
  if (!stream) args.push('--no-stream-mode');
  const env = {
    ...process.env,
    PORT: String(port),
    AGENTTAIL_NO_OPEN: '1',
    AGENTTAIL_CONFIG_DIR: tmp,
    AGENTTAIL_CONTROL_FILE: controlFile,
    AGENTTAIL_CONTROL_AUDIT_FILE: auditFile,
    DSH_SESSIONS_ROOT: sessions,
    AGENTTAIL_DSH_BIN: process.execPath,
    AGENTTAIL_DSH_ARGS: JSON.stringify([fakeAcp]),
    OLLAMA_API_KEY: 'fake-key',
  };
  const proc = spawn(process.execPath, args, {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (d) => { out += d; process.stdout.write('  [server] ' + d); });
  proc.stderr.on('data', (d) => { err += d; process.stderr.write('  [server:err] ' + d); });
  servers.push(proc);
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${base}/api/sessions`);
      if (res.ok) { up = true; break; }
    } catch { /* starting */ }
    await sleep(100);
  }
  if (!up) throw new Error(`server ${port} did not start\n${out}\n${err}`);
  let foundToken = null;
  if (token) {
    const match = /#token=([A-Za-z0-9_-]{20,})/.exec(out);
    if (match) foundToken = match[1];
  }
  return { proc, base, out: () => out, err: () => err, token: foundToken };
}

async function jsonRequest(base, method, requestPath, headers = {}, body) {
  const res = await fetch(base + requestPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function post(base, token, requestPath, body, extraHeaders = {}) {
  return jsonRequest(base, 'POST', requestPath, {
    Origin: base,
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  }, body);
}

async function readSse(url, stop, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const collected = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = raw.split('\n').find((line) => line.startsWith('event: '))?.slice(7).trim();
        const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
        if (!event || !dataLine) continue;
        const data = JSON.parse(dataLine.slice(6));
        collected.push({ event, data });
        if (stop({ event, data }, collected)) {
          controller.abort();
          return collected;
        }
      }
    }
    return collected;
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
    return [];
  } finally {
    clearTimeout(timer);
    try { controller.abort(); } catch { /* ignore */ }
  }
}

let controlServer;
try {
  console.log('\nopt-in gate');
  const off = await launch({ port: 8890, allow: false, stream: false, token: false });
  const offPost = await post(off.base, 'x'.repeat(32), '/api/control/session/begin', { cwd: workspace });
  check(offPost.status === 404, 'control without --allow-control is 404', String(offPost.status));
  const offNoOrigin = await jsonRequest(off.base, 'POST', '/api/control/session/begin', {}, { cwd: workspace });
  check(offNoOrigin.status === 404, 'control path is 404 before origin checks without the flag', String(offNoOrigin.status));

  console.log('\nstream-mode lockout');
  const stream = await launch({ port: 8892, allow: true, stream: true, token: false });
  const streamStatus = await jsonRequest(stream.base, 'GET', '/api/control/status', {});
  check(streamStatus.status === 200 && streamStatus.data.locked === true, 'stream mode reports control locked');
  const streamPost = await post(stream.base, 'x'.repeat(32), '/api/control/session/begin', { cwd: workspace });
  check(streamPost.status === 403, 'control in stream mode is 403', String(streamPost.status));
  const streamOptions = await jsonRequest(stream.base, 'GET', '/api/control/options', {});
  check(streamOptions.status === 403, 'control options in stream mode is 403', String(streamOptions.status));
  check(!/#token=/.test(stream.out()), 'stream mode never prints a control token');

  console.log('\nauth checks');
  controlServer = await launch({ port: 8891, allow: true, stream: false });
  check(!!controlServer.token, 'control token is printed in the URL');
  const status = await jsonRequest(controlServer.base, 'GET', '/api/control/status', {});
  check(status.status === 200 && status.data.enabled === true && status.data.locked === false, 'control status is enabled');

  const noToken = await post(controlServer.base, null, '/api/control/session/begin', { cwd: workspace });
  check(noToken.status === 401, 'missing token is 401', String(noToken.status));
  const wrongToken = await post(controlServer.base, 'wrong'.repeat(8), '/api/control/session/begin', { cwd: workspace });
  check(wrongToken.status === 401, 'wrong token is 401', String(wrongToken.status));
  const foreign = await post(controlServer.base, controlServer.token, '/api/control/session/begin', { cwd: workspace }, {
    Origin: 'http://evil.example',
  });
  check(foreign.status === 403, 'foreign Origin is 403', String(foreign.status));
  const wrongType = await jsonRequest(controlServer.base, 'POST', '/api/control/session/begin', {
    Origin: controlServer.base,
    'Content-Type': 'text/plain',
    Authorization: `Bearer ${controlServer.token}`,
  }, { cwd: workspace });
  check(wrongType.status === 403, 'non-JSON control POST is 403', String(wrongType.status));
  const badWorkspace = await post(controlServer.base, controlServer.token, '/api/control/session/begin', {
    cwd: path.dirname(tmp),
  });
  check(badWorkspace.status === 403, 'workspace outside the allowlist is 403', String(badWorkspace.status));
  const danger = await post(controlServer.base, controlServer.token, '/api/control/session/begin', {
    cwd: workspace,
    preset: 'danger-full-access',
  });
  check(danger.status === 400, 'danger-full-access requires explicit confirmation', String(danger.status));
  const dangerOk = await post(controlServer.base, controlServer.token, '/api/control/session/begin', {
    cwd: workspace,
    preset: 'danger-full-access',
    confirmDanger: true,
  });
  check(dangerOk.status === 200 && dangerOk.data?.session?.preset === 'danger-full-access', 'confirmed danger-full-access is accepted');
  if (dangerOk.data?.session?.id) {
    await post(controlServer.base, controlServer.token, '/api/control/close', { id: dangerOk.data.session.id });
  }

  console.log('\nstart, approve, stop');
  const begin = await post(controlServer.base, controlServer.token, '/api/control/session/begin', {
    cwd: workspace,
    preset: 'workspace-write',
  });
  check(begin.status === 200, 'begin creates a session', JSON.stringify(begin.data));
  const id = begin.data?.session?.id;
  check(id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'session id matches the ACP id', id);
  check(begin.data?.models?.some((m) => m.provider === 'ollama' && m.model === 'fake-model'), 'model catalog includes the custom provider');
  check(begin.data?.session?.preset === 'workspace-write', 'permission preset is workspace-write');

  const started = await post(controlServer.base, controlServer.token, '/api/control/session/start', {
    id,
    model: JSON.stringify(['ollama', 'fake-model']),
    message: 'Please run the fake command',
  });
  check(started.status === 200 && started.data?.running === true, 'first message starts a turn');

  const events = await readSse(`${controlServer.base}/api/stream?source=dsh&id=${encodeURIComponent(id)}`, (event) => event.event === 'approval');
  const approvalEvent = events.find((event) => event.event === 'approval');
  check(!!approvalEvent, 'approval reaches SSE');
  check(approvalEvent?.data?.command === 'echo fake-ok', 'approval carries the exact command', approvalEvent?.data?.command);
  check(events.some((event) => event.event === 'meta' && event.data.control?.owned === true), 'meta marks the session owned');

  const approvedPromise = readSse(`${controlServer.base}/api/stream?source=dsh&id=${encodeURIComponent(id)}`, (event) => event.event === 'approvalDone');
  await sleep(250);
  const approved = await post(controlServer.base, controlServer.token, '/api/control/approval', {
    id,
    approvalId: approvalEvent.data.approvalId,
    decision: 'approve',
  });
  check(approved.status === 200 && approved.data?.decision === 'approve', 'approve endpoint accepts the decision');
  const after = await approvedPromise;
  check(after.some((event) => event.event === 'approvalDone'), 'approvalDone reaches SSE');

  const stopped = await post(controlServer.base, controlServer.token, '/api/control/stop', { id });
  check(stopped.status === 200, 'stop endpoint responds', JSON.stringify(stopped.data));
  const closed = await post(controlServer.base, controlServer.token, '/api/control/close', { id });
  check(closed.status === 200 && closed.data?.closed === true, 'close endpoint responds');

  console.log('\nqueue');
  const begin2 = await post(controlServer.base, controlServer.token, '/api/control/session/begin', {
    cwd: workspace,
    preset: 'workspace-write',
  });
  const id2 = begin2.data.session.id;
  await post(controlServer.base, controlServer.token, '/api/control/session/start', {
    id: id2,
    model: JSON.stringify(['ollama', 'fake-model']),
    message: 'First fake message',
  });
  await readSse(`${controlServer.base}/api/stream?source=dsh&id=${encodeURIComponent(id2)}`, (event) => event.event === 'approval');
  const queued = await post(controlServer.base, controlServer.token, '/api/control/message', {
    id: id2,
    text: 'Queued fake message',
  });
  check(queued.status === 200 && queued.data?.queued === true, 'a message sent during a turn is queued');
  await post(controlServer.base, controlServer.token, '/api/control/stop', { id: id2 });
  await post(controlServer.base, controlServer.token, '/api/control/close', { id: id2 });

  console.log('\naudit');
  const audit = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const actions = audit.map((entry) => entry.action);
  check(actions.includes('start'), 'audit records start');
  check(actions.includes('message'), 'audit records message');
  check(actions.includes('approve'), 'audit records approve');
  check(actions.includes('stop'), 'audit records stop');
  check(actions.includes('close'), 'audit records close');
  check(!fs.readFileSync(auditFile, 'utf8').includes('Please run the fake command'), 'audit never stores message bodies');
} finally {
  for (const proc of servers) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  await sleep(200);
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('\nall control checks passed');
