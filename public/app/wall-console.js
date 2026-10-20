// Watch wall widget: a live console per pane.
// Loaded by index.html as a classic script, in order with the others.
/* ---------- wall console: live shell output in every wall pane ---------- */
(() => {
  'use strict';

  const terms = new WeakMap();
  const MAX_COMMAND_ROWS = 6;
  const MAX_OUTPUT_LINES = 40;

  const sanitize = (value) => clean(String(value ?? '')).replace(/[\u0080-\u009f]/g, '');

  function commandRows(text, cols) {
    const width = Math.max(12, Number(cols || 80) - 2);
    const logical = sanitize(text).replace(/\r\n?/g, '\n').split('\n');
    while (logical.length > 1 && logical[logical.length - 1] === '') logical.pop();
    const rows = [];
    for (const raw of logical) {
      const chars = Array.from(raw.replace(/\t/g, '    '));
      if (!chars.length) {
        rows.push('');
        continue;
      }
      for (let i = 0; i < chars.length; i += width) rows.push(chars.slice(i, i + width).join(''));
    }
    return rows.length ? rows : [''];
  }

  function renderCommand(term, command) {
    const rows = commandRows(command, term.cols || 80);
    const shown = rows.slice(0, MAX_COMMAND_ROWS);
    const extra = rows.length - shown.length;
    term.write(`${C.green}${C.bold}$ ${C.reset}${C.white}${C.bold}${esc(shown[0] || '')}${C.reset}\r\n`);
    for (const row of shown.slice(1)) {
      term.write(`${C.white}${C.bold}  ${esc(row)}${C.reset}\r\n`);
    }
    if (extra > 0) term.write(`${C.grey}(+${extra} lines)${C.reset}\r\n`);
  }

  function renderResult(term, ev) {
    const raw = sanitize(ev.text || '');
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const earlier = Math.max(0, lines.length - MAX_OUTPUT_LINES);
    const shown = earlier ? lines.slice(-MAX_OUTPUT_LINES) : lines;
    if (earlier) term.write(`${C.grey}(+${earlier} earlier lines)${C.reset}\r\n`);
    const color = ev.isError ? C.red : C.green;
    for (const line of shown) term.write(`${color}${esc(line)}${C.reset}\r\n`);

    const exitMatch = /\[exit code:\s*(-?\d+)\]/i.exec(raw);
    const exitCode = exitMatch ? Number(exitMatch[1]) : null;
    let ok = true;
    let detail = 'exit 0';
    if (exitCode !== null && exitCode !== 0) {
      ok = false;
      detail = `exit ${exitCode}`;
    } else if (ev.isError) {
      ok = false;
      detail = 'error';
    } else if (exitCode !== null) {
      detail = `exit ${exitCode}`;
    }
    term.write(`${ok ? C.green : C.red}${ok ? '✓' : '✗'} ${esc(detail)}${C.reset}\r\n`);
  }

  function renderJob(term, ev) {
    const label = sanitize(ev.label || '').replace(/\s+/g, ' ').trim();
    term.write(`${C.amber}▶ job running · ${esc(label)}${C.reset}\r\n`);
  }

  function renderJobEnd(term, ev) {
    const status = sanitize(ev.status || 'ended').replace(/\s+/g, ' ').trim();
    const color = /fail|error|cancel/i.test(status) ? C.red : /complete|done|success/i.test(status) ? C.green : C.amber;
    term.write(`${color}■ job ${esc(status)}${C.reset}\r\n`);
  }

  function renderJobOutput(term, text) {
    const raw = sanitize(text || '');
    if (!raw.trim()) return;
    const lines = raw.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
    for (const line of lines) term.write(`${C.grey}${esc(line)}${C.reset}\r\n`);
  }

  function bufferText(term) {
    const buffer = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      const text = line ? line.translateToString(true) : '';
      // Rows the terminal wrapped belong to the line before them.
      if (line && line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  window.__wallHooks = window.__wallHooks || [];
  window.__wallHooks.push({
    create(pane) {
      const slot = pane && pane.slots && pane.slots.console;
      if (!slot || typeof Terminal === 'undefined' || !window.FitAddon) return null;

      const doc = slot.ownerDocument || document;
      const label = doc.createElement('span');
      label.className = 'wp-slot-label';
      label.textContent = 'CONSOLE';
      slot.appendChild(label);

      const host = doc.createElement('div');
      host.className = 'wp-console-host';
      slot.appendChild(host);

      const term = new Terminal({
        fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
        fontSize: 11,
        lineHeight: 1.15,
        cursorBlink: false,
        disableStdin: true,
        convertEol: true,
        allowTransparency: true,
        scrollback: 2000,
        theme: { ...THEME_JS[currentTheme].terminal },
      });
      const fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(host);

      let disposed = false;
      let fitFrame = 0;
      let flashTimer = null;
      let placeholder = true;
      const shellCalls = new Set();

      const write = (data) => {
        if (disposed) return;
        try { term.write(data); } catch { /* terminal already gone */ }
      };

      const clearPlaceholder = () => {
        if (!placeholder) return;
        placeholder = false;
        write('\x1b[2K\r');
      };

      const fitNow = () => {
        if (disposed) return;
        try { fitAddon.fit(); } catch { /* slot not laid out yet */ }
      };
      const queueFit = () => {
        if (disposed || fitFrame) return;
        fitFrame = requestAnimationFrame(() => {
          fitFrame = 0;
          fitNow();
        });
      };
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(queueFit) : null;
      if (observer) observer.observe(slot);
      queueFit();

      function flash() {
        if (pane.history || reducedMotion()) return;
        slot.classList.remove('wp-console-flash');
        void slot.offsetWidth;
        slot.classList.add('wp-console-flash');
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
          flashTimer = null;
          slot.classList.remove('wp-console-flash');
        }, 600);
      }

      write(`${C.grey}no commands yet${C.reset}`);

      function onEvent(ev) {
        if (disposed || !ev) return;
        if (ev.t === 'call') {
          if (ev.name !== 'pwsh') return;
          clearPlaceholder();
          shellCalls.add(ev.callId);
          renderCommand(term, (ev.args && ev.args.command) || '');
          if (!pane.history) {
            try { term.scrollToBottom(); } catch { /* ignore */ }
            requestAnimationFrame(() => {
              if (disposed) return;
              try { term.scrollToBottom(); } catch { /* ignore */ }
            });
            flash();
          }
          return;
        }
        if (ev.t === 'result') {
          if (!shellCalls.has(ev.callId)) return;
          shellCalls.delete(ev.callId);
          clearPlaceholder();
          renderResult(term, ev);
          return;
        }
        if (ev.t === 'job') {
          clearPlaceholder();
          renderJob(term, ev);
          return;
        }
        if (ev.t === 'jobEnd') {
          clearPlaceholder();
          renderJobEnd(term, ev);
          return;
        }
        if (ev.t === 'jobOutput') {
          clearPlaceholder();
          renderJobOutput(term, ev.text);
          return;
        }
        if (window.__wallChatInline && window.__wallChatInline()) renderChat(ev);
      }

      /** Chat and reasoning as console lines (the wall's "chat in console" mode). */
      function renderChat(ev) {
        const width = Math.max(20, (term.cols || 80) - 4);
        const wrap = (text, max) => {
          const lines = [];
          for (const raw of String(text).split('\n')) {
            let line = raw.replace(/\s+$/, '');
            if (!line) { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); continue; }
            while (line.length > width) { lines.push(line.slice(0, width)); line = line.slice(width); }
            lines.push(line);
          }
          while (lines.length && lines[lines.length - 1] === '') lines.pop();
          if (lines.length > max) return [...lines.slice(0, max), `… (+${lines.length - max} lines)`];
          return lines;
        };
        if (ev.t === 'user' && !ev.system && ev.text) {
          clearPlaceholder();
          write(`\r\n${C.cyan}▸ ${esc(wrap(ev.text, 6).join('\r\n  '))}${C.reset}\r\n`);
        } else if (ev.t === 'say') {
          if (ev.thinking) {
            clearPlaceholder();
            write(`${C.grey}\x1b[3m  … ${esc(wrap(mdToText(ev.thinking), 3).join('\r\n    '))}\x1b[23m${C.reset}\r\n`);
          }
          if (ev.text) {
            clearPlaceholder();
            write(`${C.white}✦ ${esc(wrap(mdToText(ev.text), 24).join('\r\n  '))}${C.reset}\r\n`);
          }
        } else {
          return;
        }
        if (!pane.history) {
          try { term.scrollToBottom(); } catch { /* ignore */ }
        }
      }

      function onHistoryEnd() {
        queueFit();
      }

      function dispose() {
        if (disposed) return;
        disposed = true;
        if (fitFrame) {
          cancelAnimationFrame(fitFrame);
          fitFrame = 0;
        }
        if (flashTimer) {
          clearTimeout(flashTimer);
          flashTimer = null;
        }
        if (observer) {
          try { observer.disconnect(); } catch { /* ignore */ }
        }
        terms.delete(slot);
        if (pane.root) terms.delete(pane.root);
        // xterm may still have a viewport refresh queued for the next frame;
        // disposing under it throws, so let that frame run first.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try { term.dispose(); } catch { /* ignore */ }
          try { label.remove(); host.remove(); } catch { /* ignore */ }
        }));
      }

      terms.set(slot, term);
      if (pane.root) terms.set(pane.root, term);
      return { onEvent, onHistoryEnd, dispose };
    },
  });

  window.__wallConsoleText = (paneElement) => {
    let term = paneElement && terms.get(paneElement);
    if (!term && paneElement && paneElement.closest) {
      const root = paneElement.closest('.wall-pane');
      if (root) term = terms.get(root);
    }
    if (!term) return '';
    try { return bufferText(term); } catch { return ''; }
  };
})();
