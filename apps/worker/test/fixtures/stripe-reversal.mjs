import Stripe from 'stripe';
import { handleStripeWebhookRequest } from '../../dist/stripe-flow.js';

export const USER = '11111111-1111-4111-8111-111111111111';
export function reversalFixture(options = {}) {
  const env = { STRIPE_WEBHOOK_SECRET: 'whsec_local_reversal_fixture', SUPABASE_URL: 'https://unit.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture', ...options.env };
  const calls = [];
  const ledger = new Map();
  const failures = new Set(options.failures ?? []);
  const called = (name, detail) => { calls.push({ name, detail }); if (failures.has(name)) throw new Error(`${name}_unavailable`); };
  const start = 1_900_000_000;
  const end = start + 2_592_000;
  const target = options.target === null ? null : {
    userId: USER, revision: 4, periodStart: new Date(start * 1000).toISOString(),
    periodEnd: new Date(end * 1000).toISOString(), invoiceId: 'in-current', ...options.target,
  };
  const deps = {
    env,
    verifyStripeWebhookEvent(raw, signature, secret) { return Stripe.webhooks.constructEvent(raw, signature, secret); },
    async retrieveStripeDispute(id) { called('dispute', id); return { id, charge: 'ch-fixture', status: 'needs_response', ...options.dispute }; },
    async retrieveStripeCharge(id) { called('charge', id); return { id, customer: 'cus-fixture', payment_intent: 'pi-fixture', refunded: true, ...options.charge }; },
    async listStripeInvoicePayments(id, after) {
      called('payments', { id, after });
      if (options.pages) return options.pages(after);
      return { has_more: false, data: [{ id: 'inpay-fixture', invoice: 'in-current', status: 'paid', amount_paid: 999,
        payment: { type: 'payment_intent', payment_intent: id } }] };
    },
    async retrieveStripeInvoice(id) { called('invoice', id); return { id, customer: 'cus-fixture', amount_paid: 999,
      parent: { subscription_details: { subscription: 'sub-fixture' } }, ...options.invoice }; },
    async retrieveStripeSubscription(id) { called('subscription', id); return { id, customer: 'cus-fixture', latest_invoice: 'in-current',
      items: { has_more: false, data: [{ current_period_start: start, current_period_end: end }] }, ...options.subscription }; },
    store: {
      async claimBillingEvent(input) {
        called('claim', input);
        const existing = ledger.get(input.provider_event_id);
        if (existing?.payload_hash && existing.payload_hash !== input.payload_hash) return { state: 'payload_mismatch', event: existing };
        if (['processed','ignored'].includes(existing?.status)) return { state: 'duplicate_terminal', event: existing };
        const event = { ...input, id: input.provider_event_id, status: 'processing' };
        ledger.set(event.id, event);
        return { state: 'claimed', event };
      },
      async updateBillingEvent(id, patch) { called('ledger', patch); Object.assign(ledger.get(id), patch); },
      async getStripeReversalTarget(customerId, subscriptionId) { called('target', { customerId, subscriptionId }); return target; },
      async applyStripeReversal(input) { called('apply', input); return options.outcome ?? 'applied'; },
      async applyEntitlement() { throw new Error('a reversal must not use ordinary grant handling'); },
    },
  };
  const event = (type = 'charge.refunded', overrides = {}) => ({ id: 'evt-reversal', type, created: start + 100,
    data: { object: type === 'charge.refunded' ? { id: 'ch-fixture', object: 'charge', refunded: true }
      : { id: 'dp-fixture', object: 'dispute', charge: 'ch-fixture', payment_intent: 'pi-fixture' } }, ...overrides });
  const request = (value, valid = true) => {
    const body = JSON.stringify(value);
    return new Request('https://api.test/api/stripe/webhook', { method: 'POST', body,
      headers: { 'stripe-signature': valid ? Stripe.webhooks.generateTestHeaderString({ payload: body, secret: env.STRIPE_WEBHOOK_SECRET }) : 'invalid' } });
  };
  return { calls, ledger, failures, deps, event, run: (value = event(), valid = true) => handleStripeWebhookRequest(request(value, valid), deps) };
}
