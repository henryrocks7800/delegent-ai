import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fetchReviewClaim } from './reviewClaim';

// Use the same polyfill React Native installs, not Node's richer web API.
const nativeAbort = createRequire(import.meta.url)('abort-controller/dist/abort-controller');

test('claims work with React Native AbortSignal and release the timeout', async (t) => {
  assert.equal(typeof nativeAbort.AbortSignal.timeout, 'undefined');
  const originalController = globalThis.AbortController;
  globalThis.AbortController = nativeAbort.AbortController;
  t.after(() => { globalThis.AbortController = originalController; });
  const originalSignal = globalThis.AbortSignal;
  globalThis.AbortSignal = nativeAbort.AbortSignal;
  t.after(() => { globalThis.AbortSignal = originalSignal; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://example.test/claim');
    assert.equal(init.body, '{"p_expected_user_id":"test-user"}');
    signal = init.signal ?? undefined;
    return new Response('"claimed"');
  });
  assert.equal(await fetchReviewClaim('https://example.test/claim', { method: 'POST', body: '{"p_expected_user_id":"test-user"}' }), 'claimed');
  t.mock.timers.tick(10_000);
  assert.equal(signal?.aborted, false);
});

test('a stalled native request aborts after ten seconds', async (t) => {
  const originalController = globalThis.AbortController;
  globalThis.AbortController = nativeAbort.AbortController;
  t.after(() => { globalThis.AbortController = originalController; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const result = assert.rejects(fetchReviewClaim('https://example.test/claim', {}), /aborted/);
  t.mock.timers.tick(10_000);
  await result;
});

test('failed or invalid claims are not accepted', async (t) => {
  for (const response of [new Response('unavailable', { status: 503 }), new Response('"unexpected"')]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(fetchReviewClaim('https://example.test/claim', {}));
  }
});
