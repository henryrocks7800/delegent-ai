import test from 'node:test';
import assert from 'node:assert/strict';
import { createStripeCheckoutSession } from '../dist/index.js';
import { SIDEKICK_FREE_TRIAL, SIDEKICK_PLAN_TIERS, freeTrialTermsLine } from '@sidekick/shared';

const input = {
  userId: 'trial_test_user', tierId: 'studio', hasPriorSubscription: false,
  successUrl: 'https://delegentai.co.uk/success', cancelUrl: 'https://delegentai.co.uk/cancel',
  now: () => 0,
};

function clientFor(tierId = 'studio', history = []) {
  const creates = [];
  const tier = SIDEKICK_PLAN_TIERS.find((tier) => tier.id === tierId);
  return {
    creates,
    prices: { list: async () => ({ data: [{ id: 'price_unchanged', lookup_key: tier.stripePriceLookupKey, active: true }] }) },
    subscriptions: { list: async () => ({ data: history }) },
    checkout: { sessions: { create: async (params, options) => {
      creates.push({ params, options });
      return { id: 'cs_trial', url: 'https://checkout.stripe.com/c/pay/cs_trial' };
    } } },
  };
}

test('three-day trial billing contract', async (t) => {
  const previous = SIDEKICK_FREE_TRIAL.enabled;
  SIDEKICK_FREE_TRIAL.enabled = true;
  try {
    await t.test('all tiers keep their recurring price and collect a payment method, without stacking a coupon', async () => {
      for (const tier of SIDEKICK_PLAN_TIERS) {
        const client = clientFor(tier.id);
        await createStripeCheckoutSession({ ...input, tierId: tier.id }, client);
        const { params, options } = client.creates[0];
        assert.deepEqual(params.line_items, [{ price: 'price_unchanged', quantity: 1 }]);
        assert.equal(params.subscription_data.trial_period_days, 3);
        assert.equal(params.subscription_data.trial_settings.end_behavior.missing_payment_method, 'cancel');
        assert.equal(params.payment_method_collection, 'always');
        assert.equal(params.discounts, undefined);
        assert.equal(params.allow_promotion_codes, undefined);
        assert.equal(params.metadata.introductoryOfferId, SIDEKICK_FREE_TRIAL.offerId);
        assert.equal(params.subscription_data.metadata.launchPromoCouponId, undefined);
        assert.equal(params.custom_text.submit.message, freeTrialTermsLine(tier));
        assert.match(options.idempotencyKey, /three_day_trial_2026_09/);
      }
    });
    await t.test('previous Apple or Stripe subscription cannot claim a new trial', async () => {
      for (const prior of [
        { input: { hasPriorSubscription: true }, history: [] },
        { input: { existingStripeCustomerId: 'cus_returning' }, history: [{ status: 'canceled' }] },
      ]) {
        const client = clientFor('studio', prior.history);
        await createStripeCheckoutSession({ ...input, ...prior.input }, client);
        const { params, options } = client.creates[0];
        assert.equal(params.subscription_data.trial_period_days, undefined);
        assert.equal(params.discounts, undefined);
        assert.equal(params.metadata.introductoryOfferId, undefined);
        assert.match(options.idempotencyKey, /:returning:/);
      }
    });
    await t.test('abandoned checkouts do not consume the trial', async () => {
      const client = clientFor('studio', [{ status: 'incomplete_expired' }]);
      await createStripeCheckoutSession({ ...input, existingStripeCustomerId: 'cus_new' }, client);
      assert.equal(client.creates[0].params.subscription_data.trial_period_days, 3);
    });
    await t.test('existing active, overdue or unfinished subscriptions cannot open a duplicate checkout', async () => {
      for (const status of ['active', 'trialing', 'past_due', 'incomplete']) {
        const client = clientFor('studio', [{ status }]);
        await assert.rejects(createStripeCheckoutSession({ ...input, hasPriorSubscription: true, existingStripeCustomerId: 'cus_existing' }, client));
        assert.equal(client.creates.length, 0);
      }
    });
    await t.test('unknown account history and failed Stripe history never open a full-price checkout', async () => {
      for (const kind of ['unknown_account', 'missing_reader', 'upstream_failure', 'malformed_response']) {
        const client = clientFor();
        const attempt = { ...input, existingStripeCustomerId: 'cus_new' };
        if (kind === 'unknown_account') delete attempt.hasPriorSubscription;
        if (kind === 'missing_reader') delete client.subscriptions;
        if (kind === 'upstream_failure') client.subscriptions.list = async () => { throw new Error('upstream'); };
        if (kind === 'malformed_response') client.subscriptions.list = async () => ({});
        await assert.rejects(createStripeCheckoutSession(attempt, client), /Trial eligibility unavailable/, kind);
        assert.equal(client.creates.length, 0, kind);
      }
    });
  } finally {
    SIDEKICK_FREE_TRIAL.enabled = previous;
  }
});

test('the assistant plan: its own price, a free month, and nothing else changes', async (t) => {
  const { AGENT_PLAN, agentFreeTrialTermsLine } = await import('@sidekick/shared');
  const { isTrialOfferSubscription, stripeEntitlementStatus } = await import('../dist/index.js');
  const previous = SIDEKICK_FREE_TRIAL.enabled;
  SIDEKICK_FREE_TRIAL.enabled = true;
  const assistantClient = (history = []) => {
    const client = clientFor('studio', history);
    const lookups = [];
    client.lookups = lookups;
    client.prices.list = async (params) => {
      lookups.push(params.lookup_keys);
      return { data: [{ id: 'price_assistant', lookup_key: AGENT_PLAN.stripePriceLookupKey, active: true }] };
    };
    return client;
  };
  try {
    await t.test('a new subscriber gets 30 days free on the £3.99 price, card taken up front', async () => {
      const client = assistantClient();
      await createStripeCheckoutSession({ ...input, plan: 'assistant' }, client);
      const { params, options } = client.creates[0];
      assert.deepEqual(client.lookups, [[AGENT_PLAN.stripePriceLookupKey]]);
      assert.deepEqual(params.line_items, [{ price: 'price_assistant', quantity: 1 }]);
      assert.equal(params.subscription_data.trial_period_days, 30);
      assert.equal(params.subscription_data.trial_settings.end_behavior.missing_payment_method, 'cancel');
      assert.equal(params.payment_method_collection, 'always');
      assert.equal(params.metadata.introductoryOfferId, AGENT_PLAN.freeTrialOfferId);
      assert.equal(params.metadata.plan, 'assistant');
      assert.equal(params.metadata.tierId, 'studio', 'recorded under its tier, as the purchase intent requires');
      assert.equal(params.metadata.priceLookupKey, AGENT_PLAN.stripePriceLookupKey);
      assert.deepEqual(params.subscription_data.metadata, params.metadata);
      assert.equal(params.custom_text.submit.message, agentFreeTrialTermsLine());
      assert.equal(params.discounts, undefined);
      assert.match(options.idempotencyKey, /free_month_2026_09:assistant/);
    });
    await t.test('someone who has subscribed before pays from day one', async () => {
      const client = assistantClient([{ status: 'canceled' }]);
      await createStripeCheckoutSession({ ...input, plan: 'assistant', existingStripeCustomerId: 'cus_returning' }, client);
      const { params } = client.creates[0];
      assert.equal(params.subscription_data.trial_period_days, undefined);
      assert.equal(params.metadata.introductoryOfferId, undefined);
      assert.equal(params.metadata.plan, 'assistant');
    });
    await t.test('the assistant plan is only ever its own tier', async () => {
      await assert.rejects(createStripeCheckoutSession({ ...input, tierId: 'pro-office', plan: 'assistant' }, assistantClient()), /Unknown billing plan tier/);
    });
    await t.test('without the plan flag a checkout is the workspace plan, exactly as before', async () => {
      const client = clientFor('studio');
      await createStripeCheckoutSession(input, client);
      const { params } = client.creates[0];
      assert.equal(params.subscription_data.trial_period_days, 3);
      assert.equal(params.metadata.plan, undefined);
      assert.equal(params.metadata.priceLookupKey, 'sidekick_studio_monthly');
    });
    await t.test('the free month is a trial offer to the webhook: the £0 invoice grants a trial, not a paid month', () => {
      const subscription = { metadata: { introductoryOfferId: AGENT_PLAN.freeTrialOfferId } };
      assert.equal(isTrialOfferSubscription(subscription), true);
      assert.equal(stripeEntitlementStatus('past_due', subscription), 'canceled', 'a failed first payment ends access, as for the 3-day trial');
      assert.equal(stripeEntitlementStatus('active', { ...subscription, latest_invoice: { status: 'paid', billing_reason: 'subscription_create', amount_paid: 0 } }), 'canceled');
      assert.equal(isTrialOfferSubscription({ metadata: { introductoryOfferId: 'something_else' } }), false);
    });
  } finally {
    SIDEKICK_FREE_TRIAL.enabled = previous;
  }
});
