// Console stage: while the agent runs a command the console comes up over the
// editor; when it edits, the console goes back to its dock; when the console
// has nothing to show it shrinks to a rail; while the agent thinks, a small
// window with the agenttail mascot sits over the editor.
// Loaded by index.html as a classic script, after main.js.
/* ---------- console stage ---------- */
(() => {
  const MODE_KEY = 'agenttail-console-mode';
  const cfg = {
    lingerMs: 2500,     // a finished command stays on stage this long
    idleMs: 15000,      // a console with no new lines for this long shrinks
    holdMs: 45000,      // opening the rail keeps the console out this long
    thinkDelayMs: 900,  // short thoughts do not flash the window
    glyphMs: 900,
  };
  const GLYPHS = ['{ }', '( )', ';', 'λ', '?', '</>', '#', '=>', '…', '[ ]'];

  let mode = 'stage';
  try { if (localStorage.getItem(MODE_KEY) === 'docked') mode = 'docked'; } catch { /* ignore */ }

  const pane = $('terminalPane');
  const home = $('bottomArea');
  const homeBefore = $('consoleChatSplitter');
  const wrap = $('editorWrap');

  const s = {
    staged: false,
    min: false,
    thinking: false,
    wasRunning: false,
    runEndedAt: 0,
    consoleAt: Date.now(),
    holdUntil: 0,
    glyph: 0,
    glyphTimer: 0,
  };

  /* --- the rail the console shrinks to --- */
  const rail = document.createElement('button');
  rail.id = 'consoleRail';
  rail.type = 'button';
  const railIcon = document.createElement('b');
  railIcon.textContent = '$';
  const railText = document.createElement('span');
  railText.className = 'cr-text';
  const railState = document.createElement('i');
  railState.className = 'cr-state';
  rail.append(railIcon, railState, railText);
  home.insertBefore(rail, home.firstChild);
  rail.addEventListener('click', () => {
    s.holdUntil = Date.now() + cfg.holdMs;
    s.consoleAt = Date.now();
    update();
  });

  /* --- the mode switch in the console header --- */
  const modeBtn = document.createElement('button');
  modeBtn.id = 'consoleMode';
  modeBtn.type = 'button';
  modeBtn.className = 'panel-btn';
  pane.querySelector('.panel-title').appendChild(modeBtn);
  modeBtn.addEventListener('click', () => setMode(mode === 'stage' ? 'docked' : 'stage'));

  /* --- the thinking window --- */
  const card = document.createElement('div');
  card.id = 'thinkCard';
  card.setAttribute('aria-hidden', 'true');
  // Static markup only: the mascot is the logo's prompt chevron with an eye,
  // and the logo's trailing dots float up into a thought bubble.
  card.innerHTML = `
    <svg class="tail-mascot" viewBox="0 0 128 96" aria-hidden="true">
      <ellipse class="tm-shadow" cx="31" cy="91" rx="13" ry="2.4"/>
      <g class="tm-body">
        <path class="tm-chevron" d="M18 44 L44 64 L18 84"/>
        <circle class="tm-eye" cx="36" cy="45" r="3"/>
        <circle class="tm-glint" cx="37.1" cy="43.9" r=".9"/>
      </g>
      <g class="tm-thought">
        <circle class="tm-dot d1" cx="54" cy="56" r="2.6"/>
        <circle class="tm-dot d2" cx="63" cy="45" r="3.4"/>
        <circle class="tm-dot d3" cx="73" cy="34" r="4.2"/>
        <rect class="tm-cloud" x="76" y="6" width="48" height="28" rx="14"/>
        <text class="tm-glyph" x="100" y="24.5" text-anchor="middle">{ }</text>
      </g>
    </svg>
    <div class="tc-text">
      <div class="tc-head"><b>THINKING</b><span class="tc-time"></span></div>
      <div class="tc-line"></div>
    </div>`;
  wrap.appendChild(card);
  const glyphEl = card.querySelector('.tm-glyph');
  const timeEl = card.querySelector('.tc-time');
  const lineEl = card.querySelector('.tc-line');

  try {
    term.onLineFeed(() => { s.consoleAt = Date.now(); });
  } catch { /* older xterm: the console never counts as idle */ }

  function fit() {
    requestAnimationFrame(() => { try { ensureTermFit(); } catch { /* not ready */ } });
  }

  /** Stage acts on sessions in motion: live, idle between turns, or replaying. A finished one keeps the dock. */
  function active() {
    return mode === 'stage' && (state.replaying || (state.historyDone && (!!state.live || state.state === 'idle')));
  }

  function place(onStage) {
    if (onStage && pane.parentElement !== wrap) {
      wrap.appendChild(pane);
      pane.classList.add('staged');
      wrap.classList.add('has-stage');
      fit();
    } else if (!onStage && pane.parentElement !== home) {
      home.insertBefore(pane, homeBefore);
      pane.classList.remove('staged');
      wrap.classList.remove('has-stage');
      fit();
    }
  }

  function railLabel() {
    if (s.staged) return state.lastCommand ? `running ${state.lastCommand}` : 'running';
    return state.lastCommand || 'console';
  }

  function showGlyphs(on) {
    if (on && !s.glyphTimer) {
      s.glyphTimer = setInterval(() => {
        s.glyph = (s.glyph + 1) % GLYPHS.length;
        glyphEl.textContent = GLYPHS[s.glyph];
      }, cfg.glyphMs);
    } else if (!on && s.glyphTimer) {
      clearInterval(s.glyphTimer);
      s.glyphTimer = 0;
    }
  }

  function update() {
    const now = Date.now();
    const on = active();
    const running = on && activity.kind === 'running';
    if (running) {
      s.wasRunning = true;
    } else if (s.wasRunning) {
      s.wasRunning = false;
      s.runEndedAt = now;
    }
    // An edit takes the stage back at once; otherwise a finished command lingers.
    s.staged = running || (on && s.staged && activity.kind !== 'editing' && now - s.runEndedAt < cfg.lingerMs);
    s.min = on && !s.staged && state.runningJobs.size === 0
      && now - s.consoleAt > cfg.idleMs && now >= s.holdUntil;
    s.thinking = on && !s.staged && activity.kind === 'thinking' && now - activity.startedAt > cfg.thinkDelayMs;

    place(s.staged);
    const out = s.staged || s.min;
    const body = document.body;
    const changed = body.classList.contains('stage-out') !== out;
    body.classList.toggle('console-stage', on);
    body.classList.toggle('stage-out', out);
    body.classList.toggle('stage-min', s.min);
    if (changed) fit();

    rail.title = s.staged ? 'The console is over the editor while the command runs' : 'Open the console';
    railText.textContent = railLabel();
    railState.textContent = s.staged ? '▲' : state.lastCommandOk === false ? '✗' : state.lastCommandOk === true ? '✓' : '';
    railState.className = `cr-state ${s.staged ? 'run' : state.lastCommandOk === false ? 'bad' : 'ok'}`;

    card.classList.toggle('show', s.thinking);
    card.setAttribute('aria-hidden', String(!s.thinking));
    showGlyphs(s.thinking);
    if (s.thinking) {
      timeEl.textContent = `${Math.max(0, Math.round((now - activity.startedAt) / 1000))} s`;
      lineEl.textContent = activity.label && activity.label !== 'command finished' ? activity.label : '';
    }

    modeBtn.textContent = mode === 'stage' ? '⇱ STAGE' : '▭ DOCKED';
    modeBtn.title = mode === 'stage'
      ? 'Stage: the console comes up over the editor while a command runs and shrinks when quiet. Click to keep it docked.'
      : 'Docked: the console stays under the editor. Click for the stage.';
    modeBtn.setAttribute('aria-pressed', String(mode === 'stage'));
  }

  function setMode(next) {
    mode = next === 'docked' ? 'docked' : 'stage';
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
    s.holdUntil = 0;
    s.consoleAt = Date.now();
    update();
  }

  // Touching the console keeps it out for a while, like pausing follow.
  pane.addEventListener('pointerdown', () => { s.holdUntil = Date.now() + cfg.holdMs; });

  setInterval(update, 1000);
  window.stageUpdate = update;
  window.__stage = {
    get mode() { return mode; },
    setMode,
    cfg,
    state: () => ({ staged: s.staged, min: s.min, thinking: s.thinking, glyph: glyphEl.textContent }),
  };
  update();
})();
