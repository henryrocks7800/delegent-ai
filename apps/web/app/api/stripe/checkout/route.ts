import Stripe from 'stripe';
import { reconcileStripeSubscriptionByEmail } from '@sidekick/billing/stripe-recovery';
import { createPurchaseIntentStore } from '@sidekick/billing/purchase-intents';
import { createClient } from '@supabase/supabase-js';
import {
  type StripeBillingClient,
  type StripeBillingPortalSessionCreateParams,
  type StripeCheckoutSessionCreateParams,
  type StripePriceListParams,
  type StripeSubscriptionListParams,
  type StripeSubscriptionRetrieveParams,
} from '@sidekick/billing';
import {
  createSupabaseAuthResolver,
  createSupabaseStripeBillingStore,
  handleStripeCheckoutRequest,
  type CheckoutSubscriptionState,
  type StripeServerEnv,
} from '../../../../lib/server/stripeRealFlow';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const env = stripeServerEnv();
  return handleStripeCheckoutRequest(request, {
    env,
    purchaseIntentStore: createPurchaseIntentStore(async (name, args) => await createServiceSupabaseClient(env).rpc(name,args)),
    createStripeBillingClient(secretKey) {
      return createStripeBillingClient(secretKey);
    },
    async getAuthenticatedUser(token) {
      const supabase = createServerSupabaseClient(env);
      return createSupabaseAuthResolver(supabase)(token);
    },
    async reconcileStripeSubscriptionByEmail({ userId, email }) {
      return reconcileStripeSubscriptionByEmail(env, { userId, email }, {
        stripe: createStripeSDK(env.STRIPE_SECRET_KEY!),
        store: createSupabaseStripeBillingStore(createServiceSupabaseClient(env)),
      });
    },
    async getCheckoutSubscription(userId) {
      const supabase = createServiceSupabaseClient(env);
      const result = await supabase
        .from('subscriptions')
        .select('status, tier_id, stripe_customer_id, stripe_subscription_id, price_id, current_period_end, billing_provider, service_access_until')
        .eq('user_id', userId)
        .maybeSingle();

      if (result.error) throw new Error('checkout_subscription_lookup_failed');
      if (!result.data) return null;
      return toCheckoutSubscriptionState(result.data);
    },
  });
}

function stripeServerEnv(): StripeServerEnv {
  return {
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: process.env.SIDEKICK_CHECKOUT_REDIRECT_ORIGINS,
  };
}

function createServerSupabaseClient(env: StripeServerEnv, accessToken?: string) {
  return createClient(
    env.SUPABASE_URL || 'https://missing.supabase.co',
    env.SUPABASE_ANON_KEY || 'missing-anon-key',
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: accessToken
        ? {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        : undefined,
    },
  );
}

function createServiceSupabaseClient(env: StripeServerEnv) {
  return createClient(
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
}

function toCheckoutSubscriptionState(row: {
  billing_provider?: unknown;
  service_access_until?: unknown;
  current_period_end?: unknown;
  status?: unknown;
  tier_id?: unknown;
  stripe_customer_id?: unknown;
  stripe_subscription_id?: unknown;
  price_id?: unknown;
}): CheckoutSubscriptionState {
  const status = typeof row.status === 'string' && isCheckoutSubscriptionStatus(row.status) ? row.status : null;
  return {
    status,
    currentPeriodEnd: typeof row.current_period_end === 'string' ? row.current_period_end : null,
    billingProvider: typeof row.billing_provider === 'string' ? row.billing_provider : null,
    serviceAccessUntil: typeof row.service_access_until === 'string' ? row.service_access_until : null,
    tierId: typeof row.tier_id === 'string' && isCheckoutPlanTierId(row.tier_id) ? row.tier_id : null,
    stripeCustomerId: typeof row.stripe_customer_id === 'string' && row.stripe_customer_id.trim() ? row.stripe_customer_id.trim() : null,
    stripeSubscriptionId: typeof row.stripe_subscription_id === 'string' && row.stripe_subscription_id.trim() ? row.stripe_subscription_id.trim() : null,
    priceId: typeof row.price_id === 'string' && row.price_id.trim() ? row.price_id.trim() : null,
  };
}

function isCheckoutSubscriptionStatus(value: string): value is NonNullable<CheckoutSubscriptionState['status']> {
  return value === 'inactive' || value === 'trialing' || value === 'active' || value === 'past_due' || value === 'canceled';
}

function isCheckoutPlanTierId(value: string): value is NonNullable<CheckoutSubscriptionState['tierId']> {
  return value === 'studio' || value === 'pro-office' || value === 'enterprise-suite';
}

function createStripeSDK(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: '2026-04-22.dahlia',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function createStripeBillingClient(secretKey: string): StripeBillingClient {
  const stripe = createStripeSDK(secretKey);
  return {
    prices: {
      list(params: StripePriceListParams) {
        return stripe.prices.list({
          active: params.active,
          limit: params.limit,
          lookup_keys: [...params.lookup_keys],
        });
      },
    },
    checkout: {
      sessions: {
        retrieve: id => stripe.checkout.sessions.retrieve(id),
        expire: id => stripe.checkout.sessions.expire(id),
        list: params => stripe.checkout.sessions.list(params),
        async create(params: StripeCheckoutSessionCreateParams, options) {
          const session = await stripe.checkout.sessions.create(
            {
              mode: params.mode,
              expires_at: params.expires_at,
              line_items: [...params.line_items],
              success_url: params.success_url,
              cancel_url: params.cancel_url,
              client_reference_id: params.client_reference_id,
              customer_email: params.customer_email,
              customer: params.customer,
              metadata: { ...params.metadata },
              subscription_data: { ...params.subscription_data, metadata: { ...params.subscription_data.metadata } },
              ...(params.payment_method_collection ? { payment_method_collection: params.payment_method_collection } : {}),
              payment_method_types: [...params.payment_method_types],
              // allow_promotion_codes and discounts are mutually exclusive in
              // Stripe; the billing contract sets exactly one.
              ...(params.allow_promotion_codes ? { allow_promotion_codes: params.allow_promotion_codes } : {}),
              ...(params.discounts ? { discounts: params.discounts.map((d) => ({ coupon: d.coupon })) } : {}),
              ...(params.custom_text?.submit ? { custom_text: { submit: { message: params.custom_text.submit.message } } } : {}),
              billing_address_collection: params.billing_address_collection,
            },
            options,
          );
          return { id: session.id, url: session.url };
        },
      },
    },
    billingPortal: {
      configurations: { retrieve(id) { return stripe.billingPortal.configurations.retrieve(id); } },
      sessions: {
        async create(params: StripeBillingPortalSessionCreateParams) {
          const createParams: Stripe.BillingPortal.SessionCreateParams = {
            configuration: params.configuration,
            customer: params.customer,
            return_url: params.return_url,
          };
          if (params.flow_data) createParams.flow_data = {
            type: params.flow_data.type,
            after_completion: {
              type: params.flow_data.after_completion.type,
              redirect: { return_url: params.flow_data.after_completion.redirect.return_url },
            },
            subscription_update_confirm: {
              subscription: params.flow_data.subscription_update_confirm.subscription,
              items: params.flow_data.subscription_update_confirm.items.map((item) => ({
                id: item.id,
                price: item.price,
                quantity: item.quantity,
              })),
              ...(params.flow_data.subscription_update_confirm.discounts
                ? {
                    discounts: params.flow_data.subscription_update_confirm.discounts.map((d) => ({
                      coupon: d.coupon,
                    })),
                  }
                : {}),
            },
          };
          const session = await stripe.billingPortal.sessions.create(createParams);
          if (!session.url) throw new Error('stripe_billing_portal_session_missing_url');
          return { id: session.id, url: session.url };
        },
      },
    },
    subscriptions: {
      retrieve(id: string, params?: StripeSubscriptionRetrieveParams) {
        return stripe.subscriptions.retrieve(id, {
          expand: params?.expand ? [...params.expand] : undefined,
        });
      },
      list(params: StripeSubscriptionListParams) {
        return stripe.subscriptions.list({
          customer: params.customer,
          status: params.status,
          limit: params.limit,
          expand: params.expand ? [...params.expand] : undefined,
        });
      },
    },
  };
}
