// More of the mascot's games: breakout, flappy and typer. They register with
// mascot-games.js (which must load first) and run in stage.js's loop like the
// others, on the same small canvas and in the theme's colours.
// Loaded by index.html as a classic script, after mascot-games.js.
/* ---------- more mascot games ---------- */
(() => {
  const games = window.__mascotGames;
  if (!games) return;
  const { W, H, drawMascot, label, GLYPHS } = games;
  const TAU = Math.PI * 2;
  const rand = (n) => Math.floor(Math.random() * n);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Bursts of dots and floating text come from mascot-games.js, shared by every game.
  const { burst, stepParts, drawParts, stepPops, drawPops } = games.fx;

  /* ---------- breakout: Tail holds up the paddle, the ball trails tail dots ---------- */
  function breakout() {
    const COLS = 11;
    const ROWS = 5;
    const BW = 18;
    const BH = 5;
    const OX = 11;
    const OY = 12;
    const PY = 94;
    const R = 2.2;
    const ROW_COLORS = ['cyan', 'purple', 'amber', 'ok', 'orange'];
    // Power-ups fall from broken bricks: W a wide paddle, M more balls, S a slower ball.
    const POWERS = { W: 'amber', M: 'cyan', S: 'purple' };
    const NAMES = { W: 'wide', M: 'multi', S: 'slow' };
    let bricks; let balls; let px; let lives; let score; let level; let serve; let wide; let slow; let ramp;
    let drops; let parts; let pops; let flash; let over; let aim; let bounceAt = -9;
    let clock = 0;
    let human = false;
    const keys = { left: false, right: false };
    const pw = () => (wide > 0 ? 46 : 30);
    const speed = () => (96 + level * 9 + ramp) * (slow > 0 ? 0.65 : 1);
    /** The layouts, in turn: rows with gaps, a pyramid, a checkerboard, a scatter. */
    function layout(n) {
      const kind = n % 4;
      const out = [];
      for (let r = 0; r < ROWS; r++) {
        for (let col = 0; col < COLS; col++) {
          const on = kind === 0 ? r < 4 && col % 4 !== (r % 2 ? 1 : 3)
            : kind === 1 ? Math.abs(col - 5) <= r + 1
              : kind === 2 ? (col + r) % 2 === 0
                : Math.random() < 0.6;
          if (!on) continue;
          const hp = (kind === 1 && r === 0) || Math.random() < Math.min(0.35, 0.06 + n * 0.05) ? 2 : 1;
          out.push({ x: OX + col * (BW + 2), y: OY + r * (BH + 2), r, hp, max: hp, hit: 0 });
        }
      }
      return out.length ? out : layout(0);
    }
    const newBall = (x, y, a, sp) => ({ x, y, vx: Math.sin(a) * sp, vy: -Math.cos(a) * sp, trail: [] });
    function serveBall() { balls = []; serve = 0.8; aim = 0; }
    function reset() {
      level = 0; score = 0; lives = 3; px = W / 2; wide = 0; slow = 0; ramp = 0;
      drops = []; parts = []; pops = []; flash = 0; over = 0;
      bricks = layout(0);
      serveBall();
    }
    function hitBrick(k) {
      k.hp -= 1;
      k.hit = 0.12;
      if (k.hp > 0) { score += 5; return; }
      score += 10 * k.max;
      burst(parts, k.x + BW / 2, k.y + BH / 2, ROW_COLORS[k.r], 6, 45);
      if (Math.random() < 0.13) { const kinds = Object.keys(POWERS); drops.push({ x: k.x + BW / 2, y: k.y, kind: kinds[rand(kinds.length)] }); }
    }
    function power(kind) {
      pops.push({ x: px, y: PY - 6, text: NAMES[kind], age: 0, color: POWERS[kind] });
      score += 5;
      if (kind === 'W') wide = 10;
      else if (kind === 'S') slow = 6;
      else {
        const more = [];
        for (const b of balls.slice(0, 3)) for (const d of [-0.5, 0.5]) more.push(newBall(b.x, b.y, Math.atan2(b.vx, -b.vy) + d, speed()));
        balls.push(...more);
      }
    }
    /** Move one ball in small steps so it cannot skip through a brick. */
    function moveBall(b, dt) {
      const n = Math.max(1, Math.ceil((Math.hypot(b.vx, b.vy) * dt) / 2.5));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        const ox = b.x;
        const oy = b.y;
        b.x += b.vx * h; b.y += b.vy * h;
        if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx); }
        if (b.x > W - R) { b.x = W - R; b.vx = -Math.abs(b.vx); }
        if (b.y < R) { b.y = R; b.vy = Math.abs(b.vy); }
        // The paddle: where the ball lands on it sets the angle it leaves at.
        const half = pw() / 2;
        if (b.vy > 0 && oy + R <= PY && b.y + R >= PY && Math.abs(b.x - px) <= half + R) {
          const a = clamp((b.x - px) / half, -1, 1) * 1.05;
          b.vx = Math.sin(a) * speed(); b.vy = -Math.cos(a) * speed(); b.y = PY - R;
          b.bounced = true;
        }
        for (const k of bricks) {
          if (k.hp <= 0 || b.x + R < k.x || b.x - R > k.x + BW || b.y + R < k.y || b.y - R > k.y + BH) continue;
          if (ox + R <= k.x || ox - R >= k.x + BW) b.vx = -b.vx; else b.vy = -b.vy;
          b.x = ox; b.y = oy;
          hitBrick(k);
          break;
        }
      }
    }
    /** Where a falling ball reaches the paddle, folding in the side-wall bounces. */
    function landing(b) {
      const span = W - 2 * R;
      const x = b.x + b.vx * ((PY - R - b.y) / b.vy) - R;
      const m = ((x % (2 * span)) + 2 * span) % (2 * span);
      return R + (m > span ? 2 * span - m : m);
    }
    function think(dt) {
      // The AI: get under where the next ball comes down, a little off centre to angle it;
      // grab a power-up when there is time. Now and then it misjudges by a paddle.
      const falling = balls.filter((b) => b.vy > 0).sort((a, b) => (PY - a.y) / a.vy - (PY - b.y) / b.vy);
      let goal = balls.length ? balls[0].x : W / 2;
      if (falling.length) goal = landing(falling[0]) + aim;
      const drop = drops.find((d) => d.y > 50);
      if (drop && (!falling.length || (PY - falling[0].y) / falling[0].vy > 0.9)) goal = drop.x;
      px += clamp((goal - px) * 9, -210, 210) * dt;
    }
    reset();
    return {
      name: 'breakout',
      controls: '← → move · space serve',
      set human(on) { human = !!on; keys.left = keys.right = false; },
      input(type, k) {
        const down = type === 'down';
        if (k === 'ArrowLeft' || k === 'a') keys.left = down;
        else if (k === 'ArrowRight' || k === 'd') keys.right = down;
        else if (k === ' ') { if (down && serve > 0) serve = 0.001; }
        else return false;
        return true;
      },
      score: () => score,
      step(dt) {
        clock += dt;
        stepParts(parts, dt);
        stepPops(pops, dt);
        if (over) { over -= dt; if (over <= 0) reset(); return; }
        flash = Math.max(0, flash - dt);
        wide = Math.max(0, wide - dt);
        slow = Math.max(0, slow - dt);
        ramp = Math.min(35, ramp + dt);
        if (human) px += ((keys.right ? 1 : 0) - (keys.left ? 1 : 0)) * 190 * dt;
        else think(dt);
        px = clamp(px, pw() / 2, W - pw() / 2);
        if (serve > 0) {
          serve -= dt;
          if (serve <= 0) balls = [newBall(px, PY - R, (Math.random() - 0.5) * 0.9, speed())];
        }
        const s = speed();
        for (const b of balls) {
          moveBall(b, dt);
          // Keep every ball at the current speed, and never too flat to come back down.
          if (Math.abs(b.vy) < s * 0.3) b.vy = (b.vy < 0 ? -1 : 1) * s * 0.3;
          const f = s / Math.hypot(b.vx, b.vy);
          b.vx *= f; b.vy *= f;
          b.trail.push({ x: b.x, y: b.y });
          if (b.trail.length > 6) b.trail.shift();
          if (b.bounced) {
            b.bounced = false;
            bounceAt = clock;
            aim = Math.random() < 0.035 ? (Math.random() < 0.5 ? -1 : 1) * (pw() / 2 + 9) : (Math.random() - 0.5) * pw() * 0.7;
          }
        }
        balls = balls.filter((b) => b.y < H + 6);
        if (!balls.length && serve <= 0) {
          lives -= 1;
          wide = 0; slow = 0;
          if (lives <= 0) over = 1.4; else serveBall();
        }
        for (const d of drops) {
          d.y += 38 * dt;
          if (d.y >= PY - 3 && d.y <= PY + 4 && Math.abs(d.x - px) < pw() / 2 + 3) { d.gone = true; power(d.kind); }
        }
        drops = drops.filter((d) => !d.gone && d.y < H + 4);
        for (const k of bricks) k.hit = Math.max(0, k.hit - dt);
        if (bricks.every((k) => k.hp <= 0)) {
          // Cleared: a small party, then the next layout, a touch faster.
          level += 1; score += 50; flash = 1.4; ramp = 0; drops = [];
          for (let i = 0; i < 5; i++) burst(parts, 40 + i * 40, 40, ROW_COLORS[i], 7, 70);
          bricks = layout(level);
          serveBall();
        }
      },
      draw(ctx, c, t) {
        for (const k of bricks) {
          if (k.hp <= 0) continue;
          ctx.globalAlpha = over ? 0.3 : k.hp > 1 ? 1 : 0.72;
          ctx.fillStyle = k.hit ? c.text : c[ROW_COLORS[k.r]];
          ctx.fillRect(k.x, k.y, BW, BH);
          if (k.hp > 1) { ctx.strokeStyle = c.text; ctx.lineWidth = 1; ctx.strokeRect(k.x + 0.5, k.y + 0.5, BW - 1, BH - 1); }
        }
        ctx.globalAlpha = 1;
        for (const d of drops) {
          ctx.strokeStyle = c[POWERS[d.kind]]; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(d.x, d.y, 4.5, 0, TAU); ctx.stroke();
          label(ctx, c, d.kind, d.x, d.y + 2.5, c[POWERS[d.kind]], 7, 'center');
        }
        ctx.fillStyle = c.accent;
        for (const b of balls) {
          b.trail.forEach((p, i) => { ctx.globalAlpha = ((i + 1) / (b.trail.length + 1)) * 0.45; ctx.beginPath(); ctx.arc(p.x, p.y, 0.7 + i * 0.25, 0, TAU); ctx.fill(); });
          ctx.globalAlpha = 1;
          ctx.shadowColor = c.accent; ctx.shadowBlur = 5;
          ctx.beginPath(); ctx.arc(b.x, b.y, R, 0, TAU); ctx.fill();
          ctx.shadowBlur = 0;
        }
        if (serve > 0 && !over) { ctx.beginPath(); ctx.arc(px, PY - R, R, 0, TAU); ctx.fill(); }
        // the paddle, blinking when the wide one is about to run out
        const blink = wide > 0 && wide < 2 && Math.floor(t * 10) % 2;
        ctx.fillStyle = slow > 0 ? c.purple : c.dim;
        ctx.fillRect(px - pw() / 2, PY, pw(), 3);
        ctx.fillStyle = blink ? c.text : c.accent;
        ctx.fillRect(px - pw() / 2, PY, pw(), 1);
        drawParts(ctx, c, parts);
        drawPops(ctx, c, pops);
        if (flash) { ctx.globalAlpha = Math.min(1, flash * 2); label(ctx, c, `level ${level + 1}`, W / 2, 64, c.ok, 12, 'center'); ctx.globalAlpha = 1; }
        if (over && Math.floor(t * 6) % 2) label(ctx, c, 'game over', W / 2, 64, c.red, 11, 'center');
        // Tail under the paddle, its eye on the ball
        const b = balls.reduce((m, o) => (!m || o.y > m.y ? o : m), null);
        const bx = b ? b.x : px;
        const by = b ? b.y : PY - R;
        const n = Math.hypot(bx - px, by - 103) || 1;
        drawMascot(ctx, c, px, 103, 11, { lookX: (bx - px) / n, lookY: (by - 103) / n, mouth: clock - bounceAt < 0.15 || flash ? 0.5 : 0, sleep: over > 0 });
      },
      caption: () => `breakout · level ${level + 1} · ${score} pts · ${'♥'.repeat(Math.max(0, lives))}`,
    };
  }

  /* ---------- flappy: Tail flaps through gaps in columns of curly brackets ---------- */
  function flappy() {
    const MX = 62;
    const PW = 14;
    const FLOOR = H - 6;
    const GRAV = 420;
    const FLAP = -118;
    const HIT = 4.5;
    let y; let vy; let pillars; let speed; let passed; let coins; let gapIn; let dead; let ready;
    let parts; let pops; let trail; let dist; let cheer; let jitter;
    let flapAt = -9;
    let clock = 0;
    let human = false;
    let flapQueued = false;
    const clouds = [0, 1, 2].map((i) => ({ x: 30 + i * 85, y: 16 + rand(30), g: GLYPHS[rand(GLYPHS.length)] }));
    const gapSize = () => Math.max(34, 46 - passed * 0.5);
    function reset() {
      y = H / 2; vy = 0; pillars = []; speed = 58; passed = 0; coins = 0; gapIn = 40; dead = 0;
      ready = human ? Infinity : 0.6; parts = []; pops = []; trail = []; dist = 0; cheer = 0; jitter = 0;
    }
    /** A new pair of columns: the gap wanders from the last one, narrows, and later some drift. */
    function spawn() {
      const g = gapSize();
      const drift = passed >= 5 && Math.random() < 0.35 ? 6 + Math.random() * 7 : 0;
      const prev = pillars.length ? pillars[pillars.length - 1].base : H / 2;
      const base = clamp(prev + (Math.random() - 0.5) * 56, 12 + g / 2 + drift, FLOOR - 8 - g / 2 - drift);
      pillars.push({
        x: W + 4, base, gy: base, gap: g, drift, phase: Math.random() * TAU, passed: false,
        coin: Math.random() < 0.4 ? { taken: false } : null,
        slip: Math.random() < 0.035, // the AI's mind wanders at this one
      });
    }
    function crash() {
      if (dead) return;
      dead = 1.3;
      burst(parts, MX, y, 'accent', 12, 60);
    }
    reset();
    return {
      name: 'flappy',
      controls: 'space flap',
      set human(on) { human = !!on; flapQueued = false; if (!human && ready > 1) ready = 0.6; },
      input(type, k) {
        if (k !== ' ' && k !== 'ArrowUp' && k !== 'w') return false;
        if (type === 'down') flapQueued = true;
        return true;
      },
      score: () => passed + coins,
      step(dt) {
        clock += dt;
        stepParts(parts, dt, 80);
        stepPops(pops, dt);
        cheer = Math.max(0, cheer - dt);
        for (const cl of clouds) { cl.x -= speed * 0.2 * dt; if (cl.x < -30) { cl.x = W + 20; cl.y = 16 + rand(30); cl.g = GLYPHS[rand(GLYPHS.length)]; } }
        if (dead) { dead -= dt; vy += GRAV * dt; y = Math.min(FLOOR - 3, y + vy * dt); if (dead <= 0) reset(); return; }
        if (ready > 0) {
          ready = human ? (flapQueued ? 0 : ready) : ready - dt;
          if (ready > 0) { y = H / 2 + Math.sin(clock * 5) * 3; vy = 0; return; }
        }
        const dx = speed * dt;
        dist += dx;
        gapIn -= dx;
        if (gapIn <= 0) { spawn(); gapIn = 80 + Math.random() * 14; }
        for (const p of pillars) { p.x -= dx; p.gy = p.base + Math.sin(clock * 1.6 + p.phase) * p.drift; }
        pillars = pillars.filter((p) => p.x > -PW - 4);
        for (const tp of trail) tp.x -= dx;
        trail.push({ x: MX - 6, y });
        if (trail.length > 5) trail.shift();
        let flap = flapQueued;
        if (!human) {
          // The AI: flap whenever it sinks a little under the middle of the next gap.
          const next = pillars.find((p) => p.x + PW > MX - HIT);
          const goal = next ? next.gy + (next.slip ? next.gap * 0.55 : 0) : H / 2;
          flap = y > goal + 5 + jitter && vy > -10 && clock - flapAt > 0.16;
        }
        flapQueued = false;
        if (flap) { vy = FLAP; flapAt = clock; jitter = (Math.random() - 0.5) * 4; }
        vy += GRAV * dt;
        y += vy * dt;
        if (y < HIT) { y = HIT; vy = Math.max(0, vy); }
        if (y > FLOOR - HIT) { crash(); return; }
        for (const p of pillars) {
          if (MX + HIT > p.x && MX - HIT < p.x + PW && (y - HIT < p.gy - p.gap / 2 || y + HIT > p.gy + p.gap / 2)) { crash(); return; }
          if (p.coin && !p.coin.taken && Math.abs(p.x + PW / 2 - MX) < 6 && Math.abs(p.gy - y) < 9) {
            p.coin.taken = true; coins += 1;
            burst(parts, MX + 4, p.gy, 'cyan', 6, 40);
            pops.push({ x: MX, y: y - 12, text: '+coin', age: 0, color: 'cyan' });
          }
          if (!p.passed && p.x + PW < MX - HIT) {
            p.passed = true; passed += 1;
            pops.push({ x: MX, y: y - 10, text: '+1', age: 0, color: 'ok' });
            if (passed % 10 === 0) { cheer = 1.3; for (let i = 0; i < 3; i++) burst(parts, W / 2 - 30 + i * 30, 34, ['ok', 'amber', 'cyan'][i], 7, 60); }
          }
        }
        speed = Math.min(90, 58 + passed * 1.1);
      },
      draw(ctx, c, t) {
        for (const cl of clouds) { ctx.globalAlpha = 0.25; label(ctx, c, cl.g, cl.x, cl.y, c.muted, 10); }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.lineDashOffset = dist % 8;
        ctx.beginPath(); ctx.moveTo(0, FLOOR + 0.5); ctx.lineTo(W, FLOOR + 0.5); ctx.stroke();
        ctx.setLineDash([]);
        for (const p of pillars) {
          const top = p.gy - p.gap / 2;
          const bot = p.gy + p.gap / 2;
          const edge = p.drift ? c.orange : c.purple;
          ctx.fillStyle = c.panel;
          ctx.fillRect(p.x, 0, PW, top);
          ctx.fillRect(p.x, bot, PW, FLOOR - bot);
          // the column is a stack of braces, closed by a bracket cap at the gap
          ctx.globalAlpha = 0.55;
          for (let yy = top - 3; yy > 0; yy -= 9) label(ctx, c, '}', p.x + PW / 2, yy, c.dim, 9, 'center');
          for (let yy = bot + 10; yy < FLOOR; yy += 9) label(ctx, c, '{', p.x + PW / 2, yy, c.dim, 9, 'center');
          ctx.globalAlpha = 1;
          ctx.strokeStyle = edge; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(p.x - 2, top - 4); ctx.lineTo(p.x - 2, top); ctx.lineTo(p.x + PW + 2, top); ctx.lineTo(p.x + PW + 2, top - 4); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(p.x - 2, bot + 4); ctx.lineTo(p.x - 2, bot); ctx.lineTo(p.x + PW + 2, bot); ctx.lineTo(p.x + PW + 2, bot + 4); ctx.stroke();
          ctx.lineWidth = 1;
          ctx.strokeRect(p.x + 0.5, -1, PW - 1, top - 3);
          ctx.strokeRect(p.x + 0.5, bot + 3.5, PW - 1, FLOOR - bot - 3.5);
          if (p.coin && !p.coin.taken) {
            ctx.fillStyle = c.cyan; ctx.shadowColor = c.cyan; ctx.shadowBlur = 4;
            ctx.beginPath(); ctx.arc(p.x + PW / 2, p.gy, 2.3 + Math.sin(t * 7) * 0.5, 0, TAU); ctx.fill();
            ctx.shadowBlur = 0;
          }
        }
        drawParts(ctx, c, parts);
        drawPops(ctx, c, pops);
        if (cheer) { ctx.globalAlpha = Math.min(1, cheer * 2); label(ctx, c, `${passed}!`, W / 2, 30, c.ok, 13, 'center'); ctx.globalAlpha = 1; }
        if (ready > 0 && human) label(ctx, c, 'space to flap', W / 2, 30, c.muted, 9, 'center');
        if (dead && Math.floor(t * 12) % 2) return;
        ctx.fillStyle = c.accent;
        trail.forEach((tp, i) => { ctx.globalAlpha = (i / trail.length) * 0.4; ctx.beginPath(); ctx.arc(tp.x, tp.y, 0.8 + i * 0.3, 0, TAU); ctx.fill(); });
        ctx.globalAlpha = 1;
        const tilt = dead ? 1.2 : clamp(vy / 260, -0.5, 0.9);
        drawMascot(ctx, c, MX, y, 13, { angle: tilt, mouth: clock - flapAt < 0.12 ? 0.5 : 0, lookX: 0.9, lookY: clamp(vy / 200, -0.6, 0.6), sleep: dead > 0 });
      },
      caption: () => `flappy · ${passed} pillar${passed === 1 ? '' : 's'} · ${coins} coin${coins === 1 ? '' : 's'}`,
    };
  }

  /* ---------- typer: shell commands rain down, Tail types them away ---------- */
  function typer() {
    const WORDS = [
      'git push', 'npm test', 'ls -la', 'cd ..', 'make', 'grep todo', 'npm i', 'git rebase', 'cargo build',
      'docker ps', 'rm -rf dist', 'git stash', 'pnpm dev', 'node .', 'ssh prod', 'git diff', 'cat .env',
      'go run .', 'tsc -w', 'kill -9', 'top', 'vim .', 'git log', 'pip install',
    ];
    const KEYS = 'abcdefghijklmnopqrstuvwxyz';
    const GROUND = 90;
    const TX = W / 2;
    const TY = 101;
    let words; let target; let lives; let chars; let cleared; let spawnIn; let parts; let pops; let shots;
    let over; let hurt; let lvlFlash; let typeIn; let aim = -Math.PI / 2;
    let cw = 5.4; // one character at 9px, measured again on every draw
    let clock = 0;
    let human = false;
    const levelOf = () => 1 + Math.floor(cleared / 8);
    function reset() {
      words = []; target = null; lives = 3; chars = 0; cleared = 0; spawnIn = 0.3;
      parts = []; pops = []; shots = []; over = 0; hurt = 0; lvlFlash = 0; typeIn = 0;
    }
    /** A new command at the top, somewhere it does not sit on another one. */
    function spawn() {
      const used = new Set(words.map((w) => w.text));
      let text = WORDS[rand(WORDS.length)];
      for (let i = 0; i < 5 && used.has(text); i++) text = WORDS[rand(WORDS.length)];
      const wide = text.length * cw;
      const pick = () => 4 + Math.random() * Math.max(1, W - wide - 8);
      let x = pick();
      for (let i = 0; i < 6 && words.some((w) => w.y < 34 && x < w.x + w.text.length * cw + 6 && x + wide + 6 > w.x); i++) x = pick();
      words.push({ text, x, y: 10, v: (6 + levelOf() * 1.5) * (0.75 + Math.random() * 0.5), typed: 0, wrong: '', wrongT: 0 });
    }
    function finish(w) {
      const before = levelOf();
      chars += w.text.length;
      cleared += 1;
      for (let i = 0; i < w.text.length; i++) if (w.text[i] !== ' ') burst(parts, w.x + i * cw + cw / 2, w.y - 3, i % 2 ? 'ok' : 'cyan', 2, 40);
      pops.push({ x: w.x + (w.text.length * cw) / 2, y: w.y - 6, text: `+${w.text.length}`, age: 0, color: 'ok' });
      words = words.filter((o) => o !== w);
      target = null;
      if (levelOf() > before) lvlFlash = 1.3;
    }
    /** One key: the right next letter turns green and Tail fires a dot at it; a wrong one shows red. */
    function press(k) {
      if (!target) {
        target = words.filter((w) => w.text[0] === k).sort((a, b) => b.y - a.y)[0] || null;
        if (!target) { pops.push({ x: TX, y: TY - 12, text: k === ' ' ? '·' : k, age: 0.3, color: 'red' }); return; }
      }
      const w = target;
      if (w.text[w.typed] === k) {
        shots.push({ w, i: w.typed, age: 0 });
        w.typed += 1;
        w.wrong = '';
        if (w.typed >= w.text.length) finish(w);
      } else {
        w.wrong = k;
        w.wrongT = 0.3;
      }
    }
    function backspace() {
      if (!target) return;
      if (target.wrong) target.wrong = '';
      else if (target.typed > 0) target.typed -= 1;
      if (!target.typed && !target.wrong) target = null;
    }
    function think(dt) {
      // The AI: take the lowest command and type it at a human pace, with the odd typo it backs out of.
      if (!target && words.length) { target = words.reduce((m, w) => (w.y > m.y ? w : m)); typeIn = 0.25 + Math.random() * 0.2; }
      typeIn -= dt;
      if (!target || typeIn > 0) return;
      const w = target;
      if (w.wrong) { w.wrong = ''; typeIn = 0.12; return; }
      if (Math.random() < 0.04) {
        let k = KEYS[rand(KEYS.length)];
        while (k === w.text[w.typed]) k = KEYS[rand(KEYS.length)];
        w.wrong = k;
        w.wrongT = 9; // stays red until it backspaces
        typeIn = 0.3 + Math.random() * 0.2;
        return;
      }
      press(w.text[w.typed]);
      typeIn = 1 / (7 + Math.random() * 3);
    }
    reset();
    return {
      name: 'typer',
      controls: 'type the commands · ⌫ undo',
      wantsText: true,
      set human(on) {
        human = !!on;
        if (target) { target.typed = 0; target.wrong = ''; target = null; }
      },
      input(type, k) {
        if (k.length !== 1 && k !== 'Backspace') return false;
        if (type !== 'down' || !human || over) return true;
        if (k === 'Backspace') backspace(); else press(k);
        return true;
      },
      score: () => chars,
      step(dt) {
        clock += dt;
        stepParts(parts, dt, 40);
        stepPops(pops, dt);
        shots = shots.filter((s) => (s.age += dt) < 0.14);
        hurt = Math.max(0, hurt - dt);
        lvlFlash = Math.max(0, lvlFlash - dt);
        if (over) { over -= dt; if (over <= 0) reset(); return; }
        spawnIn -= dt;
        if (spawnIn <= 0) { spawn(); spawnIn = Math.max(0.8, 2.6 - levelOf() * 0.2) * (0.7 + Math.random() * 0.6); }
        for (const w of words) {
          w.y += w.v * dt;
          if (w.wrong && (w.wrongT -= dt) <= 0) w.wrong = '';
          if (w.y >= GROUND) {
            w.dead = true; lives -= 1; hurt = 0.45;
            burst(parts, w.x + (w.text.length * cw) / 2, GROUND, 'red', 9, 45);
            if (target === w) target = null;
          }
        }
        words = words.filter((w) => !w.dead);
        if (lives <= 0) { over = 1.5; target = null; return; }
        if (!human) think(dt);
        // Tail turns toward the letter it is about to type.
        const tx = target ? target.x + target.typed * cw + cw / 2 : TX;
        const ty = target ? target.y - 3 : 0;
        aim += (Math.atan2(ty - TY, tx - TX) - aim) * Math.min(1, dt * 10);
      },
      draw(ctx, c, t) {
        ctx.font = '9px "JetBrains Mono", Consolas, monospace';
        cw = ctx.measureText('0').width || 5.4;
        if (hurt) { ctx.globalAlpha = hurt * 0.3; ctx.fillStyle = c.red; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
        ctx.strokeStyle = hurt ? c.red : c.line;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(0, GROUND + 1.5); ctx.lineTo(W, GROUND + 1.5); ctx.stroke();
        ctx.setLineDash([]);
        for (const w of words) {
          const mine = w === target;
          const low = w.y > GROUND - 22;
          ctx.globalAlpha = over ? 0.35 : 1;
          if (mine) {
            ctx.fillStyle = c.accent;
            ctx.fillRect(w.x, w.y + 2, w.text.length * cw, 1);
            label(ctx, c, w.text.slice(0, w.typed), w.x, w.y, c.ok, 9);
            const rest = w.x + w.typed * cw;
            if (w.wrong) {
              label(ctx, c, w.wrong === ' ' ? '_' : w.wrong, rest, w.y, c.red, 9);
              label(ctx, c, w.text.slice(w.typed + 1), rest + cw, w.y, low ? c.amber : c.muted, 9);
            } else {
              label(ctx, c, w.text.slice(w.typed), rest, w.y, low ? c.amber : c.muted, 9);
            }
          } else {
            label(ctx, c, w.text, w.x, w.y, low ? c.amber : c.muted, 9);
          }
        }
        ctx.globalAlpha = 1;
        // the dots Tail fires at each letter it gets right
        const tipX = TX + Math.cos(aim) * 7;
        const tipY = TY + Math.sin(aim) * 7;
        ctx.fillStyle = c.accent;
        for (const s of shots) {
          const k = s.age / 0.14;
          const sx = tipX + (s.w.x + s.i * cw + cw / 2 - tipX) * k;
          const sy = tipY + (s.w.y - 3 - tipY) * k;
          ctx.beginPath(); ctx.arc(sx, sy, 1.5, 0, TAU); ctx.fill();
        }
        drawParts(ctx, c, parts);
        drawPops(ctx, c, pops);
        if (lvlFlash) { ctx.globalAlpha = Math.min(1, lvlFlash * 2); label(ctx, c, `level ${levelOf()}`, W / 2, 52, c.ok, 12, 'center'); ctx.globalAlpha = 1; }
        if (over && Math.floor(t * 6) % 2) label(ctx, c, 'game over', W / 2, 52, c.red, 11, 'center');
        if (hurt && Math.floor(t * 14) % 2) return;
        const firing = shots.length > 0;
        drawMascot(ctx, c, TX, TY, 14, { angle: aim, mouth: firing ? 0.4 : 0, lookX: 0.9, lookY: 0, sleep: over > 0 });
      },
      caption: () => `typer · level ${levelOf()} · ${chars} chars · ${'♥'.repeat(Math.max(0, lives))}`,
    };
  }

  games.add('breakout', breakout);
  games.add('flappy', flappy);
  games.add('typer', typer);
})();
