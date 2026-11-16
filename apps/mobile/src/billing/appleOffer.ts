/** Minimal public StoreKit product data used to quote an offer. */
export interface AppleOfferProduct {
  id: string;
  displayPrice?: string;
  /** ISO currency code of displayPrice, from StoreKit's price format style. */
  currency?: string;
  subscriptionGroupIdIOS?: string | null;
  introductoryPricePaymentModeIOS?: string;
  introductoryPriceSubscriptionPeriodIOS?: string | null;
  introductoryPriceNumberOfPeriodsIOS?: string | null;
}

export interface ApplePlanOffer {
  priceLine: string;
  /** StoreKit confirmed BOTH the three-day free offer and this Apple ID's eligibility. */
  hasThreeDayTrial: boolean;
  /** The product carries the three-day free offer, whatever eligibility said. */
  offersThreeDayTrial: boolean;
  /** StoreKit confirmed BOTH the free first month (the assistant plan) and eligibility. */
  hasFreeMonth: boolean;
  /** The product carries the free first month, whatever eligibility said. */
  offersFreeMonth: boolean;
}

/** Does the StoreKit product carry the assistant plan's free first month? */
export function productOffersFreeMonth(product: AppleOfferProduct): boolean {
  return product.introductoryPricePaymentModeIOS === 'free-trial'
    && product.introductoryPriceSubscriptionPeriodIOS === 'month'
    && product.introductoryPriceNumberOfPeriodsIOS === '1';
}

/** Does the StoreKit product carry our three-day free introductory offer? */
export function productOffersThreeDayTrial(product: AppleOfferProduct): boolean {
  // OpenIAP 3.2.1 StoreKitTypesBridge.introductoryPeriods returns the
  // normalized period value multiplied by periodCount, so a three-day
  // offer is "day" / "3", even when StoreKit's periodCount is one.
  // https://github.com/hyodotdev/openiap/blob/3.2.1/packages/apple/Sources/Helpers/StoreKitTypesBridge.swift
  return product.introductoryPricePaymentModeIOS === 'free-trial'
    && product.introductoryPriceSubscriptionPeriodIOS === 'day'
    && product.introductoryPriceNumberOfPeriodsIOS === '3';
}

/**
 * The price line under the plan name on the iOS paywall.
 *
 * StoreKit has disagreed with the purchase sheet in both directions during
 * handset testing. On 12 September a non-true eligibility read hid a trial
 * Apple then offered. On 14 September the fallback "3 days free for new
 * subscribers" led Alex to expect a trial Apple did not offer (build51's
 * diagnostic returned false; the product still carried the correct offer).
 *
 * For either false or unknown, lead with the actual monthly price and make
 * the trial expressly conditional on Apple's confirmation screen. Do not
 * infer eligibility from a new Delegent login, or claim that a false local
 * read proves the Apple Account used its trial. Only confirmed eligibility
 * gets the firm trial line, trial button and "Nothing to pay today" caption.
 */
export function applePlanOffer(product: AppleOfferProduct, eligible: boolean | null): ApplePlanOffer {
  const price = product.displayPrice?.trim();
  const offered = Boolean(price) && productOffersThreeDayTrial(product);
  const trial = offered && eligible === true;
  // The assistant plan's free first month follows the same rule as the
  // three-day trial: firm wording only once Apple has confirmed eligibility.
  const monthOffered = Boolean(price) && productOffersFreeMonth(product);
  const month = monthOffered && eligible === true;
  if (monthOffered) {
    return {
      hasThreeDayTrial: false,
      offersThreeDayTrial: false,
      hasFreeMonth: month,
      offersFreeMonth: true,
      // Short, because Alex found the first version wordy on the phone
      // (2026-09-16). Still honest on the two points that matter: the free
      // month is Apple's to confirm, and cancelling is in App Store settings.
      priceLine: month
        ? `First month free, then ${price} a month. Cancel in App Store settings before the month ends and you pay nothing.`
        : `${price} a month. New subscribers get the first month free if Apple offers it on the next screen. Cancel any time in App Store settings.`,
    };
  }
  return {
    hasThreeDayTrial: trial,
    offersThreeDayTrial: offered,
    hasFreeMonth: false,
    offersFreeMonth: false,
    priceLine: trial
      ? `3 days free, then ${price} per month automatically. Cancel in App Store settings at least 24 hours before the trial ends to avoid being charged.`
      : offered
        ? `${price} per month. The 3-day free trial only applies if Apple offers it on the next screen. If offered, billing starts automatically after the trial. Cancel in App Store settings at least 24 hours before the trial ends to avoid being charged.`
        : price ? `${price} per month. Apple confirms any eligible offer before purchase. Managed by Apple.`
          : 'See your local price and any eligible offer in the App Store before confirming. Managed by Apple.',
  };
}
