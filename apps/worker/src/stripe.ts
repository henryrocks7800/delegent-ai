// Worker entrypoints for the Stripe checkout / portal / webhook routes.
// These were previously implemented in apps/web (a Next.js app that was
// never deployed). The mobile bundle's EXPO_PUBLIC_SIDEKICK_API_BASE_URL
// already points at this Worker, so consolidating here avoids a second
// deploy target.
import Stripe from 'stripe';
import { reconcileStripeSubscriptionByEmail, type StripeRecoveryClient } from '@sidekick/billing/stripe-recovery';
import { isUsageTopUpSession } from '@sidekick/billing/usage-top-up';
import { createPurchaseIntentStore } from '@sidekick/billing/purchase-intents';
import { createClient } from '@supabase/supabase-js';
import { getPlanTier } from '@sidekick/shared';
import {
  type StripeBillingClient,
  type StripeBillingPortalSessionCreateParams,
  type StripeCheckoutSessionCreateParams,
  type StripePriceListParams,
  type StripeSubscriptionListParams,
  type StripeSubscriptionRetrieveParams,
} from '@sidekick/billing';
import {
  type CheckoutSubscriptionState,
  type StripeServerEnv,
  createSupabaseAuthResolver,
  createSupabaseStripeBillingStore,
  handleStripeBillingPortalRequest,
  handleStripeCheckoutRequest,
  handleStripeWebhookRequest,
  type StripeBillingStore,
} from './stripe-flow.js';
import {
  WELCOME_EMAIL_FROM,
  WELCOME_EMAIL_REPLY_TO,
  maybeSendWelcomeEmailOnCheckout,
  type WelcomeEmailUserStore,
} from './welcome-email.js';
import { maybeSendMetaPurchaseEvent } from './metaCapi.js';
import { maybeRewardReferral, referralRewardDeps } from './referrals.js';
import {
  PAYMENT_EMAIL_FROM,
  PAYMENT_EMAIL_REPLY_TO,
  appendSentInvoiceId,
  maybeSendPaymentReceiptEmail,
  type PaymentReceiptEmailStore,
} from './payment-email.js';

type WorkerStripeEnv = StripeServerEnv;

/**
 * Which accounts are on the assistant engine (apps/agent). Passed in by the
 * Worker, which owns the allowlist, so this module needs no view of it. An
 * assistant account buys the assistant plan, and is never given a workspace.
 */
export interface AssistantAccounts {
  isAssistantAccount(userId: string): boolean | Promise<boolean>;
  /**
   * Undo the runner request the entitlement RPC queues for every activation.
   * Called after an applied Stripe entitlement for an assistant account.
   */
  releaseRunner?(userId: string): Promise<unknown>;
}

/**
 * An assistant account has no workspace, so its plan must never queue a runner
 * for the provisioner to build (and bill for). Every other account's
 * provisioning goes through exactly as before.
 *
 * The entitlement RPC (`apply_billing_entitlement`) queues or resumes a
 * `hermes_instances` row on every activation, before this module sees the
 * result, so wrapping `enqueueHermesProvisioning` alone was never enough:
 * Alex's Apple test purchase queued a Studio runner on 2026-09-16. The
 * `applyEntitlement` wrapper releases that request straight after the write
 * and reports `resumed: false`, so the webhook does not try to reattach a
 * workspace the account does not have.
 */
export function withoutAssistantWorkspaces(store: StripeBillingStore, assistants?: AssistantAccounts): StripeBillingStore {
  if (!assistants) return store;
  return {
    ...store,
    async enqueueHermesProvisioning(job) {
      if (await assistants.isAssistantAccount(job.user_id)) return;
      return store.enqueueHermesProvisioning(job);
    },
    async applyEntitlement(input) {
      const result = await store.applyEntitlement(input);
      if (result.outcome !== 'applied' || !assistants.releaseRunner) return result;
      if (!(await assistants.isAssistantAccount(input.subscription.user_id))) return result;
      await assistants.releaseRunner(input.subscription.user_id);
      return { ...result, resumed: false };
    },
  };
}

export function stripeServerEnvFromWorker(env: WorkerStripeEnv): StripeServerEnv {
  return {
    STRIPE_SECRET_KEY: stringOrNull(env.STRIPE_SECRET_KEY),
    STRIPE_PORTAL_CONFIGURATION_ID: stringOrNull(env.STRIPE_PORTAL_CONFIGURATION_ID),
    STRIPE_PORTAL_UPGRADE_PRO_CONFIGURATION_ID: stringOrNull(env.STRIPE_PORTAL_UPGRADE_PRO_CONFIGURATION_ID),
    STRIPE_PORTAL_UPGRADE_ENTERPRISE_CONFIGURATION_ID: stringOrNull(env.STRIPE_PORTAL_UPGRADE_ENTERPRISE_CONFIGURATION_ID),
    STRIPE_WEBHOOK_SECRET: stringOrNull(env.STRIPE_WEBHOOK_SECRET),
    SUPABASE_URL: stringOrNull(env.SUPABASE_URL),
    SUPABASE_ANON_KEY: stringOrNull(env.SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: stringOrNull(env.SUPABASE_SERVICE_ROLE_KEY),
    SIDEKICK_CHECKOUT_REDIRECT_ORIGINS: stringOrNull(env.SIDEKICK_CHECKOUT_REDIRECT_ORIGINS),
    // Was silently dropped here, so the Worker could never be told a
    // retention window other than its compiled-in default.
    SIDEKICK_FLY_VOLUME_RETENTION_DAYS: stringOrNull(env.SIDEKICK_FLY_VOLUME_RETENTION_DAYS),
  };
}

export function handleStripeCheckoutFromWorker(request: Request, workerEnv: WorkerStripeEnv, assistants?: AssistantAccounts): Promise<Response> {
  if (request.method !== 'POST') return Promise.resolve(Response.json({ error: 'POST required' }, { status: 405 }));
  const env = stripeServerEnvFromWorker(workerEnv);
  return handleStripeCheckoutRequest(request, {
    env,
    ...(assistants ? { isAssistantPlanAccount: (userId: string) => assistants.isAssistantAccount(userId) } : {}),
    purchaseIntentStore: createPurchaseIntentStore(async (name, args) => await createServiceSupabaseClient(env).rpc(name,args)),
    createStripeBillingClient(secretKey) {
      return createWorkerStripeBillingClient(secretKey);
    },
    async getAuthenticatedUser(token) {
      const supabase = createServerSupabaseClient(env);
      return createSupabaseAuthResolver(supabase)(token);
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
    async reconcileStripeSubscriptionByEmail({ userId, email }) {
      return reconcileStripeSubscriptionByEmailImpl(env, { userId, email });
    },
  });
}

export function handleStripeBillingPortalFromWorker(request: Request, workerEnv: WorkerStripeEnv): Promise<Response> {
  if (request.method !== 'POST') return Promise.resolve(Response.json({ error: 'POST required' }, { status: 405 }));
  const env = stripeServerEnvFromWorker(workerEnv);
  return handleStripeBillingPortalRequest(request, {
    env,
    createStripeBillingClient(secretKey) {
      return createWorkerStripeBillingClient(secretKey);
    },
    async getAuthenticatedUser(token) {
      const supabase = createServerSupabaseClient(env);
      return createSupabaseAuthResolver(supabase)(token);
    },
    async getBillingPortalSubscription(userId) {
      const supabase = createServiceSupabaseClient(env);
      const result = await supabase
        .from('subscriptions')
        .select('status, tier_id, stripe_customer_id, stripe_subscription_id, price_id')
        .eq('user_id', userId)
        .maybeSingle();
      if (result.error) throw new Error('billing_portal_subscription_lookup_failed');
      if (!result.data) return null;
      return toCheckoutSubscriptionState(result.data);
    },
  });
}

interface WorkerWaitUntilCtx { waitUntil(promise: Promise<unknown>): void }

export async function handleStripeWebhookFromWorker(
  request: Request,
  workerEnv: WorkerStripeEnv,
  ctx?: WorkerWaitUntilCtx,
  /**
   * Optional Sentry sink. The prod Worker passes captureWorkerException bound
   * to its env+ctx so a DEGRADED instant-provisioning path (missing
   * GITHUB_DISPATCH_TOKEN, or a failed GitHub dispatch) raises a real alert
   * rather than only a console line. Omitted in unit tests that assert the
   * alert wiring with their own sink.
   */
  captureException?: (err: unknown, context?: Record<string, unknown>) => void,
  assistants?: AssistantAccounts,
): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405 });
  const env = stripeServerEnvFromWorker(workerEnv);
  const supabase = createServiceSupabaseClient(env);
  const store = withoutAssistantWorkspaces(createSupabaseStripeBillingStore(supabase), assistants);
  // The Workers runtime has no node:crypto, so the sync Stripe.webhooks.constructEvent
  // can't run here. constructEventAsync with Stripe's SubtleCrypto provider is
  // the supported path for `*.workers.dev`.
  const stripeForVerification = createWorkerStripeSDK(env.STRIPE_SECRET_KEY ?? 'sk_test_webhook_verification_unused');
  const cryptoProvider = Stripe.createSubtleCryptoProvider();

  // Peek the event type from a CLONE before the handler consumes the body, so
  // we can fire an immediate provisioning trigger on a paid activation. (Only
  // used to decide whether to nudge the provisioner; the handler below still
  // does the signature-verified processing on the original request.)
  let eventType = '';
  let peekedObject: Record<string, unknown> | null = null;
  try {
    const peek = (await request.clone().json()) as { type?: unknown; data?: { object?: unknown } };
    eventType = typeof peek?.type === 'string' ? peek.type : '';
    const obj = peek?.data?.object;
    peekedObject = obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    eventType = '';
    peekedObject = null;
  }

  const response = await handleStripeWebhookRequest(request, {
    env,
    store,
    async verifyStripeWebhookEvent(rawBody, signature, webhookSecret) {
      return stripeForVerification.webhooks.constructEventAsync(rawBody, signature, webhookSecret, undefined, cryptoProvider);
    },
    async retrieveStripeInvoice(id) {
      return await stripeForVerification.invoices.retrieve(id) as unknown as Record<string, unknown>;
    },
    async retrieveStripeCharge(id) {
      return await stripeForVerification.charges.retrieve(id) as unknown as Record<string, unknown>;
    },
    async retrieveStripeDispute(id) {
      return await stripeForVerification.disputes.retrieve(id) as unknown as Record<string, unknown>;
    },
    async retrieveStripeSubscription(id) {
      return await stripeForVerification.subscriptions.retrieve(id) as unknown as Record<string, unknown>;
    },
    async listStripeInvoicePayments(paymentIntentId, startingAfter) {
      return await stripeForVerification.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId },
        status: 'paid', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    },
    // Lets the resume-reattach fast path run after the webhook response (the
    // retained Machine is woken via /healthz and the row flipped to ready).
    waitUntil: ctx?.waitUntil ? (promise) => ctx.waitUntil(promise) : undefined,
    // A paid usage top-up (migration 0076). The Checkout session id is unique,
    // so a redelivered event cannot grant twice.
    async recordUsageTopUp(grant) {
      const { error } = await supabase.from('usage_top_ups').upsert({
        user_id: grant.userId,
        tokens: grant.tokens,
        amount_pence: grant.amountPence,
        currency: 'gbp',
        stripe_checkout_session_id: grant.checkoutSessionId,
        stripe_payment_intent_id: grant.paymentIntentId,
        purchased_at: grant.purchasedAt,
        expires_at: grant.expiresAt,
      }, { onConflict: 'stripe_checkout_session_id', ignoreDuplicates: true });
      if (error) throw new Error('usage_top_up_record_failed');
    },
  });

  // A top-up is a one-off payment by someone who is already a customer: none of
  // the sign-up follow-ups below (provisioning, welcome, receipt, advert
  // purchase event) applies to it.
  if (eventType === 'checkout.session.completed' && isUsageTopUpSession(peekedObject)) return response;

  // D3 (provision-on-payment): the per-user Fly runner is provisioned by the
  // GitHub Actions cron, which holds the FLY_API_TOKEN (the Worker must NEVER
  // hold it — trust boundary). GitHub throttles SCHEDULED crons to ~5 min, so
  // on a paid activation we ALSO fire an immediate workflow_dispatch so the
  // workspace provisions within ~1-2 min instead of up to 5. See
  // maybeDispatchProvisionOnActivation for the full PREOP-C02 rationale.
  const dispatchJob = maybeDispatchProvisionOnActivation({
    responseOk: response.ok,
    eventType,
    env: workerEnv as Record<string, string | undefined>,
    alert: captureException
      ? (detail) =>
          captureException(new Error(detail.message), {
            where: 'provision_dispatch_degraded',
            reason: detail.reason,
            eventType: detail.eventType,
            status: detail.status,
          })
      : undefined,
  });
  if (ctx?.waitUntil) ctx.waitUntil(dispatchJob); else await dispatchJob;

  // Welcome email (2026-07-18): on a fresh, successful checkout completion,
  // send the new customer the onboarding email exactly once. Strictly
  // best-effort — a failure here can never affect the webhook response,
  // billing, or provisioning (same contract as the dispatch job above).
  // The welcome email describes the workspace coworker, so an assistant account
  // does not get it (its own welcome is still to be written).
  const checkoutUserId = typeof peekedObject?.client_reference_id === 'string' ? peekedObject.client_reference_id : null;
  const assistantCheckout = Boolean(checkoutUserId && assistants && await assistants.isAssistantAccount(checkoutUserId));
  const welcomeJob = maybeSendWelcomeEmailOnCheckout({
    responseOk: response.ok && !assistantCheckout,
    eventType,
    session: peekedObject,
    store: createWelcomeEmailUserStore(supabase),
    send: (to, html, subject) => sendWelcomeEmailViaResend(workerEnv, to, html, subject),
  });
  if (ctx?.waitUntil) ctx.waitUntil(welcomeJob); else await welcomeJob;

  // Payment confirmation (2026-07-30): Stripe has never emailed our customers a
  // receipt (the account-level customer email is off, which is the live-mode
  // default), so we send our own — and ours names the plan and the exact service
  // period, which Stripe's does not. Same best-effort contract as above.
  const receiptJob = maybeSendPaymentReceiptEmail({
    responseOk: response.ok,
    eventType,
    invoice: peekedObject,
    store: createPaymentReceiptEmailStore(supabase),
    send: (to, subject, html) => sendTransactionalEmailViaResend(workerEnv, {
      from: PAYMENT_EMAIL_FROM,
      replyTo: PAYMENT_EMAIL_REPLY_TO,
      to,
      subject,
      html,
      logTag: 'payment-email',
    }),
  });
  if (ctx?.waitUntil) ctx.waitUntil(receiptJob); else await receiptJob;

  // Referrals (2026-09-23): a friend's first paid invoice gives the member who
  // invited them a free month, as a credit on their Stripe balance. Once per
  // referral (idempotency key and a pending-only update), same best-effort
  // contract as above.
  const referralJob = maybeRewardReferral({
    responseOk: response.ok,
    eventType,
    invoice: peekedObject,
    deps: referralRewardDeps(workerEnv),
  });
  if (ctx?.waitUntil) ctx.waitUntil(referralJob); else await referralJob;

  // Meta Conversions API (2026-09-08): tell Meta the click behind this
  // customer's install just paid, so it can optimise towards people who buy
  // rather than people who tap. Only for installs that carried a Meta click
  // id, only on checkout completion, keyed on the session id, off unless
  // SIDEKICK_META_CAPI_ENABLED. Same best-effort contract as the jobs above.
  const metaPurchaseJob = maybeSendMetaPurchaseEvent(
    workerEnv as Record<string, string | undefined>,
    { responseOk: response.ok, eventType, session: peekedObject },
  ).catch(() => undefined);
  if (ctx?.waitUntil) ctx.waitUntil(metaPurchaseJob); else await metaPurchaseJob;

  return response;
}

// Backs maybeSendPaymentReceiptEmail. The marker is a list of invoice ids in
// app_metadata (no migration), because Stripe delivers both `invoice.paid` and
// `invoice.payment_succeeded` for the same invoice and a single "last sent"
// timestamp would let the second one through.
function createPaymentReceiptEmailStore(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
): PaymentReceiptEmailStore {
  let cachedAppMetadata: Record<string, unknown> = {};
  return {
    async getUser(userId) {
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      cachedAppMetadata = (data.user.app_metadata ?? {}) as Record<string, unknown>;
      const sent = cachedAppMetadata.payment_receipt_invoice_ids;
      return {
        email: typeof data.user.email === 'string' ? data.user.email : null,
        sentInvoiceIds: Array.isArray(sent) ? sent.filter((v): v is string => typeof v === 'string') : [],
      };
    },
    async markSent(userId, invoiceId) {
      await supabase.auth.admin.updateUserById(userId, {
        app_metadata: {
          ...cachedAppMetadata,
          payment_receipt_invoice_ids: appendSentInvoiceId(cachedAppMetadata.payment_receipt_invoice_ids, invoiceId),
        },
      });
    },
  };
}

// Backs maybeSendWelcomeEmailOnCheckout: reads the recipient + once-per-account
// marker from the auth user, and persists the marker after a successful send.
// The marker lives in app_metadata.welcome_email_sent_at (no schema migration,
// naturally per-account, and invisible to the public/mobile surface).
function createWelcomeEmailUserStore(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
): WelcomeEmailUserStore {
  let cachedAppMetadata: Record<string, unknown> = {};
  return {
    async getUser(userId) {
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error || !data?.user) return null;
      cachedAppMetadata = (data.user.app_metadata ?? {}) as Record<string, unknown>;
      const backSessions = cachedAppMetadata.welcome_back_email_session_ids;
      return {
        email: typeof data.user.email === 'string' ? data.user.email : null,
        alreadySent: Boolean(cachedAppMetadata.welcome_email_sent_at),
        welcomeBackSessionIds: Array.isArray(backSessions)
          ? backSessions.filter((v): v is string => typeof v === 'string')
          : [],
      };
    },
    async markSent(userId) {
      await supabase.auth.admin.updateUserById(userId, {
        app_metadata: { ...cachedAppMetadata, welcome_email_sent_at: new Date().toISOString() },
      });
    },
    // Returning-customer detection: a private runner binding only ever exists
    // for someone who had a workspace before (the provisioner creates it well
    // after the first checkout's welcome email has been decided). A live
    // binding means the volume is retained; a deleted one means their old
    // workspace was grace-expired and they start fresh.
    async getWorkspaceHistory(userId) {
      const { data, error } = await supabase
        .from('hermes_instance_private')
        .select('deleted_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (error || !data) return 'none';
      return (data as { deleted_at?: string | null }).deleted_at ? 'expired' : 'retained';
    },
    async markWelcomeBackSent(userId, sessionId) {
      const existing = Array.isArray(cachedAppMetadata.welcome_back_email_session_ids)
        ? (cachedAppMetadata.welcome_back_email_session_ids as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
      // Keep the marker list bounded; only the most recent sessions matter
      // for redelivery dedupe.
      const next = [...existing.filter((id) => id !== sessionId), sessionId].slice(-10);
      await supabase.auth.admin.updateUserById(userId, {
        app_metadata: { ...cachedAppMetadata, welcome_back_email_session_ids: next },
      });
    },
  };
}

function sendWelcomeEmailViaResend(workerEnv: WorkerStripeEnv, to: string, html: string, subject: string): Promise<boolean> {
  return sendTransactionalEmailViaResend(workerEnv, {
    from: WELCOME_EMAIL_FROM,
    replyTo: WELCOME_EMAIL_REPLY_TO,
    to,
    subject,
    html,
    logTag: 'welcome-email',
  });
}

interface TransactionalEmail {
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  html: string;
  /** Prefixes the diagnostic lines so two senders stay distinguishable in logs. */
  logTag: string;
}

async function sendTransactionalEmailViaResend(workerEnv: WorkerStripeEnv, email: TransactionalEmail): Promise<boolean> {
  const resendKey = (workerEnv as { RESEND_API_KEY?: string }).RESEND_API_KEY?.trim();
  if (!resendKey) {
    console.warn(`[${email.logTag}] RESEND_API_KEY not set on worker; email not sent`);
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const upstream = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: email.from,
        to: [email.to],
        reply_to: email.replyTo,
        subject: email.subject,
        html: email.html,
      }),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      let detail = '';
      try { detail = (await upstream.text()).slice(0, 200); } catch {}
      console.warn(`[${email.logTag}] resend non-ok status=${upstream.status} body=${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[${email.logTag}] resend fetch failed detail=${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The synthetic event the Apple IAP verify route reports.
 *
 * Apple has no webhook event name at this point in the flow — StoreKit has
 * finished on the device and our own route is granting the entitlement — so it
 * needs a name of its own to sit in the activation set below.
 */
export const APPLE_IAP_ACTIVATION_EVENT = 'apple.iap.verified';

/**
 * Every event that means "somebody just became entitled and needs a runner NOW".
 *
 * ⚠️ This set used to hold only the three Stripe events, and that omission is
 * what failed App Review on 2026-08-24 under Guideline 2.1(b). The Apple path
 * wrote its provisioning row and stopped, so it never fired the instant
 * workflow_dispatch and fell through to the hourly cron backstop. Measured on
 * the reviewer's own account: purchase verified 15:04:50, runner ready
 * 15:37:53, THIRTY-THREE MINUTES later. Apple rejected us at 15:07. A reviewer
 * will never wait, so that was a guaranteed rejection every time, not bad luck.
 *
 * Anything that grants entitlement belongs in here. If a third billing
 * provider is ever added, add it here in the same change.
 */
const ACTIVATION_EVENTS = new Set<string>([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  APPLE_IAP_ACTIVATION_EVENT,
]);

/**
 * The shape the three activation paths still hand over. Every field is now
 * accepted and ignored (see maybeDispatchProvisionOnActivation): they are kept
 * so bringing the runner model back is a change in one file, not four.
 */
export interface MaybeDispatchProvisionInput {
  responseOk: boolean;
  eventType: string;
  env: Record<string, string | undefined>;
  /** Test seam from the runner era. Never called. */
  dispatch?: (token: string, repo: string, job: string) => Promise<{ ok: boolean; status: number; reason?: string }>;
  /** Test seam from the runner era. Never called. */
  warn?: (message: string) => void;
  /** Test seam from the runner era. Never called: there is nothing left to degrade. */
  alert?: (detail: { reason: string; eventType: string; message: string; status?: number }) => void;
}

/**
 * A paid activation used to fire a GitHub workflow_dispatch so the customer's
 * Fly runner was built in ~60s rather than waiting for the hourly cron. There
 * are no runners. They were destroyed and the Fly account closed on
 * 2026-09-18, every account is on the agent engine, and the workflow's Fly
 * steps were removed in the same change, so the dispatch had nothing left to
 * start.
 *
 * It was not harmless. The token it used is a classic PAT belonging to
 * qa-account, which lost access to the repo in the 2026-09-12 ownership
 * move, so GitHub answered 404 (its answer for "no permission" on a private
 * repo). Every activation therefore raised two Sentry errors and emailed Alex:
 * "instant provision-once dispatch failed ... status=404". On 2026-09-19 that
 * fired for Jordan and for a new trial customer, both of whom were served
 * perfectly well by the engine, so the alarm was pure noise sitting on top of
 * a real alerting channel.
 *
 * Kept as a named no-op rather than deleted at the three call sites: if the
 * runner model is ever brought back (the golden image is archived at
 * ghcr.io/your-org/delegent-runner-images), this is the one place that
 * has to change back, and the call sites already pass what it would need.
 */
export async function maybeDispatchProvisionOnActivation(_input: MaybeDispatchProvisionInput): Promise<void> {
  // Deliberately nothing: no dispatch, no diagnostic, no alert. An activation
  // on the agent engine has nothing to provision.
}

/**
 * Tiny landing pages for Stripe's success_url / cancel_url and Billing Portal
 * return_url. The real product UX lives in the mobile app; these pages just
 * need to avoid a dead end after the hosted Stripe flow. Mobile reads
 * subscription state from Supabase, not from these URLs.
 */
export function buildCheckoutLandingResponse(kind: 'success' | 'cancel' | 'billing'): Response {
  const content = {
    success: {
      title: 'Return to Delegent AI',
      message: 'The app should reopen automatically and check your subscription so you can continue.',
      appUrl: 'sidekick://checkout/success',
      action: 'Open Delegent AI',
    },
    cancel: {
      title: 'No charge. Checkout cancelled',
      message: 'Nothing was billed. Open Delegent AI to try again.',
      appUrl: 'sidekick://checkout/cancel',
      action: 'Open Delegent AI',
    },
    billing: {
      title: 'Billing updated',
      message: 'Open Delegent AI to carry on.',
      appUrl: 'sidekick://billing/return',
      action: 'Open Delegent AI',
    },
  }[kind];
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${content.title} - Delegent AI</title>
<style>
  :root { color-scheme: light; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f3ee; color: #1c1c1c; margin: 0;
    min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  main { max-width: 420px; text-align: center; }
  h1 { font-size: 28px; margin: 0 0 12px; font-weight: 600; }
  p  { font-size: 16px; line-height: 1.5; color: #4a4a4a; margin: 0; }
  a  {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 44px; padding: 0 18px; margin-top: 22px;
    border-radius: 8px; background: #1c1c1c; color: #fff;
    font-weight: 600; text-decoration: none;
  }
</style>
</head>
<body>
  <main>
    <h1>${content.title}</h1>
    <p>${content.message}</p>
    <a href="${content.appUrl}">${content.action}</a>
  </main>
  <script>
    window.setTimeout(function () {
      window.location.href = '${content.appUrl}';
    }, 350);
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

function createServerSupabaseClient(env: StripeServerEnv) {
  return createClient(
    env.SUPABASE_URL || 'https://missing.supabase.co',
    env.SUPABASE_ANON_KEY || 'missing-anon-key',
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
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
    stripeCustomerId: typeof row.stripe_customer_id === 'string' && row.stripe_customer_id.trim()
      ? row.stripe_customer_id.trim()
      : null,
    stripeSubscriptionId: typeof row.stripe_subscription_id === 'string' && row.stripe_subscription_id.trim()
      ? row.stripe_subscription_id.trim()
      : null,
    priceId: typeof row.price_id === 'string' && row.price_id.trim() ? row.price_id.trim() : null,
  };
}

function isCheckoutSubscriptionStatus(value: string): value is NonNullable<CheckoutSubscriptionState['status']> {
  return value === 'inactive' || value === 'trialing' || value === 'active' || value === 'past_due' || value === 'canceled';
}

function isCheckoutPlanTierId(value: string): value is NonNullable<CheckoutSubscriptionState['tierId']> {
  return value === 'studio' || value === 'pro-office' || value === 'enterprise-suite';
}

function createWorkerStripeSDK(secretKey: string): Stripe {
  // `createFetchHttpClient` is the Stripe-supported path for the
  // Cloudflare Workers runtime: it routes outbound requests through the
  // global `fetch` instead of node:https, which is unavailable here.
  return new Stripe(secretKey, {
    apiVersion: '2026-04-22.dahlia',
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export type AccountDeletionStripeCancel =
  | { ok: true; cancelled: boolean }
  | { ok: false; reason: string };

// Defect hunt 2026-09-03 (D1). Account deletion removes the auth user in the
// same request, and the profiles cascade takes the subscriptions row (and with
// it the Stripe ids) down with it, so this is the LAST moment anything can
// stop the next charge. Immediate cancel, not period-end: the account is gone
// at once, so there is no paid period left to honour, and a period-end cancel
// would leave a live subscription on a deleted account for up to a month,
// emitting webhooks for a customer nobody can map. Nothing is refunded here;
// that stays a manual decision in the Stripe dashboard.
export async function cancelStripeSubscriptionForAccountDeletion(
  workerEnv: WorkerStripeEnv,
  stripeSubscriptionId: string,
): Promise<AccountDeletionStripeCancel> {
  const secretKey = stringOrNull(workerEnv.STRIPE_SECRET_KEY);
  if (!secretKey) return { ok: false, reason: 'stripe_not_configured' };
  const stripe = createWorkerStripeSDK(secretKey);
  try {
    await stripe.subscriptions.cancel(stripeSubscriptionId);
    return { ok: true, cancelled: true };
  } catch (err) {
    const stripeError = err as { type?: unknown; statusCode?: unknown } | null;
    // Already cancelled, or the id no longer exists at Stripe: nothing left to
    // stop, so the deletion may proceed. Anything else (auth, network, 5xx) is
    // a real failure and the caller aborts the deletion rather than let a
    // customer walk away still being charged.
    if (stripeError?.type === 'StripeInvalidRequestError'
      && (stripeError.statusCode === 400 || stripeError.statusCode === 404)) {
      return { ok: true, cancelled: false };
    }
    const reason = typeof stripeError?.type === 'string' ? stripeError.type : 'stripe_error';
    return { ok: false, reason };
  }
}

export function createWorkerStripeBillingClient(secretKey: string): StripeBillingClient {
  const stripe = createWorkerStripeSDK(secretKey);
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
              // Stripe; the billing contract sets exactly one, so forward
              // whichever is present.
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
    subscriptionSchedules: {
      create(params: { from_subscription: string }) {
        return stripe.subscriptionSchedules.create({ from_subscription: params.from_subscription });
      },
      update(id: string, params: Record<string, unknown>) {
        return stripe.subscriptionSchedules.update(id, params as Stripe.SubscriptionScheduleUpdateParams);
      },
      release(id: string) {
        return stripe.subscriptionSchedules.release(id);
      },
    },
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

// =====================================================================
// Stripe ↔ Supabase reconciliation. Called by the checkout route when
// Supabase says the user is inactive — we search Stripe by email to
// detect a missed webhook (active sub on Stripe, no row in Supabase)
// and write the recovered state back so the user proceeds to their
// workspace instead of stranding on Stripe's "You're all done here"
// screen.
//
// Returns the persisted state on success, null when no matching active
// subscription exists, and throws on unknown provider/database state.
// =====================================================================
export async function reconcileStripeSubscriptionByEmailImpl(
  env: StripeServerEnv, input: { userId: string; email: string },
  deps?: { stripe: StripeRecoveryClient; store: Pick<StripeBillingStore, 'applyEntitlement'> },
): Promise<CheckoutSubscriptionState | null> {
  if (!env.STRIPE_SECRET_KEY) throw new Error('stripe_recovery_not_configured');
  return reconcileStripeSubscriptionByEmail(env, input, deps ?? {
    stripe: createWorkerStripeSDK(env.STRIPE_SECRET_KEY),
    store: createSupabaseStripeBillingStore(createServiceSupabaseClient(env)),
  });
}

// Worker Env interface marker - keeps the file self-typed without forcing
// callers to import shared Env types here.
export type { WorkerStripeEnv };
