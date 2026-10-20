#!/usr/bin/env node
/**
 * Capture synthetic demo assets with headless Edge/Chrome over CDP.
 *
 *   node scripts/capture.mjs [--out docs]
 *
 * Generates a fake session, starts a throwaway server and records the page.
 * Nothing from the user's real sessions is read or written.
 */
'use strict';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import pngjs from 'pngjs';
import gifenc from 'gifenc';

const { PNG } = pngjs;
const { GIFEncoder, quantize, applyPalette } = gifenc;

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = path.resolve(argValue('--out', path.join(ROOT, 'docs')));
const DEMO = process.platform === 'win32'
  ? 'C:\\ProgramData\\agenttail-demo-capture'
  : path.join(os.tmpdir(), `agenttail-demo-${process.pid}`);
const PROFILE = path.join(os.tmpdir(), `agenttail-edge-${process.pid}`);
const PORT = 8896;
const CDP_PORT = 9336;
const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555';
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

let server;
let browser;
let ws;
let id = 0;
const pending = new Map();

function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  throw new Error('Edge or Chrome not found; set EDGE_PATH');
}

async function waitHttp(url, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function cdp(method, params = {}) {
  const callId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'page evaluation failed');
  return result.result.value;
}

async function waitEval(expression, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (await evaluate(expression)) return true; } catch { /* page may still be navigating */ }
    await sleep(100);
  }
  return false;
}

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((target) => target.type === 'page');
  if (!page) throw new Error('no page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (!data.id || !pending.has(data.id)) return;
    const item = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error.message));
    else item.resolve(data.result);
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Network.enable');
}

async function setViewport(width, height) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}

async function framePng() {
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  return PNG.sync.read(Buffer.from(shot.data, 'base64'));
}

function writeGif(file, frames, width, height, delay) {
  const gif = GIFEncoder();
  for (const png of frames) {
    const rgba = new Uint8Array(png.data);
    const palette = quantize(rgba, 128, { format: 'rgba4444' });
    const index = applyPalette(rgba, palette, 'rgba4444');
    gif.writeFrame(index, width, height, { palette, delay });
  }
  gif.finish();
  fs.writeFileSync(file, gif.bytes());
}

async function captureLoading() {
  await cdp('Network.emulateNetworkConditions', {
    offline: false,
    latency: 180,
    downloadThroughput: 700 * 1024 / 8,
    uploadThroughput: 700 * 1024 / 8,
  });
  await setViewport(1200, 750);
  await cdp('Page.navigate', { url: `${BASE}/#${SESSION_ID}` });
  await sleep(120);
  const frames = [];
  for (let i = 0; i < 14; i++) {
    frames.push(await framePng());
    await sleep(110);
  }
  fs.writeFileSync(path.join(OUT, 'loading.png'), PNG.sync.write(frames[0]));
  await cdp('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
}

async function startDemo() {
  const child = spawn(process.execPath, [
    path.join(ROOT, 'scripts', 'demo-session.mjs'),
    '--dir', DEMO, '--append', '--delay', '500',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', (chunk) => process.stdout.write(`  [demo] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`  [demo:err] ${chunk}`));
  return child;
}

async function captureHero() {
  await cdp('Network.setCacheDisabled', { cacheDisabled: true });
  await setViewport(1200, 750);
  await cdp('Page.navigate', { url: `${BASE}/#${SESSION_ID}` });
  await waitEval(`document.body && !document.body.classList.contains('loading-session')`, 15000);
  await sleep(400);
  const demo = await startDemo();
  const frames = [];
  let streamShot = null;
  for (let i = 0; i < 52; i++) {
    const png = await framePng();
    frames.push(png);
    if (!streamShot) {
      const text = await evaluate(`(() => { const b = window.__agenttailTerm.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\n'; return s.includes('▓'); })()`);
      if (text) streamShot = png;
    }
    await sleep(190);
  }
  writeGif(path.join(OUT, 'hero.gif'), frames, 1200, 750, 190);
  if (demo.exitCode === null) await new Promise((resolve) => demo.once('exit', resolve));
  if (streamShot) {
    // Re-capture stream mode at a readable size once the redacted line is present.
    await setViewport(1600, 1000);
    await sleep(300);
    const line = await evaluate(`(() => { const b = window.__agenttailTerm.buffer.active; for (let i = 0; i < b.length; i++) if (b.getLine(i).translateToString(true).includes('▓')) return i; return -1; })()`);
    if (line >= 0) await evaluate(`window.__agenttailTerm.scrollToLine(${Math.max(0, line - 3)}); true`);
    await sleep(300);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'stream-mode.png'), Buffer.from(shot.data, 'base64'));
  }
  await waitEval(`document.getElementById('liveText').textContent !== 'LIVE'`, 8000);
  await sleep(2400);
}

async function captureStills() {
  await setViewport(1600, 1000);
  await sleep(500);
  await evaluate(`document.getElementById('chatViewChat').click(); true`);
  await sleep(400);
  let shot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'screenshot-dark.png'), Buffer.from(shot.data, 'base64'));
  await evaluate(`document.getElementById('chatViewLog').click(); true`);
  await sleep(400);
  shot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'chat-log.png'), Buffer.from(shot.data, 'base64'));
}

async function cleanup() {
  try { ws?.close(); } catch { /* ignore */ }
  if (browser?.pid) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        browser.kill('SIGKILL');
      }
    } catch { /* ignore */ }
  }
  try { server?.kill(); } catch { /* ignore */ }
  await sleep(400);
  await fsp.rm(DEMO, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'demo-session.mjs'), '--dir', DEMO, '--history-turns', '3'], { cwd: ROOT, stdio: 'ignore' });
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENTTAIL_NO_OPEN: '1',
      DSH_SESSIONS_ROOT: path.join(DEMO, 'sessions'),
      DSH_ROOTS_FILE: path.join(DEMO, 'roots.json'),
      DSH_REDACT_FILE: path.join(DEMO, 'redact.json'),
      DSH_NICKNAMES_FILE: path.join(DEMO, 'nicknames.json'),
      DSH_POLL_MS: '120',
      AGENTTAIL_HISTORY_DELAY_MS: '1800',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  server.stdout.on('data', (chunk) => process.stdout.write(`  [server] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`  [server:err] ${chunk}`));
  await waitHttp(`${BASE}/api/sessions`);

  browser = spawn(findBrowser(), [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`, '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break;
    } catch { /* starting */ }
    await sleep(100);
  }
  await connect();
  // Turn off the boot overlay so the loading skeleton, not a black boot screen,
  // is what the loading capture shows.
  await cdp('Page.navigate', { url: `${BASE}/` });
  await waitEval(`document.body && document.body.classList.contains('boot-done')`, 8000);
  await evaluate(`localStorage.setItem('agenttail-fx', JSON.stringify(Object.assign(JSON.parse(localStorage.getItem('agenttail-fx') || '{}'), { boot: false }))); true`);

  console.log('capturing loading.png');
  await captureLoading();
  console.log('capturing hero.gif');
  await captureHero();
  console.log('capturing stills');
  await captureStills();

  const files = ['hero.gif', 'loading.png', 'screenshot-dark.png', 'stream-mode.png', 'chat-log.png'];
  for (const name of files) {
    const stat = await fsp.stat(path.join(OUT, name));
    console.log(`${name.padEnd(20)} ${(stat.size / 1024).toFixed(0)} KiB`);
  }
  await cleanup();
})().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exitCode = 1;
});
