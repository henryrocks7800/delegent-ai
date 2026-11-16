// Payment confirmation email (2026-07-30). Stripe has never emailed our
// customers a receipt: the account-level "Successful payments" customer email is
// off, which is the live-mode default, and there is no read API to detect that.
// The evidence is `charge.receipt_number` being empty on every charge we have
// taken. So the product sends its own confirmation, which is better anyway: it
// names the plan, states the exact service period the money covers, and says in
// plain words when the next charge lands.
//
// Strictly best-effort + fire-and-forget, the same contract as
// maybeSendWelcomeEmailOnCheckout: nothing here can affect the webhook response,
// billing, or provisioning.
//
// Idempotency is keyed on the Stripe invoice id, kept in the auth user's
// app_metadata (no migration). This matters: Stripe delivers BOTH
// `invoice.paid` and `invoice.payment_succeeded` for the same invoice, so a
// per-account "last sent" marker alone would double-send.

import { SIDEKICK_PLAN_TIERS } from '@sidekick/shared';
import { stripeCancellationAtPeriodEnd } from '@sidekick/billing';

export const PAYMENT_EMAIL_FROM = 'Delegent AI <hello@example.com>';
export const PAYMENT_EMAIL_REPLY_TO = 'accounts@example.com';

/** How many invoice ids we remember. Enough to cover a Stripe redelivery storm. */
const REMEMBERED_INVOICE_IDS = 8;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Stripe sends unix seconds. Zero is a real timestamp to Stripe but not to us. */
function isoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

/** "1 August 2026" — no ordinal suffix, unambiguous, and the same on both surfaces. */
export function formatEmailDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Stripe amounts are minor units. GBP is the only currency we sell in today. */
export function formatEmailAmount(amountMinorUnits: number, currency: string): string {
  const symbol = currency.toLowerCase() === 'gbp' ? '£' : currency.toLowerCase() === 'usd' ? '$' : currency.toLowerCase() === 'eur' ? '€' : '';
  const major = (amountMinorUnits / 100).toFixed(2);
  return symbol ? `${symbol}${major}` : `${major} ${currency.toUpperCase()}`;
}

function planNameForLookupKey(lookupKey: string | null): string | null {
  if (!lookupKey) return null;
  const tier = SIDEKICK_PLAN_TIERS.find((candidate) => candidate.stripePriceLookupKey === lookupKey);
  return tier ? tier.name : null;
}

export interface PaymentReceiptDetails {
  userId: string;
  invoiceId: string;
  /** Stripe's human invoice number, when it has assigned one. */
  invoiceNumber: string | null;
  amountMinorUnits: number;
  currency: string;
  periodStartIso: string;
  periodEndIso: string;
  planName: string | null;
  /** False when the customer has cancelled and this is their final period. */
  willRenew: boolean;
  /** Stripe's hosted invoice page, for the customer's own records. */
  invoiceUrl: string | null;
}

/**
 * Pull everything the receipt needs out of a paid invoice object.
 *
 * The service period is taken from the invoice LINE, not the invoice header: on
 * a `subscription_create` invoice the header's period_start and period_end are
 * degenerate (equal), so the header would tell the customer their month covers
 * zero days.
 */
export function extractPaymentReceiptDetails(
  invoice: Record<string, unknown> | null | undefined,
): PaymentReceiptDetails | null {
  if (!isRecord(invoice)) return null;

  const invoiceId = optionalString(invoice.id);
  if (!invoiceId) return null;

  const lines = isRecord(invoice.lines) && Array.isArray(invoice.lines.data) ? invoice.lines.data : [];
  const line = lines.find(isRecord) ?? null;
  const subscriptionDetails = isRecord(invoice.subscription_details) ? invoice.subscription_details : null;
  const expandedSubscription = isRecord(invoice.subscription) ? invoice.subscription : null;

  const userId =
    optionalString(isRecord(subscriptionDetails?.metadata) ? subscriptionDetails.metadata.sidekickUserId : null) ??
    optionalString(isRecord(line?.metadata) ? line.metadata.sidekickUserId : null) ??
    optionalString(isRecord(expandedSubscription?.metadata) ? expandedSubscription.metadata.sidekickUserId : null) ??
    optionalString(isRecord(invoice.metadata) ? invoice.metadata.sidekickUserId : null);
  if (!userId) return null;

  // An invoice with no subscription behind it is a one-off charge and is not a
  // subscription period the customer needs a renewal date for.
  const hasSubscription =
    Boolean(optionalString(invoice.subscription)) ||
    Boolean(expandedSubscription) ||
    Boolean(optionalString(subscriptionDetails?.subscription)) ||
    Boolean(optionalString(line?.subscription));
  if (!hasSubscription) return null;

  const linePeriod = isRecord(line?.period) ? line.period : null;
  const periodStartIso =
    isoFromUnixSeconds(linePeriod?.start) ??
    isoFromUnixSeconds(expandedSubscription?.current_period_start) ??
    isoFromUnixSeconds(invoice.period_start);
  const periodEndIso =
    isoFromUnixSeconds(linePeriod?.end) ??
    isoFromUnixSeconds(expandedSubscription?.current_period_end) ??
    isoFromUnixSeconds(invoice.period_end);
  if (!periodStartIso || !periodEndIso || Date.parse(periodEndIso) <= Date.parse(periodStartIso)) return null;

  const amount = typeof invoice.amount_paid === 'number' ? invoice.amount_paid : typeof invoice.total === 'number' ? invoice.total : null;
  if (amount === null || !Number.isFinite(amount) || amount < 0) return null;

  const priceDetails = isRecord(line?.pricing) && isRecord(line.pricing.price_details) ? line.pricing.price_details : null;
  const lookupKey =
    optionalString(isRecord(line?.metadata) ? line.metadata.priceLookupKey : null) ??
    optionalString(isRecord(line?.price) ? line.price.lookup_key : null) ??
    optionalString(priceDetails?.lookup_key) ??
    optionalString(isRecord(invoice.metadata) ? invoice.metadata.priceLookupKey : null);

  return {
    userId,
    invoiceId,
    invoiceNumber: optionalString(invoice.number),
    amountMinorUnits: amount,
    currency: optionalString(invoice.currency) ?? 'gbp',
    periodStartIso,
    periodEndIso,
    planName: planNameForLookupKey(lookupKey),
    willRenew: expandedSubscription
      ? stripeCancellationAtPeriodEnd({ ...expandedSubscription, current_period_end: Date.parse(periodEndIso) / 1000 }) !== true
      : true,
    invoiceUrl: optionalString(invoice.hosted_invoice_url),
  };
}

export function paymentReceiptSubject(details: PaymentReceiptDetails): string {
  const plan = details.planName ? `${details.planName} plan` : 'your plan';
  return `Your Delegent AI receipt: ${plan}, ${formatEmailDate(details.periodStartIso)} to ${formatEmailDate(details.periodEndIso)}`;
}

function row(label: string, value: string): string {
  return `
            <tr>
              <td style="padding:9px 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;color:#8a8577;vertical-align:top;width:44%;">${label}</td>
              <td style="padding:9px 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;color:#1C1A15;vertical-align:top;">${value}</td>
            </tr>`;
}

/** Render the payment confirmation email HTML. */
export function renderPaymentReceiptEmailHtml(details: PaymentReceiptDetails): string {
  const plan = escapeHtml(details.planName ?? 'Delegent AI');
  const amount = escapeHtml(formatEmailAmount(details.amountMinorUnits, details.currency));
  const from = escapeHtml(formatEmailDate(details.periodStartIso));
  const to = escapeHtml(formatEmailDate(details.periodEndIso));
  const reference = details.invoiceNumber ? escapeHtml(details.invoiceNumber) : null;
  const preheader = `${amount} paid. Your ${plan} plan covers ${from} to ${to}.`;

  const renewalLine = details.willRenew
    ? `Your plan renews automatically on <strong style="color:#1C1A15;">${to}</strong> and you will be charged ${amount} again. You can turn that off at any time in the app under Manage plan, and you keep everything you have paid for until the end of the period.`
    : `You have turned off automatic renewal, so this is your final period. Your plan ends on <strong style="color:#1C1A15;">${to}</strong> and you will not be charged again. You can restart it any time in the app under Manage plan.`;

  const invoiceButton = details.invoiceUrl
    ? `
        <tr><td align="center" style="padding:22px 32px 0 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td align="center" style="border-radius:12px;background:#2A4A3A;">
              <a href="${escapeHtml(details.invoiceUrl)}" style="display:inline-block;padding:13px 26px;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">View your invoice</a>
            </td>
          </tr></table>
        </td></tr>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Your Delegent AI receipt</title>
</head>
<body style="margin:0;padding:0;background:#F0EEE7;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#F0EEE7;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEE7;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #E5E2DA;border-radius:18px;overflow:hidden;">

        <tr><td align="center" style="padding:36px 32px 8px 32px;">
          <img src="https://delegentai.co.uk/app-icon.png" width="56" height="56" alt="Delegent AI" style="display:block;border-radius:14px;">
        </td></tr>
        <tr><td align="center" style="padding:0 32px 4px 32px;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:15px;color:#8a8577;letter-spacing:.3px;">Delegent AI</p>
        </td></tr>

        <tr><td align="center" style="padding:14px 40px 0 40px;">
          <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:400;font-size:30px;line-height:1.15;color:#1C1A15;">Thank you, that is paid.</h1>
        </td></tr>
        <tr><td align="center" style="padding:12px 44px 0 44px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#3a382f;">Here is exactly what you paid and the period it covers, for your records.</p>
        </td></tr>

        <tr><td style="padding:26px 32px 0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F4EE;border:1px solid #ECE9E1;border-radius:12px;">
            <tr><td style="padding:6px 18px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${row('Plan', plan)}
${row('Amount paid', amount)}
${row('Period covered', `${from} to ${to}`)}
${reference ? row('Reference', reference) : ''}
              </table>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:22px 32px 0 32px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.62;color:#3a382f;">${renewalLine}</p>
        </td></tr>
${invoiceButton}

        <tr><td style="padding:26px 32px 0 32px;"><div style="border-top:1px solid #ECE9E1;"></div></td></tr>

        <tr><td align="center" style="padding:22px 32px 4px 32px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#8a8577;">Questions about this payment? Reply to this email and a person will answer.</p>
        </td></tr>
        <tr><td align="center" style="padding:14px 32px 4px 32px;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:15px;color:#2A4A3A;">The Delegent AI Team</p>
          <p style="margin:6px 0 0 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;color:#a09b8d;"><a href="https://delegentai.co.uk" style="color:#a09b8d;text-decoration:none;">delegentai.co.uk</a></p>
        </td></tr>

        <tr><td align="center" style="padding:16px 40px 32px 40px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#b7b2a4;">You are receiving this because you have a paid Delegent AI plan. Delegent AI, registered in England and Wales ().</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Looks up the recipient and which invoices they have already been mailed about. */
export interface PaymentReceiptEmailStore {
  /** null = user not found. */
  getUser(userId: string): Promise<{ email: string | null; sentInvoiceIds: readonly string[] } | null>;
  /** Persist the per-invoice marker. */
  markSent(userId: string, invoiceId: string): Promise<void>;
}

const RECEIPT_EVENT_TYPES = new Set<string>(['invoice.payment_succeeded', 'invoice.paid']);

export interface MaybeSendPaymentReceiptInput {
  responseOk: boolean;
  eventType: string;
  /** The peeked (already signature-verified upstream) invoice object. */
  invoice: Record<string, unknown> | null;
  store: PaymentReceiptEmailStore;
  /** Returns true on a successful send. Must not throw. */
  send: (to: string, subject: string, html: string) => Promise<boolean>;
  /** Diagnostic sink (defaults to console.warn). */
  warn?: (message: string) => void;
}

/**
 * Email the customer their payment confirmation, once per invoice, when a
 * renewal or first charge succeeded. Best-effort: every failure path is caught
 * and logged, so a caller can `ctx.waitUntil` it safely.
 */
export async function maybeSendPaymentReceiptEmail(input: MaybeSendPaymentReceiptInput): Promise<void> {
  const warn = input.warn ?? ((m: string) => console.warn(m));
  try {
    if (!input.responseOk) return;
    if (!RECEIPT_EVENT_TYPES.has(input.eventType)) return;

    const details = extractPaymentReceiptDetails(input.invoice);
    if (!details) return;
    // A £0 invoice (a full-coupon period, or a proration that nets to nothing)
    // is not a payment, and telling someone "£0.00 paid" is worse than silence.
    if (details.amountMinorUnits <= 0) return;

    const user = await input.store.getUser(details.userId);
    if (!user) {
      warn(`[payment-email] skipped: user not found userId=${details.userId}`);
      return;
    }
    if (user.sentInvoiceIds.includes(details.invoiceId)) return; // idempotent
    if (!user.email || !user.email.includes('@')) {
      warn(`[payment-email] skipped: no usable email userId=${details.userId}`);
      return;
    }

    const ok = await input.send(user.email, paymentReceiptSubject(details), renderPaymentReceiptEmailHtml(details));
    if (!ok) {
      warn(`[payment-email] send failed userId=${details.userId} (will retry on a redelivery)`);
      return;
    }
    await input.store.markSent(details.userId, details.invoiceId);
  } catch (err) {
    // Best-effort: a receipt must never disturb billing or provisioning.
    warn(`[payment-email] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Append an invoice id to the remembered list, newest last, capped. */
export function appendSentInvoiceId(existing: unknown, invoiceId: string): string[] {
  const prior = Array.isArray(existing) ? existing.filter((v): v is string => typeof v === 'string') : [];
  const deduped = prior.filter((v) => v !== invoiceId);
  return [...deduped, invoiceId].slice(-REMEMBERED_INVOICE_IDS);
}
