/**
 * Cookie consent for the marketing site.
 *
 * WHY THIS EXISTS AT ALL. The Meta Pixel is a non-essential advertising
 * technology. Under PECR, storing or accessing information on a visitor's
 * device for advertising requires CONSENT, not legitimate interest, and
 * Delegent AI is UK-governed and ICO registered. The mobile app already
 * holds itself to exactly this standard: `apps/mobile/src/analytics/metaSdk.ts`
 * ships the Meta SDK inert and will not wake it without an explicit yes. It
 * would be indefensible to apply a stricter rule to our own app than to our
 * own website, for identical data.
 *
 * THE RULES THIS FILE ENFORCES
 *   1. Nothing loads before a decision. Not "loads and waits", not "loads with
 *      consent mode denied". The script tag is never inserted.
 *   2. Reject is as easy as accept. A banner where "Accept" is a button and
 *      "Reject" is a buried link is not valid consent under UK guidance.
 *   3. The decision is revocable, and revoking takes effect on next load.
 *   4. Silence is not consent. No decision means no pixel, forever, on every
 *      page, not just until the banner is dismissed.
 */

export const CONSENT_KEY = 'delegent.cookieConsent.v1';

export type ConsentState = 'granted' | 'denied' | 'unasked';

/** Read the stored decision. Anything unexpected is treated as no decision. */
export function readConsent(): ConsentState {
  if (typeof window === 'undefined') return 'unasked';
  try {
    const v = window.localStorage.getItem(CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : 'unasked';
  } catch {
    // Private browsing or storage disabled. Treat as no consent, never as yes.
    return 'unasked';
  }
}

export function writeConsent(state: Exclude<ConsentState, 'unasked'>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONSENT_KEY, state);
  } catch {
    // If we cannot remember the answer we must ask again rather than assume.
  }
}

/** Forget the decision, so the banner asks again. Wired to the "Cookie choices"
 *  button in sections/Footer.tsx. */
export function clearConsent(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* no-op */
  }
}
