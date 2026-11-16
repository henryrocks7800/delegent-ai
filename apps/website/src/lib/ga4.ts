/**
 * Google Analytics 4 for the marketing site, loaded ONLY after an explicit yes.
 *
 * WHY THIS DID NOT EXIST UNTIL 2026-09-03, which is the interesting part. The
 * GA4 property `delegentai.co.uk` (`G-9G65P310RP`) has existed for months and
 * has been receiving events the whole time. Every one of them came from the
 * MOBILE APP, posted server-side through the Measurement Protocol:
 * `screen_view`, `sign_in_completed`, `viewed_plans`, `tapped_upgrade`,
 * `reached_stripe`, `payment_completed`. The property therefore looked alive.
 *
 * The website itself had no tag at all. Not a broken tag, not a misconfigured
 * one: no `gtag`, no GTM container, nothing in `index.html`. Ninety days of
 * data showed zero `page_view` and zero `session_start`, and Play Console had
 * been reporting "data collection isn't active for your website" throughout.
 * The gap survived because the property was not empty, so every glance at it
 * looked healthy.
 *
 * That is the general lesson worth keeping: a property with data in it is not
 * evidence that a particular STREAM is reporting. Check the stream, and check
 * for the event you expect rather than for any event at all.
 *
 * CONSENT. GA4 writes `_ga` cookies to the visitor's device, so under PECR it
 * needs consent for the same reason the Meta Pixel does, and it is held to the
 * identical standard: nothing is inserted before an explicit yes, and there is
 * no "load with consent mode denied" middle ground. See `consent.ts` for why
 * that line was drawn where it was.
 *
 * A CONSEQUENCE TO BE HONEST ABOUT. Because this is consent-gated, it measures
 * the share of visitors who accept a banner, not all of them. It is therefore
 * NOT the thing that tells us whether advertising works. That job belongs to
 * the click beacon in `public/install.html` and to `install_attribution`,
 * neither of which touches the visitor's device and both of which therefore
 * count everybody. This is here for on-site behaviour: which pages people read,
 * where they stop, whether the pricing section is ever reached.
 */
import { readConsent } from './consent';

/**
 * The real property, `delegentai.co.uk`, account "Google Ads Account",
 * property id 000000000.
 *
 * ⚠️ Until 2026-08-06 the mobile app posted to `G-5E137LG4TS`, which belongs to
 * no property Delegent owns, and every event was silently discarded for months.
 * GA4's collect endpoint answers **HTTP 204 for a completely bogus measurement
 * id**, so any test that checks "did the send succeed" passes while the
 * pipeline is entirely broken. The ONLY valid proof is reading an event back
 * out of the property. If you change this value, verify it that way.
 *
 * A measurement id is public by design; it ships in the page source of every
 * site that uses it, so it is not a secret and belongs in the repo.
 */
export const GA4_MEASUREMENT_ID = 'G-9G65P310RP';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let loaded = false;

/**
 * Insert gtag.js, once, if and only if consent was granted.
 * Returns true when GA4 is live and usable.
 */
export function ensureGa4(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (readConsent() !== 'granted') return false;
  if (loaded && window.gtag) return true;

  window.dataLayer = window.dataLayer || [];
  // gtag.js requires the `arguments` OBJECT, not a copied array. Rewriting this
  // as `(...args) => dataLayer.push(args)` looks equivalent, type-checks, and
  // is the single most common way to end up with a tag that loads cleanly and
  // records nothing. Keep the canonical shape.
  function gtagShim() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer?.push(arguments);
  }
  window.gtag = gtagShim as unknown as Window['gtag'];

  // Inserted before the first existing <script> rather than appended to
  // <head>, matching metaPixel.ts exactly. Both tags are covered by the same
  // consent-gate test and the same stubbed browser, and a second insertion
  // idiom would mean the test could pass for one tag and be vacuous for the
  // other.
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}`;
  const first = document.getElementsByTagName('script')[0];
  first?.parentNode?.insertBefore(script, first);

  window.gtag?.('js', new Date());
  window.gtag?.('config', GA4_MEASUREMENT_ID, {
    // We have already asked, and the answer was yes. Ads personalisation stays
    // off regardless: our published privacy policy promises the analytics
    // identifier "is not used for advertising", and that promise is not
    // conditional on the banner.
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  loaded = true;
  return true;
}

/**
 * Fire a GA4 event. No-ops silently without consent, which is the point: call
 * sites stay simple and cannot leak.
 */
export function trackGa4(event: string, params?: Record<string, unknown>): void {
  if (!ensureGa4()) return;
  window.gtag?.('event', event, params ?? {});
}
