# agenttail hub: roadmap

Where agenttail goes after v0.3.0: one cockpit for every agent harness you
use (Claude Code, Antigravity, DeepSeek Harness and more). It shows how each
one works, live, as today, and lets you work with them and drive them from
the same place: start a session, send messages and images, approve or reject
what it wants to do, stop it. On top of that, agents on the same project can
see each other, work together and call each other for help, while a human
stays in control.

The point is any harness, watched and driven the same way. Agent-to-agent
coordination (0.6, 0.7) is a layer on top of that, not the goal by itself.

This roadmap merges three documents written on 2026-10-21:

- [hub-current-state.md](hub-current-state.md): what the control plane does
  today, with file and line references (written by DeepSeek Harness, checked).
- [hub-harness-control.md](hub-harness-control.md): controlling harnesses
  beyond dsh over ACP, and a "needs you" state for every source.
- [hub-coordination.md](hub-coordination.md): an agenttail MCP server for
  coordination, the human approval gate, safety, UI, images and the API.

Read them for the evidence and sources; this file is the order of work and the
decisions. [harness-coverage.md](harness-coverage.md) (2026-10-22) holds every
harness to one watch-and-drive checklist and supersedes the effort estimates
below where they differ.

## What stays true

- The read-only viewer stays the default and keeps working with no flags.
- Anything that drives agents is opt-in, localhost only, token-protected,
  audited without message bodies, and off in stream mode.
- Open standards: ACP to drive harnesses, MCP for the tools agents call.
  agenttail never downloads or installs a harness and never edits another
  tool's config files; it prints snippets instead.
- Zero runtime dependencies: the MCP layer is a small hand-written stateless
  implementation (the official SDK brings 17 dependencies).
- Every request from one agent to another passes a human approval card in
  the first versions. Agents have no approve tool.

## What the inventory changed

- The ACP transport in `lib/acp.js` is already generic. What ties control to
  dsh is the spawn config, the permission presets (a dsh environment
  variable), a model-only config option, dsh-shaped approval details, and
  `source === 'dsh'` checks in `server.js`.
- The chat of an owned session still comes from dsh's own log files, not from
  ACP. A harness without a log adapter needs a new in-memory stream built from
  ACP `session/update` (the `AcpStream` below). This is the largest single
  piece.
- Two safety issues to fix first, whatever else happens:
  - Approve picks the first option whose kind is `allow_once` or
    `allow_always`, in the order the agent lists them, so it can approve
    "always" by accident (`lib/control.js:414-418`). It must pick
    `allow_once` by kind.
  - Approval cards ignore ACP diff content, so an edit can be approved
    without being seen.
- Wall panes shrink after 60 s of silence, so an agent waiting on the human
  disappears from view exactly when it needs attention.
- Sessions are started with `mcpServers: []` (`lib/control.js:276`); dsh's
  ACP accepts HTTP MCP servers with headers there, which gives owned sessions
  a strong per-session identity for the hub at no extra cost.

## Releases

| Release | Theme | Work (from the two designs) | Size |
| --- | --- | --- | --- |
| 0.4 | **Needs you** | Groundwork: harness registry with the old dsh keys still working, control split into manager/session/registry, capabilities probed at runtime, one approval normaliser (allow_once by kind, diffs shown, an `origin` field), caller-supplied `mcpServers`, one shared "needs you" event list. Then the attention state for every source: dsh open approvals, Claude Code `~/.claude/sessions/<pid>.json` status plus open AskUserQuestion/ExitPlanMode, owned ACP approvals; shown in the picker, overview, wall (no shrinking while waiting), title, favicon and notifications; one approvals inbox. Optional user-installed Claude hook helper. | ~9 days |
| 0.5 | **Drive any harness** | Claude Code and Antigravity (both installed on the author's machine) next to dsh, then more. Claude Code driven through its own headless stream mode on the user's existing sign-in (subscription or API key), with the ACP adapter as an option for API keys (see decision 1), with images, presets mapped to modes, resume only when supported and no live process owns the session. `AcpStream` for harnesses without a log adapter. Recipes for OpenCode, Codex, Goose, Gemini CLI, Antigravity's ACP server, marked unverified until run. | ~11 days |
| 0.6 | **Passive hub** | `POST /mcp` plus an `agenttail mcp` stdio shim, behind a new opt-in flag. Identity for owned agents (per-session token through ACP) and external agents (shim facts, then a one-time code the agent echoes into its own log). Tools: whoami, list_agents, board_read/post, claim_files/release_files (advisory leases checked against observed edits), inbox, wait_for. Board drawer and claim locks on the wall, a Connect dialog with per-harness snippets, a frozen read API. | ~9 days |
| 0.7 | **Agents ask each other** | ask_agent, reply, handoff; by default a helper session agenttail owns, in the chosen harness. Human card on every request (full text, edit before approve, provider-boundary line, 10-minute expiry), limits (6 asks/hour and 2 open per agent, depth 2, no cycles, Pause hub), a sanitising envelope against prompt injection, helper presets never above the asker's (read-only by default). Arrows between panes, "waiting on <agent>", Tail reactions. | ~9 days |
| 0.8 | Reach and media | Delivery to external sessions (hook nudges, optional claim enforcement), images between agents and the human, API v1 write endpoints with scoped tokens. | ~12 days |
| later | Remote | A spike only: two agenttails over an SSH port forward, each human approving their own side. | spike |

The full music video ships with 0.7, when agents calling each other is real.

## How the work is run

- One coordinating session (Opus) owns the plan, reviews every change, runs
  the tests and merges. Workers never merge or push.
- Two Claude workers (Sonnet, high effort), each in its own git worktree, take
  independent pieces with disjoint files, e.g. in 0.4: worker A the groundwork
  in `lib/` and `server.js`, worker B the attention producers and the UI once
  the shared event list is merged.
- DeepSeek Harness (dsh headless) takes cheap, well-specified pieces and
  independent cross-checks: inventories, fixtures, test cases, doc updates,
  and reviewing a worker's diff from a different model family. Its sessions
  are watched live in agenttail.
- Every release keeps the existing test suites green and adds its own
  (`harness.test.mjs`, `attention.test.mjs`, MCP fixtures against fake
  clients). UI suites run in short bursts.

## Decisions taken

2026-10-21, with the author:

- The goal is any harness, watched and driven the same way; Claude Code and
  Antigravity are the first harnesses after dsh, not OpenCode.
- Decision 2: yes, read only the status fields of Claude Code's status file
  in the default mode (never the `.key` files).
- Decision 3: a separate `--allow-hub` flag.
- Decision 4: every cross-agent request needs the human in v1.
- Decision 1: Claude Code with a subscription is a first-class path, not an
  afterthought. agenttail drives the user's own installed `claude` binary in
  its headless stream mode, signed in as the user already is; it never sees or
  handles credentials. Checked on Claude Code 2.1.304 (the copy the desktop app
  ships): `--print --input-format stream-json --output-format stream-json`
  for a live two-way session, `--permission-prompts host` so permission
  prompts go to the process that runs it (agenttail shows its approval card),
  plus `--resume <session-id>`, `--mcp-config` and `--permission-mode`. The
  ACP adapter stays as the option for API-key users. Before release, the
  README states plainly that users must follow Anthropic's terms for their
  plan when Claude Code is driven by another program.

- Permission modes come from the harness, never from agenttail (author,
  2026-10-21). Lists go stale: the design above names a Claude Code `default`
  mode, but Claude Code 2.1.304 offers `manual`, `acceptEdits`, `auto`,
  `plan`, `dontAsk` and `bypassPermissions`.
  - Driving: the choices are what the agent declares (ACP config options or
    modes, as 0.4 already does), or, for Claude Code's headless mode, the
    `--permission-mode` choices read from the installed `claude` itself.
  - Watching: show the harness's own name, read from its records (Claude Code
    writes `permissionMode` on each user entry of the transcript; dsh records
    its preset and approval policy).
  - agenttail adds only a risk tier for the badge colour (asks, edits on its
    own, plan only, bypass), from a small table of known names; an unknown
    name shows neutrally with its own name and is never guessed. Bypass-tier
    modes (`bypassPermissions`, `danger-full-access` and the like) get a loud
    BYPASS badge everywhere and need the explicit confirmation to start or
    switch into.
  - On top of the harness's modes, agenttail offers "bypass with a safety
    net": the agent runs in an asking mode and agenttail approves its requests
    itself, except a denylist (recursive deletes, force pushes, writes outside
    the workspace, secrets) that still comes to the human. Every request is
    seen and audited.

These defaults can change; the questions below record the trade-offs.

## Decisions for the author

Needed before 0.4 and 0.5 (the rest can wait):

1. **Claude Code control path.** The ACP adapter runs on the Agent SDK. API-key
   sign-in is clearly fine; using a Claude subscription sign-in through it is
   a terms question. Document API key only, also allow subscription sign-in at
   the user's own responsibility, or start with OpenCode instead and leave
   Claude Code read-only for now?
2. **Reading Claude Code's status file.** In the default read-only mode,
   may agenttail read `~/.claude/sessions/<pid>.json` (status fields only,
   never the `.key` files next to it), or only behind a flag?
3. **One flag or two.** A separate `--allow-hub` (proposed: passive hub alone,
   agents prompting agents only together with `--allow-control`), or fold it
   all into `--allow-control`? The hub is off in stream mode either way.
4. **Approval policy in v1.** Every cross-agent request needs a human click
   (proposed), or opt-in auto-approval for some cases, such as read-only
   questions inside one repository?

Later: whether agenttail may create git worktrees for write-capable helpers;
the token for external agents (a runtime file on disk read by the shim, or
pasted per start); approve-always at all; audit detail; retention of board
and request text (7 days proposed, with an off-the-record mode); which
harnesses you can install to verify; the 30-minute Antigravity spike (see
hub-harness-control.md); how far Tail goes with cross-agent reactions.
