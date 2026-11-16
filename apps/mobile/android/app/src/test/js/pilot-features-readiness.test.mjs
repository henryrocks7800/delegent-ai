import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const webViewHtmlSource = readFileSync(new URL('../../../../../src/chat/chatWebViewHtml.ts', import.meta.url), 'utf8');
const chatScreenSource = readFileSync(new URL('../../../../../src/chat/WebViewChatScreen.tsx', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

// History: plain-English tool cards + push-to-talk voice shipped 2026-07-13 as
// a Alex-only pilot, then went GA on 2026-07-14 (Alex's call). A third pilot
// feature, inline trace translation (mdWithTraces), was rolled back the same
// day: it made streaming feel like hanging. These guards pin the GA shape.

test('GA: friendly tool-card headlines render for every account, ungated', () => {
  assert.match(webViewHtmlSource, /function friendlyToolHeadline\(/, 'headline mapper must exist');
  assert.match(webViewHtmlSource, /function friendlyCommandLabel\(/, 'command parser must exist');
  assert.match(webViewHtmlSource, /FRIENDLY_CMD_MAP/, 'command map must exist');
  assert.match(webViewHtmlSource, /const headline = friendlyToolHeadline\(tc\.tool, tc\.cmd \|\| tc\.summary\);/, 'renderToolCard must use the friendly headline unconditionally');
  assert.doesNotMatch(webViewHtmlSource, /pilotFriendlyTools/, 'the friendly-cards pilot gate must be gone');
  assert.match(webViewHtmlSource, /tc\.cmd = tc\.summary/, 'tool.started must stash the original invocation for the card body');
  // Spot-check the plain-English vocabulary: a grep must read as a file search.
  assert.match(webViewHtmlSource, /Searching your files/, 'grep-class commands must translate');
  assert.match(webViewHtmlSource, /Looking through your folders/, 'find-class commands must translate');
});

test('GA: mic button ships visible and ungated', () => {
  assert.match(webViewHtmlSource, /class="attach-btn mic-btn" id="micBtn"/, 'mic button must not ship hidden');
  assert.doesNotMatch(webViewHtmlSource, /pilotVoiceInput/, 'the voice pilot gate must be gone');
  assert.match(webViewHtmlSource, /postToNative\('voice_start'/, 'mic tap must ask native to start recording');
  assert.match(webViewHtmlSource, /postToNative\('voice_stop'/, 'second tap must ask native to stop + transcribe');
  assert.match(webViewHtmlSource, /voice_transcript/, 'WebView must consume the transcript message');
  assert.match(webViewHtmlSource, /friendlyVoiceError/, 'voice errors must render as friendly copy');
});

test('GA rollback guard: inline trace translation stays out of the bundle', () => {
  // 2026-07-14: mdWithTraces was rolled back for making streaming feel
  // frozen (static translated lines + full-message rescans per delta). If it
  // returns, it must come back as a deliberate, perf-proven decision, not a
  // stray revert of the revert. (The name may appear in comments; the
  // function and its machinery must not.)
  assert.doesNotMatch(webViewHtmlSource, /function mdWithTraces\(/, 'mdWithTraces function must stay removed');
  assert.doesNotMatch(webViewHtmlSource, /TRACE_SPLIT_RE/, 'trace splitter must stay removed');
  assert.doesNotMatch(webViewHtmlSource, /function traceInfo\(/, 'trace classifier must stay removed');
  assert.match(webViewHtmlSource, /\$\{md\(part\.text\)\}/, 'assistant prose must render through plain md()');
});

test('push-to-talk: native side records, transcribes, caps runaway recordings, and cleans up', () => {
  assert.match(chatScreenSource, /from '\.\/voiceRecorder'/, 'native must use the existing voiceRecorder client');
  assert.match(chatScreenSource, /msg\.type === 'voice_start'/, 'native must handle voice_start');
  assert.match(chatScreenSource, /msg\.type === 'voice_stop'/, 'native must handle voice_stop');
  assert.match(chatScreenSource, /VOICE_MAX_RECORDING_MS/, 'a hard recording ceiling must exist');
  assert.match(chatScreenSource, /voice_transcript/, 'native must deliver the transcript back to the WebView');
  // Leaving chat, not unmounting: this screen stays mounted behind every other
  // tab, so the cleanup this used to point at could not fire.
  assert.match(chatScreenSource, /void stopRecording\(handle\);/, 'leaving chat must stop an active recording');
});

test('every piloted chat feature is GA; the allowlist module remains for future pilots', () => {
  // 2026-07-16: voice mode + Telegram connect GA'd after Alex's pilot round,
  // so the chat surface no longer consults the allowlist. The init keeps the
  // pilotFeatures shape (both true) so the WebView contract is unchanged, and
  // src/state/pilotFeatures.ts stays for the next pilot.
  const pilotModuleSource = readFileSync(new URL('../../../../../src/state/pilotFeatures.ts', import.meta.url), 'utf8');
  assert.match(pilotModuleSource, /PILOT_FEATURE_EMAILS\s*=\s*\[/, 'allowlist constant must exist in the shared module');
  // voiceCapture joined the shape on 2026-08-13: push-to-talk dictation is
  // Android-only because expo-av's pod is excluded from Apple builds and the
  // dictate tap aborted the app on iOS (ASC crash 49B119CF). See
  // voice-mode-readiness.test.mjs for the full two-layer contract.
  assert.match(
    chatScreenSource,
    /pilotFeatures:\s*\{\s*telegramConnect:\s*true,\s*voiceMode:\s*true,\s*voiceCapture:\s*Platform\.OS !== 'ios'\s*\}/,
    'init must carry both GA features plus Android-only voiceCapture',
  );
  assert.match(webViewHtmlSource, /pilotTelegramConnect: !!\(msg\.pilotFeatures && msg\.pilotFeatures\.telegramConnect\)/, 'WebView must read the telegramConnect flag');
});

test('mobile test suite includes pilot-features regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /pilot-features-readiness\.test\.mjs/);
});
