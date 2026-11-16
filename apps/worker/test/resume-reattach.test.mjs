// Resume-reattach tests (2026-07-30 defect: after a resubscribe the webhook
// flipped the sleeping row to 'provisioning', but the provisioning cron cannot
// claim a user who still has a live private binding, so the workspace sat on
// "Preparing workspace" indefinitely. The fix reattaches the retained Machine
// in place: a webhook fast path via ctx.waitUntil plus a Worker-cron sweep.)
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSupabaseStripeBillingStore,
  handleStripeWebhookRequest,
  reattachResumedSeries4Runner,
} from '../dist/stripe-flow.js';
import { sweepStuckResumedRunners } from '../dist/index.js';

const userId = '22222222-2222-4222-8222-222222222222';
const runnerBaseUrl = 'https://delegent-runner-test.fly.dev';

const healthyResponse = () =>
  new Response(JSON.stringify({ ok: true, hermesApiServerAvailable: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function reattachStore(overrides = {}) {
  const calls = { promoted: [] };
  const store = {
    async claimBillingEvent() { throw new Error('unused'); },
    async updateBillingEvent() {},
    async upsertSubscription() { return true; },
    async upsertUsageQuota() { return true; },
    async enqueueHermesProvisioning() {},
    async getResumedRunnerReattachTarget() { return runnerBaseUrl; },
    async promoteResumedRunnerReady(id, url) {
      calls.promoted.push({ id, url });
      return true;
    },
    ...overrides,
  };
  return { store, calls };
}

const fastOptions = { intervalMs: 0, sleep: async () => {} };

test('reattach promotes the row once the runner healthz comes up', async () => {
  const { store, calls } = reattachStore();
  const result = await reattachResumedSeries4Runner(store, userId, async () => healthyResponse(), fastOptions);
  assert.equal(result, 'promoted');
  assert.deepEqual(calls.promoted, [{ id: userId, url: runnerBaseUrl }]);
});

test('reattach retries through cold-boot failures before promoting (first probe triggers Fly autostart)', async () => {
  const { store, calls } = reattachStore();
  let probes = 0;
  const result = await reattachResumedSeries4Runner(
    store,
    userId,
    async () => {
      probes += 1;
      if (probes < 3) throw new Error('connection refused: machine still booting');
      return healthyResponse();
    },
    fastOptions,
  );
  assert.equal(result, 'promoted');
  assert.equal(probes, 3);
  assert.equal(calls.promoted.length, 1);
});

test('reattach is a no-op when there is nothing to reattach (fresh signup, no binding)', async () => {
  const { store, calls } = reattachStore({ async getResumedRunnerReattachTarget() { return null; } });
  let probes = 0;
  const result = await reattachResumedSeries4Runner(store, userId, async () => { probes += 1; return healthyResponse(); }, fastOptions);
  assert.equal(result, 'no_target');
  assert.equal(probes, 0, 'must not probe anything without a target');
  assert.deepEqual(calls.promoted, []);
});

test('reattach reports unready when the runner never becomes healthy', async () => {
  const { store, calls } = reattachStore();
  const result = await reattachResumedSeries4Runner(
    store,
    userId,
    async () => new Response('{"ok":false}', { status: 200, headers: { 'content-type': 'application/json' } }),
    { ...fastOptions, attempts: 2 },
  );
  assert.equal(result, 'unready');
  assert.deepEqual(calls.promoted, [], 'an unhealthy runner must never be promoted');
});

test('reattach refuses a non-https or malformed runner URL', async () => {
  for (const badUrl of ['http://insecure.fly.dev', 'not a url', 'https://user:pw@runner.fly.dev']) {
    const { store, calls } = reattachStore({ async getResumedRunnerReattachTarget() { return badUrl; } });
    const result = await reattachResumedSeries4Runner(store, userId, async () => healthyResponse(), fastOptions);
    assert.equal(result, 'no_target', `must refuse ${badUrl}`);
    assert.deepEqual(calls.promoted, []);
  }
});

// --- The webhook fast path: a successful resume schedules the reattach via waitUntil ---

const webhookEnv = {
  STRIPE_WEBHOOK_SECRET: 'whsec_resume_reattach_test',
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
};

function activationEvent() {
  return {
    id: 'evt_resume_reattach_123',
    type: 'checkout.session.completed',
    created: 0,
    data: {
      object: {
        id: 'cs_resume_reattach_123',
        client_reference_id: userId,
        customer: 'cus_resume_reattach',
        subscription: {
          id: 'sub_resume_reattach',
          status: 'active',
          current_period_start: 0,
          current_period_end: 3600,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: 'price_worker_pro', lookup_key: 'sidekick_pro_office_monthly' } }] },
        },
        metadata: { priceLookupKey: 'sidekick_pro_office_monthly' },
      },
    },
  };
}

function webhookRequest(event) {
  return new Request('https://worker.sidekick.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'unit_signature_present' },
    body: JSON.stringify(event),
  });
}

function ledgerStoreBits() {
  return {
    async claimBillingEvent(input) {
      return {
        state: 'claimed',
        event: {
          id: 'ledger_resume_reattach',
          provider: input.provider,
          provider_event_id: input.provider_event_id,
          event_type: input.event_type,
          idempotency_key: input.idempotency_key,
          payload_hash: input.payload_hash,
          status: 'processing',
          user_id: input.user_id,
          error_code: null,
          processed_at: null,
          processing_started_at: new Date(0).toISOString(),
          processing_expires_at: new Date(5 * 60 * 1000).toISOString(),
        },
      };
    },
    async updateBillingEvent() {},
    async upsertSubscription() { return true; },
    async upsertUsageQuota() { return true; },
    async enqueueHermesProvisioning() {},
  };
}

test('webhook resume schedules the reattach through waitUntil and promotes in the background', async () => {
  const promoted = [];
  const store = {
    ...ledgerStoreBits(),
    async applyEntitlement() { return { outcome: 'applied', resumed: true }; },
    async getResumedRunnerReattachTarget(id) { return id === userId ? runnerBaseUrl : null; },
    async promoteResumedRunnerReady(id, url) { promoted.push({ id, url }); return true; },
  };
  const scheduled = [];
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const response = await handleStripeWebhookRequest(webhookRequest(activationEvent()), {
    env: webhookEnv,
    store,
    async verifyStripeWebhookEvent(rawBody) { return JSON.parse(rawBody); },
    waitUntil(promise) { scheduled.push(promise); },
    fetchImpl: async () => { await probeGate; return healthyResponse(); },
  });

  assert.equal(response.status, 200);
  assert.equal(scheduled.length, 1, 'the resume must schedule exactly one background reattach');
  assert.deepEqual(promoted, [], 'the reattach must run AFTER the webhook response, not during');
  releaseProbe();
  await Promise.all(scheduled);
  assert.deepEqual(promoted, [{ id: userId, url: runnerBaseUrl }]);
});

test('webhook does not schedule a reattach when the resume flipped nothing (fresh signup path)', async () => {
  let targetLookups = 0;
  const store = {
    ...ledgerStoreBits(),
    async applyEntitlement() { return { outcome: 'applied', resumed: false }; },
    async getResumedRunnerReattachTarget() { targetLookups += 1; return runnerBaseUrl; },
    async promoteResumedRunnerReady() { return true; },
  };
  const scheduled = [];
  const response = await handleStripeWebhookRequest(webhookRequest(activationEvent()), {
    env: webhookEnv,
    store,
    async verifyStripeWebhookEvent(rawBody) { return JSON.parse(rawBody); },
    waitUntil(promise) { scheduled.push(promise); },
    fetchImpl: async () => healthyResponse(),
  });
  assert.equal(response.status, 200);
  assert.equal(scheduled.length, 0);
  assert.equal(targetLookups, 0);
});

test('webhook without a waitUntil bridge still succeeds and never blocks on a reattach', async () => {
  let targetLookups = 0;
  const store = {
    ...ledgerStoreBits(),
    async applyEntitlement() { return { outcome: 'applied', resumed: true }; },
    async getResumedRunnerReattachTarget() { targetLookups += 1; return runnerBaseUrl; },
    async promoteResumedRunnerReady() { return true; },
  };
  const response = await handleStripeWebhookRequest(webhookRequest(activationEvent()), {
    env: webhookEnv,
    store,
    async verifyStripeWebhookEvent(rawBody) { return JSON.parse(rawBody); },
  });
  assert.equal(response.status, 200);
  assert.equal(targetLookups, 0, 'no waitUntil means no in-band reattach; the cron sweep covers it');
});

// --- The real Supabase store methods ---

function supabaseFake({ instanceStatus, binding, updateResult }) {
  const operations = [];
  const client = {
    from(table) {
      return {
        select(columns) {
          operations.push({ op: 'select', table, columns });
          return {
            eq(column, value) {
              operations.push({ op: 'select.eq', table, value: { column, value } });
              return {
                async maybeSingle() {
                  if (table === 'hermes_instances') return { data: instanceStatus ? { status: instanceStatus } : null, error: null };
                  if (table === 'hermes_instance_private') return { data: binding ?? null, error: null };
                  return { data: null, error: null };
                },
              };
            },
          };
        },
        update(value) {
          operations.push({ op: 'update', table, value: structuredClone(value) });
          return {
            eq(column, val) {
              operations.push({ op: 'update.eq', table, value: { column, value: val } });
              return {
                eq(column2, val2) {
                  operations.push({ op: 'update.eq', table, value: { column: column2, value: val2 } });
                  return {
                    select() {
                      return {
                        async maybeSingle() { return updateResult ?? { data: { user_id: userId }, error: null }; },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, operations };
}

test('getResumedRunnerReattachTarget returns the binding URL only for a provisioning row with a live binding', async () => {
  const { client } = supabaseFake({
    instanceStatus: 'provisioning',
    binding: { runner_base_url: ` ${runnerBaseUrl} `, deleted_at: null },
  });
  const store = createSupabaseStripeBillingStore(client);
  assert.equal(await store.getResumedRunnerReattachTarget(userId), runnerBaseUrl);
});

test('getResumedRunnerReattachTarget refuses non-provisioning rows and deleted bindings', async () => {
  for (const scenario of [
    { instanceStatus: 'ready', binding: { runner_base_url: runnerBaseUrl, deleted_at: null } },
    { instanceStatus: 'sleeping', binding: { runner_base_url: runnerBaseUrl, deleted_at: null } },
    { instanceStatus: 'provisioning', binding: { runner_base_url: runnerBaseUrl, deleted_at: '2026-07-01T00:00:00Z' } },
    { instanceStatus: 'provisioning', binding: null },
    { instanceStatus: null, binding: { runner_base_url: runnerBaseUrl, deleted_at: null } },
    { instanceStatus: 'provisioning', binding: { runner_base_url: '   ', deleted_at: null } },
  ]) {
    const { client } = supabaseFake(scenario);
    const store = createSupabaseStripeBillingStore(client);
    assert.equal(await store.getResumedRunnerReattachTarget(userId), null, JSON.stringify(scenario));
  }
});

test('promoteResumedRunnerReady writes the full ready shape guarded on status=provisioning', async () => {
  const { client, operations } = supabaseFake({ instanceStatus: 'provisioning' });
  const store = createSupabaseStripeBillingStore(client);
  assert.equal(await store.promoteResumedRunnerReady(userId, runnerBaseUrl), true);

  const update = operations.find((op) => op.op === 'update' && op.table === 'hermes_instances');
  assert.equal(update?.value.status, 'ready');
  assert.equal(update?.value.base_url, runnerBaseUrl);
  assert.equal(update?.value.public_status_message, 'Delegent AI is online.');
  assert.equal(update?.value.error, null);
  assert.equal(update?.value.error_code, null);
  assert.equal(update?.value.provisioning_claimed_at, null);
  assert.equal(update?.value.provisioning_lease_expires_at, null);
  assert.ok(update?.value.ready_at, 'ready_at must be stamped');
  assert.ok(update?.value.last_health_at, 'last_health_at must be stamped');

  const guards = operations.filter((op) => op.op === 'update.eq' && op.table === 'hermes_instances').map((op) => op.value);
  assert.deepEqual(guards, [
    { column: 'user_id', value: userId },
    { column: 'status', value: 'provisioning' },
  ]);
});

test('promoteResumedRunnerReady reports false when another path already moved the row on', async () => {
  const { client } = supabaseFake({ instanceStatus: 'provisioning', updateResult: { data: null, error: null } });
  const store = createSupabaseStripeBillingStore(client);
  assert.equal(await store.promoteResumedRunnerReady(userId, runnerBaseUrl), false);
});

// --- The cron sweep safety net ---

test('sweepStuckResumedRunners claims with a 5-minute age gate, wakes the runner and promotes the row', async () => {
  const env = { SUPABASE_URL: 'https://unit.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret' };
  const rpcBodies = [];
  const patches = [];
  let claimsServed = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/rest/v1/rpc/claim_next_series4_stuck_readiness')) {
      rpcBodies.push(JSON.parse(init.body));
      claimsServed += 1;
      const rows = claimsServed === 1
        ? [{ user_id: userId, provisioning_tier_id: 'pro-office', provisioning_idempotency_key: 'k', runner_base_url: runnerBaseUrl, claimed_at: new Date().toISOString() }]
        : [];
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.startsWith(runnerBaseUrl)) {
      assert.equal(target, `${runnerBaseUrl}/healthz`);
      return healthyResponse();
    }
    if (target.includes('/rest/v1/hermes_instances')) {
      patches.push({ url: target, body: JSON.parse(init.body) });
      return new Response(JSON.stringify([{ user_id: userId }]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    const summary = await sweepStuckResumedRunners(env);
    assert.deepEqual(summary, { claimed: 1, promoted: 1, unready: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(rpcBodies[0].p_min_age_seconds, 300, 'the sweep must use the 5-minute gate, not the 30-minute default');
  assert.ok(rpcBodies[0].p_at, 'the claim must pass an explicit p_at');
  assert.equal(patches.length, 1);
  assert.match(patches[0].url, /user_id=eq\./);
  assert.match(patches[0].url, /status=eq\.provisioning/, 'the promote must be guarded on status=provisioning');
  assert.equal(patches[0].body.status, 'ready');
  assert.equal(patches[0].body.base_url, runnerBaseUrl);
  assert.equal(patches[0].body.public_status_message, 'Delegent AI is online.');
});

test('sweepStuckResumedRunners leaves an unready runner claimed for the next tick and never throws', async () => {
  const env = { SUPABASE_URL: 'https://unit.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret' };
  let claimsServed = 0;
  let patched = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/rest/v1/rpc/claim_next_series4_stuck_readiness')) {
      claimsServed += 1;
      const rows = claimsServed === 1
        ? [{ user_id: userId, runner_base_url: runnerBaseUrl }]
        : [];
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.startsWith(runnerBaseUrl)) throw new Error('machine still cold');
    if (target.includes('/rest/v1/hermes_instances') && init.method === 'PATCH') { patched += 1; }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const summary = await sweepStuckResumedRunners(env, { attempts: 2, intervalMs: 0 });
    assert.deepEqual(summary, { claimed: 1, promoted: 0, unready: 1 });
    assert.equal(patched, 0, 'an unreachable runner must not be promoted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sweepStuckResumedRunners is a silent no-op without Supabase credentials', async () => {
  const summary = await sweepStuckResumedRunners({});
  assert.deepEqual(summary, { claimed: 0, promoted: 0, unready: 0 });
});
