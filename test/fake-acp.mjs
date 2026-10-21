// Minimal fake `dsh --profile acp` server for control tests.
// Speaks newline-delimited JSON-RPC over stdio and writes a real dsh-shaped
// session log so the viewer's read side is exercised too.
//
// FAKE_ACP_PROFILE is a comma list of behaviours the unit tests switch on:
//   allow-always-first   permission options listed allow_always, allow_once, reject_once
//   only-allow-always    permission options are allow_always and reject_once only
//   reject-always-only   permission options are allow_once and reject_always only
//   reject-always-first  permission options listed reject_always, reject_once, allow_once
//   no-reject-option     permission options are allow_once only
//   diff-only            the tool call has a diff content block and no rawInput
//   diff-inline          no tool_call update; the request carries two diffs (one a new file)
//   deceptive-title      a harmless title over a destructive command (argv array)
//   facts-late           a tool call with only a path, the request, then the diff in a tool_call_update
//   command-changes      a tool call with one command, the request, then an update with a different command
//   no-facts             a tool call with a title and nothing else
//   modes                a `mode` config option (default, plan, bypass)
//   legacy-modes         Session Modes (ask, code) in session/new and session/set_mode
//   free-option         a select option (`note`) that declares no choices
//   one-model, no-model  a one-value model option, or none
//   no-images            promptCapabilities.image false (FAKE_ACP_NO_IMAGES does the same)
//   embedded-context, mcp-http, auth-methods   other declared capabilities
//   no-close             sessionCapabilities without close
//   crash-on-start       exit 7 with a line on stderr when initialize arrives
//   crash-on-prompt      exit 3 with a line on stderr when a prompt arrives
//   oversize-line        a prompt is answered with 9 MiB on stdout and no newline
//   prompt-error         a prompt is answered with a JSON-RPC error
//   finish-with-card     a permission request goes out and the prompt ends at once, unanswered
//   error-with-card      the same, but the prompt ends with a JSON-RPC error
//   late-permission      a session/cancel is answered by one more permission request, then the prompt ends
//   no-log               do not write the dsh-shaped session log (for non-dsh harnesses)
// FAKE_ACP_MARK=<file> appends one line per session/new, config, mode and close
// request, and one `reply:<id>:<outcome>` per answer to a permission request;
// FAKE_ACP_ENV_FILE=<file> receives the names of the environment variables.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MODEL_VALUE = JSON.stringify(['ollama', 'fake-model']);
const OTHER_MODEL = JSON.stringify(['deepseek-official', 'deepseek-v4-flash']);
const PROFILE = new Set(String(process.env.FAKE_ACP_PROFILE || '').split(',').map((x) => x.trim()).filter(Boolean));
let currentModel = MODEL_VALUE;
let currentMode = PROFILE.has('legacy-modes') ? 'ask' : 'default';
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

function mark(line) {
  if (process.env.FAKE_ACP_MARK) fs.appendFileSync(process.env.FAKE_ACP_MARK, `${line}\n`);
}

function modelOptions() {
  const out = [];
  if (!PROFILE.has('no-model')) {
    const choices = PROFILE.has('one-model')
      ? [{ group: 'ollama', name: 'Ollama', options: [{ value: MODEL_VALUE, name: 'fake-model' }] }]
      : [{
        group: 'ollama',
        name: 'Ollama',
        options: [{ value: MODEL_VALUE, name: 'fake-model' }],
      }, {
        group: 'deepseek-official',
        name: 'DeepSeek',
        options: [{ value: OTHER_MODEL, name: 'deepseek-v4-flash' }],
      }];
    out.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: currentModel,
      options: choices,
    });
  }
  out.push({
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [{ value: 'high', name: 'High' }],
  });
  if (PROFILE.has('free-option')) {
    out.push({ id: 'note', name: 'Note', category: 'other', type: 'select', currentValue: 'a', options: [] });
  }
  if (PROFILE.has('modes')) {
    out.push({
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: currentMode,
      options: [
        { value: 'default', name: 'Ask before edits' },
        { value: 'plan', name: 'Plan only' },
        { value: 'bypass', name: 'Bypass permissions' },
      ],
    });
  }
  return out;
}

// Older agents offer Session Modes instead of a mode config option.
function legacyModes() {
  return {
    currentModeId: currentMode,
    availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }],
  };
}

function createSession(cwd) {
  const created = { sessionId: SESSION_ID, configOptions: modelOptions() };
  if (PROFILE.has('legacy-modes')) created.modes = legacyModes();
  if (PROFILE.has('no-log')) return created;
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
  return created;
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
  if (PROFILE.has('no-reject-option')) return [allowOnce];
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
  // More detail about the same tool call, after the request was raised.
  if (spec.after) notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: callId, ...spec.after } });
}

// What the permission request is about.  `update` is sent first as a
// tool_call (dsh style), `inline` rides on the request itself.
function toolCallSpec() {
  if (PROFILE.has('facts-late')) {
    return {
      update: { title: 'Edit src/a.js', kind: 'edit', status: 'pending', locations: [{ path: 'src/a.js' }] },
      after: { status: 'pending', content: [{ type: 'diff', path: 'src/a.js', oldText: 'const a = 1;', newText: 'const a = 2;' }] },
    };
  }
  if (PROFILE.has('command-changes')) {
    return {
      update: { title: 'Run a check', kind: 'execute', status: 'pending', rawInput: { command: 'echo safe' } },
      after: { rawInput: { command: 'rm -rf build' } },
    };
  }
  if (PROFILE.has('no-facts')) {
    return { update: { title: 'Do something', status: 'pending' } };
  }
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
    if (process.env.FAKE_ACP_ENV_FILE) fs.writeFileSync(process.env.FAKE_ACP_ENV_FILE, JSON.stringify(Object.keys(process.env)));
    if (PROFILE.has('crash-on-start')) {
      process.stderr.write('fake-acp: cannot load its configuration (synthetic failure)\n');
      process.exit(7);
    }
    respond(message.id, {
      protocolVersion: 1,
      agentInfo: { name: 'fake-acp', version: '0.0.0' },
      agentCapabilities: {
        promptCapabilities: {
          image: !(process.env.FAKE_ACP_NO_IMAGES || PROFILE.has('no-images')),
          audio: false,
          embeddedContext: PROFILE.has('embedded-context'),
        },
        mcpCapabilities: PROFILE.has('mcp-http') ? { http: true } : {},
        sessionCapabilities: PROFILE.has('no-close') ? { list: {} } : { close: {}, list: {}, resume: {} },
      },
      authMethods: PROFILE.has('auth-methods') ? [{ id: 'login', name: 'Log in' }] : [],
    });
    return;
  }
  if (message.method === 'session/new') {
    mark(`new:${JSON.stringify(message.params.mcpServers || [])}`);
    session = createSession(message.params.cwd);
    respond(message.id, session);
    return;
  }
  if (message.method === 'session/set_config_option') {
    mark(`config:${message.params.configId}=${message.params.value}`);
    if (message.params.configId === 'model') currentModel = message.params.value;
    if (message.params.configId === 'mode') currentMode = message.params.value;
    respond(message.id, { configOptions: modelOptions() });
    return;
  }
  if (message.method === 'session/set_mode') {
    mark(`mode:${message.params.modeId}`);
    currentMode = message.params.modeId;
    respond(message.id, {});
    return;
  }
  if (message.method === 'session/prompt') {
    if (PROFILE.has('oversize-line')) {
      process.stdout.write('x'.repeat(9 * 1024 * 1024));
      return;
    }
    if (PROFILE.has('finish-with-card') || PROFILE.has('error-with-card')) {
      const callId = 'call_card';
      notify('session/update', {
        sessionId: message.params.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: callId, title: 'pwsh', kind: 'other', rawInput: { command: 'echo card' } },
      });
      write({
        jsonrpc: '2.0',
        id: permissionId++,
        method: 'session/request_permission',
        params: { sessionId: message.params.sessionId, toolCall: { toolCallId: callId }, options: permissionOptions() },
      });
      if (PROFILE.has('error-with-card')) fail(message.id, -32000, 'the turn failed with a request still open (synthetic failure)');
      else respond(message.id, { stopReason: 'end_turn' });
      return;
    }
    if (PROFILE.has('prompt-error')) { fail(message.id, -32000, 'the model backend refused the request (synthetic failure)'); return; }
    if (PROFILE.has('crash-on-prompt')) {
      process.stderr.write('fake-acp: the model backend went away (synthetic failure)\n');
      process.exit(3);
    }
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
    mark('close');
    pendingPrompt = null;
    respond(message.id, {});
    return;
  }
  if (message.method === 'session/cancel') {
    if (pendingPrompt && PROFILE.has('late-permission')) {
      write({
        jsonrpc: '2.0',
        id: permissionId++,
        method: 'session/request_permission',
        params: { sessionId: pendingPrompt.sessionId, toolCall: { toolCallId: pendingPrompt.callId }, options: permissionOptions() },
      });
    }
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
    mark(`reply:${message.id}:${message.result?.outcome?.outcome || 'none'}`);
    // late-permission keeps the turn open until the session/cancel itself arrives.
    if (PROFILE.has('late-permission') && message.result?.outcome?.outcome === 'cancelled') return;
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
