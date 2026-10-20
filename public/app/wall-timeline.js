// Watch wall strip widget: the team timeline.
// Loaded by index.html as a classic script, in order with the others.
/* ---------- watch wall strip widget: live team timeline ---------- */
(() => {
  'use strict';

  const ROW_H = 20;
  const RULER_H = 16;
  const MAX_MARKS = 20000;
  const POP_MS = 460;
  const FRAME_MS = 1000 / 30;
  const ZOOM_MINUTES = [2, 10, 30, 60];
  const DEFAULT_RANGE = 10 * 60 * 1000;
  const BAND_MS = 2000;
  const EDIT_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'notebook_edit']);
  const TICK_FONT = '9px "JetBrains Mono", "Cascadia Mono", Consolas, monospace';
  const microtask = typeof queueMicrotask === 'function' ? (fn) => queueMicrotask(fn) : (fn) => Promise.resolve().then(fn);
  const motionQuery = (() => {
    try { return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null; } catch { return null; }
  })();

  const colorCtx = document.createElement('canvas').getContext('2d');
  let activeWidget = null;

  function normalizeColor(value, fallback, depth = 0) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return fallback;
    if (depth < 4) {
      const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(raw);
      if (m) {
        let resolved = '';
        try { resolved = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim(); } catch { /* ignore */ }
        if (resolved) return normalizeColor(resolved, fallback, depth + 1);
        if (m[2]) return normalizeColor(m[2], fallback, depth + 1);
        return fallback;
      }
    }
    if (!colorCtx) return fallback;
    colorCtx.fillStyle = '#010203';
    const sentinel = colorCtx.fillStyle;
    colorCtx.fillStyle = raw;
    const out = colorCtx.fillStyle;
    if (out === sentinel) {
      const compact = raw.toLowerCase().replace(/\s+/g, '');
      if (compact !== '#010203' && compact !== 'rgb(1,2,3)') return fallback;
    }
    return out;
  }

  function themeColors() {
    let cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch { /* ignore */ }
    const read = (name, fallback) => normalizeColor(cs ? cs.getPropertyValue(name).trim() : '', fallback);
    return {
      accent: read('--green', '#37f28a'),
      red: read('--red', '#ff5f6d'),
      dim: read('--muted', '#5f7c6a'),
      line: read('--line-soft', '#0d2118'),
      text: read('--text', '#c8f7d4'),
    };
  }

  function reduced() {
    return !!(motionQuery && motionQuery.matches);
  }

  function oneLine(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function clipText(value, max) {
    const s = oneLine(value);
    return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
  }

  function clockText(ms, seconds) {
    const d = new Date(Number(ms) || 0);
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    if (!seconds) return `${h}:${m}`;
    return `${h}:${m}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  function exitCode(text) {
    const m = /\[exit code:\s*(-?\d+)\]/i.exec(String(text == null ? '' : text));
    return m ? Number(m[1]) : null;
  }

  function tickStep(range) {
    if (range <= 2 * 60 * 1000) return 30 * 1000;
    if (range <= 10 * 60 * 1000) return 60 * 1000;
    if (range <= 30 * 60 * 1000) return 5 * 60 * 1000;
    return 10 * 60 * 1000;
  }

  function appendsRow(ev) {
    if (!ev) return false;
    if (ev.t === 'call' || ev.t === 'job' || ev.t === 'jobEnd') return true;
    if (ev.t === 'say') return !!(ev.thinking || ev.text);
    if (ev.t === 'user') return !!(ev.text && !ev.system);
    return false;
  }

  function create(wall) {
    const slot = wall && wall.slots && wall.slots.timeline;
    if (!slot) return null;
    const doc = slot.ownerDocument || document;
    const panes = Array.isArray(wall.panes) ? wall.panes.slice() : [];
    const root = doc.createElement('div');
    root.className = 'ws-tl-root';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Team timeline');

    const bar = doc.createElement('div');
    bar.className = 'ws-tl-bar';
    const title = doc.createElement('span');
    title.className = 'ws-tl-title';
    title.textContent = 'Team timeline';
    bar.appendChild(title);
    const zoom = doc.createElement('div');
    zoom.className = 'ws-tl-zoom';
    zoom.setAttribute('role', 'group');
    zoom.setAttribute('aria-label', 'Timeline window');
    bar.appendChild(zoom);

    const body = doc.createElement('div');
    body.className = 'ws-tl-body';
    const labels = doc.createElement('div');
    labels.className = 'ws-tl-labels';
    const spacer = doc.createElement('div');
    spacer.className = 'ws-tl-labels-spacer';
    spacer.style.height = RULER_H + 'px';
    labels.appendChild(spacer);
    const wrap = doc.createElement('div');
    wrap.className = 'ws-tl-canvas-wrap';
    const canvas = doc.createElement('canvas');
    canvas.className = 'ws-tl-canvas';
    canvas.setAttribute('aria-label', 'Events per agent over time');
    wrap.appendChild(canvas);
    body.appendChild(labels);
    body.appendChild(wrap);
    root.appendChild(bar);
    root.appendChild(body);

    const tip = doc.createElement('div');
    tip.className = 'ws-tl-tip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-hidden', 'true');
    root.appendChild(tip);
    slot.appendChild(root);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      root.remove();
      return null;
    }

    const state = {
      disposed: false,
      rangeMs: DEFAULT_RANGE,
      colors: themeColors(),
      width: 0,
      height: 0,
      dpr: 1,
    };
    const marks = [];
    const callMarks = new Map();
    const tracks = [];
    const byPane = new Map();
    const zoomButtons = [];
    const flashTimers = new Set();
    const flashAnims = new Set();
    let raf = 0;
    let lastDraw = 0;
    let hoverMark = null;
    let tipMark = null;
    let disposed = false;

    function makeTrack(pane, index) {
      const agent = (pane && pane.agent) || {};
      const source = agent.sourceLabel || agent.source || 'agent';
      const branch = agent.repo && agent.repo.branch ? String(agent.repo.branch) : '';
      const key = String(agent.key || (pane && pane.root && pane.root.dataset && pane.root.dataset.key) || `agent-${index}`);
      const label = doc.createElement('div');
      label.className = 'ws-tl-label';
      label.style.height = ROW_H + 'px';
      const dot = doc.createElement('span');
      dot.className = 'ws-tl-dot';
      const text = doc.createElement('span');
      text.className = 'ws-tl-label-text';
      text.textContent = branch ? `${source} · ${branch}` : source;
      label.title = agent.title ? `${text.textContent} — ${agent.title}` : text.textContent;
      label.appendChild(dot);
      label.appendChild(text);
      labels.appendChild(label);
      const track = { row: index, pane, key, label: text.textContent, dot, color: state.colors.accent };
      byPane.set(pane, track);
      return track;
    }

    for (let i = 0; i < panes.length; i++) tracks.push(makeTrack(panes[i], i));

    function paneColor(pane, fallback) {
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
      return normalizeColor(raw, fallback);
    }

    function paintLabels() {
      for (const track of tracks) {
        track.color = paneColor(track.pane, state.colors.accent);
        track.dot.style.background = track.color;
        track.dot.style.boxShadow = `0 0 4px ${track.color}`;
      }
    }
    paintLabels();

    for (const minutes of ZOOM_MINUTES) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = `${minutes}m`;
      button.title = `Show the last ${minutes} minutes`;
      button.dataset.ms = String(minutes * 60 * 1000);
      button.setAttribute('aria-pressed', minutes === 10 ? 'true' : 'false');
      if (minutes === 10) button.classList.add('active');
      button.addEventListener('click', () => {
        if (disposed) return;
        state.rangeMs = minutes * 60 * 1000;
        for (const b of zoomButtons) {
          const on = Number(b.dataset.ms) === state.rangeMs;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      });
      zoom.appendChild(button);
      zoomButtons.push(button);
    }

    function trackFor(pane) {
      const direct = byPane.get(pane);
      if (direct) return direct;
      if (pane && pane.agent) {
        for (const track of tracks) {
          if (track.pane && track.pane.agent && track.pane.agent.key === pane.agent.key) return track;
        }
      }
      if (pane && pane.root && pane.root.dataset) {
        for (const track of tracks) {
          if (track.pane && track.pane.root && track.pane.root.dataset && track.pane.root.dataset.key === pane.root.dataset.key) return track;
        }
      }
      return null;
    }

    function lowerBound(t) {
      let lo = 0;
      let hi = marks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (marks[mid].t < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    function visibleMarks(from, to) {
      const out = [];
      for (let i = lowerBound(from); i < marks.length && marks[i].t <= to; i++) out.push(marks[i]);
      return out;
    }

    function callKey(track, callId) {
      return `${track.row}\u0000${callId}`;
    }

    function prune() {
      const extra = marks.length - MAX_MARKS;
      if (extra <= 0) return;
      const removed = marks.splice(0, extra);
      for (const mark of removed) {
        const key = mark.callId ? callKey(mark.track, mark.callId) : '';
        if (key && callMarks.get(key) === mark) callMarks.delete(key);
      }
    }

    function addMark(mark) {
      let i = marks.length;
      while (i > 0 && marks[i - 1].t > mark.t) i--;
      marks.splice(i, 0, mark);
      if (mark.callId) callMarks.set(callKey(mark.track, mark.callId), mark);
      prune();
    }

    function describeCall(ev) {
      const args = (ev && ev.args) || {};
      if (ev.name === 'pwsh') return { kind: 'command', desc: `$ ${clipText(args.command || 'pwsh', 220)}` };
      if (EDIT_TOOLS.has(ev.name)) return { kind: 'edit', desc: `✎ ${clipText(args.file_path || ev.name || 'edit', 220)}` };
      const detail = args.file_path || args.pattern || args.description || '';
      return { kind: 'tool', desc: `⚙ ${ev.name || 'tool'}${detail ? ' · ' + clipText(detail, 180) : ''}` };
    }

    function markFor(track, ev) {
      const t = Number(ev.time);
      const time = Number.isFinite(t) && t >= 0 ? t : Date.now();
      const mark = {
        key: track.key,
        t: time,
        kind: 'tool',
        error: false,
        status: null,
        exit: null,
        desc: '',
        callId: null,
        row: null,
        feedIndex: null,
        track,
        born: 0,
        thinking: false,
        system: false,
      };
      if (ev.t === 'call') {
        const d = describeCall(ev);
        mark.kind = d.kind;
        mark.desc = d.desc;
        mark.callId = ev.callId || null;
      } else if (ev.t === 'say') {
        mark.kind = 'say';
        mark.thinking = !ev.text && !!ev.thinking;
        mark.desc = `✦ ${clipText(ev.text || ev.thinking || 'reply', 80)}`;
      } else if (ev.t === 'user') {
        mark.kind = 'user';
        mark.system = !!ev.system;
        mark.desc = `${ev.system ? '⟐' : '▸'} ${clipText(ev.text || '', 80)}`;
      } else if (ev.t === 'job') {
        mark.kind = 'job';
        mark.desc = `▶ ${clipText(ev.label || 'job', 140)}`;
      } else if (ev.t === 'jobEnd') {
        mark.kind = 'jobEnd';
        mark.error = /fail|error|cancel/i.test(String(ev.status || '') + ' ' + String(ev.detail || ''));
        mark.status = mark.error ? 'error' : 'ok';
        mark.desc = `■ job ${clipText(ev.status || 'ended', 100)}`;
      } else if (ev.t === 'result') {
        mark.kind = 'result';
        const exit = exitCode(ev.text);
        mark.error = !!ev.isError || (exit !== null && exit !== 0);
        mark.exit = exit;
        mark.status = mark.error ? 'error' : 'ok';
        mark.desc = `↳ ${clipText(ev.text || 'result', 160)}`;
      } else {
        return null;
      }
      return mark;
    }

    function bindRow(mark, pane, ev) {
      if (!appendsRow(ev) || !pane || !pane.feed) return;
      const feed = pane.feed;
      mark.feedIndex = feed.childElementCount;
      microtask(() => {
        if (disposed) return;
        const row = feed.lastElementChild;
        if (row) mark.row = row;
      });
    }

    function onPaneEvent(pane, ev) {
      if (disposed || !pane || !ev) return;
      const track = trackFor(pane);
      if (!track) return;
      if (ev.t === 'result') {
        const mark = ev.callId ? callMarks.get(callKey(track, ev.callId)) : null;
        if (mark) {
          const exit = exitCode(ev.text);
          mark.error = !!ev.isError || (exit !== null && exit !== 0);
          mark.exit = exit;
          mark.status = mark.error ? 'error' : 'ok';
          if (tipMark === mark) buildTip(mark);
          return;
        }
      }
      const mark = markFor(track, ev);
      if (!mark) return;
      mark.pane = pane;
      if (!pane.history) mark.born = performance.now();
      addMark(mark);
      bindRow(mark, pane, ev);
    }

    function computeBands(list, left, right) {
      const bands = [];
      const counts = new Map();
      let distinct = 0;
      let start = 0;
      let current = null;
      for (let end = 0; end < list.length; end++) {
        const mark = list[end];
        const row = mark.track.row;
        const count = (counts.get(row) || 0) + 1;
        counts.set(row, count);
        if (count === 1) distinct++;
        while (mark.t - list[start].t > BAND_MS) {
          const oldRow = list[start].track.row;
          const oldCount = counts.get(oldRow) - 1;
          if (oldCount <= 0) {
            counts.delete(oldRow);
            distinct--;
          } else {
            counts.set(oldRow, oldCount);
          }
          start++;
        }
        if (distinct >= 2) {
          let top = Infinity;
          let bottom = -1;
          for (const row of counts.keys()) {
            if (row < top) top = row;
            if (row > bottom) bottom = row;
          }
          const t0 = Math.max(left, list[start].t);
          const t1 = Math.min(right, mark.t);
          if (current && t0 <= current.t1 + 1) {
            if (t0 < current.t0) current.t0 = t0;
            if (t1 > current.t1) current.t1 = t1;
            if (top < current.top) current.top = top;
            if (bottom > current.bottom) current.bottom = bottom;
          } else {
            current = { t0, t1, top, bottom };
            bands.push(current);
          }
        } else {
          current = null;
        }
      }
      return bands;
    }

    function resize() {
      if (disposed) return;
      const rect = wrap.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = RULER_H + Math.max(1, tracks.length) * ROW_H + 2;
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      canvas.style.height = height + 'px';
      state.width = width;
      state.height = height;
      state.dpr = dpr;
    }

    function currentView() {
      const now = Date.now();
      const left = now - state.rangeMs;
      const plotL = 3;
      const plotR = Math.max(plotL + 1, state.width - 3);
      return { now, left, right: now, plotL, plotR, plotW: plotR - plotL };
    }

    function drawMark(mark, x, cy, scale, alpha) {
      const color = mark.error ? state.colors.red : mark.track.color;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      if (mark.kind === 'command') {
        const s = 6.5 * scale;
        ctx.fillRect(x - s / 2, cy - s / 2, s, s);
      } else if (mark.kind === 'edit') {
        const s = 7 * scale;
        ctx.beginPath();
        ctx.moveTo(x, cy - s / 2);
        ctx.lineTo(x + s / 2, cy);
        ctx.lineTo(x, cy + s / 2);
        ctx.lineTo(x - s / 2, cy);
        ctx.closePath();
        ctx.fill();
      } else if (mark.kind === 'user') {
        const w = Math.max(2, 2.6 * scale);
        const h = 15 * scale;
        ctx.fillRect(x - w / 2, cy - h / 2, w, h);
      } else if (mark.kind === 'job' || mark.kind === 'jobEnd') {
        const s = 5 * scale;
        ctx.fillRect(x - s / 2, cy - s / 2, s, s);
      } else if (mark.kind === 'tool' || mark.kind === 'result') {
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, cy, 3 * scale, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const r = 3.1 * scale;
        ctx.beginPath();
        ctx.arc(x, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function draw() {
      if (disposed || !state.width || !state.height) return;
      const view = currentView();
      const { now, left, plotL, plotR, plotW } = view;
      const width = state.width;
      const height = state.height;
      const dpr = state.dpr;
      const range = state.rangeMs;
      const xFor = (t) => plotL + ((t - left) / range) * plotW;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const step = tickStep(range);
      const firstTick = Math.ceil(left / step) * step;
      ctx.font = TICK_FONT;
      ctx.textBaseline = 'alphabetic';
      ctx.lineWidth = 1;
      ctx.strokeStyle = state.colors.line;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      for (let t = firstTick; t <= now; t += step) {
        const x = Math.round(xFor(t)) + 0.5;
        if (x < plotL || x > plotR) continue;
        ctx.moveTo(x, RULER_H);
        ctx.lineTo(x, height);
      }
      ctx.stroke();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = state.colors.dim;
      for (let t = firstTick; t <= now; t += step) {
        const x = xFor(t);
        if (x < plotL || x > plotR - 24) continue;
        ctx.fillText(clockText(t, step < 60 * 1000), x + 3, RULER_H - 5);
      }

      ctx.strokeStyle = state.colors.line;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      for (let row = 0; row < tracks.length; row++) {
        const y = RULER_H + row * ROW_H + ROW_H / 2 + 0.5;
        ctx.moveTo(plotL, y);
        ctx.lineTo(plotR, y);
      }
      ctx.stroke();

      const extended = visibleMarks(left - BAND_MS, now);
      const bands = computeBands(extended, left, now);
      ctx.save();
      ctx.beginPath();
      ctx.rect(plotL, RULER_H, plotW, height - RULER_H);
      ctx.clip();

      if (bands.length) {
        ctx.fillStyle = state.colors.accent;
        ctx.globalAlpha = 0.075;
        for (const band of bands) {
          let x0 = xFor(Math.max(band.t0, left));
          let x1 = xFor(Math.min(band.t1, now));
          if (x1 - x0 < 3) {
            const mid = (x0 + x1) / 2;
            x0 = mid - 1.5;
            x1 = mid + 1.5;
          }
          const y0 = RULER_H + band.top * ROW_H + 2;
          const y1 = RULER_H + (band.bottom + 1) * ROW_H - 2;
          ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(2, y1 - y0));
        }
      }

      const perf = performance.now();
      const noMotion = reduced();
      for (const mark of extended) {
        if (mark.t < left || mark.t > now) continue;
        const x = xFor(mark.t);
        if (x < plotL - 8 || x > plotR + 8) continue;
        const cy = RULER_H + mark.track.row * ROW_H + ROW_H / 2;
        let scale = 1;
        let alpha = mark.system || mark.thinking ? 0.62 : 1;
        if (mark.born && !noMotion) {
          const age = perf - mark.born;
          if (age < POP_MS) {
            const p = Math.max(0, age) / POP_MS;
            scale = 0.55 + 0.45 * (1 - Math.pow(1 - p, 3)) + Math.sin(p * Math.PI) * 0.3;
            alpha *= Math.min(1, 0.4 + age / 100);
          }
        }
        drawMark(mark, x, cy, scale, alpha);
        if (hoverMark === mark) {
          ctx.globalAlpha = 0.95;
          ctx.strokeStyle = state.colors.text;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, cy, 6.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      ctx.restore();

      ctx.strokeStyle = state.colors.accent;
      ctx.lineWidth = 1.25;
      ctx.globalAlpha = 0.95;
      const nx = Math.round(xFor(now)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(nx, RULER_H - 2);
      ctx.lineTo(nx, height);
      ctx.stroke();
      ctx.fillStyle = state.colors.accent;
      ctx.beginPath();
      ctx.moveTo(nx - 3, RULER_H - 2);
      ctx.lineTo(nx + 3, RULER_H - 2);
      ctx.lineTo(nx, RULER_H + 2);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    function markAt(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      if (y < RULER_H - 2) return null;
      const row = Math.floor((y - RULER_H) / ROW_H);
      if (row < 0 || row >= tracks.length) return null;
      const view = currentView();
      const list = visibleMarks(view.left - BAND_MS, view.right);
      let best = null;
      let bestDistance = Infinity;
      for (const mark of list) {
        if (mark.track.row !== row || mark.t < view.left || mark.t > view.right) continue;
        const mx = view.plotL + ((mark.t - view.left) / state.rangeMs) * view.plotW;
        const cy = RULER_H + row * ROW_H + ROW_H / 2;
        const dx = Math.abs(x - mx);
        const dy = Math.abs(y - cy);
        if (dx > 7 || dy > 8) continue;
        const distance = dx * dx + dy * dy;
        if (distance <= bestDistance) {
          best = mark;
          bestDistance = distance;
        }
      }
      return best;
    }

    function statusGlyph(mark) {
      if (mark.kind === 'command' || mark.kind === 'edit' || mark.kind === 'tool') {
        if (mark.status === 'error') return '✗';
        if (mark.status === 'ok') return '✓';
      }
      if (mark.kind === 'jobEnd') return mark.error ? '✗' : '✓';
      if (mark.kind === 'result') return mark.error ? '✗' : '✓';
      return '';
    }

    function buildTip(mark) {
      tip.textContent = '';
      const agent = doc.createElement('div');
      agent.className = 'ws-tl-tip-agent';
      agent.textContent = mark.track.label;
      const time = doc.createElement('div');
      time.className = 'ws-tl-tip-time';
      time.textContent = clockText(mark.t, true);
      const desc = doc.createElement('div');
      desc.className = 'ws-tl-tip-desc';
      const glyph = statusGlyph(mark);
      if (glyph) {
        const status = doc.createElement('span');
        status.className = mark.error ? 'ws-tl-tip-bad' : 'ws-tl-tip-ok';
        status.textContent = glyph + ' ';
        desc.appendChild(status);
      }
      desc.appendChild(doc.createTextNode(mark.desc || mark.kind));
      tip.appendChild(agent);
      tip.appendChild(time);
      tip.appendChild(desc);
    }

    function hideTip() {
      tip.classList.remove('show');
      tip.setAttribute('aria-hidden', 'true');
      tipMark = null;
    }

    function showTip(mark, clientX, clientY) {
      if (tipMark !== mark) {
        buildTip(mark);
        tipMark = mark;
      }
      tip.classList.add('show');
      tip.setAttribute('aria-hidden', 'false');
      const rect = root.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let left = clientX - rect.left + 12;
      let top = clientY - rect.top + 14;
      if (left + tw > root.clientWidth - 4) left = clientX - rect.left - tw - 12;
      if (top + th > root.clientHeight - 2) top = clientY - rect.top - th - 10;
      tip.style.left = Math.max(3, Math.round(left)) + 'px';
      tip.style.top = Math.max(3, Math.round(top)) + 'px';
    }

    function rowFor(mark) {
      if (mark.row && mark.row.isConnected) return mark.row;
      const pane = mark.pane || mark.track.pane;
      const feed = pane && pane.feed;
      if (!feed || !feed.children || !Number.isInteger(mark.feedIndex)) return null;
      return feed.children[mark.feedIndex] || null;
    }

    function flashRow(row) {
      const accent = state.colors.accent;
      if (reduced() || typeof row.animate !== 'function') {
        const previous = row.style.boxShadow;
        row.style.boxShadow = `inset 0 0 0 2px ${accent}`;
        const timer = setTimeout(() => {
          row.style.boxShadow = previous;
          flashTimers.delete(timer);
        }, 500);
        flashTimers.add(timer);
        return;
      }
      try {
        const anim = row.animate(
          [{ boxShadow: `inset 0 0 0 2px ${accent}` }, { boxShadow: 'inset 0 0 0 2px transparent' }],
          { duration: 650, easing: 'ease-out' },
        );
        flashAnims.add(anim);
        anim.onfinish = () => {
          flashAnims.delete(anim);
          try { anim.cancel(); } catch { /* ignore */ }
        };
      } catch {
        const previous = row.style.boxShadow;
        row.style.boxShadow = `inset 0 0 0 2px ${accent}`;
        const timer = setTimeout(() => {
          row.style.boxShadow = previous;
          flashTimers.delete(timer);
        }, 500);
        flashTimers.add(timer);
      }
    }

    function scrollToRow(mark, row) {
      const pane = mark.pane || mark.track.pane;
      const feed = pane && pane.feed;
      if (!feed) return;
      const rr = row.getBoundingClientRect();
      const fr = feed.getBoundingClientRect();
      const target = feed.scrollTop + (rr.top - fr.top) - (feed.clientHeight - rr.height) / 2;
      const max = Math.max(0, feed.scrollHeight - feed.clientHeight);
      const top = Math.max(0, Math.min(max, target));
      const smooth = !reduced();
      try {
        if (smooth && typeof feed.scrollTo === 'function') feed.scrollTo({ top, behavior: 'smooth' });
        else feed.scrollTop = top;
      } catch {
        feed.scrollTop = top;
      }
      flashRow(row);
    }

    function onMove(ev) {
      if (disposed) return;
      const mark = markAt(ev.clientX, ev.clientY);
      if (!mark) {
        if (hoverMark) {
          hoverMark = null;
          hideTip();
        }
        return;
      }
      hoverMark = mark;
      showTip(mark, ev.clientX, ev.clientY);
    }

    function onLeave() {
      if (disposed) return;
      hoverMark = null;
      hideTip();
    }

    function onClick(ev) {
      if (disposed) return;
      const mark = markAt(ev.clientX, ev.clientY);
      if (!mark) return;
      const row = rowFor(mark);
      if (row) scrollToRow(mark, row);
    }

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('click', onClick);

    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(onResize);
      try { resizeObserver.observe(wrap); } catch { /* ignore */ }
    }

    let themeObserver = null;
    if (typeof MutationObserver === 'function') {
      themeObserver = new MutationObserver(() => {
        if (disposed) return;
        state.colors = themeColors();
        paintLabels();
      });
      try {
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
      } catch { /* ignore */ }
    }

    function frame(ts) {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      if (ts - lastDraw < FRAME_MS) return;
      lastDraw = ts;
      draw();
    }

    const api = {
      onPaneEvent,
      dispose,
      marks() {
        return marks.map((mark) => ({ key: mark.key, t: mark.t, kind: mark.kind, error: !!mark.error }));
      },
    };

    function dispose() {
      if (disposed) return;
      disposed = true;
      state.disposed = true;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch { /* ignore */ }
        resizeObserver = null;
      }
      if (themeObserver) {
        try { themeObserver.disconnect(); } catch { /* ignore */ }
        themeObserver = null;
      }
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('click', onClick);
      for (const timer of flashTimers) clearTimeout(timer);
      flashTimers.clear();
      for (const anim of flashAnims) {
        try { anim.cancel(); } catch { /* ignore */ }
      }
      flashAnims.clear();
      hideTip();
      try { root.remove(); } catch { /* ignore */ }
      if (activeWidget === api) activeWidget = null;
    }

    activeWidget = api;
    resize();
    raf = requestAnimationFrame(frame);
    return api;
  }

  window.__wallTimeline = {
    marks() {
      return activeWidget ? activeWidget.marks() : [];
    },
  };

  window.__wallStripHooks = window.__wallStripHooks || [];
  window.__wallStripHooks.push({
    name: 'timeline',
    create(wall) {
      try {
        return create(wall);
      } catch (err) {
        console.error('timeline widget failed', err);
        return null;
      }
    },
  });
})();
