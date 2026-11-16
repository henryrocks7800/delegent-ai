// The Worker's half of an account erasure that stopped part way.
//
// The deletion queue only ever tore down the workspace, so when Supabase auth
// deletion returned 503 the endpoint answered 503 and nothing ever came back
// for it. The request sat unfinished, the person could still sign in, and the
// queue went on to report the account erased on the strength of Fly teardown
// alone. Reproduced against the live handlers on 2026-09-13.
import test from 'node:test';
import assert from 'node:assert/strict';

import { sweepUnfinishedAccountDeletions } from '../dist/index.js';

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_secret',
  COMPOSIO_API_KEY: 'ak_test',
};
const USER = '66666666-6666-4666-8666-666666666666';
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init: init ?? {} });
    const answered = await handler({ url, init: init ?? {} });
    if (answered) return answered;
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const unfinished = (over = {}) => ({
  id: 'delete_req_resume',
  user_id: USER,
  auth_deleted_at: null,
  connections_cleared_at: null,
  pending_cleanup: [],
  ...over,
});

test('an auth deletion that failed at request time is retried and recorded', async () => {
  const progress = [];
  const result = await withFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === '/rest/v1/account_deletion_requests') {
      assert.equal(url.searchParams.get('completed_at'), 'is.null', 'only unfinished work');
      return json([unfinished({ connections_cleared_at: '2026-09-13T10:00:00Z' })]);
    }
    if (url.pathname === `/auth/v1/admin/users/${USER}`) {
      assert.equal(call.init.method, 'DELETE');
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/rest/v1/rpc/record_account_deletion_origin_progress') {
      progress.push(JSON.parse(call.init.body));
      return json(true);
    }
    return null;
  }, () => sweepUnfinishedAccountDeletions(ENV));

  assert.equal(result.ok, true);
  assert.equal(result.examined, 1);
  assert.equal(result.authDeleted, 1);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].p_auth_deleted, true);
  assert.equal(progress[0].p_request_id, 'delete_req_resume');
});

test('a grant still owed at a broker is retried by id, never by a retained credential', async () => {
  const progress = [];
  const deleted = [];
  const result = await withFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === '/rest/v1/account_deletion_requests') {
      return json([unfinished({
        auth_deleted_at: '2026-09-13T10:00:00Z',
        pending_cleanup: [{ broker: 'composio', account_id: 'ca_stuck' }],
      })]);
    }
    if (url.hostname === 'backend.composio.dev') {
      if (call.init.method === 'DELETE') { deleted.push(url.pathname.split('/').pop()); return json({}); }
      return json({ items: [{ id: 'ca_stuck', status: 'ACTIVE', toolkit: { slug: 'gmail' } }] });
    }
    if (url.pathname === '/rest/v1/rpc/record_account_deletion_origin_progress') {
      progress.push(JSON.parse(call.init.body));
      return json(true);
    }
    return null;
  }, () => sweepUnfinishedAccountDeletions(ENV));

  assert.equal(result.ok, true);
  assert.equal(result.authDeleted, 0, 'the auth phase was already done and is not repeated');
  assert.deepEqual(deleted, ['ca_stuck']);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].p_connections_swept, true);
  assert.deepEqual(progress[0].p_pending_cleanup, [], 'nothing is owed once the revoke lands');
  // A Composio revoke needs only the id and our own API key, so nothing had to
  // be kept alive to make this retry possible.
  assert.doesNotMatch(JSON.stringify(progress), /token|secret|_enc/i);
});

test('a broker that is still down leaves the work owed rather than marking it cleared', async () => {
  const progress = [];
  await withFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === '/rest/v1/account_deletion_requests') {
      return json([unfinished({ auth_deleted_at: '2026-09-13T10:00:00Z' })]);
    }
    if (url.hostname === 'backend.composio.dev') {
      if (call.init.method === 'DELETE') return new Response('no', { status: 503 });
      return json({ items: [{ id: 'ca_stuck', status: 'ACTIVE', toolkit: { slug: 'gmail' } }] });
    }
    if (url.pathname === '/rest/v1/rpc/record_account_deletion_origin_progress') {
      progress.push(JSON.parse(call.init.body));
      return json(true);
    }
    return null;
  }, () => sweepUnfinishedAccountDeletions(ENV));

  assert.deepEqual(progress[0].p_pending_cleanup, [{ broker: 'composio', account_id: 'ca_stuck' }]);
});

test('an inventory that could not be read to the end keeps the whole account owed', async () => {
  const progress = [];
  await withFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === '/rest/v1/account_deletion_requests') {
      return json([unfinished({ auth_deleted_at: '2026-09-13T10:00:00Z' })]);
    }
    if (url.hostname === 'backend.composio.dev') {
      // A later page fails, so an empty failure list proves nothing.
      return url.searchParams.get('cursor')
        ? new Response('no', { status: 500 })
        : json({ items: [], next_cursor: 'page2' });
    }
    if (url.pathname === '/rest/v1/rpc/record_account_deletion_origin_progress') {
      progress.push(JSON.parse(call.init.body));
      return json(true);
    }
    return null;
  }, () => sweepUnfinishedAccountDeletions(ENV));

  assert.deepEqual(progress[0].p_pending_cleanup, [{ broker: 'composio', scope: 'all', reason: 'inventory_incomplete' }]);
});

test('the sweep never completes a request, because it only owns half the job', async () => {
  await withFetch((call) => {
    const url = new URL(call.url);
    assert.notEqual(url.pathname, '/rest/v1/rpc/record_account_deletion_request_completed',
      'completing on the strength of half the work is the defect this exists for');
    if (url.pathname === '/rest/v1/account_deletion_requests') return json([unfinished()]);
    if (url.pathname === `/auth/v1/admin/users/${USER}`) return new Response(null, { status: 200 });
    if (url.hostname === 'backend.composio.dev') return json({ items: [] });
    if (url.pathname === '/rest/v1/rpc/record_account_deletion_origin_progress') return json(true);
    return null;
  }, () => sweepUnfinishedAccountDeletions(ENV));
});

test('an unreadable queue is an unreadable queue, not an empty one', async () => {
  const result = await withFetch((call) => {
    if (new URL(call.url).pathname === '/rest/v1/account_deletion_requests') {
      return new Response('no', { status: 503 });
    }
    return null;
  }, () => sweepUnfinishedAccountDeletions(ENV));
  assert.deepEqual(result, { ok: false, examined: 0, authDeleted: 0, cleanupCleared: 0 });
});

test('a Worker with no service-role key does nothing at all', async () => {
  const result = await withFetch(() => { throw new Error('must not reach the network'); },
    () => sweepUnfinishedAccountDeletions({}));
  assert.equal(result.ok, false);
  assert.equal(result.examined, 0);
});
