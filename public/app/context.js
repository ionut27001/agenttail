// Context meter: used / available tokens, main view and wall panes.
// Loaded by index.html as a classic script, in order with the others.
/* ---------- context meter: used / available tokens ---------- */
(() => {
  const BIG_WINDOW = 1000000;
  const CLAUDE_WINDOW = 200000;
  const CLAUDE_RE = /claude|opus|sonnet|haiku|fable/i;

  function fmtTokens(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '?';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(Math.round(n));
  }

  function fmtFull(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '?';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // dsh names the real window on every request. Claude Code does not, so fall
  // back to the window that its model family ships with.
  function resolveWindow(model, contextWindow, used, sessionSource) {
    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      return { window: contextWindow, source: 'from dsh' };
    }
    const name = String(model || '');
    if (/\[1m\]/i.test(name) || /-1m\b/i.test(name)) {
      return { window: BIG_WINDOW, source: 'Claude 1M model' };
    }
    // Claude Code transcripts often carry no model name; the source says enough.
    if (CLAUDE_RE.test(name) || sessionSource === 'claude') {
      // More than 200k in use can only happen on a 1M-context model.
      if (Number.isFinite(used) && used > CLAUDE_WINDOW) return { window: BIG_WINDOW, source: 'Claude 1M (inferred from use)' };
      return { window: CLAUDE_WINDOW, source: 'Claude default' };
    }
    return { window: null, source: 'unknown' };
  }

  function summarize(data) {
    const win = resolveWindow(data.model, data.contextWindow, data.used, data.source);
    const used = data.used;
    const percent = used !== null && win.window ? Math.round((used / win.window) * 100) : null;
    return { used, window: win.window, percent, source: win.source, output: data.output || 0 };
  }

  function colourClass(percent) {
    if (percent === null) return '';
    if (percent >= 90) return 'hot';
    if (percent >= 75) return 'warn';
    return '';
  }

  function barWidth(used, win) {
    if (!win || used === null) return '0%';
    return `${Math.max(0, Math.min(100, (used / win) * 100))}%`;
  }

  function tooltip(s) {
    const lines = [
      `Context used: ${s.used === null ? 'unknown' : fmtTokens(s.used) + ' tokens (' + fmtFull(s.used) + ')'}`,
      `Window: ${s.window === null ? 'unknown' : fmtTokens(s.window) + ' tokens (' + fmtFull(s.window) + ')'}`,
      `Window source: ${s.source}`,
      `Used: ${s.percent === null ? 'unknown' : s.percent + '%'}`,
    ];
    if (s.used !== null) {
      lines.push(`≈ ${fmtTokens(s.used + s.output)} tokens on the next turn (${fmtTokens(s.output)} output joins the context)`);
    }
    lines.push('updates after every reply');
    return lines.join('\n');
  }

  /* ----- main view ----- */
  const meter = document.getElementById('ctxMeter');
  const meterFill = document.getElementById('ctxFill');
  const meterTrack = meter ? meter.querySelector('.ctx-track') : null;
  const meterText = document.getElementById('ctxText');
  const main = { model: null, contextWindow: null, used: null, output: 0 };

  function mainSnapshot() {
    return summarize({
      source: state.source,
      model: main.model,
      contextWindow: main.contextWindow,
      used: main.used,
      output: main.output,
    });
  }

  function rememberSessionModel() {
    try {
      const model = (state.route && state.route.model) || (state.session && state.session.model) || null;
      if (model) main.model = model;
    } catch { /* state is not reachable from here */ }
  }

  function paintMain() {
    if (!meter) return;
    const s = mainSnapshot();
    if (s.used === null) {
      meter.classList.add('hidden');
      meter.classList.remove('warn', 'hot');
      return;
    }
    meter.classList.remove('hidden');
    if (meterTrack) meterTrack.style.display = s.window ? '' : 'none';
    meterText.textContent = s.window
      ? `${fmtTokens(s.used)} / ${fmtTokens(s.window)} · ${s.percent}%`
      : fmtTokens(s.used);
    if (meterFill) meterFill.style.width = barWidth(s.used, s.window);
    const tone = colourClass(s.percent);
    meter.classList.toggle('warn', tone === 'warn');
    meter.classList.toggle('hot', tone === 'hot');
    meter.title = tooltip(s);
  }

  window.__context = {
    get() {
      const s = mainSnapshot();
      return { used: s.used, window: s.window, percent: s.percent, source: s.source };
    },
  };

  window.__contextEvent = (ev) => {
    if (ev.t === 'route') {
      main.model = ev.model || null;
      rememberSessionModel();
      main.contextWindow = Number.isFinite(ev.contextWindow) && ev.contextWindow > 0 ? ev.contextWindow : null;
      paintMain();
    } else if (ev.t === 'say' && ev.usage) {
      rememberSessionModel();
      const u = ev.usage;
      main.used = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      main.output = u.output || 0;
      paintMain();
    }
  };

  window.__contextReset = () => {
    main.model = null;
    main.contextWindow = null;
    main.used = null;
    main.output = 0;
    if (meter) {
      meter.classList.add('hidden');
      meter.classList.remove('warn', 'hot');
      meter.title = '';
    }
    if (meterText) meterText.textContent = '—';
    if (meterTrack) meterTrack.style.display = '';
    if (meterFill) meterFill.style.width = '0%';
  };

  /* ----- watch wall panes ----- */
  const wallData = new WeakMap();

  function paintWall(box, fill, track, label, data) {
    const s = summarize({
      source: data.source,
      model: data.model || data.fallbackModel,
      contextWindow: data.contextWindow || data.fallbackWindow,
      used: data.used,
      output: data.output,
    });
    if (s.used === null) {
      box.classList.add('hidden');
      box.classList.remove('warn', 'hot');
      return;
    }
    box.classList.remove('hidden');
    if (track) track.style.display = s.window ? '' : 'none';
    label.textContent = s.window ? `${s.percent}%` : fmtTokens(s.used);
    if (fill) fill.style.width = barWidth(s.used, s.window);
    const tone = colourClass(s.percent);
    box.classList.toggle('warn', tone === 'warn');
    box.classList.toggle('hot', tone === 'hot');
    box.title = tooltip(s);
  }

  window.__wallHooks = window.__wallHooks || [];
  window.__wallHooks.push({
    name: 'context',
    create(pane) {
      const root = pane && pane.root;
      const head = root && root.querySelector('.wp-head');
      if (!head) return null;
      const box = document.createElement('span');
      box.className = 'wp-ctx hidden';
      const track = document.createElement('span');
      track.className = 'wp-ctx-track';
      const fill = document.createElement('span');
      fill.className = 'wp-ctx-fill';
      track.appendChild(fill);
      const label = document.createElement('span');
      label.className = 'wp-ctx-text';
      box.appendChild(track);
      box.appendChild(label);
      head.insertBefore(box, head.querySelector('.wp-state'));
      const data = {
        model: null,
        contextWindow: null,
        used: null,
        output: 0,
        fallbackModel: (pane.agent && pane.agent.model) ? String(pane.agent.model) : null,
        // The wall replays only a tail; the window logged earlier comes from /api/agents.
        fallbackWindow: pane.agent && Number.isFinite(pane.agent.contextWindow) ? pane.agent.contextWindow : null,
        source: pane.agent ? pane.agent.source : null,
      };
      wallData.set(root, data);
      paintWall(box, fill, track, label, data);
      return {
        onEvent(ev) {
          if (!ev) return;
          if (ev.t === 'route') {
            data.model = ev.model || null;
            data.contextWindow = Number.isFinite(ev.contextWindow) && ev.contextWindow > 0 ? ev.contextWindow : null;
            paintWall(box, fill, track, label, data);
          } else if (ev.t === 'say' && ev.usage) {
            const u = ev.usage;
            data.used = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
            data.output = u.output || 0;
            paintWall(box, fill, track, label, data);
          }
        },
        dispose() {
          wallData.delete(root);
          box.remove();
        },
      };
    },
  });

  window.__wallContext = (paneElement) => {
    const data = paneElement ? wallData.get(paneElement) : null;
    if (!data) return { used: null, window: null, percent: null, source: 'unknown' };
    const s = summarize({
      source: data.source,
      model: data.model || data.fallbackModel,
      contextWindow: data.contextWindow || data.fallbackWindow,
      used: data.used,
      output: data.output,
    });
    return { used: s.used, window: s.window, percent: s.percent, source: s.source };
  };

  paintMain();
})();
