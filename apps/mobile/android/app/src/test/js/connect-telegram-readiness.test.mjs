import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const webViewHtmlSource = readFileSync(new URL('../../../../../src/chat/chatWebViewHtml.ts', import.meta.url), 'utf8');
const chatScreenSource = readFileSync(new URL('../../../../../src/chat/WebViewChatScreen.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const skillSource = readFileSync(new URL('../../../../../../../services/hermes-runner/skills/delegent/skills/connect-telegram/SKILL.md', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

// 2026-07-14 connect-Telegram pilot: the agent's connect-telegram skill emits
// an empty ```telegram-connect fence; the chat WebView strips it from prose
// and renders a live connect card (pilot-gated) that mints a code against the
// user's own session via the existing worker endpoint. These guards keep the
// three halves (skill fence, WebView card, pilot gate) from drifting apart:
// a skill emitting a fence nobody renders reads as a broken promise to the
// user, and an ungated card exposes an unlaunched surface to every customer.

test('connect-telegram: WebView strips the fence and renders the card last-message-only, gated', () => {
  // Note: the regen script doubles backslashes, so [\s\S] appears as [\\s\\S].
  assert.match(webViewHtmlSource, /telegram-connect\[\\\\s\\\\S\]\*\?/, 'md() must strip the telegram-connect fence from prose');
  assert.match(webViewHtmlSource, /function renderTelegramConnectCard\(/, 'connect card renderer must exist');
  // Note: chatWebViewHtml.ts escapes backticks (\`), so match the escaped fence.
  assert.match(webViewHtmlSource, /pilotTelegramConnect && \/(?:\\`){3}telegram-connect\/i\.test\(fullText\)/, 'card must be pilot-gated and fence-triggered');
  assert.match(webViewHtmlSource, /pilotTelegramConnect: !!\(msg\.pilotFeatures && msg\.pilotFeatures\.telegramConnect\)/, 'WebView must read the telegramConnect pilot flag');
});

test('connect-telegram: card mints via the existing worker endpoint with the user session', () => {
  assert.match(webViewHtmlSource, /api\('\/api\/gateways\/telegram\/connect-code', \{ method: 'POST' \}\)/, 'mint must POST the existing gateway endpoint via api() (session bearer)');
  assert.match(webViewHtmlSource, /telegramConnectMint/, 'mint handler must exist');
  // The deep link must pass the default-deny link policy, not bypass it.
  assert.match(webViewHtmlSource, /fresh\.deepLink \? safeLinkHref\(fresh\.deepLink\) : null/, 'deep link must go through safeLinkHref');
});

test('connect-telegram: native init carries the telegramConnect flag (GA 2026-07-16)', () => {
  assert.match(chatScreenSource, /pilotFeatures: \{ telegramConnect: true/);
});

test('connect-telegram: skill exists, triggers on the right phrases, and emits the exact fence', () => {
  assert.match(skillSource, /^name: connect-telegram$/m, 'skill frontmatter name');
  assert.match(skillSource, /- "connect telegram"/, 'activation phrase');
  assert.match(skillSource, /```telegram-connect\n```/, 'skill must show the exact empty fence to emit');
  assert.match(skillSource, /NEVER invent, guess, or type a connect code/, 'skill must forbid inventing codes');
  assert.match(skillSource, /NEVER ask for the user.s Telegram password/, 'skill must forbid credential requests');
});

test('connect-telegram: menu surfaces a first-class opt-in that triggers the skill', () => {
  // 2026-07-24 (Alex, roadmap #12): a menu row must send the exact "connect
  // telegram" activation phrase into chat via the shared skill dispatch, so the
  // live connect card renders. Not a dead native screen, not a fake slash.
  assert.match(appSource, /testID="menu\.telegramRow"/, 'Telegram menu row must exist');
  assert.match(appSource, /onPress=\{\(\) => runSkillPhrase\('connect telegram'\)\}/, 'the row must send the connect-telegram activation phrase');
});

test('mobile test suite includes connect-telegram regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /connect-telegram-readiness\.test\.mjs/);
});
