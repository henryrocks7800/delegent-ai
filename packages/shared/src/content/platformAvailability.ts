/**
 * Which platforms we are allowed to SAY the app is on, in one place.
 *
 * Before this existed, "On Android and in your browser today" was hard-coded
 * in four files, which is how a launch ends up half-announced.
 *
 * **The only consumer is the marketing site**, `apps/website`. Verified
 * 2026-08-31 by grepping every workspace:
 *
 *   - `sections/Hero.tsx`, `sections/CTA.tsx`  -> `platformAvailabilityLine()`
 *   - `sections/FAQ.tsx`                       -> `supportedDevicesSentence()`
 *   - `components/StoreButtons.tsx`            -> `IOS_LIVE`, the store URLs
 *
 * This header used to claim "the marketing site, the web app and the mobile
 * app's own FAQ" all read from it. They do not, and never did. The FAQ above
 * is the WEBSITE's FAQ. Neither `apps/mobile` nor `apps/webapp` imports this
 * module or hard-codes the claim, which is why flipping a flag here needs a
 * website deploy and **no mobile OTA**.
 *
 * The second file that has to move in step is not TypeScript and cannot import
 * this one: `apps/website/public/install.html` carries its own `var IOS_LIVE`
 * because it is a standalone pre-React redirect page.
 * `infra/scripts/ios-go-live.py` flips both together and refuses to run unless
 * App Store Connect reports READY_FOR_SALE.
 *
 * ⚠️ THESE ARE CLAIMS, NOT CAPABILITIES. Flipping `IOS_LIVE` to true tells the
 * world the iPhone app is downloadable, so it flips ON APPROVAL DAY, not when
 * the build is ready and not while it is in review. Saying "available on the
 * App Store" while it is TestFlight-only is false advertising, and it is the
 * reason these edits were deliberately held back rather than shipped with the
 * rest of the iOS work.
 */

/** The iPhone app is downloadable from the App Store by the public. */
export const IOS_LIVE = true;

/**
 * Whether to promise a Windows desktop app.
 *
 * FALSE since 2026-08-15: Alex confirmed the Windows build is mothballed. The
 * site had been saying "Windows & iOS coming next" on the home page and in the
 * closing call to action, which promises something nobody is working on.
 * `public/windows.html` still explains the position for anyone holding an old
 * link; it just is not advertised any more.
 */
export const WINDOWS_ANNOUNCED = false;

export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.sidekick.v2';
export const APP_STORE_URL = 'https://apps.apple.com/gb/app/id6800837608';

/**
 * The device-aware redirect. ONE link that sends Android to Play, iPhone to
 * the App Store, and everyone else to a page offering both plus the browser.
 *
 * This is what adverts should point at, because a Meta or Google advert gets a
 * single destination URL and we have two stores.
 */
export const GET_THE_APP_URL = 'https://delegentai.co.uk/install';

/** "On Android and in your browser today. iOS coming next." and variants. */
export function platformAvailabilityLine(): string {
  const soon: string[] = [];
  if (!IOS_LIVE) soon.push('iOS');
  if (WINDOWS_ANNOUNCED) soon.push('Windows');

  const today = IOS_LIVE
    ? 'On iPhone, Android and in your browser today.'
    : 'On Android and in your browser today.';

  return soon.length > 0 ? `${today} ${soon.join(' & ')} coming next.` : today;
}

/** Answer to "which devices does it work on?" in the FAQ. `assistant` words it for the assistant plan, which keeps no files. */
export function supportedDevicesSentence(webAppUrl: string, options: { assistant?: boolean } = {}): string {
  const devices = IOS_LIVE
    ? 'iPhone and Android phones, and any computer or tablet with a browser'
    : 'Android phones, and any computer or tablet with a browser';
  const tail = IOS_LIVE ? '' : ' An iOS app is next.';
  return (
    `${devices}. Prefer to work at a desk? Open ${webAppUrl} and sign in the same way you do on ` +
    `your phone: ${options.assistant ? 'same coworker, same conversation' : 'same coworker, same files, same conversation'}.${tail} ` +
    'Delegent AI is for adults aged 18 or over.'
  );
}
