import { SIDEKICK_PLAN_TIERS, formatGbp, promoPriceGbpMonthly, shouldQuotePromoPrice, shouldQuoteFreeTrial, type SubscriptionStatus } from '@sidekick/shared';

// Read back from the active Meta traffic ad set on 2026-09-09. Referrer text
// is untrusted: only these known IDs can choose fixed customer-facing copy.
const ADVERTS = {
  '120248171699360408': 'night',
  '120248173267850408': 'interview',
  '120248157165390408': 'short_b',
} as const;
export type PaywallAdvert = typeof ADVERTS[keyof typeof ADVERTS];
export function advertFromReferrer(referrer: string): PaywallAdvert | null {
  if (!referrer || referrer.length > 8192) return null;
  const id = new URLSearchParams(referrer).get('ad_id');
  return id && Object.prototype.hasOwnProperty.call(ADVERTS, id) ? ADVERTS[id as keyof typeof ADVERTS] : null;
}
export function advertHeadline(advert: PaywallAdvert, status: SubscriptionStatus, periodEnd: string | null): string {
  if (advert === 'night') return 'Receipts, filed while you sleep';
  if (advert === 'short_b') return 'Your inbox, read and sorted';
  if (shouldQuoteFreeTrial({ status, currentPeriodEnd: periodEnd ?? undefined })) return 'Meet your first AI coworker. Try 3 days free.';
  const studio = SIDEKICK_PLAN_TIERS.find((tier) => tier.id === 'studio')!;
  const intro = shouldQuotePromoPrice({ status, currentPeriodEnd: periodEnd ?? undefined });
  return `Your first AI coworker, from ${formatGbp(intro ? promoPriceGbpMonthly(studio) : studio.priceGbpMonthly)}`;
}
export const advertSeenKey = (userId: string) => `delegent.paywallAdvert.seen.v1.${userId}`;
export async function readFirstPaywallAdvert(deps: {
  userId: string; platform: string;
  getItem: (key: string) => Promise<string | null>;
  getReferrer: () => Promise<string>;
}): Promise<PaywallAdvert | null> {
  if (deps.platform !== 'android' || !deps.userId) return null;
  if (await deps.getItem(advertSeenKey(deps.userId))) return null;
  return advertFromReferrer(await deps.getReferrer());
}
