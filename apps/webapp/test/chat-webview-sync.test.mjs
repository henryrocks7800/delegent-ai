import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CHAT_SOURCE,
  CHAT_TARGET,
  WEB_HOST_SHIM,
  buildChatDocument,
  expectedChatDocument,
  readChatSource,
} from '../scripts/sync-chat-webview.mjs';

// The web app serves the phone's chat document verbatim. If these tests fail,
// the two surfaces have drifted and a chat fix will land on only one of them.

test('the generated chat document is in step with the mobile source', () => {
  const generated = readFileSync(CHAT_TARGET, 'utf8');
  assert.equal(
    generated,
    expectedChatDocument(),
    `${CHAT_TARGET} is stale. Run: node apps/webapp/scripts/sync-chat-webview.mjs`,
  );
});

test('the shim is injected exactly once', () => {
  const generated = readFileSync(CHAT_TARGET, 'utf8');
  const occurrences = generated.split(WEB_HOST_SHIM).length - 1;
  assert.equal(occurrences, 1);
});

test('the shim is the only difference from the mobile source', () => {
  const source = readChatSource();
  const generated = expectedChatDocument();
  assert.equal(generated.replace(`\n${WEB_HOST_SHIM}`, ''), source);
});

test('the shim only redefines the native bridge', () => {
  // It must not reach into the chat page's own state. Anything beyond
  // ReactNativeWebView is a second implementation waiting to drift.
  assert.match(WEB_HOST_SHIM, /window\.ReactNativeWebView = \{/);
  assert.equal(WEB_HOST_SHIM.includes('__sidekick'), false);
  assert.equal(WEB_HOST_SHIM.includes('fetch('), false);
  assert.equal(WEB_HOST_SHIM.includes('localStorage'), false);
});

test('the shim posts to our own origin, never a wildcard', () => {
  assert.match(WEB_HOST_SHIM, /window\.location\.origin/);
  assert.equal(WEB_HOST_SHIM.includes("'*'"), false);
  assert.equal(WEB_HOST_SHIM.includes('"*"'), false);
});

test('the shim stays inert on the phone, where there is no parent frame', () => {
  assert.match(WEB_HOST_SHIM, /if \(window\.parent === window\) return;/);
});

test('building refuses a source with nowhere safe to inject', () => {
  assert.throws(() => buildChatDocument('<html><body>no charset here</body></html>'), /missing/);
});

test('the mobile source is the file the phone actually ships', () => {
  assert.match(CHAT_SOURCE, /apps[\\/]mobile[\\/]assets[\\/]chat-webview[\\/]index\.html$/);
});

test('a failed upload is reported once, inside the conversation', () => {
  // The document drops the chip and writes the reason into the transcript, next
  // to the attempt it belongs to. The browser host used to say the same
  // sentence a second time in a banner pinned above the frame, with nothing to
  // press, so one failed upload left a red bar over the chat for the rest of
  // the session long after it had stopped describing anything on screen. The
  // phone host has only ever sent the message and left the rendering to the
  // document.
  const source = readChatSource();
  assert.match(source, /if \(msg\.type === 'attachment_error'\)/, 'the document no longer reports a failed upload');
  assert.match(source, /if \(msg\.message\) addError\(msg\.message\)/, 'the document no longer shows the reason');

  const root = new URL('../', import.meta.url);
  const host = readFileSync(new URL('src/features/chat/ChatScreen.tsx', root), 'utf8');
  const mobileHost = readFileSync(new URL('../mobile/src/chat/WebViewChatScreen.tsx', root), 'utf8');
  for (const [surface, code] of [['the browser', host], ['the phone', mobileHost]]) {
    assert.match(code, /type: 'attachment_error'/, `${surface} no longer tells the document the upload failed`);
    assert.equal(
      /uploadError/.test(code),
      false,
      `${surface} keeps its own copy of the upload failure outside the conversation`,
    );
  }
});
