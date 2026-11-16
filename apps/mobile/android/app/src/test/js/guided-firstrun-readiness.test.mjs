import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// 2026-07-24 (Alex, roadmap #4): a brand-new user used to land in an empty chat
// with only a greeting and a blank box, no obvious first action. Guided
// first-run surfaces tappable starter-prompt chips in the chat empty/welcome
// state (shown on ANY empty chat, so it also appears after "Start fresh chat").
// Tapping a chip pre-fills the composer and selects the [paste ...] placeholder;
// it deliberately does NOT auto-send. These guards keep the four halves (source
// HTML, the shared catalogue it mirrors, the compose-not-send behaviour, and the
// regenerated bundle) from drifting apart.

const htmlSource = readFileSync(new URL('../../../../../assets/chat-webview/index.html', import.meta.url), 'utf8');
const compiledSource = readFileSync(new URL('../../../../../src/chat/chatWebViewHtml.ts', import.meta.url), 'utf8');
const sharedSource = readFileSync(new URL('../../../../../../../packages/shared/src/index.ts', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

test('welcome empty-state renders the starter chips', () => {
  // The welcome branch must invoke the starters builder.
  assert.match(htmlSource, /<div class="welcome-greeting">[\s\S]*?\$\{welcomeStartersHtml\(\)\}/, 'welcome state must render welcomeStartersHtml()');
  assert.match(htmlSource, /function welcomeStartersHtml\(\)/, 'welcomeStartersHtml builder must exist');
  assert.match(htmlSource, /class="starter-chip" data-starter="\$\{i\}"/, 'each starter must render a tappable chip carrying its index');
});

test('starters re-appear after a Fresh-chat divider (returning user / testability)', () => {
  // "Start fresh chat" does not empty the transcript, it appends a divider, so
  // the messages.length===0 welcome branch never fires after a reset. render()
  // must re-offer the starters when the last message is that divider, otherwise
  // a returning user (like Alex) can never see or test the feature.
  assert.match(htmlSource, /messages\[messages\.length-1\]\.role === 'divider'\) \{\s*\n\s*h \+= welcomeStartersHtml\(\)/, 'render must append welcomeStartersHtml() when the last message is a fresh-chat divider');
});

test('tapping a starter pre-fills the composer but does NOT auto-send', () => {
  const match = htmlSource.match(/function useStarter\(index\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'useStarter handler not found');
  const body = match[1];
  assert.match(body, /\$input\.value = s\.request/, 'must pre-fill the composer with the request text');
  assert.match(body, /setSelectionRange/, 'must select the [paste ...] placeholder for the user');
  assert.ok(!/sendMessage\(/.test(body), 'useStarter must NOT auto-send (compose, not send)');
  // Compose is gated on the composer being usable.
  assert.match(body, /!bridge\.config\.initComplete/, 'must guard on initComplete');
});

test('starter taps are wired through a delegated click listener', () => {
  assert.match(htmlSource, /\$messages\.addEventListener\('click'/, 'delegated listener on the messages list (survives innerHTML rebuilds)');
  assert.match(htmlSource, /closest\('\.starter-chip'\)/, 'listener must match the starter chip');
  assert.match(htmlSource, /useStarter\(parseInt\(chip\.dataset\.starter, 10\)\)/, 'listener must call useStarter with the chip index');
});

test('inline starters stay in sync with the shared SIDEKICK_INSPIRATION_STARTERS catalogue', () => {
  // The WebView is a standalone bundle and cannot import the shared catalogue,
  // so the request strings are mirrored inline. This asserts they match the
  // canonical source so they cannot silently drift.
  const requests = [...sharedSource.matchAll(/request: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(requests.length >= 3, 'expected the 3 shared starter requests');
  for (const req of requests) {
    assert.ok(htmlSource.includes(req), `inline WELCOME_STARTERS is missing the shared request: ${req}`);
  }
});

test('the compiled bundle was regenerated with the starters (no stale HTML)', () => {
  assert.match(compiledSource, /const WELCOME_STARTERS = \[/, 'chatWebViewHtml.ts must include the regenerated starters');
  assert.match(compiledSource, /function useStarter\(index\)/, 'chatWebViewHtml.ts must include useStarter');
});

test('a history read that failed is not dressed up as a brand-new chat', () => {
  // The welcome renders on an empty message list, and a failed history read
  // leaves the list empty, so a reader with months of conversation was greeted
  // as a stranger and asked their name, with nothing on screen to press. Both
  // failure paths must raise the flag, the flag must get its own branch ahead
  // of the welcome, and that branch must carry a way back.
  assert.match(htmlSource, /let historyFailed = false;/, 'the failed-read state must exist and be distinct from historyLoading');

  const load = htmlSource.slice(htmlSource.indexOf('async function loadHistory()'), htmlSource.indexOf('function norm(m)'));
  assert.match(load, /historyLoading = true;\s*\n\s*historyFailed = false;/, 'a fresh attempt must clear the previous failure');
  assert.equal((load.match(/historyFailed = true;/g) || []).length, 2, 'both the refused reply and the throw must raise the failure flag');

  const empty = htmlSource.slice(htmlSource.indexOf('function render()'), htmlSource.indexOf('class="welcome"'));
  assert.ok(empty.indexOf('if (historyFailed) {') > -1, 'the failure must be handled before the welcome, not after it');
  assert.match(htmlSource, /class="history-retry"/, 'the failure must give the reader something to press');
  assert.match(htmlSource, /closest\('\.history-retry'\)[\s\S]{0,80}loadHistory\(\)/, 'pressing it must retry the read');

  // The ambient poll repaints only when the list differs. A recovered read of a
  // chat that really is empty differs from nothing, so without this the failure
  // would stay on screen for the rest of the session.
  assert.match(htmlSource, /if \([^\n]+\|\| historyFailed\) \{\s*historyFailed = false;/, 'a later successful read must clear the failure');

  assert.match(compiledSource, /let historyFailed = false;/, 'chatWebViewHtml.ts is stale: regenerate it');
});

test('mobile test suite includes guided-firstrun regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /guided-firstrun-readiness\.test\.mjs/);
});
