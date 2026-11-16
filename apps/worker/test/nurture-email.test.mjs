// 2026-09-09: the paywall-bounce nurture email. One email, about a day after
// sign-up, to people who created an account but never reached Stripe, never
// twice, never to the box's own identities, family, staff or Apple relays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SIDEKICK_FREE_TRIAL } from '@sidekick/shared';

import {
  selectNurtureRecipients,
  isNurtureExcludedEmail,
  buildNurtureEmailHtml,
  NURTURE_MIN_AGE_MS,
  NURTURE_MAX_AGE_MS,
} from '../dist/index.js';

const NOW = Date.parse('2026-09-10T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 60 * 60 * 1000;

test('excludes the box\'s own identities, family, staff, Apple relays and the business inbox', () => {
  for (const e of [
    'customer22@example.com', 'customer6@example.com', 'x@example.com',
    'a@cloudtestlabaccounts.com', 'abc123@privaterelay.appleid.com', 'owner@family.example', 'tester@example.com',
    'friend@example.com', 'customer82@example.com', '', 'not-an-email',
  ]) assert.equal(isNurtureExcludedEmail(e), true, e);
  for (const e of ['customer1@nhs.net', 'customer2@passmail.net', 'customer3@gmail.com'])
    assert.equal(isNurtureExcludedEmail(e), false, e);
});

test('picks accounts 24h to 14d old with no Stripe customer and no earlier email', () => {
  const candidates = [
    { id: 'fresh', email: 'fresh@gmail.com', createdAt: ago(6 * H) },              // too new
    { id: 'due', email: 'due@gmail.com', createdAt: ago(30 * H) },                 // due
    { id: 'paid', email: 'paid@gmail.com', createdAt: ago(30 * H) },               // reached Stripe
    { id: 'active', email: 'active@gmail.com', createdAt: ago(30 * H) },           // subscribed
    { id: 'done', email: 'done@gmail.com', createdAt: ago(30 * H) },               // already emailed
    { id: 'old', email: 'old@gmail.com', createdAt: ago(20 * 24 * H) },            // too old
    { id: 'test', email: 'customer22@example.com', createdAt: ago(30 * H) },
    { id: 'edge', email: 'edge@gmail.com', createdAt: ago(NURTURE_MAX_AGE_MS - H) }, // just inside
  ];
  const subs = [
    { user_id: 'paid', status: 'inactive', stripe_customer_id: 'cus_1' },
    { user_id: 'active', status: 'active', stripe_customer_id: null },
    { user_id: 'due', status: 'inactive', stripe_customer_id: null },
  ];
  const sent = [{ user_id: 'done' }];
  const out = selectNurtureRecipients(candidates, subs, sent, NOW).map((c) => c.id);
  assert.deepEqual(out, ['due', 'edge']);
  assert.equal(NURTURE_MIN_AGE_MS, 24 * H);
});

test('the email carries the price, and the reply-to-unsubscribe line', () => {
  const { subject, html } = buildNurtureEmailHtml();
  assert.equal(subject, 'Your AI coworker is still waiting');
  // Every new sign-up is a coworker (agent engine) account, so the offer in
  // the email is that plan's offer at checkout (AGENT_PLAN), never Studio.
  assert.match(html, /your first month free<\/strong>, then &pound;3\.99 a month/);
  assert.match(html, /connected AI coworker/);
  assert.doesNotMatch(html, /assistant/i, 'the word is coworker everywhere (Alex, 2026-09-16)');
  assert.doesNotMatch(html, /Studio|9\.99|2\.99|employee|workspace/);
  assert.match(html, /reply with &quot;unsubscribe&quot;/);
  assert.doesNotMatch(html, /—/, 'no em dashes');
});
