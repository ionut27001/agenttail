// Tail's thought bubble: the window that opens while an agent thinks, with a
// clock, a line of nonsense and, on a long think, one of Tail's games that you
// can take over. The main view (stage.js) and every watch-wall pane
// (wall-tail.js) each own one.
// Loaded by index.html as a classic script, after the games and buddy.js.
/* ---------- Tail's thought bubble ---------- */
(() => {
  const cfg = {
    glyphMs: 900,
    quipMs: 4500,        // a new line of nonsense this often
    stallMs: 5 * 60_000, // no event for this long: the agent may be stuck
    gameAfterMs: 8000,   // a long think: the mascot gets bored and plays
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

  const games = window.__mascotGames || null;
  const reducedMotion = (() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return null; }
  })();

  /* --- records: your best per game, kept across sessions; Tail's own runs count too --- */
  const RECORDS_KEY = 'agenttail-tail-records';
  let records = {};
  try { records = JSON.parse(localStorage.getItem(RECORDS_KEY) || '{}') || {}; } catch { records = {}; }
  function noteRecord(g) {
    if (!g || typeof g.score !== 'function') return null;
    const score = g.score();
    if (score > (records[g.name] || 0)) {
      records[g.name] = score;
      try { localStorage.setItem(RECORDS_KEY, JSON.stringify(records)); } catch { /* ignore */ }
    }
    return records[g.name] || 0;
  }

  /** 42 s, 3m 05s, 1h 02m */
  function clock(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return `${sec} s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${String(sec % 60).padStart(2, '0')}s`;
    return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
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

  // Only one bubble has your controls at a time; the keys go to that one.
  const all = new Set();
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  function onKey(e) {
    if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    for (const b of all) if (b.key(e)) return;
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);

  /**
   * A bubble in `host`. opts: { id, onPlaying(on) }. Feed it update(info) about
   * once a second, where info is { thinking, startedAt, quietMs, label, doing }.
   */
  function create(host, opts = {}) {
    const card = document.createElement('div');
    if (opts.id) card.id = opts.id;
    card.className = 'think-card';
    card.setAttribute('aria-hidden', 'true');
    // Static markup only.
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
    host.appendChild(card);
    const bubble = card.querySelector('.tc-bubble');
    const glyphEl = card.querySelector('.tc-glyph');
    const titleEl = card.querySelector('.tc-title');
    const timeEl = card.querySelector('.tc-time');
    const quipEl = card.querySelector('.tc-quip');
    const lineEl = card.querySelector('.tc-line');
    const canvas = card.querySelector('.tail-game');
    const gameEl = card.querySelector('.tc-game');

    const s = { thinking: false, stalled: false, playing: false, human: false, quip: '', quipAt: 0, glyph: 0, glyphTimer: 0, info: {} };
    const game = { current: null, order: [], colors: null, raf: 0, last: 0, frames: 0, captionAt: 0 };

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
      if (on) for (const other of all) if (other !== api) other.setHuman(false);
      s.human = on;
      card.classList.toggle('human', on);
      if (game.current) game.current.human = on;
      if (on) bubble.focus({ preventScroll: true });
      update(s.info);
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
        const record = noteRecord(game.current);
        gameEl.textContent = `${game.current.caption()}${record ? ` · ★ ${record}` : ''}`;
      }
      game.raf = requestAnimationFrame(frame);
    }

    function play(on) {
      if (on && !games) return;
      if (on === s.playing) return;
      s.playing = on;
      card.classList.toggle('playing', on);
      if (opts.onPlaying) opts.onPlaying(on);
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

    bubble.tabIndex = -1;
    card.querySelector('.tc-play').addEventListener('click', (e) => { e.stopPropagation(); setHuman(true); });
    card.querySelector('.tc-next').addEventListener('click', (e) => { e.stopPropagation(); if (s.playing) nextGame(); });
    card.querySelector('.tc-stop').addEventListener('click', (e) => { e.stopPropagation(); setHuman(false); });
    card.addEventListener('click', (e) => e.stopPropagation());

    /** While you play, the game gets the arrow keys and space; Esc gives it back, N skips. */
    function key(e) {
      // A bubble that is not on screen never takes keys, whatever state it is in.
      if (!s.human || !game.current || !card.isConnected || card.offsetParent === null) return false;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      // Esc only ends the game, not the wall or a dialog around it.
      if (e.type === 'keydown' && k === 'Escape') { setHuman(false); e.preventDefault(); e.stopPropagation(); return true; }
      // Games that take text (typer) keep N for themselves; Tab skips there.
      const skip = game.current.wantsText ? k === 'Tab' : k === 'n';
      if (e.type === 'keydown' && skip) { nextGame(); e.preventDefault(); return true; }
      if (e.repeat && k !== ' ') { e.preventDefault(); return true; }
      if (game.current.input(e.type === 'keydown' ? 'down' : 'up', k)) { e.preventDefault(); e.stopPropagation(); }
      return true;
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

    /** A random line, never the one just shown. */
    function nextQuip(list) {
      let q = s.quip;
      for (let i = 0; i < 5 && q === s.quip; i++) q = list[Math.floor(Math.random() * list.length)];
      return q;
    }

    function update(info = {}) {
      s.info = info;
      const now = Date.now();
      s.thinking = !!info.thinking;
      // While you play, the bubble stays open even after the agent stops thinking.
      const show = s.thinking || s.human;
      card.classList.toggle('show', show);
      card.setAttribute('aria-hidden', String(!show));
      const quiet = info.quietMs || 0;
      const stalled = s.thinking && quiet > cfg.stallMs;
      // A stalled agent puts the mascot to sleep; a long think gets it playing.
      showGlyphs(s.thinking && !stalled);
      if (stalled !== s.stalled) {
        // Falling asleep or waking up changes the bubble and the line at once.
        s.stalled = stalled;
        glyphEl.textContent = stalled ? 'z z z' : GLYPHS[s.glyph];
        s.quip = '';
      }
      const since = now - (info.startedAt || now);
      play(s.human || (s.thinking && !stalled && since > cfg.gameAfterMs && !(reducedMotion && reducedMotion.matches)));
      if (s.human) {
        card.classList.remove('stalled');
        titleEl.textContent = 'YOU PLAY';
        const doing = s.thinking ? `thinking · ${clock(since)}` : (info.doing || 'working');
        timeEl.textContent = `agent ${doing}`.slice(0, 64);
        quipEl.textContent = game.current && game.current.controls ? game.current.controls : '';
        lineEl.textContent = 'esc: back to Tail · n: next game';
        s.quip = '';
      } else if (s.thinking) {
        card.classList.toggle('stalled', stalled);
        titleEl.textContent = stalled ? 'STALLED?' : 'THINKING';
        timeEl.textContent = stalled ? `no output for ${clock(quiet)}` : clock(since);
        if (!s.quip || now - s.quipAt > cfg.quipMs) {
          s.quip = nextQuip(stalled ? STALL_QUIPS : QUIPS);
          s.quipAt = now;
          quipEl.textContent = `${s.quip}…`;
        }
        lineEl.textContent = info.label || '';
      } else {
        s.quip = '';
      }
      return { stalled };
    }

    function dispose() {
      play(false);
      showGlyphs(false);
      all.delete(api);
      card.remove();
    }

    const api = {
      el: card,
      update,
      setHuman,
      key,
      dispose,
      get showing() { return card.classList.contains('show'); },
      state: () => ({
        thinking: s.thinking, glyph: glyphEl.textContent, quip: s.quip, stalled: card.classList.contains('stalled'),
        playing: s.playing, human: !!s.human, game: game.current ? game.current.name : null, frames: game.frames,
        score: game.current && game.current.score ? game.current.score() : null,
      }),
    };
    all.add(api);
    return api;
  }

  window.__thinkBubble = {
    create,
    cfg,
    clock,
    quips: QUIPS,
    records: () => ({ ...records }),
    games: games ? games.names : [],
  };
})();
