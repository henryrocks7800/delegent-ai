import { createClient } from '@supabase/supabase-js';
import { coordinatePurchase, createPurchaseIntentStore, purchaseStripeClientFromBilling } from '@sidekick/billing/purchase-intents';
import { type StripeServerEnv } from '@sidekick/billing/server-flow';
import { isUserAllowlistedForAppleIap, type AppleIapEnv } from './apple-iap.js';
import { createWorkerStripeBillingClient } from './stripe.js';

type AdmissionEnv = AppleIapEnv & StripeServerEnv;
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Called only after the Worker's authenticated-user resolver. Body never chooses the account. */
export async function handleApplePurchaseAdmission(request: Request, env: AdmissionEnv, userId: string): Promise<Response> {
  if (!uuid(userId)) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ error: 'purchase_coordination_unavailable' }, { status: 503 });
  }
  const cancel = new URL(request.url).pathname.endsWith('/cancel');
  // A user may release their own pending attempt even after the allowlist or
  // provider configuration changes. This never cancels a paid subscription.
  if (!cancel) {
    if (!isUserAllowlistedForAppleIap(env, userId)) return Response.json({ error: 'not_allowlisted' }, { status: 403 });
    if (![env.APPLE_IAP_KEY_P8, env.APPLE_IAP_KEY_ID, env.APPLE_IAP_ISSUER_ID, env.STRIPE_SECRET_KEY]
      .every(value => typeof value === 'string' && value.trim())) {
      return Response.json({ error: 'apple_iap_not_configured' }, { status: 503 });
    }
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'invalid_json' }, { status: 400 });
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  try {
    if (cancel) {
      if (!uuid(body.intentId)) return Response.json({ error: 'invalid_purchase_intent' }, { status: 400 });
      const result = await client.rpc('cancel_billing_apple_purchase_intent', { p_user_id: userId, p_intent_id: body.intentId });
      if (result.error || !['canceled','completed','not_found','not_pending'].includes(String(result.data))) {
        throw new Error('purchase_cancel_unavailable');
      }
      if (result.data === 'not_found') return Response.json({ error: 'purchase_intent_not_found' }, { status: 404 });
      if (result.data !== 'canceled') return Response.json({ error: 'subscription_payment_pending' }, { status: 409 });
      return Response.json({ canceled: true });
    }
    const tierId = body.tierId;
    if (tierId !== 'studio' && tierId !== 'pro-office' && tierId !== 'enterprise-suite') {
      return Response.json({ error: 'unknown_tier' }, { status: 400 });
    }
    const result = await coordinatePurchase({ userId, provider: 'apple', tierId },
      createPurchaseIntentStore(async (name, args) => await client.rpc(name, args)),
      purchaseStripeClientFromBilling(createWorkerStripeBillingClient(env.STRIPE_SECRET_KEY!)));
    if (result.kind === 'apple') return Response.json({ intentId: result.intentId, expiresAt: result.expiresAt });
    const error = result.kind === 'already_entitled' ? 'already_subscribed_via_stripe'
      : result.kind === 'reconciliation_required' ? 'purchase_requires_review'
      : result.kind === 'payment_pending' ? 'subscription_payment_pending' : 'purchase_pending';
    return Response.json({ error }, { status: result.kind === 'busy' ? 503 : 409 });
  } catch {
    return Response.json({ error: 'purchase_coordination_unavailable' }, { status: 503 });
  }
}
