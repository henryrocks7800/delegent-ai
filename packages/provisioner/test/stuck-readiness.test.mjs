// Stuck-readiness reclaim (2026-06-03 review P0 #4) — processNextSeries4StuckReadiness
// re-polls /healthz for a runner stuck in 'provisioning' (binding recorded but
// mark-ready failed) and promotes it IN PLACE, never re-creating.
import test from 'node:test';
import assert from 'node:assert/strict';

import { processNextSeries4StuckReadiness } from '../dist/index.js';

const claim = { job: { userId: 'u1', tierId: 'studio', idempotencyKey: 'k1', claimedAt: '2026-06-03T00:00:00Z' }, runnerBaseUrl: 'https://runner.fly.dev' };
const healthyFetch = async () => ({ ok: true, json: async () => ({ ok: true, hermesApiServerAvailable: true }) });
const noopSleep = async () => {};

test('idle when the store does not implement the claim', async () => {
  const r = await processNextSeries4StuckReadiness({ env: {} }, { store: {} });
  assert.deepEqual(r, { status: 'idle' });
});

test('idle when there is nothing stuck to claim', async () => {
  const r = await processNextSeries4StuckReadiness({ env: {} }, { store: { claimNextSeries4StuckReadiness: async () => null } });
  assert.deepEqual(r, { status: 'idle' });
});

test('a claim RPC error fails the scan instead of reporting idle', async () => {
  const store = { claimNextSeries4StuckReadiness: async () => { throw new Error('rpc reserve_chat_tokens does not exist'); } };
  await assert.rejects(processNextSeries4StuckReadiness({ env: {} }, { store }), /does not exist/);
});

test('healthy runner -> promoted IN PLACE via markSeries4FlyRunnerReady (no re-create)', async () => {
  const calls = {};
  const store = {
    claimNextSeries4StuckReadiness: async () => claim,
    markSeries4FlyRunnerReady: async (job, url) => { calls.ready = { job, url }; },
  };
  const r = await processNextSeries4StuckReadiness({ env: {} }, {
    store, fetchImpl: healthyFetch, now: () => 0, sleep: noopSleep,
  });
  assert.deepEqual(r, { status: 'promoted', userId: 'u1' });
  assert.equal(calls.ready.job.userId, 'u1');
  assert.equal(calls.ready.url, 'https://runner.fly.dev');
});

test('still-unready runner -> left in place (no promote), retried next pass', async () => {
  const calls = { ready: false };
  const store = {
    claimNextSeries4StuckReadiness: async () => claim,
    markSeries4FlyRunnerReady: async () => { calls.ready = true; },
  };
  // now jumps past the 120s deadline immediately so the poll times out fast.
  let t = 0;
  const r = await processNextSeries4StuckReadiness({ env: {} }, {
    store, fetchImpl: healthyFetch, now: () => { const v = t; t += 200_000; return v; }, sleep: noopSleep,
  });
  assert.equal(r.status, 'still_unready');
  assert.equal(r.userId, 'u1');
  assert.equal(calls.ready, false);
});

test('mark-ready failure surfaces as failed (not a silent promote)', async () => {
  const store = {
    claimNextSeries4StuckReadiness: async () => claim,
    markSeries4FlyRunnerReady: async () => { throw new Error('mark ready rpc down'); },
  };
  const r = await processNextSeries4StuckReadiness({ env: {} }, {
    store, fetchImpl: healthyFetch, now: () => 0, sleep: noopSleep,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.userId, 'u1');
});
