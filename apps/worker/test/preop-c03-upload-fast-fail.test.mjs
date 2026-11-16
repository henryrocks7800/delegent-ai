// PREOP-C03 regression — "file upload from drawer fails after ~1 min, then
// later succeeds".
//
// Root cause: getUsableRunnerBinding (apps/worker/src/files.ts) returns a usable
// binding as soon as `runner_base_url` exists in hermes_instance_private — which
// is written right after the Fly machine is created, BEFORE the runner finishes
// booting and serving /files. The upload then POSTed to the still-booting runner
// with NO timeout, so the connection hung for ~tens of seconds before failing
// with a vague error ("upload couldn't finish, try again"). Once the runner came
// up, a later retry worked — hence "fails ~1 min then later succeeds".
//
// Fix: fetchRunnerWithTimeout wraps the runner upload/list/download in an
// AbortController timeout (SIDEKICK_RUNNER_REQUEST_TIMEOUT_MS, default 12s) so a
// not-ready runner fails FAST with a structured, retry-safe
// runner_file_unavailable response instead of hanging.
//
// Fails-without: with no timeout, the upload fetch never settles in this test
// (the runner mock holds the connection open forever), so worker.fetch never
// resolves within the test's own guard and the test times out / hangs.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/index.js';

const BASE = 'https://worker.sidekick.test';
const RUNNER_FILES_URL = `${BASE}/api/files/runner`;
const USER_ID = '11111111-1111-4111-8111-111111111111';

const ENV = {
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
  SIDEKICK_FILE_LINK_SIGNING_SECRET: 'file_link_signing_secret',
  // Drive the new timeout low so the test is fast but still exercises the real
  // abort path (default is 12s).
  SIDEKICK_RUNNER_REQUEST_TIMEOUT_MS: '150',
};

// A runner that is provisioned (binding exists) but NOT yet serving: its /files
// endpoint never responds and only settles (rejecting) when the request is
// aborted. This is exactly the boot-window behaviour behind C03.
function withNotReadyRunnerFetch(callback) {
  const originalFetch = globalThis.fetch;
  let runnerHangStarted = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;

    if (url === `${ENV.SUPABASE_URL}/auth/v1/user`) {
      return new Response(JSON.stringify({ id: USER_ID, email: 'alex@example.test' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/rest/v1/hermes_instances')) {
      // 2026-09-03: the binding also requires the workspace row to be 'ready'.
      return new Response(JSON.stringify([{ status: 'ready', deleted_at: null }]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/rest/v1/hermes_instance_private')) {
      return new Response(JSON.stringify([{
        runner_base_url: 'https://runner.sidekick.dev',
        runner_shared_secret: 'runner_private_file_secret',
      }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://runner.sidekick.dev/files') {
      runnerHangStarted = true;
      // Hang until aborted — mimics a runner that has not finished booting.
      return await new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }
        // No resolve/reject otherwise: without the timeout+signal this never settles.
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return Promise.resolve(callback(() => runnerHangStarted)).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test('PREOP-C03 upload to a not-ready runner fails FAST with a structured error, not a ~60s hang', async () => {
  await withNotReadyRunnerFetch(async (runnerWasCalled) => {
    const started = Date.now();
    const response = await worker.fetch(new Request(RUNNER_FILES_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer app_access_token', 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'notes.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from('hello upload from mobile').toString('base64'),
      }),
    }), ENV);
    const elapsedMs = Date.now() - started;

    assert.equal(runnerWasCalled(), true, 'the upload must actually reach the runner before timing out');
    // Fast-fail: well under the minute-long hang users saw (timeout is 150ms here).
    assert.ok(elapsedMs < 3000, `upload should fail fast, took ${elapsedMs}ms`);

    // Structured, retry-safe error (not a raw hang / 5xx passthrough).
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, 'runner_file_unavailable');
    // No runner internals leaked.
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /runner\.sidekick\.dev/);
    assert.doesNotMatch(text, /runner_private_file_secret/);
  });
});
