import { Link } from 'react-router-dom';
import {
  AGENT_PLAN,
  CAPACITY_NO_ALLOWANCE_BODY,
  CAPACITY_NO_ALLOWANCE_CTA,
  CAPACITY_NO_ALLOWANCE_TITLE,
  SIDEKICK_PLAN_TIERS,
  formatCycleEndLine,
  isSubscriptionEntitled,
  type PlanTier,
  type UsageSummary,
} from '@sidekick/shared';
import { Screen, Spinner } from '../../components/ui';
import { useProductStateContext } from '../state/productStateContext';
import { useCoworkerEngine } from '../../state/coworkerEngine';

// The web half of the phone's "Monthly capacity" destination. The shared FAQ
// tells every reader to "watch usage on the Monthly capacity page", so the page
// has to exist on both surfaces or that answer is wrong in a browser.
//
// Same three questions the phone answers, in the same order: how full is the
// month, when does it reset, and what do I do if I am running short.

export function CapacityScreen() {
  const { status, snapshot } = useProductStateContext();
  const agentEngine = useCoworkerEngine() === 'agent';

  const subscription = snapshot?.subscription ?? null;
  const entitled = isSubscriptionEntitled(subscription);
  const tier = subscription?.tierId
    ? SIDEKICK_PLAN_TIERS.find((candidate) => candidate.id === subscription.tierId) ?? null
    : null;
  const usage = snapshot?.usage ?? null;
  const resetLine = formatCycleEndLine(
    subscription?.currentPeriodEnd ?? null,
    subscription?.cancelAtPeriodEnd ?? false,
  );

  return (
    <Screen title="Monthly capacity" subtitle="How much of this month's thinking you have used.">
      {status === 'loading' ? (
        <Spinner label="Loading your capacity…" />
      ) : !entitled || !usage || usage.quotaTokens <= 0 ? (
        <article className="card p-4">
          <p className="text-body text-textPrimary">{CAPACITY_NO_ALLOWANCE_TITLE}</p>
          <p className="mt-1 text-body-sm text-textSecondary">{CAPACITY_NO_ALLOWANCE_BODY}</p>
          {/* Link, not an anchor: an href reloads the whole document to move
              one screen, and on a static host that path only resolves if a
              rewrite rule happens to be in place. */}
          <Link className="btn-primary mt-4 inline-flex" to="/plan">
            {CAPACITY_NO_ALLOWANCE_CTA}
          </Link>
        </article>
      ) : (
        <>
          <CapacityCard usage={usage} tier={tier} />
          {resetLine ? <p className="mt-3 text-body-sm text-textSecondary">{resetLine}</p> : null}

          <dl className="mt-5">
            {/* capacityNote describes the size of the plan, which reads as a
                claim about right now when it sits under a used-up meter: the
                card said "You have used this month's capacity" and the line
                below it said there was "plenty left for quick questions". At
                100% the plan's shape is not the reader's question, and the
                reset line and the row beneath already answer the one that is. */}
            {usage.hardLimited ? null : (
              <Row label="Best for" value={tier?.capacityNote ?? 'Everyday admin, research, and follow-ups.'} />
            )}
            <Row label="Files" value={agentEngine ? 'Kept with your chat. There is no separate file store.' : 'Stored in your private cloud space.'} />
            <Row label="Running short?" value="More thinking each month is one plan change away." />
          </dl>

          {/* The plan page, not the Stripe portal. The row above says a bigger
              allowance is one plan change away, and our portal configuration is
              cancel-only, so the portal was the one place that could not do the
              thing this button offered. The phone made the same correction. */}
          <Link className="btn-secondary mt-5 flex w-full justify-center" to="/plan">
            Manage plan and payment
          </Link>
        </>
      )}
    </Screen>
  );
}

function CapacityCard({ usage, tier }: { usage: UsageSummary; tier: PlanTier | null }) {
  const agentEngine = useCoworkerEngine() === 'agent';
  const percent = Math.min(100, Math.round(usage.ratio * 100));
  const heading = usage.hardLimited
    ? 'You have used this month’s capacity'
    : usage.nearLimit
      ? 'Capacity is nearly full'
      : 'Comfortable';
  const copy = usage.hardLimited
    ? 'Tasks pause until your allowance resets, or until you move up a plan.'
    : usage.nearLimit
      ? 'You can keep working. Move up a plan if you want headroom for the rest of the month.'
      : 'Plenty of room for admin, research, files, and follow-ups this month.';

  return (
    <article className="card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-caption uppercase tracking-wide text-textSecondary">Current plan</p>
        <span className="shrink-0 rounded-full bg-accentMuted px-2.5 py-1 text-caption text-accent">
          {agentEngine ? AGENT_PLAN.name : tier ? tier.name : 'Active plan'}
        </span>
      </div>
      <p className="mt-2 text-display-md text-textPrimary">{heading}</p>
      <p className="mt-1 text-body-sm text-textSecondary">{copy}</p>

      <div
        className="mt-4 h-2 w-full overflow-hidden rounded-full bg-bg"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Monthly capacity used"
      >
        <div
          className={`h-full rounded-full ${usage.hardLimited ? 'bg-danger' : usage.nearLimit ? 'bg-warning' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-body-sm text-textSecondary">{percent}% of this month&rsquo;s thinking used.</p>
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border py-3 last:border-b-0">
      <dt className="shrink-0 text-body-sm text-textSecondary">{label}</dt>
      <dd className="text-right text-body-sm text-textPrimary">{value}</dd>
    </div>
  );
}
