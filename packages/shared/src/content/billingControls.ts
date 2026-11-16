import type { BillingProvider } from '../index.ts';

/**
 * Which billing controls a surface may offer, and what to say when it may not.
 *
 * ⚠️ THE SAME MISTAKE HAS NOW BEEN MADE ON BOTH SURFACES, which is why this
 * lives in one place.
 *
 * On the phone, 2026-09-12: the guard was written as
 * `usesStoreKit() === (provider === 'apple')`, which treats an UNKNOWN provider
 * as "definitely the other one". `billingProvider` is optional, so on an iPhone
 * the one build that can only ever have sold through Apple hid its own cancel
 * button and printed a note saying the plan was not billed through the App
 * Store. Both halves wrong, on the screen a cancelling customer is reading.
 *
 * On the web, found 2026-09-13: an Apple subscriber with no Stripe customer id
 * got an enabled "Cancel or manage billing" button, which called Stripe, got a
 * 409, and displayed "Choose a plan first, then billing can manage changes."
 * They are already subscribed. The page said nothing about Apple at all.
 *
 * The rule that answers both: refuse only on a POSITIVE mismatch, and when you
 * refuse, say where the subscription actually lives. An unknown provider falls
 * through to the surface's own store, which is safe in both directions, because
 * that is the only store this surface could have sold through.
 */

/** Where a browser can send somebody to manage an Apple subscription. */
export const APPLE_MANAGE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';

/** Which biller the surface asking can actually reach. */
export type BillingSurfaceBiller = 'stripe' | 'apple';

export interface BillingControls {
  /** Offer a cancel or manage control that opens this surface's own biller. */
  readonly canManage: boolean;
  /** Offer tier switching through this surface's own biller. */
  readonly canChangeTier: boolean;
  /** Why not, and where to go instead. Null when the controls are offered. */
  readonly notice: string | null;
  /** A link to include with the notice, when there is a useful one. */
  readonly manageUrl: string | null;
}

const OFFERED: BillingControls = { canManage: true, canChangeTier: true, notice: null, manageUrl: null };

export function billingControlsFor(
  surface: BillingSurfaceBiller,
  provider: BillingProvider | undefined,
  options: { readonly entitled?: boolean } = {},
): BillingControls {
  // Nothing to manage and nothing to explain: the buy buttons are the answer.
  if (options.entitled === false) return OFFERED;
  if (surface === 'stripe' && provider === 'apple') {
    return {
      canManage: false,
      canChangeTier: false,
      notice: 'You subscribed through Apple, so Apple holds this subscription and only you can change or cancel it. On your iPhone or iPad open Settings, tap your name, then Subscriptions. You can also manage it from your Apple account in a browser.',
      manageUrl: APPLE_MANAGE_SUBSCRIPTIONS_URL,
    };
  }
  if (surface === 'apple' && provider === 'stripe') {
    return {
      canManage: false,
      canChangeTier: false,
      notice: 'This subscription was not bought through the App Store, so it is managed on the web instead. Sign in at delegent-app.web.app and open Plan and billing.',
      manageUrl: null,
    };
  }
  return OFFERED;
}
