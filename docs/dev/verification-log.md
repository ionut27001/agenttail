# Verification log

Live checks on real installs, one line each: what was checked, on which
harness version and variant, on which platform, when, and what happened. An
item in [harness-coverage.md](harness-coverage.md) counts as full only with a
passing line here. Failures, surprises and checks still owed are recorded too.

| Date | Harness, version, variant | Platform | Item | Check | Result |
| --- | --- | --- | --- | --- | --- |
| 2026-10-21 | DeepSeek Harness 0.2.1-rc.2, ACP | Windows 11 | D1, D2, D7 | Start a controlled session from the New Session dialog, send a first message, end it | Pass |
| 2026-10-21 | DeepSeek Harness 0.2.1-rc.2, ACP | Windows 11 | W11, X1 | A short first message gives the session a title; agenttail's own sessions sort first | Failed, fixed in fc1bee5, re-checked: pass |
| 2026-10-22 | DeepSeek Harness 0.2.1-rc.2, ACP | Windows 11 | D1 | `initialize`, `session/new`, `session/close` against a scratch home, no prompt | Pass; the agent reports no image support on the tested route |
| 2026-10-22 | DeepSeek Harness 0.2.1-rc.2 | Windows 11 | W7 | Totals from agenttail against a provider usage page | Tokens match dsh's own records within about 1%; cost does not reconcile (see Cost accuracy) |
| 2026-10-22 | Claude Code 2.1.304, headless | Windows 11 | D1, D5 | `initialize`, `set_permission_mode`, `list_models` with a scratch config, no model call | Pass; `manual` is reported back as `default` |
| - | Claude Code, desktop sessions | Windows 11 | W13 | A live `waiting` status file while a permission prompt is open | Owed: only unit-tested so far |
| 2026-10-21 | Antigravity CLI 1.4.4, interactive | Windows 11 | W13 | What is written while a permission prompt is open | Log writes `Surfacing tool confirmation`; the step has status 9 in the conversation database; the transcript has no line for it. The prompt was raised behind the CLI's setup screen and never displayed |
| 2026-10-21 | Antigravity CLI 1.4.4, print mode | Windows 11 | W13, D3 | The same command with `-p` | Denied without asking: `soft-denying tool confirmation`, then `Tool confirmation for conversation <id> step N (... approved=false)`; step status 7; `denied_actions` in the result |
| 2026-10-22 | Antigravity CLI 1.4.5, print mode | Windows 11 | W13, X2 | agenttail against a run on the updated CLI | Pass: the reader followed open and close although the log line numbers moved; no needs-you for the denied call |
| 2026-10-22 | Antigravity CLI 1.4.5, print mode | Windows 11 | D1 | `--input-format stream-json` start and `/config`, `/usage` slash commands | `init`, `step_update`, `result` events confirmed; slash commands answer without a model turn when not rewritten by the shell |
| - | Antigravity CLI, interactive | Windows 11 | W13 | A person approves a prompt with agenttail open | Owed: the closing log line for an approved prompt is unobserved, so the signal stays "probable" |
