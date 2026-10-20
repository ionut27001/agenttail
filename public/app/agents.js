// Agents overview, watch wall, attention alerts.
// Loaded by index.html as a classic script, in order with the others.
/* ---------- multi-agent overview ---------- */
(() => {
  const agents = { data: null, open: false, busy: false };
  const $a = (id) => document.getElementById(id);
  const colorOf = (agent) => `var(--agent-${(agent && Number.isInteger(agent.color) ? agent.color : 0) % 8})`;
  const KIND = { command: '$', edit: '✎', read: '👁', search: '⌕', agent: '⇢', tool: '⚙' };

  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return `${Math.round(s / 3600)} h ago`;
  }

  /** 2m 05s */
  function clock(ms) {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  function hashFor(agent) {
    return agent.source === 'dsh' ? agent.id : `${agent.source}:${agent.id}`;
  }

  function findMe() {
    if (!agents.data || !state.sessionId) return { group: null, me: null };
    for (const group of agents.data.groups) {
      const me = group.agents.find((a) => a.id === state.sessionId && a.source === state.source);
      if (me) return { group, me };
    }
    return { group: null, me: null };
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function dot(agent) {
    const d = el('span', `ag-dot${agent.state === 'live' ? ' live' : ''}`);
    d.style.setProperty('--c', colorOf(agent));
    return d;
  }

  function agentName(agent) {
    return `${agent.sourceLabel}${agent.repo && agent.repo.branch ? ' · ' + agent.repo.branch : ''}`;
  }

  function activityText(agent) {
    if (!agent.activity) return agent.stateDetail || agent.state;
    const verb = { command: 'running', edit: 'editing', read: 'reading', search: 'searching', agent: 'delegating', tool: agent.activity.name }[agent.activity.kind] || agent.activity.name;
    return `${verb} ${agent.activity.label || ''}`.trim();
  }

  function renderChip() {
    const chip = $a('coAgents');
    if (!chip) return;
    const data = agents.data;
    chip.textContent = '';
    if (!data || !data.total) { chip.classList.add('hidden'); return; }
    const { group, me } = findMe();
    const others = group ? group.agents.filter((a) => a !== me && a.state !== 'finished') : [];
    const overlaps = group ? group.overlaps.filter((o) => me && o.agents.includes(me.key)) : [];
    for (const a of (others.length ? others : data.groups.flatMap((g) => g.agents).filter((a) => a.state === 'live')).slice(0, 5)) chip.appendChild(dot(a));
    let label;
    if (others.length) {
      label = `${others.length} OTHER AGENT${others.length === 1 ? '' : 'S'} ON THIS REPO`;
      const busy = others.find((a) => a.state === 'live' && a.activity);
      if (busy) label += ` · ${busy.sourceLabel} ${activityText(busy)}`.slice(0, 120);
    } else {
      label = `${data.live} LIVE AGENT${data.live === 1 ? '' : 'S'}`;
    }
    if (overlaps.length) label += ` · ⚠ ${overlaps.length} SHARED FILE${overlaps.length === 1 ? '' : 'S'}`;
    chip.appendChild(document.createTextNode(label));
    chip.classList.toggle('warn', overlaps.length > 0);
    chip.title = others.length
      ? others.map((a) => `${agentName(a)}: ${activityText(a)}`).join('\n')
      : 'Agents working right now (click for the overview)';
    chip.classList.remove('hidden');
  }

  function applyColor() {
    const { me } = findMe();
    const app = $a('app');
    if (!app) return;
    if (me) app.style.setProperty('--agent-color', colorOf(me));
    else app.style.removeProperty('--agent-color');
  }

  /** Mark tree files that other agents on the same repo edited, in their colours. */
  function markTree() {
    const tree = $a('tree');
    if (!tree) return;
    for (const old of tree.querySelectorAll('.agent-mark')) old.remove();
    const { group, me } = findMe();
    if (!group) return;
    const byPath = new Map();
    for (const agent of group.agents) {
      if (agent === me || agent.state === 'finished') continue;
      for (const t of agent.touched) {
        if (!byPath.has(t.path)) byPath.set(t.path, []);
        byPath.get(t.path).push(agent);
      }
    }
    if (!byPath.size) return;
    for (const row of tree.querySelectorAll('.tree-row')) {
      const who = byPath.get(row.dataset.path);
      if (!who) continue;
      const mark = el('span', 'agent-mark');
      for (const agent of who) mark.appendChild(dot(agent));
      mark.title = `also edited by ${who.map(agentName).join(', ')}`;
      row.appendChild(mark);
    }
  }

  function renderPanel() {
    const body = $a('agentsBody');
    if (!body || !agents.open) return;
    const data = agents.data;
    body.textContent = '';
    if (!data || !data.total) {
      body.appendChild(el('div', 'ag-empty', 'No agent has been active in the last 30 minutes.'));
      $a('agentsSummary').textContent = '';
      return;
    }
    $a('agentsSummary').textContent = `${data.live} live · ${data.total} recent · ${data.groups.length} workspace${data.groups.length === 1 ? '' : 's'}`;
    const byKey = new Map(data.groups.flatMap((g) => g.agents).map((a) => [a.key, a]));
    for (const group of data.groups) {
      const section = el('section', 'ag-group');
      const head = el('div', 'ag-group-head');
      head.appendChild(el('b', '', group.name));
      head.appendChild(el('span', 'dim', `${group.git ? 'git repo' : 'folder'} · ${group.agents.length} agent${group.agents.length === 1 ? '' : 's'} · ${group.live} live`));
      const watchable = group.agents.filter((a) => a.state === 'live');
      if (watchable.length) {
        const watch = el('button', 'ag-watch', '◫ WATCH SIDE BY SIDE');
        watch.type = 'button';
        watch.title = 'Follow these agents live, one pane each';
        watch.addEventListener('click', () => wall.open(watchable));
        head.appendChild(watch);
      }
      section.appendChild(head);
      if (group.overlaps.length) {
        const box = el('div', 'ag-overlaps');
        box.appendChild(el('div', '', `⚠ ${group.overlaps.length} file${group.overlaps.length === 1 ? '' : 's'} edited by more than one agent in the last 30 minutes`));
        for (const overlap of group.overlaps.slice(0, 8)) {
          const row = el('div', 'row');
          for (const key of overlap.agents) { const a = byKey.get(key); if (a) row.appendChild(dot(a)); }
          row.appendChild(el('span', 'p', overlap.path));
          row.title = overlap.agents.map((k) => (byKey.get(k) ? agentName(byKey.get(k)) : k)).join(' + ');
          box.appendChild(row);
        }
        section.appendChild(box);
      }
      const grid = el('div', 'ag-grid');
      const shared = new Set(group.overlaps.map((o) => o.path));
      for (const agent of group.agents) {
        const card = el('button', `ag-card ${agent.state}`);
        card.type = 'button';
        card.style.setProperty('--c', colorOf(agent));
        card.dataset.key = agent.key;
        const isMe = agent.id === state.sessionId && agent.source === state.source;
        if (isMe) card.classList.add('current');
        const top = el('div', 'ag-top');
        top.appendChild(dot(agent));
        top.appendChild(el('span', 'ag-src', agent.sourceLabel));
        top.appendChild(el('span', 'ag-meta', agent.state));
        if (isMe) top.appendChild(el('span', 'ag-here', 'VIEWING'));
        card.appendChild(top);
        card.appendChild(el('div', 'ag-title', agent.title));
        const meta = el('div', 'ag-meta');
        if (agent.repo && agent.repo.branch) meta.appendChild(el('span', 'br', `⎇ ${agent.repo.branch}${agent.repo.removed ? ' (worktree removed)' : agent.repo.worktree ? ' (worktree)' : ''}`));
        if (agent.model) meta.appendChild(el('span', '', agent.model));
        if (agent.owned) meta.appendChild(el('span', '', '◈ owned'));
        if (agent.approvals) meta.appendChild(el('span', 'ag-wait', `⚠ ${agent.approvals} approval${agent.approvals === 1 ? '' : 's'} waiting`));
        meta.appendChild(el('span', '', ago(agent.lastEventAt)));
        card.appendChild(meta);
        const act = el('div', 'ag-act');
        act.appendChild(el('span', 'k', agent.activity ? (KIND[agent.activity.kind] || '⚙') : '·'));
        act.appendChild(document.createTextNode(activityText(agent)));
        act.title = activityText(agent);
        card.appendChild(act);
        if (agent.touched.length) {
          const files = el('div', 'ag-files');
          for (const t of agent.touched.slice(0, 6)) {
            const chip = el('span', `ag-file${shared.has(t.path) ? ' overlap' : ''}`, t.path.split('/').pop());
            chip.title = `${t.path} · ${ago(t.at)}`;
            files.appendChild(chip);
          }
          card.appendChild(files);
        }
        card.addEventListener('click', () => {
          setOpen(false);
          location.hash = hashFor(agent);
        });
        grid.appendChild(card);
      }
      section.appendChild(grid);
      body.appendChild(section);
    }
  }

  async function refresh() {
    if (agents.busy) return;
    agents.busy = true;
    try {
      const res = await fetch('/api/agents');
      if (res.ok) agents.data = await res.json();
    } catch { /* keep the last snapshot */ }
    agents.busy = false;
    renderChip();
    applyColor();
    markTree();
    renderPanel();
    attention.update(agents.data);
  }

  function setOpen(open) {
    agents.open = open;
    $a('agentsPanel').classList.toggle('hidden', !open);
    $a('agentsBackdrop').classList.toggle('hidden', !open);
    if (open) {
      renderPanel();
      refresh();
      $a('agentsClose').focus({ preventScroll: true });
    }
  }

  $a('coAgents').addEventListener('click', () => setOpen(true));
  $a('agentsClose').addEventListener('click', () => setOpen(false));
  $a('agentsBackdrop').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && agents.open) setOpen(false);
    // Alt+A opens the agents overview.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyA' || e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setOpen(!agents.open);
    }
  });
  window.addEventListener('hashchange', () => setTimeout(refresh, 400));
  // The tree re-renders as files change; put the marks back afterwards.
  let markTimer = null;
  const ownMark = (n) => n.nodeType === 1 && n.classList.contains('agent-mark');
  new MutationObserver((list) => {
    // Ignore the marks this script adds or removes itself.
    if (list.every((m) => [...m.addedNodes, ...m.removedNodes].every(ownMark))) return;
    if (markTimer) return;
    markTimer = setTimeout(() => { markTimer = null; markTree(); }, 150);
  }).observe($a('tree'), { childList: true, subtree: true });
  let lastPoll = 0;
  setInterval(() => {
    if (document.hidden && Date.now() - lastPoll < 10_000) return;
    lastPoll = Date.now();
    refresh();
  }, 5000);
  setTimeout(refresh, 800);
  window.__agents = { refresh, open: setOpen, get data() { return agents.data; } };

  /* ---------- watch wall ---------- */
  // Pane widgets: { create(pane) -> { onEvent(ev), onHistoryEnd(), dispose() } }.
  // pane: { agent, slots: { editor, console }, history (true while replaying
  // the tail), root }. Widgets live in their own <script> blocks.
  window.__wallHooks = window.__wallHooks || [];
  // Strip widgets: { create({ slots: { timeline, tree }, panes }) -> { onPaneEvent(pane, ev), dispose() } }.
  // pane.showFile(path, key) opens a file in that pane's editor.
  // Panes open before the strip; their events (history tail first) arrive after.
  window.__wallStripHooks = window.__wallStripHooks || [];
  const WALL_PREFS_KEY = 'agenttail-wall';
  // chat: 'caption' (replies as a caption, conversation in the dock drawer),
  // 'side' (a feed column beside the editor) or 'console' (printed in it).
  const CHAT_MODES = ['caption', 'side', 'console'];
  const wallPrefs = { chat: 'caption', shrinkQuiet: true, focus: true, strip: 'auto' };
  try {
    const saved = JSON.parse(localStorage.getItem(WALL_PREFS_KEY) || '{}');
    Object.assign(wallPrefs, saved);
    if (saved.chat === undefined && saved.chatInline) wallPrefs.chat = 'console';
  } catch { /* ignore */ }
  if (!CHAT_MODES.includes(wallPrefs.chat)) wallPrefs.chat = 'caption';
  delete wallPrefs.chatInline;
  // The console widget asks this to decide whether chat lines go to the console.
  window.__wallChatInline = () => wallPrefs.chat === 'console';
  const DORMANT_MS = 60_000;
  const MODEL_WAIT_MS = 20_000;
  const STALL_MS = 5 * 60_000;
  const CONSOLE_LINGER_MS = 3000; // a finished command keeps the console up this long
  const CAPTION_MS = 9000;        // reasoning captions fade after this
  const wall = (() => {
    const panes = [];
    const MAX_PANES = 4;
    const MAX_ROWS = 220;

    function close() {
      for (const pane of panes.splice(0)) {
        try { pane.es.close(); } catch { /* ignore */ }
        clearInterval(pane.timer);
        clearTimeout(pane.consoleTimer);
        clearTimeout(pane.captionTimer);
        for (const widget of pane.widgets) {
          try { widget.dispose && widget.dispose(); } catch { /* ignore */ }
        }
      }
      $a('wallGrid').textContent = '';
      closeStrip();
      $a('wall').classList.add('hidden');
    }

    function trim(feed) {
      while (feed.childElementCount > MAX_ROWS) feed.firstElementChild.remove();
    }

    function pin(pane) {
      if (pane.stick) pane.feed.scrollTop = pane.feed.scrollHeight;
    }

    function setAction(pane, glyph, text, at) {
      pane.action = { glyph, text, at: at || Date.now() };
      drawAction(pane);
    }

    /** How long a running step has produced nothing, or 0. */
    function modelWait(pane) {
      // A tool still running is not the model: the console shows that.
      if (pane.state !== 'live' || !pane.stepOpen || !pane.lastEvAt || pane.openCalls.size || pane.jobs.size) return 0;
      const quiet = Date.now() - pane.lastEvAt;
      return quiet > MODEL_WAIT_MS ? quiet : 0;
    }

    /** Minutes without a word usually means the model or the agent process hung. */
    function waitText(pane, wait) {
      return wait > STALL_MS
        ? `stalled? no output for ${clock(wait)} · step ${pane.stepOpen}`
        : `waiting on the model · ${clock(wait)} · step ${pane.stepOpen}`;
    }

    function drawAction(pane) {
      const wait = modelWait(pane);
      pane.root.classList.toggle('model-wait', !!wait);
      if (wait) {
        pane.act.textContent = '';
        pane.act.appendChild(el('span', 'k', '⏳'));
        pane.act.appendChild(document.createTextNode(waitText(pane, wait)));
        return;
      }
      const a = pane.action;
      pane.act.textContent = '';
      pane.act.appendChild(el('span', 'k', a ? a.glyph : '·'));
      pane.act.appendChild(document.createTextNode(a ? `${a.text}  · ${ago(a.at)}` : 'waiting for activity…'));
    }

    function addFile(pane, p) {
      if (!p) return;
      pane.files = [p, ...pane.files.filter((f) => f !== p)].slice(0, 8);
      pane.filesEl.textContent = '';
      for (const f of pane.files) {
        const chip = el('span', 'ag-file', f.split('/').pop());
        chip.title = f;
        pane.filesEl.appendChild(chip);
      }
    }

    /** One message in a pane's conversation drawer (kept to the last 120). */
    function addConversation(pane, who, text) {
      const list = pane.focus.thinkReply;
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      const item = el('div', `th-msg ${who}`);
      item.appendChild(el('span', 'th-who', who === 'user' ? '▸ you' : '✦'));
      const body = el('div', 'th-text');
      if (who === 'user') body.textContent = String(text).slice(0, 1200);
      else renderMarkdown(body, String(text).slice(0, 6000));
      item.appendChild(body);
      list.appendChild(item);
      while (list.childElementCount > 120) list.firstElementChild.remove();
      if (atBottom) list.scrollTop = list.scrollHeight;
    }

    /** What the agent is doing decides the stage: console, editor or thoughts. */
    function followView(pane, ev) {
      const f = pane.focus;
      let next = null;
      if (ev.t === 'call') {
        if (ev.name === 'pwsh') {
          next = 'console';
          clearTimeout(pane.consoleTimer);
          const cmd = String((ev.args && ev.args.command) || '').replace(/\s+/g, ' ');
          f.dkConsoleText.textContent = cmd.slice(0, 60) || 'command';
          f.dkConsole.classList.remove('ok', 'bad');
          pane.lastShell = ev.callId;
        } else if (EDIT_TOOLS.has(ev.name) || ev.name === 'read') {
          next = 'editor';
        }
      } else if (ev.t === 'result' && ev.callId && ev.callId === pane.lastShell) {
        const exit = /\[exit code:\s*(-?\d+)\]/i.exec(ev.text || '');
        const bad = ev.isError || (exit && exit[1] !== '0');
        f.dkConsole.classList.toggle('bad', !!bad);
        f.dkConsole.classList.toggle('ok', !bad);
        f.dkConsoleText.textContent = `${f.dkConsoleText.textContent.replace(/ [✓✗].*$/, '')} ${bad ? '✗' : '✓'}`;
        // The command is done: back to the editor shortly, unless another one starts.
        if (!pane.history) {
          clearTimeout(pane.consoleTimer);
          pane.consoleTimer = setTimeout(() => {
            if (pane.view === 'console' && pane.jobs.size === 0) {
              pane.view = 'editor';
              applyView(pane);
            }
          }, CONSOLE_LINGER_MS);
        }
      } else if (ev.t === 'job') {
        pane.jobs.add(ev.jobId || ev.callId || ev.seq);
        next = 'console';
      } else if (ev.t === 'jobEnd') {
        pane.jobs.delete(ev.jobId || ev.callId || ev.seq);
      } else if (ev.t === 'say' && (ev.thinking || ev.text)) {
        // Reasoning does not take the stage; it runs as a caption.
        const said = ev.text ? mdToText(ev.text) : mdToText(ev.thinking);
        const tail = said.split('\n').filter((l) => l.trim()).slice(-2).join(' ').replace(/\s+/g, ' ');
        f.captionKind.textContent = ev.text ? 'replying' : 'thinking';
        f.captionText.textContent = tail.length > 220 ? `…${tail.slice(-220)}` : tail;
        f.caption.classList.toggle('reply', !!ev.text);
        if (!pane.history) {
          pane.root.classList.add('captioning');
          clearTimeout(pane.captionTimer);
          pane.captionTimer = setTimeout(() => pane.root.classList.remove('captioning'), CAPTION_MS);
        }
        const lastLines = (text, n) => mdToText(text).split('\n').filter((l) => l.trim()).slice(-n).join('\n');
        f.thinkReason.textContent = ev.thinking && !ev.text ? `… ${lastLines(ev.thinking, 4)}` : '';
        if (ev.text) addConversation(pane, 'agent', ev.text);
        f.dkThinkText.textContent = ev.text ? 'replied' : 'thinking';
      } else if (ev.t === 'user' && !ev.system && ev.text) {
        addConversation(pane, 'user', ev.text);
      }
      f.dkJob.classList.toggle('hidden', pane.jobs.size === 0);
      f.dkJob.textContent = pane.jobs.size > 1 ? `▶ ${pane.jobs.size} jobs` : '▶ job';
      if (next) {
        pane.lastView = next;
        if (!pane.history) {
          pane.view = next;
          applyView(pane);
        }
      }
    }

    function applyView(pane) {
      const view = pane.pinnedView || pane.view;
      const f = pane.focus;
      const was = pane.shownView;
      pane.root.classList.toggle('show-console', view === 'console');
      pane.root.classList.toggle('show-think', view === 'think');
      for (const [name, button] of [['editor', f.dkEditor], ['console', f.dkConsole], ['think', f.dkThink]]) {
        button.classList.toggle('on', name === view);
        button.classList.toggle('pinned', name === pane.pinnedView);
      }
      // The view that just minimised bumps its dock icon.
      if (was && was !== view && !reduced()) {
        const button = { editor: f.dkEditor, console: f.dkConsole, think: f.dkThink }[was];
        button.classList.remove('bump');
        void button.offsetWidth;
        button.classList.add('bump');
      }
      pane.shownView = view;
    }

    function reduced() {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
    }

    /**
     * Commands and edits are already on the console, the editor and the
     * timeline; in the feed consecutive actions fold into one row that opens
     * on click, so the feed reads as the conversation.
     */
    function addAction(feed, row) {
      const last = feed.lastElementChild;
      if (last && last.classList.contains('wf-group')) {
        last.querySelector('.wf-group-list').appendChild(row);
        summarizeGroup(last);
        return;
      }
      if (last && last.classList.contains('wf-call')) {
        const group = document.createElement('details');
        group.className = 'wf-group';
        const summary = el('summary', 'wf-group-sum');
        const list = el('div', 'wf-group-list');
        group.append(summary, list);
        feed.replaceChild(group, last);
        list.append(last, row);
        summarizeGroup(group);
        return;
      }
      feed.appendChild(row);
    }

    function summarizeGroup(group) {
      const rows = [...group.querySelectorAll('.wf-call')];
      const count = (k) => rows.filter((r) => r.dataset.kind === k).length;
      const parts = [['cmd', '$'], ['edit', '✎'], ['read', '👁'], ['tool', '⚙']]
        .map(([k, g]) => (count(k) ? `${g} ${count(k)}` : ''))
        .filter(Boolean);
      const failed = rows.filter((r) => r.dataset.bad).length;
      const sum = group.querySelector('.wf-group-sum');
      sum.textContent = `⚙ ${rows.length} actions · ${parts.join('  ')}`;
      if (failed) sum.appendChild(el('span', 'bad', `  ✗ ${failed}`));
      const lastRow = rows[rows.length - 1];
      if (lastRow) sum.appendChild(el('span', 'wf-group-last', `  — ${lastRow.textContent.replace(/[✓✗].*$/, '').trim().slice(0, 60)}`));
    }

    function onEvent(pane, ev) {
      // Replayed events count from their own time, live ones from their arrival.
      pane.lastEvAt = pane.history ? Math.max(pane.lastEvAt || 0, ev.time || 0) : Date.now();
      if (ev.t === 'step') { pane.stepOpen = ev.step || true; pane.openCalls.clear(); }
      else if (ev.t === 'stepEnd') { pane.stepOpen = 0; pane.openCalls.clear(); }
      else if (ev.t === 'call' && ev.callId) pane.openCalls.add(ev.callId);
      else if (ev.t === 'result' && ev.callId) pane.openCalls.delete(ev.callId);
      if (ev.t === 'step' || ev.t === 'stepEnd') pane.root.classList.toggle('stepping', !!pane.stepOpen);
      followView(pane, ev);
      if (!pane.history && ['call', 'result', 'say', 'user', 'job', 'jobEnd', 'jobOutput'].includes(ev.t)) {
        pane.lastActiveAt = Date.now();
        updateDormant(pane);
      } else if (pane.history && typeof ev.time === 'number') {
        pane.lastActiveAt = Math.max(pane.lastActiveAt, ev.time);
      }
      for (const widget of pane.widgets) {
        try { widget.onEvent && widget.onEvent(ev); } catch (err) { console.error('wall widget event failed', err); }
      }
      stripEvent(pane, ev);
      const feed = pane.feed;
      if (ev.t === 'user' && !ev.system && ev.text) {
        feed.appendChild(el('div', 'wf-user', String(ev.text).slice(0, 600)));
        setAction(pane, '▸', 'new user message', ev.time);
      } else if (ev.t === 'say') {
        if (ev.thinking) feed.appendChild(el('div', 'wf-think', `thinking · ${mdToText(ev.thinking).replace(/\s+/g, ' ').slice(0, 160)}`));
        if (ev.text) {
          const say = el('div', 'wf-say');
          renderMarkdown(say, ev.text);
          feed.appendChild(say);
          setAction(pane, '✦', `replying · ${mdToText(ev.text).replace(/\s+/g, ' ').slice(0, 90)}`, ev.time);
        } else if (ev.thinking) {
          setAction(pane, '…', 'thinking', ev.time);
        }
      } else if (ev.t === 'call') {
        const args = ev.args || {};
        const isEdit = EDIT_TOOLS.has(ev.name);
        const label = ev.name === 'pwsh' ? (args.command || '') : (args.file_path || args.pattern || args.description || ev.name);
        const glyph = ev.name === 'pwsh' ? '$' : isEdit ? '✎' : ev.name === 'read' ? '👁' : '⚙';
        const row = el('div', 'wf-call', `${glyph} ${String(label).replace(/\s+/g, ' ')}`);
        row.title = String(label);
        row.dataset.kind = ev.name === 'pwsh' ? 'cmd' : isEdit ? 'edit' : ev.name === 'read' ? 'read' : 'tool';
        addAction(feed, row);
        if (ev.callId) pane.calls.set(ev.callId, row);
        if (isEdit) addFile(pane, args.file_path);
        setAction(pane, glyph, `${ev.name === 'pwsh' ? 'running' : isEdit ? 'editing' : ev.name} ${String(label).replace(/\s+/g, ' ').slice(0, 120)}`, ev.time);
      } else if (ev.t === 'result') {
        const row = pane.calls.get(ev.callId);
        if (row) {
          const exit = /\[exit code:\s*(-?\d+)\]/i.exec(ev.text || '');
          const bad = ev.isError || (exit && exit[1] !== '0');
          row.appendChild(el('span', bad ? 'bad' : 'ok', bad ? `✗${exit ? ' exit ' + exit[1] : ''}` : `✓${exit ? ' exit ' + exit[1] : ''}`));
          if (bad) row.dataset.bad = '1';
          const group = row.closest('.wf-group');
          if (group) summarizeGroup(group);
          pane.calls.delete(ev.callId);
        }
      } else if (ev.t === 'job') {
        feed.appendChild(el('div', 'wf-job', `▶ job running · ${String(ev.label || '').replace(/\s+/g, ' ').slice(0, 140)}`));
        setAction(pane, '▶', `job running · ${String(ev.label || '').slice(0, 100)}`, ev.time);
      } else if (ev.t === 'jobEnd') {
        feed.appendChild(el('div', 'wf-job', `■ job ${ev.status || 'ended'}${ev.detail ? ' · ' + ev.detail : ''}`));
      } else {
        return;
      }
      if (pane.history) return;
      trim(feed);
      pin(pane);
    }

    function paneFor(agent) {
      const root = el('section', `wall-pane${agent.state === 'live' ? ' live' : ''}`);
      root.style.setProperty('--c', colorOf(agent));
      root.dataset.key = agent.key;
      const head = el('div', 'wp-head');
      head.appendChild(dot(agent));
      head.appendChild(el('span', 'wp-src', agent.sourceLabel));
      if (agent.repo && agent.repo.branch) head.appendChild(el('span', 'wp-branch', `⎇ ${agent.repo.branch}`));
      const title = el('span', 'wp-title', agent.title);
      title.title = 'Open this session in the main view';
      title.addEventListener('click', () => { close(); location.hash = hashFor(agent); });
      head.appendChild(title);
      const stateEl = el('span', `wp-state${agent.state === 'live' ? ' live' : ''}`, agent.state);
      head.appendChild(stateEl);
      root.appendChild(head);
      const act = el('div', 'wp-act');
      root.appendChild(act);
      const body = el('div', 'wp-body');
      const main = el('div', 'wp-main');
      const editorSlot = el('div', 'wp-editor');
      const consoleSlot = el('div', 'wp-console');
      main.appendChild(editorSlot);
      main.appendChild(consoleSlot);
      const think = el('div', 'wp-think');
      const thinkHead = el('div', 'th-head');
      const dots = el('span', 'dots');
      dots.append(el('i'), el('i'), el('i'));
      const thinkTitle = el('span', '', 'CONVERSATION');
      thinkHead.append(dots, thinkTitle);
      // The conversation drawer: your messages and the agent's replies in order
      // (actions live in the console, editor and timeline), latest reasoning last.
      const thinkBody = el('div', 'th-body');
      const thinkReply = el('div', 'th-list');
      const thinkReason = el('div', 'th-reason');
      thinkBody.append(thinkReply, thinkReason);
      think.append(thinkHead, thinkBody);
      main.appendChild(think);
      // Reasoning and replies run as a caption over the stage, not a card.
      const caption = el('div', 'wp-caption');
      const captionKind = el('b', '', 'thinking');
      const captionText = el('span', '');
      caption.append(captionKind, captionText);
      main.appendChild(caption);
      const dock = el('div', 'wp-dock');
      const dkEditor = el('button', 'dk-editor');
      dkEditor.type = 'button';
      dkEditor.title = 'Show the editor: the file this agent is working on';
      dkEditor.append(el('b', '', '✎'), el('span', '', 'editor'));
      const dkConsole = el('button', 'dk-console');
      dkConsole.type = 'button';
      const dkConsoleText = el('span', '', 'console');
      const dkJob = el('em', 'dk-job hidden', '▶ job');
      dkConsole.title = 'Show the console: the commands this agent ran';
      dkConsole.append(el('b', '', '$'), dkConsoleText, dkJob);
      const dkThink = el('button', 'dk-think');
      dkThink.type = 'button';
      const dkThinkText = el('span', '', 'conversation');
      dkThink.title = 'Open the conversation: your messages and the agent replies';
      dkThink.append(el('b', '', '💬'), dkThinkText);
      dock.append(dkEditor, dkConsole, dkThink);
      main.appendChild(dock);
      const side = el('div', 'wp-side');
      const feed = el('div', 'wp-feed');
      side.appendChild(feed);
      const filesEl = el('div', 'wp-files');
      side.appendChild(filesEl);
      body.appendChild(main);
      body.appendChild(side);
      root.appendChild(body);
      const dormantEl = el('div', 'wp-dormant');
      dormantEl.appendChild(el('span', 'z', '💤'));
      const dormantText = el('span', '', 'waiting');
      dormantEl.appendChild(dormantText);
      root.appendChild(dormantEl);
      root.addEventListener('click', (e) => {
        if (!root.classList.contains('dormant') && !pane.pinned) return;
        if (e.target.closest('.wp-title')) return;
        pane.pinned = !pane.pinned;
        updateDormant(pane);
      });
      const pane = {
        agent, root, act, feed, filesEl, stateEl, calls: new Map(), files: [], stick: true, history: true, action: null,
        dormantText, lastActiveAt: 0, state: agent.state, pinned: false,
        view: 'editor', pinnedView: null, jobs: new Set(), openCalls: new Set(), lastView: 'editor',
        focus: { thinkTitle, thinkReason, thinkReply, dkEditor, dkConsole, dkConsoleText, dkJob, dkThink, dkThinkText, caption, captionKind, captionText },
        consoleTimer: null, captionTimer: null,
        slots: { editor: editorSlot, console: consoleSlot },
        widgets: [],
      };
      // Widgets (editor, console …) register in window.__wallHooks; each gets
      // the pane and then every event of its session.
      for (const [view, button] of [['editor', pane.focus.dkEditor], ['console', pane.focus.dkConsole], ['think', pane.focus.dkThink]]) {
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          pane.pinnedView = pane.pinnedView === view ? null : view;
          applyView(pane);
        });
      }
      applyView(pane);
      for (const hook of window.__wallHooks || []) {
        try {
          const widget = hook.create(pane);
          if (widget) pane.widgets.push(widget);
        } catch (err) { console.error('wall widget failed', err); }
      }
      // Other widgets (the team tree) can open a file in this pane's editor.
      pane.showFile = (filePath, key) => {
        for (const widget of pane.widgets) {
          if (typeof widget.open === 'function') widget.open(filePath, key || null);
        }
        pane.pinnedView = null;
        pane.view = 'editor';
        applyView(pane);
      };
      feed.addEventListener('scroll', () => {
        pane.stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
      });
      for (const t of agent.touched || []) addFile(pane, t.path);
      drawAction(pane);
      const url = `/api/stream?source=${encodeURIComponent(agent.source)}&id=${encodeURIComponent(agent.id)}&tail=150&lite=1`;
      pane.es = new EventSource(url);
      pane.es.addEventListener('ev', (e) => { try { onEvent(pane, JSON.parse(e.data)); } catch { /* ignore */ } });
      pane.es.addEventListener('historyEnd', () => {
        pane.history = false;
        pane.view = pane.lastView === 'think' ? 'editor' : pane.lastView;
        applyView(pane);
        for (const widget of pane.widgets) {
          try { widget.onHistoryEnd && widget.onHistoryEnd(); } catch { /* ignore */ }
        }
        trim(feed);
        feed.scrollTop = feed.scrollHeight;
        if (!feed.childElementCount) feed.appendChild(el('div', 'wf-think', 'no activity yet'));
      });
      pane.es.addEventListener('status', (e) => {
        try {
          const st = JSON.parse(e.data);
          if (!st.state) return;
          stateEl.textContent = st.state;
          stateEl.classList.toggle('live', st.state === 'live');
          root.classList.toggle('live', st.state === 'live');
          pane.state = st.state;
          if (Array.isArray(st.jobs)) {
            pane.jobs = new Set(st.jobs.map((j) => j.jobId));
            pane.focus.dkJob.classList.toggle('hidden', pane.jobs.size === 0);
            pane.focus.dkJob.textContent = pane.jobs.size > 1 ? `▶ ${pane.jobs.size} jobs` : '▶ job';
          }
          drawAction(pane);
          updateDormant(pane);
        } catch { /* ignore */ }
      });
      pane.timer = setInterval(() => { drawAction(pane); updateDormant(pane); }, 2000);
      return pane;
    }

    /**
     * A pane is dormant when its agent is not working (idle/finished) or has
     * produced nothing for a minute. Dormant panes shrink to a slim column
     * unless the user pinned them open; never all of them at once.
     */
    function updateDormant(pane) {
      const quietFor = Date.now() - (pane.lastActiveAt || 0);
      const quiet = pane.state !== 'live' || quietFor > DORMANT_MS;
      pane.quiet = quiet;
      const label = pane.state !== 'live'
        ? (pane.state === 'idle' ? 'waiting for you' : 'finished')
        : modelWait(pane) ? waitText(pane, modelWait(pane)) : `thinking quietly · ${ago(pane.lastActiveAt)}`;
      pane.dormantText.textContent = label;
      applyDormant();
    }

    function applyDormant() {
      const active = panes.filter((p) => !(p.quiet && !p.pinned));
      for (const p of panes) {
        const shrink = wallPrefs.shrinkQuiet && p.quiet && !p.pinned && active.length > 0;
        if (p.root.classList.contains('dormant') !== shrink) p.root.classList.toggle('dormant', shrink);
        p.root.title = shrink ? 'Quiet agent — click to keep it open' : (p.pinned ? 'Pinned open — click to let it shrink when quiet' : '');
      }
    }

    function renderToggles() {
      $a('wallChatMode').textContent = `CHAT: ${{ caption: 'CAPTION', side: 'SIDE', console: 'IN CONSOLE' }[wallPrefs.chat]}`;
      $a('wallDormantMode').textContent = wallPrefs.shrinkQuiet ? 'QUIET AGENTS: SHRINK' : 'QUIET AGENTS: KEEP';
      // Only SIDE keeps the feed column; the others give editor and console the width.
      $a('wall').classList.toggle('chat-inline', wallPrefs.chat === 'console' || (wallPrefs.chat === 'caption' && wallPrefs.focus));
      $a('wall').classList.toggle('chat-console', wallPrefs.chat === 'console');
      $a('wall').classList.toggle('focus', wallPrefs.focus);
      $a('wallLayoutMode').textContent = wallPrefs.focus ? 'LAYOUT: FOCUS' : 'LAYOUT: SPLIT';
      applyStrip();
    }

    function savePrefs() {
      try { localStorage.setItem(WALL_PREFS_KEY, JSON.stringify(wallPrefs)); } catch { /* ignore */ }
    }

    $a('wallChatMode').addEventListener('click', () => {
      const before = wallPrefs.chat;
      wallPrefs.chat = CHAT_MODES[(CHAT_MODES.indexOf(before) + 1) % CHAT_MODES.length];
      savePrefs();
      renderToggles();
      // Replay the panes when the consoles must pick up (or drop) the chat lines.
      if (before === 'console' || wallPrefs.chat === 'console') {
        const agentsNow = panes.map((p) => p.agent);
        if (agentsNow.length) open(agentsNow);
      }
    });
    /** 'auto' is compact on short windows; a click picks full or compact for good. */
    function applyStrip() {
      const compact = wallPrefs.strip === 'compact' || (wallPrefs.strip === 'auto' && window.innerHeight < 820);
      $a('wallStrip').classList.toggle('compact', compact);
      $a('wallStripToggle').textContent = compact ? '▸' : '▾';
      $a('wallStripToggle').title = compact ? 'Show the timeline' : 'Hide the timeline';
    }
    $a('wallStripToggle').addEventListener('click', () => {
      wallPrefs.strip = $a('wallStrip').classList.contains('compact') ? 'full' : 'compact';
      savePrefs();
      applyStrip();
    });
    window.addEventListener('resize', () => { if (wallPrefs.strip === 'auto') applyStrip(); });
    $a('wallLayoutMode').addEventListener('click', () => {
      wallPrefs.focus = !wallPrefs.focus;
      savePrefs();
      renderToggles();
    });
    $a('wallDormantMode').addEventListener('click', () => {
      wallPrefs.shrinkQuiet = !wallPrefs.shrinkQuiet;
      savePrefs();
      renderToggles();
      applyDormant();
    });

    const strip = { widgets: [] };
    function openStrip() {
      const slots = {
        timeline: document.querySelector('#wallStrip .ws-timeline'),
        tree: document.getElementById('wallSide'),
      };
      for (const hook of window.__wallStripHooks || []) {
        try {
          const widget = hook.create({ slots, panes: panes.slice() });
          if (widget) strip.widgets.push(widget);
        } catch (err) { console.error('wall strip widget failed', err); }
      }
    }
    function closeStrip() {
      for (const widget of strip.widgets.splice(0)) {
        try { widget.dispose && widget.dispose(); } catch { /* ignore */ }
      }
      for (const slot of document.querySelectorAll('#wallStrip .ws-slot, #wallSide')) slot.textContent = '';
    }
    function stripEvent(pane, ev) {
      for (const widget of strip.widgets) {
        try { widget.onPaneEvent && widget.onPaneEvent(pane, ev); } catch (err) { console.error('wall strip event failed', err); }
      }
    }

    function open(list) {
      const chosen = (list || []).slice(0, MAX_PANES);
      if (!chosen.length) return;
      close();
      setOpen(false);
      const grid = $a('wallGrid');
      renderToggles();
      for (const agent of chosen) {
        const pane = paneFor(agent);
        panes.push(pane);
        grid.appendChild(pane.root);
      }
      $a('wallSummary').textContent = chosen.map((a) => `${a.sourceLabel}${a.repo && a.repo.branch ? ' · ' + a.repo.branch : ''}`).join('  +  ');
      $a('wall').classList.remove('hidden');
      openStrip();
    }

    /** Live agents of the repo being viewed, else the live agents anywhere. */
    function defaultList() {
      const data = agents.data;
      if (!data) return [];
      const { group, me } = findMe();
      const mine = group ? group.agents.filter((a) => a.state === 'live' && a !== me) : [];
      const others = mine.length >= 1 ? mine
        : data.groups.flatMap((g) => g.agents).filter((a) => a.state === 'live' && a !== me);
      // The session being viewed is always the first pane (it shrinks if quiet).
      return me ? [me, ...others] : others;
    }

    $a('wallClose').addEventListener('click', close);
    return {
      open,
      close,
      openDefault: () => open(defaultList()),
      get open_() { return !$a('wall').classList.contains('hidden'); },
      get panes() { return panes.length; },
      get dormant() { return panes.filter((p) => p.root.classList.contains('dormant')).map((p) => p.agent.key); },
      views: () => Object.fromEntries(panes.map((p) => [p.agent.key, p.pinnedView || p.view])),
      prefs: wallPrefs,
    };
  })();
  $a('agentsWatchLive').addEventListener('click', () => wall.open((agents.data ? agents.data.groups.flatMap((g) => g.agents) : []).filter((a) => a.state === 'live')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wall.open_) { wall.close(); return; }
    // Ctrl+Shift+W closes the browser window, so the wall uses Alt+W.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyW' || e.key === 'w' || e.key === 'W')) {
      e.preventDefault();
      if (wall.open_) wall.close();
      else agents.data ? wall.openDefault() : refresh().then(() => wall.openDefault());
    }
  });
  window.__wall = wall;

  /* ---------- attention: title count, favicon badge, notifications ---------- */
  const attention = (() => {
    const baseTitle = document.title;
    const NOTIFY_KEY = 'agenttail-notify';
    const prev = new Map(); // agent key -> { state, approvals }
    const done = new Map(); // agents that stopped while the tab was hidden
    let approvals = 0;
    let seeded = false;
    let iconImage = null;
    let notify = false;
    try { notify = localStorage.getItem(NOTIFY_KEY) === '1'; } catch { /* ignore */ }

    function label(agent) {
      return `${agent.sourceLabel}${agent.repo && agent.repo.branch ? ' · ' + agent.repo.branch : ''}`;
    }

    function desktop(title, body, tag) {
      if (!notify || !document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      try { new Notification(title, { body, tag, silent: false }); } catch { /* ignore */ }
    }

    function drawIcon() {
      const link = $a('favicon');
      if (!link) return;
      const count = approvals + done.size;
      if (!count) {
        if (link.dataset.badge) {
          link.type = 'image/svg+xml';
          link.href = '/favicon.svg';
          delete link.dataset.badge;
        }
        return;
      }
      const colour = approvals ? '#ffb020' : '#37f28a';
      const paint = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#050c09';
        ctx.fillRect(0, 0, 32, 32);
        if (iconImage && iconImage.complete) ctx.drawImage(iconImage, 0, 0, 32, 32);
        ctx.beginPath();
        ctx.arc(23, 9, 9, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(count > 9 ? '9+' : String(count), 23, 10);
        link.type = 'image/png';
        link.href = canvas.toDataURL('image/png');
        link.dataset.badge = String(count);
      };
      if (!iconImage) {
        iconImage = new Image();
        iconImage.onload = paint;
        iconImage.src = '/favicon.svg';
      }
      paint();
    }

    function render() {
      const count = approvals + done.size;
      const mark = approvals ? '⚠ ' : done.size ? '✓ ' : '';
      document.title = count ? `(${count}) ${mark}${baseTitle}` : baseTitle;
      drawIcon();
    }

    function update(data) {
      const list = data ? data.groups.flatMap((g) => g.agents) : [];
      approvals = list.reduce((sum, a) => sum + (a.approvals || 0), 0);
      for (const agent of list) {
        const before = prev.get(agent.key);
        if (seeded && before) {
          if ((agent.approvals || 0) > (before.approvals || 0)) {
            desktop('Approval needed', `${label(agent)}: ${agent.title}`, `approval:${agent.key}`);
          }
          if (before.state === 'live' && agent.state !== 'live' && document.hidden) {
            done.set(agent.key, agent);
            desktop('Agent stopped working', `${label(agent)}: ${agent.title}`, `done:${agent.key}`);
          }
        }
        prev.set(agent.key, { state: agent.state, approvals: agent.approvals || 0 });
      }
      seeded = true;
      render();
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && done.size) {
        done.clear();
        render();
      }
    });

    const box = $a('notifyBox');
    if (box) {
      box.checked = notify;
      box.addEventListener('change', async () => {
        notify = box.checked;
        if (notify && typeof Notification !== 'undefined' && Notification.permission === 'default') {
          try { await Notification.requestPermission(); } catch { /* ignore */ }
        }
        if (notify && typeof Notification !== 'undefined' && Notification.permission === 'denied') {
          notify = false;
          box.checked = false;
          box.parentElement.title = 'Notifications are blocked for this page in the browser settings';
        }
        try { localStorage.setItem(NOTIFY_KEY, notify ? '1' : '0'); } catch { /* ignore */ }
      });
    }

    return { update, get count() { return approvals + done.size; }, get done() { return [...done.keys()]; } };
  })();
  window.__attention = attention;
})();
