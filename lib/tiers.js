'use strict';

/**
 * Permission modes and their risk tiers (docs/dev/harness-coverage.md, W14).
 *
 * Each harness has its own words for how much an agent may do without asking.
 * Every source reader hands its raw names to one function here, which returns
 * the same small record for the page:
 *
 *   { tier, names, currency, fullAccess }
 *
 *   tier        asks | edits | reviewer | plan | refuses | bypass | neutral
 *   names       the raw values that decided it, as the harness wrote them
 *   currency    how current the reading is (see CURRENCIES)
 *   fullAccess  a sandbox that allows full access sits behind the mode
 *
 * A name that is not in a table is "neutral": shown as it is, never guessed.
 * Readings that span tiers (preset and sandbox, flag and setting) take the
 * riskiest known tier; a neutral name only decides when nothing else does.
 */

const TIERS = ['asks', 'edits', 'reviewer', 'plan', 'refuses', 'bypass', 'neutral'];

/**
 * How current a reading is:
 *   exact          the harness logs every change (DeepSeek Harness events)
 *   last-prompt    written on each prompt, so a switch shows at the next one (Claude Code)
 *   process-start  read once when the process started (Antigravity CLI log)
 *   configured     a settings file, not proof of what a conversation did (Antigravity editor)
 *   unknown        no reading
 */
const CURRENCIES = ['exact', 'last-prompt', 'process-start', 'configured', 'unknown'];

// Safest first. The order only matters when one session names several tiers.
const RISK = { plan: 0, refuses: 1, asks: 2, edits: 3, reviewer: 4, bypass: 5 };

const MAX_NAMES = 6;
const MAX_NAME = 80;

/**
 * A raw name as a short single-line string (control characters out), or null.
 * A long one is replaced, not cut: half a secret would no longer match the
 * redactor's patterns and would still leak.
 */
function cleanName(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!s) return null;
  return s.length > MAX_NAME ? '[long name]' : s;
}

function reading(tier, names, currency, fullAccess = false) {
  return {
    tier: TIERS.includes(tier) ? tier : 'neutral',
    names: [...new Set((names || []).map(cleanName).filter(Boolean))].slice(0, MAX_NAMES),
    currency: CURRENCIES.includes(currency) ? currency : 'unknown',
    fullAccess: fullAccess === true,
  };
}

/** No reading at all. */
function unknown() {
  return reading('neutral', [], 'unknown');
}

/** The riskiest known tier among `tiers`; neutral only when none is known. */
function riskiestTier(tiers) {
  let best = null;
  for (const t of tiers) {
    if (Object.hasOwn(RISK, t) && (best === null || RISK[t] > RISK[best])) best = t;
  }
  return best || 'neutral';
}

const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

/* --------------------------------------------------------- DeepSeek Harness */

const DSH_PRESET = {
  'workspace-write': 'asks',
  'danger-full-access': 'bypass',
  // The auto review integration: a reviewer approves instead of the person.
  auto: 'reviewer',
  plan: 'plan',
};

/**
 * From the log's permission/preset, sandbox/mode and approval/policy values.
 * A named preset and the sandbox + approval pair each give a tier, and the
 * riskiest wins, so a switch that has only reached one of the three events
 * never reads safer than it is. A pair outside the table ("custom") is neutral.
 */
function fromDsh({ preset, sandbox, policy } = {}) {
  const names = [preset, sandbox, policy];
  if (!preset && !sandbox && !policy) return unknown();
  const tiers = [];
  if (preset) tiers.push(own(DSH_PRESET, preset) || 'neutral');
  if (sandbox && policy) {
    if (sandbox === 'workspace-write' && policy === 'ask') tiers.push('asks');
    else if (sandbox === 'danger-full-access' && policy === 'never') tiers.push('bypass');
    else tiers.push('neutral');
  }
  const tier = riskiestTier(tiers);
  const fullAccess = sandbox ? sandbox === 'danger-full-access' : preset === 'auto' || preset === 'danger-full-access';
  // An unmatched pair is named by its preset ("custom") when the log has one.
  return reading(tier, tier === 'neutral' && preset ? [preset, sandbox, policy] : names, 'exact', fullAccess);
}

/* -------------------------------------------------------------- Claude Code */

const CLAUDE_MODE = {
  default: 'asks',
  manual: 'asks',
  acceptEdits: 'edits',
  auto: 'reviewer',
  plan: 'plan',
  dontAsk: 'refuses',
  bypassPermissions: 'bypass',
};

/** From the permissionMode on the latest user entry. */
function fromClaude(mode) {
  const name = cleanName(mode);
  if (!name) return unknown();
  return reading(own(CLAUDE_MODE, name) || 'neutral', [name], 'last-prompt');
}

/* ------------------------------------------------------- Antigravity (CLI) */

const AGY_TOOL_PERMISSION = {
  'request-review': 'asks',
  strict: 'asks',
  'proceed-in-sandbox': 'edits',
  'always-proceed': 'bypass',
};

const AGY_AGENT_MODE = {
  default: 'asks',
  'accept-edits': 'edits',
  auto: 'reviewer',
  plan: 'plan',
};

/**
 * From the CLI log at process start: the toolPermission setting, plus a
 * --mode value or --dangerously-skip-permissions when the log names one.
 * Without a flag the mode a person cycles to inside the session is not logged.
 */
function fromAgyCli({ toolPermission, mode, skipPermissions } = {}) {
  const names = [];
  const tiers = [];
  if (toolPermission) {
    names.push(toolPermission);
    tiers.push(own(AGY_TOOL_PERMISSION, toolPermission) || 'neutral');
  }
  if (mode) {
    names.push(mode);
    tiers.push(own(AGY_AGENT_MODE, mode) || 'neutral');
  }
  if (skipPermissions) {
    names.push('--dangerously-skip-permissions');
    tiers.push('bypass');
  }
  if (!names.length) return unknown();
  return reading(riskiestTier(tiers), names, 'process-start');
}

/* ------------------------------------------------------ Antigravity (editor) */

const EDITOR_PREFIX = /^(?:AGENT_PERMISSION_PRESET_|CASCADE_COMMANDS_AUTO_EXECUTION_|AGENT_SETTING_POLICY_)/;
const EDITOR_PRESET = { REQUEST_REVIEW: 'asks', AUTO: 'edits', TURBO: 'bypass' };
const EDITOR_AUTO_EXECUTION = { OFF: 'asks', AUTO: 'edits', EAGER: 'bypass' };
const EDITOR_NON_WORKSPACE = { ASK: 'asks', DENY: 'asks', ALLOW: 'bypass' };

const editorKey = (value) => String(value).trim().toUpperCase().replace(EDITOR_PREFIX, '');

/** From the three userSettings keys of the editor's settings file. */
function fromAgyEditor({ permissionPreset, autoExecutionPolicy, nonWorkspaceFileAccessPolicy } = {}) {
  const names = [];
  const tiers = [];
  for (const [value, table] of [
    [permissionPreset, EDITOR_PRESET],
    [autoExecutionPolicy, EDITOR_AUTO_EXECUTION],
    [nonWorkspaceFileAccessPolicy, EDITOR_NON_WORKSPACE],
  ]) {
    const name = cleanName(value);
    if (!name) continue;
    names.push(name);
    tiers.push(own(table, editorKey(name)) || 'neutral');
  }
  if (!names.length) return unknown();
  return reading(riskiestTier(tiers), names, 'configured');
}

/* -------------------------------------------------------------------- page */

/** The record as the page gets it: fixed vocabulary for tier and currency, `text` over the names. */
function forPage(value, text = (s) => s) {
  const r = value && typeof value === 'object' ? value : unknown();
  const out = reading(r.tier, Array.isArray(r.names) ? r.names : [], r.currency, r.fullAccess);
  out.names = out.names.map((n) => text(n));
  return out;
}

/** Whether a reading changed in a way the page must shout about: into bypass from a known other tier. */
function enteredBypass(before, after) {
  return !!before && !!after && before.tier !== 'bypass' && after.tier === 'bypass';
}

/** A stable string for change detection (status keys). */
function key(value) {
  if (!value) return '';
  return `${value.tier}|${value.currency}|${value.fullAccess ? 1 : 0}|${(value.names || []).join(',')}`;
}

module.exports = {
  TIERS, CURRENCIES, unknown, fromDsh, fromClaude, fromAgyCli, fromAgyEditor, forPage, enteredBypass, key, riskiestTier,
};
