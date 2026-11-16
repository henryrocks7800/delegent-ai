// Where the browser version of the app lives, and the words every surface uses
// to point at it.
//
// One constant because the address is about to change: the custom domain
// https://app.delegentai.co.uk is verifying in Firebase Hosting, and when it
// lands only this file should need the edit. The .web.app address stays live
// either way. apps/website keeps its own copy in src/components/webAppLink.ts
// because it is a standalone Vite app with no workspace dependencies; a test
// holds the two to the same value.

export const WEB_APP_URL = 'https://delegent-app.web.app';

// The address as a reader should see it. Nobody wants to read a scheme.
export const WEB_APP_DISPLAY_URL = WEB_APP_URL.replace(/^https?:\/\//, '');

export const WEB_APP_MENU_LABEL = 'Use it on your computer';

export const WEB_APP_MENU_DETAIL = 'Open the web app in any browser, same sign-in';

// The FAQ renders on the phone AND in the browser, so this answer has to read
// correctly to someone who is already using the thing it describes. It states
// where the browser version lives rather than telling the reader to go there.
export const WEB_APP_DEVICES_ANSWER =
  `Android phones, and any computer or tablet with a browser at ${WEB_APP_DISPLAY_URL}. Sign in the same way on either one ` +
  'and you get the same coworker, the same files and the same conversation, so you can start something at your desk and pick ' +
  'it up on your phone.';
