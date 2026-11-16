// Coverage push for the smaller exported helpers in @sidekick/shared. The
// existing test suites (`product-state.test.mjs`, `gateway-handoff.test.mjs`,
// `billing-inspirations.test.mjs`) cover the headline behaviours; this file
// fills in the edges so a regression in a helper doesn't sneak through.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACKNOWLEDGEMENT_TEXT,
  ACKNOWLEDGEMENT_VERSION,
  SIDEKICK_PLAN_TIERS,
  buildUsageSummary,
  canUseSidekick,
  extractGatewayConnectCode,
  getPlanTier,
  isCurrentAcknowledgement,
  isEntitledSubscriptionStatus,
  isSubscriptionEntitled,
  normalizeGatewayConnectCode,
  planTierIdForStripeLookupKey,
  publicHermesInstance,
  resolveGatewayConnections,
  resolveLiveProviderReadiness,
} from '../dist/index.js';

// ---------------------------------------------------------------------------
// planTierIdForStripeLookupKey
// ---------------------------------------------------------------------------

test('planTierIdForStripeLookupKey returns null for empty / whitespace / unknown / wrong-case keys', () => {
  assert.equal(planTierIdForStripeLookupKey(null), null);
  assert.equal(planTierIdForStripeLookupKey(undefined), null);
  assert.equal(planTierIdForStripeLookupKey(''), null);
  assert.equal(planTierIdForStripeLookupKey('   '), null);
  assert.equal(planTierIdForStripeLookupKey('not_a_real_lookup_key'), null);
});

test('planTierIdForStripeLookupKey trims input and matches each canonical tier', () => {
  for (const tier of SIDEKICK_PLAN_TIERS) {
    assert.equal(planTierIdForStripeLookupKey(tier.stripePriceLookupKey), tier.id);
    assert.equal(planTierIdForStripeLookupKey(`  ${tier.stripePriceLookupKey}  `), tier.id);
  }
});

// ---------------------------------------------------------------------------
// getPlanTier
// ---------------------------------------------------------------------------

test('getPlanTier returns each canonical tier and throws on unknown ids', () => {
  for (const tier of SIDEKICK_PLAN_TIERS) {
    assert.equal(getPlanTier(tier.id).id, tier.id);
  }
  assert.throws(() => getPlanTier('not-a-real-tier'), /(plan|tier|unknown)/i);
});

// ---------------------------------------------------------------------------
// isSubscriptionEntitled
// ---------------------------------------------------------------------------

test('isSubscriptionEntitled keeps paid, trial, and payment-grace users inside the workspace', () => {
  assert.equal(isSubscriptionEntitled(null), false);
  assert.equal(isSubscriptionEntitled(undefined), false);
  assert.equal(isSubscriptionEntitled({ userId: 'u', status: 'inactive', tierId: 'studio' }), false);
  assert.equal(isSubscriptionEntitled({ userId: 'u', status: 'canceled', tierId: 'studio' }), false);
  assert.equal(isSubscriptionEntitled({ userId: 'u', status: 'unpaid', tierId: 'studio' }), false);
  assert.equal(isSubscriptionEntitled({ userId: 'u', status: 'active', tierId: 'studio' }), true);
  assert.equal(isSubscriptionEntitled({ userId: 'u', status: 'trialing', tierId: 'studio', currentPeriodEnd: new Date(Date.now() + 86400000).toISOString() }), true);
  assert.equal(isSubscriptionEntitled({ userId: 'u', status: 'trialing', tierId: 'studio' }), false, 'a trial with no deadline cannot grant access');
  assert.equal(isSubscriptionEntitled({ userId: 'u', status: 'trialing', tierId: 'studio', currentPeriodEnd: new Date(Date.now() - 1).toISOString() }), false, 'an expired trial cannot grant access');
  assert.equal(isSubscriptionEntitled({ userId: 'u', status: 'past_due', tierId: 'studio' }), true);
});

// A cancelled reader is not a subscribed one. Callers that only have the status
// to hand were writing their own `!== 'inactive'` test, which counts 'canceled'
// as a live plan and promises them things that no longer exist.
test('status-level and object-level entitlement agree when the trial has time remaining', () => {
  assert.equal(isEntitledSubscriptionStatus(null), false);
  assert.equal(isEntitledSubscriptionStatus(undefined), false);
  assert.equal(isEntitledSubscriptionStatus('inactive'), false);
  assert.equal(isEntitledSubscriptionStatus('canceled'), false);
  assert.equal(isEntitledSubscriptionStatus('active'), true);
  assert.equal(isEntitledSubscriptionStatus('trialing'), true);
  assert.equal(isEntitledSubscriptionStatus('past_due'), true);

  for (const status of ['inactive', 'canceled', 'active', 'trialing', 'past_due']) {
    assert.equal(
      isEntitledSubscriptionStatus(status),
      isSubscriptionEntitled({ userId: 'u', status, tierId: 'studio', currentPeriodEnd: new Date(Date.now() + 86400000).toISOString() }),
      `${status} must resolve the same way at both levels`,
    );
  }
});

// ---------------------------------------------------------------------------
// isCurrentAcknowledgement
// ---------------------------------------------------------------------------

test('isCurrentAcknowledgement matches only the canonical version', () => {
  assert.equal(isCurrentAcknowledgement(null), false);
  assert.equal(isCurrentAcknowledgement(undefined), false);
  assert.equal(isCurrentAcknowledgement({
    userId: 'u',
    acceptedAt: new Date().toISOString(),
    textVersion: 'v0-stale',
  }), false);
  assert.equal(isCurrentAcknowledgement({
    userId: 'u',
    acceptedAt: new Date().toISOString(),
    textVersion: ACKNOWLEDGEMENT_VERSION,
  }), true);
});

// ---------------------------------------------------------------------------
// publicHermesInstance
// ---------------------------------------------------------------------------

test('publicHermesInstance strips infrastructure fields and exposes only the public projection', () => {
  assert.equal(publicHermesInstance(null), null);
  assert.equal(publicHermesInstance(undefined), null);

  const projection = publicHermesInstance({
    userId: 'u',
    status: 'ready',
    publicStatusMessage: 'Ready',
    railwayProjectId: 'proj_secret',
    railwayServiceId: 'svc_secret',
    railwayVolumeId: 'vol_secret',
    baseUrl: 'https://internal.runner.example',
    error: 'internal',
  });

  assert.ok(projection);
  // Public fields preserved.
  assert.equal(projection.userId, 'u');
  assert.equal(projection.status, 'ready');
  assert.equal(projection.publicStatusMessage, 'Ready');
  // Sensitive fields stripped — the projection only includes public fields.
  for (const forbidden of ['railwayProjectId', 'railwayServiceId', 'railwayVolumeId', 'baseUrl', 'error']) {
    assert.equal(projection[forbidden], undefined, `public projection must not include ${forbidden}`);
  }
  assert.doesNotMatch(JSON.stringify(projection), /proj_secret|svc_secret|vol_secret|internal\.runner/);
});

// ---------------------------------------------------------------------------
// buildUsageSummary edge cases
// ---------------------------------------------------------------------------

test('buildUsageSummary handles zero quotas, large overages, and stale events without throwing', () => {
  // Zero quota -> any usage hard-limits.
  const zeroQuota = buildUsageSummary([], { userId: 'u', monthlyTokenQuota: 0, tierId: 'studio' });
  assert.equal(zeroQuota.usedTokens, 0);
  assert.equal(zeroQuota.quotaTokens, 0);

  // Mixed events sum correctly.
  const summary = buildUsageSummary(
    [
      { userId: 'u', promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      { userId: 'u', promptTokens: 5, completionTokens: 15, totalTokens: 20 },
    ],
    { userId: 'u', monthlyTokenQuota: 100, tierId: 'studio' },
  );
  assert.equal(summary.usedTokens, 50);
  assert.equal(summary.remainingTokens, 50);
  assert.equal(summary.quotaTokens, 100);

  // Overage -> remainingTokens floored at 0; no negative remaining.
  const overage = buildUsageSummary(
    [{ userId: 'u', promptTokens: 1, completionTokens: 1, totalTokens: 200 }],
    { userId: 'u', monthlyTokenQuota: 100, tierId: 'studio' },
  );
  assert.equal(overage.usedTokens, 200);
  assert.equal(overage.remainingTokens, 0);

  // Negative event total tokens are clamped to 0 in the sum.
  const clamped = buildUsageSummary(
    [{ userId: 'u', promptTokens: 0, completionTokens: 0, totalTokens: -5 }],
    { userId: 'u', monthlyTokenQuota: 100, tierId: 'studio' },
  );
  assert.equal(clamped.usedTokens, 0);
  assert.equal(clamped.remainingTokens, 100);
});

// ---------------------------------------------------------------------------
// canUseSidekick
// ---------------------------------------------------------------------------

test('canUseSidekick rejects unknown gate kinds and accepts only the canonical ones', () => {
  assert.equal(canUseSidekick({ kind: 'ready' }), true);
  assert.equal(canUseSidekick({ kind: 'degraded' }), true);
  for (const kind of ['signed_out', 'no_subscription', 'pending_setup', 'hard_limited', 'error', 'acknowledgement_required']) {
    assert.equal(canUseSidekick({ kind }), false, `${kind} must not be usable`);
  }
});

// ---------------------------------------------------------------------------
// resolveGatewayConnections
// ---------------------------------------------------------------------------

test('resolveGatewayConnections returns the canonical registry by default and honours field overrides', () => {
  const defaults = resolveGatewayConnections();
  assert.ok(defaults.length > 0);
  for (const entry of defaults) {
    assert.match(entry.id, /^(telegram|whatsapp|signal|email)$/);
  }

  const overridden = resolveGatewayConnections({
    telegram: { status: 'paused' },
  });
  const tg = overridden.find((c) => c.id === 'telegram');
  assert.ok(tg);
  assert.equal(tg.status, 'paused');
});

// ---------------------------------------------------------------------------
// resolveLiveProviderReadiness
// ---------------------------------------------------------------------------

test('resolveLiveProviderReadiness reports complete only when every requirement is satisfied', () => {
  const empty = resolveLiveProviderReadiness('telegram', []);
  assert.equal(empty.ready, false);
  assert.equal(empty.providerId, 'telegram');
  assert.ok(Array.isArray(empty.requirementIds));
  assert.ok(empty.requirementIds.length > 0);
  // Every requirement is missing when nothing is completed.
  assert.deepEqual(empty.missingRequirementIds.slice().sort(), empty.requirementIds.slice().sort());

  const ready = resolveLiveProviderReadiness('telegram', empty.requirementIds);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missingRequirementIds, []);
});

// ---------------------------------------------------------------------------
// gateway connect code helpers
// ---------------------------------------------------------------------------

test('extractGatewayConnectCode handles bare codes, /start commands, and bot mentions', () => {
  assert.equal(extractGatewayConnectCode('TG ABC-123'), 'TGABC123');
  assert.equal(extractGatewayConnectCode('/start TG ABC-123'), 'TGABC123');
  assert.equal(extractGatewayConnectCode('/start@some_bot TG-ABC123'), 'TGABC123');
  assert.equal(extractGatewayConnectCode(null), null);
  assert.equal(extractGatewayConnectCode(''), null);
  assert.equal(extractGatewayConnectCode('   '), null);
});

test('normalizeGatewayConnectCode strips whitespace and dashes and uppercases', () => {
  assert.equal(normalizeGatewayConnectCode('tg-abc-123'), 'TGABC123');
  assert.equal(normalizeGatewayConnectCode('  tg abc 123  '), 'TGABC123');
  assert.equal(normalizeGatewayConnectCode(''), null);
  assert.equal(normalizeGatewayConnectCode(null), null);
  assert.equal(normalizeGatewayConnectCode(undefined), null);
});

// ---------------------------------------------------------------------------
// Acknowledgement constants
// ---------------------------------------------------------------------------

test('ACKNOWLEDGEMENT_VERSION and ACKNOWLEDGEMENT_TEXT are non-empty strings', () => {
  assert.ok(typeof ACKNOWLEDGEMENT_VERSION === 'string' && ACKNOWLEDGEMENT_VERSION.length > 0);
  assert.ok(typeof ACKNOWLEDGEMENT_TEXT === 'string' && ACKNOWLEDGEMENT_TEXT.length > 0);
});
