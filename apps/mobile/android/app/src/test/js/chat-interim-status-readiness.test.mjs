import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const webViewHtmlSource = readFileSync(new URL('../../../../../src/chat/chatWebViewHtml.ts', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

// PREOP-C06 (client half): the worker now returns inFlight / interimStatusMessage
// / elapsedSeconds for an in-progress run (so a long task is no longer a silent
// spinner). The chat WebView poll must surface that heartbeat. This guards the
// client render so the backend signal cannot silently go unrendered again.
test('PREOP-C06: chat WebView surfaces the in-flight interim status heartbeat + elapsed seconds', () => {
  assert.match(webViewHtmlSource, /d\.inFlight && d\.interimStatusMessage/, 'poll must read the in-flight interim status');
  assert.match(webViewHtmlSource, /d\.elapsedSeconds/, 'poll must read elapsedSeconds');
  assert.match(webViewHtmlSource, /setStatus\('thinking', d\.interimStatusMessage/, 'interim message must be shown via setStatus');
});

// The "Still working on this" card was removed on 2026-09-23. What stays is the
// guard from 2026-08-01: a terminal state clears the run clock, so a late
// setStatus('thinking') cannot adopt an old start time and count on for ever.
test('a terminal state clears the run clock', () => {
  assert.match(webViewHtmlSource, /if \(!showActivityPill\) runStartedAt = null;/);
  assert.doesNotMatch(webViewHtmlSource, /longRunCard|LONG_RUN_MAX_SECONDS/, 'the long-run card is gone');
});

test('mobile test suite includes chat interim-status regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /chat-interim-status-readiness\.test\.mjs/);
});
