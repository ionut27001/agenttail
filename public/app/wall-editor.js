// Watch wall widget: a live editor per pane.
// Loaded by index.html as a classic script, in order with the others.
/* ---------- watch wall widget: live editor per pane ---------- */
(() => {
  const TYPE_MS_MAX = 1400;
  const TYPE_MS_PER_CHAR = 9;

  function reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  function create(pane) {
    const slot = pane.slots.editor;
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0;';
    slot.appendChild(host);
    const label = document.createElement('span');
    label.className = 'wp-slot-label';
    label.textContent = 'EDITOR';
    slot.appendChild(label);
    const empty = document.createElement('div');
    empty.className = 'wp-editor-empty';
    empty.textContent = 'waiting for an edit…';
    slot.appendChild(empty);

    const state = {
      editor: null,
      models: new Map(),      // display path -> monaco model
      loading: new Map(),     // display path -> Promise
      current: null,
      lastEdit: null,         // { path, key, args } during history replay
      animation: null,
      decorations: [],
      disposed: false,
      queue: Promise.resolve(),
    };

    // Monaco loads with the page; the wall usually opens later, but wait if not.
    const ready = new Promise((resolve) => {
      const check = () => {
        if (state.disposed) return;
        if (typeof monacoNS !== 'undefined' && monacoNS && monacoNS.editor) {
          state.editor = monacoNS.editor.create(host, {
            theme: 'agenttail',
            readOnly: true,
            domReadOnly: true,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 11.5,
            lineHeight: 17,
            fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
            lineNumbersMinChars: 3,
            wordWrap: 'on',
            renderLineHighlight: 'none',
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            folding: false,
            glyphMargin: false,
            padding: { top: 18, bottom: 6 },
            scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7 },
          });
          resolve();
        } else {
          setTimeout(check, 250);
        }
      };
      check();
    });

    function setLabel(verb, p) {
      label.textContent = p ? `EDITOR · ${verb} ${p}` : 'EDITOR';
    }

    async function load(p, key) {
      if (state.models.has(p)) return state.models.get(p);
      if (state.loading.has(p)) return state.loading.get(p);
      const job = (async () => {
        const qs = new URLSearchParams({ source: pane.agent.source, id: pane.agent.id });
        if (key) qs.set('key', key); else qs.set('path', p);
        let text = '';
        try {
          const res = await fetch(`/api/file?${qs}`);
          const data = await res.json().catch(() => ({}));
          if (res.ok && !data.binary) text = String(data.content || '');
          else text = `// ${p}\n// ${data.error || 'not readable from this workspace'}\n`;
        } catch {
          text = `// ${p}\n// could not load the file\n`;
        }
        await ready;
        const model = monacoNS.editor.createModel(text, langFor(p));
        state.models.set(p, model);
        return model;
      })();
      state.loading.set(p, job);
      try { return await job; } finally { state.loading.delete(p); }
    }

    async function show(p, key) {
      const model = await load(p, key);
      if (state.disposed) return null;
      if (state.editor.getModel() !== model) state.editor.setModel(model);
      state.current = p;
      empty.style.display = 'none';
      return model;
    }

    function highlight(model, startOffset, endOffset) {
      const start = model.getPositionAt(startOffset);
      const end = model.getPositionAt(endOffset);
      const range = new monacoNS.Range(start.lineNumber, start.column, end.lineNumber, end.column);
      state.decorations = state.editor.deltaDecorations(state.decorations, [{
        range,
        options: { className: 'typing-insert', isWholeLine: false },
      }]);
      state.editor.revealRangeInCenterIfOutsideViewport(range);
      return range;
    }

    function stopAnimation() {
      if (state.animation) {
        cancelAnimationFrame(state.animation.frame);
        state.animation.finish();
        state.animation = null;
      }
    }

    /** Type `text` into the model at `offset`, a few characters per frame. */
    function type(model, offset, text) {
      return new Promise((resolve) => {
        stopAnimation();
        if (!text || reduced()) {
          model.applyEdits([{ range: rangeAt(model, offset, offset), text }]);
          highlight(model, offset, offset + text.length);
          resolve();
          return;
        }
        const duration = Math.min(TYPE_MS_MAX, Math.max(250, text.length * TYPE_MS_PER_CHAR));
        const t0 = performance.now();
        let written = 0;
        const anim = {
          frame: 0,
          finish: () => {
            if (written < text.length) {
              model.applyEdits([{ range: rangeAt(model, offset + written, offset + written), text: text.slice(written) }]);
              written = text.length;
            }
            highlight(model, offset, offset + text.length);
            resolve();
          },
        };
        const step = (now) => {
          if (state.disposed) { resolve(); return; }
          const want = Math.min(text.length, Math.ceil(((now - t0) / duration) * text.length));
          if (want > written) {
            model.applyEdits([{ range: rangeAt(model, offset + written, offset + written), text: text.slice(written, want) }]);
            written = want;
            highlight(model, offset, offset + written);
          }
          if (written < text.length) anim.frame = requestAnimationFrame(step);
          else { state.animation = null; anim.finish(); }
        };
        state.animation = anim;
        anim.frame = requestAnimationFrame(step);
      });
    }

    function rangeAt(model, from, to) {
      const a = model.getPositionAt(from);
      const b = model.getPositionAt(to);
      return new monacoNS.Range(a.lineNumber, a.column, b.lineNumber, b.column);
    }

    /** A live edit: remove the old text and type the new one where it was. */
    async function playEdit(p, key, args) {
      const model = await show(p, key);
      if (!model) return;
      setLabel('editing', p);
      const text = model.getValue();
      const oldText = typeof args.old_string === 'string' ? args.old_string : null;
      const newText = typeof args.new_string === 'string' ? args.new_string
        : typeof args.content === 'string' ? args.content : null;
      if (newText === null) return;
      if (oldText && text.includes(oldText)) {
        const at = text.indexOf(oldText);
        model.applyEdits([{ range: rangeAt(model, at, at + oldText.length), text: '' }]);
        await type(model, at, newText);
      } else if (!oldText && typeof args.content === 'string') {
        model.setValue('');
        await type(model, 0, newText.slice(0, 4000));
        if (newText.length > 4000) model.setValue(newText);
      } else if (text.includes(newText)) {
        // The file on disk already has the change: show where it landed.
        const at = text.indexOf(newText);
        highlight(model, at, at + newText.length);
      }
    }

    /** After history: open the last edited file and mark the last change. */
    async function showLast() {
      const last = state.lastEdit;
      if (!last) return;
      const model = await show(last.path, last.key);
      if (!model) return;
      setLabel('last edit', last.path);
      const newText = typeof last.args.new_string === 'string' ? last.args.new_string : null;
      const text = model.getValue();
      if (newText && text.includes(newText)) {
        const at = text.indexOf(newText);
        highlight(model, at, at + newText.length);
      }
    }

    function enqueue(fn) {
      state.queue = state.queue.then(fn).catch(() => {});
    }

    return {
      onEvent(ev) {
        if (ev.t !== 'call' || !ev.args || typeof ev.args.file_path !== 'string') return;
        const p = ev.args.file_path;
        const key = ev.args.key || null;
        if (EDIT_TOOLS.has(ev.name)) {
          if (pane.history) state.lastEdit = { path: p, key, args: ev.args };
          else enqueue(() => playEdit(p, key, ev.args));
        } else if (ev.name === 'read' && !pane.history) {
          enqueue(async () => {
            if (state.animation) return;
            await show(p, key);
            setLabel('reading', p);
          });
        }
      },
      onHistoryEnd() {
        enqueue(showLast);
      },
      dispose() {
        state.disposed = true;
        stopAnimation();
        try { state.editor && state.editor.dispose(); } catch { /* ignore */ }
        for (const model of state.models.values()) {
          try { model.dispose(); } catch { /* ignore */ }
        }
        state.models.clear();
      },
      get value() { return state.editor && state.editor.getModel() ? state.editor.getModel().getValue() : ''; },
      get path() { return state.current; },
    };
  }

  window.__wallHooks = window.__wallHooks || [];
  window.__wallHooks.push({ name: 'editor', create });
  window.__wallEditor = (paneElement) => {
    const ed = paneElement && paneElement.querySelector('.wp-editor');
    return ed ? { label: ed.querySelector('.wp-slot-label')?.textContent || '', text: (ed.querySelector('.view-lines')?.innerText || '').replace(/ /g, ' ') } : null;
  };
})();
