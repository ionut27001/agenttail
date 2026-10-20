# Driving dsh from agenttail — input design (agenttail 0.2, step 1)

Date: 2026-10-20. Environment: Windows, DeepSeek Harness 0.2.1-rc.2, Node 24,
`dsh` from the DeepSeek Harness desktop install.

This note records what the installed dsh actually allows, with the evidence and
the resulting design. It was written before the input code.

## TL;DR

- dsh exposes two stdio control surfaces: `dsh --profile acp` (ACP v1) and
  `dsh --profile sdk` (a DSH-specific JSON-RPC protocol).
- **ACP is the only usable one for this feature.** It has sessions, prompts,
  cancellation, one-shot permission requests, per-session model options and
  session close. The SDK protocol has no prompt cancel, no session close and no
  approval forwarding.
- Both surfaces are **stdio child processes owned by their launcher**. There is
  no documented or tested way to attach to the dsh Desktop app's live process.
  `session/list` can see persisted Desktop sessions, and `session/resume` can
  reopen an **inactive** one, but a second process is rejected while the first
  owns it: `session "…" is already owned by an active write handle`.
- Therefore agenttail will **start and own** its own `dsh --profile acp`
  children. Sessions started by the Desktop app (or any other process) stay
  view-only.
- The CLI's ACP surface does not expose permission presets as a protocol
  option. A session's preset is the process's deployment setting:
  `DSH_PERMISSION_MODE=read-only|workspace-write|danger-full-access` (the base
  profile maps that to sandbox mode and approval policy). agenttail uses one
  child per owned session, so the preset is chosen before spawn.
- One ACP child per owned session is deliberate: the preset and working
  directory are process-level in dsh, while model/reasoning effort are
  per-session ACP options. A process per session is the smallest correct
  mapping (and `DSH_PERMISSION_MODE` is a documented deployment override, not
  a private API).

## What was checked

### 1. CLI profiles and protocols

`dsh --help` lists profiles as bundles. The shipped templates are in
`@deepseek-ai/dsh-app-boot`:

```js
acp: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] },
sdk: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] },
```

`dsh acp --help` / `dsh sdk --help` first initialize
`$DSH_HOME/profiles/<name>` (it failed under the read-only sandbox with
`EPERM … mkdir ~/.dsh/profiles/acp`, then worked once the profile existed),
then the app's own `--help` exits before claiming stdin/stdout.

`@deepseek-ai/dsh-acp/README.md` documents the supported matrix:

| Call | ACP |
| --- | --- |
| create session | `session/new` (absolute `cwd`) |
| send user message | `session/prompt` (one in flight per session) |
| receive events | `session/update` notifications |
| ask for permission | `session/request_permission` (server → client request) |
| answer permission | `session/request_permission` response, one-shot choices |
| interrupt turn | `session/cancel` notification |
| stop process | `session/close`, then end the process |
| list/resume | `session/list`, `session/resume` (persisted, inactive) |
| model | `session/new` returns `configOptions`; `session/set_config_option` |
| permission preset | **not exposed** |

The ACP app README also states that stdout is reserved for newline-delimited
ACP JSON-RPC, stderr is for diagnostics, and the profile disables HMR.

The SDK protocol README lists only `initialize`, `session/prompt`,
`session/resume`, `session/wait`, `session/working-directory/*`, `shutdown`,
and four notifications. It explicitly says there is **no cancel or session
close** and that server→client requests are a dead capability. That rules it
out for approvals and stop.

### 2. Live probe of `dsh --profile acp`

Probe (`initialize` + `session/new`, cwd `<scratch>/probe-workspace`):

```json
INIT {"protocolVersion":1,
      "agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},
      "agentCapabilities":{"sessionCapabilities":{"close":{},"list":{},"resume":{}}}}
NEW {"sessionId":"<uuid>",
     "configOptions":[
       {"id":"model","name":"Model","type":"select",
        "currentValue":"[\"deepseek-official\",\"deepseek-v4-flash\"]",
        "options":[{"group":"deepseek-official","name":"DeepSeek","options":[
          {"value":"[\"deepseek-official\",\"deepseek-v4-flash\"]","name":"deepseek-v4-flash"}]}]},
       {"id":"reasoning_effort","name":"Reasoning effort","type":"select",
        "currentValue":"high","options":[...]}]}
```

The ACP session id is a bare UUID, and ACP-created sessions persist under the
same bare UUID (`sessions/<workspace>/<uuid>/session.v4.jsonl.zstd`). Desktop-
created sessions use the `session-<uuid>` form, so the viewer accepts both. The
model value is a JSON array string `[provider, model]`, which gives the UI both
provider and model.

With an Ollama provider added to the ACP profile's patch
(`llm-pi-ai` + `agent-default-model`), the same `configOptions` also advertised:

```json
{"group":"ollama","name":"Ollama (MiniMax)","options":[
  {"value":"[\"ollama\",\"minimax-m3.1-flash:cloud\"]","name":"minimax-m3.1-flash:cloud"}]}
```

So the model picker is populated from dsh's live catalog, not a hard-coded
list. Custom providers must be configured in the ACP profile (or supplied via
a `--patch` overlay); the Desktop profile's `llm-pi-ai` section is not
automatically inherited by the `acp` profile.

### 3. Can an external process attach to a Desktop session?

**Persisted sessions are visible, live ones are not attachable.**

`session/list` against the real `~/.dsh/sessions` returned 9 sessions,
including Desktop-app sessions:

```json
{"sessionId":"session-<uuid>","cwd":"<workspace A>"}
{"sessionId":"session-<uuid>","cwd":"<workspace B>"}
…
```

A copy of an inactive session was resumed successfully in a scratch store. A
second ACP process then tried to resume the same session while the first held
it:

```
A resume OK
B resume rejected: Internal error
  {"details":"session \"session-<uuid>\" is already owned by an active write handle"}
```

The ACP source checks both its own session map and the persistence layer's
active write handle (`resumeSession` throws `session is already active` when
`ctx.sessions.get(sessionId)` exists; the persistence layer rejects the
cross-process case above). There is no ACP endpoint exposed by the Desktop app
to hand a live session to another process. The SDK has no attach method either.

**Conclusion:** agenttail owns only sessions it starts. Others are read-only,
and the UI says so.

### 4. Permission behavior

The base profile (`@deepseek-ai/dsh-base/cordis.patch.yml`) contains:

```yaml
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
- id: approval
  config:
    policy: !!js (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'
- id: permission
  config:
    presets:
      read-only:        { sandbox: read-only,         approval: ask }
      workspace-write:  { sandbox: workspace-write,   approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

The ACP bridge maps `approval/request` to `session/request_permission` with
one-shot allow/reject options and maps the answer back to `allowed-once` or
`rejected`. It never auto-approves.

So:
- default `workspace-write` → sandbox workspace-write, approval `ask`;
- `read-only` → read-only sandbox, approval `ask`;
- `danger-full-access` → no sandbox, approval `never` (explicit choice only);
- `DSH_PERMISSION_MODE` is a deployment override, evaluated at process start,
  before the ACP session exists. Per-session selection therefore means one
  child per session.

ACP's permission outcome has no standard reason field. agenttail puts a reject
reason in the response `_meta.reason` and records only its presence/length in
the audit log; dsh's shipped bridge maps the selected option and ignores
`_meta`, so the reason is for the user/audit, not a model-visible message.

### 5. Log evidence on the read side

Real dsh logs contain the facts the read-only side needs:

```json
{"type":"permission/preset","seq":0,"data":{"preset":"workspace-write"}}
{"type":"sandbox/mode","seq":1,"data":{"mode":"workspace-write"}}
{"type":"approval/policy","seq":2,"data":{"policy":"ask"}}
{"type":"request/context","seq":13,"data":{"provider":"deepseek-account","model":"deepseek-flash","contextWindow":1048576}}
{"type":"approval/asked","seq":388,"data":{"toolName":"pwsh","callId":"…","reason":"…"}}
```

Assistant messages also carry `message.source.provider` / `.model`. The read
side can therefore show model/provider, preset and approval-policy changes
without asking the control plane. Per-turn usage is already in
`assistant/message.data.usage` (`inputTokens`, `outputTokens`,
`cacheReadTokens`, `cacheWriteTokens`); turn boundaries are `turn/start` and
`turn/end`.

## Design

### Process model

- `POST /api/control/session/begin` spawns one `dsh --profile acp` child in the
  chosen workspace, initializes ACP, creates a session, returns the model
  catalog and a temporary owned-session id.
- `POST /api/control/session/start` sets the chosen `model` with
  `session/set_config_option`, then sends the first `session/prompt`.
- The child is owned by agenttail for the lifetime of the app process.
  `session/cancel` interrupts; `session/close` + process exit ends it.
- dsh's log remains the single read-side source. The control plane adds an SSE
  side channel only for approvals and run state; commands/answers/updates are
  still rendered from the log, so the viewer and the controller agree.

Rejected alternatives:
- **one ACP process, many sessions** — cannot vary permission preset per
  session, and `DSH_PERMISSION_MODE` is process-level;
- **SDK profile** — no approvals, no cancel, no close;
- **attach to Desktop** — not exposed, and resume of a live session is refused
  by the active write handle.

### Security model

- control is off unless `--allow-control`;
- 32 random bytes, base64url, printed only in the startup URL fragment
  (`#token=…`); fragment is not sent in HTTP requests or Referer;
- every control POST requires `Authorization: Bearer <token>` in addition to
  the existing Host, Origin and Content-Type checks;
- stream mode (on by default) locks control out completely: no input box,
  approval buttons or Stop, and the endpoints return 403;
- no auto-approve anywhere; the harness permission preset is selected at
  spawn; `danger-full-access` requires an explicit confirmation in the
  New Session dialog;
- audit log: JSONL in the per-user config dir, timestamp + action + owned
  session id (+ preset/decision metadata); message bodies are never written,
  even outside stream mode;
- workspaces are allowlisted in `control.json` (existing `roots.json` is a
  read allowlist and is not reused for write-capable sessions).

### UI

- New Session dialog: workspace (allowlist), permission preset, then model
  (live ACP catalog after begin), plus first message. `danger-full-access`
  needs a confirmation checkbox.
- Composer under the chat, only for owned sessions; Enter sends,
  Shift+Enter inserts a newline; a running turn queues one message and shows
  “queued”.
- Approval card with the exact command/diff and Approve/Reject; reject takes
  an optional short reason. A compact approval badge lives in the activity
  bar.
- Stop cancels the current turn; End closes the owned session.
- Session picker marks owned sessions with ✎; other dsh sessions show
  “started outside agenttail, view only”.
- Read side adds model/provider, preset and approval-policy history,
  per-turn tokens/cost in Log, a per-turn cost sparkline, and a background-job
  list whose rows jump to the job's console output.

## Demo evidence

The final end-to-end run used a scratch `DSH_HOME` with an ACP profile whose
`llm-pi-ai` section advertised the local Ollama model
`minimax-m3.1-flash:cloud`, plus `control.json` allowing the workspace
`<scratch workspace>` for the run:

1. `POST /api/control/session/begin` returned
   `session <uuid>`, provider `ollama`, model
   `minimax-m3.1-flash:cloud`, preset `workspace-write`.
2. The first message asked for `echo approval-ok` with
   `sandbox_permissions: danger-full-access`. ACP sent
   `session/request_permission` with the exact command; the UI showed the
   approval card in the chat and activity bar.
3. Clicking **Approve** produced a dsh log with
   `approval/decided {outcome:"allowed-once"}`, a `pwsh` job that completed with
   `exit code: 0`, and a tool result `approval-ok`.
4. A second message started `Start-Sleep -Seconds 30`; clicking **Stop** logged
   `job/settled status:"killed"`, `tool/result isError:true`,
   `turn/end reason:{kind:"aborted", reason:{kind:"user"}}` and the UI returned
   to idle.
5. The audit log contained `start`, `message`, `approve`, `reject`, `stop` and
   `close`, with message lengths only — no message bodies.

The automated `test/control.test.mjs` repeats the protocol path against a fake
ACP child (start, approval, approve, queue, stop, close) and checks the opt-in
404, token 401, stream 403 and foreign-Origin 403 gates.

## Evidence caveats

- ACP is explicitly “automation-only”: no plans, commands, terminals, client
  filesystem operations, or elicitation. The UI only promises what the log
  shows; it does not invent those features.
- The ACP profile's provider catalog depends on that profile's configuration.
  A model shown in the Desktop model picker is not automatically visible to
  `dsh acp` unless the ACP profile (or a patch overlay) supplies the same
  provider. This is a deployment fact, not a UI bug; `control.json` accepts a
  `patch` path to pass a provider patch to the ACP child.
- dsh persists a session only once work starts; agenttail waits briefly for
  the ACP session's log after the first prompt before opening the stream.
- One process per session costs memory and startup time. A later version can
  share a process per (workspace, preset) once dsh exposes per-session presets.
