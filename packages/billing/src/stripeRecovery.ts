import { getPlanTier } from '@sidekick/shared';
import { stripeCancellationAtPeriodEnd, stripeEntitlementStatus } from './index.js';
import { resolveSeries4SuspendRetentionSeconds, type CheckoutSubscriptionState, type StripeBillingStore, type StripeServerEnv } from './serverFlow.js';

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
export interface StripeRecoveryClient {
  customers: { list(input: { email: string; limit: number; starting_after?: string }): Promise<unknown> };
  subscriptions: { list(input: { customer: string; status: 'all'; limit: number; expand: string[]; starting_after?: string }): Promise<unknown> };
}

async function inventory(list: (cursor?: string) => Promise<unknown>): Promise<Row[]> {
  const rows: Row[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = row(await list(cursor));
    if (!result || !Array.isArray(result.data) || typeof result.has_more !== 'boolean') throw new Error('stripe_recovery_inventory_invalid');
    for (const value of result.data) {
      const item = row(value);
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new Error('stripe_recovery_inventory_invalid');
      seen.add(item.id); rows.push(item); cursor = item.id;
    }
    if (!result.has_more) return rows;
    if (!result.data.length) throw new Error('stripe_recovery_inventory_invalid');
  }
  throw new Error('stripe_recovery_inventory_limit');
}

function periodIso(sub: Row, field: 'current_period_start' | 'current_period_end'): string | null {
  const items = row(sub.items)?.data;
  for (const value of [sub[field], ...(Array.isArray(items) ? items.map(item => row(item)?.[field]) : [])]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const date = new Date(value * 1000);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

/** Complete provider evidence is required before checkout treats an account as unsubscribed. */
export async function reconcileStripeSubscriptionByEmail(
  env: StripeServerEnv, input: { userId: string; email: string },
  deps: { stripe: StripeRecoveryClient; store: Pick<StripeBillingStore, 'applyEntitlement'> },
): Promise<CheckoutSubscriptionState | null> {
  const customers = await inventory(cursor => deps.stripe.customers.list({ email: input.email, limit: 100,
    ...(cursor ? { starting_after: cursor } : {}) }));
  const candidates: { customer: Row; sub: Row; observedAt: string }[] = [];
  for (const customer of customers) {
    const observedAt = new Date().toISOString();
    const subscriptions = await inventory(cursor => deps.stripe.subscriptions.list({ customer: customer.id as string,
      status: 'all', limit: 100, expand: ['data.latest_invoice'], ...(cursor ? { starting_after: cursor } : {}) }));
    for (const sub of subscriptions) {
      if (typeof sub.status !== 'string') throw new Error('stripe_recovery_subscription_invalid');
      if (!['active', 'trialing', 'past_due'].includes(sub.status)) continue;
      const metadata = row(sub.metadata), customerMetadata = row(customer.metadata);
      // Explicit subscription ownership wins over a customer-level fallback.
      const owner = metadata?.sidekickUserId ?? customerMetadata?.sidekickUserId;
      if (owner !== input.userId) continue;
      candidates.push({ customer, sub, observedAt });
    }
  }
  // Do not choose the first subscription when an account already pays twice.
  // A later page/read failure also reaches here without any partial write.
  if (candidates.length > 1) throw new Error('stripe_recovery_multiple_subscriptions');
  const candidate = candidates[0];
  if (!candidate) return null;
  const { customer, sub, observedAt } = candidate;
  const metadata = row(sub.metadata), customerMetadata = row(customer.metadata);
  const tierId = metadata?.tierId ?? customerMetadata?.tierId;
  if (tierId !== 'studio' && tierId !== 'pro-office' && tierId !== 'enterprise-suite') throw new Error('stripe_recovery_tier_invalid');
  const items = row(sub.items)?.data;
  if (!Array.isArray(items) || items.length !== 1) throw new Error('stripe_recovery_items_invalid');
  const priceId = row(row(items[0])?.price)?.id;
  const periodStartIso = periodIso(sub, 'current_period_start'), periodEndIso = periodIso(sub, 'current_period_end');
  if (!periodStartIso || !periodEndIso || periodEndIso <= periodStartIso || typeof priceId !== 'string' || !priceId) {
    throw new Error('stripe_recovery_entitlement_incomplete');
  }
  const status = stripeEntitlementStatus(sub.status as 'active' | 'trialing' | 'past_due', sub);
  const nowIso = new Date().toISOString(), tier = getPlanTier(tierId);
  const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : row(sub.latest_invoice)?.id;
  const result = await deps.store.applyEntitlement({
    subscription: {
      user_id: input.userId, status, tier_id: tierId, stripe_customer_id: customer.id as string,
      stripe_subscription_id: sub.id as string, price_id: priceId,
      purchase_intent_id: typeof metadata?.purchaseIntentId === 'string' ? metadata.purchaseIntentId : undefined,
      stripe_entitlement_invoice_id: typeof invoiceId === 'string' ? invoiceId : undefined,
      current_period_start: periodStartIso, current_period_end: periodEndIso,
      cancel_at_period_end: stripeCancellationAtPeriodEnd(sub) ?? false,
      updated_at: nowIso, provider_updated_at: observedAt,
    },
    quota: { user_id: input.userId, tier_id: tierId, monthly_token_quota: tier.monthlyTokenQuota,
      storage_quota_bytes: tier.storageGb * 1024 ** 3, voice_seconds_quota: tier.voiceSecondsQuota,
      updated_at: nowIso, provider_updated_at: observedAt },
    eventKey: `stripe-recovery:${sub.id}:${nowIso}`, allowProviderSwitch: false,
    retentionSeconds: resolveSeries4SuspendRetentionSeconds(env),
  });
  if (result.outcome !== 'applied' && result.outcome !== 'duplicate') throw new Error(`stripe_recovery_${result.outcome}`);
  return { status, paymentRequired: status === 'canceled', tierId, stripeCustomerId: customer.id as string,
    stripeSubscriptionId: sub.id as string, priceId, currentPeriodEnd: periodEndIso, billingProvider: 'stripe' };
}
