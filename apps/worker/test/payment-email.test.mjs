// Payment confirmation email (2026-07-30) — extraction, copy, and the
// once-per-invoice contract.
//
// Alex paid and got nothing: Stripe's own customer receipt is off (the live-mode
// default) and `charge.receipt_number` was empty on every charge we had taken. So
// the product sends its own. What must hold:
//   • the SERVICE period comes from the invoice LINE, not the invoice header —
//     the header is degenerate (start === end) on a subscription_create invoice,
//     which would tell the customer their month covers zero days;
//   • exactly one email per invoice, even though Stripe delivers BOTH
//     `invoice.paid` and `invoice.payment_succeeded` for the same invoice;
//   • a one-off charge (no subscription) never produces a renewal promise;
//   • the copy states the amount, the period, and what happens next;
//   • nothing throws (it runs behind ctx.waitUntil).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendSentInvoiceId,
  extractPaymentReceiptDetails,
  formatEmailAmount,
  formatEmailDate,
  maybeSendPaymentReceiptEmail,
  paymentReceiptSubject,
  renderPaymentReceiptEmailHtml,
} from '../dist/payment-email.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PERIOD_START = 1_780_000_000; // 2026-05-29T09:46:40Z
const PERIOD_END = 1_782_592_000; // 2026-06-28T09:46:40Z

function paidInvoice(overrides = {}) {
  return {
    id: 'in_test_receipt',
    object: 'invoice',
    number: 'DELEGENT-0007',
    status: 'paid',
    currency: 'gbp',
    amount_paid: 3000,
    hosted_invoice_url: 'https://invoice.stripe.com/i/test',
    // Degenerate on purpose: a subscription_create invoice really does report the
    // same value for both, so the resolver must not trust the header.
    period_start: PERIOD_START,
    period_end: PERIOD_START,
    subscription_details: {
      subscription: 'sub_test_receipt',
      metadata: { sidekickUserId: USER_ID },
    },
    lines: {
      data: [
        {
          subscription: 'sub_test_receipt',
          metadata: { sidekickUserId: USER_ID, priceLookupKey: 'sidekick_studio_monthly' },
          period: { start: PERIOD_START, end: PERIOD_END },
          pricing: { type: 'price_details', price_details: { price: 'price_test', product: 'prod_test' } },
        },
      ],
    },
    ...overrides,
  };
}

function fakeStore(user) {
  const calls = { markSent: 0, lastInvoiceId: null };
  return {
    calls,
    async getUser() { return user; },
    async markSent(_userId, invoiceId) { calls.markSent += 1; calls.lastInvoiceId = invoiceId; },
  };
}

function fakeSender({ ok = true } = {}) {
  const sends = [];
  return { sends, send: async (to, subject, html) => { sends.push({ to, subject, html }); return ok; } };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
test('the service period comes from the invoice line, not the degenerate header', () => {
  const details = extractPaymentReceiptDetails(paidInvoice());
  assert.equal(details.userId, USER_ID);
  assert.equal(details.invoiceId, 'in_test_receipt');
  assert.equal(details.invoiceNumber, 'DELEGENT-0007');
  assert.equal(details.amountMinorUnits, 3000);
  assert.equal(details.currency, 'gbp');
  assert.equal(details.periodStartIso, new Date(PERIOD_START * 1000).toISOString());
  assert.equal(details.periodEndIso, new Date(PERIOD_END * 1000).toISOString());
  assert.equal(details.planName, 'Studio');
  assert.equal(details.willRenew, true);
  assert.equal(details.invoiceUrl, 'https://invoice.stripe.com/i/test');
});

test('an invoice with no subscription behind it is not a subscription receipt', () => {
  const oneOff = paidInvoice({ subscription_details: undefined, lines: { data: [{ period: { start: PERIOD_START, end: PERIOD_END } }] }, metadata: { sidekickUserId: USER_ID } });
  assert.equal(extractPaymentReceiptDetails(oneOff), null);
});

test('a cancelled subscription is reported as not renewing', () => {
  const details = extractPaymentReceiptDetails(paidInvoice({
    subscription: {
      id: 'sub_test_receipt',
      cancel_at_period_end: true,
      metadata: { sidekickUserId: USER_ID },
    },
  }));
  assert.equal(details.willRenew, false);
});

test('portal cancellation date suppresses a false renewal promise on the receipt', () => {
  const details = extractPaymentReceiptDetails(paidInvoice({ subscription: {
    id: 'sub_test_receipt', cancel_at_period_end: false, cancel_at: PERIOD_END,
    metadata: { sidekickUserId: USER_ID },
  } }));
  assert.equal(details.willRenew, false);
  assert.doesNotMatch(renderPaymentReceiptEmailHtml(details), /renews automatically/);
});

test('an unresolvable or nonsensical invoice yields nothing rather than a wrong receipt', () => {
  assert.equal(extractPaymentReceiptDetails(null), null);
  assert.equal(extractPaymentReceiptDetails({}), null);
  // No user id anywhere: we would not know who to mail.
  assert.equal(extractPaymentReceiptDetails(paidInvoice({
    subscription_details: { subscription: 'sub_x' },
    lines: { data: [{ subscription: 'sub_x', period: { start: PERIOD_START, end: PERIOD_END } }] },
  })), null);
  // Inverted period: better to send nothing than a period that ends before it starts.
  assert.equal(extractPaymentReceiptDetails(paidInvoice({
    lines: {
      data: [{
        subscription: 'sub_test_receipt',
        metadata: { sidekickUserId: USER_ID, priceLookupKey: 'sidekick_studio_monthly' },
        period: { start: PERIOD_END, end: PERIOD_START },
      }],
    },
  })), null);
});

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
test('the subject and body state the amount, the plan, and the exact period covered', () => {
  const details = extractPaymentReceiptDetails(paidInvoice());
  const subject = paymentReceiptSubject(details);
  assert.match(subject, /Studio plan/);
  assert.match(subject, /28 May 2026 to 27 June 2026/);

  // No em dashes in anything a customer reads.
  assert.doesNotMatch(subject, /—/);

  const html = renderPaymentReceiptEmailHtml(details);
  assert.doesNotMatch(html, /—/);
  assert.match(html, /£30\.00/);
  assert.match(html, /28 May 2026 to 27 June 2026/);
  assert.match(html, /renews automatically on/);
  assert.match(html, /Manage plan/);
  assert.match(html, /View your invoice/);
  // The customer-facing receipt must never leak infrastructure or secrets.
  assert.doesNotMatch(html, /sk_|whsec_|service-role|supabase|fly\.io|openrouter|cloudflare|\brunner\b/i);
});

test('a cancelled plan is told it is ending, not that it will renew', () => {
  const details = extractPaymentReceiptDetails(paidInvoice({
    subscription: { id: 'sub_test_receipt', cancel_at_period_end: true, metadata: { sidekickUserId: USER_ID } },
  }));
  const html = renderPaymentReceiptEmailHtml(details);
  assert.match(html, /turned off automatic renewal/);
  assert.match(html, /you will not be charged again/);
  assert.doesNotMatch(html, /renews automatically/);
});

test('a hostile plan name renders as text rather than markup', () => {
  const html = renderPaymentReceiptEmailHtml({
    userId: USER_ID,
    invoiceId: 'in_x',
    invoiceNumber: '<script>alert(1)</script>',
    amountMinorUnits: 3000,
    currency: 'gbp',
    periodStartIso: new Date(PERIOD_START * 1000).toISOString(),
    periodEndIso: new Date(PERIOD_END * 1000).toISOString(),
    planName: '<img src=x onerror=1>',
    willRenew: true,
    invoiceUrl: null,
  });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('amount and date formatting is unambiguous', () => {
  assert.equal(formatEmailAmount(3000, 'gbp'), '£30.00');
  assert.equal(formatEmailAmount(7500, 'GBP'), '£75.00');
  assert.equal(formatEmailAmount(1234, 'sek'), '12.34 SEK');
  assert.equal(formatEmailDate('2026-06-01T00:00:00.000Z'), '1 June 2026');
});

// ---------------------------------------------------------------------------
// Gating + idempotency
// ---------------------------------------------------------------------------
test('a paid renewal sends exactly one receipt', async () => {
  for (const eventType of ['invoice.payment_succeeded', 'invoice.paid']) {
    const store = fakeStore({ email: 'alex@example.com', sentInvoiceIds: [] });
    const sender = fakeSender();
    await maybeSendPaymentReceiptEmail({
      responseOk: true, eventType, invoice: paidInvoice(), store, send: sender.send, warn: () => {},
    });
    assert.equal(sender.sends.length, 1, eventType);
    assert.equal(sender.sends[0].to, 'alex@example.com');
    assert.equal(store.calls.markSent, 1);
    assert.equal(store.calls.lastInvoiceId, 'in_test_receipt');
  }
});

test('the SAME invoice arriving as both Stripe events sends only one email', async () => {
  // This is the whole reason the marker is per-invoice: Stripe fires invoice.paid
  // and invoice.payment_succeeded for one payment. A per-account timestamp would
  // let the second one through and the customer gets two receipts for one charge.
  const sentInvoiceIds = [];
  const sender = fakeSender();
  const store = {
    async getUser() { return { email: 'alex@example.com', sentInvoiceIds: [...sentInvoiceIds] }; },
    async markSent(_userId, invoiceId) { sentInvoiceIds.push(invoiceId); },
  };
  for (const eventType of ['invoice.paid', 'invoice.payment_succeeded']) {
    await maybeSendPaymentReceiptEmail({
      responseOk: true, eventType, invoice: paidInvoice(), store, send: sender.send, warn: () => {},
    });
  }
  assert.equal(sender.sends.length, 1);
  assert.deepEqual(sentInvoiceIds, ['in_test_receipt']);
});

test('does not send on an unrelated event, a failed webhook, or a zero-amount invoice', async () => {
  const cases = [
    { responseOk: true, eventType: 'customer.subscription.updated', invoice: paidInvoice() },
    { responseOk: false, eventType: 'invoice.payment_succeeded', invoice: paidInvoice() },
    { responseOk: true, eventType: 'invoice.payment_failed', invoice: paidInvoice() },
    // £0.00 is not a payment, and "you paid £0.00" is worse than saying nothing.
    { responseOk: true, eventType: 'invoice.paid', invoice: paidInvoice({ amount_paid: 0 }) },
  ];
  for (const base of cases) {
    const store = fakeStore({ email: 'alex@example.com', sentInvoiceIds: [] });
    const sender = fakeSender();
    await maybeSendPaymentReceiptEmail({ ...base, store, send: sender.send, warn: () => {} });
    assert.equal(sender.sends.length, 0, base.eventType);
    assert.equal(store.calls.markSent, 0);
  }
});

test('a failed send is not marked, so a Stripe redelivery retries it', async () => {
  const store = fakeStore({ email: 'alex@example.com', sentInvoiceIds: [] });
  const sender = fakeSender({ ok: false });
  await maybeSendPaymentReceiptEmail({
    responseOk: true, eventType: 'invoice.paid', invoice: paidInvoice(), store, send: sender.send, warn: () => {},
  });
  assert.equal(sender.sends.length, 1);
  assert.equal(store.calls.markSent, 0);
});

test('never throws, whatever the store or sender does', async () => {
  const exploding = {
    async getUser() { throw new Error('supabase down'); },
    async markSent() { throw new Error('should not reach'); },
  };
  await maybeSendPaymentReceiptEmail({
    responseOk: true, eventType: 'invoice.paid', invoice: paidInvoice(), store: exploding,
    send: async () => true, warn: () => {},
  });

  const store = fakeStore({ email: 'alex@example.com', sentInvoiceIds: [] });
  await maybeSendPaymentReceiptEmail({
    responseOk: true, eventType: 'invoice.paid', invoice: paidInvoice(), store,
    send: async () => { throw new Error('resend down'); }, warn: () => {},
  });
  assert.equal(store.calls.markSent, 0);
});

test('the remembered invoice list dedupes, keeps order, and stays bounded', () => {
  assert.deepEqual(appendSentInvoiceId(undefined, 'in_1'), ['in_1']);
  assert.deepEqual(appendSentInvoiceId(['in_1'], 'in_1'), ['in_1']);
  assert.deepEqual(appendSentInvoiceId(['in_1'], 'in_2'), ['in_1', 'in_2']);
  assert.deepEqual(appendSentInvoiceId('not-an-array', 'in_1'), ['in_1']);
  const many = Array.from({ length: 12 }, (_, i) => `in_${i}`);
  const capped = appendSentInvoiceId(many, 'in_new');
  assert.equal(capped.length, 8);
  assert.equal(capped.at(-1), 'in_new');
  assert.equal(capped[0], 'in_5');
});
