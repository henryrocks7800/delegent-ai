import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSortDuration, handleInboxNotice, parseSortNotice, sortEstimateMinutes, sortNoticeText } from '../dist/inbox-notice.js';
// Use the engine's real signer to catch cross-service protocol drift.
import { inboxNoticeHeaders } from '../../agent/src/inboxNotice.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const SECRET = 'synthetic-internal-secret';
const env = { SIDEKICK_AGENT_SHARED_SECRET: SECRET, SIDEKICK_AGENT_ENGINE_USER_IDS: USER,
  AGENT: { fetch() { throw new Error('No model or agent callback is needed'); } },
  SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-role' };
const plan = (changes = {}) => ({ kind: 'sort', id: crypto.randomUUID(), sortId: crypto.randomUUID(), provider: 'outlook', outcome: 'plan',
  total: 46_938, toFile: 37_156, stay: 9_782, filed: 0,
  groups: [{ name: 'Promotions', count: 18_707, newFolder: true }, { name: "Northfield St Mary's", count: 18_449, newFolder: false }], ...changes });

test('the plan message estimates the time from the counts, rounded up (calibrated 2026-09-24)', () => {
  // Outlook reads the whole inbox at about 1,000 emails a minute: the real 24 Sep run, 72,820 emails.
  assert.match(sortNoticeText(plan({ total: 72_820, toFile: 20_876, stay: 51_944,
    groups: [{ name: 'Promotions', count: 20_876, newFolder: true }] })), /It should take about 1 hour 15 minutes\./);
  assert.equal(formatSortDuration(sortEstimateMinutes('outlook', 210_000, 1)), 'about 3 hours 45 minutes');
  // Gmail files by search, so a small plan is quick.
  assert.match(sortNoticeText(plan({ provider: 'gmail', total: 400, toFile: 16, stay: 384,
    groups: [{ name: 'Promotions', count: 16, newFolder: true }] })), /It should take a few minutes\./);
  assert.equal(formatSortDuration(sortEstimateMinutes('gmail', 90_000, 60_000)), 'about 15 minutes');
});

test('a sort plan parses only when its counts add up', () => {
  assert.ok(parseSortNotice(plan()));
  assert.equal(parseSortNotice(plan({ stay: 1 })), null, 'total must equal filed plus kept');
  assert.equal(parseSortNotice(plan({ groups: [{ name: 'Promotions', count: 1, newFolder: true }] })), null, 'groups must add up to the plan');
  assert.equal(parseSortNotice(plan({ filed: 5 })), null, 'a plan has filed nothing yet');
  assert.equal(parseSortNotice(plan({ subject: 'leak' })), null, 'no extra fields, so no email content can ride along');
  assert.equal(parseSortNotice({ ...plan(), kind: 'preview' }), null);
  assert.ok(parseSortNotice(plan({ outcome: 'done', filed: 37_000, groups: [] })));
  assert.equal(parseSortNotice(plan({ outcome: 'done', filed: 40_000, groups: [] })), null, 'cannot report more filed than planned');
});

test('the plan message lists folders, marks new ones, asks once and makes no em dash', () => {
  const text = sortNoticeText(plan());
  assert.match(text, /I checked 46,938 emails and can file 37,156 of them/);
  assert.match(text, /- Promotions \(new folder\): 18,707/);
  assert.match(text, /- Northfield St Mary's: 18,449/);
  assert.match(text, /9,782 stay in your inbox/);
  assert.match(text, /Nothing has moved yet\. Shall I go ahead\? It should take about 50 minutes\. One yes sorts the lot/);
  assert.match(text, /You can keep using the app or close it/);
  assert.match(text, /Nothing is ever deleted or marked as read/);
  assert.doesNotMatch(text, /—/);
  const done = sortNoticeText(plan({ outcome: 'done', filed: 37_000, groups: [] }));
  assert.match(done, /Your Outlook inbox is sorted\. I filed 37,000 emails/);
  assert.match(done, /156 changed while I was working/);
  assert.match(sortNoticeText(plan({ outcome: 'failed', filed: 12, groups: [] })), /stopped after 12 emails/);
  const unplanned = sortNoticeText(plan({ outcome: 'failed', filed: 0, groups: [] }));
  assert.match(unplanned, /couldn't finish planning/);
  assert.match(unplanned, /Nothing was moved or changed/);
  assert.doesNotMatch(unplanned, /already filed/, 'a failed plan must not talk about filed emails');
  // QA F20, 2026-09-23: a tidy inbox read "I filed 0 emails into their folders, newest first".
  const tidy = sortNoticeText(plan({ outcome: 'done', total: 212, toFile: 0, stay: 212, filed: 0, groups: [] }));
  assert.equal(tidy, 'Your Outlook inbox is already tidy. I checked 212 emails and none of them need filing, so nothing was moved.');
  assert.ok(parseSortNotice(plan({ outcome: 'done', total: 212, toFile: 0, stay: 212, filed: 0, groups: [] })), 'a tidy result still parses');
});

test('a signed sort notice becomes one chat message and a generic push without folder names', async () => {
  const rows = new Map(); const pushes = [];
  const fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === '/rest/v1/account_deletion_requests') return Response.json([]);
    const value = JSON.parse(init.body);
    rows.set(value.id, value);
    return Response.json([{ id: value.id }], { status: 201 });
  };
  const notice = plan();
  const body = JSON.stringify(notice);
  const request = new Request('https://unit.test/internal/inbox-notice', { method: 'POST', body, headers: await inboxNoticeHeaders(SECRET, USER, body) });
  const response = await handleInboxNotice(request, env, { fetch, push: async (_env, userId, message) => { pushes.push({ userId, ...message }); return 1; } });
  assert.equal(response.status, 204);
  assert.match(rows.get(notice.id).content, /Here is the plan for your Outlook inbox/);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'Your inbox plan is ready');
  assert.doesNotMatch(JSON.stringify(pushes), /Promotions|Northfield|46,938/);
});
