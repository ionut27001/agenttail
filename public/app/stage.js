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
    quipMs: 4500,       // a new line of nonsense this often
    stallMs: 5 * 60_000, // no event for this long: the agent may be stuck
    gameAfterMs: 8000,  // a long think: the mascot gets bored and plays
  };
  const GLYPHS = ['{ }', '( )', ';', 'λ', '?', '</>', '#', '=>', '…', '[ ]'];
  // What the mascot is up to while the model thinks. Not true, mostly.
  const QUIPS = [
    'coding life', 'catching kittens', 'what is 42', 'chasing its own tail', 'counting semicolons',
    'asking the rubber duck', 'untangling spaghetti', 'reading the docs (for once)', 'negotiating with the compiler',
    'petting the linter', 'sharpening regexes', 'off by one, back by two', 'renaming things (the hard part)',
    'looking for the missing bracket', 'tail -f /dev/thoughts', 'grepping the universe', 'it works on my machine',
    'turning it off and on again', 'mining for edge cases', 'folding the call stack', 'brewing tea for the tests',
    'dividing by zero, carefully', 'warming up the cache', 'polishing the diff', 'consulting the stack trace tarot',
    'herding race conditions', 'teaching the cat git', 'waiting for npm', 'befriending the borrow checker',
    'naming a variable x2', 'shaving a yak', 'wagging the tail',
  ];
  const STALL_QUIPS = ['chasing its own tail', 'staring into the void', 'still here, probably', 'waiting for the model to wake up'];

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
    quip: '',
    quipAt: 0,
    playing: false,
    human: false,       // you have the controls of the game
  };
  const reducedMotion = (() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return null; }
  })();

  /** A random line, never the one just shown. */
  function nextQuip(list) {
    let q = s.quip;
    for (let i = 0; i < 5 && q === s.quip; i++) q = list[Math.floor(Math.random() * list.length)];
    return q;
  }

  /** 42 s, 3m 05s, 1h 02m */
  function clock(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return `${sec} s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${String(sec % 60).padStart(2, '0')}s`;
    return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
  }

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
  // Static markup only. The window is Tail's thought bubble (buddy.js draws
  // Tail and the dots that rise to it). Games play inside; you can take over.
  card.innerHTML = `
    <div class="tc-bubble">
      <canvas class="tail-game" aria-hidden="true"></canvas>
      <div class="tc-text">
        <div class="tc-head"><b class="tc-title">THINKING</b><span class="tc-time"></span><span class="tc-glyph">{ }</span></div>
        <div class="tc-quip"></div>
        <div class="tc-game"></div>
        <div class="tc-line"></div>
        <div class="tc-controls">
          <button type="button" class="tc-play" title="Take the controls (Esc gives them back)">▶ play</button>
          <button type="button" class="tc-next" title="Another game (N)">↻ next</button>
          <button type="button" class="tc-stop" title="Stop playing (Esc)">✕</button>
        </div>
      </div>
    </div>`;
  const buddy = window.__buddy || null;
  (buddy ? buddy.slot : wrap).appendChild(card);
  const glyphEl = card.querySelector('.tc-glyph');
  const titleEl = card.querySelector('.tc-title');
  const timeEl = card.querySelector('.tc-time');
  const quipEl = card.querySelector('.tc-quip');
  const lineEl = card.querySelector('.tc-line');

  /* --- the mascot's games (mascot-games.js): snake, tetris, runner, chess, chomp --- */
  const games = window.__mascotGames || null;
  const canvas = card.querySelector('.tail-game');
  const gameEl = card.querySelector('.tc-game');
  const game = { current: null, order: [], colors: null, raf: 0, last: 0, frames: 0, captionAt: 0 };
  const RECORDS_KEY = 'agenttail-tail-records';
  let records = {};
  try { records = JSON.parse(localStorage.getItem(RECORDS_KEY) || '{}') || {}; } catch { records = {}; }

  /** Your best per game, kept across sessions; Tail's own runs count too. */
  function noteRecord() {
    const g = game.current;
    if (!g || typeof g.score !== 'function') return null;
    const score = g.score();
    if (score > (records[g.name] || 0)) {
      records[g.name] = score;
      try { localStorage.setItem(RECORDS_KEY, JSON.stringify(records)); } catch { /* ignore */ }
    }
    return records[g.name] || 0;
  }

  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    return {
      accent: v('--green'), dim: v('--green-dim'), cyan: v('--cyan'), amber: v('--amber'), red: v('--red'),
      ok: v('--ok'), purple: v('--purple'), orange: v('--orange'), text: v('--text-strong'), muted: v('--muted'),
      line: v('--line'), bg: v('--bg-deep'), panel: v('--panel'),
    };
  }

  /** The next game in a shuffled round, so every game comes up before one repeats. */
  function nextGame() {
    if (!game.order.length) {
      game.order = games.names.slice();
      for (let i = game.order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [game.order[i], game.order[j]] = [game.order[j], game.order[i]];
      }
    }
    game.current = games.create(game.order.shift());
    game.colors = themeColors();
    game.captionAt = 0;
    if (s.human) {
      if (typeof game.current.input === 'function') game.current.human = true;
      else nextGame(); // chess only replays; skip it while you play
    }
    card.classList.toggle('watch-only', typeof game.current.input !== 'function');
  }

  /** Hand the controls to you, or back to Tail. */
  function setHuman(on) {
    on = !!on && !!game.current && typeof game.current.input === 'function';
    if (on === s.human) return;
    s.human = on;
    card.classList.toggle('human', on);
    if (game.current) game.current.human = on;
    if (on) card.querySelector('.tc-bubble').focus({ preventScroll: true });
    update();
  }

  function frame(t) {
    if (!s.playing || !game.current) return;
    const dt = Math.min(0.05, (t - (game.last || t)) / 1000);
    game.last = t;
    game.current.step(dt, t / 1000);
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    if (canvas.width !== Math.round(games.W * dpr)) {
      canvas.width = Math.round(games.W * dpr);
      canvas.height = Math.round(games.H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, games.W, games.H);
    game.current.draw(ctx, game.colors, t / 1000);
    game.frames += 1;
    if (t - game.captionAt > 300) {
      game.captionAt = t;
      const record = noteRecord();
      gameEl.textContent = `${game.current.caption()}${record ? ` · ★ ${record}` : ''}`;
    }
    game.raf = requestAnimationFrame(frame);
  }

  function play(on) {
    if (on && !games) return;
    if (on === s.playing) return;
    s.playing = on;
    card.classList.toggle('playing', on);
    if (buddy) buddy.el.classList.toggle('playing', on);
    if (on) {
      nextGame();
      game.last = 0;
      game.raf = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(game.raf);
      setHuman(false);
      game.current = null;
      gameEl.textContent = '';
    }
  }

  card.querySelector('.tc-bubble').tabIndex = -1;
  card.querySelector('.tc-play').addEventListener('click', (e) => { e.stopPropagation(); setHuman(true); });
  card.querySelector('.tc-next').addEventListener('click', (e) => { e.stopPropagation(); if (s.playing) nextGame(); });
  card.querySelector('.tc-stop').addEventListener('click', (e) => { e.stopPropagation(); setHuman(false); });

  // While you play, the game gets the arrow keys and space; Esc gives it back, N skips.
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  function onKey(e) {
    if (!s.human || !game.current || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.type === 'keydown' && k === 'Escape') { setHuman(false); e.preventDefault(); return; }
    if (e.type === 'keydown' && k === 'n') { nextGame(); e.preventDefault(); return; }
    if (e.repeat && k !== ' ') { e.preventDefault(); return; }
    if (game.current.input(e.type === 'keydown' ? 'down' : 'up', k)) { e.preventDefault(); e.stopPropagation(); }
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);

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

    // While you play, the bubble stays open even after the agent stops thinking.
    const showCard = s.thinking || s.human;
    card.classList.toggle('show', showCard);
    card.setAttribute('aria-hidden', String(!showCard));
    // The log's own clock, so a stuck session reads as stuck right after a reload too.
    const quiet = now - (state.stats.lastTime || activity.lastEventAt || now);
    const stalled = s.thinking && quiet > cfg.stallMs;
    // A stalled agent puts the mascot to sleep; a long think gets it playing.
    showGlyphs(s.thinking && !stalled);
    if (stalled !== s.wasStalled) {
      // Falling asleep or waking up changes the bubble and the line at once.
      s.wasStalled = stalled;
      glyphEl.textContent = stalled ? 'z z z' : GLYPHS[s.glyph];
      s.quip = '';
    }
    play(s.human || (s.thinking && !stalled && now - activity.startedAt > cfg.gameAfterMs && !(reducedMotion && reducedMotion.matches)));
    if (buddy) buddy.el.classList.toggle('stalled', stalled);
    if (s.human) {
      card.classList.remove('stalled');
      titleEl.textContent = 'YOU PLAY';
      const doing = s.thinking ? `thinking · ${clock(now - activity.startedAt)}` : `${activity.kind}${activity.label ? ` · ${activity.label}` : ''}`;
      timeEl.textContent = `agent ${doing}`.slice(0, 64);
      quipEl.textContent = game.current && game.current.controls ? game.current.controls : '';
      lineEl.textContent = 'esc: back to Tail · n: next game';
      s.quip = '';
    } else if (s.thinking) {
      card.classList.toggle('stalled', stalled);
      titleEl.textContent = stalled ? 'STALLED?' : 'THINKING';
      timeEl.textContent = stalled ? `no output for ${clock(quiet)}` : clock(now - activity.startedAt);
      if (!s.quip || now - s.quipAt > cfg.quipMs) {
        s.quip = nextQuip(stalled ? STALL_QUIPS : QUIPS);
        s.quipAt = now;
        quipEl.textContent = `${s.quip}…`;
      }
      lineEl.textContent = activity.label && activity.label !== 'command finished' ? activity.label : '';
    } else {
      s.quip = '';
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
    state: () => ({ staged: s.staged, min: s.min, thinking: s.thinking, glyph: glyphEl.textContent, quip: s.quip, stalled: card.classList.contains('stalled'), playing: s.playing, human: !!s.human, game: game.current ? game.current.name : null, frames: game.frames, score: game.current && game.current.score ? game.current.score() : null }),
    setHuman,
    records: () => ({ ...records }),
    games: games ? games.names : [],
    quips: QUIPS,
  };
  update();
})();
