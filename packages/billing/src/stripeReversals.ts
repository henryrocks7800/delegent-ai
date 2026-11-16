import type { StripeWebhookRouteDeps } from './serverFlow.js';

type Row = Record<string, unknown>;
export interface StripeReversalTarget {
  userId: string;
  revision: number;
  periodStart: string;
  periodEnd: string;
  invoiceId: string | null;
}
export interface StripeReversalInput extends StripeReversalTarget {
  customerId: string;
  subscriptionId: string;
  invoiceId: string;
  chargeId: string;
  eventKey: string;
  eventAt: string;
  reason: 'refund' | 'dispute';
  retentionSeconds: number;
}
const row = (value: unknown): Row | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const id = (value: unknown): string | null => typeof value === 'string' && value ? value : typeof row(value)?.id === 'string' ? row(value)!.id as string : null;
function iso(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

async function invoiceForCharge(charge: Row, deps: StripeWebhookRouteDeps): Promise<string> {
  const legacy = id(charge.invoice);
  if (legacy) return legacy;
  const paymentIntent = id(charge.payment_intent);
  if (!paymentIntent || !deps.listStripeInvoicePayments) throw new Error('reversal_invoice_lookup_unavailable');
  const invoices = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await deps.listStripeInvoicePayments(paymentIntent, cursor);
    if (!Array.isArray(result.data) || typeof result.has_more !== 'boolean') throw new Error('reversal_invoice_list_invalid');
    for (const value of result.data) {
      const payment = row(value);
      if (!payment || id(row(payment.payment)?.payment_intent) !== paymentIntent) throw new Error('reversal_invoice_payment_mismatch');
      const invoice = id(payment.invoice);
      if (payment.status === 'paid' && typeof payment.amount_paid === 'number' && payment.amount_paid > 0 && invoice) invoices.add(invoice);
    }
    if (!result.has_more) {
      if (invoices.size !== 1) throw new Error('reversal_invoice_missing_or_ambiguous');
      return [...invoices][0];
    }
    const next = id(result.data.at(-1));
    if (!next || next === cursor) throw new Error('reversal_invoice_pagination_invalid');
    cursor = next;
  }
  throw new Error('reversal_invoice_pagination_limit');
}

/** Called only after signature verification and durable event claiming. */
export async function processStripeReversal(
  event: unknown, deps: StripeWebhookRouteDeps, retentionSeconds: number,
): Promise<{ outcome: string; userId?: string }> {
  const envelope = row(event);
  const object = row(row(envelope?.data)?.object);
  const reason = envelope?.type === 'charge.refunded' ? 'refund' : 'dispute';
  if (reason === 'refund' && object?.refunded === false) return { outcome: 'ignored_partial_refund' };
  const chargeId = reason === 'refund' ? id(object) : id(object?.charge);
  const eventId = id(envelope);
  const eventAt = iso(envelope?.created);
  if (!chargeId || !eventId || !eventAt) throw new Error('reversal_event_incomplete');
  if (!deps.retrieveStripeCharge || !deps.retrieveStripeInvoice || !deps.retrieveStripeSubscription
    || !deps.store.getStripeReversalTarget || !deps.store.applyStripeReversal) throw new Error('reversal_dependencies_missing');
  if (reason === 'dispute') {
    const disputeId = id(object);
    if (!disputeId || !deps.retrieveStripeDispute) throw new Error('reversal_dispute_lookup_unavailable');
    const currentDispute = await deps.retrieveStripeDispute(disputeId);
    if (id(currentDispute) !== disputeId || id(currentDispute.charge) !== chargeId) throw new Error('reversal_dispute_mismatch');
    if (['won','prevented','warning_closed'].includes(String(currentDispute.status))) return { outcome: 'ignored_closed_dispute' };
    if (!['needs_response','under_review','lost','warning_needs_response','warning_under_review'].includes(String(currentDispute.status))) {
      throw new Error('reversal_dispute_status_unknown');
    }
  }
  const charge = await deps.retrieveStripeCharge(chargeId);
  const customerId = id(charge.customer);
  if (id(charge) !== chargeId || !customerId) throw new Error('reversal_charge_mismatch');
  if (reason === 'refund' && charge.refunded !== true) throw new Error('reversal_refund_not_confirmed');
  const invoiceId = await invoiceForCharge(charge, deps);
  const invoice = await deps.retrieveStripeInvoice(invoiceId);
  const subscriptionId = id(invoice.subscription) ?? id(row(row(invoice.parent)?.subscription_details)?.subscription);
  if (id(invoice) !== invoiceId || id(invoice.customer) !== customerId) throw new Error('reversal_invoice_mismatch');
  if (!subscriptionId) return { outcome: 'ignored_non_subscription_invoice' };
  if (typeof invoice.amount_paid !== 'number' || invoice.amount_paid <= 0) throw new Error('reversal_paid_invoice_unverified');

  // Read the local revision BEFORE fetching Stripe's current invoice. The
  // transaction refuses a concurrent renewal/upgrade after this snapshot.
  const target = await deps.store.getStripeReversalTarget(customerId, subscriptionId);
  if (!target) return { outcome: 'ignored_historical_subscription' };
  const current = await deps.retrieveStripeSubscription(subscriptionId);
  if (id(current) !== subscriptionId || id(current.customer) !== customerId) throw new Error('reversal_subscription_mismatch');
  if (id(current.latest_invoice) !== invoiceId) return { outcome: 'ignored_historical_invoice', userId: target.userId };
  const items = row(current.items);
  if (items?.has_more === true || !Array.isArray(items?.data) || items.data.length !== 1) throw new Error('reversal_subscription_items_ambiguous');
  const item = row(items.data[0]);
  const start = iso(current.current_period_start ?? item?.current_period_start);
  const end = iso(current.current_period_end ?? item?.current_period_end);
  if (!start || !end || start !== new Date(target.periodStart).toISOString()
    || end !== new Date(target.periodEnd).toISOString() || (target.invoiceId && target.invoiceId !== invoiceId)) {
    throw new Error('reversal_subscription_state_changed');
  }
  const outcome = await deps.store.applyStripeReversal({ ...target, customerId, subscriptionId, invoiceId,
    chargeId, eventKey: `stripe:${eventId}`, eventAt, reason, retentionSeconds });
  return { outcome, userId: target.userId };
}
