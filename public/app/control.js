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
  };
  const MAX_ATTACHMENTS = 4;
  const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
  const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  const $c = (id) => document.getElementById(id);

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
      text = 'this owned session ended — view only';
    } else if (control.enabled && !control.token) {
      text = 'control token missing — reopen the URL printed by the server';
      kind = 'err';
    }
    hint.textContent = text;
    hint.className = `control-hint${text ? '' : ' hidden'}${kind ? ' ' + kind : ''}`;

    renderModelPicker(canType ? c : null);
    const stop = $c('composerStop');
    const end = $c('composerEnd');
    if (stop) stop.disabled = !(canType && c && c.running);
    if (end) end.disabled = !canType;
    if (canType) {
      if (c.running) setStatus('turn running · Stop cancels it · a message sent now will be queued');
      else if (control.queued) setStatus('queued — sends when the current turn ends');
      else if (control.lastError) setStatus(control.lastError, 'err');
      else setStatus(`Enter sends · Shift+Enter newline${c.model ? ` · ${c.provider ? c.provider + '/' : ''}${c.model}` : ''}`);
    }
    const badge = $c('approvalBadge');
    if (badge) badge.classList.toggle('hidden', control.approvals.length === 0 || control.locked || !control.enabled);
  }

  /** The live dsh catalog for this session; switching applies to the next turn. */
  function renderModelPicker(session) {
    const select = $c('composerModel');
    if (!select) return;
    const models = session && Array.isArray(session.models) ? session.models : [];
    select.classList.toggle('hidden', models.length < 2);
    const signature = models.map((m) => m.value).join('|');
    if (select.dataset.signature !== signature) {
      select.textContent = '';
      if (!models.length) {
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '—';
        select.appendChild(none);
      }
      const groups = new Map();
      for (const model of models) {
        const key = model.provider || 'other';
        if (!groups.has(key)) {
          const group = document.createElement('optgroup');
          group.label = key;
          groups.set(key, group);
          select.appendChild(group);
        }
        const opt = document.createElement('option');
        opt.value = model.value;
        opt.textContent = model.name || model.value;
        groups.get(key).appendChild(opt);
      }
      select.dataset.signature = signature;
    }
    if (session && session.modelValue && document.activeElement !== select) select.value = session.modelValue;
    select.disabled = control.modelBusy;
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
    if (!control.current || control.current.images !== true) {
      setStatus('this agent does not accept images (dsh ACP has no image prompts)', 'warn');
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
    if (index >= 0) control.approvals[index] = approval;
    else control.approvals.push(approval);
    renderApproval();
  }

  function approvalText(approval) {
    if (approval.command) return `$ ${approval.command}`;
    if (approval.diff) {
      const path = approval.diff.path || '(file)';
      const oldLines = String(approval.diff.oldText || '').split('\n').map((line) => `- ${line}`).join('\n');
      const newLines = String(approval.diff.newText || '').split('\n').map((line) => `+ ${line}`).join('\n');
      return `${path}\n--- old\n${oldLines}\n+++ new\n${newLines}`;
    }
    if (approval.content) return approval.content;
    if (approval.rawInput) return JSON.stringify(approval.rawInput, null, 2);
    return approval.title || '(no command details were sent)';
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
    $c('approvalTool').textContent = approval.title + (approval.kind ? ` · ${approval.kind}` : '');
    $c('approvalDetail').textContent = approvalText(approval);
    panel.classList.remove('hidden');
    badge.classList.remove('hidden');
    badge.textContent = control.approvals.length > 1
      ? `⚠ ${control.approvals.length} APPROVALS`
      : '⚠ APPROVAL';
    badge.title = approval.title || 'Approval needed';
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
      await controlFetch('/api/control/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.sessionId, approvalId: approval.approvalId, decision, reason }),
      });
      control.approvals = control.approvals.filter((a) => a.approvalId !== approval.approvalId);
      $c('approvalReason').value = '';
      setStatus(decision === 'approve' ? 'approved' : 'rejected');
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
      input.style.height = 'auto';
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
  async function openNewSession() {
    if (!control.enabled || control.locked) return;
    const dialog = $c('newSessionDialog');
    $c('dlgErr').textContent = '';
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
    $c('dangerRow').classList.toggle('hidden', $c('dlgPreset').value !== 'danger-full-access');
    dialog.showModal();
    try {
      const data = await controlFetch('/api/control/options');
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
      $c('dlgProfile').textContent = `profile: ${data.dshProfile || 'acp'}`;
    } catch (err) {
      $c('dlgErr').textContent = err.message;
    }
  }

  async function continueNewSession() {
    if (!control.enabled || control.locked) return;
    if (control.dialogSession) return;
    const cwd = $c('dlgWorkspace').value;
    const preset = $c('dlgPreset').value;
    if (!cwd) { $c('dlgErr').textContent = 'choose a workspace from the allowlist'; return; }
    if (preset === 'danger-full-access' && !$c('dlgDanger').checked) {
      $c('dlgErr').textContent = 'tick the confirmation to use danger-full-access';
      return;
    }
    $c('dlgErr').textContent = '';
    control.starting = true;
    $c('dlgContinue').disabled = true;
    $c('dlgContinue').textContent = 'Starting dsh…';
    try {
      const data = await controlFetch('/api/control/session/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, preset, confirmDanger: preset === 'danger-full-access' }),
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
      const groups = new Map();
      for (const model of data.models || []) {
        const key = model.provider || 'other';
        if (!groups.has(key)) {
          const group = document.createElement('optgroup');
          group.label = key;
          groups.set(key, group);
          modelSelect.appendChild(group);
        }
        const opt = document.createElement('option');
        opt.value = model.value;
        opt.textContent = model.name || model.model || model.value;
        groups.get(key).appendChild(opt);
      }
      if (modelSelect.options.length) modelSelect.value = data.currentModel || modelSelect.options[0].value;
      else $c('dlgErr').textContent = 'dsh did not advertise a model for this profile';
      $c('dlgStep').textContent = 'model + first message';
      $c('dlgStep2').classList.remove('hidden');
      $c('dlgWorkspace').disabled = true;
      $c('dlgPreset').disabled = true;
      $c('dlgDanger').disabled = true;
      $c('dlgContinue').classList.add('hidden');
      $c('dlgStart').classList.remove('hidden');
      $c('dlgMessage').focus();
    } catch (err) {
      $c('dlgErr').textContent = err.message;
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
    $c('dangerRow').classList.toggle('hidden', $c('dlgPreset').value !== 'danger-full-access');
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
  $c('composerInput').addEventListener('input', () => {
    const input = $c('composerInput');
    input.style.height = 'auto';
    input.style.height = `${Math.min(150, input.scrollHeight)}px`;
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
