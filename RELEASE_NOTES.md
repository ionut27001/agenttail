# agenttail v0.2.0

**Several agents at once, opt-in control for DeepSeek Harness, and a deeper read
side.** The default is
still a local, read-only viewer; control is off unless you pass
`--allow-control --no-stream-mode`.

## Highlights

- Start and own `dsh --profile acp` sessions: workspace allowlist, live model
  catalog (including custom providers such as Ollama), permission preset and a
  first message.
- Message input with queueing, exact-command approval cards, reject reason,
  Stop and End, all backed by ACP permissions and cancellation.
- Owned sessions are marked ✎; sessions started elsewhere stay view-only.
- Read side: model/provider, permission preset and approval-policy history,
  per-turn tokens and cost in Log, a cost-per-turn sparkline, and a background
  job list that jumps to console output.
- Switch the model between turns from the input row; pasted images are sent
  only to agents that declare image prompts (dsh does not).
- Agents overview: every agent active in the last 30 minutes across dsh,
  Claude Code and Antigravity, grouped by git repository (worktrees included),
  each with its own colour, branch, model and current action. Files edited by
  more than one agent are flagged; the activity bar and tree show the other
  agents on the repo you are viewing. Owned sessions waiting on an approval say
  so.
- Agent replies render as markdown in Chat and Log; each turn in Log has a
  summary (model, tools, files changed, failures, tokens, cost, duration).
- The agent pane can dock as a full-height column on the right
  (`Ctrl+Shift+.`); repeated identical actions collapse into one console line.
- Five colour themes (matrix, amber, ice, dracula, paper), a Settings modal
  behind a gear, and the agenttail wordmark in the header.
- Security: per-start bearer token, `--allow-control` gate, stream-mode lockout,
  no auto-approve, workspace allowlist and an audit log without message bodies.
  Stream mode now also redacts file paths outside the workspace (they could
  carry the Windows user name).
- New `control`, `agents` and control-UI test suites; all existing suites still
  pass.

## Compatibility

- Same Node 24+ requirement and `~/.dsh/sessions` layout.
- Control needs an `acp` dsh profile (created on first use by dsh) and a
  `control.json` workspace allowlist.
- Existing read-only usage is unchanged: no flag, no control endpoints.

---

# agenttail v0.1.0

**tail -f for AI coding agents.** A local, read-only live viewer for DeepSeek Harness, Claude Code and Antigravity CLI sessions.

![agenttail](docs/hero.gif)

## Highlights

- Live editor typing, tree heat and per-file edit/failure tooltips.
- Console with commands, job progress (`[n/N]`), collapsible output and a running spinner.
- Agent chat plus a full **Log** trajectory view.
- Activity bar with one current state, colour-coded animation and finished/error transients.
- Replay for finished sessions.
- Stream mode redaction with fail-closed behaviour.
- **No telemetry and no external requests.** Monaco, xterm.js and JetBrains Mono are vendored; the page works offline.
- Read-only, localhost only, with Host/Origin checks against DNS rebinding and CSRF.

## Supported sources

| Source | Logs |
| --- | --- |
| DeepSeek Harness | `~/.dsh/sessions/**/session.v4.jsonl.zstd` |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Antigravity CLI | `~/.gemini/antigravity/**` |

## Requirements

- Node.js 24 or newer for the package/portable build.
- The Windows standalone exe embeds Node and needs no installation.
- Windows is tested. macOS and Linux are untested.

## Stream-mode warning

Stream mode is on by default and redacts secrets, identity, network addresses and several opaque identifiers before anything reaches the browser. Redaction reduces risk; it is not a guarantee. **Review the stream before sharing or recording it.**

## Known limits

- Windows is the tested platform; macOS and Linux builds are untested.
- The Windows exe is **unsigned**, so SmartScreen may warn. Verify the SHA-256 checksum before running it.
- Only newer sessions are listed (60 dsh/Claude, 40 Antigravity).
- Peak/off-peak pricing ignores public holidays; GPU metering needs `nvidia-smi`.
- `.dsh` logs with corrupted zstd frames are skipped.

## Artifacts

- `agenttail-0.1.0.tgz` — npm package. agenttail is not on the npm registry yet: run it with `npx github:ionut27001/agenttail` or `npx ./agenttail-0.1.0.tgz`; `npx agenttail` comes later.
- `agenttail-0.1.0-portable.zip` — source plus `start.cmd` / `start.sh`, for Node 24+.
- `agenttail-0.1.0-win-x64.exe` — standalone Windows x64 build (unsigned).

## Verify the checksums

```powershell
Get-FileHash .\agenttail-0.1.0.tgz, .\agenttail-0.1.0-portable.zip, .\agenttail-0.1.0-win-x64.exe -Algorithm SHA256
```

Compare the output with `SHA256SUMS.txt`.

## License

MIT © 2026 ionut27001. agenttail is not affiliated with DeepSeek, Anthropic or Google. Product names are used only to describe supported sources.
