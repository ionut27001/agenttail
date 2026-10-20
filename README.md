<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="docs/logo-light.svg">
    <img src="docs/logo.svg" width="96" height="96" alt="agenttail logo">
  </picture>
</p>

<h1 align="center">agenttail</h1>

<p align="center"><b>tail -f for AI coding agents</b> — one live, read-only dashboard for DeepSeek Harness, Claude Code and Antigravity sessions.</p>

<p align="center">
  <a href="https://github.com/ionut27001/agenttail/releases"><img alt="release" src="https://img.shields.io/badge/release-v0.1.0-37f28a.svg"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-37f28a.svg"></a>
  <a href="https://nodejs.org/"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D24-339933.svg"></a>
  <a href="#quick-start"><img alt="platform" src="https://img.shields.io/badge/platform-Windows%20tested-0078D6.svg"></a>
  <a href="#security-and-privacy"><img alt="no telemetry" src="https://img.shields.io/badge/telemetry-none-37f28a.svg"></a>
</p>

<p align="center">
  <a href="#quick-start">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#stream-mode">Stream mode</a> ·
  <a href="#security-and-privacy">Security</a>
</p>

<p align="center">
  <img src="docs/hero.gif" width="100%" alt="agenttail dashboard: editor typing, console, agent chat and activity bar">
</p>

agenttail follows the session logs your coding agent already writes and turns them into one calm dashboard: the file being edited, the command being run, the agent chat, and the activity state — live. It never writes to your agent's session store, workspace or transcripts.

> [!NOTE]
> Read-only, localhost only, no telemetry. agenttail is an independent project, not affiliated with DeepSeek, Anthropic or Google.

## What it is

A zero-runtime-dependency Node 24 server plus a single-page UI. It reads local logs, normalizes them into one event shape, streams them over SSE, and renders the result on `127.0.0.1`. Stream mode redacts secrets and identity before anything reaches the browser.

## Supported sources

| Source | | Logs read from | Shown |
| --- | --- | --- | --- |
| DeepSeek Harness | ✓ | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | edits, commands, background jobs, thinking, tool calls, tokens/cost |
| Claude Code | ✓ | `~/.claude/projects/**/*.jsonl` | messages, thinking, tool calls, subagents, custom titles |
| Antigravity CLI | ◐ | `~/.gemini/antigravity/**` | normalized messages, thinking, tool calls and file edits |

✓ full adapter · ◐ normalized/partial. Only sessions whose logs exist locally are listed; empty sessions are hidden behind a picker toggle.

<details>
<summary><b>Source adapter details</b></summary>

- **DeepSeek Harness** reads `session.v4.jsonl.zstd` frames from `~/.dsh/sessions`, decodes them with Node's built-in zlib and understands edits, commands, background jobs, thinking and token/cost usage. The title prefers the local nickname, then a real `session/title` (fallback titles derived from the first prompt are ignored), then the last real user message (first 60 characters), then the first prompt.
- **Claude Code** reads `~/.claude/projects` transcripts, including custom titles, thinking blocks, tool calls, subagents and pending live writes.
- **Antigravity CLI** reads `~/.gemini/antigravity` conversations and normalizes messages, thinking, tool calls and file edits.
- Sessions sort live first, then by last activity. The header shows only the short id; the picker carries the full title and details. Nicknames live in `nicknames.json` in the config directory (never in `.dsh`) and are redacted like every other label.

</details>

## Quick start

1. **Get agenttail.** Download the Windows exe from [Releases](https://github.com/ionut27001/agenttail/releases), or run:

   ```bash
   npx agenttail
   ```

   From a clone instead:

   ```bash
   npm install
   npm start
   ```

2. **Open [http://127.0.0.1:8787](http://127.0.0.1:8787).** The server opens the browser for you; pass `--no-open` to disable that. `PORT=9000` changes the port.

3. **Pick a session.** The latest sessions are sorted first; empty ones are behind a picker toggle.

Requirements: Node 24+, Windows, macOS or Linux. Windows is the tested platform; see [Limits](#limits).

## Features

- ✍️ **Live editor typing** — follows the file the agent is editing and types edits in place with a short highlight sweep.
- 🌡️ **Edit heat** — the tree tracks edits, failures and deleted files; hover reports `N edits · last … · M failed`. `.tmp`, `_*`, `node_modules`, `.git` and build directories are hidden unless **show hidden files** is enabled.
- ⌨️ **Console and job progress** — running spinner, elapsed time, collapsible multi-line commands, `(+N lines)` outputs, a live job bar and a `[n/N]` mini progress bar. Failed commands flash red and show `✗ COMMAND FAILED` for three seconds.
- 💬 **Chat and Log** — Chat groups tool calls and thinking for reading; Log is the full trajectory for auditing.
- ◉ **One activity state** — RUNNING, EDITING, THINKING, REPLYING, IDLE or DONE, with a colour-coded stripe and dot; a settled job shows a checkmark briefly, then returns to the current state.
- 📊 **Meters and layout** — CPU, RAM, GPU, steps, tokens, throughput and estimated cost; dockable console/chat, collapsible rails and 90/100/115/130% UI scale (115% on wide fresh profiles).
- ⏪ **Replay** — finished sessions replay through the same pipeline, typing animation included, at a chosen speed.
- 🔒 **Stream mode** — server-side redaction with fail-closed behaviour; add your own rules in `redact.json`.

<table>
  <tr>
    <td width="50%" align="center">
      <a href="docs/screenshot-dark.png"><img src="docs/screenshot-dark.png" width="400" alt="Full dashboard"></a><br>
      <sub>Full layout: editor, console, chat and activity bar.</sub>
    </td>
    <td width="50%" align="center">
      <a href="docs/chat-log.png"><img src="docs/chat-log.png" width="400" alt="Chat Log view"></a><br>
      <sub>Log view: the complete agent trajectory.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <a href="docs/stream-mode.png"><img src="docs/stream-mode.png" width="400" alt="Stream mode redaction"></a><br>
      <sub>Stream mode: secrets and identity redacted server-side.</sub>
    </td>
    <td width="50%" align="center">
      <a href="docs/loading.png"><img src="docs/loading.png" width="400" alt="Loading skeleton"></a><br>
      <sub>Loading: skeleton rows and a determinate history bar.</sub>
    </td>
  </tr>
</table>

<details>
<summary><b>Live states, follow mode and layout details</b></summary>

**Live state** is derived from the log, never mtime alone. The server polls file size and the timestamp of the last event; size growth counts as activity.

- **● live** (green, pulsing) — an open turn or step. Background jobs alone never make a session live.
- **◐ idle** (amber) — the last turn/step ended under 10 minutes ago, **or** a detached background job is still open. The background case reads `IDLE · BG`, and the tooltip/job bar names the job.
- **○ finished** — everything else.

Downgrades require two consecutive polls to agree; upgrades apply immediately. The dot's tooltip explains `step 1 running, last event …`, `background job pwsh-…, 12 min` or `idle since …`. The picker and status stream use the same state.

**Follow mode** is on by default: the editor opens the file being edited (and the last edited file when idle), the console scrolls, and the chat stays at the newest event. A manual click pauses follow for 30 seconds and shows `FOLLOW PAUSED`; the editor never shows “SELECT A FILE TO INSPECT” while the session has edits. The active pane gets a green glow and a `● active` tag.

**Layout:** console/chat are docked at about 55/45 (console default) and 28% of the window tall; the chat keeps at least 420 px. Drag the horizontal splitter for bottom height (double-click restores/minimizes) and the vertical splitter for the ratio. The tree collapses to a 28 px rail with a touched-file badge; the chat rail shows unread count and a thinking indicator. Sizes and collapsed states persist in `localStorage`. Below 1000 px a fresh profile starts with tree and chat collapsed.

**Readability:** header text is at least 13 px, uppercase labels 11 px, values 14–15 px, panel titles 11 px and CPU/RAM/GPU bars 48 px wide. UI scale is 90/100/115/130%; a fresh wide (>1600 px) profile starts at 115%.

**Background jobs** show a running bar driven by `job/registered`/`job/settled`, surviving reconnects. Redirected logs are tailed while they run (last 2 KiB first, then new lines); UTF-16LE PowerShell output is decoded. Jobs without a redirect still show the start line, bar and final result.

**Replay** turns on for finished sessions: it resets editor/tree/console and re-runs the whole event stream through the same pipeline, typing included, paced by the speed slider. Live sessions cannot be replayed.

</details>

<details>
<summary><b>Chat, system meters and visual effects</b></summary>

**Agent chat** is the docked right pane: agent messages in full contrast, fenced code as monospace blocks, user turns, thinking rows, and grouped tool calls. **Chat** groups tool calls/thinking for reading; **Log** is the complete trajectory. System injections are hidden by default; the pane has a pin toggle and keeps a 420 px minimum. Empty bars are never rendered.

**System meters** show CPU, RAM and GPU alongside steps, tokens, throughput and estimated cost. CPU/RAM are sampled from `os.cpus()` deltas every 2 s; GPU uses one long-lived `nvidia-smi` process, started on the first SSE client and stopped on the last or on dispose. Without `nvidia-smi` the GPU meter shows `n/a` and everything else keeps working.

**Visual effects** in the `⋯` menu: replay speed, effect intensity, boot sequence, matrix rain, spark line, cursor, glitch, heat, follow mode, show system and **show hidden files**.

</details>

## Stream mode

> [!WARNING]
> Redaction reduces risk; it is not a guarantee. Review the stream before sharing, streaming or recording it.

Stream mode is **on by default**. Redaction happens on the server before anything is sent to the browser or written by the file API.

- **Secrets**: provider API keys, GitHub tokens, AWS keys, bearer tokens, JWTs, private-key blocks, URL credentials and token/password query parameters.
- **Identity**: emails, Windows usernames in user paths, computer/user environment values, SIDs.
- **Environment output**: `env`/`printenv`/`set` dumps keep variable names but lose their values.
- **Network**: IPv4/IPv6 addresses (including IPs inside URLs, with ports preserved), MAC addresses, PlayStation-style hostnames and `SSID:` values.
- **Opaque identifiers**: UUIDs, call/tool/message/request ids and `pwsh-…` job ids in log text.
- **Private roots and release names**: configured paths and scene-style release archives.

Replacement is length-preserving (`▓`) where possible. If redaction throws, the event is **dropped** (`fail closed`); it is never sent raw. Add literals or regexes in `redact.json`, then verify the result before sharing anything.

## Security and privacy

- **Read-only.** Session logs, transcripts and workspace files are only read. The only writes are local nicknames and optional config files in the per-user config directory.
- **Localhost only.** The server binds to `127.0.0.1`; there is no remote listener and no authentication.
- **DNS rebinding blocked.** Every request must carry `Host: 127.0.0.1:<port>` or `Host: localhost:<port>`, otherwise `403`.
- **CSRF blocked.** POST requests require an `Origin` matching the exact Host and `Content-Type: application/json`, otherwise `403` before the body is read.
- **No telemetry.** agenttail collects no analytics, crash reports or usage data.
- **No external requests.** Monaco, xterm.js and JetBrains Mono are vendored under `public/vendor/` with their licenses. The page loads no CDN and works offline.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and the full privacy statement.

<details>
<summary><b>Configuration and environment variables</b></summary>

Configuration lives in a per-user directory, never in the repo:

| Platform | Config directory |
| --- | --- |
| Windows | `%APPDATA%\agenttail\` |
| macOS / Linux | `~/.config/agenttail/` (or `$XDG_CONFIG_HOME/agenttail/`) |

Files: `roots.json`, `redact.json` and `nicknames.json`. Copy [roots.example.json](roots.example.json) and [redact.example.json](redact.example.json) there to start.

`roots.json` is the read-only allowlist for extra workspaces and the tree ignore list:

```json
{
  "roots": [{ "path": "/path/to/another-project", "as": "example" }],
  "privateRoots": [],
  "ignore": [".git", ".tmp", "node_modules", "build", "build-*", "_*"]
}
```

The session workspace is always allowed. Junctions/symlinks are followed only when their real target is an allowed root; otherwise they are listed but not expanded. `as` maps an allowed root back into the workspace tree, and `..`, unrelated absolute paths, UNC paths and symlink escapes get `403`. Tree nodes carry an opaque key so redacted display names still open files. Paths the session touched are injected even when the breadth-first walk hits its node/depth budget. `ignore` supports exact names and `*` suffix prefix matching; **show hidden files** in the `⋯` menu re-fetches the tree.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port, bound to `127.0.0.1` |
| `AGENTTAIL_CONFIG_DIR` | per-user dir above | Configuration location |
| `AGENTTAIL_ROOTS_FILE` | `<config>/roots.json` | Allowlisted roots and ignore list |
| `AGENTTAIL_REDACT_FILE` | `<config>/redact.json` | Extra redaction literals/patterns |
| `AGENTTAIL_NICKNAMES_FILE` | `<config>/nicknames.json` | Local display nicknames |
| `AGENTTAIL_POLL_MS` | `700` | Log poll interval |
| `AGENTTAIL_STREAM_MODE` | `on` | Set `off` to disable redaction (not recommended) |
| `DSH_SESSIONS_ROOT` | `~/.dsh/sessions` | DeepSeek Harness session root |
| `CLAUDE_PROJECTS_ROOT` | `~/.claude/projects` | Claude Code transcripts |
| `ANTIGRAVITY_ROOT` | `~/.gemini/antigravity` | Antigravity transcripts |
| `AGENTTAIL_NO_OPEN` | unset | Set `1` to skip opening the browser |

`--no-open` and `--no-stream-mode` are accepted on the command line.

</details>

<details>
<summary><b>Keyboard shortcuts</b></summary>

| Shortcut | Action |
| --- | --- |
| `Ctrl+B` | collapse/expand the workspace tree |
| `Ctrl+J` | collapse/expand the bottom area |
| `Ctrl+.` | collapse/expand the agent chat |

</details>

<details>
<summary><b>How it works</b></summary>

```mermaid
flowchart LR
  A[DeepSeek Harness logs] --> D[Adapters]
  B[Claude Code transcripts] --> D
  C[Antigravity transcripts] --> D
  D --> E[Normalized events]
  E --> F[Stream mode redaction]
  F --> G[SSE]
  G --> H[Dashboard UI]
```

Each source adapter tail-decodes its log and maps it to a common event shape (`say`, `call`, `result`, `job`, `jobOutput`, `thinking`, `user`, `step`). The server watches file size and the last event timestamp, derives the live state from open turns/steps/jobs, and streams history first and then live events over one SSE connection. The page renders that stream into the tree, editor, console, chat and activity bar. There is no database and no browser build step.

</details>

<details>
<summary><b>Development and limits</b></summary>

```bash
npm test                 # smoke, roots, redaction, sources and headless Edge UI suites
node scripts/demo-session.mjs --play   # synthetic demo (no real data)
node scripts/capture.mjs               # regenerate docs assets
```

The test suites use temporary synthetic fixtures only. The UI suite drives Edge through the DevTools protocol; set `EDGE_PATH` if Edge is not in its default location. Dev-only tools (`esbuild`, `postject`, `gifenc`, `pngjs`) are used for the release build and asset capture; the runtime has no dependencies.

- `smoke` — dsh API/SSE, live/idle/finished states, stale-mtime growth, hysteresis, system user classification, nicknames, job output, sorting, source counts, sys samples, Host/Origin/Content-Type checks.
- `roots` — allowlisted roots, junction follow/deny, opaque keys, traversal, touched deep paths, ignore list/show-hidden.
- `redact` — every redaction category, IP:port/UUID/opaque-id rules, network boundaries, live `redact.json`, fail-closed and off mode.
- `sources` — Claude custom titles/subagents/thinking/pending live, Antigravity normalization, tokens, deletes and live tail.
- `ui` — headless Edge: header, compact picker, meters, activity states, follow, tree legend/tooltips/show-hidden, skeleton/loading bar, chat Chat|Log and grouped tools, replay, splitter persistence, vendored assets, reduced motion and 900/720 px layouts.

Build a standalone Windows exe and the package/portable archives with `node scripts/build-sea.mjs`. Artifacts go to `dist/` (git-ignored).

### Limits

- Only the newest sessions per source are listed (60 dsh/Claude, 40 Antigravity).
- The tree is a snapshot (2,500 nodes, 12 levels); files created later appear when touched if their parent is known.
- Peak/off-peak pricing ignores public holidays; GPU metering needs `nvidia-smi`.
- Windows is tested. macOS and Linux are untested. The Windows exe is unsigned, so SmartScreen may warn.
- `.dsh` logs are decoded as zstd frames; corrupted frames are skipped.

</details>

## License

MIT © 2026 ionut27001. See [LICENSE](LICENSE).

<p align="center">
  <img src="docs/wordmark.svg" width="220" alt="agenttail wordmark">
</p>

agenttail is not affiliated with DeepSeek, Anthropic or Google. Product names are used only to describe supported sources.
