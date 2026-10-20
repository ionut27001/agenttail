// Watch wall widget: a scoreboard in each pane header.
// Loaded by index.html as a classic script, in order with the others.
/* ---------- watch wall widget: pane scoreboards ---------- */
(() => {
  function reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /* ----- scoreboard in each pane header ----- */
  window.__wallHooks = window.__wallHooks || [];
  window.__wallHooks.push({
    name: 'score',
    create(pane) {
      const head = pane.root.querySelector('.wp-head');
      const box = node('span', 'wp-score');
      const parts = {};
      for (const [k, glyph, title] of [
        ['edits', '✎', 'edits'],
        ['commands', '$', 'commands'],
        ['ok', '✓', 'commands that succeeded'],
        ['bad', '✗', 'commands that failed'],
        ['streak', '🔥', 'green runs in a row'],
      ]) {
        const part = node('span', `sc sc-${k} zero`);
        part.title = title;
        part.appendChild(node('i', '', glyph));
        part.appendChild(node('b', '', '0'));
        box.appendChild(part);
        parts[k] = part;
      }
      const stateEl = head.querySelector('.wp-state');
      head.insertBefore(box, stateEl);
      const score = { edits: 0, commands: 0, ok: 0, bad: 0, streak: 0, best: 0 };
      const shell = new Set();
      const set = (k, pop) => {
        parts[k].querySelector('b').textContent = String(score[k]);
        parts[k].classList.toggle('zero', score[k] === 0);
        if (pop && !pane.history && !reduced()) {
          parts[k].classList.remove('pop');
          void parts[k].offsetWidth;
          parts[k].classList.add('pop');
        }
      };
      return {
        onEvent(ev) {
          if (ev.t === 'call') {
            if (EDIT_TOOLS.has(ev.name)) { score.edits += 1; set('edits', true); }
            if (ev.name === 'pwsh') { score.commands += 1; shell.add(ev.callId); set('commands', true); }
          } else if (ev.t === 'result' && shell.has(ev.callId)) {
            shell.delete(ev.callId);
            const exit = /\[exit code:\s*(-?\d+)\]/i.exec(ev.text || '');
            const bad = ev.isError || (exit && exit[1] !== '0');
            if (bad) {
              score.bad += 1;
              score.streak = 0;
              set('bad', true);
              set('streak', false);
            } else {
              score.ok += 1;
              score.streak += 1;
              set('ok', true);
              set('streak', score.streak > score.best);
              score.best = Math.max(score.best, score.streak);
            }
            parts.streak.classList.toggle('hot', score.streak >= 3);
          }
        },
        dispose() { box.remove(); },
        get score() { return { ...score }; },
      };
    },
  });
})();
