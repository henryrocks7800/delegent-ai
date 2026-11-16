// Quota-journey unit tests (AGENT_TODO_CHECKLIST §2.5 / Batch 4a).
//
// Verifies the pure-function pieces of the new quota-journey wiring without
// reaching network. The end-to-end "Worker returns QuotaPauseResponse on
// 402" path is covered by chat-api.test.mjs once it ports onto the new
// snapshot shape (deferred to Batch 4c §2.5.8).
//
// IMPORTANT: runs against ../dist/index.js. Always `npm test` from the worker
// workspace so the build runs first (per CLAUDE.md commands).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  resolveUsageGate,
  recordUsageViolation,
  fetchGlobalBillingGuard,
  fetchBillingCycleStartIso,
  resolveUsageWindowStartIso,
  fetchUsageSnapshot,
} from '../dist/index.js';
import { SIDEKICK_PLAN_TIERS, getPlanTier } from '@sidekick/shared';

const ENV = {
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test',
};

function snapshot(overrides = {}) {
  return {
    userId: '11111111-2222-4333-8444-555555555555',
    tierId: 'studio',
    monthlyTokenQuota: 200_000,
    usedTokens: 0,
    remainingTokens: 200_000,
    hardLimited: false,
    periodStart: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}

function guard(overrides = {}) {
  return {
    monthlyBudgetGbpPence: 750_000,
    monthlySpendGbpPence: 100_000,
    spendCycleStartIso: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------- resolveUsageGate

test('resolveUsageGate: allows request inside per-user remaining tokens', () => {
  const result = resolveUsageGate(snapshot({ remainingTokens: 5_000 }), 1_500);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.reason, 'allowed');
});

test('resolveUsageGate: 402 tier_limit_exceeded when requestedTokenBudget > remaining', () => {
  const result = resolveUsageGate(snapshot({ remainingTokens: 100 }), 1_500);
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.equal(result.reason, 'tier_limit_exceeded');
});

test('resolveUsageGate: 402 tier_limit_exceeded when hardLimited is true', () => {
  const result = resolveUsageGate(snapshot({ remainingTokens: 5_000, hardLimited: true }), 100);
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.equal(result.reason, 'tier_limit_exceeded');
});

test('resolveUsageGate: passes Enterprise through even when global guard is over budget', () => {
  const result = resolveUsageGate(
    snapshot({ tierId: 'enterprise-suite' }),
    1_000,
    guard({ monthlySpendGbpPence: 800_000, monthlyBudgetGbpPence: 750_000 }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'allowed');
});

test('resolveUsageGate: 503 global_spend_paused for non-Enterprise when guard fires', () => {
  for (const tierId of ['studio', 'pro-office']) {
    const result = resolveUsageGate(
      snapshot({ tierId }),
      1_000,
      guard({ monthlySpendGbpPence: 800_000, monthlyBudgetGbpPence: 750_000 }),
    );
    assert.equal(result.ok, false, `${tierId} should be paused`);
    assert.equal(result.status, 503);
    assert.equal(result.reason, 'global_spend_paused');
  }
});

test('resolveUsageGate: guard with zero budget is treated as no guard (fail-open)', () => {
  // monthlyBudgetGbpPence === 0 means "guard not configured" — do not pause anyone.
  const result = resolveUsageGate(
    snapshot({ tierId: 'studio', remainingTokens: 5_000 }),
    1_000,
    guard({ monthlyBudgetGbpPence: 0, monthlySpendGbpPence: 999_999 }),
  );
  assert.equal(result.ok, true);
});

test('resolveUsageGate: null guard means org guard never fires', () => {
  const result = resolveUsageGate(snapshot({ tierId: 'studio', remainingTokens: 5_000 }), 1_000, null);
  assert.equal(result.ok, true);
});

test('resolveUsageGate: per-user cap fires even when global guard is fine', () => {
  const result = resolveUsageGate(
    snapshot({ tierId: 'studio', remainingTokens: 100 }),
    1_500,
    guard({ monthlySpendGbpPence: 100_000 }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.equal(result.reason, 'tier_limit_exceeded');
});

// ------------------------------------------------------ resolveUsageGate: admin exemption
//
// 2026-08-26. Alex's own Studio account ran its monthly cap to zero on daily
// scheduled routines he never saw succeed or fail. SIDEKICK_ADMIN_USER_IDS
// already existed (for the BI dashboard) but nothing gated on it, so internal
// testing was metered against a real customer's allowance with no way out.

test('resolveUsageGate: an admin-exempt account is allowed even with zero tokens left', () => {
  const result = resolveUsageGate(
    snapshot({ isAdminExempt: true, hardLimited: true, remainingTokens: 0 }),
    50_000,
  );
  assert.equal(result.ok, true, 'exemption must survive being completely out of quota');
  assert.equal(result.status, 200);
  assert.equal(result.reason, 'allowed');
});

test('resolveUsageGate: a non-admin account with the SAME exhausted numbers is still refused', () => {
  // Same inputs as above, isAdminExempt just omitted (falsy by default) — this
  // is the control that proves the exemption is doing the work above, not
  // some other field.
  const result = resolveUsageGate(
    snapshot({ hardLimited: true, remainingTokens: 0 }),
    50_000,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'tier_limit_exceeded');
});

test('resolveUsageGate: admin exemption does NOT bypass the org-wide spend guard', () => {
  // Deliberate: if the business itself is out of OpenRouter budget, an admin
  // account should not be able to keep draining it. Exemption only ever
  // covers the PER-USER cap.
  const result = resolveUsageGate(
    snapshot({ isAdminExempt: true, tierId: 'studio' }),
    1_000,
    guard({ monthlyBudgetGbpPence: 750_000, monthlySpendGbpPence: 750_000 }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.reason, 'global_spend_paused');
});

test('fetchUsageSnapshot: isAdminExempt is true only for ids in SIDEKICK_ADMIN_USER_IDS', async () => {
  const adminEnv = {
    ...ENV,
    SIDEKICK_ADMIN_USER_IDS: 'aaaaaaaa-0000-4000-8000-000000000001,bbbbbbbb-0000-4000-8000-000000000002',
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200 });
  try {
    const admin = await fetchUsageSnapshot('aaaaaaaa-0000-4000-8000-000000000001', adminEnv);
    const stranger = await fetchUsageSnapshot('cccccccc-0000-4000-8000-000000000003', adminEnv);
    assert.equal(admin.isAdminExempt, true);
    assert.equal(stranger.isAdminExempt, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the reservation RPC is skipped for admin-exempt accounts, not just the JS gate', () => {
  // A unit test on resolveUsageGate cannot prove this: reserve_chat_tokens is
  // an ATOMIC PostgreSQL check with no idea a caller is exempt, so calling it
  // for a used-up admin account would come back allowed:false and silently
  // override the exemption above it. Pin the guard in source.
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(
    src,
    /if \(!usageSnapshot\.isAdminExempt && \(usageGate\.ok \|\| usageGate\.reason === 'tier_limit_exceeded'\)\)/,
    'reserveChatTokens must not run for an admin-exempt account',
  );
});

// ---------------------------------------------------------------- fetchGlobalBillingGuard

test('fetchGlobalBillingGuard: returns null on transport failure (fail-open)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    const guardResult = await fetchGlobalBillingGuard(ENV);
    assert.equal(guardResult, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchGlobalBillingGuard: returns null when no row exists', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([]), { status: 200 });
  try {
    const guardResult = await fetchGlobalBillingGuard(ENV);
    assert.equal(guardResult, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchGlobalBillingGuard: parses live row correctly', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([
        {
          monthly_budget_gbp_pence: 750_000,
          monthly_spend_gbp_pence: 42_000,
          spend_cycle_start: '2026-05-01T00:00:00.000Z',
        },
      ]),
      { status: 200 },
    );
  try {
    const guardResult = await fetchGlobalBillingGuard(ENV);
    assert.deepEqual(guardResult, {
      monthlyBudgetGbpPence: 750_000,
      monthlySpendGbpPence: 42_000,
      spendCycleStartIso: '2026-05-01T00:00:00.000Z',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------- fetchBillingCycleStartIso

test('fetchBillingCycleStartIso: prefers subscriptions.current_period_start', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([{
        current_period_start: '2026-05-15T03:14:15.000Z',
        current_period_end: '2026-06-15T03:14:15.000Z',
      }]),
      { status: 200 },
    );
  try {
    const now = new Date('2026-05-20T12:00:00.000Z');
    const result = await fetchBillingCycleStartIso('user-1', ENV, now);
    assert.equal(result, '2026-05-15T03:14:15.000Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBillingCycleStartIso: a stale anchor does not keep charging last cycle forever', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify([{
        current_period_start: '2026-05-15T03:14:15.000Z',
        current_period_end: '2026-06-15T03:14:15.000Z',
      }]),
      { status: 200 },
    );
  try {
    // Two renewals have come and gone without Stripe telling us a new period.
    const now = new Date('2026-07-20T12:00:00.000Z');
    const result = await fetchBillingCycleStartIso('user-1', ENV, now);
    assert.equal(result, '2026-07-15T03:14:15.000Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBillingCycleStartIso: falls back to calendar month start when no row', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify([]), { status: 200 });
  try {
    const now = new Date('2026-05-17T12:00:00.000Z');
    const result = await fetchBillingCycleStartIso('user-1', ENV, now);
    assert.equal(result, '2026-05-01T00:00:00.000Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBillingCycleStartIso: falls back to calendar month on transport error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  try {
    const now = new Date('2026-05-17T12:00:00.000Z');
    const result = await fetchBillingCycleStartIso('user-1', ENV, now);
    assert.equal(result, '2026-05-01T00:00:00.000Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchBillingCycleStartIso: falls back to calendar month on unparseable timestamp', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ current_period_start: 'not-a-date' }]), { status: 200 });
  try {
    const now = new Date('2026-05-17T12:00:00.000Z');
    const result = await fetchBillingCycleStartIso('user-1', ENV, now);
    assert.equal(result, '2026-05-01T00:00:00.000Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------- resolveUsageWindowStartIso

const FALLBACK = '2026-07-01T00:00:00.000Z';

test('resolveUsageWindowStartIso: inside a live period the stored anchor is used untouched', () => {
  const at = (iso) => resolveUsageWindowStartIso('2026-06-29T10:57:56.000Z', '2026-07-29T10:57:56.000Z', new Date(iso), FALLBACK);
  assert.equal(at('2026-06-29T10:57:56.000Z'), '2026-06-29T10:57:56.000Z', 'the first instant still belongs to the period');
  assert.equal(at('2026-07-20T15:31:00.000Z'), '2026-06-29T10:57:56.000Z');
  // One millisecond before the end is still inside, so no second allowance.
  assert.equal(at('2026-07-29T10:57:55.999Z'), '2026-06-29T10:57:56.000Z');
});

test('resolveUsageWindowStartIso: a stale anchor rolls forward on the billing day, not the 1st', () => {
  const at = (iso) => resolveUsageWindowStartIso('2026-06-29T10:57:56.000Z', '2026-07-29T10:57:56.000Z', new Date(iso), FALLBACK);
  // The exact instant the period ends is the start of the next one.
  assert.equal(at('2026-07-29T10:57:56.000Z'), '2026-07-29T10:57:56.000Z');
  assert.equal(at('2026-08-02T00:00:00.000Z'), '2026-07-29T10:57:56.000Z');
  // Several missed renewals still land on one window, not a cumulative one.
  assert.equal(at('2026-10-30T00:00:00.000Z'), '2026-10-29T10:57:56.000Z');
});

test('resolveUsageWindowStartIso: a 31st anchor clamps into short months like Stripe does', () => {
  const at = (iso) => resolveUsageWindowStartIso('2026-01-31T09:00:00.000Z', '2026-02-28T09:00:00.000Z', new Date(iso), FALLBACK);
  assert.equal(at('2026-03-01T00:00:00.000Z'), '2026-02-28T09:00:00.000Z', 'February clamps to the 28th');
  assert.equal(at('2026-04-01T00:00:00.000Z'), '2026-03-31T09:00:00.000Z', 'and March returns to the 31st');
});

test('resolveUsageWindowStartIso: a missing period end still rolls once a whole month has passed', () => {
  const at = (iso) => resolveUsageWindowStartIso('2026-05-15T03:14:15.000Z', null, new Date(iso), FALLBACK);
  assert.equal(at('2026-06-01T00:00:00.000Z'), '2026-05-15T03:14:15.000Z', 'inside the implied month');
  assert.equal(at('2026-06-20T00:00:00.000Z'), '2026-06-15T03:14:15.000Z', 'past it');
});

test('resolveUsageWindowStartIso: bad or absurd rows fall back rather than inventing a window', () => {
  assert.equal(resolveUsageWindowStartIso(null, null, new Date('2026-07-30T00:00:00.000Z'), FALLBACK), FALLBACK);
  assert.equal(resolveUsageWindowStartIso('not-a-date', null, new Date('2026-07-30T00:00:00.000Z'), FALLBACK), FALLBACK);
  // Twenty years of stale anchor is a bad row, not a billing period.
  assert.equal(resolveUsageWindowStartIso('1990-01-01T00:00:00.000Z', null, new Date('2026-07-30T00:00:00.000Z'), FALLBACK), FALLBACK);
  // A future anchor is clock skew or a scheduled change; leave it alone.
  assert.equal(
    resolveUsageWindowStartIso('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', new Date('2026-07-30T00:00:00.000Z'), FALLBACK),
    '2026-09-01T00:00:00.000Z',
  );
});

// ---------------------------------------------------------------- recordUsageViolation

test('recordUsageViolation: posts to usage_violations + soft-fails on network error', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ?? null });
    throw new Error('transient supabase blip');
  };
  try {
    // Must NOT throw — audit row is best-effort.
    await recordUsageViolation(ENV, {
      userId: '11111111-2222-4333-8444-555555555555',
      capKind: 'token',
      requested: 1_500,
      available: 100,
      billingCycleStartIso: '2026-05-15T00:00:00.000Z',
      notes: 'unit test',
    });
    assert.match(String(calls[0].url), /\/rest\/v1\/usage_violations(\?|$)/);
    const body = JSON.parse(calls[0].body);
    assert.equal(body.user_id, '11111111-2222-4333-8444-555555555555');
    assert.equal(body.cap_kind, 'token');
    assert.equal(body.requested, 1_500);
    assert.equal(body.available, 100);
    assert.equal(body.billing_cycle_start, '2026-05-15T00:00:00.000Z');
    assert.equal(body.notes, 'unit test');

    // Since 2026-07-30 a denial ALSO tries to tell the user (a paying user sat
    // capped for nine days with only an in-app banner). That lookup fails here
    // along with everything else, which is the point: the notice must never turn
    // the audit path into a throw.
    assert.equal(calls.length, 2);
    assert.match(String(calls[1].url), /\/auth\/v1\/admin\/users\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('recordUsageViolation: our own spend guard never tries to email the customer', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ?? null });
    throw new Error('transient supabase blip');
  };
  try {
    await recordUsageViolation(ENV, {
      userId: '11111111-2222-4333-8444-555555555555',
      capKind: 'global_spend',
      requested: 1_500,
      available: 0,
      billingCycleStartIso: '2026-05-15T00:00:00.000Z',
    });
    // Audit row only. An org-wide spend guard is our problem, and mailing a
    // customer about it would be both confusing and a disclosure.
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].url), /\/rest\/v1\/usage_violations(\?|$)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------- E2E quota-journey (§2.5.8)

test('quota-journey E2E: cycle anchor moves with subscriptions.current_period_start (cycle reset proof)', async () => {
  // Proves the cycle-aware reset documented in docs/QUOTA_JOURNEY.md §6:
  //   "Critical: the cycle window is bound to subscriptions
  //    .current_period_start, NOT a calendar month."
  // Two cycle anchors, same user, same usage rows. Only rows >= the
  // active anchor count toward this cycle. Anchor advances forward
  // → previously-counted rows fall out of the cycle → the user
  // gets a fresh budget without any background reset job.
  const originalFetch = globalThis.fetch;
  let activeAnchor = '2026-05-01T00:00:00.000Z';
  let activeAnchorEnd = '2026-06-01T00:00:00.000Z';
  // Pinned rather than wall-clock: `now` has to sit inside the active period,
  // otherwise the stale-anchor roll-forward kicks in and the test is really
  // asserting today's date.
  let now = new Date('2026-05-20T00:00:00.000Z');
  const usageRows = [
    { total_tokens: 50_000, created_at: '2026-05-05T00:00:00.000Z' }, // inside first cycle
    { total_tokens: 50_000, created_at: '2026-05-15T00:00:00.000Z' }, // inside first cycle
    { total_tokens: 1_000, created_at: '2026-06-02T00:00:00.000Z' }, // inside second cycle
  ];
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('/rest/v1/subscriptions')) {
      return new Response(
        JSON.stringify([{ current_period_start: activeAnchor, current_period_end: activeAnchorEnd }]),
        { status: 200 },
      );
    }
    if (s.includes('/rest/v1/token_usage_events')) {
      // Parse the created_at=gte.<iso> param the Worker sends.
      const m = s.match(/created_at=gte\.([^&]+)/);
      const since = m ? decodeURIComponent(m[1]) : '1970-01-01T00:00:00.000Z';
      const filtered = usageRows.filter((r) => r.created_at >= since);
      return new Response(JSON.stringify(filtered.map((r) => ({ total_tokens: r.total_tokens }))), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  try {
    const cycleA = await fetchBillingCycleStartIso('user-1', ENV, now);
    assert.equal(cycleA, '2026-05-01T00:00:00.000Z', 'first cycle anchor');

    // Advance the Stripe subscription forward — simulating a webhook
    // landing a new current_period_start on cycle rollover.
    activeAnchor = '2026-06-01T00:00:00.000Z';
    activeAnchorEnd = '2026-07-01T00:00:00.000Z';
    now = new Date('2026-06-20T00:00:00.000Z');

    const cycleB = await fetchBillingCycleStartIso('user-1', ENV, now);
    assert.equal(cycleB, '2026-06-01T00:00:00.000Z', 'second cycle anchor (post-rollover)');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('quota-journey E2E: per-user 402 + global-pause 503 + Enterprise carve-out (combined gate matrix)', () => {
  // Independent invariants from §2.5 enforcement (compact regression sweep):
  // 1. Per-user budget under cap → allowed.
  // 2. Per-user budget at cap → 402 tier_limit_exceeded.
  // 3. Global guard over budget + non-Enterprise → 503 global_spend_paused.
  // 4. Global guard over budget + Enterprise → allowed (carve-out).
  // 5. Both fire + non-Enterprise → 503 (global wins; per-user evaluated
  //    only after global lets the call through).
  const userSnap = (tier, remaining) => ({
    userId: 'u',
    tierId: tier,
    monthlyTokenQuota: 200_000,
    usedTokens: 200_000 - remaining,
    remainingTokens: remaining,
    hardLimited: remaining <= 0,
    periodStart: '2026-05-15T00:00:00.000Z',
  });
  const overGuard = { monthlyBudgetGbpPence: 100_000, monthlySpendGbpPence: 200_000, spendCycleStartIso: '2026-05-01T00:00:00.000Z' };
  const okGuard = { monthlyBudgetGbpPence: 100_000, monthlySpendGbpPence: 0, spendCycleStartIso: '2026-05-01T00:00:00.000Z' };

  assert.equal(resolveUsageGate(userSnap('studio', 5_000), 1_000, okGuard).ok, true, 'allowed within both caps');
  assert.equal(resolveUsageGate(userSnap('studio', 0), 1_000, okGuard).reason, 'tier_limit_exceeded');
  assert.equal(resolveUsageGate(userSnap('studio', 5_000), 1_000, overGuard).reason, 'global_spend_paused');
  assert.equal(resolveUsageGate(userSnap('enterprise-suite', 5_000), 1_000, overGuard).ok, true, 'enterprise carve-out');
  // Both caps fire for a non-Enterprise user: global guard takes precedence
  // so the user sees the "everyone is paused" copy rather than the per-user
  // upgrade nudge — matches §2.5.6 wording in QUOTA_JOURNEY.md.
  assert.equal(resolveUsageGate(userSnap('studio', 0), 1_000, overGuard).reason, 'global_spend_paused');
});

// ---------------------------------------------------------------- per-tier preloaded credits (§2.5.4)

test('SIDEKICK_PLAN_TIERS: each tier carries token + storage + voice caps that match the schema defaults', () => {
  // Schema defaults from supabase/migrations/0026_quota_journey_foundation.sql:
  //   storage_quota_bytes default = 10 GB (matches Studio)
  //   voice_seconds_quota default = 3600s (matches Studio)
  // Stripe webhook (apps/worker/src/stripe-flow.ts toUsageQuotaPatchRecord)
  // reads these tier fields and writes them on every subscription
  // transition; mid-cycle upgrade therefore raises all three caps
  // atomically (and consumed_* counters carry over so a downgrade
  // never gives the user free room they already used).
  for (const tier of SIDEKICK_PLAN_TIERS) {
    assert.ok(tier.monthlyTokenQuota > 0, `${tier.id} monthlyTokenQuota`);
    assert.ok(tier.storageGb > 0, `${tier.id} storageGb`);
    assert.ok(tier.voiceSecondsQuota > 0, `${tier.id} voiceSecondsQuota`);
  }

  // Pin the exact tier-to-cap mapping. Changes here MUST be matched by
  // a new Supabase migration that backfills existing rows, otherwise
  // already-subscribed users keep the old caps until their next tier
  // transition.
  assert.deepEqual(getPlanTier('studio').monthlyTokenQuota, 19_550_000);
  assert.deepEqual(getPlanTier('pro-office').monthlyTokenQuota, 48_000_000);
  assert.deepEqual(getPlanTier('enterprise-suite').monthlyTokenQuota, 100_000_000);

  assert.deepEqual(getPlanTier('studio').storageGb, 10);
  assert.deepEqual(getPlanTier('pro-office').storageGb, 40);
  assert.deepEqual(getPlanTier('enterprise-suite').storageGb, 100);

  assert.deepEqual(getPlanTier('studio').voiceSecondsQuota, 3_600);
  assert.deepEqual(getPlanTier('pro-office').voiceSecondsQuota, 10_800);
  assert.deepEqual(getPlanTier('enterprise-suite').voiceSecondsQuota, 36_000);
});

test('SIDEKICK_PLAN_TIERS: storage_quota_bytes derivation matches storageGb × 1024^3', () => {
  for (const tier of SIDEKICK_PLAN_TIERS) {
    const expectedBytes = tier.storageGb * 1024 ** 3;
    assert.ok(Number.isSafeInteger(expectedBytes), `${tier.id} storage cap must fit in a safe integer`);
    // Studio's 10 GB in bytes = 10737418240, matches the schema default.
    if (tier.id === 'studio') assert.equal(expectedBytes, 10737418240);
    if (tier.id === 'pro-office') assert.equal(expectedBytes, 42949672960);
    if (tier.id === 'enterprise-suite') assert.equal(expectedBytes, 107374182400);
  }
});

test('recordUsageViolation: maps null notes to JSON null', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init?.body ?? '{}');
    return new Response(null, { status: 201 });
  };
  try {
    await recordUsageViolation(ENV, {
      userId: '22222222-3333-4444-8555-666666666666',
      capKind: 'global_spend',
      requested: 0,
      available: 0,
      billingCycleStartIso: null,
    });
    assert.equal(captured.notes, null);
    assert.equal(captured.billing_cycle_start, null);
    assert.equal(captured.cap_kind, 'global_spend');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Apple grace keeps the verified billing anchor and advances only with a renewed transaction', async () => {
  const originalFetch = globalThis.fetch;
  const now = new Date('2026-09-13T12:00:00Z');
  try {
    for (const [start, end] of [['2026-08-10T00:00:00Z','2026-09-10T00:00:00Z'], ['2026-09-10T00:00:00Z','2026-10-10T00:00:00Z']]) {
      globalThis.fetch = async () => Response.json([{ current_period_start: start, current_period_end: end, billing_provider: 'apple' }]);
      assert.equal(await fetchBillingCycleStartIso('user-1', ENV, now), new Date(start).toISOString());
    }
  } finally { globalThis.fetch = originalFetch; }
});
