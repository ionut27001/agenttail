'use strict';

/**
 * Harness registry: which agent programs the control plane may start, and how.
 *
 * The registry comes from the `harnesses` block of control.json and nothing
 * else.  A command never arrives in an API request or from the page, and
 * agenttail never downloads or installs a harness.  Top-level dsh keys from
 * older config files (dshProfile, dshCommand, dshArgs, dshHome, patch) still
 * work: they are read as the `dsh` entry only when `harnesses` is absent.
 */

const path = require('node:path');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const PRESET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_()]*$/;
const MAX_HARNESSES = 16;
const MAX_ARGS = 64;
const MAX_PRESETS = 16;
const DEFAULT_PROFILE = 'acp';

/**
 * Environment a non-dsh harness gets besides `envPass` and its static `env`:
 * where things live and how to find programs, no secrets.  Matched ignoring
 * case, since Windows spells PATH as Path.
 */
const BASE_ENV = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
];

/** dsh takes its permission preset as an environment variable at spawn time. */
const DSH_PRESETS = [
  {
    id: 'workspace-write',
    label: 'workspace-write — sandboxed, approvals ask',
    danger: false,
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
  },
  {
    id: 'read-only',
    label: 'read-only — no writes, approvals ask',
    danger: false,
    env: { DSH_PERMISSION_MODE: 'read-only' },
  },
  {
    id: 'danger-full-access',
    label: 'danger-full-access — no sandbox (explicit only)',
    danger: true,
    env: { DSH_PERMISSION_MODE: 'danger-full-access' },
  },
];
const DSH_DEFAULT_PRESET = 'workspace-write';

/** A harness with no presets of its own runs as the agent is configured. */
const AGENT_DEFAULT_PRESET = { id: 'default', label: 'agent default', danger: false };

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function stringList(value, max = MAX_ARGS) {
  return Array.isArray(value) ? value.slice(0, max).map(String) : [];
}

function envNames(value) {
  return stringList(value, 64).filter((name) => ENV_NAME_RE.test(name));
}

/** A static env block: only plain string values; kept out of audit and API output. */
function staticEnv(value) {
  const out = {};
  if (!isPlainObject(value)) return out;
  for (const [name, entry] of Object.entries(value)) {
    if (ENV_NAME_RE.test(name) && typeof entry === 'string') out[name] = entry;
  }
  return out;
}

/** `command` and paths in the config resolve against the config directory when relative. */
function resolveFromConfig(value, base) {
  const text = String(value);
  return path.isAbsolute(text) ? text : path.resolve(base, text);
}

function parsePreset(raw) {
  if (!isPlainObject(raw)) return null;
  const id = String(raw.id ?? '');
  if (!PRESET_ID_RE.test(id)) return null;
  const preset = {
    id,
    label: raw.label ? String(raw.label).slice(0, 120) : id,
    danger: raw.danger === true,
  };
  if (isPlainObject(raw.env)) preset.env = staticEnv(raw.env);
  if (typeof raw.mode === 'string' && raw.mode) preset.mode = raw.mode;
  if (isPlainObject(raw.config) && typeof raw.config.configId === 'string' && raw.config.configId
    && raw.config.value !== undefined && raw.config.value !== null) {
    preset.config = { configId: raw.config.configId, value: String(raw.config.value) };
  }
  return preset;
}

function parseHarness(id, raw, base) {
  if (!ID_RE.test(id) || !isPlainObject(raw)) return null;
  const kind = raw.kind === 'dsh' || raw.kind === 'acp' ? raw.kind : (id === 'dsh' ? 'dsh' : 'acp');
  let command = typeof raw.command === 'string' && raw.command ? raw.command : null;
  if (command && /[\\/]/.test(command)) command = resolveFromConfig(command, base);
  // Only dsh has a built-in way to be found (`dsh` on PATH); anything else must
  // be named in the file.
  if (kind === 'acp' && !command) return null;

  const presets = (Array.isArray(raw.presets) ? raw.presets : [])
    .slice(0, MAX_PRESETS)
    .map(parsePreset)
    .filter(Boolean);
  const own = presets.length > 0;
  if (!own) presets.push(...(kind === 'dsh' ? DSH_PRESETS : [AGENT_DEFAULT_PRESET]));
  let defaultPreset = typeof raw.defaultPreset === 'string' && presets.some((p) => p.id === raw.defaultPreset)
    ? raw.defaultPreset
    : null;
  if (!defaultPreset) {
    defaultPreset = kind === 'dsh' && !own
      ? DSH_DEFAULT_PRESET
      : (presets.find((preset) => !preset.danger) || presets[0]).id;
  }

  return {
    id,
    label: raw.label ? String(raw.label).slice(0, 80) : (kind === 'dsh' ? 'dsh' : id),
    kind,
    command,
    args: stringList(raw.args),
    profile: kind === 'dsh' ? (typeof raw.profile === 'string' && raw.profile ? raw.profile : DEFAULT_PROFILE) : null,
    home: kind === 'dsh' && typeof raw.home === 'string' && raw.home ? resolveFromConfig(raw.home, base) : null,
    patch: kind === 'dsh' && typeof raw.patch === 'string' && raw.patch ? resolveFromConfig(raw.patch, base) : null,
    envPass: envNames(raw.envPass),
    env: staticEnv(raw.env),
    presets,
    defaultPreset,
    // Which existing log adapter renders this harness's sessions, if any.
    log: raw.log === 'dsh' || raw.log === 'claude' ? raw.log : (kind === 'dsh' ? 'dsh' : null),
  };
}

class HarnessRegistry {
  /** `error` is set when the config named harnesses and none of them was usable. */
  constructor(entries, defaultId, error = null) {
    this.list = entries;
    this.byId = new Map(entries.map((entry) => [entry.id, entry]));
    this.defaultId = this.byId.has(defaultId) ? defaultId : (entries[0] ? entries[0].id : null);
    this.error = error;
  }

  get(id) {
    return this.byId.get(id === undefined || id === null || id === '' ? this.defaultId : String(id)) || null;
  }

  /** What the page may see: no environment, no secrets. */
  describe(env = process.env) {
    return this.list.map((harness) => describeHarness(harness, env));
  }
}

/**
 * Parse the harness part of control.json.  With no `harnesses` key at all the
 * legacy top-level dsh keys describe a single `dsh` harness (and with those
 * absent too, plain defaults do).  A `harnesses` key that yields nothing is a
 * config mistake, not a request for dsh: the registry is empty and says why.
 */
function parseHarnesses(raw, base) {
  const source = isPlainObject(raw) ? raw : {};
  const entries = [];
  if (source.harnesses !== undefined) {
    const skipped = [];
    if (isPlainObject(source.harnesses)) {
      for (const [id, entry] of Object.entries(source.harnesses)) {
        if (entries.length >= MAX_HARNESSES) break;
        const parsed = parseHarness(id, entry, base);
        if (parsed) entries.push(parsed);
        else skipped.push(id.slice(0, 40));
      }
    }
    if (entries.length) {
      return new HarnessRegistry(entries, typeof source.defaultHarness === 'string' ? source.defaultHarness : null);
    }
    const why = !isPlainObject(source.harnesses)
      ? 'it must be an object of harness entries'
      : (skipped.length
        ? `no entry is usable (each needs a valid id and, unless it is dsh, a command); skipped: ${skipped.slice(0, 8).join(', ')}`
        : 'it has no entries');
    return new HarnessRegistry([], null, `control.json has a "harnesses" block but ${why}. Fix it, or remove the block to use the default dsh harness.`);
  }
  entries.push(parseHarness('dsh', {
    kind: 'dsh',
    command: source.dshCommand,
    args: source.dshArgs,
    profile: source.dshProfile,
    home: source.dshHome,
    patch: source.patch,
  }, base));
  return new HarnessRegistry(entries, typeof source.defaultHarness === 'string' ? source.defaultHarness : null);
}

function parseEnvArgs(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** The program and arguments that will run, from the config (and the dsh env overrides tests use). */
function resolveCommand(harness, env = process.env) {
  if (harness.kind === 'dsh') {
    const prefix = harness.args.length ? harness.args : parseEnvArgs(env.AGENTTAIL_DSH_ARGS);
    const args = [...prefix, '--profile', harness.profile];
    if (harness.patch) args.push('--patch', harness.patch);
    return { bin: harness.command || env.AGENTTAIL_DSH_BIN || 'dsh', args };
  }
  return { bin: harness.command, args: harness.args.slice() };
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function commandLine(harness, env = process.env) {
  const { bin, args } = resolveCommand(harness, env);
  return [bin, ...args].map(quoteArg).join(' ');
}

/**
 * The child's environment.  dsh keeps the whole environment: it needs the
 * provider keys the user already exported.  Every other harness gets the base
 * variables, the names listed in `envPass`, and its static `env`, so one
 * program's keys do not leak into another's process.  A preset's `env` is
 * applied last.
 */
function buildEnv(harness, preset, parent = process.env) {
  let env;
  if (harness.kind === 'dsh') {
    env = { ...parent };
  } else {
    const allowed = new Set([...BASE_ENV, ...harness.envPass].map((name) => name.toUpperCase()));
    env = {};
    for (const key of Object.keys(parent)) {
      if (allowed.has(key.toUpperCase()) && typeof parent[key] === 'string') env[key] = parent[key];
    }
  }
  Object.assign(env, harness.env);
  if (harness.kind === 'dsh' && harness.home) env.DSH_HOME = harness.home;
  if (preset && preset.env) Object.assign(env, preset.env);
  return env;
}

function describeHarness(harness, env = process.env) {
  return {
    id: harness.id,
    label: harness.label,
    kind: harness.kind,
    log: harness.log,
    // The page can show a session it starts only when an existing log adapter renders it.
    viewable: harness.log === 'dsh',
    commandLine: commandLine(harness, env),
    presets: harness.presets.map((preset) => ({ id: preset.id, label: preset.label, danger: preset.danger === true })),
    defaultPreset: harness.defaultPreset,
  };
}

/** Preset ids dsh has always offered; kept for the status payload. */
const PRESETS = ['read-only', 'workspace-write', 'danger-full-access'];

module.exports = {
  HarnessRegistry,
  parseHarnesses,
  resolveCommand,
  commandLine,
  buildEnv,
  describeHarness,
  BASE_ENV,
  DSH_PRESETS,
  DSH_DEFAULT_PRESET,
  PRESETS,
};
