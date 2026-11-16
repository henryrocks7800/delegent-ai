import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const webViewHtmlSource = readFileSync(new URL('../../../../../src/chat/chatWebViewHtml.ts', import.meta.url), 'utf8');
const chatScreenSource = readFileSync(new URL('../../../../../src/chat/WebViewChatScreen.tsx', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../../../../../../worker/src/index.ts', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');

// 2026-07-14 Voice Mode pilot: realtime speech sessions. The Worker mints
// short-lived client secrets with persona + tools pinned server-side; the
// WebView runs the live session and executes start_task/check_status against
// our own chat-run endpoints with the user's bearer. These guards pin the
// trust boundaries and the failure-safety choices.

test('voice mode: worker mints server-pinned sessions behind auth + voice quota', () => {
  assert.match(workerSource, /url\.pathname === '\/api\/voice\/session' && request\.method === 'POST'/, 'mint route must exist');
  assert.match(workerSource, /url\.pathname === '\/api\/voice\/session\/settle' && request\.method === 'POST'/, 'settle route must exist');
  assert.match(workerSource, /function buildVoiceModeInstructions\(/, 'persona must be built server-side');
  assert.match(workerSource, /VOICE_SESSION_MAX_SECONDS = 600/, 'session cap must be 10 minutes');
  assert.match(workerSource, /resolveVoiceUsageGate\(voiceSnapshot, VOICE_MIN_ENTRY_SECONDS\)/, 'mint must pass the voice quota gate');
  assert.match(workerSource, /clientSecret\.startsWith\('ek_'\)/, 'mint must validate the ephemeral secret shape');
  // Settle is best-effort by design: a metering blip must never error a hang-up.
  assert.match(workerSource, /Settle is best-effort by design/, 'settle failure-tolerance rationale must stay documented');
  assert.match(workerSource, /Math\.min\(Math\.max\(rawSeconds, 1\), VOICE_SESSION_MAX_SECONDS\)/, 'settle must clamp seconds');
});

test('voice mode: WebView session engine is pilot-gated and owns cleanup', () => {
  assert.match(webViewHtmlSource, /id="voiceModeBtn"/, 'voice mode button must exist');
  assert.match(webViewHtmlSource, /voicemode-btn hidden/, 'button must ship hidden (pilot-dark)');
  assert.match(webViewHtmlSource, /pilotVoiceMode: !!\(msg\.pilotFeatures && msg\.pilotFeatures\.voiceMode\)/, 'WebView must read the voiceMode pilot flag');
  assert.match(webViewHtmlSource, /new RTCPeerConnection\(\)/, 'live session must use WebRTC');
  assert.match(webViewHtmlSource, /api\.openai\.com\/v1\/realtime\/calls/, 'SDP offer must go to the realtime calls endpoint with the ephemeral secret');
  assert.match(webViewHtmlSource, /api\('\/api\/voice\/session', \{ method: 'POST'/, 'session must be minted via the worker');
  assert.match(webViewHtmlSource, /api\('\/api\/voice\/session\/settle'/, 'session end must settle metering');
  assert.match(webViewHtmlSource, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/, 'ending must release the microphone');
});

test('voice mode: tools call our own chat-run endpoints with the user bearer', () => {
  assert.match(webViewHtmlSource, /function vmHandleToolCall\(/, 'tool executor must exist');
  assert.match(webViewHtmlSource, /name === 'start_task'/, 'start_task must be handled');
  assert.match(webViewHtmlSource, /name === 'check_status'/, 'check_status must be handled');
  assert.match(webViewHtmlSource, /function_call_output/, 'tool results must return via the data channel');
  // start_task rides the EXACT composer dispatch shape (idempotent runs).
  assert.match(webViewHtmlSource, /conversationId: bridge\.config\.userId, message: text, clientRunId: mintClientRunId\(\)/, 'start_task must use the composer dispatch shape');
});

test('voice mode: filed runs are live-tracked like typed sends (2026-07-16 stale-thread fix)', () => {
  // Root cause of the "chat sits blank until app restart" incident: the run
  // consumer IS the finalizer. start_task must render optimistic bubbles and
  // attach a detached stream/poll tracker, or the worker never finalises the
  // reply promptly and the ambient refresh correctly sees no change.
  assert.match(webViewHtmlSource, /async function trackVoiceRun\(runId, aMsg\)/, 'voice run tracker must exist');
  assert.match(webViewHtmlSource, /void trackVoiceRun\(runId, aMsg\);/, 'start_task must fire-and-forget the tracker');
  assert.match(webViewHtmlSource, /tryStream\(runId, aMsg, \{ detached: true \}\)/, 'tracker must open a DETACHED event stream (typed-send aborts must not sever it)');
  assert.match(webViewHtmlSource, /poll\(runId, aMsg, \{ extended: true \}\)/, 'tracker must fall back to extended polling');
  // start_task pushes a user bubble + an assistant placeholder with a live
  // cursor BEFORE the tracker attaches, so the thread never looks hung.
  assert.match(webViewHtmlSource, /role:'assistant', parts:\[\], status:'queued', taskRunId:runId, createdAt:new Date\(\)\.toISOString\(\), streaming:true \};\s+messages\.push\(aMsg\);\s+render\(\);/, 'start_task must render an optimistic streaming placeholder');
  // The ambient refresh must not wholesale-replace messages while a tracker
  // is live (it would orphan the streaming bubble), and a hung fetch must
  // not wedge the refresh forever.
  assert.match(webViewHtmlSource, /backgroundRunTracking > 0\) return;/, 'ambient refresh must yield to live trackers');
  assert.match(webViewHtmlSource, /backgroundRunTracking\+\+;/, 'tracker must count itself in');
  assert.match(webViewHtmlSource, /backgroundRunTracking--;/, 'tracker must count itself out');
  assert.match(webViewHtmlSource, /AbortSignal\.timeout\(15000\)/, 'ambient refresh fetch must carry a timeout');
  // Extended cadence: 2s for the first two minutes, then 10s.
  assert.match(webViewHtmlSource, /const slowRounds = \(opts && opts\.extended\) \? 180 : 0;/, 'extended poll must add slow rounds');
});

test('voice mode: microphone exclusivity with push-to-talk', () => {
  assert.match(webViewHtmlSource, /if \(vm\) return; \/\/ voice mode owns the microphone/, 'push-to-talk must yield while a voice session is live');
  assert.match(webViewHtmlSource, /if \(voiceState !== 'idle'\) return;/, 'voice mode must not start mid-recording');
});

test('voice mode: native side grants WebView mic capture and sends the pilot flag', () => {
  assert.match(chatScreenSource, /mediaCapturePermissionGrantType="grant"/, 'WebView must grant media capture (OTA-shippable prop)');
  // Voice mode GA'd 2026-07-16 (and Telegram connect the same day): every
  // account gets the orb.
  assert.match(
    chatScreenSource,
    /pilotFeatures:\s*\{\s*telegramConnect:\s*true,\s*voiceMode:\s*true,\s*voiceCapture:\s*Platform\.OS !== 'ios'\s*\}/,
    'init must carry voiceMode GA, and voiceCapture must be Android-only',
  );
});

// 2026-08-13, Alex's on-device iOS test: voice mode "talking to itself and
// then interrupting itself" while he sat silent. WKWebView's echo cancellation
// is ineffective, so the orb's own reply audio re-entered the mic and server
// VAD (400ms, tuned snappy) read it as the user interrupting, forever. Android
// is unaffected: its WebView applies echo cancellation properly.
test('voice mode: iOS runs half-duplex so the orb cannot hear itself', () => {
  // Native must tell the document which OS hosts it, defaulting to android so
  // an older host loses nothing.
  assert.match(chatScreenSource, /platform: Platform\.OS,/, 'init must carry the host platform');
  assert.match(webViewHtmlSource, /platform: String\(msg\.platform \|\| 'android'\)/, 'the document must read it, defaulting android');

  // Explicit audio processing constraints, not the bare { audio: true }.
  // AGC is off on iOS: with no working echo cancellation it amplifies the
  // noise floor toward speech level during silence, which is phantom-turn
  // fuel (2026-08-13, the orb filed "clean my inbox" while Alex sat silent).
  assert.match(webViewHtmlSource, /echoCancellation: true, noiseSuppression: true, autoGainControl: !iosHost/,
    'getUserMedia must request echo cancellation explicitly, and AGC must be off on iOS');

  // iOS hardens server VAD at channel open: the worker mints Android-tuned
  // defaults, and the default threshold fires on iPhone ambient noise which
  // the model then hallucinates a transcript from.
  assert.match(webViewHtmlSource, /threshold: 0\.8, prefix_padding_ms: 300, silence_duration_ms: 500/,
    'iOS must raise the VAD threshold via session.update');
  // session.type is REQUIRED on GA session.update. Omitting it made the
  // server reject the message, and the then-strict error handler killed every
  // iOS session ~200ms after connect (2026-08-13, "connecting then closes").
  assert.match(webViewHtmlSource, /type: 'session\.update', session: \{ type: 'realtime'/,
    'the session.update must carry session.type, or the server rejects it');

  // A rejected request is not a dead session: invalid_request_error events
  // must be ignored, so one malformed client message can never kill the call.
  assert.match(webViewHtmlSource, /indexOf\('invalid_request'\) !== -1\) return;/,
    'invalid_request_error must not end the session');

  // And constraint rejection falls back to the bare mic request rather than
  // failing the whole session over a processing preference.
  assert.match(webViewHtmlSource, /catch \(constraintErr\) \{\s*\n\s*mic = await navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\);/,
    'constraint rejection must fall back to the bare mic request');

  // The gate: track-level, never stops the track (a stopped track cannot be
  // restarted; enabled=false sends silence and keeps WebRTC alive). Per-reply
  // closing is iOS-only; Android keeps barge-in once its start-up gate has
  // opened (2026-09-09: every platform now starts closed until the greeting
  // has played, see webViewBehavior.test.ts "voice start-up mic gate").
  assert.match(webViewHtmlSource, /function vmMicOpen\(open\)/);
  assert.match(webViewHtmlSource, /if \(bridge\.config\.platform !== 'ios' && !open && vm\.startupDone\) return;/,
    'closing must be a no-op off iOS once start-up is done, Android keeps barge-in');
  assert.match(webViewHtmlSource, /t\.enabled = open/, 'mute must toggle enabled, never stop the track');

  // Mute when the reply starts, reopen when its AUDIO finishes playing, not
  // when generation completes: response.done fires while the speaker is still
  // draining, and reopening there feeds the speech tail straight back in.
  const created = webViewHtmlSource.match(/if \(t === 'response\.created'\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.match(created, /vmMicOpen\(false\)/, 'the mic must close when the reply starts');
  assert.match(webViewHtmlSource, /t === 'output_audio_buffer\.stopped' \|\| t === 'output_audio_buffer\.cleared'/,
    'playback-finished events must reopen the mic');

  // The reopen must be MEASURED, not guessed. The first version armed a blind
  // 2.5s timer at response.done; the greeting outlasted it, the mic reopened
  // under the greeting's tail, and the model hallucinated a task Alex never
  // spoke. The analyser poll reopens on ~600ms of measured silence, with a
  // 15s hard cap so a stuck stream can never mute the conversation forever
  // and a plain-timer fallback when no analyser exists at all.
  assert.match(webViewHtmlSource, /function vmArmMicReopenWhenQuiet\(\)/);
  assert.match(webViewHtmlSource, /vmArmMicReopenWhenQuiet\(\);/, 'response.done must arm the measured reopen');
  assert.match(webViewHtmlSource, /quiet = level < 0\.02 \? quiet \+ 1 : 0;/, 'reopen must require consecutive quiet reads');
  assert.match(webViewHtmlSource, /setTimeout\(reopen, 15000\)/, 'the 15s hard cap must exist');
  assert.match(webViewHtmlSource, /setTimeout\(reopen, 4000\)/, 'the no-analyser fallback must exist');
  assert.match(created, /vmCancelMicReopen\(\)/, 'a new reply must cancel the pending reopen');
  assert.match(webViewHtmlSource, /if \(v\.micReopenTimer\) clearTimeout\(v\.micReopenTimer\)/,
    'endVoiceMode must clear the fallback timer');
  assert.match(webViewHtmlSource, /if \(v\.micReopenPoll\) clearInterval\(v\.micReopenPoll\)/,
    'endVoiceMode must clear the analyser poll');
});

// TestFlight build 32, 2026-08-13, ASC crash incident 49B119CF: tapping the
// dictate mic on iOS aborted the whole app. expo-av's native pod is excluded
// from Apple builds (deviation D-11), and the resulting exception surfaces on
// the native queue via a void TurboModule invocation, where voiceRecorder's
// try/catch provably cannot reach it (RCTFatal via RCTExceptionsManager in the
// crash log). Two layers keep iOS out of that path, and both must hold.
test('push-to-talk dictation is unreachable on iOS: hidden by flag, refused by handler', () => {
  // The brace: init tells the document iOS cannot capture, and the document
  // already hides the mic button and its tour row on that flag.
  assert.match(chatScreenSource, /voiceCapture:\s*Platform\.OS !== 'ios'/);
  assert.match(webViewHtmlSource, /voiceCapture: !\(msg\.pilotFeatures && msg\.pilotFeatures\.voiceCapture === false\)/,
    'the WebView must read the voiceCapture flag');
  assert.match(webViewHtmlSource, /\$micBtn\.classList\.toggle\('hidden', !bridge\.config\.voiceCapture\)/,
    'the mic button must hide when the host cannot capture');

  // The belt: a stale document that still shows the mic gets the polite
  // refusal, never the native recorder path that killed the app.
  const guard = chatScreenSource.match(/if \(msg\.type === 'voice_start' && Platform\.OS === 'ios'\) \{[\s\S]*?\n      \}/)?.[0];
  assert.ok(guard, 'the iOS voice_start refusal guard must exist');
  assert.match(guard, /voice_error/, 'the refusal must answer the document');
  assert.match(guard, /recorder_unavailable/, 'the refusal must reuse the existing recorder-unavailable copy');
  assert.match(guard, /return;/, 'the guard must return before the recorder path');
  assert.ok(
    chatScreenSource.indexOf("msg.type === 'voice_start' && Platform.OS === 'ios'") <
      chatScreenSource.indexOf("if (msg.type === 'voice_start') {"),
    'the iOS refusal must be checked before the generic voice_start handler',
  );
});

test('push-to-talk: a stop during start releases the mic instead of arming it', () => {
  // startRecording asks for mic permission, so on a first tap it can sit on a
  // system dialog for seconds, and the WebView deliberately allows a stop from
  // 'starting'. That stop used to find no handle, answer "voice unavailable"
  // and return, while the start it never cancelled went on to open the mic,
  // run the full two-minute cap, and then splice a transcript of whatever the
  // room had said into the composer of someone who had already stopped.
  assert.match(chatScreenSource, /voiceStartingRef/, 'no in-flight start flag');
  assert.match(chatScreenSource, /voiceCancelledRef/, 'no cancel flag for an in-flight start');
  assert.match(chatScreenSource, /if \(voiceHandleRef\.current \|\| voiceStartingRef\.current\) return;/, 'a second start can still overlap the first');
  assert.match(chatScreenSource, /if \(cancelled\) \{[\s\S]{0,240}?void stopRecording\(started\);/, 'a cancelled start does not release the recorder');
  assert.match(
    chatScreenSource,
    /voiceCancelledRef\.current = true;\s*\n\s*deliverToWebView\(\{ type: 'voice_transcript', text: '' \}\)/,
    'a cancel is still reported as a failure rather than as nothing recorded',
  );
});

test('push-to-talk: leaving while the mic is opening still releases it', () => {
  // No handle exists at that point, so the release had nothing to stop and the
  // mic would open moments after the user was gone.
  const release = chatScreenSource.slice(chatScreenSource.indexOf('const releaseMicrophone'));
  assert.match(release, /if \(voiceStartingRef\.current\) voiceCancelledRef\.current = true;/);
});

test('push-to-talk: leaving the chat tab releases the mic, not just unmounting', () => {
  // This screen stays mounted behind every other tab on purpose, so a reply in
  // flight survives the trip to Files. That makes unmount useless as a signal
  // that the user has gone: the cleanup it was hung off cannot fire while the
  // app is running. A recording started and then tabbed away from stayed live
  // for the full two-minute ceiling with the Android mic indicator showing, and
  // then spliced a transcript of the room into a composer nobody was reading.
  assert.match(chatScreenSource, /active: boolean;/, 'the screen cannot tell whether its tab is showing');
  assert.match(
    chatScreenSource,
    /if \(active\) return;\s*\n\s*releaseMicrophone\(\);/,
    'nothing releases the mic when the tab stops being the showing one',
  );
  assert.match(chatScreenSource, /return \(\) => releaseMicrophone\(\);/, 'unmount no longer releases the mic');

  // The release has to say so, or the WebView composer sits on "Listening…"
  // while the mic behind it is already closed.
  const release = chatScreenSource.slice(
    chatScreenSource.indexOf('const releaseMicrophone'),
    chatScreenSource.indexOf('Leaving chat mid-recording'),
  );
  assert.match(release, /void stopRecording\(handle\);/);
  assert.match(release, /deliverToWebView\(\{ type: 'voice_transcript', text: '' \}\)/);

  // And the tab has to actually be passed in, or the prop defaults to whatever
  // the type allows and the effect never runs.
  assert.match(appSource, /active=\{activeTab === 'dashboard'\}/, 'App never tells chat whether it is showing');
});

test('mobile test suite includes voice-mode regression coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /voice-mode-readiness\.test\.mjs/);
});

test('a Talk-filed task settles the working pill and card when it ends (2026-09-23)', () => {
  // Only a typed send's wrap-up switched the pill off, so after a Talk task the
  // pill counted for ever and the card quoted the last typed message.
  const tracker = webViewHtmlSource.slice(webViewHtmlSource.indexOf('async function trackVoiceRun('), webViewHtmlSource.indexOf('async function vmHandleToolCall('));
  assert.match(tracker, /backgroundRunTracking--;[\s\S]*if \(!streaming && backgroundRunTracking === 0\) setStatus\('online', 'online'\);/,
    'the tracker must settle the status once no run is left');
  assert.match(webViewHtmlSource, /lastUserMessage = text;\s*output = \{ ok: true, status: 'started'/, 'the card must quote the Talk task, not the last typed message');
});
