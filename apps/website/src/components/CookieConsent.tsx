import { useEffect, useState } from 'react';
import { readConsent, writeConsent, type ConsentState } from '../lib/consent';
import { ensurePixel } from '../lib/metaPixel';
import { ensureGa4 } from '../lib/ga4';

/**
 * Cookie banner.
 *
 * Deliberate choices, each one a UK compliance requirement rather than taste:
 *
 *  - **Reject is a real button, styled the same as Accept.** ICO guidance is
 *    explicit that consent is not freely given if rejecting is harder than
 *    accepting. A prominent "Accept" beside a grey text link is the single
 *    most common way sites get this wrong.
 *  - **No pre-ticked anything, and no "by continuing to browse" wording.**
 *    Continuing to scroll is not consent.
 *  - **Nothing loads until a choice is made.** The pixel is not inserted on
 *    render; `ensurePixel()` is called only after an explicit accept, and it
 *    re-checks the stored value itself.
 *  - **No cookie wall.** The site is fully usable if you reject, so the banner
 *    does not block content; it sits at the bottom and can be answered later.
 */
export function CookieConsent() {
  // Lazy initialiser, not useState('unasked') plus an effect. With the effect
  // form, every returning visitor who had already decided rendered the banner
  // for one frame before the effect corrected it — a flash of a cookie prompt
  // on every page load, which reads as though we are asking again. readConsent
  // already guards `typeof window === 'undefined'` and swallows storage errors,
  // so it is safe to call during render.
  const [state, setState] = useState<ConsentState>(readConsent);

  useEffect(() => {
    // Re-arm the tags on a return visit where consent was already given. The
    // decision itself is read above; this effect exists only for the side
    // effect, which must not run during render.
    //
    // BOTH tags go through here. GA4 was added on 2026-09-03 and the site had
    // never had any analytics tag at all, which is why the property showed
    // zero website events for ninety days while looking healthy on the app's
    // server-side traffic. Anything consent-gated belongs in this one place,
    // so there is a single answer to "what did we start when they said yes".
    if (state === 'granted') {
      ensurePixel();
      ensureGa4();
    }
  }, [state]);

  if (state !== 'unasked') return null;

  function decide(next: 'granted' | 'denied') {
    writeConsent(next);
    setState(next);
    if (next === 'granted') {
      ensurePixel();
      ensureGa4();
    }
  }

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Cookies"
      className="fixed inset-x-0 bottom-0 z-50 px-4 pb-4 sm:px-6 sm:pb-6"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 rounded-2xl border border-ink/10 bg-bg/95 p-5 shadow-quiet backdrop-blur sm:flex-row sm:items-center sm:gap-6">
        <p className="text-[15px] leading-relaxed text-ink/80">
          We would like to use advertising and analytics cookies so we can tell which adverts
          actually help people find us, and which parts of this page are worth reading. Neither is
          needed to use the site, and we will not set them unless you say yes.{' '}
          <a href="/legal/privacy" className="underline underline-offset-2 hover:text-ink">
            Read our privacy policy
          </a>
          .
        </p>
        <div className="flex shrink-0 gap-3">
          {/* Same size, same weight, same prominence. This is the requirement. */}
          <button type="button" onClick={() => decide('denied')} className="btn-soft flex-1 sm:flex-none">
            No thanks
          </button>
          <button type="button" onClick={() => decide('granted')} className="btn-primary flex-1 sm:flex-none">
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
