'use strict';

const path = require('node:path');

/**
 * Find a log file a command redirects into, e.g.
 *   $log='/path/to/build.log'; cmake --build build *> $log
 * Returns an absolute path when the target is inside an allowed root.
 */
function jobLogFromCommand(command, cwd, isAllowed) {
  const text = String(command || '');
  if (!text) return null;

  const vars = new Map();
  const assign = /\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"])([\s\S]*?)\2/g;
  let m;
  while ((m = assign.exec(text))) vars.set(m[1], m[3]);

  const targets = [];
  const redirect = /(?:\*>>|\*>|>>|>)\s*(\$[A-Za-z_][A-Za-z0-9_]*|"[^"]*"|'[^']*'|[^\s;&|>]+)/g;
  while ((m = redirect.exec(text))) {
    let target = m[1].trim();
    if (target.startsWith('$')) {
      const name = target.slice(1);
      if (!vars.has(name)) continue;
      target = vars.get(name);
    }
    target = target.replace(/^["']|["']$/g, '');
    if (!target || /^(&\d+|nul|\/dev\/null|con)$/i.test(target)) continue;
    targets.push(target);
  }
  if (!targets.length) return null;

  const resolved = path.resolve(cwd || process.cwd(), targets[targets.length - 1]);
  if (typeof isAllowed === 'function' && !isAllowed(resolved)) return null;
  return resolved;
}

module.exports = { jobLogFromCommand };
