import { useEffect } from 'react';

/**
 * Re-arms a button that was deliberately left busy while the browser navigated
 * away to Stripe or an OAuth consent screen.
 *
 * Those hand-offs keep their busy flag set on purpose, because clearing it
 * first re-arms the button for the whole page-unload window and a second press
 * there opens a second checkout or mints a second authorize state. The cost is
 * that the flag is still set if the reader comes back with the browser's Back
 * button: bfcache restores the app with React state intact, so every button on
 * the page is disabled and the one they pressed still reads "Opening…". There
 * is nothing to press and no error, only a frozen page, escapable by reloading
 * or by navigating away, neither of which the reader has a reason to try.
 *
 * `pageshow` is the only event that fires on a bfcache restore. A normal load
 * remounts the component with fresh state, so answering both cases is harmless
 * and answering only `persisted` would depend on a browser heuristic we cannot
 * observe.
 */
export function useRearmOnBack(rearm: () => void) {
  useEffect(() => {
    const onPageShow = () => rearm();
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [rearm]);
}
