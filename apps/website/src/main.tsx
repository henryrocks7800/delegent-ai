import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CookieConsent } from './components/CookieConsent';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <App />
    {/* Mounted at the ROOT rather than inside App, because App returns early
        for /guides and the other standalone routes, and a banner rendered
        inside one of those branches would be missing on the others.

        An earlier version of this comment claimed it was so the banner would
        show on /legal/*. That was wrong, and worth recording so nobody
        "restores" it: the four /legal/* pages are PRERENDERED to static HTML by
        scripts/prerender-legal.mjs and ship with ZERO script tags, so React
        never runs there at all. No banner on those pages, and equally no pixel,
        which is the right outcome anyway: we do not want to be setting an
        advertising cookie on the page someone opened to read what we do with
        their data. Anyone arriving via the banner's own "Read our privacy
        policy" link has already been asked. */}
    <CookieConsent />
  </StrictMode>,
);
