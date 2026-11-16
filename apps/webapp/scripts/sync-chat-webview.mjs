// Regenerate public/chat-frame/index.html from the mobile chat surface.
//
// The chat screen is by far the most intricate surface in the product, and it
// already exists as a standalone HTML document that talks to the API over
// fetch. Reproducing it in React would guarantee drift and defects, so the web
// app serves the SAME document in a same-origin iframe and plays the part the
// React Native WebView plays on the phone.
//
// The only edit is a small shim, injected at parse time, that points
// `window.ReactNativeWebView.postMessage` at the parent frame. Everything else
// is byte-for-byte the mobile file, so a chat fix ships to both surfaces from
// one edit. test/chat-webview-sync.test.mjs fails if the generated file is
// stale or if the shim ever grows beyond that one responsibility.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CHAT_SOURCE = resolve(here, '../../mobile/assets/chat-webview/index.html');
// Deliberately NOT public/chat/: Firebase Hosting serves static files before it
// applies the SPA rewrite, and with cleanUrls a directory named chat/ answers
// the React route /chat with its own index.html. That served the bare chat
// document, with no shell or nav, to anyone who refreshed or shared the app's
// default landing URL. This path matches no route in the app.
export const CHAT_TARGET = resolve(here, '../public/chat-frame/index.html');

export const WEB_HOST_SHIM = `<script>
/* Injected by apps/webapp/scripts/sync-chat-webview.mjs. Do not edit here.
   On the phone this document runs inside a React Native WebView and talks to
   native through window.ReactNativeWebView. In the browser the parent frame
   plays that part, so the same calls become a postMessage to the parent. */
(function () {
  if (window.parent === window) return;
  window.ReactNativeWebView = {
    postMessage: function (serialized) {
      try {
        window.parent.postMessage({ delegentChat: true, payload: serialized }, window.location.origin);
      } catch (err) {
        /* The parent went away (tab closing). Nothing useful to do. */
      }
    },
  };
})();
</script>
`;

export function buildChatDocument(source) {
  const marker = '<meta charset="utf-8">';
  if (!source.includes(marker)) {
    throw new Error(`chat surface is missing ${marker}; the shim has nowhere safe to go`);
  }
  return source.replace(marker, `${marker}\n${WEB_HOST_SHIM}`);
}

export function readChatSource() {
  return readFileSync(CHAT_SOURCE, 'utf8');
}

export function expectedChatDocument() {
  return buildChatDocument(readChatSource());
}

function main() {
  const generated = expectedChatDocument();
  mkdirSync(dirname(CHAT_TARGET), { recursive: true });
  writeFileSync(CHAT_TARGET, generated, 'utf8');
  process.stdout.write(`chat surface synced (${generated.length} bytes)\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
