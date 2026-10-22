# Harness coverage plan

agenttail's promise is "any harness, watched and driven the same way". This
document holds every harness to one checklist, records what is proven and what
is not, and orders the work so nothing is left half done.

It was built on 2026-10-22 from four inventories (DeepSeek Harness, Claude
Code, Antigravity, candidate harnesses). They read code, the files each
harness writes, and documentation, then a separate review checked the result
against the inventories and the code. The inventories did not change any
session data, but running the Antigravity binary had side effects (see
[Lessons](#lessons)).

Related: [hub-roadmap.md](hub-roadmap.md) (releases),
[hub-harness-control.md](hub-harness-control.md) (driving over ACP),
[verification-log.md](verification-log.md) (live checks).

## Scope of the evidence

- **Platform.** Everything marked verified was verified on Windows 11 only.
  macOS and Linux are untested. Known gaps there: process start times are read
  only on Windows (`lib/claude-status.js`, `lib/antigravity-status.js`), so
  liveness checks degrade to "unverified" elsewhere; a process tree is ended
  with `taskkill` (`lib/acp.js`), which has no POSIX counterpart yet.
- **Variants.** Claude Code was seen only as the desktop app's sessions (no
  terminal, IDE, SDK or `--bg` session), DeepSeek Harness only as its Windows
  desktop app (no TUI, web or SDK profile), Antigravity as both the CLI and
  the editor. Every live check records the variant.
- **Terms.** Driving a harness with a person's own sign-in may be limited by
  the vendor's terms. Each harness passes a terms check before its drive work
  ships (see [Release gates](#release-gates)).

## The checklist

An item is **full** only when all four hold:

1. agenttail does it (code in `lib/` or `public/app/`);
2. a fixture test in the suite would fail if it broke;
3. a live check on a real install is recorded in
   [verification-log.md](verification-log.md) with the harness version,
   variant, platform and date;
4. the README coverage table says so, in the same words.

Anything less is **partial**. A harness that offers no interface for an item is
**n/a**, and the README says why.

**Watch**

| Id | Item |
| --- | --- |
| W1 | Discover sessions: every place the harness keeps them, all variants, config-root overrides |
| W2 | Live tail: new events within two poll intervals of being written (measured) |
| W3 | Conversation: user and assistant messages, thinking, and who wrote a prompt (person, queue, another agent, a scheduler) |
| W4 | Tool calls and results: commands and output, edits with diffs, reads, deletes, running vs final |
| W5 | Subagents, background jobs, parallel work |
| W6 | Model and provider, per turn |
| W7 | Tokens and cost, and how far the cost can be trusted |
| W8 | Context window usage |
| W9 | Turns and steps, and how each turn ended |
| W10 | Workspace, cwd, repository, worktree |
| W11 | Titles and nicknames |
| W12 | State and liveness: working, idle, finished, crashed |
| W13 | Needs you: permission prompt, question, plan approval, other waits, with certainty |
| W14 | Permission mode in the harness's own words, plus a risk tier, and how current that reading is |
| W15 | Errors and failures: provider errors, denials, failed tools |
| W16 | Stream-mode safety: no secrets, user or host names, home paths, emails or addresses on screen, in every endpoint (project folder names stay visible by design) |

**Drive**

| Id | Item |
| --- | --- |
| D1 | Start a session from agenttail |
| D2 | Send messages and images |
| D3 | Approve or reject each tool call |
| D4 | Stop a turn |
| D5 | Switch model or permission mode |
| D6 | Resume or take over a session, only when no live process owns it |
| D7 | End a session |

**Across all harnesses**

| Id | Item |
| --- | --- |
| X1 | No silent caps: when a list is cut (60 dsh and Claude sessions, 40 Antigravity), say "N more"; honour config-root overrides (`CLAUDE_CONFIG_DIR`, a dsh `home` in `control.json`, `CODEX_HOME` and the like) |
| X2 | Format and version gate: unknown event types, unparsable lines and newer format versions are counted and shown once ("verified on X, seen Y"), never skipped silently |
| X3 | Large logs: a 100 MB session opens within a set time and memory bound; totals are marked when only the tail was read (Claude reads the last 24 MiB, so cost and turns cover only that) |
| X4 | Platforms: Windows, macOS and Linux each have a start-time source for liveness and a way to end a process tree |
| X5 | Several sessions at once per harness: same folder, id collisions, the control session limit, ordering |
| X6 | Delivery: notifications, title and favicon for needs-you, finished and crashed |
| X7 | Account limits: credit, quota or plan usage per harness, separate from per-session cost |
| X8 | Untrusted output: terminal escape sequences in tool output are neutralised; an approval card never hides the risky part of a long command |
| X9 | Logs that rotate, are compressed or are deleted while being watched |
| X10 | An audit line for every action agenttail takes on a harness (already true for dsh over ACP) |
| X11 | Time: UTC vs local day for prices and totals, the hour a clock goes back |
| X12 | Accessible data: badges that do not rely on colour alone; a read-only export or API |

## Coverage today

✓ implemented and tested (live check per the log) · ◐ partial · ✗ none · – n/a

| Id | DeepSeek Harness | Claude Code | Antigravity CLI | Antigravity editor |
| --- | --- | --- | --- | --- |
| W1 | ◐ | ◐ | ◐ | ◐ |
| W2 | ✓ | ✓ | ◐ | ◐ |
| W3 | ◐ | ◐ | ◐ | ◐ |
| W4 | ◐ | ◐ | ◐ | ◐ |
| W5 | ◐ | ◐ | ✗ | ✗ |
| W6 | ◐ | ◐ | ✗ | ✗ |
| W7 | ◐ | ◐ | ◐ | ◐ |
| W8 | ✓ | ◐ | ✗ | ✗ |
| W9 | ◐ | ◐ | ◐ | ◐ |
| W10 | ◐ | ◐ | ◐ | ◐ |
| W11 | ✓ | ◐ | ◐ | ◐ |
| W12 | ◐ | ◐ | ◐ | ◐ |
| W13 | ◐ | ◐ | ◐ | ✗ |
| W14 | ◐ | ✗ | ✗ | ✗ |
| W15 | ◐ | ◐ | ◐ | ◐ |
| W16 | ◐ | ◐ | ◐ | ◐ |
| D1 | ✓ | ✗ | ✗ | – |
| D2 | ◐ | ✗ | ✗ | – |
| D3 | ✓ | ✗ | ✗ | – |
| D4 | ✓ | ✗ | ✗ | – |
| D5 | ◐ | ✗ | ✗ | – |
| D6 | ✗ | ✗ | ✗ | – |
| D7 | ✓ | ✗ | ✗ | – |

The X items are partial or missing for every harness today.

The Antigravity editor has no command-line or protocol interface to drive.
Continuing an editor conversation from the CLI (`agy --conversation <id>`) is
unverified: the CLI keeps its own conversation folder and imports others from
its resume screen, and nothing tells whether the editor still holds one.

The README's source table calls Claude Code a "full adapter"; by this checklist
it is not. Correcting the README is part of Phase 0.

## Effort

One scale throughout: S under a day (0.75), M 1-3 days (2), L more than 3 days
(4). Items whose work is "none" are left out. Remaining, per harness:

| Harness | Watch | Drive |
| --- | --- | --- |
| DeepSeek Harness | about 15 days | about 6 days |
| Claude Code | about 16 days | about 11 days |
| Antigravity | about 21 days | about 15 days, after a paid spike (Phase 3) |
| Across all (X1-X12) | about 15 days (estimated here, not by the inventories) | - |

The roadmap's release 0.5 budgets about 11 days for Claude Code and
Antigravity driving together; by this inventory that is about 11 for Claude
Code alone. The roadmap is updated when this plan is accepted.

## Phase 0: wrong results and safety

These show the user something false or leak something. Each comes with a
fixture test that fails before the fix.

| # | Harness | Problem | Fix | Size |
| --- | --- | --- | --- | --- |
| 0.1 | all | Stream mode sent each command's absolute working directory to the page | Fixed in 165c9a6 | done |
| 0.2 | all | On Linux, home folders (`/home/<name>`) and the account and host names were not masked | Fixed, with tests | done |
| 0.3 | all | One invalid pattern in `redact.json`, or a file caught mid-save, dropped every custom literal and pattern | Fixed: a bad pattern is skipped alone, a broken file keeps what was loaded | done |
| 0.4 | Antigravity | Opening a session pane reset its "needs you" badge | Fixed in 165c9a6 | done |
| 0.5 | all | Redaction is an explicit list of fields, so any new field is shown unredacted, and the session list, agents overview, file view, tree and live meta are redacted by hand in `server.js` | Fixed: every string in an event or response is redacted unless its key is a short protocol key (ids, kinds), through one `redactor.value()` on every JSON body and SSE frame; a test walks every endpoint for Claude Code and Antigravity fixtures with a token, a user name, an email and an IP in each field | done |
| 0.6 | DeepSeek Harness | A crashed or killed run stays "live" forever and sorts first: the open-turn timeout is never applied to dsh state | Apply the open-turn cutoff; "failed" when the turn ended with an error. Negative test: a long background job keeps the session live | S |
| 0.7 | DeepSeek Harness | Cost uses one deepseek-flash price table for every provider and model: Ollama/MiniMax traffic is priced as DeepSeek, a pricier model would be underpriced several times, and the `deepseek-account` route's billing basis is undocumented | Price each reply from its own provider and model; show dollars only for pairs with a known public price (not the account route), tokens otherwise; count compaction usage; label "list-price estimate" with the table's date | M |
| 0.8 | DeepSeek Harness | Provider errors are invisible: an out-of-credit (402), rate-limited (429) or timed-out agent looks like it simply stopped | Project attempt failures, retries and turn errors into a problem event; red chip; out-of-credit and missing credentials as needs-attention | S |
| 0.9 | Claude Code | Prompts a person typed while a turn was running (queued commands) are missing from the conversation; prompts from task notifications, peers, the SDK or schedules look as if the person wrote them | Show queued prompts; label each prompt by its origin | M |
| 0.10 | Claude Code | A compaction summary shows as a user prompt and opens a fake turn; a reply cut by max_tokens keeps the turn open for 30 minutes | Skip compact summaries as turns, show a "compacted" marker; treat max_tokens as a closing reason | S |
| 0.11 | Antigravity | Tool results attach to the wrong call when the agent uses a tool the adapter does not map, or parallel calls; failed and denied tools look successful; a command result still RUNNING is shown as final (it is never rewritten); bodies are cut at about 4 KB | Every call gets a pending entry; pair by order within a step; error from the step status; "running, final output unknown" marker; read `transcript_full.jsonl` when fields are truncated | M |
| 0.12 | all | No permission mode is shown for Claude Code or Antigravity, and no harness has a BYPASS badge; bypass modes are common in practice | The tier table below, a reader per source, a loud BYPASS badge | M |
| 0.13 | all | The README overstates coverage | Replace its source table with this checklist's matrix | S |

### Risk tiers (W14)

agenttail shows each harness's own mode name and adds a tier. A session whose
settings span several tiers takes the riskiest. A sandbox that allows full
access is shown as a flag on the tier. A session's tier also covers its
subagents unless they record their own (DeepSeek Harness subagents do, with
the source "delegation"). Names not in the table are shown as they are with a
neutral badge, never guessed.

| Tier | DeepSeek Harness | Claude Code | Antigravity CLI | Antigravity editor |
| --- | --- | --- | --- | --- |
| asks | workspace-write + approval ask | manual / default | default; toolPermission request-review or strict | preset REQUEST_REVIEW; auto-execution OFF; non-workspace access ASK or DENY |
| edits on its own | - | acceptEdits | accept-edits; proceed-in-sandbox (inside the sandbox) | preset AUTO; auto-execution AUTO |
| a reviewer decides | auto (review integration), flagged full-access sandbox | auto (classifier) | auto | - |
| plan only | plan mode | plan | plan | - |
| refuses instead of asking | - | dontAsk | headless print mode | - |
| BYPASS | danger-full-access + approval never | bypassPermissions, --dangerously-skip-permissions | always-proceed, --dangerously-skip-permissions | preset TURBO; auto-execution EAGER; non-workspace access ALLOW |
| neutral (shown as is) | custom (an unmatched pair) | unknown names | unknown names | presets DEFAULT, VETTED, NONE until mapped |

How current each reading is, shown next to the badge:

- DeepSeek Harness: exact, from `permission/preset`, `sandbox/mode` and
  `approval/policy` events, including mid-session switches.
- Claude Code: as of the last prompt (`permissionMode` sits on user entries; a
  switch mid-turn shows at the next prompt).
- Antigravity CLI: as of process start (the log's `toolPermission=` line);
  mode changes inside a session (Shift+Tab) are not logged, so the mode reads
  "unknown" after start unless it was set by flag.
- Antigravity editor: the settings file, which the editor and the CLI share; it
  is a configuration, not proof of what a given conversation did, so the
  badge says "configured as".

agenttail's own `read-only` preset for DeepSeek Harness is not in the presets
table of dsh 0.2.1-rc.2; it is verified or removed in Phase 1.

## Phase 1: watch parity

After Phase 0, every watch item reaches full or an explicit n/a.

### DeepSeek Harness

| Id | Gap | Work | Size | Proof |
| --- | --- | --- | --- | --- |
| W13 | An open `ask_user_question` or `exit_plan_mode` waits on the human with no signal | Open question or plan call = needs-you (probable) | M | Fixture: open, then answered; live: ask in the desktop app |
| W1, W5 | Subagent sessions show as unrelated top-level sessions | Nest children by `parentSession` and `origin` | M | Fixture with a child session |
| W4 | The editor shows the requested edit, not the applied diff | Use the result's diffs, through the redactor and the sensitive-file rule; mark failed edits | M | Fixture: a failed edit and a `.env` diff that must be hidden |
| W3 | Images in prompts and tool results are dropped | An image marker with name, type and size (no pixels in stream mode) | S | Fixture with an image |
| W6 | A mid-session model switch or a subagent on another model is not attributed | Model and provider per reply | S | Fixture with a switch |
| W9 | Aborted, errored and quota-failed turns look completed | Show the turn's end reason | S | Fixture per reason |
| W10 | A `cd` leaves the tree on the old folder | Follow working-directory changes | S | Fixture |

### Claude Code

| Id | Gap | Work | Size | Proof |
| --- | --- | --- | --- | --- |
| W5, W1 | Workflow subagents (most subagent files) are invisible; no subagent metadata; `CLAUDE_CONFIG_DIR` is ignored | Read the workflow folders and agent meta files; runs as jobs; honour the config root | M | Fixtures: a workflow folder, a relocated config |
| W4 | Search, web, MCP and Agent calls are invisible as calls; MultiEdit and NotebookEdit unmapped; no real diff | A generic call for every tool; map the edit tools; use the structured patch, through the redactor | M | Fixture per tool type, including a `.env` patch |
| W8 | Context window and compaction invisible | Compaction marker with before/after tokens; inferred window | M | Fixture with a compaction |
| W15 | API errors, refusals and denials look like ordinary text | Error, refusal and denied markers | S | Fixture per kind |
| W12 | A crashed session and a finished one look alike | Define both cases: the status file removed on a clean exit, left behind with a dead pid on a hard kill; mark "ended mid-turn" accordingly | S | Fixtures for both; live: end a session both ways |
| W6, W10, W11 | Effort, advisor model, a moved cwd or worktree, renamed titles lag | Read them from the entries and the status file | S | Fixtures |
| W13 | The "goal proposal" wait is not mapped; a live `waiting` status has never been seen, only unit-tested | Map it; log unknown wait kinds once; record a live check | S | Fixture; live check |

Claude Code cost (W7) stays labelled "≈ API". For subscription users there is no
bill to reconcile against, and Claude Code's own cost record disagreed with
agenttail's in about half of the observed sessions (cause not established), so
it is never presented as a bill.

### Antigravity

| Id | Gap | Work | Size | Proof |
| --- | --- | --- | --- | --- |
| W1 | A new conversation is invisible until its first step finishes; the documented `~/.gemini/antigravity-ide` is not scanned; subagent conversations look unrelated | List from conversation file names too; add the documented folder; nest subagents | M | Fixture; live: start a conversation |
| W12 | A quiet but alive agent shows finished; a dead process shows live for 30 s; crashes unknown | Liveness from the CLI log's process (pid and start time) and its crash files | M | Fixture; live: end agy |
| W6 | No model shown | Model label from the CLI log | S | Fixture |
| W11, W10 | Raw first prompt instead of Antigravity's own title; workspace guessed | Title from `annotations/<id>.pbtxt`; workspace from `cache/last_conversations.json` | S | Fixtures |
| W9 | No turn count or step durations | Turns from user inputs; durations from step times | S | Fixture |
| W7 | Thinking tokens missing; no quota view | Thinking tokens. Quota only on a manual refresh (it needs `agy -p /usage`, which writes a log, a crash file and a lock and may update the binary); never polled | S | Fixture |
| W13 (editor), W8 | No signal at all for the editor's prompts; no context meter | Needs decision 1 | M | Live: an editor prompt |
| W5 | No subagent or background-job view | After one recorded run with a subagent and a background command | L | That run, captured as a fixture |

## Phase 2: drive Claude Code (release 0.5)

The user's own installed `claude` in headless stream mode, on their existing
sign-in (roadmap decision 1):

`claude -p --input-format stream-json --output-format stream-json --verbose
--permission-prompts host --permission-mode <mode> [--resume <id>] [--model]
[--mcp-config] [--strict-mcp-config] [--setting-sources user]`

Flags verified in 2.1.304 `--help`. The `initialize`, `set_permission_mode`
and `list_models` handshake was exercised with a scratch config and no model
call. The rest of the protocol is known from the binary's strings and the
documentation, not from live runs.

| Id | Work | Size |
| --- | --- | --- |
| D1 | A `claude-stream` harness kind: configured binary path (the desktop app's copy moves on every update), NDJSON reader and writer, a control session with the same state and approval interface as ACP, features detected from the init message | L |
| D2 | User message lines with image blocks (existing image validation) | S |
| D3 | `can_use_tool` requests become approval cards. Approve answers allow with the original input only; "always" rules are never sent unless the user picks them explicitly; `AskUserQuestion` gets its own card | M |
| D4 | `interrupt`, deny any pending request, wait for the result, then end the process after a timeout | S |
| D5 | Modes and models read from the installed binary and `initialize`; switch between turns; BYPASS needs the explicit confirmation | S |
| D6 | Resume only when no status file for that session id has a live pid with a matching start time; otherwise offer a fork | M |
| D7 | Interrupt if running, close stdin, wait, then end the process tree | S |

Rules that come with it:

- Never pass `--bare`: it ignores the subscription sign-in.
- Never read credentials, `.key` files or the sign-in store.
- `-p` runs project hooks and `.mcp.json` without the trust prompt: start only
  in allowlisted workspaces, with `--setting-sources user` and
  `--strict-mcp-config` unless the user opts in per workspace.
- A request nobody answers blocks forever: agenttail expires or cancels its
  own requests and cancels them on shutdown.

## Phase 3: drive Antigravity, finish DeepSeek Harness

**Antigravity.** Headless mode cannot ask for permission. Verified: it denies
the call and lists it under `denied_actions`. The stream-json event that
submits a prompt is not documented, so step 0 is a **paid spike**: one real
turn to learn that event, whether hooks run in print mode, and whether a hook's
approval overrides the print-mode denial. Then, in order:

1. Headless stream mode with a user-installed PreToolUse hook as the approval
   gate (documented at `antigravity.google/docs/hooks`). agenttail prints the
   hook; the user installs it. The hook carries the owned session's token,
   talks only to agenttail on localhost (the same Host, Origin and bearer
   checks as the control API), and when agenttail is down or does not answer
   in time it returns "ask", so Antigravity's own prompt takes over: never a
   silent allow or deny. About 15 days on the one scale, D1-D7.
2. ACP through `agy_acp_server` (a separate download the user installs):
   native permission requests, fits the existing ACP code; capabilities
   undocumented; a short spike once installed.
3. Fallback: watch only, plus the command to continue in a terminal.

Owned sessions never run in a bypass tier silently; without a working gate
they start in plan or accept-edits mode and show what was denied. Every turn
agenttail starts uses the person's own Antigravity quota, and the start dialog
says so.

**DeepSeek Harness.** D5: an effort selector; changing the permission preset
means closing and resuming the session with the new preset. D6: "Continue in
agenttail" for finished sessions through ACP `session/resume`, offered only
when the session is not live (needs 0.6); the ownership error reads "open
elsewhere". D2: images, once a model route that accepts them is verified.

## Phase 4: shared parts and the next harnesses

Shared pieces, built once:

- a line-reducer toolkit for JSONL session trees (header, typed lines, call and
  result pairing) on top of `lib/jsonl.js` and `lib/base-stream.js`;
- one hook-helper design (above), reused by every harness that reports
  approvals only through hooks;
- an `AcpStream` for harnesses driven over ACP without a log adapter: the
  largest single piece (L), and every ACP-based drive below depends on it;
- a SQLite reader for private copies, only if decision 1 allows it.

Candidates. None is installed on the test machine, so every format below is
documented, not verified. GitHub stars are a rough signal of interest, not of
users.

| Order | Harness | Watch | Drive | Notes |
| --- | --- | --- | --- | --- |
| 1 | OpenAI Codex CLI | M: JSONL rollouts, zstd after 7 days (X9) | M: ACP adapter (needs `AcpStream`) | Approval requests are not written to disk: needs-you only for owned sessions or a user-installed hook |
| 2 | OpenCode | M: its HTTP/SSE API (`permission.asked`) | M: built-in ACP | Only while the person runs `opencode serve`; a plain terminal session cannot be watched this way; the disk store is changing |
| 3 | GitHub Copilot CLI | M: session-state events | M: ACP preview | Documented hooks; event format changes quickly; `~/.copilot/logs` alone is not a session |
| 4 | Pi | S: versioned JSONL tree | M: RPC mode | No permission system at all: every session is BYPASS tier |
| 5 | Gemini CLI | M | M | `~/.gemini` is shared with Antigravity, so sources must not mix; free tier moved to Antigravity in June 2026 |
| 6 | Qwen Code, Goose, Cursor CLI, Cline, Kilo | M-L | M | Smaller or unverified formats |
| low | Aider (no tool structure), Kiro CLI (its store is off limits by contract: drive over ACP only) | | | |
| skip | Amp (cloud threads, WSL only on Windows) | | | |

Third-party ACP adapters installed with `npx` run code from the registry: they
are pinned by version and documented as the user's own install, never
fetched by agenttail.

## Release gates

A harness's drive work ships only when:

1. **Terms.** Its vendor's terms for being driven by another program on a
   person's own sign-in have been read and summarised in the README, without
   legal conclusions. For Claude Code, Anthropic's page says that products
   should use API-key authentication and that third parties may not route
   requests through Free, Pro or Max credentials, while also saying that a
   person may sign in to the unmodified Claude Code with their own plan;
   whether a local launcher like agenttail is covered is not settled, so the
   API key stays the default and the subscription path is opt-in with that
   text shown. Google (Antigravity), OpenAI, GitHub and Cursor are to be read
   before their drive work starts.
2. **Live checks.** D1-D7 each have a passing line in the verification log.
3. **Audit.** Every action is audited without message bodies (X10).

## Cost accuracy (DeepSeek Harness)

Checked against a provider usage page on 2026-10-22, using agenttail's own
analysis over the local dsh logs:

- **Tokens** match dsh's own bookkeeping within about 1% (two sessions differ
  slightly).
- **Cost does not reconcile.** No subset of local provider and day totals
  reproduces the usage page. The page shows more requests and more cost but
  fewer tokens than the matching local traffic, so "traffic that never reached
  these logs" cannot explain it alone. Cache pricing does not explain it
  either: agenttail prices cache reads per the official page fetched that
  day. Open readings: the page counts tokens differently or covers another
  period; it covers a pricier model; it belongs to another provider (its
  tokens per request are close to the local MiniMax traffic, not DeepSeek's).
- **Calls with no usage in the logs**, so never counted: title generation,
  web searches, interrupted replies, failed attempts and retries; compaction
  calls do carry usage but agenttail skips it today (0.7).
- **Prices still to model**: the peak and off-peak bands are modelled, but
  public holidays are not; DeepSeek's Search/Fetch charge starts on
  2026-11-01.
- **To close it**: the usage page's period, model filter and key; then re-run
  the reconciliation for that window only. Until then the figure is a
  list-price estimate (0.7), and the `deepseek-account` route shows tokens
  only.

## Decisions for the author

1. **Reading Antigravity's databases from a private copy.** The step status
   that marks a waiting prompt, the per-turn model, context use and the
   editor's prompts live only in its SQLite files (protobuf inside; field
   numbers worked out from a handful of conversations, some status values
   inferred, so fragile across versions). Opening such a file in place, even
   read-only, creates its `-shm`/`-wal` files next to it (observed). A copy
   must be consistent (copy the database and its WAL, open the copy, check it,
   retry on a torn copy), private (user-only permissions, a temporary folder
   outside synced folders), and deleted after each read, including after a
   crash. Allow it? It is the only way to give the editor a "needs you"
   signal.
2. **Hook helpers.** For harnesses that report approvals only through hooks,
   agenttail prints a hook for the user to install and never edits another
   tool's config. Agree?
3. **Order.** Phase 0; Phase 1 for the three installed harnesses; Claude Code
   driving (0.5); Antigravity driving and the DeepSeek Harness drive gaps;
   then Codex and OpenCode. Change it?
4. **Cost display.** Dollars only where a public price is known for that
   provider and model, tokens otherwise?
5. **Live-check budget.** Most live checks need real model turns: DeepSeek
   needs credit, Antigravity uses the person's quota, Claude Code their plan.
   Which route and how much per release?
6. **Other platforms.** Which start-time source and process-group handling for
   macOS and Linux (for example `/proc/<pid>/stat` or `ps -o lstart=`), and
   when they are tested?

## Lessons

- Running a harness binary is not free. Any `agy` invocation can update the
  binary (the first call during this work updated it from 1.4.4 to 1.4.5),
  and each one leaves a log, a crash file and a presence lock. Research avoids
  running harness binaries beyond `--help` and `--version`, and announces any
  run first.
- In Git Bash an argument that starts with `/` is rewritten into a Windows
  path: `agy -p "/help"` became a real model prompt this way. Run harness
  commands from PowerShell, or set `MSYS_NO_PATHCONV=1`.
- Opening another tool's SQLite file read-only still creates files next to it;
  copy first.
- A prompt the harness raised while its own setup screen was showing was never
  displayed, yet stayed pending in its database: agenttail must not rely on
  what the harness's UI shows.
- Log line numbers moved between two Antigravity versions; matching on the
  message text kept the reader working. Prefer content over position.
