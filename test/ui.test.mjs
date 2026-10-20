// Browser test: replay a finished session, watch the typing animation, then
// attach to a live session and confirm edits are typed as they arrive.
// Run: node test/ui.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildFixture, frame, ev } from './fixture.mjs';

const PORT = 8899;
const CDP = 9334;
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(import.meta.dirname, '..');
const tmp = path.join(import.meta.dirname, '.tmp');
const fixture = buildFixture(tmp);
fs.mkdirSync(path.join(fixture.workspace, '.tmp'), { recursive: true });
fs.writeFileSync(path.join(fixture.workspace, '.tmp', 'hidden.txt'), 'hidden\n');

// An empty session (no steps/tokens) that the picker hides by default.
const emptySessionId = 'session-00000000-1111-2222-3333-444444444444';
const emptyDir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', emptySessionId);
fs.mkdirSync(emptyDir, { recursive: true });
fs.writeFileSync(path.join(emptyDir, 'session.v4.jsonl.zstd'), frame([{
  type: 'session', version: 4, id: emptySessionId, createdAt: Date.now() - 86400000,
  cwd: fixture.workspace, isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
}]));
fs.utimesSync(path.join(emptyDir, 'session.v4.jsonl.zstd'), new Date(Date.now() - 86400000), new Date(Date.now() - 86400000));

// A finished turn with a detached background job: idle, not live.
const bgSessionId = 'session-55555555-6666-7777-8888-999999999999';
const bgDir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', bgSessionId);
fs.mkdirSync(bgDir, { recursive: true });
fs.writeFileSync(path.join(bgDir, 'session.v4.jsonl.zstd'), frame([
  { type: 'session', version: 4, id: bgSessionId, createdAt: Date.now() - 600000, cwd: fixture.workspace },
  ev('turn/start', 1, { turn: 1 }),
  ev('step/start', 2, { turn: 1, step: 1 }),
  { ...ev('step/end', 3, { turn: 1, step: 1 }), time: Date.now() - 180000 },
  { ...ev('turn/end', 4, { turn: 1 }), time: Date.now() - 180000 },
  {
    type: 'job/registered', seq: 5, time: Date.now() - 3600000,
    data: {
      jobId: 'pwsh-bg', owner: bgSessionId, kind: 'pwsh', label: 'node server.js',
      startedAt: Date.now() - 3600000,
      toolCall: { callId: 'call_bg', rootCallId: 'call_bg' },
    },
  },
]));
fs.utimesSync(path.join(bgDir, 'session.v4.jsonl.zstd'), new Date(Date.now() - 180000), new Date(Date.now() - 180000));

// A chat-heavy finished session: long commands, many tool calls, long thinking.
const chatSessionId = 'session-abababab-cdcd-efef-0101-232323232323';
const chatDir = path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', chatSessionId);
fs.mkdirSync(chatDir, { recursive: true });
const longCmd = (n) => `cmake --build build --target vulkan_tests_${n} --parallel 4 -- -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DVERBOSE=ON -DSOME_LONG_OPTION_${n}=enabled --config RelWithDebInfo`;
const longThink = (n) => `Reasoning run ${n}: the build is running with a long command line and I need to keep checking whether the test process is still alive. `.repeat(3);
for (let i = 0; i < 4; i += 1) {
  const editPath = path.join(fixture.workspace, 'src', `a-very-long-file-name-number-${i}-that-keeps-going.js`);
  fs.mkdirSync(path.dirname(editPath), { recursive: true });
  fs.writeFileSync(editPath, `export const id = ${i};\n`);
}
const chatEvents = [
  { type: 'session', version: 4, id: chatSessionId, createdAt: Date.now() - 1200000, cwd: fixture.workspace },
  { ...ev('turn/start', 1, { turn: 1 }), time: Date.now() - 1100000 },
  { ...ev('step/start', 2, { turn: 1, step: 1 }), time: Date.now() - 1090000 },
  { type: 'user/message', seq: 3, time: Date.now() - 1080000, data: { role: 'user', content: [{ type: 'text', text: 'Run the long build checks.' }], source: { kind: 'user' } } },
  {
    type: 'assistant/message', seq: 4, time: Date.now() - 1070000,
    data: { turn: 1, step: 1, usage: null, message: { role: 'assistant', content: [
      { type: 'reasoning', text: longThink(1) },
      { type: 'text', text: 'Starting the long checks now. The first batch runs the build and the editor updates.\nUse `npm test` and then:\n```js\nconst answer = 42;\nconsole.log(answer);\n```\nDone.' },
    ] } },
  },
];
for (let i = 0; i < 4; i++) {
  chatEvents.push({ ...ev('tool/call', 5 + i * 2, { turn: 1, step: 1, callId: `chat_cmd_${i}`, name: 'pwsh', arguments: JSON.stringify({ command: longCmd(i), workdir: fixture.workspace }) }), time: Date.now() - 1060000 + i * 1000 });
  chatEvents.push({ ...ev('tool/result', 6 + i * 2, { turn: 1, step: 1, message: { role: 'tool', toolCallId: `chat_cmd_${i}`, content: [{ type: 'text', text: `build ok ${i}\n[exit code: 0]` }], isError: false }, meta: { cwd: fixture.workspace } }), time: Date.now() - 1059500 + i * 1000 });
}
chatEvents.push({
  type: 'assistant/message', seq: 14, time: Date.now() - 1040000,
  data: { turn: 1, step: 1, usage: null, message: { role: 'assistant', content: [
    { type: 'text', text: 'First batch finished. Now I will edit the long file path and run the remaining checks.' },
  ] } },
});
chatEvents.push({
  type: 'assistant/message', seq: 15, time: Date.now() - 1030000,
  data: { turn: 1, step: 1, usage: null, message: { role: 'assistant', content: [{ type: 'reasoning', text: longThink(2) }] } },
});
for (let i = 0; i < 4; i++) {
  chatEvents.push({ ...ev('tool/call', 16 + i, { turn: 1, step: 1, callId: `chat_edit_${i}`, name: 'edit', arguments: JSON.stringify({ file_path: path.join(fixture.workspace, 'src', `a-very-long-file-name-number-${i}-that-keeps-going.js`), old_string: 'a'.repeat(80), new_string: 'b'.repeat(80) }) }), time: Date.now() - 1020000 + i * 1000 });
  chatEvents.push({ ...ev('tool/result', 20 + i, { turn: 1, step: 1, message: { role: 'tool', toolCallId: `chat_edit_${i}`, content: [{ type: 'text', text: 'edited' }], isError: false }, meta: { path: path.join(fixture.workspace, 'src', `a-very-long-file-name-number-${i}-that-keeps-going.js`) } }), time: Date.now() - 1019500 + i * 1000 });
}
chatEvents.push(
  { ...ev('step/end', 24, { turn: 1, step: 1 }), time: Date.now() - 1000000 },
  { ...ev('turn/end', 25, { turn: 1 }), time: Date.now() - 990000 },
  {
    type: 'assistant/message', seq: 26, time: Date.now() - 980000,
    data: { turn: 1, step: 1, usage: null, message: { role: 'assistant', content: [
      { type: 'reasoning', text: `Final reasoning: ${'checking the last result and the console output. '.repeat(8)}` },
      { type: 'text', text: 'All long checks are done. The build passed and the edits are in place.' },
    ] } },
  },
  {
    type: 'assistant/message', seq: 27, time: Date.now() - 975000,
    data: { turn: 1, step: 1, usage: null, message: { role: 'assistant', content: [
      { type: 'text', text: [
        '**Summary**',
        '- **Build:** passed',
        '- Tests:',
        '  - `unit` ok',
        '  - e2e ok',
        '',
        '| # | Task |',
        '|---|---|',
        '| 01 | Two panes (**running**) |',
        '| 02 | Speed |',
        '',
        '### Next steps',
        '1. review the diff',
        '2. ship it',
      ].join('\n') },
    ] } },
  },
);
for (let i = 1; i <= 55; i += 1) {
  chatEvents.push({
    type: 'assistant/message',
    seq: 40 + i,
    time: Date.now() - 970000 + i * 1000,
    data: {
      turn: 1, step: 1, usage: null,
      message: { role: 'assistant', content: [{ type: 'text', text: `trail ${i}: event after the last user message.` }] },
    },
  });
}
fs.writeFileSync(path.join(chatDir, 'session.v4.jsonl.zstd'), frame(chatEvents));
fs.utimesSync(path.join(chatDir, 'session.v4.jsonl.zstd'), new Date(Date.now() - 900000), new Date(Date.now() - 900000));

// A tiny Claude Code transcript so the source picker can be exercised too.
const claudeRoot = path.join(tmp, 'claude');
const claudeId = '22222222-3333-4444-5555-666666666666';
fs.mkdirSync(path.join(claudeRoot, 'E--TEST'), { recursive: true });
const claudeLines = [
  { type: 'custom-title', customTitle: 'Claude fixture', sessionId: claudeId },
  { type: 'user', cwd: fixture.workspace, sessionId: claudeId, timestamp: new Date().toISOString(), message: { role: 'user', content: 'A Claude task.' } },
  {
    type: 'assistant', cwd: fixture.workspace, sessionId: claudeId, timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Claude is on the case.' }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  },
];
fs.writeFileSync(path.join(claudeRoot, 'E--TEST', `${claudeId}.jsonl`), claudeLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const failures = [];
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok    ${msg}`);
  else { failures.push(msg); console.log(`  FAIL  ${msg}${extra ? ' :: ' + extra : ''}`); }
};

const server = spawn(process.execPath, [path.join(root, 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
      AGENTTAIL_NO_OPEN: '1',
    DSH_SESSIONS_ROOT: fixture.sessionsRoot,
    CLAUDE_PROJECTS_ROOT: claudeRoot,
    DSH_POLL_MS: '200',
    DSH_NICKNAMES_FILE: path.join(tmp, 'nicknames.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
server.stdout.on('data', (d) => process.stdout.write('  [server] ' + d));
server.stderr.on('data', (d) => process.stderr.write('  [server:err] ' + d));

let edge = null;
let browser = null;
let sessionId = null;
let targetId = null;

async function connectCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
      browser = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => { browser.onopen = res; browser.onerror = rej; });
      return;
    } catch { await sleep(200); }
  }
  throw new Error('edge did not expose CDP');
}

let nextId = 1;
const pending = new Map();
const pageLogs = [];
function send(method, params = {}, sid) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sid) msg.sessionId = sid;
  browser.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
browserSetup();
function browserSetup() {
  // assigned after connectCdp; the handler reads `browser` lazily
}

async function evalExpr(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
  return r.result?.value;
}

async function waitFor(expression, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evalExpr(expression)) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function reloadPage() {
  await send('Page.reload', { ignoreCache: true }, sessionId);
  await sleep(400);
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('.monaco-editor')`, 20000);
  await sleep(1200);
}

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/api/sessions')).ok) break; } catch {}
    await sleep(100);
  }

  edge = spawn(edgePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(tmp, 'edge-profile')}`,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  await connectCdp();
  browser.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') pageLogs.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') pageLogs.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
  };

  targetId = (await send('Target.createTarget', { url: 'about:blank' })).targetId;
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url: `${BASE}/#${fixture.finishedId}` }, sessionId);

  console.log('\nfinished session');
  const ready = await waitFor(`document.getElementById('liveText')?.textContent === 'FINISHED'`, 20000);
  check(ready, 'page reaches FINISHED for a completed log');
  check(await evalExpr(`document.getElementById('replayBtn').disabled === false`), 'replay button is enabled');
  check(await evalExpr(`document.getElementById('sessionSelect').value === '${fixture.finishedId}'`), 'session picker matches the loaded session');
  check(await evalExpr(`document.getElementById('mSteps').textContent === '3'`), 'steps counted from step/start', await evalExpr(`document.getElementById('mSteps').textContent`));
  check(await evalExpr(`document.getElementById('mTokens').textContent.length > 0`), 'tokens shown');
  check(await evalExpr(`document.getElementById('mCost').textContent.startsWith('$')`), 'cost shown');
  check(await evalExpr(`document.querySelectorAll('.tree-row.touched').length === 2`), 'two touched files highlighted',
    await evalExpr(`JSON.stringify([...document.querySelectorAll('.tree-row.touched')].map(e=>[e.dataset.path,e.textContent]))`));

  check(!(await evalExpr(`[...document.querySelectorAll('.tree-row')].some((e) => e.dataset.path === '.tmp/hidden.txt')`)), 'ignored files are hidden by default');
  await evalExpr(`document.getElementById('showHiddenBox').click(); true`);
  const hiddenShown = await waitFor(`[...document.querySelectorAll('.tree-row')].some((e) => e.dataset.path === '.tmp')`, 8000);
  check(hiddenShown, 'show hidden reveals ignored files', await evalExpr(`JSON.stringify({ checked: document.getElementById('showHiddenBox').checked, rows: [...document.querySelectorAll('.tree-row')].map((e) => e.dataset.path).filter((p) => p.includes('.tmp')) })`));
  await evalExpr(`document.getElementById('showHiddenBox').click(); true`);
  const hiddenGone = await waitFor(`![...document.querySelectorAll('.tree-row')].some((e) => e.dataset.path === '.tmp')`, 8000);
  check(hiddenGone, 'show hidden can be turned off');
  check(/heat = edits/.test(await evalExpr(`document.getElementById('treeLegend').textContent`)), 'tree legend explains heat');
  const fileTip = await evalExpr(`document.querySelector('.tree-row.touched')?.title || ''`);
  check(/\d+ edits · last .+ · \d+ failed/.test(fileTip), 'file tooltip reports edits, last time and failures', fileTip);

  console.log('\npickers');
  const selects = await evalExpr(`[...document.querySelectorAll('select')].map(s => [...s.options].map(o => o.textContent))`);
  check(Array.isArray(selects) && selects.length >= 2 && selects.every((opts) => opts.length > 0), 'every select has at least one option', JSON.stringify(selects));
  check(/dsh \(\d+\)/.test(selects[0].join('|')), 'source picker shows session counts', selects[0].join('|'));
  const optText = await evalExpr(`document.getElementById('sessionSelect').selectedOptions[0].textContent`);
  const short = fixture.finishedId.slice(8, 16);
  check(optText.startsWith('○'), 'finished sessions use an empty state dot', optText);
  check(optText.includes('Patch the answer and run the tests.'), 'session title is the last real user message', optText);
  check(optText.includes('workspace'), 'session picker shows the workspace short name', optText);
  check(optText.includes(short), 'session picker shows a short id', optText);
  const buttonText = await evalExpr(`document.getElementById('sessionButton').textContent.replace(/\\s+/g, ' ').trim()`);
  check(buttonText.startsWith('○') && buttonText.includes('Patch the answer and run the tests.') && buttonText.includes(short), 'selected session shows only dot, title and short id', buttonText);
  check(!/\\d+ st|tok|\\$/.test(buttonText), 'selected session text is compact', buttonText);
  check(await evalExpr(`/workspace[\\s\\S]*steps/.test(document.getElementById('sessionButton').title)`), 'session button tooltip carries the full details', await evalExpr(`document.getElementById('sessionButton').title`));
  await evalExpr(`document.getElementById('sessionButton').click(); true`);
  await sleep(200);
  const menu = await evalExpr(`(() => { const rows = [...document.querySelectorAll('#sessionMenu .session-item')]; return { count: rows.length, text: rows[0] ? rows[0].textContent : '', title: rows[0] ? rows[0].title : '' }; })()`);
  check(menu.count > 0 && /workspace/.test(menu.text) && /\d+ st/.test(menu.text) && /tok/.test(menu.text) && /\$/.test(menu.text), 'dropdown rows carry the full details', JSON.stringify(menu));
  check(/steps/.test(menu.title), 'dropdown row tooltip carries the full details');
  await evalExpr(`document.getElementById('sessionButton').click(); true`);
  check(/\d+ min ago/.test(optText), 'session picker shows relative activity', optText);
  check(/\d+ st/.test(optText) && /tok/.test(optText) && /\$/.test(optText), 'session picker shows steps, tokens and cost', optText);
  check(await evalExpr(`document.getElementById('liveDot').classList.contains('finished')`), 'finished sessions use the finished dot class');
  check(await evalExpr(`document.getElementById('liveDot').title.length > 0`), 'the state dot has a tooltip');
  check(await evalExpr(`document.getElementById('mSession').textContent === '${short}'`), 'the header shows the short id rather than repeating the title',
    await evalExpr(`document.getElementById('mSession').textContent`));
  check(await evalExpr(`[...document.getElementById('sessionSelect').options].some(o => /show empty \\(1\\)/.test(o.textContent))`), 'empty sessions are hidden behind a show-empty option',
    await evalExpr(`[...document.getElementById('sessionSelect').options].map(o => o.value + ':' + o.textContent).join('|')`));
  await evalExpr(`(() => { const s = document.getElementById('sessionSelect'); s.value = '__show_empty__'; s.dispatchEvent(new Event('change')); return true; })()`);
  const emptyShown = await waitFor(`[...document.getElementById('sessionSelect').options].some(o => o.value === '${emptySessionId}')`, 8000);
  check(emptyShown, 'show empty reveals the empty session');
  await evalExpr(`(() => { const s = document.getElementById('sessionSelect'); s.value = '__hide_empty__'; s.dispatchEvent(new Event('change')); return true; })()`);
  const emptyHidden = await waitFor(`![...document.getElementById('sessionSelect').options].some(o => o.value === '${emptySessionId}')`, 8000);
  check(emptyHidden, 'hide empty hides it again');

  console.log('\nheader');
  const wide = await evalExpr(`(() => {
    const t = document.getElementById('topbar');
    return { h: t.getBoundingClientRect().height, sw: document.documentElement.scrollWidth, w: innerWidth, wrap: getComputedStyle(t).flexWrap };
  })()`);
  check(wide.sw <= wide.w && wide.h <= 54 && wide.wrap === 'nowrap', 'wide header is one row without overflow', JSON.stringify(wide));
  const costGeom = await evalExpr(`(() => { const m = document.getElementById('mCost').getBoundingClientRect(); const c = document.querySelector('.metrics').getBoundingClientRect(); const s = document.getElementById('sessionSelect').getBoundingClientRect(); const w = (q) => Math.round(document.querySelector(q).getBoundingClientRect().width); return { mw: m.width, mr: m.right, cr: c.right, sw: s.width, metrics: c.width, left: w('.hleft'), middle: w('.hmiddle'), right: w('.hright'), brand: w('.brand'), fx: w('#fxBtn'), session: w('#sessionPicker') }; })()`);
  check(costGeom.mw > 0 && costGeom.mr <= costGeom.cr + 1, 'cost value is not clipped in the wide header', JSON.stringify(costGeom));
  await evalExpr(`document.getElementById('fxBtn').click(); true`);
  check(await evalExpr(`!document.getElementById('fxPanel').classList.contains('hidden')`), 'the menu opens from the top bar');
  check(await evalExpr(`!!document.getElementById('speed') && !!document.getElementById('fxIntensity') && !!document.getElementById('replayBtn') && !!document.querySelector('[data-fx="sys"]')`), 'the menu holds speed, intensity, replay and show system');
  check(await evalExpr(`!document.getElementById('fxBackdrop').classList.contains('hidden') && getComputedStyle(document.getElementById('fxPanel')).position === 'fixed'`), 'settings open as a modal with a backdrop');
  check(await evalExpr(`!!document.querySelector('#fxBtn svg')`), 'the settings button is a gear icon');
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  check(await evalExpr(`document.getElementById('fxPanel').classList.contains('hidden') && document.getElementById('fxBackdrop').classList.contains('hidden')`), 'Esc closes the settings modal');
  await evalExpr(`document.getElementById('fxBtn').click(); document.getElementById('fxBackdrop').click(); true`);
  check(await evalExpr(`document.getElementById('fxPanel').classList.contains('hidden')`), 'clicking the backdrop closes the settings modal');
  check(await evalExpr(`(() => { const r = document.querySelector('.brand .brand-full').getBoundingClientRect(); return r.width > 60 && r.height > 10; })()`), 'the header shows the agenttail wordmark');
  check(await evalExpr(`/AGENT NOW/.test(document.getElementById('activityLabel').textContent)`), 'the activity bar is labelled as the agent status');

  console.log('\nthemes');
  check(await evalExpr(`JSON.stringify(window.__theme.list()) === JSON.stringify(['matrix', 'amber', 'ice', 'dracula', 'paper']) && document.getElementById('themeSelect').options.length === 5`), 'five themes are offered in Settings');
  const matrixBg = await evalExpr(`getComputedStyle(document.body).backgroundColor`);
  check(await evalExpr(`!document.documentElement.dataset.theme || document.documentElement.dataset.theme === 'matrix'`), 'matrix is the default theme');
  await evalExpr(`(() => { const sel = document.getElementById('themeSelect'); sel.value = 'paper'; sel.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(300);
  const paper = await evalExpr(`(() => ({ attr: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, saved: localStorage.getItem('agenttail-theme'), logo: getComputedStyle(document.querySelector('.brand svg g')).fill, agent0: getComputedStyle(document.documentElement).getPropertyValue('--agent-0').trim() }))()`);
  check(paper.attr === 'paper' && paper.saved === 'paper' && paper.bg !== matrixBg, 'choosing a theme applies and saves it', JSON.stringify({ ...paper, matrixBg }));
  check(paper.logo !== 'rgb(55, 242, 138)' && paper.agent0 === '#118a4a', 'the logo and agent colours follow the light theme', JSON.stringify(paper));
  await reloadPage();
  check(await evalExpr(`document.documentElement.dataset.theme === 'paper'`), 'the saved theme is applied on load');
  await evalExpr(`window.__theme.set('matrix'); true`);
  await sleep(200);
  check(await evalExpr(`getComputedStyle(document.body).backgroundColor`) === matrixBg, 'switching back restores the matrix colours');

  console.log('\nsession search');
  await evalExpr(`window.__picker.open(); true`);
  check(await waitFor(`!document.getElementById('sessionMenu').classList.contains('hidden') && document.activeElement === document.getElementById('sessionSearch')`, 3000), 'opening the picker focuses the search box');
  const allIds = await evalExpr(`window.__picker.visibleIds()`);
  await evalExpr(`window.__picker.filter('patch answer'); true`);
  const patched = await evalExpr(`window.__picker.visibleIds()`);
  check(patched.length === 1 && patched[0] === fixture.finishedId, 'all search words must match', JSON.stringify(patched));
  await evalExpr(`window.__picker.filter('no-such-session-xyz'); true`);
  check(await evalExpr(`window.__picker.visibleIds().length === 0 && /no matching sessions/.test(document.getElementById('sessionMenu').textContent)`), 'a search with no hits says so');
  await evalExpr(`window.__picker.filter(''); true`);
  check((await evalExpr(`window.__picker.visibleIds()`)).length === allIds.length, 'clearing the search shows every session again');
  await evalExpr(`document.getElementById('sessionSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); true`);
  check(await evalExpr(`document.querySelectorAll('#sessionMenu .kbd-active').length === 1`), 'arrow keys move a highlighted row');
  await evalExpr(`document.getElementById('sessionSearch').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  check(await evalExpr(`document.getElementById('sessionMenu').classList.contains('hidden')`), 'Esc closes the picker');

  console.log('\nshortcuts and export');
  await evalExpr(`document.body.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })); true`);
  check(await waitFor(`!document.getElementById('helpPanel').classList.contains('hidden')`, 3000), '? opens the keyboard shortcuts');
  const helpText = await evalExpr(`document.getElementById('helpPanel').textContent`);
  check(['Alt+A', 'Alt+W', 'Ctrl+Shift+.', 'Ctrl+B', 'Ctrl+J', 'Esc'].every((k) => helpText.replace(/\s+/g, '').includes(k.replace(/\s+/g, ''))), 'the overlay lists the layout, dock and agents shortcuts', helpText.slice(0, 300));
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  check(await evalExpr(`document.getElementById('helpPanel').classList.contains('hidden')`), 'Esc closes the shortcuts overlay');
  await evalExpr(`document.getElementById('helpBtn').click(); true`);
  check(await evalExpr(`!document.getElementById('helpPanel').classList.contains('hidden')`), 'the header ? button opens it too');
  await evalExpr(`window.__help.close(); true`);
  const exported = await evalExpr(`window.__exportMarkdown()`);
  check(typeof exported === 'string' && /^# /.test(exported) && exported.includes('- Source: dsh') && exported.includes('Patch the answer and run the tests.'), 'the session exports as Markdown with its header and messages', String(exported).slice(0, 300));
  check(/^- \\$ /m.test(exported) || /^- ✎ /m.test(exported), 'tool calls are listed in the export', String(exported).slice(0, 600));
  check(await evalExpr(`!!document.getElementById('chatExport')`), 'the agent pane has an export button');

  console.log('\nsystem meters');
  const sysReady = await waitFor(`['sysCpu', 'sysRam'].every((id) => document.getElementById(id).querySelector('.v').textContent !== '—')`, 12000);
  check(sysReady, 'CPU and RAM meters receive SSE samples');
  const sysValues = await evalExpr(`(() => {
    const read = (id) => document.getElementById(id).querySelector('.v').textContent;
    return {
      cpu: read('sysCpu'), ram: read('sysRam'), gpu: read('sysGpu'),
      ramTitle: document.getElementById('sysRam').title,
      gpuTitle: document.getElementById('sysGpu').title,
      cpuTitle: document.getElementById('sysCpu').title,
    };
  })()`);
  check(parseInt(sysValues.cpu, 10) >= 0 && parseInt(sysValues.cpu, 10) <= 100, 'CPU meter shows a percentage', sysValues.cpu);
  check(parseInt(sysValues.ram, 10) > 0 && /GB/.test(sysValues.ramTitle), 'RAM meter tooltip shows used/total GB', sysValues.ramTitle);
  check(sysValues.gpu === 'n/a' || (parseInt(sysValues.gpu, 10) >= 0 && /VRAM|GPU not available/.test(sysValues.gpuTitle)), 'GPU meter shows utilisation and VRAM', JSON.stringify({ value: sysValues.gpu, title: sysValues.gpuTitle }));
  check(/cores/.test(sysValues.cpuTitle), 'CPU tooltip names the core count', sysValues.cpuTitle);
  check(await evalExpr(`(() => ['sysCpu', 'sysRam', 'sysGpu'].every((id) => {
    const el = document.getElementById(id);
    const p = parseInt(el.querySelector('.v').textContent, 10);
    if (Number.isNaN(p)) return el.classList.contains('na');
    const hot = el.classList.contains('hot');
    const warn = el.classList.contains('warn');
    return (p >= 85 && hot && !warn) || (p >= 60 && p < 85 && warn && !hot) || (p < 60 && !warn && !hot);
  }))()`), 'meter colours follow the 60/85 thresholds');

  console.log('\nreadability');
  const sizes = await evalExpr(`(() => {
    const pick = (sel) => { const el = document.querySelector(sel); return el ? parseFloat(getComputedStyle(el).fontSize) : null; };
    return {
      topbar: pick('#topbar'), brand: pick('.brand'), source: pick('#sourceSelect'), session: pick('#sessionSelect'),
      label: pick('.stat .k'), value: pick('.stat .v'), meter: pick('.smeter .v'),
      panel: pick('.panel-title'), chat: pick('.chat-title'), live: pick('.live'),
      bar: document.querySelector('.smeter .bar')?.getBoundingClientRect().width || 0,
    };
  })()`);
  check(Object.entries(sizes).filter(([k]) => k !== 'bar').every(([, v]) => v >= 11), 'header and panel text is at least 11px', JSON.stringify(sizes));
  check(sizes.bar >= 48, 'CPU/RAM/GPU bars are about 48px wide', String(sizes.bar));
  await evalExpr(`(() => { const s = document.getElementById('uiScale'); s.value = '1.3'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(400);
  check(await evalExpr(`document.documentElement.style.getPropertyValue('--ui-scale') === '1.3' && localStorage.getItem('agenttail-ui-scale') === '1.3'`), 'UI scale 130% applies and persists');
  check(await evalExpr(`document.documentElement.scrollWidth <= innerWidth`), 'header/layout still fits at 130% scale');
  await evalExpr(`(() => { const s = document.getElementById('uiScale'); s.value = '1'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(400);

  console.log('\nactivity bar');
  const actReady = await waitFor(`/DONE/.test(document.getElementById('activityText').textContent)`, 8000);
  check(actReady, 'finished sessions show DONE in the activity bar', await evalExpr(`document.getElementById('activityText').textContent`));
  check(await evalExpr(`document.getElementById('activityBar').getBoundingClientRect().height >= 26`), 'activity bar is about 28px tall');
  check(await evalExpr(`document.querySelector('[data-fx="follow"]').checked === true`), 'follow mode is on by default');
  await evalExpr(`document.getElementById('editorWrap').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  await sleep(200);
  check(await evalExpr(`!document.getElementById('followState').classList.contains('hidden') && /FOLLOW PAUSED/.test(document.getElementById('followState').textContent)`), 'a manual click pauses follow mode', await evalExpr(`document.getElementById('followState').textContent`));
  await evalExpr(`window.__activity.resume(); true`);

  console.log('\nagent chat');
  check(await evalExpr(`!document.body.classList.contains('chat-collapsed')`), 'chat is docked and open by default');
  check(await evalExpr(`window.__chat.state.view === 'log' && document.getElementById('chatViewLog').classList.contains('active') && document.querySelectorAll('#chatLog .log-tool').length > 0`), 'a fresh session opens in the Log trajectory view');
  await evalExpr(`document.getElementById('chatViewChat').click(); true`);
  await sleep(500);
  const chatBox = await evalExpr(`(() => { const p = document.getElementById('chatPane').getBoundingClientRect(); const l = document.getElementById('chatLog'); return { w: p.width, sw: l.scrollWidth, cw: l.clientWidth }; })()`);
  check(chatBox.w >= 420, 'chat pane keeps a 420px minimum width', JSON.stringify(chatBox));
  check(chatBox.sw <= chatBox.cw + 1, 'chat log has no horizontal overflow', JSON.stringify(chatBox));
  check(await evalExpr(`document.querySelectorAll('#chatLog .chat-msg.agent').length > 0`), 'chat shows agent messages');
  check(await evalExpr(`document.querySelectorAll('#chatLog .chat-msg.user').length > 0`), 'chat shows user turns');
  check(await evalExpr(`document.querySelectorAll('#chatLog .chat-think').length > 0`), 'chat shows thinking blocks');
  check(await evalExpr(`document.querySelectorAll('#chatLog .chat-tools').length > 0`), 'consecutive tool calls group into one row');
  check(await evalExpr(`document.querySelectorAll('.chat-sys').length === 0`), 'system injections are hidden by default');
  check(!(await evalExpr(`[...document.querySelectorAll('.chat-msg.user')].some(e => /Time sampled/.test(e.textContent))`)), 'runtime context is not a user bubble');
  const thinkSummaries = await evalExpr(`[...document.querySelectorAll('.chat-think summary')].map(s => s.textContent)`);
  check(thinkSummaries.length > 0 && thinkSummaries.every((s) => s.replace('thinking · ', '').trim().length > 0), 'empty thinking rows are hidden', JSON.stringify(thinkSummaries.slice(0, 3)));
  check(thinkSummaries.every((s) => !s.includes('▸')), 'thinking rows have exactly one caret', JSON.stringify(thinkSummaries.slice(0, 3)));
  check(thinkSummaries.some((s) => s.includes('First part') && s.includes('Second part')), 'consecutive thinking blocks merge into one row', JSON.stringify(thinkSummaries.filter((s) => s.includes('part')).slice(0, 2)));
  await evalExpr(`(() => { const b = document.querySelector('[data-fx="sys"]'); b.checked = true; b.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(300);
  check(await evalExpr(`document.querySelectorAll('.chat-sys').length > 0`), 'show system reveals system chips');
  check(await evalExpr(`[...document.querySelectorAll('.chat-sys')].some(e => /time context/.test(e.textContent))`), 'system chips are labelled by kind',
    await evalExpr(`[...document.querySelectorAll('.chat-sys')].map(e => e.textContent).join('|')`));
  await evalExpr(`(() => { const b = document.querySelector('[data-fx="sys"]'); b.checked = false; b.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(200);
  check(await evalExpr(`document.querySelectorAll('.chat-sys').length === 0`), 'show system hides them again');

  const groups = await evalExpr(`document.querySelectorAll('.chat-tools').length`);
  check(groups >= 1, 'tool groups are rendered', String(groups));
  const groupText = await evalExpr(`document.querySelector('.chat-tools summary').textContent`);
  check(/⚙ \d+ tool calls \(/.test(groupText), 'group summary counts the calls', groupText);
  const groupWasOpen = await evalExpr(`document.querySelector('.chat-tools').open`);
  await evalExpr(`document.querySelector('.chat-tools summary').click(); true`);
  check(await evalExpr(`document.querySelector('.chat-tools').open === ${groupWasOpen ? 'false' : 'true'}`), 'clicking a tool group expands it');
  if (!(await evalExpr(`document.querySelector('.chat-tools').open`))) await evalExpr(`document.querySelector('.chat-tools summary').click(); true`);
  await sleep(200);
  const chipGeom = await evalExpr(`(() => {
    const chip = document.querySelector('.chat-tools[open] .chat-chip');
    const log = document.getElementById('chatLog');
    if (!chip) return null;
    const cs = getComputedStyle(chip);
    return {
      h: chip.getBoundingClientRect().height,
      lh: parseFloat(cs.lineHeight),
      pad: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
      w: chip.getBoundingClientRect().width,
      logw: log.clientWidth,
      title: chip.title,
    };
  })()`);
  check(chipGeom && chipGeom.h >= chipGeom.lh + chipGeom.pad, 'tool chips have room for line-height plus padding', JSON.stringify(chipGeom));
  check(chipGeom && chipGeom.w <= chipGeom.logw + 1, 'tool chips never exceed the chat width', JSON.stringify(chipGeom));
  check(chipGeom && chipGeom.title.length >= 3, 'tool chips carry the full command in a tooltip', chipGeom && chipGeom.title);

  const chipClicked = await evalExpr(`(() => { const c = [...document.querySelectorAll('.chat-chip')].find(x => x.textContent.includes('app.js')) || document.querySelector('.chat-chip'); if (!c) return false; c.click(); return true; })()`);
  check(chipClicked, 'a chat tool chip is clickable');
  await sleep(500);
  check(await evalExpr(`document.getElementById('fileBadge').textContent.includes('app.js')`), 'tool chip jumps to the editor file', await evalExpr(`document.getElementById('fileBadge').textContent`));

  await evalExpr(`document.getElementById('chatClose').click(); true`);
  await sleep(300);
  check(await evalExpr(`document.body.classList.contains('chat-collapsed')`), 'chat collapses');
  check(await evalExpr(`document.getElementById('chatRail').getBoundingClientRect().width <= 30 && getComputedStyle(document.getElementById('chatRail')).display !== 'none'`), 'chat leaves a thin rail');
  await evalExpr(`document.getElementById('chatExpand').click(); true`);
  await sleep(300);
  check(!(await evalExpr(`document.body.classList.contains('chat-collapsed')`)), 'rail click expands the chat');
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true })); true`);
  check(await evalExpr(`document.body.classList.contains('chat-collapsed')`), 'Ctrl+. collapses the chat');
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true })); true`);
  check(!(await evalExpr(`document.body.classList.contains('chat-collapsed')`)), 'Ctrl+. expands the chat');
  const pinnedBefore = await evalExpr(`window.__chat.state.pinned`);
  await evalExpr(`document.getElementById('chatPin').click(); true`);
  const pinnedAfter = await evalExpr(`window.__chat.state.pinned`);
  const pinnedStored = await evalExpr(`JSON.parse(localStorage.getItem('agenttail-chat-pin'))`);
  check(pinnedAfter === !pinnedBefore && pinnedStored === pinnedAfter, 'pin toggle persists', JSON.stringify({ pinnedBefore, pinnedAfter, pinnedStored }));
  await evalExpr(`document.getElementById('chatPin').click(); true`);
  check(await evalExpr(`!!document.getElementById('chatTyping')`), 'chat has a typing indicator element');
  check(await evalExpr(`!!document.querySelector('.chat-think summary')`), 'thinking blocks are collapsible',
    await evalExpr(`(document.querySelector('.chat-think') || {}).outerHTML || 'none'`));

  console.log('\nvisual effects');
  await sleep(500);
  check(await waitFor(`document.body.classList.contains('boot-done')`, 6000), 'boot sequence completes');
  check(await evalExpr(`document.getElementById('mRon').textContent.startsWith('RON')`), 'cost odometer is shown in lei', await evalExpr(`document.getElementById('mRon').textContent`));
  check(await evalExpr(`!!document.getElementById('spark')`), 'tokens/sec sparkline canvas exists');
  check(await evalExpr(`window.__fx.state.matrix === false && window.__fx.matrixRunning() === false`), 'matrix rain is off by default in stream mode');
  check(await evalExpr(`window.__fx.state.intensity === 40`), 'effect intensity defaults to 40%');
  check(await evalExpr(`parseFloat(document.documentElement.style.getPropertyValue('--fx')) === 0.4`), 'intensity is exposed as a CSS variable');
  check(await evalExpr(`window.__fx.glyphs === '0123456789ABCDEF'`), 'matrix uses hex glyphs only');
  check(await evalExpr(`(() => { const r = document.querySelector('.tree-row.touched'); return r ? getComputedStyle(r).getPropertyValue('--heat').trim() !== '' : false; })()`), 'tree rows carry a heat colour');

  await evalExpr(`(() => { const b = document.querySelector('[data-fx="matrix"]'); b.checked = true; b.dispatchEvent(new Event('change')); return true; })()`);
  check(await evalExpr(`window.__fx.matrixRunning() === true`), 'matrix rain starts when enabled');
  await evalExpr(`window.__fx.idleFor(31000); true`);
  await sleep(500);
  check(await evalExpr(`parseFloat(window.__fx.matrixOpacity()) >= 0.07 && parseFloat(window.__fx.matrixOpacity()) <= 0.13`), 'matrix opacity stays between 0.08 and 0.12',
    await evalExpr(`window.__fx.matrixOpacity()`));
  check(await evalExpr(`(() => {
    const c = document.getElementById('matrix').getBoundingClientRect();
    const p = document.getElementById('terminalPane').getBoundingClientRect();
    return c.left >= p.left - 1 && c.right <= p.right + 1 && c.top >= p.top - 1 && c.bottom <= p.bottom + 1;
  })()`), 'matrix canvas is confined to the console, never over the editor');
  check(await evalExpr(`(() => {
    const c = document.getElementById('matrix').getBoundingClientRect();
    const e = document.getElementById('editorWrap').getBoundingClientRect();
    return c.right <= e.left + 1 || c.bottom <= e.top + 1 || c.top >= e.bottom - 1;
  })()`), 'matrix never overlaps the editor rectangle');
  await evalExpr(`window.__fx.poke(); true`);
  await sleep(420);
  check(await evalExpr(`parseFloat(window.__fx.matrixOpacity()) < 0.02`), 'matrix fades out within 300 ms of activity');

  await evalExpr(`(() => { const s = document.getElementById('fxIntensity'); s.value = '70'; s.dispatchEvent(new Event('input')); return true; })()`);
  check(await evalExpr(`parseFloat(document.documentElement.style.getPropertyValue('--fx')) === 0.7`), 'intensity slider applies live');
  check(await evalExpr(`document.getElementById('fxIntensityVal').textContent === '70%'`), 'intensity slider shows its value');
  await evalExpr(`(() => { const s = document.getElementById('fxIntensity'); s.value = '40'; s.dispatchEvent(new Event('input')); return true; })()`);

  await evalExpr(`(() => { const b = document.querySelector('[data-fx="crt"]'); b.checked = false; b.dispatchEvent(new Event('change')); return true; })()`);
  check(!(await evalExpr(`document.body.classList.contains('fx-crt')`)), 'CRT overlay toggles off');
  await evalExpr(`(() => { const b = document.querySelector('[data-fx="crt"]'); b.checked = true; b.dispatchEvent(new Event('change')); return true; })()`);
  check(await evalExpr(`document.body.classList.contains('fx-crt')`), 'CRT overlay toggles back on');
  await evalExpr(`(() => { const b = document.querySelector('[data-fx="matrix"]'); b.checked = false; b.dispatchEvent(new Event('change')); return true; })()`);
  check(await evalExpr(`window.__fx.matrixRunning() === false`), 'matrix rain stops when toggled off');
  await evalExpr(`(() => { const b = document.querySelector('[data-fx="matrix"]'); b.checked = true; b.dispatchEvent(new Event('change')); return true; })()`);

  await evalExpr(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); true`);
  check(await evalExpr(`window.__fx.matrixRunning() === false && window.__fx.sparkRunning() === false`), 'effects pause while the tab is hidden');
  check(await evalExpr(`document.body.classList.contains('tab-hidden')`), 'CSS animations are paused while hidden');
  await evalExpr(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); true`);
  check(await evalExpr(`window.__fx.matrixRunning() === true`), 'effects resume when visible');

  // Slow the typing down so the animation is observable.
  await evalExpr(`(() => { const s = document.getElementById('speed'); s.value = '40'; s.dispatchEvent(new Event('input')); return s.value; })()`);
  await evalExpr(`document.getElementById('replayBtn').click(); true`);

  const replaying = await waitFor(`document.getElementById('liveText')?.textContent === 'REPLAYING'`, 5000);
  check(replaying, 'replay mode starts');

  let sawCursor = false;
  let sawGlitch = false;
  for (let i = 0; i < 90 && !(sawCursor && sawGlitch); i++) {
    const pair = await evalExpr(`[!document.getElementById('blockCursor').classList.contains('hidden'), document.getElementById('terminalPane').classList.contains('glitch')]`);
    if (Array.isArray(pair)) {
      sawCursor = sawCursor || !!pair[0];
      sawGlitch = sawGlitch || !!pair[1];
    }
    await sleep(70);
  }
  check(sawCursor, 'blinking block cursor appears while typing');
  check(sawGlitch, 'failed commands trigger the red glitch');

  // Sample the visible text while replaying; it must grow, not jump.
  const samples = [];
  for (let i = 0; i < 24; i++) {
    await sleep(220);
    const txt = await evalExpr(`document.querySelector('.view-lines')?.innerText || ''`);
    if (txt && !samples.includes(txt)) samples.push(txt);
    if (samples.length >= 3) break;
  }
  check(samples.length >= 2, 'text is typed progressively during replay',
    JSON.stringify(samples.map((s) => s.length)));
  check(samples.some((s) => s.length > 0 && s.length < 200), 'an intermediate partial state was observed',
    JSON.stringify(samples.map((s) => s.slice(0, 24))));

  const done = await waitFor(`document.getElementById('liveText')?.textContent === 'FINISHED'`, 30000);
  check(done, 'replay finishes');

  const editorText = await evalExpr(`document.querySelector('.view-lines')?.innerText || ''`);
  await evalExpr(`[...document.querySelectorAll('.tree-row')].find(e => e.dataset.path === 'src/app.js')?.click(); true`);
  await sleep(600);
  const appText = await evalExpr(`document.querySelector('.view-lines')?.innerText || ''`);
  check(appText.includes('42'), 'edited file shows the new text after replay', JSON.stringify(appText.slice(0, 120)));

  const counts = await evalExpr(`Object.fromEntries([...document.querySelectorAll('.tree-row.touched')].map(e => [e.dataset.path, parseInt(e.querySelector('.cnt')?.textContent || '0', 10)]))`);
  check(counts['src/app.js'] === 1 && counts['notes.md'] === 1, 'replay counts each edit exactly once', JSON.stringify(counts));
  check(await evalExpr(`document.getElementById('nickBtn').textContent.includes('\\u270e')`), 'page text keeps its UTF-8 glyphs');

  const deleted = await evalExpr(`[...document.querySelectorAll('.tree-row.deleted')].map(e => e.dataset.path)`);
  check(deleted.includes('gone.txt'), 'deleted files are struck through in the tree', JSON.stringify(deleted));
  check(await evalExpr(`(() => { const r = [...document.querySelectorAll('.tree-row')].find(e => e.dataset.path === 'gone.txt'); return r ? getComputedStyle(r).textDecorationLine === 'line-through' || getComputedStyle(r.querySelector('.nm')).textDecorationLine === 'line-through' : false; })()`), 'deleted row uses a line-through style');

  const md = await evalExpr(`mdToText('**Bold** and _italic_ ![shot](assets/shot.png)\\n\\n| File | What |\\n| --- | --- |\\n| a.js | first |\\n| bb.js | second |')`);
  check(!String(md).includes('**') && String(md).includes('Bold and italic'), 'markdown emphasis is stripped', JSON.stringify(md).slice(0, 120));
  check(String(md).includes('[image: shot]'), 'images become [image: name]');
  check(/File\s+What/.test(String(md)) && /a\.js\s+first/.test(String(md)), 'tables become aligned text', JSON.stringify(md).slice(0, 160));

  // The console keeps full scrollback; read the terminal buffer, not the viewport.
  const termText = await evalExpr(`(() => { const b = window.__agenttailTerm.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`);
  check(/PS .*>/.test(termText), 'console shows a prompt for pwsh calls', JSON.stringify(termText.slice(0, 120)));
  check(termText.includes('node --test'), 'console shows the command');
  check(termText.includes('I will update'), 'console shows agent messages');
  check(/exit (code: )?1/.test(termText), 'console shows the failing exit status', JSON.stringify(termText.slice(-160)));
  check(termText.includes('flaky'), 'console shows command output');
  check(/\(\+\d+ lines/.test(termText), 'long output is truncated with an expand hint', JSON.stringify(termText.slice(-200)));
  check(termText.includes('Bold and italic') && !termText.includes('**Bold**'), 'console renders plain-text markdown');
  check(termText.includes('[image: shot]'), 'console shows images as [image: name]');
  check(/File\s+What/.test(termText), 'console renders markdown tables as aligned text');

  await evalExpr(`document.getElementById('term').click(); true`);
  await sleep(700);
  const expandedText = await evalExpr(`(() => { const b = window.__agenttailTerm.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`);
  check(expandedText.includes('expanded: pwsh output'), 'clicking the console expands the truncated block');

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const shotPath = path.join(tmp, 'replay.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('  shot  ' + shotPath);

  console.log('\nlive session');
  fs.utimesSync(fixture.liveLog, new Date(), new Date());
  await send('Page.navigate', { url: `${BASE}/?attach=${Date.now()}#${fixture.liveId}` }, sessionId);
  const live = await waitFor(`document.getElementById('liveText')?.textContent === 'LIVE'`, 15000);
  check(live, 'live session shows LIVE', await evalExpr(`document.getElementById('liveText')?.textContent`));
  check(await evalExpr(`document.getElementById('liveDot').classList.contains('live')`), 'live sessions use the live dot class');
  check(/step|job/.test(await evalExpr(`document.getElementById('liveDot').title || ''`)), 'live tooltip explains the state', await evalExpr(`document.getElementById('liveDot').title`));
  check(await evalExpr(`document.getElementById('replayBtn').disabled === true`), 'replay disabled while live');

  console.log('\nmultiple agents');
  await evalExpr(`window.__agents.refresh().then(() => true)`, true);
  check(await waitFor(`!document.getElementById('coAgents').classList.contains('hidden') && /OTHER AGENT/.test(document.getElementById('coAgents').textContent)`, 8000), 'the activity bar names the other agents on this workspace', await evalExpr(`document.getElementById('coAgents').textContent`));
  check(await evalExpr(`document.querySelectorAll('#coAgents .ag-dot').length > 0`), 'the chip shows each other agent as a coloured dot');
  check(await evalExpr(`/var\\(--agent-\\d\\)/.test(document.getElementById('app').style.getPropertyValue('--agent-color'))`), 'the working-pane highlight uses this agent colour', await evalExpr(`document.getElementById('app').style.getPropertyValue('--agent-color')`));
  await evalExpr(`document.getElementById('coAgents').click(); true`);
  check(await waitFor(`!document.getElementById('agentsPanel').classList.contains('hidden') && document.querySelectorAll('#agentsPanel .ag-card').length >= 2`, 5000), 'the chip opens the agents overview with a card per agent', await evalExpr(`document.querySelectorAll('#agentsPanel .ag-card').length`));
  const cards = await evalExpr(`[...document.querySelectorAll('#agentsPanel .ag-card')].map((c) => ({ key: c.dataset.key, current: c.classList.contains('current'), color: c.style.getPropertyValue('--c') }))`);
  check(cards.filter((c) => c.current).length === 1 && cards.find((c) => c.current)?.key === `dsh:${fixture.liveId}`, 'the viewed session is marked in the overview', JSON.stringify(cards));
  check(new Set(cards.map((c) => c.color)).size === cards.length, 'every agent card has its own colour', JSON.stringify(cards));
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  check(await evalExpr(`document.getElementById('agentsPanel').classList.contains('hidden')`), 'Esc closes the agents overview');
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', altKey: true, bubbles: true })); true`);
  check(await waitFor(`window.__wall.open_ && window.__wall.panes >= 1`, 5000), 'Alt+W opens the watch wall');
  check(await evalExpr(`[...document.querySelectorAll('#wallGrid .wall-pane')].every((p) => window.__agents.data.groups.flatMap((g) => g.agents).find((a) => a.key === p.dataset.key)?.state === 'live')`), 'by default the wall shows only agents that are working right now');
  // Watch three agents of this workspace explicitly to check the layout.
  await evalExpr(`window.__wall.open(window.__agents.data.groups.flatMap((g) => g.agents).filter((a) => a.state !== 'finished').slice(0, 3)); true`);
  check(await waitFor(`window.__wall.open_ && window.__wall.panes >= 2 && document.querySelectorAll('#wallGrid .wall-pane').length === window.__wall.panes`, 5000), 'several agents are watched side by side', String(await evalExpr(`window.__wall.panes`)));
  check(await waitFor(`[...document.querySelectorAll('#wallGrid .wp-feed')].every((f) => f.childElementCount > 0)`, 8000), 'every pane fills with its own live feed', JSON.stringify(await evalExpr(`[...document.querySelectorAll('#wallGrid .wp-feed')].map((f) => f.childElementCount)`)));
  const paneColors = await evalExpr(`[...document.querySelectorAll('#wallGrid .wall-pane')].map((p) => p.style.getPropertyValue('--c'))`);
  check(new Set(paneColors).size === paneColors.length, 'each pane carries its agent colour', JSON.stringify(paneColors));
  // A command arrives live while the wall is open: its pane shows it with the result.
  fs.appendFileSync(fixture.liveLog, frame([
    ev('tool/call', 30, { turn: 1, step: 2, callId: 'call_wall_echo', name: 'pwsh', arguments: JSON.stringify({ command: 'echo wall-check', workdir: fixture.workspace }) }),
    ev('tool/result', 31, { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'call_wall_echo', content: [{ type: 'text', text: 'wall-check\n[exit code: 0]' }], isError: false } }),
  ]));
  const livePane = `document.querySelector('#wallGrid .wall-pane[data-key="dsh:${fixture.liveId}"]')`;
  check(await waitFor(`!!${livePane} && [...${livePane}.querySelectorAll('.wf-call')].some((r) => r.textContent.includes('echo wall-check') && /✓ exit 0/.test(r.textContent))`, 8000), 'a live command appears in its pane with its result', await evalExpr(`${livePane}?.querySelector('.wp-feed')?.textContent.slice(-200) || 'no pane'`));
  check(await evalExpr(`/running echo wall-check/.test(${livePane}.querySelector('.wp-act').textContent)`), 'the pane names the current action', await evalExpr(`${livePane}.querySelector('.wp-act').textContent`));
  check(await waitFor(`(() => { const t = (window.__wallConsoleText(${livePane}) || '').replace(/\\n {2,}/g, ''); return t.includes('echo wall-check') && t.includes('wall-check') && /exit 0/.test(t); })()`, 6000), 'the pane console shows the command, its output and exit status', JSON.stringify(String(await evalExpr(`window.__wallConsoleText(${livePane})`)).slice(-300)));
  fs.appendFileSync(fixture.liveLog, frame([
    ev('tool/call', 32, { turn: 1, step: 2, callId: 'call_wall_edit', name: 'edit', arguments: JSON.stringify({ file_path: path.join(fixture.workspace, 'notes.md'), old_string: 'First line.', new_string: 'First line, edited while you watch.' }) }),
    ev('tool/result', 33, { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'call_wall_edit', content: [{ type: 'text', text: 'Edited notes.md' }], isError: false } }),
  ]));
  check(await waitFor(`(() => { const e = window.__wallEditor(${livePane}); return !!e && /editing notes\\.md/.test(e.label) && e.text.includes('edited while you watch'); })()`, 10000), 'the pane editor types a live edit into the file', JSON.stringify(await evalExpr(`window.__wallEditor(${livePane})`)));
  const score = await evalExpr(`[...${livePane}.querySelectorAll('.wp-score .sc b')].map((b) => Number(b.textContent))`);
  check(score.length === 5 && score[0] >= 1 && score[1] >= 1 && score[2] >= 1, 'the pane scoreboard counts edits, commands and green runs', JSON.stringify(score));
  check(await waitFor(`window.__wallMap().tiles.some((t) => t.path === 'notes.md') && window.__wallMap().cursors >= 1`, 5000), 'the repo map shows the file with the agent cursor on it', JSON.stringify(await evalExpr(`window.__wallMap()`)));
  // A second agent of this workspace edits the same file: the map flags it.
  const otherKey = await evalExpr(`[...document.querySelectorAll('#wallGrid .wall-pane')].map((p) => p.dataset.key).find((k) => k.startsWith('dsh:') && k !== 'dsh:${fixture.liveId}') || ''`);
  if (otherKey) {
    const otherId = otherKey.slice(4);
    fs.appendFileSync(path.join(fixture.sessionsRoot, '--tmp-fixture-workspace--', otherId, 'session.v4.jsonl.zstd'), frame([
      ev('tool/call', 900, { turn: 9, step: 1, callId: 'call_wall_clash', name: 'edit', arguments: JSON.stringify({ file_path: path.join(fixture.workspace, 'notes.md'), old_string: 'First line', new_string: 'First line' }) }),
    ]));
    check(await waitFor(`window.__wallMap().tiles.some((t) => t.path === 'notes.md' && t.clash) && /⚡/.test(window.__wallMap().clash)`, 8000), 'two agents on the same file make it flash on the map', JSON.stringify(await evalExpr(`window.__wallMap()`)));
  }
  const marks = await evalExpr(`window.__wallTimeline.marks()`);
  check(Array.isArray(marks) && marks.some((m) => m.key === `dsh:${fixture.liveId}`) && new Set(marks.map((m) => m.key)).size >= 2, 'the timeline has a track of marks per agent', JSON.stringify((marks || []).slice(-6)));
  check(marks.some((m) => m.key === `dsh:${fixture.liveId}` && !m.error && /command|cmd|shell|pwsh/i.test(String(m.kind))), 'the live command is on the timeline and not marked failed', JSON.stringify(marks.filter((m) => m.key === `dsh:${fixture.liveId}`).slice(-4)));
  check(await evalExpr(`(() => { const c = document.querySelector('#wallStrip .ws-timeline canvas'); return !!c && c.width > 100 && c.height > 20; })()`), 'the timeline is drawn under the panes');
  // Quiet agents (idle, or silent for a minute) shrink; the working one keeps the space.
  check(await waitFor(`window.__wall.dormant.length >= 1 && !window.__wall.dormant.includes('dsh:${fixture.liveId}')`, 5000), 'quiet agents shrink while the working agent keeps its pane', JSON.stringify(await evalExpr(`window.__wall.dormant`)));
  const widths = await evalExpr(`[...document.querySelectorAll('#wallGrid .wall-pane')].map((p) => ({ key: p.dataset.key, w: Math.round(p.getBoundingClientRect().width), dormant: p.classList.contains('dormant') }))`);
  check(widths.filter((p) => p.dormant).every((p) => p.w <= 240) && widths.filter((p) => !p.dormant).every((p) => p.w > 500), 'a shrunk pane is a slim column and the active pane fills the rest', JSON.stringify(widths));
  const sleeper = widths.find((p) => p.dormant)?.key;
  await evalExpr(`document.querySelector('#wallGrid .wall-pane[data-key="${sleeper}"]').click(); true`);
  check(await evalExpr(`!window.__wall.dormant.includes('${sleeper}')`), 'clicking a shrunk pane pins it open');
  await evalExpr(`document.getElementById('wallDormantMode').click(); true`);
  check(await evalExpr(`window.__wall.dormant.length === 0 && /KEEP/.test(document.getElementById('wallDormantMode').textContent)`), 'quiet agents can be kept full size');
  await evalExpr(`document.getElementById('wallDormantMode').click(); true`);
  // Chat in the console: the side feed goes away and replies print in the console.
  await evalExpr(`document.getElementById('wallChatMode').click(); true`);
  check(await waitFor(`document.getElementById('wall').classList.contains('chat-inline') && window.__wall.panes >= 1 && getComputedStyle(document.querySelector('#wallGrid .wp-side')).display === 'none'`, 5000), 'the chat can move into the console');
  await sleep(800);
  fs.appendFileSync(fixture.liveLog, frame([
    ev('assistant/message', 34, { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Checking the console view.' }, { type: 'text', text: 'Inline reply from the agent.' }] } }),
  ]));
  check(await waitFor(`(() => { const p = document.querySelector('#wallGrid .wall-pane[data-key="dsh:${fixture.liveId}"]'); const t = p ? (window.__wallConsoleText(p) || '') : ''; return t.includes('✦ Inline reply from the agent') && t.includes('Checking the console view'); })()`, 8000), 'messages and replies print in the pane console', JSON.stringify(String(await evalExpr(`window.__wallConsoleText(document.querySelector('#wallGrid .wall-pane[data-key="dsh:${fixture.liveId}"]'))`)).slice(-300)));
  await evalExpr(`document.getElementById('wallChatMode').click(); true`);
  check(await waitFor(`!document.getElementById('wall').classList.contains('chat-inline') && /SIDE/.test(document.getElementById('wallChatMode').textContent)`, 5000), 'and back beside the editor');
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  check(await evalExpr(`!window.__wall.open_ && window.__wall.panes === 0`), 'Esc closes the wall and its streams');

  console.log('\nrepeated actions');
  await evalExpr(`(() => { for (let i = 0; i < 5; i++) termNote('✎ edit   repeated/same-file.js', C.greenDim); return true; })()`);
  await sleep(250);
  const spinning = await evalExpr(`(() => { const b = window.__agenttailTerm.buffer.active; for (let i = b.length - 1; i >= 0; i--) { const t = b.getLine(i).translateToString(true); if (t.includes('same-file.js')) return t; } return ''; })()`);
  check(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(spinning) && /×5/.test(spinning), 'a repeated action animates on one line with a counter', spinning);
  await sleep(1900);
  const settled = await evalExpr(`(() => { const b = window.__agenttailTerm.buffer.active; const hits = []; for (let i = 0; i < b.length; i++) { const t = b.getLine(i).translateToString(true); if (t.includes('same-file.js')) hits.push(t); } return hits; })()`);
  check(settled.length === 1 && /×5/.test(settled[0]) && !/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(settled[0]), 'it settles to one plain line once the repeats stop', JSON.stringify(settled));

  // Append an edit + result while the page is open: it must be typed live.
  const liveEdit = [
    ev('tool/call', 40, {
      turn: 1, step: 3, callId: 'call_edit_live', name: 'edit',
      arguments: JSON.stringify({
        file_path: path.join(fixture.workspace, 'src', 'app.js'),
        old_string: 'export const answer = 42;',
        new_string: 'export const answer = 43;',
      }),
    }),
    ev('tool/result', 41, {
      turn: 1, step: 3,
      message: { role: 'tool', toolCallId: 'call_edit_live', content: [{ type: 'text', text: 'Edited src/app.js' }], isError: false },
      meta: { path: path.join(fixture.workspace, 'src', 'app.js'), diffs: [{ path: 'src/app.js' }] },
    }),
    ev('tool/call', 42, {
      turn: 1, step: 3, callId: 'call_job_live', name: 'pwsh',
      arguments: JSON.stringify({ command: 'ping -t 127.0.0.1', description: 'long running job', workdir: fixture.workspace }),
    }),
    {
      type: 'job/registered', seq: 43, time: Date.now(),
      data: {
        jobId: 'job-live', owner: fixture.liveId, kind: 'pwsh', label: 'ping -t 127.0.0.1',
        startedAt: Date.now() - 3000,
        toolCall: { callId: 'call_job_live', rootCallId: 'call_job_live' },
      },
    },
  ];
  fs.appendFileSync(fixture.liveLog, frame(liveEdit));
  const typed = await waitFor(`(document.querySelector('.view-lines')?.innerText || '').includes('43')`, 15000);
  check(typed, 'live edit is typed into the editor', await evalExpr(`JSON.stringify({ badge: document.getElementById('fileBadge').textContent, current: window.__dbg ? window.__dbg.current : null, lines: (document.querySelector('.view-lines')?.innerText || '').slice(0, 160) })`));
  const running = await waitFor(`document.getElementById('activityText').textContent.includes('RUNNING')`, 8000);
  check(running, 'activity bar shows RUNNING for a job', await evalExpr(`document.getElementById('activityText').textContent`));
  check(await evalExpr(`document.getElementById('activityBar').classList.contains('running') && document.getElementById('activityBar').classList.contains('working')`), 'RUNNING uses the amber animated indicator');
  check(await evalExpr(`!document.getElementById('runStatus').classList.contains('hidden') && !!document.querySelector('#runStatus .spinner')`), 'console shows a spinner next to the running command');
  check(await evalExpr(`document.getElementById('terminalPane').classList.contains('active') && !document.getElementById('consoleActive').classList.contains('hidden')`), 'console pane is marked active');
  fs.appendFileSync(fixture.liveLog, frame([
    ev('tool/call', 62, {
      turn: 1, step: 3, callId: 'call_edit_live2', name: 'edit',
      arguments: JSON.stringify({
        file_path: path.join(fixture.workspace, 'src', 'app.js'),
        old_string: 'export const answer = 43;',
        new_string: 'export const answer = 44;',
      }),
    }),
  ]));
  const editing = await waitFor(`document.getElementById('activityText').textContent.includes('EDITING')`, 8000);
  check(editing, 'activity bar shows EDITING for an edit', await evalExpr(`document.getElementById('activityText').textContent`));
  check(await evalExpr(`document.getElementById('activityBar').classList.contains('editing') && document.getElementById('activityBar').classList.contains('working')`), 'EDITING uses the green animated indicator');
  check(await evalExpr(`document.getElementById('editorWrap').classList.contains('active') && !document.getElementById('editorActive').classList.contains('hidden')`), 'editor pane is marked active');
  const barReady = await waitFor(`!document.getElementById('jobBar').classList.contains('hidden') && /running/.test(document.getElementById('jobBarText').textContent)`, 12000);
  check(barReady, 'running job line appears in the console');
  await waitFor(`(() => { const s = document.querySelector('.xterm-screen').getBoundingClientRect(); const v = document.querySelector('.xterm-viewport').getBoundingClientRect(); return s.height <= v.height + 1 && s.bottom <= v.bottom + 1; })()`, 5000);
  const termFit = await evalExpr(`(() => { const s = document.querySelector('.xterm-screen').getBoundingClientRect(); const v = document.querySelector('.xterm-viewport').getBoundingClientRect(); return { sh: s.height, vh: v.height, sb: s.bottom, vb: v.bottom }; })()`);
  check(termFit.sh <= termFit.vh + 1 && termFit.sb <= termFit.vb + 1, 'terminal rows fit above the console bottom (job bar accounted for)', JSON.stringify(termFit));
  const barText = await evalExpr(`document.getElementById('jobBarText').textContent`);
  check(/\d\d:\d\d/.test(barText), 'running job line shows elapsed time', barText);
  const termBuffer = await evalExpr(`(() => { const b = window.__agenttailTerm.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s; })()`);
  check(termBuffer.includes('job running'), 'console prints the job start line');
  const touchedLive = await waitFor(`[...document.querySelectorAll('.tree-row.touched')].some(e => e.dataset.path === 'src/app.js')`, 5000);
  check(touchedLive, 'live edit highlights the file in the tree');
  const countText = await evalExpr(`[...document.querySelectorAll('.tree-row')].find(e => e.dataset.path === 'src/app.js')?.textContent || ''`);
  check(/[1-9]/.test(countText), 'live edit increments the edit count', countText);

  console.log('\nlive chat');
  await evalExpr(`window.__chat.setOpen(false); true`);
  await sleep(250);
  fs.appendFileSync(fixture.liveLog, frame([
    ev('assistant/message', 70, {
      turn: 1, step: 3,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Live chat message while the rail is collapsed.' }] },
      usage: null,
    }),
  ]));
  const unreadLive = await waitFor(`!document.getElementById('chatUnread').classList.contains('hidden') && Number(document.getElementById('chatUnread').textContent) > 0`, 12000);
  check(unreadLive, 'collapsed chat rail counts unread messages', await evalExpr(`document.getElementById('chatUnread').textContent`));
  check(await evalExpr(`!document.getElementById('chatTyping').classList.contains('hidden')`), 'chat rail shows a thinking pulse while live');
  await evalExpr(`window.__chat.setOpen(true); true`);
  const liveChat = await waitFor(`document.getElementById('chatLog').textContent.includes('Live chat message while the rail')`, 12000);
  check(liveChat, 'expanding the rail shows the new message');
  check(await waitFor(`document.getElementById('activityText').textContent.includes('REPLYING')`, 5000), 'activity bar shows REPLYING for a message');
  check(await evalExpr(`document.getElementById('activityBar').classList.contains('replying')`), 'REPLYING uses the purple animated indicator');
  check(await evalExpr(`document.getElementById('chatUnread').classList.contains('hidden')`), 'expanding clears the unread badge');
  fs.appendFileSync(fixture.liveLog, frame([
    ev('assistant/message', 71, {
      turn: 1, step: 3,
      message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Live reasoning stream: checking the output while the turn is still running. '.repeat(3) }] },
      usage: null,
    }),
  ]));
  const liveThinkOpen = await waitFor(`(() => { const rows = [...document.querySelectorAll('.chat-think')]; const last = rows[rows.length - 1]; return !!last && last.open && /Live reasoning stream/.test(last.textContent); })()`, 12000);
  check(liveThinkOpen, 'the latest thinking row stays expanded while streaming');
  check(await waitFor(`document.getElementById('activityText').textContent.includes('THINKING')`, 5000), 'activity bar shows THINKING while reasoning streams');
  const thinkIndicator = await waitFor(`document.getElementById('activityBar').classList.contains('thinking') && document.querySelectorAll('#activityText .tdots i').length === 3 && /\\d+ s/.test(document.getElementById('activityText').textContent)`, 4000);
  check(thinkIndicator, 'THINKING shows three dots and elapsed seconds', await evalExpr(`JSON.stringify({ cls: document.getElementById('activityBar').className, dots: document.querySelectorAll('#activityText .tdots i').length, text: document.getElementById('activityText').textContent })`));
  check(await evalExpr(`document.getElementById('chatPane').classList.contains('active') && !document.getElementById('chatActive').classList.contains('hidden')`), 'chat pane is marked active');
  check(await evalExpr(`(() => { const rows = [...document.querySelectorAll('.chat-think summary')]; return rows.every((s) => !s.textContent.includes('▸')); })()`), 'thinking rows never show a double caret');
  await evalExpr(`document.getElementById('chatViewLog').click(); true`);
  const liveLog = await waitFor(`document.getElementById('chatLog').textContent.includes('Live chat message while the rail') && document.querySelectorAll('#chatLog .log-tool').length > 0`, 10000);
  check(liveLog, 'Log view keeps appending live trajectory rows');
  check(await evalExpr(`[...document.querySelectorAll('#chatLog .chat-think summary')].some((s) => /Live reasoning stream/.test(s.textContent))`), 'Log view shows live thinking');
  await evalExpr(`document.getElementById('chatViewChat').click(); true`);
  await sleep(300);


  fs.appendFileSync(fixture.liveLog, frame([{
    type: 'job/settled', seq: 72, time: Date.now(),
    data: {
      jobId: 'job-live', owner: fixture.liveId, kind: 'pwsh', label: 'ping -t 127.0.0.1',
      startedAt: Date.now() - 3000, finishedAt: Date.now(), status: 'completed',
      cause: 'producer', producerReported: true, detail: 'exit code: 0',
      toolCall: { callId: 'call_job_live', rootCallId: 'call_job_live' },
    },
  }]));
  const jobDone = await waitFor(`document.getElementById('activityText').textContent.includes('JOB FINISHED')`, 8000);
  check(jobDone, 'a finished job briefly shows JOB FINISHED', await evalExpr(`document.getElementById('activityText').textContent`));
  check(await evalExpr(`document.getElementById('activityIcon').textContent === '✓'`), 'the job-finished transient uses a checkmark');
  await sleep(2400);
  check(!(await evalExpr(`document.getElementById('activityText').textContent.includes('JOB FINISHED')`)), 'the job-finished transient clears to the current state');
  fs.appendFileSync(fixture.liveLog, frame([ev('tool/result', 73, {
    turn: 1, step: 3,
    message: { role: 'tool', toolCallId: 'call_err_live', isError: true, content: [{ type: 'text', text: 'boom\n[exit code: 1]' }] },
  })]));
  const errTransient = await waitFor(`document.getElementById('activityText').textContent.includes('COMMAND FAILED')`, 8000);
  check(errTransient, 'a failed command shows an error transient', await evalExpr(`document.getElementById('activityText').textContent`));
  check(await evalExpr(`document.getElementById('activityIcon').textContent === '✗'`), 'the error transient uses an X icon');
  await sleep(3300);
  check(!(await evalExpr(`document.getElementById('activityText').textContent.includes('COMMAND FAILED')`)), 'the error transient clears after three seconds');
  fs.appendFileSync(fixture.liveLog, frame([
    ev('step/end', 74, { turn: 1, step: 1 }),
    ev('turn/end', 75, { turn: 1 }),
  ]));
  const finishedLive = await waitFor(`document.getElementById('liveText').textContent !== 'LIVE'`, 12000);
  check(finishedLive, 'a closed turn leaves the LIVE state', await evalExpr(`JSON.stringify({ text: document.getElementById('liveText').textContent, dot: document.getElementById('liveDot').title })`));

  console.log('\nbackground state');
  await evalExpr(`location.hash = '${bgSessionId}'; true`);
  const idleBg = await waitFor(`document.getElementById('liveText')?.textContent === 'IDLE · BG'`, 20000);
  check(idleBg, 'a detached job shows idle background, not live', await evalExpr(`document.getElementById('liveText')?.textContent`));
  check(await evalExpr(`document.getElementById('liveDot').classList.contains('idle')`), 'the background state uses the idle dot');
  check(await evalExpr(`!document.getElementById('activityJobs').classList.contains('hidden') && /1 job running/.test(document.getElementById('activityJobs').textContent)`), 'a long-running job appears as an activity chip', await evalExpr(`document.getElementById('activityJobs').textContent`));
  await evalExpr(`document.getElementById('activityJobs').click(); true`);
  await sleep(200);
  check(await evalExpr(`!document.getElementById('jobsMenu').classList.contains('hidden') && document.querySelectorAll('#jobsMenu .job .spinner').length === 1`), 'the jobs dropdown lists a spinner per long job');
  await evalExpr(`document.getElementById('activityJobs').click(); true`);
  check(/IDLE/.test(await evalExpr(`document.getElementById('activityText').textContent`)), 'activity bar shows IDLE for a background session', await evalExpr(`document.getElementById('activityText').textContent`));
  check(/background job/.test(await evalExpr(`document.getElementById('liveDot').title || ''`)), 'the background tooltip names the job',
    await evalExpr(`document.getElementById('liveDot').title`));

  console.log('\nsource picker');
  await evalExpr(`(() => { const s = document.getElementById('sourceSelect'); s.value = 'claude'; s.dispatchEvent(new Event('change')); return true; })()`);
  const claudeReady = await waitFor(`document.getElementById('mCost').textContent.includes('TOKENS ONLY')`, 20000);
  check(claudeReady, 'source picker switches to Claude Code');
  check(await evalExpr(`document.getElementById('sourceSelect').value === 'claude'`), 'picker keeps the selected source');
  check(await evalExpr(`[...document.getElementById('sessionSelect').options].some(o => o.textContent.includes('Claude fixture'))`), 'Claude session title is shown in the picker',
    await evalExpr(`document.getElementById('sessionSelect').selectedOptions[0].textContent`));
  check(await evalExpr(`decodeURIComponent(location.hash).replace(/^#/, '').startsWith('claude:')`), 'hash records the source',
    await evalExpr(`location.hash`));
  check(await evalExpr(`document.querySelectorAll('.tree-row').length > 0`), 'Claude workspace tree loads');

  await evalExpr(`location.hash = '${fixture.finishedId}'; true`);
  const hashSync = await waitFor(`document.getElementById('sourceSelect').value === 'dsh' && document.getElementById('sessionSelect').value === '${fixture.finishedId}'`, 20000);
  check(hashSync, 'URL hash drives both pickers');

  console.log('\nchat overflow fixture');
  await evalExpr(`location.hash = '${chatSessionId}'; true`);
  const chatLoaded = await waitFor(`document.getElementById('chatLog').textContent.includes('All long checks are done')`, 20000);
  check(chatLoaded, 'long chat fixture loads', await evalExpr(`JSON.stringify({ sel: document.getElementById('sessionSelect').value, id: location.hash, text: document.getElementById('chatLog').textContent.slice(-240) })`));
  const autoOpen = await evalExpr(`(() => ({ badge: document.getElementById('fileBadge').textContent, empty: !document.getElementById('editorEmpty').classList.contains('hidden'), hasText: (document.querySelector('.view-lines')?.innerText || '').length > 0 }))()`);
  check(!autoOpen.empty && /a-very-long-file-name/.test(autoOpen.badge) && autoOpen.hasText, 'follow mode opens the last edited file when idle', JSON.stringify(autoOpen));
  const trail = await evalExpr(`(() => {
    const msgs = [...document.querySelectorAll('#chatLog .chat-msg.agent')].map((e) => e.textContent).filter((t) => /trail \\d+:/.test(t));
    const log = document.getElementById('chatLog');
    return { count: msgs.length, first: msgs[0] || '', last: msgs[msgs.length - 1] || '', bottom: log.scrollTop + log.clientHeight >= log.scrollHeight - 12 };
  })()`);
  check(trail.count === 55 && /trail 1:/.test(trail.first) && /trail 55:/.test(trail.last), 'all 55 events after the last user message appear in order', JSON.stringify({ count: trail.count, first: trail.first.slice(0, 30), last: trail.last.slice(0, 30) }));
  check(trail.bottom, 'follow mode keeps the chat at the newest event');
  const emptyAgents = await evalExpr(`[...document.querySelectorAll('#chatLog .chat-msg.agent')].filter((e) => !e.textContent.trim()).map((e) => e.outerHTML.slice(0, 120))`);
  check(Array.isArray(emptyAgents) && emptyAgents.length === 0, 'no empty agent placeholders', JSON.stringify(emptyAgents));
  check(await evalExpr(`[...document.querySelectorAll('.chat-chip')].every((c) => c.textContent.trim().length > 1)`), 'no empty tool chips');
  check(await evalExpr(`document.querySelectorAll('#chatLog .md-code').length > 0 && !document.getElementById('chatLog').textContent.includes(String.fromCharCode(96).repeat(3))`), 'fenced code blocks render without stray backticks');
  check(await evalExpr(`document.querySelectorAll('#chatLog .md-inline').length > 0`), 'inline code renders as code');
  await evalExpr(`document.getElementById('chatViewLog').click(); true`);
  await sleep(500);
  const logView = await evalExpr(`(() => ({
    tools: document.querySelectorAll('#chatLog .log-tool').length,
    users: document.querySelectorAll('#chatLog .log-user').length,
    says: document.querySelectorAll('#chatLog .log-say').length,
    thinks: document.querySelectorAll('#chatLog .chat-think').length,
    exits: [...document.querySelectorAll('#chatLog .log-tool .res')].filter((e) => /exit 0/.test(e.textContent)).length,
    active: document.getElementById('chatViewLog').classList.contains('active'),
  }))()`);
  check(logView.active && logView.tools > 0 && logView.users > 0 && logView.says > 0 && logView.thinks > 0, 'Log view shows the chronological trajectory', JSON.stringify(logView));
  check(logView.exits > 0, 'Log view shows tool result exit codes', JSON.stringify(logView));
  const mdView = await evalExpr(`(() => {
    const say = [...document.querySelectorAll('#chatLog .log-say')].find((e) => e.querySelector('.md-table'));
    if (!say) return null;
    return {
      rows: say.querySelectorAll('.md-table tbody tr').length,
      head: [...say.querySelectorAll('.md-table th')].map((e) => e.textContent),
      bold: [...say.querySelectorAll('strong')].map((e) => e.textContent),
      nested: say.querySelectorAll('ul ul li').length,
      ordered: say.querySelectorAll('ol li').length,
      heading: say.querySelector('.md-h3')?.textContent || '',
      raw: /\\*\\*|\\|---|^###/m.test(say.textContent),
      ws: getComputedStyle(say).whiteSpace,
    };
  })()`);
  check(!!mdView && mdView.rows === 2 && mdView.head.join('|') === '#|Task', 'Log view renders markdown tables', JSON.stringify(mdView));
  check(!!mdView && mdView.bold.includes('Summary') && mdView.bold.includes('Build:') && mdView.bold.includes('running'), 'Log view renders bold text, including inside tables', JSON.stringify(mdView?.bold));
  check(!!mdView && mdView.nested === 2 && mdView.ordered === 2 && mdView.heading === 'Next steps', 'Log view renders nested lists, ordered lists and headings', JSON.stringify(mdView));
  check(!!mdView && !mdView.raw && mdView.ws === 'normal', 'no raw markdown markers are left in the Log view', JSON.stringify(mdView));
  const spark = await evalExpr(`(() => { const w = document.getElementById('turnSparkWrap'); return { shown: !w.classList.contains('hidden'), label: document.getElementById('turnSparkLabel').textContent, title: w.title }; })()`);
  check(spark.shown && /^(\$|TOK)\/TURN$/.test(spark.label) && /per turn, newest on the right/.test(spark.title), 'the per-turn chart is labelled and explains itself', JSON.stringify(spark));

  console.log('\nagent side mode');
  const sideGeom = () => evalExpr(`(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    const c = r('chatPane'); const e = r('editorWrap'); const t = r('terminalPane'); const a = r('activityBar'); const app = r('app');
    return { side: document.body.classList.contains('chat-side'), parent: document.getElementById('chatPane').parentElement.id,
      top: c.top, actBottom: a.bottom, bottom: c.bottom, appBottom: app.bottom, left: c.left, right: c.right, appRight: app.right,
      editorRight: e.right, termRight: t.right, termW: t.width, w: c.width };
  })()`);
  const docked = await sideGeom();
  check(!docked.side && docked.parent === 'bottomArea', 'the agent starts docked under the editor', JSON.stringify(docked));
  await evalExpr(`document.getElementById('chatDock').click(); true`);
  await sleep(500);
  const side = await sideGeom();
  check(side.side && side.parent === 'app', 'the dock button moves the agent to the right side', JSON.stringify(side));
  check(Math.abs(side.top - side.actBottom) <= 2 && side.bottom >= side.appBottom - 2, 'the side agent spans the full height below the activity bar', JSON.stringify(side));
  check(side.left >= side.editorRight - 1 && side.left >= side.termRight - 1 && Math.abs(side.right - side.appRight) <= 2, 'editor and console sit to the left of the side agent', JSON.stringify(side));
  check(side.termW > docked.termW + 100, 'the console gets the full width under the editor', JSON.stringify({ before: docked.termW, after: side.termW }));
  check(await evalExpr(`document.querySelectorAll('#chatLog .md-table').length > 0`), 'the side agent still shows the rendered log');
  check(await evalExpr(`JSON.parse(localStorage.getItem('agenttail-layout') || '{}').chatSide === true`), 'the side mode is remembered');
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '>', code: 'Period', ctrlKey: true, shiftKey: true, bubbles: true })); true`);
  await sleep(500);
  const back = await sideGeom();
  check(!back.side && back.parent === 'bottomArea' && Math.abs(back.termW - docked.termW) <= 2, 'Ctrl+Shift+. docks the agent back under the editor', JSON.stringify(back));
  const rowHeights = await evalExpr(`[...document.getElementById('chatLog').children].map((e) => e.getBoundingClientRect().height)`);
  check(rowHeights.length === 0 || Math.min(...rowHeights) >= 10, 'chat rows keep their natural height (no collapsed bars)', JSON.stringify(rowHeights.slice(-8)));
  await evalExpr(`document.getElementById('chatViewChat').click(); true`);
  await sleep(400);
  const chatGroups = await evalExpr(`document.querySelectorAll('.chat-tools').length`);
  check(chatGroups >= 2, 'tool calls split into groups around agent messages', String(chatGroups));
  await evalExpr(`[...document.querySelectorAll('.chat-tools')].forEach((d) => { d.open = true; }); true`);
  await sleep(400);
  const longChips = await evalExpr(`(() => {
    const log = document.getElementById('chatLog');
    const chips = [...document.querySelectorAll('.chat-chip')];
    return {
      logW: log.clientWidth,
      logScroll: log.scrollWidth,
      widths: chips.map((c) => c.getBoundingClientRect().width),
      heights: chips.map((c) => c.getBoundingClientRect().height),
      titles: chips.map((c) => c.title),
    };
  })()`);
  check(longChips.logScroll <= longChips.logW + 1, 'chat with long commands has no horizontal overflow', JSON.stringify({ w: longChips.logW, sw: longChips.logScroll }));
  check(longChips.widths.every((w) => w <= longChips.logW + 1), 'every chip stays inside the panel', JSON.stringify(longChips.widths.slice(0, 3)));
  check(longChips.heights.every((h) => h >= 22), 'every chip keeps its fixed height', JSON.stringify(longChips.heights.slice(0, 3)));
  check(longChips.titles.some((t) => t.length > 120), 'long commands keep their full text in the tooltip', String(Math.max(...longChips.titles.map((t) => t.length))));
  check(await evalExpr(`[...document.querySelectorAll('.chat-think summary')].every((s) => s.textContent.length <= 95)`), 'thinking summaries stay around 80 characters');

  console.log('\nresponsive header');
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await evalExpr(`window.dispatchEvent(new Event('resize')); true`);
  await sleep(700);
  check(await evalExpr(`getComputedStyle(document.getElementById('topbar')).flexWrap === 'nowrap'`), 'header never wraps on medium screens');
  check(await evalExpr(`getComputedStyle(document.querySelector('.metrics')).display === 'none'`), 'middle stats collapse below 1500px');
  check(await evalExpr(`getComputedStyle(document.getElementById('statsChip')).display !== 'none'`), 'a stats chip takes their place');
  check(await evalExpr(`/\\d+ steps/.test(document.getElementById('statsChip').title) && /tokens/.test(document.getElementById('statsChip').title)`), 'the stats chip tooltip carries the full numbers', await evalExpr(`document.getElementById('statsChip').title`));
  check(await evalExpr(`getComputedStyle(document.getElementById('sysMeters')).display === 'none' && getComputedStyle(document.getElementById('sysChip')).display !== 'none'`), 'system meters collapse into a SYS chip under 1200px');
  check(await evalExpr(`/CPU .*%.*RAM .*GB.*GPU/.test(document.getElementById('sysChip').title)`), 'SYS chip tooltip carries CPU, RAM and GPU', await evalExpr(`document.getElementById('sysChip').title`));
  const mid = await evalExpr(`(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, h: document.getElementById('topbar').getBoundingClientRect().height }))()`);
  check(mid.sw <= mid.w && mid.h <= 54, 'medium header fits without overflow', JSON.stringify(mid));

  await send('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await evalExpr(`window.dispatchEvent(new Event('resize')); true`);
  await sleep(900);
  const innerWidth = await evalExpr(`window.innerWidth`);
  check(innerWidth === 720, 'viewport emulation reaches 720px', String(innerWidth));
  const scrollWidth = await evalExpr(`document.documentElement.scrollWidth`);
  check(scrollWidth <= 720, 'page fits a 720px window without horizontal overflow', String(scrollWidth));
  const narrow = await evalExpr(`(() => ({ h: document.getElementById('topbar').getBoundingClientRect().height, wrap: getComputedStyle(document.getElementById('topbar')).flexWrap }))()`);
  check(narrow.h <= 54 && narrow.wrap === 'nowrap', 'narrow header stays a single row', JSON.stringify(narrow));
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(300);

  console.log('\nlayout');
  const base = await evalExpr(`(() => {
    const bottom = document.getElementById('bottomArea').getBoundingClientRect();
    const chat = document.getElementById('chatPane').getBoundingClientRect();
    return { bottom: bottom.height, chat: chat.width, editor: document.getElementById('editorWrap').getBoundingClientRect().width, ih: innerHeight, iw: innerWidth };
  })()`);
  check(base.bottom >= base.ih * 0.2 && base.bottom <= base.ih * 0.38, 'bottom area defaults to about 28%', JSON.stringify(base));
  check(base.chat >= 420 && base.chat >= base.iw * 0.4, 'chat pane defaults to about 45%', JSON.stringify(base));
  await evalExpr(`document.getElementById('treeCollapse').click(); true`);
  await sleep(400);
  check(await evalExpr(`document.body.classList.contains('tree-collapsed')`), 'tree collapses');
  check(await evalExpr(`getComputedStyle(document.getElementById('treeRail')).display !== 'none' && document.getElementById('treeRail').getBoundingClientRect().width <= 30`), 'tree leaves a thin rail');
  const treeCollapsed = await evalExpr(`(() => ({ editor: document.getElementById('editorWrap').getBoundingClientRect().width, badge: document.getElementById('treeBadge').textContent }))()`);
  check(treeCollapsed.editor > base.editor + 150, 'editor grows when the tree is collapsed', JSON.stringify({ before: base.editor, after: treeCollapsed.editor }));
  check(Number(treeCollapsed.badge) > 0, 'tree rail badge counts touched files', treeCollapsed.badge);
  await evalExpr(`document.getElementById('treeExpand').click(); true`);
  await sleep(300);
  check(!(await evalExpr(`document.body.classList.contains('tree-collapsed')`)), 'tree rail expands the tree');

  await evalExpr(`document.getElementById('splitter').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await sleep(300);
  check(await evalExpr(`document.body.classList.contains('bottom-collapsed')`), 'double-clicking the splitter minimizes the bottom area');
  check(await evalExpr(`getComputedStyle(document.getElementById('bottomRail')).display !== 'none'`), 'a bottom rail remains when minimized');
  check(await evalExpr(`document.getElementById('bottomRail').getBoundingClientRect().height >= 20`), 'the bottom rail is visible at the window edge');
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true })); true`);
  await sleep(300);
  check(!(await evalExpr(`document.body.classList.contains('bottom-collapsed')`)), 'Ctrl+J restores the bottom area');
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true })); true`);
  check(await evalExpr(`document.body.classList.contains('tree-collapsed')`), 'Ctrl+B toggles the tree');
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true })); true`);

  await evalExpr(`window.__layout.setBottom(420); window.__layout.setChat(500); window.__layout.toggleTree(true); true`);
  await sleep(300);
  await reloadPage();
  const restored = await evalExpr(`(() => ({
    tree: document.body.classList.contains('tree-collapsed'),
    bottom: document.getElementById('bottomArea').getBoundingClientRect().height,
    chat: document.getElementById('chatPane').getBoundingClientRect().width,
    saved: JSON.parse(localStorage.getItem('agenttail-layout') || '{}'),
  }))()`);
  check(restored.tree, 'collapsed tree state survives reload', JSON.stringify(restored.saved));
  check(Math.abs(restored.bottom - 420) <= 2, 'bottom height survives reload', String(restored.bottom));
  check(Math.abs(restored.chat - 500) <= 2, 'chat width survives reload', String(restored.chat));

  await evalExpr(`window.__layout.toggleBottom(true); window.__chat.setOpen(false); true`);
  await sleep(300);
  await reloadPage();
  check(await evalExpr(`document.body.classList.contains('bottom-collapsed') && document.body.classList.contains('chat-collapsed')`), 'collapsed bottom and chat states survive reload');
  check(await evalExpr(`getComputedStyle(document.getElementById('bottomRail')).display !== 'none'`), 'restored bottom rail is visible');
  await evalExpr(`window.__layout.toggleBottom(false); true`);
  await sleep(200);
  check(await evalExpr(`getComputedStyle(document.getElementById('chatRail')).display !== 'none'`), 'restored chat rail is visible after expanding the bottom area');

  await evalExpr(`localStorage.removeItem('agenttail-ui-scale'); true`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1790, height: 1320, deviceScaleFactor: 1, mobile: false }, sessionId);
  await reloadPage();
  check(await evalExpr(`document.documentElement.style.getPropertyValue('--ui-scale') === '1.15'`), 'wide windows default to 115% UI scale', await evalExpr(`document.documentElement.style.getPropertyValue('--ui-scale')`));
  check(await evalExpr(`document.documentElement.scrollWidth <= innerWidth`), '115% scale fits a 1790px window');

  await evalExpr(`localStorage.removeItem('agenttail-layout'); true`);
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await reloadPage();
  check(await evalExpr(`document.body.classList.contains('tree-collapsed') && document.body.classList.contains('chat-collapsed')`), 'narrow windows start with tree and chat collapsed');
  check(await evalExpr(`getComputedStyle(document.getElementById('treeRail')).display !== 'none' && getComputedStyle(document.getElementById('chatRail')).display !== 'none'`), 'narrow rails are visible');
  const narrowW = await evalExpr(`document.documentElement.scrollWidth`);
  check(narrowW <= 900, 'narrow docked layout has no horizontal overflow', String(narrowW));

  const postStatus = await evalExpr(`fetch('/api/nickname', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'dsh', id: '${fixture.finishedId}', nickname: 'ui-host-origin-check' }) }).then((r) => r.status)`, true);
  check(postStatus === 200, 'same-origin browser POST passes Host/Origin checks', String(postStatus));

  console.log('\nvendored assets');
  const assetUrls = await evalExpr(`performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /^https?:/.test(u))`);
  check(assetUrls.length > 0 && assetUrls.every((u) => u.startsWith(BASE)), 'every loaded resource is served locally', JSON.stringify(assetUrls.filter((u) => !u.startsWith(BASE)).slice(0, 5)));
  await send('Network.enable', {}, sessionId);
  await send('Network.setBlockedURLs', {
    urls: ['*cdn.jsdelivr.net*', '*fonts.googleapis.com*', '*fonts.gstatic.com*', '*cdnjs.cloudflare.com*'],
  }, sessionId);
  await reloadPage();
  const offlineLoaded = await waitFor(`!document.body.classList.contains('loading-session') && document.querySelectorAll('#chatLog > *').length > 0`, 12000);
  check(offlineLoaded, 'the page renders fully with external CDNs blocked');
  const offlineUrls = await evalExpr(`performance.getEntriesByType('resource').map((e) => e.name).filter((u) => /^https?:/.test(u))`);
  check(offlineUrls.every((u) => u.startsWith(BASE)), 'no external request is attempted', JSON.stringify(offlineUrls.filter((u) => !u.startsWith(BASE)).slice(0, 5)));
  await send('Network.setBlockedURLs', { urls: [] }, sessionId);

  console.log('\nloading and reduced motion');
  check(await evalExpr(`!!document.getElementById('treeSkeleton') && !!document.getElementById('editorSkeleton') && !!document.getElementById('consoleSkeleton')`), 'skeleton placeholders exist for tree/editor/console');
  check(await evalExpr(`!document.body.classList.contains('loading-session') && getComputedStyle(document.getElementById('treeSkeleton')).display === 'none'`), 'skeletons disappear when history is loaded');
  check(await evalExpr(`!!document.getElementById('loadFill')`), 'the loading progress line exists');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  await sleep(400);
  const runningAnimations = await evalExpr(`[...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return s.animationName !== 'none' && s.animationDuration !== '0s'; }).length`);
  check(runningAnimations === 0, 'prefers-reduced-motion disables every CSS animation', String(runningAnimations));
  check(await evalExpr(`getComputedStyle(document.getElementById('activityBar'), '::after').display === 'none'`), 'the activity stripe is static under reduced motion');
  await send('Emulation.setEmulatedMedia', { features: [] }, sessionId);

  check(pageLogs.filter((l) => !l.includes('Tracking Prevention') && !l.includes('Canceled')).length === 0, 'no page errors', JSON.stringify(pageLogs.slice(0, 4)));
} catch (err) {
  console.error(err);
  failures.push(String(err && err.stack || err));
} finally {
  try { if (targetId) await send('Target.closeTarget', { targetId }); } catch {}
  // msedge.exe hands off to another process, so the pid we spawned is not
  // the browser. Ask the browser for its own pid, close it over CDP, and end
  // its process tree if it is still running.
  let browserPid = null;
  try {
    const info = await Promise.race([send('SystemInfo.getProcessInfo'), sleep(2000)]);
    browserPid = info?.processInfo?.find((p) => p.type === 'browser')?.id ?? null;
  } catch {}
  try { if (browser) await Promise.race([send('Browser.close'), sleep(2000)]); } catch {}
  try { browser?.close(); } catch {}
  await sleep(500);
  if (process.platform === 'win32') {
    for (const pid of [browserPid, edge?.pid].filter(Boolean)) {
      try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    }
  } else {
    try { edge?.kill(); } catch {}
  }
  server.kill();
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('all UI checks passed');
process.exit(0);
