import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import {
  createSupabaseStripeBillingStore,
  handleStripeWebhookRequest,
  type StripeServerEnv,
} from '../../../../lib/server/stripeRealFlow';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const env = stripeServerEnv();
  const stripe = new Stripe(env.STRIPE_SECRET_KEY || 'sk_test_webhook_verification_unused', { apiVersion: '2026-04-22.dahlia' });
  const supabase = createClient(
    env.SUPABASE_URL || 'https://missing.supabase.co',
    env.SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key',
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );

  return handleStripeWebhookRequest(request, {
    env,
    store: createSupabaseStripeBillingStore(supabase),
    verifyStripeWebhookEvent(rawBody, signature, webhookSecret) {
      return Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },
    async retrieveStripeInvoice(id) {
      if (!env.STRIPE_SECRET_KEY) throw new Error('stripe_key_missing');
      return await stripe.invoices.retrieve(id) as unknown as Record<string, unknown>;
    },
    async retrieveStripeCharge(id) {
      return await stripe.charges.retrieve(id) as unknown as Record<string, unknown>;
    },
    async retrieveStripeDispute(id) {
      return await stripe.disputes.retrieve(id) as unknown as Record<string, unknown>;
    },
    async retrieveStripeSubscription(id) {
      return await stripe.subscriptions.retrieve(id) as unknown as Record<string, unknown>;
    },
    async listStripeInvoicePayments(paymentIntentId, startingAfter) {
      return await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId },
        status: 'paid', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    },
  });
}

function stripeServerEnv(): StripeServerEnv {
  return {
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}
