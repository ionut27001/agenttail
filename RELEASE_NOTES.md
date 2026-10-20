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

- `agenttail-0.1.0.tgz` — npm package.
- `agenttail-0.1.0-portable.zip` — source plus `start.cmd` / `start.sh`, for Node 24+.
- `agenttail-0.1.0-win-x64.exe` — standalone Windows x64 build (unsigned).

## Verify the checksums

```powershell
Get-FileHash .\agenttail-0.1.0.tgz, .\agenttail-0.1.0-portable.zip, .\agenttail-0.1.0-win-x64.exe -Algorithm SHA256
```

Compare the output with `SHA256SUMS.txt`.

## License

MIT © 2026 ionut27001. agenttail is not affiliated with DeepSeek, Anthropic or Google. Product names are used only to describe supported sources.
