import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const webViewHtmlSource = readFileSync(new URL('../../../../../src/chat/chatWebViewHtml.ts', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

// The host inits the chat document twice on every open: once when the document
// posts `ready`, and again from the WebView's onLoadEnd. The init handler ran
// the whole first-run path both times, so each open started a second history
// load on top of the first, re-armed the tour, and reset the session clock.
// Re-initialising the SAME user is a config refresh and nothing more.
test('a second init for the same user refreshes config without redoing the first-run path', () => {
  const init = webViewHtmlSource.match(/if \(msg\.type === 'init'\) \{[\s\S]*?\n {4}\}/)?.[0];
  assert.ok(init, 'the init branch should exist');

  assert.match(
    init,
    /const already = bridge\.config\.initComplete && bridge\.config\.userId === \(msg\.userId \|\| ''\)/,
    'the repeat has to be identified by BOTH a completed prior init and the same user, or switching accounts would skip its history load',
  );
  // The three things that must not happen twice.
  assert.match(init, /if \(!already\) sessionStart = Date\.now\(\);/, 'a repeat init must not restart the session clock');
  assert.match(init, /if \(!already && bridge\.config\.initComplete\) loadHistory\(\);/, 'a repeat init must not start a second history load');
  assert.match(init, /if \(!already\) maybeAutoShowTour\(\);/, 'a repeat init must not re-show the tour');

  // `already` is computed from the OLD config, so it has to be read before the
  // assignment that overwrites it. Reversed, it is always false and the guard
  // silently does nothing.
  assert.ok(
    init.indexOf('const already =') < init.indexOf('bridge.config = {'),
    '`already` must be computed before bridge.config is replaced, or it always reads false',
  );
});

// Two overlapping history loads race to replace the same list and the loser's
// response is by definition the staler one. The composer stays live throughout
// (updateSendBtn does not consider historyLoading), so the user can and does
// send inside this window on a cold open.
test('loadHistory runs one at a time and re-checks for a live turn after its fetch', () => {
  const body = webViewHtmlSource.match(/async function loadHistory\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(body, 'loadHistory should exist');

  assert.match(webViewHtmlSource, /let historyLoadInFlight = false;/, 'the single-flight flag should be declared');
  assert.match(body, /if \(historyLoadInFlight\) return;\s*\n\s*historyLoadInFlight = true;/, 'a second concurrent load must bail out at the top');
  assert.match(
    body,
    /\} finally \{\s*\n\s*historyLoadInFlight = false;/,
    'the flag must clear in `finally`, or one failed load locks history out for the life of the document',
  );

  const at = (needle) => body.indexOf(needle);
  const recheck = body.search(/if \(streaming \|\| backgroundRunTracking > 0\) \{/);
  assert.ok(recheck > -1, 'the post-fetch guard should name both the streaming turn and the background tracker');
  assert.ok(
    recheck > at('await r.json()'),
    'the guard proves nothing about the state now unless it is re-read AFTER the last await',
  );
  assert.ok(
    recheck < at('messages = mergeHistoryPage'),
    'a send that started during the fetch must not have its bubble replaced by a response that predates it',
  );
});

test('mobile test suite includes the chat open/init idempotence guard', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /chat-open-init-idempotence\.test\.mjs/);
});
