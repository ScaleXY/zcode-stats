'use strict';

/**
 * Per-million-token USD rates from Z.ai's official pricing page:
 * https://docs.z.ai/guides/overview/pricing (fetched 2026-08-28).
 *
 * Token semantics in the zcode database follow OpenAI-compatible usage
 * reporting: cache-read tokens are a SUBSET of input_tokens (verified against
 * computed_total_tokens = input + output), and cache writes bill at the
 * regular input rate (cache storage is listed as free). Therefore:
 *
 *   cost = (input - cache_read) / 1M * input_rate
 *        + cache_read          / 1M * cache_read_rate
 *        + output              / 1M * output_rate
 */
const PRICING = {
  // Flagships
  'GLM-5.3': { input: 1.4, cacheRead: 0.26, output: 4.4 },
  'GLM-5.2': { input: 1.4, cacheRead: 0.26, output: 4.4 },
  'GLM-5.1': { input: 1.4, cacheRead: 0.26, output: 4.4 },
  'GLM-5': { input: 1.0, cacheRead: 0.2, output: 3.2 },
  'GLM-5-Turbo': { input: 1.2, cacheRead: 0.24, output: 4.0 },
  // GLM-5.3-Flash is at a 50% promotion until 2026-09-09 (list: 0.15/0.03/0.50)
  'GLM-5.3-Flash': { input: 0.075, cacheRead: 0.015, output: 0.25 },
  // Older text models
  'GLM-4.7': { input: 0.6, cacheRead: 0.11, output: 2.2 },
  'GLM-4.7-FlashX': { input: 0.07, cacheRead: 0.01, output: 0.4 },
  'GLM-4.7-Flash': { input: 0, cacheRead: 0, output: 0, free: true },
  'GLM-4.6': { input: 0.6, cacheRead: 0.11, output: 2.2 },
  'GLM-4.5': { input: 0.6, cacheRead: 0.11, output: 2.2 },
  'GLM-4.5-X': { input: 2.2, cacheRead: 0.45, output: 8.9 },
  'GLM-4.5-Air': { input: 0.2, cacheRead: 0.03, output: 1.1 },
  'GLM-4.5-AirX': { input: 1.1, cacheRead: 0.22, output: 4.5 },
  'GLM-4.5-Flash': { input: 0, cacheRead: 0, output: 0, free: true },
  'GLM-4-32B-0414-128K': { input: 0.1, output: 0.1 },
  // Vision
  'GLM-5V-Turbo': { input: 1.2, cacheRead: 0.24, output: 4.0 },
  'GLM-4.6V': { input: 0.3, cacheRead: 0.05, output: 0.9 },
  'GLM-4.6V-FlashX': { input: 0.04, cacheRead: 0.004, output: 0.4 },
  'GLM-4.6V-Flash': { input: 0, cacheRead: 0, output: 0, free: true },
  'GLM-4.5V': { input: 0.6, cacheRead: 0.11, output: 1.8 },
  'GLM-OCR': { input: 0.03, output: 0.03 },
};

const LOWER = new Map(Object.keys(PRICING).map((k) => [k.toLowerCase(), k]));

const INFO = {
  asOf: '2026-08-28',
  source: 'https://docs.z.ai/guides/overview/pricing',
  currency: 'USD',
  notes: [
    'Rates are per million tokens in USD, from Z.ai list prices.',
    'Cache-read tokens are a subset of input tokens; the cached portion bills at the cacheRead rate and the rest at the input rate.',
    'Cache writes bill at the regular input rate (cache storage currently free).',
    'GLM-5.3-Flash is at a 50% promotion until 2026-09-09 (list price $0.15 input / $0.03 cached / $0.50 output).',
    'This is the equivalent pay-as-you-go API cost; a coding-plan subscription is billed separately.',
  ],
};

function lookupPricing(modelId) {
  if (typeof modelId !== 'string') return null;
  if (PRICING[modelId]) return PRICING[modelId];
  const key = LOWER.get(modelId.toLowerCase());
  return key ? PRICING[key] : null;
}

/**
 * Estimated USD cost for a set of token counters. Returns null when the model
 * has no known pricing (so callers can distinguish "free" from "unknown").
 */
function estimateCostUsd(modelId, u) {
  const p = lookupPricing(modelId);
  if (!p) return null;
  const input = Number(u.input_tokens || 0);
  // Callers alias the column either way depending on the query.
  const cached = Math.min(Number(u.cache_read_input_tokens ?? u.cache_read_tokens ?? 0), input);
  const output = Number(u.output_tokens || 0);
  const nonCached = input - cached;
  return (
    (nonCached / 1e6) * p.input +
    (cached / 1e6) * (p.cacheRead != null ? p.cacheRead : p.input) +
    (output / 1e6) * p.output
  );
}

module.exports = { PRICING, INFO, lookupPricing, estimateCostUsd };
