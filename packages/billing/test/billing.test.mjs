import { portalConfiguration } from '../../../tests/fixtures/portal-configuration.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStripeBillingPortalSession,
  createStripeCheckoutSession,
  resolveStripeIdempotencyBucket,
  resolveVerifiedStripeWebhookEvent,
  scheduleSubscriptionDowngradeAtPeriodEnd,
  releaseScheduledDowngrade,
} from '../dist/index.js';
import { SIDEKICK_FREE_TRIAL, SIDEKICK_LAUNCH_PROMO, launchPromoCouponIdForTier } from '@sidekick/shared';

// This file pins the launch-promo checkout shape, which the shipped
// configuration replaced with the three-day trial on 2026-09-11. The promo
// path still exists behind the flag, so hold the flag off here; the trial
// path is covered by free-trial.test.mjs, which turns it on for itself.
SIDEKICK_FREE_TRIAL.enabled = false;

const checkoutInput = {
  userId: 'user_123',
  tierId: 'pro-office',
  customerEmail: 'alex@example.com',
  successUrl: 'https://app.sidekick.example/billing/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://app.sidekick.example/billing/cancel',
  // Deterministic server time keeps the idempotency key stable for assertions.
  now: () => 0,
};

test('one launch coupon serves every tier, so a discount carries across a tier change exactly', () => {
  // 2026-09-08: the per-tier amount-off coupons were retired because a fixed
  // amount is the wrong amount once the customer changes tier inside the promo
  // window. One percent coupon (70.03%, proven live to charge 2.99 / 7.49 /
  // 17.98) applies to every tier and to whatever tier the customer moves to.
  assert.equal(SIDEKICK_LAUNCH_PROMO.stripeCouponIdByTier, undefined);
  for (const tierId of ['studio', 'pro-office', 'enterprise-suite']) {
    assert.equal(launchPromoCouponIdForTier(tierId), SIDEKICK_LAUNCH_PROMO.stripeCouponId, tierId);
  }
  // The override map still works if a future promo needs it.
  const promo = { ...SIDEKICK_LAUNCH_PROMO, stripeCouponId: 'fallback', stripeCouponIdByTier: { studio: 'studio_coupon' } };
  assert.equal(launchPromoCouponIdForTier('studio', promo), 'studio_coupon');
  assert.equal(launchPromoCouponIdForTier('pro-office', promo), 'fallback');
});

test('billing portal session uses an existing Stripe customer and safe return URL without exposing secrets', async () => {
  const calls = { portalCreate: [] };
  const client = {
    prices: { async list() { throw new Error('prices.list should not be called'); } },
    checkout: { sessions: { async create() { throw new Error('checkout.sessions.create should not be called'); } } },
    billingPortal: {
      configurations: { async retrieve(id) { return portalConfiguration(id, id === 'bpc_Generic' ? undefined : id === 'bpc_Pro' ? 'price_pro_office_should_not_echo' : 'price_target'); } },
      sessions: {
        async create(params) {
          calls.portalCreate.push(params);
          return {
            id: 'bps_test_portal_123',
            url: 'https://billing.stripe.com/p/session/bps_test_portal_123',
          };
        },
      },
    },
  };

  const result = await createStripeBillingPortalSession({
    configurationId: 'bpc_Generic', livemode: false, currentTierId: 'studio',
    customerId: 'cus_private_should_not_echo',
    returnUrl: 'https://app.sidekick.example/account/billing',
  }, client);

  assert.deepEqual(calls.portalCreate, [{
    configuration: 'bpc_Generic',
    customer: 'cus_private_should_not_echo',
    return_url: 'https://app.sidekick.example/account/billing',
  }]);
  assert.deepEqual(result, {
    provider: 'stripe',
    mode: 'billing_portal',
    sessionId: 'bps_test_portal_123',
    url: 'https://billing.stripe.com/p/session/bps_test_portal_123',
  });
  assert.doesNotMatch(JSON.stringify(result), /cus_private_should_not_echo|sk_test|whsec|service_role/i);
});

test('billing portal session can deep-link an existing subscription to a target tier change', async () => {
  const calls = { priceList: [], subscriptionRetrieve: [], portalCreate: [] };
  const client = {
    prices: {
      async list(params) {
        calls.priceList.push(params);
        return {
          data: [
            {
              id: 'price_pro_office_should_not_echo',
              lookup_key: 'sidekick_pro_office_monthly',
              active: true,
            },
          ],
        };
      },
    },
    checkout: { sessions: { async create() { throw new Error('checkout.sessions.create should not be called'); } } },
    billingPortal: {
      configurations: { async retrieve(id) { return portalConfiguration(id, id === 'bpc_Generic' ? undefined : id === 'bpc_Pro' ? 'price_pro_office_should_not_echo' : 'price_target'); } },
      sessions: {
        async create(params) {
          calls.portalCreate.push(params);
          return {
            id: 'bps_test_upgrade_123',
            url: 'https://billing.stripe.com/p/session/bps_test_upgrade_123',
          };
        },
      },
    },
    subscriptions: {
      async retrieve(id, params) {
        calls.subscriptionRetrieve.push({ id, params });
        return {
          id, status: 'active', customer: 'cus_existing_should_not_echo',
          items: {
            data: [
              {
                id: 'si_current_studio',
                price: { id: 'price_current_studio' },
                quantity: 1,
              },
            ],
          },
        };
      },
    },
  };

  const result = await createStripeBillingPortalSession({
    configurationId: 'bpc_Pro', livemode: false, currentTierId: 'studio',
    customerId: 'cus_existing_should_not_echo',
    returnUrl: 'https://app.sidekick.example/account/billing',
    targetTierId: 'pro-office',
    currentSubscriptionId: 'sub_existing_should_not_echo',
    currentPriceId: 'price_current_studio',
  }, client);

  assert.deepEqual(calls.priceList, [{
    lookup_keys: ['sidekick_pro_office_monthly'],
    active: true,
    limit: 1,
  }]);
  assert.deepEqual(calls.subscriptionRetrieve, [{
    id: 'sub_existing_should_not_echo',
    params: { expand: ['items.data.price'] },
  }]);
  assert.deepEqual(calls.portalCreate, [{
    configuration: 'bpc_Pro',
    customer: 'cus_existing_should_not_echo',
    return_url: 'https://app.sidekick.example/account/billing',
    flow_data: {
      type: 'subscription_update_confirm',
      after_completion: {
        type: 'redirect',
        redirect: { return_url: 'https://app.sidekick.example/account/billing' },
      },
      subscription_update_confirm: {
        subscription: 'sub_existing_should_not_echo',
        items: [{
          id: 'si_current_studio',
          price: 'price_pro_office_should_not_echo',
          quantity: 1,
        }],
        // No discounts: the promo is for new customers only, and a tier change
        // belongs to a current subscriber. An earned promo window survives the
        // change on its own because the discount lives on the subscription.
      },
    },
  }]);
  assert.equal(result.url, 'https://billing.stripe.com/p/session/bps_test_upgrade_123');
  assert.doesNotMatch(JSON.stringify(result), /cus_existing_should_not_echo|sub_existing_should_not_echo|price_pro_office_should_not_echo/i);
});

test('billing portal tier change drops the launch coupon once the promo is off', async () => {
  const originalCouponId = SIDEKICK_LAUNCH_PROMO.stripeCouponId;
  SIDEKICK_LAUNCH_PROMO.stripeCouponId = '';
  try {
    const calls = { portalCreate: [] };
    const client = {
      prices: {
        async list() {
          return { data: [{ id: 'price_target', lookup_key: 'sidekick_pro_office_monthly', active: true }] };
        },
      },
      checkout: { sessions: { async create() { throw new Error('checkout.sessions.create should not be called'); } } },
      billingPortal: {
      configurations: { async retrieve(id) { return portalConfiguration(id, id === 'bpc_Generic' ? undefined : id === 'bpc_Pro' ? 'price_pro_office_should_not_echo' : 'price_target'); } },
        sessions: {
          async create(params) {
            calls.portalCreate.push(params);
            return { id: 'bps_no_promo', url: 'https://billing.stripe.com/p/session/bps_no_promo' };
          },
        },
      },
      subscriptions: {
        async retrieve(id) {
          return { id, status: 'active', customer: 'cus_no_promo', items: { data: [{ id: 'si_current', price: { id: 'price_current' }, quantity: 1 }] } };
        },
      },
    };

    await createStripeBillingPortalSession({
    configurationId: 'bpc_Target', livemode: false, currentTierId: 'studio',
      customerId: 'cus_no_promo',
      returnUrl: 'https://app.sidekick.example/account/billing',
      targetTierId: 'pro-office',
      currentSubscriptionId: 'sub_no_promo',
      currentPriceId: 'price_current',
    }, client);

    assert.equal(calls.portalCreate.length, 1);
    assert.equal(calls.portalCreate[0].flow_data.subscription_update_confirm.discounts, undefined);
  } finally {
    SIDEKICK_LAUNCH_PROMO.stripeCouponId = originalCouponId;
  }
});

test('billing portal refuses missing customers and unsafe return URLs before contacting Stripe', async () => {
  const unusedClient = {
    prices: { async list() { throw new Error('prices.list should not be called'); } },
    checkout: { sessions: { async create() { throw new Error('checkout.sessions.create should not be called'); } } },
    billingPortal: { sessions: { async create() { throw new Error('billingPortal.sessions.create should not be called'); } } },
  };

  await assert.rejects(
    () => createStripeBillingPortalSession({ customerId: '   ', returnUrl: 'https://app.sidekick.example/account/billing' }, unusedClient),
    /Stripe customer required/,
  );
  await assert.rejects(
    () => createStripeBillingPortalSession({ customerId: 'cus_123', returnUrl: 'http://app.sidekick.example/account/billing' }, unusedClient),
    /HTTPS/,
  );
  await assert.rejects(
    () => createStripeBillingPortalSession({ customerId: 'cus_123', returnUrl: 'https://user:pass@app.sidekick.example/account/billing' }, unusedClient),
    /credentials/,
  );
});

test('checkout idempotency bucket is server-controlled, not caller-token controlled', () => {
  assert.equal(resolveStripeIdempotencyBucket({ now: () => 0 }), 't0');
  assert.equal(resolveStripeIdempotencyBucket({ attemptToken: 'attacker_token', now: () => 0 }), 't0');
});

test('checkout session uses lookup key, safe metadata, and idempotency without leaking provider secrets', async () => {
  // This test pins the BASE checkout shape (promo OFF): the manual promotion-code
  // box is open and no coupon is auto-applied. Force the promo off regardless of
  // the shipped coupon id so it stays deterministic once the launch promo goes
  // live; the promo-on branch is covered by the sibling test below.
  const originalCouponId = SIDEKICK_LAUNCH_PROMO.stripeCouponId;
  SIDEKICK_LAUNCH_PROMO.stripeCouponId = '';
  const calls = { priceList: [], sessionCreate: [] };
  const client = {
    prices: {
      async list(params) {
        calls.priceList.push(params);
        return {
          data: [
            {
              id: 'price_secret_should_not_be_returned',
              lookup_key: 'sidekick_pro_office_monthly',
              active: true,
            },
          ],
        };
      },
    },
    checkout: {
      sessions: {
        async create(params, options) {
          calls.sessionCreate.push({ params, options });
          return {
            id: 'cs_test_checkout_123',
            url: 'https://checkout.stripe.test/c/pay/cs_test_checkout_123',
          };
        },
      },
    },
  };

  const result = await createStripeCheckoutSession(checkoutInput, client);

  assert.deepEqual(calls.priceList, [
    {
      lookup_keys: ['sidekick_pro_office_monthly'],
      active: true,
      limit: 1,
    },
  ]);

  assert.equal(calls.sessionCreate.length, 1);
  const { params, options } = calls.sessionCreate[0];
  assert.deepEqual(options, {
    idempotencyKey: 'sidekick-checkout:user_123:pro-office:t0',
  });
  assert.equal(params.mode, 'subscription');
  assert.deepEqual(params.line_items, [
    {
      price: 'price_secret_should_not_be_returned',
      quantity: 1,
    },
  ]);
  assert.equal(params.success_url, checkoutInput.successUrl);
  assert.equal(params.cancel_url, checkoutInput.cancelUrl);
  assert.equal(params.client_reference_id, 'user_123');
  assert.equal(params.customer_email, 'alex@example.com');
  assert.deepEqual(params.payment_method_types, ['card', 'link']);
  assert.equal(params.allow_promotion_codes, true);
  assert.equal(params.billing_address_collection, 'auto');
  assert.deepEqual(params.metadata, {
    sidekickUserId: 'user_123',
    tierId: 'pro-office',
    priceLookupKey: 'sidekick_pro_office_monthly',
  });
  assert.deepEqual(params.subscription_data, {
    metadata: {
      sidekickUserId: 'user_123',
      tierId: 'pro-office',
      priceLookupKey: 'sidekick_pro_office_monthly',
    },
  });

  assert.deepEqual(result, {
    provider: 'stripe',
    mode: 'checkout',
    sessionId: 'cs_test_checkout_123',
    url: 'https://checkout.stripe.test/c/pay/cs_test_checkout_123',
    tierId: 'pro-office',
    priceLookupKey: 'sidekick_pro_office_monthly',
    idempotencyKey: 'sidekick-checkout:user_123:pro-office:t0',
  });
  assert.doesNotMatch(JSON.stringify(result), /price_secret_should_not_be_returned|alex@example\.com|sk_test_fake_secret|whsec_/i);
  SIDEKICK_LAUNCH_PROMO.stripeCouponId = originalCouponId;
});

test('when the launch promo is live, checkout auto-applies the coupon and drops allow_promotion_codes', async () => {
  // Stripe rejects allow_promotion_codes and discounts together. When the promo
  // is live we auto-apply the coupon; when it is off we keep the manual code box.
  // Mutate the shared promo config to the "live" state, then restore it so the
  // default (promo-off) assertions in the sibling test stay valid.
  const originalCouponId = SIDEKICK_LAUNCH_PROMO.stripeCouponId;
  SIDEKICK_LAUNCH_PROMO.stripeCouponId = 'promo_test_half_price_2mo';
  try {
    const calls = { sessionCreate: [] };
    const client = {
      prices: {
        async list() {
          return { data: [{ id: 'price_x', lookup_key: 'sidekick_pro_office_monthly', active: true }] };
        },
      },
      checkout: {
        sessions: {
          async create(params, options) {
            calls.sessionCreate.push({ params, options });
            return { id: 'cs_test_promo', url: 'https://checkout.stripe.test/c/pay/cs_test_promo' };
          },
        },
      },
    };

    await createStripeCheckoutSession(checkoutInput, client);

    assert.equal(calls.sessionCreate.length, 1);
    const { params } = calls.sessionCreate[0];
    assert.deepEqual(params.discounts, [{ coupon: 'promo_test_half_price_2mo' }]);
    assert.equal(params.allow_promotion_codes, undefined);
    // The payment page must name the price the discount reverts to and when,
    // so the user is never surprised by the month-3 charge.
    const submitMessage = params.custom_text?.submit?.message ?? '';
    assert.match(submitMessage, /£24.99/);
    assert.match(submitMessage, /month 3/);
    // The stamp is what stops the same customer redeeming the promo twice.
    assert.equal(params.subscription_data.metadata.launchPromoCouponId, 'promo_test_half_price_2mo');
  } finally {
    SIDEKICK_LAUNCH_PROMO.stripeCouponId = originalCouponId;
  }
});

test('a tier change never applies the launch coupon afresh, whatever the promo history', async () => {
  // The promo is for NEW customers only, and a tier change belongs to a current
  // subscriber, so the coupon must never be set here: the plan card quotes this
  // reader the standard price (shouldQuotePromoPrice), and setting `discounts`
  // would also restart an already-earned window from today. A subscriber still
  // inside their window keeps it across the change without any help, because
  // the discount lives on the subscription.
  const originalCouponId = SIDEKICK_LAUNCH_PROMO.stripeCouponId;
  SIDEKICK_LAUNCH_PROMO.stripeCouponId = 'promo_test_half_price_2mo';
  try {
    const cases = [
      { label: 'no promo history at all', subscription: {} },
      { label: 'metadata stamp', subscription: { metadata: { launchPromoCouponId: 'promo_test_half_price_2mo' } } },
      { label: 'live discount', subscription: { discounts: [{ coupon: { id: 'promo_test_half_price_2mo' } }] } },
      { label: 'legacy single discount', subscription: { discount: { coupon: 'promo_test_half_price_2mo' } } },
    ];

    for (const testCase of cases) {
      const calls = { portalCreate: [] };
      const client = {
        prices: {
          async list() {
            return { data: [{ id: 'price_target', lookup_key: 'sidekick_pro_office_monthly', active: true }] };
          },
        },
        checkout: { sessions: { async create() { throw new Error('checkout.sessions.create should not be called'); } } },
        billingPortal: {
          configurations: { async retrieve(id) { return portalConfiguration(id, 'price_target'); } },
          sessions: {
            async create(params) {
              calls.portalCreate.push(params);
              return { id: 'bps_redeemed', url: 'https://billing.stripe.com/p/session/bps_redeemed' };
            },
          },
        },
        subscriptions: {
          async retrieve(id) {
            return {
              id, status: 'active', customer: 'cus_redeemed',
              items: { data: [{ id: 'si_current', price: { id: 'price_current' }, quantity: 1 }] },
              ...testCase.subscription,
            };
          },
        },
      };

      await createStripeBillingPortalSession({
        configurationId: 'bpc_Target', livemode: false, currentTierId: 'studio',
        customerId: 'cus_redeemed',
        returnUrl: 'https://app.sidekick.example/account/billing',
        targetTierId: 'pro-office',
        currentSubscriptionId: 'sub_redeemed',
        currentPriceId: 'price_current',
      }, client);

      assert.equal(calls.portalCreate.length, 1, testCase.label);
      assert.equal(
        calls.portalCreate[0].flow_data.subscription_update_confirm.discounts,
        undefined,
        `${testCase.label}: the coupon must not be re-applied`,
      );
    }
  } finally {
    SIDEKICK_LAUNCH_PROMO.stripeCouponId = originalCouponId;
  }
});

test('a returning customer never gets the launch promo at checkout, even without a promo redemption', async () => {
  // The 2026-07-30 live defect: a customer whose ONLY subscription predated the
  // promo (so it carries no stamp and no discount) resubscribed. The plan page
  // honestly quoted the standard price, but the old "has redeemed before" gate
  // passed him and Stripe charged the promo price against a full-price quote.
  // ANY real subscription in the customer's history must refuse the coupon.
  const originalCouponId = SIDEKICK_LAUNCH_PROMO.stripeCouponId;
  SIDEKICK_LAUNCH_PROMO.stripeCouponId = 'promo_test_half_price_2mo';
  try {
    const histories = [
      { label: 'pre-promo cancelled subscription', data: [{ id: 'sub_old', status: 'canceled' }] },
      { label: 'promo-stamped cancelled subscription', data: [{ id: 'sub_old', status: 'canceled', metadata: { launchPromoCouponId: 'promo_test_half_price_2mo' } }] },
      { label: 'live subscription', data: [{ id: 'sub_live', status: 'active' }] },
    ];

    for (const history of histories) {
      const calls = { sessionCreate: [], subscriptionList: [] };
      const client = {
        prices: {
          async list() {
            return { data: [{ id: 'price_x', lookup_key: 'sidekick_pro_office_monthly', active: true }] };
          },
        },
        checkout: {
          sessions: {
            async create(params) {
              calls.sessionCreate.push(params);
              return { id: 'cs_test_resub', url: 'https://checkout.stripe.test/c/pay/cs_test_resub' };
            },
          },
        },
        subscriptions: {
          async retrieve() { throw new Error('subscriptions.retrieve should not be called'); },
          async list(params) {
            calls.subscriptionList.push(params);
            return { data: history.data };
          },
        },
      };

      await createStripeCheckoutSession(
        { ...checkoutInput, existingStripeCustomerId: 'cus_returning' },
        client,
      );

      assert.deepEqual(calls.subscriptionList, [{
        customer: 'cus_returning',
        status: 'all',
        limit: 100,
      }], history.label);
      assert.equal(calls.sessionCreate.length, 1, history.label);
      assert.equal(calls.sessionCreate[0].discounts, undefined, `${history.label}: no auto-applied coupon`);
      assert.equal(calls.sessionCreate[0].custom_text, undefined, history.label);
      assert.equal(calls.sessionCreate[0].subscription_data.metadata.launchPromoCouponId, undefined, history.label);
      // They can still type a code by hand, which is the promo-off shape.
      assert.equal(calls.sessionCreate[0].allow_promotion_codes, true, history.label);
    }
  } finally {
    SIDEKICK_LAUNCH_PROMO.stripeCouponId = originalCouponId;
  }
});

test('a checkout attempt that never completed does not cost a new customer the promo', async () => {
  // 'incomplete' / 'incomplete_expired' are abandoned or failed checkout
  // attempts: Stripe has never billed this reader, the plan page still quotes
  // them the promo price, and a retry must still be charged it.
  const originalCouponId = SIDEKICK_LAUNCH_PROMO.stripeCouponId;
  SIDEKICK_LAUNCH_PROMO.stripeCouponId = 'promo_test_half_price_2mo';
  try {
    const calls = { sessionCreate: [] };
    const client = {
      prices: {
        async list() {
          return { data: [{ id: 'price_x', lookup_key: 'sidekick_pro_office_monthly', active: true }] };
        },
      },
      checkout: {
        sessions: {
          async create(params) {
            calls.sessionCreate.push(params);
            return { id: 'cs_test_retry', url: 'https://checkout.stripe.test/c/pay/cs_test_retry' };
          },
        },
      },
      subscriptions: {
        async retrieve() { throw new Error('subscriptions.retrieve should not be called'); },
        async list() {
          return {
            data: [
              { id: 'sub_abandoned', status: 'incomplete' },
              { id: 'sub_expired', status: 'incomplete_expired' },
            ],
          };
        },
      },
    };

    await createStripeCheckoutSession(
      { ...checkoutInput, existingStripeCustomerId: 'cus_retrying' },
      client,
    );

    assert.equal(calls.sessionCreate.length, 1);
    assert.deepEqual(calls.sessionCreate[0].discounts, [{ coupon: 'promo_test_half_price_2mo' }]);
    assert.equal(calls.sessionCreate[0].subscription_data.metadata.launchPromoCouponId, 'promo_test_half_price_2mo');
  } finally {
    SIDEKICK_LAUNCH_PROMO.stripeCouponId = originalCouponId;
  }
});

test('a Stripe lookup failure does not block checkout, it just applies the promo', async () => {
  const originalCouponId = SIDEKICK_LAUNCH_PROMO.stripeCouponId;
  SIDEKICK_LAUNCH_PROMO.stripeCouponId = 'promo_test_half_price_2mo';
  try {
    const calls = { sessionCreate: [] };
    const client = {
      prices: {
        async list() {
          return { data: [{ id: 'price_x', lookup_key: 'sidekick_pro_office_monthly', active: true }] };
        },
      },
      checkout: {
        sessions: {
          async create(params) {
            calls.sessionCreate.push(params);
            return { id: 'cs_test_open', url: 'https://checkout.stripe.test/c/pay/cs_test_open' };
          },
        },
      },
      subscriptions: {
        async retrieve() { throw new Error('subscriptions.retrieve should not be called'); },
        async list() { throw new Error('stripe is down'); },
      },
    };

    await createStripeCheckoutSession(
      { ...checkoutInput, existingStripeCustomerId: 'cus_returning' },
      client,
    );

    assert.equal(calls.sessionCreate.length, 1);
    assert.deepEqual(calls.sessionCreate[0].discounts, [{ coupon: 'promo_test_half_price_2mo' }]);
  } finally {
    SIDEKICK_LAUNCH_PROMO.stripeCouponId = originalCouponId;
  }
});

test('checkout refuses invalid redirect URLs, empty users, and missing or unknown prices safely', async () => {
  const unusedClient = {
    prices: { async list() { throw new Error('prices.list should not be called'); } },
    checkout: { sessions: { async create() { throw new Error('sessions.create should not be called'); } } },
  };

  await assert.rejects(
    () => createStripeCheckoutSession({ ...checkoutInput, successUrl: 'http://app.sidekick.example/success' }, unusedClient),
    /HTTPS/,
  );
  await assert.rejects(
    () => createStripeCheckoutSession({ ...checkoutInput, cancelUrl: 'https://user:pass@app.sidekick.example/cancel' }, unusedClient),
    /credentials/,
  );
  await assert.rejects(
    () => createStripeCheckoutSession({ ...checkoutInput, userId: '   ' }, unusedClient),
    /userId required/,
  );

  const noPriceClient = {
    prices: {
      async list() {
        return {
          data: [
            { id: 'price_inactive_secret', lookup_key: 'sidekick_studio_monthly', active: false },
            { id: '', lookup_key: 'sidekick_studio_monthly', active: true },
          ],
        };
      },
    },
    checkout: { sessions: { async create() { throw new Error('sessions.create should not be called'); } } },
  };

  await assert.rejects(
    () => createStripeCheckoutSession({ ...checkoutInput, tierId: 'studio' }, noPriceClient),
    (error) => {
      assert.match(error.message, /^Stripe price lookup failed/);
      assert.doesNotMatch(error.message, /sidekick_studio_monthly|price_inactive_secret|sk_test_fake_secret/i);
      return true;
    },
  );
});

test('verified checkout.session.completed resolves to a subscription patch from metadata with the selected tier quota', () => {
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_checkout_completed_123',
    type: 'checkout.session.completed',
    created: 0,
    data: {
      object: {
        id: 'cs_test_123',
        client_reference_id: 'user_checkout_ref',
        customer: 'cus_test_checkout',
        subscription: {
          id: 'sub_test_checkout',
          status: 'active',
          cancel_at_period_end: false,
          items: {
            data: [
              {
                current_period_start: 0,
                current_period_end: 3600,
                price: {
                  id: 'price_test_checkout',
                  lookup_key: 'sidekick_pro_office_monthly',
                },
              },
            ],
          },
        },
        metadata: {
          sidekickUserId: 'user_metadata_should_not_win',
          tierId: 'pro-office',
          priceLookupKey: 'sidekick_pro_office_monthly',
          secretNote: 'sk_test_fake_secret',
        },
      },
    },
  });

  assert.equal(result.kind, 'subscription_patch');
  assert.equal(result.provider, 'stripe');
  assert.equal(result.eventId, 'evt_checkout_completed_123');
  assert.equal(result.idempotencyKey, 'stripe:evt_checkout_completed_123');
  assert.equal(result.subscription.userId, 'user_checkout_ref');
  assert.equal(result.subscription.tierId, 'pro-office');
  assert.equal(result.subscription.status, 'active');
  assert.equal(result.subscription.stripeCustomerId, 'cus_test_checkout');
  assert.equal(result.subscription.stripeSubscriptionId, 'sub_test_checkout');
  assert.equal(result.subscription.priceId, 'price_test_checkout');
  assert.equal(result.subscription.currentPeriodStart, new Date(0).toISOString());
  assert.equal(result.subscription.currentPeriodEnd, new Date(3600 * 1000).toISOString());
  assert.equal(result.subscription.cancelAtPeriodEnd, false);
  assert.equal(result.usageQuota.monthlyTokenQuota, 48_000_000);
  assert.equal(result.shouldPrepareCoworker, true);
  assert.doesNotMatch(JSON.stringify(result), /sk_test_fake_secret|user_metadata_should_not_win|cs_test_123/i);
});

test('verified webhook ignores local tier metadata when provider lookup key is missing', () => {
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_missing_provider_lookup_123',
    type: 'customer.subscription.updated',
    created: 0,
    data: {
      object: {
        id: 'sub_raw_should_not_echo',
        customer: { id: 'cus_raw_should_not_echo' },
        status: 'active',
        metadata: {
          sidekickUserId: 'user_123',
          tierId: 'pro-office',
        },
        items: {
          data: [
            {
              price: {
                id: 'price_raw_should_not_echo',
              },
            },
          ],
        },
      },
    },
  });

  assert.deepEqual({ kind: result.kind, reason: result.reason }, { kind: 'ignored', reason: 'unknown_price_lookup_key' });
  assert.doesNotMatch(JSON.stringify(result), /sub_raw_should_not_echo|cus_raw_should_not_echo|price_raw_should_not_echo/i);
});

test('subscription.updated with Stripe status "unpaid" collapses to canceled so the runner is suspended (#13)', () => {
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_unpaid_dunning_123',
    type: 'customer.subscription.updated',
    created: 0,
    data: {
      object: {
        id: 'sub_unpaid', customer: { id: 'cus_unpaid' }, status: 'unpaid',
        metadata: { sidekickUserId: 'user_123' },
        items: { data: [{ price: { id: 'price_x', lookup_key: 'sidekick_pro_office_monthly' } }] },
      },
    },
  });
  assert.equal(result.kind, 'subscription_patch');
  assert.equal(result.subscription.status, 'canceled', 'unpaid must collapse to canceled (suspend), not inactive');
});

test('subscription.updated with Stripe status "incomplete_expired" also collapses to canceled (#13)', () => {
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_incomplete_expired_123',
    type: 'customer.subscription.updated',
    created: 0,
    data: {
      object: {
        id: 'sub_ie', customer: { id: 'cus_ie' }, status: 'incomplete_expired',
        metadata: { sidekickUserId: 'user_123' },
        items: { data: [{ price: { id: 'price_y', lookup_key: 'sidekick_studio_monthly' } }] },
      },
    },
  });
  assert.equal(result.kind, 'subscription_patch');
  assert.equal(result.subscription.status, 'canceled');
});

test('subscription.updated with Stripe status "paused" collapses to canceled so the runner suspends (defect hunt 2026-06-10)', () => {
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_paused_dunning_123',
    type: 'customer.subscription.updated',
    created: 0,
    data: {
      object: {
        id: 'sub_paused', customer: { id: 'cus_paused' }, status: 'paused',
        metadata: { sidekickUserId: 'user_123' },
        items: { data: [{ price: { id: 'price_p', lookup_key: 'sidekick_pro_office_monthly' } }] },
      },
    },
  });
  assert.equal(result.kind, 'subscription_patch');
  assert.equal(result.subscription.status, 'canceled', 'paused must collapse to canceled (suspend); it used to fall through to inactive and leak Fly compute');
});

test('verified subscription updated ignores multiple conflicting item price lookup keys', () => {
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_multi_item_conflicting_lookup_123',
    type: 'customer.subscription.updated',
    created: 0,
    data: {
      object: {
        id: 'sub_raw_multi_item_conflict_should_not_echo',
        customer: { id: 'cus_raw_multi_item_conflict_should_not_echo' },
        status: 'active',
        metadata: {
          sidekickUserId: 'user_123',
        },
        items: {
          data: [
            {
              price: {
                id: 'price_raw_multi_item_studio_should_not_echo',
                lookup_key: 'sidekick_studio_monthly',
              },
            },
            {
              price: {
                id: 'price_raw_multi_item_enterprise_should_not_echo',
                lookup_key: 'sidekick_enterprise_suite_monthly',
              },
            },
          ],
        },
      },
    },
  });

  assert.deepEqual({ kind: result.kind, reason: result.reason }, { kind: 'ignored', reason: 'unknown_price_lookup_key' });
  assert.doesNotMatch(JSON.stringify(result), /sub_raw_multi_item_conflict_should_not_echo|cus_raw_multi_item_conflict_should_not_echo|price_raw_multi_item_/i);
});

test('plan upgrade: subscription.updated trusts the new item lookup_key over stale customer metadata', () => {
  // Real defect from 2026-05-28: Alex upgraded Studio→Pro Office via the
  // Stripe portal. The webhook arrived with item.lookup_key=
  // sidekick_pro_office_monthly but the customer.metadata.priceLookupKey
  // was still sidekick_studio_monthly (set at original sign-up; Stripe
  // doesn't auto-rewrite it on plan change). The handler treated the
  // mismatch as tampering and ignored the event, leaving the user stuck
  // on Studio in the app.
  //
  // Fix: on subscription events the item lookup_key is authoritative;
  // metadata is a fallback for the rare legacy case where an item has no
  // lookup_key. This test pins that behaviour.
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_upgrade_studio_to_pro_office',
    type: 'customer.subscription.updated',
    created: 0,
    data: {
      object: {
        id: 'sub_upgrade_should_not_echo',
        customer: 'cus_upgrade_should_not_echo',
        status: 'active',
        current_period_start: 0,
        current_period_end: 30 * 24 * 3600,
        metadata: {
          sidekickUserId: 'user_henry',
          tierId: 'studio',  // stale — original sign-up tier
          priceLookupKey: 'sidekick_studio_monthly',  // stale
        },
        items: {
          data: [
            {
              price: {
                id: 'price_pro_office_should_not_echo',
                lookup_key: 'sidekick_pro_office_monthly',  // new — the upgrade
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(result.kind, 'subscription_patch', 'upgrade event must be applied, not ignored');
  assert.equal(result.subscription.userId, 'user_henry');
  assert.equal(result.subscription.tierId, 'pro-office', 'tier must be the NEW tier from the item, not the stale metadata');
  assert.equal(result.usageQuota.monthlyTokenQuota, 48_000_000, 'quota must scale to Pro Office');
});

test('subscription events fall through to metadata lookup when the item has no lookup_key (legacy prices)', () => {
  // Some legacy prices were created before lookup_keys were standard.
  // For those, the customer metadata is the only source of truth.
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_legacy_item_no_lookup',
    type: 'customer.subscription.updated',
    created: 0,
    data: {
      object: {
        id: 'sub_legacy_should_not_echo',
        customer: 'cus_legacy_should_not_echo',
        status: 'active',
        current_period_start: 0,
        current_period_end: 30 * 24 * 3600,
        metadata: {
          sidekickUserId: 'user_legacy',
          priceLookupKey: 'sidekick_pro_office_monthly',
        },
        items: {
          data: [
            { price: { id: 'price_legacy_should_not_echo' } },
          ],
        },
      },
    },
  });

  assert.equal(result.kind, 'subscription_patch', 'fallback to metadata when item has no lookup_key');
  assert.equal(result.subscription.tierId, 'pro-office');
});

test('subscription events ignore when neither item nor metadata carries a known lookup_key', () => {
  // True "I have no idea what tier this is" case — ignored.
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_no_lookup_anywhere',
    type: 'customer.subscription.updated',
    created: 0,
    data: {
      object: {
        id: 'sub_no_lookup_should_not_echo',
        customer: 'cus_no_lookup_should_not_echo',
        status: 'active',
        metadata: { sidekickUserId: 'user_x' },
        items: {
          data: [
            { price: { id: 'price_no_lookup_should_not_echo' } },
          ],
        },
      },
    },
  });

  assert.equal(result.kind, 'ignored');
  assert.equal(result.reason, 'unknown_price_lookup_key');
});

test('verified supported webhook events without event ids are ignored', () => {
  const cases = [
    {
      event: {
        id: '   ',
        type: 'checkout.session.completed',
        created: 0,
        data: {
          object: {
            id: 'cs_raw_blank_id_should_not_echo',
            client_reference_id: 'user_checkout_ref',
            customer: 'cus_raw_blank_id_should_not_echo',
            subscription: 'sub_raw_blank_id_should_not_echo',
            metadata: { priceLookupKey: 'sidekick_pro_office_monthly' },
          },
        },
      },
    },
    {
      event: {
        type: 'customer.subscription.updated',
        created: 0,
        data: {
          object: {
            id: 'sub_raw_missing_event_id_should_not_echo',
            customer: { id: 'cus_raw_missing_event_id_should_not_echo' },
            status: 'active',
            metadata: { sidekickUserId: 'user_subscription' },
            items: {
              data: [
                { price: { lookup_key: 'sidekick_enterprise_suite_monthly' } },
              ],
            },
          },
        },
      },
    },
    {
      event: {
        id: '',
        type: 'customer.subscription.deleted',
        created: 0,
        data: {
          object: {
            id: 'sub_raw_empty_event_id_should_not_echo',
            customer: 'cus_raw_empty_event_id_should_not_echo',
            metadata: { sidekickUserId: 'user_subscription' },
            items: {
              data: [
                { price: { lookup_key: 'sidekick_studio_monthly' } },
              ],
            },
          },
        },
      },
    },
  ];

  for (const { event } of cases) {
    const result = resolveVerifiedStripeWebhookEvent(event);

    assert.deepEqual({ kind: result.kind, reason: result.reason }, { kind: 'ignored', reason: 'unsupported_event' });
    assert.equal('idempotencyKey' in result, false);
    assert.doesNotMatch(JSON.stringify(result), /cs_raw_|sub_raw_|cus_raw_/i);
  }
});

test('verified subscription created, updated, and deleted events resolve from subscription item price lookup keys', () => {
  const created = resolveVerifiedStripeWebhookEvent({
    id: 'evt_subscription_created_123',
    type: 'customer.subscription.created',
    created: 0,
    data: {
      object: {
        id: 'sub_test_created',
        customer: 'cus_test_created',
        status: 'trialing',
        current_period_start: 0,
        current_period_end: 3600,
        cancel_at_period_end: false,
        metadata: {
          sidekickUserId: 'user_subscription',
          priceLookupKey: 'sidekick_pro_office_monthly',
        },
        items: {
          data: [
            {
              price: {
                id: 'price_created',
                lookup_key: 'sidekick_pro_office_monthly',
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(created.kind, 'subscription_patch');
  assert.equal(created.subscription.userId, 'user_subscription');
  assert.equal(created.subscription.tierId, 'pro-office');
  assert.equal(created.subscription.status, 'trialing');
  assert.equal(created.subscription.stripeCustomerId, 'cus_test_created');
  assert.equal(created.subscription.stripeSubscriptionId, 'sub_test_created');
  assert.equal(created.subscription.priceId, 'price_created');

  const updated = resolveVerifiedStripeWebhookEvent({
    id: 'evt_subscription_updated_123',
    type: 'customer.subscription.updated',
    created: 0,
    data: {
      object: {
        id: 'sub_test_updated',
        customer: { id: 'cus_test_updated' },
        status: 'active',
        current_period_start: 0,
        current_period_end: 3600,
        cancel_at_period_end: false,
        metadata: {
          sidekickUserId: 'user_subscription',
        },
        items: {
          data: [
            {
              price: {
                id: 'price_123',
                lookup_key: 'sidekick_enterprise_suite_monthly',
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(updated.kind, 'subscription_patch');
  assert.equal(updated.subscription.userId, 'user_subscription');
  assert.equal(updated.subscription.tierId, 'enterprise-suite');
  assert.equal(updated.subscription.status, 'active');
  assert.equal(updated.subscription.stripeCustomerId, 'cus_test_updated');
  assert.equal(updated.subscription.stripeSubscriptionId, 'sub_test_updated');
  assert.equal(updated.subscription.currentPeriodStart, new Date(0).toISOString());
  assert.equal(updated.subscription.currentPeriodEnd, new Date(3600 * 1000).toISOString());
  assert.equal(updated.subscription.cancelAtPeriodEnd, false);
  assert.equal(updated.usageQuota.monthlyTokenQuota, 100_000_000);
  assert.equal(updated.shouldPrepareCoworker, true);

  const deleted = resolveVerifiedStripeWebhookEvent({
    id: 'evt_subscription_deleted_123',
    type: 'customer.subscription.deleted',
    created: 0,
    data: {
      object: {
        id: 'sub_test_deleted',
        customer: 'cus_test_deleted',
        status: 'active',
        metadata: {
          sidekickUserId: 'user_subscription',
        },
        items: {
          data: [
            {
              price: {
                lookup_key: 'sidekick_studio_monthly',
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(deleted.kind, 'subscription_patch');
  assert.equal(deleted.subscription.userId, 'user_subscription');
  assert.equal(deleted.subscription.tierId, 'studio');
  assert.equal(deleted.subscription.status, 'canceled');
  assert.equal(deleted.subscription.stripeCustomerId, 'cus_test_deleted');
  assert.equal(deleted.subscription.stripeSubscriptionId, 'sub_test_deleted');
  assert.equal(deleted.usageQuota.monthlyTokenQuota, 19_550_000);
  assert.equal(deleted.shouldPrepareCoworker, false);
  assert.equal(deleted.idempotencyKey, 'stripe:evt_subscription_deleted_123');
});

test('invoice payment failed resolves to provider-backed past-due subscription patch', () => {
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_invoice_payment_failed_123',
    type: 'invoice.payment_failed',
    created: 0,
    data: {
      object: {
        id: 'in_test_failed',
        customer: 'cus_test_invoice_failed',
        subscription: {
          id: 'sub_test_invoice_failed',
          status: 'past_due',
          cancel_at_period_end: false,
          metadata: {
            sidekickUserId: '11111111-1111-4111-8111-111111111111',
          },
          items: {
            data: [
              {
                price: {
                  id: 'price_test_invoice_failed',
                  lookup_key: 'sidekick_pro_office_monthly',
                },
              },
            ],
          },
        },
        lines: {
          data: [
            {
              period: {
                start: 0,
                end: 3600,
              },
              price: {
                id: 'price_test_invoice_failed',
                lookup_key: 'sidekick_pro_office_monthly',
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(result.kind, 'subscription_patch');
  assert.equal(result.eventId, 'evt_invoice_payment_failed_123');
  assert.equal(result.idempotencyKey, 'stripe:evt_invoice_payment_failed_123');
  assert.equal(result.subscription.userId, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.subscription.status, 'past_due');
  assert.equal(result.subscription.tierId, 'pro-office');
  assert.equal(result.subscription.stripeCustomerId, 'cus_test_invoice_failed');
  assert.equal(result.subscription.stripeSubscriptionId, 'sub_test_invoice_failed');
  assert.equal(result.subscription.priceId, 'price_test_invoice_failed');
  assert.equal(result.subscription.currentPeriodStart, new Date(0).toISOString());
  assert.equal(result.subscription.currentPeriodEnd, new Date(3600 * 1000).toISOString());
  assert.equal(result.subscription.cancelAtPeriodEnd, false);
  assert.equal(result.usageQuota.monthlyTokenQuota, 48_000_000);
  assert.equal(result.shouldPrepareCoworker, false);
});

test('invoice payment failed resolves from current invoice line metadata without an expanded subscription', () => {
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_invoice_payment_failed_current_shape_123',
    type: 'invoice.payment_failed',
    created: 0,
    data: {
      object: {
        id: 'in_current_shape_failed',
        customer: { id: 'cus_test_invoice_failed' },
        subscription_details: {
          subscription: 'sub_test_invoice_failed',
          metadata: {
            sidekickUserId: '11111111-1111-4111-8111-111111111111',
          },
        },
        lines: {
          data: [
            {
              subscription: 'sub_test_invoice_failed',
              metadata: {
                sidekickUserId: '11111111-1111-4111-8111-111111111111',
                priceLookupKey: 'sidekick_pro_office_monthly',
              },
              period: {
                start: 0,
                end: 3600,
              },
              pricing: {
                type: 'price_details',
                price_details: {
                  price: 'price_test_invoice_failed',
                  product: 'prod_test_invoice_failed',
                },
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(result.kind, 'subscription_patch');
  assert.equal(result.subscription.userId, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.subscription.status, 'past_due');
  assert.equal(result.subscription.tierId, 'pro-office');
  assert.equal(result.subscription.stripeCustomerId, 'cus_test_invoice_failed');
  assert.equal(result.subscription.stripeSubscriptionId, 'sub_test_invoice_failed');
  assert.equal(result.subscription.priceId, 'price_test_invoice_failed');
});

test('a paid renewal invoice advances the billing period and keeps the entitlement active', () => {
  // The renewal invoice is the ONLY event that reliably carries the new period, and
  // the usage window is anchored on it. This used to resolve as unsupported_event, so
  // a renewal left the anchor frozen and pinned the user at 100% consumed for good.
  // Note the invoice's own status is 'paid', which is not a subscription status: if
  // that fell through, a successful renewal would cancel what it just paid for.
  for (const type of ['invoice.payment_succeeded', 'invoice.paid']) {
    const result = resolveVerifiedStripeWebhookEvent({
      id: `evt_${type.replace(/\./g, '_')}_renewal_123`,
      type,
      created: 0,
      data: {
        object: {
          id: 'in_renewal_paid',
          status: 'paid',
          customer: { id: 'cus_test_renewal' },
          subscription_details: {
            subscription: 'sub_test_renewal',
            metadata: {
              sidekickUserId: '11111111-1111-4111-8111-111111111111',
            },
          },
          lines: {
            data: [
              {
                subscription: 'sub_test_renewal',
                metadata: {
                  sidekickUserId: '11111111-1111-4111-8111-111111111111',
                  priceLookupKey: 'sidekick_studio_monthly',
                },
                period: {
                  start: 1_780_000_000,
                  end: 1_782_592_000,
                },
                pricing: {
                  type: 'price_details',
                  price_details: {
                    price: 'price_test_renewal',
                    product: 'prod_test_renewal',
                  },
                },
              },
            ],
          },
        },
      },
    });

    assert.equal(result.kind, 'subscription_patch');
    assert.equal(result.subscription.userId, '11111111-1111-4111-8111-111111111111');
    assert.equal(result.subscription.status, 'active');
    assert.equal(result.subscription.tierId, 'studio');
    assert.equal(result.subscription.stripeSubscriptionId, 'sub_test_renewal');
    assert.equal(result.subscription.currentPeriodStart, new Date(1_780_000_000 * 1000).toISOString());
    assert.equal(result.subscription.currentPeriodEnd, new Date(1_782_592_000 * 1000).toISOString());
  }
});

test('a paid renewal defers to the expanded subscription status over the invoice status', () => {
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_invoice_paid_expanded_status_123',
    type: 'invoice.payment_succeeded',
    created: 0,
    data: {
      object: {
        id: 'in_renewal_expanded',
        status: 'paid',
        customer: 'cus_test_renewal_expanded',
        subscription: {
          id: 'sub_test_renewal_expanded',
          status: 'trialing',
          metadata: {
            sidekickUserId: '11111111-1111-4111-8111-111111111111',
          },
          current_period_start: 1_780_000_000,
          current_period_end: 1_782_592_000,
          items: {
            data: [
              {
                price: {
                  id: 'price_test_renewal_expanded',
                  lookup_key: 'sidekick_studio_monthly',
                },
              },
            ],
          },
        },
      },
    },
  });

  assert.equal(result.kind, 'subscription_patch');
  assert.equal(result.subscription.status, 'trialing');
  assert.equal(result.subscription.stripeSubscriptionId, 'sub_test_renewal_expanded');
});

test('invoice payment failed without provider entitlement fields is ignored', () => {
  const result = resolveVerifiedStripeWebhookEvent({
    id: 'evt_invoice_payment_failed_incomplete_123',
    type: 'invoice.payment_failed',
    created: 0,
    data: {
      object: {
        customer: 'cus_test_invoice_failed',
        subscription: {
          id: 'sub_test_invoice_failed',
          metadata: {
            sidekickUserId: '11111111-1111-4111-8111-111111111111',
          },
          items: {
            data: [
              {
                price: {
                  lookup_key: 'sidekick_pro_office_monthly',
                },
              },
            ],
          },
        },
      },
    },
  });

  assert.deepEqual({ kind: result.kind, reason: result.reason }, { kind: 'ignored', reason: 'incomplete_provider_entitlement' });
});

test('unsupported events, missing users, and unknown lookup keys are ignored', () => {
  const unsupported = resolveVerifiedStripeWebhookEvent({
    id: 'evt_customer_updated_123',
    type: 'customer.updated',
    created: 0,
    data: {
      object: {
        client_reference_id: 'user_123',
        metadata: { priceLookupKey: 'sidekick_studio_monthly' },
      },
    },
  });
  assert.deepEqual({ kind: unsupported.kind, reason: unsupported.reason }, { kind: 'ignored', reason: 'unsupported_event' });

  // invoice.paid IS supported now, because it carries the renewal period. But an
  // invoice with no subscription behind it is a one-off charge and must not mint
  // an entitlement nobody subscribed to.
  const invoiceWithoutSubscription = resolveVerifiedStripeWebhookEvent({
    id: 'evt_invoice_paid_123',
    type: 'invoice.paid',
    created: 0,
    data: {
      object: {
        client_reference_id: 'user_123',
        metadata: { priceLookupKey: 'sidekick_studio_monthly' },
      },
    },
  });
  assert.deepEqual(
    { kind: invoiceWithoutSubscription.kind, reason: invoiceWithoutSubscription.reason },
    { kind: 'ignored', reason: 'incomplete_provider_entitlement' },
  );

  const missingUser = resolveVerifiedStripeWebhookEvent({
    id: 'evt_missing_user_123',
    type: 'checkout.session.completed',
    created: 0,
    data: {
      object: {
        metadata: { priceLookupKey: 'sidekick_studio_monthly' },
      },
    },
  });
  assert.deepEqual({ kind: missingUser.kind, reason: missingUser.reason }, { kind: 'ignored', reason: 'missing_user' });

  // Truly-unknown case: BOTH metadata and item carry a junk lookup_key,
  // so neither resolves to a tier. Under the 2026-05-28 fix the item
  // takes precedence on subscription events; if the item has a junk
  // lookup the resolver returns 'unknown_price_lookup_key'. (Before the
  // fix any metadata/item mismatch was treated as unknown, which broke
  // legitimate plan upgrades — see "plan upgrade" test above.)
  const unknownLookup = resolveVerifiedStripeWebhookEvent({
    id: 'evt_unknown_lookup_123',
    type: 'customer.subscription.updated',
    created: 0,
    data: {
      object: {
        id: 'sub_test_unknown',
        metadata: {
          sidekickUserId: 'user_123',
          priceLookupKey: 'price_unknown_should_fail_closed',
        },
        items: {
          data: [
            { price: { lookup_key: 'price_unknown_should_fail_closed' } },
          ],
        },
      },
    },
  });
  assert.deepEqual({ kind: unknownLookup.kind, reason: unknownLookup.reason }, { kind: 'ignored', reason: 'unknown_price_lookup_key' });
  assert.doesNotMatch(JSON.stringify(unknownLookup), /price_unknown_should_fail_closed|sub_test_unknown/i);
});

// ---- Downgrade-at-rollover: schedule the switch for the period boundary ----

function makeScheduleClient({ discounts = undefined, rejectUpdateWhen = null } = {}) {
  const calls = { priceList: [], subRetrieve: [], schedCreate: [], schedUpdate: [], schedRelease: [] };
  const client = {
    prices: {
      async list(params) {
        calls.priceList.push(params);
        return { data: [{ id: 'price_studio_target', lookup_key: 'sidekick_studio_monthly', active: true }] };
      },
    },
    checkout: { sessions: { async create() { throw new Error('checkout.sessions.create should not be called'); } } },
    billingPortal: { sessions: { async create() { throw new Error('billingPortal.sessions.create should not be called'); } } },
    subscriptions: {
      async retrieve(id, params) {
        calls.subRetrieve.push({ id, params });
        return {
          id,
          schedule: null,
          items: {
            data: [{ id: 'si_current', price: { id: 'price_enterprise_current' }, quantity: 1, current_period_end: 1765000000 }],
          },
          ...(discounts !== undefined ? { discounts } : {}),
        };
      },
    },
    subscriptionSchedules: {
      async create(params) {
        calls.schedCreate.push(params);
        return { id: 'sub_sched_1', status: 'not_started', phases: [{ start_date: 1762408000, items: [{ price: 'price_enterprise_current', quantity: 1 }] }] };
      },
      async update(id, params) {
        calls.schedUpdate.push({ id, params });
        if (rejectUpdateWhen && rejectUpdateWhen(params)) throw new Error('No such discount: di_promo');
        return { id, status: 'active', phases: params.phases };
      },
      async release(id) {
        calls.schedRelease.push(id);
        return { id, status: 'released' };
      },
    },
  };
  return { client, calls };
}

test('downgrade schedules at period end: phase 1 keeps the current price until renewal, phase 2 switches to target, no proration', async () => {
  const { client, calls } = makeScheduleClient();
  const result = await scheduleSubscriptionDowngradeAtPeriodEnd(
    { currentSubscriptionId: 'sub_live_123', currentPriceId: 'price_enterprise_current', targetTierId: 'studio' },
    client,
  );

  assert.equal(calls.priceList[0].lookup_keys[0], 'sidekick_studio_monthly', 'looks up the TARGET (cheaper) price');
  assert.deepEqual(calls.schedCreate, [{ from_subscription: 'sub_live_123' }], 'creates schedule from the live subscription');

  const upd = calls.schedUpdate[0].params;
  assert.equal(upd.proration_behavior, 'none', 'no mid-cycle credit or charge');
  assert.equal(upd.end_behavior, 'release', 'detaches once the cheaper phase begins');
  assert.equal(upd.phases.length, 2);
  const [p1, p2] = upd.phases;
  assert.equal(p1.items[0].price, 'price_enterprise_current', 'phase 1 keeps the CURRENT (paid) price');
  assert.equal(p1.end_date, 1765000000, 'phase 1 ends at the period boundary (derived from the item)');
  assert.equal(p2.items[0].price, 'price_studio_target', 'phase 2 switches to the target price');
  assert.equal(p2.start_date, 1765000000, 'phase 2 begins exactly at the boundary');

  assert.deepEqual(result, { provider: 'stripe', scheduleId: 'sub_sched_1', targetTierId: 'studio', effectiveAt: 1765000000 });
  assert.doesNotMatch(JSON.stringify(result), /sub_live_123|sk_test|whsec/i, 'never echoes the live sub id or secrets');
});

test('downgrade scheduling honours an explicit currentPeriodEnd over the derived one', async () => {
  const { client, calls } = makeScheduleClient();
  const result = await scheduleSubscriptionDowngradeAtPeriodEnd(
    { currentSubscriptionId: 'sub_live_123', currentPriceId: 'price_enterprise_current', targetTierId: 'studio', currentPeriodEnd: 1799999999 },
    client,
  );
  assert.equal(result.effectiveAt, 1799999999);
  assert.equal(calls.schedUpdate[0].params.phases[1].start_date, 1799999999);
});

test('downgrade rejects stale prices and unsupported provider items before creating a schedule', async () => {
  for (const kind of ['stale_price', 'missing_item', 'multiple_items', 'missing_quantity', 'quantity_change', 'wrong_subscription']) {
    const { client, calls } = makeScheduleClient();
    const originalRetrieve = client.subscriptions.retrieve;
    client.subscriptions.retrieve = async (...args) => {
      const sub = await originalRetrieve(...args);
      if (kind === 'stale_price') sub.items.data[0].price.id = 'price_changed_after_db_sync';
      if (kind === 'missing_item') sub.items.data = [];
      if (kind === 'multiple_items') sub.items.data.push({ id: 'si_other', price: 'price_other', quantity: 1 });
      if (kind === 'missing_quantity') delete sub.items.data[0].quantity;
      if (kind === 'quantity_change') sub.items.data[0].quantity = 2;
      if (kind === 'wrong_subscription') sub.id = 'sub_other';
      return sub;
    };
    await assert.rejects(() => scheduleSubscriptionDowngradeAtPeriodEnd({
      currentSubscriptionId: 'sub_live_123', currentPriceId: 'price_enterprise_current', targetTierId: 'studio',
    }, client), /subscription item lookup failed/, kind);
    assert.equal(calls.schedCreate.length, 0, kind);
    assert.equal(calls.schedUpdate.length, 0, kind);
  }
});

// ---- The launch discount must survive a scheduled downgrade ----
//
// Rewriting a schedule's phases replaces them, and a phase with no `discounts`
// inherits only the customer's discount (we have none: the launch offer sits on
// the subscription). So the old update silently stripped "70% off your first 2
// months" the moment a downgrade was booked, against the plan screen's promise
// that remaining launch-offer months carry across. Found 2026-09-07.

test('a scheduled downgrade carries the live launch discount into both phases by id', async () => {
  const { client, calls } = makeScheduleClient({
    discounts: [{ id: 'di_promo', coupon: 'delegent_launch_pro_office_2mo', end: 1770000000 }],
  });
  await scheduleSubscriptionDowngradeAtPeriodEnd(
    { currentSubscriptionId: 'sub_live_123', currentPriceId: 'price_enterprise_current', targetTierId: 'studio' },
    client,
  );
  assert.deepEqual(calls.subRetrieve[0].params.expand, ['items.data.price', 'discounts'], 'asks Stripe for the discounts');
  assert.equal(calls.schedUpdate.length, 1, 'accepted first time, no fallback needed');
  const [p1, p2] = calls.schedUpdate[0].params.phases;
  assert.deepEqual(p1.discounts, [{ discount: 'di_promo' }], 'phase 1 keeps the discount it already had');
  assert.deepEqual(p2.discounts, [{ discount: 'di_promo' }], 'phase 2 (ends 1770000000 > boundary 1765000000) still has months to run');
});

test('a discount that ends inside the current period is not carried into the cheaper phase', async () => {
  const { client, calls } = makeScheduleClient({
    discounts: [{ id: 'di_promo', coupon: 'delegent_launch_pro_office_2mo', end: 1764000000 }],
  });
  await scheduleSubscriptionDowngradeAtPeriodEnd(
    { currentSubscriptionId: 'sub_live_123', currentPriceId: 'price_enterprise_current', targetTierId: 'studio' },
    client,
  );
  const [p1, p2] = calls.schedUpdate[0].params.phases;
  assert.deepEqual(p1.discounts, [{ discount: 'di_promo' }]);
  assert.equal(p2.discounts, undefined, 'nothing left to carry, and naming an expired discount would be refused');
});

test('if Stripe will not reuse the discount on the schedule, the same coupon is re-applied rather than dropped', async () => {
  const { client, calls } = makeScheduleClient({
    discounts: [{ id: 'di_promo', coupon: { id: 'delegent_launch_pro_office_2mo' }, end: null }],
    rejectUpdateWhen: (params) => params.phases.some((phase) => (phase.discounts ?? []).some((d) => 'discount' in d)),
  });
  await scheduleSubscriptionDowngradeAtPeriodEnd(
    { currentSubscriptionId: 'sub_live_123', currentPriceId: 'price_enterprise_current', targetTierId: 'studio' },
    client,
  );
  assert.equal(calls.schedUpdate.length, 2, 'one refusal, one retry');
  const [p1, p2] = calls.schedUpdate[1].params.phases;
  assert.deepEqual(p1.discounts, [{ coupon: 'delegent_launch_pro_office_2mo' }]);
  assert.deepEqual(p2.discounts, [{ coupon: 'delegent_launch_pro_office_2mo' }], 'open-ended, so it carries');
});

test('a subscription with no discount schedules exactly as before, with no discounts key at all', async () => {
  const { client, calls } = makeScheduleClient({ discounts: [] });
  await scheduleSubscriptionDowngradeAtPeriodEnd(
    { currentSubscriptionId: 'sub_live_123', currentPriceId: 'price_enterprise_current', targetTierId: 'studio' },
    client,
  );
  const [p1, p2] = calls.schedUpdate[0].params.phases;
  assert.equal('discounts' in p1, false);
  assert.equal('discounts' in p2, false);
});

test('when the retry is also refused the downgrade fails loudly rather than booking without the discount', async () => {
  const { client, calls } = makeScheduleClient({
    discounts: [{ id: 'di_promo', coupon: 'delegent_launch_pro_office_2mo', end: null }],
    rejectUpdateWhen: () => true,
  });
  await assert.rejects(
    () => scheduleSubscriptionDowngradeAtPeriodEnd(
      { currentSubscriptionId: 'sub_live_123', currentPriceId: 'price_enterprise_current', targetTierId: 'studio' },
      client,
    ),
    /schedule update failed: No such discount/,
  );
  assert.equal(calls.schedUpdate.length, 2);
});

test('downgrade scheduling throws (never silently no-ops) when the schedule client is absent', async () => {
  const { client } = makeScheduleClient();
  delete client.subscriptionSchedules;
  await assert.rejects(
    () => scheduleSubscriptionDowngradeAtPeriodEnd({ currentSubscriptionId: 'sub_1', targetTierId: 'studio' }, client),
    /scheduling unavailable/i,
  );
});

test('releaseScheduledDowngrade releases the given schedule and no-ops on an empty id', async () => {
  const { client, calls } = makeScheduleClient();
  await releaseScheduledDowngrade('sub_sched_1', client);
  assert.deepEqual(calls.schedRelease, ['sub_sched_1']);
  await releaseScheduledDowngrade('', client);
  assert.deepEqual(calls.schedRelease, ['sub_sched_1'], 'empty id is a no-op, no throw');
});
