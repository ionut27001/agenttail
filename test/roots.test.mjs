// Step 1: allowlisted roots, junction following, two-way path mapping.
// Run: node test/roots.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { frame, ev } from './fixture.mjs';
import { Roots } from '../lib/roots.js';

const PORT = 8897;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = path.join(import.meta.dirname, '.tmp-roots');
const workspace = path.join(tmp, 'workspace');
const realRoot = path.join(tmp, 'real-root');
const blockedRoot = path.join(tmp, 'blocked-root');
const sessionsRoot = path.join(tmp, 'sessions');
const id = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.mkdirSync(path.join(realRoot, 'sub'), { recursive: true });
fs.mkdirSync(blockedRoot, { recursive: true });
fs.mkdirSync(path.join(sessionsRoot, '--tmp--', id), { recursive: true });

fs.writeFileSync(path.join(workspace, 'src', 'app.js'), 'export const answer = 42;\n');
fs.writeFileSync(path.join(workspace, 'outside-note.txt'), 'workspace note\n');
fs.writeFileSync(path.join(workspace, '_scratch.txt'), 'temp\n');
fs.mkdirSync(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'node_modules', 'pkg', 'index.js'), 'module\n');
fs.mkdirSync(path.join(workspace, '.tmp'), { recursive: true });
fs.writeFileSync(path.join(workspace, '.tmp', 'cache.bin'), 'cache\n');
fs.mkdirSync(path.join(workspace, 'build'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'build', 'out.obj'), 'obj\n');
fs.writeFileSync(path.join(realRoot, 'inside.txt'), 'allowlisted root content\n');
fs.writeFileSync(path.join(realRoot, 'sub', 'nested.txt'), 'nested content\n');
fs.writeFileSync(path.join(blockedRoot, 'secret.txt'), 'not allowlisted\n');

fs.symlinkSync(realRoot, path.join(workspace, 'link'), 'junction');
fs.symlinkSync(blockedRoot, path.join(workspace, 'blocked'), 'junction');

const rootsFile = path.join(tmp, 'roots.json');
fs.writeFileSync(rootsFile, JSON.stringify({
  roots: [{ path: realRoot, as: 'link', label: 'fixture real root' }],
  privateRoots: [],
  ignore: ['.tmp', 'node_modules', 'build', '_*'],
}, null, 2));

const session = {
  type: 'session', version: 4, id, createdAt: Date.now() - 60000, cwd: workspace,
  isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
};
const log = path.join(sessionsRoot, '--tmp--', id, 'session.v4.jsonl.zstd');
fs.writeFileSync(log, frame([
  session,
  ev('step/start', 1, { turn: 1, step: 1 }),
  ev('tool/call', 2, { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: path.join(realRoot, 'inside.txt') }) }),
]));
const old = new Date(Date.now() - 600000);
fs.utimesSync(log, old, old);

const server = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
      AGENTTAIL_NO_OPEN: '1',
    DSH_SESSIONS_ROOT: sessionsRoot,
    // Never the machine's own Antigravity folders: a real conversation would join the fixtures.
    ANTIGRAVITY_ROOT: path.join(tmp, 'no-antigravity', 'brain'),
    DSH_ROOTS_FILE: rootsFile,
    DSH_POLL_MS: '150',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
server.stdout.on('data', (d) => process.stdout.write('  [server] ' + d));
server.stderr.on('data', (d) => process.stderr.write('  [server:err] ' + d));

const failures = [];
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok    ${msg}`);
  else { failures.push(msg); console.log(`  FAIL  ${msg}${extra ? ' :: ' + extra : ''}`); }
};
const getJson = async (url) => {
  const res = await fetch(BASE + url);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/sessions')).ok) break; } catch {}
    await sleep(100);
  }

  const treeRes = await getJson('/api/tree?id=' + id);
  check(treeRes.status === 200, 'tree endpoint responds');
  const byPath = new Map();
  (function walk(nodes, prefix) {
    for (const n of nodes || []) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      byPath.set(n.path, n);
      if (n.children) walk(n.children, p);
    }
  })(treeRes.body.tree.children, '');

  check(byPath.has('src/app.js'), 'workspace file is listed');
  check(byPath.has('link'), 'allowlisted junction is listed');
  const linkNode = byPath.get('link');
  check(linkNode && !linkNode.link, 'allowlisted junction is followed (not marked blocked)');
  check(linkNode && linkNode.children.some((c) => c.name === 'inside.txt'), 'junction target children are shown');
  check(byPath.has('link/sub/nested.txt'), 'nested junction files are shown');
  check(byPath.has('blocked/secret.txt') === false, 'non-allowlisted junction is not expanded');
  check(byPath.get('blocked')?.link === true, 'non-allowlisted junction is marked as not followed');
  check(!byPath.has('node_modules/pkg/index.js'), 'node_modules is ignored by default');
  check(!byPath.has('.tmp/cache.bin'), '.tmp is ignored by default');
  check(!byPath.has('build/out.obj'), 'build directories are ignored by default');
  check(!byPath.has('_scratch.txt'), '_* temp files are ignored by default');
  const hiddenResolver = new Roots(rootsFile);
  const hiddenTree = await hiddenResolver.readTree(workspace, (p) => p, { showHidden: true });
  const hiddenPaths = [];
  (function collect(nodes) { for (const n of nodes || []) { hiddenPaths.push(n.path); collect(n.children); } })(hiddenTree?.children);
  check(hiddenPaths.includes('node_modules/pkg/index.js') && hiddenPaths.includes('.tmp/cache.bin') && hiddenPaths.includes('_scratch.txt'), 'show hidden reveals ignored entries', JSON.stringify(hiddenPaths.filter((p) => /node_modules|\.tmp|_scratch/.test(p))));

  const inside = await getJson(`/api/file?id=${id}&path=${encodeURIComponent('link/inside.txt')}`);
  check(inside.status === 200 && inside.body.content.includes('allowlisted root content'), 'junction path reads the real file', `${inside.status}`);

  const nestedKey = byPath.get('link/sub/nested.txt')?.key;
  check(!!nestedKey, 'tree nodes carry an opaque key');
  const byKey = await getJson(`/api/file?id=${id}&key=${encodeURIComponent(nestedKey)}`);
  check(byKey.status === 200 && byKey.body.content.includes('nested content'), 'file can be opened by opaque key');

  const blocked = await getJson(`/api/file?id=${id}&path=${encodeURIComponent('blocked/secret.txt')}`);
  check(blocked.status === 403, 'non-allowlisted junction target is rejected', String(blocked.status));

  const absAllowed = await getJson(`/api/file?id=${id}&path=${encodeURIComponent(path.join(realRoot, 'inside.txt'))}`);
  check(absAllowed.status === 200, 'absolute path inside an allowed root is readable', String(absAllowed.status));

  const absBlocked = await getJson(`/api/file?id=${id}&path=${encodeURIComponent(path.join(blockedRoot, 'secret.txt'))}`);
  check(absBlocked.status === 403, 'absolute path outside the roots is rejected', String(absBlocked.status));

  const traversal = await getJson(`/api/file?id=${id}&path=${encodeURIComponent('../outside.txt')}`);
  check(traversal.status === 403, 'relative traversal is rejected', String(traversal.status));

  const nestedTraversal = await getJson(`/api/file?id=${id}&path=${encodeURIComponent('src/../../outside.txt')}`);
  check(nestedTraversal.status === 403, 'nested traversal is rejected', String(nestedTraversal.status));

  const winAbs = await getJson(`/api/file?id=${id}&path=${encodeURIComponent('C:\\Windows\\win.ini')}`);
  check(winAbs.status === 403, 'unrelated absolute path is rejected', String(winAbs.status));

  // Symlink escape: point a junction inside the workspace at a non-root target
  // and confirm that even a path that looks workspace-relative is rejected.
  const escapeLink = path.join(workspace, 'escape');
  fs.symlinkSync(blockedRoot, escapeLink, 'junction');
  const escape = await getJson(`/api/file?id=${id}&path=${encodeURIComponent('escape/secret.txt')}`);
  check(escape.status === 403, 'symlink escape is rejected by realpath', String(escape.status));

  // Touched files are kept in the tree even beyond the depth/node budget.
  const deepRel = 'a/b/c/d/e/f/g/h/i/j/k/l/m/n/deep.txt';
  fs.mkdirSync(path.join(workspace, path.dirname(deepRel)), { recursive: true });
  fs.writeFileSync(path.join(workspace, deepRel), 'deep content\n');
  const resolver = new Roots(rootsFile);
  const deepTree = await resolver.readTree(workspace, (p) => p, { ensure: [deepRel] });
  const deepPaths = [];
  (function walk(nodes) { for (const n of nodes || []) { deepPaths.push(n.path); walk(n.children); } })(deepTree?.children);
  check(deepPaths.includes(deepRel), 'touched deep paths are injected into the tree');
} catch (err) {
  console.error(err);
  failures.push(String(err && err.stack || err));
} finally {
  server.kill();
  await sleep(400);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('all roots checks passed');
