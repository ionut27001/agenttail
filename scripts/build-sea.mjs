#!/usr/bin/env node
/**
 * Build the Windows standalone executable with Node's Single Executable
 * Applications support. Run on Windows with Node 24+:
 *
 *   npm install
 *   node scripts/build-sea.mjs
 *
 * The runtime stays dependency-free; esbuild/postject are development tools.
 */
'use strict';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'sea');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const NAME = `agenttail-${VERSION}-win-x64.exe`;

async function walk(dir, base = dir, out = {}) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else {
      const rel = path.relative(base, full).split(path.sep).join('/');
      out[rel] = full;
    }
  }
  return out;
}

(async () => {
  if (process.platform !== 'win32') throw new Error('the standalone build is produced on Windows');
  await fsp.mkdir(DIST, { recursive: true });
  await fsp.rm(STAGE, { recursive: true, force: true });
  await fsp.mkdir(STAGE, { recursive: true });
  await fsp.cp(path.join(ROOT, 'public'), path.join(STAGE, 'public'), { recursive: true });

  await build({
    absWorkingDir: ROOT,
    entryPoints: ['server.js'],
    outfile: path.join(STAGE, 'server.bundle.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    legalComments: 'none',
    logLevel: 'info',
  });

  const files = await walk(path.join(STAGE, 'public'));
  const assets = {};
  for (const rel of Object.keys(files)) assets[rel] = 'public/' + rel;
  const seaConfig = path.join(STAGE, 'sea-config.json');
  const blob = path.join(STAGE, 'sea-prep.blob');
  await fsp.writeFile(seaConfig, JSON.stringify({
    main: 'server.bundle.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  }, null, 2) + '\n');

  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit', cwd: STAGE });
  const stagedExe = path.join(STAGE, NAME);
  await fsp.copyFile(process.execPath, stagedExe);
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
    stagedExe,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ], { stdio: 'inherit', cwd: STAGE });
  const exe = path.join(DIST, NAME);
  await fsp.copyFile(stagedExe, exe);

  const stat = await fsp.stat(exe);
  console.log(`built ${path.relative(ROOT, exe)} (${(stat.size / 1024 / 1024).toFixed(1)} MiB)`);
  await fsp.rm(STAGE, { recursive: true, force: true });
})().catch(async (err) => {
  await fsp.rm(STAGE, { recursive: true, force: true }).catch(() => {});
  console.error(err);
  process.exitCode = 1;
});
