// Apple in-app purchase: the Worker contracts.
//
// What is worth testing here is not "does it parse JSON". It is the four ways
// this path could quietly give somebody a paid workspace for nothing:
//
//   1. Trusting a payload that arrived instead of what Apple says.
//   2. Defaulting an unknown product id to a tier.
//   3. Letting one Apple ID entitle several accounts.
//   4. An empty allowlist reading as "everybody" rather than "nobody".
//
// Plus the one that would produce a paying customer with no workspace: an
// activation that writes the subscription and forgets the quota or the
// provisioning enqueue.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../dist/index.js';

import {
  appleIapAllowlist,
  appleStatusToSubscriptionStatus,
  applyAppleEntitlement,
  decodeJwsPayloadUnverified,
  handleAppleNotification,
  isUserAllowlistedForAppleIap,
  mintAppleStoreKitToken,
  verifyAndRecordApplePurchase,
  fetchAppleSubscriptionState,
} from '../dist/apple-iap.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

// A real ES256 key. Generated for this test file only and used nowhere else;
// it signs nothing that leaves the process. The release gate scans for
// secret-shaped literals, and a PRIVATE KEY block in a test is exactly the
// shape it flags, so this is generated at runtime instead of pasted in.
async function testKeyPem() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let binary = '';
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const b64 = btoa(binary).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jws(payload) {
  return `${b64url({ alg: 'ES256' })}.${b64url(payload)}.signature-not-checked`;
}

function transactionPayload(overrides = {}) {
  return {
    transactionId: 'tx-1',
    originalTransactionId: 'orig-1',
    bundleId: 'com.sidekick.v2',
    productId: 'com.sidekick.v2.studio.monthly',
    type: 'Auto-Renewable Subscription',
    purchaseDate: Date.now() - 20 * 86_400_000,
    expiresDate: Date.now() + 10 * 86_400_000,
    environment: 'Sandbox',
    ...overrides,
  };
}

// Apple and atomic-database HTTP boundaries. These tests inspect requests and
// outcomes; the actual writes and races are covered by tests/database.
function harness({
  transaction,
  subscriptionTransaction = null,
  subscriptionLookupStatus = 200,
  subscriptionStatus = 1,
  existingOwner = null,
  appleStatus = 200,
  ownerLookupStatus = 200,
  ownerLookupBody = undefined,
  // Apple's signed renewal info for the subscription, e.g. { autoRenewStatus: 0 }
  // for a customer who has switched auto-renew off. Null omits it entirely.
  renewalInfo = null,
  purchaseOwnerRows = [],
  purchaseOwnerStatus = 200,
  entitlementStatus = 200,
  entitlementResult = { outcome: 'applied', resumed: false },
} = {}) {
  const writes = [], reads = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if ((init.method ?? 'GET') === 'GET') reads.push(href);

    if (href.includes('/inApps/v1/transactions/')) {
      if (appleStatus !== 200) {
        return new Response(JSON.stringify({ errorCode: 4040010 }), { status: appleStatus });
      }
      return new Response(JSON.stringify({ signedTransactionInfo: jws(transaction) }), { status: 200 });
    }

    if (href.includes('/inApps/v1/subscriptions/')) {
      if (subscriptionLookupStatus !== 200) return new Response('{}', { status: subscriptionLookupStatus });
      return new Response(JSON.stringify({
        data: [{ lastTransactions: [{
          originalTransactionId: transaction.originalTransactionId,
          status: subscriptionStatus,
          signedTransactionInfo: jws(subscriptionTransaction ?? transaction),
          ...(renewalInfo ? { signedRenewalInfo: jws(renewalInfo) } : {}),
        }] }],
      }), { status: 200 });
    }

    if (href.includes('/rest/v1/billing_purchase_intents')) {
      if (purchaseOwnerStatus === 'network') throw new Error('purchase owner connection lost');
      return new Response(JSON.stringify(purchaseOwnerRows), { status: purchaseOwnerStatus });
    }
    if (href.includes('/rest/v1/billing_subscription_ownership')) {
      return new Response(JSON.stringify(ownerLookupBody ?? (existingOwner ? [{ user_id: existingOwner, provider_environment: 'Sandbox' }] : [])), { status: ownerLookupStatus });
    }
    if ((init.method ?? 'GET') === 'GET') throw new Error('Unmocked Apple read: '+href);

    writes.push({ url: href, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (href.includes('/rpc/apply_billing_entitlement')) {
      return new Response(JSON.stringify(entitlementResult), { status: entitlementStatus });
    }
    // 204 must carry a null body or the Response constructor throws, which
    // looks like a bug in the code under test rather than in this harness.
    return new Response(null, { status: 204 });
  };

  return {
    reads,
    writes,
    entitlements() { return writes.filter((w) => w.url.includes('/rpc/apply_billing_entitlement')).map((w) => w.body); },
    restore() { globalThis.fetch = originalFetch; },
    table(fragment) { return writes.filter((w) => w.url.includes(fragment)); },
  };
}

async function env(overrides = {}) {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-value-for-test',
    APPLE_IAP_KEY_P8: await testKeyPem(),
    APPLE_IAP_KEY_ID: 'KEYID12345',
    APPLE_IAP_ISSUER_ID: 'issuer-id',
    SIDEKICK_APPLE_IAP_ALLOWLIST: USER,
    SIDEKICK_APPLE_IAP_ENVIRONMENT: 'Sandbox',
    ...overrides,
  };
}

test('an empty allowlist means nobody, never everybody', async () => {
  const base = await env({ SIDEKICK_APPLE_IAP_ALLOWLIST: '' });
  assert.equal(appleIapAllowlist(base).length, 0);
  assert.equal(isUserAllowlistedForAppleIap(base, USER), false);

  // And with the variable absent entirely, which is the state of a Worker
  // deployed before anyone sets it.
  const absent = await env();
  delete absent.SIDEKICK_APPLE_IAP_ALLOWLIST;
  assert.equal(isUserAllowlistedForAppleIap(absent, USER), false);
});

test("'*' opens Apple billing to everybody, and only that exact value does", async () => {
  // REQUIRED FOR APP REVIEW. The reviewer's account is not one of ours and
  // cannot be added in advance, so an id-only allowlist answers their purchase
  // with 403 "In-app purchase is not enabled for this account yet", which is an
  // automatic second Guideline 3.1.1 rejection for an app whose StoreKit works.
  const open = await env({ SIDEKICK_APPLE_IAP_ALLOWLIST: '*' });
  assert.equal(isUserAllowlistedForAppleIap(open, USER), true);
  assert.equal(isUserAllowlistedForAppleIap(open, 'anyone-at-all'), true);

  // Mixed with ids, so switching it on does not mean deleting the old value.
  const mixed = await env({ SIDEKICK_APPLE_IAP_ALLOWLIST: `${USER}, *` });
  assert.equal(isUserAllowlistedForAppleIap(mixed, OTHER_USER), true);

  // Nothing NEAR it opens the gate. A typo must fail closed, not open.
  for (const nearly of ['**', '"*"', 'all', 'true', '.*', 'ALL']) {
    const typo = await env({ SIDEKICK_APPLE_IAP_ALLOWLIST: nearly });
    assert.equal(
      isUserAllowlistedForAppleIap(typo, OTHER_USER), false,
      `${JSON.stringify(nearly)} must not admit an unlisted user`,
    );
  }
});

test('the allowlist admits only the named user', async () => {
  const base = await env({ SIDEKICK_APPLE_IAP_ALLOWLIST: ` ${USER} , ${OTHER_USER} ` });
  assert.equal(isUserAllowlistedForAppleIap(base, USER), true);
  assert.equal(isUserAllowlistedForAppleIap(base, OTHER_USER), true);
  assert.equal(isUserAllowlistedForAppleIap(base, '33333333-3333-4333-8333-333333333333'), false);
});

test('a non-allowlisted user is refused before Apple is ever called', async () => {
  const h = harness({ transaction: transactionPayload() });
  try {
    const result = await verifyAndRecordApplePurchase(
      await env({ SIDEKICK_APPLE_IAP_ALLOWLIST: OTHER_USER }), USER, 'tx-1',
    );
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'not_allowlisted');
    assert.equal(result.status, 403);
    assert.equal(h.writes.length, 0, 'a refused user must not produce any write');
  } finally {
    h.restore();
  }
});

test('an unknown product id grants nothing rather than defaulting to a tier', async () => {
  const h = harness({ transaction: transactionPayload({ productId: 'com.sidekick.v2.not.a.real.plan' }) });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'unknown_product_id');
    assert.equal(h.entitlements().length, 0);
    assert.equal(h.entitlements().length, 0);
  } finally {
    h.restore();
  }
});

test('a bundle id from another app is refused', async () => {
  const h = harness({ transaction: transactionPayload({ bundleId: 'com.someone.else' }) });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'bundle_id_mismatch');
  } finally {
    h.restore();
  }
});

test('one Apple subscription cannot entitle a second account', async () => {
  const h = harness({ transaction: transactionPayload(), existingOwner: OTHER_USER });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'already_claimed_by_another_account');
    assert.equal(result.status, 409);
    assert.equal(h.entitlements().length, 0);
  } finally {
    h.restore();
  }
});

// The double-billing guard.
//
// Each account has one current entitlement. Reject an Apple purchase while
// its Stripe subscription is still entitled. A provider-confirmed payment
// reaches the atomic fence, which preserves current service and records conflict.
// Historical ownership remains separate when the current provider changes.

test('a live Stripe subscriber is refused by the atomic paid-conflict fence', async () => {
  const h = harness({
    transaction: transactionPayload(),
    entitlementResult: { outcome: 'purchase_conflict', resumed: false },
  });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'billing_purchase_conflict');
    assert.equal(result.status, 503);
    assert.equal(h.entitlements().length, 1, 'verified payment reaches the atomic fence');
    assert.equal(h.entitlements()[0].p_subscription.apple_original_transaction_id, 'orig-1');
    assert.ok(h.table('/rest/v1/apple_iap_events').every(write => write.body.applied === false));
    assert.equal(h.table('/rest/v1/hermes_instances').length, 0);
  } finally {
    h.restore();
  }
});

test('a network failure resolving durable purchase ownership remains retryable', async () => {
  const h = harness({ transaction: transactionPayload({ appAccountToken: OTHER_USER }), purchaseOwnerStatus: 'network' });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.status, 503);
    assert.equal(result.outcome, 'apple_purchase_owner_unavailable');
    assert.equal(h.entitlements().length, 0);
  } finally { h.restore(); }
});

test('authenticated legacy restore requests the atomic inactive-provider switch policy', async () => {
  const h = harness({
    transaction: transactionPayload(),
  });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, true);
    assert.equal(h.entitlements().length, 1);
    assert.equal(h.entitlements()[0].p_allow_provider_switch, true);
  } finally {
    h.restore();
  }
});

test("authenticated restore of an owned Apple subscription reaches the atomic renewal policy", async () => {
  const h = harness({
    transaction: transactionPayload(),
    existingOwner: USER,
  });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, true, 'Apple re-verifying its own active subscription must stay idempotent');
  } finally {
    h.restore();
  }
});

test('a failed atomic entitlement write stays retryable rather than reporting delivery', async () => {
  const h = harness({ transaction: transactionPayload(), entitlementStatus: 503 });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'billing_entitlement_apply_failed');
    assert.equal(result.status, 503);
    // A failed atomic transaction remains retryable and is never reported delivered.
    assert.equal(h.entitlements().length, 1);
    assert.ok(h.table('/rest/v1/apple_iap_events').every(write => write.body.applied === false));
  } finally {
    h.restore();
  }
});

test('a successful purchase writes subscription, quota AND provisioning', async () => {
  const h = harness({ transaction: transactionPayload() });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, true);
    assert.equal(result.tierId, 'studio');

    const subscription = h.entitlements()[0]?.p_subscription;
    assert.ok(subscription, 'subscription row must be written');
    assert.equal(subscription.billing_provider, 'apple');
    assert.equal(subscription.status, 'active');
    assert.equal(subscription.apple_original_transaction_id, 'orig-1');
    assert.equal(subscription.apple_environment, 'Sandbox');
    assert.ok(subscription.current_period_start, 'period start is required by the 0054 constraint');
    assert.ok(subscription.current_period_end, 'period end is required by the 0054 constraint');

    const quota = h.entitlements()[0]?.p_quota;
    assert.ok(quota, 'a subscription without its quota leaves a paying user with no allowance');
    assert.equal(quota.tier_id, 'studio');
    assert.equal(quota.storage_quota_bytes, 10 * 1024 ** 3);

    assert.equal(h.entitlements().length, 1, 'subscription, quota and provisioning share one transaction');
    assert.equal(h.entitlements()[0].p_allow_provider_switch, true);
    assert.equal(h.table('/rest/v1/subscriptions').length + h.table('/rest/v1/usage_quotas').length + h.table('/rest/v1/hermes_instances').length, 0, 'no separate writes can partially apply');
  } finally {
    h.restore();
  }
});

test('a customer who switched auto-renew off is written as ending, not renewing', async () => {
  // Every Apple row used to be written with cancel_at_period_end=false, so the
  // Profile screen told a customer who had cancelled in Settings that their
  // monthly time would reset on a date their plan was going to end on.
  const h = harness({ transaction: transactionPayload(), renewalInfo: { autoRenewStatus: 0 } });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, true);
    const subscription = h.entitlements()[0]?.p_subscription;
    assert.equal(subscription.status, 'active', 'still entitled until the period ends');
    assert.equal(subscription.cancel_at_period_end, true);
  } finally {
    h.restore();
  }
});

test('auto-renew on, or no renewal info at all, keeps the row renewing', async () => {
  for (const renewalInfo of [{ autoRenewStatus: 1 }, null]) {
    const h = harness({ transaction: transactionPayload(), renewalInfo });
    try {
      await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
      const subscription = h.entitlements()[0]?.p_subscription;
      assert.equal(subscription.cancel_at_period_end, false, JSON.stringify(renewalInfo));
    } finally {
      h.restore();
    }
  }
});

test('a renewal notification carries the auto-renew state from Apple, not from the notification', async () => {
  const h = harness({ transaction: transactionPayload(), existingOwner: USER, renewalInfo: { autoRenewStatus: 0 } });
  try {
    const result = await handleAppleNotification(await env(), jws({
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      subtype: 'AUTO_RENEW_DISABLED',
      notificationUUID: 'n-renew-off',
      data: { originalTransactionId: 'orig-1', environment: 'Sandbox' },
    }));
    assert.equal(result.ok, true);
    const subscription = h.entitlements()[0]?.p_subscription;
    assert.equal(subscription.cancel_at_period_end, true);
  } finally {
    h.restore();
  }
});

test('a transaction Apple has never heard of grants nothing', async () => {
  const h = harness({ transaction: transactionPayload(), appleStatus: 404 });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'forged-transaction');
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'apple_transaction_not_found');
    assert.equal(h.entitlements().length, 0);
  } finally {
    h.restore();
  }
});

test('an activation missing period bounds is refused, not sent to Postgres', async () => {
  // The 0054 constraint would reject this anyway, but as an opaque 400 that
  // reads like an auth problem. Refuse it here where the reason is legible.
  const h = harness({ transaction: transactionPayload({ expiresDate: null }) });
  try {
    const result = await applyAppleEntitlement(await env(), {
      userId: USER, tierId: 'studio', status: 'active',
      info: {
        transactionId: 'tx-1', originalTransactionId: 'orig-1', bundleId: 'com.sidekick.v2',
        productId: 'com.sidekick.v2.studio.monthly', type: 'Auto-Renewable Subscription',
        purchaseDate: Date.parse('2026-08-18T00:00:00Z'), expiresDate: null,
        environment: 'Sandbox', revocationDate: null, revocationReason: null,
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.detail, 'apple_transaction_missing_period_bounds');
    assert.equal(h.writes.length, 0);
  } finally {
    h.restore();
  }
});

test('Apple status codes map to the honest subscription status', () => {
  assert.equal(appleStatusToSubscriptionStatus(1), 'active');
  // Grace period: the customer still has service while Apple retries the card.
  assert.equal(appleStatusToSubscriptionStatus(4), 'active');
  assert.equal(appleStatusToSubscriptionStatus(3), 'past_due');
  assert.equal(appleStatusToSubscriptionStatus(2), 'canceled');
  assert.equal(appleStatusToSubscriptionStatus(5), 'canceled');
  assert.equal(appleStatusToSubscriptionStatus(0), 'canceled');
});

test('a notification for a subscription we do not hold changes nothing, and does not ask Apple to retry', async () => {
  const h = harness({ transaction: transactionPayload({ originalTransactionId: 'orig-unknown' }) });
  try {
    const result = await handleAppleNotification(await env(), jws({
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid-1',
      data: { originalTransactionId: 'orig-unknown', environment: 'Sandbox' },
    }));
    assert.equal(result.outcome, 'no_local_subscription');
    assert.equal(result.status, 200, 'retrying cannot fix this, so Apple must not be told to');
    assert.equal(h.entitlements().length, 0);
  } finally {
    h.restore();
  }
});

test('restoring an older receipt uses the current transaction for both product and quota', async () => {
  const h = harness({
    transaction: transactionPayload(),
    subscriptionTransaction: transactionPayload({ transactionId: 'tx-current', productId: 'com.sidekick.v2.max.monthly' }),
  });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, true);
    assert.equal(result.tierId, 'enterprise-suite');
    assert.equal(h.entitlements()[0].p_subscription.tier_id, 'enterprise-suite');
    assert.equal(h.entitlements()[0].p_quota.monthly_token_quota, 100_000_000);
  } finally { h.restore(); }
});

test('subscription lookup failure cannot overwrite the current plan from an older receipt', async () => {
  const h = harness({ transaction: transactionPayload(), subscriptionLookupStatus: 503 });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.status, 503);
    assert.equal(h.entitlements().length, 0);
    assert.equal(h.entitlements().length, 0);
  } finally { h.restore(); }
});

test('a current subscription response cannot substitute another owner, bundle or environment', async () => {
  for (const override of [
    { originalTransactionId: 'another-original' }, { bundleId: 'another.bundle' },
    { environment: 'Production' }, { productId: 'unknown.product' },
  ]) {
    const h = harness({ transaction: transactionPayload(), subscriptionTransaction: transactionPayload(override) });
    try {
      const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
      assert.equal(result.ok, false);
      assert.equal(result.status, 503);
      assert.equal(h.entitlements().length, 0);
    } finally { h.restore(); }
  }
});

test('failed or malformed Apple ownership reads stay retryable for purchase and notification', async () => {
  for (const failure of [{ ownerLookupStatus: 503 }, { ownerLookupBody: { error: 'bad shape' } }, { ownerLookupBody: [{}] }]) {
    const h = harness({ transaction: transactionPayload(), ...failure });
    try {
      const purchase = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
      assert.equal(purchase.status, 503);
      const notification = await handleAppleNotification(await env(), jws({ data: { originalTransactionId: 'orig-1' } }));
      assert.equal(notification.status, 503);
      assert.equal(notification.outcome, 'apple_owner_lookup_unavailable');
      assert.equal(h.entitlements().length, 0);
      assert.equal(h.entitlements().length, 0);
    } finally { h.restore(); }
  }
});

test('Apple renewal grace expiry is retained as a separate verified provider fact', async () => {
  const grace = Date.now() + 86_400_000;
  const transaction = transactionPayload();
  const h = harness({ transaction, subscriptionStatus: 4,
    renewalInfo: { autoRenewStatus: 1, originalTransactionId: 'orig-1', gracePeriodExpiresDate: grace } });
  try {
    const state = await fetchAppleSubscriptionState(await env(), 'orig-1', 'Sandbox');
    assert.equal(state.gracePeriodExpiresDate, grace);
    assert.equal(state.info.expiresDate, transaction.expiresDate);
  } finally { h.restore(); }
});

test('a renewal notification is applied from Apple, not from the notification body', async () => {
  // The notification CLAIMS Max. Apple says Studio. Studio must win: otherwise
  // anyone who can post JSON at us can upgrade themselves.
  const h = harness({ transaction: transactionPayload(), existingOwner: USER });
  try {
    const result = await handleAppleNotification(await env(), jws({
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid-2',
      data: {
        originalTransactionId: 'orig-1',
        environment: 'Sandbox',
        signedTransactionInfo: jws(transactionPayload({ productId: 'com.sidekick.v2.max.monthly' })),
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.tierId, 'studio', 'the tier must come from Apple, not from the payload');

    const quota = h.entitlements()[0]?.p_quota;
    assert.equal(quota.tier_id, 'studio');
    assert.equal(quota.storage_quota_bytes, 10 * 1024 ** 3, 'Max storage here would prove the payload was trusted');
  } finally {
    h.restore();
  }
});

test('an expired subscription revokes the entitlement without re-queuing a workspace', async () => {
  const h = harness({ transaction: transactionPayload(), subscriptionStatus: 2, existingOwner: USER });
  try {
    const result = await handleAppleNotification(await env(), jws({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-3',
      data: { originalTransactionId: 'orig-1', environment: 'Sandbox' },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'applied:canceled');

    const subscription = h.entitlements()[0]?.p_subscription;
    assert.equal(subscription.status, 'canceled');
    assert.equal(h.table('/rest/v1/hermes_instances').length, 0,
      'a cancelled subscription must not queue a new workspace');
  } finally {
    h.restore();
  }
});

test('an undecodable payload is a 400, not a crash', async () => {
  assert.equal(decodeJwsPayloadUnverified('not-a-jws'), null);
  assert.equal(decodeJwsPayloadUnverified(null), null);
  assert.equal(decodeJwsPayloadUnverified('a.b'), null);

  const result = await handleAppleNotification(await env(), 'garbage');
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('the Apple token carries the bundle id and a backdated iat', async () => {
  const now = Date.parse('2026-08-18T12:00:00Z');
  const token = await mintAppleStoreKitToken(await env(), now);
  const [header, payload] = token.split('.').slice(0, 2)
    .map((segment) => JSON.parse(Buffer.from(segment, 'base64url').toString()));

  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'KEYID12345');
  // `bid` is required by the App Store Server API and absent from a plain App
  // Store Connect token. Omitting it is a 401 that reads like a bad key.
  assert.equal(payload.bid, 'com.sidekick.v2');
  assert.equal(payload.aud, 'appstoreconnect-v1');
  // Backdated, because Apple rejects tokens issued in its own future and this
  // box's clock has run ahead before.
  assert.equal(payload.iat, Math.floor(now / 1000) - 60);
  assert.ok(payload.exp - payload.iat <= 1200, 'Apple caps token lifetime at 20 minutes');
});

test('a purchase with no key configured cannot be verified at all', async () => {
  const base = await env();
  delete base.APPLE_IAP_KEY_P8;
  const h = harness({ transaction: transactionPayload() });
  try {
    await assert.rejects(
      () => mintAppleStoreKitToken(base),
      /apple_iap_key_not_configured/,
    );
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// Runner lifecycle parity with the Stripe webhook (defect hunt 2026-09-03).
//
// The Stripe path resumes a sleeping runner on renewal and suspends it on a
// final cancel. The Apple path wrote the subscription row and stopped, so an
// Apple customer who lapsed and bought again stayed on "workspace retained"
// for good (the provisioning PATCH excludes 'sleeping' on purpose), and an
// Apple cancellation left the Machine running until the daily dunning sweep.
// ---------------------------------------------------------------------------

test('a purchase asks the database to RESUME a sleeping runner, so a lapsed Apple customer comes back online', async () => {
  const h = harness({ transaction: transactionPayload() });
  try {
    const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
    assert.equal(result.ok, true);

    const [request] = h.entitlements();
    assert.ok(request, 'the atomic transaction must handle returning and first-time customers');
    assert.equal(request.p_subscription.user_id, USER);
    assert.equal(request.p_subscription.status, 'active');
    assert.equal(h.entitlements().length, 1);
    assert.equal(h.table('/rest/v1/hermes_instances').length, 0);
  } finally {
    h.restore();
  }
});

test('an expired subscription SUSPENDS the runner with the 60-day retention window, like the Stripe webhook', async () => {
  const h = harness({ transaction: transactionPayload(), subscriptionStatus: 2, existingOwner: USER });
  try {
    const result = await handleAppleNotification(await env(), jws({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-suspend',
      data: { originalTransactionId: 'orig-1', environment: 'Sandbox' },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'applied:canceled');

    const [request] = h.entitlements();
    assert.equal(request.p_subscription.user_id, USER);
    assert.equal(request.p_subscription.status, 'canceled');
    assert.equal(request.p_retention_seconds, 60 * 86400);
    assert.equal(request.p_allow_provider_switch, false);
    assert.equal(h.entitlements().length, 1);
  } finally {
    h.restore();
  }
});

test('the Apple retention window honours SIDEKICK_FLY_VOLUME_RETENTION_DAYS and defaults to 60', async () => {
  const { resolveAppleSuspendRetentionSeconds } = await import('../dist/apple-iap.js');
  assert.equal(resolveAppleSuspendRetentionSeconds({}), 60 * 86_400);
  assert.equal(resolveAppleSuspendRetentionSeconds({ SIDEKICK_FLY_VOLUME_RETENTION_DAYS: '30' }), 30 * 86_400);
  assert.equal(resolveAppleSuspendRetentionSeconds({ SIDEKICK_FLY_VOLUME_RETENTION_DAYS: 'nonsense' }), 60 * 86_400);
});

test('failed or malformed atomic writes remain retryable for Apple purchase and notification', async () => {
  for (const failure of [
    { entitlementStatus: 503 },
    { entitlementResult: null },
    { entitlementResult: { outcome: 'unknown', resumed: false } },
    { entitlementResult: { outcome: 'provider_conflict', resumed: false } },
    { entitlementResult: { outcome: 'purchase_conflict', resumed: false } },
  ]) {
    const h = harness({ transaction: transactionPayload(), existingOwner: USER, ...failure });
    try {
      const purchase = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
      assert.equal(purchase.ok, false);
      assert.equal(purchase.status, 503);
      const notification = await handleAppleNotification(await env(), jws({ data: { originalTransactionId: 'orig-1' } }));
      assert.equal(notification.status, 503);
      assert.ok(h.table('/rest/v1/apple_iap_events').every((w) => w.body.applied === false));
    } finally { h.restore(); }
  }
});

test('a deleted original Apple owner cannot be replaced with another account', async () => {
  const h = harness({ transaction: transactionPayload(), ownerLookupBody: [{ user_id: null }] });
  try {
    assert.equal((await verifyAndRecordApplePurchase(await env(), USER, 'tx-1')).status, 409);
    assert.equal(h.entitlements().length, 0);
  } finally { h.restore(); }
});

test('an old subscription notification acknowledged as historical does not claim current activation', async () => {
  const h = harness({ transaction: transactionPayload(), existingOwner: USER,
    entitlementResult: { outcome: 'ignored_historical', resumed: false } });
  try {
    const result = await handleAppleNotification(await env(), jws({ data: { originalTransactionId: 'orig-1' } }));
    assert.equal(result.status, 200);
    assert.equal(result.outcome, 'ignored_historical');
    assert.ok(h.table('/rest/v1/apple_iap_events').every((w) => w.body.applied === false));
  } finally { h.restore(); }
});

test('purchase and notification retain valid trial or paid Apple grace without changing the billing period', async () => {
  const now = Date.now();
  for (const offerDiscountType of ['FREE_TRIAL', 'PAY_AS_YOU_GO']) {
    for (const notification of [false, true]) {
      const tx = transactionPayload({ offerDiscountType, purchaseDate: now - 5 * 86_400_000, expiresDate: now - 86_400_000 });
      const grace = now + 86_400_000;
      const h = harness({ transaction: tx, subscriptionStatus: 4, existingOwner: USER,
        renewalInfo: { originalTransactionId: 'orig-1', gracePeriodExpiresDate: grace } });
      try {
        const result = notification
          ? await handleAppleNotification(await env(), jws({ notificationType: 'DID_FAIL_TO_RENEW', notificationUUID: 'grace',
            data: { originalTransactionId: 'orig-1', environment: 'Sandbox' } }))
          : await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
        assert.equal(result.ok, true);
        const sub = h.entitlements()[0].p_subscription;
        assert.equal(sub.status, offerDiscountType === 'FREE_TRIAL' ? 'trialing' : 'active');
        assert.equal(sub.service_access_until, new Date(grace).toISOString());
        assert.equal(sub.current_period_start, new Date(tx.purchaseDate).toISOString());
        assert.equal(sub.current_period_end, new Date(tx.expiresDate).toISOString());
        if (!notification) assert.equal(result.expiresAt, sub.service_access_until);
      } finally { h.restore(); }
    }
  }
});

test('missing grace remains retryable, while expired grace and billing retry revoke service', async () => {
  for (const [statusCode, grace, expected] of [[4, null, null], [4, Date.now() - 1, 'canceled'], [3, null, 'canceled']]) {
    const h = harness({ transaction: transactionPayload({ expiresDate: Date.now() - 86_400_000 }),
      subscriptionStatus: statusCode, renewalInfo: grace ? { originalTransactionId: 'orig-1', gracePeriodExpiresDate: grace } : null });
    try {
      const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
      if (expected === null) {
        assert.equal(result.status, 503);
        assert.equal(result.outcome, 'apple_service_deadline_unavailable');
        assert.equal(h.entitlements().length, 0);
      } else {
        assert.equal(result.ok, true);
        assert.equal(result.subscriptionStatus, expected);
        assert.equal(h.entitlements()[0].p_subscription.status, expected);
      }
    } finally { h.restore(); }
  }
});

test('an Apple active response expires at the service boundary even when its status notification is delayed', async () => {
  const now = '2026-09-13T12:00:00.000Z';
  const h = harness();
  try {
    const result = await applyAppleEntitlement(await env(), { userId: USER, tierId: 'studio', status: 'active',
      statusCode: 1, info: transactionPayload({ expiresDate: Date.parse(now) }), now: () => now });
    assert.equal(result.ok, true);
    assert.equal(h.entitlements()[0].p_subscription.status, 'canceled');
  } finally { h.restore(); }
});

test('Apple purchase intent comes from the current provider transaction rather than an older submitted receipt', async () => {
  const oldToken = '11111111-1111-4111-8111-111111111111';
  const currentToken = '22222222-2222-4222-8222-222222222222';
  const h = harness({ transaction: transactionPayload({ appAccountToken: oldToken }),
    subscriptionTransaction: transactionPayload({ appAccountToken: currentToken }) });
  try {
    assert.equal((await verifyAndRecordApplePurchase(await env(), USER, 'tx-1')).ok, true);
    assert.equal(h.entitlements()[0].p_subscription.purchase_intent_id, currentToken);
    assert.ok(h.reads.some(url => url.includes('/billing_purchase_intents?id=eq.'+currentToken)));
    assert.ok(!h.reads.some(url => url.includes('/billing_purchase_intents?id=eq.'+oldToken)));
  } finally { h.restore(); }
});

test('provider-confirmed purchase tokens protect other accounts and deleted admission owners', async () => {
  for (const user_id of [OTHER_USER,null]) {
    const h = harness({ transaction: transactionPayload({ appAccountToken: OTHER_USER }), purchaseOwnerRows: [{ user_id }] });
    try {
      const result = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
      assert.equal(result.status, 409);
      assert.equal(result.outcome, 'already_claimed_by_another_account');
      assert.equal(h.entitlements().length, 0);
    } finally { h.restore(); }
  }
});

test('unknown purchase-owner lookup remains retryable for verification and notifications', async () => {
  for (const options of [{ purchaseOwnerStatus: 503 }, { purchaseOwnerRows: {} },
    { purchaseOwnerRows: [{ user_id: 'malformed' }] }, { purchaseOwnerRows: [{ user_id: USER },{ user_id: OTHER_USER }] }]) {
    const h = harness({ transaction: transactionPayload({ appAccountToken: OTHER_USER }), ...options });
    try {
      const verified = await verifyAndRecordApplePurchase(await env(), USER, 'tx-1');
      assert.equal(verified.status, 503);
      assert.equal(verified.outcome, 'apple_purchase_owner_unavailable');
      const notification = await handleAppleNotification(await env(), jws({ data: { originalTransactionId: 'orig-1' } }));
      assert.equal(notification.status, 503);
      assert.equal(h.entitlements().length, 0);
    } finally { h.restore(); }
  }
});

test('first Apple notification binds verified admission without a device callback, and calls GitHub no more', async () => {
  const h = harness({ transaction: transactionPayload({ appAccountToken: OTHER_USER }), purchaseOwnerRows: [{ user_id: USER }] });
  try {
    const response = await worker.fetch(new Request('https://fixture.test/api/apple/notifications/v2', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedPayload: jws({ data: { originalTransactionId: 'orig-1', environment: 'Sandbox' } }) }),
    }), await env({ GITHUB_DISPATCH_TOKEN: 'fixture_dispatch_token', GITHUB_DISPATCH_REPO: 'fixture/repo' }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).outcome, 'applied:active');
    assert.equal(h.entitlements().length, 1);
    assert.equal(h.entitlements()[0].p_subscription.user_id, USER);
    assert.equal(h.entitlements()[0].p_subscription.purchase_intent_id, OTHER_USER);
    assert.equal(h.entitlements()[0].p_allow_provider_switch, false, 'the database admits the verified intent itself');
    // Was ['provision-once','resize-once']. The runners were destroyed on
    // 2026-09-18 and the dispatch removed on 2026-09-20; a purchase that still
    // poked GitHub would be alerting Alex about a workflow with no steps.
    assert.deepEqual(h.table('https://api.github.com/'), [], 'an Apple purchase must not call GitHub at all');
  } finally { h.restore(); }
});

test('forged notification account tokens cannot link an unowned purchase', async () => {
  const h = harness({ transaction: transactionPayload(), purchaseOwnerRows: [{ user_id: USER }] });
  try {
    const result = await handleAppleNotification(await env(), jws({ data: { originalTransactionId: 'orig-1',
      signedTransactionInfo: jws({ originalTransactionId: 'orig-1', appAccountToken: OTHER_USER }) } }));
    assert.equal(result.outcome, 'no_local_subscription');
    assert.equal(h.entitlements().length, 0);
    assert.equal(h.reads.some(url => url.includes('/billing_purchase_intents')), false);
  } finally { h.restore(); }
});

test('a late canceled Apple attempt reaches durable reconciliation through its first notification', async () => {
  const h = harness({ transaction: transactionPayload({ appAccountToken: OTHER_USER }), purchaseOwnerRows: [{ user_id: USER }],
    entitlementResult: { outcome: 'purchase_conflict', resumed: false } });
  try {
    const result = await handleAppleNotification(await env(), jws({ data: { originalTransactionId: 'orig-1' } }));
    assert.equal(result.status, 503);
    assert.equal(result.outcome, 'billing_purchase_conflict');
    assert.equal(h.entitlements()[0].p_subscription.purchase_intent_id, OTHER_USER);
    assert.ok(h.table('/rest/v1/apple_iap_events').every(write => write.body.applied === false));
  } finally { h.restore(); }
});

test('a deleted historical Apple owner cannot be rebound by notification admission fallback', async () => {
  const h = harness({ transaction: transactionPayload({ appAccountToken: OTHER_USER }),
    ownerLookupBody: [{ user_id: null, provider_environment: 'Sandbox' }], purchaseOwnerRows: [{ user_id: USER }] });
  try {
    const result = await handleAppleNotification(await env(), jws({ data: { originalTransactionId: 'orig-1' } }));
    assert.equal(result.outcome, 'no_local_subscription');
    assert.equal(h.entitlements().length, 0);
    assert.equal(h.reads.some(url => url.includes('/billing_purchase_intents')), false);
  } finally { h.restore(); }
});
