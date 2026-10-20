// Watch wall widgets: repo map with agent cursors, pane scoreboards.
// Loaded by index.html as a classic script, in order with the others.
/* ---------- watch wall widgets: repo map with agent cursors, pane scoreboards ---------- */
(() => {
  const MAX_TILES = 36;

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

  /* ----- repo map in the team strip ----- */
  window.__wallStripHooks = window.__wallStripHooks || [];
  window.__wallStripHooks.push({
    name: 'map',
    create({ slots, panes }) {
      const slot = slots.map;
      const head = node('div', 'wm-head');
      head.appendChild(node('span', 'wm-title', 'REPO MAP'));
      const legend = node('span', 'wm-legend');
      for (const pane of panes) {
        const item = node('span', 'wm-who');
        item.style.setProperty('--c', pane.root.style.getPropertyValue('--c'));
        item.appendChild(node('i'));
        item.appendChild(document.createTextNode(`${pane.agent.sourceLabel}${pane.agent.repo && pane.agent.repo.branch ? ' · ' + pane.agent.repo.branch : ''}`));
        legend.appendChild(item);
      }
      head.appendChild(legend);
      const clash = node('span', 'wm-clash hidden');
      head.appendChild(clash);
      slot.appendChild(head);
      const board = node('div', 'wm-board');
      slot.appendChild(board);
      const empty = node('div', 'wm-empty', 'files appear here as the agents touch them');
      board.appendChild(empty);

      const tiles = new Map();   // path -> { el, edits, reads, last, who: Set<key> }
      const cursors = new Map(); // pane key -> { el, path }
      let raf = 0;

      function colourOf(pane) { return pane.root.style.getPropertyValue('--c'); }

      function tileFor(p) {
        let tile = tiles.get(p);
        if (tile) return tile;
        const el = node('div', 'wm-tile');
        const name = node('span', 'wm-name', p.split('/').pop());
        el.appendChild(name);
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        if (dir) el.appendChild(node('span', 'wm-dir', dir));
        const dots = node('span', 'wm-dots');
        el.appendChild(dots);
        el.title = p;
        tile = { el, dots, edits: 0, reads: 0, last: 0, who: new Map() };
        tiles.set(p, tile);
        empty.remove();
        board.appendChild(el);
        if (tiles.size > MAX_TILES) {
          // Drop the tile nobody is on that was touched longest ago.
          const onIt = new Set([...cursors.values()].map((c) => c.path));
          const oldest = [...tiles.entries()].filter(([q]) => !onIt.has(q)).sort((a, b) => a[1].last - b[1].last)[0];
          if (oldest) { oldest[1].el.remove(); tiles.delete(oldest[0]); }
        }
        return tile;
      }

      function paint(tile) {
        const heat = Math.min(1, tile.edits / 8);
        tile.el.style.setProperty('--heat', String(heat));
        tile.dots.textContent = '';
        for (const colour of tile.who.values()) {
          const d = node('i');
          d.style.background = colour;
          tile.dots.appendChild(d);
        }
      }

      function placeCursors() {
        raf = 0;
        const boardRect = board.getBoundingClientRect();
        const byPath = new Map();
        for (const [key, cur] of cursors) {
          const tile = tiles.get(cur.path);
          if (!tile) { cur.el.style.opacity = '0'; continue; }
          const r = tile.el.getBoundingClientRect();
          const stack = byPath.get(cur.path) || 0;
          byPath.set(cur.path, stack + 1);
          cur.el.style.opacity = '1';
          cur.el.style.transform = `translate(${Math.round(r.left - boardRect.left + 6 + stack * 14)}px, ${Math.round(r.top - boardRect.top - 7)}px)`;
        }
        // Two or more agents on the same file: make it obvious.
        const shared = [...byPath.entries()].filter(([, n]) => n > 1).map(([q]) => q);
        for (const [q, tile] of tiles) tile.el.classList.toggle('clash', shared.includes(q));
        if (shared.length) {
          clash.textContent = `⚡ ${shared.length === 1 ? 'both agents on ' + shared[0].split('/').pop() : shared.length + ' files shared right now'}`;
          clash.classList.remove('hidden');
        } else {
          clash.classList.add('hidden');
        }
      }

      function schedule() {
        if (!raf) raf = requestAnimationFrame(placeCursors);
      }

      function move(pane, p, kind) {
        const tile = tileFor(p);
        tile.last = Date.now();
        if (kind === 'edit') tile.edits += 1; else tile.reads += 1;
        tile.who.set(pane.agent.key, colourOf(pane));
        paint(tile);
        let cur = cursors.get(pane.agent.key);
        if (!cur) {
          const el = node('span', 'wm-cursor');
          el.style.setProperty('--c', colourOf(pane));
          el.title = pane.agent.sourceLabel;
          board.appendChild(el);
          cur = { el, path: p };
          cursors.set(pane.agent.key, cur);
        }
        cur.path = p;
        cur.el.classList.toggle('editing', kind === 'edit');
        if (!pane.history && !reduced()) {
          tile.el.classList.remove('ping');
          void tile.el.offsetWidth;
          tile.el.classList.add('ping');
          tile.el.style.setProperty('--ping', colourOf(pane));
        }
        schedule();
      }

      const ro = new ResizeObserver(schedule);
      ro.observe(board);

      return {
        onPaneEvent(pane, ev) {
          if (ev.t !== 'call' || !ev.args || typeof ev.args.file_path !== 'string') return;
          if (EDIT_TOOLS.has(ev.name)) move(pane, ev.args.file_path, 'edit');
          else if (ev.name === 'read') move(pane, ev.args.file_path, 'read');
        },
        dispose() {
          if (raf) cancelAnimationFrame(raf);
          ro.disconnect();
        },
      };
    },
  });

  window.__wallMap = () => ({
    tiles: [...document.querySelectorAll('#wallStrip .wm-tile')].map((t) => ({ path: t.title, clash: t.classList.contains('clash') })),
    cursors: document.querySelectorAll('#wallStrip .wm-cursor').length,
    clash: document.querySelector('#wallStrip .wm-clash:not(.hidden)')?.textContent || '',
  });
})();
