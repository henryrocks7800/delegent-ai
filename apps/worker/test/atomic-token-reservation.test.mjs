// Atomic token reservation (2026-06-03 review P0 #2) — unit tests for the
// Worker side of the TOCTOU-race fix: reserveChatTokens (RPC + fallback) and
// reconcileReservation (estimate -> actual PATCH).
import test from 'node:test';
import assert from 'node:assert/strict';

import { reserveChatTokens, reconcileReservation, MODEL } from '../dist/index.js';

const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc-role-key' };

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = original; });
}

test('reserveChatTokens: RPC allowed -> {allowed, reservationId}, not fallback', async () => {
  let calledUrl, calledBody;
  await withFetch(async (url, init) => {
    calledUrl = url; calledBody = JSON.parse(init.body);
    return { ok: true, json: async () => [{ allowed: true, reservation_id: 'res-1' }] };
  }, async () => {
    const r = await reserveChatTokens(ENV, 'user-1', 1234, '2026-06-01T00:00:00.000Z');
    assert.deepEqual(r, { allowed: true, reservationId: 'res-1', fallback: false });
  });
  assert.match(calledUrl, /\/rest\/v1\/rpc\/reserve_chat_tokens$/);
  // p_model added 2026-08-01 (migration 0049). The reservation row IS the usage
  // record, and the model name used to be a literal inside the RPC, so the usage
  // table reported Kimi for hours after chat had actually moved to DeepSeek.
  // Passing it from the Worker makes MODEL the single source of truth; asserting
  // it here stops the two drifting apart again.
  assert.deepEqual(calledBody, {
    p_user_id: 'user-1',
    p_requested: 1234,
    p_cycle_start: '2026-06-01T00:00:00.000Z',
    p_model: MODEL,
  });
});

test('reserveChatTokens: RPC denies -> {allowed:false}, not fallback', async () => {
  await withFetch(async () => ({ ok: true, json: async () => [{ allowed: false, reservation_id: null }] }), async () => {
    const r = await reserveChatTokens(ENV, 'user-1', 9_000_000, '2026-06-01T00:00:00.000Z');
    assert.deepEqual(r, { allowed: false, reservationId: null, fallback: false });
  });
});

test('reserveChatTokens: RPC missing (404) -> fallback (chat never breaks on rollout order)', async () => {
  await withFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }), async () => {
    const r = await reserveChatTokens(ENV, 'user-1', 100, '2026-06-01T00:00:00.000Z');
    assert.equal(r.fallback, true);
    assert.equal(r.allowed, true);
  });
});

test('reserveChatTokens: transport error -> fallback', async () => {
  await withFetch(async () => { throw new Error('network down'); }, async () => {
    const r = await reserveChatTokens(ENV, 'user-1', 100, '2026-06-01T00:00:00.000Z');
    assert.equal(r.fallback, true);
  });
});

test('reserveChatTokens: unexpected shape (empty array) -> fallback', async () => {
  await withFetch(async () => ({ ok: true, json: async () => [] }), async () => {
    const r = await reserveChatTokens(ENV, 'user-1', 100, '2026-06-01T00:00:00.000Z');
    assert.equal(r.fallback, true);
  });
});

test('reconcileReservation: settles the owned reservation through the atomic RPC', async () => {
  let calledUrl, calledInit;
  await withFetch(async (url, init) => { calledUrl = url; calledInit = init; return Response.json(true); }, async () => {
    await reconcileReservation(ENV, 'res-42', { userId: 'user-1', promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });
  assert.match(calledUrl, /rpc\/settle_chat_usage$/);
  assert.equal(calledInit.method, 'POST');
  const body = JSON.parse(calledInit.body);
  assert.equal(body.p_total_tokens, 15);
  assert.equal(body.p_prompt_tokens, 10);
  assert.equal(body.p_completion_tokens, 5);
  assert.equal(body.p_user_id, 'user-1');
  assert.equal(body.p_reservation_id, 'res-42');
});

test('reconcileReservation: rejects a failed RPC', async () => {
  await withFetch(async () => ({ ok: false, status: 500 }), async () => {
    await assert.rejects(
      () => reconcileReservation(ENV, 'res-1', { userId: 'u', promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      /usage reconciliation unavailable/,
    );
  });
});
