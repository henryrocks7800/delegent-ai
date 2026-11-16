// Welcome email (2026-07-18) — gating + idempotency + best-effort contract.
//
// maybeSendWelcomeEmailOnCheckout must:
//   • send exactly once on a fresh, OK checkout.session.completed;
//   • NOT send on other events / non-OK responses / already-welcomed users;
//   • skip cleanly when there's no user id or no email;
//   • only persist the once-per-account marker AFTER a successful send;
//   • never throw (it is fire-and-forget behind ctx.waitUntil).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  maybeSendWelcomeEmailOnCheckout,
  renderWelcomeEmailHtml,
  renderWelcomeBackEmailHtml,
  extractCheckoutUserId,
  WELCOME_EMAIL_SUBJECT,
  WELCOME_BACK_EMAIL_SUBJECT,
} from '../dist/welcome-email.js';

function fakeStore(user, { history } = {}) {
  const calls = { markSent: 0, lastMarked: null, welcomeBack: [] };
  const store = {
    calls,
    async getUser() { return user; },
    async markSent(userId) { calls.markSent += 1; calls.lastMarked = userId; },
  };
  if (history !== undefined) {
    store.getWorkspaceHistory = async () => history;
    store.markWelcomeBackSent = async (userId, sessionId) => { calls.welcomeBack.push({ userId, sessionId }); };
  }
  return store;
}

function fakeSender({ ok = true } = {}) {
  const sends = [];
  return { sends, send: async (to, html, subject) => { sends.push({ to, html, subject }); return ok; } };
}

const OK_SESSION = { client_reference_id: 'user-123' };

test('fires once on a fresh OK checkout.session.completed', async () => {
  const store = fakeStore({ email: 'new@customer.com', alreadySent: false });
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: OK_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 1);
  assert.equal(sender.sends[0].to, 'new@customer.com');
  assert.equal(sender.sends[0].subject, WELCOME_EMAIL_SUBJECT);
  assert.equal(store.calls.markSent, 1);
  assert.equal(store.calls.lastMarked, 'user-123');
});

// --- Welcome back (2026-07-30): a returning customer must never get the
// --- "Welcome to Delegent AI" onboarding email again.

const RESUB_SESSION = { id: 'cs_resub_1', client_reference_id: 'user-123' };

test('a returning customer with a retained workspace gets the welcome-back email, not the onboarding one', async () => {
  // Alex's exact case: account predates the welcome-email feature, so
  // alreadySent=false, yet the resubscribe must NOT read "Welcome to".
  const store = fakeStore(
    { email: 'back@customer.com', alreadySent: false, welcomeBackSessionIds: [] },
    { history: 'retained' },
  );
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: RESUB_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 1);
  assert.equal(sender.sends[0].subject, WELCOME_BACK_EMAIL_SUBJECT);
  assert.match(sender.sends[0].html, /Welcome back\./);
  assert.match(sender.sends[0].html, /kept your files/);
  assert.doesNotMatch(sender.sends[0].html, /Welcome aboard\./);
  assert.equal(store.calls.markSent, 0, 'the once-per-account onboarding marker must stay untouched');
  assert.deepEqual(store.calls.welcomeBack, [{ userId: 'user-123', sessionId: 'cs_resub_1' }]);
});

test('a returning customer who was already welcomed still gets the welcome-back email on a later resubscribe', async () => {
  const store = fakeStore(
    { email: 'back@customer.com', alreadySent: true, welcomeBackSessionIds: ['cs_old_9'] },
    { history: 'retained' },
  );
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: RESUB_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 1);
  assert.equal(sender.sends[0].subject, WELCOME_BACK_EMAIL_SUBJECT);
});

test('an expired workspace gets the fresh-start wording, never a false continuity promise', async () => {
  const store = fakeStore(
    { email: 'back@customer.com', alreadySent: true, welcomeBackSessionIds: [] },
    { history: 'expired' },
  );
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: RESUB_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 1);
  assert.doesNotMatch(sender.sends[0].html, /kept your files/);
  assert.match(sender.sends[0].html, /setting your workspace up fresh/);
});

test('a Stripe redelivery of the same checkout session does not double-send the welcome-back email', async () => {
  const store = fakeStore(
    { email: 'back@customer.com', alreadySent: false, welcomeBackSessionIds: ['cs_resub_1'] },
    { history: 'retained' },
  );
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: RESUB_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 0);
  assert.deepEqual(store.calls.welcomeBack, []);
});

test('a failed welcome-back send is not marked, so a redelivered event can retry', async () => {
  const store = fakeStore(
    { email: 'back@customer.com', alreadySent: false, welcomeBackSessionIds: [] },
    { history: 'retained' },
  );
  const sender = fakeSender({ ok: false });
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: RESUB_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 1);
  assert.deepEqual(store.calls.welcomeBack, []);
});

test('a store without workspace-history support behaves exactly as before (onboarding path)', async () => {
  const store = fakeStore({ email: 'new@customer.com', alreadySent: false });
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: RESUB_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 1);
  assert.equal(sender.sends[0].subject, WELCOME_EMAIL_SUBJECT);
});

test('renderWelcomeBackEmailHtml mentions the separate receipt email and escapes a hostile agent name', () => {
  const html = renderWelcomeBackEmailHtml('<b>Evil</b>', true);
  assert.match(html, /payment receipt is on its way in a separate email/);
  assert.equal(html.includes('<b>Evil</b>'), false);
  assert.match(html, /&lt;b&gt;Evil&lt;\/b&gt;/);
  assert.equal(WELCOME_BACK_EMAIL_SUBJECT.includes('Welcome back to Delegent AI'), true);
});

test('does NOT send on a non-checkout event', async () => {
  const store = fakeStore({ email: 'a@b.com', alreadySent: false });
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'invoice.paid', session: OK_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 0);
  assert.equal(store.calls.markSent, 0);
});

test('does NOT send when the webhook response was not OK', async () => {
  const store = fakeStore({ email: 'a@b.com', alreadySent: false });
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: false, eventType: 'checkout.session.completed', session: OK_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 0);
});

test('idempotent: does NOT re-send when already welcomed', async () => {
  const store = fakeStore({ email: 'a@b.com', alreadySent: true });
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: OK_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 0);
  assert.equal(store.calls.markSent, 0);
});

test('skips (no throw) when the session has no user id', async () => {
  const store = fakeStore({ email: 'a@b.com', alreadySent: false });
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: {},
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 0);
});

test('skips when the user has no email', async () => {
  const store = fakeStore({ email: null, alreadySent: false });
  const sender = fakeSender();
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: OK_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 0);
  assert.equal(store.calls.markSent, 0);
});

test('does NOT mark sent when the send fails (so it can retry)', async () => {
  const store = fakeStore({ email: 'a@b.com', alreadySent: false });
  const sender = fakeSender({ ok: false });
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: OK_SESSION,
    store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 1);
  assert.equal(store.calls.markSent, 0);
});

test('never throws even if the store blows up', async () => {
  const throwingStore = { async getUser() { throw new Error('supabase down'); }, async markSent() {} };
  await maybeSendWelcomeEmailOnCheckout({
    responseOk: true, eventType: 'checkout.session.completed', session: OK_SESSION,
    store: throwingStore, send: async () => true, warn: () => {},
  });
  // reaching here without throwing is the assertion
  assert.ok(true);
});

test('extractCheckoutUserId reads client_reference_id then metadata.sidekickUserId', () => {
  assert.equal(extractCheckoutUserId({ client_reference_id: 'u1' }), 'u1');
  assert.equal(extractCheckoutUserId({ metadata: { sidekickUserId: 'u2' } }), 'u2');
  assert.equal(extractCheckoutUserId({}), null);
  assert.equal(extractCheckoutUserId(null), null);
});

test('renderWelcomeEmailHtml contains the approved copy + agent name', () => {
  const html = renderWelcomeEmailHtml('Ada');
  assert.match(html, /Welcome aboard\./);
  assert.match(html, /Open the app/);
  assert.match(html, /Read the guides/);
  assert.match(html, /delegentai\.co\.uk\/guides/);
  // The CTA must be the DEVICE-AWARE redirect, not a store. This asserted the
  // Play URL until 2026-08-31, which is what pinned the defect in place: iOS
  // went on sale and every "Open the app" button in the customer emails still
  // sent iPhone customers to Google Play, where they cannot install anything.
  assert.match(html, /delegentai\.co\.uk\/install/);
  assert.doesNotMatch(html, /play\.google\.com/, 'a single-store link strands the other platform');
  assert.match(html, /Ada/);
  assert.equal(WELCOME_EMAIL_SUBJECT.includes('Welcome to Delegent AI'), true);
});

test('renderWelcomeEmailHtml escapes a hostile agent name instead of rendering it', () => {
  const html = renderWelcomeEmailHtml('<img src=x onerror=alert(1)>');
  assert.equal(html.includes('<img src=x'), false, 'the name must not land as markup');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
