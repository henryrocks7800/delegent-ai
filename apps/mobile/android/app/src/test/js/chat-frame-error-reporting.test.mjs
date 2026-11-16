import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chatSource = readFileSync(new URL('../../../../../assets/chat-webview/index.html', import.meta.url), 'utf8');
const webViewSource = readFileSync(new URL('../../../../../src/chat/WebViewChatScreen.tsx', import.meta.url), 'utf8');
const sentrySource = readFileSync(new URL('../../../../../src/observability/sentry.ts', import.meta.url), 'utf8');
const webChatSource = readFileSync(new URL('../../../../../../webapp/src/features/chat/ChatScreen.tsx', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

// The chat is a document inside a frame, and an exception raised in it does not
// propagate to the host: the host's error handlers and the crash reporter both
// see nothing while the user watches the screen sit dead. The document had no
// global handler at all, and the single `webview_error` it did post was read by
// neither host despite a comment claiming it reached logcat.
test('the chat document reports its own uncaught errors and rejections', () => {
  assert.match(chatSource, /window\.addEventListener\('error',/, 'an uncaught throw has to be reported');
  assert.match(chatSource, /window\.addEventListener\('unhandledrejection',/, 'a rejected promise has to be reported too; most of this document is async');
  assert.match(chatSource, /reportError\('handleMessage'/, 'a dropped host message still reports, and dropping init is the one that disables the composer');

  const reporter = chatSource.match(/function reportError\(stage, message\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(reporter, 'reporting should go through one place');
  assert.match(reporter, /if \(errorsReported >= 5\) return;/, 'an error thrown inside a render loop fires continuously, so the reporter must cap itself');
  assert.match(reporter, /\.slice\(0, 500\)/, 'the payload must be bounded before it leaves the document');
  assert.match(reporter, /bridge\.postToNative\('webview_error'/, 'the report has to actually leave the document');
});

test('both hosts consume webview_error instead of dropping it', () => {
  assert.match(webViewSource, /msg\.type === 'webview_error'/, 'the phone must handle the message');
  assert.match(webViewSource, /reportChatFrameError\(/, 'the phone must forward it to the crash reporter, not just parse it');
  assert.match(webChatSource, /case 'webview_error'/, 'the web host must handle it as well; a chat fix that lands on one surface only is drift');
});

// The text is composed by a failure we did not write. A parse failure on the
// init message can quote the input it choked on, and init carries the access
// token, so anything token-shaped is stripped before the report is sent on.
test('the reported text is scrubbed of token-shaped runs before it leaves the device', () => {
  const scrub = /\.replace\(\/\[A-Za-z0-9_-\]\{20,\}\/g, '\[redacted\]'\)/;
  assert.match(sentrySource, scrub, 'the phone must scrub before handing the text to the reporter');
  assert.match(webChatSource, scrub, 'the web host must scrub before logging it');

  // Prove the pattern does what the name says, rather than trusting the regex by eye.
  const scrubber = (s) => s.replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]');
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  assert.doesNotMatch(scrubber(`Unexpected token in ${jwt}`), /eyJ/, 'a bearer token in the message must not survive');
  assert.equal(scrubber('Cannot read properties of undefined'), 'Cannot read properties of undefined', 'ordinary error text must survive intact or the report is useless');
});

test('mobile test suite includes the chat frame error-reporting guard', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /chat-frame-error-reporting\.test\.mjs/);
});
