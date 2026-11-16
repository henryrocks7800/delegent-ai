import { portalConfiguration } from '../../../tests/fixtures/portal-configuration.mjs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Stripe from 'stripe';
import {
  createSupabaseStripeBillingStore,
  handleStripeBillingPortalRequest,
  handleStripeCheckoutRequest,
  handleStripeWebhookRequest,
  type StripeBillingEventInsert,
  type StripeBillingEventRecord,
  type StripeBillingEventUpdate,
  type HermesProvisioningJobRecord,
  type StripeBillingStore,
  type StripeServerEnv,
  type SubscriptionPatchRecord,
  type UsageQuotaPatchRecord,
  type AtomicStripeEntitlementInput,
  type BillingEntitlementResult,
} from '../lib/server/stripeRealFlow';
import type { PurchaseIntentStore } from '@sidekick/billing/purchase-intents';
import { SIDEKICK_FREE_TRIAL, SIDEKICK_LAUNCH_PROMO } from '@sidekick/shared';

const userId = '11111111-1111-4111-8111-111111111111';
const checkoutEnv: StripeServerEnv = {
  STRIPE_SECRET_KEY: 'sk_test_fake_route_secret',
  STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_Generic',
  STRIPE_PORTAL_UPGRADE_PRO_CONFIGURATION_ID: 'bpc_Pro',
  STRIPE_PORTAL_UPGRADE_ENTERPRISE_CONFIGURATION_ID: 'bpc_Enterprise',
  SUPABASE_URL: 'https://sidekick-test.supabase.co',
  SUPABASE_ANON_KEY: 'anon_test_key',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_key',
  SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: 'https://app.sidekick.example',
};
const webhookEnv: StripeServerEnv = {
  STRIPE_WEBHOOK_SECRET: 'whsec_test_route_secret',
  SUPABASE_URL: 'https://sidekick-test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_key',
};

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://dashboard.sidekick.example${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function signedStripeRequest(path: string, event: unknown, webhookSecret: string) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  return new Request(`https://dashboard.sidekick.example${path}`, {
    method: 'POST',
    headers: {
      'stripe-signature': signature,
    },
    body: payload,
  });
}

function createCheckoutClient(overrides: { sessionUrl?: string; portalUrl?: string } = {}) {
  const purchaseIntentStore: PurchaseIntentStore = {
    async claim(userId, provider, tierId, request) {
      return { kind: 'claimed', action: 'create', intent: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: userId, provider, tier_id: tierId, phase: 'reserved',
        request: { ...request, hasPriorSubscription: Boolean(request.existingStripeCustomerId) },
        prepared_params: null, provider_session_id: null, lease_token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        created_at: new Date().toISOString(), expires_at: new Date(Date.now()+3_600_000).toISOString(),
      } };
    },
    async update() { return true; },
  };
  const calls = { priceList: [] as unknown[], sessionCreate: [] as unknown[], portalCreate: [] as unknown[], subscriptionRetrieve: [] as unknown[] };
  return {
    calls,
    purchaseDeps: { purchaseIntentStore },
    client: {
      prices: {
        async list(params: unknown) {
          calls.priceList.push(params);
          return {
            data: [
              {
                id: 'price_test_route_pro',
                lookup_key: 'sidekick_pro_office_monthly',
                active: true,
              },
            ],
          };
        },
      },
      checkout: {
        sessions: {
          async retrieve(id: string) {
            const { params } = calls.sessionCreate.at(-1) as { params: any };
            return { id, status: 'open', url: overrides.sessionUrl ?? 'https://checkout.stripe.com/c/pay/cs_test_route_123',
              client_reference_id: params.client_reference_id, metadata: params.metadata, expires_at: params.expires_at };
          },
          async expire() { throw new Error('new checkout must not expire another session'); },
          async list() { return { data: [], has_more: false }; },
          async create(params: unknown, options: unknown) {
            calls.sessionCreate.push({ params, options });
            return {
              id: 'cs_test_route_123',
              url: overrides.sessionUrl ?? 'https://checkout.stripe.com/c/pay/cs_test_route_123',
            };
          },
        },
      },
      billingPortal: {
        configurations: { async retrieve(id: string) { return portalConfiguration(id, id === 'bpc_Pro' ? 'price_test_route_pro' : undefined); } },
        sessions: {
          async create(params: unknown) {
            calls.portalCreate.push(params);
            return {
              id: 'bps_test_route_123',
              url: overrides.portalUrl ?? 'https://billing.stripe.com/p/session/bps_test_route_123',
            };
          },
        },
      },
      subscriptions: {
        // Trial eligibility verifies a returning customer's history with Stripe
        // before deciding whether to offer the trial, so the mock must answer.
        async list() {
          return { data: [{ id: 'sub_previous_route', status: 'canceled' }] };
        },
        async retrieve(id: string, params: unknown) {
          calls.subscriptionRetrieve.push({ id, params });
          return {
            id, status: 'active', customer: 'cus_existing_route',
            items: {
              data: [
                {
                  id: 'si_current_route_studio',
                  price: { id: 'price_current_studio' },
                  quantity: 1,
                },
              ],
            },
          };
        },
      },
    },
  };
}

class InMemoryBillingStore implements StripeBillingStore {
  readonly events = new Map<string, StripeBillingEventRecord>();
  readonly eventUpdates: StripeBillingEventUpdate[] = [];
  readonly subscriptions: SubscriptionPatchRecord[] = [];
  readonly usageQuotas: UsageQuotaPatchRecord[] = [];
  readonly provisioningJobs: HermesProvisioningJobRecord[] = [];
  readonly provisioningEvents: Array<{ userId: string; event: string; details: Record<string, unknown> }> = [];
  readonly entitlementCalls: AtomicStripeEntitlementInput[] = [];
  busy = false;

  async applyEntitlement(input: AtomicStripeEntitlementInput): Promise<BillingEntitlementResult> {
    this.entitlementCalls.push(structuredClone(input));
    return { outcome: 'applied', resumed: false };
  }

  async claimBillingEvent(input: StripeBillingEventInsert) {
    const existing = this.events.get(input.provider_event_id);
    if (existing) {
      if (existing.payload_hash && existing.payload_hash !== input.payload_hash) {
        return { state: 'payload_mismatch' as const, event: existing };
      }
      if (existing.status === 'processed' || existing.status === 'ignored') {
        return { state: 'duplicate_terminal' as const, event: existing };
      }
      if (this.busy || existing.status === 'processing') {
        return { state: 'busy' as const, event: existing };
      }
      Object.assign(existing, {
        status: 'processing' as const,
        processing_started_at: new Date(0).toISOString(),
        processing_expires_at: new Date(5 * 60 * 1000).toISOString(),
        processed_at: null,
        error_code: null,
      });
      return { state: 'claimed' as const, event: existing };
    }

    const event: StripeBillingEventRecord = {
      id: `billing_event_${this.events.size + 1}`,
      provider: input.provider,
      provider_event_id: input.provider_event_id,
      event_type: input.event_type,
      idempotency_key: input.idempotency_key,
      payload_hash: input.payload_hash,
      status: 'processing',
      user_id: input.user_id ?? null,
      processed_at: null,
      processing_started_at: new Date(0).toISOString(),
      processing_expires_at: new Date(5 * 60 * 1000).toISOString(),
    };
    this.events.set(input.provider_event_id, event);
    return { state: 'claimed' as const, event };
  }

  async updateBillingEvent(id: string, patch: StripeBillingEventUpdate) {
    this.eventUpdates.push({ ...patch });
    const event = [...this.events.values()].find((candidate) => candidate.id === id);
    assert.ok(event, `missing billing event ${id}`);
    Object.assign(event, patch);
  }

  async upsertSubscription(patch: SubscriptionPatchRecord) {
    this.subscriptions.push({ ...patch });
    return true;
  }

  async upsertUsageQuota(patch: UsageQuotaPatchRecord) {
    this.usageQuotas.push({ ...patch });
    return true;
  }

  async enqueueHermesProvisioning(job: HermesProvisioningJobRecord) {
    this.provisioningJobs.push({ ...job });
  }

  async recordProvisioningEvent(input: { userId: string; event: string; details: Record<string, unknown> }) {
    this.provisioningEvents.push(structuredClone(input));
  }
}

test('checkout route fails closed before contacting Stripe when the user is unauthenticated', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://app.sidekick.example/success',
      cancelUrl: 'https://app.sidekick.example/cancel',
    }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        throw new Error('auth should not be called without a bearer token');
      },
    },
  );

  assert.equal(response.status, 401);
  assert.equal(checkout.calls.priceList.length, 0);
  assert.equal(checkout.calls.sessionCreate.length, 0);
  assert.doesNotMatch(await response.text(), /sk_test|anon_test|service_role|whsec/i);
});

test('checkout route fails closed before contacting Stripe when Stripe config is incomplete', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://app.sidekick.example/success',
      cancelUrl: 'https://app.sidekick.example/cancel',
    }, { authorization: 'Bearer user_access_token' }),
    {
      env: { ...checkoutEnv, STRIPE_SECRET_KEY: '' },
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        return { id: userId, email: null };
      },
    },
  );

  assert.equal(response.status, 503);
  assert.equal(checkout.calls.priceList.length, 0);
  assert.doesNotMatch(await response.text(), /sk_test|anon_test|service_role|whsec/i);
});

test('checkout route fails closed before auth or Stripe when the server-only subscription lookup key is missing', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://app.sidekick.example/success',
      cancelUrl: 'https://app.sidekick.example/cancel',
    }, { authorization: 'Bearer user_access_token' }),
    {
      env: { ...checkoutEnv, SUPABASE_SERVICE_ROLE_KEY: '' },
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        throw new Error('auth should not be called when server lookup config is missing');
      },
      async getCheckoutSubscription() {
        throw new Error('subscription lookup should not run when server lookup config is missing');
      },
    },
  );

  assert.equal(response.status, 503);
  assert.equal(checkout.calls.priceList.length, 0);
  assert.equal(checkout.calls.sessionCreate.length, 0);
  assert.doesNotMatch(await response.text(), /sk_test|anon_test|service_role_test|whsec/i);
});

test('checkout route creates a server-side Stripe session and redirects only to Stripe Checkout', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://app.sidekick.example/success',
      cancelUrl: 'https://app.sidekick.example/cancel',
      attemptToken: 'caller_controlled_token_must_not_affect_idempotency',
      userId: 'attacker_supplied_user_id_should_be_ignored',
    }, { authorization: 'Bearer user_access_token' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser(token) {
        assert.equal(token, 'user_access_token');
        return { id: userId, email: 'alex@example.com' };
      },
      // A live route always supplies the subscription lookup; without it the
      // trial-aware factory cannot decide eligibility and refuses to guess.
      async getCheckoutSubscription() {
        return { status: 'inactive' };
      },
      now: () => 0,
    },
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_route_123');
  assert.equal(checkout.calls.priceList.length, 1);
  assert.equal(checkout.calls.sessionCreate.length, 1);
  const { params, options } = checkout.calls.sessionCreate[0] as { params: any; options: any };
  assert.equal(params.client_reference_id, userId);
  assert.equal(params.metadata.sidekickUserId, userId);
  assert.equal(params.metadata.tierId, 'pro-office');
  assert.deepEqual(params.payment_method_types, ['card', 'link']);
  assert.equal(params.customer_email, 'alex@example.com');
  assert.equal(options.idempotencyKey, 'purchase-intent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(params.metadata.purchaseIntentId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('checkout route returns a JSON Stripe URL for mobile clients that ask for JSON', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://app.sidekick.example/success',
      cancelUrl: 'https://app.sidekick.example/cancel',
    }, { authorization: 'Bearer user_access_token', accept: 'application/json' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        return { id: userId, email: 'alex@example.com' };
      },
      async getCheckoutSubscription() {
        return { status: 'inactive' };
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await response.json(), { url: 'https://checkout.stripe.com/c/pay/cs_test_route_123' });
  assert.equal(checkout.calls.sessionCreate.length, 1);
});

test('checkout route refuses caller-controlled success and cancel origins before contacting Stripe', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://evil.example/success',
      cancelUrl: 'https://app.sidekick.example/cancel',
    }, { authorization: 'Bearer user_access_token' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        return { id: userId, email: null };
      },
    },
  );

  assert.equal(response.status, 400);
  assert.equal(checkout.calls.priceList.length, 0);
  assert.equal(checkout.calls.sessionCreate.length, 0);
});

test('checkout route does not trust request origin as a redirect allow-list', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://dashboard.sidekick.example/success',
      cancelUrl: 'https://dashboard.sidekick.example/cancel',
    }, { authorization: 'Bearer user_access_token' }),
    {
      env: { ...checkoutEnv, SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: '' },
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        return { id: userId, email: null };
      },
    },
  );

  assert.equal(response.status, 400);
  assert.equal(checkout.calls.priceList.length, 0);
  assert.equal(checkout.calls.sessionCreate.length, 0);
});

test('checkout route refuses users who already have the requested provider-backed subscription', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://app.sidekick.example/success',
      cancelUrl: 'https://app.sidekick.example/cancel',
    }, { authorization: 'Bearer user_access_token' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        return { id: userId, email: 'alex@example.com' };
      },
      async getCheckoutSubscription() {
        return { status: 'active', tierId: 'pro-office', stripeCustomerId: 'cus_existing_route' };
      },
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'subscription_already_active',
    currentTierId: 'pro-office',
    requestedTierId: 'pro-office',
  });
  assert.equal(checkout.calls.priceList.length, 0);
  assert.equal(checkout.calls.sessionCreate.length, 0);
});

test('checkout route refuses duplicate subscriptions and identifies plan changes for the client', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://app.sidekick.example/success',
      cancelUrl: 'https://app.sidekick.example/cancel',
    }, { authorization: 'Bearer user_access_token' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        return { id: userId, email: 'alex@example.com' };
      },
      async getCheckoutSubscription() {
        return { status: 'active', tierId: 'studio', stripeCustomerId: 'cus_existing_route' };
      },
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: 'subscription_change_required',
    currentTierId: 'studio',
    requestedTierId: 'pro-office',
  });
  assert.equal(checkout.calls.priceList.length, 0);
  assert.equal(checkout.calls.sessionCreate.length, 0);
});

test('checkout route reuses a previous Stripe customer for a canceled subscriber', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://app.sidekick.example/success',
      cancelUrl: 'https://app.sidekick.example/cancel',
    }, { authorization: 'Bearer user_access_token' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        return { id: userId, email: 'alex@example.com' };
      },
      async getCheckoutSubscription() {
        return { status: 'canceled', stripeCustomerId: 'cus_existing_route' };
      },
    },
  );

  assert.equal(response.status, 303);
  const { params } = checkout.calls.sessionCreate[0] as { params: any };
  assert.equal(params.customer, 'cus_existing_route');
  assert.deepEqual(params.payment_method_types, ['card', 'link']);
  assert.equal(params.customer_email, undefined);
});

test('checkout route refuses non-Stripe redirect URLs returned by Stripe client', async () => {
  const checkout = createCheckoutClient({ sessionUrl: 'https://evil.example/pay/cs_test_route_123' });
  const response = await handleStripeCheckoutRequest(
    jsonRequest('/api/stripe/checkout', {
      tierId: 'pro-office',
      successUrl: 'https://app.sidekick.example/success',
      cancelUrl: 'https://app.sidekick.example/cancel',
    }, { authorization: 'Bearer user_access_token' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        return { id: userId, email: null };
      },
    },
  );

  // PREOP-C05 — a non-Stripe / failed checkout URL is a temporary
  // upstream-dependency failure, surfaced as a structured 503 (retry), not a
  // bare 502 gateway error that the client would echo to the user as "502".
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('location'), null);
});

test('billing portal route creates a customer portal session for authenticated subscribers only', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeBillingPortalRequest(
    jsonRequest('/api/stripe/portal', {
      returnUrl: 'https://app.sidekick.example/account/billing',
      stripeCustomerId: 'caller_supplied_customer_must_be_ignored',
    }, { authorization: 'Bearer user_access_token' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser(token) {
        assert.equal(token, 'user_access_token');
        return { id: userId, email: 'alex@example.com' };
      },
      async getBillingPortalSubscription(subscriptionUserId, token) {
        assert.equal(subscriptionUserId, userId);
        assert.equal(token, 'user_access_token');
        return { status: 'active', stripeCustomerId: 'cus_existing_route' };
      },
    },
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://billing.stripe.com/p/session/bps_test_route_123');
  assert.deepEqual(checkout.calls.portalCreate, [{
    configuration: 'bpc_Generic',
    customer: 'cus_existing_route',
    return_url: 'https://app.sidekick.example/account/billing',
  }]);
  assert.equal(checkout.calls.priceList.length, 0);
  assert.equal(checkout.calls.sessionCreate.length, 0);
});

test('billing portal route deep-links active subscribers into a target plan change', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeBillingPortalRequest(
    jsonRequest('/api/stripe/portal', {
      returnUrl: 'https://app.sidekick.example/account/billing',
      targetTierId: 'pro-office',
    }, { authorization: 'Bearer user_access_token', accept: 'application/json' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser(token) {
        assert.equal(token, 'user_access_token');
        return { id: userId, email: 'alex@example.com' };
      },
      async getBillingPortalSubscription(subscriptionUserId, token) {
        assert.equal(subscriptionUserId, userId);
        assert.equal(token, 'user_access_token');
        return {
          status: 'active',
          tierId: 'studio',
          stripeCustomerId: 'cus_existing_route',
          stripeSubscriptionId: 'sub_existing_route',
          priceId: 'price_current_studio',
        };
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://billing.stripe.com/p/session/bps_test_route_123' });
  assert.deepEqual(checkout.calls.priceList, [{
    lookup_keys: ['sidekick_pro_office_monthly'],
    active: true,
    limit: 1,
  }]);
  // No 'discounts' expand: since 2026-07-30 the portal tier-change path does not
  // read or re-apply the launch coupon at all, so it has nothing to inspect.
  assert.deepEqual(checkout.calls.subscriptionRetrieve, [{
    id: 'sub_existing_route',
    params: { expand: ['items.data.price'] },
  }]);
  assert.deepEqual(checkout.calls.portalCreate, [{
    configuration: 'bpc_Pro',
    customer: 'cus_existing_route',
    return_url: 'https://app.sidekick.example/account/billing',
    flow_data: {
      type: 'subscription_update_confirm',
      after_completion: {
        type: 'redirect',
        redirect: { return_url: 'https://app.sidekick.example/account/billing' },
      },
      subscription_update_confirm: {
        subscription: 'sub_existing_route',
        items: [{
          id: 'si_current_route_studio',
          price: 'price_test_route_pro',
          quantity: 1,
        }],
      },
    },
  }]);
  // 2026-07-30 defect: a tier change used to attach the launch coupon, which
  // RESTARTS the 2-month discount window for someone who already had it. The
  // promo belongs to a genuinely new customer's first Checkout only.
  const confirmedFlow = checkout.calls.portalCreate[0]?.flow_data?.subscription_update_confirm as
    { discounts?: unknown } | undefined;
  assert.equal('discounts' in (confirmedFlow ?? {}), false);
  assert.equal(JSON.stringify(checkout.calls.portalCreate).includes(SIDEKICK_LAUNCH_PROMO.stripeCouponId), false);
  assert.equal(checkout.calls.sessionCreate.length, 0);
});

test('billing portal route returns a JSON Stripe URL for mobile clients that ask for JSON', async () => {
  const checkout = createCheckoutClient();
  const response = await handleStripeBillingPortalRequest(
    jsonRequest('/api/stripe/portal', {
      returnUrl: 'https://app.sidekick.example/account/billing',
    }, { authorization: 'Bearer user_access_token', accept: 'application/json' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        return { id: userId, email: 'alex@example.com' };
      },
      async getBillingPortalSubscription() {
        return { status: 'active', stripeCustomerId: 'cus_existing_route' };
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await response.json(), { url: 'https://billing.stripe.com/p/session/bps_test_route_123' });
  assert.deepEqual(checkout.calls.portalCreate, [{
    configuration: 'bpc_Generic',
    customer: 'cus_existing_route',
    return_url: 'https://app.sidekick.example/account/billing',
  }]);
});

test('billing portal route fails closed without auth, allowed return URL, or existing Stripe customer', async () => {
  const unauthenticated = createCheckoutClient();
  const unauthenticatedResponse = await handleStripeBillingPortalRequest(
    jsonRequest('/api/stripe/portal', { returnUrl: 'https://app.sidekick.example/account/billing' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => unauthenticated.client,
      async getAuthenticatedUser() {
        throw new Error('auth should not run without a bearer token');
      },
      async getBillingPortalSubscription() {
        throw new Error('subscription lookup should not run without auth');
      },
    },
  );
  assert.equal(unauthenticatedResponse.status, 401);
  assert.equal(unauthenticated.calls.portalCreate.length, 0);

  const invalidReturn = createCheckoutClient();
  const invalidReturnResponse = await handleStripeBillingPortalRequest(
    jsonRequest('/api/stripe/portal', { returnUrl: 'https://evil.example/account/billing' }, { authorization: 'Bearer user_access_token' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => invalidReturn.client,
      async getAuthenticatedUser() {
        return { id: userId, email: null };
      },
      async getBillingPortalSubscription() {
        throw new Error('subscription lookup should not run when return URL is rejected');
      },
    },
  );
  assert.equal(invalidReturnResponse.status, 400);
  assert.equal(invalidReturn.calls.portalCreate.length, 0);

  const missingCustomer = createCheckoutClient();
  const missingCustomerResponse = await handleStripeBillingPortalRequest(
    jsonRequest('/api/stripe/portal', { returnUrl: 'https://app.sidekick.example/account/billing' }, { authorization: 'Bearer user_access_token' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => missingCustomer.client,
      async getAuthenticatedUser() {
        return { id: userId, email: null };
      },
      async getBillingPortalSubscription() {
        return { status: 'active', stripeCustomerId: null };
      },
    },
  );
  assert.equal(missingCustomerResponse.status, 409);
  assert.equal(missingCustomer.calls.portalCreate.length, 0);
  assert.doesNotMatch(await missingCustomerResponse.text(), /cus_|sk_test|service_role|whsec/i);
});

test('billing portal route refuses non-Stripe Billing Portal URLs returned by Stripe client', async () => {
  const checkout = createCheckoutClient({ portalUrl: 'https://evil.example/p/session/bps_test_route_123' });
  const response = await handleStripeBillingPortalRequest(
    jsonRequest('/api/stripe/portal', { returnUrl: 'https://app.sidekick.example/account/billing' }, { authorization: 'Bearer user_access_token' }),
    {
      env: checkoutEnv,
      createStripeBillingClient: () => checkout.client,
      ...checkout.purchaseDeps,
      async getAuthenticatedUser() {
        return { id: userId, email: null };
      },
      async getBillingPortalSubscription() {
        return { status: 'active', stripeCustomerId: 'cus_existing_route' };
      },
    },
  );

  // PREOP-C05 — see checkout-route note above; 503 (temporary), never raw 502.
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('location'), null);
});

test('webhook route verifies the raw Stripe body, records billing_events, and applies subscription and quota patches', async () => {
  const store = new InMemoryBillingStore();
  const event = checkoutCompletedEvent();
  const response = await handleStripeWebhookRequest(
    signedStripeRequest('/api/stripe/webhook', event, webhookEnv.STRIPE_WEBHOOK_SECRET!),
    webhookDeps(store),
  );

  assert.equal(response.status, 200);
  const ledger = store.events.get('evt_route_checkout_completed_123');
  assert.ok(ledger);
  assert.equal(ledger.status, 'processed');
  assert.match(ledger.payload_hash!, /^[a-f0-9]{64}$/);
  assert.equal(ledger.user_id, userId);
  assert.equal(store.entitlementCalls.length, 1);
  assert.deepEqual(store.entitlementCalls[0].subscription, {
    user_id: userId,
    status: 'active',
    tier_id: 'pro-office',
    stripe_customer_id: 'cus_test_route',
    stripe_subscription_id: 'sub_test_route',
    price_id: 'price_test_route_pro',
    current_period_start: new Date(0).toISOString(),
    current_period_end: new Date(3600 * 1000).toISOString(),
    cancel_at_period_end: false,
    updated_at: new Date(0).toISOString(),
    provider_updated_at: new Date(0).toISOString(),
  });
  assert.deepEqual(store.entitlementCalls[0].quota, {
    user_id: userId,
    tier_id: 'pro-office',
    monthly_token_quota: 48_000_000,
    storage_quota_bytes: 40 * 1024 ** 3,
    voice_seconds_quota: 10800,
    updated_at: new Date(0).toISOString(),
    provider_updated_at: new Date(0).toISOString(),
  });
  assert.equal(store.entitlementCalls[0].eventKey, 'stripe:evt_route_checkout_completed_123');
  assert.equal(store.entitlementCalls[0].allowProviderSwitch, true);
  assert.equal(store.entitlementCalls[0].retentionSeconds, 60 * 86400);
  assert.equal(store.subscriptions.length + store.usageQuotas.length + store.provisioningJobs.length, 0,
    'the handler must not make separate writes after the atomic RPC');
});

test('webhook route does not queue Hermes provisioning when a stale provider event does not update subscription state', async () => {
  class StaleSubscriptionStore extends InMemoryBillingStore {
    async applyEntitlement(_input: AtomicStripeEntitlementInput): Promise<BillingEntitlementResult> {
      return { outcome: 'ignored_stale', resumed: false };
    }
  }
  const store = new StaleSubscriptionStore();
  const response = await handleStripeWebhookRequest(
    signedStripeRequest('/api/stripe/webhook', checkoutCompletedEvent(), webhookEnv.STRIPE_WEBHOOK_SECRET!),
    webhookDeps(store),
  );

  assert.equal(response.status, 200);
  assert.equal(store.events.get('evt_route_checkout_completed_123')?.status, 'ignored');
  assert.equal(store.subscriptions.length, 0);
  assert.equal(store.usageQuotas.length, 0);
  assert.equal(store.provisioningJobs.length, 0);
});

test('webhook route leaves the ledger retryable when the entitlement transaction fails', async () => {
  class StaleUsageQuotaStore extends InMemoryBillingStore {
    async applyEntitlement(_input: AtomicStripeEntitlementInput): Promise<BillingEntitlementResult> {
      throw new Error('billing_entitlement_apply_failed_40001');
    }

    async enqueueHermesProvisioning(_job: HermesProvisioningJobRecord) {
      throw new Error('stale quota skip must not enqueue provisioning');
    }
  }
  const store = new StaleUsageQuotaStore();
  const response = await handleStripeWebhookRequest(
    signedStripeRequest('/api/stripe/webhook', checkoutCompletedEvent(), webhookEnv.STRIPE_WEBHOOK_SECRET!),
    webhookDeps(store),
  );

  assert.equal(response.status, 500);
  assert.equal(store.events.get('evt_route_checkout_completed_123')?.status, 'failed');
  assert.equal(store.events.get('evt_route_checkout_completed_123')?.error_code, 'billing_entitlement_apply_failed_40001');
  assert.equal(store.subscriptions.length, 0);
  assert.equal(store.usageQuotas.length, 0);
  assert.equal(store.provisioningJobs.length, 0);
  assert.deepEqual(store.provisioningEvents, []);
});

test('real Supabase Stripe store exposes recordProvisioningEvent for webhook skip observability', async () => {
  const inserts: Array<{ table: string; row: unknown }> = [];
  const store = createSupabaseStripeBillingStore({
    from(table: string) {
      return {
        async insert(row: unknown) {
          inserts.push({ table, row: structuredClone(row) });
          return { error: null };
        },
      };
    },
  });

  const recordProvisioningEvent = store.recordProvisioningEvent;
  if (typeof recordProvisioningEvent !== 'function') {
    throw new Error('expected recordProvisioningEvent to be implemented');
  }
  await recordProvisioningEvent({
    userId,
    event: 'hermes_provisioning_skipped',
    details: {
      reason: 'usage_quota_upsert_failed',
      subscriptionApplied: true,
      usageQuotaApplied: false,
      shouldPrepareCoworker: true,
      ledger_id: 'billing_event_1',
    },
  });

  assert.deepEqual(inserts, [
    {
      table: 'provisioning_events',
      row: {
        user_id: userId,
        event: 'hermes_provisioning_skipped',
        details: {
          reason: 'usage_quota_upsert_failed',
          subscriptionApplied: true,
          usageQuotaApplied: false,
          shouldPrepareCoworker: true,
          ledger_id: 'billing_event_1',
        },
      },
    },
  ]);
});

test('R-OBS-04 real Supabase Stripe webhook preserves upstream Supabase error code in failed billing ledger', async () => {
  const billingUpdates: Array<Record<string, unknown>> = [];
  const store = createSupabaseStripeBillingStore({
    async rpc(name: string) {
      assert.equal(name, 'apply_billing_entitlement');
      return { error: { code: '23503', message: `User ${userId} does not exist` } };
    },
    from(table: string) {
      if (table === 'billing_events') {
        return {
          insert(row: Record<string, unknown>) {
            return {
              select(_columns: string) {
                return {
                  async single() {
                    return {
                      error: null,
                      data: {
                        id: 'billing_event_postgrest_failure',
                        provider: row.provider,
                        provider_event_id: row.provider_event_id,
                        event_type: row.event_type,
                        idempotency_key: row.idempotency_key,
                        payload_hash: row.payload_hash,
                        status: 'processing',
                        user_id: row.user_id,
                        error_code: null,
                        processed_at: null,
                        processing_started_at: row.processing_started_at,
                        processing_expires_at: row.processing_expires_at,
                      },
                    };
                  },
                };
              },
            };
          },
          update(value: Record<string, unknown>) {
            billingUpdates.push(structuredClone(value));
            return {
              async eq(_column: string, _value: unknown) {
                return { error: null };
              },
            };
          },
        };
      }
      if (table === 'subscriptions') {
        return {
          async insert(_row: Record<string, unknown>) {
            return { error: null };
          },
        };
      }
      if (table === 'usage_quotas') {
        return {
          async insert(_row: Record<string, unknown>) {
            return {
              error: {
                code: '23503',
                message: 'insert or update on table "usage_quotas" violates foreign key constraint "usage_quotas_user_id_fkey"',
                details: `Key (user_id)=(${userId}) is not present in table "users".`,
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  });

  const response = await handleStripeWebhookRequest(
    signedStripeRequest('/api/stripe/webhook', checkoutCompletedEvent(), webhookEnv.STRIPE_WEBHOOK_SECRET!),
    webhookDeps(store),
  );

  assert.equal(response.status, 500);
  assert.match(String(billingUpdates.at(-1)?.error_code), /^billing_entitlement_apply_failed_23503/);
  assert.doesNotMatch(String(billingUpdates.at(-1)?.error_code), /11111111-1111-4111-8111-111111111111/);
});

test('webhook route treats duplicate processed events as retry-safe no-ops', async () => {
  const store = new InMemoryBillingStore();
  const event = checkoutCompletedEvent();

  const first = await handleStripeWebhookRequest(
    signedStripeRequest('/api/stripe/webhook', event, webhookEnv.STRIPE_WEBHOOK_SECRET!),
    webhookDeps(store),
  );
  const second = await handleStripeWebhookRequest(
    signedStripeRequest('/api/stripe/webhook', event, webhookEnv.STRIPE_WEBHOOK_SECRET!),
    webhookDeps(store),
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(store.events.size, 1);
  assert.equal(store.entitlementCalls.length, 1);
  assert.equal(store.subscriptions.length + store.usageQuotas.length + store.provisioningJobs.length, 0);
  assert.match(await second.text(), /duplicate/);
});

test('webhook route reclaims duplicate received events instead of dropping entitlements', async () => {
  const store = new InMemoryBillingStore();
  const event = checkoutCompletedEvent();
  const payload = JSON.stringify(event);
  store.events.set('evt_route_checkout_completed_123', {
    id: 'billing_event_existing',
    provider: 'stripe',
    provider_event_id: 'evt_route_checkout_completed_123',
    event_type: 'checkout.session.completed',
    idempotency_key: 'stripe:evt_route_checkout_completed_123',
    payload_hash: createHash('sha256').update(payload).digest('hex'),
    status: 'received',
    user_id: userId,
    processed_at: null,
  });

  const response = await handleStripeWebhookRequest(
    signedStripeRequest('/api/stripe/webhook', event, webhookEnv.STRIPE_WEBHOOK_SECRET!),
    webhookDeps(store),
  );

  assert.equal(response.status, 200);
  assert.equal(store.events.get('evt_route_checkout_completed_123')?.status, 'processed');
  assert.equal(store.entitlementCalls.length, 1);
  assert.equal(store.subscriptions.length + store.usageQuotas.length, 0);
});

test('webhook route does not acknowledge duplicate nonterminal events as processed', async () => {
  const store = new InMemoryBillingStore();
  const event = checkoutCompletedEvent();
  const payload = JSON.stringify(event);
  store.events.set('evt_route_checkout_completed_123', {
    id: 'billing_event_existing',
    provider: 'stripe',
    provider_event_id: 'evt_route_checkout_completed_123',
    event_type: 'checkout.session.completed',
    idempotency_key: 'stripe:evt_route_checkout_completed_123',
    payload_hash: createHash('sha256').update(payload).digest('hex'),
    status: 'processing',
    user_id: userId,
    processed_at: null,
    processing_started_at: new Date(0).toISOString(),
    processing_expires_at: new Date(5 * 60 * 1000).toISOString(),
  });

  const response = await handleStripeWebhookRequest(
    signedStripeRequest('/api/stripe/webhook', event, webhookEnv.STRIPE_WEBHOOK_SECRET!),
    webhookDeps(store),
  );

  assert.equal(response.status, 500);
  assert.equal(store.subscriptions.length, 0);
  assert.equal(store.usageQuotas.length, 0);
  assert.match(await response.text(), /retryable/);
});

test('webhook route rejects invalid signatures before any Supabase writes', async () => {
  const store = new InMemoryBillingStore();
  const event = checkoutCompletedEvent();
  const payload = JSON.stringify(event);
  const response = await handleStripeWebhookRequest(
    new Request('https://dashboard.sidekick.example/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'bad_signature' },
      body: payload,
    }),
    webhookDeps(store),
  );

  assert.equal(response.status, 400);
  assert.equal(store.events.size, 0);
  assert.equal(store.subscriptions.length, 0);
  assert.doesNotMatch(await response.text(), /whsec|service_role/i);
});

test('webhook route records incomplete provider entitlements as ignored without patching subscription state', async () => {
  const store = new InMemoryBillingStore();
  const event = checkoutCompletedEvent({
    data: {
      object: {
        id: 'cs_test_route_123',
        client_reference_id: userId,
        customer: 'cus_test_route',
        subscription: {
          id: 'sub_test_route',
          status: 'active',
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

  const response = await handleStripeWebhookRequest(
    signedStripeRequest('/api/stripe/webhook', event, webhookEnv.STRIPE_WEBHOOK_SECRET!),
    webhookDeps(store),
  );

  assert.equal(response.status, 200);
  const ledger = store.events.get('evt_route_checkout_completed_123');
  assert.ok(ledger);
  assert.equal(ledger.status, 'ignored');
  assert.equal(ledger.error_code, 'incomplete_provider_entitlement');
  assert.equal(store.subscriptions.length, 0);
  assert.equal(store.usageQuotas.length, 0);
});

test('Supabase store orders subscription writes by provider_updated_at, not trigger-managed updated_at', async () => {
  const operations: { op: string; table: string; value?: unknown }[] = [];
  const client = {
    from(table: string) {
      return {
        insert(value: unknown) {
          operations.push({ op: 'insert', table, value });
          return { error: { code: '23505' } };
        },
        update(value: unknown) {
          operations.push({ op: 'update', table, value });
          return {
            eq(column: string, value: unknown) {
              operations.push({ op: 'eq', table, value: { column, value } });
              return {
                or(filter: string) {
                  operations.push({ op: 'or', table, value: filter });
                  return {
                    select(columns: string) {
                      operations.push({ op: 'select', table, value: columns });
                      return { data: [{ user_id: userId }], error: null };
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
  const store = createSupabaseStripeBillingStore(client);
  await store.upsertSubscription({
    user_id: userId,
    status: 'active',
    tier_id: 'pro-office',
    stripe_customer_id: 'cus_test_route',
    stripe_subscription_id: 'sub_test_route',
    price_id: 'price_test_route_pro',
    current_period_start: new Date(0).toISOString(),
    current_period_end: new Date(3600 * 1000).toISOString(),
    cancel_at_period_end: false,
    updated_at: '2099-01-01T00:00:00.000Z',
    provider_updated_at: '2026-05-06T00:00:00.000Z',
  });

  assert.deepEqual(operations.find((operation) => operation.op === 'or'), {
    op: 'or',
    table: 'subscriptions',
    value: 'provider_updated_at.is.null,provider_updated_at.lte.2026-05-06T00:00:00.000Z',
  });
});

test('Supabase store keeps Stripe provider IDs out of user-readable provisioning event details', async () => {
  const operations: { op: string; table: string; value?: any }[] = [];
  const client = {
    from(table: string) {
      return {
        update(value: any) {
          operations.push({ op: 'update', table, value });
          return {
            eq(column: string, value: unknown) {
              operations.push({ op: 'eq', table, value: { column, value } });
              return {
                in(column: string, value: unknown) {
                  const values = Array.isArray(value) ? value : [];
                  operations.push({ op: 'in', table, value: { column, value } });
                  return {
                    select(value: string) {
                      operations.push({ op: 'select', table, value });
                      return {
                        async maybeSingle() {
                          return values.includes('queued')
                            ? { data: { user_id: userId }, error: null }
                            : { data: null, error: null };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
        insert(value: any) {
          operations.push({ op: 'insert', table, value });
          return { error: null };
        },
      };
    },
  };
  const store = createSupabaseStripeBillingStore(client);
  await store.enqueueHermesProvisioning({
    user_id: userId,
    tier_id: 'pro-office',
    billing_event_id: 'billing_event_private_123',
    provider_event_id: 'evt_private_123',
    idempotency_key: 'hermes-provisioning:evt_private_123',
    requested_at: '2026-05-06T00:00:00.000Z',
    public_status_message: "Your coworker's cloud computer is queued for setup.",
  });

  const statusGate = operations.find((operation) => operation.op === 'in' && operation.table === 'hermes_instances');
  assert.deepEqual(statusGate?.value, {
    column: 'status',
    value: ['not_requested', 'error', 'queued', 'deleted'],
  });

  const eventInsert = operations.find((operation) => operation.op === 'insert' && operation.table === 'provisioning_events');
  assert.deepEqual(eventInsert?.value.details, {
    tier_id: 'pro-office',
    requested_at: '2026-05-06T00:00:00.000Z',
    reason: 'stripe_entitlement_active',
  });
  assert.doesNotMatch(JSON.stringify(eventInsert?.value), /billing_event_private_123|evt_private_123|hermes-provisioning/);
});

function webhookDeps(store: StripeBillingStore) {
  const stripe = new Stripe('sk_test_fake_route_secret', { apiVersion: '2026-04-22.dahlia' });
  return {
    env: webhookEnv,
    store,
    verifyStripeWebhookEvent(rawBody: string, signature: string, webhookSecret: string) {
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },
  };
}

function checkoutCompletedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_route_checkout_completed_123',
    type: 'checkout.session.completed',
    created: 0,
    data: {
      object: {
        id: 'cs_test_route_123',
        client_reference_id: userId,
        customer: 'cus_test_route',
        subscription: {
          id: 'sub_test_route',
          status: 'active',
          current_period_start: 0,
          current_period_end: 3600,
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: {
                  id: 'price_test_route_pro',
                  lookup_key: 'sidekick_pro_office_monthly',
                },
              },
            ],
          },
        },
        metadata: {
          priceLookupKey: 'sidekick_pro_office_monthly',
        },
      },
    },
    ...overrides,
  };
}
