// Multi-agent overview: repo detection (including linked worktrees), grouping,
// shared-file overlaps, colours and the /api/agents endpoint.
// Run: node test/agents.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { buildFixture } from './fixture.mjs';

const require = createRequire(import.meta.url);
const { buildAgents, repoFor, toolKind, relPath } = require('../lib/agents.js');

// Outside this checkout, so walking up from the fixture finds no other repo.
const tmp = path.join(os.tmpdir(), `agenttail-agents-${process.pid}`);
fs.rmSync(tmp, { recursive: true, force: true });

const failures = [];
const check = (cond, msg, extra) => {
  if (cond) console.log(`  ok    ${msg}`);
  else { failures.push(msg); console.log(`  FAIL  ${msg}${extra ? ' :: ' + extra : ''}`); }
};

// A main checkout with a real `.git` folder and a linked worktree whose `.git`
// is a pointer file, the way `git worktree add` lays them out.
const main = path.join(tmp, 'repo');
const wt = path.join(tmp, 'repo-feature');
const wtGone = path.join(tmp, 'repo-gone');
const plain = path.join(tmp, 'notes');
fs.mkdirSync(path.join(main, '.git', 'worktrees', 'repo-feature'), { recursive: true });
fs.mkdirSync(path.join(main, '.git', 'worktrees', 'repo-gone'), { recursive: true });
fs.mkdirSync(path.join(main, 'src'), { recursive: true });
fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
fs.mkdirSync(path.join(wtGone, 'src'), { recursive: true });
fs.mkdirSync(plain, { recursive: true });
fs.writeFileSync(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
fs.writeFileSync(path.join(main, '.git', 'worktrees', 'repo-feature', 'HEAD'), 'ref: refs/heads/feat/themes\n');
fs.writeFileSync(path.join(main, '.git', 'worktrees', 'repo-feature', 'commondir'), '../..\n');
fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'repo-feature')}\n`);
fs.writeFileSync(path.join(main, '.git', 'worktrees', 'repo-gone', 'HEAD'), 'ref: refs/heads/feat/gone\n');
fs.writeFileSync(path.join(main, '.git', 'worktrees', 'repo-gone', 'commondir'), '../..\n');
fs.writeFileSync(path.join(wtGone, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'repo-gone')}\n`);

try {
  console.log('\nrepo detection');
  const a = await repoFor(path.join(main, 'src'));
  const b = await repoFor(wt);
  const c = await repoFor(plain);
  check(!!a && a.branch === 'main' && a.worktree === false && a.root === main, 'a subfolder of the main checkout finds its repo', JSON.stringify(a));
  check(!!b && b.branch === 'feat/themes' && b.worktree === true && b.root === wt, 'a linked worktree finds its branch', JSON.stringify(b));
  check(!!a && !!b && a.key === b.key && a.name === 'repo', 'a worktree and its main checkout are the same repository');
  check(c === null, 'a folder outside git has no repository');
  const goneBefore = await repoFor(wtGone);
  fs.rmSync(wtGone, { recursive: true, force: true });
  const goneAfter = await repoFor(wtGone);
  check(!!goneBefore && !!goneAfter && goneBefore.key === goneAfter.key && goneAfter.key === a?.key && goneAfter.removed === true && goneAfter.worktree === true, 'a deleted worktree still resolves to the remembered repository', JSON.stringify({ before: goneBefore, after: goneAfter }));

  console.log('\nhelpers');
  check(toolKind('pwsh') === 'command' && toolKind('Bash') === 'command', 'shell tools are commands');
  check(toolKind('Edit') === 'edit' && toolKind('write') === 'edit' && toolKind('read') === 'read', 'edit/write/read tools are classified');
  check(relPath(path.join(wt, 'src', 'a.js'), wt, wt) === 'src/a.js', 'paths are made repo-relative with forward slashes');

  console.log('\ngrouping, overlaps and colours');
  const now = Date.now();
  const sessions = [
    {
      source: 'claude', id: 'one', title: 'Main work', state: 'live', cwd: main, lastEventAt: now - 2000,
      lastTool: { name: 'Edit', label: path.join(main, 'src', 'shared.js'), at: now - 2000 },
      touched: [{ path: path.join(main, 'src', 'shared.js'), at: now - 2000 }, { path: path.join(main, 'README.md'), at: now - 9000 }],
    },
    {
      source: 'dsh', id: 'two', title: 'Themes', state: 'live', cwd: wt, lastEventAt: now - 1000, model: 'deepseek-v4-flash', provider: 'deepseek-official',
      lastTool: { name: 'pwsh', label: 'npm test', at: now - 1000 },
      touched: [{ path: 'src/shared.js', at: now - 1500 }, { path: 'src/theme.css', at: now - 1200 }],
    },
    { source: 'dsh', id: 'three', title: 'Notes', state: 'idle', cwd: plain, lastEventAt: now - 60000, touched: [] },
    { source: 'dsh', id: 'old', title: 'Old', state: 'finished', cwd: main, lastEventAt: now - 3 * 3600 * 1000, touched: [] },
    { source: 'dsh', id: 'empty', title: 'Empty', state: 'live', cwd: main, empty: true, lastEventAt: now },
  ];
  const data = await buildAgents(sessions, { now, labelFor: (k) => ({ dsh: 'dsh', claude: 'Claude Code' }[k]) });
  check(data.total === 3 && data.live === 2, 'old finished and empty sessions are left out', JSON.stringify({ total: data.total, live: data.live }));
  const repoGroup = data.groups.find((g) => g.git);
  check(!!repoGroup && repoGroup.agents.length === 2 && repoGroup.name === 'repo', 'agents in a repo and its worktree share one group', JSON.stringify(data.groups.map((g) => [g.name, g.agents.length])));
  check(data.groups.some((g) => !g.git && g.name === 'notes'), 'a folder outside git forms its own group');
  check(!!repoGroup && repoGroup.overlaps.length === 1 && repoGroup.overlaps[0].path === 'src/shared.js' && repoGroup.overlaps[0].agents.length === 2, 'a file both agents wrote is an overlap', JSON.stringify(repoGroup?.overlaps));
  const colors = repoGroup ? repoGroup.agents.map((x) => x.color) : [];
  check(colors.length === 2 && colors[0] !== colors[1] && colors.every((x) => Number.isInteger(x) && x >= 0 && x < 8), 'agents in one repo get different colours', JSON.stringify(colors));
  const one = repoGroup?.agents.find((x) => x.id === 'one');
  const two = repoGroup?.agents.find((x) => x.id === 'two');
  check(one?.activity?.kind === 'edit' && one.activity.label === 'src/shared.js', 'an edit is reported with a repo-relative path', JSON.stringify(one?.activity));
  check(two?.activity?.kind === 'command' && two.activity.label === 'npm test', 'a command is reported as it was run', JSON.stringify(two?.activity));
  check(two?.repo?.branch === 'feat/themes' && two.repo.worktree === true && two.model === 'deepseek-official/deepseek-v4-flash', 'each agent carries its branch and model', JSON.stringify(two?.repo));
  check(!JSON.stringify(data).includes(tmp), 'the payload carries no local repository paths');
  const again = await buildAgents(sessions, { now, labelFor: (k) => k });
  check(JSON.stringify(again.groups.map((g) => g.agents.map((x) => x.color))) === JSON.stringify(data.groups.map((g) => g.agents.map((x) => x.color))), 'colours are stable between snapshots');

  console.log('\n/api/agents');
  const fixture = buildFixture(path.join(tmp, 'server'));
  const PORT = 8905;
  const server = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENTTAIL_NO_OPEN: '1',
      AGENTTAIL_CONFIG_DIR: path.join(tmp, 'server'),
      DSH_SESSIONS_ROOT: fixture.sessionsRoot,
      CLAUDE_PROJECTS_ROOT: path.join(tmp, 'no-claude'),
      ANTIGRAVITY_ROOT: path.join(tmp, 'no-antigravity'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    let body = null;
    for (let i = 0; i < 80 && !body; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/agents`);
        if (res.ok) body = await res.json();
      } catch { /* starting */ }
      if (!body) await sleep(100);
    }
    check(!!body && Array.isArray(body.groups), 'the endpoint answers with groups', JSON.stringify(body)?.slice(0, 200));
    const agents = body ? body.groups.flatMap((g) => g.agents) : [];
    check(agents.some((x) => x.id === fixture.liveId && x.state === 'live'), 'the live fixture session is listed as live', JSON.stringify(agents.map((x) => [x.id, x.state])));
    const live = agents.find((x) => x.id === fixture.liveId);
    check(!!live && live.sourceLabel === 'dsh' && Number.isInteger(live.color), 'agents carry a source label and a colour');
    // The page's own files are served from /app/, and nothing else is.
    const appJs = await fetch(`http://127.0.0.1:${PORT}/app/main.js`);
    check(appJs.status === 200 && /javascript/.test(appJs.headers.get('content-type') || ''), 'the page scripts are served from /app/');
    const appCss = await fetch(`http://127.0.0.1:${PORT}/app/app.css`);
    check(appCss.status === 200 && /text\/css/.test(appCss.headers.get('content-type') || ''), 'the stylesheet is served from /app/');
    for (const bad of ['/app/..%2Fserver.js', '/app/%2E%2E/server.js', '/app/index.html', '/app/sub/x.js', '/app/']) {
      const res = await fetch(`http://127.0.0.1:${PORT}${bad}`);
      check(res.status === 404, `/app/ refuses ${bad}`, String(res.status));
    }
    // The watch wall subscribes with tail + lite: the last N events, no tree.
    const sse = await new Promise((resolve) => {
      const ctrl = new AbortController();
      const seen = [];
      let count = null;
      const finish = () => { ctrl.abort(); resolve({ seen, count }); };
      setTimeout(finish, 6000);
      fetch(`http://127.0.0.1:${PORT}/api/stream?source=dsh&id=${encodeURIComponent(fixture.finishedId)}&tail=2&lite=1`, { signal: ctrl.signal })
        .then(async (res) => {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            for (const m of buf.matchAll(/^event: (\w+)$/gm)) if (!seen.includes(m[1])) seen.push(m[1]);
            const end = /event: historyEnd\ndata: (\{[^\n]*\})/.exec(buf);
            if (end) { count = JSON.parse(end[1]); finish(); break; }
          }
        })
        .catch(() => {});
    });
    check(!!sse.count && sse.count.count === 2 && sse.count.total > 2, 'tail=2 sends only the last two history events', JSON.stringify(sse.count));
    check(!sse.seen.includes('tree'), 'lite mode sends no file tree', JSON.stringify(sse.seen));
    const post = await fetch(`http://127.0.0.1:${PORT}/api/agents`, { method: 'POST', headers: { Origin: `http://127.0.0.1:${PORT}`, 'Content-Type': 'application/json' }, body: '{}' });
    check(post.status === 405, 'the endpoint is read-only', String(post.status));
  } finally {
    server.kill();
    await sleep(300);
  }
} catch (err) {
  console.error(err);
  failures.push(String(err && err.stack || err));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} failure(s):`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log('all agents checks passed');
