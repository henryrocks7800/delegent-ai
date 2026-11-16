import { prepareStripeCheckoutSession, type StripeBillingClient, type StripeCheckoutSessionCreateParams } from './index.js';
import { type PlanTierId } from '@sidekick/shared';

type Row = Record<string, unknown>;
const row = (v: unknown): Row | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const tier = (v: unknown): v is PlanTierId => ['studio','pro-office','enterprise-suite'].includes(String(v));
export type PurchaseProvider = 'stripe' | 'apple';
export type PurchaseBlock = 'busy' | 'payment_pending' | 'purchase_pending' | 'already_entitled' | 'reconciliation_required';
export interface PurchaseIntent {
  id: string; user_id: string; provider: PurchaseProvider; tier_id: PlanTierId; phase: string;
  request: Row; prepared_params: StripeCheckoutSessionCreateParams | null; provider_session_id: string | null;
  lease_token: string; expires_at: string; created_at: string;
}
export type PurchaseClaim = { kind: 'claimed'; action: 'create' | 'resume' | 'replace'; intent: PurchaseIntent }
  | { kind: PurchaseBlock };
export interface PurchaseIntentStore {
  claim(userId: string, provider: PurchaseProvider, tierId: PlanTierId, request: Row): Promise<PurchaseClaim>;
  update(intent: PurchaseIntent, action: 'prepare' | 'session' | 'expire_missing' | 'authorize_apple' | 'release', value?: unknown): Promise<boolean>;
}
export function createPurchaseIntentStore(rpc: (name: string, input: Row) => Promise<{ data: unknown; error?: unknown }>): PurchaseIntentStore {
  return {
    async claim(userId, provider, tierId, request) {
      const result = await rpc('claim_billing_purchase_intent', {
        p_user_id: userId, p_provider: provider, p_tier_id: tierId, p_request: request,
      });
      if (result.error) throw new Error('purchase_claim_failed');
      const data = row(result.data);
      if (['busy','payment_pending','purchase_pending','already_entitled','reconciliation_required'].includes(String(data?.kind))) {
        return { kind: data!.kind as PurchaseBlock };
      }
      const intent = row(data?.intent);
      if (data?.kind !== 'claimed' || !['create','resume','replace'].includes(String(data.action))
        || !intent || !uuid(intent.id) || intent.user_id !== userId || !uuid(intent.lease_token)
        || !['stripe','apple'].includes(String(intent.provider)) || !tier(intent.tier_id) || !row(intent.request)
        || typeof intent.created_at !== 'string' || !Number.isFinite(Date.parse(intent.created_at))
        || typeof intent.expires_at !== 'string' || !Number.isFinite(Date.parse(intent.expires_at))) {
        throw new Error('purchase_claim_invalid');
      }
      return data as unknown as PurchaseClaim;
    },
    async update(intent, action, value = {}) {
      const result = await rpc('update_billing_purchase_intent', {
        p_user_id: intent.user_id, p_intent_id: intent.id, p_lease_token: intent.lease_token,
        p_action: action, p_value: value,
      });
      if (result.error || typeof result.data !== 'boolean') throw new Error('purchase_update_failed');
      return result.data;
    },
  };
}

export interface PurchaseSession {
  id: string; status: 'open' | 'complete' | 'expired'; url?: string | null;
  client_reference_id: string | null; metadata: Record<string, string> | null;
  expires_at: number; subscription?: string | { id: string } | null;
}
export interface PurchaseStripeClient {
  billing: StripeBillingClient;
  retrieve(id: string): Promise<PurchaseSession>;
  expire(id: string): Promise<PurchaseSession>;
  list(input: { created: { gte: number; lte: number }; limit: 100; starting_after?: string }): Promise<{ data: PurchaseSession[]; has_more: boolean }>;
}
export function purchaseStripeClientFromBilling(billing: StripeBillingClient): PurchaseStripeClient {
  const sessions = billing.checkout.sessions;
  if (!sessions.retrieve || !sessions.expire || !sessions.list) throw new Error('purchase_provider_adapter_missing');
  return {
    billing,
    // Provider responses are checked by verifiedSession/recoverSession before
    // they authorize any transition, including identity, state and pagination.
    retrieve: async id => await sessions.retrieve!(id) as PurchaseSession,
    expire: async id => await sessions.expire!(id) as PurchaseSession,
    list: async input => await sessions.list!(input) as { data: PurchaseSession[]; has_more: boolean },
  };
}

function verifiedSession(session: PurchaseSession, intent: PurchaseIntent): PurchaseSession {
  if (!session || typeof session.id !== 'string' || !session.id || !['open','complete','expired'].includes(session.status)
    || session.client_reference_id !== intent.user_id || session.metadata?.purchaseIntentId !== intent.id
    || session.metadata?.sidekickUserId !== intent.user_id || session.metadata?.tierId !== intent.tier_id
    || session.expires_at !== Math.floor(Date.parse(intent.expires_at)/1000)
    || (intent.provider_session_id && session.id !== intent.provider_session_id)) {
    throw new Error('purchase_session_identity_mismatch');
  }
  return session;
}
async function recoverSession(intent: PurchaseIntent, stripe: PurchaseStripeClient): Promise<PurchaseSession | null> {
  if (intent.provider_session_id) return verifiedSession(await stripe.retrieve(intent.provider_session_id), intent);
  if (!intent.prepared_params) return null;
  let cursor: string | undefined;
  const seen = new Set<string>(), matches: PurchaseSession[] = [];
  for (let page = 0; page < 100; page++) {
    const result = await stripe.list({ created: { gte: Math.floor(Date.parse(intent.created_at)/1000)-300,
      lte: Math.floor(Date.parse(intent.expires_at)/1000) }, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
    if (!Array.isArray(result?.data) || typeof result.has_more !== 'boolean') throw new Error('purchase_recovery_invalid');
    for (const session of result.data) {
      if (!session?.id || seen.has(session.id)) throw new Error('purchase_recovery_pagination_invalid');
      seen.add(session.id);
      if (session.metadata?.purchaseIntentId === intent.id) matches.push(verifiedSession(session, intent));
    }
    if (!result.has_more) {
      if (matches.length > 1) throw new Error('purchase_recovery_ambiguous');
      return matches[0] ?? null;
    }
    if (!result.data.length) throw new Error('purchase_recovery_pagination_invalid');
    cursor = result.data.at(-1)!.id;
  }
  throw new Error('purchase_recovery_limit');
}

export interface CoordinatePurchaseInput {
  userId: string; provider: PurchaseProvider; tierId: PlanTierId;
  successUrl?: string; cancelUrl?: string; customerEmail?: string | null;
  existingStripeCustomerId?: string | null;
  /** The assistant plan (AGENT_PLAN). Frozen into the intent with the rest of the request. */
  plan?: 'assistant';
}
export type CoordinatedPurchase = { kind: PurchaseBlock }
  | { kind: 'checkout'; sessionId: string; url: string }
  | { kind: 'apple'; intentId: string; expiresAt: string };

/** Serialize admission and recover exact provider work across response loss. */
export async function coordinatePurchase(
  input: CoordinatePurchaseInput, store: PurchaseIntentStore, stripe: PurchaseStripeClient, now = Date.now,
): Promise<CoordinatedPurchase> {
  for (let step = 0; step < 3; step++) {
    const claim = await store.claim(input.userId, input.provider, input.tierId, {
      successUrl: input.successUrl ?? null, cancelUrl: input.cancelUrl ?? null,
      customerEmail: input.customerEmail ?? null, existingStripeCustomerId: input.existingStripeCustomerId ?? null,
      ...(input.plan ? { plan: input.plan } : {}),
    });
    if (claim.kind !== 'claimed') return claim;
    const intent = claim.intent;
    const save = async (action: Parameters<PurchaseIntentStore['update']>[1], value?: unknown) => {
      if (!await store.update(intent, action, value)) throw new Error('purchase_lease_changed');
    };
    try {
      if (intent.provider === 'apple') {
        if (input.provider !== 'apple' || claim.action === 'replace') throw new Error('purchase_claim_invalid');
        await save('authorize_apple');
        return { kind: 'apple', intentId: intent.id, expiresAt: intent.expires_at };
      }
      let session = await recoverSession(intent, stripe);
      if (!session && !intent.prepared_params && claim.action === 'replace') {
        await save('expire_missing');
        continue;
      }
      if (!session && Date.parse(intent.expires_at) <= now()) {
        // A complete listing found no session, and the immutable expiry has
        // elapsed. Even a late old create request cannot create payable work.
        await save('expire_missing');
        continue;
      }
      if (!session) {
        // Stripe requires 30 minutes remaining at creation. Never extend an
        // old intent's expiry or replay its key beyond Stripe's retention.
        if (Date.parse(intent.expires_at) < now()+30*60_000) return { kind: 'purchase_pending' };
        if (!intent.prepared_params) {
          const request = intent.request;
          if (typeof request.successUrl !== 'string' || typeof request.cancelUrl !== 'string'
            || typeof request.hasPriorSubscription !== 'boolean') throw new Error('purchase_request_invalid');
          const prepared = await prepareStripeCheckoutSession({
            userId: intent.user_id, tierId: intent.tier_id, successUrl: request.successUrl, cancelUrl: request.cancelUrl,
            customerEmail: typeof request.customerEmail === 'string' ? request.customerEmail : null,
            existingStripeCustomerId: typeof request.existingStripeCustomerId === 'string' ? request.existingStripeCustomerId : null,
            hasPriorSubscription: request.hasPriorSubscription, purchaseIntentId: intent.id,
            expiresAt: Math.floor(Date.parse(intent.expires_at)/1000), now,
            ...(request.plan === 'assistant' ? { plan: 'assistant' as const } : {}),
          }, stripe.billing);
          await save('prepare', prepared.params);
          intent.prepared_params = prepared.params;
        }
        const created = await stripe.billing.checkout.sessions.create(intent.prepared_params, { idempotencyKey: 'purchase-intent:'+intent.id });
        if (!created?.id) throw new Error('purchase_session_missing');
        session = verifiedSession(await stripe.retrieve(created.id), intent);
      }
      if (session.status === 'open' && claim.action === 'replace') {
        try { session = verifiedSession(await stripe.expire(session.id), intent); }
        catch { session = verifiedSession(await stripe.retrieve(session.id), intent); }
        // A concurrent payment may have completed while expiry was attempted.
        if (session.status === 'open') throw new Error('purchase_expiry_unconfirmed');
      }
      await save('session', { id: session.id, status: session.status,
        subscription: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null });
      if (session.status === 'complete') return { kind: 'payment_pending' };
      if (session.status === 'expired') continue;
      if (input.provider !== 'stripe' || typeof session.url !== 'string') throw new Error('purchase_session_missing_url');
      const url = new URL(session.url);
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password) {
        throw new Error('purchase_session_invalid_url');
      }
      return { kind: 'checkout', sessionId: session.id, url: session.url };
    } finally {
      // A failed release leaves a bounded lease. It never discards the frozen
      // request or permits a second provider call with different parameters.
      await store.update(intent,'release').catch(() => false);
    }
  }
  return { kind: 'busy' };
}
