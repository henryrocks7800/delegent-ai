// Every surface that tells a customer which platforms we are on must agree
// with the IOS_LIVE flag, and no customer-facing "get the app" link may point
// at a single store.
//
// 2026-08-31 iOS went on sale. The website was flag-driven and updated in
// minutes. Everything that was NOT flag-driven stayed wrong, and nothing broke,
// because copy that used to be true does not fail a build:
//
//   - the LIVE Google Play listing still read "On Android and in your browser
//     today. iOS coming soon."
//   - all THREE "Open the app" buttons in the customer emails (welcome, welcome
//     back, cap notice) were hardcoded to the Play Store, so an iPhone customer
//     who had just paid was sent to a store they cannot install from.
//
// The second one is the sharper failure: it is not a stale claim, it is a dead
// end for a paying customer, and it would have survived every existing check.
//
// The fix in both cases is to derive from one place. GET_THE_APP_URL is the
// device-aware redirect (delegentai.co.uk/install) that sends Android to Play,
// iPhone to the App Store, and everyone else to a page offering both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// URL.pathname yields "/C:/..." on Windows and is not a filesystem path.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

const PLAY_URL = /play\.google\.com\/store\/apps\/details/;
const APPLE_URL = /apps\.apple\.com\//;

// Anything whose HTML a customer receives in their inbox.
const CUSTOMER_EMAILS = [
  'apps/worker/src/welcome-email.ts',
  'apps/worker/src/cap-notice-email.ts',
];

test('[availability] customer emails link the device-aware redirect, not one store', () => {
  for (const path of CUSTOMER_EMAILS) {
    const src = read(path);
    assert.ok(
      !PLAY_URL.test(src),
      `${path} hardcodes a Google Play URL. An iPhone customer who has just paid ` +
      'would be sent to a store they cannot install from. Use GET_THE_APP_URL ' +
      'from @sidekick/shared, which routes by device.',
    );
    assert.ok(
      !APPLE_URL.test(src),
      `${path} hardcodes an App Store URL, which strands Android customers the ` +
      'same way. Use GET_THE_APP_URL from @sidekick/shared.',
    );
    assert.match(
      src,
      /GET_THE_APP_URL/,
      `${path} has no app link at all, or stopped using GET_THE_APP_URL.`,
    );
  }
});

test('[availability] the store listing copy agrees with the IOS_LIVE flag', () => {
  const availability = read('packages/shared/src/content/platformAvailability.ts');
  const iosLive = /export const IOS_LIVE = true;/.test(availability);
  const listing = read('docs/play-store/LISTING.md');

  if (iosLive) {
    assert.ok(
      !/iOS coming soon|iOS coming next/i.test(listing),
      'docs/play-store/LISTING.md still promises iOS is coming while IOS_LIVE is ' +
      'true. That file is the canonical Play Console copy, so the live listing ' +
      'is telling every Android visitor the iPhone app does not exist yet.',
    );
    assert.match(
      listing,
      /iPhone/,
      'IOS_LIVE is true but the Play listing never mentions iPhone. It is the ' +
      'one place a cross-platform claim earns us anything.',
    );
  } else {
    assert.ok(
      !/On iPhone, Android/i.test(listing),
      'The Play listing claims iPhone availability while IOS_LIVE is false. ' +
      'That is an advertising claim we cannot back.',
    );
  }
});

test('[availability] GET_THE_APP_URL still points at the device-aware page', () => {
  const availability = read('packages/shared/src/content/platformAvailability.ts');
  const m = availability.match(/export const GET_THE_APP_URL = '([^']+)'/);
  assert.ok(m, 'GET_THE_APP_URL is gone from platformAvailability.ts.');
  assert.ok(
    !PLAY_URL.test(m[1]) && !APPLE_URL.test(m[1]),
    `GET_THE_APP_URL now points straight at a store (${m[1]}). It exists precisely ` +
    'so that one link can serve both platforms; pointing it at a store defeats ' +
    'every consumer of it at once, including the customer emails and adverts.',
  );
});
