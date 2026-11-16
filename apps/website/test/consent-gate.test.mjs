// The consent gate is the load-bearing claim of the whole cookie banner, and
// of the privacy policy that ships alongside it: "nothing is loaded and no
// cookie is set unless you choose Allow".
//
// It had ZERO tests. The mobile half of the same change got a dedicated
// readiness suite; this half got none, which is the wrong way round given this
// is the side facing the open internet and the side that carries a legal claim.
//
// These tests run the REAL modules against a stubbed window/document, so they
// fail if someone moves the guard, removes it, or "helpfully" pre-initialises
// the pixel to make the first event fire sooner.
import test from 'node:test';
import assert from 'node:assert/strict';

const PIXEL_SRC = 'connect.facebook.net';
const GA4_SRC = 'googletagmanager.com/gtag/js';

/**
 * Install a fake browser. Returns the created <script> elements so a test can
 * assert on exactly what was inserted.
 */
function fakeBrowser({ stored = null, throwOnRead = false } = {}) {
  const created = [];
  const firstScript = { parentNode: { insertBefore: (node) => created.push(node) } };
  globalThis.window = {
    localStorage: {
      getItem(key) {
        if (throwOnRead) throw new Error('storage disabled');
        return key === 'delegent.cookieConsent.v1' ? stored : null;
      },
      setItem() {},
      removeItem() {},
    },
  };
  globalThis.document = {
    createElement: () => ({ set src(v) { this._src = v; }, get src() { return this._src; } }),
    getElementsByTagName: () => [firstScript],
  };
  return created;
}

function reset() {
  delete globalThis.window;
  delete globalThis.document;
}

// Fresh module instances per test: metaPixel.ts holds a module-level `loaded`
// flag, so a cached import would let one test's success mask another's failure.
async function loadPixel() {
  return import(`../src/lib/metaPixel.ts?bust=${Math.random()}`);
}

// Same reasoning for GA4, which holds its own module-level `loaded` flag.
async function loadGa4() {
  return import(`../src/lib/ga4.ts?bust=${Math.random()}`);
}

test('no consent decision: the pixel is NOT loaded and no script is inserted', async () => {
  const created = fakeBrowser({ stored: null });
  try {
    const { ensurePixel, track } = await loadPixel();
    assert.equal(ensurePixel(), false, 'ensurePixel must refuse without a decision');
    track('Lead');
    assert.equal(created.length, 0, 'a script element was inserted with no consent');
    assert.equal(globalThis.window.fbq, undefined, 'fbq was defined with no consent');
  } finally {
    reset();
  }
});

test('consent DENIED: the pixel is NOT loaded', async () => {
  const created = fakeBrowser({ stored: 'denied' });
  try {
    const { ensurePixel, trackStoreRedirect } = await loadPixel();
    assert.equal(ensurePixel(), false, 'ensurePixel must refuse after a No');
    trackStoreRedirect('google_play');
    assert.equal(created.length, 0, 'a script element was inserted after the visitor said no');
  } finally {
    reset();
  }
});

test('consent GRANTED: the pixel loads, exactly once, from Meta', async () => {
  const created = fakeBrowser({ stored: 'granted' });
  try {
    const { ensurePixel } = await loadPixel();
    assert.equal(ensurePixel(), true, 'ensurePixel must load after an explicit yes');
    assert.equal(created.length, 1, `expected exactly one script, got ${created.length}`);
    assert.ok(String(created[0].src).includes(PIXEL_SRC), `unexpected script src: ${created[0].src}`);
    // Idempotent: a second call must not insert a second copy.
    ensurePixel();
    assert.equal(created.length, 1, 'ensurePixel inserted the script twice');
  } finally {
    reset();
  }
});

test('storage that throws is treated as NO consent, never as yes', async () => {
  // Private browsing, or storage disabled by policy. Failing open here would
  // silently opt in exactly the users most likely to object.
  const created = fakeBrowser({ throwOnRead: true });
  try {
    const { ensurePixel } = await loadPixel();
    assert.equal(ensurePixel(), false, 'a storage error must not be read as consent');
    assert.equal(created.length, 0, 'a script was inserted despite unreadable storage');
  } finally {
    reset();
  }
});

test('the withdrawal route is wired to something real', async () => {
  // clearConsent() shipped with a comment claiming it was "used by the footer
  // link" when no such link existed, so consent could be given and never taken
  // back. ICO guidance is that withdrawing must be as easy as giving.
  const { readFileSync } = await import('node:fs');
  const footer = readFileSync(new URL('../src/sections/Footer.tsx', import.meta.url), 'utf8');
  assert.match(footer, /clearConsent/, 'the footer no longer offers a way to change the cookie decision');
  assert.match(footer, /Cookie choices/i, 'the cookie control is no longer labelled in the footer');
});


// ---------------------------------------------------------------------------
// GA4, added 2026-09-03.
//
// The marketing site had NO analytics tag at all until then, which is why the
// GA4 property showed zero website events for ninety days while looking
// healthy: every event in it came from the mobile app's server-side
// Measurement Protocol calls. Adding a tag to the site means the policy claim
// "nothing is loaded and no cookie is set unless you choose Allow" now covers
// two technologies, so it is tested against both. A gate that holds for the
// pixel and not for GA4 is a gate that does not hold.

test('no consent decision: GA4 is NOT loaded and no script is inserted', async () => {
  const created = fakeBrowser({ stored: null });
  try {
    const { ensureGa4, trackGa4 } = await loadGa4();
    assert.equal(ensureGa4(), false, 'ensureGa4 must refuse without a decision');
    trackGa4('page_view');
    assert.equal(created.length, 0, 'a script element was inserted with no consent');
    assert.equal(globalThis.window.gtag, undefined, 'gtag was defined with no consent');
    assert.equal(globalThis.window.dataLayer, undefined, 'dataLayer was created with no consent');
  } finally {
    reset();
  }
});

test('consent DENIED: GA4 is NOT loaded', async () => {
  const created = fakeBrowser({ stored: 'denied' });
  try {
    const { ensureGa4 } = await loadGa4();
    assert.equal(ensureGa4(), false, 'ensureGa4 must refuse after a No');
    assert.equal(created.length, 0, 'a script element was inserted after the visitor said no');
  } finally {
    reset();
  }
});

test('consent GRANTED: GA4 loads, exactly once, from Google', async () => {
  const created = fakeBrowser({ stored: 'granted' });
  try {
    const { ensureGa4, GA4_MEASUREMENT_ID } = await loadGa4();
    assert.equal(ensureGa4(), true, 'ensureGa4 must load after an explicit yes');
    assert.equal(created.length, 1, `expected exactly one script, got ${created.length}`);
    assert.ok(String(created[0].src).includes(GA4_SRC), `unexpected script src: ${created[0].src}`);
    assert.ok(String(created[0].src).includes(GA4_MEASUREMENT_ID), 'the measurement id is missing from the tag URL');
    ensureGa4();
    assert.equal(created.length, 1, 'ensureGa4 inserted the script twice');
  } finally {
    reset();
  }
});

test('storage that throws is treated as NO consent for GA4 too', async () => {
  const created = fakeBrowser({ throwOnRead: true });
  try {
    const { ensureGa4 } = await loadGa4();
    assert.equal(ensureGa4(), false, 'a storage error must not be read as consent');
    assert.equal(created.length, 0, 'a script was inserted despite unreadable storage');
  } finally {
    reset();
  }
});

test('GA4 points at the property we actually own', async () => {
  // Until 2026-08-06 the mobile app posted every event to G-5E137LG4TS, a
  // measurement id belonging to no property Delegent owns, and GA4's collect
  // endpoint answers 204 for a bogus id so nothing ever failed. Months of
  // events were discarded silently. Pinning the id here will not prove the
  // property is right, but it will fail loudly if anyone reintroduces the old
  // one by copy-paste.
  const { GA4_MEASUREMENT_ID } = await loadGa4();
  assert.equal(GA4_MEASUREMENT_ID, 'G-9G65P310RP');
  assert.notEqual(GA4_MEASUREMENT_ID, 'G-5E137LG4TS', 'this is the property we do NOT own');
});

test('both tags go through the SAME consent component', async () => {
  // The gate is only as good as its call sites. If a future change arms one
  // tag somewhere else, the banner stops being the single answer to "what did
  // we start when they said yes".
  const { readFileSync } = await import('node:fs');
  const banner = readFileSync(new URL('../src/components/CookieConsent.tsx', import.meta.url), 'utf8');
  assert.match(banner, /ensurePixel/, 'the banner no longer arms the Meta Pixel');
  assert.match(banner, /ensureGa4/, 'the banner no longer arms GA4');
});
