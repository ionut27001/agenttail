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

module.exports = { PRICES, isPeak, costOf };
