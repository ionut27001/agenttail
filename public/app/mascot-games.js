// The mascot's games: when an agent thinks for a while, the mascot plays one
// of these in the thinking window, on its own; ▶ play hands you the controls.
// Each game draws on a small canvas in the theme's colours; stage.js runs the
// loop. Games change as they go: speed, levels, bonuses, surprises.
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
    // The eye sits well inside the chevron's opening, clear of the arms.
    const ex = -size * 0.28;
    const er = Math.max(1.6, size * 0.13);
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

  /* ----- shared effects: bursts of dots, floating text, a little shake ----- */
  // Colours are theme keys ('cyan', 'amber'...) resolved when drawn.
  function burst(list, x, y, color, n = 8, speed = 40) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const v = speed * (0.4 + Math.random() * 0.8);
      list.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, age: 0, life: 0.5 + Math.random() * 0.4, color, r: 0.9 + Math.random() * 1.4 });
    }
  }
  function stepParts(list, dt, gravity = 70) {
    for (const p of list) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += gravity * dt; }
    for (let i = list.length - 1; i >= 0; i--) if (list[i].age >= list[i].life) list.splice(i, 1);
  }
  function drawParts(ctx, c, list) {
    for (const p of list) {
      ctx.globalAlpha = Math.max(0, 1 - p.age / p.life);
      ctx.fillStyle = c[p.color] || p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function pop(list, text, x, y, color, size = 10) { list.push({ text, x, y, color, size, age: 0 }); }
  function stepPops(list, dt) {
    for (const p of list) p.age += dt;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].age > 0.9) list.splice(i, 1);
  }
  function drawPops(ctx, c, list) {
    for (const p of list) {
      ctx.globalAlpha = Math.max(0, 1 - p.age / 0.9);
      label(ctx, c, p.text, p.x, p.y - p.age * 18, c[p.color] || p.color, p.size, 'center');
    }
    ctx.globalAlpha = 1;
  }
  const shakeOffset = (s) => (s > 0 ? (Math.random() - 0.5) * s : 0);

  /* ---------- snake: the mascot is the head, its tail dots are the body ---------- */
  function snake() {
    const CELL = 10;
    const COLS = 24;
    const ROWS = 10;
    const OY = 8;
    const DIRS = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
    const key = (p) => p.y * COLS + p.x;
    const inside = (p) => p.x >= 0 && p.y >= 0 && p.x < COLS && p.y < ROWS;
    const cx = (p) => p.x * CELL + CELL / 2;
    const cy = (p) => OY + p.y * CELL + CELL / 2;
    let body; let dir; let food; let bug; let timer; let eaten; let dead; let grow; let clock = 0; let shake = 0;
    let human = false;
    let queued = null;
    const parts = [];
    const pops = [];

    function freeCell() {
      const taken = new Set(body.map(key));
      if (bug) taken.add(key(bug));
      const free = [];
      for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (!taken.has(y * COLS + x)) free.push({ x, y });
      return free[rand(free.length)];
    }
    /** Every fifth fruit is golden: worth three, and it fades if you are slow. */
    function place() {
      food = freeCell();
      food.gold = (eaten + 1) % 5 === 0;
      food.until = clock + 7;
    }
    function reset() {
      body = [{ x: 6, y: 5 }, { x: 5, y: 5 }, { x: 4, y: 5 }];
      dir = DIRS[0];
      eaten = 0; dead = 0; timer = 0; grow = 0; bug = null;
      place();
    }
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
    /** First step of a shortest path to the target, or null. */
    function pathStep(head, blocked, target) {
      const prev = new Map([[key(head), null]]);
      const queue = [head];
      while (queue.length) {
        const p = queue.shift();
        if (p.x === target.x && p.y === target.y) {
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
      const dist = (p) => Math.abs(p.x - head.x) + Math.abs(p.y - head.y);
      // Chase the bug when it is the closer snack.
      const target = bug && dist(bug) < dist(food) ? bug : food;
      const step = pathStep(head, blocked, target);
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
    function humanStep() {
      const d = queued || dir;
      queued = null;
      const n = { x: body[0].x + d.x, y: body[0].y + d.y };
      const blocked = new Set(body.slice(0, -1).map(key));
      return inside(n) && !blocked.has(key(n)) ? d : null;
    }
    function tick() {
      if (dead) { dead -= 1; if (!dead) reset(); return; }
      if (food.gold && clock > food.until) food.gold = false;
      const d = human ? humanStep() : choose();
      if (!d) {
        dead = 12; shake = 5;
        burst(parts, cx(body[0]), cy(body[0]), 'accent', 18, 60);
        return;
      }
      dir = d;
      const head = { x: body[0].x + d.x, y: body[0].y + d.y };
      body.unshift(head);
      if (bug && head.x === bug.x && head.y === bug.y) {
        eaten += 5; grow += 2;
        burst(parts, cx(head), cy(head), 'red', 14, 55);
        pop(pops, '+5 bug!', cx(head), cy(head) - 6, 'amber');
        bug = null;
      }
      if (head.x === food.x && head.y === food.y) {
        if (food.gold) { eaten += 3; grow += 2; burst(parts, cx(head), cy(head), 'amber', 16, 55); pop(pops, '+3', cx(head), cy(head) - 6, 'amber'); }
        else { eaten += 1; burst(parts, cx(head), cy(head), 'cyan', 6, 30); }
        place();
      }
      if (grow > 0) grow -= 1; else body.pop();
      if (body.length > COLS * ROWS - 8) dead = 12;
      // Now and then a bug wanders in.
      if (!bug && Math.random() < 0.015) { const f = freeCell(); if (f) bug = { x: f.x, y: f.y, moveIn: 0, until: clock + 9 }; }
    }
    function stepBug(dt) {
      if (!bug) return;
      if (clock > bug.until) { bug = null; return; }
      bug.moveIn -= dt;
      if (bug.moveIn > 0) return;
      bug.moveIn = 0.4;
      const d = DIRS[rand(4)];
      const n = { x: bug.x + d.x, y: bug.y + d.y };
      if (inside(n) && !body.some((p) => p.x === n.x && p.y === n.y) && !(n.x === food.x && n.y === food.y)) { bug.x = n.x; bug.y = n.y; }
    }
    const KEYS = { ArrowRight: 0, d: 0, ArrowDown: 1, s: 1, ArrowLeft: 2, a: 2, ArrowUp: 3, w: 3 };
    reset();
    return {
      name: 'snake',
      controls: '← ↑ → ↓',
      set human(on) { human = !!on; queued = null; },
      input(type, k) {
        if (type !== 'down' || !(k in KEYS)) return false;
        const d = DIRS[KEYS[k]];
        if (d.x !== -dir.x || d.y !== -dir.y) queued = d;
        return true;
      },
      score: () => eaten,
      step(dt) {
        clock += dt;
        stepBug(dt);
        stepParts(parts, dt, 0);
        stepPops(pops, dt);
        shake = Math.max(0, shake - dt * 14);
        // Faster as it grows.
        const every = Math.max(human ? 0.07 : 0.055, (human ? 0.13 : 0.1) - eaten * 0.0015);
        timer += dt;
        while (timer > every) { timer -= every; tick(); }
      },
      draw(ctx, c, t) {
        ctx.save();
        ctx.translate(shakeOffset(shake), shakeOffset(shake));
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, OY + 0.5, COLS * CELL - 1, ROWS * CELL - 1);
        if (food.gold) {
          const left = Math.max(0, food.until - clock);
          ctx.globalAlpha = left < 2 ? 0.4 + 0.6 * Math.abs(Math.sin(t * 10)) : 1;
          ctx.fillStyle = c.amber;
          ctx.beginPath(); ctx.arc(cx(food), cy(food), 3.4 + Math.sin(t * 8) * 0.6, 0, TAU); ctx.fill();
          ctx.strokeStyle = c.amber;
          ctx.beginPath(); ctx.arc(cx(food), cy(food), 5 + (t * 6) % 3, 0, TAU); ctx.stroke();
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = c.cyan;
          ctx.beginPath(); ctx.arc(cx(food), cy(food), 2.2 + Math.sin(t * 8) * 0.6, 0, TAU); ctx.fill();
        }
        if (bug) {
          const bx = cx(bug);
          const by = cy(bug);
          ctx.strokeStyle = c.red; ctx.lineWidth = 0.8;
          for (const lx of [-2.5, 0, 2.5]) { ctx.beginPath(); ctx.moveTo(bx + lx, by); ctx.lineTo(bx + lx + Math.sin(t * 20) * 1.2, by + 3.5); ctx.stroke(); }
          ctx.fillStyle = c.red;
          ctx.beginPath(); ctx.ellipse(bx, by - 0.5, 3.6, 2.6, 0, 0, TAU); ctx.fill();
        }
        for (let i = body.length - 1; i >= 1; i--) {
          const k = i / body.length;
          ctx.globalAlpha = dead ? 0.25 + 0.25 * Math.sin(t * 25) : 1 - k * 0.6;
          ctx.fillStyle = i % 5 === 0 ? c.cyan : c.accent;
          ctx.beginPath(); ctx.arc(cx(body[i]), cy(body[i]), 3.8 - k * 1.8, 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = 1;
        const head = body[0];
        const near = Math.abs(head.x - food.x) + Math.abs(head.y - food.y) <= 1;
        drawMascot(ctx, c, cx(head), cy(head), 11, { angle: Math.atan2(dir.y, dir.x), mouth: near ? 0.6 : 0, sleep: !!dead });
        drawParts(ctx, c, parts);
        drawPops(ctx, c, pops);
        ctx.restore();
      },
      caption: () => `snake · ${eaten} pts · length ${body.length}`,
    };
  }

  /* ---------- tetris: it plays itself; levels speed it up, clears burst ---------- */
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
    const CLEAR_NAMES = ['', '', 'DOUBLE', 'TRIPLE', 'TETRIS!'];
    const CLEAR_POINTS = [0, 40, 100, 300, 1200];
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
    let board; let piece; let next; let lines; let points; let timer; let flash; let over; let pieces;
    let human = false;
    let soft = false;
    const parts = [];
    const pops = [];
    const level = () => 1 + Math.floor(lines / 5);
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
    /** In Tail's games a garbage row climbs in now and then, to keep it busy. */
    function garbage() {
      if (board[0].some((v) => v >= 0)) return;
      const hole = rand(COLS);
      board.shift();
      board.push(Array.from({ length: COLS }, (_, x) => (x === hole ? -1 : 6)));
      pop(pops, 'incoming!', OX + COLS * CELL / 2, OY + ROWS * CELL - 4, 'red', 9);
    }
    function spawn() {
      const type = next;
      next = rand(SHAPES.length);
      pieces += 1;
      if (!human && pieces % 9 === 0) garbage();
      if (human) {
        const vars = variants(SHAPES[type]);
        piece = { type, vars, vi: 0, cells: vars[0], x: 3, y: 0, phase: 'human' };
        if (!fits(board, piece.cells, piece.x, 0)) { piece = null; over = 1.4; }
        return;
      }
      const target = plan(type);
      if (!target) { over = 1.4; return; }
      piece = { type, cells: target.cells, x: 3, y: 0, tx: target.x, phase: 'aim' };
      if (!fits(board, piece.cells, piece.x, 0)) piece.x = target.x;
    }
    function reset() {
      board = empty();
      lines = 0; points = 0; timer = 0; flash = null; over = 0; pieces = 0;
      next = rand(SHAPES.length);
      spawn();
    }
    function lock() {
      for (const [cx, cy] of piece.cells) board[piece.y + cy][piece.x + cx] = piece.type;
      const full = [];
      board.forEach((row, y) => { if (row.every((v) => v >= 0)) full.push(y); });
      piece = null;
      if (full.length) {
        flash = { rows: full, left: 0.24 };
        for (const y of full) for (let x = 0; x < COLS; x += 2) burst(parts, OX + x * CELL + 2, OY + y * CELL + 2, 'text', 2, 45);
        const name = CLEAR_NAMES[full.length];
        if (name) pop(pops, name, OX + COLS * CELL / 2, OY + full[0] * CELL, full.length === 4 ? 'amber' : 'cyan', full.length === 4 ? 11 : 9);
      } else {
        spawn();
      }
    }
    function tick() {
      if (!piece) return;
      if (piece.phase === 'human') {
        if (fits(board, piece.cells, piece.x, piece.y + 1)) piece.y += 1; else lock();
      } else if (piece.phase === 'aim') {
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
    function shift(dx) { if (piece && fits(board, piece.cells, piece.x + dx, piece.y)) piece.x += dx; }
    function rotate() {
      if (!piece || !piece.vars) return;
      const vi = (piece.vi + 1) % piece.vars.length;
      for (const dx of [0, -1, 1, -2, 2]) {
        if (fits(board, piece.vars[vi], piece.x + dx, piece.y)) { piece.vi = vi; piece.cells = piece.vars[vi]; piece.x += dx; return; }
      }
    }
    function ghostY() {
      let y = piece.y;
      while (fits(board, piece.cells, piece.x, y + 1)) y += 1;
      return y;
    }
    reset();
    return {
      name: 'tetris',
      controls: '← → move · ↑ turn · ↓ faster · space drop',
      set human(on) {
        human = !!on;
        soft = false;
        if (!piece) return;
        if (human) { piece.vars = variants(SHAPES[piece.type]); piece.vi = 0; piece.phase = 'human'; }
        else piece.phase = 'drop';
      },
      input(type, k) {
        if (k === 'ArrowDown' || k === 's') { soft = type === 'down'; return true; }
        if (type !== 'down') return ['ArrowLeft', 'ArrowRight', 'ArrowUp', ' ', 'a', 'd', 'w'].includes(k);
        if (!piece || piece.phase !== 'human') return true;
        if (k === 'ArrowLeft' || k === 'a') shift(-1);
        else if (k === 'ArrowRight' || k === 'd') shift(1);
        else if (k === 'ArrowUp' || k === 'w') rotate();
        else if (k === ' ') { piece.y = ghostY(); lock(); }
        else return false;
        return true;
      },
      score: () => points,
      step(dt) {
        stepParts(parts, dt, 40);
        stepPops(pops, dt);
        if (over) { over -= dt; if (over <= 0) reset(); return; }
        if (flash) {
          flash.left -= dt;
          if (flash.left <= 0) {
            const before = level();
            board = board.filter((_, y) => !flash.rows.includes(y));
            while (board.length < ROWS) board.unshift(Array(COLS).fill(-1));
            lines += flash.rows.length;
            points += CLEAR_POINTS[flash.rows.length] * before;
            if (level() > before) pop(pops, `LEVEL ${level()}`, 120, 40, 'ok', 11);
            flash = null;
            spawn();
          }
          return;
        }
        timer += dt;
        const gravity = Math.max(0.07, 0.45 - (level() - 1) * 0.05);
        const every = !piece ? 0.035 : piece.phase === 'human' ? (soft ? 0.04 : gravity) : piece.phase === 'aim' ? 0.07 : 0.035;
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
          const lit = flash && flash.rows.includes(y);
          ctx.globalAlpha = over ? 0.35 : lit ? 0.4 + 0.6 * Math.abs(Math.sin(t * 30)) : 1;
          cell(x, y, lit ? c.text : v === 6 && !human ? c.line : palette[v]);
        }));
        ctx.globalAlpha = 1;
        if (piece) {
          // where it will land
          const gy = ghostY();
          ctx.strokeStyle = palette[piece.type];
          ctx.globalAlpha = 0.45;
          for (const [cx, cy] of piece.cells) ctx.strokeRect(OX + (piece.x + cx) * CELL + 0.5, OY + (gy + cy) * CELL + 0.5, CELL - 1, CELL - 1);
          ctx.globalAlpha = 1;
          for (const [cx, cy] of piece.cells) cell(piece.x + cx, piece.y + cy, palette[piece.type]);
        }
        label(ctx, c, 'next', 74, 16);
        for (const [cx, cy] of SHAPES[next]) { ctx.fillStyle = palette[next]; ctx.fillRect(76 + cx * CELL, 22 + cy * CELL, CELL - 1, CELL - 1); }
        label(ctx, c, `lv ${level()}`, 74, 50, c.text, 10);
        const happy = !!flash;
        drawMascot(ctx, c, 150, 70 + Math.sin(t * 3) * 1.5 - (happy ? 4 : 0), 30, { lookX: -0.9, lookY: 0.1, mouth: happy ? 0.45 : 0, sleep: over > 0 });
        drawParts(ctx, c, parts);
        drawPops(ctx, c, pops);
      },
      caption: () => `tetris · level ${level()} · ${lines} lines · ${points} pts`,
    };
  }

  /* ---------- runner: jump bugs, blocks and pits, bump ? blocks, catch a star ---------- */
  function runner() {
    const G = 100;
    const MX = 46;
    let speed; let dist; let coins; let y; let vy; let ents; let gap; let oops; let star; let clouds; let hills; let milestone;
    let human = false;
    let jumpQueued = false;
    const parts = [];
    const pops = [];
    function reset() {
      speed = 78; dist = 0; coins = 0; y = G; vy = 0; ents = []; gap = 60; oops = 0; star = 0; milestone = 100;
      clouds = [0, 1, 2].map((i) => ({ x: 40 + i * 90, y: 18 + rand(22), g: GLYPHS[rand(GLYPHS.length)] }));
      hills = Array.from({ length: 7 }, (_, i) => ({ x: i * 45, h: 6 + rand(12) }));
    }
    function spawn(x) {
      const r = Math.random();
      if (r < 0.28) ents.push({ kind: 'block', x, w: 10, h: 8 + rand(9) });
      else if (r < 0.48) ents.push({ kind: 'bug', x, w: 11, h: 7 });
      else if (r < 0.66) ents.push({ kind: 'pit', x, w: 22 + rand(12), h: 0 });
      else if (r < 0.95) {
        ents.push({ kind: 'q', x, w: 11, h: 11, top: G - 40, hit: false });
        for (let i = 0; i < 3; i++) ents.push({ kind: 'coin', x: x + 40 + i * 10, cy: G - 12 });
      } else {
        ents.push({ kind: 'star', x, cy: G - 24 });
      }
    }
    const threats = (e) => e.kind === 'block' || e.kind === 'bug' || e.kind === 'pit';
    function hurt(e) {
      e.hurt = true; oops = 0.7; speed = Math.max(70, speed * 0.6);
      burst(parts, MX, y - 8, 'red', 10, 45);
    }
    function step(dt) {
      speed = Math.min(160, speed + dt * 1.8);
      const dx = speed * dt;
      dist += dx;
      gap -= dx;
      if (gap <= 0) { spawn(W + 10); gap = 85 + Math.random() * 105; }
      for (const e of ents) e.x -= dx;
      ents = ents.filter((e) => e.x + (e.w || 4) > -20 && !e.gone);
      for (const cl of clouds) { cl.x -= dx * 0.25; if (cl.x < -30) { cl.x = W + 20; cl.y = 18 + rand(22); cl.g = GLYPHS[rand(GLYPHS.length)]; } }
      for (const h of hills) { h.x -= dx * 0.5; if (h.x < -45) { h.x += 45 * hills.length; h.h = 6 + rand(12); } }
      const overPit = ents.some((e) => e.kind === 'pit' && MX > e.x + 3 && MX < e.x + e.w - 3);
      const ground = y >= G - 0.01 && !overPit;
      if (human) {
        if (jumpQueued && ground) vy = -265;
        jumpQueued = false;
      } else if (ground) {
        // The AI: jump what is coming, sometimes a beat late.
        const threat = ents.find((e) => threats(e) && e.x + e.w > MX - 6);
        if (threat) {
          const d = threat.x - (MX + 8);
          const reach = threat.kind === 'pit' ? speed * 0.12 + 6 : speed * 0.2;
          if (d > 0 && d < reach + (Math.random() < 0.02 ? -6 : 0)) vy = -255;
        }
        const q = ents.find((e) => e.kind === 'q' && !e.hit && Math.abs(e.x + e.w / 2 - MX) < speed * 0.14);
        if (q && vy === 0) vy = -265;
      }
      vy += 780 * dt;
      y += vy * dt;
      if (y >= G && !overPit) { y = G; vy = 0; }
      if (y > H + 14) {
        // fell in a pit: back on the ground a little further on
        const pit = ents.find((e) => e.kind === 'pit' && e.x < MX + 20);
        if (pit) pit.gone = true;
        y = G; vy = 0; oops = 0.8; speed = Math.max(70, speed * 0.6);
        pop(pops, 'oops', MX, G - 20, 'red');
      }
      for (const e of ents) {
        const hitX = e.x < MX + 7 && e.x + (e.w || 0) > MX - 7;
        if ((e.kind === 'block' || e.kind === 'bug') && hitX && y > G - e.h && !e.hurt) {
          if (star > 0) { e.gone = true; coins += 1; burst(parts, e.x + 5, G - 5, e.kind === 'bug' ? 'red' : 'line', 10, 50); pop(pops, '+1', e.x + 5, G - 16, 'amber'); }
          else hurt(e);
        } else if (e.kind === 'q' && !e.hit && hitX && vy < 0 && y - 15 <= e.top + e.h && y - 15 > e.top) {
          e.hit = true; e.pop = 0.5; vy = 60; coins += 1;
          burst(parts, e.x + e.w / 2, e.top, 'amber', 6, 30);
        } else if (e.kind === 'coin' && Math.abs(e.x - MX) < 8 && Math.abs(e.cy - (y - 8)) < 10) {
          e.gone = true; coins += 1;
          burst(parts, e.x, e.cy, 'cyan', 4, 25);
        } else if (e.kind === 'star' && Math.abs(e.x - MX) < 9 && Math.abs(e.cy - (y - 8)) < 12) {
          e.gone = true; star = 4.5;
          pop(pops, 'STAR!', MX + 10, G - 30, 'amber', 11);
          burst(parts, e.x, e.cy, 'amber', 14, 50);
        }
        if (e.pop) e.pop = Math.max(0, e.pop - dt);
      }
      oops = Math.max(0, oops - dt);
      star = Math.max(0, star - dt);
      if (dist / 10 >= milestone) { pop(pops, `${milestone} m!`, 160, 30, 'ok', 10); milestone += 100; }
      stepParts(parts, dt);
      stepPops(pops, dt);
    }
    reset();
    return {
      name: 'runner',
      controls: 'space jump',
      set human(on) { human = !!on; jumpQueued = false; },
      input(type, k) {
        if (k !== ' ' && k !== 'ArrowUp' && k !== 'w') return false;
        if (type === 'down') jumpQueued = true;
        return true;
      },
      score: () => Math.floor(dist / 10) + coins * 5,
      step,
      draw(ctx, c, t) {
        // hills far behind, clouds of glyphs, speed lines when it flies along
        ctx.strokeStyle = c.line;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        hills.forEach((h, i) => { if (i === 0) ctx.moveTo(h.x, G - 2); ctx.quadraticCurveTo(h.x + 22, G - 2 - h.h * 2, h.x + 45, G - 2); });
        ctx.stroke();
        for (const cl of clouds) { ctx.globalAlpha = 0.3; label(ctx, c, cl.g, cl.x, cl.y, c.muted, 10); }
        if (speed > 120) {
          ctx.globalAlpha = 0.25;
          for (let i = 0; i < 4; i++) { const ly = 20 + ((i * 23 + dist * 0.3) % 60); ctx.beginPath(); ctx.moveTo((W - (dist * 2 + i * 70) % W), ly); ctx.lineTo((W - (dist * 2 + i * 70) % W) + 14, ly); ctx.stroke(); }
        }
        ctx.globalAlpha = 1;
        // the ground, with holes where the pits are
        const pits = ents.filter((e) => e.kind === 'pit').sort((a, b) => a.x - b.x);
        ctx.strokeStyle = c.line;
        ctx.setLineDash([3, 5]);
        ctx.lineDashOffset = dist % 8;
        let from = 0;
        for (const p of pits) { if (p.x > from) { ctx.beginPath(); ctx.moveTo(from, G + 0.5); ctx.lineTo(p.x, G + 0.5); ctx.stroke(); } from = Math.max(from, p.x + p.w); }
        ctx.beginPath(); ctx.moveTo(from, G + 0.5); ctx.lineTo(W, G + 0.5); ctx.stroke();
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
          } else if (e.kind === 'star') {
            label(ctx, c, '★', e.x, e.cy + 4 + Math.sin(t * 5) * 2, c.amber, 13, 'center');
          }
        }
        drawParts(ctx, c, parts);
        drawPops(ctx, c, pops);
        const ground = y >= G - 0.01;
        const bob = ground ? Math.abs(Math.sin(t * 14)) * 1.6 : 0;
        const tilt = ground ? 0 : Math.max(-0.15, Math.min(0.15, vy / 1400));
        if (oops && Math.floor(t * 12) % 2) return;
        // a star makes Tail flash through the theme's colours
        const look = star > 0 ? { ...c, accent: [c.amber, c.cyan, c.ok, c.accent][Math.floor(t * 12) % 4] } : c;
        drawMascot(ctx, look, MX, y - 10 - bob, 19, { angle: tilt, mouth: oops ? 0.5 : star > 0 ? 0.3 : 0, lookX: 0.8, lookY: 0 });
      },
      caption: () => `runner · ${coins} coins · ${Math.floor(dist / 10)} m${star > 0 ? ' · ★' : ''}`,
    };
  }

  /* ---------- chess: replays famous games, pieces slide, brilliancies get !! ---------- */
  function chess() {
    const GAMES = [
      {
        title: 'the Opera Game', where: 'Paris, 1858',
        uci: 'e2e4 e7e5 g1f3 d7d6 d2d4 c8g4 d4e5 g4f3 d1f3 d6e5 f1c4 g8f6 f3b3 d8e7 b1c3 c7c6 c1g5 b7b5 c3b5 c6b5 c4b5 b8d7 e1c1 a8d8 d1d7 d8d7 h1d1 e7e6 b5d7 f6d7 b3b8 d7b8 d1d8',
        san: 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#',
        notes: { 24: '!', 30: '!!' },
      },
      {
        title: 'the Immortal Game', where: 'London, 1851',
        uci: 'e2e4 e7e5 f2f4 e5f4 f1c4 d8h4 e1f1 b7b5 c4b5 g8f6 g1f3 h4h6 d2d3 f6h5 f3h4 h6g5 h4f5 c7c6 g2g4 h5f6 h1g1 c6b5 h2h4 g5g6 h4h5 g6g5 d1f3 f6g8 c1f4 g5f6 b1c3 f8c5 c3d5 f6b2 f4d6 c5g1 e4e5 b2a1 f1e2 b8a6 f5g7 e8d8 f3f6 g8f6 d6e7',
        san: 'e4 e5 f4 exf4 Bc4 Qh4+ Kf1 b5 Bxb5 Nf6 Nf3 Qh6 d3 Nh5 Nh4 Qg5 Nf5 c6 g4 Nf6 Rg1 cxb5 h4 Qg6 h5 Qg5 Qf3 Ng8 Bxf4 Qf6 Nc3 Bc5 Nd5 Qxb2 Bd6 Bxg1 e5 Qxa1+ Ke2 Na6 Nxg7+ Kd8 Qf6+ Nxf6 Be7#',
        notes: { 34: '!!', 42: '!!' },
      },
    ].map((g) => ({ ...g, uci: g.uci.split(' '), san: g.san.split(' ') }));
    const PIECE = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
    const SQ = 12;
    const OX = 8;
    const OY = 7;
    const SLIDE = 0.32;
    let gi = rand(GAMES.length);
    let board; let ply; let timer; let last; let done; let anim; let taken; let note;
    const at = (s) => [s.charCodeAt(0) - 97, Number(s[1]) - 1];
    const sx = (f) => OX + f * SQ + SQ / 2;
    const sy = (r) => OY + (7 - r) * SQ + SQ / 2;
    function reset() {
      board = Array.from({ length: 8 }, () => Array(8).fill(null));
      const back = 'rnbqkbnr';
      for (let f = 0; f < 8; f++) {
        board[0][f] = { t: back[f], w: true }; board[1][f] = { t: 'p', w: true };
        board[7][f] = { t: back[f], w: false }; board[6][f] = { t: 'p', w: false };
      }
      ply = 0; timer = 0; last = null; done = 0; anim = null; taken = []; note = null;
    }
    function play(m) {
      const [ff, fr] = at(m.slice(0, 2));
      const [tf, tr] = at(m.slice(2, 4));
      const p = board[fr][ff];
      if (board[tr][tf]) taken.push(board[tr][tf]);
      board[tr][tf] = p;
      board[fr][ff] = null;
      anim = { p, ff, fr, tf, tr, t: 0 };
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
        if (anim) { anim.t += dt; if (anim.t >= SLIDE) anim = null; }
        if (note) { note.t -= dt; if (note.t <= 0) note = null; }
        if (done) { done -= dt; if (done <= 0) { gi = (gi + 1) % GAMES.length; reset(); } return; }
        timer += dt;
        if (timer > 1.05) {
          const g = GAMES[gi];
          timer = 0;
          play(g.uci[ply]);
          if (g.notes[ply]) note = { text: g.notes[ply], t: 1.6 };
          ply += 1;
          if (ply >= g.uci.length) done = 3.5;
        }
      },
      draw(ctx, c, t) {
        const g = GAMES[gi];
        const font = `${SQ - 1}px "Segoe UI Symbol", "DejaVu Sans", "Noto Sans Symbols 2", serif`;
        const piece = (p, x, y, size) => {
          ctx.font = size ? `${size}px "Segoe UI Symbol", "DejaVu Sans", serif` : font;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = p.w ? c.text : c.accent;
          ctx.fillText(PIECE[p.t], x, y + 0.5);
        };
        for (let r = 0; r < 8; r++) {
          for (let f = 0; f < 8; f++) {
            const x = OX + f * SQ;
            const y = OY + (7 - r) * SQ;
            if ((r + f) % 2 === 1) { ctx.globalAlpha = 0.55; ctx.fillStyle = c.line; ctx.fillRect(x, y, SQ, SQ); }
            if (last && ((f === last[0] && r === last[1]) || (f === last[2] && r === last[3]))) {
              ctx.globalAlpha = note ? 0.35 + 0.3 * Math.abs(Math.sin(t * 8)) : 0.35; ctx.fillStyle = c.amber; ctx.fillRect(x, y, SQ, SQ);
            }
            ctx.globalAlpha = 1;
            const p = board[r][f];
            if (p && !(anim && anim.p === p)) piece(p, sx(f), sy(r));
          }
        }
        if (anim && anim.p) {
          const k = Math.min(1, anim.t / SLIDE);
          const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
          piece(anim.p, sx(anim.ff) + (sx(anim.tf) - sx(anim.ff)) * e, sy(anim.fr) + (sy(anim.tr) - sy(anim.fr)) * e);
        }
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.strokeRect(OX - 0.5, OY - 0.5, SQ * 8 + 1, SQ * 8 + 1);
        const move = ply ? `${Math.ceil(ply / 2)}.${ply % 2 ? '' : '..'} ${g.san[ply - 1]}` : `${g.where}`;
        label(ctx, c, move, 116, 22, done ? c.amber : c.text, 11);
        if (note) label(ctx, c, note.text, 116 + ctx.measureText(move).width + 14, 22, c.amber, 12);
        if (done) label(ctx, c, 'checkmate', 116, 36, c.amber, 9);
        // the pieces each side has lost so far
        taken.forEach((p, i) => piece(p, 118 + (i % 8) * 7, 50 + Math.floor(i / 8) * 9, 8));
        const lookX = last ? Math.max(-1, Math.min(1, (sx(last[2]) - 168) / 60)) : -0.9;
        drawMascot(ctx, c, 168, 82 + Math.sin(t * 2.4) * 1.2, 26, { lookX, lookY: -0.2, mouth: note || done ? 0.45 : 0 });
      },
      caption: () => `chess · ${GAMES[gi].title}, ${GAMES[gi].where}`,
    };
  }

  /* ---------- chomp: three lanes of food, golden bites, bombs to dodge, combos ---------- */
  function chomp() {
    const EAT = 196;
    const LANES = [46, 66, 86];
    let items = []; let score = 0; let nextIn = 0; let chompAt = -9; let clock = 0;
    let lane = 1; let my = LANES[1]; let combo = 0; let missed = 0; let shake = 0;
    let human = false;
    const parts = [];
    const pops = [];
    const mult = () => Math.min(5, 1 + Math.floor(combo / 4));
    function spawn() {
      const r = Math.random();
      const kind = r < 0.12 ? 'bomb' : r < 0.22 ? 'gold' : r < 0.45 ? 'glyph' : 'dot';
      items.push({ x: -8, lane: rand(3), kind, g: GLYPHS[rand(GLYPHS.length)], r: 2.6 + Math.random() * 1.8, phase: Math.random() * TAU });
    }
    function eat(it) {
      if (it.kind === 'bomb') {
        combo = 0; shake = 6;
        burst(parts, EAT, LANES[it.lane], 'red', 18, 70);
        pop(pops, 'boom', EAT - 8, LANES[it.lane] - 12, 'red', 11);
        return;
      }
      combo += 1;
      const gain = (it.kind === 'gold' ? 5 : 1) * mult();
      score += gain;
      burst(parts, EAT, LANES[it.lane], it.kind === 'gold' ? 'amber' : 'cyan', it.kind === 'gold' ? 12 : 5, 40);
      pop(pops, mult() > 1 ? `+${gain} ×${mult()}` : `+${gain}`, EAT - 6, LANES[it.lane] - 12, it.kind === 'gold' ? 'amber' : 'ok');
    }
    /** The AI: head for the lane of the next good bite, away from bombs. */
    function aiLane() {
      const coming = items.filter((i) => i.x < EAT && i.x > EAT - 120).sort((a, b) => b.x - a.x);
      const bombNear = (l) => coming.some((i) => i.kind === 'bomb' && i.lane === l && i.x > EAT - 40);
      const good = coming.find((i) => i.kind !== 'bomb' && !bombNear(i.lane));
      let want = good ? good.lane : lane;
      if (bombNear(want)) want = [0, 1, 2].find((l) => !bombNear(l)) ?? want;
      return want;
    }
    return {
      name: 'chomp',
      controls: '↑ ↓ lanes · space chomp',
      set human(on) { human = !!on; missed = 0; },
      input(type, k) {
        if (type !== 'down') return [' ', 'ArrowUp', 'ArrowDown', 'w', 's'].includes(k);
        if (k === 'ArrowUp' || k === 'w') { lane = Math.max(0, lane - 1); return true; }
        if (k === 'ArrowDown' || k === 's') { lane = Math.min(2, lane + 1); return true; }
        if (k !== ' ') return false;
        // You chomp: whatever is at the mouth in your lane right now.
        chompAt = clock;
        for (const it of items) if (it.lane === lane && it.x > EAT - 16 && it.x < EAT + 5) { it.gone = true; eat(it); }
        items = items.filter((i) => !i.gone);
        return true;
      },
      score: () => score,
      step(dt) {
        clock += dt;
        nextIn -= dt;
        const speed = Math.min(115, 52 + clock * 0.9);
        if (nextIn <= 0) { spawn(); nextIn = Math.max(0.28, 0.75 - clock * 0.006) + Math.random() * 0.4; }
        for (const it of items) it.x += speed * dt;
        if (!human) {
          lane = aiLane();
          for (const it of items) {
            if (it.x >= EAT && it.lane === lane && it.kind !== 'bomb') { it.gone = true; chompAt = clock; eat(it); }
            else if (it.x >= EAT && it.lane === lane && it.kind === 'bomb' && Math.random() < 0.05) { it.gone = true; chompAt = clock; eat(it); }
          }
        }
        for (const it of items) {
          if (!it.gone && it.x >= EAT + 10) {
            it.gone = true;
            if (human && it.lane === lane && it.kind !== 'bomb') { missed += 1; combo = 0; pop(pops, 'miss', EAT, LANES[it.lane] - 10, 'red'); }
          }
        }
        items = items.filter((i) => !i.gone);
        my += (LANES[lane] - my) * Math.min(1, dt * 14);
        shake = Math.max(0, shake - dt * 14);
        stepParts(parts, dt);
        stepPops(pops, dt);
      },
      draw(ctx, c, t) {
        ctx.save();
        ctx.translate(shakeOffset(shake), shakeOffset(shake));
        ctx.strokeStyle = c.line;
        ctx.setLineDash([2, 6]);
        for (const ly of LANES) { ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(0, ly + 9.5); ctx.lineTo(W, ly + 9.5); ctx.stroke(); }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        for (const it of items) {
          const y = LANES[it.lane] + Math.sin(t * 3.8 + it.phase) * 2;
          if (it.kind === 'glyph') label(ctx, c, it.g, it.x, y + 4, c.text, 11, 'center');
          else if (it.kind === 'gold') { ctx.fillStyle = c.amber; ctx.beginPath(); ctx.arc(it.x, y, 4 + Math.sin(t * 9) * 0.8, 0, TAU); ctx.fill(); }
          else if (it.kind === 'bomb') {
            ctx.fillStyle = c.red; ctx.beginPath(); ctx.arc(it.x, y, 4.2, 0, TAU); ctx.fill();
            ctx.strokeStyle = c.amber; ctx.beginPath(); ctx.moveTo(it.x + 2, y - 4); ctx.lineTo(it.x + 4, y - 7); ctx.stroke();
            if (Math.floor(t * 10) % 2) { ctx.fillStyle = c.amber; ctx.fillRect(it.x + 3.5, y - 8.5, 1.6, 1.6); }
          } else { ctx.fillStyle = c.cyan; ctx.beginPath(); ctx.arc(it.x, y, it.r, 0, TAU); ctx.fill(); }
        }
        const since = clock - chompAt;
        const mouth = since < 0.09 ? since / 0.09 : since < 0.25 ? 1 - (since - 0.09) / 0.16 : 0;
        drawMascot(ctx, c, 212, my + Math.sin(t * 3.4) * 1.2, 28, { mouth, lookX: -0.9, lookY: 0 });
        if (mult() > 1) label(ctx, c, `×${mult()}`, 228, 16, c.amber, 11, 'center');
        drawParts(ctx, c, parts);
        drawPops(ctx, c, pops);
        ctx.restore();
      },
      caption: () => `chomp · ${score} pts · combo ${combo}${human ? ` · missed ${missed}` : ''}`,
    };
  }

  /* ---------- invaders: the mascot is the cannon; shields, a saucer, triple shots ---------- */
  function invaders() {
    const ALIEN = [
      ['..XXXX..', '.XXXXXX.', 'XX.XX.XX', 'XXXXXXXX', '.X.XX.X.', 'X......X'],
      ['..XXXX..', '.XXXXXX.', 'XX.XX.XX', 'XXXXXXXX', '..X..X..', '.X.XX.X.'],
    ];
    const PX = 1.4;
    const AW = 8 * PX;
    const AH = 6 * PX;
    const COLS = 8;
    const ROWS = 3;
    const GX = 20;
    const GY = 13;
    const Y0 = 98;
    const BUNKERS = [44, 120, 196];
    let aliens; let ox; let oy; let dir; let march; let frame; let shots; let bombs; let cx; let cool;
    let lives; let score; let wave; let hit; let ufo; let ufoIn; let caps; let triple; let shields;
    let human = false;
    const keys = { left: false, right: false, fire: false };
    const parts = [];
    const pops = [];
    const alive = () => aliens.filter((a) => a.alive);
    const at = (a) => ({ x: ox + a.c * GX, y: oy + a.r * GY });
    function newShields() {
      shields = [];
      for (const bx of BUNKERS) for (let r = 0; r < 3; r++) for (let q = 0; q < 6; q++) {
        if (r === 2 && (q === 2 || q === 3)) continue; // the arch
        shields.push({ x: bx - 9 + q * 3, y: Y0 - 24 + r * 3, hp: 2 });
      }
    }
    /** Each wave comes in a new shape: full rows, a checkerboard, a V. */
    function newWave() {
      aliens = [];
      const shape = wave % 3;
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const keep = shape === 0 || (shape === 1 && (r + c) % 2 === 0) || (shape === 2 && Math.abs(c - 3.5) >= r + 0.5);
        aliens.push({ c, r, alive: keep });
      }
      ox = 22; oy = 10 + Math.min(wave, 4) * 3; dir = 1; march = 0;
      if (wave) pop(pops, `wave ${wave + 1}`, W / 2, 55, 'ok', 11);
    }
    function reset() {
      wave = 0; score = 0; lives = 3; shots = []; bombs = []; cx = W / 2; cool = 0; hit = 0; frame = 0;
      ufo = null; ufoIn = 8 + Math.random() * 6; caps = []; triple = 0;
      newShields(); newWave();
    }
    function front() {
      const out = new Map();
      for (const a of alive()) if (!out.has(a.c) || out.get(a.c).r < a.r) out.set(a.c, a);
      return [...out.values()];
    }
    function fire() {
      const spread = triple > 0 ? [-45, 0, 45] : [0];
      for (const vx of spread) shots.push({ x: cx, y: Y0 - 9, vx });
      cool = triple > 0 ? 0.3 : 0.4;
    }
    /** A projectile hitting a shield chips it and stops there. */
    function chip(p) {
      const s = shields.find((b) => b.hp > 0 && p.x > b.x - 0.5 && p.x < b.x + 3.5 && p.y > b.y - 0.5 && p.y < b.y + 3.5);
      if (!s) return false;
      s.hp -= 1;
      return true;
    }
    reset();
    return {
      name: 'invaders',
      controls: '← → move · space fire',
      set human(on) { human = !!on; keys.left = keys.right = keys.fire = false; },
      input(type, k) {
        const down = type === 'down';
        if (k === 'ArrowLeft' || k === 'a') keys.left = down;
        else if (k === 'ArrowRight' || k === 'd') keys.right = down;
        else if (k === ' ') keys.fire = down;
        else return false;
        return true;
      },
      score: () => score,
      step(dt) {
        stepParts(parts, dt, 30);
        stepPops(pops, dt);
        if (hit) {
          hit -= dt;
          if (hit <= 0) { hit = 0; if (lives <= 0) reset(); }
          return;
        }
        const left = alive().length;
        march += dt;
        if (march > Math.max(0.09, 0.5 - wave * 0.05 - (1 - left / (COLS * ROWS)) * 0.3)) {
          march = 0;
          frame ^= 1;
          const xs = alive().map((a) => at(a).x);
          if ((dir > 0 && Math.max(...xs) + AW + 6 > W) || (dir < 0 && Math.min(...xs) - 6 < 0)) { dir = -dir; oy += 4; } else ox += dir * 4;
          if (Math.random() < 0.4 + wave * 0.05) {
            const shooters = front();
            const s = shooters[rand(shooters.length)];
            if (s) { const p = at(s); bombs.push({ x: p.x + AW / 2, y: p.y + AH }); }
          }
        }
        // the saucer crosses now and then
        ufoIn -= dt;
        if (!ufo && ufoIn <= 0) { const fromLeft = Math.random() < 0.5; ufo = { x: fromLeft ? -14 : W + 14, vx: fromLeft ? 48 : -48 }; }
        if (ufo) { ufo.x += ufo.vx * dt; if (ufo.x < -20 || ufo.x > W + 20) { ufo = null; ufoIn = 10 + Math.random() * 8; } }
        cool -= dt;
        triple = Math.max(0, triple - dt);
        if (human) {
          cx += ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * 90 * dt;
          if (keys.fire && cool <= 0) fire();
        } else {
          // The AI: a power-up first, the saucer when it is overhead, else the nearest front alien; dodge bombs.
          const targets = front();
          let goal = cx;
          const cap = caps.find((p) => p.y > Y0 - 50);
          if (cap) goal = cap.x;
          else if (ufo && ufo.x > 10 && ufo.x < W - 10) goal = ufo.x + ufo.vx * 0.5;
          else if (targets.length) {
            const t = targets.reduce((m, a) => (Math.abs(at(a).x + AW / 2 - cx) < Math.abs(at(m).x + AW / 2 - cx) ? a : m));
            goal = at(t).x + AW / 2;
          }
          const danger = bombs.find((b) => Math.abs(b.x - cx) < 9 && b.y > Y0 - 45);
          if (danger) goal = cx + (danger.x < cx ? 20 : -20);
          cx += Math.max(-80 * dt, Math.min(80 * dt, goal - cx));
          if (cool <= 0 && !danger && Math.abs(goal - cx) < 4) fire();
        }
        cx = Math.max(8, Math.min(W - 8, cx));
        for (const s of shots) {
          s.y -= 170 * dt;
          s.x += s.vx * dt;
          if (chip(s)) { s.gone = true; continue; }
          if (ufo && Math.abs(s.x - ufo.x) < 8 && s.y < 12) {
            const bonus = [50, 100, 150][rand(3)];
            score += bonus; s.gone = true;
            burst(parts, ufo.x, 7, 'purple', 16, 60);
            pop(pops, `+${bonus}`, ufo.x, 22, 'amber', 11);
            ufo = null; ufoIn = 10 + Math.random() * 8;
            continue;
          }
          for (const a of alive()) {
            const p = at(a);
            if (s.x > p.x && s.x < p.x + AW && s.y > p.y && s.y < p.y + AH) {
              a.alive = false; s.gone = true; score += 10 * (ROWS - a.r);
              burst(parts, p.x + AW / 2, p.y + AH / 2, ['cyan', 'purple', 'amber'][a.r % 3], 8, 40);
              if (Math.random() < 0.08) caps.push({ x: p.x + AW / 2, y: p.y + AH });
              break;
            }
          }
        }
        shots = shots.filter((s) => !s.gone && s.y > 0 && s.x > 0 && s.x < W);
        for (const p of caps) {
          p.y += 40 * dt;
          if (Math.abs(p.x - cx) < 9 && p.y > Y0 - 8) { p.gone = true; triple = 7; pop(pops, 'triple shot!', cx, Y0 - 20, 'ok', 10); }
        }
        caps = caps.filter((p) => !p.gone && p.y < H);
        for (const b of bombs) {
          b.y += (72 + wave * 6) * dt;
          if (chip(b)) { b.gone = true; continue; }
          if (Math.abs(b.x - cx) < 7 && b.y > Y0 - 7 && b.y < Y0 + 6) {
            b.gone = true; lives -= 1; hit = lives > 0 ? 0.9 : 1.6; bombs = [];
            burst(parts, cx, Y0, 'accent', 16, 55);
            break;
          }
        }
        bombs = bombs.filter((b) => !b.gone && b.y < H);
        if (!alive().length) { wave += 1; shots = []; bombs = []; newWave(); }
        else if (oy + ROWS * GY > Y0 - 26) { lives = 0; hit = 1.6; }
      },
      draw(ctx, c, t) {
        const colors = [c.cyan, c.purple, c.amber];
        for (const a of alive()) {
          const p = at(a);
          ctx.fillStyle = colors[a.r % colors.length];
          ALIEN[frame].forEach((row, y) => {
            for (let x = 0; x < row.length; x++) if (row[x] === 'X') ctx.fillRect(p.x + x * PX, p.y + y * PX, PX, PX);
          });
        }
        if (ufo) {
          ctx.fillStyle = c.purple;
          ctx.beginPath(); ctx.ellipse(ufo.x, 8, 9, 3, 0, 0, TAU); ctx.fill();
          ctx.beginPath(); ctx.ellipse(ufo.x, 5.5, 4, 3, 0, Math.PI, TAU); ctx.fill();
          ctx.fillStyle = c.amber;
          for (const lx of [-5, 0, 5]) if (Math.floor(t * 8 + lx) % 2) ctx.fillRect(ufo.x + lx - 0.7, 7.3, 1.4, 1.4);
        }
        for (const s of shields) {
          if (s.hp <= 0) continue;
          ctx.globalAlpha = s.hp === 2 ? 0.9 : 0.45;
          ctx.fillStyle = c.ok;
          ctx.fillRect(s.x, s.y, 3, 3);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.accent;
        for (const s of shots) { ctx.beginPath(); ctx.arc(s.x, s.y, 1.9, 0, TAU); ctx.fill(); }
        for (const p of caps) label(ctx, c, 'W', p.x, p.y + 4, c.ok, 9, 'center');
        ctx.strokeStyle = c.red;
        ctx.lineWidth = 1.2;
        for (const b of bombs) {
          ctx.beginPath(); ctx.moveTo(b.x, b.y - 4); ctx.lineTo(b.x + 1.5, b.y - 2); ctx.lineTo(b.x - 1.5, b.y); ctx.lineTo(b.x, b.y + 2); ctx.stroke();
        }
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, Y0 + 9.5); ctx.lineTo(W, Y0 + 9.5); ctx.stroke();
        drawParts(ctx, c, parts);
        drawPops(ctx, c, pops);
        if (hit && Math.floor(t * 12) % 2) return;
        const look = triple > 0 ? { ...c, accent: Math.floor(t * 6) % 2 ? c.ok : c.accent } : c;
        drawMascot(ctx, look, cx, Y0, 15, { angle: -Math.PI / 2, mouth: cool > 0.25 ? 0.4 : 0, lookX: 0.2, lookY: 0.6, sleep: hit > 0 && lives <= 0 });
      },
      caption: () => `invaders · wave ${wave + 1} · ${score} pts · ${'♥'.repeat(Math.max(0, lives))}${triple > 0 ? ' · ×3' : ''}`,
    };
  }

  /* ---------- dash: geometry-dash style; cube and ship sections, orbs, portals ---------- */
  function dash() {
    const G = 96;
    const CEIL = 12;
    const MX = 52;
    const S = 13;
    const SPEED = 125;
    const LEVEL = 3200;
    // Sections of the level, in metres along it.
    const SECTIONS = [{ mode: 'cube', to: 900 }, { mode: 'ship', to: 1600 }, { mode: 'cube', to: 2400 }, { mode: 'ship', to: LEVEL }];
    let dist; let y; let vy; let rot; let ents; let gap; let attempt = 1; let best = 0; let dead; let trail; let won; let mode; let si; let tunnelC;
    let human = false;
    let holding = false;
    let jumpQueued = false;
    const parts = [];
    const pops = [];
    const sectionAt = (d) => SECTIONS.find((s) => d < s.to) || SECTIONS[SECTIONS.length - 1];
    function reset() {
      dist = 0; y = G; vy = 0; rot = 0; ents = []; gap = 140; dead = 0; trail = []; won = 0;
      mode = 'cube'; si = 0; tunnelC = 60;
    }
    /** One obstacle pattern; returns how wide it is, so the next leaves room to land. */
    function spawnCube(at) {
      const r = Math.random();
      if (r < 0.28) { ents.push({ k: 'spike', x: at, w: 12, h: 12 }); return 12; }
      if (r < 0.46) { ents.push({ k: 'spike', x: at, w: 12, h: 12 }); ents.push({ k: 'spike', x: at + 12, w: 12, h: 12 }); return 24; }
      if (r < 0.66) { ents.push({ k: 'block', x: at, w: 14, h: 14 }); return 14; }
      if (r < 0.84) { ents.push({ k: 'block', x: at, w: 48, h: 14 }); ents.push({ k: 'spike', x: at + 76, w: 12, h: 12 }); return 88; }
      // three spikes, too wide for one jump: a jump orb over the middle one carries you
      for (let i = 0; i < 3; i++) ents.push({ k: 'spike', x: at + i * 12, w: 12, h: 12 });
      ents.push({ k: 'orb', x: at + 16, cy: G - 32, used: false });
      return 36;
    }
    /** Ship sections are a tunnel whose gap wanders up and down. */
    function spawnShip(at) {
      tunnelC = Math.max(CEIL + 24, Math.min(G - 24, tunnelC + (Math.random() - 0.5) * 14));
      const half = 20;
      ents.push({ k: 'wall', x: at, w: 16, top: tunnelC - half, bottom: tunnelC + half });
    }
    function crash() {
      dead = 0.9;
      best = Math.max(best, Math.floor((dist / LEVEL) * 100));
      burst(parts, MX, y - S / 2, 'accent', 18, 70);
    }
    reset();
    return {
      name: 'dash',
      controls: 'space jump · hold to fly the ship',
      set human(on) { human = !!on; holding = false; jumpQueued = false; },
      input(type, k) {
        if (k !== ' ' && k !== 'ArrowUp' && k !== 'w') return false;
        holding = type === 'down';
        if (holding) jumpQueued = true;
        return true;
      },
      score: () => best,
      step(dt) {
        stepParts(parts, dt, 60);
        stepPops(pops, dt);
        if (dead) { dead -= dt; if (dead <= 0) { attempt += 1; reset(); } return; }
        if (won) { won -= dt; if (won <= 0) { attempt = 1; reset(); } return; }
        const dx = SPEED * dt;
        dist += dx;
        if (dist >= LEVEL) { best = 100; won = 2.5; burst(parts, MX, G - 30, 'amber', 30, 80); return; }
        // what spawns depends on the section where it will be
        gap -= dx;
        const ahead = dist + (W + 10 - MX);
        const sec = sectionAt(ahead);
        if (gap <= 0 && ahead < LEVEL - 120) {
          if (sec.mode === 'ship') { spawnShip(W + 10); gap = 16; }
          else { gap = spawnCube(W + 10) + 85 + Math.random() * 70; }
        }
        // a portal at each change of section
        const boundary = SECTIONS[si] ? SECTIONS[si].to : LEVEL;
        if (si < SECTIONS.length - 1 && ahead >= boundary && !ents.some((e) => e.k === 'portal' && e.at === boundary)) {
          ents.push({ k: 'portal', x: W + 10 - (ahead - boundary), at: boundary, to: SECTIONS[si + 1].mode });
          tunnelC = G - 26; // the tunnel starts low, near where the cube runs
          ents = ents.filter((e) => !(e.x > W + 10 - (ahead - boundary) - 20 && e.k !== 'portal'));
          gap = 60;
          si += 1;
        }
        for (const e of ents) e.x -= dx;
        ents = ents.filter((e) => e.x + (e.w || 12) > -10);
        // through a portal: switch mode
        const portal = ents.find((e) => e.k === 'portal' && !e.passed && e.x < MX);
        if (portal) {
          portal.passed = true;
          mode = portal.to;
          burst(parts, MX, y - S / 2, mode === 'ship' ? 'cyan' : 'accent', 14, 50);
          pop(pops, mode === 'ship' ? 'SHIP' : 'CUBE', MX + 30, 30, mode === 'ship' ? 'cyan' : 'ok', 10);
        }
        if (mode === 'ship') {
          // The AI: aim for the middle of the next gap.
          // y is Tail's bottom edge, as in cube mode; it spans y - S .. y.
          let up = holding;
          if (!human) {
            const ahead = ents.filter((e) => e.k === 'wall' && e.x + e.w > MX - 6 && e.x < MX + 34);
            const target = ahead.length ? ahead.reduce((sum, e) => sum + (e.top + e.bottom) / 2, 0) / ahead.length : G - 30;
            // brake early: rising at full speed takes ~25 px to stop
            up = y - S / 2 - target + vy * 0.18 > 0;
          }
          vy += (up ? -720 : 560) * dt;
          vy = Math.max(-170, Math.min(170, vy));
          y += vy * dt;
          if (y - S < CEIL) { y = CEIL + S; vy = 0; }
          if (y > G) { y = G; vy = 0; }
          rot = vy / 420;
          for (const e of ents) {
            if (e.k !== 'wall' || e.x > MX + 6 || e.x + e.w < MX - 6) continue;
            if (y - S + 2 < e.top || y - 2 > e.bottom) { crash(); break; }
          }
        } else {
          const under = ents.filter((e) => e.k === 'block' && e.x < MX + S / 2 - 1 && e.x + e.w > MX - S / 2 + 1);
          const floor = under.length ? Math.min(...under.map((e) => G - e.h)) : G;
          const grounded = y >= floor - 0.5 && vy >= 0;
          const orb = ents.find((e) => e.k === 'orb' && !e.used && Math.abs(e.x - MX) < 10 && Math.abs(e.cy - (y - S / 2)) < 18);
          if (human) {
            if (grounded && (holding || jumpQueued)) vy = -300;
            if (orb && (jumpQueued || holding)) { vy = -300; orb.used = true; burst(parts, orb.x, orb.cy, 'amber', 10, 40); }
            jumpQueued = false;
          } else {
            if (grounded) {
              // The AI: jump when the next spike or wall is in reach; now and then a frame late.
              const next = ents.find((e) => e.x + (e.w || 0) > MX - S / 2 && (e.k === 'spike' || (e.k === 'block' && G - e.h < y - 1)));
              if (next) {
                const d = next.x - (MX + S / 2);
                if (d > 4 && d < (next.k === 'spike' ? 20 : 16) && Math.random() > 0.006) vy = -300;
              }
            }
            if (orb && vy > -60) { vy = -300; orb.used = true; burst(parts, orb.x, orb.cy, 'amber', 10, 40); }
          }
          vy += 1100 * dt;
          y += vy * dt;
          if (y >= floor && vy > 0) { y = floor; vy = 0; }
          rot = y < floor - 0.5 ? rot + dt * 11.5 : 0;
          for (const e of ents) {
            const overlapX = e.x + 2 < MX + S / 2 && e.x + (e.w || 0) - 2 > MX - S / 2;
            if (!overlapX) continue;
            if (e.k === 'spike' && y > G - e.h + 4) { crash(); break; }
            if (e.k === 'block' && y > G - e.h + 3 && e.x > MX - S / 2) { crash(); break; }
          }
        }
        trail.push({ x: MX, y: y - S / 2 });
        if (trail.length > 8) trail.shift();
        for (const tp of trail) tp.x -= dx;
      },
      draw(ctx, c, t) {
        const tint = mode === 'ship' ? c.purple : c.line;
        ctx.strokeStyle = tint;
        ctx.globalAlpha = 0.22 + 0.12 * Math.max(0, Math.sin(t * 8));
        for (let i = 0; i < 10; i++) {
          const bx = (i * 30 - (dist * 0.4) % 30);
          ctx.beginPath(); ctx.moveTo(bx, CEIL); ctx.lineTo(bx, G); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.panel;
        ctx.fillRect(0, G, W, H - G);
        const edge = mode === 'ship' ? c.cyan : c.accent;
        ctx.strokeStyle = edge;
        ctx.shadowColor = edge; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.moveTo(0, G + 0.5); ctx.lineTo(W, G + 0.5); ctx.stroke();
        if (mode === 'ship') { ctx.beginPath(); ctx.moveTo(0, CEIL - 0.5); ctx.lineTo(W, CEIL - 0.5); ctx.stroke(); }
        ctx.shadowBlur = 0;
        for (const e of ents) {
          if (e.k === 'spike') {
            ctx.fillStyle = c.bg; ctx.strokeStyle = c.text; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(e.x, G); ctx.lineTo(e.x + e.w / 2, G - e.h); ctx.lineTo(e.x + e.w, G); ctx.closePath(); ctx.fill(); ctx.stroke();
          } else if (e.k === 'block') {
            ctx.fillStyle = c.panel; ctx.strokeStyle = c.cyan; ctx.lineWidth = 1.2;
            ctx.fillRect(e.x, G - e.h, e.w, e.h); ctx.strokeRect(e.x + 0.5, G - e.h + 0.5, e.w - 1, e.h - 1);
          } else if (e.k === 'wall') {
            ctx.fillStyle = c.panel; ctx.strokeStyle = c.purple; ctx.lineWidth = 1;
            ctx.fillRect(e.x, CEIL, e.w, e.top - CEIL); ctx.fillRect(e.x, e.bottom, e.w, G - e.bottom);
            ctx.beginPath(); ctx.moveTo(e.x, e.top); ctx.lineTo(e.x + e.w, e.top); ctx.moveTo(e.x, e.bottom); ctx.lineTo(e.x + e.w, e.bottom); ctx.stroke();
          } else if (e.k === 'orb') {
            ctx.strokeStyle = c.amber; ctx.lineWidth = 2;
            ctx.globalAlpha = e.used ? 0.3 : 1;
            ctx.beginPath(); ctx.arc(e.x, e.cy, 4.5 + Math.sin(t * 10) * 0.8, 0, TAU); ctx.stroke();
            ctx.globalAlpha = 1;
          } else if (e.k === 'portal') {
            const pc = e.to === 'ship' ? c.cyan : c.accent;
            ctx.strokeStyle = pc; ctx.lineWidth = 2.5; ctx.shadowColor = pc; ctx.shadowBlur = 8;
            ctx.beginPath(); ctx.ellipse(e.x, (CEIL + G) / 2, 6, (G - CEIL) / 2 - 4, 0, 0, TAU); ctx.stroke();
            ctx.shadowBlur = 0;
          }
        }
        ctx.fillStyle = c.line; ctx.fillRect(20, 3, W - 40, 3);
        ctx.fillStyle = c.accent; ctx.fillRect(20, 3, (W - 40) * Math.min(1, dist / LEVEL), 3);
        drawParts(ctx, c, parts);
        drawPops(ctx, c, pops);
        if (dead) return;
        trail.forEach((tp, i) => {
          ctx.globalAlpha = (i / trail.length) * 0.5;
          ctx.fillStyle = mode === 'ship' ? c.cyan : c.accent;
          ctx.beginPath(); ctx.arc(tp.x - 4, tp.y, 1.6 + i * 0.25, 0, TAU); ctx.fill();
        });
        ctx.globalAlpha = 1;
        if (won) label(ctx, c, 'level complete', W / 2, 40, c.ok, 11, 'center');
        drawMascot(ctx, c, MX, y - S / 2, S + 3, { angle: rot, lookX: 0.8, lookY: 0 });
      },
      caption: () => `dash · ${mode} · attempt ${attempt} · ${Math.floor((dist / LEVEL) * 100)}%`,
    };
  }

  const GAMES = { snake, tetris, runner, chess, chomp, invaders, dash };
  window.__mascotGames = {
    W,
    H,
    get names() { return Object.keys(GAMES); },
    create: (name) => GAMES[name](),
    /** More games register here (mascot-games-more.js). */
    add(name, factory) { GAMES[name] = factory; },
    drawMascot,
    label,
    GLYPHS,
    fx: { burst, stepParts, drawParts, pop, stepPops, drawPops },
  };
})();
