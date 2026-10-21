// Opt-in control: token, composer, approvals, new-session dialog.
// Loaded by index.html as a classic script, in order with the others.
/* ---------- control (opt-in) ---------- */
(() => {
  const TOKEN_KEY = 'agenttail-control-token';
  // The server prints the token in the URL fragment. Fragments are never sent
  // to the server, so this is the one place the token appears in the browser.
  (() => {
    const match = /^#token=([A-Za-z0-9_-]{20,})$/.exec(location.hash || '');
    if (!match) return;
    try { sessionStorage.setItem(TOKEN_KEY, match[1]); } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname + location.search);
  })();

  const control = {
    token: (() => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } })(),
    enabled: false,
    locked: false,
    current: null,
    approvals: [],
    queued: false,
    busy: false,
    dialogSession: null,
    dialogCancelled: false,
    starting: false,
    lastError: '',
    attachments: [],
    modelBusy: false,
    options: null,
  };
  const MAX_ATTACHMENTS = 4;
  const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
  const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  const $c = (id) => document.getElementById(id);

  /* ---------- what the agent said it can do (caps) ---------- */
  // Controls appear from the capabilities the agent declared, never from which
  // harness it is.
  const capsOf = (session) => (session && session.caps) || null;
  const canSendImages = (session) => !!(capsOf(session) && capsOf(session).prompt && capsOf(session).prompt.image === true);
  const configList = (session) => (capsOf(session) && Array.isArray(capsOf(session).config) ? capsOf(session).config : []);
  const modelOption = (session) => {
    const list = configList(session).filter((o) => Array.isArray(o.options) && o.options.length);
    return list.find((o) => o.category === 'model') || list.find((o) => o.id === 'model') || null;
  };
  const modeOption = (session) => {
    const list = configList(session);
    return list.find((o) => o.category === 'mode' && Array.isArray(o.options) && o.options.length >= 2) || null;
  };
  /** A model value is a JSON [provider, model] pair, provider/model, or a plain id. */
  function providerOfModel(value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length >= 2) return String(parsed[0]);
    } catch { /* plain value */ }
    const cut = String(value).indexOf('/');
    return cut > 0 ? String(value).slice(0, cut) : '';
  }
  /** Fill a <select> with a config option's choices, grouped when the agent grouped them. */
  function fillChoices(select, option, groupFor) {
    const groups = new Map();
    for (const choice of option.options) {
      const key = groupFor(choice);
      let parent = select;
      if (key) {
        if (!groups.has(key)) {
          const group = document.createElement('optgroup');
          group.label = key;
          groups.set(key, group);
          select.appendChild(group);
        }
        parent = groups.get(key);
      }
      const opt = document.createElement('option');
      opt.value = choice.value;
      opt.textContent = choice.name || choice.value;
      parent.appendChild(opt);
    }
  }
  const modelGroup = (choice) => choice.group || providerOfModel(choice.value) || 'other';

  async function controlStatus() {
    try {
      const res = await fetch('/api/control/status');
      if (!res.ok) { control.enabled = false; control.locked = false; return; }
      const data = await res.json();
      control.enabled = data.enabled === true;
      control.locked = data.locked === true || data.streamMode === true;
    } catch {
      control.enabled = false;
    }
  }

  async function controlFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (control.token) headers.Authorization = `Bearer ${control.token}`;
    const res = await fetch(path, { ...options, headers });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      if (data && data.details) err.details = data.details;
      throw err;
    }
    return data;
  }

  function setStatus(message, kind = '') {
    const el = $c('composerStatus');
    if (!el) return;
    el.textContent = message || '';
    el.className = kind;
  }

  function updateControlChrome() {
    const newBtn = $c('newSessionBtn');
    if (newBtn) newBtn.classList.toggle('hidden', !(control.enabled && !control.locked && !!control.token));
    const composer = $c('composer');
    const hint = $c('controlHint');
    if (!composer || !hint) return;

    const c = control.current;
    const owned = !!(c && c.owned && c.controllable !== false);
    const canType = owned && !control.locked && !!control.token;

    composer.classList.toggle('hidden', !canType);
    let text = '';
    let kind = '';
    if (control.enabled && control.locked) {
      text = 'control disabled in stream mode — this session is view only';
      kind = 'warn';
    } else if (control.enabled && c && !c.owned && state.source === 'dsh') {
      text = 'started outside agenttail, view only';
    } else if (control.enabled && c && c.owned && c.controllable === false) {
      text = `this owned session ended${c.status === 'exited' && c.error ? ` (${c.error})` : ''} — view only`;
    } else if (control.enabled && !control.token) {
      text = 'control token missing — reopen the URL printed by the server';
      kind = 'err';
    }
    hint.textContent = text;
    hint.className = `control-hint${text ? '' : ' hidden'}${kind ? ' ' + kind : ''}`;

    renderModelPicker(canType ? c : null);
    renderModePicker(canType ? c : null);
    showDetails(detailsFold('controlDetails', hint), c && c.owned && c.status === 'exited' ? c.details : '');
    const stop = $c('composerStop');
    const end = $c('composerEnd');
    if (stop) {
      stop.disabled = !(canType && c && c.running);
      stop.classList.toggle('hidden', stop.disabled);
    }
    if (end) end.disabled = !canType;
    if (canType) {
      if (c.running) setStatus('turn running · Stop cancels it · a message sent now will be queued');
      else if (control.queued) setStatus('queued — sends when the current turn ends');
      else if (control.lastError) setStatus(control.lastError, 'err');
      else {
        const mode = modeOption(c);
        const modeName = mode && mode.current ? (mode.options.find((o) => o.value === mode.current) || {}).name : '';
        setStatus(`Enter sends · Shift+Enter newline${c.model ? ` · ${c.provider ? c.provider + '/' : ''}${c.model}` : ''}${modeName ? ` · ${modeName}` : ''}`);
      }
    }
    const badge = $c('approvalBadge');
    if (badge) badge.classList.toggle('hidden', control.approvals.length === 0 || control.locked || !control.enabled);
  }

  /** The agent's own model list for this session; switching applies to the next turn. */
  function renderModelPicker(session) {
    const select = $c('composerModel');
    if (!select) return;
    const option = modelOption(session);
    const choices = option ? option.options : [];
    select.classList.toggle('hidden', choices.length < 2);
    const signature = choices.map((m) => m.value).join('|');
    if (select.dataset.signature !== signature) {
      select.textContent = '';
      if (!choices.length) {
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '—';
        select.appendChild(none);
      } else {
        fillChoices(select, option, modelGroup);
      }
      select.dataset.signature = signature;
    }
    if (option && option.current && document.activeElement !== select) select.value = option.current;
    select.disabled = control.modelBusy;
  }

  /** Mode picker: only for an agent that declared a `mode` option with a choice to make. */
  function modeSelect() {
    let select = $c('composerMode');
    if (!select) {
      select = document.createElement('select');
      select.id = 'composerMode';
      select.className = 'hidden';
      select.title = 'Mode for the next turn';
      $c('composerModel').after(select);
      select.addEventListener('change', switchMode);
    }
    return select;
  }

  function renderModePicker(session) {
    const option = modeOption(session);
    // With no mode to choose and no picker built yet, add no empty control to the page.
    if (!option && !$c('composerMode')) return;
    const select = modeSelect();
    select.classList.toggle('hidden', !option);
    if (!option) { select.dataset.signature = ''; return; }
    const signature = `${option.id}|${option.options.map((m) => m.value).join('|')}`;
    if (select.dataset.signature !== signature) {
      select.textContent = '';
      fillChoices(select, option, () => '');
      select.dataset.signature = signature;
    }
    if (option.current && document.activeElement !== select) select.value = option.current;
    select.title = `${option.name || 'Mode'} for the next turn`;
    select.disabled = control.modelBusy;
  }

  async function switchMode() {
    const select = modeSelect();
    const option = modeOption(control.current);
    if (!option || !select.value || select.value === option.current) return;
    control.modelBusy = true;
    select.disabled = true;
    const post = (confirmDanger) => controlFetch('/api/control/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.sessionId, configId: option.id, value: select.value, ...(confirmDanger ? { confirmDanger: true } : {}) }),
    });
    try {
      let data;
      try {
        data = await post(false);
      } catch (err) {
        // A mode that removes the agent's permission checks needs the same yes as starting in it.
        if (err.status === 400 && /requires explicit confirmation/.test(err.message)
          && window.confirm(`${select.selectedOptions[0]?.textContent || select.value} removes the agent's permission checks (${err.message}). Switch anyway?`)) {
          data = await post(true);
        } else {
          select.value = option.current || select.value;
          throw err;
        }
      }
      if (data && data.session) control.current = { ...control.current, ...data.session };
      setStatus(`${option.name || 'mode'} → ${select.selectedOptions[0]?.textContent || select.value}`);
    } catch (err) {
      setStatus(err.message, 'err');
    } finally {
      control.modelBusy = false;
      updateControlChrome();
    }
  }

  /** What the child wrote to stderr when it exited or failed to start, in a fold. */
  function detailsFold(id, after) {
    let fold = $c(id);
    if (!fold) {
      fold = document.createElement('details');
      fold.id = id;
      fold.className = 'control-details hidden';
      fold.appendChild(document.createElement('summary')).textContent = 'details: what the agent wrote to stderr';
      fold.appendChild(document.createElement('pre'));
      after.after(fold);
    }
    return fold;
  }

  function showDetails(fold, text) {
    const body = String(text || '').trim();
    fold.classList.toggle('hidden', !body);
    fold.querySelector('pre').textContent = body;
  }

  async function switchModel() {
    const select = $c('composerModel');
    const value = select.value;
    if (!value || !control.current || value === control.current.modelValue) return;
    control.modelBusy = true;
    select.disabled = true;
    try {
      const data = await controlFetch('/api/control/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.sessionId, model: value }),
      });
      if (data && data.session) control.current = { ...control.current, ...data.session };
      setStatus(`model → ${data?.session?.provider ? data.session.provider + '/' : ''}${data?.session?.model || value}`);
    } catch (err) {
      setStatus(err.message, 'err');
    } finally {
      control.modelBusy = false;
      updateControlChrome();
    }
  }

  /* ---------- pasted images ---------- */
  function renderAttachments() {
    const box = $c('composerAttachments');
    if (!box) return;
    box.textContent = '';
    box.classList.toggle('hidden', control.attachments.length === 0);
    control.attachments.forEach((item, index) => {
      const chip = document.createElement('div');
      chip.className = 'attach';
      const img = document.createElement('img');
      img.src = `data:${item.mimeType};base64,${item.data}`;
      img.alt = '';
      chip.appendChild(img);
      const label = document.createElement('span');
      label.textContent = `${item.name} · ${Math.max(1, Math.round(item.size / 1024))} KB`;
      chip.appendChild(label);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.title = 'Remove';
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        control.attachments.splice(index, 1);
        renderAttachments();
      });
      chip.appendChild(remove);
      box.appendChild(chip);
    });
    syncComposerInput();
  }

  /** Grow the message box with its text (up to 40% of the window) and light Send once there is something to send. */
  function syncComposerInput() {
    const input = $c('composerInput');
    const send = $c('composerSend');
    if (!input || !send) return;
    input.style.height = 'auto';
    if (input.value) input.style.height = `${Math.min(Math.round(window.innerHeight * 0.4), input.scrollHeight + 2)}px`;
    send.classList.toggle('ready', !!input.value.trim() || control.attachments.length > 0);
  }

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
      reader.onerror = () => reject(reader.error || new Error('could not read the image'));
      reader.readAsDataURL(file);
    });
  }

  async function addImages(files) {
    if (!files.length) return false;
    if (!canSendImages(control.current)) {
      setStatus('this agent does not accept images', 'warn');
      return true;
    }
    for (const file of files) {
      if (control.attachments.length >= MAX_ATTACHMENTS) { setStatus(`at most ${MAX_ATTACHMENTS} images per message`, 'warn'); break; }
      if (!ATTACHMENT_TYPES.includes(file.type)) { setStatus('images must be PNG, JPEG, GIF or WebP', 'warn'); continue; }
      if (file.size > MAX_ATTACHMENT_BYTES) { setStatus('an image is larger than 5 MB', 'warn'); continue; }
      try {
        const data = await readImage(file);
        control.attachments.push({ name: file.name || 'pasted image', mimeType: file.type, size: file.size, data });
      } catch (err) {
        setStatus(err.message, 'err');
      }
    }
    renderAttachments();
    return true;
  }

  function handleControlState(next) {
    control.current = next || null;
    control.enabled = !!(next && next.enabled) || control.enabled;
    control.locked = !!(next && next.locked);
    if (next && next.owned) {
      if (next.preset) state.preset = next.preset;
      if (next.provider || next.model) {
        state.session = state.session || {};
        state.session.provider = next.provider || state.session.provider;
        state.session.model = next.model || state.session.model;
      }
      if (next.status === 'closed' || next.status === 'exited') control.approvals = [];
    }
    control.queued = !!(next && next.queued);
    if (next && next.error) control.lastError = next.error;
    updateControlChrome();
    renderApproval();
    if (state.historyDone) renderStats();
  }

  function bindControlStream(es) {
    control.current = null;
    control.approvals = [];
    control.queued = false;
    control.lastError = '';
    control.attachments = [];
    renderAttachments();
    updateControlChrome();

    es.addEventListener('meta', (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data && data.control) {
        if (data.control.enabled === true) control.enabled = true;
        handleControlState(data.control);
      } else {
        control.current = null;
        updateControlChrome();
      }
      renderApproval();
    });
    es.addEventListener('control', (event) => {
      try { handleControlState(JSON.parse(event.data)); } catch { /* ignore */ }
    });
    es.addEventListener('approval', (event) => {
      try { upsertApproval(JSON.parse(event.data)); } catch { /* ignore */ }
    });
    es.addEventListener('approvalDone', (event) => {
      try {
        const done = JSON.parse(event.data);
        control.approvals = control.approvals.filter((a) => a.approvalId !== done.approvalId);
        renderApproval();
        setStatus(done.decision === 'cancelled' ? 'approval cancelled' : `approval ${done.decision === 'approve' ? 'approved' : 'rejected'}`);
      } catch { /* ignore */ }
    });
    es.addEventListener('controlError', (event) => {
      try {
        const err = JSON.parse(event.data);
        control.lastError = err.message || 'control error';
        setStatus(control.lastError, 'err');
      } catch { /* ignore */ }
    });
  }

  function upsertApproval(approval) {
    if (!approval || !approval.approvalId) return;
    const index = control.approvals.findIndex((a) => a.approvalId === approval.approvalId);
    if (index >= 0) {
      // The card changed under the reviewer: hold Approve for a moment so a click aimed at the old one cannot land on the new one.
      if ((control.approvals[index].revision || 1) !== (approval.revision || 1)) {
        control.holdApproveUntil = Date.now() + 1200;
        setTimeout(renderApproval, 1250);
      }
      control.approvals[index] = approval;
    } else {
      control.approvals.push(approval);
    }
    renderApproval();
  }

  function diffText(diff) {
    const path = diff.path || '(file)';
    const oldLines = String(diff.oldText || '').split('\n').map((line) => `- ${line}`).join('\n');
    const newLines = String(diff.newText || '').split('\n').map((line) => `+ ${line}`).join('\n');
    return `${path}${diff.isNew ? ' (new file)' : ''}\n--- old\n${oldLines}\n+++ new\n${newLines}`;
  }

  /**
   * The card shows what the agent will actually do (command, files, edits)
   * first, and the title the agent wrote for it last: a harmless title over a
   * dangerous input is the cheapest way to fool a reviewer.
   */
  function approvalText(approval) {
    const parts = [];
    if (approval.approveBlock === 'no-details') {
      parts.push('The agent sent no command or file details, so there is nothing to review. It cannot be approved here. Reject it, or Stop the turn.');
    } else if (approval.canApprove === false) {
      parts.push('This agent offered no allow-once option, so it cannot be approved here. Reject it, or Stop the turn.');
    }
    if ((approval.revision || 1) > 1) {
      const what = Array.isArray(approval.changed) && approval.changed.length
        ? `the agent changed its ${approval.changed.join(' and ')} after this first appeared. What is shown is the latest version.`
        : 'the agent added details after this first appeared. What is shown is the latest version.';
      parts.push(`UPDATED: ${what}`);
    }
    if (approval.command) parts.push(`$ ${approval.command}`);
    const diffs = approval.diffs && approval.diffs.length ? approval.diffs : (approval.diff ? [approval.diff] : []);
    const diffPaths = new Set(diffs.map((diff) => diff.path));
    const places = (approval.locations || []).filter((place) => !diffPaths.has(place.path));
    if (places.length) parts.push(places.map((place) => `${place.path}${place.line ? `:${place.line}` : ''}`).join('\n'));
    for (const diff of diffs) parts.push(diffText(diff));
    if (!parts.length || (!approval.command && !diffs.length && !places.length)) {
      if (approval.content) parts.push(approval.content);
      else if (approval.rawInput) parts.push(JSON.stringify(approval.rawInput, null, 2));
      else if (approval.approveBlock !== 'no-details') parts.push('(the agent sent no command or file details)');
    }
    if (approval.truncated) parts.push('(the input is larger than what is shown here)');
    if (approval.title) parts.push(`the agent calls this: ${approval.title}`);
    return parts.join('\n\n');
  }

  /** Header of the card: tool kind and the first file, from the raw input. */
  function approvalHead(approval) {
    const diff = approval.diffs && approval.diffs[0] ? approval.diffs[0] : approval.diff;
    const place = (approval.locations && approval.locations[0]) || diff || null;
    const where = place && place.path ? ` · ${place.path}` : (approval.command ? ' · command' : '');
    return `${approval.kind || approval.toolKind || 'request'}${where}`;
  }

  function renderApproval() {
    const panel = $c('approvalPanel');
    const badge = $c('approvalBadge');
    updateControlChrome();
    if (!panel || !badge) return;
    const approval = control.approvals[0] || null;
    if (!approval || control.locked || !control.enabled) {
      panel.classList.add('hidden');
      badge.classList.add('hidden');
      return;
    }
    $c('approvalTool').textContent = approvalHead(approval);
    $c('approvalDetail').textContent = approvalText(approval);
    const held = Date.now() < (control.holdApproveUntil || 0);
    $c('approvalApprove').disabled = control.busy || approval.canApprove === false || held;
    $c('approvalApprove').title = approval.approveBlock === 'no-details'
      ? 'The agent sent no details to review'
      : (approval.canApprove === false ? 'No allow-once option was offered' : (held ? 'This request just changed: read it again' : ''));
    panel.classList.remove('hidden');
    badge.classList.remove('hidden');
    badge.textContent = control.approvals.length > 1
      ? `⚠ ${control.approvals.length} APPROVALS`
      : '⚠ APPROVAL';
    badge.title = approvalHead(approval) || 'Approval needed';
    if (document.activeElement !== $c('approvalReason') && document.activeElement !== $c('composerInput')) {
      $c('approvalApprove').focus({ preventScroll: true });
    }
  }

  async function resolveApproval(decision) {
    if (control.busy) return;
    const approval = control.approvals[0];
    if (!approval) return;
    const reason = decision === 'reject' ? $c('approvalReason').value.trim() : '';
    control.busy = true;
    $c('approvalApprove').disabled = true;
    $c('approvalReject').disabled = true;
    try {
      const result = await controlFetch('/api/control/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The revision says which version of the card was on screen; a card that changed since is refused.
        body: JSON.stringify({ id: state.sessionId, approvalId: approval.approvalId, decision, reason, revision: approval.revision || 1 }),
      });
      control.approvals = control.approvals.filter((a) => a.approvalId !== approval.approvalId);
      $c('approvalReason').value = '';
      if (result && result.decision === 'cancelled') setStatus('rejected: the agent offered no reject option, so the request was cancelled');
      else setStatus(decision === 'approve' ? 'approved' : 'rejected');
    } catch (err) {
      control.lastError = err.message;
      setStatus(err.message, 'err');
    } finally {
      control.busy = false;
      $c('approvalApprove').disabled = false;
      $c('approvalReject').disabled = false;
      renderApproval();
    }
  }

  async function sendMessage() {
    const input = $c('composerInput');
    const text = input.value;
    const images = control.attachments.map(({ mimeType, data }) => ({ mimeType, data }));
    if (!text.trim() && !images.length) return;
    try {
      const result = await controlFetch('/api/control/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.sessionId, text, images }),
      });
      input.value = '';
      control.attachments = [];
      renderAttachments();
      control.queued = !!result.queued;
      control.lastError = '';
      setStatus(result.queued ? 'queued — sends when the current turn ends' : 'sent');
      updateControlChrome();
    } catch (err) {
      control.lastError = err.message;
      setStatus(err.message, 'err');
    }
  }

  async function stopTurn() {
    try {
      await controlFetch('/api/control/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.sessionId }),
      });
      setStatus('stopping…');
    } catch (err) {
      setStatus(err.message, 'err');
    }
  }

  async function endSession() {
    if (!window.confirm('End this owned session? It becomes view-only and its agent process stops.')) return;
    try {
      await controlFetch('/api/control/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.sessionId }),
      });
      setStatus('session ended');
      updateControlChrome();
    } catch (err) {
      setStatus(err.message, 'err');
    }
  }

  /* ---------- new session dialog ---------- */
  /** The harness picked in the dialog, from the options the server sent. */
  function dialogHarness() {
    const list = (control.options && control.options.harnesses) || [];
    const picked = $c('dlgHarness') ? $c('dlgHarness').value : '';
    return list.find((h) => h.id === picked) || list.find((h) => h.id === (control.options && control.options.defaultHarness)) || list[0] || null;
  }

  function dialogPreset() {
    const harness = dialogHarness();
    const id = $c('dlgPreset').value;
    return harness ? harness.presets.find((p) => p.id === id) || null : null;
  }

  /** The harness picker exists only when there is a choice; dsh alone shows nothing new. */
  function harnessRow() {
    let row = $c('dlgHarnessRow');
    if (!row) {
      row = document.createElement('label');
      row.id = 'dlgHarnessRow';
      row.className = 'hidden';
      row.appendChild(document.createTextNode('HARNESS'));
      const select = document.createElement('select');
      select.id = 'dlgHarness';
      // Never an empty select: a placeholder until the options arrive.
      const loading = document.createElement('option');
      loading.value = '';
      loading.textContent = 'loading…';
      select.appendChild(loading);
      row.appendChild(select);
      $c('dlgPreset').closest('label').before(row);
      select.addEventListener('change', applyDialogHarness);
    }
    return row;
  }

  /** Presets and the command line that will run, for the chosen harness. */
  function applyDialogHarness() {
    const harness = dialogHarness();
    const select = $c('dlgPreset');
    if (harness) {
      select.textContent = '';
      for (const preset of harness.presets) {
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = preset.label || preset.id;
        select.appendChild(opt);
      }
      select.value = harness.defaultPreset;
      $c('dlgProfile').textContent = `runs: ${harness.commandLine}`;
    }
    const preset = dialogPreset();
    $c('dangerRow').classList.toggle('hidden', !(preset && preset.danger));
    $c('dlgDanger').checked = false;
  }

  async function openNewSession() {
    if (!control.enabled || control.locked) return;
    const dialog = $c('newSessionDialog');
    $c('dlgErr').textContent = '';
    showDetails(detailsFold('dlgDetails', $c('dlgErr')), '');
    $c('dlgStep').textContent = 'workspace';
    $c('dlgStep2').classList.add('hidden');
    $c('dlgContinue').classList.remove('hidden');
    $c('dlgStart').classList.add('hidden');
    $c('dlgWorkspace').disabled = false;
    $c('dlgPreset').disabled = false;
    $c('dlgDanger').checked = false;
    $c('dlgDanger').disabled = false;
    $c('dlgMessage').value = '';
    $c('dlgModel').innerHTML = '';
    control.dialogSession = null;
    control.dialogCancelled = false;
    control.starting = false;
    harnessRow().classList.add('hidden');
    $c('dlgHarness').disabled = false;
    $c('dangerRow').classList.toggle('hidden', $c('dlgPreset').value !== 'danger-full-access');
    dialog.showModal();
    try {
      const data = await controlFetch('/api/control/options');
      control.options = data;
      const select = $c('dlgWorkspace');
      select.innerHTML = '';
      if (!data.workspaces.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'no workspaces configured — add paths to control.json';
        select.appendChild(opt);
      } else {
        for (const workspace of data.workspaces) {
          const opt = document.createElement('option');
          opt.value = workspace.path;
          opt.textContent = workspace.label ? `${workspace.label} — ${workspace.path}` : workspace.path;
          select.appendChild(opt);
        }
      }
      const harnesses = Array.isArray(data.harnesses) ? data.harnesses : [];
      const picker = $c('dlgHarness');
      picker.textContent = '';
      for (const harness of harnesses) {
        const opt = document.createElement('option');
        opt.value = harness.id;
        opt.textContent = harness.label || harness.id;
        picker.appendChild(opt);
      }
      if (!harnesses.length) {
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'no harness configured';
        picker.appendChild(none);
      }
      if (harnesses.length) picker.value = data.defaultHarness || harnesses[0].id;
      harnessRow().classList.toggle('hidden', harnesses.length < 2);
      if (harnesses.length) applyDialogHarness();
      else {
        $c('dlgProfile').textContent = `profile: ${data.dshProfile || 'acp'}`;
        // An empty list is a config mistake (a "harnesses" block with nothing usable), not "dsh".
        $c('dlgErr').textContent = data.harnessesError || 'no harness is configured: check the "harnesses" block of control.json';
      }
    } catch (err) {
      $c('dlgErr').textContent = err.message;
    }
  }

  async function continueNewSession() {
    if (!control.enabled || control.locked) return;
    if (control.dialogSession) return;
    const cwd = $c('dlgWorkspace').value;
    const harness = dialogHarness();
    const preset = $c('dlgPreset').value;
    const danger = !!(dialogPreset() && dialogPreset().danger);
    if (!cwd) { $c('dlgErr').textContent = 'choose a workspace from the allowlist'; return; }
    if (danger && !$c('dlgDanger').checked) {
      $c('dlgErr').textContent = `tick the confirmation to use ${preset}`;
      return;
    }
    if (harness && !harness.viewable) {
      // Without a log adapter the page has nothing to render the session from.
      $c('dlgErr').textContent = `agenttail cannot show sessions of ${harness.label} yet, so it will not start one`;
      return;
    }
    $c('dlgErr').textContent = '';
    showDetails(detailsFold('dlgDetails', $c('dlgErr')), '');
    control.starting = true;
    $c('dlgContinue').disabled = true;
    $c('dlgContinue').textContent = 'Starting the agent…';
    try {
      const data = await controlFetch('/api/control/session/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, preset, confirmDanger: danger, ...(harness ? { harness: harness.id } : {}) }),
      });
      if (control.dialogCancelled) {
        await controlFetch('/api/control/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: data.session.id }),
        }).catch(() => {});
        return;
      }
      control.dialogSession = data.session;
      const modelSelect = $c('dlgModel');
      modelSelect.innerHTML = '';
      const option = modelOption(data.session);
      if (option) fillChoices(modelSelect, option, modelGroup);
      // An agent with no model list has nothing to choose; hide the row.
      modelSelect.closest('label').classList.toggle('hidden', !modelSelect.options.length);
      if (modelSelect.options.length) modelSelect.value = data.currentModel || modelSelect.options[0].value;
      $c('dlgStep').textContent = modelSelect.options.length ? 'model + first message' : 'first message';
      $c('dlgStep2').classList.remove('hidden');
      $c('dlgWorkspace').disabled = true;
      $c('dlgPreset').disabled = true;
      $c('dlgDanger').disabled = true;
      $c('dlgHarness').disabled = true;
      $c('dlgContinue').classList.add('hidden');
      $c('dlgStart').classList.remove('hidden');
      $c('dlgMessage').focus();
    } catch (err) {
      $c('dlgErr').textContent = err.message;
      showDetails(detailsFold('dlgDetails', $c('dlgErr')), err.details);
    } finally {
      control.starting = false;
      $c('dlgContinue').disabled = false;
      $c('dlgContinue').textContent = 'Continue →';
    }
  }

  async function startNewSession() {
    if (!control.dialogSession) return;
    const message = $c('dlgMessage').value;
    if (!message.trim()) { $c('dlgErr').textContent = 'write the first message'; return; }
    $c('dlgErr').textContent = '';
    control.starting = true;
    $c('dlgStart').disabled = true;
    $c('dlgStart').textContent = 'Starting…';
    try {
      const data = await controlFetch('/api/control/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: control.dialogSession.id,
          model: $c('dlgModel').value,
          message,
        }),
      });
      const id = data.session.id;
      control.dialogSession = null;
      control.starting = false;
      $c('newSessionDialog').close();
      state.source = 'dsh';
      $c('sourceSelect').value = 'dsh';
      sessionKey = '';
      loadSessions(false);
      openSession(id);
      setStatus('session started — waiting for the first log frame…');
    } catch (err) {
      $c('dlgErr').textContent = err.message;
    } finally {
      control.starting = false;
      $c('dlgStart').disabled = false;
      $c('dlgStart').textContent = 'Start session';
    }
  }

  async function closeNewSession() {
    const dialog = $c('newSessionDialog');
    control.dialogCancelled = true;
    if (control.starting && !control.dialogSession) {
      if (dialog.open) dialog.close();
      return;
    }
    if (control.dialogSession && !control.starting) {
      try {
        await controlFetch('/api/control/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: control.dialogSession.id }),
        });
      } catch { /* best effort */ }
    }
    control.dialogSession = null;
    if (dialog.open) dialog.close();
  }

  /* ---------- cost-per-turn sparkline ---------- */
  function drawTurnSpark() {
    const canvas = $c('turnSpark');
    if (!canvas) return;
    const wrap = $c('turnSparkWrap');
    const data = (state.turnCosts || []).slice(-24);
    if (!data.length) { wrap?.classList.add('hidden'); return; }
    const costs = data.map((entry) => Number(entry.cost) || 0);
    const tokens = data.map((entry) => Number(entry.tokens) || 0);
    const useCost = costs.some((value) => value > 0);
    const values = useCost ? costs : tokens;
    const max = Math.max(1e-9, ...values);
    wrap?.classList.remove('hidden');
    const label = $c('turnSparkLabel');
    if (label) label.textContent = useCost ? '$/TURN' : 'TOK/TURN';
    // One bar per finished turn, newest on the right. A minimum height keeps
    // equal (or tiny) turns visible as bars instead of a flat line.
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const slot = canvas.width / Math.max(values.length, 6);
    const barW = Math.max(2, slot - 2);
    const base = useCost ? cssVar('--green', '#37f28a') : cssVar('--cyan', '#5ce1e6');
    values.forEach((value, index) => {
      const h = Math.max(4, (value / max) * (canvas.height - 2));
      const x = canvas.width - (values.length - index) * slot + 1;
      ctx.globalAlpha = index === values.length - 1 ? 1 : 0.55;
      ctx.fillStyle = base;
      ctx.fillRect(x, canvas.height - h, barW, h);
    });
    ctx.globalAlpha = 1;
    const last = data[data.length - 1];
    const total = values.reduce((a, b) => a + b, 0);
    const tip = useCost
      ? `Cost per turn, newest on the right (last ${data.length} turns)\nlast turn $${Number(last.cost || 0).toFixed(4)} · total $${total.toFixed(4)} · highest $${max.toFixed(4)}`
      : `Tokens per turn, newest on the right (last ${data.length} turns; no price for this model)\nlast turn ${fmtInt(Number(last.tokens || 0))} · highest ${fmtInt(max)}`;
    canvas.title = tip;
    if (wrap) wrap.title = tip;
  }

  /* ---------- wiring ---------- */
  $c('newSessionBtn').addEventListener('click', openNewSession);
  $c('dlgContinue').addEventListener('click', continueNewSession);
  $c('dlgStart').addEventListener('click', startNewSession);
  $c('dlgCancel').addEventListener('click', closeNewSession);
  $c('dlgPreset').addEventListener('change', () => {
    const preset = dialogPreset();
    const danger = preset ? preset.danger : $c('dlgPreset').value === 'danger-full-access';
    $c('dangerRow').classList.toggle('hidden', !danger);
  });
  $c('newSessionDialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    closeNewSession();
  });

  $c('composerSend').addEventListener('click', sendMessage);
  $c('composerStop').addEventListener('click', stopTurn);
  $c('composerEnd').addEventListener('click', endSession);
  $c('composerModel').addEventListener('change', switchModel);
  $c('composerInput').addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    addImages(files);
  });
  $c('composerInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  $c('composerInput').addEventListener('input', syncComposerInput);
  // An error from an empty first message goes away once there is a message.
  $c('dlgMessage').addEventListener('input', () => {
    if ($c('dlgErr').textContent === 'write the first message' && $c('dlgMessage').value.trim()) $c('dlgErr').textContent = '';
  });

  $c('approvalApprove').addEventListener('click', () => resolveApproval('approve'));
  $c('approvalReject').addEventListener('click', () => resolveApproval('reject'));
  $c('approvalReason').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); resolveApproval('reject'); }
  });
  $c('approvalBadge').addEventListener('click', (event) => {
    event.stopPropagation();
    $c('approvalPanel').scrollIntoView({ block: 'nearest' });
    $c('approvalApprove').focus();
  });

  window.bindControlStream = bindControlStream;
  window.drawTurnSpark = drawTurnSpark;
  window.__control = { state: control, status: controlStatus, drawTurnSpark };
  controlStatus().then(() => updateControlChrome());
  drawTurnSpark();
})();
