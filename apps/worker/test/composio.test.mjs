import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSIO_MONTHLY_EXECUTION_CEILING,
  COMPOSIO_TOOLKITS,
  disconnect,
  executeTool,
  initiateConnection,
  listConnections,
  toolkitByConnectionId,
  toolkitBySlug,
} from '../dist/composio.js';

const ENV = {
  COMPOSIO_API_KEY: 'ak_test',
  SIDEKICK_CONNECTIONS_CALLBACK_ORIGIN: 'https://api.delegantai.co.uk',
};

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { impl, calls };
}

const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

test('a missing key is an ordinary outcome, not a throw', async () => {
  const res = await initiateConnection({}, 'user-1', 'gmail', {
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_configured');
});

test('rate limits parse Retry-After seconds and HTTP dates without inventing a monthly quota error', async (t) => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  for (const [header, seconds] of [['17', 17], ['Sun, 13 Sep 2026 12:00:22 GMT', 22], ['nonsense', undefined], ['-1', undefined], ['', undefined]]) {
    const result = await listConnections(ENV, 'user-1', {
      fetchImpl: async () => new Response(null, { status: 429, headers: { 'retry-after': header } }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'rate_limited');
    assert.equal(result.retryAfterSeconds, seconds);
  }
});

test('EVERY card id the connections screen offers can start a connection', async () => {
  // The bug this pins, found live on 2026-09-03: both clients call
  // startComposioConnection(service.id), i.e. the CARD ID, and the list
  // endpoint publishes card ids in `offered`. initiateConnection resolved by
  // Composio SLUG only. For twenty toolkits the two strings are identical so
  // nothing showed; for six they differ, and those Connect buttons were dead
  // with unknown_toolkit. Alex tapped one and it did nothing.
  //
  // Iterating the registry rather than listing ids means a new toolkit whose
  // slug differs from its card id is caught the day it is added, not by a
  // customer.
  for (const t of COMPOSIO_TOOLKITS) {
    for (const handle of new Set([t.connectionId, t.slug])) {
      const { impl } = fakeFetch(() => ok({ redirect_url: 'https://connect.composio.dev/link/lk_1', connected_account_id: 'ca_1' }));
      const res = await initiateConnection(ENV, 'user-1', handle, { fetchImpl: impl });
      assert.equal(res.ok, true, `initiate("${handle}") failed: ${res.ok ? '' : res.error}`);
    }
  }
});

test('refuses a toolkit that is not on the allowlist', async () => {
  const res = await initiateConnection(ENV, 'user-1', 'notatoolkit', {
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_toolkit');
});

// The documented initiate() endpoint is rejected by the live API for
// Composio-managed auth. If someone "fixes" this back, this test fails.
test('uses /connected_accounts/link, not the documented initiate endpoint', async () => {
  const f = fakeFetch(() => ok({
    redirect_url: 'https://connect.composio.dev/link/lk_x',
    connected_account_id: 'ca_x',
    expires_at: '2026-09-01T15:00:00Z',
  }));
  const res = await initiateConnection(ENV, 'user-1', 'gmail', { fetchImpl: f.impl });
  assert.equal(res.ok, true);
  assert.match(f.calls[0].url, /\/connected_accounts\/link$/);
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.user_id, 'user-1');
  assert.equal(body.auth_config_id, toolkitBySlug('gmail').authConfigId);
  assert.equal(body.callback_url, 'https://api.delegantai.co.uk/api/connections/composio/callback');
  assert.equal(res.value.redirectUrl, 'https://connect.composio.dev/link/lk_x');
});

test('omits the callback entirely when no origin is configured', async () => {
  const f = fakeFetch(() => ok({ redirect_url: 'https://x/y', connected_account_id: 'ca_x' }));
  await initiateConnection({ COMPOSIO_API_KEY: 'ak_test' }, 'user-1', 'gmail', { fetchImpl: f.impl });
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal('callback_url' in body, false, 'a blank callback would redirect the user to nowhere');
});

test('a link response missing its url is refused rather than half-returned', async () => {
  const f = fakeFetch(() => ok({ connected_account_id: 'ca_x' }));
  const res = await initiateConnection(ENV, 'user-1', 'gmail', { fetchImpl: f.impl });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'refused');
});

// A connection the customer started and abandoned must not be offered to the
// agent: the tool call would fail in front of them.
test('only ACTIVE connections count', async () => {
  const f = fakeFetch(() => ok({
    items: [
      { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
      { id: 'ca_2', status: 'INITIALIZING', toolkit: { slug: 'gmail' } },
    ],
  }));
  const res = await listConnections(ENV, 'user-1', { fetchImpl: f.impl });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.map((c) => c.active), [true, false]);
});

// Something connected in the Composio dashboard for a toolkit we have not
// shipped copy for must not surface in the app.
test('filters out toolkits that are not on our allowlist', async () => {
  const f = fakeFetch(() => ok({
    items: [
      { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
      { id: 'ca_2', status: 'ACTIVE', toolkit: { slug: 'notatoolkit' } },
    ],
  }));
  const res = await listConnections(ENV, 'user-1', { fetchImpl: f.impl });
  assert.equal(res.value.length, 1);
  assert.equal(res.value[0].toolkitSlug, 'gmail');
});

test('scopes the connection list to the one user', async () => {
  const f = fakeFetch(() => ok({ items: [] }));
  await listConnections(ENV, 'user-with/slash', { fetchImpl: f.impl });
  assert.match(f.calls[0].url, /user_ids=user-with%2Fslash/);
});

test('a 429 is reported as rate limited, not as a generic refusal', async () => {
  const f = fakeFetch(() => new Response('', { status: 429 }));
  const res = await listConnections(ENV, 'u', { fetchImpl: f.impl });
  assert.equal(res.error, 'rate_limited');
});

test('a network failure is unreachable, and never throws', async () => {
  const res = await listConnections(ENV, 'u', {
    fetchImpl: async () => { throw new Error('socket'); },
    warn: () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unreachable');
});

test('disconnect issues a DELETE for that account', async () => {
  const f = fakeFetch(() => ok({}));
  const res = await disconnect(ENV, 'ca_9', { fetchImpl: f.impl });
  assert.equal(res.ok, true);
  assert.equal(f.calls[0].init.method, 'DELETE');
  assert.match(f.calls[0].url, /\/connected_accounts\/ca_9$/);
});

// The ceiling is the guard against a looping agent, which is the real cost
// risk. Composio's own spend cap protects the account; this protects the
// customer AND tells us which one looped.
test('refuses to execute once the monthly ceiling is reached', async () => {
  const f = fakeFetch(() => { throw new Error('must not be called'); });
  const res = await executeTool(ENV, 'user-1', 'GMAIL_SEND_EMAIL', {}, {
    fetchImpl: f.impl,
    usedThisCycle: async () => COMPOSIO_MONTHLY_EXECUTION_CEILING,
    warn: () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'quota_exceeded');
  assert.equal(f.calls.length, 0, 'nothing may reach Composio once the ceiling is hit');
});

test('executes below the ceiling and scopes the call to the user', async () => {
  const f = fakeFetch(() => ok({ data: { id: 'msg_1' } }));
  const res = await executeTool(ENV, 'user-1', 'GMAIL_SEND_EMAIL', { to: 'a@b.com' }, {
    fetchImpl: f.impl,
    usedThisCycle: async () => 0,
  });
  assert.equal(res.ok, true);
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.user_id, 'user-1');
  assert.deepEqual(body.arguments, { to: 'a@b.com' });
});

// A loop that fails every time still costs money, so attempts are counted.
test('counts a FAILED execution too', async () => {
  let counted = 0;
  await executeTool(ENV, 'user-1', 'X', {}, {
    fetchImpl: async () => new Response('nope', { status: 500 }),
    usedThisCycle: async () => 0,
    recordExecution: async () => { counted += 1; },
    warn: () => {},
  });
  assert.equal(counted, 1, 'a failed call still costs and must be counted');
});

test('an unreadable usage counter fails OPEN, not closed', async () => {
  const f = fakeFetch(() => ok({}));
  const res = await executeTool(ENV, 'user-1', 'X', {}, {
    fetchImpl: f.impl,
    usedThisCycle: async () => { throw new Error('db down'); },
  });
  // A broken counter must not stop a paying customer's agent working. The
  // Composio spend cap is the backstop for that case.
  assert.equal(res.ok, true);
});

test('every allowlisted toolkit is internally consistent', () => {
  for (const t of COMPOSIO_TOOLKITS) {
    assert.match(t.authConfigId, /^ac_/, `${t.slug} needs a real auth config id`);
    assert.equal(toolkitBySlug(t.slug), t);
    assert.equal(toolkitByConnectionId(t.connectionId), t);
  }
});
