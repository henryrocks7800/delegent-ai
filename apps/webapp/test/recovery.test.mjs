import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Every one of these is the same shape of defect: something failed, and what
// the reader was left with could not get them out of it. A retry that looks
// identical to no retry, a spinner with nothing behind it, a blank document, a
// sign-out that did not sign anyone out. None of them throw, none of them log,
// and none of them would be caught by a test that only asks whether the happy
// path renders.

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(here, relative), 'utf8');

const MAIN = read('../src/main.tsx');
const BOUNDARY = read('../src/components/ErrorBoundary.tsx');
const PRODUCT_STATE = read('../src/features/state/useProductState.ts');
const ROUTINES = read('../src/features/routines/RoutinesScreen.tsx');
const ROUTINES_API = read('../src/features/routines/routinesApi.ts');
const AUTH = read('../src/features/auth/useAuth.ts');
const API = read('../src/lib/api.ts');
const CHAT = read('../src/features/chat/ChatScreen.tsx');
const RECORDER = read('../src/features/chat/voiceRecorder.ts');
const CONNECTIONS = read('../src/features/connections/ConnectionsScreen.tsx');
const PLAN = read('../src/features/billing/PlanScreen.tsx');
const REARM = read('../src/lib/useRearmOnBack.ts');
const SUPPORT = read('../src/features/support/SupportScreen.tsx');
const MOBILE = read('../../mobile/App.tsx');
const MOBILE_CHAT = read('../../mobile/src/chat/WebViewChatScreen.tsx');

test('apiFetch keeps its never-throws promise across the token read too', () => {
  // Every caller handles an ApiFailure and nothing else, so a rejection out of
  // apiFetch strands whichever screen made the call on its own "…ing" state.
  // getFreshAccessToken is raw supabase-js and its storage adapter throws
  // outright when the browser has storage blocked. The phone already catches
  // both of these; this is the browser catching up.
  const preamble = API.slice(API.indexOf('export async function apiFetch'), API.indexOf('const headers'));
  assert.match(preamble, /try \{[\s\S]*?await getFreshAccessToken\(\)[\s\S]*?\} catch \{/);
  assert.equal(
    /^\s*const token = await getFreshAccessToken\(\);/m.test(API),
    false,
    'the token read must not be awaited outside a catch',
  );
});

test('a render that throws leaves a page rather than a blank document', () => {
  // React unmounts the whole tree when no boundary claims the error, which on
  // this app is a white screen with no nav and nothing to press.
  assert.match(BOUNDARY, /static getDerivedStateFromError/);
  assert.match(BOUNDARY, /window\.location\.reload\(\)/);
  assert.match(MAIN, /<ErrorBoundary>/);
});

test('the boundary sits outside the router', () => {
  // Inside it, a throw from routing itself takes the fallback down too.
  const inner = MAIN.slice(MAIN.indexOf('<ErrorBoundary>'), MAIN.indexOf('</ErrorBoundary>'));
  assert.match(inner, /<BrowserRouter>/);
});

test('the boundary fallback depends on nothing that could have caused the crash', () => {
  // A fallback that imports from the tree it is standing in for can throw in
  // turn, and React gives up entirely when a boundary's own render fails.
  assert.equal(/from '\.\.\/features\//.test(BOUNDARY), false, 'the fallback imports a feature screen');
  assert.equal(/from '\.\/ui'/.test(BOUNDARY), false, 'the fallback imports shared components');
  assert.equal(/react-router/.test(BOUNDARY), false, 'the fallback depends on the router');
});

test('Try again on the workspace error screen visibly does something', () => {
  // It re-read with status still on 'error', so a second failure repainted the
  // identical screen and the press was indistinguishable from a dead button.
  assert.match(PRODUCT_STATE, /setStatus\(\(current\) => \(current === 'error' \? 'loading' : current\)\)/);
});

test('the transient-gate poll does not get dragged into that spinner', () => {
  // It runs through the same load every few seconds while status is 'live'.
  // Moving it to 'loading' would flash a full-page spinner over a working app.
  assert.match(PRODUCT_STATE, /current === 'error' \? 'loading' : current/);
});

test('Try again on the routines read has its own busy path', () => {
  // Calling load directly showed no spinner, so the button was pressed again
  // and each press started another read.
  assert.match(ROUTINES, /const retry = useCallback\(\(\) => \{\s*\n\s*setLoading\(true\);/);
  assert.match(ROUTINES, /onClick=\{retry\}/);
});

test('the refresh after a save or a pause is not routed through the retry', () => {
  // It would blank the list to a spinner on every toggle.
  const save = ROUTINES.slice(ROUTINES.indexOf('async function save()'), ROUTINES.indexOf('async function togglePaused'));
  assert.equal(/retry\(\)/.test(save), false, 'save now blanks the list to a spinner');
});

test('a routine that was created is not reported as a routine that failed', () => {
  // The create is a Worker call and the list is a direct read, so the create
  // can land and the refresh after it fail. Left as a bare read error over a
  // list missing the new routine, the obvious response is to make it again and
  // end up with two things firing on a schedule.
  assert.match(ROUTINES, /const refreshed = await load\(\);\s*\n\s*if \(!refreshed\) setConfirmation\(ROUTINE_CREATED_REFRESH_FAILED\)/);
});

test('the created-but-not-refreshed wording is shared with the phone', () => {
  // Copy that lives on one surface drifts from the other.
  assert.match(ROUTINES, /import \{ ROUTINE_CREATED_REFRESH_FAILED \} from '@sidekick\/shared'/);
});

test('signing out clears the session locally whatever the server says', () => {
  // The default scope calls the server to revoke and supabase-js can leave the
  // stored session behind when that call fails, so the reader walks away from a
  // machine still signed in. The phone fixed this as audit finding A8.
  assert.match(AUTH, /await supabase\.auth\.signOut\(\{ scope: 'local' \}\)/);
  const body = AUTH.slice(AUTH.indexOf('export async function signOut'));
  const globalAt = body.indexOf('await supabase.auth.signOut();');
  const localAt = body.indexOf("await supabase.auth.signOut({ scope: 'local' });");
  assert.ok(globalAt > -1 && localAt > globalAt, 'the local clear no longer follows the server revoke');
  // Nothing between them may bail out, or the clear stops being unconditional
  // and we are back to a sign-out that depends on the network.
  const between = body.slice(globalAt, localAt);
  assert.equal(/\breturn\b/.test(between), false, 'the local clear can now be skipped when the server revoke fails');
});

test('a stop pressed while the microphone is still opening is answered', () => {
  // startRecording sits on the browser permission prompt, which on a first press
  // is seconds. The chat document lets the reader press stop inside that window,
  // and a stop with no handle yet had nothing to cancel: the recorder went live
  // moments later, ran the full timeout, and spliced a transcript of whatever it
  // overheard into the composer of someone who had already stopped.
  assert.match(CHAT, /const voiceStarting = useRef\(false\)/);
  assert.match(CHAT, /const voiceCancelled = useRef\(false\)/);
  const stop = CHAT.slice(CHAT.indexOf('const onVoiceStop'), CHAT.indexOf('const onVoiceStart'));
  assert.match(stop, /if \(voiceStarting\.current\) \{[\s\S]*?voiceCancelled\.current = true;[\s\S]*?voice_transcript[\s\S]*?\}/);
});

test('a start that was cancelled mid-flight releases the microphone', () => {
  // Without this the browser keeps showing the recording indicator on a screen
  // the reader has left, which is the worst possible thing to get wrong.
  const start = CHAT.slice(CHAT.indexOf('const onVoiceStart'));
  assert.match(start, /if \(voiceHandle\.current \|\| voiceStarting\.current\) return;/);
  assert.match(start, /if \(cancelled\) \{[\s\S]*?started\.cancel\(\);[\s\S]*?return;/);
});

test('leaving the chat cancels a start that has not landed yet', () => {
  assert.match(CHAT, /if \(voiceStarting\.current\) voiceCancelled\.current = true;/);
});

test('leaving the chat route releases the microphone, not just unmounting', () => {
  // App holds this surface mounted behind every other screen on purpose, so a
  // reply in flight survives a trip to Files. That makes unmount useless as a
  // signal that the reader has gone: the cleanup it was hung off cannot fire
  // while the app is running. A recording started and then navigated away from
  // stayed live for the full two minute ceiling with the browser's recording
  // indicator showing, and then spliced a transcript of the room into a composer
  // nobody was reading.
  const APP = read('../src/App.tsx');
  assert.match(APP, /<ChatScreen user=\{user\} \/>/);
  assert.equal(
    /path="\/chat" element=\{<ChatScreen/.test(APP),
    false,
    'chat is a route again, so the route effect below is the wrong mechanism',
  );

  assert.match(CHAT, /const releaseMicrophone = useCallback\(/);
  assert.match(
    CHAT,
    /if \(location\.pathname === '\/chat'\) return;\s*\n\s*releaseMicrophone\(\);/,
    'nothing releases the microphone when the reader leaves the chat route',
  );
  assert.match(CHAT, /return \(\) => releaseMicrophone\(\);/, 'unmount no longer releases the microphone');

  // The release has to say so, or the composer inside the document sits on its
  // recording state while the microphone behind it is already closed.
  const release = CHAT.slice(CHAT.indexOf('const releaseMicrophone'), CHAT.indexOf('Leaving the chat mid-recording'));
  assert.match(release, /handle\.cancel\(\);/);
  assert.match(release, /send\(\{ type: 'voice_transcript', text: '' \}\)/);
});

test('the chat init and the transcription cannot reject past their error paths', () => {
  // Both are raw supabase-js, not apiFetch, so they really can throw when the
  // browser has storage blocked. A throw out of the init skips init_failed and
  // leaves a composer that never sends with no reason why; a throw out of the
  // transcription escapes a bare void call and leaves the composer stuck on its
  // recording state.
  const init = CHAT.slice(CHAT.indexOf('const sendInit'), CHAT.indexOf('const sendInit') + 1200);
  assert.match(init, /try \{[\s\S]*?await getFreshAccessToken\(\)[\s\S]*?\} catch \{/);
  const transcribe = RECORDER.slice(RECORDER.indexOf('export async function transcribeRecording'));
  assert.match(transcribe, /try \{[\s\S]*?await getFreshAccessToken\(\)[\s\S]*?\} catch \{/);
});

test('a failed background token refresh stays in the background', () => {
  // The interval comes round again in forty five seconds, so there is nothing
  // worth saying; what matters is that the rejection does not surface as an
  // unhandled error on a chat that is working perfectly well.
  assert.match(CHAT, /token_refresh[\s\S]{0,400}?\.catch\(\(\) => undefined\)/);
});

// Connection error parity is verified using actual HTTP replies on both
// clients in tests/e2e/connection-client.test.mjs.

test('a support message that failed to send says so where the reader is looking', () => {
  // This is the last screen a stuck reader reaches, so a send that fails
  // silently is the one failure that has no way round it. The phone puts the
  // failure between the box and the button. The browser put it at the top of
  // the page, above two chips, a paragraph, a label and a 132px box, so the
  // press produced no visible change and the obvious reading is that nothing
  // happened.
  const phone = MOBILE.slice(MOBILE.indexOf('function HelpDrawer'), MOBILE.indexOf('function CapacityDrawer'));
  const phoneBox = phone.indexOf('testID="help.messageInput"');
  const phoneError = phone.indexOf("state === 'error' ?");
  const phoneButton = phone.indexOf('testID="help.submitButton"');
  assert.ok(phoneBox > -1, 'the phone help drawer no longer has a message box');
  assert.ok(phoneError > phoneBox, 'the phone no longer renders the send failure after the box');
  assert.ok(phoneButton > phoneError, 'the phone no longer renders the send failure before the button');

  const formAt = SUPPORT.indexOf('<form onSubmit={submit}>');
  const form = SUPPORT.slice(formAt);
  const box = form.indexOf('id="support-message"');
  const error = form.indexOf('role="alert"');
  const button = form.indexOf('type="submit"');
  assert.ok(box > -1, 'the browser support screen no longer has a message box');
  assert.ok(error > box, 'the send failure is back above the box the reader is filling in');
  assert.ok(button > error, 'the send failure no longer sits above the button that produces it');
  assert.equal(
    /\{error \?/.test(SUPPORT.slice(0, formAt)),
    false,
    'the send failure is rendered a second time above the form',
  );
});

test('a failed auth bootstrap does not strand the reader on the spinner', () => {
  // These are raw supabase-js calls, not apiFetch, so they can reject. Without
  // a handler the status stays 'loading', which renders a full-screen
  // "Signing you in…" with nothing to press, permanently.
  assert.match(AUTH, /\.catch\(\(\) => apply\(null\)\)/);
});

test('coming back to the app wakes the runner on both surfaces, not just on first open', () => {
  // The runner scales to zero. Both surfaces poke it early so the first message
  // is not a cold start, and the phone pokes it again every time the app comes
  // back to the foreground. The browser hung its poke off the chat screen
  // mounting, and the chat screen is mounted for the whole session, so a reader
  // who left the tab open for an hour came back to a box that had scaled to
  // zero and paid the full boot on their next message.
  const phone = MOBILE_CHAT.slice(MOBILE_CHAT.indexOf('if (!hasActiveSubscription) return;'));
  assert.match(
    phone.slice(0, 400),
    /AppState\.addEventListener\('change', \(state\) => \{\s*\n\s*if \(state === 'active'\) void warmRunner\(\)/,
    'the phone no longer re-warms the runner when the app returns to the foreground',
  );

  const web = CHAT.slice(CHAT.indexOf("const warm = () =>"));
  assert.ok(web.length > 0, 'the browser no longer has a warm helper to call twice');
  assert.match(
    web.slice(0, 1000),
    /if \(document\.visibilityState === 'visible'\) warm\(\);/,
    'the browser only warms on the tab becoming visible, or not at all',
  );
  assert.match(
    web.slice(0, 1000),
    /document\.addEventListener\('visibilitychange', onVisible\)/,
    'the browser no longer listens for the reader coming back to the tab',
  );
  assert.match(
    web.slice(0, 1000),
    /document\.removeEventListener\('visibilitychange', onVisible\)/,
    'the visibility listener is never removed',
  );
});

test("a stalled setup escalates without switching off the loop that would clear it", () => {
  // The watchdog used to raise status to error with the stalled message. Two
  // things followed from that, and both were worse than the stall.
  //
  // The poll that watches setup only re-arms while status is live, so the
  // escalation stopped it: a workspace that came online a minute after the
  // timeout was never noticed, and the reader sat on the error screen until
  // they thought to press Try again. And status error replaces the whole
  // signed-in app, so a wait the reader could do nothing about took away the
  // chat and files they could still have used.
  const SHELL = read("../src/components/Shell.tsx");

  assert.match(PRODUCT_STATE, /provisioningStalled: boolean;/);
  assert.match(PRODUCT_STATE, /setProvisioningStalled\(true\)/);
  assert.doesNotMatch(
    PRODUCT_STATE,
    /setErrorMessage\(PROVISIONING_STALLED_MESSAGE\)/,
    "the stall must not travel as an error status",
  );

  const watchdog = PRODUCT_STATE.slice(PRODUCT_STATE.indexOf("// Provisioning can wedge"));
  assert.match(
    watchdog,
    /const remaining = PROVISIONING_STALL_TIMEOUT_MS - \(Date\.now\(\) - transientGateEnteredAt\.current\)/,
    "the clock has to survive the hand-over between the two provisioning gates",
  );
  assert.match(
    watchdog,
    /window\.setTimeout\(\(\) => setProvisioningStalled\(true\), remaining\)/,
    "the watchdog owns a timer rather than borrowing the refresh poll as a heartbeat",
  );
  assert.match(watchdog, /window\.clearTimeout\(timer\)/);
  assert.match(
    watchdog,
    /setProvisioningStalled\(false\);/,
    "leaving the gate has to clear the flag or a recovered workspace stays stalled",
  );
  assert.match(
    PRODUCT_STATE,
    /return \{ status, snapshot, gate, errorMessage, provisioningStalled, refresh \};/,
    "the flag has to leave the hook or nothing downstream can read it",
  );
  // The poll that watches setup is what eventually clears all of this, and it
  // re-arms on a timer of its own. An effect that returns no cleanup stacks a
  // fresh timer on every gate change.
  const poll = PRODUCT_STATE.slice(
    PRODUCT_STATE.indexOf("if (!signedIn || status !== 'live' || !isTransientGate(gate)) return;"),
  );
  assert.match(
    poll.slice(0, 300),
    /return \(\) => window\.clearTimeout\(timer\);/,
    "the setup poll must clear its own timer",
  );

  // And it has to land on the always-rendered notice, which is the only thing
  // still on screen while setup runs.
  assert.match(SHELL, /const \{ gate, provisioningStalled \} = useProductStateContext\(\);/);
  assert.match(SHELL, /\{PROVISIONING_STALLED_MESSAGE\}/);
  assert.match(SHELL, /data-testid="shell\.gateNotice\.stalled"/);
});

// Both hand-offs to a third party (Stripe, an OAuth consent screen) deliberately
// keep their busy flag set across `window.location.assign`, because clearing it
// first re-arms the button for the whole page-unload window and a second press
// there starts a second checkout or mints a second authorize state. The price of
// that is the Back button: bfcache restores the app with React state intact, so
// the flag is still set and every button on the page is disabled with the
// pressed one reading "Opening…". Nothing to press, no error, no way out but a
// reload the reader has no reason to try.
test('coming back from Stripe with the Back button does not leave the plan page frozen', () => {
  assert.match(PLAN, /useRearmOnBack\(/, 'the plan page must re-arm after a bfcache restore');
  const rearm = PLAN.slice(PLAN.indexOf('useRearmOnBack('));
  const body = rearm.slice(0, rearm.indexOf('}, []),'));
  assert.match(body, /setBusyTier\(null\)/, 'the tier buttons have to come back');
  assert.match(body, /setPortalBusy\(false\)/, 'Manage billing has to come back too');
});

test('coming back from a consent screen with the Back button does not leave Continue frozen', () => {
  assert.match(CONNECTIONS, /useRearmOnBack\(/, 'the connections page must re-arm after a bfcache restore');
});

test('the re-arm listens for the one event a bfcache restore fires', () => {
  // A normal load remounts with fresh state, so `pageshow` is the only signal
  // that distinguishes a restore, and it is the only one that fires for one.
  assert.match(REARM, /window\.addEventListener\('pageshow', onPageShow\)/);
  assert.match(REARM, /window\.removeEventListener\('pageshow', onPageShow\)/, 'the listener has to be torn down');
});

test('the connection hand-off keeps its button busy across the navigation', () => {
  // This is the file that did not: it cleared busy BEFORE assign, so Continue
  // flipped back to enabled while the browser was still unloading. A second
  // press minted a second authorize URL with a second state, and whichever
  // navigation lost was the state the provider could come back carrying, which
  // reads to the user as "that connection link had expired".
  const handOff = CONNECTIONS.slice(CONNECTIONS.indexOf('async function handOff'));
  const body = handOff.slice(0, handOff.indexOf('\n  }'));
  const assignAt = body.indexOf('window.location.assign');
  assert.ok(assignAt > -1, 'the hand-off should still navigate');
  // The property is not a count of clears. It is that EVERY clear belongs to a
  // branch that gives up and returns, so the success path reaches the
  // navigation with the button still held. Clearing on the way past a branch is
  // precisely the bug, since the button is then live for the whole unload
  // window on the success path too. The behaviour itself is executed against
  // the real component in tests/e2e/connection-screen.test.mjs.
  assert.doesNotMatch(body.slice(assignAt), /setBusy\(false\)/,
    'nothing may re-arm the button once the navigation has been asked for');
  const clears = body.match(/setBusy\(false\)/g) ?? [];
  assert.ok(clears.length >= 1, 'a refused hand-off has to re-arm the button somewhere');
  for (const after of body.split('setBusy(false);').slice(1)) {
    assert.match(after.slice(0, after.indexOf('}')), /return;/,
      'a clear must belong to a branch that stops, not one that falls through to the navigation');
  }
  const refused = body.slice(body.indexOf('if (!result.ok) {'));
  assert.match(refused.slice(0, refused.indexOf('}')), /setBusy\(false\)/,
    'busy must be cleared inside the failure branch, or a refused hand-off leaves Continue stuck');
});

test('a retry of the hand-off does not sit under the last failure', () => {
  const handOff = CONNECTIONS.slice(CONNECTIONS.indexOf('async function handOff'));
  const before = handOff.slice(0, handOff.indexOf('await startConnection'));
  assert.match(before, /setSheetError\(null\)/, 'the previous failure has to be cleared when a retry starts');
});

// Unknown connection reads are tested at the HTTP boundary for both clients
// in tests/e2e/connection-client.test.mjs. The old source assertion required
// 404/503 to return an empty success carrying brokerUnavailable, which no
// longer represents a successful inventory read.

test('a refresh that fails over a list already on screen offers a way to try again', () => {
  // save(), togglePaused() and confirmDelete() all end in load(), and a failed
  // load() writes the page-level error. The only Try again lived in the empty
  // state, which renders only when the list is empty, so a failure after a save
  // left a stale list, a red notice asking for another go, and nothing to press.
  const notice = ROUTINES.slice(ROUTINES.indexOf('{error && !(routines.length === 0'));
  const body = notice.slice(0, notice.indexOf(') : null}'));
  assert.match(body, /onClick=\{retry\}/, 'the over-list error notice needs its own retry');
  assert.match(body, /data-testid="routines\.retry"/);
});

test('hitting the routine ceiling in the browser says so instead of "try again"', () => {
  // The Worker answers 422 with error: 'routine_limit_reached'. ApiFailure.code
  // is a fixed transport union that flattens every 4xx to 'invalid', so the
  // ceiling only survives in serverCode. Read off code, the branch was
  // unreachable and the reader got "Try again in a moment" for a state that no
  // amount of trying clears. The phone reads the body directly and was right.
  assert.match(
    ROUTINES_API,
    /result\.serverCode === 'routine_limit_reached'/,
    'the ceiling is carried by the Worker error string, not by the transport code',
  );
  assert.ok(
    !/result\.code === 'routine_limit_reached'/.test(ROUTINES_API),
    'ApiFailure.code can never equal routine_limit_reached',
  );
  assert.match(API, /code: 'unauthenticated' \| 'no_plan'/, 'the union this depends on must still be closed');
});
