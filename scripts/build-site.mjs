#!/usr/bin/env node
/**
 * Assemble the project site (GitHub Pages) into dist/site.
 *
 *   node scripts/build-site.mjs [--out dist/site] [--serve [port]]
 *
 * The site is site/ plus the app's own Tail, thought bubble, games, themes and
 * fonts (public/app, public/vendor/fonts) and the README images (docs/), so it
 * always shows the code that ships. --serve previews it on 127.0.0.1.
 */
'use strict';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const OUT = path.resolve(ROOT, argValue('--out', path.join('dist', 'site')));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// What the site borrows from the app, by destination.
const SHARED = {
  'app/themes.css': 'public/app/themes.css',
  'app/tail.css': 'public/app/tail.css',
  'app/buddy.js': 'public/app/buddy.js',
  'app/think-bubble.js': 'public/app/think-bubble.js',
  'app/mascot-games.js': 'public/app/mascot-games.js',
  'app/mascot-games-more.js': 'public/app/mascot-games-more.js',
  'favicon.svg': 'public/favicon.svg',
};
const IMAGES = ['hero.gif', 'tail.gif', 'wall.png', 'themes.png', 'screenshot-dark.png', 'chat-log.png', 'stream-mode.png', 'logo.svg', 'wordmark.svg'];

async function build() {
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(OUT, { recursive: true });
  for (const entry of await fsp.readdir(path.join(ROOT, 'site'))) {
    const from = path.join(ROOT, 'site', entry);
    const to = path.join(OUT, entry);
    if (entry.endsWith('.html')) {
      await fsp.writeFile(to, (await fsp.readFile(from, 'utf8')).replaceAll('{{version}}', VERSION));
    } else {
      await fsp.cp(from, to, { recursive: true });
    }
  }
  for (const [to, from] of Object.entries(SHARED)) {
    await fsp.mkdir(path.dirname(path.join(OUT, to)), { recursive: true });
    await fsp.copyFile(path.join(ROOT, from), path.join(OUT, to));
  }
  await fsp.cp(path.join(ROOT, 'public', 'vendor', 'fonts'), path.join(OUT, 'vendor', 'fonts'), { recursive: true });
  await fsp.copyFile(path.join(ROOT, 'public', 'vendor', 'LICENSES', 'jetbrains-mono.txt'), path.join(OUT, 'vendor', 'fonts', 'LICENSE-jetbrains-mono.txt'));
  await fsp.mkdir(path.join(OUT, 'img'), { recursive: true });
  for (const name of IMAGES) await fsp.copyFile(path.join(ROOT, 'docs', name), path.join(OUT, 'img', name));
  // Plain static files: no Jekyll processing on GitHub Pages.
  await fsp.writeFile(path.join(OUT, '.nojekyll'), '');
  console.log(`site v${VERSION} -> ${path.relative(ROOT, OUT)}`);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function serve(port) {
  http.createServer(async (req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(OUT, url.endsWith('/') ? url + 'index.html' : url);
    if (!file.startsWith(OUT)) { res.writeHead(403).end(); return; }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  }).listen(port, '127.0.0.1', () => console.log(`preview http://127.0.0.1:${port}/`));
}

await build();
if (args.includes('--serve')) serve(Number(argValue('--serve', 8790)));
