// Cap-reached notification (2026-07-30).
//
// A paying user exhausted his token allowance on 2026-07-20 and heard nothing for
// nine days. What must hold:
//   • one email per cap kind per billing period, and it re-arms on the next one;
//   • only caps the USER can act on: never `rate`, `concurrent` or `global_spend`,
//     because our org-wide spend guard is our problem and telling a customer about
//     it is both confusing and a disclosure;
//   • the copy says what ran out, when it clears, and what to do, without any
//     token counts, byte counts, or infrastructure names;
//   • nothing throws, and a failed send is not marked so the next denial retries.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CAP_NOTICE_METADATA_KEY,
  capNoticeSubject,
  hasNotifiedCapThisPeriod,
  isNotifiableCapKind,
  maybeSendCapNoticeEmail,
  renderCapNoticeEmailHtml,
  withCapNoticeMarker,
} from '../dist/cap-notice-email.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CYCLE = '2026-07-01T00:00:00.000Z';
const RESETS = '2026-08-01T00:00:00.000Z';

function fakeStore({ email = 'alex@example.com', appMetadata = {} } = {}) {
  const calls = { marked: 0, lastMetadata: null };
  return {
    calls,
    async getUser() { return { email, appMetadata }; },
    async markNotified(_userId, metadata) { calls.marked += 1; calls.lastMetadata = metadata; },
  };
}

function fakeSender({ ok = true } = {}) {
  const sends = [];
  return { sends, send: async (to, subject, html) => { sends.push({ to, subject, html }); return ok; } };
}

function input(overrides = {}) {
  return {
    userId: USER_ID,
    capKind: 'token',
    billingCycleStartIso: CYCLE,
    resetsOnIso: RESETS,
    warn: () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Which caps are the user's to act on
// ---------------------------------------------------------------------------
test('only user-actionable caps are notifiable', () => {
  for (const kind of ['token', 'storage', 'voice']) assert.equal(isNotifiableCapKind(kind), true, kind);
  for (const kind of ['rate', 'concurrent', 'global_spend', 'nonsense']) {
    assert.equal(isNotifiableCapKind(kind), false, kind);
  }
});

test('our own spend guard and rate limits never email the customer', async () => {
  for (const capKind of ['global_spend', 'rate', 'concurrent']) {
    const store = fakeStore();
    const sender = fakeSender();
    await maybeSendCapNoticeEmail({ ...input({ capKind }), store, send: sender.send });
    assert.equal(sender.sends.length, 0, capKind);
    assert.equal(store.calls.marked, 0);
  }
});

// ---------------------------------------------------------------------------
// Once per period, re-arming on the next
// ---------------------------------------------------------------------------
test('the first denial of a period sends, and the marker records the period', async () => {
  const store = fakeStore();
  const sender = fakeSender();
  await maybeSendCapNoticeEmail({ ...input(), store, send: sender.send });
  assert.equal(sender.sends.length, 1);
  assert.equal(sender.sends[0].to, 'alex@example.com');
  assert.equal(store.calls.marked, 1);
  assert.deepEqual(store.calls.lastMetadata[CAP_NOTICE_METADATA_KEY], { token: CYCLE });
});

test('later denials in the SAME period are silent', async () => {
  const store = fakeStore({ appMetadata: { [CAP_NOTICE_METADATA_KEY]: { token: CYCLE } } });
  const sender = fakeSender();
  await maybeSendCapNoticeEmail({ ...input(), store, send: sender.send });
  assert.equal(sender.sends.length, 0);
  assert.equal(store.calls.marked, 0);
});

test('the notice re-arms on the next billing period without anything clearing it', async () => {
  const store = fakeStore({ appMetadata: { [CAP_NOTICE_METADATA_KEY]: { token: CYCLE } } });
  const sender = fakeSender();
  await maybeSendCapNoticeEmail({
    ...input({ billingCycleStartIso: '2026-08-01T00:00:00.000Z', resetsOnIso: '2026-09-01T00:00:00.000Z' }),
    store, send: sender.send,
  });
  assert.equal(sender.sends.length, 1);
  assert.deepEqual(store.calls.lastMetadata[CAP_NOTICE_METADATA_KEY], { token: '2026-08-01T00:00:00.000Z' });
});

test('each cap kind is tracked separately and preserves the others', async () => {
  const store = fakeStore({ appMetadata: { welcome_email_sent_at: 'x', [CAP_NOTICE_METADATA_KEY]: { token: CYCLE } } });
  const sender = fakeSender();
  await maybeSendCapNoticeEmail({ ...input({ capKind: 'storage' }), store, send: sender.send });
  assert.equal(sender.sends.length, 1);
  assert.deepEqual(store.calls.lastMetadata[CAP_NOTICE_METADATA_KEY], { token: CYCLE, storage: CYCLE });
  // Unrelated app_metadata must survive the merge, or we would silently un-send
  // somebody's welcome email marker and back-mail them.
  assert.equal(store.calls.lastMetadata.welcome_email_sent_at, 'x');
});

test('a missing billing cycle sends nothing, because there is no way to stop it repeating', async () => {
  for (const billingCycleStartIso of [null, '', '   ']) {
    const store = fakeStore();
    const sender = fakeSender();
    await maybeSendCapNoticeEmail({ ...input({ billingCycleStartIso }), store, send: sender.send });
    assert.equal(sender.sends.length, 0);
  }
});

test('marker helpers tolerate junk metadata', () => {
  assert.equal(hasNotifiedCapThisPeriod(null, 'token', CYCLE), false);
  assert.equal(hasNotifiedCapThisPeriod({}, 'token', CYCLE), false);
  assert.equal(hasNotifiedCapThisPeriod({ [CAP_NOTICE_METADATA_KEY]: 'nope' }, 'token', CYCLE), false);
  assert.equal(hasNotifiedCapThisPeriod({ [CAP_NOTICE_METADATA_KEY]: [] }, 'token', CYCLE), false);
  assert.equal(hasNotifiedCapThisPeriod({ [CAP_NOTICE_METADATA_KEY]: { token: CYCLE } }, 'token', CYCLE), true);
  assert.deepEqual(withCapNoticeMarker(null, 'voice', CYCLE), { [CAP_NOTICE_METADATA_KEY]: { voice: CYCLE } });
  assert.deepEqual(withCapNoticeMarker({ [CAP_NOTICE_METADATA_KEY]: 'junk' }, 'voice', CYCLE), {
    [CAP_NOTICE_METADATA_KEY]: { voice: CYCLE },
  });
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
test('the token notice says what ran out, when it clears, and what to do', () => {
  const details = { capKind: 'token', billingCycleStartIso: CYCLE, resetsOnIso: RESETS };
  assert.equal(capNoticeSubject(details), 'Your coworker has reached this month’s limit');
  const html = renderCapNoticeEmailHtml(details);
  assert.match(html, /1 August 2026/);
  assert.match(html, /Manage plan/);
  assert.match(html, /still there/);
});

test('the storage notice does not promise a reset date, because space does not refresh', () => {
  const html = renderCapNoticeEmailHtml({ capKind: 'storage', billingCycleStartIso: CYCLE, resetsOnIso: RESETS });
  assert.match(html, /full/);
  assert.match(html, /deleting files/);
  assert.doesNotMatch(html, /refreshes on/);
});

test('the voice notice reassures that typing still works', () => {
  const html = renderCapNoticeEmailHtml({ capKind: 'voice', billingCycleStartIso: CYCLE, resetsOnIso: RESETS });
  assert.match(html, /Typing still works/);
  assert.match(html, /1 August 2026/);
});

test('an unknown reset date degrades to a truthful sentence rather than a wrong date', () => {
  const html = renderCapNoticeEmailHtml({ capKind: 'token', billingCycleStartIso: CYCLE, resetsOnIso: null });
  assert.match(html, /refreshes when your plan next renews/);
  assert.doesNotMatch(html, /Invalid Date|NaN|null/);
});

test('no cap notice leaks counts, infrastructure, or em dashes', () => {
  for (const capKind of ['token', 'storage', 'voice']) {
    const details = { capKind, billingCycleStartIso: CYCLE, resetsOnIso: RESETS };
    const text = `${capNoticeSubject(details)} ${renderCapNoticeEmailHtml(details)}`;
    assert.doesNotMatch(text, /—/, capKind);
    assert.doesNotMatch(text, /sk_|whsec_|service-role|supabase|fly\.io|openrouter|cloudflare|hermes|\brunner\b|\bworker\b/i, capKind);
    assert.doesNotMatch(text, /\btokens?\b|\bbytes?\b|\bGB\b|\bquota\b/i, capKind);
  }
});

// ---------------------------------------------------------------------------
// Best-effort contract
// ---------------------------------------------------------------------------
test('a failed send is not marked, so the next denial retries it', async () => {
  const store = fakeStore();
  const sender = fakeSender({ ok: false });
  await maybeSendCapNoticeEmail({ ...input(), store, send: sender.send });
  assert.equal(sender.sends.length, 1);
  assert.equal(store.calls.marked, 0);
});

test('a user with no usable email is skipped without marking', async () => {
  for (const email of [null, '', 'not-an-email']) {
    const store = fakeStore({ email });
    const sender = fakeSender();
    await maybeSendCapNoticeEmail({ ...input(), store, send: sender.send });
    assert.equal(sender.sends.length, 0);
    assert.equal(store.calls.marked, 0);
  }
});

test('never throws, whatever the store or sender does', async () => {
  await maybeSendCapNoticeEmail({
    ...input(),
    store: { async getUser() { throw new Error('auth admin down'); }, async markNotified() {} },
    send: async () => true,
  });
  const store = fakeStore();
  await maybeSendCapNoticeEmail({
    ...input(), store, send: async () => { throw new Error('resend down'); },
  });
  assert.equal(store.calls.marked, 0);
});
