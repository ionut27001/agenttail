// agenttail page: state, event pipeline, editor, console, chat and layout.
// Loaded by index.html as a classic script, in order with the others.
/* =====================================================================
   agenttail page logic
   ===================================================================== */
'use strict';

// One-time migration from the old product prefix. Existing layouts, chat view,
// scale and effect settings survive the rename.
try {
  for (const [oldKey, newKey] of [
    ['dsh-layout', 'agenttail-layout'],
    ['dsh-ui-scale', 'agenttail-ui-scale'],
    ['dsh-chat-view', 'agenttail-chat-view'],
    ['dsh-chat-pin', 'agenttail-chat-pin'],
    ['dsh-fx', 'agenttail-fx'],
    ['dsh-show-hidden', 'agenttail-show-hidden'],
  ]) {
    const value = localStorage.getItem(oldKey);
    if (value !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, value);
    if (value !== null) localStorage.removeItem(oldKey);
  }
} catch { /* localStorage may be unavailable */ }

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/\u001b/g, '');

/* ---------- themes ---------- */
const THEME_KEY = 'agenttail-theme';
const THEME_LIST = ['matrix', 'amber', 'red', 'ice', 'dracula', 'neon', 'paper'];
const THEME_JS = {
  matrix: {
    monaco: {
      base: 'vs-dark',
      rules: [
        { token: 'comment', foreground: '4a6b57', fontStyle: 'italic' },
        { token: 'keyword', foreground: '37f28a' },
        { token: 'string', foreground: 'a8e6a3' },
        { token: 'number', foreground: 'ffd166' },
        { token: 'type', foreground: '5ce1e6' },
        { token: 'delimiter', foreground: '7fa88e' },
        { token: 'tag', foreground: '37f28a' },
      ],
      colors: {
        'editor.background': '#050a08',
        'editor.foreground': '#c8f7d4',
        'editorLineNumber.foreground': '#24402f',
        'editorLineNumber.activeForeground': '#37f28a',
        'editorCursor.foreground': '#37f28a',
        'editor.selectionBackground': '#123a26',
        'editor.lineHighlightBackground': '#08130e',
        'editorGutter.background': '#050a08',
        'editorIndentGuide.background1': '#0d2118',
        'editorWidget.background': '#07100c',
        'editorWidget.border': '#12301f',
        'editorBracketHighlight.foreground1': '#37f28a',
        'editorBracketHighlight.foreground2': '#5ce1e6',
        'editorBracketHighlight.foreground3': '#ffd166',
      },
    },
    terminal: {
      background: 'rgba(0,0,0,0.62)',
      foreground: '#33ff66',
      cursor: '#33ff66',
      selectionBackground: '#0f5132',
      black: '#000000',
      brightBlack: '#2a6b43',
    },
  },
  amber: {
    monaco: {
      base: 'vs-dark',
      rules: [
        { token: 'comment', foreground: '7a5a30', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ffb000' },
        { token: 'string', foreground: 'e8c47a' },
        { token: 'number', foreground: 'ffd166' },
        { token: 'type', foreground: 'ffcf6b' },
        { token: 'delimiter', foreground: 'c9a36a' },
        { token: 'tag', foreground: 'ffb000' },
      ],
      colors: {
        'editor.background': '#0d0904',
        'editor.foreground': '#ffd9a0',
        'editorLineNumber.foreground': '#5e4525',
        'editorLineNumber.activeForeground': '#ffb000',
        'editorCursor.foreground': '#ffb000',
        'editor.selectionBackground': '#3a2a0c',
        'editor.lineHighlightBackground': '#171006',
        'editorGutter.background': '#0d0904',
        'editorIndentGuide.background1': '#33240b',
        'editorWidget.background': '#120d05',
        'editorWidget.border': '#4a3410',
        'editorBracketHighlight.foreground1': '#ffb000',
        'editorBracketHighlight.foreground2': '#ffd27a',
        'editorBracketHighlight.foreground3': '#ff9f43',
      },
    },
    terminal: {
      background: 'rgba(0,0,0,0.62)',
      foreground: '#ffb000',
      cursor: '#ffb000',
      selectionBackground: '#4a3410',
      black: '#000000',
      brightBlack: '#6b4e28',
    },
  },
  red: {
    monaco: {
      base: 'vs-dark',
      rules: [
        { token: 'comment', foreground: '7a5458', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ff3347' },
        { token: 'string', foreground: 'f6c7a0' },
        { token: 'number', foreground: 'ffb547' },
        { token: 'type', foreground: 'ff8fa3' },
        { token: 'delimiter', foreground: 'b58a8f' },
        { token: 'tag', foreground: 'ff3347' },
      ],
      colors: {
        'editor.background': '#0e0708',
        'editor.foreground': '#f3e6e1',
        'editorLineNumber.foreground': '#5a3a3e',
        'editorLineNumber.activeForeground': '#ff3347',
        'editorCursor.foreground': '#ff3347',
        'editor.selectionBackground': '#3d1218',
        'editor.lineHighlightBackground': '#170b0d',
        'editorGutter.background': '#0e0708',
        'editorIndentGuide.background1': '#2a1216',
        'editorWidget.background': '#140a0b',
        'editorWidget.border': '#4d1a20',
        'editorBracketHighlight.foreground1': '#ff3347',
        'editorBracketHighlight.foreground2': '#ffb59a',
        'editorBracketHighlight.foreground3': '#efe0c6',
      },
    },
    terminal: {
      background: 'rgba(7,3,4,0.62)',
      foreground: '#f3e6e1',
      cursor: '#ff3347',
      selectionBackground: '#4d1a20',
      black: '#070304',
      brightBlack: '#7a5458',
    },
  },
  ice: {
    monaco: {
      base: 'vs-dark',
      rules: [
        { token: 'comment', foreground: '54788f', fontStyle: 'italic' },
        { token: 'keyword', foreground: '5ce1e6' },
        { token: 'string', foreground: 'a8e6d0' },
        { token: 'number', foreground: 'ffd166' },
        { token: 'type', foreground: '6fb7ff' },
        { token: 'delimiter', foreground: '7fa3b8' },
        { token: 'tag', foreground: '5ce1e6' },
      ],
      colors: {
        'editor.background': '#07111e',
        'editor.foreground': '#cfeaf7',
        'editorLineNumber.foreground': '#2f4d63',
        'editorLineNumber.activeForeground': '#5ce1e6',
        'editorCursor.foreground': '#5ce1e6',
        'editor.selectionBackground': '#123a52',
        'editor.lineHighlightBackground': '#0a1a2a',
        'editorGutter.background': '#07111e',
        'editorIndentGuide.background1': '#0c2838',
        'editorWidget.background': '#0a1826',
        'editorWidget.border': '#123a4d',
        'editorBracketHighlight.foreground1': '#5ce1e6',
        'editorBracketHighlight.foreground2': '#6fb7ff',
        'editorBracketHighlight.foreground3': '#a8e6d0',
      },
    },
    terminal: {
      background: 'rgba(0,6,13,0.62)',
      foreground: '#a8f0f5',
      cursor: '#5ce1e6',
      selectionBackground: '#123a52',
      black: '#00060d',
      brightBlack: '#2f5a72',
    },
  },
  dracula: {
    monaco: {
      base: 'vs-dark',
      rules: [
        { token: 'comment', foreground: '7b6c92', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ff79c6' },
        { token: 'string', foreground: 'f1fa8c' },
        { token: 'number', foreground: 'bd93f9' },
        { token: 'type', foreground: '8be9fd' },
        { token: 'delimiter', foreground: 'c3b6d9' },
        { token: 'tag', foreground: 'ff79c6' },
      ],
      colors: {
        'editor.background': '#1e1a28',
        'editor.foreground': '#f8f8f2',
        'editorLineNumber.foreground': '#514a63',
        'editorLineNumber.activeForeground': '#bd93f9',
        'editorCursor.foreground': '#ff79c6',
        'editor.selectionBackground': '#3d3152',
        'editor.lineHighlightBackground': '#2a2436',
        'editorGutter.background': '#1e1a28',
        'editorIndentGuide.background1': '#302a3e',
        'editorWidget.background': '#262132',
        'editorWidget.border': '#403850',
        'editorBracketHighlight.foreground1': '#ff79c6',
        'editorBracketHighlight.foreground2': '#bd93f9',
        'editorBracketHighlight.foreground3': '#8be9fd',
      },
    },
    terminal: {
      background: 'rgba(20,17,27,0.62)',
      foreground: '#f8f8f2',
      cursor: '#bd93f9',
      selectionBackground: '#4d3a6b',
      black: '#14111b',
      brightBlack: '#7b6f92',
    },
  },
  neon: {
    monaco: {
      base: 'vs-dark',
      rules: [
        { token: 'comment', foreground: '6e6691', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'fede5d' },
        { token: 'string', foreground: 'ff8b39' },
        { token: 'number', foreground: 'f97e72' },
        { token: 'type', foreground: '36f9f6' },
        { token: 'delimiter', foreground: 'b6b1d1' },
        { token: 'tag', foreground: '72f1b8' },
      ],
      colors: {
        'editor.background': '#1b1828',
        'editor.foreground': '#f4eeff',
        'editorLineNumber.foreground': '#4f4870',
        'editorLineNumber.activeForeground': '#ff7edb',
        'editorCursor.foreground': '#ff7edb',
        'editor.selectionBackground': '#463465',
        'editor.lineHighlightBackground': '#2d2843',
        'editorGutter.background': '#1b1828',
        'editorIndentGuide.background1': '#34294f',
        'editorWidget.background': '#241f36',
        'editorWidget.border': '#3b3254',
        'editorBracketHighlight.foreground1': '#ff7edb',
        'editorBracketHighlight.foreground2': '#36f9f6',
        'editorBracketHighlight.foreground3': '#fede5d',
      },
    },
    terminal: {
      background: 'rgba(18,15,26,0.62)',
      foreground: '#f4eeff',
      cursor: '#ff7edb',
      selectionBackground: '#463465',
      black: '#120f1a',
      brightBlack: '#6e6691',
    },
  },
  paper: {
    monaco: {
      base: 'vs',
      rules: [
        { token: 'comment', foreground: '6f7d72', fontStyle: 'italic' },
        { token: 'keyword', foreground: '1f7a4d' },
        { token: 'string', foreground: '246b3c' },
        { token: 'number', foreground: '9a6200' },
        { token: 'type', foreground: '0b6f86' },
        { token: 'delimiter', foreground: '5f6d63' },
        { token: 'tag', foreground: '1f7a4d' },
      ],
      colors: {
        'editor.background': '#fbf9f3',
        'editor.foreground': '#26312b',
        'editorLineNumber.foreground': '#a3ae9f',
        'editorLineNumber.activeForeground': '#1f7a4d',
        'editorCursor.foreground': '#1f7a4d',
        'editor.selectionBackground': '#cfe3d3',
        'editor.lineHighlightBackground': '#f1ede3',
        'editorGutter.background': '#fbf9f3',
        'editorIndentGuide.background1': '#ddd7c8',
        'editorWidget.background': '#f6f3eb',
        'editorWidget.border': '#c8c1b0',
        'editorBracketHighlight.foreground1': '#1f6f43',
        'editorBracketHighlight.foreground2': '#0b6e8a',
        'editorBracketHighlight.foreground3': '#8a5a00',
      },
    },
    terminal: {
      background: 'rgba(247,244,236,0.94)',
      foreground: '#26312b',
      cursor: '#1f7a4d',
      selectionBackground: '#cfe3d3',
      black: '#26312b',
      brightBlack: '#6b7e71',
    },
  },
};

function normalizeTheme(name) {
  const value = String(name ?? '').toLowerCase();
  return THEME_LIST.includes(value) ? value : 'matrix';
}
let currentTheme = normalizeTheme(document.documentElement.getAttribute('data-theme'));

function buildMonacoTheme(name) {
  const spec = THEME_JS[normalizeTheme(name)].monaco;
  return { base: spec.base, inherit: true, rules: spec.rules, colors: spec.colors };
}

function cssVar(name, fallback) {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/** Apply a theme immediately, in CSS, Monaco, xterm and the canvases. */
function applyTheme(name, persist = true) {
  const next = normalizeTheme(name);
  currentTheme = next;
  if (next === 'matrix') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', next);

  const select = $('themeSelect');
  if (select && select.value !== next) select.value = next;

  try { term.options.theme = { ...THEME_JS[next].terminal }; } catch { /* term not ready */ }
  if (monacoNS && monacoNS.editor) {
    try {
      monacoNS.editor.defineTheme('agenttail', buildMonacoTheme(next));
      monacoNS.editor.setTheme('agenttail');
    } catch { /* monaco not ready */ }
  }

  if (persist) {
    try { localStorage.setItem(THEME_KEY, next); } catch { /* localStorage may be unavailable */ }
  }

  // Canvases read their colours from the CSS variables, so repaint them now.
  try { if (typeof drawSpark === 'function') drawSpark(); } catch { /* ignore */ }
  try { if (typeof window.drawTurnSpark === 'function') window.drawTurnSpark(); } catch { /* ignore */ }
  return next;
}

window.__theme = {
  get: () => currentTheme,
  set: (name) => applyTheme(name),
  list: () => THEME_LIST.slice(),
};

/* ---------- terminal ---------- */
const term = new Terminal({
  fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
  fontSize: 12.5,
  lineHeight: 1.15,
  cursorBlink: true,
  disableStdin: true,
  convertEol: true,
  allowTransparency: true,
  scrollback: 8000,
  theme: { ...THEME_JS[currentTheme].terminal },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
let fitQueued = false;
function ensureTermFit() {
  try {
    fitAddon.fit();
    const screen = document.querySelector('.xterm-screen');
    const viewport = document.querySelector('.xterm-viewport');
    if (!screen || !viewport || !term.rows) return;
    const sh = screen.getBoundingClientRect().height;
    const vh = viewport.getBoundingClientRect().height;
    if (sh > vh + 1) {
      const rowH = sh / term.rows;
      const rows = Math.max(1, Math.floor(vh / rowH));
      if (rows < term.rows) term.resize(term.cols, rows);
    }
  } catch { /* ignore */ }
}
function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    ensureTermFit();
  });
}
term.open($('term'));
fitAddon.fit();
if (term.onData) term.onData(() => {}); // read-only
// Exposed for tests and for anyone who wants to copy the transcript buffer.
window.__agenttailTerm = term;

/* xterm keeps its own selection, which the browser's copy never sees: copy it ourselves. */
function consoleText() {
  if (term.hasSelection()) return term.getSelection();
  const b = term.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}
async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}
async function copyConsole() {
  const btn = $('consoleCopy');
  const selected = term.hasSelection();
  const ok = await writeClipboard(consoleText());
  if (!btn) return;
  btn.textContent = ok ? (selected ? 'copied ✓' : 'copied all ✓') : 'copy failed';
  clearTimeout(copyConsole.timer);
  copyConsole.timer = setTimeout(() => { btn.textContent = 'copy'; }, 1400);
}
$('consoleCopy').addEventListener('click', (e) => { e.stopPropagation(); copyConsole(); });
term.attachCustomKeyEventHandler((e) => {
  const copyKey = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'c' || e.key === 'C');
  if (e.type === 'keydown' && copyKey && term.hasSelection()) {
    copyConsole();
    return false;
  }
  return true;
});
// The browser's own Copy (menu or shortcut) while the selection is in the console.
document.addEventListener('copy', (e) => {
  if (!term.hasSelection() || String(window.getSelection ? window.getSelection() : '').length) return;
  e.clipboardData.setData('text/plain', term.getSelection());
  e.preventDefault();
});
// Right-click copies the selection, as in Windows Terminal; without one the menu stays.
$('term').addEventListener('contextmenu', (e) => {
  if (!term.hasSelection()) return;
  e.preventDefault();
  copyConsole();
});

// xterm 256-colour indices per theme, so terminal output stays readable when
// the foreground/background pair changes (matrix keeps its original colours).
const ANSI_PALETTES = {
  matrix: { green: 46, greenDim: 35, white: 255, cyan: 51, amber: 221, red: 203, magenta: 207, grey: 244, ok: 46 },
  amber: { green: 214, greenDim: 136, white: 230, cyan: 222, amber: 214, red: 203, magenta: 215, grey: 137, ok: 214 },
  red: { green: 203, greenDim: 167, white: 255, cyan: 217, amber: 215, red: 213, magenta: 212, grey: 138, ok: 230 },
  ice: { green: 51, greenDim: 37, white: 255, cyan: 45, amber: 221, red: 203, magenta: 207, grey: 244, ok: 51 },
  dracula: { green: 141, greenDim: 98, white: 255, cyan: 117, amber: 215, red: 203, magenta: 212, grey: 244, ok: 121 },
  neon: { green: 213, greenDim: 176, white: 255, cyan: 51, amber: 227, red: 203, magenta: 213, grey: 103, ok: 121 },
  paper: { green: 28, greenDim: 22, white: 236, cyan: 30, amber: 130, red: 124, magenta: 90, grey: 240, ok: 28 },
};
function ansiCode(key) {
  const palette = ANSI_PALETTES[currentTheme] || ANSI_PALETTES.matrix;
  return `\x1b[38;5;${palette[key]}m`;
}
const C = {
  reset: '\x1b[0m',
  get green() { return ansiCode('green'); },
  get ok() { return ansiCode('ok'); },
  get greenDim() { return ansiCode('greenDim'); },
  get white() { return ansiCode('white'); },
  get cyan() { return ansiCode('cyan'); },
  get amber() { return ansiCode('amber'); },
  get red() { return ansiCode('red'); },
  get magenta() { return ansiCode('magenta'); },
  get grey() { return ansiCode('grey'); },
  bold: '\x1b[1m',
};

function clean(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

let expansions = [];
function pushExpandable(rest, label) {
  if (!rest.length) return;
  expansions.push({ rest, label });
}

document.getElementById('term').addEventListener('click', () => {
  // A drag that selected text ends in a click: keep the selection instead of expanding.
  if (term.hasSelection() || (window.getSelection && String(window.getSelection()).length)) return;
  const item = expansions.pop();
  if (!item) { term.scrollToBottom(); return; }
  const chunk = item.rest.slice(0, 12000);
  const rest = item.rest.slice(12000);
  term.write(`\r\n${C.grey}── expanded: ${esc(item.label)} ──${C.reset}\r\n`);
  term.write(clean(chunk) + (chunk.endsWith('\n') ? '' : '\r\n'));
  if (rest.length) pushExpandable(rest, item.label + ' (more)');
  term.scrollToBottom();
});

/* ---------- monaco ---------- */
let editor = null;
let monacoNS = null;
const models = new Map();      // path -> monaco model
const fileMeta = new Map();    // path -> {touched, errors}
const LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  ps1: 'powershell', psm1: 'powershell', sh: 'shell', bash: 'shell', py: 'python',
  rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql',
  php: 'php', rb: 'ruby', kt: 'kotlin', swift: 'swift', lua: 'lua', r: 'r', dockerfile: 'dockerfile',
};
function langFor(p) {
  const base = String(p).split('/').pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return LANG[ext] || 'plaintext';
}

window.MonacoEnvironment = {
  getWorkerUrl() {
    const base = `${location.origin}/vendor/monaco/`;
    const src = `self.MonacoEnvironment={baseUrl:${JSON.stringify(base)}};importScripts(${JSON.stringify(base + 'vs/base/worker/workerMain.js')});`;
    return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  },
};

/**
 * Edits near the end of a long line scroll the editor sideways. When the
 * typing has been quiet for a moment, scroll back to the start of the line
 * (only matters without word wrap).
 */
function snapBackAfterEdits(ed, enabled) {
  let timer = null;
  ed.onDidChangeModelContent(() => {
    if (!enabled()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { if (ed.getScrollLeft() > 0) ed.setScrollLeft(0); } catch { /* disposed */ }
    }, 2500);
  });
}

function initMonaco() {
  return new Promise((resolve) => {
    require.config({ paths: { vs: '/vendor/monaco/vs' } });
    require(['vs/editor/editor.main'], (m) => {
      monacoNS = m;
      m.editor.defineTheme('agenttail', buildMonacoTheme(currentTheme));
      editor = m.editor.create($('editor'), {
        theme: 'agenttail',
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12.5,
        lineHeight: 19,
        fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
        renderLineHighlight: 'line',
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        padding: { top: 8, bottom: 8 },
        scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
        wordWrap: fx.wrap === false ? 'off' : 'on',
      });
      snapBackAfterEdits(editor, () => fx.wrap === false);
      resolve();
    });
  });
}

function modelFor(p) {
  if (models.has(p)) return models.get(p);
  if (!monacoNS) return null;
  const uri = monacoNS.Uri.parse('agenttail:/workspace/' + p.split('/').map(encodeURIComponent).join('/'));
  const model = monacoNS.editor.createModel('', langFor(p), uri);
  models.set(p, model);
  return model;
}

let emptyModel = null;
function emptyBuffer() {
  if (!emptyModel || emptyModel.isDisposed()) {
    emptyModel = monacoNS.editor.createModel('', 'plaintext', monacoNS.Uri.parse('agenttail:/empty'));
  }
  return emptyModel;
}

/**
 * Empties every per-file buffer without disposing the Monaco models: disposing
 * a model while Monaco is still tokenizing it rejects an internal promise
 * ("Canceled") that surfaces as console noise.
 */
function resetModelBuffers() {
  for (const model of models.values()) {
    try {
      if (!model.isDisposed()) model.setValue('');
    } catch { /* ignore */ }
  }
  loadedFiles.clear();
  unreadable.clear();
  fileKeys.clear();
  if (editor && monacoNS) editor.setModel(emptyBuffer());
}

const loadedFiles = new Set();
const unreadable = new Set();
const fileKeys = new Map();

async function ensureFileContent(p) {
  if (loadedFiles.has(p)) return;
  loadedFiles.add(p);
  const model = modelFor(p);
  if (!model) return;
  const key = fileKeys.get(p);
  const qs = new URLSearchParams({ source: state.source, id: state.sessionId });
  if (key) qs.set('key', key); else qs.set('path', p);
  try {
    const res = await fetch(`/api/file?${qs}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      unreadable.add(p);
      if (model.getValueLength() === 0) {
        model.setValue(
          `// ${p}\n` +
          `// Not readable inside the session workspace (${data.error || res.status}).\n` +
          `// Linked directories are shown in the tree but never followed, so the\n` +
          `// dashboard cannot display files that live outside the workspace root.\n`,
        );
      }
      return;
    }
    if (!data.binary && model.getValueLength() === 0) model.setValue(data.content || '');
  } catch { /* ignore */ }
}

function updateBadge(p, extra) {
  const badge = $('fileBadge');
  if (!p) { badge.classList.add('hidden'); return; }
  const meta = fileMeta.get(p);
  badge.classList.remove('hidden');
  badge.textContent = `${p}${meta && meta.touched ? `  ·  ${meta.touched} edit${meta.touched === 1 ? '' : 's'}` : ''}${extra ? '  ·  ' + extra : ''}`;
}

async function showFile(p, key) {
  const model = modelFor(p);
  if (!model) return;
  if (key) fileKeys.set(p, key);
  state.currentPath = p;
  editor.setModel(model);
  updateBadge(p, unreadable.has(p) ? 'NOT READ — OUTSIDE WORKSPACE' : '');
  $('editorEmpty').classList.add('hidden');
  await ensureFileContent(p);
}

/* ---------- file tree ---------- */
const treeRoot = { children: [] };
const byPath = new Map();
const byKey = new Map();
let treeContainer = null;

function applyTreePayload(data) {
  treeRoot.children = data.tree ? data.tree.children : [];
  if (data.tree) {
    $('wsPath').textContent = data.tree.root;
    $('wsPath').title = data.tree.root;
  }
  buildTree($('tree'));
}

async function reloadTree() {
  if (!state.sessionId) return;
  const qs = new URLSearchParams({ source: state.source, id: state.sessionId });
  if (state.showHidden) qs.set('hidden', '1');
  try {
    const res = await fetch(`/api/tree?${qs}`);
    if (!res.ok) return;
    applyTreePayload(await res.json());
  } catch { /* keep the current tree */ }
}

function buildTree(container) {
  treeContainer = container;
  container.innerHTML = '';
  byPath.clear();
  byKey.clear();
  const frag = document.createDocumentFragment();
  for (const child of treeRoot.children) frag.appendChild(renderNode(child, 0));
  container.appendChild(frag);
  paintTreeState();
}

function paintTreeState() {
  for (const [p, meta] of fileMeta) {
    const entry = byPath.get(p);
    if (!entry) continue;
    entry.row.classList.add('touched');
    entry.row.classList.toggle('err', meta.errors > 0);
    entry.cnt.classList.remove('hidden');
    entry.cnt.textContent = String(meta.touched);
    entry.cnt.classList.toggle('err', meta.errors > 0);
    entry.row.style.setProperty('--heat', heatColor(meta.touched + meta.errors));
    updateFileTitle(p);
  }
  for (const p of state.deletedPaths) {
    const entry = byPath.get(p);
    if (entry) entry.row.classList.add('deleted');
  }
}

function renderNode(node, depth) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'tree-row ' + (node.type === 'dir' ? 'dir' : 'file');
  row.dataset.path = node.path;
  row.style.paddingLeft = `${4 + depth * 11}px`;

  const tw = document.createElement('span');
  tw.className = 'tw';
  tw.textContent = node.type === 'dir' ? '▸' : '';
  row.appendChild(tw);

  const ic = document.createElement('span');
  ic.className = 'ic';
  ic.textContent = node.link ? '⤷' : node.type === 'dir' ? '▤' : '·';
  row.appendChild(ic);

  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = node.name;
  nm.title = node.link ? `${node.path} — linked directory (not followed)` : node.path;
  row.appendChild(nm);

  const cnt = document.createElement('span');
  cnt.className = 'cnt hidden';
  row.appendChild(cnt);

  wrap.appendChild(row);
  byPath.set(node.path, { node, row, cnt, depth });
  if (node.key) byKey.set(node.key, { node, row, cnt, depth });
  if (node.type === 'file') updateFileTitle(node.path);
  if ((node.key && state.deletedKeys.has(node.key)) || state.deletedPaths.has(node.path)) {
    row.classList.add('deleted');
  }

  if (node.type === 'dir') {
    const kids = document.createElement('div');
    kids.className = 'tree-kids hidden';
    let built = false;
    if (node.link) {
      row.style.opacity = '.55';
      row.title = 'linked directory — not followed (reads stay inside the workspace)';
    } else {
      row.addEventListener('click', () => {
        const open = !kids.classList.contains('hidden');
        if (!open && !built) {
          for (const child of node.children) kids.appendChild(renderNode(child, depth + 1));
          built = true;
        }
        kids.classList.toggle('hidden', open);
        tw.textContent = open ? '▸' : '▾';
      });
    }
    wrap.appendChild(kids);
    wrap._kids = kids;
    wrap._tw = tw;
  } else {
    row.addEventListener('click', () => showFile(node.path, node.key));
  }
  return wrap;
}

function revealPath(p) {
  // expand ancestors of a touched file so the highlight is visible
  const parts = p.split('/');
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? cur + '/' + parts[i] : parts[i];
    const entry = byPath.get(cur);
    if (!entry) continue;
    const wrap = entry.row.parentElement;
    const kids = wrap && wrap._kids;
    if (kids && kids.classList.contains('hidden')) {
      entry.row.click();
    }
  }
}

function updateFileTitle(p) {
  const entry = byPath.get(p);
  if (!entry || entry.node.type !== 'file') return;
  const meta = fileMeta.get(p) || { touched: 0, errors: 0, lastAt: 0 };
  const last = meta.lastAt ? `last ${fmtRelative(meta.lastAt)}` : 'never edited';
  const deleted = state.deletedPaths.has(p) ? ' · deleted' : '';
  entry.row.title = `${meta.touched} edits · ${last} · ${meta.errors} failed${deleted}`;
}

function touchedStyle(p, errors) {
  const entry = byPath.get(p);
  if (!entry) return;
  const meta = fileMeta.get(p) || { touched: 0, errors: 0 };
  entry.row.classList.add('touched');
  entry.row.classList.toggle('err', errors ? true : meta.errors > 0);
  entry.cnt.classList.remove('hidden');
  entry.cnt.textContent = String(meta.touched);
  entry.cnt.classList.toggle('err', errors ? true : meta.errors > 0);
  entry.row.style.setProperty('--heat', heatColor(meta.touched + meta.errors));
  updateFileTitle(p);
  entry.row.classList.remove('flash');
  void entry.row.offsetWidth;
  entry.row.classList.add('flash');
  entry.row.classList.remove('pulse');
  void entry.row.offsetWidth;
  entry.row.classList.add('pulse');
  setTimeout(() => entry.row.classList.remove('pulse'), 600);
}

function updateTreeBadge() {
  const n = [...fileMeta.values()].filter((m) => m.touched > 0).length;
  const badge = $('treeBadge');
  if (!badge) return;
  badge.textContent = String(n);
  badge.title = `${n} file${n === 1 ? '' : 's'} touched`;
}

function bumpFile(p, isError) {
  const meta = fileMeta.get(p) || { touched: 0, errors: 0, lastAt: 0 };
  if (isError) meta.errors += 1; else meta.touched += 1;
  meta.lastAt = Date.now();
  fileMeta.set(p, meta);
  updateTreeBadge();
  if (!isError) revealPath(p);
  if (!byPath.has(p)) return;
  touchedStyle(p, false);
  updateBadge(p);
}

function addMissingFile(rel) {
  // The tree is a snapshot; a file the agent created after it was fetched
  // gets appended to its parent folder when that folder is known.
  if (byPath.has(rel)) return;
  const parts = rel.split('/');
  const name = parts.pop();
  const parentRel = parts.join('/');
  if (parentRel) {
    const parent = byPath.get(parentRel);
    if (!parent || parent.node.type !== 'dir') return;
    const node = { type: 'file', name, path: rel, size: 0, mtimeMs: Date.now() };
    parent.node.children.push(node);
    const wrap = parent.row.parentElement;
    if (wrap && wrap._kids && !wrap._kids.classList.contains('hidden')) {
      wrap._kids.appendChild(renderNode(node, parent.depth + 1));
    }
  }
}

/* ---------- app state ---------- */
const state = {
  session: null,
  sessionId: null,
  source: 'dsh',
  prices: null,
  live: false,
  state: 'finished',
  stateDetail: '',
  lastCommand: '',        // short label of the latest command, for the console rail
  lastCommandOk: null,    // its outcome: true, false, or null while unknown
  showEmpty: false,
  showHidden: localStorage.getItem('agenttail-show-hidden') === '1',
  sessions: [],
  historyTotal: 0,
  historySeen: 0,
  commandProgress: null,
  lastEditedPath: null,
  currentPath: null,
  streamSafe: true,
  historyDone: false,
  replaying: false,
  seq: -1,
  events: [],
  stats: { steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, peak: false, lastTime: 0 },
  pendingCommands: new Map(), // callId -> {command, workdir, time}
  toolNames: new Map(),       // callId -> name
  runningJobs: new Map(),     // jobId -> { label, startedAt, kind }
  finishedJobs: new Map(),    // jobId -> { label, startedAt, endedAt, ok, callId }
  termMarkers: new Map(),     // callId -> xterm marker
  route: null,                // { provider, model, contextWindow }
  preset: null,
  policy: null,
  sandbox: null,
  turnCosts: [],              // one entry per completed turn
  currentTurnItem: null,
  deletedKeys: new Set(),
  deletedPaths: new Set(),
  es: null,
  animate: false,
};

const speedInput = $('speed');
const speedVal = $('speedVal');
const speedCps = () => Number(speedInput.value) || 220;
speedInput.addEventListener('input', () => { speedVal.textContent = speedInput.value; });

/* ---------- cost display currency (approximate rates) ---------- */
const CURRENCY_KEY = 'agenttail-currency';
const CURRENCIES = ['USD', 'EUR', 'GBP', 'RON'];
const CURRENCY_RATES = { EUR: 0.92, GBP: 0.79, RON: 4.6 };
let currency = 'USD';
try {
  const savedCurrency = localStorage.getItem(CURRENCY_KEY);
  if (CURRENCIES.includes(savedCurrency)) currency = savedCurrency;
} catch { /* localStorage may be unavailable */ }
function perUsd() {
  if (currency === 'RON') return state.prices?.ronPerUsd || CURRENCY_RATES.RON;
  return CURRENCY_RATES[currency] || 1;
}
function approxCostLine(usd) {
  if (currency === 'USD') return '';
  const value = usd * perUsd();
  const amount = currency === 'RON' ? `${value.toFixed(2)} RON` : `${currency === 'EUR' ? '€' : '£'}${value.toFixed(2)}`;
  return `≈ ${amount} (approx. rate)`;
}
const currencySelect = $('currencySelect');
if (currencySelect) {
  currencySelect.value = currency;
  currencySelect.addEventListener('change', () => {
    currency = CURRENCIES.includes(currencySelect.value) ? currencySelect.value : 'USD';
    try { localStorage.setItem(CURRENCY_KEY, currency); } catch { /* ignore */ }
    renderStats();
  });
}

/* ---------- pricing (USD per 1M tokens, V4.1 Flash) ---------- */
function isPeak(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  for (const [a, b] of (state.prices?.peakUtcWindows || [[1, 4], [6, 10]])) {
    if (h >= a && h < b) return true;
  }
  return false;
}

function tokenTotal(usage) {
  if (!usage) return 0;
  return (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
}

/**
 * What one reply cost in USD: the server's own figure, which it computed from
 * the reply's provider and model (Claude at Anthropic's API list prices, what
 * the tokens would cost on the API even on a subscription; DeepSeek at its
 * list prices by the band the reply fell in). A reply with no price counts 0.
 */
function replyCost(usage, time, cost) {
  if (!state.prices || !usage) return 0;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : 0;
}

function addUsage(usage, time, cost, provider) {
  if (!usage) return;
  state.stats.input += usage.input || 0;
  state.stats.output += usage.output || 0;
  state.stats.cacheRead += usage.cacheRead || 0;
  state.stats.cacheWrite += usage.cacheWrite || 0;
  state.stats.lastTime = Math.max(state.stats.lastTime, time || 0);
  // Speed is what the model writes: output tokens, on the log's own clock.
  if (usage.output) {
    tokenTimeline.push({ t: time || Date.now(), tokens: usage.output });
    if (tokenTimeline.length > 400) tokenTimeline.splice(0, tokenTimeline.length - 400);
  }
  lastActivity = Date.now();
  const p = state.prices;
  if (!p) { renderStats(); return; }
  state.stats.cost += replyCost(usage, time, cost);
  if (typeof cost === 'number') {
    state.stats.pricedTokens = (state.stats.pricedTokens || 0) + tokenTotal(usage);
    if (p.listEstimate) state.stats.peak = isPeak(time || Date.now());
  } else if (tokenTotal(usage) > 0) {
    state.stats.unpriced = (state.stats.unpriced || 0) + 1;
    const by = state.stats.unpricedBy || (state.stats.unpricedBy = {});
    const name = provider || 'unknown provider';
    by[name] = (by[name] || 0) + 1;
  }
  renderStats();
}

function fmtUsd(n) {
  if (n > 0 && n < 0.0001) return n.toFixed(6);
  return n >= 100 ? n.toFixed(2) : n.toFixed(4);
}
function fmtInt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
  return n.toLocaleString('en-US');
}
function renderStats() {
  const s = state.stats;
  $('mTokens').textContent = fmtInt(s.input + s.output + s.cacheRead + s.cacheWrite);
  $('mTokens').title = `input ${s.input.toLocaleString()} · output ${s.output.toLocaleString()} · cache read ${s.cacheRead.toLocaleString()} · cache write ${s.cacheWrite.toLocaleString()}`;
  $('mSteps').textContent = String(s.steps);
  $('mSteps').title = `${s.steps} steps` + (s.turn ? ` · turn ${s.turn} · step ${s.step}` : '');
  const modelEl = $('mModel');
  if (modelEl) {
    const model = state.route?.model || state.session?.model || '';
    const provider = state.route?.provider || state.session?.provider || '';
    modelEl.textContent = model ? `${provider ? provider + '/' : ''}${model}` : '—';
    modelEl.title = model ? `provider ${provider || 'unknown'} · model ${model}` : 'no model recorded for this session';
  }
  const permEl = $('mPerm');
  if (permEl) {
    const preset = state.preset || state.session?.preset || '';
    const policy = state.policy || state.session?.policy || '';
    permEl.textContent = preset || '—';
    permEl.title = [preset ? `permission preset: ${preset}` : '', policy ? `approval policy: ${policy}` : '']
      .filter(Boolean).join(' · ') || 'no permission facts recorded';
  }
  const spark = $('spark');
  if (spark) spark.title = 'output tokens per second, second by second';
  const approx = state.prices ? approxCostLine(s.cost) : '';
  if (!state.prices) {
    $('mCost').innerHTML = '—<span class="period" id="mPeriod">TOKENS ONLY</span>';
    $('mCost').title = 'No cost estimate for this source; token counts only.';
  } else if (state.prices.apiEquivalent) {
    $('mCost').innerHTML = `$${fmtUsd(s.cost)}<span class="period" id="mPeriod">≈ API</span>`;
    const unpriced = s.unpriced ? `\n${s.unpriced} ${s.unpriced === 1 ? 'reply' : 'replies'} from a model with no list price ${s.unpriced === 1 ? 'is' : 'are'} not counted.` : '';
    $('mCost').title = `API equivalent: what these tokens would cost at ${state.prices.model}, $${s.cost.toFixed(4)}. Each reply is priced by its own model, with cache reads, 5-minute and 1-hour cache writes, fast mode and web searches at their own rates. A subscription is not billed per token, so this is a yardstick, not your bill.${unpriced}${approx ? '\n' + approx : ''}`;
  } else {
    // DeepSeek: a list-price estimate, priced reply by reply on the server.
    const names = Object.keys(s.unpricedBy || {});
    const tokensOnly = names.length > 0 && !s.pricedTokens;
    const rest = names.length ? `Tokens only for ${names.join(', ')}: ${s.unpriced} ${s.unpriced === 1 ? 'reply has' : 'replies have'} no public per-token price and ${s.unpriced === 1 ? 'is' : 'are'} not in the cost.` : '';
    const basis = `List-price estimate, not a bill: ${state.prices.model} of ${state.prices.date}. Each reply is priced for its own provider and model; DeepSeek charges 2× during peak hours and the band of each reply is used ("low" = off-peak).`;
    if (tokensOnly) {
      $('mCost').innerHTML = '—<span class="period" id="mPeriod">TOKENS ONLY</span>';
      $('mCost').title = `${rest}\n${basis}`;
    } else {
      $('mCost').innerHTML = `$${fmtUsd(s.cost)}<span class="period" id="mPeriod">${names.length ? 'part' : (s.peak ? 'peak' : 'low')}</span>`;
      $('mCost').title = `$${s.cost.toFixed(4)} · ${basis}${rest ? '\n' + rest : ''}${approx ? '\n' + approx : ''}`;
    }
  }
  updateStatsChip();
}

function setMeter(id, pct, title, na) {
  const el = $(id);
  if (!el) return;
  const fill = el.querySelector('.bar i');
  const val = el.querySelector('.v');
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  if (fill) fill.style.width = na ? '0%' : `${p}%`;
  if (val) val.textContent = na ? 'n/a' : `${p}%`;
  el.classList.toggle('na', !!na);
  el.classList.toggle('warn', !na && p >= 60 && p < 85);
  el.classList.toggle('hot', !na && p >= 85);
  el.title = title;
}

function gb(bytes) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function renderSys(s) {
  if (!s) return;
  setMeter('sysCpu', s.cpu.pct, `CPU ${s.cpu.pct}% · ${s.cpu.cores} logical cores`);
  setMeter('sysRam', s.ram.pct, `RAM ${gb(s.ram.used)} / ${gb(s.ram.total)} GB used (${s.ram.pct}%)`);
  let gpuText = 'n/a';
  if (s.gpu) {
    gpuText = `${s.gpu.pct}%`;
    setMeter(
      'sysGpu',
      s.gpu.pct,
      `${s.gpu.name} · GPU ${s.gpu.pct}% · VRAM ${(s.gpu.usedMiB / 1024).toFixed(1)} / ${(s.gpu.totalMiB / 1024).toFixed(1)} GB`,
    );
  } else {
    setMeter('sysGpu', 0, s.gpuUnavailable ? 'GPU not available (nvidia-smi missing)' : 'GPU sampling…', true);
    if (!s.gpuUnavailable) gpuText = '…';
  }
  const chip = $('sysChip');
  if (chip) {
    chip.title = `CPU ${s.cpu.pct}% (${s.cpu.cores} cores) · RAM ${gb(s.ram.used)} / ${gb(s.ram.total)} GB (${s.ram.pct}%) · GPU ${gpuText}`;
    chip.textContent = 'SYS';
  }
}

function updateStatsChip() {
  const chip = $('statsChip');
  if (!chip) return;
  const s = state.stats;
  const noPrice = state.prices?.listEstimate && !s.pricedTokens && s.unpriced > 0;
  const cost = !state.prices || noPrice ? 'no cost estimate'
    : state.prices.apiEquivalent ? `$${s.cost.toFixed(4)} at API prices`
      : `$${s.cost.toFixed(4)} list-price estimate${s.unpriced ? ' (part of the session has no price)' : ''}`;
  const approx = state.prices ? approxCostLine(s.cost) : '';
  const base = [`${s.steps} steps`, `${(s.input + s.output + s.cacheRead + s.cacheWrite).toLocaleString('en-US')} tokens`, cost].join(' · ');
  chip.title = approx ? `${base}\n${approx}` : base;
}

/* ---------- terminal rendering ---------- */
function termPrompt(workdir, command, description, agent) {
  const cwd = workdir || state.session?.cwd || '';
  const lines = String(command || '').split(/\r?\n/);
  const first = lines[0] || '';
  const rest = lines.slice(1);
  if (agent) term.write(`\r\n${C.grey}↳ ${esc(agent)}${C.reset}`);
  term.write(`\r\n\r\n${C.green}${C.bold}PS ${esc(cwd)}>${C.reset} ${C.white}${C.bold}${esc(first)}${C.reset}${rest.length ? ` ${C.grey}(+${rest.length} lines)${C.reset}` : ''}\r\n`);
  if (rest.length) pushExpandable(rest.join('\n'), `${rest.length} more command line(s)`);
  if (description) term.write(`${C.grey}# ${esc(description)}${C.reset}\r\n`);
}

function termOutput(text, isError) {
  const raw = clean(text);
  const lines = raw.split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const color = isError ? C.red : C.green;
  const maxLines = 10;
  const maxChars = 2200;
  let shown = lines.slice(0, maxLines);
  let rest = lines.slice(maxLines);
  let body = shown.join('\n');
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    rest = [body.slice(maxChars)].filter(Boolean).concat(rest);
  }
  if (body.trim().length) {
    term.write(color + esc(body).replace(/\n/g, '\r\n') + C.reset + '\r\n');
  }
  if (rest.length) {
    term.write(`${C.grey}… (+${rest.length} lines — click console to expand)${C.reset}\r\n`);
    pushExpandable(rest.join('\n'), 'pwsh output');
  }
}

function termStatus(ok, detail) {
  if (ok) term.write(`${C.ok}✓ ${esc(detail || 'exit 0')}${C.reset}\r\n`);
  else term.write(`${C.red}✗ ${esc(detail || 'failed')}${C.reset}\r\n`);
  term.write('\r\n');
}

function flashConsoleError() {
  const pane = $('terminalPane');
  if (!pane) return;
  pane.classList.remove('flash-error');
  void pane.offsetWidth;
  pane.classList.add('flash-error');
  setTimeout(() => pane.classList.remove('flash-error'), 450);
}

/** Lightweight markdown -> plain text for the console. */
function mdToText(md) {
  let s = String(md ?? '').replace(/\r\n/g, '\n');
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
    const name = alt || String(url).split(/[\\/]/).pop() || 'image';
    return `[image: ${name}]`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

  const lines = s.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] || '';
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(next)) {
      const rows = [];
      let j = i;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        rows.push(lines[j]);
        j++;
      }
      const parsed = rows
        .filter((r, idx) => !(idx === 1 && /^[\s|:-]+$/.test(r)))
        .map((r) => mdCells(r));
      const widths = [];
      for (const row of parsed) row.forEach((c, ci) => { widths[ci] = Math.max(widths[ci] || 0, c.length); });
      for (const row of parsed) out.push(row.map((c, ci) => c.padEnd(widths[ci])).join('  ').trimEnd());
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  s = out.join('\n');

  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/~~(.*?)~~/g, '$1');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  s = s.replace(/^\s*-{3,}\s*$/gm, '────────');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function termSay(text, agent) {
  const plain = mdToText(text);
  if (!plain) return;
  const prefix = `${agent ? '↳ ' : ''}▌ `;
  const lines = plain.split('\n');
  const maxLines = 14;
  let shown = lines.slice(0, maxLines);
  let rest = lines.slice(maxLines);
  let body = shown.join('\n');
  if (body.length > 1400) {
    const cut = body.slice(1400);
    rest = [cut].concat(rest);
    body = body.slice(0, 1400);
  }
  const outLines = body.split('\n');
  term.write(`\r\n${C.cyan}${prefix}${esc(outLines[0])}${C.reset}\r\n`);
  for (const line of outLines.slice(1)) term.write(`${C.cyan}  ${esc(line)}${C.reset}\r\n`);
  if (rest.length) {
    term.write(`${C.grey}  (+${rest.length} lines — click to expand)${C.reset}\r\n`);
    pushExpandable(rest.join('\n'), 'agent message');
  }
}

function termUser(text, agent, origin) {
  const one = clean(text).replace(/\s*\n\s*/g, ' ').trim();
  if (!one) return;
  const cut = one.length > 300 ? one.slice(0, 300) + '…' : one;
  term.write(`\r\n${C.magenta}${agent ? '↳ ' : ''}» ${esc(originTag(origin) || 'user')}: ${esc(cut)}${C.reset}\r\n`);
}

/**
 * Who wrote a prompt, when it was not simply the person. Claude Code says so
 * for every prompt; an origin this page does not know is shown as it came.
 */
const ORIGIN_TAGS = { queued: 'queued', task_notification: 'task notification', peer: 'another agent', sdk: 'SDK', scheduled: 'scheduled' };
function originTag(origin) {
  if (!origin || origin === 'person' || origin === 'system') return null;
  return ORIGIN_TAGS[origin] || String(origin);
}

/*
 * The same note many times in a row (an agent editing one file over and over)
 * becomes one line with a counter. While repeats keep arriving live, the line
 * shows a spinner; it settles to the plain note once they stop or anything
 * else is written below it.
 */
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const repeatNote = { text: null, color: '', count: 0, rows: 1, writes: -1, frame: 0, lastAt: 0, timer: null };
let termWrites = 0;
const termWriteRaw = term.write.bind(term);
term.write = (data, cb) => {
  if (repeatNote.timer && repeatNote.writes === termWrites) settleRepeat();
  termWrites++;
  return termWriteRaw(data, cb);
};
for (const method of ['reset', 'clear']) {
  const original = term[method].bind(term);
  term[method] = (...args) => {
    if (repeatNote.timer) { clearInterval(repeatNote.timer); repeatNote.timer = null; }
    repeatNote.text = null;
    termWrites++;
    return original(...args);
  };
}

function repeatLine(spinning) {
  const r = repeatNote;
  const lead = spinning ? `${SPIN[r.frame % SPIN.length]} ` : '';
  return { text: `${lead}${r.text}`, suffix: r.count > 1 ? `  ×${r.count}` : '' };
}

function drawRepeat(spinning) {
  const r = repeatNote;
  const { text, suffix } = repeatLine(spinning);
  let clear = '';
  for (let i = 0; i < r.rows; i++) clear += '\x1b[1A\r\x1b[2K';
  r.rows = Math.max(1, Math.ceil((text.length + suffix.length) / Math.max(1, term.cols)));
  termWriteRaw(`${clear}${r.color || C.grey}${esc(text)}${C.reset}${C.grey}${suffix}${C.reset}\r\n`);
}

function settleRepeat() {
  const r = repeatNote;
  if (r.timer) { clearInterval(r.timer); r.timer = null; }
  if (r.writes === termWrites && r.count > 1) drawRepeat(false);
}

function termNote(text, color) {
  const r = repeatNote;
  const live = state.historyDone && !state.replaying;
  if (r.text === text && r.color === (color || '') && r.writes === termWrites) {
    r.count++;
    r.lastAt = Date.now();
    if (live && !reducedMotion()) {
      r.frame++;
      drawRepeat(true);
      if (!r.timer) {
        r.timer = setInterval(() => {
          if (r.writes !== termWrites || Date.now() - r.lastAt > 1500) { settleRepeat(); return; }
          r.frame++;
          drawRepeat(true);
        }, 110);
      }
    } else {
      drawRepeat(false);
    }
    return;
  }
  if (r.timer) settleRepeat();
  term.write(`${color || C.grey}${esc(text)}${C.reset}\r\n`);
  Object.assign(r, {
    text,
    color: color || '',
    count: 1,
    rows: Math.max(1, Math.ceil(text.length / Math.max(1, term.cols))),
    writes: termWrites,
    frame: 0,
    lastAt: Date.now(),
  });
}

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function shortLabel(label) {
  const one = String(label || '').replace(/\s+/g, ' ').trim();
  return one.length > 110 ? one.slice(0, 110) + '…' : one;
}

function updateJobBar() {
  const bar = $('jobBar');
  if (!bar) return;
  const jobs = [...state.runningJobs.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  if (!jobs.length) {
    bar.classList.add('hidden');
    queueFit();
    return;
  }
  const first = jobs[0];
  bar.classList.remove('hidden');
  $('jobBarText').textContent = `${jobs.length} job${jobs.length === 1 ? '' : 's'} running · ${fmtClock(Date.now() - (first.startedAt || Date.now()))} · ${shortLabel(first.label)}`;
  queueFit();
}

setInterval(() => { if (!document.hidden) updateJobBar(); }, 1000);

/* ---------- edit animation ---------- */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

async function typeInto(model, offset, text, cps, budget = 8) {
  if (!text) return;
  const total = text.length;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const pos = model.getPositionAt(offset);
    editor.executeEdits('typing', [{ range: new monacoNS.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text, forceMoveMarkers: true }]);
    return;
  }
  // Characters are paced by wall-clock time, not frame count, so a throttled
  // or slow display cannot stretch the animation. Large writes always finish
  // within `budget` seconds.
  const rate = Math.max(cps, total / Math.max(0.2, budget));
  const t0 = performance.now();
  let i = 0;
  let frame = 0;
  while (i < total) {
    const target = Math.min(total, Math.floor(((performance.now() - t0) / 1000) * rate));
    if (target > i) {
      const pos = model.getPositionAt(offset + i);
      model.applyEdits([{
        range: new monacoNS.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        text: text.slice(i, target),
      }]);
      i = target;
      placeBlockCursor(model, offset + i);
      if (++frame % 4 === 0) {
        const p2 = model.getPositionAt(offset + i);
        editor.revealPositionInCenterIfOutsideViewport(p2);
      }
    }
    if (i >= total) break;
    await nextFrame();
  }
}

async function animateEdit(path, kind, oldText, newText, key) {
  const model = modelFor(path);
  if (!model) return;
  if (key) fileKeys.set(path, key);
  await ensureFileContent(path);
  showFile(path, key);
  if (unreadable.has(path)) return;
  editor.setModel(model);
  const budget = state.replaying ? 1.1 : 8;
  const Range = monacoNS.Range;
  const cps = speedCps() * (1 + Math.min(inboxLength(), 6) * 0.35);

  const src = model.getValue();
  let at = oldText ? src.indexOf(oldText) : -1;

  if (oldText && at < 0) {
    // The file already contains the new text (live tail, or a snapshot that is
    // ahead of the log). Back-apply, then replay the edit visibly.
    const atNew = src.indexOf(newText);
    if (atNew < 0) {
      // Can't line it up: resync from the workspace copy.
      await reloadModel(path);
      return;
    }
    const s = model.getPositionAt(atNew);
    const e = model.getPositionAt(atNew + newText.length);
    model.applyEdits([{ range: new Range(s.lineNumber, s.column, e.lineNumber, e.column), text: oldText }]);
    at = atNew;
    editor.setModel(model);
  }

  if (kind === 'write' || !oldText) {
    // Whole-file write: replace the visible content.
    const whole = model.getFullModelRange();
    if (model.getValueLength()) {
      editor.deltaDecorations([], [{ range: whole, options: { className: 'typing-remove' } }]);
      model.applyEdits([{ range: whole, text: '' }]);
    }
    const deco = editor.deltaDecorations([], [{
      range: new Range(1, 1, 1, 1),
      options: { className: 'typing-insert' },
    }]);
    await typeInto(model, 0, newText, cps, budget);
    setTimeout(() => editor.deltaDecorations(deco, []), 1600);
    return;
  }

  if (at < 0) return;
  const startPos = model.getPositionAt(at);
  const endPos = model.getPositionAt(at + oldText.length);
  const range = new Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
  const removeDeco = editor.deltaDecorations([], [{ range, options: { className: 'typing-remove' } }]);
  placeBlockCursor(model, at);
  editor.revealPositionInCenterIfOutsideViewport(startPos);
  model.applyEdits([{ range, text: '' }]);
  const insDeco = editor.deltaDecorations([], [{
    range: new Range(startPos.lineNumber, startPos.column, startPos.lineNumber, startPos.column),
    options: { className: 'typing-insert' },
  }]);
  await typeInto(model, at, newText, cps, budget);
  setTimeout(() => {
    editor.deltaDecorations(removeDeco, []);
    editor.deltaDecorations(insDeco, []);
  }, 1800);
}

async function reloadModel(path) {
  try {
    const qs = new URLSearchParams({ source: state.source, id: state.sessionId, path });
    const res = await fetch(`/api/file?${qs}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.binary) return;
    const model = modelFor(path);
    model.setValue(data.content || '');
    showFile(path);
  } catch { /* ignore */ }
}

/* ---------- event application ---------- */
const inbox = [];
let pumping = false;
const inboxLength = () => inbox.length;

function enqueue(ev) {
  if (typeof ev.seq === 'number' && ev.seq <= state.seq && ev.t !== 'session') return;
  if (typeof ev.seq === 'number') state.seq = ev.seq;
  inbox.push(ev);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (inbox.length) {
      const ev = inbox.shift();
      try {
        await applyEvent(ev);
      } catch (err) {
        console.error('event failed', ev, err);
      }
    }
  } finally {
    pumping = false;
  }
}

/** Resolves once every queued history/live event has been applied. */
async function waitForIdle() {
  while (pumping || inbox.length) await new Promise((r) => setTimeout(r, 40));
}

const EDIT_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'notebook_edit']);

async function applyEvent(ev) {
  if (!ev || !ev.t) return;
  pokeActivity();
  touchActivity();
  if (!state.historyDone && !state.replaying) {
    state.historySeen += 1;
    if (state.historySeen % 25 === 0) updateActivityBar();
  }
  state.stats.lastTime = Math.max(state.stats.lastTime, ev.time || 0);
  const animate = ev.__animate === true || state.replaying === true;

  switch (ev.t) {
    case 'step':
      state.stats.steps += 1;
      state.stats.turn = ev.turn;
      state.stats.step = ev.step;
      if (state.currentTurnItem && state.currentTurnItem.turn === ev.turn) state.currentTurnItem.steps += 1;
      if (state.historyDone) renderStats();
      break;

    case 'turn': {
      const item = {
        kind: 'turn',
        turn: ev.turn,
        steps: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
        startedAt: ev.time || Date.now(),
        endedAt: null,
        model: state.route ? state.route.model : (state.session && state.session.model) || null,
        tools: 0,
        commands: 0,
        edits: 0,
        reads: 0,
        errors: 0,
        files: new Set(),
      };
      state.currentTurnItem = item;
      chat.log.push(item);
      scheduleLogRender();
      break;
    }

    case 'turnEnd': {
      const item = state.currentTurnItem && state.currentTurnItem.turn === ev.turn
        ? state.currentTurnItem
        : chat.log.filter((x) => x.kind === 'turn' && x.turn === ev.turn).pop();
      if (item) {
        item.endedAt = ev.time || Date.now();
        // A reply that ran into its output limit ends the turn mid-sentence.
        if (ev.reason === 'max_tokens') {
          item.cutShort = true;
          chatPush({ kind: 'divider', text: 'cut short (max tokens)', chatOnly: true });
        }
        state.turnCosts.push({ turn: item.turn, cost: item.cost, tokens: tokenTotal(item.usage) });
        if (state.turnCosts.length > 60) state.turnCosts.shift();
        drawTurnSpark();
      }
      state.currentTurnItem = null;
      scheduleLogRender();
      break;
    }

    case 'route':
      state.route = { provider: ev.provider, model: ev.model, contextWindow: ev.contextWindow };
      if (state.session) {
        state.session.provider = ev.provider;
        state.session.model = ev.model;
      }
      chatLogPush({ kind: 'meta', text: `model ${ev.provider ? ev.provider + '/' : ''}${ev.model || '?'}` });
      if (state.historyDone) renderStats();
      break;

    case 'preset':
      state.preset = ev.preset;
      chatLogPush({ kind: 'meta', text: `permission preset ${ev.preset || '?'}` });
      if (state.historyDone) renderStats();
      break;

    case 'policy':
      state.policy = ev.policy;
      chatLogPush({ kind: 'meta', text: `approval policy ${ev.policy || '?'}` });
      if (state.historyDone) renderStats();
      break;

    case 'sandbox':
      state.sandbox = ev.mode;
      chatLogPush({ kind: 'meta', text: `sandbox ${ev.mode || '?'}` });
      break;

    case 'say': {
      if (ev.usage) {
        addUsage(ev.usage, ev.time, ev.cost, ev.provider);
        if (state.currentTurnItem && state.currentTurnItem.turn === ev.turn) {
          const u = state.currentTurnItem.usage;
          u.input += ev.usage.input || 0;
          u.output += ev.usage.output || 0;
          u.cacheRead += ev.usage.cacheRead || 0;
          u.cacheWrite += ev.usage.cacheWrite || 0;
          state.currentTurnItem.cost += replyCost(ev.usage, ev.time, ev.cost);
        }
      }
      if (ev.thinking) {
        setActivity('thinking', thinkPreview(ev.thinking), 'chat');
        chatPush({ kind: 'think', text: ev.thinking, agent: ev.agent });
      }
      if (ev.text) {
        setActivity('replying', '', 'chat');
        if (fx.consoleSay) termSay(ev.text, ev.agent);
        chatPush({ kind: 'agent', text: ev.text, agent: ev.agent });
      }
      break;
    }

    case 'usage':
      if (ev.usage) addUsage(ev.usage, ev.time, ev.cost, ev.provider);
      break;

    case 'problem': {
      // A provider failure: out of credit, rate limited, timed out, signed out.
      const text = problemText(ev);
      chatPush({ kind: 'problem', text, problem: ev.kind });
      termNote(`✗ ${text}`, C.red);
      break;
    }

    case 'compacted': {
      // The agent's context was summarised; what follows no longer remembers all that came before.
      const tokens = Number.isFinite(ev.before) && Number.isFinite(ev.after) ? ` (${fmtInt(ev.before)} → ${fmtInt(ev.after)} tokens)` : '';
      chatPush({ kind: 'divider', text: `context compacted${tokens}` });
      termNote('⇲ context compacted', C.grey);
      break;
    }

    case 'deleted': {
      if (ev.key) state.deletedKeys.add(ev.key);
      if (ev.path) state.deletedPaths.add(ev.path);
      const entry = (ev.key && byKey.get(ev.key)) || (ev.path && byPath.get(ev.path));
      if (entry) entry.row.classList.add('deleted');
      if (ev.path) updateFileTitle(ev.path);
      termNote(`✖ deleted ${ev.path || ''}`, C.red);
      break;
    }

    case 'user':
      if (ev.text) {
        if (!ev.system) termUser(ev.text, ev.agent, ev.origin);
        chatPush(ev.system
          ? { kind: 'system', label: [ev.systemLabel || '⟐ system', originTag(ev.origin)].filter(Boolean).join(' · '), text: ev.text, agent: ev.agent }
          : { kind: 'user', text: ev.text, agent: ev.agent, origin: ev.origin });
        if (!ev.system) setActivity('thinking', 'reading your message', 'chat');
      }
      break;

    case 'call': {
      state.toolNames.set(ev.callId, ev.name);
      if (ev.name === 'pwsh') {
        state.pendingCommands.set(ev.callId, {
          command: ev.args.command || '',
          workdir: ev.args.workdir || null,
          time: ev.time,
          description: ev.args.description || '',
        });
        termPrompt(ev.args.workdir, ev.args.command || '', ev.args.description, ev.agent);
      } else if (ev.name === 'write' && ev.args.file_path) {
        termNote(`${ev.agent ? '↳ ' : ''}✎ write  ${ev.args.file_path}`, C.greenDim);
      } else if (ev.name === 'edit' && ev.args.file_path) {
        termNote(`${ev.agent ? '↳ ' : ''}✎ edit   ${ev.args.file_path}`, C.greenDim);
      }

      const p = ev.args && ev.args.file_path ? relPath(ev.args.file_path) : '';
      if (ev.name === 'pwsh') {
        state.commandProgress = null;
        state.lastCommand = shortLabel(ev.args.command || '');
        state.lastCommandOk = null;
        setActivity('running', shortLabel(ev.args.command || ''), 'console');
      } else if (EDIT_TOOLS.has(ev.name) && p) {
        setActivity('editing', p, 'editor');
        state.lastEditedPath = p;
        if (!animate) followFile(p, ev.args && ev.args.key);
      } else {
        setActivity('thinking', TOOL_ACTIVITY[ev.name] || ev.name || 'tool', 'chat');
      }
      if (p && EDIT_TOOLS.has(ev.name) && ev.args) {
        state.pendingEdits.set(ev.callId, p);
        if (ev.args.key) fileKeys.set(p, ev.args.key);
        if (animate && (ev.args.new_string !== undefined || ev.args.content !== undefined)) {
          const kind = ev.name === 'write' ? 'write' : 'edit';
          const oldText = kind === 'edit' ? (ev.args.old_string ?? '') : '';
          const newText = kind === 'edit' ? (ev.args.new_string ?? '') : (ev.args.content ?? '');
          if (kind === 'write' || oldText) await animateEdit(p, kind, oldText, newText, ev.args.key);
        }
      }
      if (ev.t === 'call' && ev.callId) {
        try {
          const marker = term.registerMarker(0);
          if (marker) state.termMarkers.set(ev.callId, marker);
        } catch { /* markers optional */ }
        const logText = ev.name === 'pwsh'
          ? (ev.args && ev.args.command) || ''
          : p || (ev.args && (ev.args.pattern || ev.args.description)) || ev.name || 'tool';
        chatLogPush({
          kind: 'tool',
          callId: ev.callId,
          name: ev.name || 'tool',
          path: p,
          text: shortLabel(logText),
          full: logText,
        });
        const turnItem = state.currentTurnItem;
        if (turnItem) {
          turnItem.tools += 1;
          if (ev.name === 'pwsh') turnItem.commands += 1;
          else if (EDIT_TOOLS.has(ev.name)) {
            turnItem.edits += 1;
            if (p) turnItem.files.add(p);
          } else if (ev.name === 'read') turnItem.reads += 1;
        }
        if (ev.name === 'pwsh' || EDIT_TOOLS.has(ev.name)) {
          const full = ev.name === 'pwsh' ? (ev.args && ev.args.command) || '' : p || ev.name;
          chatPush({
            kind: 'chip',
            callId: ev.callId,
            name: ev.name,
            path: p,
            key: ev.args && ev.args.key,
            text: shortLabel(full),
            full,
          });
        }
      }
      break;
    }

    case 'result': {
      const name = state.toolNames.get(ev.callId);
      const exitMatch = /\[exit code:\s*(-?\d+)\]/i.exec(ev.text || '');
      chatLogPush({
        kind: 'result',
        callId: ev.callId,
        text: ev.text || '',
        isError: !!ev.isError,
        exitCode: exitMatch ? Number(exitMatch[1]) : null,
      });
      if (state.currentTurnItem && (ev.isError || (exitMatch && Number(exitMatch[1]) !== 0))) state.currentTurnItem.errors += 1;
      if (ev.isError) {
        activity.kind = 'thinking';
        activity.startedAt = Date.now();
        triggerGlitch();
        flashConsoleError();
        setTransient('error', 'COMMAND FAILED', 3000);
      }
      if (name === 'pwsh') {
        state.lastCommandOk = !(ev.isError || (exitMatch && Number(exitMatch[1]) !== 0));
        if (ev.agent) termNote(`↳ ${ev.agent}`, C.grey);
        termOutput(ev.text || '', ev.isError);
        if (!ev.isError) {
          const m = /\[exit code:\s*(-?\d+)\]/i.exec(ev.text || '');
          if (m) termStatus(m[1] === '0', `exit ${m[1]}`);
        }
      }
      if (name === 'pwsh' && state.runningJobs.size === 0) {
        state.commandProgress = null;
        setActivity('thinking', 'command finished', 'chat');
      }
      if (name === 'edit' || name === 'write' || name === 'multi_edit') {
        const p = ev.meta?.path ? relPath(ev.meta.path) : (state.pendingEdits.get(ev.callId) || '');
        const key = ev.meta?.key || ev.key;
        if (p) {
          if (key) fileKeys.set(p, key);
          state.lastEditedPath = p;
          bumpFile(p, !!ev.isError);
          if (!state.currentPath) followFile(p, key);
          if (!ev.isError) addMissingFile(p);
        }
      }
      break;
    }

    case 'job': {
      state.runningJobs.set(ev.jobId, {
        label: ev.label,
        startedAt: ev.startedAt || Date.now(),
        kind: ev.kind,
        callId: ev.callId || null,
      });
      setActivity('running', shortLabel(ev.label), 'console');
      termNote(`▶ job running: ${shortLabel(ev.label)}`, C.amber);
      updateJobBar();
      break;
    }

    case 'jobOutput': {
      const text = clean(ev.text || '').replace(/\s+$/, '');
      if (!text.trim()) break;
      const progress = /\[(\d+)\s*\/\s*(\d+)\]/.exec(text);
      if (progress) {
        state.commandProgress = { done: Number(progress[1]), total: Number(progress[2]) };
        updateActivityBar();
      }
      const lines = text.split('\n').slice(0, 60);
      for (const line of lines) {
        term.write(`${C.greenDim}│ ${esc(line.slice(0, 300))}${C.reset}\r\n`);
      }
      break;
    }

    case 'jobEnd': {
      const job = state.runningJobs.get(ev.jobId);
      if (job) {
        state.runningJobs.delete(ev.jobId);
        const ok = ev.status !== 'failed' && !/\b(failed|exit code: [1-9])/i.test(ev.detail || '');
        state.finishedJobs.set(ev.jobId, {
          ...job,
          callId: ev.callId || job.callId || null,
          endedAt: Date.now(),
          ok,
        });
        if (state.finishedJobs.size > 20) state.finishedJobs.delete(state.finishedJobs.keys().next().value);
        updateJobBar();
        termNote(
          `${ok ? '✓' : '✗'} job ${ok ? 'finished' : 'failed'} in ${fmtClock(Date.now() - (job.startedAt || Date.now()))}${ev.detail ? ' · ' + ev.detail : ''}`,
          ok ? C.ok : C.red,
        );
        if (ok) {
          activity.kind = 'thinking';
          activity.startedAt = Date.now();
          activity.pane = null;
          setTransient('jobDone', `JOB FINISHED · ${fmtActivityTime(Date.now() - (job.startedAt || Date.now()))}`, 2000);
        } else {
          activity.kind = 'thinking';
          activity.startedAt = Date.now();
          activity.pane = null;
          flashConsoleError();
          setTransient('error', 'COMMAND FAILED', 3000);
        }
      }
      if (state.pendingCommands.has(ev.callId) && !job) {
        state.pendingCommands.delete(ev.callId);
        const m = /exit code:\s*(-?\d+)/i.exec(ev.detail || '');
        const ok = m ? m[1] === '0' : ev.status === 'completed';
        state.lastCommandOk = ok;
        if (!ok) { triggerGlitch(); flashConsoleError(); setTransient('error', 'COMMAND FAILED', 3000); }
        termStatus(ok, ev.detail || ev.status || '');
      }
      break;
    }

    case 'approval':
      termNote(`⚑ approval requested: ${ev.toolName} — ${ev.reason || ''}`, C.amber);
      break;
    case 'redactionError':
      termNote('⚠ [redaction error] — event dropped', C.red);
      break;
    case 'approvalDone':
      termNote(`⚑ approval ${ev.outcome}`, C.amber);
      break;

    case 'title':
      if (state.session) state.session.title = ev.title;
      break;

    default:
      break;
  }
  if ((ev.t === 'route' || ev.t === 'say') && typeof window.__contextEvent === 'function') {
    window.__contextEvent(ev);
  }
  if (state.historyDone && followActive() && ['jobOutput', 'result', 'job', 'jobEnd', 'say', 'user'].includes(ev.t)) followFanout();
  // Tail reacts to what happens now, not to the history replaying on load.
  if ((state.historyDone || state.replaying) && window.__buddy) window.__buddy.onEvent(ev);
}

function relPath(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  const root = (state.session?.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && s.toLowerCase().startsWith(root.toLowerCase() + '/')) return s.slice(root.length + 1);
  if (root && s.toLowerCase() === root.toLowerCase()) return '';
  return s;
}

/* ---------- SSE ---------- */
function closeStream() {
  if (state.es) { state.es.close(); state.es = null; }
}

function resetView() {
  inbox.length = 0;
  tokenTimeline.length = 0; // TOK/S starts over with the next session or replay
  state.lastCommand = '';
  state.lastCommandOk = null;
  resetModelBuffers();
  fileMeta.clear();
  updateTreeBadge();
  expansions = [];
  byPath.clear();
  treeRoot.children = [];
  state.events = [];
  state.seq = -1;
  state.historyDone = false;
  state.replaying = false;
  state.pendingCommands.clear();
  state.toolNames.clear();
  state.runningJobs.clear();
  state.finishedJobs.clear();
  state.route = null;
  state.preset = null;
  state.policy = null;
  state.sandbox = null;
  state.turnCosts = [];
  state.currentTurnItem = null;
  if (typeof window.__contextReset === 'function') window.__contextReset();
  if (typeof drawTurnSpark === 'function') drawTurnSpark();
  $('jobBar').classList.add('hidden');
  for (const marker of state.termMarkers.values()) {
    try { marker.dispose(); } catch { /* ignore */ }
  }
  state.termMarkers.clear();
  state.deletedKeys.clear();
  state.deletedPaths.clear();
  state.pendingEdits = new Map();
  state.currentPath = null;
  state.lastEditedPath = null;
  state.state = 'finished';
  state.stateDetail = '';
  state.attention = null;
  state.problem = null;
  state.showEmpty = false;
  state.historyTotal = 0;
  state.historySeen = 0;
  document.body.classList.add('loading-session');
  activity.kind = 'idle';
  activity.label = '';
  activity.pane = null;
  setActivePane(null);
  updateActivityBar();
  chatReset();
  state.stats = { steps: 0, turn: 0, step: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, peak: false, lastTime: 0 };
  term.reset();
  term.clear();
  $('tree').innerHTML = '';
  $('editorEmpty').classList.remove('hidden');
  $('fileBadge').classList.add('hidden');
  renderStats();
}

function statusLabel() {
  const dot = $('liveDot');
  const text = $('liveText');
  const st = state.state || (state.live ? 'live' : 'finished');
  dot.className = `dot ${st}`;
  dot.title = state.stateDetail || '';
  applyActivityDot();
  if (state.replaying) { dot.className = 'dot live'; applyActivityDot(); text.textContent = 'REPLAYING'; return; }
  if (!state.historyDone) { text.textContent = 'LOADING'; return; }
  const background = st === 'idle' && /background job/.test(state.stateDetail || '');
  text.textContent = st === 'live' ? 'LIVE' : st === 'idle' ? (background ? 'IDLE · BG' : 'IDLE') : 'FINISHED';
  text.title = state.stateDetail || '';
  // An agent blocked on you says so where the state is shown.
  const waiting = attnNeeds(state.attention);
  dot.classList.toggle('needs-you', waiting);
  if (waiting) {
    text.textContent = 'NEEDS YOU';
    text.title = attnTitle(state.attention);
    dot.title = text.title;
  }
  if (st !== 'live') closeStreamingThinking();
  $('replayBtn').disabled = st === 'live' || !state.historyDone;
  updateChatPill();
  applyActivityDot();
}

async function openSession(id) {
  closeStream();
  resetView();
  state.sessionId = id;
  const sessionSelect = $('sessionSelect');
  if (sessionSelect && [...sessionSelect.options].some((o) => o.value === id)) sessionSelect.value = id;
  updateSessionButton();
  location.hash = state.source === 'dsh' ? (id || '') : `${state.source}:${id}`;
  $('wsPath').textContent = '';
  statusLabel();

  const qs = new URLSearchParams({ source: state.source });
  if (id) qs.set('id', id);
  if (state.showHidden) qs.set('hidden', '1');
  const es = new EventSource(`/api/stream?${qs}`);
  state.es = es;
  try { bindControlStream(es, id); } catch { /* control UI is optional */ }

  es.addEventListener('meta', (e) => {
    const data = JSON.parse(e.data);
    // A reconnect replays from the start: reset so nothing is duplicated.
    if (state.historyDone) resetView();
    state.session = data.session;
    state.prices = data.prices;
    state.state = data.session.state || (data.session.live ? 'live' : null);
    state.stateDetail = data.session.stateDetail || '';
    state.attention = data.session.attention || null;
    state.problem = data.session.problem || null;
    state.historyTotal = Number(data.historyCount) || 0;
    state.historySeen = 0;
    document.body.classList.add('loading-session');
    if (state.state === 'finished') {
      activity.kind = 'done';
      activity.pane = null;
      setActivePane(null);
      updateActivityBar();
    } else if (state.state === 'idle') {
      activity.kind = 'idle';
      activity.pane = null;
      setActivePane(null);
      updateActivityBar();
    }
    state.streamSafe = data.streamSafe !== false;
    state.source = data.session.source || state.source;
    $('sourceSelect').value = state.source;
    const badge = $('streamBadge');
    badge.classList.toggle('off', !state.streamSafe);
    $('streamText').textContent = state.streamSafe ? 'SAFE' : 'UNSAFE';
    badge.title = state.streamSafe
      ? 'Stream mode: the server redacts secrets and identity before sending anything.'
      : 'Stream mode is OFF (server started with --no-stream-mode).';
    state.sessionId = data.session.id;
    state.stats.lastTime = data.session.createdAt || 0;
    $('wsPath').textContent = data.session.cwd || '';
    $('wsPath').title = data.session.cwd || '';
    renderStats();
    updateActivityBar();
  });

  es.addEventListener('tree', (e) => {
    applyTreePayload(JSON.parse(e.data));
  });

  es.addEventListener('ev', (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.t === 'session') {
      if (!state.session) state.session = ev;
      return;
    }
    state.events.push(ev);
    if (state.replaying) return; // replay consumes its own copy
    ev.__animate = state.historyDone; // live events animate; history is applied instantly
    enqueue(ev);
  });

  es.addEventListener('historyEnd', () => {
    state.historyDone = true;
    state.live = false;
    document.body.classList.remove('loading-session');
    renderChat();
    renderStats();
    updateChatRail();
    updateActivityBar();
    statusLabel();
    editorEmptyHint();
    ensureEditorFile();
  });

  es.addEventListener('sys', (e) => {
    try { renderSys(JSON.parse(e.data)); } catch { /* ignore */ }
  });

  es.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    const prevState = state.state;
    state.live = !!data.live;
    if (data.state) state.state = data.state;
    if (data.stateDetail) state.stateDetail = data.stateDetail;
    if (data.attention !== undefined) state.attention = data.attention;
    if (data.problem !== undefined && JSON.stringify(data.problem) !== JSON.stringify(state.problem)) {
      state.problem = data.problem;
      updateActivityBar();
    }
    if (data.state === 'finished') {
      activity.kind = 'done';
      activity.pane = null;
      setActivePane(null);
      updateActivityBar();
      ensureEditorFile();
    } else if (data.state === 'idle') {
      if (activity.kind !== 'idle') {
        activity.kind = 'idle';
        activity.pane = null;
        setActivePane(null);
        updateActivityBar();
      }
      ensureEditorFile();
    } else if (data.state === 'live' && (activity.kind === 'idle' || activity.kind === 'done')) {
      setActivity('thinking', '…', 'chat');
    }
    if (Array.isArray(data.jobs)) {
      const next = new Map();
      for (const job of data.jobs) {
        next.set(job.jobId, {
          label: job.label,
          startedAt: job.startedAt,
          kind: job.kind,
          callId: job.callId || state.runningJobs.get(job.jobId)?.callId || null,
        });
      }
      state.runningJobs = next;
      updateJobBar();
    }
    statusLabel();
  });

  es.addEventListener('reset', () => {
    closeStream();
    openSession(state.sessionId);
  });

  es.onerror = () => {
    if (state.es === es) $('liveText').textContent = 'RECONNECTING';
  };
}

function editorEmptyHint() {
  const anyTouched = fileMeta.size > 0;
  $('editorEmpty').textContent = anyTouched ? 'SELECT A FILE TO INSPECT' : 'WAITING FOR THE AGENT TO TOUCH A FILE';
}

/* ---------- replay ---------- */
async function replay() {
  if (state.replaying || state.live || !state.historyDone) return;
  state.replaying = true;
  $('replayBtn').disabled = true;
  statusLabel();

  // History events may still be draining into the view even though the
  // historyEnd marker arrived; let them land before rebuilding state.
  await waitForIdle();
  if (!state.replaying || state.live) { state.replaying = false; statusLabel(); return; }

  const events = state.events.slice();
  // Reset the visual state but keep the session/stream.
  resetModelBuffers();
  fileMeta.clear();
  updateTreeBadge();
  expansions = [];
  byPath.clear();
  $('tree').innerHTML = '';
  buildTree($('tree'));
  $('editorEmpty').classList.remove('hidden');
  term.clear();
  chatReset();
  state.stats = { steps: 0, turn: 0, step: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, peak: false, lastTime: state.session?.createdAt || 0 };
  state.seq = -1;
  renderStats();
  termNote(`▶ replaying ${events.length} events at ${speedCps()} cps`, C.amber);

  // Pace the transcript so a long session replays in a bounded time; edits
  // dominate the duration through their typing animation.
  const perEvent = events.length ? Math.max(2, Math.min(90, 20000 / events.length)) : 20;
  for (const ev of events) {
    if (!state.replaying) break;
    if (ev.t !== 'step' && ev.t !== 'stepEnd') await new Promise((r) => setTimeout(r, perEvent));
    await applyEvent(ev);
    state.seq = Math.max(state.seq, ev.seq ?? 0);
  }

  state.replaying = false;
  statusLabel();
  termNote('■ replay finished', C.amber);
}

$('replayBtn').addEventListener('click', () => { replay(); });

/* ---------- sources + sessions ---------- */
let sessionKey = '';

function parseHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  const idx = raw.indexOf(':');
  if (idx > 0) return { source: raw.slice(0, idx), id: raw.slice(idx + 1) };
  return { source: 'dsh', id: raw };
}

function fmtRelative(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function dotChar(st) {
  return st === 'live' ? '●' : st === 'idle' ? '◐' : '○';
}

/* ---------- attention ("needs you"): shared by the picker, overview, wall and inbox ---------- */
const ATTENTION_VIA = {
  acp: 'agenttail (ACP)',
  'status-file': "Claude Code's status file",
  hook: 'a Claude Code hook',
  log: 'the session log',
  transcript: 'the transcript',
};

// Reasons that read better as a phrase than as the word the server sends.
const ATTENTION_REASON = { quota: 'out of credit', auth: 'sign-in needed' };

/* A provider problem (out of credit, rate limit...) as the server's fixed words, never the provider's text. */
const PROBLEM_LABEL = { quota: 'out of credit', 'rate-limit': 'rate limited', timeout: 'timed out', auth: 'sign-in needed', 'provider-error': 'provider error' };
function problemText(p) {
  if (!p) return '';
  return [PROBLEM_LABEL[p.kind] || 'provider error', p.status ? `HTTP ${p.status}` : '', p.provider || '', p.attempts ? `attempt ${p.attempts}` : ''].filter(Boolean).join(' · ');
}

function attnNeeds(att) {
  return !!att && att.level === 'needs-you';
}

/** NEEDS YOU · permission · Bash (names only: the server never sends command text). */
function attnLabel(att) {
  if (!att) return '';
  if (att.level === 'ready') return 'READY';
  if (att.level !== 'needs-you') return '';
  const bits = ['NEEDS YOU'];
  if (att.reason && att.reason !== 'unknown') bits.push(ATTENTION_REASON[att.reason] || att.reason);
  if (att.tool) bits.push(att.tool);
  return bits.join(' · ');
}

/** Tooltip: what, how it was seen and how sure we are. */
function attnTitle(att) {
  if (!att || att.level === 'none') return '';
  const label = attnLabel(att);
  const bits = [label];
  // The label already names the reason; a detail that only repeats it adds nothing.
  if (att.detail && !label.toLowerCase().includes(att.detail.toLowerCase())) bits.push(att.detail);
  if (att.via) bits.push(`seen via ${ATTENTION_VIA[att.via] || att.via}`);
  if (att.certainty) bits.push(att.certainty);
  if (att.since) bits.push(`began ${fmtRelative(att.since)}`);
  return bits.join(' — ');
}

/** Needs-you sessions first, otherwise the order the server gave. */
function attnFirst(list) {
  return list.map((s, i) => [s, i])
    .sort(([a, i], [b, j]) => (attnNeeds(b.attention) ? 1 : 0) - (attnNeeds(a.attention) ? 1 : 0) || i - j)
    .map(([s]) => s);
}

async function loadSources() {
  const sel = $('sourceSelect');
  const fallback = [
    { key: 'dsh', label: 'dsh', available: true, count: null },
    { key: 'claude', label: 'Claude Code', available: true, count: null },
    { key: 'antigravity', label: 'Antigravity CLI', available: true, count: null },
  ];
  let list = fallback;
  try {
    const res = await fetch('/api/sources');
    const data = await res.json();
    if (Array.isArray(data.sources) && data.sources.length) list = data.sources;
  } catch { /* fallback keeps the control usable */ }
  sel.innerHTML = '';
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s.key;
    const count = typeof s.count === 'number' ? ` (${s.count})` : '';
    opt.textContent = s.available === false ? `${s.label} (soon)` : `${s.label}${count}`;
    opt.disabled = s.available === false;
    opt.title = s.description || s.label;
    sel.appendChild(opt);
  }
  if (!sel.options.length) {
    const opt = document.createElement('option');
    opt.value = 'dsh';
    opt.textContent = 'dsh';
    sel.appendChild(opt);
  }
  if (![...sel.options].some((o) => o.value === state.source && !o.disabled)) {
    state.source = [...sel.options].find((o) => !o.disabled)?.value || 'dsh';
  }
  sel.value = state.source;
}

function shortId(id) {
  const s = String(id || '');
  return s.startsWith('session-') ? s.slice(8, 16) : s.slice(0, 8);
}

function sessionOption(s) {
  const title = String(s.title || '').replace(/\s+/g, ' ').trim().slice(0, 60) || s.id.slice(0, 8);
  const ws = s.cwd ? s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() : '';
  const bits = [`${dotChar(s.state)} ${title}${s.owned ? ' ◈' : ''}`];
  if (attnNeeds(s.attention)) bits.push(attnLabel(s.attention));
  else if (s.problem) bits.push(`✗ ${problemText(s.problem)}`);
  if (ws) bits.push(ws);
  bits.push(shortId(s.id));
  bits.push(fmtRelative(s.lastEventAt || s.mtimeMs));
  if (s.model) bits.push(`${s.provider ? s.provider + '/' : ''}${s.model}`);
  if (s.preset) bits.push(s.preset);
  if (s.steps !== null && s.steps !== undefined) bits.push(`${s.steps} st`);
  if (s.tokens !== null && s.tokens !== undefined) bits.push(`${fmtInt(s.tokens)} tok`);
  if (s.cost !== null && s.cost !== undefined) bits.push(`$${s.cost.toFixed(3)}`);
  if (s.subagents) bits.push(`${s.subagents} sub`);
  const opt = document.createElement('option');
  opt.value = s.id;
  opt.textContent = bits.join(' · ');
  opt.title = [
    s.title || s.id,
    s.cwd || '',
    `id ${s.id}`,
    s.owned ? 'owned by agenttail (◈)' : (s.source === 'dsh' ? 'started outside agenttail, view only' : ''),
    `state: ${s.state}${s.stateDetail ? ' — ' + s.stateDetail : ''}`,
    attnTitle(s.attention),
    s.problem ? `provider problem: ${problemText(s.problem)}` : '',
    s.source === 'antigravity' && !s.promptsVisible ? 'approval prompts are not visible in the Antigravity editor' : '',
    s.model ? `model: ${s.provider ? s.provider + '/' : ''}${s.model}` : '',
    s.preset ? `permission: ${s.preset}` : '',
    s.policy ? `approval policy: ${s.policy}` : '',
    s.firstUser ? `first prompt: ${String(s.firstUser).replace(/\s+/g, ' ').slice(0, 300)}` : '',
    s.steps !== null && s.steps !== undefined ? `${s.steps} steps` : '',
    s.tokens !== null && s.tokens !== undefined ? `${s.tokens.toLocaleString('en-US')} tokens` : '',
    s.cost !== null && s.cost !== undefined ? `$${s.cost.toFixed(4)}${s.source === 'dsh' ? ' list-price estimate' : ''}` : '',
    s.unpriced?.length ? `tokens only for ${s.unpriced.join(', ')} (no list price)` : '',
    s.nickname ? `nickname: ${s.nickname}` : '',
  ].filter(Boolean).join('\n');
  return opt;
}

function sessionFullTitle(s) {
  return [
    s.title || s.id,
    s.cwd || '',
    `id ${s.id}`,
    s.owned ? 'owned by agenttail (◈)' : (s.source === 'dsh' ? 'started outside agenttail, view only' : ''),
    `state: ${s.state}${s.stateDetail ? ' — ' + s.stateDetail : ''}`,
    attnTitle(s.attention),
    s.problem ? `provider problem: ${problemText(s.problem)}` : '',
    s.source === 'antigravity' && !s.promptsVisible ? 'approval prompts are not visible in the Antigravity editor' : '',
    s.model ? `model: ${s.provider ? s.provider + '/' : ''}${s.model}` : '',
    s.preset ? `permission: ${s.preset}` : '',
    s.policy ? `approval policy: ${s.policy}` : '',
    s.firstUser ? `first prompt: ${String(s.firstUser).replace(/\s+/g, ' ').slice(0, 300)}` : '',
    s.steps !== null && s.steps !== undefined ? `${s.steps} steps` : '',
    s.tokens !== null && s.tokens !== undefined ? `${s.tokens.toLocaleString('en-US')} tokens` : '',
    s.cost !== null && s.cost !== undefined ? `$${s.cost.toFixed(4)}${s.source === 'dsh' ? ' list-price estimate' : ''}` : '',
    s.unpriced?.length ? `tokens only for ${s.unpriced.join(', ')} (no list price)` : '',
    s.nickname ? `nickname: ${s.nickname}` : '',
  ].filter(Boolean).join('\n');
}

function updateSessionButton() {
  const sel = $('sessionSelect');
  const s = (state.sessions || []).find((x) => x.id === sel.value);
  const dot = $('sessionDot');
  const title = $('sessionTitleText');
  const sid = $('sessionIdText');
  if (s) {
    dot.textContent = dotChar(s.state);
    dot.style.color = attnNeeds(s.attention) ? 'var(--amber)' : s.state === 'live' ? 'var(--green)' : s.state === 'idle' ? 'var(--amber)' : 'var(--muted)';
    dot.classList.toggle('needs-you', attnNeeds(s.attention));
    title.textContent = `${s.owned ? '◈ ' : ''}${String(s.title || s.id).replace(/\s+/g, ' ').trim() || s.id}`;
    sid.textContent = shortId(s.id);
    $('sessionButton').title = sessionFullTitle(s);
  } else {
    dot.textContent = '○';
    title.textContent = sel.value === '' ? 'no sessions' : 'loading…';
    sid.textContent = '';
    $('sessionButton').title = title.textContent;
  }
}

function sessionMenuSearchText(s) {
  const ws = s.cwd
    ? s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop()
    : (s.workspace || s.workspaceName || '');
  return [
    s.title,
    s.nickname,
    s.sessionTitle,
    ws,
    s.model,
    s.provider && s.model ? `${s.provider}/${s.model}` : '',
    shortId(s.id),
    s.id,
    s.state,
    s.stateDetail,
    attnNeeds(s.attention) ? 'needs you' : '',
  ].filter(Boolean).join(' ').toLowerCase();
}

function setSessionMenuActive(row, scroll) {
  const menu = $('sessionMenu');
  for (const el of menu.querySelectorAll('.session-item.kbd-active')) el.classList.remove('kbd-active');
  if (!row) return;
  row.classList.add('kbd-active');
  if (scroll !== false && typeof row.scrollIntoView === 'function') {
    try { row.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
  }
}

function visibleSessionRows() {
  return [...$('sessionMenu').querySelectorAll('.session-item[data-session-id]:not(.hidden)')];
}

function applySessionFilter(text) {
  const input = $('sessionSearch');
  const value = text === undefined ? (input ? input.value : '') : String(text);
  if (input && input.value !== value) input.value = value;
  const terms = value.toLowerCase().split(/\s+/).filter(Boolean);
  let first = null;
  for (const row of $('sessionMenu').querySelectorAll('.session-item')) {
    if (!row.dataset.sessionId) {
      row.classList.remove('hidden');
      continue;
    }
    const hit = terms.every((term) => (row._searchText || '').includes(term));
    row.classList.toggle('hidden', !hit);
    if (hit && !first) first = row;
  }
  const empty = $('sessionEmpty');
  if (empty) empty.classList.toggle('hidden', !!first);
  setSessionMenuActive(first, true);
}

function moveSessionMenuActive(delta) {
  const rows = visibleSessionRows();
  if (!rows.length) {
    setSessionMenuActive(null);
    return;
  }
  let index = rows.findIndex((row) => row.classList.contains('kbd-active'));
  if (index < 0) index = delta > 0 ? -1 : 0;
  const next = Math.max(0, Math.min(rows.length - 1, index + delta));
  setSessionMenuActive(rows[next], true);
}

function activeSessionRow() {
  return visibleSessionRows().find((row) => row.classList.contains('kbd-active')) || null;
}

function openSessionMenu() {
  const menu = $('sessionMenu');
  menu.classList.remove('hidden');
  const input = $('sessionSearch');
  applySessionFilter(input ? input.value : '');
  if (input) input.focus();
}

function closeSessionMenu() {
  const menu = $('sessionMenu');
  const wasOpen = !menu.classList.contains('hidden');
  menu.classList.add('hidden');
  if (wasOpen) {
    const input = $('sessionSearch');
    if (input) input.value = '';
    applySessionFilter('');
  }
  setSessionMenuActive(null);
}

function buildSessionMenu(list, emptyCount) {
  const menu = $('sessionMenu');
  for (const row of [...menu.querySelectorAll('.session-item')]) row.remove();
  const addRow = (text, meta, title, onPick, active) => {
    const row = document.createElement('div');
    row.className = `session-item${active ? ' active' : ''}`;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = text;
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta;
    row.append(t, m);
    row.title = title;
    row.addEventListener('mousedown', (e) => e.preventDefault());
    row.addEventListener('click', onPick);
    menu.appendChild(row);
    return row;
  };
  for (const s of list) {
    const ws = s.cwd ? s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() : '';
    const meta = [
      attnNeeds(s.attention) ? attnLabel(s.attention) : '',
      ws,
      shortId(s.id),
      s.owned ? '◈ owned' : 'view only',
      s.model ? `${s.provider ? s.provider + '/' : ''}${s.model}` : '',
      s.preset || '',
      fmtRelative(s.lastEventAt || s.mtimeMs),
      s.steps !== null && s.steps !== undefined ? `${s.steps} st` : '',
      s.tokens !== null && s.tokens !== undefined ? `${fmtInt(s.tokens)} tok` : '',
      s.cost !== null && s.cost !== undefined ? `$${s.cost.toFixed(3)}` : '',
      s.stateDetail || '',
    ].filter(Boolean).join(' · ');
    const row = addRow(`${dotChar(s.state)} ${s.owned ? '◈ ' : ''}${s.title || s.id}`, meta, sessionFullTitle(s), () => {
      $('sessionSelect').value = s.id;
      $('sessionSelect').dispatchEvent(new Event('change'));
      closeSessionMenu();
      updateSessionButton();
    }, s.id === $('sessionSelect').value);
    row.dataset.sessionId = s.id;
    row.classList.toggle('needs-you', attnNeeds(s.attention));
    row._searchText = sessionMenuSearchText(s);
  }
  const empty = $('sessionEmpty');
  if (empty) menu.appendChild(empty);
  if (emptyCount) {
    addRow(
      state.showEmpty ? '⌃ hide empty sessions' : `⌄ show empty sessions (${emptyCount})`,
      state.showEmpty ? 'hide the empty sessions' : 'sessions with no steps or tokens',
      state.showEmpty ? 'Hide empty sessions' : 'Show empty sessions',
      () => {
        $('sessionSelect').value = state.showEmpty ? '__hide_empty__' : '__show_empty__';
        $('sessionSelect').dispatchEvent(new Event('change'));
        closeSessionMenu();
      },
      false,
    );
  }
  applySessionFilter();
}

async function loadSessions(initial) {
  const sel = $('sessionSelect');
  let data;
  try {
    const res = await fetch('/api/sessions?source=' + encodeURIComponent(state.source));
    data = await res.json();
  } catch {
    if (initial) sel.innerHTML = '<option value="">no sessions</option>';
    document.body.classList.remove('loading-session');
    return;
  }
  const all = data.sessions || [];
  const want = initial ? parseHash() : null;
  if (initial && want.source === state.source) {
    const target = all.find((s) => s.id === want.id);
    if (target && target.empty) state.showEmpty = true;
  }
  const emptyCount = all.filter((s) => s.empty).length;
  const list = attnFirst(state.showEmpty
    ? [...all.filter((s) => !s.empty), ...all.filter((s) => s.empty)]
    : all.filter((s) => !s.empty));
  state.sessions = list;
  const key = state.source + '::' + (state.showEmpty ? '1' : '0') + '::' + list
    .map((s) => [s.id, s.state, s.title, s.steps, s.tokens, s.cost, s.lastEventAt, s.subagents, attnLabel(s.attention), s.problem && s.problem.kind].join('~'))
    .join('|');
  if (!initial && key === sessionKey) return;
  sessionKey = key;

  const current = state.sessionId;
  sel.innerHTML = '';
  for (const s of list) sel.appendChild(sessionOption(s));
  if (emptyCount) {
    const opt = document.createElement('option');
    opt.value = state.showEmpty ? '__hide_empty__' : '__show_empty__';
    opt.textContent = state.showEmpty ? '⌃ hide empty' : `⌄ show empty (${emptyCount})`;
    sel.appendChild(opt);
  }
  buildSessionMenu(list, emptyCount);
  updateSessionButton();
  if (!list.length) {
    if (!state.showEmpty && emptyCount) {
      state.showEmpty = true;
      sessionKey = '';
      return loadSessions(initial);
    }
    sel.innerHTML = '<option value="">no sessions</option>';
    state.sessions = [];
    buildSessionMenu([], 0);
    updateSessionButton();
    closeStream();
    resetView();
    document.body.classList.remove('loading-session');
    return;
  }

  if (initial) {
    const pick = (want && want.source === state.source && list.find((s) => s.id === want.id)) || list[0];
    sel.value = pick.id;
    openSession(pick.id);
    return;
  }
  if (current && list.some((s) => s.id === current)) {
    sel.value = current;
    updateSessionButton();
  } else {
    sel.value = list[0].id;
    openSession(list[0].id);
  }
}

$('sessionSelect').addEventListener('change', (e) => {
  const value = e.target.value;
  if (value === '__show_empty__' || value === '__hide_empty__') {
    state.showEmpty = value === '__show_empty__';
    sessionKey = '';
    loadSessions(false);
    return;
  }
  if (value) openSession(value);
});

$('sessionSearch').addEventListener('input', (e) => applySessionFilter(e.target.value));
$('sessionSearch').addEventListener('search', (e) => applySessionFilter(e.target.value));
$('sessionButton').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('sessionMenu').classList.contains('hidden')) openSessionMenu();
  else closeSessionMenu();
});
$('sessionMenu').addEventListener('mousedown', (e) => {
  if (!e.target.closest('#sessionSearch')) e.preventDefault();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#sessionPicker')) closeSessionMenu();
});
document.addEventListener('keydown', (e) => {
  if ($('sessionMenu').classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSessionMenu();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveSessionMenuActive(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'Enter') {
    const row = activeSessionRow();
    if (!row) return;
    e.preventDefault();
    row.click();
  }
});

window.__picker = {
  open() {
    openSessionMenu();
  },
  filter(text) {
    const value = text === null || text === undefined ? '' : String(text);
    const input = $('sessionSearch');
    if (input) input.value = value;
    applySessionFilter(value);
  },
  visibleIds() {
    return visibleSessionRows().map((row) => row.dataset.sessionId);
  },
};

$('nickBtn').addEventListener('click', async () => {
  if (!state.sessionId) return;
  const current = state.session?.title || $('sessionSelect').selectedOptions[0]?.textContent || '';
  const name = window.prompt('Local nickname for this session (leave empty to clear):', current === state.sessionId ? '' : current);
  if (name === null) return;
  try {
    await fetch('/api/nickname', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: state.source, id: state.sessionId, nickname: name }),
    });
  } catch { /* ignore */ }
  sessionKey = '';
  loadSessions(false);
});

$('sourceSelect').addEventListener('change', (e) => {
  state.source = e.target.value;
  state.sessionId = null;
  state.showEmpty = false;
  sessionKey = '';
  closeStream();
  resetView();
  loadSessions(true);
});

window.addEventListener('hashchange', () => {
  const { source, id } = parseHash();
  if (!id) return;
  if (source !== state.source) {
    state.source = source;
    $('sourceSelect').value = source;
    state.sessionId = null;
    state.showEmpty = false;
    sessionKey = '';
    closeStream();
    resetView();
    loadSessions(true);
    return;
  }
  if (id !== state.sessionId) openSession(id);
});

setInterval(() => { if (state.sessionId) loadSessions(false); }, 15000);

/* ---------- splitter ---------- */
(() => {
  const app = $('app');
  const splitter = $('splitter');
  let dragging = false;
  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
    document.body.style.cursor = 'row-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const h = Math.min(Math.max(window.innerHeight - e.clientY, 90), window.innerHeight - 180);
    app.style.gridTemplateRows = `auto minmax(0, 1fr) 6px ${h}px`;
    try { fitAddon.fit(); } catch {}
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
  });
})();

window.addEventListener('resize', () => {
  try { fitAddon.fit(); } catch {}
});

/* ---------- visual effects (all behind toggles) ---------- */
const FX_DEFAULTS = { boot: true, crt: false, matrix: false, cursor: true, glitch: false, spark: true, heat: true, sys: false, follow: true, consoleSay: false, meters: false, wrap: true, mascot: true, intensity: 40 };
const fx = { ...FX_DEFAULTS };
try { Object.assign(fx, JSON.parse(localStorage.getItem('agenttail-fx') || '{}')); } catch { /* ignore */ }
if (typeof fx.intensity !== 'number') fx.intensity = 40;
if (fx.matrix === undefined) fx.matrix = false;

let lastActivity = Date.now();
let matrixTimer = null;
let matrixCtx = null;
let matrixDrops = [];
let sparkTimer = null;
const tokenTimeline = [];
const rateSamples = [];
const MATRIX_GLYPHS = '0123456789ABCDEF';

function pokeActivity() {
  lastActivity = Date.now();
  const canvas = $('matrix');
  if (canvas) canvas.style.opacity = '0';
}

function heatColor(n) {
  if (n >= 10) return cssVar('--red', '#ff5f6d');
  if (n >= 6) return cssVar('--orange', '#ff9f43');
  if (n >= 3) return cssVar('--amber', '#ffd166');
  return cssVar('--green', '#37f28a');
}

function sizeMatrix() {
  const canvas = $('matrix');
  const pane = $('terminalPane');
  if (!canvas || !pane) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, pane.clientWidth * dpr);
  canvas.height = Math.max(1, pane.clientHeight * dpr);
  matrixCtx = canvas.getContext('2d');
  matrixCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const columns = Math.max(6, Math.floor(pane.clientWidth / 22));
  matrixDrops = Array.from({ length: columns }, () => ({
    y: Math.random() * pane.clientHeight,
    speed: 0.35 + Math.random() * 0.45,
  }));
}

/** Matrix rain: only after 30 s of idle, faded out again within 300 ms. */
function drawMatrix() {
  const canvas = $('matrix');
  if (!canvas || !matrixCtx) return;
  if (Date.now() - lastActivity < 30_000) {
    canvas.style.opacity = '0';
    return;
  }
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.style.opacity = String(0.08 + 0.04 * (fx.intensity / 100));
  matrixCtx.fillStyle = cssVar('--matrix-fade', 'rgba(0,0,0,0.18)');
  matrixCtx.fillRect(0, 0, w, h);
  matrixCtx.font = '10px "JetBrains Mono", monospace';
  matrixCtx.fillStyle = cssVar('--matrix-glyph', 'rgba(55,242,138,0.65)');
  for (let i = 0; i < matrixDrops.length; i++) {
    const col = matrixDrops[i];
    const x = i * 22 + 6;
    if (col.y > 0 && col.y < h) {
      matrixCtx.fillText(MATRIX_GLYPHS[Math.floor(Math.random() * MATRIX_GLYPHS.length)], x, col.y);
    }
    col.y += col.speed * 1.6;
    if (col.y > h + Math.random() * 220) {
      col.y = -Math.random() * 220;
      col.speed = 0.35 + Math.random() * 0.45;
    }
  }
}

function startMatrix() {
  if (matrixTimer || document.hidden || !fx.matrix) return;
  sizeMatrix();
  matrixTimer = setInterval(drawMatrix, 140);
}

function stopMatrix() {
  clearInterval(matrixTimer);
  matrixTimer = null;
  const canvas = $('matrix');
  if (canvas) canvas.style.opacity = '0';
}

function drawSpark() {
  const canvas = $('spark');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = cssVar('--green', '#37f28a');
  ctx.lineWidth = 1 + (fx.intensity / 100) * 1.5;
  const max = Math.max(1, ...rateSamples);
  ctx.beginPath();
  rateSamples.forEach((v, i) => {
    const x = (i / Math.max(1, rateSamples.length - 1)) * (canvas.width - 1);
    const y = canvas.height - 1 - (v / max) * (canvas.height - 3);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.stroke();
}

/** Output tokens per second over the last windowMs of a timeline of { t, tokens } (the wall panes keep their own). */
function outputRate(windowMs, timeline = tokenTimeline) {
  const now = Date.now();
  let tokens = 0;
  for (const x of timeline) if (now - x.t <= windowMs) tokens += x.tokens;
  return tokens / (windowMs / 1000);
}

function fmtRate(r) {
  return r === 0 ? '0' : r >= 1000 ? `${(r / 1000).toFixed(1)}k` : r >= 10 ? String(Math.round(r)) : r.toFixed(1);
}

/** The TOK/S number: a 30 s average, so a burst at the end of a step does not flicker it. */
function renderRate() {
  const el = $('mRate');
  if (!el) return;
  const r = outputRate(30000);
  el.textContent = fmtRate(r);
  el.title = `${r.toFixed(1)} output tokens per second over the last 30 s`;
}
setInterval(renderRate, 1000);

function sampleRate() {
  rateSamples.push(Math.round(outputRate(3000)));
  if (rateSamples.length > 40) rateSamples.shift();
  drawSpark();
}

function startSpark() {
  if (sparkTimer || document.hidden || !fx.spark) return;
  sampleRate();
  sparkTimer = setInterval(sampleRate, 1000);
}

function stopSpark() {
  clearInterval(sparkTimer);
  sparkTimer = null;
}

let cursorHideTimer = null;
function placeBlockCursor(model, offset) {
  const el = $('blockCursor');
  if (!fx.cursor || !editor || !model) { el.classList.add('hidden'); return; }
  const coords = editor.getScrolledVisiblePosition(model.getPositionAt(offset));
  const dom = editor.getDomNode();
  if (!coords || !dom) { el.classList.add('hidden'); return; }
  const dr = dom.getBoundingClientRect();
  const wr = $('editorWrap').getBoundingClientRect();
  el.style.left = `${dr.left - wr.left + coords.left}px`;
  el.style.top = `${dr.top - wr.top + coords.top}px`;
  el.style.height = `${coords.height || 16}px`;
  el.classList.remove('hidden');
  clearTimeout(cursorHideTimer);
  cursorHideTimer = setTimeout(() => el.classList.add('hidden'), 800);
}

function triggerGlitch() {
  if (!fx.glitch) return;
  const pane = $('terminalPane');
  pane.classList.remove('glitch');
  void pane.offsetWidth;
  pane.classList.add('glitch');
  setTimeout(() => pane.classList.remove('glitch'), 520);
}

function applyFx(save = true) {
  const intensity = Math.max(0, Math.min(100, Number(fx.intensity) || 0));
  document.documentElement.style.setProperty('--fx', (intensity / 100).toFixed(2));
  for (const key of Object.keys(FX_DEFAULTS)) {
    if (typeof FX_DEFAULTS[key] !== 'boolean') continue;
    document.body.classList.toggle(`fx-${key}`, !!fx[key]);
    const box = document.querySelector(`[data-fx="${key}"]`);
    if (box) box.checked = !!fx[key];
  }
  if (typeof editor !== 'undefined' && editor) {
    try { editor.updateOptions({ wordWrap: fx.wrap === false ? 'off' : 'on' }); } catch { /* not ready */ }
  }
  if (fx.matrix) startMatrix(); else stopMatrix();
  if (fx.spark) startSpark(); else stopSpark();
  if (!fx.boot) {
    $('boot').classList.add('hidden');
    document.body.classList.add('boot-done');
  }
  if (save) {
    try { localStorage.setItem('agenttail-fx', JSON.stringify(fx)); } catch { /* ignore */ }
  }
}

function runBoot() {
  const boot = $('boot');
  if (!fx.boot) { boot.classList.add('hidden'); document.body.classList.add('boot-done'); return; }
  boot.classList.remove('hidden');
  const lines = [
    ['> initializing agenttail', 'ok'],
    ['> sources: dsh · claude · antigravity', 'ok'],
    ['> stream mode: SAFE (server-side redaction)', 'ok'],
    ['> mounting monaco + xterm', 'ok'],
    ['> ready', 'ok'],
  ];
  const log = $('bootLog');
  log.innerHTML = '';
  let i = 0;
  let timer = null;
  const finish = () => {
    if (timer) clearInterval(timer);
    timer = null;
    boot.classList.add('hidden');
    document.body.classList.add('boot-done');
  };
  timer = setInterval(() => {
    if (i >= lines.length) { finish(); return; }
    const div = document.createElement('div');
    div.className = lines[i][1];
    div.innerHTML = lines[i][0];
    log.appendChild(div);
    i++;
  }, 170);
  boot.addEventListener('click', finish, { once: true });
  setTimeout(finish, 2600);
}

document.querySelectorAll('#fxPanel input[data-fx]').forEach((box) => {
  box.addEventListener('change', () => {
    fx[box.dataset.fx] = box.checked;
    if (box.dataset.fx === 'matrix' && box.checked) pokeActivity();
    applyFx();
    if (box.dataset.fx === 'sys') renderChat();
    if (box.dataset.fx === 'follow') {
      if (!fx.follow) followPausedUntil = 0;
      else { ensureEditorFile(); followFanout(); }
      updateActivityBar();
    }
  });
});
function setSettingsOpen(open) {
  $('fxPanel').classList.toggle('hidden', !open);
  $('fxBackdrop').classList.toggle('hidden', !open);
  if (open) $('fxClose').focus({ preventScroll: true });
}
$('fxBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  setSettingsOpen($('fxPanel').classList.contains('hidden'));
});
$('fxClose').addEventListener('click', () => setSettingsOpen(false));
$('fxBackdrop').addEventListener('click', () => setSettingsOpen(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('fxPanel').classList.contains('hidden')) setSettingsOpen(false);
});

function isTypingFocus(el) {
  return !!el && el.nodeType === 1 && !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .monaco-editor');
}
let helpReturnFocus = null;
function setHelpOpen(open) {
  const panel = $('helpPanel');
  if (!panel) return;
  const wasOpen = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  $('helpBackdrop').classList.toggle('hidden', !open);
  if (open) {
    if (!wasOpen) helpReturnFocus = document.activeElement;
    $('helpClose').focus({ preventScroll: true });
  } else if (wasOpen && helpReturnFocus && document.contains(helpReturnFocus)) {
    const target = helpReturnFocus;
    helpReturnFocus = null;
    try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
}
$('helpBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  setHelpOpen(true);
});
$('fxHelp').addEventListener('click', () => {
  setSettingsOpen(false);
  setHelpOpen(true);
});
$('helpClose').addEventListener('click', () => setHelpOpen(false));
$('helpBackdrop').addEventListener('click', () => setHelpOpen(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('helpPanel').classList.contains('hidden')) {
    e.preventDefault();
    setHelpOpen(false);
    return;
  }
  if (e.defaultPrevented || e.key !== '?' || e.ctrlKey || e.altKey || e.metaKey) return;
  if (isTypingFocus(e.target) || isTypingFocus(document.activeElement)) return;
  e.preventDefault();
  setHelpOpen(true);
});
window.__help = { open: () => setHelpOpen(true), close: () => setHelpOpen(false) };

document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('tab-hidden', document.hidden);
  if (document.hidden) {
    stopMatrix();
    stopSpark();
  } else {
    if (fx.matrix) startMatrix();
    if (fx.spark) startSpark();
    updateJobBar();
  }
});
window.addEventListener('resize', () => {
  if (fx.matrix && !document.hidden) sizeMatrix();
  drawSpark();
});

window.__fx = {
  state: fx,
  apply: applyFx,
  glitch: triggerGlitch,
  matrixRunning: () => !!matrixTimer,
  sparkRunning: () => !!sparkTimer,
  idleFor: (ms) => { lastActivity = Date.now() - Math.max(0, Number(ms) || 0); },
  poke: pokeActivity,
  glyphs: MATRIX_GLYPHS,
  matrixOpacity: () => {
    const canvas = $('matrix');
    return canvas ? getComputedStyle(canvas).opacity : '0';
  },
};

/* ---------- docked layout ---------- */
const LAYOUT_KEY = 'agenttail-layout';
const layout = { bottomH: null, chatW: null, chatSideW: null, chatSide: false, bottomCollapsed: false, chatCollapsed: false, treeCollapsed: false, saved: false };
try {
  const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
  if (saved && typeof saved === 'object') Object.assign(layout, saved);
} catch { /* ignore */ }

const narrowStart = window.innerWidth < 1000;
if (!layout.saved) {
  layout.bottomH = Math.round(window.innerHeight * 0.28);
  layout.chatW = Math.round(window.innerWidth * 0.45);
  layout.treeCollapsed = narrowStart;
  layout.chatCollapsed = narrowStart;
}
if (!layout.bottomH) layout.bottomH = Math.round(window.innerHeight * 0.28);
if (!layout.chatW) layout.chatW = Math.round(window.innerWidth * 0.45);

const UI_SCALE_KEY = 'agenttail-ui-scale';
let uiScale = Number(localStorage.getItem(UI_SCALE_KEY) || 0);
if (![0.9, 1, 1.15, 1.3].includes(uiScale)) uiScale = window.innerWidth > 1600 ? 1.15 : 1;
if (!layout.saved) {
  layout.chatW = Math.round((window.innerWidth / uiScale) * 0.45);
  layout.bottomH = Math.round((window.innerHeight / uiScale) * 0.28);
}
function applyUiScale(scale, persist = true) {
  uiScale = [0.9, 1, 1.15, 1.3].includes(Number(scale)) ? Number(scale) : 1;
  document.documentElement.style.setProperty('--ui-scale', String(uiScale));
  const sel = $('uiScale');
  if (sel) sel.value = String(uiScale);
  const eff = window.innerWidth / uiScale;
  document.body.classList.toggle('ui-compact-stats', eff <= 1500);
  document.body.classList.toggle('ui-compact-sys', eff <= 1200);
  clampLayout();
  applyLayout();
  if (persist) {
    try { localStorage.setItem(UI_SCALE_KEY, String(uiScale)); } catch { /* ignore */ }
  }
}

function clampLayout() {
  layout.bottomH = Math.max(120, Number(layout.bottomH) || 220);
  layout.chatW = Math.max(420, Number(layout.chatW) || 480);
  const width = window.innerWidth / (uiScale || 1);
  layout.chatSideW = Math.min(Math.max(320, Number(layout.chatSideW) || Math.round(width * 0.32)), Math.max(320, width - 480));
  layout.chatSide = !!layout.chatSide;
}

/** Move the agent pane between the bottom area and the right-side column. */
function placeChatPane() {
  const pane = $('chatPane');
  const rail = $('chatRail');
  const side = !!layout.chatSide;
  const target = side ? $('app') : $('bottomArea');
  if (pane.parentElement === target) return;
  const log = $('chatLog');
  const atBottom = log && log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  // Both live last in either parent: after the console in the bottom area,
  // or after the side splitter in #app (grid placement does the rest).
  target.appendChild(pane);
  target.appendChild(rail);
  if (log && (atBottom || chat.pinned)) log.scrollTop = log.scrollHeight;
  const dock = $('chatDock');
  if (dock) {
    dock.textContent = side ? '⤓' : '⇥';
    dock.title = side ? 'Dock the agent under the editor (Ctrl+Shift+.)' : 'Dock the agent to the right side (Ctrl+Shift+.)';
    dock.setAttribute('aria-pressed', String(side));
  }
}
function applyLayout() {
  clampLayout();
  const app = $('app');
  const shownBottom = Math.min(layout.bottomH, Math.round(window.innerHeight * 0.7));
  const shownChat = Math.min(layout.chatW, Math.max(420, window.innerWidth - 226));
  app.style.setProperty('--bottom-h', `${shownBottom}px`);
  app.style.setProperty('--chat-w', `${shownChat}px`);
  app.style.setProperty('--chat-side-w', `${layout.chatSideW}px`);
  document.body.classList.toggle('chat-side', !!layout.chatSide);
  placeChatPane();
  document.body.classList.toggle('bottom-collapsed', !!layout.bottomCollapsed);
  document.body.classList.toggle('chat-collapsed', !!layout.chatCollapsed);
  document.body.classList.toggle('tree-collapsed', !!layout.treeCollapsed);
  ensureTermFit();
}
function saveLayout() {
  layout.saved = true;
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ }
}
function toggleTree(force) {
  layout.treeCollapsed = force === undefined ? !layout.treeCollapsed : !!force;
  applyLayout();
  saveLayout();
}
function toggleBottom(force) {
  layout.bottomCollapsed = force === undefined ? !layout.bottomCollapsed : !!force;
  applyLayout();
  saveLayout();
}
function toggleChatSide(force) {
  layout.chatSide = force === undefined ? !layout.chatSide : !!force;
  if (layout.chatCollapsed) layout.chatCollapsed = false;
  applyLayout();
  saveLayout();
  renderChat();
}
function setChatOpen(open) {
  layout.chatCollapsed = !open;
  if (open && layout.bottomCollapsed) layout.bottomCollapsed = false;
  applyLayout();
  saveLayout();
  if (open) {
    chat.unread = 0;
    renderChat();
    setTimeout(() => {
      const log = $('chatLog');
      if (log && chat.pinned) log.scrollTop = log.scrollHeight;
    }, 0);
  }
  updateChatRail();
}
function toggleChat() {
  setChatOpen(!!layout.chatCollapsed);
}

$('treeCollapse').addEventListener('click', () => toggleTree(true));
$('treeExpand').addEventListener('click', () => toggleTree(false));
$('chatClose').addEventListener('click', () => setChatOpen(false));
$('chatExpand').addEventListener('click', () => setChatOpen(true));
$('bottomExpand').addEventListener('click', () => toggleBottom(false));
$('uiScale').addEventListener('change', () => applyUiScale(Number($('uiScale').value)));
$('themeSelect').addEventListener('change', () => applyTheme($('themeSelect').value));
$('showHiddenBox').checked = state.showHidden;
$('showHiddenBox').addEventListener('change', () => {
  state.showHidden = $('showHiddenBox').checked;
  try { localStorage.setItem('agenttail-show-hidden', state.showHidden ? '1' : '0'); } catch { /* ignore */ }
  reloadTree();
});

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'b' || e.key === 'B') { e.preventDefault(); toggleTree(); }
  else if (e.key === 'j' || e.key === 'J') { e.preventDefault(); toggleBottom(); }
  else if (e.shiftKey && (e.key === '>' || e.code === 'Period')) { e.preventDefault(); toggleChatSide(); }
  else if (e.key === '.' || e.code === 'Period') { e.preventDefault(); toggleChat(); }
});

(() => {
  let drag = null;
  const split = $('splitter');
  split.addEventListener('pointerdown', (e) => {
    drag = { mode: 'bottom' };
    e.preventDefault();
  });
  split.addEventListener('dblclick', () => toggleBottom());
  $('consoleChatSplitter').addEventListener('pointerdown', (e) => {
    drag = { mode: 'chat' };
    e.preventDefault();
  });
  $('sideSplitter').addEventListener('pointerdown', (e) => {
    drag = { mode: 'side' };
    e.preventDefault();
  });
  $('chatDock').addEventListener('click', () => toggleChatSide());
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.mode === 'bottom') layout.bottomH = Math.round(window.innerHeight - e.clientY);
    else if (drag.mode === 'side') layout.chatSideW = Math.round($('app').getBoundingClientRect().right - e.clientX);
    else layout.chatW = Math.round($('bottomArea').getBoundingClientRect().right - e.clientX);
    applyLayout();
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    saveLayout();
  });
  window.addEventListener('resize', () => applyUiScale(uiScale, false));
})();

/* ---------- activity bar + follow mode ---------- */
const activity = { kind: 'idle', label: '', pane: null, startedAt: Date.now(), lastEventAt: Date.now(), transient: null };
let followPausedUntil = 0;

function transientActive() {
  return !!activity.transient && Date.now() < activity.transient.until;
}

function setTransient(kind, text, ms) {
  if (!state.historyDone && !state.replaying) return;
  activity.transient = { kind, text, until: Date.now() + ms };
  updateActivityBar();
  setTimeout(() => {
    if (!activity.transient || Date.now() < activity.transient.until) return;
    activity.transient = null;
    updateActivityBar();
  }, ms + 30);
}

function applyActivityDot() {
  const dot = $('liveDot');
  if (!dot) return;
  for (const k of ['thinking', 'running', 'editing', 'replying', 'error']) dot.classList.remove(`act-${k}`);
  const kind = activity.transient ? (activity.transient.kind === 'error' ? 'error' : activity.transient.kind) : activity.kind;
  if (state.live && ['thinking', 'running', 'editing', 'replying', 'error'].includes(kind)) dot.classList.add(`act-${kind}`);
}

function followActive() {
  return !!fx.follow && Date.now() >= followPausedUntil;
}

function followFanout() {
  if (!followActive()) return;
  try { term.scrollToBottom(); } catch { /* not ready */ }
  const log = $('chatLog');
  if (log) log.scrollTop = log.scrollHeight;
}

function pauseFollow() {
  if (!fx.follow) return;
  followPausedUntil = Date.now() + 30000;
  updateActivityBar();
  setTimeout(() => {
    if (Date.now() < followPausedUntil) return;
    updateActivityBar();
    if (followActive()) {
      ensureEditorFile();
      followFanout();
    }
  }, 30100);
}

function fmtActivityTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h`;
}

function setActivePane(pane) {
  const map = { console: 'terminalPane', editor: 'editorWrap', chat: 'chatPane' };
  for (const [key, paneId] of Object.entries(map)) {
    const el = $(paneId);
    if (el) el.classList.toggle('active', pane === key);
  }
}

function updateActivityBar() {
  const bar = $('activityBar');
  if (!bar) return;
  const paused = Date.now() < followPausedUntil;
  const follow = $('followState');
  if (follow) {
    follow.classList.toggle('hidden', !paused);
    if (paused) follow.textContent = `FOLLOW PAUSED · ${Math.ceil((followPausedUntil - Date.now()) / 1000)} s`;
  }
  const loading = !state.historyDone && !state.replaying;
  const transient = transientActive() ? activity.transient : null;
  const kind = transient ? transient.kind : activity.kind;
  const iconEl = $('activityIcon');
  const textEl = $('activityText');
  const loadFill = $('loadFill');
  let icon = '·';
  let text = 'CONNECTING';
  bar.classList.remove('idle', 'done', 'working', 'thinking', 'running', 'editing', 'replying', 'error', 'loading', 'needs-you');
  if (loading) {
    const total = state.historyTotal || 0;
    const seen = state.historySeen || 0;
    icon = '⏳';
    text = `LOADING session… ${seen.toLocaleString('en-US')}${total ? ` / ${total.toLocaleString('en-US')}` : ''} events`;
    bar.classList.add('loading');
    if (loadFill) {
      loadFill.classList.remove('hidden');
      loadFill.style.width = total ? `${Math.min(100, (seen / total) * 100)}%` : '30%';
    }
  } else {
    if (loadFill) loadFill.classList.add('hidden');
    if (transient) {
      icon = transient.kind === 'error' ? '✗' : transient.kind === 'jobDone' ? '✓' : '·';
      text = transient.text;
      bar.classList.add(transient.kind === 'error' ? 'error' : 'working');
    } else if (attnNeeds(state.attention)) {
      // Blocked on a person: say so, whatever the last action was.
      icon = '⚠'; text = `${attnLabel(state.attention)}${state.attention.since ? ` · ${fmtAgo(Date.now() - state.attention.since)}` : ''}`; bar.classList.add('needs-you');
    } else if (state.problem && !state.live) {
      // The run stopped on a provider failure: a red line instead of a calm DONE.
      icon = '✗'; text = `FAILED · ${problemText(state.problem)}`; bar.classList.add('error');
    } else if (activity.kind === 'running') {
      icon = '⚙'; text = `RUNNING  ${activity.label} · ${fmtActivityTime(Date.now() - activity.startedAt)}`; bar.classList.add('running', 'working');
    } else if (activity.kind === 'editing') {
      icon = '✎'; text = `EDITING  ${activity.label} · ${fmtActivityTime(Date.now() - activity.startedAt)}`; bar.classList.add('editing', 'working');
    } else if (activity.kind === 'thinking') {
      icon = '💭'; text = 'THINKING'; bar.classList.add('thinking', 'working');
    } else if (activity.kind === 'replying') {
      icon = '💬'; text = `REPLYING · ${fmtActivityTime(Date.now() - activity.startedAt)}`; bar.classList.add('replying', 'working');
    } else if (activity.kind === 'done') {
      icon = '✓'; text = 'DONE'; bar.classList.add('done');
    } else {
      icon = '⏸'; text = `IDLE · ready · ${fmtAgo(Date.now() - activity.lastEventAt)}`; bar.classList.add('idle');
    }
  }
  if (iconEl) iconEl.textContent = icon;
  if (textEl) {
    if (activity.kind === 'thinking' && !transient && !loading && !attnNeeds(state.attention)) {
      textEl.textContent = '';
      textEl.append(document.createTextNode('THINKING'));
      const dots = document.createElement('span');
      dots.className = 'tdots';
      dots.innerHTML = '<i></i><i></i><i></i>';
      textEl.append(dots, document.createTextNode(` ${Math.max(0, Math.round((Date.now() - activity.startedAt) / 1000))} s`));
    } else {
      textEl.textContent = text.replace(/\s+/g, ' ').trim();
    }
  }
  applyActivityDot();
  updateJobsChip();
  updateRunStatus();
  if (typeof window.stageUpdate === 'function') window.stageUpdate();
}

function updateRunStatus() {
  const el = $('runStatus');
  if (!el) return;
  const running = activity.kind === 'running' && state.live && state.historyDone;
  el.classList.toggle('hidden', !running);
  if (!running) return;
  $('runLabel').textContent = activity.label || 'command';
  $('runElapsed').textContent = fmtActivityTime(Date.now() - activity.startedAt);
  const progress = state.commandProgress;
  const wrap = $('runProgress');
  const fill = wrap && wrap.querySelector('b');
  if (progress && progress.total > 0) {
    wrap.classList.add('on');
    if (fill) fill.style.width = `${Math.min(100, (progress.done / progress.total) * 100)}%`;
  } else {
    wrap.classList.remove('on');
    if (fill) fill.style.width = '0%';
  }
}

function jumpToJob(job) {
  const marker = state.termMarkers.get(job.callId);
  if (marker && !marker.isDisposed) {
    try { term.scrollToLine(Math.max(0, marker.line - 1)); } catch { /* ignore */ }
  } else {
    try { term.scrollToBottom(); } catch { /* ignore */ }
  }
  $('jobsMenu').classList.add('hidden');
}

function updateJobsChip() {
  const btn = $('activityJobs');
  const menu = $('jobsMenu');
  if (!btn || !menu) return;
  const now = Date.now();
  const running = [...state.runningJobs.entries()]
    .map(([jobId, job]) => ({ ...job, jobId, elapsed: now - (job.startedAt || now), state: 'running' }))
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const finished = [...state.finishedJobs.entries()]
    .map(([jobId, job]) => ({ ...job, jobId, elapsed: (job.endedAt || now) - (job.startedAt || now), state: job.ok ? 'finished' : 'failed' }))
    .filter((job) => now - (job.endedAt || 0) < 5 * 60_000)
    .slice(-8)
    .reverse();
  if (!running.length) {
    btn.classList.add('hidden');
    btn.textContent = '';
    menu.classList.add('hidden');
  } else {
    btn.classList.remove('hidden');
    btn.textContent = `${running.length} job${running.length === 1 ? '' : 's'} running`;
  }
  menu.innerHTML = '';
  const addJobRow = (job) => {
    const row = document.createElement('div');
    row.className = 'job';
    row.style.cursor = 'pointer';
    row.title = 'Jump to this job in the console';
    const icon = document.createElement('span');
    if (job.state === 'running') {
      icon.className = 'spinner';
    } else {
      icon.textContent = job.state === 'finished' ? '✓' : '✗';
      icon.style.color = job.state === 'finished' ? 'var(--ok)' : 'var(--red)';
    }
    const label = document.createElement('span');
    label.className = 'lbl';
    label.textContent = job.label || job.jobId || 'job';
    const stateText = document.createElement('span');
    stateText.className = 't';
    stateText.textContent = job.state === 'running'
      ? `running · ${fmtActivityTime(job.elapsed)}`
      : `${job.state} · ${fmtActivityTime(job.elapsed)}`;
    row.append(icon, label, stateText);
    row.addEventListener('click', () => jumpToJob(job));
    menu.appendChild(row);
  };
  for (const job of running) addJobRow(job);
  if (finished.length) {
    const head = document.createElement('div');
    head.className = 'job-head';
    head.textContent = 'finished';
    menu.appendChild(head);
    for (const job of finished) addJobRow(job);
  }
}

const TOOL_ACTIVITY = { read: 'reading a file', write: 'writing a file', edit: 'editing a file', glob: 'searching files', grep: 'searching code', web_fetch: 'fetching a page', web_search: 'searching the web', job_output: 'reading job output', job_kill: 'stopping a job' };

function setActivity(kind, label, pane) {
  const now = Date.now();
  const quiet = !state.historyDone && !state.replaying;
  activity.transient = null;
  if (activity.kind !== kind) activity.startedAt = now;
  activity.kind = kind;
  activity.label = label || '';
  activity.pane = pane || null;
  activity.lastEventAt = now;
  if (quiet) return;
  setActivePane(pane);
  updateActivityBar();
  if (followActive()) followFanout();
}

function touchActivity() {
  activity.lastEventAt = Date.now();
}

function ensureEditorFile() {
  if (state.currentPath || !state.lastEditedPath) return;
  showFile(state.lastEditedPath, fileKeys.get(state.lastEditedPath)).catch(() => {});
}

function followFile(p, key) {
  if (!p) return;
  state.lastEditedPath = p;
  if (!state.historyDone) return;
  if (!state.currentPath || (followActive() && state.currentPath !== p)) {
    showFile(p, key).catch(() => {});
  }
}

for (const id of ['editorWrap', 'terminalPane', 'chatPane', 'sidebar']) {
  const el = $(id);
  if (el) el.addEventListener('pointerdown', () => pauseFollow());
}
setInterval(updateActivityBar, 1000);
$('activityJobs').addEventListener('click', (e) => {
  e.stopPropagation();
  $('jobsMenu').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#activityJobs') && !e.target.closest('#jobsMenu')) $('jobsMenu').classList.add('hidden');
});
window.__activity = {
  state: activity,
  followActive,
  pause: pauseFollow,
  resume() { followPausedUntil = 0; updateActivityBar(); },
};
window.__ui = { get scale() { return uiScale; }, set: applyUiScale };

/* ---------- agent chat ---------- */
const CHAT_WINDOW = 250;
const chat = { pinned: true, unread: 0, items: [], log: [], view: 'chat', window: CHAT_WINDOW };
try { chat.view = localStorage.getItem('agenttail-chat-view') === 'chat' ? 'chat' : 'log'; } catch { /* ignore */ }

function chatEmpty() {
  const log = $('chatLog');
  if (!log || (chat.view === 'log' ? chat.log.length : chat.items.length) || log.querySelector('.chat-empty')) return;
  const d = document.createElement('div');
  d.className = 'chat-empty';
  d.textContent = 'waiting for the agent…';
  log.appendChild(d);
}

function chatReset() {
  chat.items = [];
  chat.log = [];
  chat.unread = 0;
  chat.window = CHAT_WINDOW;
  const log = $('chatLog');
  if (log) log.innerHTML = '';
  chatEmpty();
  updateChatRail();
}

/**
 * Markdown -> DOM for agent messages. Builds nodes directly (never innerHTML),
 * so model text can't inject markup. Covers what agents actually write:
 * headings, lists (nested, ordered), tables, quotes, rules, fenced code and
 * inline bold / italic / strike / code / links.
 */
function renderMarkdown(el, text) {
  el.textContent = '';
  el.classList.add('md');
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  mdBlocks(el, lines);
}

const MD_LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)/;
const MD_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const mdIsTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
const mdIsTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && mdIsTableSep(lines[i + 1]);

function mdStartsBlock(lines, i) {
  const line = lines[i];
  return MD_FENCE.test(line) || MD_HEADING.test(line) || MD_HR.test(line)
    || /^\s*>/.test(line) || MD_LIST.test(line) || mdIsTableStart(lines, i);
}

function mdBlocks(container, lines) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = MD_FENCE.exec(line);
    if (fence) {
      const close = fence[1][0];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${close === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      const pre = document.createElement('pre');
      pre.className = 'md-code';
      if (fence[2]) pre.dataset.lang = fence[2];
      const code = document.createElement('code');
      code.textContent = body.join('\n');
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }

    const heading = MD_HEADING.exec(line);
    if (heading) {
      const h = document.createElement('div');
      h.className = `md-h md-h${heading[1].length}`;
      mdInline(h, heading[2]);
      container.appendChild(h);
      i++;
      continue;
    }

    if (MD_HR.test(line)) {
      const hr = document.createElement('hr');
      hr.className = 'md-hr';
      container.appendChild(hr);
      i++;
      continue;
    }

    if (mdIsTableStart(lines, i)) {
      const table = document.createElement('table');
      table.className = 'md-table';
      const align = mdCells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
      const row = (cells, tag, parent) => {
        const tr = document.createElement('tr');
        cells.forEach((cell, n) => {
          const td = document.createElement(tag);
          if (align[n]) td.style.textAlign = align[n];
          mdInline(td, cell);
          tr.appendChild(td);
        });
        parent.appendChild(tr);
      };
      const thead = document.createElement('thead');
      row(mdCells(lines[i]), 'th', thead);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        row(mdCells(lines[i]), 'td', tbody);
        i++;
      }
      table.appendChild(tbody);
      container.appendChild(table);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const quote = document.createElement('blockquote');
      quote.className = 'md-quote';
      mdBlocks(quote, quoted);
      container.appendChild(quote);
      continue;
    }

    if (MD_LIST.test(line)) {
      i = mdList(container, lines, i);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !mdStartsBlock(lines, i))) {
      para.push(lines[i].trim());
      i++;
    }
    const p = document.createElement('p');
    para.forEach((part, n) => {
      if (n) p.appendChild(document.createElement('br'));
      mdInline(p, part);
    });
    container.appendChild(p);
  }
}

/** One list (and its nested lists); returns the index after it. */
function mdList(container, lines, start) {
  const first = MD_LIST.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = document.createElement(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2], 10) !== 1) list.start = parseInt(first[2], 10);
  let i = start;
  let li = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const next = lines[i + 1];
      const m = next !== undefined ? MD_LIST.exec(next) : null;
      if (m && m[1].length >= indent) { i++; continue; }
      if (next !== undefined && next.trim() && /^\s+/.test(next) && li) { i++; continue; }
      break;
    }
    const m = MD_LIST.exec(line);
    if (m && m[1].length === indent && /\d/.test(m[2]) === ordered) {
      li = document.createElement('li');
      const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
      if (task) {
        li.className = `md-task${task[1] === ' ' ? '' : ' done'}`;
        const box = document.createElement('span');
        box.className = 'md-box';
        box.textContent = task[1] === ' ' ? '☐' : '☑';
        li.appendChild(box);
        mdInline(li, task[2]);
      } else {
        mdInline(li, m[3]);
      }
      list.appendChild(li);
      i++;
      continue;
    }
    if (m && m[1].length > indent && li) {
      i = mdList(li, lines, i);
      continue;
    }
    // A shallower item, or a switch between ordered and unordered, ends it.
    if (m || !li || mdStartsBlock(lines, i) || !/^\s+/.test(line)) break;
    // Indented continuation text of the current item.
    li.appendChild(document.createElement('br'));
    mdInline(li, line.trim());
    i++;
  }
  container.appendChild(list);
  return i;
}

function mdCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const MD_INLINE = /(`+)([\s\S]+?)\1|\*\*(?=\S)([\s\S]+?)\*\*|__(?=\S)([\s\S]+?)__|~~(?=\S)([\s\S]+?)~~|\*(?=[^\s*])([^*]+?)\*|(?<![\w])_(?=[^\s_])([^_]+?)_(?![\w])|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

function mdInline(parent, text) {
  const source = String(text || '');
  let last = 0;
  MD_INLINE.lastIndex = 0;
  for (let m = MD_INLINE.exec(source); m; m = MD_INLINE.exec(source)) {
    if (m.index > last) parent.appendChild(document.createTextNode(source.slice(last, m.index)));
    last = MD_INLINE.lastIndex;
    let node;
    if (m[1]) {
      node = document.createElement('code');
      node.className = 'md-inline';
      node.textContent = m[2].trim() ? m[2].replace(/^ (.*) $/, '$1') : m[2];
    } else if (m[3] !== undefined || m[4] !== undefined) {
      node = document.createElement('strong');
      mdInlineNested(node, m[3] ?? m[4]);
    } else if (m[5] !== undefined) {
      node = document.createElement('del');
      mdInlineNested(node, m[5]);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      node = document.createElement('em');
      mdInlineNested(node, m[6] ?? m[7]);
    } else {
      node = document.createElement('a');
      node.href = m[9];
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
      node.title = m[9];
      mdInlineNested(node, m[8]);
    }
    parent.appendChild(node);
  }
  if (last < source.length) parent.appendChild(document.createTextNode(source.slice(last)));
}

// The inline regex is global and shared, so nested calls save its position.
function mdInlineNested(parent, text) {
  const saved = MD_INLINE.lastIndex;
  mdInline(parent, text);
  MD_INLINE.lastIndex = saved;
}

let logRenderTimer = null;
function scheduleLogRender() {
  if (chat.view !== 'log' || !state.historyDone || state.replaying) return;
  clearTimeout(logRenderTimer);
  logRenderTimer = setTimeout(() => {
    logRenderTimer = null;
    renderChat();
  }, 100);
}

function chatLogPush(item) {
  if (!item) return;
  if (item.kind === 'result' && item.callId) {
    const call = chat.log.find((x) => x.kind === 'tool' && x.callId === item.callId);
    if (call) {
      call.result = item;
      scheduleLogRender();
      return;
    }
  }
  chat.log.push(item);
  if (chat.log.length > 900) chat.log.splice(0, chat.log.length - 900);
  scheduleLogRender();
}

function setChatView(view) {
  chat.view = view === 'log' ? 'log' : 'chat';
  $('chatViewChat').classList.toggle('active', chat.view === 'chat');
  $('chatViewLog').classList.toggle('active', chat.view === 'log');
  try { localStorage.setItem('agenttail-chat-view', chat.view); } catch { /* ignore */ }
  renderChat();
}

$('chatViewChat').addEventListener('click', () => setChatView('chat'));
$('chatViewLog').addEventListener('click', () => setChatView('log'));

function updateChatRail() {
  const unread = $('chatUnread');
  if (unread) {
    unread.textContent = String(chat.unread);
    unread.classList.toggle('hidden', chat.unread === 0 || !layout.chatCollapsed);
  }
  const typing = $('chatTyping');
  if (typing) {
    const busy = state.state === 'live' && Date.now() - (state.stats.lastTime || 0) < 20_000;
    typing.classList.toggle('hidden', !busy);
  }
}

function updateChatPill() {
  updateChatRail();
}

function updatePin() {
  const pin = $('chatPin');
  if (pin) pin.classList.toggle('pinned', chat.pinned);
}

function thinkPreview(text) {
  return mdToText(text).replace(/\s+/g, ' ').trim().slice(0, 80);
}

function groupSummary(calls) {
  const counts = new Map();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) || 0) + 1);
  const parts = [...counts.entries()].map(([name, n]) => `${name} ×${n}`).join(', ');
  return `⚙ ${calls.length} tool call${calls.length === 1 ? '' : 's'} (${parts})`;
}

function chatChip(call) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chat-chip';
  b.title = call.full || call.text || call.name || '';
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = call.name === 'pwsh' ? '$' : '✎';
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = call.name === 'pwsh' ? call.text : `${call.name} ${call.text}`;
  b.append(k, t);
  b.addEventListener('click', () => chatJump(call));
  return b;
}

function chatGroupEl(group) {
  const el = document.createElement('details');
  el.className = 'chat-tools';
  const sum = document.createElement('summary');
  sum.textContent = groupSummary(group.calls);
  sum.title = group.calls.map((c) => `${c.name}: ${c.full || c.text}`).join('\n').slice(0, 1200);
  const list = document.createElement('div');
  list.className = 'chat-tool-list';
  for (const call of group.calls) list.appendChild(chatChip(call));
  el.append(sum, list);
  group.el = el;
  group.summary = sum;
  group.list = list;
  return el;
}

function closeStreamingThinking() {
  for (const item of chat.items) {
    if (item.kind === 'think' && item.streamOpen) {
      item.streamOpen = false;
      if (item.el) item.el.open = false;
    }
  }
}

function chatStreamText(el, text, stream) {
  if (!text) {
    el.textContent = '';
    return;
  }
  if (!stream || layout.chatCollapsed || document.hidden) {
    el.textContent = text;
    return;
  }
  let i = 0;
  el.textContent = '…';
  const tick = () => {
    if (!el.isConnected) return;
    i = Math.min(text.length, i + 8);
    el.textContent = text.slice(0, i);
    if (i < text.length) setTimeout(tick, 30);
  };
  setTimeout(tick, 30);
}

function chatAppend(item) {
  const log = $('chatLog');
  if (!log) return;
  if (item.kind === 'system' && !fx.sys) return;
  log.querySelector('.chat-empty')?.remove();
  let el;
  if (item.kind === 'think') {
    el = document.createElement('details');
    el.className = 'chat-think';
    const sum = document.createElement('summary');
    sum.textContent = `thinking · ${thinkPreview(item.text)}`;
    el.appendChild(sum);
    const body = document.createElement('div');
    el.appendChild(body);
    item.el = el;
    item.summary = sum;
    item.body = body;
    if (item.streamOpen) el.open = true;
    chatStreamText(body, item.text || '', !!item.stream);
  } else if (item.kind === 'group') {
    el = chatGroupEl(item);
  } else if (item.kind === 'chip' || item.kind === 'tool') {
    el = chatChip(item);
  } else if (item.kind === 'system') {
    el = document.createElement('div');
    el.className = 'chat-sys';
    el.textContent = item.label || '⟐ system';
    el.title = mdToText(item.text || '').slice(0, 800);
    item.el = el;
  } else if (item.kind === 'problem') {
    el = document.createElement('div');
    el.className = 'chat-problem';
    el.textContent = `✗ ${item.text}`;
    item.el = el;
  } else if (item.kind === 'divider') {
    el = dividerRow(item);
    item.el = el;
  } else {
    el = document.createElement('div');
    const tag = item.kind === 'user' ? originTag(item.origin) : null;
    // A prompt someone else wrote is not styled as yours.
    el.className = `chat-msg ${item.kind}${tag && item.origin !== 'queued' ? ' from-other' : ''}`;
    // Only label what is not obvious: your turns, other writers and sub-agents.
    if (item.kind === 'user' || item.agent) {
      const who = document.createElement('span');
      who.className = 'who';
      const you = tag ? (item.origin === 'queued' ? `you · ${tag}` : tag) : 'you';
      who.textContent = item.kind === 'user' ? `${you}${item.agent ? ' · ' + item.agent : ''}` : `↳ ${item.agent}`;
      el.appendChild(who);
    }
    if (item.thought) el.appendChild(thoughtToggle(item.thought));
    const body = document.createElement('div');
    body.className = 'msg-body';
    renderMarkdown(body, item.text || '');
    el.appendChild(body);
  }
  log.appendChild(el);
  if (followActive() || chat.pinned) log.scrollTop = log.scrollHeight;
}

/** A thin line across the conversation: the context was compacted, a reply was cut short. */
function dividerRow(item) {
  const el = document.createElement('div');
  el.className = 'chat-divider';
  const label = document.createElement('span');
  label.textContent = item.text || '';
  el.appendChild(label);
  return el;
}

/** A collapsed "reasoning" toggle inside a reply. */
function thoughtToggle(text) {
  const details = document.createElement('details');
  details.className = 'msg-thought';
  const sum = document.createElement('summary');
  sum.textContent = `💭 reasoning · ${thinkPreview(text)}`;
  details.appendChild(sum);
  const body = document.createElement('div');
  renderMarkdown(body, text);
  details.appendChild(body);
  return details;
}

function chatPush(item) {
  if (!item) return;
  const quiet = !state.historyDone && !state.replaying;
  // A reply takes in the reasoning that led to it: one row instead of two.
  if (item.kind === 'agent') {
    const last = chat.items[chat.items.length - 1];
    if (last && last.kind === 'think' && (last.agent || null) === (item.agent || null)) {
      chat.items.pop();
      item.thought = last.text;
      if (last.el) last.el.remove();
    }
  }
  if (item.kind === 'think') {
    const text = String(item.text || '').trim();
    if (!text) return;
    item.text = text;
    item.stream = !!state.live;
    chatLogPush({ kind: 'think', text, agent: item.agent });
    const last = chat.items[chat.items.length - 1];
    if (last && last.kind === 'think') {
      last.text += `\n\n${text}`;
      last.stream = item.stream;
      if (item.stream) last.streamOpen = true;
      if (last.summary) last.summary.textContent = `thinking · ${thinkPreview(last.text)}`;
      if (last.body) last.body.textContent = last.text;
      if (last.el && last.streamOpen) last.el.open = true;
      updateChatRail();
      return;
    }
    item.streamOpen = item.stream;
    chat.items.push(item);
    if (!quiet && chat.view === 'chat' && !layout.chatCollapsed) { chatAppend(item); trimChatDom(); }
    if (!quiet) updateChatRail();
    return;
  }

  if (item.kind === 'chip' || item.kind === 'tool') {
    const call = { name: item.name || 'tool', text: item.text || '', full: item.full, path: item.path, key: item.key, callId: item.callId };
    if (!String(call.full || call.text || '').trim()) return;
    let idx = chat.items.length - 1;
    while (idx >= 0 && chat.items[idx].kind === 'think') idx--;
    const prev = idx >= 0 ? chat.items[idx] : null;
    if (prev && prev.kind === 'group') {
      prev.calls.push(call);
      if (prev.summary) prev.summary.textContent = groupSummary(prev.calls);
      if (prev.summary) prev.summary.title = prev.calls.map((c) => `${c.name}: ${c.full || c.text}`).join('\n').slice(0, 1200);
      if (prev.list) prev.list.appendChild(chatChip(call));
      updateChatRail();
      return;
    }
    const group = { kind: 'group', calls: [call] };
    chat.items.push(group);
    if (!quiet && chat.view === 'chat' && !layout.chatCollapsed) chatAppend(group);
    if (!quiet) updateChatRail();
    return;
  }

  closeStreamingThinking();
  if ((item.kind === 'agent' || item.kind === 'user') && !String(item.text || '').trim()) return;
  item.stream = !!state.historyDone && !state.replaying;
  if (!item.chatOnly) chatLogPush({ ...item });
  chat.items.push(item);
  if (chat.items.length > 400) {
    chat.items.splice(0, chat.items.length - 400);
    if (!layout.chatCollapsed) {
      const log = $('chatLog');
      const first = log.querySelector('.chat-msg, .chat-think, .chat-tools, .chat-sys, .chat-problem, .chat-divider');
      if (first) first.remove();
    }
  }
  if (!quiet && chat.view === 'chat' && !layout.chatCollapsed) { chatAppend(item); trimChatDom(); }
  else if (item.kind === 'agent' || item.kind === 'user') chat.unread += 1;
  if (!quiet) updateChatRail();
}

function renderChat() {
  const log = $('chatLog');
  if (!log) return;
  log.innerHTML = '';
  if (chat.view === 'log') {
    renderLog();
    return;
  }
  const visible = chat.items.filter((item) => item.kind !== 'system' || fx.sys);
  if (!visible.length) {
    chatEmpty();
    return;
  }
  const start = Math.max(0, visible.length - chat.window);
  if (start > 0) log.appendChild(earlierRow(start));
  for (let i = start; i < visible.length; i++) chatAppend(visible[i]);
  if (followActive() || chat.pinned) log.scrollTop = log.scrollHeight;
}

/**
 * Long sessions render only their latest rows; this row loads more. It keeps
 * the page responsive after hundreds of tool calls.
 */
function earlierRow(hidden) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'chat-earlier';
  row.textContent = `▲ show ${Math.min(CHAT_WINDOW, hidden)} earlier (${hidden} hidden)`;
  row.addEventListener('click', () => {
    const log = $('chatLog');
    const fromBottom = log.scrollHeight - log.scrollTop;
    chat.window += CHAT_WINDOW;
    renderChat();
    log.scrollTop = log.scrollHeight - fromBottom;
  });
  return row;
}

/** Live appends in the Chat view keep the DOM to the window, too. */
function trimChatDom() {
  const log = $('chatLog');
  if (!log || chat.view !== 'chat') return;
  const rows = [...log.children].filter((el) => !el.classList.contains('chat-earlier'));
  const extra = rows.length - chat.window;
  if (extra < 25) return;
  for (const el of rows.slice(0, extra)) el.remove();
  const visible = chat.items.filter((item) => item.kind !== 'system' || fx.sys).length;
  log.querySelector('.chat-earlier')?.remove();
  log.insertBefore(earlierRow(Math.max(0, visible - chat.window)), log.firstChild);
}

/**
 * One line per tool result: what happened, not the raw payload. Reads report
 * their size, searches their hits, edits that they applied; commands keep the
 * exit code and the first line of output. The full text stays in the tooltip.
 */
function logResultLine(result, name) {
  if (!result) return '';
  const raw = String(result.text || '');
  // Tool payloads often come wrapped in tags (<path>, <content>, …).
  const plain = raw.replace(/<\/?[a-z_][\w-]*>/gi, ' ');
  const lines = plain.split('\n').filter((l) => l.trim() && !/^\[exit code:/i.test(l.trim()));
  const first = (lines[0] || '').replace(/\s+/g, ' ').trim();
  const status = result.exitCode !== undefined && result.exitCode !== null
    ? `exit ${result.exitCode}`
    : (result.isError ? 'error' : 'done');
  const tool = String(name || '').toLowerCase();
  let detail;
  if (result.isError) detail = first;
  else if (tool === 'read' || tool === 'view_file') detail = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
  else if (['grep', 'glob', 'search', 'find'].includes(tool)) {
    const found = /found\s+(\d+)\s+(match|file|result)/i.exec(plain);
    detail = found ? `${found[1]} ${found[2]}${found[1] === '1' ? '' : (found[2].endsWith('h') ? 'es' : 's')}` : `${lines.length} hit${lines.length === 1 ? '' : 's'}`;
  } else if (EDIT_TOOLS.has(tool)) detail = 'applied';
  else detail = first;
  return `${status}${detail ? ' · ' + detail.slice(0, 160) : ''}`;
}

function renderLog() {
  const log = $('chatLog');
  if (!log) return;
  const items = chat.log.filter((item) => item.kind !== 'system' || fx.sys);
  if (!items.length) {
    chatEmpty();
    return;
  }
  const start = Math.max(0, items.length - chat.window);
  if (start > 0) log.appendChild(earlierRow(start));
  for (let i = start; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'system') {
      const el = document.createElement('div');
      el.className = 'chat-sys';
      el.textContent = item.label || '⟐ system';
      el.title = mdToText(item.text || '').slice(0, 800);
      log.appendChild(el);
      continue;
    }
    if (item.kind === 'think') {
      const next = items[i + 1];
      if (next && next.kind === 'agent' && (next.agent || null) === (item.agent || null)) {
        next.__thought = item.text;
        continue;
      }
      const details = document.createElement('details');
      details.className = 'chat-think';
      const sum = document.createElement('summary');
      sum.textContent = `thinking · ${thinkPreview(item.text)}`;
      details.appendChild(sum);
      const body = document.createElement('div');
      renderMarkdown(body, item.text || '');
      details.appendChild(body);
      log.appendChild(details);
      continue;
    }
    if (item.kind === 'tool') {
      const row = document.createElement('div');
      row.className = `log-row log-tool${item.result && item.result.isError ? ' err' : ''}`;
      const cmd = document.createElement('div');
      cmd.className = 'cmd';
      const glyph = item.name === 'pwsh' ? '$'
        : EDIT_TOOLS.has(item.name) ? '✎'
          : item.name === 'read' ? '👁'
            : ['grep', 'glob', 'search', 'find'].includes(String(item.name).toLowerCase()) ? '⌕' : '⚙';
      cmd.textContent = `${glyph} ${item.full || item.text}`;
      row.appendChild(cmd);
      const res = document.createElement('div');
      res.className = 'res';
      res.textContent = item.result ? logResultLine(item.result, item.name) : 'running…';
      if (item.result && item.result.text) res.title = String(item.result.text).slice(0, 2000);
      row.appendChild(res);
      log.appendChild(row);
      continue;
    }
    if (item.kind === 'result') {
      const row = document.createElement('div');
      row.className = 'log-row log-sys';
      row.textContent = logResultLine(item);
      log.appendChild(row);
      continue;
    }
    if (item.kind === 'turn') {
      log.appendChild(turnRow(item));
      continue;
    }
    if (item.kind === 'meta') {
      const row = document.createElement('div');
      row.className = 'log-row log-sys';
      row.textContent = item.text || '';
      log.appendChild(row);
      continue;
    }
    if (item.kind === 'problem') {
      const row = document.createElement('div');
      row.className = 'log-row log-problem';
      row.textContent = `✗ ${item.text}`;
      log.appendChild(row);
      continue;
    }
    if (item.kind === 'divider') {
      log.appendChild(dividerRow(item));
      continue;
    }
    const row = document.createElement('div');
    row.className = `log-row ${item.kind === 'user' ? 'log-user' : 'log-say'}`;
    renderMarkdown(row, item.text || '');
    const tag = item.kind === 'user' ? originTag(item.origin) : null;
    if (tag) {
      const label = document.createElement('span');
      label.className = 'log-origin';
      label.textContent = tag;
      row.insertBefore(label, row.firstChild);
    }
    if (item.__thought) {
      row.insertBefore(thoughtToggle(item.__thought), row.firstChild);
      delete item.__thought;
    }
    log.appendChild(row);
  }
  if (followActive() || chat.pinned) log.scrollTop = log.scrollHeight;
}

/** One turn's summary: what the agent did, what it changed, what failed. */
function turnRow(item) {
  const row = document.createElement('div');
  row.className = 'log-turn';
  const part = (text, cls) => {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    row.appendChild(span);
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  part(`TURN ${item.turn}`, 'lt-n');
  if (item.model) part(item.model, 'lt-model');
  part(plural(item.steps, 'step'));
  if (item.tools) {
    const kinds = [];
    if (item.commands) kinds.push(`$ ${item.commands}`);
    if (item.edits) kinds.push(`✎ ${item.edits}`);
    if (item.reads) kinds.push(`👁 ${item.reads}`);
    const other = item.tools - item.commands - item.edits - item.reads;
    if (other > 0) kinds.push(`⚙ ${other}`);
    part(`${plural(item.tools, 'tool')}${kinds.length ? ' (' + kinds.join(' · ') + ')' : ''}`);
  }
  const files = item.files ? item.files.size : 0;
  if (files) part(plural(files, 'file') + ' changed', 'lt-files');
  if (item.errors) part(plural(item.errors, 'failure'), 'lt-err');
  if (item.cutShort) part('cut short (max tokens)', 'lt-err');
  part(`${fmtInt(tokenTotal(item.usage))} tokens`);
  if (item.cost > 0) part(`$${item.cost.toFixed(4)}`);
  part(item.startedAt && item.endedAt ? fmtActivityTime(item.endedAt - item.startedAt) : 'running', item.endedAt ? '' : 'lt-run');
  const lines = [`Turn ${item.turn}`];
  if (item.files && item.files.size) lines.push('', 'Files changed:', ...[...item.files].slice(0, 20).map((f) => `  ${f}`));
  row.title = lines.join('\n');
  return row;
}

function exportToolLine(tool) {
  const name = tool.name || 'tool';
  const full = String(tool.full || tool.text || '').replace(/\s+/g, ' ').trim();
  let label;
  if (name === 'pwsh') label = `$ ${full}`;
  else if (EDIT_TOOLS.has(name)) label = `✎ ${tool.path || full || name}`;
  else if (tool.path) label = `${name} ${tool.path}`;
  else label = name;
  const result = tool.result;
  let status = 'running';
  if (result) {
    if (result.exitCode !== null && result.exitCode !== undefined) status = `exit ${result.exitCode}${result.isError ? ' (error)' : ''}`;
    else if (result.isError) {
      const detail = String(result.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      status = detail ? `error: ${detail}` : 'error';
    } else status = 'done';
  }
  return `- ${label} — ${status}`;
}

function exportTurnSummary(item, index) {
  const number = item && item.turn !== undefined && item.turn !== null ? item.turn : index + 1;
  if (!item) return `TURN ${number}`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [`TURN ${number}`];
  if (item.model) parts.push(item.model);
  parts.push(plural(item.steps || 0, 'step'));
  if (item.tools) {
    const kinds = [];
    if (item.commands) kinds.push(`$ ${item.commands}`);
    if (item.edits) kinds.push(`✎ ${item.edits}`);
    if (item.reads) kinds.push(`👁 ${item.reads}`);
    const other = item.tools - item.commands - item.edits - item.reads;
    if (other > 0) kinds.push(`⚙ ${other}`);
    parts.push(`${plural(item.tools, 'tool')}${kinds.length ? ' (' + kinds.join(' · ') + ')' : ''}`);
  }
  const files = item.files ? item.files.size : 0;
  if (files) parts.push(`${plural(files, 'file')} changed`);
  if (item.errors) parts.push(plural(item.errors, 'failure'));
  parts.push(`${tokenTotal(item.usage)} tokens`);
  const turnCost = Number(item.cost) || 0;
  if (turnCost > 0) parts.push(`$${turnCost.toFixed(4)}`);
  parts.push(item.startedAt && item.endedAt ? fmtActivityTime(item.endedAt - item.startedAt) : 'running');
  return parts.join(' · ');
}

function exportMarkdown() {
  const session = state.session || {};
  const stats = state.stats || {};
  const id = state.sessionId || session.id || '';
  const title = String(session.title || id || 'agenttail session').replace(/\s+/g, ' ').trim() || 'agenttail session';
  const source = state.source || session.source || 'dsh';
  const provider = (state.route && state.route.provider) || session.provider || '';
  const model = (state.route && state.route.model) || session.model || '';
  const preset = state.preset || session.preset || '';
  const input = Number(stats.input) || 0;
  const output = Number(stats.output) || 0;
  const cacheRead = Number(stats.cacheRead) || 0;
  const cacheWrite = Number(stats.cacheWrite) || 0;
  const totalTokens = input + output + cacheRead + cacheWrite;
  const cost = Number(stats.cost) || 0;
  const out = [];
  out.push(`# ${title}`, '');
  out.push(`- Session ID: ${id || '—'}`);
  out.push(`- Source: ${source}`);
  out.push(`- Model: ${model ? `${provider ? provider + '/' : ''}${model}` : '—'}`);
  out.push(`- Permission preset: ${preset || '—'}`);
  out.push(`- Steps: ${Number(stats.steps) || 0}`);
  out.push(`- Tokens: ${totalTokens}${totalTokens ? ` (input ${input} · output ${output} · cache read ${cacheRead} · cache write ${cacheWrite})` : ''}`);
  out.push(`- Cost: $${cost.toFixed(4)}`);
  out.push('');

  const turns = [];
  let current = null;
  const pending = [];
  const addBlock = (turn, item) => {
    if (item.kind === 'user' || item.kind === 'agent') {
      const text = String(item.text || '');
      if (text.trim()) turn.blocks.push(`**${item.kind === 'user' ? 'User' : 'Agent'}**\n\n${text}`);
      return;
    }
    if (item.kind === 'tool') turn.blocks.push(exportToolLine(item));
    if (item.kind === 'problem') turn.blocks.push(`> ✗ ${item.text}`);
  };

  for (const item of chat.log) {
    if (!item) continue;
    if (item.kind === 'turn') {
      current = { item, blocks: [] };
      turns.push(current);
      for (const early of pending) addBlock(current, early);
      pending.length = 0;
      continue;
    }
    if (!['user', 'agent', 'tool'].includes(item.kind)) continue;
    if (current) addBlock(current, item);
    else pending.push(item);
  }
  if (!turns.length && pending.length) {
    current = { item: null, blocks: [] };
    turns.push(current);
    for (const early of pending) addBlock(current, early);
  }
  if (!turns.length) {
    out.push('_No turns recorded yet._');
    return out.join('\n').replace(/\n+$/, '\n');
  }

  turns.forEach((turn, index) => {
    const number = turn.item && turn.item.turn !== undefined && turn.item.turn !== null ? turn.item.turn : index + 1;
    out.push(`## Turn ${number}`, '');
    for (const block of turn.blocks) out.push(block, '');
    out.push(`**Turn summary:** ${exportTurnSummary(turn.item, index)}`, '');
  });
  return out.join('\n').replace(/\n+$/, '\n');
}

function downloadMarkdown() {
  const markdown = exportMarkdown();
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `agenttail-${shortId(state.sessionId || state.session?.id) || 'session'}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function chatJump(item) {
  const marker = state.termMarkers.get(item.callId);
  if (marker && !marker.isDisposed) {
    try { term.scrollToLine(Math.max(0, marker.line - 2)); } catch { /* ignore */ }
  }
  if (item.path) showFile(item.path, item.key);
}

$('chatExport').addEventListener('click', downloadMarkdown);
$('chatLog').addEventListener('scroll', () => {
  const log = $('chatLog');
  // Stick to the newest row while the reader is at the bottom.
  chat.pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 12;
});

applyUiScale(uiScale, false);
applyLayout();
updatePin();
updateChatRail();
$('chatViewChat').classList.toggle('active', chat.view === 'chat');
$('chatViewLog').classList.toggle('active', chat.view === 'log');
chatEmpty();
window.__chat = { state: chat, layout, setOpen: setChatOpen, reset: chatReset, closeThinking: closeStreamingThinking };
window.__exportMarkdown = exportMarkdown;
window.__layout = {
  state: layout,
  apply: applyLayout,
  save: saveLayout,
  toggleTree,
  toggleChat,
  toggleBottom,
  toggleChatSide,
  setBottom(h) { layout.bottomH = h; applyLayout(); saveLayout(); },
  setChat(w) { layout.chatW = w; applyLayout(); saveLayout(); },
};


applyTheme(currentTheme, false);
applyFx(false);
runBoot();

/* ---------- start ---------- */
initMonaco().then(async () => {
  state.source = parseHash().source || 'dsh';
  await loadSources();
  loadSessions(true);
});

if (window.ResizeObserver) {
  const termObserver = new ResizeObserver(() => ensureTermFit());
termObserver.observe($('terminalPane'));
termObserver.observe($('term'));
}
