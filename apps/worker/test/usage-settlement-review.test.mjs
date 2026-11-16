import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUsageEvent, persistUsageEvent, reconcileReservation, releaseChatReservation } from '../dist/index.js';

const env = { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture' };

test('settled usage retains provider facts on both persistence paths without deriving dollars', async () => {
  const event = extractUsageEvent('owner', { id: 'generation-fixture', provider: 'provider-fixture',
    usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010,
      prompt_tokens_details: { cached_tokens: 900 }, cost: 0.00006 } });
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json(true);
  };
  try {
    await persistUsageEvent(env, event);
    await reconcileReservation(env, 'reservation', event);
  } finally { globalThis.fetch = original; }
  assert.equal(calls[0].body.cached_tokens, 900);
  assert.equal(calls[0].body.provider_cost_usd, 0.00006);
  assert.equal(calls[0].body.upstream_provider, 'provider-fixture');
  assert.equal(calls[0].body.provider_request_id, 'generation-fixture');
  assert.equal(calls[1].body.p_provider_cost_usd, 0.00006);
  assert.equal(calls[1].body.p_cached_tokens, 900);
  assert.equal(calls[1].body.p_provider_request_id, 'generation-fixture');
  const unknown = extractUsageEvent('owner', { usage: { prompt_tokens: 1000, completion_tokens: 10 } });
  assert.equal(unknown.providerCostUsd, undefined);
  assert.equal(unknown.upstreamProvider, undefined);
  assert.equal(unknown.cachedTokens, undefined);
});

test('a late reservation release cannot match settled usage', async () => {
  const original = globalThis.fetch;
  let query;
  globalThis.fetch = async url => { query = new URL(url).searchParams; return Response.json(true); };
  try { await releaseChatReservation(env, 'reservation'); } finally { globalThis.fetch = original; }
  assert.equal(query.get('id'), 'eq.reservation');
  assert.equal(query.get('source'), 'eq.worker_reservation');
});

test('malformed success does not acknowledge a settlement', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'not actually settled' });
  try {
    await assert.rejects(reconcileReservation(env, 'reservation', {
      userId: 'owner', promptTokens: 1, completionTokens: 1, totalTokens: 2,
    }), /usage reconciliation unavailable/);
  } finally { globalThis.fetch = original; }
});
