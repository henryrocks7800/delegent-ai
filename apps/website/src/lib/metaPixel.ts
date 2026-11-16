/**
 * Meta Pixel, loaded ONLY after an explicit yes.
 *
 * The pixel exists so a Meta campaign can optimise for something better than a
 * click. Today the Android app reports no installs to Meta (the SDK ships with
 * an empty App ID), so Meta's optimiser has nothing to aim at and buys whoever
 * is cheapest to make tap. Two campaigns showed exactly that shape: 43 clicks
 * and 176 clicks, nothing measurable at the other end.
 *
 * This is an INTENT proxy, not an install. It fires when a visitor actually
 * taps through to a store. Weaker than a real install event, but available
 * without a native rebuild, and far better than optimising on clicks. Once a
 * new Android build carries the Meta SDK App ID, real install events become
 * available and this becomes the secondary signal.
 *
 * Consent is enforced in ONE place: `ensurePixel` returns early unless the
 * stored decision is 'granted'. Callers never have to remember.
 */
import { readConsent } from './consent';

/**
 * Created 2026-08-17 on the Delegent AI ad account via the Marketing API.
 * A pixel id is public by design: it ships in the page source of every site
 * that uses it, so it is not a secret and belongs in the repo.
 */
export const META_PIXEL_ID = '1081310147586858';

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { callMethod?: (...args: unknown[]) => void; queue?: unknown[] };
    _fbq?: unknown;
  }
}

let loaded = false;

/**
 * Insert the Meta base code, once, if and only if consent was granted.
 * Returns true when the pixel is live and usable.
 */
export function ensurePixel(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (readConsent() !== 'granted') return false;
  if (loaded && window.fbq) return true;

  /* eslint-disable */
  // Meta's standard snippet, transcribed rather than pasted as a raw <script>,
  // so it is type-checked and so the insertion is conditional.
  (function (f: any, b: Document, e: string, v: string) {
    if (f.fbq) return;
    const n: any = (f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    });
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = '2.0';
    n.queue = [];
    const t = b.createElement(e) as HTMLScriptElement;
    t.async = true;
    t.src = v;
    const s = b.getElementsByTagName(e)[0];
    s.parentNode?.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */

  window.fbq?.('init', META_PIXEL_ID);
  window.fbq?.('track', 'PageView');
  loaded = true;
  return true;
}

/**
 * Fire a standard event. No-ops silently without consent, which is the point:
 * call sites stay simple and cannot leak.
 */
export function track(event: string, params?: Record<string, unknown>): void {
  if (!ensurePixel()) return;
  window.fbq?.('track', event, params);
}

/**
 * Someone tapped through to a store. This is the conversion a campaign should
 * optimise for until real install events exist.
 *
 * 'Lead' rather than 'InitiateCheckout' deliberately: nothing has been
 * purchased and no checkout has begun, and mislabelling it would teach Meta's
 * optimiser the wrong thing and overstate the funnel.
 */
export function trackStoreRedirect(store: 'google_play' | 'app_store'): void {
  track('Lead', { content_name: 'store_redirect', content_category: store });
}
