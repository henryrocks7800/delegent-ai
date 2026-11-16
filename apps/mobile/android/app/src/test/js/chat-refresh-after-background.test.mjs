import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const screenSource = readFileSync(new URL('../../../../../src/chat/WebViewChatScreen.tsx', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('../../../../../assets/chat-webview/index.html', import.meta.url), 'utf8');

// 2026-09-24 (Alex): reopening the app after about an hour away showed a stale
// transcript for several seconds. The 45s token timer is paused in the
// background, so the foreground history_refresh went out with an expired token,
// the Worker answered 401 (seen live at 18:40:59 UTC), and the refresh was
// dropped until the next 30s ambient tick.
test('returning to the foreground hands the chat a fresh token before refreshing it', () => {
  const handler = screenSource.match(/AppState\.addEventListener\('change', \(state\) => \{[\s\S]*?\n {4}\}\);/)?.[0];
  assert.ok(handler, 'the foreground handler should exist');
  const token = handler.indexOf("deliverToWebView({ type: 'token_refresh'");
  const refresh = handler.indexOf("deliverToWebView({ type: 'history_refresh' })");
  assert.ok(handler.includes('getFreshMobileAccessToken(mobileSupabase)'), 'it must fetch a fresh token on foreground');
  assert.ok(token >= 0 && refresh > token, 'token_refresh has to be delivered before history_refresh');
});

test('a quiet refresh refused for an expired token retries as soon as a fresh token arrives', () => {
  const quiet = htmlSource.match(/async function refreshHistoryQuietly\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(quiet, 'refreshHistoryQuietly should exist');
  assert.match(quiet, /if \(r\.status === 401 \|\| r\.status === 403\) historyRefreshNeedsAuth = true;/);
  assert.match(quiet, /historyRefreshNeedsAuth = false;/, 'a successful refresh clears the flag');
  const tokenBranch = htmlSource.match(/if \(msg\.type === 'token_refresh'\) \{[\s\S]*?\n {4}\}/)?.[0];
  assert.ok(tokenBranch, 'the token_refresh branch should exist');
  assert.match(tokenBranch, /if \(historyRefreshNeedsAuth && msg\.accessToken\) \{ historyRefreshNeedsAuth = false; void refreshHistoryQuietly\(\); \}/);
});
