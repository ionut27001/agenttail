// Browser test for the opt-in control surface: no input without the flag,
// stream-mode lockout, view-only hint, and an owned session driven through the
// UI against the fake ACP child (new session, approval card, queue, Stop, End).
// Run: node test/ui-control.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildFixture } from './fixture.mjs';

const CDP = 9335;
const root = path.join(import.meta.dirname, '..');
const tmp = path.join(import.meta.dirname, '.tmp-ui-control');
const fixture = buildFixture(tmp);
const controlFile = path.join(tmp, 'control.json');
fs.writeFileSync(controlFile, JSON.stringify({ workspaces: [fixture.workspace], maxSessions: 4 }));
const fakeAcp = path.join(import.meta.dirname, 'fake-acp.mjs');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const failures = [];
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok    ${msg}`);
  else { failures.push(msg); console.log(`  FAIL  ${msg}${extra ? ' :: ' + extra : ''}`); }
};

const servers = [];
async function launch(port, args) {
  let out = '';
  const proc = spawn(process.execPath, [path.join(root, 'server.js'), ...args], {
    env: {
      ...process.env,
      PORT: String(port),
      AGENTTAIL_NO_OPEN: '1',
      AGENTTAIL_CONFIG_DIR: tmp,
      AGENTTAIL_CONTROL_FILE: controlFile,
      AGENTTAIL_CONTROL_AUDIT_FILE: path.join(tmp, 'control-audit.log'),
      DSH_SESSIONS_ROOT: fixture.sessionsRoot,
      DSH_POLL_MS: '200',
      DSH_NICKNAMES_FILE: path.join(tmp, 'nicknames.json'),
      AGENTTAIL_DSH_BIN: process.execPath,
      AGENTTAIL_DSH_ARGS: JSON.stringify([fakeAcp]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => process.stderr.write('  [server:err] ' + d));
  servers.push(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/sessions`)).ok) break; } catch { /* starting */ }
    await sleep(100);
  }
  const token = /#token=([A-Za-z0-9_-]{20,})/.exec(out)?.[1] || null;
  return { base, token };
}

let edge = null;
let browser = null;
let sessionId = null;
let targetId = null;
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

async function evalExpr(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  return r.result?.value;
}

async function waitFor(expression, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await evalExpr(expression)) return true; } catch { /* page navigating */ }
    await sleep(200);
  }
  return false;
}

async function open(url) {
  await send('Page.navigate', { url }, sessionId);
  await sleep(300);
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('.monaco-editor')`, 20000);
  // The control status request runs after the page script starts.
  await sleep(800);
}

const hidden = (id) => `document.getElementById('${id}').classList.contains('hidden')`;
const text = (id) => `document.getElementById('${id}').textContent`;

try {
  const plain = await launch(8903, ['--no-stream-mode']);
  const locked = await launch(8902, ['--allow-control']);
  const live = await launch(8901, ['--allow-control', '--no-stream-mode']);
  check(!!live.token, 'the control server prints a token');

  edge = spawn(edgePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(tmp, 'edge-profile')}`,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      browser = ws;
    } catch { await sleep(200); }
  }
  if (!browser) throw new Error('edge did not expose CDP');
  browser.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') pageLogs.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  };
  targetId = (await send('Target.createTarget', { url: 'about:blank' })).targetId;
  sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

  console.log('\nwithout --allow-control');
  await open(`${plain.base}/#${fixture.finishedId}`);
  check(await evalExpr(hidden('composer')), 'no input box');
  check(await evalExpr(hidden('newSessionBtn')), 'no New Session button');
  check(await evalExpr(hidden('controlHint')), 'no control hint');

  console.log('\nstream mode');
  await open(`${locked.base}/#${fixture.finishedId}`);
  check(await evalExpr(hidden('composer')), 'no input box in stream mode');
  check(await evalExpr(hidden('newSessionBtn')), 'no New Session button in stream mode');
  check(await waitFor(`/control disabled in stream mode/.test(${text('controlHint')})`, 5000), 'the hint says control is disabled in stream mode', await evalExpr(text('controlHint')));

  console.log('\nview-only session');
  await open(`${live.base}/#token=${live.token}`);
  check(await evalExpr(`location.hash === '' || !location.hash.includes('token')`), 'the token is removed from the address bar');
  check(await evalExpr(`!${hidden('newSessionBtn')}`), 'New Session button is shown with a token');
  await evalExpr(`location.hash = '${fixture.finishedId}'; true`);
  check(await waitFor(`/started outside agenttail, view only/.test(${text('controlHint')})`, 8000), 'a session started elsewhere is view only', await evalExpr(text('controlHint')));
  check(await evalExpr(hidden('composer')), 'no input box for a view-only session');

  console.log('\nnew session');
  await evalExpr(`document.getElementById('newSessionBtn').click(); true`);
  check(await waitFor(`[...document.getElementById('dlgWorkspace').options].some((o) => o.value && o.value.endsWith('workspace'))`, 8000), 'the dialog lists the allowlisted workspace');
  check(await evalExpr(`document.getElementById('dlgPreset').value === 'workspace-write'`), 'the preset defaults to workspace-write');
  await evalExpr(`document.getElementById('dlgPreset').value = 'danger-full-access'; document.getElementById('dlgPreset').dispatchEvent(new Event('change')); true`);
  check(await evalExpr(`!${hidden('dangerRow')}`), 'danger-full-access shows a confirmation');
  await evalExpr(`document.getElementById('dlgContinue').click(); true`);
  check(await waitFor(`/confirmation/.test(${text('dlgErr')})`, 3000), 'danger-full-access is refused without the confirmation', await evalExpr(text('dlgErr')));
  await evalExpr(`document.getElementById('dlgPreset').value = 'workspace-write'; document.getElementById('dlgPreset').dispatchEvent(new Event('change')); true`);
  await evalExpr(`document.getElementById('dlgContinue').click(); true`);
  check(await waitFor(`!document.getElementById('dlgStep2').classList.contains('hidden') && document.getElementById('dlgModel').options.length > 0`, 10000), 'the dialog shows the live model catalog');
  check(await evalExpr(`document.querySelector('#dlgModel optgroup')?.label === 'ollama'`), 'models are grouped by provider');
  await evalExpr(`document.getElementById('dlgMessage').value = 'Please run the fake command'; document.getElementById('dlgStart').click(); true`);
  check(await waitFor(`!document.getElementById('newSessionDialog').open`, 10000), 'the dialog closes after start');

  console.log('\napproval');
  check(await waitFor(`!${hidden('composer')}`, 15000), 'the owned session shows the input box', await evalExpr(text('controlHint')));
  check(await waitFor(`!${hidden('approvalPanel')}`, 10000), 'the approval card appears');
  check(await evalExpr(`${text('approvalDetail')}.includes('$ echo fake-ok')`), 'the card shows the exact command', await evalExpr(text('approvalDetail')));
  check(await evalExpr(`!${hidden('approvalBadge')}`), 'the activity bar shows an approval badge');
  await evalExpr(`window.__agents.refresh(); true`);
  check(await waitFor(`!!window.__agents.data && window.__agents.data.groups.flatMap((g) => g.agents).some((a) => a.owned && a.approvals === 1)`, 6000), 'the agents overview shows the owned session waiting on an approval');
  check(await evalExpr(`${text('sessionButton')}.includes('✎')`), 'the picker marks the session as owned', await evalExpr(text('sessionButton')));
  check(await evalExpr(`document.getElementById('composerStop').disabled === false`), 'Stop is enabled while the turn runs');
  await evalExpr(`document.getElementById('approvalApprove').click(); true`);
  check(await waitFor(hidden('approvalPanel'), 8000), 'approving hides the card');
  check(await waitFor(`document.getElementById('composerStop').disabled === true`, 8000), 'the turn ends after approval');

  console.log('\ninput, queue and stop');
  const enter = (value) => `(() => { const el = document.getElementById('composerInput'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`;
  await evalExpr(`(() => { const el = document.getElementById('composerInput'); el.value = 'line one'; el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); return true; })()`);
  await sleep(300);
  check(await evalExpr(`document.getElementById('composerInput').value === 'line one'`), 'Shift+Enter does not send');
  await evalExpr(enter('Run it again'));
  check(await waitFor(`!${hidden('approvalPanel')}`, 8000), 'Enter sends and the next approval appears');
  await evalExpr(enter('A follow-up while busy'));
  check(await waitFor(`/queued/.test(${text('composerStatus')})`, 5000), 'a message during a running turn shows queued', await evalExpr(text('composerStatus')));
  await evalExpr(`document.getElementById('composerStop').click(); true`);
  check(await waitFor(`${hidden('approvalPanel')} && document.getElementById('composerStop').disabled === true`, 8000), 'Stop ends the turn and clears the card');

  console.log('\nmodel and images');
  check(await waitFor(`!document.getElementById('composerModel').classList.contains('hidden') && document.getElementById('composerModel').options.length === 2`, 5000), 'the composer offers the session models');
  await evalExpr(`(() => { const sel = document.getElementById('composerModel'); sel.value = JSON.stringify(['deepseek-official', 'deepseek-v4-flash']); sel.dispatchEvent(new Event('change')); return true; })()`);
  check(await waitFor(`/deepseek-official\\/deepseek-v4-flash/.test(${text('composerStatus')}) && document.getElementById('composerModel').value.includes('deepseek-v4-flash')`, 5000), 'switching the model applies it to the session', await evalExpr(text('composerStatus')));
  await evalExpr(`(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    document.getElementById('composerInput').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  check(await waitFor(`document.querySelectorAll('#composerAttachments .attach img').length === 1`, 5000), 'a pasted image shows as an attachment thumbnail');
  await evalExpr(enter('What does this screenshot show?'));
  check(await waitFor(`document.querySelectorAll('#composerAttachments .attach').length === 0 && !${hidden('approvalPanel')}`, 8000), 'sending clears the attachment and starts the turn');
  check(await waitFor(`document.getElementById('chatLog').textContent.includes('[images: 1]')`, 8000), 'the image reaches the agent with the message');
  await evalExpr(`document.getElementById('composerStop').click(); true`);
  await waitFor(`document.getElementById('composerStop').disabled === true`, 8000);

  console.log('\nend');
  await evalExpr(`window.confirm = () => true; document.getElementById('composerEnd').click(); true`);
  check(await waitFor(hidden('composer'), 8000), 'End removes the input box');
  check(await waitFor(`/view only/.test(${text('controlHint')})`, 5000), 'an ended session is view only', await evalExpr(text('controlHint')));

  // Monaco throws a benign `Canceled` when a model is disposed mid-request.
  const errors = pageLogs.filter((l) => !l.includes('Canceled'));
  check(errors.length === 0, 'no page errors', JSON.stringify(errors.slice(0, 4)));
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
  for (const proc of servers) { try { proc.kill(); } catch {} }
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('all control UI checks passed');
process.exit(0);
