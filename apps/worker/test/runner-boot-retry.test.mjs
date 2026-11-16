// The boot-transition retry (2026-09-06). A runner with Fly autostop=stop is
// unreachable for a few seconds while the proxy stops and restarts it; a
// request landing in that window gets a proxy 502/503 or a dropped connection
// and the box is back about three seconds later. Alex's receipt photo hit that
// window at 20:31 UTC on 2026-09-06 and hung for fourteen minutes. These pin
// the exact rule: retry proxy-level failures inside the budget, never retry a
// timeout, and hand every other status straight back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchRunnerWithBootRetry,
  isRunnerBootTransientError,
  RUNNER_BOOT_RETRY_BUDGET_MS,
  RUNNER_BOOT_RETRY_WAIT_MS,
  STALE_UNDISPATCHED_RUN_THRESHOLD_MS,
  STALE_CHAT_RUN_THRESHOLD_MS,
} from '../dist/index.js';

const realFetch = globalThis.fetch;
const noSleep = async () => {};

function withFetch(sequence, fn) {
  let i = 0;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    const step = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    if (step instanceof Error) throw step;
    return new Response(step.body ?? '', { status: step.status });
  };
  return fn(calls).finally(() => { globalThis.fetch = realFetch; });
}

test('a proxy 503 during the stop/start window is retried and the restarted runner answers', async () => {
  await withFetch([{ status: 503 }, { status: 503 }, { status: 200, body: '{"ok":true}' }], async (calls) => {
    const resp = await fetchRunnerWithBootRetry('https://runner.test/v1/capabilities', { method: 'GET' }, { label: 't', sleep: noSleep });
    assert.equal(resp.status, 200);
    assert.equal(calls.length, 3, 'two proxy failures then success');
  });
});

test('a dropped connection is retried the same way', async () => {
  const conn = new TypeError('fetch failed');
  await withFetch([conn, { status: 200 }], async (calls) => {
    const resp = await fetchRunnerWithBootRetry('https://runner.test/v1/delegent/message', { method: 'POST', body: '{}' }, { label: 't', sleep: noSleep });
    assert.equal(resp.status, 200);
    assert.equal(calls.length, 2);
  });
});

test('a timeout is NOT retried: a hang is not a boot transition', async () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  await withFetch([timeout, { status: 200 }], async (calls) => {
    await assert.rejects(
      fetchRunnerWithBootRetry('https://runner.test/v1/delegent/message', { method: 'POST' }, { label: 't', sleep: noSleep }),
      (err) => err.name === 'TimeoutError',
    );
    assert.equal(calls.length, 1, 'no second attempt after a timeout');
  });
  assert.equal(isRunnerBootTransientError(new DOMException('x', 'AbortError')), false);
  assert.equal(isRunnerBootTransientError(new DOMException('x', 'TimeoutError')), false);
  assert.equal(isRunnerBootTransientError(new TypeError('fetch failed')), true);
});

test('404 and other non-proxy statuses are returned untouched, so platform fallbacks still work', async () => {
  await withFetch([{ status: 404 }], async (calls) => {
    const resp = await fetchRunnerWithBootRetry('https://runner.test/v1/delegent/message', { method: 'POST' }, { label: 't', sleep: noSleep });
    assert.equal(resp.status, 404);
    assert.equal(calls.length, 1);
  });
  await withFetch([{ status: 500 }], async (calls) => {
    const resp = await fetchRunnerWithBootRetry('https://runner.test/v1/runs', { method: 'POST' }, { label: 't', sleep: noSleep });
    assert.equal(resp.status, 500, 'a 500 comes from the runner itself, not the proxy, and is not retried');
    assert.equal(calls.length, 1);
  });
});

test('the retry gives up inside the budget and returns the last proxy response', async () => {
  // Budget of 3 s with a 1.5 s wait allows exactly two attempts; the clock is
  // real but sleep is a no-op, so this stays fast and deterministic.
  await withFetch([{ status: 503 }], async (calls) => {
    const resp = await fetchRunnerWithBootRetry('https://runner.test/v1/capabilities', { method: 'GET' }, { label: 't', budgetMs: 3_000, waitMs: 1_500, sleep: noSleep });
    assert.equal(resp.status, 503);
    assert.ok(calls.length >= 1 && calls.length <= 3, `bounded attempts, got ${calls.length}`);
  });
});

test('the per-attempt timeout is applied as a signal, and the retry option never leaks into fetch init', async () => {
  await withFetch([{ status: 200 }], async (calls) => {
    await fetchRunnerWithBootRetry('https://runner.test/v1/capabilities', { method: 'GET', attemptTimeoutMs: 8_000 }, { label: 't', sleep: noSleep });
    assert.ok(calls[0].init.signal instanceof AbortSignal, 'per-attempt timeout becomes an AbortSignal');
    assert.equal('attemptTimeoutMs' in calls[0].init, false);
  });
});

test('the budget covers a real Fly restart and the undispatched reap is faster than the hard ceiling', () => {
  // A stopped machine is routable again in roughly three seconds; twenty
  // seconds of retry covers a slow boot without holding a user for long.
  assert.ok(RUNNER_BOOT_RETRY_BUDGET_MS >= 10_000 && RUNNER_BOOT_RETRY_BUDGET_MS <= 30_000, `budget ${RUNNER_BOOT_RETRY_BUDGET_MS}`);
  assert.ok(RUNNER_BOOT_RETRY_WAIT_MS >= 500 && RUNNER_BOOT_RETRY_WAIT_MS <= 3_000, `wait ${RUNNER_BOOT_RETRY_WAIT_MS}`);
  // Past the 150 s legacy dispatch cap, well inside the ten-minute ceiling.
  assert.ok(STALE_UNDISPATCHED_RUN_THRESHOLD_MS > 150_000, 'must outlast a legacy /tasks call');
  assert.ok(STALE_UNDISPATCHED_RUN_THRESHOLD_MS < STALE_CHAT_RUN_THRESHOLD_MS, 'must be quicker than the hard ceiling');
});
