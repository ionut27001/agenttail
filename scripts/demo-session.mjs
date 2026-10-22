#!/usr/bin/env node
/**
 * Generate a synthetic demo session for screenshots and local testing.
 *
 *   node scripts/demo-session.mjs [--dir <dir>] [--play] [--delay <ms>] [--team]
 *
 * The demo workspace, session log and configs contain no real user data. With
 * --play the remaining events are appended live so the dashboard animations can
 * be captured. --team adds two teammate sessions in the same workspace for the
 * watch wall; --team-append plays their live part.
 */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DEFAULT_ROOT = process.platform === 'win32'
  ? 'C:\\ProgramData\\agenttail-demo'
  : path.join(os.tmpdir(), 'agenttail-demo');
const ROOT = path.resolve(argValue('--dir', DEFAULT_ROOT));
const PLAY = args.includes('--play');
const DELAY = Number(argValue('--delay', 1600));
const HISTORY_TURNS = Number(argValue('--history-turns', 3));
const WORKSPACE = path.join(ROOT, 'workspace');
const SESSIONS = path.join(ROOT, 'sessions');
const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555';
const SESSION_DIR = path.join(SESSIONS, '--demo-workspace--', SESSION_ID);
const LOG = path.join(SESSION_DIR, 'session.v4.jsonl.zstd');
const BUILD_LOG = path.join(WORKSPACE, 'build.log');
const NOW = Date.now();
const TEAM = args.includes('--team');
// Two teammates in the same workspace, so the watch wall has agents to show.
const TEAMMATES = [
  { id: 'session-66666666-7777-8888-9999-000000000001', title: 'Add divide() with tests' },
  { id: 'session-66666666-7777-8888-9999-000000000002', title: 'Document the calculator API' },
].map((mate) => ({ ...mate, log: path.join(SESSIONS, '--demo-workspace--', mate.id, 'session.v4.jsonl.zstd') }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = (event) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n'));
const append = (event) => fs.appendFileSync(LOG, frame(event));
const appendTo = (log, event) => fs.appendFileSync(log, frame(event));
const event = (type, seq) => ({ type, seq, time: Date.now() });

function writeWorkspace() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORKSPACE, 'src'), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE, 'test'), { recursive: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'package.json'), JSON.stringify({
    name: 'demo-calculator',
    private: true,
    type: 'module',
    scripts: { test: 'node --test' },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(WORKSPACE, 'README.md'), [
    '# demo-calculator',
    '',
    'A tiny calculator project.',
    '',
    'Run `npm test` to execute the checks.',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(WORKSPACE, 'src', 'calculator.js'), [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'export function multiply(a, b) {',
    '  return a * b;',
    '}',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(WORKSPACE, 'test', 'calculator.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add, multiply } from '../src/calculator.js';",
    '',
    "test('add', () => assert.equal(add(20, 22), 42));",
    "test('multiply', () => assert.equal(multiply(6, 7), 42));",
  ].join('\n') + '\n');
  fs.writeFileSync(BUILD_LOG, '');
  fs.writeFileSync(path.join(ROOT, 'roots.json'), JSON.stringify({
    roots: [],
    privateRoots: [],
    ignore: ['.git', '.tmp', 'node_modules', 'build', 'build-*', 'dist', 'target', '_*'],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(ROOT, 'redact.json'), JSON.stringify({ literals: [], patterns: [] }, null, 2) + '\n');
  fs.writeFileSync(path.join(ROOT, 'nicknames.json'), '{}\n');
}

function initialHistory() {
  const events = [];
  let seq = 1;
  events.push({
    type: 'session', seq: seq++, time: NOW - 240000,
    id: SESSION_ID, version: 4, cwd: WORKSPACE, createdAt: NOW - 240000,
    isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  });
  events.push({
    type: 'session/title', seq: seq++, time: NOW - 239000,
    data: { title: 'Fix the calculator demo and run the suite' },
  });
  // A few earlier steps make the session look lived-in and give the loading
  // screen enough history to be visible for a moment.
  for (let turn = 1; turn <= HISTORY_TURNS; turn++) {
    events.push({ type: 'turn/start', seq: seq++, time: NOW - 230000 + turn * 1000, data: { turn } });
    events.push({
      type: 'user/message', seq: seq++, time: NOW - 229000 + turn * 1000,
      data: { role: 'user', content: [{ type: 'text', text: `Demo request ${turn}: keep the sample project tidy.` }], source: { kind: 'user' } },
    });
    events.push({ type: 'step/start', seq: seq++, time: NOW - 228000 + turn * 1000, data: { turn, step: turn } });
    events.push({
      type: 'assistant/message', seq: seq++, time: NOW - 227000 + turn * 1000,
      data: {
        turn, step: turn,
        message: {
          role: 'assistant',
          source: { provider: 'deepseek-official', model: 'deepseek-flash' },
          content: [
            { type: 'reasoning', text: 'Checking the project layout before changing anything.' },
            { type: 'text', text: `Working on demo step ${turn}.` },
          ],
        },
        usage: { inputTokens: 800, outputTokens: 30, cacheReadTokens: 1200, cacheWriteTokens: 0, totalTokens: 2030 },
      },
    });
    events.push({ type: 'step/end', seq: seq++, time: NOW - 226000 + turn * 1000, data: { turn, step: turn } });
    events.push({ type: 'turn/end', seq: seq++, time: NOW - 225000 + turn * 1000, data: { turn } });
  }
  events.push({ type: 'turn/start', seq: seq++, time: NOW, data: { turn: 4 } });
  events.push({
    type: 'user/message', seq: seq++, time: NOW,
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'Please fix add(), run the tests and show me the build progress.' }],
      source: { kind: 'user' },
    },
  });
  events.push({ type: 'step/start', seq: seq++, time: NOW, data: { turn: 4, step: 1 } });
  for (const e of events) append(e);
}

const call = (seq, turn, step, name, callId, input) => append({
  type: 'tool/call', seq: seq++, time: Date.now(),
  data: { turn, step, callId, name, arguments: JSON.stringify(input) },
});
const result = (seq, turn, step, callId, text, isError = false) => append({
  type: 'tool/result', seq: seq++, time: Date.now(),
  data: {
    turn, step,
    message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError },
  },
});

function teamHistory() {
  for (const [i, mate] of TEAMMATES.entries()) {
    fs.mkdirSync(path.dirname(mate.log), { recursive: true });
    const at = NOW - 90000 + i * 5000;
    let seq = 1;
    const put = (type, data, extra = {}) => appendTo(mate.log, { type, seq: seq++, time: at + seq * 400, ...extra, ...(data ? { data } : {}) });
    put('session', null, { id: mate.id, version: 4, cwd: WORKSPACE, createdAt: at, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' });
    put('session/title', { title: mate.title });
    put('turn/start', { turn: 1 });
    put('user/message', { role: 'user', content: [{ type: 'text', text: `${mate.title}.` }], source: { kind: 'user' } });
    put('step/start', { turn: 1, step: 1 });
    const file = i === 0 ? 'test/calculator.test.js' : 'package.json';
    const callId = `call_team_${i}_read`;
    put('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: JSON.stringify({ file_path: path.join(WORKSPACE, file) }) });
    put('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: fs.readFileSync(path.join(WORKSPACE, file), 'utf8') }], isError: false } });
  }
}

/** The teammates' live part: one adds divide() next to the lead's fix, one writes docs. */
async function playTeam() {
  const [math, docs] = TEAMMATES;
  let seq = 200;
  const usage = { inputTokens: 900, outputTokens: 40, cacheReadTokens: 1500, cacheWriteTokens: 0, totalTokens: 2440 };
  const think = (mate, text) => appendTo(mate.log, {
    type: 'assistant/message', seq: seq++, time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'reasoning', text }] }, usage },
  });
  const use = (mate, name, callId, input) => appendTo(mate.log, {
    type: 'tool/call', seq: seq++, time: Date.now(),
    data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(input) },
  });
  const done = (mate, callId, text) => appendTo(mate.log, {
    type: 'tool/result', seq: seq++, time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }], isError: false } },
  });
  const mathPart = (async () => {
    await sleep(DELAY / 2);
    think(math, 'The lead is fixing add(); divide() goes after multiply(), with a guard for zero.');
    await sleep(DELAY);
    use(math, 'edit', 'call_math_test', {
      file_path: path.join(WORKSPACE, 'test', 'calculator.test.js'),
      old_string: "test('multiply', () => assert.equal(multiply(6, 7), 42));",
      new_string: [
        "test('multiply', () => assert.equal(multiply(6, 7), 42));",
        "test('divide', () => assert.equal(divide(84, 2), 42));",
      ].join('\n'),
    });
    done(math, 'call_math_test', 'Edited test/calculator.test.js');
    await sleep(DELAY);
    use(math, 'edit', 'call_math_src', {
      file_path: path.join(WORKSPACE, 'src', 'calculator.js'),
      old_string: 'export function multiply(a, b) {\n  return a * b;\n}',
      new_string: [
        'export function multiply(a, b) {',
        '  return a * b;',
        '}',
        '',
        'export function divide(a, b) {',
        "  if (b === 0) throw new RangeError('divide by zero');",
        '  return a / b;',
        '}',
      ].join('\n'),
    });
    done(math, 'call_math_src', 'Edited src/calculator.js');
    await sleep(DELAY);
    use(math, 'pwsh', 'call_math_run', { command: 'node --test test/calculator.test.js', description: 'run the calculator tests', workdir: WORKSPACE });
    await sleep(DELAY / 2);
    done(math, 'call_math_run', ['✔ add (1.1ms)', '✔ multiply (0.6ms)', '✔ divide (0.5ms)', '# pass 3', '[exit code: 0]'].join('\n'));
  })();
  const docsPart = (async () => {
    await sleep(DELAY);
    think(docs, 'Reading the sources first so the API section matches the exports.');
    use(docs, 'read', 'call_docs_src', { file_path: path.join(WORKSPACE, 'src', 'calculator.js') });
    done(docs, 'call_docs_src', fs.readFileSync(path.join(WORKSPACE, 'src', 'calculator.js'), 'utf8'));
    await sleep(DELAY * 1.5);
    use(docs, 'edit', 'call_docs_readme', {
      file_path: path.join(WORKSPACE, 'README.md'),
      old_string: 'Run `npm test` to execute the checks.',
      new_string: [
        'Run `npm test` to execute the checks.',
        '',
        '## API',
        '',
        '- `add(a, b)` returns the sum.',
        '- `multiply(a, b)` returns the product.',
        '- `divide(a, b)` returns the quotient and throws on zero.',
      ].join('\n'),
    });
    done(docs, 'call_docs_readme', 'Edited README.md');
    await sleep(DELAY);
    think(docs, 'The README now lists every export; I will check the wording once divide() lands.');
  })();
  await Promise.all([mathPart, docsPart]);
}

async function play() {
  let seq = 100;
  await sleep(DELAY);
  // The build starts first and keeps running in the background, so the
  // console streams progress while the agent thinks and types its edit.
  call(seq++, 4, 1, 'pwsh', 'call_demo_build', {
    command: `$log='${BUILD_LOG}'; cmake --build build *> $log`,
    description: 'build the demo project and stream progress',
    workdir: WORKSPACE,
  });
  append({
    type: 'job/registered', seq: seq++, time: Date.now(),
    data: {
      jobId: 'pwsh-demo-build', owner: SESSION_ID, kind: 'pwsh',
      label: 'cmake --build build', startedAt: Date.now(),
      toolCall: { callId: 'call_demo_build', rootCallId: 'call_demo_build' },
    },
  });
  const buildStarted = Date.now();
  const build = (async () => {
    for (let i = 1; i <= 24; i++) {
      fs.appendFileSync(BUILD_LOG, `[${i}/24] compiling calculator module ${i}\n`);
      await sleep(320);
    }
  })();
  await sleep(500);
  append({
    type: 'assistant/message', seq: seq++, time: Date.now(),
    data: {
      turn: 4, step: 1,
      message: {
        role: 'assistant',
        source: { provider: 'deepseek-official', model: 'deepseek-flash' },
        content: [
          { type: 'reasoning', text: 'The build is running in the background. While it compiles I will fix add() with the smallest possible change, document it, and then run the test suite.' },
        ],
      },
      usage: { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 1600, cacheWriteTokens: 0, totalTokens: 2860 },
    },
  });
  await sleep(700);
  call(seq++, 4, 1, 'edit', 'call_demo_edit', {
    file_path: path.join(WORKSPACE, 'src', 'calculator.js'),
    old_string: 'export function add(a, b) {\n  return a + b;\n}',
    new_string: [
      '/**',
      ' * Adds two numbers.',
      ' * @param {number} a first operand',
      ' * @param {number} b second operand',
      ' * @returns {number} the sum of a and b',
      ' */',
      'export function add(a, b) {',
      '  return Number(a) + Number(b);',
      '}',
    ].join('\n'),
  });
  await sleep(300);
  result(seq++, 4, 1, 'call_demo_edit', 'Edited src/calculator.js');
  await build;
  append({
    type: 'job/settled', seq: seq++, time: Date.now(),
    data: {
      jobId: 'pwsh-demo-build', owner: SESSION_ID, kind: 'pwsh',
      label: 'cmake --build build', startedAt: buildStarted,
      finishedAt: Date.now(), status: 'completed', cause: 'producer', producerReported: true,
      detail: 'exit code: 0', toolCall: { callId: 'call_demo_build', rootCallId: 'call_demo_build' },
    },
  });
  result(seq++, 4, 1, 'call_demo_build', 'Build completed: 24/24 targets\n[exit code: 0]');
  await sleep(800);
  call(seq++, 4, 1, 'pwsh', 'call_demo_test', {
    command: 'node --test',
    description: 'run the demo test suite',
    workdir: WORKSPACE,
  });
  await sleep(400);
  result(seq++, 4, 1, 'call_demo_test', [
    '✔ add (1.2ms)',
    '✖ multiply (0.8ms)',
    '  expected 42, got 41',
    `  endpoint 192.0.2.10:8443 for ${['demo', 'example.com'].join('@')}`,
    'not ok 2 - multiply',
    '[exit code: 1]',
  ].join('\n'), true);
  await sleep(900);
  append({
    type: 'assistant/message', seq: seq++, time: Date.now(),
    data: {
      turn: 4, step: 1,
      message: {
        role: 'assistant',
        source: { provider: 'deepseek-official', model: 'deepseek-flash' },
        content: [{ type: 'text', text: 'add() is fixed and documented, and the build finished cleanly. The failing multiply test is intentional and shows how errors are rendered.' }],
      },
      usage: { inputTokens: 900, outputTokens: 45, cacheReadTokens: 1400, cacheWriteTokens: 0, totalTokens: 2345 },
    },
  });
  append({ type: 'step/end', seq: seq++, time: Date.now(), data: { turn: 4, step: 1 } });
  append({ type: 'turn/end', seq: seq++, time: Date.now(), data: { turn: 4 } });
}

(async () => {
  if (args.includes('--team-append')) {
    console.log('appending the teammates\' live part…');
    await playTeam();
    console.log('team demo finished');
    return;
  }
  if (args.includes('--append')) {
    console.log('appending the synthetic live turn…');
    await play();
    console.log('demo finished');
    return;
  }
  writeWorkspace();
  initialHistory();
  if (TEAM) teamHistory();
  console.log(`demo workspace  ${WORKSPACE}`);
  console.log(`demo sessions   ${SESSIONS}`);
  console.log(`session         ${SESSION_ID}`);
  if (PLAY) {
    console.log('playing the synthetic live session…');
    await play();
    console.log('demo finished');
  } else {
    console.log('run again with --play to append the live turn');
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
