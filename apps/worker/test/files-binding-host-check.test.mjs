// Fable 5 pickup 7 (2026-07-29) — host-check symmetry on the files path.
//
// The chat dispatch path refuses to sign requests to a runner_base_url whose
// host does not belong to the user's own Fly app (flyRunnerBindingHostMatches
// in index.ts). The files path (list/upload/download/delete) signs the SAME
// per-user HMAC headers against the SAME binding row but previously skipped
// that gate, so a stale or admin-mutated runner_base_url could receive a
// user's signed file traffic. getUsableRunnerBinding now applies the identical
// last-gate: for a fly_machines row, the URL host must be
// `<fly_app_name>.fly.dev` or the binding is treated as unusable.
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
};

function withMockedFetch(privateRow, callback) {
  const originalFetch = globalThis.fetch;
  const runnerRequests = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === `${ENV.SUPABASE_URL}/auth/v1/user`) {
      return new Response(JSON.stringify({ id: USER_ID, email: 'alex@example.test' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/rest/v1/hermes_instance_private')) {
      return new Response(JSON.stringify([privateRow]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/rest/v1/hermes_instances')) {
      // A live workspace row: since 2026-09-03 the binding is gated on
      // status === 'ready' (files used to wake a paused user's machine), so
      // the host check below is what decides usability here. Not sleeping,
      // so an unusable binding still renders plain "not ready".
      return new Response(JSON.stringify([{ status: 'ready', deleted_at: null, volume_retention_until: null }]), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/files')) {
      runnerRequests.push(url);
      return new Response(JSON.stringify({ ok: true, truncated: false, files: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return Promise.resolve(callback(runnerRequests)).finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function listRequest() {
  return new Request(RUNNER_FILES_URL, {
    method: 'GET',
    headers: { authorization: 'Bearer user-token' },
  });
}

test('files path refuses a fly binding whose URL host is not the bound app', async () => {
  await withMockedFetch({
    runner_base_url: 'https://evil-other-app.fly.dev',
    runner_shared_secret: 'per-user-secret',
    provider: 'fly_machines',
    fly_app_name: 'delegent-runner-abc123',
  }, async (runnerRequests) => {
    const response = await worker.fetch(listRequest(), ENV);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.storageStatus, 'not_ready', 'a mismatched host must not be treated as a usable runner');
    assert.equal(runnerRequests.length, 0, 'no signed request may reach the mismatched host');
  });
});

test('files path refuses a fly binding with no fly_app_name to check against', async () => {
  await withMockedFetch({
    runner_base_url: 'https://delegent-runner-abc123.fly.dev',
    runner_shared_secret: 'per-user-secret',
    provider: 'fly_machines',
  }, async (runnerRequests) => {
    const response = await worker.fetch(listRequest(), ENV);
    const body = await response.json();
    assert.equal(body.storageStatus, 'not_ready');
    assert.equal(runnerRequests.length, 0);
  });
});

test('files path accepts the matching fly binding and signs to it', async () => {
  await withMockedFetch({
    runner_base_url: 'https://delegent-runner-abc123.fly.dev',
    runner_shared_secret: 'per-user-secret',
    provider: 'fly_machines',
    fly_app_name: 'delegent-runner-abc123',
  }, async (runnerRequests) => {
    const response = await worker.fetch(listRequest(), ENV);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.notEqual(body.storageStatus, 'not_ready');
    assert.equal(runnerRequests.length, 1, 'the matching host receives the signed list request');
  });
});

test('files path keeps serving a legacy (non-fly) binding without the gate', async () => {
  await withMockedFetch({
    runner_base_url: 'https://runner.sidekick.dev',
    runner_shared_secret: 'per-user-secret',
  }, async (runnerRequests) => {
    const response = await worker.fetch(listRequest(), ENV);
    assert.equal(response.status, 200);
    assert.equal(runnerRequests.length, 1, 'legacy rows with no provider still work');
  });
});
