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
  };
  // The bubble's own timings (think-bubble.js) read and write through here too.
  const bubbleCfg = window.__thinkBubble.cfg;
  for (const key of ['glyphMs', 'quipMs', 'stallMs', 'gameAfterMs']) {
    Object.defineProperty(cfg, key, { enumerable: true, get: () => bubbleCfg[key], set: (v) => { bubbleCfg[key] = v; } });
  }
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

  /* --- the thinking window: Tail's thought bubble (think-bubble.js), on Tail (buddy.js) --- */
  const buddy = window.__buddy || null;
  const bubble = window.__thinkBubble.create(buddy ? buddy.slot : wrap, {
    id: 'thinkCard',
    onPlaying: (on) => { if (buddy) buddy.el.classList.toggle('playing', on); },
  });

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
    // With Tail turned off there is no bubble to think in, and no game to run.
    const mascot = document.body.classList.contains('fx-mascot');
    s.thinking = on && mascot && !s.staged && activity.kind === 'thinking' && now - activity.startedAt > cfg.thinkDelayMs;

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

    // The log's own clock, so a stuck session reads as stuck right after a reload too.
    const quiet = now - (state.stats.lastTime || activity.lastEventAt || now);
    // A game you were playing goes away with Tail; it must not keep the keyboard.
    if (!on || !mascot) bubble.setHuman(false);
    const { stalled } = bubble.update({
      thinking: s.thinking,
      startedAt: activity.startedAt,
      quietMs: quiet,
      label: activity.label && activity.label !== 'command finished' ? activity.label : '',
      doing: `${activity.kind}${activity.label ? ` · ${activity.label}` : ''}`,
    });
    if (buddy) buddy.el.classList.toggle('stalled', stalled);

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
    state: () => ({ ...bubble.state(), staged: s.staged, min: s.min, thinking: s.thinking }),
    setHuman: bubble.setHuman,
    records: window.__thinkBubble.records,
    games: window.__thinkBubble.games,
    quips: window.__thinkBubble.quips,
  };
  update();
})();
