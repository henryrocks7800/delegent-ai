// DEFECT E (2026-06-04): leaked token reservations. A timed-out/broken streaming
// run never reconciles its `worker_reservation` row, so the reserved estimate
// counts against the user's quota forever (fetchUsageSnapshot sums total_tokens
// with no source filter). reclaimStaleChatReservations releases anything still
// unreconciled after 10 min. These lock the targeting + release semantics.
import test from 'node:test';
import assert from 'node:assert/strict';

import { reclaimStaleChatReservations } from '../dist/index.js';

const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
function withFetch(impl, fn) {
  const o = globalThis.fetch; globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = o; });
}

test('reclaim PATCHes ONLY stale, unreconciled reservations and releases them to 0', async () => {
  let captured = null;
  await withFetch(async (url, init) => {
    captured = { url: String(url), method: init.method, body: init.body };
    return { ok: true, json: async () => [{ id: 'r1' }, { id: 'r2' }] };
  }, async () => {
    const count = await reclaimStaleChatReservations(ENV, new Date('2026-06-04T21:00:00.000Z'));
    assert.equal(count, 2, 'returns how many it released');
  });
  const decoded = decodeURIComponent(captured.url);
  assert.equal(captured.method, 'PATCH');
  assert.ok(decoded.includes('token_usage_events'), 'targets the usage table');
  assert.ok(decoded.includes('source=eq.worker_reservation'), 'ONLY reservation rows (not reconciled usage)');
  assert.ok(decoded.includes('prompt_tokens=eq.0'), 'ONLY unreconciled (a reconciled row has prompt>0)');
  assert.ok(decoded.includes('total_tokens=gt.0'), 'ONLY ones still holding a reserved amount (idempotent)');
  assert.ok(decoded.includes('created_at=lt.2026-06-04T20:50:00.000Z'), `cutoff is exactly now-10min, got: ${decoded}`);
  assert.deepEqual(JSON.parse(captured.body), { total_tokens: 0 }, 'releases the phantom to zero');
});

test('reclaim returns 0 when nothing is stale (no-op)', async () => {
  await withFetch(async () => ({ ok: true, json: async () => [] }), async () => {
    assert.equal(await reclaimStaleChatReservations(ENV, new Date()), 0);
  });
});

test('reclaim throws on a non-ok response so the cron logs + Sentry-captures it', async () => {
  await withFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }), async () => {
    await assert.rejects(() => reclaimStaleChatReservations(ENV, new Date()), /reservation reclaim failed http_500/);
  });
});
