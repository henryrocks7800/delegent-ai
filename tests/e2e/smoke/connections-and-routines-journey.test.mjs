// Connections and Routines, end to end.
//
// The unit suites already cover each handler in isolation, and they do it well.
// What they cannot cover is the seam: every one of those tests writes its own
// fixture row, so a create path and a read path can disagree about a column name
// and both suites still pass while production breaks.
//
// So this file keeps ONE in-memory store and makes the real handlers write to it
// and read from it. A connection is created by the real callback and then read by
// all four consumers that exist: the two surfaces, the agent's run instructions,
// and the runner spending the token. A routine is created by the real endpoint
// and then claimed by the real sweep.
//
// No network, no credentials.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { sweepScheduledTasks } from '../../../apps/worker/dist/index.js';
import {
  handleConnectionStart,
  handleConnectionCallback,
  handleConnectionComplete,
  handleConnectionList,
  handleConnectionDisconnect,
  handleRunnerConnectionToken,
  listBrokeredConnections,
  __testing as connectionsTesting,
} from '../../../apps/worker/dist/connections-oauth.js';
import { findConnectableService, isServiceOffered } from '../../../packages/shared/dist/index.js';

const USER_ID = '9c4d1e77-3b2a-4f60-9d81-5a6c7e8f0a12';
const SUPABASE_URL = 'https://journey.supabase.test';
const WORKER_URL = 'https://worker.journey.test';
const CALLBACK_ORIGIN = 'https://api.delegantai.co.uk';
const ACCOUNT_LABEL = 'alex@example.com';
const FLY_APP = 'delegent-runner-journey01';
const RUNNER_BASE = `https://${FLY_APP}.fly.dev`;
const PER_USER_SECRET = 'per-user-hmac-secret-journey';

const ENV = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_journey_fixture',
  SIDEKICK_CONNECTIONS_ENC_KEY: Buffer.alloc(32, 9).toString('base64'),
  SIDEKICK_FREEAGENT_CLIENT_ID: 'fa-client-id',
  SIDEKICK_FREEAGENT_CLIENT_SECRET: 'fa-client-secret',
  SIDEKICK_CONNECTIONS_CALLBACK_ORIGIN: CALLBACK_ORIGIN,
  SIDEKICK_CONNECTIONS_RETURN_WEB_URL: 'https://delegent-app.web.app/connections',
  SIDEKICK_RUNNER_SHARED_SECRET: 'global_secret_must_not_be_used_here',
};

function ctxStub() {
  return { waitUntil() {} };
}

// The hand-off burst buckets are module state shared by every test in the file,
// so without this the last connection test in the file fails on a rate limit
// rather than on the thing it is about.
test.beforeEach(() => connectionsTesting.resetConnectionBurstLimits());

/**
 * The smallest Supabase that still behaves like one: rows in memory, PostgREST
 * `col=eq.value` filters honoured, and the two RPCs the journey needs. Anything
 * it is not asked to serve throws, so a handler reaching for a table this test
 * did not think about fails loudly rather than silently reading nothing.
 */
function fakeSupabase({ tables = {}, external = {} } = {}) {
  const store = {
    connection_oauth_flows: [],
    user_connections: [],
    scheduled_tasks: [],
    subscriptions: [{ user_id: USER_ID, status: 'active', current_period_start: '2026-07-01T00:00:00.000Z' }],
    usage_quotas: [{ user_id: USER_ID, monthly_token_quota: 1_000_000, tier_id: 'studio' }],
    token_usage_events: [],
    hermes_instances: [{
      user_id: USER_ID,
      status: 'ready',
      ready_at: new Date().toISOString(),
      last_health_at: new Date().toISOString(),
      provider: 'fly_machines',
    }],
    hermes_instance_private: [{
      user_id: USER_ID,
      runner_base_url: RUNNER_BASE,
      provider: 'fly_machines',
      fly_app_name: FLY_APP,
      runner_shared_secret: PER_USER_SECRET,
    }],
    profiles: [{ id: USER_ID, agent_name: 'Hassan' }],
    task_runs: [],
    messages: [],
    ...tables,
  };

  const calls = [];
  const real = globalThis.fetch;

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  // PostgREST filters: only `eq` is used anywhere in the paths under test.
  function matches(row, url) {
    for (const [key, raw] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue;
      if (!raw.startsWith('eq.')) continue;
      if (String(row[key] ?? '') !== raw.slice(3)) return false;
    }
    return true;
  }

  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const method = (init.method ?? 'GET').toUpperCase();
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body ?? null; }
    calls.push({ url: String(rawUrl), method, body, headers: init.headers ?? {} });

    for (const [prefix, handler] of Object.entries(external)) {
      if (String(rawUrl).startsWith(prefix)) return handler(String(rawUrl), init);
    }

    const url = new URL(rawUrl);

    if (url.pathname === '/auth/v1/user') return json({ id: USER_ID });

    if (url.pathname === '/rest/v1/rpc/consume_connection_oauth_flow') {
      const index = store.connection_oauth_flows.findIndex((row) => row.state === body?.p_state);
      if (index === -1) return json([]);
      // Single-use is the whole security property, so the fake honours it.
      const [flow] = store.connection_oauth_flows.splice(index, 1);
      return json([{
        user_id: flow.user_id,
        provider: flow.provider,
        code_verifier: flow.code_verifier,
        return_surface: flow.return_surface,
      }]);
    }
    if (url.pathname === '/rest/v1/rpc/purge_expired_connection_flows') return json(0);
    if (url.pathname === '/rest/v1/rpc/claim_due_scheduled_tasks') {
      const due = store.scheduled_tasks.filter((row) => row.status === 'active');
      return json(due.map((row) => ({
        id: row.id, user_id: row.user_id, prompt: row.prompt, label: row.label,
      })));
    }
    if (url.pathname === '/rest/v1/rpc/record_scheduled_task_dispatch') return json([]);

    const table = url.pathname.replace('/rest/v1/', '');
    if (!(table in store)) throw new Error(`fake supabase: unknown table ${table}`);

    if (method === 'GET') return json(store[table].filter((row) => matches(row, url)));

    if (method === 'POST') {
      const incoming = Array.isArray(body) ? body : [body];
      const written = incoming.map((row) => {
        const conflict = url.searchParams.get('on_conflict');
        if (conflict) {
          const keys = conflict.split(',');
          const existing = store[table].find((held) => keys.every((k) => held[k] === row[k]));
          if (existing) {
            Object.assign(existing, row);
            return existing;
          }
        }
        const created = { id: `${table}-${store[table].length + 1}`, ...row };
        store[table].push(created);
        return created;
      });
      return json(written, 201);
    }

    if (method === 'PATCH') {
      const hit = store[table].filter((row) => matches(row, url));
      for (const row of hit) Object.assign(row, body);
      return json(hit);
    }

    if (method === 'DELETE') {
      store[table] = store[table].filter((row) => !matches(row, url));
      return json([], 200);
    }

    throw new Error(`fake supabase: unhandled ${method} ${url.pathname}`);
  };

  return { store, calls, restore: () => { globalThis.fetch = real; } };
}

// Dropbox, Slack, GitHub, Google Drive, Outlook and Teams moved to Composio on
// 2026-09-03. This journey pins OUR OWN broker end to end, so it runs on the
// one native provider left. FreeAgent publishes no revocation endpoint, so
// there is no revoke leg to stub, and none to assert.
const freeagentProvider = {
  'https://api.freeagent.com/v2/token_endpoint': () =>
    Response.json({ access_token: 'access-live', refresh_token: 'refresh-live', expires_in: 14_400 }),
  'https://api.freeagent.com/v2/company': () => Response.json({ company: { name: ACCOUNT_LABEL } }),
};

const authed = (url, init = {}) =>
  new Request(url, { ...init, headers: { authorization: 'Bearer session-token', ...(init.headers ?? {}) } });

/**
 * Drive all three real legs so the row under test is one we really made: start,
 * the unauthenticated callback that only hands the code back, and the
 * authenticated completion that actually stores the grant.
 */
async function connectDropbox(surface = 'web') {
  const start = await handleConnectionStart(
    authed(`${CALLBACK_ORIGIN}/api/connections/oauth/freeagent/start`, {
      method: 'POST',
      body: JSON.stringify({ surface }),
    }),
    ENV,
    'freeagent',
  );
  assert.equal(start.status, 200);
  const state = new URL((await start.json()).authorizeUrl).searchParams.get('state');

  const callback = await handleConnectionCallback(
    new Request(`${CALLBACK_ORIGIN}/oauth/freeagent/callback?state=${state}&code=auth-code`),
    ENV,
    'freeagent',
  );
  assert.equal(callback.status, 302);

  const handedBack = new URL(callback.headers.get('location'));
  assert.equal(handedBack.searchParams.get('connection_state'), state);
  const code = handedBack.searchParams.get('connection_code');
  assert.equal(code, 'auth-code');

  const completed = await completeDropbox(state, code);
  assert.equal(completed.status, 200);
  return state;
}

/** The authenticated leg, on its own, for the tests that replay it. */
function completeDropbox(state, code = 'auth-code') {
  return handleConnectionComplete(
    authed(`${CALLBACK_ORIGIN}/api/connections/oauth/freeagent/complete`, {
      method: 'POST',
      body: JSON.stringify({ state, code }),
    }),
    ENV,
    'freeagent',
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

// The four readers are written in three different files and were added weeks
// apart. If they ever disagree, the user sees "Connected" on a screen while the
// agent tells them in chat that nothing is connected, which is the single worst
// failure this feature has.
test('one real connect is seen the same way by both surfaces, the agent and the runner', async () => {
  const fake = fakeSupabase({ external: freeagentProvider });
  try {
    await connectDropbox('web');

    // Exactly one row, and the tokens in it are not readable.
    assert.equal(fake.store.user_connections.length, 1);
    const stored = fake.store.user_connections[0];
    assert.equal(stored.status, 'connected');
    assert.match(stored.access_token_enc, /^v1\./);
    assert.ok(!JSON.stringify(stored).includes('access-live'), 'no plaintext token at rest');

    // Reader 1 and 2: the screen, on the phone and in the browser. Both call
    // this one endpoint, so agreement between them is structural.
    const listed = await (await handleConnectionList(
      authed(`${CALLBACK_ORIGIN}/api/connections/oauth`), ENV,
    )).json();
    assert.deepEqual(listed.connections.map((c) => c.provider), ['freeagent']);
    assert.equal(listed.connections[0].status, 'connected');
    assert.equal(listed.connections[0].accountLabel, ACCOUNT_LABEL);
    assert.ok(!JSON.stringify(listed).includes('token'), 'the client response carries no token field');

    // Reader 3: what the agent is told at the top of a turn.
    const brokered = await listBrokeredConnections(ENV, USER_ID);
    assert.deepEqual(brokered.map((c) => c.provider), ['freeagent']);
    assert.equal(brokered[0].status, 'connected');
    assert.equal(brokered[0].accountLabel, ACCOUNT_LABEL, 'the agent names the same account the screen does');
    assert.ok(brokered[0].displayName.length > 0, 'the agent is given a name it can say out loud');

    // Reader 4: the runner actually spending it. This is the only caller
    // allowed a token, and it must be the live one, not the stored ciphertext.
    const token = await (await handleRunnerConnectionToken(
      new Request(`${CALLBACK_ORIGIN}/api/runner/connections/token`, {
        method: 'POST',
        body: JSON.stringify({ provider: 'freeagent' }),
      }),
      ENV,
      USER_ID,
    )).json();
    assert.equal(token.accessToken, 'access-live');

    // And the catalogue the surfaces render agrees that it is offerable.
    assert.equal(isServiceOffered(findConnectableService('freeagent'), listed.available), true);
  } finally {
    fake.restore();
  }
});

// A provider the broker holds no credentials for must not be offered, or the
// reader taps a live-looking card and gets a failure. This is the gate that
// lets a provider ship dark and go live on a secret alone.
test('a provider with no credentials is absent from the offer list on both surfaces', async () => {
  const fake = fakeSupabase({ external: freeagentProvider });
  try {
    const listed = await (await handleConnectionList(
      authed(`${CALLBACK_ORIGIN}/api/connections/oauth`), ENV,
    )).json();

    assert.ok(listed.available.includes('freeagent'));
    // Slack used to be the dark-provider example here. It is brokered by
    // Composio from 2026-09-03, so it is not on the native list at all, which
    // is a stronger statement than "present but not offered".
    assert.equal(listed.available.includes('slack'), false, 'Slack is brokered, not native');
    assert.equal(isServiceOffered(findConnectableService('slack'), listed.available), false);

    // Starting a provider the native broker does not know is refused rather
    // than half-built. 404, because the registry has no such id at all.
    const start = await handleConnectionStart(
      authed(`${CALLBACK_ORIGIN}/api/connections/oauth/slack/start`, { method: 'POST' }),
      ENV,
      'slack',
    );
    assert.equal(start.status, 404);
    assert.equal(fake.store.connection_oauth_flows.length, 0, 'no flow row for a provider that cannot finish');
  } finally {
    fake.restore();
  }
});

test('disconnecting on one surface clears the agent and the runner too', async () => {
  const fake = fakeSupabase({ external: freeagentProvider });
  try {
    await connectDropbox('app');
    assert.equal((await listBrokeredConnections(ENV, USER_ID)).length, 1);

    const removed = await handleConnectionDisconnect(
      authed(`${CALLBACK_ORIGIN}/api/connections/oauth/freeagent`, { method: 'DELETE' }),
      ENV,
      'freeagent',
    );
    assert.equal(removed.status, 200);

    assert.equal(fake.store.user_connections.length, 0);
    const listed = await (await handleConnectionList(
      authed(`${CALLBACK_ORIGIN}/api/connections/oauth`), ENV,
    )).json();
    assert.deepEqual(listed.connections, []);
    assert.deepEqual(await listBrokeredConnections(ENV, USER_ID), []);

    // The runner must be told it is gone rather than handed a stale token.
    const token = await handleRunnerConnectionToken(
      new Request(`${CALLBACK_ORIGIN}/api/runner/connections/token`, {
        method: 'POST',
        body: JSON.stringify({ provider: 'freeagent' }),
      }),
      ENV,
      USER_ID,
    );
    assert.notEqual(token.status, 200);

    // This used to assert the grant was revoked at Dropbox as well. FreeAgent
    // publishes no revocation endpoint, so `revoke` is null for it and there
    // is no call to make. What must hold is that we do NOT invent one: the row
    // goes, the runner is refused, and nothing is called at the provider.
    assert.ok(
      !fake.calls.some((c) => c.url.includes('token/revoke')),
      'no revoke endpoint exists for FreeAgent, so none may be called',
    );
  } finally {
    fake.restore();
  }
});

// The flow row is what binds a returning browser to a user, and it is spent on
// the completion leg now rather than in the callback. Replaying it would let a
// captured return URL attach an account a second time.
test('a connection state cannot be spent twice', async () => {
  const fake = fakeSupabase({ external: freeagentProvider });
  try {
    const state = await connectDropbox('web');
    assert.equal(fake.store.user_connections.length, 1);

    const replay = await completeDropbox(state);
    assert.equal(replay.status, 410);
    assert.equal((await replay.json()).error, 'invalid_state');
    assert.equal(fake.store.user_connections.length, 1, 'a replay must not write a second row');

    // And the callback half is equally spent, so a captured return URL cannot be
    // re-run to have a fresh code handed back out.
    const replayedCallback = await handleConnectionCallback(
      new Request(`${CALLBACK_ORIGIN}/oauth/freeagent/callback?state=${state}&code=auth-code`),
      ENV,
      'freeagent',
    );
    assert.equal(replayedCallback.status, 302);
    assert.match(replayedCallback.headers.get('location'), /invalid_state/);
  } finally {
    fake.restore();
  }
});

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

// Creating a routine and running it are two halves written months apart against
// the same table. Every unit test on either side supplies its own fixture row,
// so this is the only place the halves are made to agree on real columns.
test('a routine created through the API is the row the waker claims and dispatches', async () => {
  const fake = fakeSupabase({
    external: {
      [`${RUNNER_BASE}/healthz`]: () => Response.json({ ok: true, workspaceReady: true }),
      [`${RUNNER_BASE}/tasks`]: () => Response.json({ status: 'completed', result: 'Three unread, nothing urgent.' }),
    },
  });
  try {
    const created = await worker.fetch(
      authed(`${WORKER_URL}/api/scheduled-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Summarise my unread email',
          label: 'Inbox digest',
          schedule_kind: 'interval',
          interval_seconds: 86_400,
          timezone: 'Europe/London',
        }),
      }),
      ENV,
      ctxStub(),
    );
    assert.equal(created.status, 201);
    assert.ok((await created.json()).id, 'the caller gets an id back and no provider internals');

    // The row as actually written.
    assert.equal(fake.store.scheduled_tasks.length, 1);
    const row = fake.store.scheduled_tasks[0];
    assert.equal(row.user_id, USER_ID);
    assert.equal(row.status, 'active');
    assert.equal(row.prompt, 'Summarise my unread email');
    // The zone is carried so a daily routine keeps its local hour across a
    // clock change rather than drifting by an hour twice a year.
    assert.equal(row.timezone, 'Europe/London');
    assert.ok(new Date(row.next_run_at).getTime() > Date.now(), 'first run is in the future');

    // Now the other half, reading the same row through the real claim path.
    const swept = await sweepScheduledTasks(ENV);
    assert.deepEqual(swept, { dispatched: 1, failed: 0 });

    const dispatch = fake.calls.find((c) => c.url === `${RUNNER_BASE}/tasks` && c.method === 'POST');
    assert.ok(dispatch, 'the routine must reach the user own runner');
    assert.equal(dispatch.body.user_id, USER_ID);
    assert.equal(
      dispatch.body.instruction,
      'Summarise my unread email',
      'the prompt the user typed is the instruction the runner receives',
    );
    assert.match(dispatch.headers['x-sidekick-runner-token'], /^v1\.[a-f0-9]{64}$/);

    // And the answer lands in chat, which is the only place the user will look.
    const message = fake.store.messages.at(-1);
    assert.ok(message, 'a scheduled run must leave an assistant message behind');
    assert.equal(message.role, 'assistant');
    assert.ok(message.content.includes('Three unread'));
  } finally {
    fake.restore();
  }
});

test('a routine is refused without an active plan, and nothing is written', async () => {
  const fake = fakeSupabase({
    tables: { subscriptions: [{ user_id: USER_ID, status: 'canceled' }] },
  });
  try {
    const response = await worker.fetch(
      authed(`${WORKER_URL}/api/scheduled-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Do a thing', interval_seconds: 3_600 }),
      }),
      ENV,
      ctxStub(),
    );
    assert.equal(response.status, 402);
    assert.equal(fake.store.scheduled_tasks.length, 0);
  } finally {
    fake.restore();
  }
});

// The waker cadence is five minutes, so a finer schedule is a promise we cannot
// keep. Better refused at the door than accepted and quietly run late for ever.
test('a routine faster than the waker cadence is refused rather than stored', async () => {
  const fake = fakeSupabase();
  try {
    const response = await worker.fetch(
      authed(`${WORKER_URL}/api/scheduled-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'Check every minute', interval_seconds: 60 }),
      }),
      ENV,
      ctxStub(),
    );
    assert.equal(response.status, 422);
    assert.equal(fake.store.scheduled_tasks.length, 0);
  } finally {
    fake.restore();
  }
});
