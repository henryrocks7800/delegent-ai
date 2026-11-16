import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const webViewHtmlSource = readFileSync(new URL('../../../../../src/chat/chatWebViewHtml.ts', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

// PREOP-C04: a chat message the user sent and then backgrounded the app would
// silently vanish on return. The user message IS persisted server-side on send
// (handleChatRunCreate + the legacy path both call enqueue_chat_message, which
// inserts the user row immediately), so a SUCCESSFUL send survives a WebView
// reload. The remaining gap is the failure case (degraded "preparing" window,
// coupled to C02): the optimistic bubble must not stay 'complete'-looking and
// then disappear on reload — it must be marked 'failed' so it reads as unsent.
test('PREOP-C04: a failed send marks the optimistic user bubble failed (not silently complete-then-gone)', () => {
  assert.match(webViewHtmlSource, /const optimisticUserMsg = \{ id:'u-'\+Date\.now\(\), role:'user'/, 'optimistic user message must be captured so its status can change');
  assert.match(webViewHtmlSource, /messages\.push\(optimisticUserMsg\)/);
  const failedAssignments = webViewHtmlSource.match(/optimisticUserMsg\.status = 'failed';/g) ?? [];
  assert.ok(failedAssignments.length >= 2, 'both the server-rejected (!r.ok) and network-error (catch) paths must mark the bubble failed');
});

// Regression (Alex 2026-07-20): after declining an approval mid-turn and then
// tapping Stop, the play button stayed disabled and only an app restart cleared
// it. Two root causes: (1) the reconcile-poll fallback ignored the user's Stop
// and kept running its long window (the "still working" pill lingered); (2)
// stopStreaming and the send finally refreshed button VISIBILITY
// (showSendOrStop) but never the DISABLED state (updateSendBtn), so the send
// button stayed stuck from the in-flight state until the next keystroke.
test('composer recovers after decline-then-stop: Stop cancels the poll and re-enables send', () => {
  // A cancel flag exists and is reset at the start of every send.
  assert.match(webViewHtmlSource, /let pollCancelled = false;/, 'pollCancelled flag should be declared');
  assert.match(webViewHtmlSource, /pollCancelled = false;\s*\n\s*runStartedAt/, 'pollCancelled must reset at send start');
  // The background poll bails out immediately when the user stops. `cancellable`
  // scopes that to the typed composer's own turn: a voice-filed run is tracked
  // detached and must survive a Stop aimed at a later typed message.
  assert.match(
    webViewHtmlSource,
    /if \(cancellable && pollCancelled\) \{ aMsg\.streaming = false; stopToolTimers\(aMsg\); renderActive\(aMsg\); return; \}/,
    'the reconcile poll must abort when pollCancelled is set',
  );
  // stopStreaming cancels the poll AND refreshes the send button disabled state.
  const stop = webViewHtmlSource.match(/function stopStreaming\(\)[\s\S]*?\n\}/);
  assert.ok(stop, 'stopStreaming should exist');
  assert.match(stop[0], /pollCancelled = true;/, 'Stop must cancel the background poll');
  assert.match(stop[0], /updateSendBtn\(\);/, 'Stop must refresh the send button disabled state');
});

// A tool card ticks its elapsed counter on a 500ms interval that re-renders the
// whole transcript. Only `tool.completed` used to stop it, so a turn that ended
// any other way (the run finished while polling, the user pressed Stop, the
// stream sent [DONE], the poll window ran out) left the interval running for the
// life of the WebView. They accumulate: after a handful of such turns the chat
// is re-rendering itself many times a second and typing goes visibly laggy.
test('every way a turn can end stops the tool-card timers', () => {
  assert.match(
    webViewHtmlSource,
    /function stopToolTimers\(msg\) \{/,
    'the timer teardown should live in one named place, not be copied per exit path',
  );
  // The paths that end a turn. Each one has to hand its message to the helper.
  const exits = [
    // poll(): the run reached a terminal status.
    /aMsg\.status=d\.status==='succeeded'\?'complete':'failed'; stopToolTimers\(aMsg\);/,
    // poll(): the user pressed Stop.
    /if \(cancellable && pollCancelled\) \{ aMsg\.streaming = false; stopToolTimers\(aMsg\);/,
    // poll(): the whole polling window elapsed with no terminal status.
    /aMsg\.status='failed';\s*\n\s*stopToolTimers\(aMsg\);/,
    // tryStream(): the server closed the stream with [DONE].
    /raw==='\[DONE\]'.*stopToolTimers\(aMsg\)/,
    // tryStream(): the stream closed after a terminal event.
    /aMsg\.streaming=false; stopToolTimers\(aMsg\); render\(\); return true;/,
    // handleEvent(): run.completed / run.failed.
    /aMsg\.status=t==='run\.completed'\?'complete':'failed';[\s\S]{0,200}?stopToolTimers\(aMsg\);/,
    // stopStreaming(): the Stop button, before poll() has noticed.
    /stopToolTimers\(last\);/,
  ];
  for (const exit of exits) {
    assert.match(webViewHtmlSource, exit, `a turn can end here without stopping its tool timers: ${exit}`);
  }
  // Nothing clears a timer by hand any more, so a new exit path cannot quietly
  // half-implement the teardown and still look like the surrounding code.
  const strays = webViewHtmlSource.match(/for \([^)]*\) if \([a-z]+\._timer\)/g) || [];
  assert.equal(strays.length, 0, `hand-rolled timer teardown still present: ${strays.join(', ')}`);
});

// The ambient refresh fetches the server list, then replaces `messages` with
// it. Its guards used to be read only at function entry, so a send that started
// during the fetch (~1-2s) had its optimistic user bubble and its streaming
// assistant placeholder wiped by a response that predates both. The turn still
// ran and still billed; the user watched their own message disappear.
test('the ambient history refresh re-checks its guards after the fetch, not just before it', () => {
  const body = webViewHtmlSource.match(/async function refreshHistoryQuietly\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(body, 'refreshHistoryQuietly should exist');

  const at = (needle) => body.indexOf(needle);
  const guard = /if \(streaming \|\| historyLoading \|\| backgroundRunTracking > 0\) return;/;
  const recheck = body.search(guard);
  assert.ok(recheck > -1, 'the post-await guard should name every state a send or tracker sets');

  assert.ok(at('await r.json()') > -1, 'the refresh should still await the response body');
  assert.ok(
    recheck > at('await r.json()'),
    'the guard has to be re-read AFTER the last await, or it proves nothing about the state now',
  );
  assert.ok(
    recheck < at('messages = fresh'),
    'a stale response must not replace the transcript once a send has started',
  );
});

// Alex, 2026-09-16: a reply that kept failing gave him "That reply did not
// finish. Please send it again." and no hint that a fresh chat would clear it,
// so he resent into the same broken conversation. Every generic chat failure
// has to offer the way out, and must not repeat it when the server already did.
test('a failed reply tells the person a fresh chat is the way out', () => {
  assert.match(webViewHtmlSource, /open the menu and tap Start a fresh chat/, 'the hint text must exist');
  assert.match(webViewHtmlSource, /if \(\/fresh chat\/i\.test\(body\)\) return body;/, 'a message that already says it must not say it twice');
  assert.match(
    webViewHtmlSource,
    /run\.failed' && !textOf\(aMsg\)\.trim\(\)\) lastTextPart\(aMsg\)\.text = withFreshChatHint\(/,
    'the failed-reply bubble is the message Alex actually saw',
  );
  assert.match(webViewHtmlSource, /addError\(withFreshChatHint\(err\.message\|\|err\.error/, 'the generic send failure too');
});

test('mobile test suite includes chat send-persistence regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /chat-send-persistence-readiness\.test\.mjs/);
});
