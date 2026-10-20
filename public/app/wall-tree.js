// Watch wall strip widget: a shared team tree of the files the agents touched.
// Loaded by index.html as a classic script, in order with the others.
/* ---------- watch wall strip widget: shared team tree ---------- */
(() => {
  'use strict';

  const HISTORY_QUIET_MS = 250;   // history collection settles before one render
  const RENDER_MIN_MS = 150;      // coalesce live events into at most one render
  const PULSE_MS = 620;           // cursor move flourish
  const OUTSIDE_KEY = 'outside';
  const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'notebook_edit']);
  const motionQuery = (() => {
    try { return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null; } catch { return null; }
  })();

  let activeWidget = null;

  function reduced() {
    return !!(motionQuery && motionQuery.matches);
  }

  function oneLine(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function normalizePath(value) {
    const raw = String(value == null ? '' : value).replace(/\\/g, '/').trim();
    if (!raw) return '';
    const drive = /^([A-Za-z]):(?:\/|$)/.exec(raw);
    const unc = raw.startsWith('//');
    const absolute = !!drive || unc || raw.startsWith('/');
    let prefix = '';
    let rest = raw;
    if (drive) {
      prefix = drive[1] + ':/';
      rest = raw.slice(drive[0].length);
    } else if (unc) {
      prefix = '//';
      rest = raw.replace(/^\/+/, '');
    } else if (raw.startsWith('/')) {
      prefix = '/';
      rest = raw.replace(/^\/+/, '');
    }
    const parts = [];
    for (const segment of rest.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') {
        if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
        else if (!absolute) parts.push('..');
      } else {
        parts.push(segment);
      }
    }
    return prefix + parts.join('/');
  }

  function isAbsolutePath(path) {
    return /^(?:[A-Za-z]:\/|\/)/.test(path);
  }

  function baseName(path) {
    const clean = String(path || '').replace(/\/+$/, '');
    const at = clean.lastIndexOf('/');
    return at >= 0 ? clean.slice(at + 1) : clean;
  }

  function workspaceName(agent) {
    const workspace = oneLine(agent && agent.workspace);
    if (!workspace) return oneLine(agent && agent.sourceLabel) || 'workspace';
    const clean = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
    const at = clean.lastIndexOf('/');
    return at >= 0 ? (clean.slice(at + 1) || workspace) : workspace;
  }

  /**
   * A path relative to the agent's workspace, or null when it points outside.
   * Relative paths are taken as workspace-relative. Absolute paths are outside
   * the workspace, except when the workspace itself is an absolute path and
   * the file sits under it (then the relative part is returned).
   */
  function relativeInside(pane, normalized) {
    if (!normalized) return null;
    if (!isAbsolutePath(normalized)) {
      if (normalized === '..' || normalized.startsWith('../')) return null;
      return normalized;
    }
    const workspace = oneLine(pane && pane.agent && pane.agent.workspace);
    if (!workspace) return null;
    const wsPath = normalizePath(workspace);
    if (!wsPath || !isAbsolutePath(wsPath)) return null;
    const base = wsPath.replace(/\/+$/, '');
    const prefix = base.toLowerCase() + '/';
    if (!normalized.toLowerCase().startsWith(prefix)) return null;
    return normalized.slice(base.length).replace(/^\/+/, '') || null;
  }

  function eventTime(ev) {
    const t = Number(ev && ev.time);
    return Number.isFinite(t) && t > 0 ? t : Date.now();
  }

  function ago(time) {
    if (!time) return '—';
    const delta = Math.max(0, Date.now() - time);
    if (delta < 1000) return 'now';
    if (delta < 60_000) return Math.floor(delta / 1000) + 's ago';
    if (delta < 3_600_000) return Math.floor(delta / 60_000) + 'm ago';
    if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + 'h ago';
    return Math.floor(delta / 86_400_000) + 'd ago';
  }

  function isWriteTool(name) {
    const tool = String(name || '');
    if (WRITE_TOOLS.has(tool)) return true;
    try {
      return typeof EDIT_TOOLS !== 'undefined' && EDIT_TOOLS.has(tool);
    } catch {
      return false;
    }
  }

  function create({ slots, panes }) {
    const slot = slots && slots.tree;
    if (!slot) return null;
    const doc = slot.ownerDocument || document;
    const initialPanes = Array.isArray(panes) ? panes.slice() : [];

    function node(tag, cls, text) {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined && text !== null) n.textContent = String(text);
      return n;
    }

    const root = node('div', 'wt-root');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Files the agents touched');

    const head = node('div', 'wt-head');
    const title = node('span', 'wt-title', 'FILES');
    const countEl = node('span', 'wt-count', '0');
    countEl.title = 'Files touched';
    const headSpacer = node('span', 'wt-head-spacer');
    head.append(title, doc.createTextNode(' '), countEl, headSpacer);
    const clashLine = node('div', 'wt-clash-line hidden');
    clashLine.setAttribute('role', 'status');
    const sectionsEl = node('div', 'wt-sections');
    const tip = node('div', 'wt-tip');
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-hidden', 'true');
    root.append(head, clashLine, sectionsEl, tip);

    const groups = new Map();
    const cursors = new Map();
    const rowByFile = new Map();
    const paneByKey = new Map();
    const dirtyFiles = new Set();
    const collapsedByGroup = new Map();
    let pendingReveal = null;
    let tipFile = null;
    let renderedOnce = false;
    let disposed = false;
    let flushTimer = 0;
    let flushDeadline = 0;
    let flushKind = '';
    let lastFlushAt = -Infinity;
    let userScrollAt = -Infinity;
    let selfScrollUntil = 0;

    function paneKey(pane) {
      const agent = pane && pane.agent;
      return oneLine(agent && agent.key);
    }

    function paneColor(pane) {
      let raw = '';
      try {
        if (pane && pane.root && pane.root.style) raw = pane.root.style.getPropertyValue('--c');
      } catch { /* ignore */ }
      if (!raw && pane && pane.root) {
        try { raw = getComputedStyle(pane.root).getPropertyValue('--c'); } catch { /* ignore */ }
      }
      if (!raw) {
        const n = pane && pane.agent && Number.isInteger(pane.agent.color) ? pane.agent.color : 0;
        raw = `var(--agent-${((n % 8) + 8) % 8})`;
      }
      return oneLine(raw);
    }

    function groupKeyFor(pane, outside) {
      if (outside) return OUTSIDE_KEY;
      const agent = (pane && pane.agent) || {};
      const repo = agent.repo;
      if (repo && (repo.name || repo.key)) return `repo:${oneLine(repo.name || repo.key).toLowerCase()}`;
      return `ws:${workspaceName(agent).toLowerCase()}`;
    }

    function groupLabelFor(pane, outside) {
      if (outside) return 'outside the workspace';
      const agent = (pane && pane.agent) || {};
      const repo = agent.repo;
      if (repo && (repo.name || repo.key)) return oneLine(repo.name || repo.key) || workspaceName(agent);
      return workspaceName(agent);
    }

    function ensureGroup(pane, outside) {
      const key = groupKeyFor(pane, outside);
      let group = groups.get(key);
      if (group) return group;
      const label = groupLabelFor(pane, outside);
      const el = node('section', 'wt-section' + (outside ? ' wt-outside' : ''));
      el.dataset.group = key;
      const labelEl = node('div', 'wt-repo');
      const labelText = node('span', 'wt-repo-name', label);
      labelText.title = label;
      labelEl.appendChild(labelText);
      const bodyEl = node('div', 'wt-children');
      el.append(labelEl, bodyEl);
      group = {
        key,
        label,
        kind: outside ? 'outside' : 'tree',
        el,
        bodyEl,
        files: new Map(),
        structureDirty: true,
      };
      groups.set(key, group);
      collapsedByGroup.set(group, new Set());
      return group;
    }

    function ensureRootAttached() {
      let total = 0;
      for (const group of groups.values()) total += group.files.size;
      if (total > 0 && root.parentNode !== slot) slot.appendChild(root);
      else if (total === 0 && root.parentNode === slot) {
        hideTip();
        root.remove();
      }
      return total;
    }

    function attachGroup(group) {
      if (group.el.parentNode) return;
      const outside = groups.get(OUTSIDE_KEY);
      if (!outside || outside === group || !outside.el.parentNode) sectionsEl.appendChild(group.el);
      else sectionsEl.insertBefore(group.el, outside.el);
    }

    function registerFile(pane, key, rawPath, kind, at, fileKey) {
      const normalized = normalizePath(rawPath);
      if (!normalized) return null;
      const relative = relativeInside(pane, normalized);
      const outside = relative === null;
      const path = outside ? normalized : relative;
      const group = ensureGroup(pane, outside);
      let file = group.files.get(path);
      if (!file) {
        file = {
          path,
          group,
          outside,
          displayName: baseName(path),
          agents: new Map(),
          edits: 0,
          reads: 0,
          lastAt: 0,
          lastAgentKey: '',
          lastPane: null,
          lastKind: '',
        };
        group.files.set(path, file);
        group.structureDirty = true;
        dirtyFiles.add(file);
      }
      file.lastAt = at;
      file.lastKind = kind;
      file.lastPane = pane;
      file.lastAgentKey = key;
      if (kind === 'edit') file.edits += 1;
      else file.reads += 1;
      let agent = file.agents.get(key);
      if (!agent) {
        const agentData = (pane && pane.agent) || {};
        agent = {
          key,
          label: oneLine(agentData.sourceLabel || agentData.title || key),
          color: paneColor(pane) || 'var(--agent-0)',
          edits: 0,
          reads: 0,
          last: 0,
          lastKind: '',
          fileKey: null,
        };
        file.agents.set(key, agent);
      }
      if (fileKey !== undefined && fileKey !== null && fileKey !== '') agent.fileKey = fileKey;
      if (kind === 'edit') agent.edits += 1;
      else agent.reads += 1;
      agent.last = at;
      agent.lastKind = kind;
      agent.label = oneLine(((pane && pane.agent) || {}).sourceLabel || agent.label || key);
      agent.color = paneColor(pane) || agent.color;

      let cursor = cursors.get(key);
      if (!cursor) {
        cursor = { key, pane, label: agent.label, color: agent.color, file: null, path: '', at: 0, kind: '', pulseUntil: 0 };
        cursors.set(key, cursor);
      }
      const previous = cursor.file;
      cursor.pane = pane;
      cursor.label = agent.label;
      cursor.color = agent.color;
      cursor.file = file;
      cursor.path = file.path;
      cursor.at = at;
      cursor.kind = kind;
      if (!pane.history) {
        cursor.pulseUntil = performance.now() + PULSE_MS;
        pendingReveal = file;
      }
      if (previous && previous !== file) dirtyFiles.add(previous);
      dirtyFiles.add(file);
      return file;
    }

    function cursorsByFileNow() {
      const out = new Map();
      for (const cursor of cursors.values()) {
        if (!cursor.file) continue;
        let list = out.get(cursor.file);
        if (!list) {
          list = [];
          out.set(cursor.file, list);
        }
        list.push(cursor);
      }
      for (const list of out.values()) list.sort((a, b) => (a.at || 0) - (b.at || 0));
      return out;
    }

    function childList(children) {
      return [...children.values()].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
          || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      });
    }

    function buildTree(files) {
      const tree = { type: 'root', children: new Map() };
      for (const file of files) {
        const segments = file.path.split('/').filter(Boolean);
        if (!segments.length) continue;
        let current = tree;
        for (let i = 0; i < segments.length; i += 1) {
          const name = segments[i];
          const isFile = i === segments.length - 1;
          if (isFile) {
            current.children.set(`f:${name}`, { type: 'file', name, file });
            continue;
          }
          const mapKey = `d:${name}`;
          let folder = current.children.get(mapKey);
          if (!folder) {
            folder = {
              type: 'folder',
              name,
              path: segments.slice(0, i + 1).join('/'),
              children: new Map(),
            };
            current.children.set(mapKey, folder);
          }
          current = folder;
        }
      }
      return tree;
    }

    function folderChain(folder) {
      let label = folder.name;
      let current = folder;
      while (current.children.size === 1) {
        const only = current.children.values().next().value;
        if (!only || only.type !== 'folder') break;
        label += '/' + only.name;
        current = only;
      }
      return { label, node: current, id: folder.path };
    }

    function fileRow(file, depth, cursorsNow) {
      const row = node('div', 'wt-row tree-row wt-file file');
      row.dataset.path = file.path;
      row.dataset.clash = '0';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.style.paddingLeft = `${4 + depth * 11}px`;
      const cursorEl = node('span', 'wt-cursors');
      cursorEl.setAttribute('aria-hidden', 'true');
      const name = node('span', 'wt-name nm', file.displayName);
      const count = node('span', 'wt-count cnt');
      const dots = node('span', 'wt-dots');
      const bolt = node('span', 'wt-bolt');
      bolt.setAttribute('aria-hidden', 'true');
      row.append(cursorEl, name, count, dots, bolt);
      const info = { el: row, countEl: count, dotsEl: dots, cursorsEl: cursorEl, boltEl: bolt, clash: false };
      rowByFile.set(file, info);

      row.addEventListener('click', () => openFile(file));
      row.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
        ev.preventDefault();
        openFile(file);
      });
      const onHover = (ev) => showTip(file, ev);
      row.addEventListener('mouseenter', onHover);
      row.addEventListener('mouseover', onHover);
      row.addEventListener('mousemove', (ev) => {
        if (tipFile !== file) showTip(file, ev);
        else placeTip(ev);
      });
      row.addEventListener('mouseleave', hideTip);
      row.addEventListener('mouseout', (ev) => {
        const to = ev.relatedTarget;
        if (!to || to.nodeType !== 1 || !row.contains(to)) hideTip();
      });

      paintFile(file, info, cursorsNow);
      return row;
    }

    function folderRow(chain, depth, collapsedSet, kids) {
      const row = node('div', 'wt-row tree-row wt-dir dir');
      row.dataset.folder = chain.id;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.style.paddingLeft = `${4 + depth * 11}px`;
      const collapsed = collapsedSet.has(chain.id);
      const caret = node('span', 'wt-caret tw', collapsed ? '▸' : '▾');
      caret.setAttribute('aria-hidden', 'true');
      const name = node('span', 'wt-name nm', chain.label);
      name.title = chain.id;
      row.append(caret, name);
      row.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      row.title = collapsed ? `Expand ${chain.label}` : `Collapse ${chain.label}`;
      const toggle = (ev) => {
        if (ev) {
          ev.preventDefault();
          ev.stopPropagation();
        }
        const nowCollapsed = !collapsedSet.has(chain.id);
        if (nowCollapsed) collapsedSet.add(chain.id);
        else collapsedSet.delete(chain.id);
        kids.classList.toggle('hidden', nowCollapsed);
        caret.textContent = nowCollapsed ? '▸' : '▾';
        row.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        row.title = nowCollapsed ? `Expand ${chain.label}` : `Collapse ${chain.label}`;
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
        toggle(ev);
      });
      return row;
    }

    function renderChildren(group, container, children, depth, cursorsNow, collapsedSet) {
      for (const child of childList(children)) {
        if (child.type === 'folder') {
          const chain = folderChain(child);
          const collapsed = collapsedSet.has(chain.id);
          const kids = node('div', 'wt-kids tree-kids' + (collapsed ? ' hidden' : ''));
          container.appendChild(folderRow(chain, depth, collapsedSet, kids));
          container.appendChild(kids);
          renderChildren(group, kids, chain.node.children, depth + 1, cursorsNow, collapsedSet);
        } else {
          container.appendChild(fileRow(child.file, depth, cursorsNow));
        }
      }
    }

    function renderGroup(group, cursorsNow) {
      attachGroup(group);
      if (tipFile && tipFile.group === group) hideTip();
      for (const file of group.files.values()) rowByFile.delete(file);
      group.bodyEl.textContent = '';
      const collapsedSet = collapsedByGroup.get(group) || new Set();
      collapsedByGroup.set(group, collapsedSet);
      if (group.kind === 'outside') {
        const files = [...group.files.values()].sort((a, b) => {
          return a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: 'base' })
            || a.path.localeCompare(b.path);
        });
        for (const file of files) group.bodyEl.appendChild(fileRow(file, 0, cursorsNow));
      } else {
        const tree = buildTree(group.files.values());
        renderChildren(group, group.bodyEl, tree.children, 0, cursorsNow, collapsedSet);
      }
      group.structureDirty = false;
      for (const file of group.files.values()) dirtyFiles.delete(file);
    }

    function paintFile(file, info, cursorsNow) {
      const heat = file.edits > 0 ? Math.min(36, 5 + Math.round(Math.sqrt(file.edits) * 7)) : 0;
      info.el.style.setProperty('--heat', `${heat}%`);
      info.countEl.textContent = file.edits ? String(file.edits) : '';
      info.countEl.title = `${file.edits} edit${file.edits === 1 ? '' : 's'}`;

      info.dotsEl.textContent = '';
      const agents = [...file.agents.values()].sort((a, b) => (a.last || 0) - (b.last || 0));
      for (const agent of agents) {
        const dot = node('i', 'wt-dot' + (agent.edits > 0 ? '' : ' read'));
        dot.style.setProperty('--c', agent.color);
        dot.dataset.agent = agent.key;
        dot.dataset.kind = agent.edits > 0 ? 'edit' : 'read';
        dot.title = `${agent.label} — edited ${agent.edits}× · read ${agent.reads}× · last ${ago(agent.last)}`;
        info.dotsEl.appendChild(dot);
      }

      info.cursorsEl.textContent = '';
      const here = cursorsNow.get(file) || [];
      for (const cursor of here) {
        const marker = node('span', 'wt-cursor', '▸');
        marker.style.setProperty('--c', cursor.color);
        marker.dataset.agent = cursor.key;
        marker.title = `${cursor.label} — ${cursor.kind === 'edit' ? 'editing' : 'reading'} ${file.displayName}`;
        if (!reduced() && cursor.pulseUntil && performance.now() < cursor.pulseUntil) {
          marker.classList.add('wt-cursor-moved');
          setTimeout(() => marker.classList.remove('wt-cursor-moved'), PULSE_MS + 60);
        }
        info.cursorsEl.appendChild(marker);
      }
      info.el.setAttribute('aria-label', `${file.path}, ${file.edits} edits, ${file.reads} reads`);
    }

    function syncClash(cursorsNow) {
      for (const [file, info] of rowByFile) {
        const clash = (cursorsNow.get(file) || []).length >= 2;
        if (info.clash === clash) continue;
        info.clash = clash;
        info.el.classList.toggle('clash', clash);
        info.el.dataset.clash = clash ? '1' : '0';
        info.boltEl.textContent = clash ? '⚡' : '';
      }
    }

    function updateHeader(cursorsNow) {
      let total = 0;
      for (const group of groups.values()) total += group.files.size;
      const totalText = String(total);
      if (countEl.textContent !== totalText) countEl.textContent = totalText;
      countEl.title = `${total} file${total === 1 ? '' : 's'} touched`;
      const clashes = [];
      for (const [file, list] of cursorsNow) {
        if (list.length < 2) continue;
        let at = 0;
        for (const cursor of list) at = Math.max(at, cursor.at || 0);
        clashes.push({ file, at });
      }
      if (!clashes.length) {
        if (clashLine.textContent) clashLine.textContent = '';
        clashLine.classList.add('hidden');
        return;
      }
      clashes.sort((a, b) => (b.at || 0) - (a.at || 0));
      const first = clashes[0].file;
      const text = `⚡ ${first.displayName} — both agents here`;
      if (clashLine.textContent !== text) clashLine.textContent = text;
      clashLine.classList.remove('hidden');
    }

    function openFile(file) {
      if (!file) return;
      const agentKey = file.lastAgentKey;
      const lastAgent = agentKey ? file.agents.get(agentKey) : null;
      const fileKey = lastAgent ? lastAgent.fileKey : null;
      let pane = file.lastPane;
      if (!pane && agentKey) pane = paneByKey.get(agentKey);
      if (!pane || typeof pane.showFile !== 'function') {
        pane = null;
        for (const cursor of cursors.values()) {
          if (cursor.file !== file || !cursor.pane || typeof cursor.pane.showFile !== 'function') continue;
          pane = cursor.pane;
          break;
        }
      }
      if (!pane || typeof pane.showFile !== 'function') return;
      try { pane.showFile(file.path, fileKey == null ? null : fileKey); } catch { /* ignore */ }
    }

    function buildTip(file) {
      tip.textContent = '';
      const pathLine = node('div', 'wt-tip-path', file.path);
      pathLine.title = file.path;
      tip.appendChild(pathLine);
      const agents = [...file.agents.values()].sort((a, b) => (a.last || 0) - (b.last || 0));
      for (const agent of agents) {
        const row = node('div', 'wt-tip-agent');
        row.dataset.agent = agent.key;
        row.style.setProperty('--c', agent.color);
        const dot = node('i', agent.edits > 0 ? '' : 'read');
        const who = node('span', 'wt-tip-who', agent.label);
        const detail = node('span', 'wt-tip-detail', `edited ${agent.edits}× · read ${agent.reads}× · last ${ago(agent.last)}`);
        row.append(dot, who, detail);
        tip.appendChild(row);
      }
      tipFile = file;
      tip.dataset.path = file.path;
      tip.classList.add('show');
      tip.setAttribute('aria-hidden', 'false');
    }

    function placeTip(ev) {
      if (!tip.classList.contains('show')) return;
      const pad = 10;
      const width = tip.offsetWidth;
      const height = tip.offsetHeight;
      let left = ev.clientX + 12;
      let top = ev.clientY + 14;
      if (left + width > window.innerWidth - pad) left = ev.clientX - width - 12;
      if (top + height > window.innerHeight - pad) top = ev.clientY - height - 12;
      tip.style.left = `${Math.max(pad, Math.round(left))}px`;
      tip.style.top = `${Math.max(pad, Math.round(top))}px`;
    }

    function showTip(file, ev) {
      if (disposed) return;
      if (tipFile !== file) buildTip(file);
      placeTip(ev);
    }

    function hideTip() {
      tipFile = null;
      tip.classList.remove('show');
      tip.setAttribute('aria-hidden', 'true');
    }

    function reveal(row) {
      if (!row || !row.isConnected) return;
      const now = performance.now();
      if (now - userScrollAt < 1000) return;
      const slotRect = slot.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      if (!slotRect.height || !rowRect.height) return;
      const margin = 8;
      const clashHeight = clashLine.classList.contains('hidden') ? 0 : (clashLine.offsetHeight || 0);
      const topInset = margin + (head.offsetHeight || 0) + clashHeight;
      let delta = 0;
      if (rowRect.top < slotRect.top + topInset) delta = rowRect.top - (slotRect.top + topInset);
      else if (rowRect.bottom > slotRect.bottom - margin) delta = rowRect.bottom - (slotRect.bottom - margin);
      if (!delta) return;
      const max = Math.max(0, slot.scrollHeight - slot.clientHeight);
      const target = Math.max(0, Math.min(max, slot.scrollTop + delta));
      selfScrollUntil = performance.now() + 520;
      try { slot.scrollTop = target; } catch { /* ignore */ }
    }

    function flush() {
      if (disposed) return;
      lastFlushAt = performance.now();
      const cursorsNow = cursorsByFileNow();
      ensureRootAttached();

      for (const group of groups.values()) {
        if (group.structureDirty) renderGroup(group, cursorsNow);
      }
      for (const file of [...dirtyFiles]) {
        dirtyFiles.delete(file);
        if (file.group && file.group.structureDirty) continue;
        const info = rowByFile.get(file);
        if (info) paintFile(file, info, cursorsNow);
      }
      syncClash(cursorsNow);
      updateHeader(cursorsNow);

      if (!renderedOnce && !pendingReveal) {
        let latest = null;
        for (const cursor of cursors.values()) {
          if (cursor.file && (!latest || (cursor.at || 0) > (latest.at || 0))) latest = cursor;
        }
        if (latest) pendingReveal = latest.file;
      }
      renderedOnce = true;
      if (pendingReveal) {
        const info = rowByFile.get(pendingReveal);
        pendingReveal = null;
        if (info) reveal(info.el);
      }
    }

    function armFlush(wait, kind) {
      if (disposed) return;
      const target = performance.now() + Math.max(0, wait);
      if (flushTimer) {
        if (kind === 'history' && flushKind === 'history') {
          clearTimeout(flushTimer);
        } else if (flushDeadline <= target) {
          return;
        } else {
          clearTimeout(flushTimer);
        }
      }
      flushKind = kind;
      flushDeadline = target;
      flushTimer = setTimeout(() => {
        flushTimer = 0;
        flushDeadline = 0;
        flushKind = '';
        flush();
      }, Math.max(0, target - performance.now()));
    }

    function scheduleLiveFlush() {
      const since = performance.now() - lastFlushAt;
      armFlush(Math.max(0, RENDER_MIN_MS - since), 'live');
    }

    function scheduleHistoryFlush() {
      armFlush(HISTORY_QUIET_MS, 'history');
    }

    function onPaneEvent(pane, ev) {
      if (disposed || !pane || !ev || ev.t !== 'call') return;
      const args = ev.args || {};
      const rawPath = args.file_path;
      if (typeof rawPath !== 'string' || !rawPath.trim()) return;
      const key = paneKey(pane);
      if (!key) return;
      const name = String(ev.name || '');
      let kind = '';
      if (isWriteTool(name)) kind = 'edit';
      else if (name === 'read') kind = 'read';
      else return;
      paneByKey.set(key, pane);
      registerFile(pane, key, rawPath, kind, eventTime(ev), args.key);
      if (pane.history) scheduleHistoryFlush();
      else scheduleLiveFlush();
    }

    function snapshot() {
      const cursorsNow = cursorsByFileNow();
      const files = [];
      for (const group of groups.values()) {
        for (const file of group.files.values()) {
          files.push({
            path: file.path,
            edits: file.edits,
            agents: [...file.agents.keys()],
            clash: (cursorsNow.get(file) || []).length >= 2,
          });
        }
      }
      const out = {};
      for (const [key, cursor] of cursors) {
        if (cursor.file) out[key] = cursor.path;
      }
      return { files, cursors: out };
    }

    const api = {
      onPaneEvent,
      dispose,
      snapshot,
      _files: () => snapshot().files,
    };

    function markUserScroll() {
      userScrollAt = performance.now();
    }

    function onSlotScroll() {
      if (performance.now() < selfScrollUntil) return;
      markUserScroll();
    }

    function onSlotKeydown(ev) {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(ev.key)) markUserScroll();
    }

    slot.addEventListener('wheel', markUserScroll, { passive: true });
    slot.addEventListener('touchstart', markUserScroll, { passive: true });
    slot.addEventListener('touchmove', markUserScroll, { passive: true });
    slot.addEventListener('scroll', onSlotScroll, { passive: true });
    slot.addEventListener('keydown', onSlotKeydown);

    for (const pane of initialPanes) {
      const key = paneKey(pane);
      if (key) paneByKey.set(key, pane);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = 0;
      }
      slot.removeEventListener('wheel', markUserScroll);
      slot.removeEventListener('touchstart', markUserScroll);
      slot.removeEventListener('touchmove', markUserScroll);
      slot.removeEventListener('scroll', onSlotScroll);
      slot.removeEventListener('keydown', onSlotKeydown);
      hideTip();
      groups.clear();
      cursors.clear();
      rowByFile.clear();
      paneByKey.clear();
      dirtyFiles.clear();
      pendingReveal = null;
      try { root.remove(); } catch { /* ignore */ }
      if (activeWidget === api) activeWidget = null;
    }

    activeWidget = api;
    return api;
  }

  window.__wallTree = () => (activeWidget ? activeWidget.snapshot() : { files: [], cursors: {} });

  window.__wallStripHooks = window.__wallStripHooks || [];
  window.__wallStripHooks.push({
    name: 'tree',
    create(wall) {
      try {
        const { slots, panes } = wall || {};
        return create({ slots, panes });
      } catch (err) {
        console.error('tree widget failed', err);
        return null;
      }
    },
  });
})();
