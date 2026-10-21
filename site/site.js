// The agenttail project site. Tail, its thought bubble and the games are the
// app's own code (buddy.js, think-bubble.js, mascot-games*.js); this file only
// stages them: the hero, a simulated session, the Tail lab, the arcade, the
// theme picker and a few effects.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const motion = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return null; } })();
  const reduced = () => !!(motion && motion.matches);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  /* ---------- themes: the app's seven, recolouring the whole page ---------- */
  const THEMES = [
    ['matrix', '#37f28a', '#050807'], ['amber', '#ffb000', '#0b0803'], ['red', '#ff3347', '#0c0607'],
    ['ice', '#5ce1e6', '#050b14'], ['dracula', '#bd93f9', '#1a1723'], ['neon', '#ff7edb', '#171520'], ['paper', '#1f7a4d', '#f4f1e8'],
  ];
  const themeListeners = [];
  function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'matrix'; }
  function setTheme(name) {
    if (name === 'matrix') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', name);
    try { localStorage.setItem('agenttail-site-theme', name); } catch { /* ignore */ }
    for (const b of document.querySelectorAll('.sw')) b.setAttribute('aria-checked', String(b.dataset.theme === name));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = (THEMES.find((t) => t[0] === name) || THEMES[0])[2];
    for (const fn of themeListeners) fn();
  }
  const swatches = $('swatches');
  for (const [name, accent, bg] of THEMES) {
    const b = el('button', 'sw');
    b.type = 'button';
    b.dataset.theme = name;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(name === currentTheme()));
    const chip = el('span', 'chip');
    chip.style.background = `linear-gradient(135deg, ${accent} 0 50%, ${bg} 50% 100%)`;
    b.append(chip, document.createTextNode(name));
    b.addEventListener('click', () => setTheme(name));
    swatches.appendChild(b);
  }
  const colors = () => window.__thinkBubble.colors();

  /* ---------- matrix rain behind everything ---------- */
  (() => {
    const canvas = $('rain');
    const ctx = canvas.getContext('2d');
    const glyphs = 'アイウエオカキクケコサシスセソ0123456789{}[]<>=;λ#$'.split('');
    let cols = [];
    let glyph = '#37f28a';
    let fade = 'rgba(5, 8, 7, .2)';
    const size = 16;
    function readColors() {
      const cs = getComputedStyle(document.documentElement);
      glyph = cs.getPropertyValue('--matrix-glyph').trim() || cs.getPropertyValue('--green').trim();
      fade = cs.getPropertyValue('--matrix-fade').trim() || 'rgba(5, 8, 7, .2)';
      ctx.fillStyle = cs.getPropertyValue('--bg').trim();
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    function fit() {
      canvas.width = innerWidth;
      canvas.height = innerHeight;
      cols = Array.from({ length: Math.ceil(innerWidth / size) }, () => ({ y: Math.random() * -innerHeight, v: 0.4 + Math.random() * 0.7 }));
      readColors();
    }
    function draw() {
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = glyph;
      ctx.font = `${size - 2}px "JetBrains Mono", monospace`;
      cols.forEach((c, i) => {
        if (Math.random() < 0.55) ctx.fillText(pick(glyphs), i * size, c.y);
        c.y += size * c.v;
        if (c.y > canvas.height + Math.random() * 400) c.y = -Math.random() * 300;
      });
    }
    fit();
    addEventListener('resize', fit);
    themeListeners.push(readColors);
    setInterval(() => { if (!document.hidden && !reduced()) draw(); }, 90);
  })();

  /* ---------- the nav logo's eye follows the pointer too ---------- */
  const navPupil = document.querySelector('.b-pupil');
  addEventListener('pointermove', (e) => {
    const svg = navPupil && navPupil.ownerSVGElement;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width * 0.2);
    const dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1;
    navPupil.style.transform = `translate(${(dx / d) * 1.2}px, ${(dy / d) * 1.2}px)`;
  }, { passive: true });

  /* ---------- copy buttons and tabs ---------- */
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); } catch { return; }
      b.classList.add('done');
      setTimeout(() => b.classList.remove('done'), 1600);
    });
  }
  for (const t of document.querySelectorAll('[data-tab]')) {
    t.addEventListener('click', () => {
      for (const o of document.querySelectorAll('[data-tab]')) o.setAttribute('aria-selected', String(o === t));
      for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== t.dataset.tab;
    });
  }

  /* ---------- reveal on scroll, a light that follows the pointer on cards ---------- */
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); seen.unobserve(e.target); }
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach((n, i) => {
    const siblings = [...n.parentElement.children].filter((c) => c.classList.contains('reveal'));
    n.style.setProperty('--d', `${Math.min(siblings.indexOf(n), 8) * 0.07}s`);
    seen.observe(n);
  });
  for (const card of document.querySelectorAll('.card')) {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  }

  /** True while the element is on screen, so off-screen demos stop working. */
  function watchVisible(node) {
    const state = { on: false };
    new IntersectionObserver(([e]) => { state.on = e.isIntersecting; }, { threshold: 0.05 }).observe(node);
    return state;
  }
  async function whenVisible(state) {
    while (!state.on || document.hidden) await sleep(300);
  }

  /* ---------- hero: a big Tail, and the server starting up ---------- */
  const HELLO = ['hi, I\'m Tail', 'I watch the agent so you don\'t have to', 'tail -f me', 'boop!', 'pet me more', 'no bugs today. probably.'];
  const heroHost = $('heroTailHost');
  const heroTail = window.__tail.create(heroHost, {
    className: 'big',
    shown: () => true,
    thinking: () => false,
    defaultLook: () => ({ x: -0.9, y: -0.2 }),
    isShell: () => true,
    idle: () => false,
    lastEventAt: () => Date.now(),
  });
  heroHost.insertBefore(heroTail.el, heroHost.querySelector('.hint'));
  setTimeout(() => heroTail.react('perk', { line: HELLO[0] }), 1200);
  setInterval(() => {
    if (document.hidden || heroTail.state().reaction) return;
    heroTail.react(pick(['happy', 'perk', 'love']), { line: Math.random() < 0.5 ? pick(HELLO) : '' });
  }, 9000);

  const version = (document.querySelector('.pill') || {}).textContent || '';
  const heroLines = [
    ['$ ', 't-p', 'npx github:ionut27001/agenttail'],
    ['', 't-m', `agenttail ${version.replace(/^v/, '')}  `, 't-c', 'http://127.0.0.1:8787'],
    ['', 't-m', 'sessions   ~/.dsh/sessions · ~/.claude/projects'],
    ['', 't-m', 'stream mode on · control off · no telemetry'],
    ['', 't-ok', '● watching 3 agents · 1 thinking · tail is awake'],
  ];
  (async () => {
    const pre = $('heroTerm');
    const cursor = el('span', 'cur');
    for (;;) {
      pre.textContent = '';
      pre.appendChild(cursor);
      for (const line of heroLines) {
        for (let i = 1; i < line.length; i += 2) {
          const span = el('span', line[i]);
          pre.insertBefore(span, cursor);
          const text = (i === 1 ? line[0] : '') + line[i + 1];
          const typing = line === heroLines[0] && i === 1;
          for (let c = 0; c < text.length; c++) {
            span.textContent += text[c];
            if (typing && !reduced()) await sleep(38);
          }
        }
        pre.insertBefore(document.createTextNode('\n'), cursor);
        await sleep(line === heroLines[0] ? 650 : 260);
      }
      await sleep(7000);
    }
  })();

  /* ---------- the live demo: a small session, replayed ---------- */
  const dash = $('dash');
  const dashVisible = watchVisible(dash);
  const demo = { kind: 'idle', since: Date.now(), label: '', thinkingSince: 0, lastAt: Date.now(), tokens: 0, cost: 0, steps: 0, rate: 0 };
  let demoBubble = null;
  const demoTail = window.__tail.create($('dStage'), {
    shown: () => true,
    thinking: () => demoBubble && demoBubble.showing,
    defaultLook: () => ({ running: { x: -0.3, y: 1 }, editing: { x: -1, y: -0.4 }, replying: { x: 1, y: 0.2 } }[demo.kind] || { x: 0.75, y: -0.15 }),
    isShell: () => true,
    idle: () => demo.kind === 'done' || demo.kind === 'idle',
    lastEventAt: () => demo.lastAt,
  });
  // A demo think is short, so Tail gets bored sooner than in the app.
  demoBubble = window.__thinkBubble.create(demoTail.slot, { gameAfterMs: 3500, onPlaying: (on) => demoTail.el.classList.toggle('playing', on) });

  const ICONS = { idle: '·', thinking: '…', editing: '✎', running: '◐', replying: '✦', done: '✓', error: '✗' };
  function act(kind, label = '') {
    demo.kind = kind;
    demo.label = label;
    demo.since = Date.now();
    demo.lastAt = Date.now();
    dash.className = `dash reveal in s-${kind}${dash.classList.contains('staged') ? ' staged' : ''}`;
    $('dActIcon').textContent = ICONS[kind] || '·';
    $('dActText').textContent = kind.toUpperCase();
    $('dActLabel').textContent = label ? `· ${label}` : '';
    $('dLive').textContent = kind === 'done' || kind === 'idle' ? '◐ IDLE' : '● LIVE';
    $('dLive').classList.toggle('idle', kind === 'done' || kind === 'idle');
    demo.thinkingSince = kind === 'thinking' ? Date.now() : 0;
  }
  function stage(on) { dash.classList.toggle('staged', on); }
  function fmt(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(n); }
  function spend(tokens, rate) {
    demo.tokens += tokens;
    demo.cost += tokens * 0.0000022;
    demo.rate = rate;
    $('mTokens').textContent = fmt(demo.tokens);
    $('mCost').textContent = `$${demo.cost.toFixed(4)}`;
  }
  function step() { demo.steps += 1; $('mSteps').textContent = String(demo.steps); }
  setInterval(() => {
    const sec = Math.max(0, Math.floor((Date.now() - demo.since) / 1000));
    $('dActClock').textContent = demo.kind === 'idle' || demo.kind === 'done' ? '' : `${sec} s`;
    const wobble = demo.rate ? demo.rate + (Math.random() * 8 - 4) : 0;
    $('mRate').textContent = wobble > 0 ? String(Math.round(wobble)) : '0';
    const { stalled } = demoBubble.update({ thinking: !!demo.thinkingSince && Date.now() - demo.thinkingSince > 700, startedAt: demo.thinkingSince, quietMs: 0, label: demo.label, doing: demo.kind });
    demoTail.el.classList.toggle('stalled', stalled);
  }, 500);

  const CODE = [
    '<span class="cm">/**</span>',
    '<span class="cm"> * Adds two numbers.</span>',
    '<span class="cm"> * @returns {number} the sum of a and b</span>',
    '<span class="cm"> */</span>',
    '<span class="k">export function</span> <span class="f">add</span>(a, b) {',
    '  <span class="k">return</span> a + b;',
    '}',
    '',
    '<span class="k">export function</span> <span class="f">multiply</span>(a, b) {',
    '  <span class="k">return</span> a * b',
    '}',
  ];
  const code = $('dCode');
  function resetCode() {
    code.textContent = '';
    for (const html of CODE) {
      const li = el('li');
      li.innerHTML = html || ' ';
      code.appendChild(li);
    }
  }
  /** Type a new version of a line in place, then let the highlight sweep fade. */
  async function typeLine(index, plain, html) {
    const li = code.children[index];
    li.classList.remove('typed');
    li.classList.add('typing');
    li.textContent = '';
    for (const ch of plain) {
      li.textContent += ch;
      await sleep(reduced() ? 0 : 28 + Math.random() * 40);
    }
    li.classList.remove('typing');
    li.innerHTML = html;
    void li.offsetWidth;
    li.classList.add('typed');
  }

  const lines = $('dLines');
  function out(text, cls) {
    const row = el('div', cls, text);
    lines.appendChild(row);
    while (lines.childElementCount > 9) lines.firstElementChild.remove();
    return row;
  }
  async function run(command, output, ok) {
    step();
    act('running', command);
    stage(true);
    lines.textContent = '';
    out(`PS ~/demo-calculator> ${command}`, 't-p');
    const spin = out('⠋ running', 't-a');
    const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
    for (let i = 0; i < 14; i++) { spin.textContent = `${frames[i % frames.length]} running · ${(i * 0.1).toFixed(1)} s`; await sleep(90); }
    spin.remove();
    for (const [text, cls] of output) { out(text, cls); await sleep(170); }
    out(ok ? '✓ exit 0' : '✗ exit 1', ok ? 't-ok' : 't-r');
    demoTail.onEvent({ t: 'result', callId: command, text: `[exit code: ${ok ? 0 : 1}]`, isError: !ok });
    if (!ok) act('error', `${command} failed`);
    await sleep(1800);
    stage(false);
  }
  const msgs = $('dMsgs');
  function chat(kind, text) {
    msgs.appendChild(el('div', `m ${kind}`, text));
    while (msgs.childElementCount > 7) msgs.firstElementChild.remove();
  }
  async function think(ms, thought) {
    step();
    act('thinking', thought);
    chat('think', `thinking · ${thought}`);
    spend(1800, 58);
    await sleep(ms);
    demo.rate = 0;
  }
  function hot(file, bad) {
    for (const f of document.querySelectorAll('.t-file')) {
      if (f.dataset.file === file) { f.classList.toggle('hot', !bad); f.classList.toggle('bad', !!bad); }
    }
  }
  async function edit(index, plain, html) {
    step();
    act('editing', 'src/calculator.js');
    demoTail.onEvent({ t: 'call', name: 'edit' });
    chat('tool', '✎ edit src/calculator.js');
    spend(900, 41);
    hot('calculator.js');
    await typeLine(index, plain, html);
    await sleep(700);
  }

  (async () => {
    for (;;) {
      await whenVisible(dashVisible);
      // A fresh session.
      Object.assign(demo, { tokens: 0, cost: 0, steps: 0, rate: 0 });
      ['mSteps', 'mTokens'].forEach((id) => { $(id).textContent = '0'; });
      $('mCost').textContent = '$0.0000';
      resetCode();
      lines.textContent = '';
      msgs.textContent = '';
      for (const f of document.querySelectorAll('.t-file')) f.classList.remove('hot', 'bad');
      act('idle');
      await sleep(1400);

      chat('user', 'Fix add(), run the tests and show me the build.');
      demoTail.onEvent({ t: 'user', text: 'Fix add()' });
      await sleep(900);
      await think(2600, "add('2', '3') returns '23': the arguments arrive as strings.");
      await edit(5, '  return Number(a) + Number(b);', '  <span class="k">return</span> <span class="f">Number</span>(a) + <span class="f">Number</span>(b);');
      await run('npm test', [['✓ add (1.2ms)', 't-ok'], ['✓ multiply (0.8ms)', 't-ok'], ['tests 2 · pass 2 · fail 0', 't-m']], true);
      await whenVisible(dashVisible);
      await think(9500, 'Tests pass. The build runs the linter first; let me see what it says about multiply().');
      await run('npm run build', [['> eslint src', 't-m'], ['src/calculator.js', 't-c'], ['  10:15  error  Missing semicolon  semi', 't-r'], ['✗ 1 problem (1 error)', 't-r']], false);
      hot('calculator.js', true);
      await think(2200, 'Missing semicolon in multiply(). One character.');
      await edit(9, '  return a * b;', '  <span class="k">return</span> a * b;');
      await run('npm run build', [['> eslint src', 't-m'], ['> node build.mjs', 't-m'], ['[1/3] bundle', 't-c'], ['[2/3] minify', 't-c'], ['[3/3] write dist/', 't-c'], ['built in 412 ms', 't-ok']], true);
      step();
      act('replying');
      spend(1200, 72);
      chat('agent', 'add() now converts its arguments, both tests pass and the build is clean.');
      await sleep(2200);
      demo.rate = 0;
      demoTail.onEvent({ t: 'turnEnd' });
      act('done', 'turn finished');
      await sleep(6000);
    }
  })();

  /* ---------- the Tail lab: every mood on a button ---------- */
  const lab = { thinkingSince: 0, play: false };
  let labBubble = null;
  const labTail = window.__tail.create($('labStage'), {
    className: 'big',
    shown: () => true,
    thinking: () => labBubble && labBubble.showing,
    defaultLook: () => ({ x: 0.9, y: -0.1 }),
    isShell: () => true,
    idle: () => false,
    lastEventAt: () => Date.now(),
  });
  labBubble = window.__thinkBubble.create(labTail.slot, { onPlaying: (on) => labTail.el.classList.toggle('playing', on) });
  const LINES = {
    happy: ['nice!', 'green!', 'it passed!'], oops: ['oof', 'uh oh', 'red again…'], cheer: ['done!', 'turn done!', 'ta-da!'],
    perk: ['hm? a message!', 'oh, hi'], love: ['hehe', 'more pets = fewer bugs', 'boop!'], dizzy: ['whoa… dizzy'],
  };
  const moodButtons = document.querySelectorAll('[data-mood]');
  function labThink(on, startedAt) {
    lab.thinkingSince = on ? startedAt || Date.now() : 0;
    for (const b of moodButtons) if (b.dataset.mood === 'think') b.classList.toggle('on', on);
    labUpdate();
  }
  function labUpdate() {
    labBubble.update({ thinking: !!lab.thinkingSince, startedAt: lab.thinkingSince, quietMs: 0, label: 'weighing whether divide() should throw on zero', doing: 'thinking' });
  }
  setInterval(labUpdate, 1000);
  for (const b of moodButtons) {
    b.addEventListener('click', () => {
      const mood = b.dataset.mood;
      if (mood === 'think') { labThink(!lab.thinkingSince); return; }
      if (mood === 'play') {
        // Think long enough to be bored, then hand over the controls.
        releaseCabinet();
        labThink(true, Date.now() - window.__thinkBubble.cfg.gameAfterMs - 1000);
        setTimeout(() => labBubble.setHuman(true), 80);
        return;
      }
      labTail.react(mood, { line: pick(LINES[mood]) });
    });
  }

  /* ---------- the arcade: all ten games, each playing itself ---------- */
  const games = window.__mascotGames;
  const arcade = $('arcade');
  const cabinets = [];
  let human = null;
  function releaseCabinet() {
    if (!human) return;
    human.game.human = false;
    human.node.classList.remove('human');
    human.tag.textContent = human.game.input ? 'click to play' : 'watch';
    human = null;
  }
  for (const name of games.names) {
    const node = el('div', 'cab');
    node.tabIndex = 0;
    const canvas = el('canvas');
    const head = el('div', 'cab-name');
    const tag = el('span', 'cab-tag');
    head.append(el('span', '', name), tag);
    const cap = el('div', 'cab-cap', ' ');
    node.append(canvas, head, cap);
    arcade.appendChild(node);
    const cab = { name, node, canvas, cap, tag, game: games.create(name), visible: watchVisible(node), last: 0, capAt: 0 };
    tag.textContent = cab.game.input ? 'click to play' : 'watch';
    node.setAttribute('aria-label', `${name}: ${cab.game.input ? 'click to play' : 'plays itself'}`);
    node.addEventListener('click', () => {
      if (!cab.game.input) return;
      if (human === cab) { releaseCabinet(); return; }
      releaseCabinet();
      labBubble.setHuman(false);
      human = cab;
      cab.game.human = true;
      node.classList.add('human');
      tag.textContent = 'you play · esc';
      node.focus({ preventScroll: true });
    });
    cabinets.push(cab);
  }
  let palette = colors();
  themeListeners.push(() => { palette = colors(); });
  function drawAll(t) {
    for (const cab of cabinets) {
      if (!cab.visible.on) { cab.last = 0; continue; }
      const dt = Math.min(0.05, (t - (cab.last || t)) / 1000);
      cab.last = t;
      cab.game.step(dt, t / 1000);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cab.canvas.width !== games.W * dpr) { cab.canvas.width = games.W * dpr; cab.canvas.height = games.H * dpr; }
      const ctx = cab.canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, games.W, games.H);
      cab.game.draw(ctx, palette, t / 1000);
      if (t - cab.capAt > 400) { cab.capAt = t; cab.cap.textContent = cab.game.caption(); }
    }
  }
  function frame(t) {
    if (!reduced()) drawAll(t);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  // With reduced motion the games still show, one quiet frame a second.
  setInterval(() => { if (reduced()) drawAll(performance.now()); }, 1000);
  const typing = (target) => target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  function onKey(e) {
    if (!human || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.type === 'keydown' && k === 'Escape') { releaseCabinet(); e.preventDefault(); return; }
    if (k === 'Tab') return;
    if (human.game.input(e.type === 'keydown' ? 'down' : 'up', k)) { e.preventDefault(); e.stopPropagation(); }
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);

  /* ---------- stream mode: a console that redacts itself ---------- */
  (async () => {
    const pre = $('redactTerm');
    const box = pre.parentElement;
    const visible = watchVisible(box);
    const ROWS = [
      ['$ ', 't-p', 'curl -H "Authorization: Bearer ', '', 'sk-live-9f2c81d44a0be7c3', 't-p', '" https://api.example.com/v1'],
      ['', 't-m', 'connecting to ', '', '203.0.113.42:8443', 't-m', ' as '],
      ['', 't-m', 'user ', '', 'jane.doe@example.com', 't-m', ' · home '],
      ['', 't-m', 'C:\\Users\\', '', 'janedoe', 't-m', '\\project\\.env loaded'],
      ['', 't-m', 'AWS_SECRET_ACCESS_KEY=', '', 'wJalrXUtnFEMIK7MDENGbPxRfiCY', 't-m', ''],
    ];
    for (;;) {
      await whenVisible(visible);
      pre.textContent = '';
      const secrets = [];
      for (const r of ROWS) {
        pre.append(el('span', r[1], r[0] + r[2]));
        const s = el('span', 't-a', r[4]);
        secrets.push(s);
        pre.append(s, el('span', r[5], r[6]), document.createTextNode('\n'));
        await sleep(220);
      }
      await sleep(1300);
      // Server-side redaction: same length, ▓ where the secret was.
      for (const s of secrets) {
        const text = s.textContent;
        for (let i = 0; i <= text.length; i += 2) {
          s.textContent = '▓'.repeat(i) + text.slice(i);
          await sleep(reduced() ? 0 : 18);
        }
        s.textContent = '▓'.repeat(text.length);
        s.className = 't-m';
        await sleep(120);
      }
      pre.append(el('span', 't-ok', '✓ redacted on the server, before the browser saw it'));
      await sleep(6000);
    }
  })();
})();
