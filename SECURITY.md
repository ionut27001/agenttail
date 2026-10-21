# Security

## Local only

agenttail binds to `127.0.0.1` only. Read-only endpoints have no authentication
because they are not reachable from the network. Control is different: see
below. Keep the bind address as it is: do not put agenttail behind a reverse
proxy, port-forward it, or change the bind address.

Every request must carry a `Host` header of exactly `127.0.0.1:<port>` or
`localhost:<port>`; anything else receives `403`. POST requests must also carry
an `Origin` matching that exact Host and `Content-Type: application/json`.
Together these block DNS rebinding and cross-site request forgery. Control
POSTs add a bearer token on top of those checks.

## Read-only by default

Without `--allow-control` the server reads session logs and workspace files. It
never writes to session stores, transcripts or workspace files. Its only writes
are the local nickname file and optional configuration files in the agenttail
config directory.

To tell when an agent waits for you, agenttail also reads the status files Claude Code
keeps for its own processes, `~/.claude/sessions/<pid>.json` (folder overridable
with `AGENTTAIL_CLAUDE_SESSIONS_DIR`). Only the numbered `.json` files are
opened, and only the pid, session id, status, what the process waits for and
when are kept; nothing else in the file is copied or sent. The `*.key` files next
to them are never opened. A status is used only while its process is alive,
checked with signal 0 (nothing is sent to the process), and while it is fresh.
This adds no write and no network request.

The agents overview (`GET /api/agents`) is read-only as well. To group agents by
repository it reads `.git` (and, for linked worktrees, the `gitdir`,
`commondir` and `HEAD` files) next to each session's working directory; it never
runs `git`. The response carries repository names, branches and repo-relative
file paths, redacted like everything else in stream mode, and never the local
repository path.

With `--allow-control`, agenttail can start **its own** DeepSeek Harness
sessions through `dsh --profile acp`. Those sessions write ordinary dsh logs and
may edit the chosen workspace; that is the point of control. Sessions started by
the Desktop app or another process are never attached to and stay view-only.

## Control (opt-in)

- **Opt-in.** No control endpoint exists unless the server starts with
  `--allow-control`; without the flag every `/api/control/*` request is `404`.
- **Session token.** On start the server generates 32 random bytes (base64url)
  and prints `http://127.0.0.1:<port>/#token=…`. The fragment is not sent in
  HTTP requests or `Referer`. Every control POST requires
  `Authorization: Bearer <token>` in addition to Host/Origin/Content-Type.
  Missing or wrong tokens receive `401`. Tokens are regenerated on each start.
- **Stream mode lockout.** Stream mode is on by default. While it is on, the
  input box and approval buttons are hidden and control endpoints return `403`,
  so a stream can never be used to drive an agent. Use `--no-stream-mode` only
  when you actually need to type into an agent.
- **No auto-approve.** agenttail never approves anything by itself. An approval
  is a user click; rejecting accepts an optional short reason. dsh remains the
  permission authority.
- **Permission presets.** The default is `workspace-write` (sandboxed, approval
  policy `ask`). `read-only` is available. `danger-full-access` removes the
  sandbox and is available only after an explicit confirmation in the New
  Session dialog. It cannot be selected by a plain API call without
  `confirmDanger: true`.
- **Workspace allowlist.** Controlled sessions can only start in directories
  listed in `control.json`, and only those directories are offered in the New
  Session dialog. `roots.json` is a read allowlist and is not reused for
  write-capable sessions.
- **Audit log.** Every control action (`start`, `message`, `model`, `approve`,
  `reject`, `stop`, `close`) is appended to `control-audit.log` in the per-user
  config directory with a timestamp and the owned session id. Message bodies,
  reject reasons and image data are never written; a message entry records only
  its length, the number of images and whether it was queued.
- **Images.** A message can carry at most four PNG, JPEG, GIF or WebP images of
  up to 5 MB each, and only when the agent declares image prompts during the
  ACP handshake. dsh's ACP does not, so dsh sessions never receive images.
- **Stream-mode privacy.** Because control is disabled in stream mode, approval
  payloads (which can contain commands and diffs) are never sent to a stream
  session.
- **Inbox endpoint.** `GET /api/control/approvals` lists the pending approvals of
  owned sessions for the inbox. It sits behind the same gates as the other
  control endpoints: `404` without `--allow-control`, `403` in stream mode,
  `401` without the token. The inbox approves and rejects through the existing
  `POST /api/control/approval`, with the same token.

The control URL is a secret. Anyone who can read it can drive the sessions
agenttail owns. Prefer a scratch workspace and a narrow `control.json`.

## Stream mode

Stream mode is enabled by default: emails, Windows usernames, URLs with
credentials, tokens, IPv4/IPv6/MAC addresses and several opaque identifiers are
redacted on the server before anything reaches the browser. If a redaction
fails, the event is dropped rather than sent raw. You can add private literals
and patterns in `redact.json`. **Review the stream before sharing or recording
it.** Redaction reduces risk; it is not a guarantee that every sensitive string
is caught.

## Needs you

The needs-you state (an agent is blocked on a person) is derived from local files
and, for sessions agenttail owns, from its own ACP approvals. In stream mode it
shows the kind of wait and the name of the tool only (`NEEDS YOU · permission ·
Bash`), never a command, a path or any text the agent wrote; the same holds for
desktop notifications, the tab title and the favicon. Notifications use the
browser's own Notification API on the local page; nothing is sent anywhere.

## Privacy

agenttail collects **no** telemetry, analytics or crash reports. It makes **no**
network requests: it only reads local session logs and serves them on
`127.0.0.1`. All frontend libraries and fonts are vendored under
`public/vendor/`; the page loads nothing from a CDN. Nothing leaves your
machine. The only exception is the agent itself: a controlled dsh session may
call its configured model provider, exactly as a normal dsh session does.

## Reporting a vulnerability

Please report security issues privately to the maintainer rather than opening a
public issue with exploit details. Include the affected version, a minimal
reproduction, and the impact. You should receive an acknowledgement within a
few days. Do not test against systems you do not own.
