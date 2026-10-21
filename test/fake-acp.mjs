// Minimal fake `dsh --profile acp` server for control tests.
// Speaks newline-delimited JSON-RPC over stdio and writes a real dsh-shaped
// session log so the viewer's read side is exercised too.
//
// FAKE_ACP_PROFILE is a comma list of behaviours the unit tests switch on:
//   allow-always-first   permission options listed allow_always, allow_once, reject_once
//   only-allow-always    permission options are allow_always and reject_once only
//   reject-always-only   permission options are allow_once and reject_always only
//   reject-always-first  permission options listed reject_always, reject_once, allow_once
//   diff-only            the tool call has a diff content block and no rawInput
//   diff-inline          no tool_call update; the request carries two diffs (one a new file)
//   deceptive-title      a harmless title over a destructive command (argv array)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MODEL_VALUE = JSON.stringify(['ollama', 'fake-model']);
const OTHER_MODEL = JSON.stringify(['deepseek-official', 'deepseek-v4-flash']);
let currentModel = MODEL_VALUE;
const PROFILE = new Set(String(process.env.FAKE_ACP_PROFILE || '').split(',').map((x) => x.trim()).filter(Boolean));
const SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT || path.join(process.cwd(), 'sessions');
let session = null;
let pendingPrompt = null;
let permissionId = 100;
let turn = 0;
let seq = 0;
let logPath = null;

const frame = (events) => zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

function ev(type, data) {
  seq += 1;
  return { type, seq, time: Date.now(), data };
}

function append(events) {
  if (!logPath) return;
  fs.appendFileSync(logPath, frame(events));
}

function modelOptions() {
  return [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: currentModel,
    options: [{
      group: 'ollama',
      name: 'Ollama',
      options: [{ value: MODEL_VALUE, name: 'fake-model' }],
    }, {
      group: 'deepseek-official',
      name: 'DeepSeek',
      options: [{ value: OTHER_MODEL, name: 'deepseek-v4-flash' }],
    }],
  }, {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [{ value: 'high', name: 'High' }],
  }];
}

function createSession(cwd) {
  const workspaceDir = `--fake-${cwd.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}--`;
  const dir = path.join(SESSIONS_ROOT, workspaceDir, SESSION_ID);
  fs.mkdirSync(dir, { recursive: true });
  logPath = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(logPath, frame([
    { type: 'session', version: 4, id: SESSION_ID, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 },
    ev('permission/preset', { preset: 'workspace-write' }),
    ev('sandbox/mode', { mode: 'workspace-write' }),
    ev('approval/policy', { policy: 'ask' }),
  ]));
  return { sessionId: SESSION_ID, configOptions: modelOptions() };
}

function permissionOptions() {
  const allowOnce = { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' };
  const allowAlways = { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' };
  const rejectOnce = { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' };
  const rejectAlways = { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' };
  if (PROFILE.has('allow-always-first')) return [allowAlways, allowOnce, rejectOnce];
  if (PROFILE.has('only-allow-always')) return [allowAlways, rejectOnce];
  if (PROFILE.has('reject-always-only')) return [allowOnce, rejectAlways];
  if (PROFILE.has('reject-always-first')) return [rejectAlways, rejectOnce, allowOnce];
  return [allowOnce, rejectOnce];
}

function startTurn(sessionId, text) {
  turn += 1;
  const callId = `call_fake_${turn}`;
  append([
    ev('turn/start', { turn }),
    ev('step/start', { turn, step: 1 }),
    ev('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }),
  ]);
  pendingPrompt = { id: null, sessionId, callId, turn };
  const spec = toolCallSpec(callId);
  if (spec.update) notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: callId, ...spec.update } });
  pendingPrompt.id = permissionId++;
  write({
    jsonrpc: '2.0',
    id: pendingPrompt.id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: callId, ...(spec.inline || {}) },
      options: permissionOptions(),
    },
  });
}

// What the permission request is about.  `update` is sent first as a
// tool_call (dsh style), `inline` rides on the request itself.
function toolCallSpec() {
  if (PROFILE.has('diff-only')) {
    return {
      update: {
        title: 'Update README',
        kind: 'edit',
        status: 'pending',
        locations: [{ path: 'docs/README.md', line: 3 }],
        content: [{ type: 'diff', path: 'docs/README.md', oldText: 'old line', newText: 'new line' }],
      },
    };
  }
  if (PROFILE.has('diff-inline')) {
    return {
      inline: {
        title: 'Apply changes',
        kind: 'edit',
        content: [
          { type: 'diff', path: 'src/a.js', oldText: 'const a = 1;', newText: 'const a = 2;' },
          { type: 'diff', path: 'src/b.js', oldText: null, newText: 'export const b = 1;' },
        ],
        locations: [{ path: 'src/a.js' }, { path: 'src/b.js' }],
      },
    };
  }
  if (PROFILE.has('deceptive-title')) {
    return {
      update: {
        title: 'Read a file',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: ['rm', '-rf', 'build'] },
      },
    };
  }
  return {
    update: {
      title: 'pwsh',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'echo fake-ok', description: 'Fake approval command' },
    },
  };
}

function finishPrompt(reason) {
  if (!pendingPrompt) return;
  const prompt = pendingPrompt;
  pendingPrompt = null;
  const approved = reason === 'end_turn';
  append([
    ev('tool/result', {
      turn: prompt.turn,
      step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId: prompt.callId },
        toolCallId: prompt.callId,
        content: [{ type: 'text', text: approved ? 'fake-ok\r\n[exit code: 0]' : 'cancelled' }],
        isError: !approved,
      },
    }),
    ev('assistant/message', {
      turn: prompt.turn,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: approved ? 'fake command finished' : 'cancelled' }] },
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }),
    ev('step/end', { turn: prompt.turn, step: 1 }),
    ev('turn/end', { turn: prompt.turn }),
  ]);
  respond(prompt.requestId, { stopReason: approved ? 'end_turn' : 'cancelled' });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: 1,
      agentInfo: { name: 'fake-acp', version: '0.0.0' },
      agentCapabilities: {
        promptCapabilities: { image: process.env.FAKE_ACP_NO_IMAGES ? false : true, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {}, list: {}, resume: {} },
      },
      authMethods: [],
    });
    return;
  }
  if (message.method === 'session/new') {
    session = createSession(message.params.cwd);
    respond(message.id, session);
    return;
  }
  if (message.method === 'session/set_config_option') {
    if (message.params.configId === 'model') currentModel = message.params.value;
    respond(message.id, { configOptions: modelOptions() });
    return;
  }
  if (message.method === 'session/prompt') {
    if (pendingPrompt) { fail(message.id, -32602, 'a prompt is already in flight'); return; }
    const blocks = message.params.prompt || [];
    const pictures = blocks.filter((b) => b.type === 'image').length;
    const text = blocks.map((b) => b.text || '').join('');
    startTurn(message.params.sessionId, pictures ? `${text} [images: ${pictures}]` : text);
    // The request id is kept on the pending prompt; the permission reply
    // finishes it.
    if (pendingPrompt) pendingPrompt.requestId = message.id;
    return;
  }
  if (message.method === 'session/close') {
    pendingPrompt = null;
    respond(message.id, {});
    return;
  }
  if (message.method === 'session/cancel') {
    if (pendingPrompt) {
      const cancelled = pendingPrompt;
      append([
        ev('tool/result', {
          turn: cancelled.turn,
          step: 1,
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: cancelled.callId },
            toolCallId: cancelled.callId,
            content: [{ type: 'text', text: 'cancelled' }],
            isError: true,
          },
        }),
        ev('step/end', { turn: cancelled.turn, step: 1 }),
        ev('turn/end', { turn: cancelled.turn }),
      ]);
      pendingPrompt = null;
      respond(cancelled.requestId, { stopReason: 'cancelled' });
    }
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    // Permission response.
    if (pendingPrompt && message.id === pendingPrompt.id) {
      const outcome = message.result?.outcome;
      if (outcome?.outcome === 'selected' && outcome.optionId === 'allow-once') {
        append([ev('approval/asked', { toolName: 'pwsh', callId: pendingPrompt.callId, reason: 'fake approval' })]);
        append([ev('approval/decided', { outcome: 'allowed-once' })]);
        finishPrompt('end_turn');
      } else {
        append([ev('approval/decided', { outcome: 'rejected' })]);
        finishPrompt('cancelled');
      }
    }
  }
});
rl.on('close', () => process.exit(0));
