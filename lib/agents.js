'use strict';

/**
 * Multi-agent overview: which agents are working right now, grouped by the
 * git repository they work in, with what each one is doing and the files
 * more than one of them has edited.
 *
 * Read-only: repository detection only reads `.git`, `gitdir`, `commondir`
 * and `HEAD`. Worktrees of one repository count as the same repository.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const attention = require('./attention');

const REPO_TTL_MS = 30_000;
const RECENT_MS = 30 * 60 * 1000;
const MAX_AGENTS = 16;
const repoCache = new Map();
// Resolved repos are kept for the process lifetime so a deleted linked
// worktree still groups under the repository it belonged to.
const repoMemory = new Map();
const COLORS = 8;

/** Stable colour slot for an agent (FNV-1a of its key). */
function colorSlot(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % COLORS;
}

async function readText(file) {
  try {
    return (await fsp.readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function statKind(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/** { key, name, root, branch, worktree } for the repo around `cwd`, or null. */
async function repoFor(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const cwdKey = path.resolve(cwd);
  const missing = (await statKind(cwdKey)) === null;
  const remembered = repoMemory.get(cwdKey);
  if (!missing) {
    const hit = repoCache.get(cwd);
    if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit.repo;
  }
  let repo = null;
  let dir = cwdKey;
  for (let depth = 0; depth < 40; depth++) {
    const dotGit = path.join(dir, '.git');
    const kind = await statKind(dotGit);
    if (kind === 'dir') {
      repo = { common: dotGit, gitDir: dotGit, root: dir, worktree: false };
      break;
    }
    if (kind === 'file') {
      // A linked worktree: `.git` holds `gitdir: <main>/.git/worktrees/<name>`,
      // and that folder's `commondir` points back at the shared `.git`.
      const pointer = await readText(dotGit);
      const match = pointer && /^gitdir:\s*(.+)$/m.exec(pointer);
      if (match) {
        const gitDir = path.resolve(dir, match[1].trim());
        const commonRel = await readText(path.join(gitDir, 'commondir'));
        const common = commonRel ? path.resolve(gitDir, commonRel) : gitDir;
        repo = { common, gitDir, root: dir, worktree: true };
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let result = null;
  if (repo) {
    const head = await readText(path.join(repo.gitDir, 'HEAD'));
    const branch = head && head.startsWith('ref: ') ? head.slice(5).replace(/^refs\/heads\//, '') : (head ? head.slice(0, 8) : null);
    const common = path.resolve(repo.common);
    result = {
      key: process.platform === 'win32' ? common.toLowerCase() : common,
      name: path.basename(path.dirname(common)),
      root: repo.root,
      branch,
      worktree: repo.worktree,
    };
    repoMemory.set(cwdKey, result);
  }
  // A linked worktree that has been deleted leaves a still-known repo and a
  // session cwd that no longer exists; keep it under its repository.
  if (!result && missing && remembered) {
    return { ...remembered, worktree: true, removed: true };
  }
  repoCache.set(cwd, { at: Date.now(), repo: result });
  return result;
}

function toolKind(name) {
  const n = String(name || '').toLowerCase();
  if (['pwsh', 'bash', 'shell', 'run_command', 'powershell'].includes(n)) return 'command';
  if (['edit', 'write', 'multiedit', 'multi_edit', 'notebookedit', 'notebook_edit', 'apply_patch', 'replace_file_content', 'write_to_file'].includes(n)) return 'edit';
  if (['read', 'view_file', 'read_file'].includes(n)) return 'read';
  if (['grep', 'glob', 'search', 'find', 'list_dir'].includes(n)) return 'search';
  if (['task', 'agent'].includes(n)) return 'agent';
  return 'tool';
}

/** Path relative to the repo root (or the session cwd), with forward slashes. */
function relPath(file, cwd, root) {
  if (!file) return null;
  const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(cwd || '.', file);
  const base = root || cwd;
  if (base) {
    const rel = path.relative(base, abs);
    if (rel === '') return '.';
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return abs.split(path.sep).join('/');
}

/**
 * Build the overview from session records of every source.
 * `text` redacts a display string (stream mode); `labelFor` names a source.
 */
async function buildAgents(sessions, { now = Date.now(), text = (s) => s, labelFor = (s) => s } = {}) {
  const order = { live: 0, idle: 1, finished: 2 };
  // An agent waiting on the human is always listed, and first.
  const waiting = (s) => attention.isNeedsYou(s.attention);
  const listed = sessions
    .filter((s) => s && !s.empty && (waiting(s) || s.state === 'live' || s.state === 'idle' || now - (s.lastEventAt || 0) < RECENT_MS))
    .sort((a, b) => (waiting(b) ? 1 : 0) - (waiting(a) ? 1 : 0)
      || (waiting(a) && waiting(b) ? attention.compareForList(a.attention, b.attention) : 0)
      || (order[a.state] ?? 3) - (order[b.state] ?? 3)
      || (b.lastEventAt || 0) - (a.lastEventAt || 0));
  // The cap trims only the agents that do not need you. They sort first, so
  // the inbox and the NEEDS YOU counts never lose one however many wait.
  const recent = listed.slice(0, Math.max(MAX_AGENTS, listed.filter(waiting).length));

  const agents = [];
  for (const s of recent) {
    const repo = await repoFor(s.cwd);
    const touched = (Array.isArray(s.touched) ? s.touched : [])
      .map((t) => ({ path: relPath(t.path, s.cwd, repo && repo.root), at: t.at || 0 }))
      .filter((t) => t.path);
    const tool = s.lastTool || null;
    agents.push({
      key: `${s.source}:${s.id}`,
      source: s.source,
      sourceLabel: labelFor(s.source),
      id: s.id,
      title: text(String(s.nickname || s.title || s.id).slice(0, 120)),
      state: s.state,
      stateDetail: text(String(s.stateDetail || '')),
      attention: attention.forPage(s.attention, text),
      lastEventAt: s.lastEventAt || 0,
      model: s.model ? text(`${s.provider ? s.provider + '/' : ''}${s.model}`) : null,
      contextWindow: Number.isFinite(s.contextWindow) ? s.contextWindow : null,
      owned: !!s.owned,
      ...(s.source === 'antigravity' ? { promptsVisible: s.promptsVisible === true } : {}),
      workspace: s.cwd ? text(path.basename(s.cwd)) : null,
      repo: repo ? {
        key: repo.key,
        name: text(repo.name),
        branch: repo.branch ? text(repo.branch) : null,
        worktree: repo.worktree,
        removed: !!repo.removed,
      } : null,
      activity: tool ? {
        kind: toolKind(tool.name),
        name: text(tool.name),
        // A bare path (edit, read, search target) is shown relative to the repo.
        label: text(['edit', 'read'].includes(toolKind(tool.name))
          || (path.isAbsolute(String(tool.label || '')) && !/\s/.test(tool.label))
          ? (relPath(tool.label, s.cwd, repo && repo.root) || tool.label)
          : tool.label),
        at: tool.at || 0,
      } : null,
      touched: touched.slice(0, 12).map((t) => ({ path: text(t.path), at: t.at })),
      _touched: touched,
    });
  }

  // Group by repository; sessions outside git form their own group per folder.
  const groups = new Map();
  for (const agent of agents) {
    const key = agent.repo ? agent.repo.key : `folder:${agent.workspace || agent.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key: agent.repo ? `repo:${groups.size}` : `folder:${groups.size}`,
        name: agent.repo ? agent.repo.name : (agent.workspace || 'no workspace'),
        git: !!agent.repo,
        agents: [],
        overlaps: [],
      });
    }
    groups.get(key).agents.push(agent);
  }
  for (const group of groups.values()) {
    // A file is an overlap when two or more recent agents in the repo wrote it.
    const byPath = new Map();
    for (const agent of group.agents) {
      for (const t of agent._touched) {
        if (now - (t.at || 0) > RECENT_MS) continue;
        if (!byPath.has(t.path)) byPath.set(t.path, new Map());
        byPath.get(t.path).set(`${agent.source}:${agent.id}`, t.at);
      }
    }
    for (const [file, who] of byPath) {
      if (who.size < 2) continue;
      group.overlaps.push({
        path: text(file),
        agents: [...who.keys()],
        lastAt: Math.max(...who.values()),
      });
    }
    group.overlaps.sort((a, b) => b.lastAt - a.lastAt);
    group.live = group.agents.filter((a) => a.state === 'live').length;
    group.needsYou = group.agents.filter((a) => attention.isNeedsYou(a.attention)).length;
    // Each agent keeps its own colour; agents sharing a repo never share one.
    const used = new Set();
    for (const agent of [...group.agents].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      let slot = colorSlot(agent.key);
      for (let n = 0; n < COLORS && used.has(slot); n++) slot = (slot + 1) % COLORS;
      used.add(slot);
      agent.color = slot;
    }
  }
  for (const agent of agents) {
    delete agent._touched;
    // The repo key is a local path; the page only needs the group.
    if (agent.repo) delete agent.repo.key;
  }
  const list = [...groups.values()].sort((a, b) => b.needsYou - a.needsYou || b.agents.length - a.agents.length || b.live - a.live);
  return {
    now,
    live: agents.filter((a) => a.state === 'live').length,
    needsYou: agents.filter((a) => attention.isNeedsYou(a.attention)).length,
    total: agents.length,
    groups: list,
  };
}

module.exports = { buildAgents, repoFor, toolKind, relPath, colorSlot };
