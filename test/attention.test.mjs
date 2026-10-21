// "Needs you": the attention model, the dsh / Claude Code / Antigravity / owned
// producers, the status-file reader and the inbox endpoint.
// Everything is synthetic: fake logs, fake status files, fake processes.
// Run: node test/attention.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { frame } from './fixture.mjs';

const require = createRequire(import.meta.url);
const attention = require('../lib/attention.js');
const claudeStatus = require('../lib/claude-status.js');
const { analyzeEvents } = require('../lib/session-analysis.js');
const { buildAgents } = require('../lib/agents.js');

const PORT = 8907;
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(import.meta.dirname, '..');
const tmp = path.join(import.meta.dirname, '.tmp-attention');
const SECRET_CMD = 'rm -rf SECRET_COMMAND_TEXT';
const SECRET_SOCKET = 'SECRET_SOCKET_PATH';

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const failures = [];
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok    ${msg}`);
  else { failures.push(msg); console.log(`  FAIL  ${msg}${extra ? ' :: ' + extra : ''}`); }
};
const J = (v) => JSON.stringify(v);

const children = [];
function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore', windowsHide: true });
  children.push(child);
  return child.pid;
}
/** The pid of a process that has already exited. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true });
  return r.pid;
}

try {
  /* ------------------------------------------------------------ model --- */
  console.log('\nthe attention model');
  const now = Date.now();
  check(attention.make({ level: 'nope' }).level === 'none', 'an unknown level is no attention');
  check(attention.make({ level: 'needs-you', reason: 'weird' }).reason === 'unknown', 'an unknown reason becomes "unknown"');
  const tooled = attention.needsYou({ reason: 'permission', since: now, via: 'log', tool: 'Bash' });
  check(tooled.tool === 'Bash' && tooled.certainty === 'sure' && tooled.level === 'needs-you', 'a tool name is kept', J(tooled));
  check(attention.needsYou({ tool: 'rm -rf /' }).tool === undefined, 'a command is never kept as a tool name');
  check(attention.needsYou({ tool: 'C:\\Users\\x\\a.js' }).tool === undefined && attention.needsYou({ tool: '/home/x/a.js' }).tool === undefined, 'a path is never kept as a tool name');
  check(attention.needsYou({ detail: 'run SECRET_COMMAND_TEXT now' }).detail === undefined && attention.needsYou({ detail: 'Permission Prompt' }).detail === 'permission prompt', 'a detail is a fixed phrase, never agent text');
  check(attention.none().level === 'none' && attention.ready({ via: 'log' }).reason === null, 'none and ready carry no reason');
  check(attention.notifiable(attention.needsYou({ certainty: 'sure' })) && attention.notifiable(attention.needsYou({ certainty: 'probable' })) && !attention.notifiable(attention.needsYou({ certainty: 'guess' })), 'only sure and probable attention notifies');

  console.log('\nmerging signals of one session');
  const logAsk = attention.needsYou({ via: 'log', since: now - 5000 });
  const acpAsk = attention.needsYou({ via: 'acp', since: now - 1000 });
  check(attention.merge(attention.ready({ via: 'log' }), logAsk).level === 'needs-you', 'needs-you beats ready');
  check(attention.merge(logAsk, acpAsk).via === 'acp' && attention.merge(acpAsk, logAsk).via === 'acp', 'the exact ACP signal beats the log signal, in either order');
  check(attention.merge(attention.needsYou({ certainty: 'guess', via: 'acp' }), attention.needsYou({ certainty: 'sure', via: 'transcript' })).via === 'transcript', 'certainty is compared before the source');
  check(attention.merge(null, undefined).level === 'none', 'nothing merges to none');
  check(attention.countNeedsYou([{ attention: logAsk }, { attention: attention.none() }, { attention: acpAsk }]) === 2, 'sessions that need you are counted');
  const sorted = [{ attention: attention.ready({}) }, { attention: attention.needsYou({ since: 200 }) }, { attention: attention.needsYou({ since: 100 }) }].sort((a, b) => attention.compareForList(a.attention, b.attention));
  check(sorted[0].attention.since === 100 && sorted[1].attention.since === 200 && sorted[2].attention.level === 'ready', 'lists put the longest wait first, ready last');
  const redacted = attention.forPage(attention.needsYou({ tool: 'Bash', detail: 'permission prompt' }), (v) => `[${v}]`);
  check(redacted.tool === '[Bash]' && redacted.detail === '[permission prompt]', 'the page copy passes tool and detail through the redactor');

  console.log('\nowned sessions (ACP)');
  check(attention.ownedAttention([]).level === 'none', 'no pending approval, no attention');
  const owned = attention.ownedAttention([
    { createdAt: now - 1000, kind: 'execute', title: SECRET_CMD, command: SECRET_CMD },
    { createdAt: now - 9000, kind: 'edit', title: 'Edit src/secret.js' },
  ]);
  check(owned.level === 'needs-you' && owned.via === 'acp' && owned.certainty === 'sure' && owned.since === now - 9000, 'pending approvals are a sure ACP signal that began at the oldest', J(owned));
  check(owned.tool === 'edit' && !JSON.stringify(owned).includes('SECRET') && !JSON.stringify(owned).includes('secret.js'), 'the tool is a kind label; no title, command or path', J(owned));
  check(attention.ownedAttention([{ createdAt: 1, toolName: 'Bash' }]).tool === 'Bash', 'a tool name from the harness is used when it is one');

  console.log('\nClaude Code rules');
  const waiting = (waitingFor) => attention.claudeAttention({ status: { status: 'waiting', waitingFor, since: now - 3000 }, state: 'live', now, openTool: 'Bash' });
  const reasons = Object.fromEntries(['permission prompt', 'input needed', 'sandbox request', 'worker request', 'dialog open', 'something new', undefined].map((w) => [String(w), waiting(w)]));
  check(reasons['permission prompt'].reason === 'permission' && reasons['permission prompt'].tool === 'Bash' && reasons['permission prompt'].via === 'status-file' && reasons['permission prompt'].certainty === 'sure', 'waiting for a permission prompt is sure, with the open tool name', J(reasons['permission prompt']));
  check(reasons['input needed'].reason === 'input' && reasons['sandbox request'].reason === 'sandbox' && reasons['dialog open'].reason === 'dialog', 'input, sandbox and dialog map to their reasons');
  check(reasons['worker request'].reason === 'unknown' && reasons['worker request'].detail === 'worker request', 'a worker request is unknown with its own detail');
  check(reasons['something new'].reason === 'unknown' && reasons['something new'].detail === 'waiting for you' && reasons.undefined.reason === 'unknown', 'an unknown waitingFor is still needs-you, without echoing it');
  check(attention.claudeAttention({ status: { status: 'busy' }, question: { name: 'AskUserQuestion', at: now }, state: 'live', now }).level === 'none', 'a busy process needs nothing, even with an old question in the transcript');
  check(attention.claudeAttention({ status: { status: 'idle', since: now }, state: 'idle', now }).level === 'ready' && attention.claudeAttention({ status: { status: 'idle', since: now }, state: 'finished', now }).level === 'none', 'idle is ready while recent, nothing once finished');
  const asked = attention.claudeAttention({ question: { name: 'AskUserQuestion', at: now - 60000 }, state: 'live', now });
  check(asked.level === 'needs-you' && asked.reason === 'question' && asked.certainty === 'probable' && asked.via === 'transcript' && asked.tool === 'AskUserQuestion', 'an unanswered AskUserQuestion is a probable question', J(asked));
  check(attention.claudeAttention({ question: { name: 'ExitPlanMode', at: now }, state: 'live', now }).detail === 'plan approval', 'an unanswered ExitPlanMode is a plan approval');
  check(attention.claudeAttention({ question: { name: 'AskUserQuestion', at: now - 7 * 3600 * 1000 }, state: 'idle', turnOpen: true, now }).level === 'none', 'a very old question stops counting');
  check(attention.claudeAttention({ state: 'idle', turnOpen: false, lastEventAt: now - 1000, now }).level === 'ready' && attention.claudeAttention({ state: 'live', turnOpen: true, now }).level === 'none', 'end_turn is ready; an open turn or tool call says nothing');

  console.log('\ndsh rules');
  const open = new Map();
  const ask = (id, at, tool = 'pwsh') => ({ t: 'approval', id, callId: `c-${id}`, toolName: tool, time: at, seq: 1 });
  attention.trackApproval(open, ask('a1', now - 20000));
  check(attention.dshAttention({ open, rawState: 'live', now }).level === 'needs-you', 'an open ask in a live session needs you');
  const dsh = attention.dshAttention({ open, rawState: 'live', now });
  check(dsh.reason === 'permission' && dsh.via === 'log' && dsh.certainty === 'sure' && dsh.tool === 'pwsh' && dsh.since === now - 20000, 'it is a sure permission signal from the log, with the tool name', J(dsh));
  check(attention.dshAttention({ open, rawState: 'finished', now }).level === 'none', 'an ask in a session that no longer looks live is ignored');
  check(attention.dshAttention({ open, rawState: 'live', now: now + 31 * 60 * 1000 }).level === 'none', 'an ask older than the open-turn limit is ignored');
  attention.trackApproval(open, { t: 'approvalDone', id: 'a1', outcome: 'allowed-once' });
  check(open.size === 0 && attention.dshAttention({ open, rawState: 'live', now }).level === 'none', 'a decision with the same id closes it');
  attention.trackApproval(open, ask('a2', now));
  attention.trackApproval(open, { t: 'approvalDone', id: 'a2', outcome: 'unavailable' });
  check(open.size === 0, 'an "unavailable" decision closes it too: no human was needed');
  attention.trackApproval(open, { t: 'approval', callId: 'cc1', toolName: 'pwsh', time: now, seq: 5 });
  attention.trackApproval(open, { t: 'approvalDone', callId: 'cc1' });
  check(open.size === 0, 'an ask without an id pairs by call id');
  attention.trackApproval(open, { t: 'approval', toolName: 'pwsh', time: now, seq: 6 });
  attention.trackApproval(open, { t: 'approval', toolName: 'pwsh', time: now, seq: 7 });
  attention.trackApproval(open, { t: 'approvalDone' });
  check(open.size === 1, 'a decision that names nothing closes the oldest ask');
  check(attention.dshAttention({ open: new Map(), rawState: 'idle', now }).level === 'ready' && attention.dshAttention({ open: new Map(), rawState: 'idle', hasOpenJob: true, now }).level === 'none', 'an idle session is ready, unless a background job keeps it busy');
  check(attention.approvalRef({ data: { id: 'x' } }) === 'x' && attention.approvalRef({ data: { approvalId: 7 } }) === '7' && attention.approvalRef({ data: {} }) === null, 'the approval id is read wherever the log keeps it');

  console.log('\nlog analysis');
  const at = (type, seq, data, time) => ({ type, seq, time, data });
  const analysis = analyzeEvents([
    at('turn/start', 1, { turn: 1 }, now - 50000),
    at('step/start', 2, { turn: 1, step: 1 }, now - 49000),
    at('approval/asked', 3, { id: 'p1', toolName: 'pwsh', callId: 'k1', reason: 'r' }, now - 40000),
    at('approval/asked', 4, { id: 'p2', toolName: 'edit', callId: 'k2', reason: 'r' }, now - 30000),
    at('approval/decided', 5, { id: 'p1', outcome: 'allowed-once' }, now - 20000),
  ], now);
  check(analysis.openApprovals.length === 1 && analysis.openApprovals[0].id === 'p2' && analysis.openApprovals[0].tool === 'edit', 'the analysis lists the asks still open', J(analysis.openApprovals));

  /* -------------------------------------------------- status-file reader --- */
  console.log('\nthe Claude Code status-file reader');
  const sdir = path.join(tmp, 'unit-sessions');
  fs.mkdirSync(sdir, { recursive: true });
  const alivePid = process.pid;
  const dead = deadPid();
  const write = (name, body) => fs.writeFileSync(path.join(sdir, name), typeof body === 'string' ? body : J(body));
  const status = (pid, sessionId, extra = {}) => ({
    pid, sessionId, cwd: 'x', startedAt: now - 60000, updatedAt: now - 2000, status: 'busy', statusUpdatedAt: now - 2000,
    version: '0.0.0', kind: 'interactive', entrypoint: 'test', messagingSocketPath: SECRET_SOCKET, ...extra,
  });
  const KEY_BODY = 'KEYFILE-SENTINEL-DO-NOT-READ';
  write(`${alivePid}.json`, status(alivePid, 'unit-busy'));
  write('4000001.json', status(4000001, 'unit-waiting', { status: 'waiting', waitingFor: 'permission prompt' }));
  write(`${dead}.json`, status(dead, 'unit-dead', { status: 'waiting', waitingFor: 'permission prompt' }));
  write('4000002.json', status(4000002, 'unit-unknown', { status: 'dreaming' }));
  write('4000003.json', status(4000003, 'unit-mismatch', { pid: 4999999 }));
  write('4000004.json', '[1,2,3]');
  write('4000005.json', '{ not json');
  write('4000006.json', status(4000006, '../escape', {}));
  write('4000007.json', status(4000007, 'unit-stale', { updatedAt: now - 3 * 86400000, statusUpdatedAt: now - 3 * 86400000 }));
  write('4000008.json', 'x'.repeat(70 * 1024));
  write('notes.json', status(4000009, 'unit-notes'));
  write('4000001.key', KEY_BODY);
  write(`${alivePid}.key`, KEY_BODY);
  fs.utimesSync(path.join(sdir, '4000007.json'), new Date(now - 3 * 86400000), new Date(now - 3 * 86400000));
  const keyBefore = fs.statSync(path.join(sdir, '4000001.key'));

  // Record every path the reader touches.
  const fsp = require('node:fs/promises');
  const touched = [];
  const originals = {};
  for (const name of ['readFile', 'stat', 'open', 'lstat', 'readdir']) {
    originals[name] = fsp[name];
    fsp[name] = (...args) => { touched.push(String(args[0])); return originals[name](...args); };
  }
  const aliveFn = (pid) => pid === alivePid || pid === 4000001 || pid === 4000002 || pid === 4000004 || pid === 4000007 || pid === 4000008;
  let map;
  try {
    map = await claudeStatus.readStatuses({ dir: sdir, now, alive: aliveFn, fresh: true });
  } finally {
    for (const name of Object.keys(originals)) fsp[name] = originals[name];
  }
  check(map.get('unit-busy')?.status === 'busy', 'a live process with a busy status is read');
  check(map.get('unit-waiting')?.status === 'waiting' && map.get('unit-waiting')?.waitingFor === 'permission prompt', 'a waiting status keeps what it waits for');
  check(!map.has('unit-dead'), 'a status whose process is gone is ignored');
  check(!map.has('unit-unknown') && !map.has('unit-mismatch') && !map.has('../escape') && !map.has('unit-stale') && !map.has('unit-notes'), 'an unknown status, a wrong pid, a bad session id, a stale file and a non-numbered name give no signal', J([...map.keys()]));
  check(map.size === 2, 'nothing else was picked up (bad JSON, arrays and huge files are skipped)', J([...map.keys()]));
  check(!JSON.stringify([...map.values()]).includes(SECRET_SOCKET), 'only status fields are kept; the rest of the file is not copied');
  check(!touched.some((p) => p.endsWith('.key')), 'the .key files are never opened, stat-ed or read', J(touched.filter((p) => p.endsWith('.key'))));
  check(!touched.some((p) => p.endsWith('notes.json')), 'files that are not <pid>.json are not opened');
  const keyAfter = fs.statSync(path.join(sdir, '4000001.key'));
  check(fs.readFileSync(path.join(sdir, '4000001.key'), 'utf8') === KEY_BODY && keyAfter.mtimeMs === keyBefore.mtimeMs, 'a .key file is unchanged after a read');
  check(claudeStatus.pidAlive(process.pid) && !claudeStatus.pidAlive(dead) && !claudeStatus.pidAlive(0) && !claudeStatus.pidAlive(-5) && !claudeStatus.pidAlive('12'), 'process liveness: running, exited, and nonsense pids');
  check((await claudeStatus.readStatuses({ dir: path.join(tmp, 'does-not-exist'), fresh: true })).size === 0, 'a missing folder is no signal, not an error');

  /* ------------------------------------------------------------- server --- */
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const dshRoot = path.join(tmp, 'dsh');
  const dshDir = path.join(dshRoot, '--tmp-attention-workspace--');
  const claudeRoot = path.join(tmp, 'claude');
  const claudeProject = path.join(claudeRoot, 'E--ATTN');
  const agyRoot = path.join(tmp, 'antigravity');
  const statusDir = path.join(tmp, 'claude-sessions');
  const configDir = path.join(tmp, 'config');
  for (const dir of [dshDir, claudeProject, statusDir, configDir, path.join(agyRoot, 'brain')]) fs.mkdirSync(dir, { recursive: true });

  const evt = (type, seq, data, ago) => ({ type, seq, time: Date.now() - ago, data });
  function dshSession(id, events, mtimeAgo = 0) {
    const dir = path.join(dshDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'session.v4.jsonl.zstd');
    fs.writeFileSync(log, frame([{ type: 'session', version: 4, id, createdAt: Date.now() - 3600000, cwd: workspace }, ...events]));
    if (mtimeAgo) fs.utimesSync(log, new Date(Date.now() - mtimeAgo), new Date(Date.now() - mtimeAgo));
    return log;
  }
  const userMsg = (seq, ago) => ({ type: 'user/message', seq, time: Date.now() - ago, data: { role: 'user', content: [{ type: 'text', text: 'Please run the cleanup commands.' }], source: { kind: 'user' } } });
  const callEv = (seq, callId, ago) => evt('tool/call', seq, { turn: 1, step: 1, callId, name: 'pwsh', arguments: J({ command: SECRET_CMD, workdir: workspace }) }, ago);
  const open1 = [evt('turn/start', 1, { turn: 1 }, 60000), evt('step/start', 2, { turn: 1, step: 1 }, 59000), userMsg(3, 58000)];
  const D = {
    open: '11111111-0000-0000-0000-00000000000a',
    two: '11111111-0000-0000-0000-00000000000b',
    closed: '11111111-0000-0000-0000-00000000000c',
    unavailable: '11111111-0000-0000-0000-00000000000d',
    crashed: '11111111-0000-0000-0000-00000000000e',
    ready: '11111111-0000-0000-0000-00000000000f',
    noid: '11111111-0000-0000-0000-000000000010',
  };
  const logs = {};
  logs.open = dshSession(D.open, [...open1, callEv(4, 'k1', 30000), evt('approval/asked', 5, { id: 'ap1', toolName: 'pwsh', callId: 'k1', reason: `wants to run ${SECRET_CMD}` }, 20000)]);
  logs.two = dshSession(D.two, [...open1, evt('approval/asked', 4, { id: 'ap1', toolName: 'pwsh', callId: 'k1', reason: 'r' }, 30000), evt('approval/asked', 5, { id: 'ap2', toolName: 'edit', callId: 'k2', reason: 'r' }, 10000)]);
  logs.closed = dshSession(D.closed, [...open1, evt('approval/asked', 4, { id: 'ap1', toolName: 'pwsh', callId: 'k1', reason: 'r' }, 30000), evt('approval/decided', 5, { id: 'ap1', outcome: 'allowed-once' }, 25000)]);
  logs.unavailable = dshSession(D.unavailable, [...open1, evt('approval/asked', 4, { id: 'ap1', toolName: 'pwsh', callId: 'k1', reason: 'r' }, 30000), evt('approval/decided', 5, { id: 'ap1', outcome: 'unavailable' }, 30000)]);
  const crashAgo = 40 * 60 * 1000;
  logs.crashed = dshSession(D.crashed, [
    evt('turn/start', 1, { turn: 1 }, crashAgo + 3000), evt('step/start', 2, { turn: 1, step: 1 }, crashAgo + 2000), userMsg(3, crashAgo + 1000),
    evt('approval/asked', 4, { id: 'ap1', toolName: 'pwsh', callId: 'k1', reason: 'r' }, crashAgo),
  ], crashAgo);
  logs.ready = dshSession(D.ready, [
    evt('turn/start', 1, { turn: 1 }, 200000), evt('step/start', 2, { turn: 1, step: 1 }, 190000), userMsg(3, 180000),
    evt('step/end', 4, { turn: 1, step: 1 }, 120000), evt('turn/end', 5, { turn: 1 }, 120000),
  ], 120000);
  logs.noid = dshSession(D.noid, [...open1, evt('approval/asked', 4, { toolName: 'pwsh', callId: 'k1', reason: 'r' }, 30000), evt('approval/decided', 5, { outcome: 'allowed-once' }, 25000)]);

  // Claude Code transcripts.
  const iso = (ago) => new Date(Date.now() - ago).toISOString();
  function claudeSession(name, id, entries) {
    const file = path.join(claudeProject, `${id}.jsonl`);
    const lines = entries.map((e) => J({ cwd: workspace, sessionId: id, ...e }));
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }
  const prompt = (ago) => ({ type: 'user', timestamp: iso(ago), message: { role: 'user', content: 'Please clean up the build folder now.' } });
  const say = (ago, text, stop = 'end_turn', mid = `m${ago}`) => ({ type: 'assistant', timestamp: iso(ago), message: { id: mid, model: 'claude-sonnet-5-5', role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const use = (ago, toolId, name, input) => ({ type: 'assistant', timestamp: iso(ago), message: { id: `u${toolId}`, model: 'claude-sonnet-5-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: toolId, name, input }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const result = (ago, toolId, text) => ({ type: 'user', timestamp: iso(ago), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: text, is_error: false }] } });
  const openBash = (id, ago = 30000) => [prompt(ago + 5000), use(ago, `bash-${id}`, 'Bash', { command: SECRET_CMD, description: 'clean up' })];
  const ids = {};
  const cid = (n) => `c0c0c0c0-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
  let n = 0;
  const names = ['permission', 'input', 'sandbox', 'dialog', 'worker', 'novel', 'busy', 'idle', 'deadWaiting', 'unknownShape', 'question', 'answered', 'plan', 'bashOnly'];
  for (const name of names) ids[name] = cid(++n);
  for (const name of ['permission', 'input', 'sandbox', 'dialog', 'worker', 'novel', 'busy', 'deadWaiting', 'unknownShape', 'bashOnly']) claudeSession(name, ids[name], openBash(ids[name]));
  claudeSession('idle', ids.idle, [prompt(90000), say(60000, 'All done.')]);
  claudeSession('question', ids.question, [prompt(90000), use(40000, 'q1', 'AskUserQuestion', { questions: [{ question: 'Which folder should I clean?' }] })]);
  claudeSession('answered', ids.answered, [prompt(90000), use(60000, 'q2', 'AskUserQuestion', { questions: [{ question: 'Which folder?' }] }), result(50000, 'q2', 'the build folder'), say(40000, 'Cleaned it.')]);
  claudeSession('plan', ids.plan, [prompt(90000), use(40000, 'p1', 'ExitPlanMode', { plan: 'Remove the build folder.' })]);

  // Status files: one live process per session that has one.
  const pids = {};
  const statusFile = (name, pid, body) => {
    pids[name] = pid;
    fs.writeFileSync(path.join(statusDir, `${pid}.json`), J({
      pid, sessionId: ids[name], cwd: workspace, startedAt: Date.now() - 600000, updatedAt: Date.now() - 4000, statusUpdatedAt: Date.now() - 4000,
      version: '0.0.0', kind: 'interactive', entrypoint: 'test', messagingSocketPath: SECRET_SOCKET, ...body,
    }));
  };
  statusFile('permission', sleeper(), { status: 'waiting', waitingFor: 'permission prompt' });
  statusFile('input', sleeper(), { status: 'waiting', waitingFor: 'input needed' });
  statusFile('sandbox', sleeper(), { status: 'waiting', waitingFor: 'sandbox request' });
  statusFile('dialog', sleeper(), { status: 'waiting', waitingFor: 'dialog open' });
  statusFile('worker', sleeper(), { status: 'waiting', waitingFor: 'worker request' });
  statusFile('novel', sleeper(), { status: 'waiting', waitingFor: 'something new' });
  statusFile('busy', sleeper(), { status: 'busy' });
  statusFile('idle', sleeper(), { status: 'idle' });
  // A dead process: the transcript has an open question, so that is what counts.
  claudeSession('deadWaiting', ids.deadWaiting, [prompt(90000), use(40000, 'q3', 'AskUserQuestion', { questions: [{ question: 'Which?' }] })]);
  statusFile('deadWaiting', dead, { status: 'waiting', waitingFor: 'permission prompt' });
  // An unknown shape: no signal, so the open Bash call says nothing.
  statusFile('unknownShape', sleeper(), { status: 'pondering' });
  // The files next to the status files must stay shut.
  fs.writeFileSync(path.join(statusDir, `${pids.permission}.key`), KEY_BODY);
  const keyFile = path.join(statusDir, `${pids.permission}.key`);
  const keyMtime = fs.statSync(keyFile).mtimeMs;

  // Antigravity: no signal for an open prompt, whatever the transcript holds.
  const agyConv = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const agyFile = path.join(agyRoot, 'brain', agyConv, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(agyFile), { recursive: true });
  fs.writeFileSync(agyFile, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: iso(20000), content: '<USER_REQUEST>\nClean the build folder\n</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: iso(10000), content: 'Running it.', tool_calls: [{ name: 'run_command', args: { CommandLine: J(SECRET_CMD), Cwd: J(workspace) } }] },
  ].map((l) => J(l)).join('\n') + '\n');

  const procs = [];
  async function launch(args = [], env = {}) {
    const proc = spawn(process.execPath, [path.join(root, 'server.js'), ...args], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(PORT),
        AGENTTAIL_NO_OPEN: '1',
        AGENTTAIL_CONFIG_DIR: configDir,
        DSH_SESSIONS_ROOT: dshRoot,
        CLAUDE_PROJECTS_ROOT: claudeRoot,
        ANTIGRAVITY_ROOT: path.join(agyRoot, 'brain'),
        AGENTTAIL_CLAUDE_SESSIONS_DIR: statusDir,
        DSH_POLL_MS: '150',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => process.stderr.write('  [server:err] ' + d));
    procs.push(proc);
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${BASE}/api/sources`)).ok) break; } catch { /* starting */ }
      await sleep(100);
    }
    return { proc, out: () => out };
  }
  async function stop(server) {
    server.proc.kill();
    await new Promise((resolve) => { server.proc.once('exit', resolve); setTimeout(resolve, 3000); });
    await sleep(300);
  }
  const getJson = async (url, headers = {}) => {
    const res = await fetch(BASE + url, { headers });
    return { status: res.status, body: await res.json().catch(() => ({})), text: '' };
  };
  async function readSse(url, stop, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const events = [];
    try {
      const res = await fetch(url, { signal: controller.signal });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evLine = raw.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
          if (!evLine || !dataLine) continue;
          events.push({ event: evLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
          if (stop(events)) { controller.abort(); return events; }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timer);
    }
    return events;
  }
  const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]));

  let server = await launch();
  try {
    console.log('\ndsh sessions in the list');
    const dshList = await getJson('/api/sessions?source=dsh');
    const d = byId(dshList.body.sessions || []);
    const a = (name) => d[D[name]]?.attention;
    check(a('open')?.level === 'needs-you' && a('open').reason === 'permission' && a('open').via === 'log' && a('open').certainty === 'sure' && a('open').tool === 'pwsh', 'an open ask in a live session needs you', J(a('open')));
    check(a('open')?.detail === 'permission prompt' && a('open').since > 0, 'with a fixed detail and the time it began', J(a('open')));
    check(a('two')?.level === 'needs-you' && a('two').tool === 'pwsh', 'two open asks are one session needing you, since the older one', J(a('two')));
    check(a('closed')?.level === 'none', 'an ask that was decided does not', J(a('closed')));
    check(a('unavailable')?.level === 'none', 'an "unavailable" decision does not need the human', J(a('unavailable')));
    check(a('noid')?.level === 'none', 'an ask and a decision without ids still pair up', J(a('noid')));
    check(d[D.crashed]?.state === 'live' && a('crashed')?.level === 'none', 'an ask left open by a crash, 40 minutes old, is ignored', J(d[D.crashed]));
    check(d[D.ready]?.state === 'idle' && a('ready')?.level === 'ready' && a('ready').via === 'log', 'a turn that ended recently is ready', J(d[D.ready]));
    check(!J(Object.values(d).map((s) => s.attention)).includes('SECRET_COMMAND_TEXT'), 'no attention record carries command text');

    console.log('\nClaude Code sessions in the list');
    const claudeList = await getJson('/api/sessions?source=claude');
    const c = byId(claudeList.body.sessions || []);
    const ca = (name) => c[ids[name]]?.attention;
    check(ca('permission')?.level === 'needs-you' && ca('permission').reason === 'permission' && ca('permission').via === 'status-file' && ca('permission').certainty === 'sure', 'status waiting + permission prompt is a sure permission need', J(ca('permission')));
    check(ca('permission')?.tool === 'Bash' && ca('permission').detail === 'permission prompt', 'with the open tool name (Bash) and no command', J(ca('permission')));
    check(ca('input')?.reason === 'input' && ca('sandbox')?.reason === 'sandbox' && ca('dialog')?.reason === 'dialog', 'input needed, sandbox request and dialog open map to their reasons');
    check(ca('worker')?.level === 'needs-you' && ca('worker').reason === 'unknown' && ca('worker').detail === 'worker request', 'a worker request needs you, reason unknown');
    check(ca('novel')?.level === 'needs-you' && ca('novel').reason === 'unknown' && !J(ca('novel')).includes('something new'), 'an unknown waitingFor still needs you and is not echoed');
    check(c[ids.permission]?.state === 'live' && c[ids.permission].stateDetail === 'waiting for you', 'a waiting process is live', J(c[ids.permission]));
    check(ca('busy')?.level === 'none' && c[ids.busy]?.state === 'live', 'a busy process is live and needs nothing');
    check(ca('idle')?.level === 'ready' && ca('idle').via === 'status-file' && c[ids.idle]?.state === 'idle', 'an idle process is ready and idle');
    check(ca('deadWaiting')?.level === 'needs-you' && ca('deadWaiting').via === 'transcript' && ca('deadWaiting').reason === 'question' && ca('deadWaiting').certainty === 'probable', 'a dead process status is ignored; the transcript question counts', J(ca('deadWaiting')));
    check(ca('unknownShape')?.level === 'none', 'an unknown status shape gives no signal; the open Bash call needs nothing', J(ca('unknownShape')));
    check(ca('bashOnly')?.level === 'none' && c[ids.bashOnly]?.state === 'live', 'an open tool call alone is live but needs nothing', J(c[ids.bashOnly]));
    check(ca('question')?.level === 'needs-you' && ca('question').reason === 'question' && ca('question').certainty === 'probable' && ca('question').tool === 'AskUserQuestion', 'an unanswered AskUserQuestion is a probable question', J(ca('question')));
    check(ca('plan')?.level === 'needs-you' && ca('plan').detail === 'plan approval' && ca('plan').tool === 'ExitPlanMode', 'an unanswered ExitPlanMode is a plan approval', J(ca('plan')));
    check(ca('answered')?.level === 'ready' && ca('answered').via === 'transcript', 'an answered question and an end_turn is ready', J(ca('answered')));
    check(!J(claudeList.body).includes('SECRET_COMMAND_TEXT') && !J(claudeList.body).includes(SECRET_SOCKET) && !J(claudeList.body).includes('KEYFILE'), 'the list carries no command text, socket path or key file content');

    console.log('\nthe agents overview');
    const agents = await getJson('/api/agents');
    const all = (agents.body.groups || []).flatMap((g) => g.agents);
    const needing = all.filter((x) => x.attention?.level === 'needs-you');
    check(needing.length === agents.body.needsYou, 'the overview counts the sessions that need you once each', `${needing.length} vs ${agents.body.needsYou}`);
    const expectNeeding = [D.open, D.two, ids.permission, ids.input, ids.sandbox, ids.dialog, ids.worker, ids.novel, ids.deadWaiting, ids.question, ids.plan];
    check(expectNeeding.every((id) => needing.some((x) => x.id === id)) && needing.length === expectNeeding.length, 'every source is in it: dsh, status-file Claude Code and transcript Claude Code', J(needing.map((x) => [x.source, x.id.slice(-2), x.attention.via])));
    const firstReady = all.findIndex((x) => x.attention?.level !== 'needs-you');
    check(all.slice(0, needing.length).every((x) => x.attention?.level === 'needs-you') && (firstReady === -1 || firstReady >= needing.length), 'sessions that need you come first');
    const group = agents.body.groups.find((g) => g.agents.some((x) => x.attention?.level === 'needs-you'));
    check(group && group.needsYou === group.agents.filter((x) => x.attention?.level === 'needs-you').length && agents.body.groups[0].needsYou > 0, 'a group says how many need you and groups that do come first');
    const agySessions = (await getJson('/api/sessions?source=antigravity')).body.sessions || [];
    check(agySessions.length === 1 && agySessions[0].attention?.level === 'none', 'Antigravity gives no attention, whatever it is doing', J(agySessions[0]?.attention));
    check(all.filter((x) => x.source === 'antigravity').every((x) => x.attention?.level === 'none'), 'and the overview agrees');
    check(!J(needing.map((x) => x.attention)).includes('SECRET_COMMAND_TEXT') && !J(needing.map((x) => x.attention)).includes('/'), 'attention records in the overview hold no command text and no path');

    console.log('\nthe live status event');
    const live = await readSse(`${BASE}/api/stream?source=claude&id=${ids.permission}&lite=1`, (events) => events.some((e) => e.event === 'status'));
    const liveStatus = live.find((e) => e.event === 'status')?.data;
    const liveMeta = live.find((e) => e.event === 'meta')?.data;
    check(liveStatus?.attention?.level === 'needs-you' && liveStatus.attention.reason === 'permission' && liveStatus.attention.via === 'status-file', 'the status event carries the attention record', J(liveStatus?.attention));
    check(liveMeta?.session?.attention?.level === 'needs-you' && liveStatus.state === 'live', 'and so does the stream meta; the state comes from the status file', J(liveMeta?.session?.attention));
    const dshLive = await readSse(`${BASE}/api/stream?source=dsh&id=${D.open}&lite=1`, (events) => events.some((e) => e.event === 'status'));
    check(dshLive.find((e) => e.event === 'status')?.data?.attention?.via === 'log', 'a dsh stream reports its open ask from the log');
    const idleLive = await readSse(`${BASE}/api/stream?source=claude&id=${ids.idle}&lite=1`, (events) => events.some((e) => e.event === 'status'));
    const idleStatus = idleLive.find((e) => e.event === 'status')?.data;
    check(idleStatus?.attention?.level === 'ready' && idleStatus.state === 'idle', 'an idle Claude Code stream is ready');

    console.log('\nchanges while the server runs');
    // busy -> waiting
    const busyFile = path.join(statusDir, `${pids.busy}.json`);
    const busyBody = JSON.parse(fs.readFileSync(busyFile, 'utf8'));
    fs.writeFileSync(busyFile, J({ ...busyBody, status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now() }));
    let flipped = null;
    for (let i = 0; i < 40 && !(flipped?.level === 'needs-you'); i++) {
      await sleep(250);
      flipped = byId((await getJson('/api/sessions?source=claude')).body.sessions || [])[ids.busy]?.attention;
    }
    check(flipped?.level === 'needs-you' && flipped.reason === 'permission', 'a busy session that starts waiting is seen within a few seconds', J(flipped));
    fs.rmSync(busyFile);
    let gone = null;
    for (let i = 0; i < 40 && gone?.level !== 'none'; i++) {
      await sleep(250);
      gone = byId((await getJson('/api/sessions?source=claude')).body.sessions || [])[ids.busy]?.attention;
    }
    check(gone?.level === 'none', 'and stops when its status file goes away (the open Bash call says nothing)', J(gone));
    // dsh: the ask gets decided
    fs.appendFileSync(logs.open, frame([evt('approval/decided', 6, { id: 'ap1', outcome: 'allowed-once' }, 0)]));
    let decided = null;
    for (let i = 0; i < 40 && decided?.level !== 'none'; i++) {
      await sleep(250);
      decided = byId((await getJson('/api/sessions?source=dsh')).body.sessions || [])[D.open]?.attention;
    }
    check(decided?.level === 'none', 'a dsh ask stops needing you once it is decided', J(decided));
    fs.appendFileSync(logs.open, frame([evt('approval/asked', 7, { id: 'ap2', toolName: 'edit', callId: 'k3', reason: 'r' }, 0)]));
    let again = null;
    for (let i = 0; i < 40 && again?.level !== 'needs-you'; i++) {
      await sleep(250);
      again = byId((await getJson('/api/sessions?source=dsh')).body.sessions || [])[D.open]?.attention;
    }
    check(again?.level === 'needs-you' && again.tool === 'edit', 'and a new ask needs you again', J(again));

    console.log('\nfiles we must leave alone');
    check(fs.readFileSync(keyFile, 'utf8') === KEY_BODY && fs.statSync(keyFile).mtimeMs === keyMtime, 'the .key file next to the status files is untouched');

    console.log('\nthe inbox endpoint is control only');
    const noControl = await getJson('/api/control/approvals');
    check(noControl.status === 404, 'without --allow-control there is no /api/control/approvals', String(noControl.status));
  } finally {
    await stop(server);
  }

  server = await launch(['--allow-control']);
  try {
    const locked = await getJson('/api/control/approvals');
    check(locked.status === 403, 'in stream mode the inbox endpoint is locked', String(locked.status));
  } finally {
    await stop(server);
  }

  /* ------------------------------------------------- owned (ACP) session --- */
  console.log('\nan owned session (ACP)');
  const controlFile = path.join(configDir, 'control.json');
  const auditFile = path.join(configDir, 'control-audit.log');
  fs.writeFileSync(controlFile, J({ workspaces: [workspace], dshProfile: 'acp', maxSessions: 2 }));
  const ownedRoot = path.join(tmp, 'owned-dsh');
  fs.mkdirSync(ownedRoot, { recursive: true });
  server = await launch(['--allow-control', '--no-stream-mode'], {
    DSH_SESSIONS_ROOT: ownedRoot,
    CLAUDE_PROJECTS_ROOT: path.join(tmp, 'no-claude'),
    ANTIGRAVITY_ROOT: path.join(tmp, 'no-antigravity'),
    AGENTTAIL_CONTROL_FILE: controlFile,
    AGENTTAIL_CONTROL_AUDIT_FILE: auditFile,
    AGENTTAIL_DSH_BIN: process.execPath,
    AGENTTAIL_DSH_ARGS: J([path.join(import.meta.dirname, 'fake-acp.mjs')]),
    OLLAMA_API_KEY: 'fake-key',
  });
  try {
    const token = /#token=([A-Za-z0-9_-]{20,})/.exec(server.out())?.[1];
    check(!!token, 'the server prints a control token');
    const authed = { Authorization: `Bearer ${token}` };
    const post = async (p, body) => {
      const res = await fetch(BASE + p, { method: 'POST', headers: { Origin: BASE, 'Content-Type': 'application/json', ...authed }, body: J(body) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    check((await getJson('/api/control/approvals')).status === 401, 'the inbox endpoint needs the control token');
    check(((await getJson('/api/control/approvals', authed)).body.approvals || []).length === 0, 'with the token and nothing pending it is an empty list');

    const begun = await post('/api/control/session/begin', { cwd: workspace, preset: 'workspace-write' });
    const sid = begun.body?.session?.id;
    check(begun.status === 200 && !!sid, 'a session begins', J(begun.body).slice(0, 200));
    const started = await post('/api/control/session/start', { id: sid, message: 'run the fake command' });
    check(started.status === 200, 'its first message starts a turn', J(started.body).slice(0, 200));
    let pending = [];
    for (let i = 0; i < 40 && !pending.length; i++) {
      await sleep(150);
      pending = (await getJson('/api/control/approvals', authed)).body.approvals || [];
    }
    check(pending.length === 1 && pending[0].sessionId === sid && pending[0].source === 'dsh', 'the inbox lists the pending approval with its session', J(pending).slice(0, 300));
    check(pending[0]?.approval?.command === 'echo fake-ok' && !!pending[0]?.approval?.approvalId && Array.isArray(pending[0].approval.options), 'with the exact command and its options for the card');

    const owner = byId((await getJson('/api/sessions?source=dsh')).body.sessions || [])[sid];
    check(owner?.owned === true && owner.attention?.level === 'needs-you' && owner.attention.via === 'acp' && owner.attention.certainty === 'sure', 'the owned session needs you via ACP, sure', J(owner?.attention));
    check(!J(owner?.attention).includes('echo fake-ok'), 'and the record carries no command');

    // The same prompt is also in the session log: the session must count once.
    let logPath = null;
    const find = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) find(p);
        else if (entry.name === 'session.v4.jsonl.zstd') logPath = p;
      }
    };
    find(ownedRoot);
    fs.appendFileSync(logPath, frame([evt('approval/asked', 900, { id: 'dup1', toolName: 'pwsh', callId: 'call_fake_1', reason: 'r' }, 0)]));
    let merged = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      merged = await getJson('/api/agents');
      const mine = (merged.body.groups || []).flatMap((g) => g.agents).find((x) => x.id === sid);
      if (mine?.attention?.level === 'needs-you') break;
    }
    const mine = (merged.body.groups || []).flatMap((g) => g.agents).find((x) => x.id === sid);
    check(merged.body.needsYou === 1 && mine?.attention?.via === 'acp' && mine.approvals === 1, 'ACP and the log saw the same prompt: one session, counted once, via ACP', J({ needsYou: merged.body.needsYou, via: mine?.attention?.via, approvals: mine?.approvals }));
    const ownedStream = await readSse(`${BASE}/api/stream?source=dsh&id=${sid}&lite=1`, (events) => events.some((e) => e.event === 'status'));
    check(ownedStream.find((e) => e.event === 'status')?.data?.attention?.via === 'acp', 'the status event of an owned session carries the ACP signal');

    // Approve in place, with the endpoint the session page uses.
    fs.appendFileSync(logPath, frame([evt('approval/decided', 901, { id: 'dup1', outcome: 'allowed-once' }, 0)]));
    const decision = await post('/api/control/approval', { id: sid, approvalId: pending[0].approvalId || pending[0].approval.approvalId, decision: 'approve' });
    check(decision.status === 200, 'the existing approval endpoint answers the inbox', J(decision.body).slice(0, 200));
    let after = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      after = byId((await getJson('/api/sessions?source=dsh')).body.sessions || [])[sid];
      if (after && after.attention?.level !== 'needs-you') break;
    }
    check(((await getJson('/api/control/approvals', authed)).body.approvals || []).length === 0, 'once approved the inbox is empty again');
    check(after?.attention?.level !== 'needs-you', 'and the session no longer needs you', J(after?.attention));
    await post('/api/control/close', { id: sid });
  } finally {
    await stop(server);
  }
} catch (err) {
  console.error(err);
  failures.push(String((err && err.stack) || err));
} finally {
  for (const child of children) { try { child.kill(); } catch { /* gone */ } }
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('all attention checks passed');
process.exit(0);
