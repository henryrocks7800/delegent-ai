// Stripe webhook IDEMPOTENCY — the replay-safety LOGIC, tested directly.
//
// The pre-existing R-SEC-17 invariant only scans live billing_events for
// duplicate provider_event_id rows (an observational check: it proves no
// dup data EXISTS, not that a replay is actually short-circuited). Stripe
// retries webhooks aggressively and a user can double-submit checkout, so
// the handler MUST process a repeated event exactly once. These tests drive
// that path against in-memory fakes — no production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { SIDEKICK_FREE_TRIAL } from '@sidekick/shared';

import {
  createSupabaseStripeBillingStore,
  handleStripeWebhookRequest,
} from '../dist/stripe-flow.js';

const userId = '22222222-2222-4222-8222-222222222222';
const webhookEnv = {
  STRIPE_WEBHOOK_SECRET: 'whsec_idempotency_test',
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
};
function signedReq(event) {
  return new Request('https://worker.sidekick.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'unit_signature_present' },
    body: JSON.stringify(event),
  });
}
function subscriptionCreatedEvent(overrides = {}) {
  return {
    id: 'evt_idem_sub_created_1',
    type: 'customer.subscription.created',
    created: 1_900_000_000,
    data: {
      object: {
        id: 'sub_idem_1',
        object: 'subscription',
        customer: 'cus_idem_1',
        status: 'active',
        metadata: { sidekickUserId: userId, tierId: 'studio' },
        items: {
          object: 'list',
          data: [
            {
              id: 'si_idem_1',
              price: { id: 'price_idem_studio', lookup_key: 'sidekick_studio_monthly', recurring: { interval: 'month' } },
              current_period_start: 1_900_000_000,
              current_period_end: 1_902_592_000,
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

test('trial webhook verifies signature before invoice reads and retries failed reads without consuming the event', async () => {
  const event = subscriptionCreatedEvent();
  event.data.object.metadata.introductoryOfferId = SIDEKICK_FREE_TRIAL.offerId;
  event.data.object.latest_invoice = 'in_trial_activation';
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookEnv.STRIPE_WEBHOOK_SECRET });
  const request = (signed = signature) => new Request('https://unit.test/api/stripe/webhook', {
    method: 'POST', headers: { 'stripe-signature': signed }, body: payload,
  });
  let reads = 0;
  let invoiceAvailable = false;
  const claims = [];
  const subscriptions = [];
  const deps = {
    env: webhookEnv,
    verifyStripeWebhookEvent: (raw, sig, secret) => Stripe.webhooks.constructEvent(raw, sig, secret),
    async retrieveStripeInvoice(id) {
      reads++;
      assert.equal(id, 'in_trial_activation');
      if (!invoiceAvailable) throw new Error('provider temporarily unavailable');
      return { id, status: 'paid', amount_paid: 999, billing_reason: 'subscription_cycle' };
    },
    store: {
      async claimBillingEvent(input) {
        claims.push(input);
        return { state: 'claimed', event: { id: 'billing_trial', ...input, status: 'processing' } };
      },
      async updateBillingEvent() {},
      async applyEntitlement(input) { subscriptions.push(input.subscription); return { outcome: 'applied', resumed: false }; },
      async upsertUsageQuota() { return true; },
      async enqueueHermesProvisioning() {},
    },
  };
  assert.equal((await handleStripeWebhookRequest(request('invalid'), deps)).status, 400);
  assert.equal(reads, 0);
  assert.equal((await handleStripeWebhookRequest(request(), deps)).status, 503);
  assert.equal(claims.length, 0, 'failed invoice read must leave the event available for a retry');
  assert.equal(subscriptions.length, 0);
  invoiceAvailable = true;
  assert.equal((await handleStripeWebhookRequest(request(), deps)).status, 200);
  assert.equal(subscriptions[0].status, 'active');
  assert.equal(claims[0].payload_hash, createHash('sha256').update(payload).digest('hex'), 'ledger hashes signed body, not hydrated provider data');
});

test('IDEMPOTENCY: a replayed terminal event is NOT re-applied (handler short-circuits before upsert)', async () => {
  const calls = { atomic: 0, upsertSubscription: 0, upsertUsageQuota: 0, enqueue: 0 };
  const store = {
    async claimBillingEvent(input) {
      // Simulate the store having already processed this provider_event_id.
      return {
        state: 'duplicate_terminal',
        event: {
          id: 'be_already_processed',
          provider: 'stripe',
          provider_event_id: input.provider_event_id,
          event_type: input.event_type,
          idempotency_key: input.idempotency_key,
          payload_hash: input.payload_hash,
          status: 'processed',
          user_id: input.user_id,
          error_code: null,
          processed_at: new Date(0).toISOString(),
          processing_started_at: null,
          processing_expires_at: null,
        },
      };
    },
    async updateBillingEvent() {},
    async applyEntitlement() { calls.atomic++; throw new Error('duplicate must not write'); },
    async upsertSubscription() { calls.upsertSubscription += 1; return true; },
    async upsertUsageQuota() { calls.upsertUsageQuota += 1; return true; },
    async enqueueHermesProvisioning() { calls.enqueue += 1; },
  };

  const res = await handleStripeWebhookRequest(signedReq(subscriptionCreatedEvent()), {
    env: webhookEnv,
    store,
    async verifyStripeWebhookEvent(rawBody) { return JSON.parse(rawBody); },
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.duplicate, true, 'response must flag the delivery as a duplicate');
  assert.equal(calls.upsertSubscription, 0, 'subscription must NOT be re-upserted on replay');
  assert.equal(calls.upsertUsageQuota, 0, 'usage quota must NOT be re-upserted on replay');
  assert.equal(calls.atomic, 0);
  assert.equal(calls.enqueue, 0, 'provisioning must NOT be re-enqueued on replay');
});

test('IDEMPOTENCY: store claim detects a unique-violation replay as duplicate_terminal', async () => {
  const existingRow = {
    id: 'be_existing',
    provider: 'stripe',
    provider_event_id: 'evt_idem_sub_created_1',
    event_type: 'customer.subscription.created',
    idempotency_key: 'stripe:evt_idem_sub_created_1',
    payload_hash: 'HASH_MATCH',
    status: 'processed',
    user_id: userId,
    error_code: null,
    processed_at: new Date(0).toISOString(),
    processing_started_at: null,
    processing_expires_at: null,
  };
  const store = createSupabaseStripeBillingStore({
    from(table) {
      assert.equal(table, 'billing_events');
      return {
        insert() {
          return { select() { return { async single() { return { error: { code: '23505' }, data: null }; } }; } };
        },
        select() {
          const chain = {
            eq() { return chain; },
            async maybeSingle() { return { error: null, data: existingRow }; },
          };
          return chain;
        },
      };
    },
  });

  const claim = await store.claimBillingEvent({
    provider: 'stripe',
    provider_event_id: 'evt_idem_sub_created_1',
    event_type: 'customer.subscription.created',
    idempotency_key: 'stripe:evt_idem_sub_created_1',
    payload_hash: 'HASH_MATCH',
    user_id: userId,
  });

  assert.equal(claim.state, 'duplicate_terminal', 'a replay of an already-processed event must be duplicate_terminal');
});

test('IDEMPOTENCY: store claim flags a same-id DIFFERENT-payload replay as payload_mismatch', async () => {
  const existingRow = {
    id: 'be_existing',
    provider: 'stripe',
    provider_event_id: 'evt_idem_sub_created_1',
    event_type: 'customer.subscription.created',
    idempotency_key: 'stripe:evt_idem_sub_created_1',
    payload_hash: 'HASH_ORIGINAL',
    status: 'processed',
    user_id: userId,
    error_code: null,
    processed_at: new Date(0).toISOString(),
    processing_started_at: null,
    processing_expires_at: null,
  };
  const store = createSupabaseStripeBillingStore({
    from() {
      return {
        insert() {
          return { select() { return { async single() { return { error: { code: '23505' }, data: null }; } }; } };
        },
        select() {
          const chain = { eq() { return chain; }, async maybeSingle() { return { error: null, data: existingRow }; } };
          return chain;
        },
      };
    },
  });

  const claim = await store.claimBillingEvent({
    provider: 'stripe',
    provider_event_id: 'evt_idem_sub_created_1',
    event_type: 'customer.subscription.created',
    idempotency_key: 'stripe:evt_idem_sub_created_1',
    payload_hash: 'HASH_DIFFERENT',
    user_id: userId,
  });

  assert.equal(claim.state, 'payload_mismatch', 'a same-id event with a mutated body must be payload_mismatch, not silently re-applied');
});

test('signed purchase intent reaches the atomic fence and a paid conflict stays retryable in the ledger', async () => {
  const event = subscriptionCreatedEvent();
  const intent = '33333333-3333-4333-8333-333333333333';
  event.data.object.metadata.purchaseIntentId = intent;
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookEnv.STRIPE_WEBHOOK_SECRET });
  const patches = [], ledger = [];
  const response = await handleStripeWebhookRequest(new Request('https://unit.test/api/stripe/webhook', {
    method: 'POST', headers: { 'stripe-signature': signature }, body: payload,
  }), {
    env: webhookEnv,
    verifyStripeWebhookEvent: (raw, sig, secret) => Stripe.webhooks.constructEvent(raw, sig, secret),
    store: {
      async claimBillingEvent(input) { return { state: 'claimed', event: { id: 'billing_purchase', ...input } }; },
      async applyEntitlement(input) { patches.push(input); return { outcome: 'purchase_conflict', resumed: false }; },
      async updateBillingEvent(id, patch) { ledger.push(patch); },
    },
  });
  assert.equal(response.status, 500);
  assert.equal(patches[0].subscription.purchase_intent_id, intent);
  assert.equal(ledger.length,1);
  assert.equal(ledger[0].status,'failed');
  assert.match(ledger[0].error_code,/purchase_conflict/);
});
