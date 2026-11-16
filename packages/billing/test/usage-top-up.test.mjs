// Usage top-ups: a one-off Checkout payment that adds usage for an agent-engine
// account. The webhook must record exactly what Stripe says was paid, once, and
// must never let a top-up reach the subscription code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarMonths, isUsageTopUpSession, usageTopUpGrantFromSession } from '../dist/usageTopUp.js';
import { handleStripeWebhookRequest } from '../dist/serverFlow.js';

const userId = '22222222-2222-4222-8222-222222222222';

function topUpSession(overrides = {}) {
  return {
    id: 'cs_live_top_up_1',
    object: 'checkout.session',
    mode: 'payment',
    payment_status: 'paid',
    currency: 'gbp',
    amount_total: 300,
    customer: 'cus_top_up_1',
    payment_intent: 'pi_top_up_1',
    metadata: { kind: 'usage_top_up', topUpUserId: userId, pricePence: '100', tokensPerPack: '4000000', validMonths: '12' },
    ...overrides,
  };
}

test('a paid top-up grants whole packs at the price and size it was sold at, for 12 months', () => {
  const grant = usageTopUpGrantFromSession(topUpSession(), '2026-09-15T12:00:00.000Z');
  assert.deepEqual(grant, {
    userId,
    tokens: 12_000_000,
    amountPence: 300,
    checkoutSessionId: 'cs_live_top_up_1',
    paymentIntentId: 'pi_top_up_1',
    purchasedAt: '2026-09-15T12:00:00.000Z',
    expiresAt: '2027-09-15T12:00:00.000Z',
  });
  assert.equal(isUsageTopUpSession(topUpSession()), true);
});

test('nothing is granted for an unpaid, foreign-currency, part-pack or subscription session', () => {
  const at = '2026-09-15T12:00:00.000Z';
  assert.equal(usageTopUpGrantFromSession(topUpSession({ payment_status: 'unpaid' }), at), null);
  assert.equal(usageTopUpGrantFromSession(topUpSession({ currency: 'usd' }), at), null);
  assert.equal(usageTopUpGrantFromSession(topUpSession({ amount_total: 150 }), at), null);
  assert.equal(usageTopUpGrantFromSession(topUpSession({ mode: 'subscription' }), at), null);
  assert.equal(usageTopUpGrantFromSession(topUpSession({ metadata: { ...topUpSession().metadata, topUpUserId: 'not-a-user' } }), at), null);
  assert.equal(isUsageTopUpSession({ mode: 'subscription', metadata: { sidekickUserId: userId } }), false);
});

test('calendar months clamp to the end of a shorter month', () => {
  assert.equal(addCalendarMonths('2026-01-31T10:00:00.000Z', 1), '2026-02-28T10:00:00.000Z');
  assert.equal(addCalendarMonths('2028-02-29T00:00:00.000Z', 12), '2029-02-28T00:00:00.000Z');
});

function deps({ recordUsageTopUp, events = [] } = {}) {
  const updates = [];
  const entitlements = [];
  return {
    updates,
    entitlements,
    value: {
      env: { STRIPE_WEBHOOK_SECRET: 'whsec_unit', SUPABASE_URL: 'https://unit.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'service_role_unit' },
      verifyStripeWebhookEvent: (raw) => JSON.parse(raw),
      store: {
        async claimBillingEvent(input) {
          if (events.includes(input.provider_event_id)) return { state: 'duplicate_terminal' };
          events.push(input.provider_event_id);
          return { state: 'claimed', event: { id: `ledger_${input.provider_event_id}`, ...input, status: 'processing' } };
        },
        async updateBillingEvent(id, patch) { updates.push({ id, ...patch }); },
        async applyEntitlement(input) { entitlements.push(input); return { outcome: 'applied', resumed: false }; },
        async findUserIdByStripeCustomer() { throw new Error('a top-up must not look up a subscription owner'); },
      },
      ...(recordUsageTopUp ? { recordUsageTopUp } : {}),
    },
  };
}

function webhook(object, id = 'evt_top_up_1') {
  return new Request('https://unit.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'unit' },
    body: JSON.stringify({ id, type: 'checkout.session.completed', created: 1_789_473_600, data: { object } }),
  });
}

test('the webhook records a paid top-up once and never touches a subscription', async () => {
  const recorded = [];
  const events = [];
  const first = deps({ recordUsageTopUp: async (grant) => { recorded.push(grant); }, events });
  const response = await handleStripeWebhookRequest(webhook(topUpSession()), first.value);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true, note: 'usage_top_up' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].tokens, 12_000_000);
  assert.equal(recorded[0].purchasedAt, new Date(1_789_473_600 * 1000).toISOString());
  assert.equal(first.entitlements.length, 0, 'no subscription patch');
  assert.equal(first.updates.at(-1).status, 'processed');
  assert.equal(first.updates.at(-1).user_id, userId);

  const replay = deps({ recordUsageTopUp: async (grant) => { recorded.push(grant); }, events });
  const again = await handleStripeWebhookRequest(webhook(topUpSession()), replay.value);
  assert.equal(again.status, 200);
  assert.equal(recorded.length, 1, 'a redelivered event is not granted twice');
});

test('an unpaid top-up is ignored, and a missing store fails so Stripe retries', async () => {
  const unpaid = deps({ recordUsageTopUp: async () => { throw new Error('must not record'); } });
  const ignored = await handleStripeWebhookRequest(webhook(topUpSession({ payment_status: 'unpaid' }), 'evt_unpaid'), unpaid.value);
  assert.equal(ignored.status, 200);
  assert.equal(unpaid.updates.at(-1).error_code, 'usage_top_up_not_payable');

  const noStore = deps();
  const retry = await handleStripeWebhookRequest(webhook(topUpSession(), 'evt_no_store'), noStore.value);
  assert.equal(retry.status, 500, 'retryable, not silently dropped');
  assert.equal(noStore.entitlements.length, 0);
});
