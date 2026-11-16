import { useCallback, useEffect, useState } from 'react';
import {
  AGENT_PLAN,
  AGENT_PLAN_HEADLINE_OFFER,
  AGENT_PLAN_HEADLINE_PERIOD,
  AGENT_PLAN_PRICE_NOTE,
  AGENT_PLAN_SUMMARY,
  AGENT_PLAN_TRIAL_CTA,
  agentFreeTrialTermsLine,
  agentPlanHighlights,
  agentPlanThenLine,
  formatAgentPlanPrice,
  CHECKOUT_CONFIRMATION_POLL_ATTEMPTS,
  CHECKOUT_CONFIRMATION_POLL_INTERVAL_MS,
  CHECKOUT_CONFIRMATION_SLOW_MESSAGE,
  CHECKOUT_CONFIRMING_MESSAGE,
  LAUNCH_PROMO_CARRY_OVER_LINE,
  SIDEKICK_LAUNCH_PROMO,
  shouldQuoteFreeTrial,
  freeTrialTermsLine,
  SIDEKICK_PLAN_TIERS,
  MODEL_CLAIM_PAYWALL,
  STORAGE_DOWNGRADE_BLOCK_TITLE,
  SUBSCRIPTION_ALREADY_ACTIVE_CONFIRMING,
  SUBSCRIPTION_ALREADY_ACTIVE_SLOW_MESSAGE,
  billingControlsFor,
  checkoutThankYouBody,
  formatGbp,
  isLaunchPromoLive,
  isPlanDowngrade,
  isSubscriptionEntitled,
  launchPromoTermsLine,
  planChangeNote,
  promoPriceGbpMonthly,
  shouldQuotePromoPrice,
  type PlanTier,
  type PlanTierId,
} from '@sidekick/shared';
import { Notice, Screen, Spinner } from '../../components/ui';
import { useRearmOnBack } from '../../lib/useRearmOnBack';
import { useCoworkerEngine } from '../../state/coworkerEngine';
import { useProductStateContext } from '../state/productStateContext';
import { openBillingPortal, startCheckout } from './billingApi';
import { confirmScheduledPlanChange } from './confirmScheduledPlanChange';

export function PlanScreen() {
  const { status, snapshot, refresh } = useProductStateContext();
  const agentEngine = useCoworkerEngine() === 'agent';
  const [busyTier, setBusyTier] = useState<PlanTierId | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Held apart from `error` because it is not one. The server refused the
  // downgrade on purpose, and rendering it in the red slot with no title told
  // the reader something had gone wrong rather than what to do about it.
  const [storageBlock, setStorageBlock] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<string | null>(null);
  const [returned, setReturned] = useState<'success' | 'cancel' | 'billing' | null>(null);
  // Null once the plan is visible, or when we never came back from a payment.
  const [confirmAttempt, setConfirmAttempt] = useState<number | null>(null);
  // Whether the poll below is chasing a payment or a plan the server says we
  // already have. Both wait on the same read; only one of them was paid for in
  // the press that started it, and saying "Payment received" to the other told
  // someone who had just been refused a purchase that they had been charged.
  const [confirmReason, setConfirmReason] = useState<'payment' | 'already_active'>('payment');

  // Every exit to Stripe leaves its busy flag set on purpose (see `pick`).
  // Coming back with the browser's Back button restores this component with
  // those flags intact, which renders every tier button and Manage billing
  // disabled, with the pressed one still reading "Opening payment…".
  useRearmOnBack(
    useCallback(() => {
      setBusyTier(null);
      setPortalBusy(false);
    }, []),
  );

  // Stripe sends the browser back here with a marker in the query string. Read
  // it once, then strip it so a refresh does not re-announce an old checkout.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    const billing = params.get('billing');
    if (!checkout && !billing) return;
    setReturned(checkout === 'success' ? 'success' : checkout === 'cancel' ? 'cancel' : billing ? 'billing' : null);
    if (checkout === 'success') {
      setConfirmReason('payment');
      setConfirmAttempt(0);
    }
    window.history.replaceState({}, '', window.location.pathname);
    refresh();
  }, [refresh]);

  const subscription = snapshot?.subscription ?? null;
  const currentTierId = subscription?.tierId ?? null;
  const currentTierName = currentTierId
    ? SIDEKICK_PLAN_TIERS.find((tier) => tier.id === currentTierId)?.name ?? null
    : null;
  const entitled = isSubscriptionEntitled(subscription);
  // ⚠️ AN APPLE SUBSCRIBER ON THE WEB IS AN ORDINARY SUPPORTED STATE, and this
  // page used to have no idea. It rendered an enabled "Cancel or manage
  // billing" that called Stripe, got a 409 for a customer id that does not
  // exist, and displayed "Choose a plan first, then billing can manage
  // changes." to somebody who is already paying. Nothing on the page mentioned
  // Apple. The phone has refused the wrong store's controls since 2026-09-12;
  // the rule is shared now so the two cannot drift again.
  const billing = billingControlsFor('stripe', subscription?.billingProvider, { entitled });
  const promoLive = isLaunchPromoLive();
  const quotePromo = shouldQuotePromoPrice(subscription);
  const quoteTrial = shouldQuoteFreeTrial(subscription);
  const [paymentRequired, setPaymentRequired] = useState(false);
  const confirming = confirmAttempt !== null && confirmAttempt < CHECKOUT_CONFIRMATION_POLL_ATTEMPTS;
  const confirmationStalled = confirmAttempt !== null && confirmAttempt >= CHECKOUT_CONFIRMATION_POLL_ATTEMPTS;

  // Stripe redirects on payment success, but the entitlement is written by the
  // webhook a beat later, so the first read almost always still says "no plan".
  // Reading once left a customer who had just been charged looking at the buy
  // buttons again. Poll on the same schedule the phone uses.
  useEffect(() => {
    if (confirmAttempt === null) return;
    if (entitled) {
      setConfirmAttempt(null);
      return;
    }
    if (confirmAttempt >= CHECKOUT_CONFIRMATION_POLL_ATTEMPTS) return;
    const timer = window.setTimeout(() => {
      setConfirmAttempt((attempt) => (attempt ?? 0) + 1);
      refresh();
    }, CHECKOUT_CONFIRMATION_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [confirmAttempt, entitled, refresh]);

  // The busy flag stays set on every path that leaves for Stripe. Clearing it
  // first re-arms the buttons for the whole page-unload window, which on a slow
  // connection is seconds, and a second press there opens a second live checkout
  // session: the server only de-duplicates repeats of the SAME tier, so pressing
  // a different one gets through.
  async function pick(tierId: PlanTierId) {
    setError(null);
    setStorageBlock(null);
    setBusyTier(tierId);
    const result = await startCheckout(tierId);
    if (!result.ok) {
      setBusyTier(null);
      setPaymentRequired(result.paymentRequired === true);
      // The server has just told us this account already holds a plan, so the
      // buy buttons under this message are the wrong answer and the message
      // itself named a Manage billing button that is only rendered to someone
      // we already believe is subscribed: whenever it could be read, the thing
      // it pointed at was guaranteed not to be on screen. Go and look for the
      // plan on the same poll a payment uses, which hides the tier list while
      // it runs and ends in a warning with a Check again if it never lands.
      if (result.staleSubscription) {
        setConfirmReason('already_active');
        setConfirmAttempt(0);
        return;
      }
      setError(result.message);
      return;
    }
    window.location.assign(result.url);
  }

  async function manage() {
    setError(null);
    setStorageBlock(null);
    setScheduled(null);
    setPortalBusy(true);
    const result = await openBillingPortal();
    if (result.ok && result.kind === 'canceled') { setPortalBusy(false); return; }
    if (!result.ok) {
      setPortalBusy(false);
      if (result.storageBlocked) setStorageBlock(result.message);
      else setError(result.message);
      return;
    }
    if (result.kind === 'redirect') {
      window.location.assign(result.url);
      return;
    }
    // A downgrade is booked without leaving the page, so the button comes back
    // and says what was recorded rather than sitting on "Opening…" forever.
    setPortalBusy(false);
    setScheduled(result.message);
    refresh();
  }

  // Changing plan while subscribed is not a fresh checkout: Stripe refuses to
  // open one on a customer who already has a subscription. It is a portal call
  // that names the tier being moved to, which is what the phone ends up doing
  // after its checkout attempt is refused.
  async function switchTo(tierId: PlanTierId) {
    setError(null);
    setStorageBlock(null);
    setScheduled(null);
    setBusyTier(tierId);
    const result = await openBillingPortal(tierId, confirmScheduledPlanChange);
    if (result.ok && result.kind === 'canceled') { setBusyTier(null); return; }
    if (!result.ok) {
      setBusyTier(null);
      if (result.storageBlocked) setStorageBlock(result.message);
      else setError(result.message);
      return;
    }
    if (result.kind === 'redirect') {
      window.location.assign(result.url);
      return;
    }
    // A downgrade never leaves the app, so say what was booked and pick up the
    // pending change the server just recorded.
    setBusyTier(null);
    setScheduled(result.message);
    refresh();
  }

  return (
    <Screen title="Plan and billing" subtitle="What your coworker can do each month, and how you pay for it.">
      {returned === 'success' && confirmAttempt === null ? (
        <Notice tone="info">{checkoutThankYouBody(currentTierName, 'web')}</Notice>
      ) : null}
      {confirmationStalled ? (
        // The poll has given up, so the page needs a way forward. Without this
        // the only thing that could ever clear the warning was a browser
        // reload, because nothing left on screen asked the server again.
        <Notice tone="warning">
          {confirmReason === 'already_active' ? SUBSCRIPTION_ALREADY_ACTIVE_SLOW_MESSAGE : CHECKOUT_CONFIRMATION_SLOW_MESSAGE}{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => setConfirmAttempt(0)}>
            Check again
          </button>
        </Notice>
      ) : null}
      {returned === 'cancel' ? <Notice tone="info">Nothing was charged. Pick a plan whenever you are ready.</Notice> : null}
      {returned === 'billing' ? <Notice tone="info">Billing updated.</Notice> : null}
      {scheduled ? <Notice tone="info">{scheduled}</Notice> : null}
      {storageBlock ? (
        <Notice tone="warning">
          <strong className="block font-medium text-textPrimary">{STORAGE_DOWNGRADE_BLOCK_TITLE}</strong>
          {storageBlock}
        </Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {status === 'loading' ? (
        <Spinner label="Loading your plan…" />
      ) : confirming ? (
        // No tier list while a payment is still landing. Someone who has just
        // been charged must not be shown the buy buttons again.
        <Spinner label={confirmReason === 'already_active' ? SUBSCRIPTION_ALREADY_ACTIVE_CONFIRMING : CHECKOUT_CONFIRMING_MESSAGE} />
      ) : (
        // Deliberately still rendered once the poll has given up. Hiding the
        // body left someone who had just been charged looking at a single
        // warning paragraph with no plan, no Manage billing and no way back,
        // for the rest of the session. The phone keeps its picker on screen in
        // the same situation and shows the warning above it.
        <>
          {entitled ? <CurrentPlanCard tierId={currentTierId} snapshot={snapshot} agentEngine={agentEngine} /> : null}

          {/* Not shown to someone who already subscribes. The coupon is applied
              once per subscription, so a subscriber whose two months are spent
              is charged the standard price on a tier change, and quoting them
              the promo price here promised less than Stripe's confirm screen takes. */}
          {quotePromo ? (
            <div className="mb-4 rounded-xl bg-accentMuted px-4 py-3">
              <p className="text-body-sm font-medium text-accent">{SIDEKICK_LAUNCH_PROMO.badge}</p>
              {/* Primary, not secondary: on the muted accent band #6F6E68
                  measures 4.37:1, under the AA floor. The badge above is still
                  the louder line by weight and colour. */}
              <p className="mt-0.5 text-body-sm text-textPrimary">{SIDEKICK_LAUNCH_PROMO.headline}</p>
            </div>
          ) : promoLive && entitled && !agentEngine ? (
            // One plan on the engine, so there is no "new plan" to carry anything across to.
            <p className="mb-4 text-body-sm text-textSecondary">{LAUNCH_PROMO_CARRY_OVER_LINE}</p>
          ) : null}

          {/* An agent-engine account has one plan, so it is shown one plan.
              Until 2026-09-22 this page rendered the three workspace tiers to
              everybody, headlined with the workspace price, while the server
              charged the agent plan and gave a free month: the charge was
              right and the page was not. The server still decides the plan
              from the account (packages/billing serverFlow.ts), so this card
              reports what is sold rather than offering a second opinion. */}
          {agentEngine ? (
            <AgentPlanCard
              isCurrent={entitled}
              disabled={busyTier !== null || portalBusy}
              busy={busyTier === AGENT_PLAN.tierId}
              onPick={() => void pick(AGENT_PLAN.tierId)}
            />
          ) : (
            SIDEKICK_PLAN_TIERS.map((tier) => (
              <PlanCard
                key={tier.id}
                tier={tier}
                promoLive={quotePromo}
                trialAvailable={quoteTrial}
                isCurrent={tier.id === currentTierId && entitled}
                isDowngrade={Boolean(entitled && currentTierId && isPlanDowngrade(currentTierId, tier.id))}
                disabled={busyTier !== null || portalBusy}
                busy={busyTier === tier.id}
                onPick={() => void pick(tier.id)}
                onSwitch={() => void switchTo(tier.id)}
                entitled={entitled}
                canChangeTier={billing.canChangeTier}
              />
            ))
          )}

          {/* The same capability line the phone shows under its plan picker.
              Shared so the two surfaces cannot describe the product
              differently, and deliberately not naming the model — see
              packages/shared/src/content/modelClaim.ts. */}
          <p className="mt-4 text-body-sm text-textSecondary">{MODEL_CLAIM_PAYWALL}</p>

          {/* Both halves of the guard, the same way the tier buttons above
              carry both and the phone carries one combined flag. With only
              portalBusy this stayed live through the seconds-long unload
              window after Switch to was pressed, and a press there opened a
              second portal session with no tier named, which could win the
              redirect race and land the reader in the plain portal instead
              of the plan change they asked for. */}
          {billing.notice ? (
            <Notice tone="info">
              <span data-testid="plan.billingElsewhere">{billing.notice}</span>
              {billing.manageUrl ? (
                <a
                  className="btn-secondary mt-3 flex w-full justify-center"
                  href={billing.manageUrl}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="plan.manageElsewhere"
                >
                  Manage it with Apple
                </a>
              ) : null}
            </Notice>
          ) : null}

            {billing.canManage && (entitled || paymentRequired) ? (
            <button
              className="btn-secondary mt-2 w-full"
              type="button"
              onClick={() => void manage()}
              disabled={portalBusy || busyTier !== null}
            >
              {/* 2026-09-12: this read "Manage billing", which is where you
                  cancel but does not say so, and a customer hunting for the
                  word "cancel" never found it. "Manage billing" is kept as a
                  substring on purpose: two checkout error messages in
                  billingApi.ts name that control, and renaming it outright
                  would leave them pointing at a button that is not there. */}
              {portalBusy ? 'Opening…' : 'Cancel or manage billing'}
            </button>
          ) : null}

          <p className="mt-6 text-body-sm text-textSecondary">
            {/* Telling an Apple subscriber that Stripe handles their payment is
                simply untrue, and it sat directly under the controls that could
                not help them. */}
            {billing.canManage
              ? 'Payment is handled by Stripe. We never see or store your card details. Prices include VAT where it applies.'
              : 'Payment is handled by Apple. We never see or store your card details. Prices include VAT where it applies.'}
          </p>
        </>
      )}
    </Screen>
  );
}

function CurrentPlanCard({
  tierId,
  snapshot,
  agentEngine = false,
}: {
  agentEngine?: boolean;
  tierId: PlanTierId | null;
  snapshot: { usage: { usedTokens: number; quotaTokens: number; ratio: number; nearLimit: boolean; hardLimited: boolean } } | null;
}) {
  const tier = tierId ? SIDEKICK_PLAN_TIERS.find((candidate) => candidate.id === tierId) ?? null : null;
  const usage = snapshot?.usage ?? null;
  const percent = usage && usage.quotaTokens > 0 ? Math.min(100, Math.round(usage.ratio * 100)) : 0;

  return (
    <article className="card mb-5 p-4">
      <p className="text-caption uppercase tracking-wide text-textSecondary">Your plan</p>
      <p className="mt-1 text-title text-textPrimary">{agentEngine ? AGENT_PLAN.name : tier ? tier.name : 'Active plan'}</p>
      {usage && usage.quotaTokens > 0 ? (
        <>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-bg">
            <div
              className={`h-full rounded-full ${usage.hardLimited ? 'bg-danger' : usage.nearLimit ? 'bg-warning' : 'bg-accent'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 text-body-sm text-textSecondary">
            {percent}% of this month&rsquo;s thinking used.
          </p>
          {usage.hardLimited ? (
            <p className="mt-1 text-body-sm text-danger">
              You have used this month&rsquo;s allowance. It resets at the start of your next billing month, or you can move
              up a plan.
            </p>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

function PlanCard({
  tier,
  promoLive,
  trialAvailable,
  isCurrent,
  isDowngrade,
  disabled,
  busy,
  onPick,
  onSwitch,
  entitled,
  canChangeTier,
}: {
  tier: PlanTier;
  promoLive: boolean;
  trialAvailable: boolean;
  isCurrent: boolean;
  isDowngrade: boolean;
  disabled: boolean;
  busy: boolean;
  onPick: () => void;
  onSwitch: () => void;
  entitled: boolean;
  canChangeTier: boolean;
}) {
  const promoPrice = promoPriceGbpMonthly(tier);

  return (
    <article className={`card mb-3 p-4 ${tier.isMostChosen ? 'ring-1 ring-accent' : ''}`} data-testid={`plan.tier.${tier.id}`}>
      {tier.ribbon ? (
        <span className="mb-2 inline-block rounded-full bg-accentMuted px-2.5 py-1 text-caption text-accent">
          {tier.ribbon}
        </span>
      ) : null}
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-body font-medium text-textPrimary">{tier.name}</p>
        <p className="shrink-0 text-body text-textPrimary">
          {promoLive ? (
            <>
              <span className="mr-1.5 text-textSecondary line-through">{formatGbp(tier.priceGbpMonthly)}</span>
              <span className="font-medium">{formatGbp(promoPrice)}</span>
            </>
          ) : (
            <span className="font-medium">{formatGbp(tier.priceGbpMonthly)}</span>
          )}
          <span className="text-body-sm text-textSecondary"> /mo</span>
        </p>
      </div>

      <p className="mt-1 text-body-sm text-textSecondary">{tier.summary}</p>
      {tier.inferenceNote ? <p className="mt-2 text-body-sm text-textSecondary">{tier.inferenceNote}</p> : null}

      <ul className="mt-3 space-y-1">
        {tier.features.map((feature) => (
          <li key={feature} className="flex gap-2 text-body-sm text-textSecondary">
            <span aria-hidden="true" className="text-accent">
              •
            </span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {promoLive ? <p className="mt-3 text-body-sm text-textSecondary">{launchPromoTermsLine(tier)}</p> : null}
      {trialAvailable ? <p className="mt-3 text-body-sm text-textSecondary">{freeTrialTermsLine(tier)}</p> : null}

      <div className="mt-4">
        {isCurrent ? (
          // Not a button. Pressing it did nothing useful, and Manage billing
          // below is the real control for the plan you are already on.
          <p className="rounded-lg bg-surfaceHigh px-4 py-2.5 text-center text-body-sm text-textSecondary">
            Your current plan
          </p>
        ) : entitled && !canChangeTier ? (
          // Their subscription lives at the other store, so this surface cannot
          // move them. The notice above says where it can be done; a disabled
          // button with no explanation is the thing this replaces.
          <p className="rounded-lg bg-surfaceHigh px-4 py-2.5 text-center text-body-sm text-textSecondary">
            Change your plan where you bought it
          </p>
        ) : entitled ? (
          <>
            <button className="btn-secondary w-full" type="button" onClick={onSwitch} disabled={disabled}>
              {busy ? 'Changing plan…' : `Switch to ${tier.shortName}`}
            </button>
            {/* A move down is booked for renewal and credits nothing, a move up
                is priced by Stripe on the spot. The reader deserves to know
                which before they press, not after. */}
            <p className="mt-2 text-center text-body-sm text-textSecondary">{planChangeNote(isDowngrade)}</p>
          </>
        ) : (
          <button className="btn-primary w-full" type="button" onClick={onPick} disabled={disabled}>
            {busy ? 'Opening payment…' : trialAvailable ? 'Start 3-day free trial' : `Choose ${tier.shortName}`}
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * The one plan an agent-engine account can buy. The offer leads and the price
 * follows it, the same way the phone's card reads, because what a new
 * subscriber is being asked to accept is a free month. The price and the full
 * renewal terms stay on screen: they are required where the purchase happens
 * and, plainly, someone should know what they will be charged.
 */
function AgentPlanCard({ isCurrent, disabled, busy, onPick }: {
  isCurrent: boolean;
  disabled: boolean;
  busy: boolean;
  onPick: () => void;
}) {
  return (
    <article className="card mb-3 p-4 ring-1 ring-accent" data-testid="plan.agentCard">
      <span className="mb-2 inline-block rounded-full bg-accentMuted px-2.5 py-1 text-caption text-accent">
        {isCurrent ? 'Current plan' : 'First month free'}
      </span>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-body font-medium text-textPrimary">{AGENT_PLAN.name}</p>
        <p className="shrink-0 text-body text-textPrimary">
          {isCurrent ? (
            <>
              <span className="font-medium">{formatAgentPlanPrice()}</span>
              <span className="text-body-sm text-textSecondary"> /mo</span>
            </>
          ) : (
            <>
              <span className="font-medium">{AGENT_PLAN_HEADLINE_OFFER}</span>
              <span className="text-body-sm text-textSecondary"> {AGENT_PLAN_HEADLINE_PERIOD}</span>
            </>
          )}
        </p>
      </div>
      {!isCurrent ? (
        <p className="mt-0.5 text-right text-body-sm text-textSecondary">{agentPlanThenLine()}</p>
      ) : null}

      <p className="mt-1 text-body-sm text-textSecondary">{AGENT_PLAN_SUMMARY}</p>
      <p className="mt-2 text-body-sm text-textSecondary">{AGENT_PLAN_PRICE_NOTE}</p>

      <ul className="mt-3 space-y-1">
        {agentPlanHighlights().map((highlight) => (
          <li key={highlight.lead} className="text-body-sm text-textSecondary">
            <span className="font-medium text-textPrimary">{highlight.lead}</span> {highlight.text}
          </li>
        ))}
      </ul>

      {!isCurrent ? (
        <>
          <button
            type="button"
            className="btn-primary mt-4 flex w-full justify-center"
            disabled={disabled}
            onClick={onPick}
            data-testid="plan.agentCard.start"
          >
            {busy ? 'Opening secure checkout…' : AGENT_PLAN_TRIAL_CTA}
          </button>
          <p className="mt-2 text-caption text-textSecondary">{agentFreeTrialTermsLine()}</p>
        </>
      ) : null}
    </article>
  );
}
