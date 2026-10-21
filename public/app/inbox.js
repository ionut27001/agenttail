// Inbox: everything that needs you, in one list.
// Loaded by index.html as a classic script, after control.js and agents.js.
//
// Rows come from the agents overview (every source: dsh, Claude Code,
// Antigravity) and carry "open session". For sessions agenttail owns, the
// pending approvals come from /api/control/approvals (only with
// --allow-control, and never in stream mode) and can be approved or rejected
// here, with the same endpoint and token the session page uses.
/* ---------- inbox ---------- */
(() => {
  const $i = (id) => document.getElementById(id);
  const TOKEN_KEY = 'agenttail-control-token';
  const inbox = { open: false, agents: [], approvals: [], busy: new Set(), errors: new Map(), usable: false, loading: false };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const hashOf = (source, id) => (source === 'dsh' ? id : `${source}:${id}`);
  const keyOf = (source, id) => `${source}:${id}`;

  function token() {
    try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
  }

  /** Control must be on, unlocked (not stream mode) and the page must hold the token. */
  function controlUsable() {
    const c = window.__control && window.__control.state;
    return !!(c && c.enabled && !c.locked && token());
  }

  async function controlFetch(path, options = {}) {
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${token()}` };
    const res = await fetch(path, { ...options, headers });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** The text of an approval as the agent will run it: raw input first, title after. */
  function approvalText(approval) {
    if (approval.command) return `$ ${approval.command}`;
    if (approval.diff) {
      const lines = (text, mark) => String(text || '').split('\n').map((line) => `${mark} ${line}`).join('\n');
      return `${approval.diff.path || '(file)'}\n${lines(approval.diff.oldText, '-')}\n${lines(approval.diff.newText, '+')}`;
    }
    if (approval.content) return approval.content;
    if (approval.rawInput) return JSON.stringify(approval.rawInput, null, 2);
    return approval.title || '(no command details were sent)';
  }

  function waited(since) {
    if (!since) return '';
    const s = Math.max(0, Math.round((Date.now() - since) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return `${Math.round(s / 3600)} h`;
  }

  /** One row per session that needs you: agents from the overview plus owned approvals. */
  function rows() {
    const out = new Map();
    for (const agent of inbox.agents) {
      if (!attnNeeds(agent.attention)) continue;
      out.set(agent.key, { key: agent.key, source: agent.source, id: agent.id, agent, approvals: [], since: agent.attention.since || 0 });
    }
    for (const item of inbox.approvals) {
      const key = keyOf(item.source, item.sessionId);
      if (!out.has(key)) {
        out.set(key, { key, source: item.source, id: item.sessionId, agent: null, approvals: [], since: item.approval.createdAt || 0 });
      }
      out.get(key).approvals.push(item);
    }
    return [...out.values()].sort((a, b) => (a.since || Infinity) - (b.since || Infinity));
  }

  function approvalCard(row, item) {
    const approval = item.approval;
    const card = el('div', 'ib-approval');
    const head = el('div', 'ib-ahead');
    head.appendChild(el('span', 'ib-tool', approval.title || 'Permission request'));
    if (approval.kind) head.appendChild(el('span', 'dim', approval.kind));
    if (approval.createdAt) head.appendChild(el('span', 'dim', `waiting ${waited(approval.createdAt)}`));
    card.appendChild(head);
    // The whole text, scrollable: approving what you cannot read defeats the point.
    card.appendChild(el('pre', 'ib-detail', approvalText(approval)));
    const id = `${row.id}|${approval.approvalId}`;
    const actions = el('div', 'ib-actions');
    const reason = el('input', 'ib-reason');
    reason.type = 'text';
    reason.placeholder = 'reason (optional, only for reject)';
    reason.maxLength = 500;
    const approve = el('button', 'ib-approve', 'APPROVE');
    const reject = el('button', 'ib-reject', 'REJECT');
    for (const b of [approve, reject]) { b.type = 'button'; b.disabled = inbox.busy.has(id); }
    approve.title = 'Allow this once';
    approve.addEventListener('click', () => decide(row, approval, 'approve', ''));
    reject.addEventListener('click', () => decide(row, approval, 'reject', reason.value.trim()));
    reason.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); decide(row, approval, 'reject', reason.value.trim()); } });
    actions.append(approve, reject, reason);
    card.appendChild(actions);
    if (inbox.errors.has(id)) card.appendChild(el('div', 'ib-error', inbox.errors.get(id)));
    return card;
  }

  async function decide(row, approval, decision, reason) {
    const id = `${row.id}|${approval.approvalId}`;
    if (inbox.busy.has(id)) return;
    inbox.busy.add(id);
    inbox.errors.delete(id);
    render();
    try {
      await controlFetch('/api/control/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, approvalId: approval.approvalId, decision, reason }),
      });
      inbox.approvals = inbox.approvals.filter((a) => !(a.sessionId === row.id && a.approval.approvalId === approval.approvalId));
    } catch (err) {
      inbox.errors.set(id, err.message || 'the decision failed');
    } finally {
      inbox.busy.delete(id);
    }
    render();
    await load();
    if (window.__agents) window.__agents.refresh();
  }

  function rowEl(row) {
    const agent = row.agent;
    const att = agent ? agent.attention : null;
    const box = el('section', 'ib-item');
    box.dataset.key = row.key;
    if (agent) box.style.setProperty('--c', `var(--agent-${Number.isInteger(agent.color) ? agent.color % 8 : 0})`);
    const top = el('div', 'ib-top');
    top.appendChild(el('b', 'ib-src', agent ? agent.sourceLabel : row.source));
    if (agent && agent.repo && agent.repo.branch) top.appendChild(el('span', 'ib-branch', `⎇ ${agent.repo.branch}`));
    top.appendChild(el('span', 'ib-title', agent ? agent.title : row.id));
    const age = waited(row.since);
    if (age) top.appendChild(el('span', 'ib-age dim', `waiting ${age}`));
    box.appendChild(top);
    const why = el('div', 'ib-why');
    why.appendChild(el('span', 'ib-label', att ? attnLabel(att) : 'NEEDS YOU · permission'));
    if (att) why.appendChild(el('span', 'dim', `${att.detail ? att.detail + ' · ' : ''}via ${ATTENTION_VIA[att.via] || att.via} · ${att.certainty}`));
    box.appendChild(why);
    for (const item of row.approvals) box.appendChild(approvalCard(row, item));
    const actions = el('div', 'ib-actions');
    const open = el('button', 'ib-open', 'OPEN SESSION');
    open.type = 'button';
    open.addEventListener('click', () => {
      setOpen(false);
      location.hash = agent && window.__agents ? window.__agents.hashFor(agent) : hashOf(row.source, row.id);
    });
    actions.appendChild(open);
    if (!row.approvals.length && att && att.via !== 'acp') {
      const note = !controlUsable() ? 'answer it in the agent itself' : 'answer it in the agent itself (agenttail does not own this session)';
      actions.appendChild(el('span', 'dim', note));
    }
    box.appendChild(actions);
    return box;
  }

  function render() {
    const list = rows();
    const btn = $i('inboxBtn');
    if (btn) {
      btn.textContent = `⚠ NEEDS YOU · ${list.length}`;
      btn.classList.toggle('hidden', list.length === 0 && !inbox.open);
      btn.title = list.length ? `${list.length} session${list.length === 1 ? '' : 's'} waiting on you (Alt+I)` : 'Nothing needs you (Alt+I)';
    }
    if (!inbox.open) return;
    const body = $i('inboxBody');
    body.textContent = '';
    $i('inboxSummary').textContent = list.length ? `${list.length} waiting` : '';
    if (!list.length) body.appendChild(el('div', 'ag-empty', 'Nothing needs you right now.'));
    for (const row of list) body.appendChild(rowEl(row));
    const notes = el('div', 'ib-notes dim');
    notes.appendChild(el('div', '', 'dsh and Claude Code are watched with no setup. Antigravity approval prompts are not visible to agenttail.'));
    if (!controlUsable()) {
      notes.appendChild(el('div', '', 'Approve and Reject appear here for sessions started from agenttail (start it with --allow-control, outside stream mode).'));
    }
    body.appendChild(notes);
  }

  /** Pending approvals of owned sessions. Quietly nothing when control is off or locked. */
  async function load() {
    if (inbox.loading) return;
    if (!controlUsable()) {
      inbox.usable = false;
      if (inbox.approvals.length) { inbox.approvals = []; render(); }
      return;
    }
    inbox.loading = true;
    try {
      const data = await controlFetch('/api/control/approvals');
      inbox.usable = true;
      inbox.approvals = Array.isArray(data.approvals) ? data.approvals : [];
    } catch {
      inbox.usable = false;
      inbox.approvals = [];
    }
    inbox.loading = false;
    render();
  }

  function setOpen(open) {
    inbox.open = open;
    $i('inboxPanel').classList.toggle('hidden', !open);
    $i('inboxBackdrop').classList.toggle('hidden', !open);
    if (open) {
      inbox.agents = window.__agents && window.__agents.data ? window.__agents.data.groups.flatMap((g) => g.agents) : [];
      render();
      load();
      if (window.__agents) window.__agents.refresh();
      $i('inboxClose').focus({ preventScroll: true });
    } else {
      render();
    }
  }

  // The button, the backdrop and the panel are built here so the page markup
  // stays as it is.
  const bar = $i('activityBar');
  if (!bar) return;
  const btn = el('button', 'hidden', '⚠ NEEDS YOU');
  btn.id = 'inboxBtn';
  btn.type = 'button';
  const anchor = $i('approvalBadge');
  bar.insertBefore(btn, anchor || null);
  const backdrop = el('div', 'hidden');
  backdrop.id = 'inboxBackdrop';
  const panel = el('div', 'hidden');
  panel.id = 'inboxPanel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Needs you');
  const head = el('div', 'ib-head');
  head.appendChild(el('span', '', 'NEEDS YOU'));
  const summary = el('span', 'dim');
  summary.id = 'inboxSummary';
  head.appendChild(summary);
  const close = el('button', '', '✕');
  close.id = 'inboxClose';
  close.type = 'button';
  close.title = 'Close (Esc)';
  head.appendChild(close);
  const body = el('div');
  body.id = 'inboxBody';
  panel.append(head, body);
  document.body.append(backdrop, panel);

  btn.addEventListener('click', () => setOpen(true));
  close.addEventListener('click', () => setOpen(false));
  backdrop.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && inbox.open) setOpen(false);
    // Alt+I opens the inbox.
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyI' || e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      setOpen(!inbox.open);
    }
  });
  document.addEventListener('agenttail:agents', (e) => {
    inbox.agents = e.detail ? e.detail.groups.flatMap((g) => g.agents) : [];
    render();
    // Owned approvals change faster than the overview polls; ask when it matters.
    if (inbox.open || inbox.agents.some((a) => a.owned && attnNeeds(a.attention))) load();
  });
  // While the inbox is open, owned approvals are polled quickly.
  setInterval(() => { if (inbox.open) load(); }, 2000);

  window.__inbox = {
    get open() { return inbox.open; },
    get rows() { return rows().map((r) => ({ key: r.key, approvals: r.approvals.length })); },
    setOpen,
    load,
  };
})();
