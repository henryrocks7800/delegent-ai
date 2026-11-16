import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirstTaskReview, type FirstTaskReviewDependencies } from './firstTaskReview';

function setup(overrides: Partial<FirstTaskReviewDependencies> = {}) {
  const calls: string[] = [];
  const request = createFirstTaskReview({
    canPresent: () => true,
    isAvailable: async () => { calls.push('available'); return true; },
    claim: async () => { calls.push('claim'); return 'claimed'; },
    requestReview: async () => { calls.push('request'); },
    ...overrides,
  });
  return { request, calls };
}
test('claims before requesting and ignores simultaneous and repeated completions', async () => {
  const { request, calls } = setup();
  await Promise.all([request(), request(), request()]);
  await request();
  assert.deepEqual(calls, ['available', 'claim', 'request']);
});
test('old binaries and unavailable stores do not consume the account claim', async () => {
  const { request, calls } = setup({ isAvailable: async () => false });
  assert.equal(await request(), 'finished');
  assert.deepEqual(calls, []);
});
test('another device already requested: no native prompt', async () => {
  const { request, calls } = setup({ claim: async () => 'already_requested' });
  await request();
  assert.deepEqual(calls, ['available']);
});
test('server has not committed task success yet: defer and retry', async () => {
  let claims = 0;
  const { request, calls } = setup({ claim: async () => ++claims === 1 ? 'not_ready' : 'claimed' });
  assert.equal(await request(), 'deferred');
  assert.equal(await request(), 'finished');
  assert.deepEqual(calls, ['available', 'available', 'request']);
});
test('navigation or sign-out during the claim prevents the prompt', async () => {
  let visible = true;
  const { request, calls } = setup({ canPresent: () => visible, claim: async () => { visible = false; return 'claimed'; } });
  await request();
  assert.deepEqual(calls, ['available']);
});
test('a failed native request does not repeatedly ask the same account', async () => {
  let prompts = 0;
  const { request } = setup({ requestReview: async () => { prompts++; throw new Error('store unavailable'); } });
  assert.equal(await request(), 'finished');
  assert.equal(await request(), 'finished');
  assert.equal(prompts, 1);
});
test('a database outage is silent and does not mark a prompt requested', async () => {
  const { request, calls } = setup({ claim: async () => { throw new Error('offline'); } });
  assert.equal(await request(), 'deferred');
  assert.equal(await request(), 'deferred');
  assert.deepEqual(calls, ['available', 'available']);
});
