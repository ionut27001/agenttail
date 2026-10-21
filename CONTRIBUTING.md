# Contributing

Thanks for considering a contribution.

1. Use Node 24 or newer.
2. `npm install` for the development-only tools (the runtime itself has no dependencies).
3. Make the change with synthetic fixtures only. Do not commit real session logs, screenshots of real sessions, local paths or config files.
4. Run `npm test`; it starts throwaway servers on loopback and drives headless Edge for the UI suite.
5. Keep the runtime dependency-free and every request local.

## Layout

- `server.js` — the local HTTP server (read side, SSE, control endpoints).
- `lib/` — session sources (dsh, Claude Code, Antigravity), redaction, roots, the agents overview, the ACP control plane.
- `public/index.html` — the page markup; `public/app/` holds its stylesheets (`themes.css` for the theme colours, `app.css`, `tail.css` for Tail) and classic scripts, loaded in order: `main.js` (event pipeline, editor, console, chat, layout), `mascot-games.js` and `mascot-games-more.js` (the games the mascot plays, sharing one set of effects), `buddy.js` (Tail, the mascot, made by a factory the wall reuses), `think-bubble.js` (Tail's thought bubble and the games host, also reused), `stage.js` (the console stage), `control.js`, `agents.js` (overview, watch wall, alerts) and the wall widgets (`wall-editor.js`, `wall-score.js`, `wall-console.js`, `wall-tail.js`, `wall-timeline.js`, `wall-tree.js`), then `context.js`.
- `public/vendor/` — vendored Monaco, xterm.js and fonts; nothing loads from a CDN.
- `site/` — the project site on GitHub Pages. `node scripts/build-site.mjs --serve` builds it into `dist/site` with the app's own Tail, games, themes and fonts and the README images, and previews it; the Pages workflow runs the same script on every push to `main`.
- `test/` — one suite per area; `npm test` runs them all.

By submitting a contribution you agree that it is licensed under the MIT
License in this repository.
