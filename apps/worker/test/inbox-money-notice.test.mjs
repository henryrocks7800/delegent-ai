import assert from 'node:assert/strict';
import test from 'node:test';
import { handleInboxNotice, moneyNoticeText, parseMoneyNotice, parseSortNotice } from '../dist/inbox-notice.js';
// Use the engine's real signer to catch cross-service protocol drift.
import { inboxNoticeHeaders } from '../../agent/src/inboxNotice.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const SECRET = 'synthetic-internal-secret';
const env = { SIDEKICK_AGENT_SHARED_SECRET: SECRET, SIDEKICK_AGENT_ENGINE_USER_IDS: USER,
  AGENT: { fetch() { throw new Error('No model or agent callback is needed'); } },
  SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-role' };
const report = (changes = {}) => ({ kind: 'money', id: crypto.randomUUID(), runId: crypto.randomUUID(), provider: 'gmail', outcome: 'report',
  read: 214, owedPence: 24_399, subscriptionCount: 2, subscriptionsYearlyPence: 25_488, priceRisesYearlyPence: 2_400, trialsEnding: 1,
  items: [
    { kind: 'flight_compensation', merchant: 'Example Air', amountPence: 22_000, yearlyPence: 0, detail: 'LGW to BCN, arrived about 4 hours late' },
    { kind: 'refund_due', merchant: 'Shop A', amountPence: 2_399, yearlyPence: 0, detail: 'promised but never confirmed as paid' },
    { kind: 'price_rise', merchant: 'Streamer', amountPence: 1_299, yearlyPence: 2_400, detail: 'went up from £10.99 to £12.99' },
    { kind: 'trial_ending', merchant: 'News Plus', amountPence: 799, yearlyPence: 0, detail: 'free trial ends 2026-10-05' },
    { kind: 'subscription', merchant: 'Streamer', amountPence: 1_299, yearlyPence: 15_588, detail: 'monthly charge' },
    { kind: 'subscription', merchant: 'Cloud Box', amountPence: 9_900, yearlyPence: 9_900, detail: 'yearly charge' },
  ], ...changes });

test('a money report reads as fixed wording with the amounts, and says nothing was sent', () => {
  const text = moneyNoticeText(parseMoneyNotice(report()));
  assert.match(text, /^I checked 214 likely emails in your Gmail inbox\./);
  assert.match(text, /Money you may be owed, about £243\.99:\n- Example Air, LGW to BCN, arrived about 4 hours late: up to £220\.00 flight compensation\n- Shop A: a £23\.99 refund, promised but never confirmed as paid/);
  assert.match(text, /- Streamer went up from £10\.99 to £12\.99, £24\.00 a year more/);
  assert.match(text, /- News Plus: free trial ends 2026-10-05, then £7\.99/);
  assert.match(text, /Subscriptions, 2 costing about £254\.88 a year:\n- Streamer: £12\.99 monthly charge, £155\.88 a year\n- Cloud Box: £99\.00 yearly charge, £99\.00 a year/);
  assert.match(text, /Flight claims are possible, not certain/);
  assert.match(text, /Nothing was sent or changed\./);
});

test('nothing found and a failure each have their own honest message', () => {
  assert.match(moneyNoticeText(parseMoneyNotice(report({ items: [], owedPence: 0, subscriptionCount: 0, subscriptionsYearlyPence: 0, priceRisesYearlyPence: 0, trialsEnding: 0 }))),
    /found nothing to chase/);
  assert.match(moneyNoticeText(parseMoneyNotice(report({ outcome: 'failed', items: [] }))), /couldn't finish checking your Gmail inbox/);
});

test('the money parser is strict: exact keys, bounded values, no items on a failure, and names cannot inject Markdown', () => {
  assert.equal(parseMoneyNotice(report({ extra: 1 })), null);
  assert.equal(parseMoneyNotice(report({ owedPence: -1 })), null);
  assert.equal(parseMoneyNotice(report({ outcome: 'failed' })), null, 'a failure carries no items');
  assert.equal(parseMoneyNotice(report({ items: Array.from({ length: 16 }, () => report().items[0]) })), null);
  assert.equal(parseMoneyNotice(report({ items: [{ ...report().items[0], kind: 'lottery' }] })), null);
  assert.equal(parseMoneyNotice(report({ items: [{ ...report().items[0], detail: 'x'.repeat(121) }] })), null);
  assert.equal(parseSortNotice(report()), null, 'a money notice is never read as a sort');
  const text = moneyNoticeText(parseMoneyNotice(report({ items: [{ ...report().items[4], merchant: '[Click](https://evil.example)' }] })));
  assert.doesNotMatch(text, /\[Click\]\(/);
});

test('a signed money notice is stored as a system chat message and pushed once', async () => {
  const notice = report(); const body = JSON.stringify(notice); const writes = []; const pushes = [];
  const request = new Request('https://worker.invalid/internal/inbox-notice', { method: 'POST', body,
    headers: { 'content-type': 'application/json', ...(await inboxNoticeHeaders(SECRET, USER, body)) } });
  const response = await handleInboxNotice(request, env, {
    fetch: async (url, init) => {
      if (String(url).includes('account_deletion_requests')) return Response.json([]);
      writes.push(JSON.parse(init.body)); return Response.json([{ id: notice.id }]);
    },
    push: async (_env, userId, message) => { pushes.push([userId, message.title]); return 1; },
  });
  assert.equal(response.status, 204);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, notice.id);
  assert.equal(writes[0].channel, 'system');
  assert.match(writes[0].content, /Money you may be owed/);
  assert.deepEqual(pushes, [[USER, 'Your money check is ready']]);
});

test('an upgrade charged in full is listed as money owed with the fixed advice line', () => {
  const text = moneyNoticeText(parseMoneyNotice(report({ owedPence: 1_800, items: [
    { kind: 'upgrade_overcharge', merchant: 'Anthropic', amountPence: 1_800, yearlyPence: 0, detail: 'paid for Claude Pro on 2026-08-19, then Claude Max at full price on 2026-08-27 with no credit' },
  ] })));
  assert.match(text, /Money you may be owed, about £18\.00:\n- Anthropic: £18\.00 back, you paid for Claude Pro on 2026-08-19, then Claude Max at full price on 2026-08-27 with no credit/);
  assert.match(text, /ask the app store \(or the company\) to refund the earlier charge/);
});
