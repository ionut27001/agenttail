# Hub current state: ACP client and control plane

Read-only map of agenttail `0.3.0` (`package.json:3`). Sources: `lib/acp.js`,
`lib/control.js`, control endpoints in `server.js`, `public/app/control.js`,
`test/control.test.mjs`, `test/ui-control.test.mjs`, `docs/dev/input-design.md`,
plus `test/fake-acp.mjs` and `test/fixture.mjs` where they define what the tests
actually exercise. Tests were not run. No code was changed.

**Short version:** agenttail owns one local `dsh --profile acp` child per
controlled session, speaks a small newline-delimited JSON-RPC subset, and keeps
the ACP control channel separate from the read side. The page still renders the
conversation from dsh's own `session.v4.jsonl.zstd` log; ACP supplies only
approvals and run state. Only dsh sessions can be controlled; Claude Code and
Antigravity are read-only viewers (`server.js:84-88`, `package.json:4`).

## 1. The ACP client in `lib/acp.js`

### 1.1 Transport and framing

- `AcpClient` is hand-written, not the ACP SDK, because the project has no
  runtime dependencies (`lib/acp.js:3-11`; `package.json` has no `dependencies`).
- It spawns a child with `stdio: ['pipe','pipe','pipe']` and `windowsHide: true`
  (`lib/acp.js:49-55`). On Windows a non-`.exe`/`.com` binary, or a `.cmd`/`.bat`,
  is run through a shell with `quoteWin()` quoting (`lib/acp.js:19-23,47-61`).
- Wire format: **newline-delimited JSON-RPC 2.0 over stdout/stdin**. No
  `Content-Length` header and no framing beyond `\n`:
  - reads chunks, splits on `\n`, strips a trailing `\r`, skips blank lines,
    `JSON.parse`s each line (`lib/acp.js:86-107`);
  - malformed lines emit `protocol-error` and are dropped (`lib/acp.js:99-103`);
  - a buffer larger than `MAX_LINE = 8 MiB` emits `error` and kills the child
    (`lib/acp.js:16,88-92`);
  - writes are `${JSON.stringify(message)}\n` (`lib/acp.js:147-152`);
  - stderr is decoded and the last `STDERR_KEEP = 8 KiB` is retained
    (`lib/acp.js:17,66-69`). Nothing in `lib/control.js` ever reads
    `client.stderr`, so child diagnostics are not surfaced. A `protocol-error`
    only sets `lastError`; it does not itself emit state
    (`lib/control.js:260-262`).
- Message classification (`lib/acp.js:109-133`):
  - `id` + `method` => server-to-client request, emitted as `request`;
  - `method` only => notification, emitted as `notification`;
  - `id` only => response; looked up in `this.pending`; `error` becomes an
    `Error` with `.code`/`.data`; unknown ids are ignored.
- Requests get monotonically increasing ids from 1 and an optional
  `timeoutMs`; timed-out entries are removed and rejected with
  `code = 'ETIMEDOUT'` (`lib/acp.js:35,154-174`). Notifications and responses
  are `notify()`/`respond()`/`respondError()` (`lib/acp.js:176-186`).
- On child exit every pending request is rejected with
  `dsh ACP exited (...)` (the text is hard-coded, `lib/acp.js:135-145`);
  `exit` is emitted and `exitWaiters` are resolved.
- `close()` closes stdin, waits at most 1.5 s for exit, then `kill()`s
  (`lib/acp.js:188-204`). On Windows `kill()` uses `taskkill /pid <pid> /T /F`
  because `dsh.cmd` makes the pid a shell (`lib/acp.js:206-220`).

### 1.2 ACP methods sent and handled

All application-level calls live in `lib/control.js`; `lib/acp.js` is the
transport.

| Direction | Method | Where | Notes |
| --- | --- | --- | --- |
| client -> agent | `initialize` | `lib/control.js:266-270` | `protocolVersion: 1`; `clientCapabilities.fs.readTextFile = false`, `.writeTextFile = false`; `clientInfo = { name:'agenttail', version }`; 150 s timeout. |
| client -> agent | `session/new` | `lib/control.js:274-277` | `cwd` (absolute, realpathed workspace), `mcpServers: []`; 150 s timeout. Reads `sessionId` and `configOptions`. |
| client -> agent | `session/prompt` | `lib/control.js:484-487` | `sessionId` + `prompt` array of `{type:'text',text}` and image blocks; **no timeout** (only child exit or close rejects it). One prompt in flight per session. |
| client -> agent | `session/cancel` | `lib/control.js:520` | Notification, not a request; no reply. |
| client -> agent | `session/set_config_option` | `lib/control.js:445-449` | `configId:'model'`, `value`; 30 s timeout. Reads returned `configOptions`. |
| client -> agent | `session/close` | `lib/control.js:537` | 5 s timeout; sent unconditionally when closing. |
| agent -> client | `session/update` | `lib/control.js:334-366` | Only `tool_call`/`tool_call_update` (one branch, merged into `this.toolCalls`, max 500, used to enrich pending approvals) and `config_option_update` (replaces model catalog/current when the update yields a non-empty catalog) are handled. Everything else is ignored. |
| agent -> client | `session/request_permission` | `lib/control.js:368-399` | Stored as an approval, emitted as `approval`, shown in state as `approvalCount`. |
| client -> agent | permission response | `lib/control.js:375,420-428` | `{ outcome: { outcome:'selected', optionId } }`, `{ outcome:{ outcome:'cancelled' } }`, or an error for unmatched options (409, `lib/control.js:419-425`). A reject reason is added as `_meta.reason` (`lib/control.js:427`). |
| any | unknown request method | `lib/control.js:369-371` | Responds JSON-RPC error `-32601` (`method not supported by agenttail`). |

**Not implemented anywhere:** `session/load`, `session/resume`, `session/list`,
`authenticate`/`logout`, `fs/read_text_file`, `fs/write_text_file`,
`terminal/*`, elicitation, and any plan/command update handling. There is no
ACP method for model selection other than `session/set_config_option` with
`configId:'model'`. dsh supports `session/list`/`session/resume` according to
`docs/dev/input-design.md:53-66`, but agenttail never calls them.

### 1.3 Capabilities and negotiation

- The client declares only `protocolVersion: 1` and disabled filesystem
  read/write (`lib/control.js:266-270`). It does **not** declare terminal,
  elicitation, or any other client capability. Since the default is absent/false,
  an agent cannot use client fs/terminal callbacks through this client.
- From the `initialize` result it reads only
  `agentCapabilities.promptCapabilities` and stores it as `promptCaps`
  (`lib/control.js:271-273`); the only field consulted is `.image`
  (`lib/control.js:319,465`).
- `agentCapabilities.sessionCapabilities`, `authMethods`, `protocolVersion`
  returned by the agent, and `agentInfo` are ignored.
- `promptCaps.image` is exposed to the page as `state.images`
  (`lib/control.js:319`). A real dsh is described in-code as **not** declaring
  image prompts (`lib/control.js:271`), so images are off there; the test fake
  declares `image: true` (`test/fake-acp.mjs:152`).

## 2. What is generic ACP vs specific to DeepSeek Harness

### 2.1 Generic parts

- JSON-RPC 2.0/stdin framing, request ids, timeouts, notification dispatch,
  permission replies (`lib/acp.js`).
- ACP method names and payload envelopes: `initialize`, `session/new`,
  `session/prompt`, `session/cancel`, `session/close`,
  `session/request_permission`, `session/update`.
- Content blocks: `{type:'text',text}` and `{type:'image',mimeType,data}`
  (`lib/control.js:30-42,484-487`).
- Config-option update envelope (`config_option_update` +
  `configOptions`), although the model-specific parsing is not generic.
- The control/security shell: one child per session, HTTP token, workspace
  allowlist, audit log, SSE side channel.

### 2.2 DeepSeek-Harness-specific parts

| Concern | What the code assumes | Where |
| --- | --- | --- |
| Executable | Default `dsh`; optional `AGENTTAIL_DSH_BIN`/`dshCommand` | `lib/acp.js:28`; `lib/control.js:250` |
| Profile | Default `acp`; `--profile <name>` is always passed; optional `--patch <file>` | `lib/acp.js:30,45-46`; `lib/control.js:151-155` |
| Prefix args | `dshArgs` from `control.json`, else JSON array in `AGENTTAIL_DSH_ARGS` | `lib/control.js:153,251,562-570` |
| Environment | `DSH_PERMISSION_MODE=<preset>` and optional `DSH_HOME` | `lib/control.js:242-248` |
| Config file | `dshProfile`, `dshCommand`, `dshArgs`, `dshHome`, `patch` keys under `control.json` | `lib/control.js:151-155` |
| Permission presets | `read-only`, `workspace-write`, `danger-full-access`; default `workspace-write`; `danger-full-access` requires `confirmDanger === true` | `lib/control.js:20-21,594-599` |
| Preset semantics | Preset is process-level via `DSH_PERMISSION_MODE`, not an ACP option; docs record dsh's sandbox/approval mapping | `docs/dev/input-design.md:25-34,148-175` |
| Model catalog | First `configOptions` entry with `id === 'model'`; nested `options` groups; `currentValue`; provider/model from a JSON `["provider","model"]` string, with a `provider/model` fallback | `lib/control.js:48-89,282-285` |
| Model switch | `session/set_config_option` with `configId:'model'`; value must already be in the advertised catalog | `lib/control.js:441-455` |
| Session id | The ACP `sessionId` becomes both the agenttail session id and the viewer id (`this.id = this.acpId`); no separate temporary id | `lib/control.js:278-281` |
| Session id shape | Bare UUID expected by the dsh log scanner; `session-<uuid>` also accepted for Desktop-created sessions | `server.js:117-120`; `docs/dev/input-design.md:95-99` |
| Approval details | Permission request carries only `toolCall.toolCallId`; the matching `tool_call` update (title/rawInput) is assumed to arrive first. Extracts `raw.command`, `raw.file_path/path`, `raw.old_string/new_string`, plus a fixed `keep` key list | `lib/control.js:378-383,98-127` |
| Approval options | Maps `approve` to `allow_once`/`allow_always`, `reject` to `reject_once`/`reject_always`, with a `/reject/i` fallback | `lib/control.js:414-418` |
| Reject reason | ACP has no standard reason; code sends `_meta.reason`; docs say dsh ignores it, so it is audit/UI-only | `lib/control.js:427`; `docs/dev/input-design.md:177-180` |
| Images | ACP `promptCapabilities.image` gate, but the user-facing text says dsh ACP has no image prompts; real dsh behavior is not exercised in repo | `lib/control.js:271-273,465`; `public/app/control.js:210` |
| Error strings | `dsh ACP exited`; `could not start dsh ACP`; UI `Starting dsh…` | `lib/acp.js:137`; `lib/control.js:551,615`; `public/app/control.js:474` |

### 2.3 DSH log-file coupling (the control plane itself does not read logs)

`lib/control.js` reads only `control.json` and writes only the audit log; it
never opens a dsh session log. The **viewer** does, and that is where the
coupling is:

- dsh sessions root defaults to `~/.dsh/sessions` (`DSH_SESSIONS_ROOT`
  overrides) (`server.js:53-54`).
- `listSessions()` scans `<SESSIONS_ROOT>/<workspaceDir>/<sessionId>/session.v4.jsonl.zstd`
  and only accepts ids matching `isSessionId` (`server.js:318-348`,
  `server.js:117-120`).
- `serveStream()` sends the log-derived events; the control channel only adds
  `control`, `approval`, `approvalDone`, `controlError` (`server.js:1197-1238`).
  Its own comment says commands, messages and results are rendered from the dsh
  log (`server.js:1197-1199`).
- An owned dsh session is marked `owned` in the session list only when
  `control.has(rec.id)` and the record was found in dsh's log index
  (`server.js:388`). `/api/stream` has a special 8 s wait for the log record of
  an owned ACP id (`server.js:1703-1709`, `server.js:1133-1141`).
- The agents overview attaches pending approval counts only for source `dsh`
  (`server.js:108-112`).
- The test fake writes a real dsh-shaped zstd log so the read side is
  exercised (`test/fake-acp.mjs:63-74,32-35`), and the control test reads it to
  verify image delivery (`test/control.test.mjs:331-336`).

Consequence: an ACP harness that does not persist dsh's v4 zstd log will have
control state but no conversation/events on the existing page, and its id will
not appear in `/api/sessions?source=dsh`.

## 3. Control flow, end to end

### 3.1 Opt-in and setup

- Control exists only with `--allow-control` (`server.js:72-82`); otherwise all
  `/api/control/*` paths return 404 (`server.js:1554-1557`).
- Stream mode is on by default; `--no-stream-mode` or `STREAM_MODE=off` turns it
  off (`server.js:69-70`). Control is hard-locked while stream mode is on.
- Token is 32 random bytes base64url, generated only with the flag; only its
  SHA-256 hash is kept (`server.js:76-79`). It is printed in the startup URL
  fragment (`#token=…`) only when control is unlocked (`server.js:1802-1808`).
- `ControlManager` uses `AGENTTAIL_CONTROL_FILE`/`DSH_CONTROL_FILE` and
  `AGENTTAIL_CONTROL_AUDIT_FILE`/`DSH_CONTROL_AUDIT_FILE`, defaulting to
  `control.json` and `control-audit.log` in the per-user config directory
  (`server.js:74-82`).

### 3.2 HTTP surface

All POSTs pass the global Host check and the Origin/Content-Type check before
routing (`server.js:1543-1566`); control POSTs then require the bearer token
(`server.js:1395-1399`).

| Endpoint | Auth | Handler | Effect |
| --- | --- | --- | --- |
| `GET /api/control/status` | none | `server.js:1568-1577` | `enabled`, `streamMode`, `locked`, `presets`, `defaultPreset`; still 200 when locked. |
| `GET /api/control/options` | Bearer | `server.js:1606-1618` -> `1373-1388` | allowlisted workspaces (path + label), presets, default, `dshProfile`. |
| `POST /api/control/session/begin` | Bearer | `server.js:1409-1417` -> `lib/control.js:594-630` | Validate preset/danger, resolve workspace, enforce max, spawn ACP child, `initialize` + `session/new`, return state/models/current. |
| `POST /api/control/session/start` | Bearer | `server.js:1418-1432` -> `lib/control.js:632-643` | Optional model switch, then first prompt; requires non-empty message and `MAX_MESSAGE`. |
| `POST /api/control/message` | Bearer | `server.js:1433-1437` -> `lib/control.js:645-655` | Validate text/images, run or queue one message, audit. |
| `POST /api/control/approval` | Bearer | `server.js:1438-1449` -> `lib/control.js:665-675` | `approve`/`reject`, optional reason sliced to 500, answer ACP, audit. |
| `POST /api/control/model` | Bearer | `server.js:1450-1454` -> `lib/control.js:657-663` | Switch advertised model, audit. |
| `POST /api/control/stop` | Bearer | `server.js:1455-1459` -> `lib/control.js:677-682` | Cancel running turn, drop queue, audit. |
| `POST /api/control/close` | Bearer | `server.js:1460-1464` -> `lib/control.js:684-690` | `session/close`, stop child, delete from manager, audit. |
| `GET /api/stream?source=dsh&id=…` | none | `server.js:1703-1721` | Viewer SSE; adds the control descriptor in `meta` and control/approval events. |

Body limits: 32 MiB for `/api/control/message` (images), 64 KiB for every other
control POST (`server.js:1400-1407`). Errors return `err.status || 500`
(`server.js:1466-1468`).

### 3.3 Begin: HTTP -> ControlSession -> ACP

1. `ControlManager.begin()` validates `preset` against `PRESETS`, requires
   `confirmDanger === true` for `danger-full-access`, resolves the workspace,
   and checks `sessions.size >= config.maxSessions` (`lib/control.js:594-601`).
2. `ControlConfig.resolveWorkspace()` realpaths the requested path, stats it as
   a directory, realpaths each `workspaces` entry, and accepts the first entry
   where `isInside(real, wsReal)`; otherwise 403 (`lib/control.js:175-193`).
3. `new ControlSession({cwd: real, preset, config, audit})` is created and
   `start()`ed (`lib/control.js:602-613`).
4. `start()` builds `env = {...process.env, DSH_PERMISSION_MODE: preset}`, adds
   `DSH_HOME` if configured, constructs `AcpClient` with bin/prefixArgs/profile/
   patch/cwd/env, attaches `notification`, `request`, `exit`, and
   `protocol-error` listeners, then spawns (`lib/control.js:242-262`).
5. It sends `initialize` then `session/new`, stores `this.acpId` and `this.id`
   from the returned `sessionId`, parses `configOptions` into `models`/
   `modelValue`, sets `status = 'idle'`, and emits `state`
   (`lib/control.js:264-288`).
6. On failure it sets `status='error'`, emits state, closes the client, and the
   manager wraps the error as 502 (`lib/control.js:289-295,612-616`).
7. The manager stores the session by id, appends the `start` audit record, and
   returns `{session, models, currentModel}` (`lib/control.js:617-629`).

### 3.4 Prompt, queueing, turn end

- `send(text, images)` validates images, non-empty text, `MAX_MESSAGE`, image
  capability, and live/controllable state. If a turn is running it stores at most
  one `queued` message; otherwise it calls `_runPrompt()` (`lib/control.js:460-475`).
- `_runPrompt()` sets `running=true`, `status='running'`, `turnStartedAt`, then
  sends `session/prompt` with text first and image blocks after. On resolve it
  records `result.stopReason`, goes idle (or closed), emits `turn-end` and
  `state`; on request failure it sets `lastError`, emits `error`/`state`; in
  `finally` it starts a queued message if still live (`lib/control.js:477-506`).
- Queueing is one-deep: a second message while queued is 409
  (`lib/control.js:467-471`). A stop or close clears the queue
  (`lib/control.js:510-513,529`).
- `session/prompt` has no timeout, so a misbehaving child can leave the session
  `running` until it exits or is stopped.

### 3.5 Approvals

- Agent request `session/request_permission` with a matching/absent `sessionId`:
  mismatched session gets `{outcome:{outcome:'cancelled'}}` (`lib/control.js:373-377`).
- `toolCall.toolCallId` is looked up in the `toolCalls` map; the request's own
  `toolCall` object wins over the tracked update
  (`lib/control.js:378-383`).
- `approvalDetails()` builds `title`, `kind`, `toolCallId`, `command`, `diff`,
  `content` (truncated to 20 k) and a `rawInput` subset with values over 8 k
  truncated (`lib/control.js:98-127`).
- Approval id is the JSON-RPC request id as a string; `rpcId` is kept privately.
  The public form omits `rpcId` (`lib/control.js:389-398,572-585`).
- `resolveApproval()` picks an option by `kind`, sends the selected option id,
  adds `_meta.reason` only for reject, deletes the approval, emits
  `approval-done` and state (`lib/control.js:410-439`). If no matching option
  exists it responds `cancelled`, emits `approval-done`, and throws 409
  (`lib/control.js:419-425`).
- `stop`/`close` respond `cancelled` to every pending approval and emit
  `approval-done` (`lib/control.js:515-519,530-534`). Child exit clears the map
  and emits `approval-done` for each (`lib/control.js:553-557`).
- Late `tool_call`/`tool_call_update` updates can enrich an approval that still
  has no command/diff/content (`lib/control.js:347-353`).

### 3.6 Model switch

- `applyModel(value)` requires the value to be in the current `models`, calls
  `session/set_config_option`, optionally refreshes `models` from the result,
  sets `modelValue`/provider/model, emits state, and returns it
  (`lib/control.js:441-458`).
- A `config_option_update` notification can replace the catalog/current model
  mid-session when it yields a non-empty catalog (`lib/control.js:357-365`).
- `session/start` applies the model before the first prompt
  (`lib/control.js:632-635`).

### 3.7 Stop and end

- `cancel()` throws 409 if closing/exited; drops any queued message; if not
  running returns `{cancelled:false}`; otherwise cancels pending approvals and
  sends the `session/cancel` notification (`lib/control.js:508-523`).
- `close()` sets `closing`, drops the queue, cancels approvals, sends
  `session/close` (5 s, best-effort), then `client.close()` (1.5 s grace then
  kill), sets `status='closed'`, emits state and `closed`
  (`lib/control.js:525-544`).
- `_onExit()` records the exit, marks `exited` unless already closing, clears
  approvals, emits state and `exit` (`lib/control.js:546-559`).
- `ControlManager.close()` deletes the session immediately and audits
  (`lib/control.js:684-690`); `_onSessionState()` otherwise schedules deletion
  2 s after `closed`/`exited` so an SSE subscriber can see the final state
  (`lib/control.js:708-718`). A reconnect after close therefore sees
  `reason:'external'` (view-only), not a remembered `closed` state.

### 3.8 Events back to the page

`ControlSession` emits `state`, `approval`, `approval-update`,
`approval-done`, `turn-end`, `error`, `exit`, `closed`
(`lib/control.js:287,351,363,397,422,436,491,497,543,557-558`).

`serveStream()` includes `controlDescriptor(record)` in the initial `meta`
event (`server.js:1171-1195,1084-1097`), replays pending approvals
(`server.js:1199-1201`), and, only for an owned dsh session, subscribes to the
session and maps events to SSE:

- `state` -> `control`
- `approval` / `approval-update` -> `approval` (redacted via `safeApproval`)
- `approval-done` -> `approvalDone`
- `error` -> `controlError`

(`server.js:1224-1238`; redaction `server.js:1099-1122`). The descriptor is
`null` without control; for non-dsh it returns `viewOnly`, `reason:'source'`;
for dsh not owned, `viewOnly`, `reason:'external'`; for owned, the full
`statePayload` (`server.js:1084-1097`).

### 3.9 Security checks

| Check | Behavior | Where |
| --- | --- | --- |
| Opt-in | No `/api/control/*` route without `--allow-control` | `server.js:72-82,1554-1557` |
| Token | 32 random bytes base64url; SHA-256 hash held; `Authorization: Bearer` must match `^[A-Za-z0-9_-]{20,}$`; `timingSafeEqual`; printed only in the startup fragment | `server.js:76-79,1124-1131,1802-1808` |
| Browser token handling | `sessionStorage`, hash stripped with `history.replaceState` | `public/app/control.js:5-13` |
| Host | Exact allowlist `127.0.0.1:<PORT>` and `localhost:<PORT>`, checked on every request | `server.js:1543-1550` |
| Origin | Every POST must have `Origin === http://<allowed host>` and `Content-Type: application/json`; otherwise 403 | `server.js:1559-1566` |
| Stream-mode lockout | Default on; control/options endpoints 403 before auth; status reports `locked`; token not printed | `server.js:69-70,1373-1377,1390-1394,1568-1575,1606-1610,1802-1805` |
| Workspace allowlist | `control.json.workspaces` entries (string or `{path,label}`), resolved relative to the config file, both sides `realpath`ed, `isInside` check; 403 outside | `lib/control.js:136-173,175-193`; `lib/util.js:6-16` |
| Danger preset | `danger-full-access` requires `confirmDanger === true` | `lib/control.js:596-599`; `server.js:1409-1414` |
| Audit | JSONL append, mode `0600` at creation, serialized chain, failures swallowed; actions/fields listed below | `lib/control.js:196-212` |
| Max sessions | Default 8, config `maxSessions` clamped to 1..32, checked before spawn | `lib/control.js:24,156-158,601` |
| Request size | 32 MiB for message, 64 KiB for other control POSTs | `server.js:1400-1407` |

Audit contents: `start` (sessionId, preset, cwd, model, provider), `message`
(sessionId, chars, images, queued, first), `model`, `approve`/`reject`
(approvalId, hadReason, reasonLength), `stop` (cancelled), `close`
(`lib/control.js:618-674`). Message bodies, reject reasons and image data are
never written (`test/control.test.mjs:351-355`).

Notable boundaries: `GET /api/control/status` and `GET /api/stream` are
unauthenticated (they rely on the loopback bind and Host check); `GET
/api/control/options` requires the token. There is no rate limit and no token
rotation. The Host/Origin checks compare against the request's own Host header,
but the Host itself is allowlisted first, so a DNS-rebinding request with a
foreign Host is rejected before the Origin check (`server.js:1543-1566`).

### 3.10 Limits and edge conditions

- `MAX_SESSIONS = 8`; configured cap 32 (`lib/control.js:24,156-158`). The
  check at `lib/control.js:601` is not atomic with `sessions.set()` at
  `lib/control.js:617`, so concurrent `begin` calls can overshoot the cap.
- `MAX_MESSAGE = 32 KiB` characters (`lib/control.js:22,464`);
  `MAX_IMAGES = 4`, `MAX_IMAGE_BYTES = 5 MiB`, types PNG/JPEG/GIF/WebP
  (`lib/control.js:25-27,30-42`); `MAX_REASON = 500`
  (`lib/control.js:23,427`).
- One prompt in flight and at most one queued message per session
  (`lib/control.js:467-471`); ACP output line limit 8 MiB, stderr retention
  8 KiB (`lib/acp.js:16-17`).
- Timeouts: initialize/session-new 150 s, model switch 30 s, session close
  5 s, graceful stdin-close wait 1.5 s (`lib/control.js:270,277,449,537`;
  `lib/acp.js:198-202`). `session/prompt` has none.
- Tool-call cache is capped at 500 (`lib/control.js:346`); approval detail
  truncates title 300, raw string values 8 k, content 20 k
  (`lib/control.js:116-124`).
- One child per owned session; no idle timeout; children live until
  `close`/exit/server shutdown (`lib/control.js:702-706`; `server.js:1817-1825`).

## 4. Page side (`public/app/control.js`)

### 4.1 Composer and state

- Token is read from `location.hash` once, stored in `sessionStorage`, and the
  fragment is removed (`public/app/control.js:5-13`). `controlStatus()` fetches
  `/api/control/status` without the token (`36-46`).
- `controlFetch()` adds `Authorization: Bearer` to every control request and
  turns non-2xx JSON into an `Error` with `.status` (`48-60`).
- `updateControlChrome()` decides visibility: New Session when
  `enabled && !locked && token`; composer when the current session is `owned`,
  `controllable !== false`, unlocked, and a token exists. Hints cover stream
  mode, external dsh session, ended owned session, missing token
  (`69-110`).
- Composer sends on Enter, Shift+Enter inserts a newline, auto-grows to 150 px,
  and posts to `/api/control/message` with `{id: state.sessionId, text, images}`
  (`365-388,647-657`). It shows "queued" from the server response or state
  (`103-104,380-383`).
- Stop posts `/api/control/stop`; End confirms then posts `/api/control/close`
  (`390-416`). The page expects the SSE `control` event to supply subsequent
  running/queue/ended state.

### 4.2 Approvals

- The page keeps an array but renders **only the first** approval
  (`control.approvals[0]`, `313-335`); the badge shows the total count
  (`328-330`).
- Detail text chooses in this order: `command` -> `$ …`; `diff` -> path plus
  `-`/`+` lines; `content`; `rawInput` JSON; title (`300-311`).
- Approve/Reject post `{id, approvalId, decision, reason}`; reject sends the
  textarea reason, then the card is removed optimistically after a successful
  POST (`337-363`). Only one request is allowed at a time via `control.busy`.
- SSE `approval` upserts by `approvalId`; `approvalDone` removes and reports
  the decision; `controlError` sets the error status (`272-289`).

### 4.3 Model picker

- Rendered from `control.current.models`; hidden when fewer than two; grouped
  by `model.provider || 'other'`; option `value` is the opaque ACP value and
  option text is `model.name || model.value` (`113-145`).
- Change posts `/api/control/model` with `state.sessionId`; it merges the
  returned `session` into `control.current` and shows
  `provider/model` (`147-167`). It does not refresh the catalog from a separate
  endpoint.
- The page comment says switching applies "to the next turn" (`112`); the
  server sends `session/set_config_option` immediately
  (`lib/control.js:445-449`). The code does not say whether a turn already in
  flight observes the new value.

### 4.4 Image paste

- Paste listener extracts image files, prevents the default paste, and calls
  `addImages()` (`638-646`).
- `addImages()` refuses unless `control.current.images === true`; limits 4
  attachments, PNG/JPEG/GIF/WebP, 5 MiB each; reads as data URL and strips the
  prefix; renders thumbnails with name/size and remove buttons
  (`170-226`).
- On successful send, attachments are cleared; the POST sends only
  `{mimeType, data}` (`365-388`).

### 4.5 New Session dialog

- Step 1 lists `/api/control/options` workspaces, presets, and
  `profile: ${data.dshProfile || 'acp'}` (`419-459`).
- `continueNewSession()` posts `/api/control/session/begin` with
  `{cwd, preset, confirmDanger}`; a cancel during the request later calls
  `/api/control/close` (`461-523,562-580`).
- Step 2 shows the model catalog returned by `begin` and the first message;
  `startNewSession()` posts `/api/control/session/start` with
  `{id, model, message}`, then forces `state.source='dsh'`, reloads the session
  list, opens the id, and says "waiting for the first log frame"
  (`525-560`).

### 4.6 What the page assumes about the agent

- The global `state` object and helpers from `main.js`: `state.sessionId`,
  `state.source`, `state.session`, `state.historyDone`, `state.preset`,
  `renderStats`, `loadSessions`, `openSession`, `fmtInt`, `cssVar`
  (`public/app/main.js:816-847,1895-1936`; `public/app/control.js:106,157,
  233-245,349,374,409,547-551,589-603`).
- `bindControlStream(es)` is called before the page's own `meta` listener
  (`public/app/main.js:1895-1899`); the control UI lives entirely off the
  existing `/api/stream` SSE, not a separate control socket.
- The control descriptor fields: `enabled`, `locked`, `owned`, `controllable`,
  `status`, `running`, `queued`, `images`, `models`, `modelValue`, `provider`,
  `model`, `error`, `lastStopReason` (`lib/control.js:305-328`).
- An owned, live session is addressable by `state.sessionId` and accepts
  message/approval/model/stop/close with that id; the page has no harness field
  and no per-harness branching beyond `state.source === 'dsh'` in the hint
  (`public/app/control.js:86`).
- The conversation will appear through the dsh log. The page calls
  `loadSessions`/`openSession` after start and explicitly says it is waiting for
  the first log frame (`547-552`); approval detail is the only ACP tool content
  it renders directly.
- The agent offers at least one model; if none, the dialog shows an error but
  does not hard-block Start (`507-514`; `startFirst` skips `applyModel` when
  `model` is falsy, `lib/control.js:632-635`).
- Presets are exactly the three server-provided values, and
  `danger-full-access` needs the checkbox (`lib/control.js:20-21`;
  `public/app/control.js:467-470`).
- Approval options are abstracted away by the server: the page only sends
  `approve`/`reject` and never displays the ACP `options` list
  (`public/app/control.js:337-363`).

## 5. To support another harness we would need to change

Sizes are rough: **S** = localized edit, **M** = new abstraction or several
call sites, **L** = new subsystem/event pipeline or a cross-cutting refactor.

| # | Change | Where it lives today | Size |
| --- | --- | --- | --- |
| 1 | A harness descriptor/config schema (id, command, prefix args, profile, env, cwd policy) instead of the hard-coded `dsh` + `--profile` + `DSH_*` defaults and all-dsh `control.json` keys | `lib/acp.js:28-61`; `lib/control.js:151-155,242-256`; `control.example.json`; `server.js:74-82,1373-1388` | M |
| 2 | Per-harness ACP capability negotiation: auth, fs/terminal client callbacks, `sessionCapabilities.close/list/resume`, prompt image/audio/embedded-context. Today only `promptCapabilities.image` is read and fs is hard-disabled | `lib/control.js:266-273` | M |
| 3 | Model-catalog adapter. Today `id === 'model'`, nested grouping, JSON `[provider,model]` and `provider/model` parsing, and `configId:'model'` are assumed | `lib/control.js:48-89,282-285,441-458`; `public/app/control.js:113-167` | M |
| 4 | Permission-preset and approval-mapping abstraction. Today presets are dsh env modes; approval details come from dsh `rawInput` keys; one-shot option kinds are assumed; reject reason is `_meta`-only | `lib/control.js:20-21,98-127,368-439`; `server.js:1088-1091`; `public/app/control.js:419-523` | L |
| 5 | Session identity/namespace. The manager map is keyed only by ACP session id, `statePayload` has no harness/source field, and ids can collide across harnesses | `lib/control.js:587-718,305-328`; `server.js:1084-1097` | M |
| 6 | Read-side event source. ACP `session/update` tool calls are used only to enrich approvals (config updates also refresh the catalog); chat comes from dsh v4 zstd logs. Need either ACP update projection or a per-harness log adapter | `lib/control.js:334-366`; `server.js:53-54,117-120,318-348,1167-1201`; `public/app/control.js:248-290` | L |
| 7 | Source registry + stream routing. `SOURCE_DEFS`, `sessionsFor`, `findSession`, `/api/stream` and the page source selector are a fixed dsh/claude/antigravity set | `server.js:84-88,1040-1072,1650-1721`; `public/app/main.js:2120-2132,2504-2527` | L |
| 8 | Control descriptor/SSE gating. `owned`/approvals/agents count are `source === 'dsh'`; non-dsh is always `viewOnly`, and the page hint only names dsh | `server.js:108-112,388,1084-1097,1167-1238`; `public/app/control.js:86` | M |
| 9 | Page new-session flow. It assumes a two-step dsh begin/start, `dshProfile`, the three presets, a model catalog, then forces `state.source='dsh'` and waits for a dsh log frame | `public/app/control.js:419-560` | L |
| 10 | Approval rendering. Command/diff/content shapes are dsh tool shapes; only the first pending approval is shown, with no generic option list | `lib/control.js:98-127`; `public/app/control.js:300-363` | M |
| 11 | Lifecycle fallback. `session/close` is sent unconditionally and cancel is assumed; capability-driven fallback (kill/close transport, no cancel) is needed for harnesses that do not advertise close | `lib/control.js:508-544` | S |
| 12 | Resume/reattach, if the hub needs to reopen sessions: neither `session/load` nor `session/resume`/`session/list` is called today | `lib/acp.js` (no code); `lib/control.js:242-296` | M |
| 13 | Labels/errors/UI text: `dsh ACP exited`, `could not start dsh ACP`, "Starting dsh…", "dsh ACP has no image prompts", `profile:` label | `lib/acp.js:137`; `lib/control.js:551,615`; `public/app/control.js:210,455,474,507,552` | S |
| 14 | Tests: a second fake ACP child and harness-specific assertions (see section 6) | `test/fake-acp.mjs`; `test/control.test.mjs`; `test/ui-control.test.mjs` | M |
| 15 | Security/audit: token, Host/Origin, stream lockout and workspace allowlist are harness-neutral and reusable; only per-harness policy/limits and naming would need review. No structural change needed for the checks themselves | `server.js:1124-1131,1543-1566`; `lib/control.js:136-212` | S |

Hub-relevant absences not covered by the table: no external-session attach
(docs record dsh refusing a second write handle, `docs/dev/input-design.md:114-144`),
no cross-session message bus, no peer/delegation primitive, no shared model or
approval policy across sessions, and no normalized event model independent of
a harness log.

## 6. Tests today and what a second harness needs

### 6.1 `test/control.test.mjs` (protocol/HTTP, no browser)

Setup: writes a `control.json` with one workspace, `dshProfile:'acp'`,
`maxSessions:4`; launches the server with `--allow-control --no-stream-mode`;
sets `AGENTTAIL_DSH_BIN=node` and `AGENTTAIL_DSH_ARGS=[fake-acp.mjs]`; parses
the token from stdout (`test/control.test.mjs:18-26,38-83`). Every POST sets
`Origin` and `Content-Type` (`96-103`). SSE is read with a stop predicate
(`105-148`).

Covers:

| Area | Checks | Lines |
| --- | --- | --- |
| Opt-in gate | no `--allow-control` => control POST and control path 404 (before Origin checks) | `152-157` |
| Stream lockout | status says `locked`; begin and options 403; no token printed | `159-167` |
| Auth | missing/wrong token 401; foreign Origin 403; non-JSON POST 403; workspace outside allowlist 403; danger without confirmation 400; confirmed danger accepted | `169-206` |
| Begin/start/approve/stop | begin id equals ACP id; model catalog includes custom provider; preset retained; first message starts; approval reaches SSE with exact command; `meta.control.owned` true; approve reaches `approvalDone`; stop/close; closed session 404; list marks it view-only | `208-251` |
| Reject | reject picks `reject-once`, reason not echoed, rejection ends the turn | `253-277` |
| Queue/stop | message during turn queues; stop drops queue; stop returns `cancelled:true`; turn ends with `lastStopReason:'cancelled'`; pending approval emits `cancelled` | `279-306` |
| Model/images | two models + `images:true`; switch to JSON-array value; unknown model 400; bad image type 400; five images 400; one image accepted and appears in the fake agent's dsh log as `[images: 1]` | `308-338` |
| Audit | `start`, `message`, `approve`, `reject`, `stop`, `close`, `model`; timestamps/session ids; no message bodies, reject reason text, or image data; image count recorded | `340-355` |

The fake ACP server (`test/fake-acp.mjs`) is the only "agent" used: it returns a
bare UUID, a two-provider model catalog with JSON-array values, declares
`promptCapabilities.image:true` and `sessionCapabilities.close/list/resume`,
sends a `tool_call` then `session/request_permission` with only
`toolCallId`, and writes a dsh v4 zstd log (`1-223`).

### 6.2 `test/ui-control.test.mjs` (headless Edge, not run here)

Launches three servers (plain, `--allow-control` stream-locked, control +
`--no-stream-mode`) against the same fake ACP (`test/ui-control.test.mjs:27-57,100-104`),
drives the page over CDP (`59-133`), and covers:

- no control: composer, New Session button, hint all hidden (`135-139`);
- stream mode: composer/new hidden and hint says control disabled (`141-145`);
- view-only dsh session: token removed from URL, "started outside agenttail"
  hint, no composer (`147-153`);
- new session: workspace listed, default `workspace-write`, danger confirmation,
  live model catalog grouped by provider, dialog closes after start
  (`155-168`);
- approval: card shows `$ echo fake-ok`, badge, agents overview counts it,
  title/favicon, Stop enabled, approve hides card and ends turn (`170-183`);
- input: Shift+Enter does not send, Enter sends, next approval appears, a
  message during a turn shows queued, Stop clears card and ends (`185-195`);
- model: composer shows two options and switching updates status/value
  (`197-200`);
- images: pasted PNG becomes a thumbnail, send clears it, chat contains
  `[images: 1]` (`201-213`);
- end: End hides composer and shows view-only (`215-218`);
- no non-benign page exceptions (`220-222`).

### 6.3 Coverage gaps relevant to a second harness

- Only `dsh` is tested; there is no second ACP fake and no test of a
  non-`dsh` source becoming controllable.
- `maxSessions:4` is configured but never exercised; no 429 test; no concurrent
  begin test for the non-atomic cap.
- Image rejection when capability is false is not tested even though the fake
  supports `FAKE_ACP_NO_IMAGES` (`test/fake-acp.mjs:152`) and no test sets it.
- No Host-header rejection test (only Origin), no missing/invalid JSON body
  limit test, no `GET /api/control/options` auth test.
- No config-option-update notification test, no flat/no model catalog, no
  `session/close` unsupported case, no cancel unsupported case.
- No unmatched approval option (409/cancelled), no multiple simultaneous
  approvals (the page only renders the first).
- No child crash/exit, malformed ACP line, protocol-error or stderr-surfacing
  test; no `session/prompt` timeout behavior test.
- No message size 413, image >5 MiB, second queued-message 409, or missing
  workspace field test.
- No test that the page works without a dsh log record; the fake always writes
  one.

### 6.4 What a second harness would need in tests

1. **A second fake ACP child** with different capabilities: no images, no
   model config (or a flat catalog), no `session/close`, different permission
   option kinds/shapes, and no dsh log output.
2. **Capability-gating assertions**: UI hides/disables images and model picker
   appropriately; unsupported close/cancel falls back without a 500; any
   `fs`/`terminal` callback request is refused with `-32601` rather than
   attempted, because the client does not declare those capabilities.
3. **Descriptor/source tests**: owned-second-harness appears in
   `/api/sessions` and `/api/agents` with approvals; non-owned is view-only;
   ids are namespaced and cannot collide with dsh ids.
4. **Approval mapping tests** for generic option kinds and generic
   `toolCall`/`rawInput` shapes, including multiple pending approvals.
5. **Event projection test**: `session/update` tool/message updates reach the
   page (or the new adapter) without requiring a dsh v4 log.
6. **Security parity**: token, Host, Origin, stream lockout and workspace
   allowlist for the new harness, plus per-harness audit records.
7. **Lifecycle/limits**: exit mid-turn, close failure, resume/load if added,
   max sessions shared across harnesses, concurrent begin.
8. **UI test additions**: harness selector in New Session, capability-driven
   dialog, harness labels instead of "dsh", and a view-only/unsupported state.
9. **Regression**: keep the existing dsh tests passing unchanged; the dsh path
   should become one descriptor, not a special case.

## 7. Points the code does not settle

- **Real dsh image support.** `lib/control.js:271` says dsh's ACP does not
  declare image prompts; the fake declares `image:true` and both test suites
  assert images work. The real agent's `promptCapabilities` is not in the repo.
- **Other `session/update` kinds.** Only `tool_call`, `tool_call_update`, and
  `config_option_update` are recognized (`lib/control.js:334-365`); the code
  does not say which additional updates dsh emits or how they should map to the
  viewer.
- **Advertised session capabilities.** The fake advertises
  `close/list/resume` (`test/fake-acp.mjs:153`), but the client never reads
  `sessionCapabilities` and always sends `session/close`
  (`lib/control.js:535-538`). Real dsh's advertised set is not captured by code.
- **Model value encoding.** `["provider","model"]` and `provider/model` are
  observed/parsed conventions (`lib/control.js:48-59`;
  `docs/dev/input-design.md:95-99`), not part of ACP. A harness with another
  encoding would currently show an empty/incorrect picker.
- **Reject reason visibility.** The code sends `_meta.reason`; the claim that
  dsh ignores it is from `docs/dev/input-design.md:177-180`, not from repo code.
- **Design note vs code on session ids.** The design note says `begin` returns
  "a temporary owned-session id" (`docs/dev/input-design.md:205-208`); the code
  uses the ACP `sessionId` directly as the only id (`lib/control.js:278-281`).
- **Audit file mode.** `mode: 0o600` is passed to `appendFile`
  (`lib/control.js:207`); on an already-existing file the mode is not
  re-applied, so the effective permissions depend on the filesystem.
