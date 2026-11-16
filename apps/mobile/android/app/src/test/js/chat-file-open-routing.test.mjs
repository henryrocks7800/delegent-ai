import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../../../../../assets/chat-webview/index.html', import.meta.url), 'utf8');
const webViewSource = readFileSync(new URL('../../../../../src/chat/WebViewChatScreen.tsx', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

// PREOP-H01 / PREOP-H02: tapping a file inside chat must route to the Files
// tab (and surface the file there), instead of the previous inert `open_file`
// handler that left the WebView preview affordance doing nothing.

test('PREOP-H01: the chat WebView open_file message routes to an onOpenFile handler (not an inert stub)', () => {
  assert.match(webViewSource, /onOpenFile\?:\s*\(path:\s*string\)\s*=>\s*void/, 'WebViewChatScreen must declare an onOpenFile prop');
  const openFileBranch = webViewSource.match(/if \(msg\.type === 'open_file'\) \{[\s\S]*?\n\s{6}\}/);
  assert.ok(openFileBranch, 'open_file branch should exist');
  assert.match(openFileBranch[0], /onOpenFile\?\.\(/, 'open_file must invoke onOpenFile with the path (was an inert stub)');
  // Guard against regressing to the comment-only stub that did nothing.
  assert.doesNotMatch(webViewSource, /File open requests could trigger native file viewer/);
});

test('PREOP-H02: a chat file tap switches to the Files tab and surfaces the focused file', () => {
  // Dashboard forwards the callback to the chat WebView.
  assert.match(appSource, /<WebViewChatScreen[\s\S]*?onOpenFile=\{onOpenFile\}/);
  // The shell routes the tap to the Files (artifacts) tab and records the focus.
  assert.match(appSource, /onOpenFile=\{\(path\) => \{[\s\S]*?setFocusedArtifactPath\(path\)[\s\S]*?selectShellTab\('artifacts'\)/);
  // The Files tab receives the focused path and renders the focus surface.
  assert.match(appSource, /<ArtifactsScreen[\s\S]*?focusedFilePath=\{focusedArtifactPath\}/);
  assert.match(appSource, /testID="files\.focusedFromChat"/);
});

// Both hosts routed `open_file` for months, but the chat document never sent
// it: requestFile had no caller and the file chip on a sent message was inert.
// A handler with no trigger reads as a working feature in every source-level
// test that only looks at the receiving end, so this one starts at the tap.
test('a file chip in the transcript actually asks the host to open it', () => {
  const chip = chatSource.match(/<span class="attach-chip ready"[^`]*?<\/span>`/)?.[0];
  assert.ok(chip, 'sent messages should still render a file chip');
  assert.match(chip, /data-file="\$\{esc\(a\.relativeName\|\|a\.name\|\|''\)\}"/, 'the chip should carry the path to open');
  assert.match(chip, /onclick="requestFile\(this\.dataset\.file\)"/, 'tapping the chip should ask the host to open the file');
  assert.match(chip, /role="button"/, 'the chip should announce itself as a control');

  assert.match(
    chatSource,
    /function requestFile\(p\) \{ if \(!p\) return; bridge\.postToNative\('open_file',\{path:p\}\); \}/,
    'requestFile should refuse an empty path rather than route to a bare file list',
  );
  assert.match(
    chatSource,
    /closest\('\.attach-chip\[data-file\]'\)/,
    'a chip with role=button has to answer a key press too',
  );
});

test('mobile test suite includes chat file-open routing regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /chat-file-open-routing\.test\.mjs/);
});
