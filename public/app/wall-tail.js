// Watch wall widget: Tail in every pane, with its thought bubble and games,
// made by the same factories as the main view's (buddy.js, think-bubble.js).
// It reacts to that pane's agent: hops on a green command, shakes on a red
// one, cheers when a turn ends, thinks out loud and plays on a long think.
// Loaded by index.html as a classic script, after agents.js.
/* ---------- watch wall widget: Tail per pane ---------- */
(() => {
  const THINK_DELAY_MS = 900; // short thoughts do not flash the bubble
  const byPane = new WeakMap();

  window.__wallHooks = window.__wallHooks || [];
  window.__wallHooks.push({
    name: 'tail',
    create(pane) {
      const main = pane.root && pane.root.querySelector('.wp-main');
      if (!main || !window.__tail || !window.__thinkBubble) return null;

      const t = { thinkingSince: 0, label: '', lastEvAt: 0, kind: 'idle', shells: new Set() };
      let bubble = null;
      const tail = window.__tail.create(main, {
        className: 'wall-tail',
        shown: () => document.body.classList.contains('fx-mascot') && !pane.history && pane.state !== 'finished',
        thinking: () => !!bubble && bubble.showing,
        defaultLook: () => ({ running: { x: -1, y: -0.2 }, editing: { x: -1, y: 0.1 }, replying: { x: 0.2, y: 1 } }[t.kind] || { x: 0.75, y: -0.15 }),
        isShell: (ev) => t.shells.has(ev.callId),
        idle: () => pane.state !== 'live',
        lastEventAt: () => t.lastEvAt,
      });
      bubble = window.__thinkBubble.create(tail.slot, {
        onPlaying: (on) => tail.el.classList.toggle('playing', on),
      });
      pane.root.classList.add('has-tail');
      byPane.set(pane.root, { tail, bubble });

      function update() {
        const now = Date.now();
        // A step that has gone quiet is the model thinking too, even without a thinking line.
        const wait = typeof pane.modelWait === 'function' ? pane.modelWait() : 0;
        const since = t.thinkingSince || (wait ? now - wait : 0);
        const on = !pane.history && pane.state === 'live' && tail.state().shown && !!since && now - since > THINK_DELAY_MS;
        const { stalled } = bubble.update({
          thinking: on,
          startedAt: since,
          quietMs: now - (t.lastEvAt || now),
          label: t.label,
          doing: t.kind,
        });
        tail.el.classList.toggle('stalled', stalled);
        pane.root.classList.toggle('tail-thinking', on);
      }
      const timer = setInterval(update, 1000);

      return {
        onEvent(ev) {
          // Replayed events count from their own time, live ones from their arrival.
          t.lastEvAt = pane.history ? Math.max(t.lastEvAt, ev.time || 0) : Date.now();
          const at = pane.history ? ev.time || Date.now() : Date.now();
          if (ev.t === 'call') {
            if (ev.name === 'pwsh') t.shells.add(ev.callId);
            t.kind = ev.name === 'pwsh' ? 'running' : EDIT_TOOLS.has(ev.name) ? 'editing' : 'working';
            t.thinkingSince = 0;
          } else if (ev.t === 'say' && ev.text) {
            t.kind = 'replying';
            t.thinkingSince = 0;
          } else if (ev.t === 'say' && ev.thinking) {
            t.kind = 'thinking';
            if (!t.thinkingSince) t.thinkingSince = at;
            const lines = mdToText(ev.thinking).split('\n').filter((l) => l.trim());
            t.label = (lines[lines.length - 1] || '').replace(/\s+/g, ' ').slice(0, 160);
          } else if (['result', 'user', 'turn', 'turnEnd', 'stepEnd', 'job', 'jobEnd'].includes(ev.t)) {
            t.thinkingSince = 0;
            if (ev.t === 'turnEnd') t.kind = 'done';
          }
          if (!pane.history) tail.onEvent(ev);
          if (ev.t === 'result') t.shells.delete(ev.callId);
          if (!pane.history) update();
        },
        onHistoryEnd() {
          update();
          tail.tick();
        },
        dispose() {
          clearInterval(timer);
          bubble.dispose();
          tail.dispose();
          pane.root.classList.remove('has-tail', 'tail-thinking');
          byPane.delete(pane.root);
        },
        tail,
        bubble,
      };
    },
  });

  /** A pane's Tail and bubble state, for tests and debugging. */
  window.__wallTail = (paneElement) => {
    const root = paneElement && paneElement.closest ? paneElement.closest('.wall-pane') : null;
    const w = root && byPane.get(root);
    return w ? { ...w.tail.state(), bubble: w.bubble.state() } : null;
  };
})();
