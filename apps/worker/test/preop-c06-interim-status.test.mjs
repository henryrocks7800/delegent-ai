// PREOP-C06 regression — "first task hung >3 min, no progress, then timed out".
//
// Root cause: the chat dispatch is synchronous (the Worker awaits the runner
// /tasks call up to CHAT_DISPATCH_TIMEOUT_MS) and Feature 2's live event feed is
// not built, so the mobile poll of getRunStatus saw the same status with NOTHING
// to render -> a silent spinner for minutes, then a timeout. (Terminal state was
// already guaranteed: every dispatch path finalises and the stale-run sweeper
// reaps stuck runs.)
//
// Fix: handleChatRunStatus now returns inFlight + elapsedSeconds +
// interimStatusMessage for an in-flight run (null once terminal), so the client
// can show "Working on it... 45s" instead of a frozen spinner.
//
// Fails-without: the pre-fix response had no interimStatusMessage/inFlight/
// elapsedSeconds fields, and buildInterimStatusMessage did not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { buildInterimStatusMessage } from '../dist/index.js';

const BASE = 'https://worker.sidekick.test';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ENV = {
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
};

test('PREOP-C06 buildInterimStatusMessage escalates with elapsed time and never leaks infra', () => {
  const early = buildInterimStatusMessage(0);
  const mid = buildInterimStatusMessage(30);
  const late = buildInterimStatusMessage(120);

  for (const m of [early, mid, late]) {
    assert.ok(typeof m === 'string' && m.length > 0, 'a non-empty progress line');
    assert.doesNotMatch(m, /openrouter|cloudflare|\bfly\b|supabase|runner|hermes/i, 'no infra leak');
    assert.equal(m.includes('—'), false, 'no em-dash (release-gate copy rule)');
  }
  // The wording must change as time passes so a slow task reassures.
  assert.notEqual(early, mid);
  assert.notEqual(mid, late);
  assert.match(late, /longer than usual|hang tight/i);
  // Tolerates a null elapsed (returns the base line, not a crash).
  assert.equal(typeof buildInterimStatusMessage(null), 'string');
});

function withRunStatusFetch(runRow, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === `${ENV.SUPABASE_URL}/auth/v1/user`) {
      return new Response(JSON.stringify({ id: USER_ID }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/v1/task_runs')) {
      return new Response(JSON.stringify([runRow]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/rest/v1/messages')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return Promise.resolve(callback()).finally(() => { globalThis.fetch = originalFetch; });
}

function statusRequest() {
  return new Request(`${BASE}/api/chat/runs/${RUN_ID}`, {
    method: 'GET',
    headers: { authorization: 'Bearer app_access_token' },
  });
}

test('PREOP-C06 getRunStatus surfaces inFlight + elapsedSeconds + interim message for an in-flight run', async () => {
  const createdAt = new Date(Date.now() - 95_000).toISOString(); // 95s ago
  await withRunStatusFetch(
    { id: RUN_ID, status: 'dispatched', error_code: null, kind: 'chat', created_at: createdAt, completed_at: null },
    async () => {
      const response = await worker.fetch(statusRequest(), ENV);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, 'dispatched');
      assert.equal(body.inFlight, true, 'an in-flight run must be flagged so the UI shows progress');
      assert.ok(typeof body.elapsedSeconds === 'number' && body.elapsedSeconds >= 90, `elapsedSeconds ~95, got ${body.elapsedSeconds}`);
      assert.ok(typeof body.interimStatusMessage === 'string' && body.interimStatusMessage.length > 0, 'a non-silent heartbeat line');
      assert.match(body.interimStatusMessage, /longer than usual|hang tight/i, 'escalated wording past 90s');
    },
  );
});

test('PREOP-C06 a terminal (completed) run carries NO interim heartbeat', async () => {
  await withRunStatusFetch(
    { id: RUN_ID, status: 'completed', error_code: null, kind: 'chat', created_at: new Date(Date.now() - 5_000).toISOString(), completed_at: new Date().toISOString() },
    async () => {
      const response = await worker.fetch(statusRequest(), ENV);
      const body = await response.json();
      assert.equal(body.status, 'completed');
      assert.equal(body.inFlight, false, 'a terminal run is not in-flight');
      assert.equal(body.interimStatusMessage, null, 'no "still working" noise once terminal');
    },
  );
});
