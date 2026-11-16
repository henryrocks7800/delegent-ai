// DEFECT HUNT 2026-06-05 — cost-proportional quota accounting (#6 + quota-vs-cost).
// ---------------------------------------------------------------------------
// extractUsageEvent now weights output x OUTPUT_TOKEN_QUOTA_WEIGHT (~4.7, the
// output/input price ratio on Kimi K2.6) and cached input x
// CACHED_TOKEN_QUOTA_WEIGHT (0.21), so billableTokens ~= cost / input-price. That
// makes each tier's token cap a HARD model-cost ceiling regardless of the user's
// input/output mix: a full-quota burn can never cost more than input-price x cap,
// so we can size caps to a £ target and never lose money (COST_MODEL 2026-06-05).
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUsageEvent, CACHED_TOKEN_QUOTA_WEIGHT, OUTPUT_TOKEN_QUOTA_WEIGHT } from '../dist/index.js';

// Live Kimi K2.6 (DeepInfra) prices, $/token — used for the never-lose invariant.
const P_IN = 0.75e-6, P_CACHE = 0.15e-6, P_OUT = 3.50e-6;
const ev = (prompt, completion, cached) => extractUsageEvent('u', {
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } },
});

test('billable = uncached x1 + cached x0.21 + output x4.7 (cost-proportional)', () => {
  assert.equal(OUTPUT_TOKEN_QUOTA_WEIGHT, 4.7);
  const e = ev(10_000, 500, 8_000);
  const expected = Math.round((10_000 - 8_000) + 8_000 * CACHED_TOKEN_QUOTA_WEIGHT + 500 * OUTPUT_TOKEN_QUOTA_WEIGHT);
  assert.equal(e.billableTokens, expected); // 2000 + 1680 + 2350 = 6030
});

test('output is the expensive part: a pure-output call bills ~4.7x its tokens', () => {
  const e = ev(0, 1_000, 0);
  assert.equal(e.billableTokens, Math.round(1_000 * OUTPUT_TOKEN_QUOTA_WEIGHT));
  assert.ok(e.billableTokens > e.totalTokens, 'output-heavy bills MORE than raw tokens (reflects the 4.67x cost)');
});

test('NEVER-LOSE invariant: input-price x billable >= real OpenRouter cost, for every mix', () => {
  const cases = [
    [40_000, 200, 38_000],    // input + cache heavy (typical agentic turn)
    [2_000, 6_000, 0],        // output heavy (long-form writing)
    [1_000, 1_000, 0],        // balanced
    [50_000, 50_000, 49_000], // big context + big output, mostly cached
  ];
  for (const [p, c, cached] of cases) {
    const e = ev(p, c, cached);
    const cap = Math.min(p, cached);
    const realCost = P_IN * (p - cap) + P_CACHE * cap + P_OUT * c;
    const quotaCostCeiling = P_IN * e.billableTokens; // what a full-quota burn implies
    assert.ok(quotaCostCeiling + 1e-9 >= realCost, `mix ${p}/${c}/${cached}: ceiling ${quotaCostCeiling} < real ${realCost}`);
  }
});

test('a full Studio burn (19.55M cost-weighted) costs us at most ~£11.5 (the hard ceiling)', () => {
  const FX = 1.27;
  const maxGbp = (P_IN * 19_550_000) / FX; // input-price x cap = worst-case cost, in £
  assert.ok(maxGbp <= 11.8, `Studio worst-case ~£${maxGbp.toFixed(2)} should be ~£11.5`);
  assert.ok(maxGbp >= 10.9, 'and close to the £11.5 target (2026-07-14 +15% bump)');
});
