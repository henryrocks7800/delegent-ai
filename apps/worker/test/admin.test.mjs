// Admin dashboard contracts.
//
// The risky parts are not "does JSON come back". They are: who can see the
// business's money numbers at all, whether the per-user margin maths tells
// Alex the truth about where money is lost, and whether the projections stay
// attached to their stated assumptions. Those are what these tests hold.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAPEX_LEDGER,
  FIXED_MONTHLY_COSTS,
  UNIT_ECONOMICS,
  billingFeeGbp,
  buildImportantDates,
  capexReceiptedTotalGbp,
  classifyCustomer,
  computeProjections,
  computeUserRow,
  couponIdOf,
  CUSTOMER_COLUMNS,
  fixedCostsGbpMonthly,
  isAppleSandbox,
  PRICE_COLUMNS,
  SUBSCRIPTION_COLUMNS,
  inferenceGbpForTokens,
  MODEL_PERSONAS,
  measuredPersona,
  netOfBillingFees,
  parseAdminUserIds,
  rejectUnlessAdmin,
} from '../dist/admin.js';

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
test('allowlist parsing keeps only well-formed uuids and lowercases them', () => {
  const ids = parseAdminUserIds(
    '272b9ffd-3097-4d59-a1b4-c0fc2dddffc2, not-a-uuid, ,90626a23-d86c-4360-ad01-54bc873751f3',
  );
  assert.equal(ids.size, 2);
  assert.ok(ids.has('272b9ffd-3097-4d59-a1b4-c0fc2dddffc2'));
  assert.ok(ids.has('90626a23-d86c-4360-ad01-54bc873751f3'));
});

test('no bearer token is 401 before any network call', async () => {
  const response = await rejectUnlessAdmin(new Request('https://x/api/admin/dashboard'), {
    SIDEKICK_ADMIN_USER_IDS: '272b9ffd-3097-4d59-a1b4-c0fc2dddffc2',
  });
  assert.equal(response.status, 401);
});

test('an EMPTY allowlist is 403 for everyone: the safe default when the var is unset', async () => {
  const response = await rejectUnlessAdmin(
    new Request('https://x/api/admin/dashboard', { headers: { authorization: 'Bearer sometoken' } }),
    {},
  );
  assert.equal(response.status, 403);
});

test('a valid token for a NON-listed user is 403', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ id: '99999999-9999-4999-8999-999999999999' }), { status: 200 });
  const response = await rejectUnlessAdmin(
    new Request('https://x/api/admin/dashboard', { headers: { authorization: 'Bearer valid' } }),
    {
      SUPABASE_URL: 'https://supabase.example',
      SUPABASE_SERVICE_ROLE_KEY: 'srk',
      SIDEKICK_ADMIN_USER_IDS: '272b9ffd-3097-4d59-a1b4-c0fc2dddffc2',
    },
  );
  assert.equal(response.status, 403);
});

test('a listed admin passes the gate', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ id: '272b9ffd-3097-4d59-a1b4-c0fc2dddffc2' }), { status: 200 });
  const response = await rejectUnlessAdmin(
    new Request('https://x/api/admin/dashboard', { headers: { authorization: 'Bearer valid' } }),
    {
      SUPABASE_URL: 'https://supabase.example',
      SUPABASE_SERVICE_ROLE_KEY: 'srk',
      SIDEKICK_ADMIN_USER_IDS: '272b9ffd-3097-4d59-a1b4-c0fc2dddffc2',
    },
  );
  assert.equal(response, null);
});

// ---------------------------------------------------------------------------
// Money maths
// ---------------------------------------------------------------------------
test('a subscriber is priced at what their biller actually charges them, not at a list price', () => {
  const legacy = computeUserRow({
    name: 'Test Customer 63',
    email: 'legacy@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'active',
    billingProvider: 'stripe',
    priceGbp: 9.99,
    consumedTokens: 1_000_000,
    quotaTokens: 16_000_000,
  });
  const current = computeUserRow({
    email: 'current@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'active',
    billingProvider: 'stripe',
    priceGbp: 3.99,
    consumedTokens: 1_000_000,
    quotaTokens: 16_000_000,
  });
  // Half the book is on a legacy price. Quoting everyone the same number is
  // what made MRR wrong by more than half on 2026-09-19.
  assert.equal(legacy.revenueGbp, 9.99);
  assert.equal(current.revenueGbp, 3.99);
  assert.ok(legacy.marginGbp > current.marginGbp);
});

test('the subscription select asks for every column the price reader needs', () => {
  // This is the test for a fault that shipped as far as a pushed commit:
  // resolvePrices read stripe_subscription_id while the select did not ask for
  // it. PostgREST returns only what you select, so the property was undefined,
  // the coupon lookup never ran, and every customer silently fell back to
  // their LIST price. Silent, wrong, and the exact thing Alex complained
  // about. Caught by a second session reading the diff, not by a test.
  for (const column of PRICE_COLUMNS) {
    assert.ok(
      SUBSCRIPTION_COLUMNS.includes(column),
      `${column} is read when pricing a customer but is not in the select, so it will arrive undefined`,
    );
  }
});

test('a Stripe discount yields its coupon id in every shape the API returns it', () => {
  // The shape that broke the first attempt: the coupon arrives as a STRING id
  // nested under source, so the obvious discount.coupon.percent_off is
  // undefined and the list price survives without an error anywhere.
  assert.equal(couponIdOf({ source: { coupon: 'delegent_launch_half_price_2mo' } }), 'delegent_launch_half_price_2mo');
  assert.equal(couponIdOf({ coupon: 'internal-testing' }), 'internal-testing');
  assert.equal(couponIdOf({ coupon: { id: 'delegent_launch_7003_2mo' } }), 'delegent_launch_7003_2mo');
  assert.equal(couponIdOf({ source: { coupon: { id: 'stacked' } } }), 'stacked');
  assert.equal(couponIdOf('bare-id'), 'bare-id');
  for (const nothing of [null, undefined, {}, 42, '', { coupon: null }]) {
    assert.equal(couponIdOf(nothing), null, `${JSON.stringify(nothing)} must not resolve to a coupon`);
  }
});

test('a discounted subscriber is worth what they are billed, and a free one is worth nothing', () => {
  // Three of the four paying Stripe customers are on launch coupons and the
  // test account is on a 100%-off internal one. Reading the list price
  // overstated the Stripe book by more than double (£29.94 listed against
  // £13.17 billed, checked live 2026-09-19), which is the thing Alex spotted
  // on the page. Found by a second session reviewing this change.
  const discounted = computeUserRow({
    email: 'halfprice@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'active',
    billingProvider: 'stripe',
    priceGbp: 2,
    consumedTokens: 0,
    quotaTokens: 16_000_000,
  });
  assert.equal(discounted.revenueGbp, 2, 'half price is half the revenue');

  const comped = computeUserRow({
    email: 'internal@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'active',
    billingProvider: 'stripe',
    priceGbp: 0,
    consumedTokens: 1_000_000,
    quotaTokens: 16_000_000,
  });
  assert.equal(comped.revenueGbp, 0, 'a 100%-off coupon must not fall back to the list price');
  assert.ok(comped.marginGbp < 0, 'and it still costs us something to serve');

  const unknown = computeUserRow({
    email: 'unknown@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'active',
    billingProvider: 'stripe',
    consumedTokens: 0,
    quotaTokens: 16_000_000,
  });
  assert.equal(unknown.revenueGbp, 3.99, 'no price read at all still falls back to the list price');
});

test("Apple's commission is a real cost and shows as one", () => {
  const apple = computeUserRow({
    email: 'apple@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'active',
    billingProvider: 'apple',
    priceGbp: 3.99,
    consumedTokens: 0,
    quotaTokens: 16_000_000,
  });
  const stripe = computeUserRow({
    email: 'stripe@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'active',
    billingProvider: 'stripe',
    priceGbp: 3.99,
    consumedTokens: 0,
    quotaTokens: 16_000_000,
  });
  assert.equal(apple.billingFeeGbp, 0.6, '15% of £3.99');
  assert.equal(stripe.billingFeeGbp, 0.26, '1.5% + 20p');
  assert.ok(apple.marginGbp < stripe.marginGbp, 'the same customer is worth less through Apple');
});

test('a free month is not revenue', () => {
  const trial = computeUserRow({
    email: 'trial@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'trialing',
    billingProvider: 'stripe',
    priceGbp: 3.99,
    consumedTokens: 500_000,
    quotaTokens: 4_000_000,
  });
  assert.equal(trial.revenueGbp, 0, 'counting a trial as MRR inflates it by everyone who has not paid');
  assert.ok(trial.marginGbp < 0, 'and it costs us something to serve');
});

test('Talk is charged into the margin: at the cap it costs more than a typical month of chat', () => {
  const quiet = computeUserRow({
    email: 'quiet@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'active',
    billingProvider: 'stripe',
    priceGbp: 3.99,
    consumedTokens: 400_000,
    quotaTokens: 16_000_000,
    talkSeconds: 0,
  });
  const talker = computeUserRow({
    email: 'talker@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'active',
    billingProvider: 'stripe',
    priceGbp: 3.99,
    consumedTokens: 400_000,
    quotaTokens: 16_000_000,
    talkSeconds: 15 * 60,
  });
  assert.equal(quiet.talkGbp, 0);
  assert.ok(talker.talkGbp > 0.7, `15 minutes of Talk should be most of a pound, got £${talker.talkGbp}`);
  assert.ok(talker.talkGbp > quiet.inferenceGbp, 'Talk is the bigger half of a normal month');
});

test('the worst case a plan allows still does not lose money', () => {
  // The allowance exists to make this true (AGENT_PLAN: "the worst case is I
  // break even"). If this test fails, the plan is underpriced, which is a
  // business decision and not a test to relax.
  for (const provider of ['stripe', 'apple']) {
    const maxed = computeUserRow({
      email: `maxed-${provider}@example.co.uk`,
      tierId: 'studio',
      subscriptionStatus: 'active',
      billingProvider: provider,
      priceGbp: 3.99,
      consumedTokens: 16_000_000,
      quotaTokens: 16_000_000,
      talkSeconds: 15 * 60,
    });
    assert.ok(maxed.marginGbp >= 0, `${provider}: a maxed-out customer loses £${-maxed.marginGbp}`);
  }
});

test('the row carries the person name, and a missing one is empty rather than undefined', () => {
  const named = computeUserRow({
    name: '  Hannah Munoz  ',
    email: 'hannah@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'active',
    priceGbp: 3.99,
    consumedTokens: 0,
    quotaTokens: 16_000_000,
  });
  assert.equal(named.name, 'Hannah Munoz', 'trimmed, so the table does not indent one row');
  const unnamed = computeUserRow({
    email: 'nobody@example.co.uk',
    tierId: null,
    subscriptionStatus: 'inactive',
    consumedTokens: 0,
    quotaTokens: 0,
  });
  assert.equal(unnamed.name, '', 'the screen falls back to the email, and must never print undefined');
});

test('a lapsed subscription now costs nothing: there is no runner left to bill', () => {
  const row = computeUserRow({
    email: 'churned@example.co.uk',
    tierId: 'studio',
    subscriptionStatus: 'canceled',
    consumedTokens: 0,
    quotaTokens: 16_000_000,
  });
  assert.equal(row.revenueGbp, 0);
  assert.equal(row.marginGbp, 0, 'no runner, no volume, no cost');
  assert.equal(row.marginPct, null);
});

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------
test('every projection carries the fixed costs exactly once', () => {
  const { scenarios } = computeProjections({ counts: [10, 100] });
  for (const s of scenarios) {
    const [p10, p100] = s.points;
    assert.equal(p10.fixedGbp, fixedCostsGbpMonthly());
    assert.equal(p10.fixedGbp, p100.fixedGbp, 'fixed costs do not scale with subscribers');
    assert.ok(Math.abs(p100.revenueGbp - p10.revenueGbp * 10) < 0.01, 'revenue does scale');
  }
});

test('break-even answers the question Alex actually asks: how many customers', () => {
  const { scenarios } = computeProjections();
  const light = scenarios.find((s) => s.key === 'light');
  const maxed = scenarios.find((s) => s.key === 'maxed');
  assert.ok(light.breakEvenSubscribers > 0, 'a light customer book does break even');
  assert.ok(
    maxed.breakEvenSubscribers === null || maxed.breakEvenSubscribers > light.breakEvenSubscribers,
    'heavier customers need more of them, or never get there',
  );
  for (const target of light.targets) {
    assert.ok(target.subscribers > light.breakEvenSubscribers, `£${target.profitGbp} needs more than break-even`);
  }
});

test('a heavier customer contributes less, and the order is never inverted', () => {
  const { scenarios } = computeProjections();
  const contributions = scenarios.map((s) => s.contributionGbp);
  for (let i = 1; i < contributions.length; i += 1) {
    assert.ok(contributions[i] <= contributions[i - 1], 'contribution must fall as usage rises');
  }
});

test("Apple's share of the book moves the answer, because its cut is four times Stripe's", () => {
  const allStripe = computeProjections({ appleShare: 0 }).scenarios[0];
  const allApple = computeProjections({ appleShare: 1 }).scenarios[0];
  assert.ok(allApple.contributionGbp < allStripe.contributionGbp);
  assert.ok(allApple.breakEvenSubscribers > allStripe.breakEvenSubscribers);
});

test('projections state their assumptions alongside the numbers', () => {
  const { assumptions } = computeProjections();
  assert.match(assumptions.inference, /metered tokens/);
  assert.match(assumptions.billing, /Apple/);
  assert.match(assumptions.fx, /£1/);
  assert.match(assumptions.fixed, /fixed costs/);
});

test('the measured persona is the median of a usage WINDOW, not of the billing cycle', () => {
  const s = (tokens, talkSeconds) => ({ tokens, talkSeconds });
  assert.equal(
    measuredPersona([s(1, 0), s(2, 0)]),
    null,
    'two customers is not a sample; say nothing rather than invent a typical customer',
  );

  // The live shape on 2026-09-19: six payers, two of whom have never sent a
  // message. The old percentile-of-this-cycle code answered 0 tokens for both
  // the light AND the typical customer, which told Alex his customers cost
  // nothing to serve.
  const real = measuredPersona([s(0, 0), s(0, 0), s(39_207, 15), s(148_204, 0), s(227_906, 0), s(2_599_443, 8)]);
  assert.ok(real.tokens > 0, 'a book where two thirds of payers DO use it cannot have a zero median');
  assert.equal(real.tokens, Math.round((39_207 + 148_204) / 2), 'even count takes the mean of the middle two');
  assert.match(real.note, /2 of whom used nothing at all/, 'the quiet ones are named, not hidden');
  assert.match(real.note, /30 days/, 'the window is stated on the row itself');

  // A mean would be dragged to ~502k by the one heavy user, which is above the
  // 90th percentile of this book and describes nobody in it.
  assert.ok(real.tokens < 500_000, 'the median resists one heavy customer; a mean would not');
});

test('the planning personas stay fixed, so "how many do I need" has a stable answer', () => {
  assert.deepEqual(
    MODEL_PERSONAS.map((p) => p.key),
    ['light', 'typical', 'heavy', 'maxed'],
  );
  assert.equal(MODEL_PERSONAS.at(-1).tokens, 16_000_000, 'the worst case is the allowance the engine enforces');
  assert.equal(MODEL_PERSONAS.at(-1).talkSeconds, 900, 'and every minute of Talk the plan allows');
  for (let i = 1; i < MODEL_PERSONAS.length; i += 1) {
    assert.ok(MODEL_PERSONAS[i].tokens > MODEL_PERSONAS[i - 1].tokens, 'personas ascend');
  }
});

test('the biller fee helpers agree with each other', () => {
  for (const provider of ['stripe', 'apple']) {
    assert.ok(
      Math.abs(netOfBillingFees(3.99, provider) + billingFeeGbp(3.99, provider) - 3.99) < 1e-9,
      `${provider}: net + fee must equal the price`,
    );
  }
  assert.equal(netOfBillingFees(0, 'stripe'), 0, 'no revenue means no fee, not a negative one');
  assert.equal(inferenceGbpForTokens(0), 0);
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
test('important dates include the Microsoft secret expiry Alex remembered, with countdown', () => {
  const dates = buildImportantDates(new Date('2026-08-04T00:00:00Z'));
  const ms = dates.find((d) => /Microsoft OAuth client secrets/.test(d.label));
  assert.ok(ms, 'the 24-month Microsoft secret expiry must be tracked');
  assert.equal(ms.due, '2028-07-31');
  assert.ok(ms.daysLeft > 700 && ms.daysLeft < 740);
  assert.equal(ms.status, 'verify');
});

test('every derived date is marked verify or pending, never silently confirmed', () => {
  for (const d of buildImportantDates(new Date())) {
    assert.ok(['confirmed', 'verify', 'pending'].includes(d.status));
    // Nothing in v1 is confirmed: every date is an inference until a human
    // checks it at the source. If someone confirms one, they change this.
    assert.notEqual(d.status, 'confirmed', `${d.label} claims confirmed without a human having verified it`);
  }
});

// ---------------------------------------------------------------------------
// Customer funnel classification (Alex, launch day: active vs past vs the
// paywall bounces the ads are judged by)
// ---------------------------------------------------------------------------
test('an in-good-standing subscription is an active customer', () => {
  assert.equal(classifyCustomer({ subscriptionStatus: 'active', stripeCustomerId: 'cus_1' }), 'active');
  assert.equal(classifyCustomer({ subscriptionStatus: 'trialing', stripeCustomerId: 'cus_2' }), 'active');
});

test('paid-before-but-lapsed is a PAST customer, not a prospect: Stripe knew them', () => {
  assert.equal(classifyCustomer({ subscriptionStatus: 'canceled', stripeCustomerId: 'cus_3' }), 'past');
  assert.equal(classifyCustomer({ subscriptionStatus: 'inactive', stripeCustomerId: 'cus_4' }), 'past');
});

test('signed in but never reached Stripe is a prospect: the paywall-bounce signal', () => {
  assert.equal(classifyCustomer({ subscriptionStatus: 'inactive', stripeCustomerId: null }), 'prospect');
  // A canceled status with no Stripe id cannot mean a paying past: no money
  // ever moved. Classify by the money trail, not the status string.
  assert.equal(classifyCustomer({ subscriptionStatus: 'canceled', stripeCustomerId: null }), 'prospect');
});

test('an Apple subscriber who lapsed is a PAST customer: Apple is their money trail', () => {
  assert.equal(
    classifyCustomer({ subscriptionStatus: 'canceled', stripeCustomerId: null, appleOriginalTransactionId: '500003037687946' }),
    'past',
  );
  assert.equal(
    classifyCustomer({ subscriptionStatus: 'trialing', stripeCustomerId: null, appleOriginalTransactionId: '230003694328400' }),
    'active',
  );
});

test('an App Store sandbox purchase is a tester, never a customer (the 17 that were 16, 2026-09-23)', () => {
  // A reviewer's sandbox subscription renews on Apple's accelerated clock, so it
  // read "active" on the dashboard and inflated the count Alex watches.
  assert.equal(isAppleSandbox({ billing_provider: 'apple', apple_environment: 'Sandbox' }), true);
  assert.equal(isAppleSandbox({ billing_provider: 'apple', apple_environment: 'Production' }), false);
  assert.equal(isAppleSandbox({ billing_provider: 'stripe', apple_environment: null }), false);
  assert.equal(isAppleSandbox({ billing_provider: 'apple' }), false, 'no environment recorded is not proof of a tester');
  assert.equal(isAppleSandbox(undefined), false);
});

test('the subscription select asks for every column the customer lists need', () => {
  // The same trap as the price columns: PostgREST returns only what is
  // selected, so a missing apple_environment would arrive undefined and the
  // sandbox filter would silently let every tester through.
  for (const column of CUSTOMER_COLUMNS) {
    assert.ok(SUBSCRIPTION_COLUMNS.includes(column), `${column} is read to classify a customer but is not in the select`);
  }
});

// ---------------------------------------------------------------------------
// Capital expenditure ledger
// ---------------------------------------------------------------------------
test('the capex ledger matches the FreeAgent-transcribed total to the penny', () => {
  // £854.39 of director-paid expenses (26) plus £155.93 of Mettle card
  // purchases (8), both in FreeAgent's own GBP at each transaction date,
  // transcribed 2026-08-12. If this fails because the ledger was updated,
  // recompute against FreeAgent, not against the old number.
  assert.equal(capexReceiptedTotalGbp(), 1010.32);
  for (const row of CAPEX_LEDGER) {
    assert.ok(row.amountGbp > 0, `${row.vendor} has no amount`);
    assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/, `${row.vendor} has a malformed date`);
  }
});

// ---------------------------------------------------------------------------
// Fixed costs sanity
// ---------------------------------------------------------------------------
test('fixed costs are itemised, non-negative, and sum to the advertised total', () => {
  let sum = 0;
  for (const c of FIXED_MONTHLY_COSTS) {
    assert.ok(c.gbpMonthly >= 0, `${c.label} is negative`);
    assert.ok(c.note.length > 0, `${c.label} has no provenance note`);
    sum += c.gbpMonthly;
  }
  assert.equal(Math.round(sum * 100) / 100, fixedCostsGbpMonthly());
});
