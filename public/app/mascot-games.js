// The mascot's games: when an agent thinks for a while, the mascot plays one
// of these in the thinking window, on its own. Each game draws on a small
// canvas in the theme's colours; stage.js runs the loop.
// Loaded by index.html as a classic script, before stage.js.
/* ---------- mascot games ---------- */
(() => {
  const W = 240;
  const H = 110;
  const TAU = Math.PI * 2;
  const rand = (n) => Math.floor(Math.random() * n);
  const GLYPHS = ['{ }', ';', 'λ', '</>', '=>', '#', '[ ]'];

  /**
   * The mascot: the logo's chevron, apex to the right, with an eye in its
   * opening. (x, y) is its centre; mouth 0..1 closes the arms a little.
   */
  function drawMascot(ctx, c, x, y, size, opts = {}) {
    const { angle = 0, mouth = 0, lookX = 0.5, lookY = -0.3, sleep = false, glow = true } = opts;
    const half = size / 2;
    const spread = size * 0.4 * (1 - Math.min(0.6, mouth));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, size * 0.16);
    ctx.strokeStyle = c.accent;
    if (glow) { ctx.shadowColor = c.accent; ctx.shadowBlur = size * 0.3; }
    ctx.beginPath();
    ctx.moveTo(-half, -spread);
    ctx.lineTo(half, 0);
    ctx.lineTo(-half, spread);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // The eye sits in the middle of the chevron's opening, as big as it fits.
    const ex = -size * 0.23;
    const er = Math.max(1.8, size * 0.16);
    ctx.fillStyle = c.accent;
    if (sleep) {
      ctx.fillRect(ex - er, -0.8, er * 2, 1.6);
    } else {
      ctx.beginPath(); ctx.arc(ex, 0, er, 0, TAU); ctx.fill();
      ctx.fillStyle = c.bg;
      ctx.beginPath(); ctx.arc(ex + lookX * er * 0.5, lookY * er * 0.5, er * 0.5, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  function label(ctx, c, text, x, y, color, size = 9, align = 'left') {
    ctx.font = `${size}px "JetBrains Mono", Consolas, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = color || c.muted;
    ctx.fillText(text, x, y);
  }

  /* ---------- snake: the mascot is the head, its tail dots are the body ---------- */
  function snake() {
    const CELL = 10;
    const COLS = 24;
    const ROWS = 10;
    const OY = 8;
    const DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
    const key = (p) => p.y * COLS + p.x;
    const inside = (p) => p.x >= 0 && p.y >= 0 && p.x < COLS && p.y < ROWS;
    let body; let dir; let food; let timer; let eaten; let best = 0; let dead;

    function place() {
      const taken = new Set(body.map(key));
      const free = [];
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (!taken.has(y * COLS + x)) free.push({ x, y });
      food = free[rand(free.length)];
    }
    function reset() {
      body = [{ x: 6, y: 5 }, { x: 5, y: 5 }, { x: 4, y: 5 }];
      dir = DIRS[0];
      eaten = 0;
      dead = 0;
      timer = 0;
      place();
    }
    /** Cells reachable from start, counting to a cap. */
    function room(start, blocked, cap) {
      const seen = new Set([key(start)]);
      const queue = [start];
      while (queue.length && seen.size < cap) {
        const p = queue.shift();
        for (const d of DIRS) {
          const n = { x: p.x + d.x, y: p.y + d.y };
          if (inside(n) && !blocked.has(key(n)) && !seen.has(key(n))) { seen.add(key(n)); queue.push(n); }
        }
      }
      return seen.size;
    }
    /** First step of a shortest path to the food, or null. */
    function pathStep(head, blocked) {
      const prev = new Map([[key(head), null]]);
      const queue = [head];
      while (queue.length) {
        const p = queue.shift();
        if (p.x === food.x && p.y === food.y) {
          let cur = p;
          while (prev.get(key(cur)) && key(prev.get(key(cur))) !== key(head)) cur = prev.get(key(cur));
          return { x: cur.x - head.x, y: cur.y - head.y };
        }
        for (const d of DIRS) {
          const n = { x: p.x + d.x, y: p.y + d.y };
          if (inside(n) && !blocked.has(key(n)) && !prev.has(key(n))) { prev.set(key(n), p); queue.push(n); }
        }
      }
      return null;
    }
    function choose() {
      const head = body[0];
      const blocked = new Set(body.slice(0, -1).map(key)); // the tail moves out of the way
      const step = pathStep(head, blocked);
      const after = new Set([...blocked, key(head)]);
      if (step && room({ x: head.x + step.x, y: head.y + step.y }, after, body.length + 2) > body.length) return step;
      let pick = null;
      let most = -1;
      for (const d of DIRS) {
        const n = { x: head.x + d.x, y: head.y + d.y };
        if (!inside(n) || blocked.has(key(n))) continue;
        const r = room(n, after, 300);
        if (r > most) { most = r; pick = d; }
      }
      return pick;
    }
    function tick() {
      if (dead) { dead -= 1; if (!dead) reset(); return; }
      const d = choose();
      if (!d) { dead = 10; best = Math.max(best, eaten); return; }
      dir = d;
      const head = { x: body[0].x + d.x, y: body[0].y + d.y };
      body.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        eaten += 1;
        best = Math.max(best, eaten);
        if (body.length > COLS * ROWS - 4) dead = 10; else place();
      } else {
        body.pop();
      }
    }
    const cx = (p) => p.x * CELL + CELL / 2;
    const cy = (p) => OY + p.y * CELL + CELL / 2;
    reset();
    return {
      name: 'snake',
      step(dt) { timer += dt; while (timer > 0.1) { timer -= 0.1; tick(); } },
      draw(ctx, c, t) {
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, OY + 0.5, COLS * CELL - 1, ROWS * CELL - 1);
        const pulse = 2.2 + Math.sin(t * 8) * 0.6;
        ctx.fillStyle = c.cyan;
        ctx.beginPath(); ctx.arc(cx(food), cy(food), pulse, 0, TAU); ctx.fill();
        for (let i = body.length - 1; i >= 1; i--) {
          const k = i / body.length;
          ctx.globalAlpha = dead ? 0.25 + 0.25 * Math.sin(t * 25) : 1 - k * 0.6;
          ctx.fillStyle = c.accent;
          ctx.beginPath(); ctx.arc(cx(body[i]), cy(body[i]), 3.8 - k * 1.8, 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = 1;
        const head = body[0];
        const near = Math.abs(head.x - food.x) + Math.abs(head.y - food.y) <= 1;
        drawMascot(ctx, c, cx(head), cy(head), 11, { angle: Math.atan2(dir.y, dir.x), mouth: near ? 0.6 : 0, sleep: !!dead });
      },
      caption: () => `snake · ${eaten} eaten · best ${best}`,
    };
  }

  /* ---------- tetris: it plays itself, with a small placement AI ---------- */
  function tetris() {
    const COLS = 10;
    const ROWS = 20;
    const CELL = 5;
    const OX = 10;
    const OY = 5;
    const SHAPES = [
      [[0, 1], [1, 1], [2, 1], [3, 1]],
      [[0, 0], [1, 0], [0, 1], [1, 1]],
      [[1, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [2, 0], [0, 1], [1, 1]],
      [[0, 0], [1, 0], [1, 1], [2, 1]],
      [[0, 0], [0, 1], [1, 1], [2, 1]],
      [[2, 0], [0, 1], [1, 1], [2, 1]],
    ];
    const norm = (cells) => {
      const mx = Math.min(...cells.map((p) => p[0]));
      const my = Math.min(...cells.map((p) => p[1]));
      return cells.map(([x, y]) => [x - mx, y - my]);
    };
    const turn = (cells) => norm(cells.map(([x, y]) => [-y, x]));
    function variants(cells) {
      const out = [];
      let cur = norm(cells);
      for (let i = 0; i < 4; i++) {
        const k = cur.map((p) => p.join(',')).sort().join(' ');
        if (!out.some((o) => o.k === k)) out.push({ k, cells: cur });
        cur = turn(cur);
      }
      return out.map((o) => o.cells);
    }
    const empty = () => Array.from({ length: ROWS }, () => Array(COLS).fill(-1));
    const fits = (b, cells, px, py) => cells.every(([x, y]) => {
      const bx = px + x;
      const by = py + y;
      return bx >= 0 && bx < COLS && by >= 0 && by < ROWS && b[by][bx] < 0;
    });
    function evaluate(b) {
      let lines = 0;
      let holes = 0;
      let agg = 0;
      let bump = 0;
      const heights = [];
      for (const row of b) if (row.every((v) => v >= 0)) lines += 1;
      for (let x = 0; x < COLS; x++) {
        let y = 0;
        while (y < ROWS && b[y][x] < 0) y++;
        heights.push(ROWS - y);
        for (let yy = y + 1; yy < ROWS; yy++) if (b[yy][x] < 0) holes += 1;
      }
      for (let x = 0; x < COLS; x++) { agg += heights[x]; if (x) bump += Math.abs(heights[x] - heights[x - 1]); }
      return -0.51 * agg + 0.76 * lines - 0.36 * holes - 0.18 * bump;
    }
    let board; let piece; let next; let lines; let best = 0; let timer; let flash; let over;
    function plan(type) {
      let pick = null;
      for (const cells of variants(SHAPES[type])) {
        const w = Math.max(...cells.map((p) => p[0])) + 1;
        for (let x = 0; x <= COLS - w; x++) {
          if (!fits(board, cells, x, 0)) continue;
          let y = 0;
          while (fits(board, cells, x, y + 1)) y++;
          const b = board.map((r) => r.slice());
          for (const [cx, cy] of cells) b[y + cy][x + cx] = type;
          const score = evaluate(b);
          if (!pick || score > pick.score) pick = { cells, x, score };
        }
      }
      return pick;
    }
    function spawn() {
      const type = next;
      next = rand(SHAPES.length);
      const target = plan(type);
      if (!target) { over = 1.4; best = Math.max(best, lines); return; }
      piece = { type, cells: target.cells, x: 3, y: 0, tx: target.x, phase: 'aim' };
      if (!fits(board, piece.cells, piece.x, 0)) piece.x = target.x;
    }
    function reset() {
      board = empty();
      lines = 0;
      timer = 0;
      flash = null;
      over = 0;
      next = rand(SHAPES.length);
      spawn();
    }
    function lock() {
      for (const [cx, cy] of piece.cells) board[piece.y + cy][piece.x + cx] = piece.type;
      const full = [];
      board.forEach((row, y) => { if (row.every((v) => v >= 0)) full.push(y); });
      piece = null;
      if (full.length) flash = { rows: full, left: 0.22 };
      else spawn();
    }
    function tick() {
      if (!piece) return;
      if (piece.phase === 'aim') {
        if (piece.x !== piece.tx) {
          const nx = piece.x + Math.sign(piece.tx - piece.x);
          if (fits(board, piece.cells, nx, piece.y)) piece.x = nx; else piece.phase = 'drop';
        } else {
          piece.phase = 'drop';
        }
      } else if (fits(board, piece.cells, piece.x, piece.y + 1)) {
        piece.y += 1;
      } else {
        lock();
      }
    }
    reset();
    return {
      name: 'tetris',
      step(dt) {
        if (over) { over -= dt; if (over <= 0) reset(); return; }
        if (flash) {
          flash.left -= dt;
          if (flash.left <= 0) {
            board = board.filter((_, y) => !flash.rows.includes(y));
            while (board.length < ROWS) board.unshift(Array(COLS).fill(-1));
            lines += flash.rows.length;
            best = Math.max(best, lines);
            flash = null;
            spawn();
          }
          return;
        }
        timer += dt;
        const every = piece && piece.phase === 'aim' ? 0.07 : 0.035;
        while (timer > every) { timer -= every; tick(); }
      },
      draw(ctx, c, t) {
        const palette = [c.cyan, c.amber, c.purple, c.ok, c.red, c.accent, c.orange];
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.strokeRect(OX - 1.5, OY - 1.5, COLS * CELL + 3, ROWS * CELL + 3);
        const cell = (x, y, color) => { ctx.fillStyle = color; ctx.fillRect(OX + x * CELL + 0.5, OY + y * CELL + 0.5, CELL - 1, CELL - 1); };
        board.forEach((row, y) => row.forEach((v, x) => {
          if (v < 0) return;
          ctx.globalAlpha = over ? 0.35 : flash && flash.rows.includes(y) ? 0.4 + 0.6 * Math.abs(Math.sin(t * 30)) : 1;
          cell(x, y, flash && flash.rows.includes(y) ? c.text : palette[v]);
        }));
        ctx.globalAlpha = 1;
        if (piece) for (const [cx, cy] of piece.cells) cell(piece.x + cx, piece.y + cy, palette[piece.type]);
        // the next piece, and the mascot watching the board
        label(ctx, c, 'next', 74, 16);
        for (const [cx, cy] of SHAPES[next]) { ctx.fillStyle = palette[next]; ctx.fillRect(76 + cx * CELL, 22 + cy * CELL, CELL - 1, CELL - 1); }
        label(ctx, c, `lines ${lines}`, 74, 54, c.text, 10);
        const happy = !!flash;
        drawMascot(ctx, c, 150, 70 + Math.sin(t * 3) * 1.5 - (happy ? 4 : 0), 30, { lookX: -0.9, lookY: 0.1, mouth: happy ? 0.45 : 0, sleep: over > 0 });
      },
      caption: () => `tetris · ${lines} lines · best ${best}`,
    };
  }

  /* ---------- runner: jump the bugs, bump the ? blocks, grab the coins ---------- */
  function runner() {
    const G = 100;
    const MX = 46;
    let speed; let dist; let coins; let y; let vy; let ents; let gap; let oops; let clouds; let best = 0;
    function reset() {
      speed = 78; dist = 0; coins = 0; y = G; vy = 0; ents = []; gap = 60; oops = 0;
      clouds = [0, 1, 2].map((i) => ({ x: 40 + i * 90, y: 18 + rand(22), g: GLYPHS[rand(GLYPHS.length)] }));
    }
    function spawn(x) {
      const r = Math.random();
      if (r < 0.4) ents.push({ kind: 'block', x, w: 10, h: 8 + rand(9) });
      else if (r < 0.65) ents.push({ kind: 'bug', x, w: 11, h: 7 });
      else {
        ents.push({ kind: 'q', x, w: 11, h: 11, top: G - 40, hit: false });
        for (let i = 0; i < 3; i++) ents.push({ kind: 'coin', x: x + 40 + i * 10, cy: G - 12 });
      }
    }
    function step(dt) {
      speed = Math.min(150, speed + dt * 1.6);
      const dx = speed * dt;
      dist += dx;
      gap -= dx;
      if (gap <= 0) { spawn(W + 10); gap = 90 + Math.random() * 110; }
      for (const e of ents) e.x -= dx;
      ents = ents.filter((e) => e.x > -20 && !e.gone);
      for (const cl of clouds) { cl.x -= dx * 0.25; if (cl.x < -30) { cl.x = W + 20; cl.y = 18 + rand(22); cl.g = GLYPHS[rand(GLYPHS.length)]; } }
      const ground = y >= G - 0.01;
      // The AI: jump what is coming, sometimes a beat late.
      if (ground) {
        const threat = ents.find((e) => (e.kind === 'block' || e.kind === 'bug') && e.x + e.w > MX - 6);
        if (threat) {
          const d = threat.x - (MX + 8);
          if (d > 0 && d < speed * 0.2 + (Math.random() < 0.02 ? -6 : 0)) vy = -250;
        }
        const q = ents.find((e) => e.kind === 'q' && !e.hit && Math.abs(e.x + e.w / 2 - MX) < speed * 0.14);
        if (q && vy === 0) vy = -265;
      }
      vy += 780 * dt;
      y += vy * dt;
      if (y >= G) { y = G; vy = 0; }
      for (const e of ents) {
        const hitX = e.x < MX + 7 && e.x + e.w > MX - 7;
        if ((e.kind === 'block' || e.kind === 'bug') && hitX && y > G - e.h && !e.hurt) {
          e.hurt = true; oops = 0.6; speed = Math.max(70, speed * 0.6); best = Math.max(best, coins);
        } else if (e.kind === 'q' && !e.hit && hitX && vy < 0 && y - 15 <= e.top + e.h && y - 15 > e.top) {
          e.hit = true; e.pop = 0.5; vy = 60; coins += 1;
        } else if (e.kind === 'coin' && Math.abs(e.x - MX) < 8 && Math.abs(e.cy - (y - 8)) < 10) {
          e.gone = true; coins += 1;
        }
        if (e.pop) e.pop = Math.max(0, e.pop - dt);
      }
      oops = Math.max(0, oops - dt);
      best = Math.max(best, coins);
    }
    reset();
    return {
      name: 'runner',
      step,
      draw(ctx, c, t) {
        for (const cl of clouds) { ctx.globalAlpha = 0.3; label(ctx, c, cl.g, cl.x, cl.y, c.muted, 10); }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = c.line;
        ctx.setLineDash([3, 5]);
        ctx.lineDashOffset = dist % 8;
        ctx.beginPath(); ctx.moveTo(0, G + 0.5); ctx.lineTo(W, G + 0.5); ctx.stroke();
        ctx.setLineDash([]);
        for (const e of ents) {
          if (e.kind === 'block') {
            ctx.fillStyle = c.panel; ctx.strokeStyle = c.dim; ctx.lineWidth = 1.2;
            ctx.fillRect(e.x, G - e.h, e.w, e.h); ctx.strokeRect(e.x + 0.5, G - e.h + 0.5, e.w - 1, e.h - 1);
          } else if (e.kind === 'bug') {
            const leg = Math.sin(t * 22 + e.x) * 1.5;
            ctx.strokeStyle = c.red; ctx.lineWidth = 1;
            for (const lx of [2, 5.5, 9]) { ctx.beginPath(); ctx.moveTo(e.x + lx, G - 3); ctx.lineTo(e.x + lx + leg, G); ctx.stroke(); }
            ctx.fillStyle = c.red;
            ctx.beginPath(); ctx.ellipse(e.x + 5.5, G - 4.5, 5.5, 3.6, 0, 0, TAU); ctx.fill();
            ctx.fillStyle = c.bg; ctx.fillRect(e.x + 1.5, G - 6, 1.4, 1.4);
          } else if (e.kind === 'q') {
            ctx.fillStyle = e.hit ? c.line : c.amber;
            ctx.fillRect(e.x, e.top, e.w, e.h);
            if (!e.hit) label(ctx, c, '?', e.x + e.w / 2, e.top + 9, c.bg, 9, 'center');
            if (e.pop) { ctx.fillStyle = c.cyan; ctx.beginPath(); ctx.arc(e.x + e.w / 2, e.top - 6 - (0.5 - e.pop) * 30, 2.6, 0, TAU); ctx.fill(); }
          } else if (e.kind === 'coin') {
            ctx.fillStyle = c.cyan;
            ctx.beginPath(); ctx.arc(e.x, e.cy + Math.sin(t * 6 + e.x) * 1.2, 2.5, 0, TAU); ctx.fill();
          }
        }
        const ground = y >= G - 0.01;
        const bob = ground ? Math.abs(Math.sin(t * 14)) * 1.6 : 0;
        const tilt = ground ? 0 : Math.max(-0.15, Math.min(0.15, vy / 1400));
        if (oops && Math.floor(t * 12) % 2) return;
        drawMascot(ctx, c, MX, y - 10 - bob, 19, { angle: tilt, mouth: oops ? 0.5 : 0, lookX: 0.8, lookY: 0 });
      },
      caption: () => `runner · ${coins} coins · ${Math.floor(dist / 10)} m`,
    };
  }

  /* ---------- chess: it replays the Opera Game, Morphy, Paris 1858 ---------- */
  function chess() {
    const UCI = 'e2e4 e7e5 g1f3 d7d6 d2d4 c8g4 d4e5 g4f3 d1f3 d6e5 f1c4 g8f6 f3b3 d8e7 b1c3 c7c6 c1g5 b7b5 c3b5 c6b5 c4b5 b8d7 e1c1 a8d8 d1d7 d8d7 h1d1 e7e6 b5d7 f6d7 b3b8 d7b8 d1d8'.split(' ');
    const SAN = 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#'.split(' ');
    const PIECE = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
    const SQ = 12;
    const OX = 8;
    const OY = 7;
    let board; let ply; let timer; let last; let done;
    const at = (s) => [s.charCodeAt(0) - 97, Number(s[1]) - 1];
    function reset() {
      board = Array.from({ length: 8 }, () => Array(8).fill(null));
      const back = 'rnbqkbnr';
      for (let f = 0; f < 8; f++) {
        board[0][f] = { t: back[f], w: true }; board[1][f] = { t: 'p', w: true };
        board[7][f] = { t: back[f], w: false }; board[6][f] = { t: 'p', w: false };
      }
      ply = 0; timer = 0; last = null; done = 0;
    }
    function play(m) {
      const [ff, fr] = at(m.slice(0, 2));
      const [tf, tr] = at(m.slice(2, 4));
      const p = board[fr][ff];
      board[tr][tf] = p;
      board[fr][ff] = null;
      if (p && p.t === 'k' && Math.abs(tf - ff) === 2) {
        const [rf, rt] = tf < ff ? [0, 3] : [7, 5];
        board[tr][rt] = board[tr][rf];
        board[tr][rf] = null;
      }
      last = [ff, fr, tf, tr];
    }
    reset();
    return {
      name: 'chess',
      step(dt) {
        if (done) { done -= dt; if (done <= 0) reset(); return; }
        timer += dt;
        if (timer > 1.1) {
          timer = 0;
          play(UCI[ply]);
          ply += 1;
          if (ply >= UCI.length) done = 3.5;
        }
      },
      draw(ctx, c, t) {
        for (let r = 0; r < 8; r++) {
          for (let f = 0; f < 8; f++) {
            const x = OX + f * SQ;
            const y = OY + (7 - r) * SQ;
            if ((r + f) % 2 === 1) { ctx.globalAlpha = 0.55; ctx.fillStyle = c.line; ctx.fillRect(x, y, SQ, SQ); }
            if (last && ((f === last[0] && r === last[1]) || (f === last[2] && r === last[3]))) {
              ctx.globalAlpha = 0.35; ctx.fillStyle = c.amber; ctx.fillRect(x, y, SQ, SQ);
            }
            ctx.globalAlpha = 1;
            const p = board[r][f];
            if (p) {
              ctx.font = `${SQ - 1}px "Segoe UI Symbol", "DejaVu Sans", "Noto Sans Symbols 2", serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = p.w ? c.text : c.accent;
              ctx.fillText(PIECE[p.t], x + SQ / 2, y + SQ / 2 + 0.5);
            }
          }
        }
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.strokeRect(OX - 0.5, OY - 0.5, SQ * 8 + 1, SQ * 8 + 1);
        const move = ply ? `${Math.ceil(ply / 2)}.${ply % 2 ? '' : '..'} ${SAN[ply - 1]}` : 'Morphy to move';
        label(ctx, c, move, 116, 24, done ? c.amber : c.text, 11);
        label(ctx, c, done ? 'checkmate' : 'Paris, 1858', 116, 38, c.muted, 9);
        drawMascot(ctx, c, 168, 76 + Math.sin(t * 2.4) * 1.2, 28, { lookX: -0.9, lookY: 0.2, mouth: done ? 0.4 : 0 });
      },
      caption: () => `chess · the Opera Game · move ${Math.ceil(Math.max(1, ply) / 2)}`,
    };
  }

  /* ---------- chomp: food drifts in, the mascot's open side eats it ---------- */
  function chomp() {
    const EAT = 196;
    let items = []; let pops = []; let score = 0; let nextIn = 0; let chompAt = -9;
    let clock = 0;
    function food(x) {
      const glyph = Math.random() < 0.3;
      items.push({ x, glyph, g: GLYPHS[rand(GLYPHS.length)], r: 2.6 + Math.random() * 1.8, phase: Math.random() * TAU });
    }
    return {
      name: 'chomp',
      feed() {
        const lead = Math.min(-8, ...items.map((i) => i.x - 16));
        for (let i = 0; i < 5; i++) food(lead - i * 16);
      },
      step(dt) {
        clock += dt;
        nextIn -= dt;
        if (nextIn <= 0) { food(-8); nextIn = 0.65 + Math.random() * 0.6; }
        for (const it of items) it.x += 52 * dt;
        for (const it of items.filter((i) => i.x >= EAT)) { score += 1; chompAt = clock; pops.push({ age: 0 }); }
        items = items.filter((i) => i.x < EAT);
        for (const p of pops) p.age += dt;
        pops = pops.filter((p) => p.age < 0.7);
      },
      draw(ctx, c, t) {
        ctx.strokeStyle = c.line;
        ctx.setLineDash([2, 5]);
        ctx.beginPath(); ctx.moveTo(0, 96.5); ctx.lineTo(W, 96.5); ctx.stroke();
        ctx.setLineDash([]);
        for (const it of items) {
          const y = 66 + Math.sin(t * 3.8 + it.phase) * 3;
          if (it.glyph) label(ctx, c, it.g, it.x, y + 4, c.text, 11, 'center');
          else { ctx.fillStyle = c.cyan; ctx.beginPath(); ctx.arc(it.x, y, it.r, 0, TAU); ctx.fill(); }
        }
        const since = clock - chompAt;
        const mouth = since < 0.09 ? since / 0.09 : since < 0.25 ? 1 - (since - 0.09) / 0.16 : 0;
        drawMascot(ctx, c, 212, 66 + Math.sin(t * 3.4) * 1.5, 30, { mouth, lookX: -0.9, lookY: 0 });
        for (const p of pops) { ctx.globalAlpha = 1 - p.age / 0.7; label(ctx, c, '+1', 196, 40 - p.age * 20, c.ok, 11, 'center'); }
        ctx.globalAlpha = 1;
      },
      caption: () => `chomp · nom ×${score}`,
    };
  }

  const GAMES = { snake, tetris, runner, chess, chomp };
  window.__mascotGames = {
    W,
    H,
    names: Object.keys(GAMES),
    create: (name) => GAMES[name](),
    drawMascot,
  };
})();
