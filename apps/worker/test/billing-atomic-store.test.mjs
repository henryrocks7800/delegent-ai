import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createSupabaseStripeBillingStore } from '../dist/stripe-flow.js';

const user = '11111111-1111-4111-8111-111111111111';
function fixture({ owners = [], ownerStatus = 200, seeded = [], seedStatus = 200,
  result = { outcome: 'applied', resumed: true }, rpcStatus = 200 } = {}) {
  const requests = [];
  const client = createClient('https://unit.supabase.test', 'fixture-service-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { async fetch(url, init) {
      const path = new URL(url).pathname;
      requests.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
      let body, status;
      if (path.endsWith('/billing_subscription_ownership')) { body = owners; status = ownerStatus; }
      else if (path.endsWith('/subscriptions')) { body = seeded; status = seedStatus; }
      else if (path.endsWith('/rpc/apply_billing_entitlement') || path.endsWith('/rpc/apply_stripe_payment_reversal')) { body = result; status = rpcStatus; }
      else throw new Error(`unexpected request ${path}`);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    } },
  });
  return { store: createSupabaseStripeBillingStore(client), requests };
}

test('real Supabase adapter sends one atomic entitlement RPC and validates its result', async () => {
  const f = fixture();
  const input = { subscription: { user_id: user, stripe_subscription_id: 'sub-fixture' },
    quota: { user_id: user, monthly_token_quota: 19_550_000 }, eventKey: 'stripe:evt-fixture',
    allowProviderSwitch: true, retentionSeconds: 60 * 86400 };
  assert.deepEqual(await f.store.applyEntitlement(input), { outcome: 'applied', resumed: true });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'POST');
  assert.deepEqual(f.requests[0].body, { p_provider: 'stripe', p_subscription: input.subscription,
    p_quota: input.quota, p_event_key: input.eventKey, p_allow_provider_switch: true,
    p_retention_seconds: 60 * 86400 });
  for (const options of [{ result: null }, { result: { outcome: 'applied' } },
    { result: { code: '40001', message: 'private fixture detail' }, rpcStatus: 409 }]) {
    await assert.rejects(fixture(options).store.applyEntitlement(input), /billing_entitlement/);
  }
});

test('Stripe customer lookup uses durable ownership after a provider switch', async () => {
  const f = fixture({ owners: [{ user_id: user }, { user_id: user }] });
  assert.equal(await f.store.findUserIdByStripeCustomer('cus-fixture'), user);
  assert.equal(f.requests.length, 1);
  const url = new URL(f.requests[0].url);
  assert.equal(url.searchParams.get('provider'), 'eq.stripe');
  assert.equal(url.searchParams.get('provider_customer_id'), 'eq.cus-fixture');
});

test('unknown, malformed and ambiguous Stripe ownership stays retryable', async () => {
  for (const options of [{ ownerStatus: 503 }, { owners: null }, { owners: [{}] },
    { owners: [{ user_id: user }, { user_id: 'another-user' }] }, { seedStatus: 503 }]) {
    await assert.rejects(fixture(options).store.findUserIdByStripeCustomer('cus-fixture'), /billing_owner/);
  }
});

test('a deleted owner never falls back to a new customer mapping, while a new checkout can', async () => {
  const deleted = fixture({ owners: [{ user_id: null }], seeded: [{ user_id: user }] });
  assert.equal(await deleted.store.findUserIdByStripeCustomer('cus-fixture'), null);
  assert.equal(deleted.requests.length, 1);
  const first = fixture({ seeded: [{ user_id: user }] });
  assert.equal(await first.store.findUserIdByStripeCustomer('cus-fixture'), user);
  assert.equal(first.requests.length, 2);
});

test('reversal target uses the exact historical subscription owner and the current row revision', async () => {
  const current = { billing_provider: 'stripe', stripe_subscription_id: 'sub-fixture', stripe_customer_id: 'cus-fixture',
    current_period_start: '2026-09-13T00:00:00Z', current_period_end: '2026-10-13T00:00:00Z',
    stripe_entitlement_invoice_id: 'in-fixture', billing_revision: 8 };
  const owner = { user_id: user, provider_customer_id: 'cus-fixture' };
  const f = fixture({ owners: [owner], seeded: [current] });
  assert.deepEqual(await f.store.getStripeReversalTarget('cus-fixture', 'sub-fixture'), {
    userId: user, revision: 8, periodStart: current.current_period_start, periodEnd: current.current_period_end, invoiceId: 'in-fixture',
  });
  assert.equal(new URL(f.requests[0].url).searchParams.get('provider_subscription_id'), 'eq.sub-fixture');
  const historical = fixture({ owners: [owner], seeded: [{ ...current, billing_provider: 'apple' }] });
  assert.equal(await historical.store.getStripeReversalTarget('cus-fixture', 'sub-fixture'), null);
  for (const options of [{ owners: [] }, { owners: [owner], seeded: [] },
    { owners: [owner], seeded: [{ ...current, billing_revision: undefined }] },
    { owners: [{ ...owner, provider_customer_id: 'cus-other' }], seeded: [current] }]) {
    await assert.rejects(fixture(options).store.getStripeReversalTarget('cus-fixture','sub-fixture'), /reversal_/);
  }
});

test('reversal RPC contains the invoice, billing revision and period, with no separate cancellation writes', async () => {
  const f = fixture({ result: 'applied' });
  assert.equal(await f.store.applyStripeReversal({ userId: user, customerId: 'cus-fixture', subscriptionId: 'sub-fixture',
    invoiceId: 'in-fixture', chargeId: 'ch-fixture', revision: 8, periodStart: '2026-09-13T00:00:00Z',
    periodEnd: '2026-10-13T00:00:00Z', eventKey: 'stripe:evt-reversal', eventAt: '2026-09-13T12:00:00Z',
    reason: 'refund', retentionSeconds: 5184000 }), 'applied');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.p_expected_revision, 8);
  assert.equal(f.requests[0].body.p_invoice_id, 'in-fixture');
  assert.equal(f.requests[0].body.p_subscription_id, 'sub-fixture');
  assert.equal(f.requests[0].body.p_period_end, '2026-10-13T00:00:00Z');
});
