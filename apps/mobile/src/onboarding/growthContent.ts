import { SIDEKICK_PLAN_TIERS, SIDEKICK_LAUNCH_PROMO, formatGbp, promoPriceGbpMonthly, shouldQuotePromoPrice, shouldQuoteFreeTrial, freeTrialTermsLine,
  type PlanTierId, type SubscriptionStatus } from '@sidekick/shared';

export const ONBOARDING_GOALS = ['receipts', 'inbox', 'admin', 'something_else'] as const;
export type OnboardingGoal = typeof ONBOARDING_GOALS[number];
// Keep stored values compatible with existing profiles and the database enum.
// Admin is retired from the picker; something_else now names the connections journey.
export const ONBOARDING_CHOICES: readonly OnboardingGoal[] = ['something_else', 'receipts', 'inbox'];
export const GOAL_LABELS: Record<OnboardingGoal, string> = {
  receipts: 'Receipts', inbox: 'Inbox', admin: 'Admin', something_else: 'Everyday connections',
};
export const GOAL_HEADLINES: Record<OnboardingGoal, string> = {
  receipts: 'Receipts, filed while you sleep', inbox: 'Your inbox, read and sorted',
  admin: 'Your admin, off your plate', something_else: 'Your everyday apps, working together',
};
export const DEMO_FINISH: Record<OnboardingGoal, string> = {
  receipts: 'From a receipt to a filed expense.',
  inbox: 'An email drafted, ready for you to review.',
  admin: 'An email drafted, ready for you to review.',
  something_else: 'Your apps, connected to your coworker.',
};
export function isOnboardingGoal(value: unknown): value is OnboardingGoal {
  return typeof value === 'string' && ONBOARDING_GOALS.includes(value as OnboardingGoal);
}
export function paywallPriceLine(tierId: PlanTierId, status: SubscriptionStatus, currentPeriodEnd: string | null) {
  const tier = SIDEKICK_PLAN_TIERS.find((t) => t.id === tierId)!;
  if (shouldQuoteFreeTrial({ status, currentPeriodEnd: currentPeriodEnd ?? undefined })) return freeTrialTermsLine(tier);
  if (!shouldQuotePromoPrice({ status, currentPeriodEnd: currentPeriodEnd ?? undefined })) {
    return `${formatGbp(tier.priceGbpMonthly)} a month. Cancel anytime.`;
  }
  return `${formatGbp(promoPriceGbpMonthly(tier))} a month for your first ${SIDEKICK_LAUNCH_PROMO.durationMonths} months, then ${formatGbp(tier.priceGbpMonthly)}. Cancel anytime.`;
}

export type StoreReview = {
  quote: string;
  /** The reviewer's store nickname. Play's review export carries no names. */
  author: string;
  store: 'App Store' | 'Google Play';
  stars: 1 | 2 | 3 | 4 | 5;
};

// Every review with words in it, read from the stores on 2026-09-28: App Store
// Connect customerReviews and the Play Console monthly reviews export (both
// read-only). Exact excerpts, cut only at sentence ends, never reworded; the
// stars are each review's own. Two had been shown since 9 Sep, so the same
// two kept coming back (Alex, 2026-09-28). Refresh from the stores, never
// write one.
export const PAYWALL_REVIEWS: readonly StoreReview[] = [
  { quote: 'So far it’s genuinely saved me about an hour a day.', author: 'RachDC123', store: 'App Store', stars: 5 },
  { quote: 'Makes it easy to get your AI to manage your inbox!', author: 'Dan5538', store: 'App Store', stars: 5 },
  { quote: 'A good time saver and really helps to keep on top of everything', author: 'Heoslleneabe', store: 'App Store', stars: 5 },
  { quote: 'It covers everything I need for my business needs and personal needs.', author: 'Ameer ski', store: 'App Store', stars: 5 },
  { quote: 'Setup and connecting to my apps took no time at all and I had the assistant sending perfect emails within 5 mins.', author: 'Brakfactor', store: 'App Store', stars: 5 },
  { quote: 'A breath of fresh air and the most helpful app to date.', author: 'Aarie44', store: 'App Store', stars: 5 },
  { quote: 'It’s like a mini assistant! It does my admin work for me, v. cool.', author: '', store: 'Google Play', stars: 5 },
  { quote: 'It feels amazing to have your own PA to deal with your admin', author: '', store: 'Google Play', stars: 5 },
  { quote: 'It’s fast, intuitive and incredibly easy to use, even if you’re not particularly technical.', author: '', store: 'Google Play', stars: 5 },
  { quote: 'Easy to get started and use. Helps to manage email and tasks easily.', author: '', store: 'Google Play', stars: 4 },
  { quote: 'Intuitive, collaborative and forward thinking.', author: '', store: 'Google Play', stars: 5 },
];

/** A different handful each time the plan screen opens, in a random order. */
export function pickReviews(reviews: readonly StoreReview[], count: number, random: () => number = Math.random): StoreReview[] {
  const pool = [...reviews];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, Math.min(count, pool.length)));
}

/** "RachDC123, App Store", or "Google Play review" when the store gives no name. */
export function reviewCredit(review: StoreReview): string {
  return review.author ? `${review.author}, ${review.store}` : `${review.store} review`;
}
