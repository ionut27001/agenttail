# Hub design, part 1: harness control and "needs you"

Date: 2026-10-21. Status: design proposal, nothing implemented. agenttail 0.3.0.
Scope of this document: how agenttail controls agent harnesses beyond dsh, and how
it knows when any agent needs the human. Cross-agent coordination (MCP), the public
API and remote machines are other parts. `docs/dev/hub-current-state.md` is a
companion map of the current ACP client and control plane.

Evidence tags used below:

- **[verified]** read in the repo, in the cited spec/doc page, or run on this
  machine with a read-only command.
- **[observed]** seen on this Windows machine (agenttail author's), not documented
  as a contract.
- **[not verified]** claimed by a secondary source, inferred, or not checked.
  Nothing marked this way should be built on without a spike.

I did not run any ACP adapter or harness (no installs, no `npx`), so every
"capability a harness declares" below comes from its docs or README, not from a real
`initialize` response. Section 2.3 therefore makes capabilities a runtime probe, not a
table baked into agenttail.

---

## 0. Recommendation in one page

1. **Ship "needs you" first and on its own.** It is read-only, works without
   `--allow-control`, and the strongest signal for Claude Code (the author's other
   daily harness) is a file Claude Code already writes: `~/.claude/sessions/<pid>.json`
   carries `status: busy | idle | waiting` and, per the docs, `waitingFor`
   (section 3.3). dsh logs carry `approval/asked` and `approval/decided` events that
   pair by `id` (section 3.4). Antigravity has no known signal (section 3.5). Today
   only owned dsh sessions can raise an attention badge (`server.js:108-112`).
2. **Generalise the control plane around a harness registry, not around dsh.** One
   `harnesses` block in `control.json`; each entry says how to spawn the ACP server
   (absolute command, args, env allowlist), which permission presets it offers, and
   which log adapter (if any) already renders its sessions.
3. **Make every capability a runtime probe.** Read `agentCapabilities` and the
   `configOptions` from `initialize` / `session/new`, gate the UI on them (images,
   resume, mode picker, model picker). agenttail already does this for images
   (`lib/control.js:272`); extend the habit, do not hard-code per-harness tables.
4. **One transcript source per owned session.** If a log adapter resolves the
   session (dsh today, Claude Code next), the page keeps rendering the log and ACP is
   a side channel for approvals and run state, exactly like dsh now. If none does
   (OpenCode, Codex, Goose, Gemini, Antigravity-over-ACP), a new in-memory `AcpStream`
   renders the session from `session/update` notifications. Never both. Never written
   to disk by agenttail.
5. **Claude Code is the first non-dsh harness**, through Anthropic/Zed/JetBrains'
   ACP adapter. It has the log adapter already, so no new renderer is needed. There is
   a real terms-of-service question about driving it through the Agent SDK with a
   subscription login (section 1.4); that needs the author's decision before code.
6. **Order after Claude:** OpenCode (MIT, standalone Windows binary, closest to the
   "opencode that controls harnesses" vision), Codex, Goose, Gemini CLI, then the
   Antigravity ACP server. Each ships as a documented recipe marked unverified until
   someone runs it on a real install.
7. **Do not clone herdr** and do not scrape terminals. Everything here is protocol
   (ACP) or files the harness already writes.

Changes to the staging you proposed are in section 4.1.

---

## 1. Which harnesses can be driven over ACP today

### 1.1 What ACP gives us (spec facts)

- JSON-RPC 2.0, methods plus notifications. Lifecycle: `initialize`, optional
  `authenticate`, `session/new` or `session/load`, then `session/prompt` with
  `session/update` notifications and a `session/cancel` notification.
  [verified: https://agentclientprotocol.com/protocol/overview]
- Transport: **stdio**, newline-delimited UTF-8 JSON, nothing else on stdout. A
  **Streamable HTTP** transport is only a "draft proposal in progress".
  [verified: https://agentclientprotocol.com/protocol/transports]
- Capability gating is strict: omitted means unsupported. Agent side:
  `loadSession`, `promptCapabilities.{image,audio,embeddedContext}`,
  `mcpCapabilities.{http,sse}`, `sessionCapabilities.{delete,additionalDirectories}`;
  client side: `fs.{readTextFile,writeTextFile}`, `terminal`, `auth.terminal`,
  `elicitation`. Protocol version is one integer; the client sends the latest it
  supports and the agent answers with the same or its own latest.
  [verified: https://agentclientprotocol.com/protocol/initialization]
- Session methods in the current schema: `session/new`, `session/load`
  (needs `loadSession`, replays history as `session/update`), `session/resume`
  (needs `sessionCapabilities.resume`, no replay), `session/list` (needs
  `sessionCapabilities.list`), `session/close` (needs `sessionCapabilities.close`),
  `session/delete`, `session/set_config_option`, `session/set_mode`.
  [verified: https://agentclientprotocol.com/protocol/session-setup,
  https://agentclientprotocol.com/protocol/schema,
  https://agentclientprotocol.com/protocol/session-list] The spec pages do not label
  stable versus draft for these; treat every optional method as capability-gated and
  probe.
- Permissions: the agent sends `session/request_permission` with `toolCall` and
  `options` whose `kind` is `allow_once | allow_always | reject_once | reject_always`.
  The client answers `{outcome:"selected", optionId}` or `{outcome:"cancelled"}`, and
  **must** answer every pending request `cancelled` when it cancels the turn. A
  client may answer automatically; agenttail never does.
  [verified: https://agentclientprotocol.com/protocol/tool-calls,
  https://agentclientprotocol.com/protocol/prompt-turn]
- Tool calls carry `kind` (`read`, `edit`, `delete`, `move`, `search`, `execute`,
  `think`, `fetch`, `switch_mode`, `other`), `rawInput`/`rawOutput`, `locations`, and
  content blocks of type `content`, `diff` (`path`, `oldText`, `newText`) or
  `terminal`. [verified: tool-calls page above]
- Images are content blocks `{type:"image", data (base64), mimeType, uri?}` and are
  only legal when the agent declared `promptCapabilities.image`.
  [verified: https://agentclientprotocol.com/protocol/content]
- Config options (`configOptions`, categories `mode`, `model`, `model_config`,
  `thought_level`; `session/set_config_option`; agent-initiated
  `config_option_update`) are the current mechanism and are said to supersede the
  older Session Modes API. [verified:
  https://agentclientprotocol.com/protocol/session-config-options]
- `session/new` takes `mcpServers` (stdio always; `http` only with
  `mcpCapabilities.http`). This is the hook part 2 (MCP) will use to give owned
  sessions an agenttail MCP server. [verified: session-setup page above]
- Clients can also be asked questions: `elicitation/create` is a client method, with
  a matching client capability. I could not load its own page, so the exact shape is
  [not verified]. [verified that it exists: overview page above]
- **Registry.** A curated JSON registry lists ACP agents with a distribution recipe
  (npx package, uvx package, or per-OS binary archive), "including only the ones that
  support authentication". I fetched
  https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json on 2026-10-21:
  43 agents. [verified: https://agentclientprotocol.com/get-started/registry]

### 1.2 Survey

Launch commands come from the registry JSON above (versions as of 2026-10-21).
"Declared capabilities" are what docs or READMEs say, not a probe.

| Harness | Launch in ACP mode | Auth | Declared (docs) | Windows | Licence | Maturity |
| --- | --- | --- | --- | --- | --- | --- |
| **dsh** (DeepSeek Harness) | `dsh --profile acp` | dsh's own provider config in `DSH_HOME` | Probed by the author on 0.2.1-rc.2: `session` close/list/resume, **no image prompts**, one-shot permission requests, `configOptions` for model and reasoning effort, permission preset not exposed (env `DSH_PERMISSION_MODE`). "automation-only: no plans, terminals, fs, elicitation" [verified: `docs/dev/input-design.md`] | Yes, daily use on the author's machine | not checked | agentInfo `deepseek-harness-acp 0.0.1`; works today |
| **Claude Code** via `@agentclientprotocol/claude-agent-acp` | `npx @agentclientprotocol/claude-agent-acp@0.94.0` (registry id `claude-acp`); npm bin `claude-agent-acp`, node >= 22 | The adapter wraps the Claude Agent SDK, which runs Claude Code. Credentials come from Claude Code's own login or an API key; the README page I could load does not describe auth [not verified]. See the terms issue in 1.4 | README: images, tool calls with permission requests, edit review, TODO lists (v1) / plans (v2), terminals (interactive and background), custom slash commands, client MCP servers, subagent transcripts. `session/resume` with replay, `session/fork`, `session/delete` are listed as **v2 (a draft that "can still change")** only; v1 resume support is not stated [verified: https://github.com/agentclientprotocol/claude-agent-acp]. Modes seen in source: `default`, `auto`, `acceptEdits`, `dontAsk`, `plan`, `bypassPermissions` (bypass allowed unless root, or `IS_SANDBOX` set) [verified: `src/permissions/modes.ts`]. Permission options are sorted allow_once, allow_always, other, reject, or reject-first when `defaultToNo` [verified: `src/permissions/options.ts`] | SDK ships a `win32-x64` native optional package (`@anthropic-ai/claude-agent-sdk-win32-x64`) [verified: `npm view`]; adapter on Windows not tested by me | npm: Apache-2.0; registry entry says "proprietary" with a pointer to the repo LICENSE. Sources disagree; read the file before redistributing anything (agenttail would not) | 0.94.0, published 2026-10-21; depends on `@agentclientprotocol/sdk` 2.0.0, which is a major bump from the 1.x the Codex adapter still uses |
| **Codex** via `@agentclientprotocol/codex-acp` | `npx @agentclientprotocol/codex-acp@2.2.2` (registry `codex-acp`); `CODEX_PATH` can point at another Codex binary | ChatGPT login, `CODEX_API_KEY` or `OPENAI_API_KEY`, or a custom gateway | README: images, embedded context, permission requests, modes `read-only`, `workspace-write`, `agent`, `agent-full-access`, model and reasoning-effort options, plans, shell/terminal output, file changes, MCP, slash commands. Session load only referenced indirectly [verified: https://github.com/agentclientprotocol/codex-acp]. The older `@zed-industries/codex-acp` repo is archived [verified: https://github.com/zed-industries/codex-acp] | Not mentioned [not verified] | Apache-2.0 | 2.2.2; built on Codex App Server |
| **OpenCode** | `opencode acp` (registry binary `opencode`, also `opencode-v2` 2.1.2) | OpenCode's own provider config; env passthrough shown (`OPENCODE_API_KEY`) | Docs: built-in tools, custom tools and slash commands, MCP from its config, `AGENTS.md` rules, agents and permission system; `/undo` and `/redo` unsupported [verified: https://opencode.ai/docs/acp/]. Exact `initialize` flags [not verified] | Registry has `windows-x86_64` and `windows-aarch64` zips | MIT | 1.19.3 |
| **Gemini CLI** | `gemini --acp` (registry: `npx @google/gemini-cli@0.65.0 --acp`) | Not described on the ACP page; `authenticate` method exists [verified: https://geminicli.com/docs/cli/acp-mode/] | A 2025 snapshot quoted in an issue says `loadSession:false` and image/audio/embeddedContext true [not verified; secondary: https://github.com/agentclientprotocol/agent-client-protocol/issues/77]. Docs list `setSessionMode` (approval level) and `unstable_setSessionModel` | Not mentioned | Apache-2.0 | 0.65.0. The same docs page says Antigravity CLI replaced it for unpaid-tier and Google One users on 2026-06-18, so expect it to fade |
| **Goose** | `goose acp` (stdio); also `goose serve` listening on `127.0.0.1:3284` with an ACP endpoint at `/acp` over HTTP/WebSocket and an `X-Secret-Key` secret [verified: https://goose-docs.ai/docs/gdk/acp/] | Provider config in goose; device-code notification during provider auth for clients that opt in | Standard capabilities not stated on the pages I could load [not verified]. Goose adds `_goose/unstable/...` extension methods [verified: https://goose-docs.ai/docs/gdk/acp/reference] | Registry has `windows-x86_64` | Apache-2.0 | 1.55.0 |
| **Antigravity** (agy) | Separate server binary `agy_acp_server.exe` (Windows x64/arm64), registry id `antigravity-acp` 1.4.1, downloaded from `dl.google.com/agy-extensions/...`. The **installed `agy.exe` 1.4.2 has no `acp` subcommand** in `--help` [verified here] | Not documented on the pages I could load. A community adapter (`agy-acp`) uses a Gemini API key and warns that third-party use with an Antigravity account may violate Google's terms [secondary: https://github.com/jiridanek/agy-acp] | Nothing documented [not verified] | Yes (registry zip) | proprietary (registry) | 1.4.1; closed source |
| Others in the registry | Copilot CLI (`--acp`), Cursor (`cursor-agent acp`), Kilo, Kimi, Qwen Code, Cline, Amp, Mistral Vibe, ... (43 total) | per harness | not surveyed | most have a windows entry | mixed | not surveyed |

Sources for the table: the registry JSON and the pages linked in the cells. Package
metadata (versions, licences, `bin`, `engines`, optional dependencies) is from
`npm view`, read-only, on 2026-10-21.

### 1.3 What this tells us

- The **same client code** can drive all of them if it stays inside ACP v1 and treats
  everything optional as probed. Claude Code, Codex, OpenCode and Goose all ship as
  "registry-listed" recipes: an executable plus fixed args.
- **Versions are moving.** The Claude adapter already speaks a draft v2 when a client
  asks for protocol version 2 (`CLAUDE_AGENT_ACP_PROTOCOL` = `auto|v1|v2`; a client
  that asks for 1 gets v1). agenttail should send `protocolVersion: 1` and pin
  adapter versions in the recipe. [verified: README above]
- **Resume is the least certain capability.** dsh declares `resume`; the Claude
  adapter documents resume only for v2; others unknown. The design must work when
  neither `session/load` nor `session/resume` exists (section 2.4).
- **Goose is the only one with a documented non-stdio ACP transport.** Not needed in
  v1; stdio keeps one process model.

### 1.4 What is installed here, and the Anthropic terms question

Checked with read-only commands on this machine:

- `dsh`: installed (DeepSeek Harness desktop runtime). [verified: `where dsh`]
- `agy.exe` 1.4.2: installed under `%LOCALAPPDATA%\agy\bin`; `--help` lists print
  mode with `--input-format stream-json --output-format stream-json`,
  `--dangerously-skip-permissions`, `--mode accept-edits|auto|plan`, `--remote-control`,
  and no ACP subcommand. [verified]
- `claude`: **not on PATH**. Claude Code transcripts and `~/.claude/sessions` exist
  because the Claude desktop app runs it (`entrypoint: claude-desktop`, version
  2.1.304). So there is no standalone `claude` binary to point an adapter at;
  the adapter's SDK ships its own native binary. [verified/observed]
- `codex`, `gemini`, `opencode`, `goose`: not installed. So nothing in section 1.2
  for those has been tested here.

**The terms question for Claude Code.** Anthropic's Claude Code legal page says
developers building products "including those using the Agent SDK, should use API key
authentication"; Anthropic "does not permit third-party developers to offer Claude.ai
login into their own applications, or to route requests through Free, Pro, or Max
plan credentials on behalf of their users", and developers "may not collect, store, or
intermediate Claude.ai credentials or session tokens". The same page says this does
not prevent "an end user from signing in to the unmodified Claude Code binary with
their own Claude subscription". [verified:
https://code.claude.com/docs/en/legal-and-compliance] The Agent SDK overview repeats
the API-key rule. [secondary summary of: https://code.claude.com/docs/en/agent-sdk/overview]

What that means for agenttail, which is a local tool a person runs for themselves:

- agenttail never sees, stores or relays a credential. The user signs in outside
  agenttail; the adapter and Claude Code read their own credentials.
- Whether a local personal tool that launches the adapter counts as "offering
  Claude.ai login" is a legal reading I cannot settle. The safe, documented path is an
  API key (or Bedrock/Vertex credentials) set by the user in the adapter's
  environment. Subscription login through the adapter is the user's own
  responsibility. See open question Q1.
- An alternative that avoids the adapter: drive the real `claude` binary in
  `-p --input-format stream-json --output-format stream-json` mode with
  `--permission-prompt-tool`. [verified that the flags exist:
  https://code.claude.com/docs/en/headless] That is a bespoke protocol, so it is not
  recommended as the first path, but it is the fallback if the adapter route is
  rejected.

---

## 2. Generalising `lib/acp.js` and `lib/control.js`

### 2.1 What in the current code is dsh-shaped (all [verified] by reading)

| # | Where | Problem for a second harness |
| --- | --- | --- |
| 1 | `lib/control.js:249-256`, `lib/control.js:151-155`, `control.example.json` | Spawn is `dsh` only: `dshCommand`, `dshArgs`, `dshProfile`, `dshHome`, `patch`. `--profile` is appended unconditionally in `lib/acp.js:45`. |
| 2 | `lib/control.js:244-248` | The permission preset is the env var `DSH_PERMISSION_MODE`; other harnesses use modes/config options, or nothing. |
| 3 | `lib/control.js:417` | Approve picks the **first** option whose kind is `allow_once` or `allow_always`, in array order. ACP does not fix option order. The Claude adapter sorts `allow_once` first, but a different adapter or version could list `allow_always` first, and Approve would then silently grant a persistent rule. Must select `allow_once` explicitly and treat `allow_always` as a separate, explicit user choice. |
| 4 | `lib/control.js:61-89`, `:282-304` | Only the `model` config option is understood. `mode`, `thought_level` and `model_config` options are dropped. |
| 5 | `lib/control.js:98-127` | `approvalDetails` reads dsh-style `rawInput` keys (`command`, `old_string`, `new_string`) and only `text` content. ACP-standard `diff` content blocks (`path`, `oldText`, `newText`) and `locations` are ignored, so a harness that sends a diff but no `rawInput` would show an empty card. |
| 6 | `lib/control.js:266-270` | `initialize` hard-codes `fs` capabilities off and no `terminal`/`elicitation`. Right for v1 (agenttail implements none of them), but the agent's reaction is harness-specific, e.g. an agent that wants to ask a question may skip it. |
| 7 | `lib/control.js:274-277`, `:518-523` | `mcpServers: []` is hard-coded; no way to inject servers later. |
| 8 | `lib/control.js:537`, `:550`, `lib/acp.js:137` | Error text says "dsh ACP exited"; `session/close` is sent without checking `sessionCapabilities.close`. |
| 9 | `server.js:1093`, `:1167`, `:1707`, `:388` | `controlDescriptor`, the control SSE channel and the `owned` flag are all `source === 'dsh'`. |
| 10 | `server.js:1040-1060` | `getStream` / `sessionsFor` know three sources by name; a harness with no log adapter has nowhere to render. |
| 11 | `lib/control.js:632-643` | `begin` then `startFirst` is a two-step flow built so the model can be picked from the live catalog; fine, but the catalog now also needs mode/preset options. |
| 12 | `lib/control.js:196-212` | Audit has no `harness`, adapter name/version, protocol version, or what kind of thing was approved. |
| 13 | `lib/acp.js:28-33`, `lib/control.js:249` | Child env is all of `process.env`. Acceptable for dsh (it needs provider keys the user already exported); for adapters that spawn other programs, pass an allowlist. |

None of these need a rewrite. The transport (`AcpClient`) is generic apart from
items 1, 8 and 13.

### 2.2 Harness registry

Replace the dsh-only keys with a `harnesses` map in `control.json`. Legacy top-level
keys (`dshProfile`, `dshCommand`, ...) are read as `harnesses.dsh` when `harnesses`
is absent, so existing files keep working.

```json
{
  "workspaces": ["E:\\dev\\scratch"],
  "maxSessions": 8,
  "harnesses": {
    "dsh": {
      "label": "DeepSeek Harness",
      "kind": "dsh",
      "profile": "acp",
      "home": "C:\\Users\\you\\.dsh"
    },
    "claude": {
      "label": "Claude Code",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\tools\\acp\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js"],
      "envPass": ["ANTHROPIC_API_KEY"],
      "log": "claude",
      "presets": [
        { "id": "default",     "label": "Ask before edits and commands", "mode": "default" },
        { "id": "acceptEdits", "label": "Accept edits, ask for commands", "mode": "acceptEdits" },
        { "id": "plan",        "label": "Plan only", "mode": "plan" },
        { "id": "bypass",      "label": "Bypass permissions", "mode": "bypassPermissions", "danger": true }
      ],
      "defaultPreset": "default"
    },
    "opencode": {
      "label": "OpenCode",
      "command": "C:\\tools\\opencode\\opencode.exe",
      "args": ["acp"]
    }
  }
}
```

Rules:

- **Commands come only from this file.** Never from an API request or the page.
  Absolute paths recommended; the New Session dialog shows the resolved command line
  for the chosen harness so the user sees what will run. (Same trust level as the
  workspace allowlist: anything that can write the config directory can add a
  harness, as it can edit any dotfile.)
- **agenttail never downloads or installs a harness.** The README gets a "bring your
  own adapter" table (the recipes), and recommends installing the pinned adapter once
  into a folder the user owns, then pointing `command`/`args` at it. Running
  `npx -y pkg@ver` works but makes the child fetch from npm on first use, which is
  the user's call, not agenttail's; the README's "no external requests from
  agenttail" stays true because agenttail itself makes none.
- **Env.** dsh keeps passing the full environment (unchanged). Other harnesses get a
  small base (`PATH`, `SystemRoot`, `USERPROFILE`/`HOME`, `APPDATA`, `LOCALAPPDATA`,
  temp dirs) plus `envPass` names plus a static `env` object for non-secret values.
  Env values are never written to the audit log or sent to the page.
- **Presets** abstract the three real mechanisms: `{ "env": {...} }` (dsh, applied
  before spawn), `{ "mode": "<id>" }` (applied right after `session/new` with
  `session/set_config_option` for the `mode` category, or `session/set_mode` when the
  agent offers only legacy `modes`), `{ "config": {configId, value} }`. A preset with
  `"danger": true` keeps today's rule: `confirmDanger: true` plus a ticked box.
  Default preset is the one that asks.
- **Log link.** `"log": "dsh" | "claude" | null` says which existing adapter renders
  this harness's sessions (section 2.8).
- **Recipes live in docs and `control.example.json`, not in code.** No built-in
  harness list means no list to keep in sync with a fast-moving registry.

### 2.3 Capabilities: probe, then gate

After `initialize` and `session/new`, build one `caps` object per session and send it
to the page in the existing `control` state payload:

```
caps = {
  protocolVersion, agent: { name, version },
  prompt: { image, audio, embeddedContext },
  loadSession, session: { list, resume, close, delete },
  mcp: { http, sse },
  authMethods: [ ...ids ],
  config: [ { id, name, category, type, current, options[] } ]   // all select options
}
```

UI gating (all derived, none per-harness):

| Control | Shown when |
| --- | --- |
| Image paste/attach chip | `caps.prompt.image === true` (today: `images`) |
| Model picker | a config option with category `model` (or id `model`) has >= 2 values |
| Mode / effort pickers | config options with category `mode` / `thought_level` |
| "Resume" on a finished session | `caps.session.resume` or `caps.loadSession` (section 2.4) |
| Plan strip | the agent has sent a `plan` update (no capability needed) |
| "End" sends `session/close` first | `caps.session.close`; otherwise end stdin and kill |

If `initialize` returns `authMethods` and `session/new` fails with an auth error,
agenttail shows "this harness needs you to sign in; do that outside agenttail" and
records it. It does not implement `authenticate`, collect secrets, or open terminals.
[not verified: the exact auth error shape; spike on the first adapter.]

### 2.4 Session lifecycle

- **New.** Unchanged shape: `begin` (spawn, initialize, `session/new`, apply preset,
  return catalog and caps), `start` (pick model/mode, first prompt). One child per
  owned session stays: it matches dsh's process-level preset, isolates crashes, and is
  the smallest change. Cost: each Claude session is an adapter plus a Claude Code
  process, so `maxSessions` (default 8) stays a real limit. Pooling is a later
  optimisation for harnesses whose presets are per-session.
- **Resume ("take over").** For a session shown in the picker that belongs to a
  configured harness and has no live process: spawn the harness in the session's
  `cwd` (still must be inside the workspace allowlist), `initialize`, then
  `session/resume` if `caps.session.resume`, else `session/load` if `caps.loadSession`
  (ignore the replayed `session/update` flood, because the log view already has the
  history), else the button is not offered ("start a new session in this folder"
  instead). Refuse when something else still owns the session:
  - dsh: a second process is rejected by dsh itself (`already owned by an active
    write handle`, `docs/dev/input-design.md`). Surface that error text.
  - Claude Code: `~/.claude/sessions/<pid>.json` has the owning `pid`/`sessionId`;
    if that pid is alive, refuse. The Claude docs warn that resuming the same
    session in two terminals without forking interleaves both into one transcript.
    [verified: https://code.claude.com/docs/en/sessions]
  Resume only ever starts a process the user asked for; there is no auto-resume after
  a crash.
- **Cancel.** Keep today's behaviour (drop the queued message; answer every pending
  permission request with `cancelled`; send `session/cancel`), and add what the spec
  requires of the agent's side: the prompt must come back with `stopReason:
  "cancelled"`. If it has not within 10 s, show "agent did not stop" and offer End.
  Do not kill on a timer without the user asking.
- **Close / crash.** `session/close` only if declared; then close stdin; then
  `taskkill /T` as today. Child exit marks the session `exited`, clears approvals
  (already done). Show the last 8 KiB of the child's stderr in a "details" fold: it is
  captured in `AcpClient` (`lib/acp.js:66-69`) and never shown today.

### 2.5 Approvals

Normalise every `session/request_permission` into one object, independent of harness:

```
{ approvalId, origin: 'harness' | (later) 'hub',
  harness, title, toolKind,                  // ACP ToolKind
  command?, diff?: {path, oldText, newText}, // from rawInput OR content[type=diff]
  locations[], rawInput (lean), content (text),
  options: [{optionId, name, kind}], createdAt }
```

- The card shows **raw input first** (command, diff, paths) and the agent-supplied
  `title` second. The title is text the agent wrote; a benign title over a dangerous
  `rawInput` is the cheapest way to trick a tired reviewer.
- Approve = the option with kind `allow_once`. If there is none, say so and let the
  user reject; do not fall back to `allow_always`. "Always allow" is a separate
  button, hidden by default, enabled per harness in `control.json`
  (`"allowAlways": true`) and audited as its own action. Reject = `reject_once`, else
  `reject_always` only if that is all there is.
- The reject reason stays in `_meta.reason` and in the user's own audit trail. Note
  that ACP's permission response has no message field, so a harness cannot hear
  "do X instead"; the way to redirect is the next message. Say so in the UI.
- `origin` is there now so part 2 (agents asking agents) can reuse the same queue and
  the same human gate.
- A global **inbox** (list of every pending approval across owned sessions, with
  Approve/Reject in place) belongs in stage 1 of the plan; today an approval is only
  actionable inside the session that raised it.

### 2.6 Images

The composer already accepts up to 4 pasted images of 5 MB (PNG/JPEG/GIF/WebP),
validates them in `imageBlocks`, and sends ACP `image` blocks only when the agent
declared `promptCapabilities.image` (`lib/control.js:29-42`, `:465`). Generalisation:

- No code change to the wire format: the block shape is exactly the spec's.
- The message text for the UI hint becomes per-harness ("this agent does not accept
  images"), driven by `caps`, instead of the dsh-specific string in
  `public/app/control.js:210`.
- Also send images as `resource_link` / `embeddedContext` for harnesses that declare
  only `embeddedContext` (screenshots as files)? Not in v1; text plus image only.
- Per-adapter size limits are unknown [not verified]; a rejected prompt must show the
  agent's error, not a generic failure.
- Viewing images that the **agent** produces (tool results, screenshots) is a read-side
  feature, not control, and belongs to stage 3 of the overall plan.

### 2.7 Audit log

Same file, same rule (no message bodies, no reasons, no env). Add fields:

| Action | New fields |
| --- | --- |
| `start` | `harness`, `agent` (name/version from `agentInfo`), `protocol`, `preset`/`mode`, `images` (bool), `resumed` (bool) |
| `approve` / `reject` | `harness`, `toolKind`, `titleDigest` (first 12 hex of SHA-256 of the title+command) so an entry can be matched to a known command without storing it |
| `config` (replaces `model`) | `harness`, `configId`, `value` for non-secret select values |
| `resume`, `close`, `stop` | `harness` |

Whether to log tool titles in clear is a judgement call (it is what a reviewer would
want after an incident; it also may contain paths and commands). Default to digest
only, with an opt-in `"auditDetail": "titles"`. See Q5.

### 2.8 Owned sessions next to the read-only log views

The read side keys sessions as `source:id` (`lib/agents.js:152`, `nicknames`,
`streams` map). A controlled session must not produce a second row or a second chat.
Rule: **each owned session has exactly one `viewFrom`**, decided once, shortly after
the first prompt.

```
after first prompt:
  if harness.log is set:
      look for the log record whose id == acpSessionId (dsh: same uuid, already how it
      works; Claude: the transcript file is <sessionId>.jsonl [verified path rule:
      https://code.claude.com/docs/en/sessions])
      found within ~8 s (same wait as waitForSessionRecord, server.js:1133) -> viewFrom = 'log'
      not found -> viewFrom = 'acp'      (e.g. transcript persistence is off)
  else viewFrom = 'acp'
```

- `viewFrom = 'log'` (dsh, Claude): the row is the existing `dsh` or `claude` row,
  tagged `owned`. The page renders the log. ACP supplies approvals, run state, caps and
  plan updates only. No chat text from ACP is rendered. This is today's dsh model, so
  nothing double-renders and nothing new is invented for Claude.
  [not verified: that the adapter's ACP `sessionId` equals the Claude Code session id
  and that Agent-SDK sessions persist a transcript. The Claude docs say `-p` and SDK
  sessions are left out of Claude Code's own picker but remain resumable by id and
  stored as `.jsonl`, which suggests they exist on disk. First task of stage 2 is to
  confirm both against the real adapter.]
- `viewFrom = 'acp'` (everything without a log adapter): a new `AcpStream`
  (extends `BaseStream`, `lib/acp-stream.js`) turns `session/update` into the existing
  normalized events (`say`, `thinking`, `user`, `call`, `result`, `step`, `turn`,
  `turnEnd`, plus `plan`), so the editor, console, tree, wall and clash detection work
  with no page changes. It is **in memory only**: agenttail still never writes message
  bodies. When agenttail stops, an ACP-only session is gone from the viewer (the
  harness keeps its own history). `getStream` gets one more branch; the source key is
  the harness id, shown with the harness label.

  | ACP update | Normalized event |
  | --- | --- |
  | `user_message_chunk` | `user` (not echoed for the prompt we just sent) |
  | `agent_message_chunk` | `say`, chunks merged until a tool call, turn end or 800 ms |
  | `agent_thought_chunk` | `thinking` |
  | `tool_call` kind `execute` | `call` name `pwsh`, `args.command` from `rawInput`/title |
  | `tool_call` kind `edit` with `diff` content | `call` name `edit`/`write`, `args.{file_path,old_string,new_string}` |
  | `tool_call` kind `read` / `search` | `call` name `read` / `grep`; `locations[0].path` as the file |
  | `tool_call_update` completed / failed | `result` (`isError` on failed), text from `rawOutput`/content |
  | `plan` | `plan` (new, small renderer in the chat) |
  | prompt response `stopReason` | `turnEnd` |
  | `usage_update` | tokens, if the agent sends it |

- **Replay from `session/load` is dropped** in both modes (it would duplicate the log
  or the in-memory history).
- The mapping is the biggest new piece of work (stage 3). It is also what makes
  OpenCode, Codex, Goose and Gemini usable at all, since agenttail has no adapter for
  their on-disk stores. Writing log adapters for those stores later is optional and
  per-harness.

### 2.9 HTTP surface (all behind `--allow-control`, token, not in stream mode)

Existing endpoints keep their names and semantics; `harness` defaults to `dsh`.

| Endpoint | Change |
| --- | --- |
| `GET /api/control/options` | adds `harnesses: [{id, label, available, presets, defaultPreset, commandLine}]`; `available` = the command exists (`where`-style check, no execution) |
| `POST /api/control/session/begin` | `{ harness, cwd, preset, confirmDanger }` -> `{ session, caps, config }` |
| `POST /api/control/session/start` | unchanged, plus optional `config: {configId: value}` |
| `POST /api/control/session/resume` | new: `{ harness, sessionId, cwd }` |
| `POST /api/control/message` | unchanged (`images`) |
| `POST /api/control/config` | new, replaces `/model`: `{ id, configId, value }` (`/model` kept as an alias) |
| `POST /api/control/approval` | adds `choice: 'approve' | 'reject' | 'approve-always'` (`decision` still accepted) |
| `GET /api/control/approvals` | new: pending approvals across owned sessions (inbox) |
| `POST /api/control/stop`, `/close` | unchanged |

Control sessions are identified by `harness:id` internally so two harnesses can never
collide on an id.

### 2.10 Security notes specific to this section

- Stream mode still locks all of this out (403) and the page hides the controls. An
  `AcpStream` passes every event through `BaseStream.add` -> `safeRedact`, so even the
  read-only rendering of an owned ACP session is redacted like any other.
- A harness is a program that edits files and runs commands in the allowlisted
  workspace. agenttail does not sandbox it; the harness's own permission mode is the
  boundary, as with dsh today. The README's risk paragraph must say it per harness.
- Approval content is attacker-influenced (an agent that has read a hostile file can
  ask for anything). Exact text, no truncation of commands in the card (the existing
  8,000-char cap on `rawInput` strings stays and is shown as truncated), raw input
  before title.
- Windows: `npx`/`.cmd` shims need `shell: true` (`lib/acp.js:47-58`). Arguments there
  come only from `control.json`, never from the page, which is what keeps `quoteWin`
  adequate. Prefer `node.exe` + script path in recipes so no shell is involved.

---

## 3. "Needs you" for every source

### 3.1 Vocabulary

Three levels, because "idle" is not "blocked":

| Level | Meaning | Look |
| --- | --- | --- |
| **NEEDS YOU** | The agent cannot continue until a human acts: permission, a question, a sandbox/network prompt, a dialog, an auth problem | amber, loud |
| **READY** | The turn ended; the agent waits for the next prompt | green check, quiet |
| **WORKING / STALLED?** | Existing live state, existing 5-minute stall label | unchanged |

Claude Code's own agent view makes the same split: "Needs input" (yellow, "waiting on
something only you can provide, including a permission decision") versus "Idle"
(ready for your next prompt). [verified:
https://code.claude.com/docs/en/agent-view]

Each session record gets one optional field, produced by the source adapter and
carried through `/api/agents`, the session list and the SSE `status` event:

```
attention: {
  level: 'needs-you' | 'ready' | 'none',
  reason: 'permission' | 'question' | 'sandbox' | 'dialog' | 'input' | 'auth' | 'unknown',
  since: <ms>,
  via: 'acp' | 'status-file' | 'hook' | 'log' | 'transcript',
  certainty: 'sure' | 'probable' | 'guess',
  tool?: 'Bash',            // name only
  detail?: 'permission prompt'
}
```

`certainty` is shown. Notifications fire only for `sure` and `probable`. `guess` is a
quiet "maybe waiting" label, because some cases cannot be told apart from work.

### 3.2 What is and is not detectable

| Source | Signal | What it proves | Not detectable |
| --- | --- | --- | --- |
| **Owned, any harness (ACP)** | a pending `session/request_permission` in agenttail's own map (`ControlSession.approvals`) | exactly: which tool, the exact input, since when. **sure**, no polling delay | A question the agent asks as plain text in its reply (that is a normal end of turn, so READY, not NEEDS YOU). A question via `elicitation/create` is not handled in v1; agenttail declares no `elicitation` capability, and what an adapter does then is [not verified] |
| **dsh, not owned** (Desktop app, terminal) | `approval/asked` without a matching `approval/decided` of the same `id` in the session log [verified: 20 of 20 decisions in this machine's logs pair by `id`] | permission prompt open (tool name, reason, time) -> **sure** | Prompts of any other kind. A crash while a prompt is open leaves an `asked` forever, so cap by age (OPEN_TURN_MS) and by the session no longer being live |
| **Claude Code, any origin** | `~/.claude/sessions/<pid>.json` `status: waiting` (+ `waitingFor`) | documented for `claude agents --json`: `waitingFor` is one of `permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open` -> **sure** while the file is fresh and the pid alive | Only [observed here] with `busy` and `idle`; `waiting` was never seen on this machine, and the doc says the file layout is not the supported interface (poll `claude agents --json`) [verified: https://code.claude.com/docs/en/agent-view]. Schema can change without notice |
| Claude Code transcript | an unanswered `tool_use` named `AskUserQuestion` or `ExitPlanMode` | a question / plan approval is pending -> **probable** (17 `AskUserQuestion` calls in 25 recent local transcripts [observed]) | A permission prompt for `Bash`, `Edit` and the rest: the `tool_use` is written when the model asks, before the user answers, and the `tool_result` after. An open `tool_use` is the same bytes whether a human is deciding or the command is just slow -> at best **guess**. No permission-prompt record type exists in the 138,232 entries I counted across the 25 most recent of 29 transcripts [observed; entry types: user, assistant, attachment, system, queue-operation, mode, ...] |
| Claude Code hooks (optional, user-installed) | `Notification` events: `permission_prompt` (fires after the prompt has waited about 6 s), `elicitation_dialog`, `idle_prompt` (60 s after finishing), `agent_needs_input`; `PermissionRequest` event with `tool_name`/`tool_input`; `Stop` | **sure**, with the tool name | Requires the user to edit their own `settings.json`; agenttail must never do it. Hooks do not fire in `--bare` runs. [verified: https://code.claude.com/docs/en/hooks] |
| **Antigravity CLI** | transcript only: `status` per step is `DONE` / `RUNNING` / `ERROR` in the one conversation here (343/6/1) [observed] | working vs finished, via mtime | **No known signal for an open permission prompt.** Third-party posts describe permission presets (`request-review` default) and hooks (`BeforeTool`, `AfterAgent`), but I found no first-party page or event for "waiting for approval" [not verified: https://medium.com/google-cloud/a-developers-guide-to-agent-hooks-in-antigravity-cli-4c1440febd11]. `presence/<id>.lock` exists (empty) and might mean "process alive" [not verified] |
| Any source, last resort | open tool call or open turn with no log growth for N minutes | something is stuck or slow | Cannot tell blocked from busy. Existing wall label is `waiting on the model` then `stalled?` after 5 min (`public/app/agents.js:287-288`); reuse it, do not notify |

Plainly: for Claude Code and dsh, "needs you for a permission" is detectable without
owning the session. For Antigravity it is not, until a spike finds a signal or the
session is owned through an ACP server.

### 3.3 Claude Code, in order of preference

1. **Session registry file** (zero setup). `~/.claude/sessions/<pid>.json` on this
   machine (Claude Code 2.1.304, desktop entrypoint) holds: `pid`, `sessionId`, `cwd`,
   `startedAt`, `procStart`, `version`, `kind`, `entrypoint`, `name`, `updatedAt`,
   `status` (`busy`/`idle` seen), `statusUpdatedAt`, plus fields I will not rely on
   (`messagingSocketPath`, `peerFeatures`). [observed] The docs describe `status` as
   `busy | waiting | idle` and `waitingFor` "when `status` is `waiting`". [verified:
   https://code.claude.com/docs/en/agent-view]
   Rules for reading it: join by `sessionId` to the transcript record; require the pid
   to be alive (`process.kill(pid, 0)`; `procStart` guards pid reuse); treat any
   unknown shape as "no signal" and fall back to transcript heuristics; read only the
   `.json` files. **Do not open the sibling `*.key` files** next to them (115 bytes
   each, purpose unknown, could be a secret). Env override
   `AGENTTAIL_CLAUDE_SESSIONS_DIR` for tests. Bonus: `busy` vs `idle` is a better
   LIVE signal than the transcript-growth plus 30-minute open-turn rule in
   `lib/claude.js`, and it fixes "quiet but composing a long reply".
2. **Transcript rules** (fallback, already parsed in `lib/claude.js`): unanswered
   `AskUserQuestion` or `ExitPlanMode` -> `needs-you/question`, `probable`; last
   assistant stop reason `end_turn` -> `ready`; any other unanswered tool call ->
   no attention, only the existing live state.
3. **Hooks, as an opt-in enrichment, shipped as a copy-paste snippet and a tiny
   script, never installed by agenttail.** A `command` hook (not HTTP, so the
   read-only server needs no new write endpoint) appends one line
   `{ts, event, sessionId, notification_type, tool_name}` to
   `<config>/attention/claude.jsonl`; agenttail only reads that file. The script keeps
   `tool_input` and message text out of the file (same rule as the audit log).
   [verified that command and `http` hook types exist and what the payloads contain:
   https://code.claude.com/docs/en/hooks]. Hooks add exact tool names and the
   `idle_prompt` / `Stop` times; the status file already gives the core signal, so
   this is optional.
4. **`claude agents --json`** is the documented interface, but it spawns a process and
   `claude` is not on PATH here (the desktop app bundles it). Support it only if the
   user sets `claudeCommand` in config; not in the first cut.

A **later, separate** option, not recommended in the first pass: a `PermissionRequest`
hook of type `http` pointing at agenttail would let the human approve or deny prompts
of Claude sessions agenttail does not own (the hook response can allow or deny).
[verified that the hook can return `decision.behavior` allow/deny:
https://code.claude.com/docs/en/hooks] That makes agenttail a permission authority
for sessions it did not start and depends on fail-open/fail-closed behavior when
agenttail is down, which I could not verify. Treat as its own design if wanted.

### 3.4 dsh

Both the Desktop app and terminal sessions write `approval/asked` and
`approval/decided` to the same zstd log agenttail already decodes; the server maps
them to events `approval` / `approvalDone` (`server.js:978-982`) but drops the `id`,
and `lib/session-analysis.js` ignores them for state. Change: carry `id`, track the set
of open ids in `session-analysis.js` (same place `openTurns` live), emit
`attention {needs-you, permission, via: log, certainty: sure, tool: toolName}` while
the set is non-empty and the log still looks live.

Observed on this machine's last 40 sessions: 11 had approvals; 20 asks, 20 decisions;
outcomes `allowed-once` 13 and `unavailable` 7; ask-to-decision gaps from 0 s to 139 s.
[observed] `unavailable` seems to be a decision made without a human (a host that
could not show the prompt), so those must not count as "needs you" for longer than the
poll that sees them. Whether the 0 s gaps are exactly the `unavailable` ones, and
whether the Desktop app flushes `asked` to disk before a human answers, are
[not verified]; the 1 to 139 s gaps show the two events are written at different
times, which is consistent with live writes.

For owned dsh sessions the ACP map stays authoritative (`approvals.size`); the log
signal is the same fact seen from outside and must not double count: key by session.

### 3.5 Antigravity

Today: working/idle/finished from mtime (`lib/antigravity.js:186`) and nothing else.
Plan:

1. Add a **spike task** (30 minutes, by the author, because it needs an account):
   run `agy` in a scratch folder with the default `request-review` permission, trigger
   a command that needs approval, and diff `transcript.jsonl`, `transcript_full.jsonl`,
   `.system_generated/messages/*.json` and the `presence/<id>.lock` file before and
   during the prompt. If a step with a waiting-like status or a message appears, add
   it as `via: transcript, certainty: probable`.
2. Until the spike says otherwise, Antigravity shows READY/idle only, and the UI says
   "approval prompts are not visible for Antigravity".
3. If the author installs `agy_acp_server` and owns Antigravity sessions through
   agenttail, the ACP map gives a sure signal (section 3.2, first row).

### 3.6 Where it shows

The pieces exist for owned dsh approvals only; the change is to feed them
`attention` instead of `approvals`.

| Place | Today | Change |
| --- | --- | --- |
| Session picker (`public/app/main.js`, rows near `:2193-2330`) | state dot + `stateDetail` | amber dot and `NEEDS YOU · permission · Bash`; needs-you rows sort first, then live |
| Agents overview cards (`public/app/agents.js:162-181`) | `⚠ N approvals waiting` for owned dsh | `attention` chip for every source, with `via` in the tooltip; group header shows "N need you" |
| Watch wall pane | `waiting for you` label is shown for **idle** panes (`agents.js:744-745`) | rename that to `ready`; a needs-you pane gets an amber frame and header chip |
| Tab title and favicon badge (`agents.js:890-957`) | count = owned-dsh approvals + "stopped while hidden" | count = needs-you sessions; `(2) ⚠ agenttail`; amber badge; READY uses the existing green `✓` |
| Desktop notification (`agents.js:905-908`, opt-in checkbox) | "Approval needed" for owned dsh; "Agent stopped working" | "Needs you" for any `sure`/`probable` attention with source, branch and tool name; stream mode shows no command text |
| Inbox (new) | none | one list of everything needing you, with Approve/Reject in place for owned sessions; read-only "open session" for the rest |

**A bug to fix with this** (found by reading, not by running): in
`updateDormant` the pane is `quiet` when its state is not `live` **or** it has not
produced output for 60 s (`agents.js:742`, `DORMANT_MS` at `:286`). An agent blocked on
an approval writes nothing, so its wall pane shrinks to a slim column after a minute -
exactly the pane that needs you. Needs-you panes must never be dormant.

Honest limits of notification: it is the browser's Notification API
(`Notification.permission`, only when the page is hidden, `agents.js:905-906`), so
nothing reaches you when the agenttail tab is closed. There is no OS-level toast,
because that would need either a dependency or a PowerShell call from the server.
That could be an opt-in later; not proposed here.

### 3.7 Stream mode and privacy

- Everything above is redacted with the existing `redactor.text`. In stream mode the
  attention object carries reason and tool **name** only; never command text, never
  paths.
- The hook script writes names and times only. The attention spool file lives in the
  config directory, not in any agent's store.
- The new read locations (`~/.claude/sessions/*.json`, `<config>/attention/`) must be
  added to the README "Security and privacy" list. Still no writes outside the config
  directory, still no network.

---

## 4. Stage plan

Effort is focused developer-days including tests, one person. "Tests" lists new
files; existing suites must keep passing at every stage.

| Stage | Scope | Files | Tests | Effort |
| --- | --- | --- | --- | --- |
| **0. Groundwork** | Harness registry + legacy-key shim; split `lib/control.js` into manager / session / registry; `caps` object; approval normaliser (diff + locations, `allow_once` by kind, `origin`); config options generalised beyond `model`; generic error text; stderr tail shown; no behaviour change for dsh | `lib/harness.js` (new), `lib/control.js`, `lib/control-session.js` (new), `lib/acp-normalize.js` (new), `lib/acp.js`, `control.example.json`, `server.js` (descriptor, options), `public/app/control.js` (caps gating, harness picker hidden when only dsh) | existing `control.test.mjs` unchanged and green; new `harness.test.mjs`: registry parse incl. legacy keys, env allowlist, option choice with `allow_always` listed first, diff-only approval, cancel answers pending requests | 3 |
| **1. Needs you (read-only, ships alone as 0.4)** | `lib/attention.js`; producers: dsh open-ask set (add `id`), Claude status-file + transcript rules, Antigravity "none"; `attention` in session lists, `/api/agents` and SSE; UI in picker, overview, wall (fix dormant), title/favicon/notification; owned-session `attention` from ACP map; inbox with approve/reject for owned sessions; README + SECURITY text | `lib/attention.js`, `lib/session-analysis.js`, `lib/claude.js`, `lib/antigravity.js`, `lib/agents.js`, `server.js` (mapping, `/api/agents`, `/api/control/approvals`), `public/app/main.js`, `public/app/agents.js`, `public/app/control.js`, `public/app/app.css` | new `attention.test.mjs` with synthetic fixtures: dsh log with open and closed asks (incl. `unavailable` and crash-while-open), fake `sessions/<pid>.json` (busy, waiting each `waitingFor`, dead pid, unknown shape, `.key` file present and untouched), Claude transcript with open `AskUserQuestion`; `ui.test.mjs` additions: badge count, title, favicon, wall pane not shrinking when needs-you, no command text in stream mode | 5 |
| **1b. Hook helper (optional)** | `scripts/agenttail-hook.mjs` that writes names/times only to the spool; README snippet; reader in `lib/attention.js` | `scripts/agenttail-hook.mjs`, `lib/attention.js`, README | fixture spool lines; script test with piped sample payloads from the hooks doc; never writes `tool_input` | 1 |
| **2. Claude Code over ACP** | Recipe + pin; spawn via `node` + adapter script; presets from `mode`; `owned` for `claude` source; log link and `viewFrom`; images on; resume/take-over with pid check; auth-needed message; ToS paragraph in README; manual checklist on the real adapter (ids, persistence, option order, resume support, auth error) | `lib/harness.js`, `lib/control*.js`, `server.js` (`controlDescriptor`, `sessionsFor` owned flag for claude), `public/app/control.js`, README, `control.example.json` | `test/fake-acp.mjs` grows profiles (`claude-like`: image true, options order variants, diff-only tool calls, plan updates, `resume` or not, transcript writer producing a `.jsonl`); `harness-claude.test.mjs`: begin/message/approve/stop/close, image gating, resume refusal when pid alive, no double rendering (one row, one chat) | 5 |
| **3. `AcpStream` + more harnesses** | `lib/acp-stream.js`, `getStream` branch, `plan` renderer, harness sources in the picker; recipes for OpenCode, Codex, Goose, Gemini; Antigravity ACP recipe after the spike; per-harness "verified on <version>" table in README | `lib/acp-stream.js`, `server.js`, `public/app/main.js` (+ small chat renderer), `docs`, `control.example.json` | `acp-stream.test.mjs`: fixture `session/update` sequences -> events -> editor/console/tree via existing UI harness; redaction of an ACP-only stream; fake `opencode-like` profile with no log | 6 |
| **4. Backlog** | take-over for ACP-only harnesses via `session/list`; elicitation forms; `allowAlways`; process pooling for per-session presets; `PermissionRequest` http-hook authority; Goose HTTP transport | - | - | later |

Total for 0 to 3: about 20 days. Stage 1 can start before stage 0 finishes, since it
touches different files, but the approval-option fix in stage 0 should land first.

### 4.1 Where I would change your staging

- **Split your stage 1.** "Needs you" does not depend on ACP and is useful to everyone
  who never passes `--allow-control`, so it should ship first and alone. ACP control
  beyond dsh is a separate, riskier release.
- **Stage 0 is not optional.** Two issues (Approve choosing the first allow option;
  approval cards that ignore ACP diff content) are harmless with one cooperative
  harness and unsafe with several.
- **Do not add harnesses faster than they can be verified.** The author has dsh,
  Claude Code (desktop) and agy. Everything else is unverified until someone installs
  it. Ship recipes as "unverified" with the checklist, not as supported.
- **Make approvals harness-agnostic before stage 2 (MCP).** The same inbox and
  `origin` field become the human gate for agent-to-agent requests, so cross-agent
  requests do not need a second approval system.
- **Images** are mostly done for control (paste -> ACP image block). What stage 3 of
  the overall plan still owes is the read side (showing images agents produce) and
  per-harness size limits.

---

## 5. Risks

1. **Anthropic terms for the Claude path** (section 1.4). Mitigation: no credential
   handling in agenttail, API-key path documented as the safe one, subscription use
   stated as the user's responsibility, decision recorded in Q1 before stage 2.
2. **Adapter and protocol churn.** The Claude adapter serves a draft v2 on request;
   the ACP SDK just went to 2.0.0 while other adapters use 1.x; the Claude adapter
   moved from `@zed-industries/claude-code-acp` (npm 0.16.2, last published
   2026-03-26) to `@agentclientprotocol/claude-agent-acp`; Codex's old repo is
   archived. Mitigation: always send `protocolVersion: 1`, pin versions in recipes,
   probe capabilities, keep fake-ACP contract tests per profile, treat unknown update
   types as ignorable.
3. **Prompt-injection through approvals.** A hostile file can make an agent request
   something dangerous with a friendly title. Mitigation: raw input first, no
   truncation of commands in the card, `allow_once` only, human click always,
   stream-mode lockout (all already in the project's identity).
4. **Arbitrary program execution from config.** Mitigation: commands only from
   `control.json`, shown in full in the dialog, absolute paths recommended, env
   allowlist for non-dsh harnesses.
5. **Silent persistent grants.** The `allow_always` ordering issue in 2.1 row 3.
   Mitigation: stage 0.
6. **False confidence in "needs you".** Claude's open `tool_use` cannot be told from
   a slow command; Antigravity has no signal. Mitigation: `certainty` field, no
   notification for `guess`, plain README table of what is detectable.
7. **Depending on undocumented files** (`~/.claude/sessions/*.json`). They are not
   the supported interface; a Claude Code update can change them. Mitigation: strict
   validation, pid liveness, fall back silently to transcript rules, covered by tests
   with unknown shapes, and an env override; revisit `claude agents --json` if it
   breaks.
8. **Reading a `*.key` file by accident.** Mitigation: list directory entries by exact
   `<digits>.json` pattern only.
9. **Id mismatch between ACP and the log** (Claude). If the adapter's session id is
   not the transcript id, `viewFrom` falls to `acp` and the row would appear twice
   (log row + owned row). Mitigation: lookup by cwd + start time as a second key, and
   the stage 2 manual check before anything ships.
10. **Resource use.** One adapter plus one Claude Code process per session. Keep
    `maxSessions` low by default; pooling is backlog.
11. **ACP-only sessions vanish with the agenttail process** (by design, no bodies on
    disk). Users may expect history. Say it in the UI.
12. **Windows launch details.** `.cmd` shims, `npx` cold start (initialize timeout is
    already 150 s), `taskkill /T` for process trees. Prefer `node.exe` + script.
13. **Hook-spool privacy.** Mitigation: the helper script strips inputs; documented.
14. **Image limits** differ per adapter and are unknown; show the agent's error.

---

## 6. Open questions for the author

- **Q1. Claude Code and the Agent SDK terms.** Do you want the Claude recipe to
  document API-key authentication only, or also tell users they may sign in with their
  own subscription (their responsibility)? Or should Claude control use the real
  `claude -p` stream-json protocol instead of the ACP adapter?
- **Q2. New read locations by default.** Is it acceptable that the default read-only
  mode starts reading `~/.claude/sessions/<pid>.json` (status only) for "needs you",
  and that the README says so? Alternative: off unless `--attention` is passed.
- **Q3. ACP-only sessions are in memory.** Keep that (consistent with "never writes
  message bodies"), or allow an opt-in export (Markdown, like the existing **MD**
  button) so history survives a restart?
- **Q4. Hooks.** May agenttail ship a hook script and snippet (user installs them),
  given it will never edit `~/.claude/settings.json` itself? And is a future
  `PermissionRequest` http-hook authority for non-owned Claude sessions in scope at all?
- **Q5. Audit detail.** Digest-only for approved commands (my default), or titles in
  clear behind `auditDetail`? Should `approve-always` exist at all?
- **Q6. Process model.** Stay with one child per owned session until presets move to
  `set_config_option` everywhere, or pool earlier to save memory?
- **Q7. Which harnesses can you verify?** You have dsh, Claude (desktop) and agy.
  Will you install OpenCode (and the Antigravity ACP server) to run the checklist?
  Without that, they ship as documented-but-unverified recipes.
- **Q8. Antigravity spike.** Will you run the 30-minute approval-prompt spike in 3.5?
  It decides whether Antigravity can ever raise "needs you" without ACP.
- **Q9. Resume policy.** Is "take over an idle session of a configured harness" wanted
  in the first Claude release, given resume support in the v1 adapter is unconfirmed?

---

## 7. Sources

ACP spec (all fetched 2026-10-21):
- https://agentclientprotocol.com/protocol/overview
- https://agentclientprotocol.com/protocol/initialization
- https://agentclientprotocol.com/protocol/transports
- https://agentclientprotocol.com/protocol/session-setup
- https://agentclientprotocol.com/protocol/session-list
- https://agentclientprotocol.com/protocol/session-config-options
- https://agentclientprotocol.com/protocol/prompt-turn
- https://agentclientprotocol.com/protocol/tool-calls
- https://agentclientprotocol.com/protocol/content
- https://agentclientprotocol.com/protocol/schema
- https://agentclientprotocol.com/get-started/registry
- https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- https://agentclientprotocol.com/overview/agents

Harnesses and adapters:
- https://github.com/agentclientprotocol/claude-agent-acp (README, `src/permissions/modes.ts`, `src/permissions/options.ts`, `src/acp-agent.ts` partial)
- https://github.com/agentclientprotocol/codex-acp and https://github.com/zed-industries/codex-acp
- https://geminicli.com/docs/cli/acp-mode/
- https://opencode.ai/docs/acp/
- https://goose-docs.ai/docs/gdk/acp/ and https://goose-docs.ai/docs/gdk/acp/reference
- https://zed.dev/acp/agent/antigravity-acp and https://github.com/jiridanek/agy-acp (community, secondary)
- https://github.com/agentclientprotocol/agent-client-protocol/issues/77 (secondary, Gemini capabilities snapshot)
- https://github.com/ogulcancelik/herdr (herdr: "every pane is marked working, blocked, or idle"; how it detects states is not stated on the page, third-party write-ups say process names and terminal output patterns, and disagree on the licence; not verified)

Claude Code:
- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/hooks (Notification types, PermissionRequest, Stop, http handler)
- https://code.claude.com/docs/en/hooks-guide
- https://code.claude.com/docs/en/agent-view (status values, `claude agents --json`, `waitingFor`)
- https://code.claude.com/docs/en/sessions (transcript path, resume, fork)
- https://code.claude.com/docs/en/headless (stream-json, permission prompts)
- https://code.claude.com/docs/en/agent-sdk/user-input (`canUseTool`, `AskUserQuestion`)

Local, read-only checks (2026-10-21): `where` for the CLIs; `agy --help`; `npm view` on
`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`,
`@zed-industries/*`, `@google/gemini-cli`, `opencode-ai`, `@agentclientprotocol/sdk`,
`@anthropic-ai/claude-agent-sdk`; entry-type counts over the 25 most recently
modified Claude transcripts and over 40 dsh logs; key listing of
`~/.claude/sessions/*.json` (values not copied; `*.key` files not opened); listing of
`~/.gemini/antigravity` and entry-status counts of its single transcript.

## Appendix: what I could not verify

- Any real `initialize` response from any adapter other than dsh.
- Whether the Claude adapter's ACP `sessionId` equals the Claude Code session id,
  whether its sessions persist a `.jsonl`, whether v1 supports `session/load` or
  `resume`, its Windows behavior, and its auth error shape.
- `status: waiting` and `waitingFor` in `~/.claude/sessions/*.json` (documented via
  `claude agents --json`, never seen in a file here).
- Whether dsh Desktop flushes `approval/asked` before the human answers.
- Any Antigravity signal for an open permission prompt; what `presence/*.lock` means.
- ACP `elicitation/create` shape and how adapters treat clients that do not declare it.
- Gemini CLI's and OpenCode's and Goose's actual declared capabilities.
- Licences: dsh not checked; Claude adapter reported differently by npm and the
  registry; herdr reported differently by its page and by third parties.
