// Step 2: server-side stream-mode redaction.
// Run: node test/redact.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { frame, ev } from './fixture.mjs';
import { Redactor, safeRedact } from '../lib/redact.js';

const PORT = 8896;
const OFF_PORT = 8895;
const BASE = `http://127.0.0.1:${PORT}`;
const OFF_BASE = `http://127.0.0.1:${OFF_PORT}`;
const tmp = path.join(import.meta.dirname, '.tmp-redact');
const workspace = path.join(tmp, 'workspace');
const sessionsRoot = path.join(tmp, 'sessions');
const id = 'session-12345678-1234-1234-1234-123456789abc';
const redactFile = path.join(tmp, 'redact.json');
const PRIVATE_ROOT = path.join(tmp, 'PrivateData');

const SECRETS = {
  sk: 'sk-live-ABCDEFGHIJKLMNOPQRSTUV',
  ghp: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  bearer: 'Bearer abcDEF1234567890abcdef',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  password: 'password=hunter2',
  userinfo: 'https://alice:s3cr3t@example.com/api',
  email: 'alice@example.com',
  username: process.env.USERNAME || 'demo-user',
  computer: process.env.COMPUTERNAME || 'DESKTOP-ABC123',
  sid: 'S-1-5-21-111111111-2222222222-3333333333-1001',
  ipv4: '192.0.2.23',
  ipv6: 'fe80::1234:5678:9abc:def0',
  mac: 'aa:bb:cc:dd:ee:ff',
  host: 'PS5-TESTBOX',
  ssid: 'HomeNet-5G',
  envValue: 'supersecretvalue',
  privatePath: path.join(PRIVATE_ROOT, 'Secret Game', 'disc.iso'),
  scene: 'GROUP-Title_Name_2024_1080p.mkv',
  literal: 'ProjectBluebird',
  later: 'SecondSecret',
};

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true });
fs.mkdirSync(path.join(sessionsRoot, '--tmp--', id), { recursive: true });

fs.writeFileSync(path.join(workspace, 'src', 'app.js'), 'export const answer = 42;\n');
fs.writeFileSync(path.join(workspace, '.env'), `OPENAI_API_KEY=${SECRETS.sk}\nPASSWORD=hunter2\n`);
fs.writeFileSync(path.join(workspace, 'credentials.json'), JSON.stringify({ token: SECRETS.ghp }));
fs.writeFileSync(path.join(workspace, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEow...\n-----END OPENSSH PRIVATE KEY-----\n');
fs.writeFileSync(path.join(workspace, 'sub', 'hosts.yml'), 'all:\n  hosts:\n    ps5:\n      ansible_host: 10.0.0.9\n');
fs.writeFileSync(path.join(workspace, 'notes.txt'), [
  `Contact ${SECRETS.email}`,
  `Home: C:\\Users\\${SECRETS.username}\\Desktop\\notes.txt`,
  `Shell: /c/Users/${SECRETS.username}/bin`,
  `Lower: c:\\users\\${SECRETS.username}\\tmp`,
  `Literal ${SECRETS.literal} and ${SECRETS.later}`,
  '',
].join('\n'));
fs.writeFileSync(path.join(workspace, SECRETS.scene), 'not a real video\n');

fs.writeFileSync(redactFile, JSON.stringify({
  literals: [SECRETS.literal],
  patterns: [{ regex: 'Ticket-\\d{4}', flags: 'g' }],
}, null, 2));

const logEvents = [
  {
    type: 'session', version: 4, id, createdAt: Date.now() - 60000, cwd: workspace,
    isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  },
  ev('step/start', 1, { turn: 1, step: 1 }),
  {
    type: 'user/message', seq: 2, time: Date.now() - 50000, surfaceOp: 'append',
    data: { role: 'user', content: [{ type: 'text', text: `Mail ${SECRETS.email}, host ${SECRETS.host}.` }], source: { kind: 'user' } },
  },
  {
    type: 'assistant/message', seq: 3, time: Date.now() - 49000, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: `Using ${SECRETS.sk} and ${SECRETS.ghp}; auth ${SECRETS.bearer}; jwt ${SECRETS.jwt}; aws ${SECRETS.aws}; private key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretmaterial\n-----END RSA PRIVATE KEY-----` }] },
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  },
  ev('tool/call', 4, {
    turn: 1, step: 1, callId: 'env1', name: 'pwsh',
    arguments: JSON.stringify({ command: 'Get-ChildItem env:', description: 'dump env' }),
  }),
  ev('tool/result', 5, {
    turn: 1, step: 1,
    message: {
      role: 'tool', toolCallId: 'env1', isError: false,
      content: [{ type: 'text', text: `Name                 Value\nUSERNAME             ${SECRETS.username}\nAPI_TOKEN            ${SECRETS.envValue}\nCOMPUTERNAME         ${SECRETS.computer}` }],
    },
    meta: { cwd: workspace },
  }),
  ev('tool/call', 6, {
    turn: 1, step: 2, callId: 'cmd1', name: 'pwsh',
    arguments: JSON.stringify({ command: `curl "${SECRETS.userinfo}?token=abc123&x=1" ${SECRETS.password}` }),
  }),
  ev('tool/result', 7, {
    turn: 1, step: 2,
    message: {
      role: 'tool', toolCallId: 'cmd1', isError: false,
      content: [{ type: 'text', text: `IPv4 ${SECRETS.ipv4}\nURL http://${SECRETS.ipv4}:8787\nUUID 550e8400-e29b-41d4-a716-446655440000\nCall call_abcdef1234567890\nJob pwsh-4aca12345678\nFile session-analysis.js\nIPv6 ${SECRETS.ipv6}\nMAC ${SECRETS.mac}\nSSID: ${SECRETS.ssid}\nSID ${SECRETS.sid}\nHost ${SECRETS.host}\nTicket-1234\nCode: std::fprintf(stderr, "${SECRETS.ipv4}"); Foo::Bar a::b::c std::chrono::seconds v1.2.3.4` }],
    },
    meta: { cwd: workspace },
  }),
  ev('tool/call', 8, {
    turn: 1, step: 3, callId: 'edit1', name: 'edit',
    arguments: JSON.stringify({ file_path: path.join(workspace, '.env'), old_string: `OPENAI_API_KEY=${SECRETS.sk}`, new_string: 'OPENAI_API_KEY=rotated' }),
  }),
  ev('tool/result', 9, {
    turn: 1, step: 3,
    message: { role: 'tool', toolCallId: 'edit1', isError: false, content: [{ type: 'text', text: 'Edited .env' }] },
    meta: { path: path.join(workspace, '.env'), diffs: [] },
  }),
  ev('tool/call', 10, {
    turn: 1, step: 4, callId: 'write1', name: 'write',
    arguments: JSON.stringify({
      file_path: path.join(workspace, 'notes.txt'),
      content: `Contact ${SECRETS.email}\nHome C:\\Users\\${SECRETS.username}\\notes.txt\n${SECRETS.literal} ${SECRETS.later}\n`,
    }),
  }),
  ev('tool/result', 11, {
    turn: 1, step: 4,
    message: { role: 'tool', toolCallId: 'write1', isError: false, content: [{ type: 'text', text: 'Wrote notes.txt' }] },
    meta: { path: path.join(workspace, 'notes.txt'), operation: 'update', diffs: [] },
  }),
  {
    type: 'assistant/message', seq: 12, time: Date.now() - 30000, surfaceOp: 'append',
    data: {
      turn: 1, step: 5,
      message: { role: 'assistant', content: [{ type: 'text', text: `Private path ${SECRETS.privatePath} and release ${SECRETS.scene}` }] },
      usage: null,
    },
  },
];

const log = path.join(sessionsRoot, '--tmp--', id, 'session.v4.jsonl.zstd');
fs.writeFileSync(log, frame(logEvents));
const old = new Date(Date.now() - 600000);
fs.utimesSync(log, old, old);

const servers = [];
function startServer(port, extraArgs = []) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.js'), ...extraArgs], {
    env: {
      ...process.env,
      PORT: String(port),
      AGENTTAIL_NO_OPEN: '1',
      DSH_SESSIONS_ROOT: sessionsRoot,
      // Never the machine's own Antigravity folders: a real conversation would join the fixtures.
      ANTIGRAVITY_ROOT: path.join(tmp, 'no-antigravity', 'brain'),
      DSH_ROOTS_FILE: path.join(tmp, 'roots.json'),
      DSH_REDACT_FILE: redactFile,
      DSH_POLL_MS: '150',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (d) => process.stdout.write('  [server] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('  [server:err] ' + d));
  servers.push(child);
  return child;
}

async function readAllSse(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const events = [];
    while (true) {
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
        if (events.at(-1).event === 'historyEnd') {
          controller.abort();
          return { events, text: JSON.stringify(events) };
        }
      }
    }
    return { events, text: JSON.stringify(events) };
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const failures = [];
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok    ${msg}`);
  else { failures.push(msg); console.log(`  FAIL  ${msg}${extra ? ' :: ' + extra : ''}`); }
};

fs.writeFileSync(path.join(tmp, 'roots.json'), JSON.stringify({ roots: [], privateRoots: [PRIVATE_ROOT] }));

startServer(PORT);
startServer(OFF_PORT, ['--no-stream-mode']);

try {
  for (let i = 0; i < 60; i++) {
    try {
      const a = await fetch(BASE + '/api/sessions');
      const b = await fetch(OFF_BASE + '/api/sessions');
      if (a.ok && b.ok) break;
    } catch {}
    await sleep(100);
  }

  console.log('\nstream mode: SSE');
  const sse = await readAllSse(`${BASE}/api/stream?id=${id}`);
  const text = sse.text;
  const meta = sse.events.find((e) => e.event === 'meta');
  check(meta?.data.streamSafe === true, 'stream mode is reported as on');
  check(!!meta?.data.prices, 'pricing still sent for dsh');

  const rawValues = [
    ['sk token', SECRETS.sk], ['github token', SECRETS.ghp], ['bearer value', 'abcDEF1234567890abcdef'],
    ['jwt', SECRETS.jwt], ['aws key', SECRETS.aws], ['password', 'hunter2'], ['url password', 's3cr3t'],
    ['email', SECRETS.email], ['username', SECRETS.username], ['computer name', SECRETS.computer],
    ['sid', SECRETS.sid], ['ipv4', SECRETS.ipv4], ['ipv6', SECRETS.ipv6], ['mac', SECRETS.mac],
    ['hostname', SECRETS.host], ['ssid', SECRETS.ssid], ['env value', SECRETS.envValue],
    ['private path', PRIVATE_ROOT], ['release name', SECRETS.scene], ['user literal', SECRETS.literal],
    ['private key body', 'MIIEsecretmaterial'], ['pattern ticket', 'Ticket-1234'],
  ];
  for (const [label, value] of rawValues) {
    check(!text.includes(value), `${label} never reaches the SSE stream`, value.slice(0, 40));
  }
  check(text.includes('▓'), 'redactions use block glyphs');
  check(text.includes('[private]'), 'private paths are marked [private]');
  check(text.includes('std::fprintf'), 'C++ scope resolution is not mistaken for IPv6');
  check(text.includes('Foo::Bar') && text.includes('a::b::c') && text.includes('std::chrono::seconds'), 'C++ identifiers survive redaction');
  check(text.includes('v1.2.3.4'), 'version strings are not mistaken for IPv4');
  check(text.includes(':8787') && !text.includes(`${SECRETS.ipv4}:8787`), 'URL IPs are redacted without losing the port');
  check(!text.includes('550e8400') && !text.includes('call_abcdef') && !text.includes('pwsh-4aca'), 'UUIDs and opaque ids are redacted');
  check(text.includes('session-analysis.js'), 'session-looking filenames survive');

  console.log('\nstream mode: env dump');
  const envResult = sse.events.find((e) => e.event === 'ev' && e.data.t === 'result' && e.data.callId === 'env1')?.data;
  check(envResult && envResult.text.includes('API_TOKEN'), 'environment names are kept');
  check(envResult && !envResult.text.includes(SECRETS.envValue), 'environment values are redacted');
  check(envResult && !envResult.text.includes(SECRETS.computer), 'COMPUTERNAME value is redacted');

  console.log('\nstream mode: file API + tree');
  const envFile = await (await fetch(`${BASE}/api/file?id=${id}&path=${encodeURIComponent('.env')}`)).json();
  check(envFile.content === '[contents hidden]', 'sensitive .env contents are hidden', JSON.stringify(envFile.content).slice(0, 80));
  const creds = await (await fetch(`${BASE}/api/file?id=${id}&path=${encodeURIComponent('credentials.json')}`)).json();
  check(creds.content === '[contents hidden]', 'credentials file contents are hidden');
  const keyFile = await (await fetch(`${BASE}/api/file?id=${id}&path=${encodeURIComponent('id_rsa')}`)).json();
  check(keyFile.content === '[contents hidden]', 'private key file contents are hidden');
  const hosts = await (await fetch(`${BASE}/api/file?id=${id}&path=${encodeURIComponent('sub/hosts.yml')}`)).json();
  check(hosts.content === '[contents hidden]', 'hosts.yml contents are hidden');

  const notes = await (await fetch(`${BASE}/api/file?id=${id}&path=${encodeURIComponent('notes.txt')}`)).json();
  check(!notes.content.includes(SECRETS.email), 'file contents redact email addresses');
  check(!notes.content.includes(SECRETS.username), 'file contents redact the Windows username');
  check(notes.content.includes('▓'), 'file contents use block glyphs', JSON.stringify(notes.content).slice(0, 120));

  const tree = await (await fetch(`${BASE}/api/tree?id=${id}`)).json();
  const treeText = JSON.stringify(tree);
  check(!treeText.includes(SECRETS.scene), 'scene release names are hidden in the tree');
  check(treeText.includes('[private]'), 'tree marks private paths');
  check(!treeText.includes(SECRETS.username), 'tree names are redacted');

  console.log('\nlive reload of redact.json');
  fs.writeFileSync(redactFile, JSON.stringify({ literals: [SECRETS.later], patterns: [] }, null, 2));
  await sleep(1400);
  const notes2 = await (await fetch(`${BASE}/api/file?id=${id}&path=${encodeURIComponent('notes.txt')}`)).json();
  check(!notes2.content.includes(SECRETS.later), 'new literal from redact.json is applied live');
  check(notes2.content.includes(SECRETS.literal), 'removed literal no longer applies');

  console.log('\nstream mode off');
  const offSse = await readAllSse(`${OFF_BASE}/api/stream?id=${id}`);
  const offMeta = offSse.events.find((e) => e.event === 'meta');
  check(offMeta?.data.streamSafe === false, 'stream mode off is reported');
  check(offSse.text.includes(SECRETS.email), 'raw data flows when the operator disables stream mode');
  const offEnv = await (await fetch(`${OFF_BASE}/api/file?id=${id}&path=${encodeURIComponent('.env')}`)).json();
  check(offEnv.content.includes(SECRETS.sk), 'file contents are raw when stream mode is off');

  console.log('\nredactor unit checks');
  const r = new Redactor({ configPath: redactFile, enabled: true });
  const uname = process.env.USERNAME || 'user';
  for (const sample of [`C:\\Users\\${uname}\\x.txt`, `/c/Users/${uname}/x`, `c:\\users\\${uname}\\y`]) {
    check(!r.text(sample).toLowerCase().includes(uname.toLowerCase()), `path form redacted: ${sample}`, r.text(sample));
  }
  for (const outside of [`C:/Users/${uname}/AppData/Local/Temp/x.cjs`, `C:\\Users\\${uname}\\notes.md`]) {
    const call = r.event({ t: 'call', name: 'edit', args: { file_path: outside, old_string: 'a', new_string: 'b' } });
    check(!call.args.file_path.toLowerCase().includes(uname.toLowerCase()), `file paths outside the workspace are redacted: ${outside}`, call.args.file_path);
    const result = r.event({ t: 'result', text: 'ok', meta: { path: outside } });
    check(!result.meta.path.toLowerCase().includes(uname.toLowerCase()), `result paths outside the workspace are redacted: ${outside}`, result.meta.path);
  }
  const ran = r.event({ t: 'result', text: 'ok', meta: { path: null, operation: null, cwd: `C:\\Users\\${uname}\\project` } });
  check(!ran.meta.cwd.toLowerCase().includes(uname.toLowerCase()), 'a command result does not carry its working directory unredacted', ran.meta.cwd);
  const posix = r.event({ t: 'result', text: 'cd /home/alice-dev/work && ls', meta: { path: null, operation: null, cwd: '/home/alice-dev/work' } });
  check(!JSON.stringify(posix).includes('alice-dev'), 'Linux home folders are redacted in text and working directories too', JSON.stringify(posix));
  check(r.text('see /homework and src/home/notes.js').includes('/homework') && r.text('src/home/notes.js').includes('home/notes.js'), 'only a real /home/<name> is touched');

  // redact.json: one bad pattern must not cost the others, and a broken file keeps what was loaded.
  const cfg = path.join(tmp, 'redact-broken.json');
  fs.writeFileSync(cfg, JSON.stringify({ literals: ['AcmeSecretClient'], patterns: ['acme-[0-9]+', '(unclosed'] }));
  const rb = new Redactor({ configPath: cfg, enabled: true });
  check(!rb.text('AcmeSecretClient acme-42').includes('AcmeSecretClient') && !rb.text('acme-42').includes('acme-42'), 'an invalid pattern is skipped and the rest still apply');
  fs.writeFileSync(cfg, '{ "literals": [ broken');
  fs.utimesSync(cfg, new Date(), new Date(Date.now() + 10000));
  rb.refresh(true);
  check(!rb.text('AcmeSecretClient acme-42').includes('AcmeSecretClient'), 'a redact.json that stops parsing keeps the literals and patterns already loaded');
  const inside = r.event({ t: 'call', name: 'edit', args: { file_path: 'src/app.js', old_string: 'a', new_string: 'b' } });
  check(inside.args.file_path === 'src/app.js', 'workspace-relative file paths stay as they are');
  check(!r.text('S-1-5-21-1-2-3-1001').includes('S-1-5-21'), 'SID redacted');
  check(!r.text('10.0.0.5').includes('10.0.0.5'), 'IPv4 redacted');
  check(!r.text('http://127.0.0.1:8787').includes('127.0.0.1') && r.text('http://127.0.0.1:8787').includes(':8787'), 'IPv4 in a URL is redacted but the port remains');
  check(!r.text('::1').includes('::1'), 'loopback IPv6 redacted');
  check(!r.text('550e8400-e29b-41d4-a716-446655440000').includes('550e8400'), 'UUIDs are redacted');
  check(!r.text('call_abcdef1234567890').includes('call_abcdef'), 'call/tool ids are redacted');
  check(!r.text('pwsh-4aca12345678').includes('pwsh-4aca'), 'pwsh job ids are redacted');
  check(r.text('session-analysis.js') === 'session-analysis.js', 'filenames that look like session ids survive');
  check(r.text('3f43a8199') === '3f43a8199', 'short git hashes survive');
  check(r.text('call_controller') === 'call_controller', 'ordinary call_ identifiers survive');
  check(!r.text('aa-bb-cc-dd-ee-ff').includes('aa-bb'), 'MAC redacted');
  check(!r.text('PS5-ALPHA').includes('PS5-ALPHA'), 'PS5 hostname redacted');
  check(!r.text('mail me at bob@corp.example').includes('bob@corp.example'), 'email redacted');
  const token = 'sk-' + 'a'.repeat(30);
  check(r.text(token).length === token.length, 'blocks preserve match length');

  console.log('\nnetwork boundary checks');
  const untouched = [
    'std::fprintf(stderr, "x");',
    'Foo::Bar value',
    'a::b::c',
    'std::chrono::seconds',
    'v1.2.3.4',
  ];
  for (const sample of untouched) {
    check(r.text(sample) === sample, `not redacted: ${sample}`, r.text(sample));
  }
  const touched = [
    ['fe80::1', 'fe80::1'],
    ['2001:db8::8a2e:370:7334', '2001:db8::8a2e:370:7334'],
    ['::1', '::1'],
    ['192.168.1.10', '192.168.1.10'],
    ['aa:bb:cc:dd:ee:ff', 'aa:bb:cc:dd:ee:ff'],
    ['AA-BB-CC-DD-EE-FF', 'AA-BB-CC-DD-EE-FF'],
  ];
  for (const [label, sample] of touched) {
    check(!r.text(`addr ${sample} end`).includes(sample), `redacted: ${label}`, r.text(`addr ${sample} end`));
  }
  const failed = safeRedact({ event() { throw new Error('boom'); } }, { seq: 1, t: 'say', text: 'sk-RAW' });
  check(failed.t === 'redactionError' && failed.text === '[redaction error]', 'fail closed drops the raw event');
} catch (err) {
  console.error(err);
  failures.push(String(err && err.stack || err));
} finally {
  for (const s of servers) s.kill();
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures.slice(0, 20)) console.error(' - ' + f);
  process.exit(1);
}
console.log('all redaction checks passed');
