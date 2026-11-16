import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleComposio,
  handleComposioRunner,
  isComposioPath,
  isComposioRunnerPath,
} from '../dist/composio-routes.js';
import { COMPOSIO_MONTHLY_EXECUTION_CEILING, COMPOSIO_TOOLKITS } from '../dist/composio.js';

const ENV = {
  COMPOSIO_API_KEY: 'ak_test',
  SIDEKICK_CONNECTIONS_CALLBACK_ORIGIN: 'https://api.delegantai.co.uk',
  SIDEKICK_CONNECTIONS_RETURN_WEB_URL: 'https://delegent-app.web.app/connections/return',
};

const USER = { id: 'user-1' };
const authed = async () => USER;
const anon = async () => null;
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

function req(path, method = 'GET', body) {
  const url = new URL(`https://api.delegantai.co.uk${path}`);
  return { request: new Request(url, { method, body }), url };
}

// The generic /api/connections/ branch in index.ts would swallow every one of
// these. This is the same trap /api/connections/oauth already carries a comment
// about, and a comment did not stop it happening the first time.
test('every composio path is recognised so it can be routed BEFORE the vault branch', () => {
  for (const p of [
    '/api/connections/composio',
    '/api/connections/composio/initiate',
    '/api/connections/composio/callback',
    '/api/connections/composio/ca_123',
  ]) assert.equal(isComposioPath(p), true, p);
  assert.equal(isComposioPath('/api/connections'), false);
  assert.equal(isComposioPath('/api/connections/dropbox'), false);
});

test('the callback needs no session and redirects on success', async () => {
  const { request, url } = req('/api/connections/composio/callback?status=success&connected_account_id=ca_1');
  const res = await handleComposio(request, ENV, url, { authedUser: anon });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://delegent-app.web.app/connections/return?connected=ok');
});

// The query string arrives from a redirect we do not control, so nothing from
// it may be forwarded onward.
test('the callback never echoes Composio parameters onward', async () => {
  const { request, url } = req('/api/connections/composio/callback?status=success&connected_account_id=ca_evil&extra=%3Cscript%3E');
  const res = await handleComposio(request, ENV, url, { authedUser: anon });
  const location = res.headers.get('location');
  assert.equal(location.includes('ca_evil'), false);
  assert.equal(location.includes('script'), false);
});

test('a failed grant is acknowledged calmly, not as an error page', async () => {
  const { request, url } = req('/api/connections/composio/callback?status=failed');
  const res = await handleComposio(request, ENV, url, { authedUser: anon });
  assert.equal(res.headers.get('location'), 'https://delegent-app.web.app/connections/return?connected=failed');
});

test('everything except the callback requires a session', async () => {
  for (const [path, method] of [['/api/connections/composio', 'GET'], ['/api/connections/composio/initiate', 'POST']]) {
    const { request, url } = req(path, method, method === 'POST' ? '{}' : undefined);
    const res = await handleComposio(request, ENV, url, { authedUser: anon });
    assert.equal(res.status, 401, path);
  }
});

test('listing returns only ACTIVE connections', async () => {
  const { request, url } = req('/api/connections/composio');
  const res = await handleComposio(request, ENV, url, {
    authedUser: authed,
    fetchImpl: async () => ok({ items: [
      { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
      { id: 'ca_2', status: 'INITIALIZING', toolkit: { slug: 'gmail' } },
    ] }),
  });
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.connections.length, 1);
  assert.equal(body.connections[0].id, 'gmail');
  // OFFERED is what the screen filters its cards by. Reporting only what is
  // connected is what made Gmail invisible: the card appeared once connected,
  // so it could never be connected.
  // Every registered toolkit is offered, whatever is connected. Pinned to the
  // registry rather than to a literal list so adding a connector (QuickBooks,
  // 2026-09-02) does not fail a test about Gmail.
  assert.ok(body.offered.includes('gmail'));
  assert.equal(body.offered.length, COMPOSIO_TOOLKITS.length);
});

// A Worker deployed without the key must still render the connections page.
test('a missing key renders an empty list, not a failure', async () => {
  const { request, url } = req('/api/connections/composio');
  const res = await handleComposio(request, {}, url, { authedUser: authed });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { available: false, offered: [], connections: [] });
});

test('initiate returns the redirect url and the exact account id for return verification', async () => {
  const { request, url } = req('/api/connections/composio/initiate', 'POST', JSON.stringify({ toolkit: 'gmail' }));
  const res = await handleComposio(request, ENV, url, {
    authedUser: authed,
    fetchImpl: async () => ok({ redirect_url: 'https://connect.composio.dev/link/lk_1', connected_account_id: 'ca_1', expires_at: 'Z' }),
  });
  assert.deepEqual(await res.json(), { redirectUrl: 'https://connect.composio.dev/link/lk_1',
    expiresAt: 'Z', connectedAccountId: 'ca_1' });
});

test('initiate rejects malformed account ids instead of exposing an uncorrelated link', async () => {
  for (const id of [undefined, null, '', 42, {}, 'ca/other', 'a'.repeat(129)]) {
    const { request, url } = req('/api/connections/composio/initiate', 'POST', JSON.stringify({ toolkit: 'gmail' }));
    const res = await handleComposio(request, ENV, url, {
      authedUser: authed,
      fetchImpl: async () => ok({ redirect_url: 'https://connect.composio.dev/link/lk_1', connected_account_id: id }),
    });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'refused' });
  }
});

test('initiate rejects a junk or unknown toolkit', async () => {
  for (const [toolkit, status] of [[123, 400], ['../etc', 400], ['notatoolkit', 400]]) {
    const { request, url } = req('/api/connections/composio/initiate', 'POST', JSON.stringify({ toolkit }));
    const res = await handleComposio(request, ENV, url, {
      authedUser: authed,
      fetchImpl: async () => { throw new Error('must not be called'); },
    });
    assert.equal(res.status, status, String(toolkit));
  }
});

// Composio would happily delete any account id handed to it. Without this
// check one customer could disconnect another customer's mailbox.
test('refuses to disconnect an account that is not the caller own', async () => {
  const { request, url } = req('/api/connections/composio/ca_someone_else', 'DELETE');
  let deleted = false;
  const res = await handleComposio(request, ENV, url, {
    authedUser: authed,
    fetchImpl: async (u, init) => {
      if (init?.method === 'DELETE') { deleted = true; return ok({}); }
      return ok({ items: [{ id: 'ca_mine', status: 'ACTIVE', toolkit: { slug: 'gmail' } }] });
    },
  });
  assert.equal(res.status, 404);
  assert.equal(deleted, false, 'no DELETE may reach Composio for an account we do not own');
});

test('disconnects an account the caller does own', async () => {
  const { request, url } = req('/api/connections/composio/ca_mine', 'DELETE');
  let deleted = false;
  const res = await handleComposio(request, ENV, url, {
    authedUser: authed,
    fetchImpl: async (u, init) => {
      if (init?.method === 'DELETE') { deleted = true; return ok({}); }
      return ok({ items: [{ id: 'ca_mine', status: 'ACTIVE', toolkit: { slug: 'gmail' } }] });
    },
  });
  assert.equal(res.status, 200);
  assert.equal(deleted, true);
});

// ---------------------------------------------------------------------------
// Service-level disconnect. The card is per service and its confirmation says
// access stops straight away; the account-addressed route above removed ONE
// grant, so a second live one survived and the agent kept working.
// ---------------------------------------------------------------------------

const serviceReq = (service) => req('/api/connections/composio/service/' + service, 'DELETE');
const inventory = (items) => ok({ items });

test('the service route is matched before the account-addressed one', async () => {
  // Without the ordering, 'service/gmail' arrives at the account branch, fails
  // its id pattern on the slash and comes back as a 400 invalid_account.
  const { request, url } = serviceReq('gmail');
  const res = await handleComposio(request, ENV, url, {
    authedUser: authed,
    fetchImpl: async (u, init) => (init?.method === 'DELETE' ? ok({}) : inventory([])),
  });
  assert.notEqual(res.status, 400);
});

test('disconnecting a service removes every grant the caller owns for it', async () => {
  const { request, url } = serviceReq('gmail');
  const deleted = [];
  const res = await handleComposio(request, ENV, url, {
    authedUser: authed,
    fetchImpl: async (u, init) => {
      if (init?.method === 'DELETE') { deleted.push(String(u).split('/').pop()); return ok({}); }
      return inventory([
        { id: 'ca_one', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
        { id: 'ca_two', status: 'INACTIVE', toolkit: { slug: 'gmail' } },
        { id: 'ca_calendar', status: 'ACTIVE', toolkit: { slug: 'googlecalendar' } },
      ]);
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { disconnected: true, removed: 2, complete: true });
  assert.deepEqual(deleted, ['ca_one', 'ca_two'], 'another card is not disconnected by this one');
});

test('a partial removal is a failure, because the coworker can still reach the account', async () => {
  const { request, url } = serviceReq('gmail');
  const res = await handleComposio(request, ENV, url, {
    authedUser: authed,
    fetchImpl: async (u, init) => {
      if (init?.method === 'DELETE') return String(u).endsWith('ca_stuck') ? new Response('no', { status: 500 }) : ok({});
      return inventory([
        { id: 'ca_gone', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
        { id: 'ca_stuck', status: 'ACTIVE', toolkit: { slug: 'gmail' } },
      ]);
    },
  });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'partial_disconnect', removed: 1, failed: 1 });
});

test('finding nothing in an inventory we could not finish reading is not a success', async () => {
  const { request, url } = serviceReq('gmail');
  const res = await handleComposio(request, ENV, url, {
    authedUser: authed,
    fetchImpl: async (u) => (new URL(String(u)).searchParams.get('cursor')
      ? new Response('no', { status: 500 })
      : ok({ items: [{ id: 'ca_calendar', status: 'ACTIVE', toolkit: { slug: 'googlecalendar' } }], next_cursor: 'page2' })),
  });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'disconnect_unconfirmed');
});

test('a service with nothing connected is an honest, idempotent success', async () => {
  const { request, url } = serviceReq('gmail');
  const res = await handleComposio(request, ENV, url, {
    authedUser: authed,
    fetchImpl: async (u, init) => {
      assert.notEqual(init?.method, 'DELETE');
      return inventory([]);
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { disconnected: true, removed: 0, complete: true });
});

test('the service route refuses a service this build does not offer, before any call', async () => {
  for (const service of ['not_a_service', 'NOT-VALID', 'a'.repeat(65)]) {
    const { request, url } = serviceReq(service);
    const res = await handleComposio(request, ENV, url, {
      authedUser: authed,
      fetchImpl: async () => { throw new Error('must not reach Composio'); },
    });
    assert.equal(res.status, 400, service);
  }
});

test('the service route needs a session, like every other authenticated route', async () => {
  const { request, url } = serviceReq('gmail');
  const res = await handleComposio(request, ENV, url, {
    authedUser: anon,
    fetchImpl: async () => { throw new Error('must not reach Composio'); },
  });
  assert.equal(res.status, 401);
});

test('an unknown composio path is a 404, not a fallthrough', async () => {
  const { request, url } = req('/api/connections/composio/nope/deep');
  const res = await handleComposio(request, ENV, url, { authedUser: authed });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// The runner surface: the half that was missing, and its absence is why a
// connected Gmail was useless. See the header of composio-routes.ts.
// ---------------------------------------------------------------------------

const RUNNER_USER = 'user-1';
const active = { items: [{ id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'gmail' } }] };
const noneConnected = { items: [] };
const counted = (used = 0) => ({ usedThisCycle: async () => used, recordExecution: async () => {} });

/** Route the fake fetch by path, so list and execute can differ in one test. */
function router(map) {
  return async (input) => {
    const path = new URL(typeof input === 'string' ? input : input.url).pathname;
    for (const [needle, body] of Object.entries(map)) {
      if (path.includes(needle)) return ok(body);
    }
    throw new Error(`unexpected call to ${path}`);
  };
}

function runnerReq(path, method = 'GET', body) {
  const url = new URL(`https://api.delegantai.co.uk${path}`);
  return { request: new Request(url, { method, body }), url };
}

test('the runner paths are recognised so index.ts can route them', () => {
  assert.equal(isComposioRunnerPath('/api/runner/connections/composio'), true);
  assert.equal(isComposioRunnerPath('/api/runner/connections/composio/execute'), true);
  assert.equal(isComposioRunnerPath('/api/runner/connections'), false);
  assert.equal(isComposioRunnerPath('/api/connections/composio'), false);
});

test('the runner can list what Composio holds, tagged with its backend', async () => {
  const { request, url } = runnerReq('/api/runner/connections/composio');
  const res = await handleComposioRunner(request, ENV, url, RUNNER_USER, {
    ...counted(), fetchImpl: router({ '/connected_accounts': active }),
  });
  const body = await res.json();
  assert.deepEqual(body.connections, [
    { provider: 'gmail', toolkit: 'gmail', backend: 'composio', status: 'connected' },
  ]);
});

test('a tool name that is not a Composio slug is refused before any call', async () => {
  for (const tool of ['', 'gmail_fetch', '../../admin', 'GM', 'A'.repeat(200)]) {
    const { request, url } = runnerReq('/api/runner/connections/composio/execute', 'POST', JSON.stringify({ tool }));
    const res = await handleComposioRunner(request, ENV, url, RUNNER_USER, {
      ...counted(),
      fetchImpl: async () => { throw new Error('must not reach Composio'); },
    });
    assert.equal(res.status, 400, tool);
  }
});

test('a tool from a toolkit we do not offer is refused', async () => {
  // The injection case: an email telling the agent to run an action on a
  // service the customer was never shown must not reach it. The example is a
  // toolkit that does not exist at all, on purpose: this test said
  // NOTION_DELETE_PAGE, then Notion shipped; then TRELLO_DELETE_BOARD, then
  // Trello shipped, both on 2026-09-02. A real toolkit rots into a registered
  // one; a fictional prefix exercises exactly the same refusal and never will.
  const { request, url } = runnerReq('/api/runner/connections/composio/execute', 'POST',
    JSON.stringify({ tool: 'NOTATOOLKIT_DELETE_EVERYTHING' }));
  const res = await handleComposioRunner(request, ENV, url, RUNNER_USER, {
    ...counted(),
    fetchImpl: async () => { throw new Error('must not reach Composio'); },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'unknown_toolkit');
});

test('a write action on a read-only toolkit never reaches Composio', async () => {
  // Stripe will not issue a read-only grant, so the grant is read_write and
  // the card's promise is kept at this boundary. A refund must be refused
  // before any call, whatever the customer's token could do.
  for (const tool of ['STRIPE_CREATE_REFUND', 'STRIPE_CANCEL_SUBSCRIPTION', 'STRIPE_UPDATE_CUSTOMER', 'STRIPE_DELETE_CUSTOMER']) {
    const { request, url } = runnerReq('/api/runner/connections/composio/execute', 'POST', JSON.stringify({ tool }));
    const res = await handleComposioRunner(request, ENV, url, RUNNER_USER, {
      ...counted(),
      fetchImpl: async () => { throw new Error('must not reach Composio'); },
    });
    assert.equal(res.status, 403, tool);
    const body = await res.json();
    assert.equal(body.error, 'read_only');
    assert.equal(body.provider, 'stripe');
  }
});

test('an unconnected service is refused with something the agent can act on', async () => {
  const { request, url } = runnerReq('/api/runner/connections/composio/execute', 'POST',
    JSON.stringify({ tool: 'GMAIL_FETCH_EMAILS' }));
  const res = await handleComposioRunner(request, ENV, url, RUNNER_USER, {
    ...counted(), fetchImpl: router({ '/connected_accounts': noneConnected }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'not_connected');
  // Named, so the agent can tell the customer WHICH card to press.
  assert.equal(body.provider, 'gmail');
});

test('a connected service runs and the result comes back', async () => {
  const { request, url } = runnerReq('/api/runner/connections/composio/execute', 'POST',
    JSON.stringify({ tool: 'GMAIL_FETCH_EMAILS', arguments: { max_results: 2 } }));
  const res = await handleComposioRunner(request, ENV, url, RUNNER_USER, {
    ...counted(),
    fetchImpl: router({ '/connected_accounts': active, '/tools/execute': { messages: [{ subject: 'hello' }] } }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).result, { messages: [{ subject: 'hello' }] });
});

test('arguments must be an object, not an array or a string', async () => {
  for (const bad of [[], 'x', 7]) {
    const { request, url } = runnerReq('/api/runner/connections/composio/execute', 'POST',
      JSON.stringify({ tool: 'GMAIL_FETCH_EMAILS', arguments: bad }));
    const res = await handleComposioRunner(request, ENV, url, RUNNER_USER, {
      ...counted(), fetchImpl: async () => { throw new Error('must not reach Composio'); },
    });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test('a runaway agent is stopped by the monthly ceiling', async () => {
  const { request, url } = runnerReq('/api/runner/connections/composio/execute', 'POST',
    JSON.stringify({ tool: 'GMAIL_FETCH_EMAILS' }));
  const res = await handleComposioRunner(request, ENV, url, RUNNER_USER, {
    usedThisCycle: async () => COMPOSIO_MONTHLY_EXECUTION_CEILING,
    fetchImpl: router({ '/connected_accounts': active }),
  });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'quota_exceeded');
});

for (const stage of ['inventory', 'execution']) {
  test(`a ${stage} rate limit preserves retry timing through the runner JSON response`, async () => {
    const { request, url } = runnerReq('/api/runner/connections/composio/execute', 'POST', JSON.stringify({ tool: 'GMAIL_FETCH_EMAILS' }));
    let calls = 0;
    const res = await handleComposioRunner(request, ENV, url, RUNNER_USER, {
      ...counted(),
      fetchImpl: async (input) => {
        calls++;
        if (stage === 'execution' && String(input).includes('/connected_accounts')) return ok(active);
        return new Response(null, { status: 429, headers: { 'retry-after': '17' } });
      },
    });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'rate_limited', retryAfterSeconds: 17 });
    assert.equal(calls, stage === 'inventory' ? 1 : 2, 'the broker must not automatically replay an action');
  });
}

test('a Worker with no key says nothing is connected rather than erroring', async () => {
  const { request, url } = runnerReq('/api/runner/connections/composio');
  const res = await handleComposioRunner(request, {}, url, RUNNER_USER, counted());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { connections: [] });
});

test('a phone is sent back to the app, not to the web app', async () => {
  // Alex, 2026-09-01: connecting on the phone dumped him in a browser looking at
  // a page that did not even list the service he had just connected.
  const { request, url } = req('/api/connections/composio/callback/app?status=success');
  const res = await handleComposio(request, ENV, url, { authedUser: anon });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'sidekick://connections/return?provider=composio&connected=ok');
});

test('the app surface is carried into the callback url Composio is given', async () => {
  let sent = null;
  const { request, url } = req('/api/connections/composio/initiate', 'POST', JSON.stringify({ toolkit: 'gmail', surface: 'app' }));
  await handleComposio(request, ENV, url, {
    authedUser: authed,
    fetchImpl: async (_input, init) => {
      sent = JSON.parse(init.body);
      return ok({ redirect_url: 'https://connect.composio.dev/link/lk_1', connected_account_id: 'ca_1' });
    },
  });
  assert.equal(sent.callback_url, 'https://api.delegantai.co.uk/api/connections/composio/callback/app');
});
