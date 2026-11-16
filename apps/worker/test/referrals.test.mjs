// IMPORTANT: imports the built Worker from `../dist/`. Run via `npm test`.
//
// Referrals (2026-09-23): "give a friend a free month, get one yourself".
// apps/worker/src/referrals.ts, tables in supabase/migrations/0077_referrals.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REFERRAL_CODE_PATTERN,
  REFERRAL_REWARDS_PER_YEAR,
  REFERRAL_REWARD_PENCE,
  canInvite,
  generateReferralCode,
  handleReferralGet,
  handleReferralRedeem,
  isNewToPaying,
  maybeRewardReferral,
  normaliseReferralCode,
  referralRewardDeps,
  referralShareText,
} from '../dist/referrals.js';

const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', STRIPE_SECRET_KEY: 'sk_test_x' };
const MEMBER = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';

/** A fetch stand-in routed by URL substring; records every call. */
function mockFetch(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', body: init.body, headers: init.headers ?? {} });
    for (const [needle, respond] of routes) {
      if (typeof needle === 'function' ? needle(u, init) : u.includes(needle)) return respond(u, init);
    }
    throw new Error(`unexpected fetch ${init.method ?? 'GET'} ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a code is 8 characters with nothing easily confused (no I, O, 0 or 1)', () => {
  for (let i = 0; i < 200; i++) assert.match(generateReferralCode(), REFERRAL_CODE_PATTERN);
  assert.equal(generateReferralCode(() => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])), 'ABCDEFGH');
  assert.equal(generateReferralCode(() => new Uint8Array(8).fill(31)), '99999999');
});

test('what someone types is forgiven for case, spaces and dashes, and nothing else', () => {
  assert.equal(normaliseReferralCode('abcd 2345'), 'ABCD2345');
  assert.equal(normaliseReferralCode(' ABCD-2345 '), 'ABCD2345');
  for (const bad of ['ABCD1234', 'ABCDO234', 'ABC2345', 'ABCD23456', '', null, 42, undefined]) {
    assert.equal(normaliseReferralCode(bad), null, String(bad));
  }
});

test('only a live member billed through Stripe can invite (the reward is a Stripe credit)', () => {
  assert.equal(canInvite({ status: 'active', billing_provider: 'stripe', stripe_customer_id: 'cus_1' }), true);
  assert.equal(canInvite({ status: 'trialing', billing_provider: null, stripe_customer_id: 'cus_1' }), true);
  assert.equal(canInvite({ status: 'active', billing_provider: 'apple', stripe_customer_id: null }), false, 'Apple: Guideline 3.1.1');
  assert.equal(canInvite({ status: 'canceled', billing_provider: 'stripe', stripe_customer_id: 'cus_1' }), false);
  assert.equal(canInvite({ status: 'active', billing_provider: 'stripe', stripe_customer_id: null }), false);
  assert.equal(canInvite(null), false);
});

test('only someone who has never paid can use an invite code', () => {
  assert.equal(isNewToPaying(null), true);
  assert.equal(isNewToPaying({ status: 'inactive', stripe_customer_id: null, apple_original_transaction_id: null }), true);
  assert.equal(isNewToPaying({ status: 'trialing', stripe_customer_id: 'cus_2' }), false);
  assert.equal(isNewToPaying({ status: 'canceled', stripe_customer_id: 'cus_2' }), false, 'a lapsed customer is not new');
  assert.equal(isNewToPaying({ status: 'canceled', apple_original_transaction_id: '2300036' }), false);
});

test('the share text carries the code and the install link, in the house style', () => {
  const text = referralShareText('ABCD2345');
  assert.match(text, /ABCD2345/);
  assert.match(text, /https:\/\/delegentai\.co\.uk\/install/);
  assert.match(text, /first month is free/);
  assert.match(text, /If you're on Android, enter my invite code ABCD2345 on the plan screen/, 'the code box is Android only, and the message must not promise otherwise');
  assert.doesNotMatch(text, /[\u2014\u2013]/);
});

test('GET: a member who cannot invite is told so, and no code is made', async () => {
  const m = mockFetch([['/subscriptions?', () => json(200, [{ status: 'active', billing_provider: 'apple', stripe_customer_id: null }])]]);
  try {
    const res = await handleReferralGet(ENV, MEMBER);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { eligible: false });
    assert.ok(!m.calls.some((c) => c.url.includes('referral_codes')));
  } finally { m.restore(); }
});

test('GET: a Stripe member gets a code on first ask, the same code after, and counts only', async () => {
  let stored = null;
  const m = mockFetch([
    ['/subscriptions?', () => json(200, [{ status: 'active', billing_provider: 'stripe', stripe_customer_id: 'cus_1' }])],
    [(u, i) => u.includes('/referral_codes?select=code'), () => json(200, stored ? [{ code: stored }] : [])],
    [(u, i) => u.includes('/referral_codes?on_conflict=user_id') && i.method === 'POST', (u, i) => { stored = JSON.parse(i.body).code; return json(201); }],
    ['/referrals?select=status', () => json(200, [{ status: 'pending' }, { status: 'rewarded' }, { status: 'void' }])],
  ]);
  try {
    const first = await (await handleReferralGet(ENV, MEMBER)).json();
    assert.equal(first.eligible, true);
    assert.match(first.code, REFERRAL_CODE_PATTERN);
    assert.equal(first.friendsJoined, 2, 'a voided referral is not a friend who joined');
    assert.equal(first.freeMonthsEarned, 1);
    assert.equal(first.rewardsPerYear, REFERRAL_REWARDS_PER_YEAR);
    assert.ok(!JSON.stringify(first).includes(FRIEND), 'never who joined');
    const again = await (await handleReferralGet(ENV, MEMBER)).json();
    assert.equal(again.code, first.code);
    assert.equal(m.calls.filter((c) => c.method === 'POST').length, 1, 'the code is made once');
  } finally { m.restore(); }
});

test('redeem: bad, unknown and own codes are refused before anything is written', async () => {
  const m = mockFetch([
    [(u) => u.includes('referral_codes?select=user_id&code=eq.ABCD2345'), () => json(200, [])],
    [(u) => u.includes('referral_codes?select=user_id&code=eq.MYNE2345'), () => json(200, [{ user_id: FRIEND }])],
  ]);
  try {
    assert.equal((await handleReferralRedeem(ENV, FRIEND, { code: 'nope' })).status, 400);
    assert.equal((await handleReferralRedeem(ENV, FRIEND, { code: 'abcd-2345' })).status, 404);
    const own = await handleReferralRedeem(ENV, FRIEND, { code: 'MYNE2345' });
    assert.equal(own.status, 400);
    assert.equal((await own.json()).error, 'invite_code_own');
    assert.ok(!m.calls.some((c) => c.method === 'POST'));
  } finally { m.restore(); }
});

test('redeem: an existing or past customer cannot use a code; a new account is linked once', async () => {
  let friendSub = [{ status: 'trialing', stripe_customer_id: 'cus_9' }];
  let inserted = 0;
  const m = mockFetch([
    [(u) => u.includes('referral_codes?select=user_id&code=eq.ABCD2345'), () => json(200, [{ user_id: MEMBER }])],
    ['/subscriptions?', () => json(200, friendSub)],
    [(u, i) => u.endsWith('/rest/v1/referrals') && i.method === 'POST', (u, i) => {
      inserted += 1;
      const body = JSON.parse(i.body);
      assert.deepEqual(body, { referrer_user_id: MEMBER, referred_user_id: FRIEND, code: 'ABCD2345' });
      return inserted === 1 ? json(201) : json(409, { code: '23505' });
    }],
  ]);
  try {
    const member = await handleReferralRedeem(ENV, FRIEND, { code: 'ABCD2345' });
    assert.equal(member.status, 409);
    assert.equal((await member.json()).error, 'invite_for_new_members');
    friendSub = [];
    const ok = await handleReferralRedeem(ENV, FRIEND, { code: 'abcd 2345' });
    assert.equal(ok.status, 200);
    const twice = await handleReferralRedeem(ENV, FRIEND, { code: 'ABCD2345' });
    assert.equal(twice.status, 409);
    assert.equal((await twice.json()).error, 'invite_code_already_used');
  } finally { m.restore(); }
});

// The reward ---------------------------------------------------------------
const paidInvoice = (amount = 399, userId = FRIEND) => ({
  id: 'in_1', amount_paid: amount, subscription: 'sub_1', period_start: 1_790_000_000, period_end: 1_792_600_000,
  subscription_details: { metadata: { sidekickUserId: userId } },
  lines: { data: [{ period: { start: 1_790_000_000, end: 1_792_600_000 } }] },
});
function deps(overrides = {}) {
  const log = [];
  return {
    log,
    pendingReferralFor: async (userId) => (userId === FRIEND ? { id: '7', referrerUserId: MEMBER } : null),
    rewardsSince: async () => 0,
    stripeCustomerOf: async () => 'cus_member',
    creditFreeMonth: async (customer, id) => { log.push(['credit', customer, id]); return 'cbtxn_1'; },
    markRewarded: async (id, ref) => { log.push(['rewarded', id, ref]); },
    markVoid: async (id, reason) => { log.push(['void', id, reason]); },
    warn: (m) => log.push(['warn', m]),
    ...overrides,
  };
}

test('a friend\'s first paid invoice gives the member a free month, once', async () => {
  const d = deps();
  assert.equal(await maybeRewardReferral({ responseOk: true, eventType: 'invoice.paid', invoice: paidInvoice(), deps: d }), 'rewarded');
  assert.deepEqual(d.log, [['credit', 'cus_member', '7'], ['rewarded', '7', 'cbtxn_1']]);
});

test('no reward for a free month, a failed webhook, another event, or someone nobody invited', async () => {
  const d = deps();
  assert.equal(await maybeRewardReferral({ responseOk: true, eventType: 'invoice.paid', invoice: paidInvoice(0), deps: d }), 'skipped', 'the £0 trial invoice');
  assert.equal(await maybeRewardReferral({ responseOk: false, eventType: 'invoice.paid', invoice: paidInvoice(), deps: d }), 'skipped');
  assert.equal(await maybeRewardReferral({ responseOk: true, eventType: 'checkout.session.completed', invoice: paidInvoice(), deps: d }), 'skipped');
  assert.equal(await maybeRewardReferral({ responseOk: true, eventType: 'invoice.paid', invoice: paidInvoice(399, MEMBER), deps: d }), 'skipped');
  assert.deepEqual(d.log, []);
});

test('twelve free months a year at most; the thirteenth referral is closed, not paid', async () => {
  const d = deps({ rewardsSince: async () => REFERRAL_REWARDS_PER_YEAR });
  assert.equal(await maybeRewardReferral({ responseOk: true, eventType: 'invoice.paid', invoice: paidInvoice(), deps: d }), 'void');
  assert.deepEqual(d.log, [['void', '7', 'yearly_limit']]);
});

test('a member with no Stripe customer keeps the reward waiting rather than losing it', async () => {
  const d = deps({ stripeCustomerOf: async () => null });
  assert.equal(await maybeRewardReferral({ responseOk: true, eventType: 'invoice.paid', invoice: paidInvoice(), deps: d }), 'pending');
  assert.ok(!d.log.some(([k]) => k === 'credit' || k === 'rewarded' || k === 'void'));
});

test('a failure never escapes: billing is never disturbed by the reward', async () => {
  const d = deps({ creditFreeMonth: async () => { throw new Error('stripe down'); } });
  assert.equal(await maybeRewardReferral({ responseOk: true, eventType: 'invoice.payment_succeeded', invoice: paidInvoice(), deps: d }), 'error');
  assert.ok(!d.log.some(([k]) => k === 'rewarded'));
});

test('the credit is one month at the plan price, negative, and idempotent per referral', async () => {
  const m = mockFetch([['api.stripe.com/v1/customers/cus_member/balance_transactions', () => json(200, { id: 'cbtxn_42' })]]);
  try {
    const ref = await referralRewardDeps(ENV).creditFreeMonth('cus_member', '7');
    assert.equal(ref, 'cbtxn_42');
    const call = m.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['idempotency-key'], 'referral-reward-7');
    const form = new URLSearchParams(String(call.body));
    assert.equal(form.get('amount'), String(-REFERRAL_REWARD_PENCE));
    assert.equal(REFERRAL_REWARD_PENCE, 399);
    assert.equal(form.get('currency'), 'gbp');
  } finally { m.restore(); }
});

test('marking a reward only moves a referral that is still pending', async () => {
  const m = mockFetch([[(u, i) => i.method === 'PATCH', () => json(204)]]);
  try {
    await referralRewardDeps(ENV).markRewarded('7', 'cbtxn_1');
    assert.match(m.calls[0].url, /referrals\?id=eq\.7&status=eq\.pending$/);
  } finally { m.restore(); }
});
