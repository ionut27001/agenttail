'use strict';

/**
 * DeepSeek-V4.1-Flash list prices, USD per 1M tokens.
 * Source: https://api-docs.deepseek.com/quick_start/pricing
 * Off-peak is half of peak. Peak = 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri,
 * excluding Chinese public holidays (holidays are not modelled).
 */
const PRICES = {
  model: 'DeepSeek-V4.1-Flash',
  unit: 1_000_000,
  currency: 'USD',
  peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  peakUtcWindows: [
    [1, 4],
    [6, 10],
  ],
  ronPerUsd: 4.6,
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
};

function isPeak(ts) {
  const d = new Date(ts || Date.now());
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  for (const [a, b] of PRICES.peakUtcWindows) if (h >= a && h < b) return true;
  return false;
}

function costOf(usage, ts) {
  if (!usage) return 0;
  const rate = isPeak(ts) ? PRICES.peak : PRICES.offPeak;
  return (
    (usage.input || 0) * rate.cacheMiss +
    (usage.cacheRead || 0) * rate.cacheHit +
    (usage.output || 0) * rate.output
  ) / PRICES.unit;
}

/**
 * Anthropic API list prices, USD per 1M tokens, from the official pricing
 * table. Claude Code on a subscription is not billed per token; these say what
 * the same tokens would have cost on the API. Cache writes cost 1.25x input
 * for the 5-minute cache and 2x for the 1-hour one; cache reads cost 0.1x
 * input unless the model has its own rate.
 * Rows: id prefix, input, output, cache read (optional), extras (optional).
 * Longer prefixes come first so claude-opus-5-5 never matches claude-opus-5.
 */
const CLAUDE_RATES = [
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1],
  ['claude-mythos-5', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, 0.2, { fast: [8, 40] }],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4', 15, 75],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4', 3, 15],
  // Haiku 5.5 has two rate cards: prompts over 100K tokens pay the second.
  ['claude-haiku-5-5', 0.1, 0.5, undefined, { longOver: 100_000, long: [0.5, 2.5] }],
  ['claude-haiku-4-5', 1, 5],
];
const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches

const CLAUDE_PRICES = {
  model: 'Claude API list prices',
  apiEquivalent: true,
  unit: 1_000_000,
  currency: 'USD',
  ronPerUsd: PRICES.ronPerUsd,
  source: 'https://claude.com/pricing',
};

/** The rate row for a model id, or null for a model with no list price. */
function claudeRate(model) {
  const raw = String(model || '').toLowerCase();
  const at = raw.indexOf('claude-');
  if (at < 0) return null;
  const id = raw.slice(at);
  for (const row of CLAUDE_RATES) {
    const prefix = row[0];
    if (id === prefix || (id.startsWith(prefix) && /^[-@\[]/.test(id.slice(prefix.length)))) return row;
  }
  return null;
}

/**
 * What one Claude reply would cost on the API, in USD, from the usage block
 * the API returned with it. Null when the model has no list price.
 */
function claudeCost(model, u) {
  const row = claudeRate(model);
  if (!row || !u) return null;
  const [, baseIn, baseOut, read, extra = {}] = row;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const split = u.cache_creation || {};
  const write1h = Math.min(cacheWrite, split.ephemeral_1h_input_tokens || 0);
  const write5m = cacheWrite - write1h;
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + cacheWrite;
  let input = baseIn;
  let output = baseOut;
  let cacheRead = read ?? baseIn * 0.1;
  if (extra.long && prompt > extra.longOver) {
    [input, output] = extra.long;
    cacheRead = input * 0.1;
  }
  if (extra.fast && u.speed === 'fast') {
    const scale = extra.fast[0] / input;
    [input, output] = extra.fast;
    cacheRead *= scale;
  }
  const searches = u.server_tool_use?.web_search_requests || 0;
  return (
    (u.input_tokens || 0) * input +
    (u.output_tokens || 0) * output +
    (u.cache_read_input_tokens || 0) * cacheRead +
    write5m * input * 1.25 +
    write1h * input * 2
  ) / 1_000_000 + searches * WEB_SEARCH_USD;
}

module.exports = { PRICES, isPeak, costOf, CLAUDE_PRICES, CLAUDE_RATES, claudeRate, claudeCost };
