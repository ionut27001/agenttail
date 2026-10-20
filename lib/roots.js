'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { isInside, relativeInside } = require('./util');

const MAX_TREE_NODES = 2500;
const MAX_TREE_DEPTH = 12;
const SKIP_DIRS = new Set(['.git', '.dsh', 'node_modules', '.cache', '__pycache__', '.venv', 'venv', '.turbo', '.next']);

function isIgnoredName(name, patterns) {
  const lower = String(name).toLowerCase();
  return patterns.some((p) => {
    const pattern = String(p).toLowerCase();
    if (pattern.endsWith('*')) return lower.startsWith(pattern.slice(0, -1));
    return lower === pattern;
  });
}

// Scene-style release archives, e.g. GROUP-Title_Name_2024_1080p.mkv
const SCENE_RE = /\b[A-Za-z0-9]{2,12}-[A-Za-z0-9][A-Za-z0-9._-]{4,}\.(?:rar|zip|7z|iso|mkv|mp4|avi|flac|m4a|epub|pdf)\b/i;

const SENSITIVE = [
  /^\.env(?:\..*)?$/i,
  /credentials/i,
  /^hosts\.ya?ml$/i,
  /^\.git-credentials$/i,
  /^id_[^/\\]+$/i,
  /\.pem$/i,
  /\.key$/i,
  /^\.netrc$/i,
  /\.kdbx$/i,
];

function isSensitiveName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return SENSITIVE.some((re) => re.test(base));
}

class Roots {
  constructor(configPath) {
    this.configPath = configPath;
    this.cache = null;
    this.mtimeMs = 0;
    this.defaultPrivate = [];
  }

  async config() {
    try {
      const st = await fsp.stat(this.configPath);
      if (this.cache && st.mtimeMs === this.mtimeMs) return this.cache;
      const raw = JSON.parse(await fsp.readFile(this.configPath, 'utf8'));
      const roots = (raw.roots || [])
        .map((r) => (typeof r === 'string' ? { path: r } : r))
        .filter((r) => r && r.path)
        .map((r) => ({
          path: path.resolve(String(r.path)),
          as: r.as ? String(r.as).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '',
          label: r.label ? String(r.label) : '',
        }));
      const privateRoots = (raw.privateRoots || this.defaultPrivate).map((p) => path.resolve(String(p)));
      const ignore = Array.isArray(raw.ignore)
        ? raw.ignore.map(String).filter(Boolean)
        : [...SKIP_DIRS];
      this.cache = { roots, privateRoots, ignore };
      this.mtimeMs = st.mtimeMs;
      return this.cache;
    } catch {
      return this.cache || { roots: [], privateRoots: this.defaultPrivate.map((p) => path.resolve(p)), ignore: [...SKIP_DIRS] };
    }
  }

  async allowedRoots(sessionRoot) {
    const { roots } = await this.config();
    let sessionReal = sessionRoot;
    try {
      sessionReal = await fsp.realpath(sessionRoot);
    } catch {
      /* keep the lexical root */
    }
    const out = [{ real: sessionReal, lexical: path.resolve(sessionRoot), as: '', path: sessionRoot }];
    for (const r of roots) {
      let real = r.path;
      try {
        real = await fsp.realpath(r.path);
      } catch {
        /* root may not exist yet; keep lexical */
      }
      out.push({ ...r, real });
    }
    return out;
  }

  async isPrivatePath(p) {
    if (!p) return false;
    const abs = path.resolve(p);
    const { privateRoots } = await this.config();
    if (privateRoots.some((root) => isInside(abs, root))) return true;
    return SCENE_RE.test(String(p));
  }

  /**
   * Resolve a logged or requested path to a real path that is inside one of the
   * allowed roots. Rejects `..`, paths outside the roots and symlink escapes.
   */
  async resolve(sessionRoot, input) {
    const raw = String(input ?? '');
    if (!raw) throw Object.assign(new Error('missing path'), { status: 400 });
    if (raw.split(/[\\/]+/).includes('..')) {
      throw Object.assign(new Error('path traversal is not allowed'), { status: 403 });
    }
    if (/^\\\\/.test(raw)) throw Object.assign(new Error('UNC paths are not allowed'), { status: 403 });

    const isAbs = /^[A-Za-z]:[\\/]/.test(raw) || path.isAbsolute(raw);
    const candidate = isAbs ? raw : path.resolve(sessionRoot, raw);
    let real;
    try {
      real = await fsp.realpath(candidate);
    } catch {
      throw Object.assign(new Error('not found'), { status: 404 });
    }
    const allowed = await this.allowedRoots(sessionRoot);
    if (!allowed.some((r) => isInside(real, r.real))) {
      throw Object.assign(new Error('path is outside the allowed roots'), { status: 403 });
    }
    return { real, allowed };
  }

  /** Lexical workspace-relative display path for an absolute path. */
  async displayFor(sessionRoot, absOrRel) {
    if (!absOrRel) return null;
    const { roots } = await this.config();
    const abs = path.isAbsolute(absOrRel) ? path.resolve(absOrRel) : path.resolve(sessionRoot, absOrRel);
    const relSession = relativeInside(abs, sessionRoot);
    if (relSession !== '') return relSession;
    if (isInside(abs, sessionRoot)) return '';
    for (const r of roots) {
      const rel = relativeInside(abs, r.path);
      if (rel !== '') {
        if (!r.as) return null;
        return `${r.as}/${rel}`;
      }
      if (isInside(abs, r.path) && r.as) return r.as;
    }
    return null;
  }

  /** Lexical allowlist test (the path does not need to exist yet). */
  async lexicalAllowed(sessionRoot, abs) {
    const { roots } = await this.config();
    const target = path.resolve(String(abs || ''));
    if (sessionRoot && isInside(target, sessionRoot)) return true;
    return roots.some((r) => isInside(target, r.path));
  }

  async readTree(sessionRoot, keyFn, options = {}) {
    let rootReal;
    try {
      rootReal = await fsp.realpath(sessionRoot);
      if (!(await fsp.stat(rootReal)).isDirectory()) return null;
    } catch {
      return null;
    }
    const allowed = await this.allowedRoots(sessionRoot);
    const showHidden = options.showHidden === true;
    const ignore = showHidden ? [] : (await this.config()).ignore;
    const visited = new Set([rootReal.toLowerCase()]);
    const tree = { root: sessionRoot, name: path.basename(sessionRoot), children: [], truncated: false };
    const queue = [{ abs: rootReal, rel: '', depth: 0, node: tree }];
    let nodes = 0;
    let truncated = false;
    const seen = new Set();

    while (queue.length) {
      const item = queue.shift();
      if (item.depth >= MAX_TREE_DEPTH) {
        truncated = true;
        continue;
      }
      let entries;
      try {
        entries = await fsp.readdir(item.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad - bd || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      for (const entry of entries) {
        if (nodes >= MAX_TREE_NODES) {
          truncated = true;
          break;
        }
        const full = path.join(item.abs, entry.name);
        const rel = item.rel ? `${item.rel}/${entry.name}` : entry.name;
        if (!showHidden && isIgnoredName(entry.name, ignore)) continue;
        const isLink = entry.isSymbolicLink();
        let targetIsDir = entry.isDirectory();

        if (isLink) {
          let real;
          try {
            real = await fsp.realpath(full);
            targetIsDir = (await fsp.stat(real)).isDirectory();
          } catch {
            continue;
          }
          if (!allowed.some((r) => isInside(real, r.real))) {
            // Listed, but never followed or read.
            nodes++;
            item.node.children.push({
              type: targetIsDir ? 'dir' : 'file',
              name: entry.name,
              path: rel,
              link: true,
              key: keyFn ? keyFn(rel) : undefined,
              children: targetIsDir ? [] : undefined,
            });
            continue;
          }
          if (targetIsDir && visited.has(real.toLowerCase())) {
            nodes++;
            item.node.children.push({ type: 'dir', name: entry.name, path: rel, link: true, key: keyFn ? keyFn(rel) : undefined, children: [] });
            continue;
          }
          visited.add(real.toLowerCase());
        }

        if (targetIsDir) {
          if (!isLink && !showHidden && SKIP_DIRS.has(entry.name)) continue;
          nodes++;
          seen.add(rel);
          const node = { type: 'dir', name: entry.name, path: rel, children: [] };
          if (keyFn) node.key = keyFn(rel);
          if (await this.isPrivatePath(full)) {
            node.name = '[private]';
            node.path = '[private]';
          }
          item.node.children.push(node);
          queue.push({ abs: isLink ? await fsp.realpath(full) : full, rel, depth: item.depth + 1, node });
        } else if (entry.isFile() || isLink) {
          let size = 0;
          let mtimeMs = 0;
          try {
            const st = await fsp.stat(full);
            size = st.size;
            mtimeMs = st.mtimeMs;
          } catch {
            /* ignore */
          }
          nodes++;
          seen.add(rel);
          const node = {
            type: 'file',
            name: entry.name,
            path: rel,
            size,
            mtimeMs,
            sensitive: isSensitiveName(entry.name),
          };
          if (keyFn) node.key = keyFn(rel);
          if (await this.isPrivatePath(full)) {
            node.name = '[private]';
            node.path = '[private]';
            node.private = true;
          }
          item.node.children.push(node);
        }
      }
    }

    // Files the agent touched are always represented, even when the breadth-
    // first walk ran out of node budget before reaching them.
    if (Array.isArray(options.ensure) && options.ensure.length) {
      const wanted = [...new Set(options.ensure)].filter((p) => p && !p.startsWith('[') && !seen.has(p)).slice(-300);
      for (const rel of wanted) {
        const segments = String(rel).split('/').filter(Boolean);
        if (!segments.length) continue;
        let node = tree;
        let prefix = '';
        let alive = true;
        for (let i = 0; i < segments.length; i++) {
          prefix = prefix ? `${prefix}/${segments[i]}` : segments[i];
          const abs = path.resolve(sessionRoot, prefix);
          let real;
          let st;
          try {
            real = await fsp.realpath(abs);
            st = await fsp.stat(real);
          } catch {
            alive = false;
            break;
          }
          if (!allowed.some((r) => isInside(real, r.real))) {
            alive = false;
            break;
          }
          let child = (node.children || []).find((c) => c.path === prefix);
          if (!child) {
            if (st.isDirectory()) {
              child = { type: 'dir', name: segments[i], path: prefix, children: [] };
            } else {
              child = {
                type: 'file',
                name: segments[i],
                path: prefix,
                size: st.size,
                mtimeMs: st.mtimeMs,
                sensitive: isSensitiveName(segments[i]),
              };
            }
            if (keyFn) child.key = keyFn(prefix);
            if (await this.isPrivatePath(abs)) {
              child.name = '[private]';
              child.path = '[private]';
              child.private = true;
            }
            node.children = node.children || [];
            node.children.push(child);
          }
          node = child;
          if (!node.children) break;
        }
        if (!alive) continue;
      }
    }

    tree.truncated = truncated;
    return tree;
  }

  async readFile(sessionRoot, input, { hideSensitive = true } = {}) {
    const { real } = await this.resolve(sessionRoot, input);
    const st = await fsp.stat(real);
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { status: 400 });
    const name = path.basename(real);
    if (hideSensitive && (isSensitiveName(name) || (await this.isPrivatePath(real)))) {
      const priv = await this.isPrivatePath(real);
      return {
        path: input,
        size: st.size,
        mtimeMs: st.mtimeMs,
        binary: false,
        truncated: false,
        hidden: true,
        reason: priv ? 'private' : 'sensitive',
        content: priv ? '[private]' : '[contents hidden]',
      };
    }
    const limit = Math.min(st.size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(limit);
    let fh;
    try {
      fh = await fsp.open(real, 'r');
      let got = 0;
      while (got < limit) {
        const { bytesRead } = await fh.read(buf, got, limit - got, got);
        if (!bytesRead) break;
        got += bytesRead;
      }
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    const binary = buf.subarray(0, Math.min(8192, limit)).includes(0);
    return {
      path: input,
      size: st.size,
      mtimeMs: st.mtimeMs,
      binary,
      truncated: st.size > limit,
      content: binary ? '' : buf.toString('utf8'),
    };
  }
}

module.exports = { Roots, isSensitiveName, isPrivateName: (p) => SCENE_RE.test(String(p)) };
