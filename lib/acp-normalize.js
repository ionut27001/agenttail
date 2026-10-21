'use strict';

/**
 * Turns the loose shapes ACP agents send into the small, fixed objects the rest
 * of agenttail uses.  Nothing here talks to a process; it is all pure functions.
 */

const MAX_TEXT = 8000;
const MAX_COMMAND = 64000;
const MAX_DIFF_TEXT = 20000;
const MAX_DIFFS = 20;
const MAX_LOCATIONS = 50;
const MAX_CONTENT = 20000;

/**
 * Pick the permission option for a decision, by its ACP `kind`, never by its
 * position: ACP does not fix the order of `options`, so the first one may well
 * be "always allow".
 *
 * Approve is `allow_once` and nothing else; with no such option the caller
 * refuses and the user can still reject.  Reject is `reject_once`, or
 * `reject_always` only when that is all the agent offers.
 */
function chooseOption(options, decision) {
  const list = Array.isArray(options) ? options : [];
  const byKind = (kind) => list.find((option) => option && option.kind === kind) || null;
  if (decision === 'approve') return byKind('allow_once');
  if (decision === 'reject') return byKind('reject_once') || byKind('reject_always');
  return null;
}

function toolText(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'content' && block.content) return toolText(block.content);
  if (typeof block.text === 'string') return block.text;
  return '';
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? { text: `${text.slice(0, max)}…`, cut: true } : { text, cut: false };
}

/** `diff` blocks of a tool call's content: { path, oldText, newText } (oldText null = new file). */
function contentDiffs(content) {
  const out = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== 'object' || block.type !== 'diff') continue;
    out.push({
      path: block.path ? String(block.path) : null,
      oldText: block.oldText === null || block.oldText === undefined ? null : String(block.oldText),
      newText: String(block.newText ?? ''),
    });
  }
  return out;
}

/** The edit a raw input describes, for harnesses that send old/new strings and no diff block. */
function rawDiff(raw) {
  if (typeof raw.old_string !== 'string' && typeof raw.new_string !== 'string') return null;
  return {
    path: raw.file_path || raw.path ? String(raw.file_path || raw.path) : null,
    oldText: typeof raw.old_string === 'string' ? raw.old_string : '',
    newText: typeof raw.new_string === 'string' ? raw.new_string : '',
  };
}

function rawCommand(raw) {
  if (typeof raw.command === 'string') return raw.command;
  if (Array.isArray(raw.command) && raw.command.every((part) => typeof part === 'string')) return raw.command.join(' ');
  return null;
}

/**
 * What a permission request is about, from the tool call that raised it:
 * the raw input (command, edits, paths) first, the agent-written title kept
 * beside it.  A harness that sends a diff but no raw input still gets a card
 * with something real on it.
 */
function toolCallFacts(toolCall) {
  const call = toolCall && typeof toolCall === 'object' ? toolCall : {};
  const raw = call.rawInput && typeof call.rawInput === 'object' && !Array.isArray(call.rawInput) ? call.rawInput : {};
  let truncated = false;
  const cut = (value, max) => {
    const clipped = clip(value, max);
    if (clipped.cut) truncated = true;
    return clipped.text;
  };

  const found = contentDiffs(call.content);
  const fromRaw = rawDiff(raw);
  if (fromRaw && !found.length) found.push(fromRaw);
  const diffs = found.slice(0, MAX_DIFFS).map((diff) => ({
    path: diff.path,
    oldText: diff.oldText === null ? '' : cut(diff.oldText, MAX_DIFF_TEXT),
    newText: cut(diff.newText, MAX_DIFF_TEXT),
    isNew: diff.oldText === null,
  }));
  if (found.length > MAX_DIFFS) truncated = true;

  const locations = [];
  for (const entry of Array.isArray(call.locations) ? call.locations : []) {
    if (!entry || typeof entry !== 'object' || !entry.path) continue;
    const location = { path: String(entry.path) };
    if (Number.isInteger(entry.line)) location.line = entry.line;
    locations.push(location);
    if (locations.length >= MAX_LOCATIONS) break;
  }
  if (!locations.length) {
    const only = raw.file_path || raw.path;
    if (typeof only === 'string' && only) locations.push({ path: only });
  }

  const keep = ['command', 'file_path', 'path', 'workdir', 'description', 'justification', 'pattern', 'old_string', 'new_string', 'content'];
  const lean = {};
  for (const key of keep) {
    if (raw[key] === undefined) continue;
    const value = raw[key];
    lean[key] = typeof value === 'string' ? cut(value, MAX_TEXT) : value;
  }

  const text = (Array.isArray(call.content) ? call.content : []).map(toolText).filter(Boolean).join('\n');
  const command = rawCommand(raw);
  return {
    title: String(call.title || call.kind || 'Permission request').slice(0, 300),
    toolKind: String(call.kind || ''),
    toolCallId: String(call.toolCallId || ''),
    command: command === null ? null : cut(command, MAX_COMMAND),
    diff: diffs[0] || null,
    diffs,
    locations,
    content: text.slice(0, MAX_CONTENT),
    rawInput: Object.keys(lean).length ? lean : null,
    truncated,
  };
}

function hasFacts(approval) {
  return !!(approval.command || (approval.diffs && approval.diffs.length) || (approval.locations && approval.locations.length)
    || approval.content || approval.rawInput);
}

function normalizeOptions(options) {
  return (Array.isArray(options) ? options : [])
    .filter((option) => option && typeof option === 'object' && option.optionId !== undefined)
    .map((option) => ({
      optionId: String(option.optionId),
      name: String(option.name || option.optionId),
      kind: String(option.kind || ''),
    }));
}

/**
 * One `session/request_permission`, joined with the tool call it is about, as
 * the approval object every consumer reads.  `toolCall` is the tool call as
 * last seen in `session/update` merged with what the request itself carries.
 */
function normalizeApproval({ harness, requestId, toolCall, options, createdAt }) {
  return {
    approvalId: String(requestId),
    origin: 'harness',
    harness: harness ? String(harness) : null,
    ...toolCallFacts(toolCall),
    options: normalizeOptions(options),
    createdAt: createdAt || Date.now(),
  };
}

/** The part of an approval the page and the HTTP API may see. */
function publicApproval(approval) {
  return {
    approvalId: approval.approvalId,
    origin: approval.origin,
    harness: approval.harness,
    title: approval.title,
    toolKind: approval.toolKind,
    kind: approval.toolKind,
    toolCallId: approval.toolCallId,
    command: approval.command,
    diff: approval.diff,
    diffs: approval.diffs,
    locations: approval.locations,
    content: approval.content,
    rawInput: approval.rawInput,
    truncated: approval.truncated === true,
    options: approval.options,
    canApprove: !!chooseOption(approval.options, 'approve'),
    canReject: !!chooseOption(approval.options, 'reject'),
    createdAt: approval.createdAt,
  };
}

/* ---------- config options and capabilities ---------- */

const MAX_CONFIG_OPTIONS = 32;
const MAX_CONFIG_VALUES = 500;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
// ACP declares a capability by including it; `{}` means supported.
const declared = (value) => value !== undefined && value !== null && value !== false;

/**
 * A model value is either a JSON `[provider, model]` pair (dsh), a
 * `provider/model` string, or a plain model id.
 */
function splitModelValue(value) {
  const raw = String(value ?? '');
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return { provider: String(parsed[0]), model: String(parsed[1]), value: raw };
    }
  } catch { /* older/plain values */ }
  const cut = raw.indexOf('/');
  if (cut > 0) return { provider: raw.slice(0, cut), model: raw.slice(cut + 1), value: raw };
  return { provider: '', model: raw, value: raw };
}

function flattenChoices(entries, group, out) {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (out.length >= MAX_CONFIG_VALUES) return;
    if (!isObject(entry)) continue;
    if (Array.isArray(entry.options)) {
      flattenChoices(entry.options, String(entry.group || entry.name || group || ''), out);
      continue;
    }
    if (entry.value === undefined || entry.value === null) continue;
    out.push({
      value: String(entry.value),
      name: String(entry.name || entry.value).slice(0, 200),
      group: String(entry.group || group || ''),
    });
  }
}

/**
 * The agent's config options as one flat, bounded list:
 * [{ id, name, category, type, current, options: [{ value, name, group }] }].
 * Agents that only offer the older Session Modes API get a synthetic `mode`
 * option so the page has one thing to read.
 */
function normalizeConfigOptions(rawOptions, legacyModes) {
  const out = [];
  for (const raw of Array.isArray(rawOptions) ? rawOptions : []) {
    if (out.length >= MAX_CONFIG_OPTIONS) break;
    if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) continue;
    const choices = [];
    flattenChoices(raw.options, '', choices);
    const current = raw.currentValue;
    out.push({
      id: raw.id,
      name: String(raw.name || raw.id).slice(0, 120),
      category: typeof raw.category === 'string' ? raw.category : '',
      type: typeof raw.type === 'string' ? raw.type : 'select',
      current: current === undefined || current === null ? null : (typeof current === 'boolean' ? current : String(current)),
      options: choices,
    });
  }
  const modes = isObject(legacyModes) && Array.isArray(legacyModes.availableModes) ? legacyModes.availableModes : [];
  if (modes.length && !out.some((option) => option.category === 'mode')) {
    out.push({
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      current: legacyModes.currentModeId === undefined ? null : String(legacyModes.currentModeId),
      options: modes
        .filter((mode) => isObject(mode) && mode.id !== undefined)
        .slice(0, MAX_CONFIG_VALUES)
        .map((mode) => ({ value: String(mode.id), name: String(mode.name || mode.id).slice(0, 200), group: '' })),
      legacy: true,
    });
  }
  return out;
}

/** The option holding the model: category `model`, else the id `model`. */
function findModelOption(options) {
  const list = Array.isArray(options) ? options : [];
  const usable = (option) => Array.isArray(option.options) && option.options.length > 0;
  return list.find((option) => option.category === 'model' && usable(option))
    || list.find((option) => option.id === 'model' && usable(option))
    || null;
}

/** The mode option: category `mode`, else the id `mode`. */
function findModeOption(options) {
  const list = Array.isArray(options) ? options : [];
  return list.find((option) => option.category === 'mode')
    || list.find((option) => option.id === 'mode')
    || null;
}

/** Models as the page lists them: [{ value, name, provider, model }] and the current value. */
function modelChoices(options) {
  const option = findModelOption(options);
  if (!option) return { models: [], current: null, configId: null };
  const models = option.options.map((choice) => {
    const split = splitModelValue(choice.value);
    return {
      value: choice.value,
      name: choice.name || split.model || choice.value,
      provider: choice.group || split.provider || '',
      model: split.model,
    };
  });
  return {
    models,
    current: option.current !== null && option.current !== undefined ? String(option.current) : (models[0]?.value ?? null),
    configId: option.id,
  };
}

/**
 * What the agent said it can do, from `initialize` and `session/new`.  Anything
 * not declared is unsupported; the page gates its controls on this and not on
 * which harness it is.
 */
function probeCaps(init, created) {
  const result = isObject(init) ? init : {};
  const agent = isObject(result.agentCapabilities) ? result.agentCapabilities : {};
  const prompt = isObject(agent.promptCapabilities) ? agent.promptCapabilities : {};
  const session = isObject(agent.sessionCapabilities) ? agent.sessionCapabilities : {};
  const mcp = isObject(agent.mcpCapabilities) ? agent.mcpCapabilities : {};
  const info = isObject(result.agentInfo) ? result.agentInfo : {};
  const made = isObject(created) ? created : {};
  return {
    protocolVersion: Number.isInteger(result.protocolVersion) ? result.protocolVersion : null,
    agent: { name: String(info.name || '').slice(0, 120), version: String(info.version || '').slice(0, 60) },
    prompt: { image: prompt.image === true, audio: prompt.audio === true, embeddedContext: prompt.embeddedContext === true },
    loadSession: agent.loadSession === true,
    session: {
      list: declared(session.list),
      resume: declared(session.resume),
      close: declared(session.close),
      delete: declared(session.delete),
    },
    mcp: { http: mcp.http === true, sse: mcp.sse === true },
    authMethods: (Array.isArray(result.authMethods) ? result.authMethods : [])
      .slice(0, 16)
      .map((method) => String(isObject(method) ? method.id ?? '' : method).slice(0, 80))
      .filter(Boolean),
    config: normalizeConfigOptions(made.configOptions, made.modes),
  };
}

module.exports = {
  chooseOption,
  splitModelValue,
  normalizeConfigOptions,
  findModelOption,
  findModeOption,
  modelChoices,
  probeCaps,
  toolText,
  toolCallFacts,
  hasFacts,
  normalizeApproval,
  publicApproval,
};
