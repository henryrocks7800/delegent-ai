// The advert landing page, /install.
//
// This page is where every pound of advertising lands, and until 2026-09-03 it
// was the least tested file in the product. It did a redirect and nothing else,
// which made the whole funnel unmeasurable in the middle: Meta billed us for
// 732 link clicks, Google Play recorded 3 installs in the whole of August, and
// nothing we owned could say whether one click had ever loaded a page of ours.
//
// It is plain HTML with an inline script, so it cannot be imported. These are
// contract tests over the source, in the same spirit as the "withdrawal route
// is wired to something real" test next door. They are deliberately about the
// things that were ACTUALLY wrong, each of which passed every other check:
//
//   - a bare Play Store link with no referrer, so no install was attributable
//   - no click measurement of any kind
//   - a hardcoded campaign name that had been paused for weeks
//
// The seam this guards is the one that broke: the page and the Worker have to
// agree on an endpoint, and the page and packages/shared have to agree on
// whether iOS is live. Neither agreement is enforced by any compiler, because
// one side is a string in an HTML file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../public/install.html', import.meta.url), 'utf8');

test('iPhone and iPad retain a visible store button when automatic navigation is blocked', () => {
  for (const userAgent of ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)']) {
    const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
      const classes = new Set((/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(' '));
      return [id, { href: /href="([^"]*)"/.exec(tag)?.[1], textContent: '', classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value) } }];
    }));
    const redirects = [];
    runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], {
      window: { location: { search: '', replace: (url) => redirects.push(url) }, localStorage: { getItem: () => null } },
      navigator: { userAgent },
      document: { ontouchend: null, getElementById: (id) => elements.get(id) },
      URLSearchParams,
    });
    assert.deepEqual(redirects, ['https://apps.apple.com/gb/app/id6800837608']);
    assert.equal(elements.get('appstore').classList.contains('hidden'), false, 'blocked redirect must leave a tappable App Store link');
    assert.equal(elements.get('appstore').href, redirects[0]);
    assert.equal(elements.get('play').classList.contains('hidden'), true);
    assert.match(elements.get('lead').textContent, /tap the button/);
  }
});
const workerRoutes = readFileSync(new URL('../../worker/src/index.ts', import.meta.url), 'utf8');
const sharedPlatforms = readFileSync(
  new URL('../../../packages/shared/src/content/platformAvailability.ts', import.meta.url),
  'utf8',
);

test('the Play Store link carries an install referrer', () => {
  // Without this there is no way, at all, to join an install back to the
  // advert that caused it. The old page linked to a bare store URL.
  assert.match(html, /referrer=/, 'the Play link no longer builds a referrer');
  assert.match(html, /buildPlayReferrer/, 'the referrer builder is gone');
});

test('the referrer carries the campaign identifiers, not just a source', () => {
  // fbclid (2026-09-08) is Meta's click id; the Worker's Conversions API path
  // needs it in the referrer or no sign-up or purchase can ever be reported.
  for (const field of ['utm_source', 'utm_medium', 'utm_campaign', 'campaign_id', 'adset_id', 'ad_id', 'placement', 'fbclid']) {
    assert.ok(html.includes(`'${field}'`), `the referrer no longer carries ${field}`);
  }
});

test('NO campaign name is hardcoded in the page', () => {
  // The eight Android adverts each hardcoded utm_campaign=uk-launch-test, a
  // campaign that had been paused since 20 August. Every install they produced
  // would have been credited to it. The page must read campaign values from
  // the URL, never carry one of its own.
  assert.ok(!/uk-launch-test/i.test(html), 'a specific campaign name is hardcoded in the landing page');
  assert.match(html, /URLSearchParams/, 'the page no longer reads campaign values from the URL');
});

test('an unresolved Meta macro is refused rather than passed on', () => {
  // Storing or forwarding a literal "{{campaign.id}}" pollutes every later
  // count. The same guard exists in the Worker; both ends must hold it.
  assert.match(html, /\{\{/, 'the macro guard is gone from the landing page');
  assert.match(html, /indexOf\('\{\{'\)/, 'the macro guard no longer checks for unresolved braces');
});

test('the click beacon fires before the redirect, on every path', () => {
  assert.match(html, /navigator\.sendBeacon/, 'sendBeacon is gone; a click will not survive the navigation');
  // Android, iOS and the desktop chooser must all report.
  const reports = html.match(/reportClick\(/g) ?? [];
  assert.ok(reports.length >= 4, `expected reportClick on every path, found ${reports.length} calls`);
});

test('a desktop store tap is reported as store_tap, not a second arrival', () => {
  // On a phone the page redirects immediately, so the arrival IS the store
  // visit: one visitor, one row. On desktop the chooser means an arrival and a
  // later badge tap are two events from ONE person. Reporting both as arrivals
  // would double every desktop click count.
  assert.match(html, /reportClick\('arrival'/, "the page no longer reports arrivals");
  assert.match(html, /reportClick\('store_tap', 'google_play'\)/, 'the desktop Play tap is not marked store_tap');
  assert.match(html, /reportClick\('store_tap', 'app_store'\)/, 'the desktop App Store tap is not marked store_tap');
  // The three auto-redirect paths must all be arrivals.
  const arrivals = html.match(/reportClick\('arrival'/g) ?? [];
  assert.ok(arrivals.length >= 4, `expected an arrival on every entry path, found ${arrivals.length}`);
});

test('the beacon uses a CORS-safelisted content type, so it needs no preflight', () => {
  // Only text/plain, application/x-www-form-urlencoded and multipart/form-data
  // are safelisted. Anything else makes this a preflighted cross-origin
  // request, so the browser has to complete an OPTIONS round trip BEFORE the
  // POST. sendBeacon fires microseconds before the page navigates to a store,
  // which is the worst possible moment to need two round trips: the beacon is
  // silently dropped and the click is never counted.
  //
  // The body is still JSON and the Worker still parses it as JSON. It reads
  // request.text() and never inspects the Content-Type, so labelling it
  // text/plain costs nothing and buys reliability. This is easy to "tidy" back
  // to application/json, which is why it is pinned.
  const beacon = /sendBeacon\([^)]*type:\s*'([^']+)'/.exec(html);
  assert.ok(beacon, 'the sendBeacon call no longer sets an explicit Blob type');
  assert.match(
    beacon[1],
    /^text\/plain/,
    `sendBeacon uses "${beacon[1]}", which triggers a CORS preflight and will drop the click`,
  );
  assert.ok(
    !/'Content-Type':\s*'application\/json'/.test(html),
    'the fetch fallback still uses application/json and will be preflighted',
  );
});

test('the page and the Worker agree on the click endpoint', () => {
  // This is a string on one side and a route on the other, so nothing but a
  // test can hold them together.
  const m = html.match(/CLICK_ENDPOINT\s*=\s*'([^']+)'/);
  assert.ok(m, 'CLICK_ENDPOINT is no longer declared in the page');
  const path = new URL(m[1]).pathname;
  assert.equal(path, '/api/ad/click');
  assert.ok(
    workerRoutes.includes(`url.pathname === '${path}'`),
    `the Worker has no route for ${path}, so every click beacon would 404`,
  );
});

test('the Meta Pixel on this page is STILL consent-gated', () => {
  // The click beacon needs no consent because it touches nothing on the
  // device. The Pixel is third-party device storage and does. The temptation,
  // when volume looks low, is to load it unconditionally here because the page
  // redirects too fast for a banner. That would break the promise made in the
  // privacy policy, so it is pinned.
  assert.match(html, /delegent\.cookieConsent\.v1/, 'the page no longer reads the stored consent decision');
  assert.match(
    html,
    /consent\s*!==\s*'granted'\)\s*return/,
    'the pixel on the landing page is no longer gated on an explicit yes',
  );
  // And the gate must come before the loader, not after it.
  assert.ok(
    html.indexOf("consent !== 'granted'") < html.indexOf('connect.facebook.net'),
    'the pixel loader appears before the consent check',
  );
});

test('the page and packages/shared agree on whether iOS is live', () => {
  // install.html cannot import TypeScript, so it carries its own copy of the
  // flag. infra/scripts/ios-go-live.py flips both; this catches a hand edit to
  // one of them. Saying "available on the App Store" while it is not is false
  // advertising, and the reverse costs every iPhone install.
  const page = /var IOS_LIVE = (true|false)/.exec(html);
  const shared = /export const IOS_LIVE = (true|false)/.exec(sharedPlatforms);
  assert.ok(page, 'install.html no longer declares IOS_LIVE');
  assert.ok(shared, 'packages/shared no longer exports IOS_LIVE');
  assert.equal(page[1], shared[1], 'install.html and packages/shared disagree about whether iOS is live');
});

test('adverts are still pointed at this page', () => {
  assert.match(sharedPlatforms, /GET_THE_APP_URL = 'https:\/\/delegentai\.co\.uk\/install'/);
});

// 2026-09-09: the live advert link was walked on a real Android browser for
// the first time. It reached the Play LISTING, but the web one inside the
// browser, whose Install button needs a Google sign-in in that browser; the
// Facebook in-app browser never has one. Android now goes through an intent
// URL to the Play Store app, with the web listing as the fallback.
test('Android is sent to the Play Store app by intent URL, with the web listing as fallback', () => {
  assert.match(html, /function playAppUrl\(\)/, 'the app-URL builder is gone');
  assert.match(html, /'intent:\/\/' \+ data \+ '#Intent;scheme=market;package=com\.android\.vending;S\.browser_fallback_url='/, 'the intent URL must name the Play Store package and carry a browser fallback');
  assert.match(html, /details\?id=com\.sidekick\.v2' \+ \(ref \? '&referrer=' \+ encodeURIComponent\(ref\) : ''\)/, 'the intent URL must carry the same install referrer');
  assert.match(html, /reportClick\('arrival', 'google_play'\);\s*firePixelLeadIfConsented\('google_play'\);[\s\S]{0,900}window\.location\.replace\(playAppUrl\(\)\);/, 'the Android branch must navigate to the app URL after reporting');
  assert.match(html, /playEl\.href = playUrl\(\);/, 'the desktop chooser keeps the https link on the badge');
  // Chrome needs a tap to open another app without a prompt, so on Android
  // the badge itself must open the Play Store app (Alex's phone, 2026-09-09).
  assert.match(html, /playEl\.href = playAppUrl\(\);\s*document\.getElementById\('lead'\)\.textContent = 'Opening Google Play\. If it has not opened, tap the button\.';\s*window\.location\.replace\(playAppUrl\(\)\);/,
    'on Android the badge must point at the Play Store app and the lead must tell the visitor to tap it');
});
