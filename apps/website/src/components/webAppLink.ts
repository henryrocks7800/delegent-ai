// The browser version of the app. Swap this for https://app.delegentai.co.uk
// the moment that custom domain finishes verifying in Firebase Hosting; the
// .web.app address stays live either way, so nothing breaks in the meantime.
//
// The app and the web app read the same value from
// packages/shared/src/content/webApp.ts. The website is a standalone Vite build
// with no workspace dependencies, so it keeps its own copy, and a test in
// website-content-scanner.test.mjs holds the two to the same address.
export const WEB_APP_URL = 'https://delegent-app.web.app';

// The address as a reader should see it. Nobody wants to read a scheme.
export const WEB_APP_DISPLAY_URL = WEB_APP_URL.replace(/^https?:\/\//, '');
