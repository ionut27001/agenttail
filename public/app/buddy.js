// Tail, the agenttail mascot: the logo's prompt chevron with an eye in its
// opening. It lives in the editor's corner while a session is in motion,
// follows the pointer with its eye, reacts to what the agent does (a hop when
// a command passes, a shake when one fails, a cheer when a turn ends), falls
// asleep when nothing happens, and likes being petted. stage.js hangs the
// thought bubble on it while the agent thinks. Each watch-wall pane gets its
// own Tail too (wall-tail.js), made by the same factory.
// Loaded by index.html as a classic script, before stage.js.
/* ---------- Tail, the mascot ---------- */
(() => {
  const EYE = { x: 24, y: 64 };     // eye centre in the SVG's units: well inside the opening
  const LOOK = 2.7;                 // how far the pupil travels
  const SLEEP_AFTER_MS = 90_000;    // an idle session this quiet puts Tail to sleep
  const PET_LINES = [
    'hi, I\'m Tail', 'boop!', 'I watch the agent so you don\'t have to', 'pet me more', 'you\'re doing great',
    'is it shipping yet?', 'one more test run?', 'I\'m 50% chevron, 50% feelings', 'tail -f me', 'snack break?',
    'no bugs today. probably.', 'the agent is fine. I checked.', 'hehe', 'more pets = fewer bugs',
  ];
  const HAPPY_LINES = ['nice!', 'green!', 'it passed!', 'yes!', 'clean run'];
  const OOPS_LINES = ['oof', 'uh oh', 'that broke', 'red again…', 'ouch'];
  const CHEER_LINES = ['done!', 'turn done!', 'your move!', 'ta-da!'];

  /**
   * A Tail in `host`. o: { id, className, shown(), thinking(), defaultLook(),
   * isShell(ev), idle(), lastEventAt() } says where it is and what its agent does.
   */
  function createTail(host, o) {
    const el = document.createElement('div');
    if (o.id) el.id = o.id;
    el.className = `tail-buddy${o.className ? ' ' + o.className : ''}`;
    // Static markup only.
    el.innerHTML = `
      <div class="tb-bubble-slot"></div>
      <i class="tm-dot d1"></i><i class="tm-dot d2"></i><i class="tm-dot d3"></i>
      <div class="tb-say" aria-live="polite"></div>
      <div class="tb-fx" aria-hidden="true"></div>
      <svg class="tail-mascot" viewBox="4 30 50 68" role="img" aria-label="Tail, the agenttail mascot. Click to pet.">
        <ellipse class="tm-shadow" cx="30" cy="95" rx="15" ry="2.6"/>
        <g class="tm-body">
          <g class="tm-pose">
            <path class="tm-chevron" d="M13 38 L46 64 L13 90"/>
            <g class="tm-eye">
              <circle class="tm-white" cx="24" cy="64" r="5.9"/>
              <circle class="tm-pupil" cx="25.8" cy="62.4" r="2.8"/>
              <circle class="tm-glint" cx="26.8" cy="61.2" r="1"/>
            </g>
            <path class="tm-happy" d="M19 66.5 Q24 58.5 29 66.5"/>
            <path class="tm-sweat" d="M41 41 q3.2 5 0 7.4 q-3.2 -2.4 0 -7.4z"/>
          </g>
        </g>
      </svg>`;
    host.appendChild(el);
    const svg = el.querySelector('.tail-mascot');
    const white = el.querySelector('.tm-white');
    const pupil = el.querySelector('.tm-pupil');
    const glint = el.querySelector('.tm-glint');
    const sayEl = el.querySelector('.tb-say');
    const fxEl = el.querySelector('.tb-fx');

    const b = {
      pointer: null,        // last pointer position, page coordinates
      pointerAt: 0,
      look: { x: 0.6, y: -0.3 },
      reaction: '',
      reactionUntil: 0,
      sayUntil: 0,
      pets: [],
      sleeping: false,
      hidden: true,
      raf: 0,
    };

    /** Where Tail looks when nobody is pointing at it: up at its thoughts, or at what the agent is doing. */
    function defaultLook() {
      if (o.thinking()) return { x: -0.75, y: -0.65 };
      return o.defaultLook ? o.defaultLook() : { x: 0.75, y: -0.15 };
    }

    function aim() {
      b.raf = 0;
      if (b.hidden) return;
      let target = defaultLook();
      const now = Date.now();
      if (b.pointer && now - b.pointerAt < 4000) {
        const r = white.getBoundingClientRect();
        const dx = b.pointer.x - (r.left + r.width / 2);
        const dy = b.pointer.y - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy);
        if (d < 700) target = d < 4 ? { x: 0, y: 0 } : { x: dx / d, y: dy / d };
      }
      if (b.reaction === 'dizzy') {
        const a = now / 120;
        target = { x: Math.cos(a), y: Math.sin(a) };
      }
      b.look = target;
      const px = EYE.x + target.x * LOOK;
      const py = EYE.y + target.y * LOOK;
      pupil.setAttribute('cx', px.toFixed(2));
      pupil.setAttribute('cy', py.toFixed(2));
      glint.setAttribute('cx', (px + 1.1).toFixed(2));
      glint.setAttribute('cy', (py - 1.3).toFixed(2));
      if (b.reaction === 'dizzy') b.raf = requestAnimationFrame(aim);
    }
    const queueAim = () => { if (!b.raf) b.raf = requestAnimationFrame(aim); };

    function onPointer(e) {
      b.pointer = { x: e.clientX, y: e.clientY };
      b.pointerAt = Date.now();
      if (b.sleeping) {
        const r = svg.getBoundingClientRect();
        if (Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) < 120) wake(true);
      }
      queueAim();
    }
    document.addEventListener('pointermove', onPointer, { passive: true });

    function particle(text, cls, dx, dy) {
      const p = document.createElement('span');
      p.className = `tb-p ${cls || ''}`;
      p.textContent = text;
      p.style.setProperty('--dx', `${dx || 0}px`);
      p.style.setProperty('--dy', `${dy || -34}px`);
      fxEl.appendChild(p);
      setTimeout(() => p.remove(), 1300);
    }

    function confetti() {
      const colors = ['var(--green)', 'var(--cyan)', 'var(--amber)', 'var(--purple)', 'var(--ok)', 'var(--orange)'];
      for (let i = 0; i < 16; i++) {
        const a = Math.PI + (i / 15) * Math.PI;
        const p = document.createElement('i');
        p.className = 'tb-confetti';
        p.style.setProperty('--dx', `${Math.cos(a) * (28 + Math.random() * 30)}px`);
        p.style.setProperty('--dy', `${Math.sin(a) * (28 + Math.random() * 34)}px`);
        p.style.background = colors[i % colors.length];
        fxEl.appendChild(p);
        setTimeout(() => p.remove(), 1100);
      }
    }

    function say(text, ms = 2600) {
      if (!text) return;
      sayEl.textContent = text;
      sayEl.classList.remove('pop');
      void sayEl.offsetWidth; // restart the pop animation
      sayEl.classList.add('show', 'pop');
      b.sayUntil = Date.now() + ms;
      setTimeout(() => { if (Date.now() >= b.sayUntil) sayEl.classList.remove('show'); }, ms + 20);
    }

    const pick = (list) => list[Math.floor(Math.random() * list.length)];

    /** Play a reaction: a pose for a moment, a particle, sometimes a line. */
    function react(kind, opts = {}) {
      if (b.hidden) return;
      const ms = { happy: 900, oops: 1100, cheer: 1300, perk: 700, love: 1000, dizzy: 2200, type: 280 }[kind] || 800;
      if (kind !== 'type') wake(false);
      el.classList.remove('r-happy', 'r-oops', 'r-cheer', 'r-perk', 'r-love', 'r-dizzy', 'r-type');
      void el.offsetWidth; // restart the animation when the same reaction repeats
      el.classList.add(`r-${kind}`);
      b.reaction = kind;
      b.last = kind;
      b.reactionUntil = Date.now() + ms;
      setTimeout(() => {
        if (Date.now() < b.reactionUntil) return;
        el.classList.remove(`r-${kind}`);
        b.reaction = '';
        queueAim();
      }, ms + 20);
      if (kind === 'happy') particle('✓', 'ok');
      if (kind === 'oops') particle('✗', 'bad', -6);
      if (kind === 'perk') particle('!', 'perk', 4, -30);
      if (kind === 'love') { particle('♥', 'love', -10); setTimeout(() => particle('♥', 'love', 8, -42), 140); }
      if (kind === 'cheer') confetti();
      if (opts.line) say(opts.line);
      queueAim();
    }

    function sleep() {
      if (b.sleeping) return;
      b.sleeping = true;
      el.classList.add('sleeping');
    }
    function wake(perk) {
      if (!b.sleeping) return;
      b.sleeping = false;
      el.classList.remove('sleeping');
      if (perk) react('perk');
    }

    // Petting: a click is a pet; a flurry of them makes Tail dizzy.
    svg.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.reaction === 'dizzy') return; // let the room stop spinning first
      const now = Date.now();
      b.pets = b.pets.filter((t) => now - t < 2500);
      b.pets.push(now);
      if (b.sleeping) { wake(false); react('perk', { line: 'huh? oh, hi' }); return; }
      if (b.pets.length >= 5) { b.pets = []; react('dizzy', { line: 'whoa… dizzy' }); return; }
      react('love', { line: pick(PET_LINES) });
    });

    /** Every event of its session once the history has loaded. */
    function onEvent(ev) {
      if (b.hidden || !ev) return;
      if (ev.t === 'result') {
        if (!o.isShell(ev)) return;
        const exit = /\[exit code:\s*(-?\d+)\]/i.exec(ev.text || '');
        const bad = ev.isError || (exit && exit[1] !== '0');
        if (bad) react('oops', { line: Math.random() < 0.6 ? pick(OOPS_LINES) : '' });
        else react('happy', { line: Math.random() < 0.35 ? pick(HAPPY_LINES) : '' });
      } else if (ev.t === 'jobEnd') {
        const bad = ev.status === 'failed' || /\b(failed|exit code: [1-9])/i.test(ev.detail || '');
        react(bad ? 'oops' : 'happy');
      } else if (ev.t === 'turnEnd') {
        react('cheer', { line: pick(CHEER_LINES) });
      } else if (ev.t === 'user' && !ev.system && ev.text) {
        react('perk');
      } else if (ev.t === 'call' && (ev.name === 'edit' || ev.name === 'write' || ev.name === 'multi_edit')) {
        react('type');
      }
    }

    function tick() {
      const show = o.shown();
      if (show !== !b.hidden) {
        b.hidden = !show;
        el.classList.toggle('show', show);
        if (show) queueAim();
      }
      if (b.hidden) return;
      // Asleep when the session has been idle and nobody is around.
      const quiet = Date.now() - Math.max(o.lastEventAt() || 0, b.pointerAt || 0);
      const idle = o.idle();
      if (idle && quiet > SLEEP_AFTER_MS) sleep();
      else if (!idle) wake(false);
      el.classList.toggle('thinking', !!o.thinking());
      queueAim();
    }
    const timer = setInterval(tick, 1000);

    function dispose() {
      clearInterval(timer);
      cancelAnimationFrame(b.raf);
      document.removeEventListener('pointermove', onPointer);
      el.remove();
    }

    tick();
    return {
      el,
      slot: el.querySelector('.tb-bubble-slot'),
      onEvent,
      react,
      say,
      tick,
      state: () => ({ shown: !b.hidden, sleeping: b.sleeping, reaction: b.reaction, last: b.last || '', saying: sayEl.classList.contains('show') ? sayEl.textContent : '', look: b.look }),
      cfg: { get sleepAfterMs() { return SLEEP_AFTER_MS; } },
      dispose,
      _sleepNow: sleep,
    };
  }

  window.__tail = { create: createTail };
  // The main view's Tail, in the editor corner while the session is in motion.
  // Pages without the editor (the project site) only use the factory.
  const editorWrap = document.getElementById('editorWrap');
  if (!editorWrap) return;
  window.__buddy = createTail(editorWrap, {
    id: 'tailBuddy',
    shown: () => document.body.classList.contains('console-stage') && document.body.classList.contains('fx-mascot'),
    thinking: () => !!document.getElementById('thinkCard')?.classList.contains('show'),
    defaultLook() {
      switch (activity.kind) {
        case 'running': return { x: -1, y: -0.2 };
        case 'editing': return { x: -1, y: 0.1 };
        case 'replying': return { x: 0.2, y: 1 };
        default: return { x: 0.75, y: -0.15 };
      }
    },
    isShell: (ev) => !!state.toolNames && state.toolNames.get(ev.callId) === 'pwsh',
    idle: () => state.state === 'idle' || activity.kind === 'idle' || activity.kind === 'done',
    lastEventAt: () => activity.lastEventAt,
  });
})();
