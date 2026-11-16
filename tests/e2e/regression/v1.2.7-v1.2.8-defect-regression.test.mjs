// v1.2.7 + v1.2.8 defect regression suite.
//
// Alex's directive after the v1.2.7 emulator review: "I'd like you
// to document all of these defects in the table like we did before,
// so that we can work through them systematically and don't forget
// any" — and then in v1.2.8: "I want tests written for every single
// defect that we found here so that we never have these defects
// again."
//
// This file is the single source of truth: every defect from the
// v1.2.7 + v1.2.8 reviews gets at least one assertion below. If a
// future refactor regresses the fix, this suite fails at npm test
// (no emulator required), long before the regression hits an APK.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
// Files-tab folder grouping/order logic was extracted out of App.tsx into a
// pure module (2026-06-06), then moved again into @sidekick/shared when the
// browser started drawing the same Files screen. The mobile module is now a
// typed re-export, so DN8 asserts the folder contract where it actually lives
// and separately asserts the phone still sources it from there.
const folderGroupsSource = read('packages/shared/src/files/folderGroups.ts');
const mobileFolderGroupsSource = read('apps/mobile/src/files/folderGroups.ts');

const appSource = read('apps/mobile/App.tsx');
// 2026-06-10: the legacy native chat (HomeChatPanel.tsx + the cards/
// renderer modules) was verified unmounted and deleted. The defect
// assertions that lived purely in that surface (D4/DN3/DN4 header,
// D9 scroll pinning, DN5 ThinkingDots, the D6 native tool-call cards)
// were retired with it; the live chat surface is the WebView
// (chatWebViewHtml.ts) covered by webViewBehavior.test.ts.
const chatClientSource = read('apps/mobile/src/chat/chatClient.ts');
const voiceRecorderSource = read('apps/mobile/src/chat/voiceRecorder.ts');
const workerSource = read('apps/worker/src/index.ts');
const runnerSource = read('services/hermes-runner/server.py');
const emailScript = read('scripts/apply-supabase-email-template.mjs');
const appConfig = read('apps/mobile/app.config.ts');
const androidManifest = read('apps/mobile/android/app/src/main/AndroidManifest.xml');

// ---------------------------------------------------------------------------
// v1.2.7 defects (Alex's first emulator review)
// ---------------------------------------------------------------------------

test('[v1.2.7 D1] Magic-link email template ships with Delegent AI branding (not the Supabase default)', () => {
  assert.match(emailScript, /Delegent/);
  assert.match(emailScript, /Instrument Serif/);
  // Banned: any remaining Supabase-default copy or the dead-end
  // "Open Delegent AI" button (DN10 removed it).
  assert.doesNotMatch(emailScript, /powered by Supabase/);
  assert.doesNotMatch(emailScript, />Open Delegent AI</);
  // Banned: bare {{ .Email }} in the body — DN10 stripped this to
  // remove the user's own mailbox from the visible copy.
  assert.doesNotMatch(emailScript, /to \{\{ \.Email \}\}/);
});

test('[v1.2.7 D2] Login screen surfaces an OTP code input after sending the email', () => {
  assert.match(appSource, /testID="login\.emailOtpInput"/);
  assert.match(appSource, /testID="login\.emailOtpVerify"/);
  assert.match(appSource, /onVerifyEmailOtp/);
  assert.match(appSource, /handleVerifyEmailOtp/);
  // The OTP input must only show after the email is sent (emailSentTo).
  assert.match(appSource, /emailSentTo \? \(/);
});

test('[v1.2.7 D5 + D7] Shell latches once authenticated so productState refreshes do NOT flicker the LoginScreen', () => {
  assert.match(appSource, /const \[shellEverShown, setShellEverShown\] = useState\(false\)/);
  assert.match(appSource, /initialAuthReadyForShell && !shellEverShown/);
  // Latch must reset cleanly on actual sign-out so a logged-out user
  // doesn't get a stuck shell.
  assert.match(appSource, /authState\.status === 'signed_out' && shellEverShown/);
});

test('[v1.2.7 D6] Chat dispatch routes through the user\'s runner (NOT a raw OpenRouter shortcut)', () => {
  // Worker chat dispatch must look up the binding before doing anything else,
  // and the runner /tasks endpoint is the ONLY path. v2.0.1 removed the
  // OpenRouter fallback, so a not-ready runner fails closed (see [v2.0.1 P0]).
  assert.match(workerSource, /fetchChatRunnerBinding/);
  assert.match(workerSource, /buildSidekickRunnerTaskHeaders/);
  assert.match(workerSource, /handled EXCLUSIVELY by the user's per-user Hermes runner/);
  // Runner side accepts history + agent_name so chat continuity works.
  assert.match(runnerSource, /class TaskIn\(BaseModel\):/);
  assert.match(runnerSource, /history: list\[ChatHistoryTurn\] \| None = None/);
  assert.match(runnerSource, /agent_name: str \| None = None/);
});

test('[v1.2.7 D6] Chat message contract carries tool calls for inline rendering', () => {
  // The native ToolCallCard surface was deleted with HomeChatPanel
  // (2026-06-10); the live WebView renders tool parts from the SSE
  // stream (covered by webViewBehavior.test.ts). The surviving
  // contract: ChatMessage must carry toolCalls so the type-system
  // enforces tool-call data reaching the chat surface.
  assert.match(chatClientSource, /toolCalls: readonly ChatToolCall\[\]/);
});

// ---------------------------------------------------------------------------
// v1.2.8 defects (Alex's second emulator review)
// ---------------------------------------------------------------------------

test('[v2.0.1 P0] Chat dispatch has NO direct-OpenRouter fallback (runner or honest error)', () => {
  // Operator decision (2026-05-29): the v1.2.8 direct-OpenRouter fallback was
  // REMOVED. It hid real defects (a workspace that never provisioned still
  // "chatted", and tool-only asks fake-succeeded with no file produced). Chat
  // must go through the user's Hermes runner, or fail closed with an honest
  // runner_not_ready status, so a real reply always means the real runner ran.
  assert.doesNotMatch(workerSource, /dispatchChatRunOpenRouterFallback/,
    'the direct-OpenRouter chat fallback function must be removed');
  assert.match(
    workerSource,
    /binding\.kind === 'runner_not_ready'[\s\S]*?finalizeChatRun\(env, job, '', false, 'runner_not_ready'\)/,
    'a not-ready runner must fail closed with an honest runner_not_ready status, never a silent OpenRouter answer',
  );
  assert.match(workerSource, /errorCode === 'runner_not_ready'/,
    'userFacingErrorMessage must surface an honest not-ready message');
});

test('[v1.2.8 DN1] OTP input accepts the 8-digit codes Supabase actually issues', () => {
  assert.match(appSource, /sanitizedOtp\.length === 8/);
  assert.match(appSource, /\.slice\(0, 8\)/);
  // Old 6-char cap must NOT come back — it'd reproduce the v1.2.7
  // bug where the code in the email "didn't work".
  assert.doesNotMatch(appSource, /sanitizedOtp\.length === 6/);
  // 2026-05-17 follow-up: Maestro caught the post-send status copy
  // still saying "6-digit code" while the input had been bumped to
  // 8. The copy MUST match the length or users will type 6 chars
  // and the verify button never enables. Pin both.
  assert.match(appSource, /We sent an 8-digit code to \$\{result\.email\}/);
  assert.doesNotMatch(appSource, /sent a 6-digit code/);
  // The placeholder is copy too. A six-digit worked example on an
  // eight-digit field reproduces the same dead end by demonstration.
  assert.match(appSource, /placeholder="00000000"/);
  assert.doesNotMatch(appSource, /placeholder="123456"/);
});

test('[v1.2.8 DN2] Monthly capacity page uses a one-shot ref guard against the infinite-refresh loop', () => {
  // CapacityDrawer must have refreshedOnEntryRef so the useEffect
  // can\'t re-fire when onRefreshCapacity\'s reference changes.
  const start = appSource.indexOf('function CapacityDrawer');
  assert.notEqual(start, -1, 'CapacityDrawer must exist');
  const end = appSource.indexOf('\nfunction ', start + 1);
  const body = end === -1 ? appSource.slice(start) : appSource.slice(start, end);
  assert.match(body, /const refreshedOnEntryRef = useRef\(false\)/);
  assert.match(body, /if \(refreshedOnEntryRef\.current\) return/);
  assert.match(body, /refreshedOnEntryRef\.current = true/);
});

test('[v1.2.8 DN6] Mic button drives a real expo-av recorder + Worker transcribe route', () => {
  // expo-av wired in package.json + native permission declared in
  // BOTH app.config.ts and the prebuilt AndroidManifest.
  const mobilePackage = JSON.parse(read('apps/mobile/package.json'));
  assert.ok(mobilePackage.dependencies['expo-av'], 'expo-av dep must be installed');
  // RECORD_AUDIO must be declared, but the array now carries sibling
  // permissions too (CAMERA for the chat composer's camera button), so match
  // RECORD_AUDIO inside the array rather than pinning it as the sole entry.
  assert.match(appConfig, /permissions: \[[^\]]*'RECORD_AUDIO'/);
  assert.match(androidManifest, /android\.permission\.RECORD_AUDIO/);

  // voiceRecorder helper exposes the three lifecycle calls.
  assert.match(voiceRecorderSource, /export async function startRecording/);
  assert.match(voiceRecorderSource, /export async function stopRecording/);
  assert.match(voiceRecorderSource, /export async function transcribeRecording/);

  // Worker route exists + reuses OPENROUTER_API_KEY when OpenAI key
  // is absent so Alex doesn't have to configure a new secret.
  assert.match(workerSource, /async function handleAudioTranscribe/);
  assert.match(workerSource, /\/api\/audio\/transcribe/);
  assert.match(workerSource, /openrouter\.ai\/api\/v1\/audio\/transcriptions/);
});

test('[v1.2.8 DN7] Tab icons are message-square + hard-drive with an active-state pill', () => {
  const start = appSource.indexOf('function TabButton');
  assert.notEqual(start, -1);
  const end = appSource.indexOf('\nfunction ', start + 1);
  const body = end === -1 ? appSource.slice(start) : appSource.slice(start, end);
  assert.match(body, /dashboard: 'message-square'/);
  assert.match(body, /artifacts: 'hard-drive'/);
  assert.match(body, /tabIconWrapActive/);
});

test('[v1.2.8 DN8] Files tab groups by the runner\'s top-level Linux directory', () => {
  // Renderer is in App.tsx; the grouping logic moved to folderGroups.ts.
  assert.match(appSource, /function RunnerFilesByDirectory/);
  assert.match(appSource, /buildFolderGroups\(/);
  assert.match(folderGroupsSource, /FOLDER_ORDER/);
  // The phone must keep drawing from the shared definition. A local copy here
  // is how the two surfaces start disagreeing about which folder a file is in.
  assert.match(mobileFolderGroupsSource, /from '@sidekick\/shared'/);
  // v1.2.8 DN8 originally listed 'home, documents, downloads, code, notes'.
  // The set was tuned after the Files page rewrite to drop `code` and add
  // `pictures` so the seeded folders mirror what a non-technical user
  // expects in a home directory; the contract this test guards is that
  // the renderer keeps a fixed top-level folder order (no per-render
  // resorting) so files don't visually jump between sessions.
  assert.match(
    folderGroupsSource,
    /key: 'home'[\s\S]*?key: 'documents'[\s\S]*?key: 'pictures'[\s\S]*?key: 'downloads'[\s\S]*?key: 'notes'/,
    'DEFAULT_FOLDERS must enumerate the five top-level folders in a stable order',
  );
  // Each file's top-level directory is derived before sorting.
  assert.match(folderGroupsSource, /fullDirectoryPath/);
  assert.match(appSource, /private cloud space/);
});

test('[v1.2.8 DN8] Runner seeds the standard Linux directories on first boot, idempotently', () => {
  assert.match(runnerSource, /def _seed_runner_workspace/);
  assert.match(runnerSource, /_WORKSPACE_SEEDED_MARKER = '\.delegent-workspace-seeded'/);
  assert.match(runnerSource, /'home\/README\.md'/);
  assert.match(runnerSource, /'documents\/getting-started\.md'/);
  assert.match(runnerSource, /'downloads\/README\.md'/);
  assert.match(runnerSource, /'code\/example\.py'/);
  assert.match(runnerSource, /'notes\/welcome\.md'/);
  // Tests can suppress seeding via the env flag.
  assert.match(runnerSource, /DELEGENT_SKIP_WORKSPACE_SEED/);
});

test('[v1.2.8 DN10] Email template removed both the dead-end button AND the recipient-email leak', () => {
  // The "Open Delegent AI" button (which dead-ended at about:blank
  // under Gmail's WebView) must be gone.
  assert.doesNotMatch(emailScript, />Open Delegent AI</);
  // The "{{ .Email }}" leak in the body must be gone.
  assert.doesNotMatch(emailScript, /to \{\{ \.Email \}\}/);
  // The branded code block remains.
  assert.match(emailScript, /\{\{ \.Token \}\}/);
});

// ---------------------------------------------------------------------------
// Lessons-learned guards: stop the v1.2.7 gap that triggered the v1.2.8 round
// ---------------------------------------------------------------------------

test('[guard] worker chat dispatch must never silently 500/"I couldn\'t finish that" without trying the fallback first', () => {
  // The v1.2.7 regression silently finalized with "I couldn't finish
  // that. Try again in a moment." for every runner_not_ready binding.
  // The v1.2.8 fallback explicitly logs the fall-through reason AND
  // still produces a real assistant reply, so this hardcoded copy
  // should now only ever appear via finalizeChatRun's last-resort
  // failure path (where errorCode is set + the mobile UI knows to
  // soften the copy).
  //
  // v1.3+: the literal copy moved into a `DN1_4_01_SAFE_COPY` const +
  // `userFacingErrorMessage(errorCode)` helper. The guard still has to
  // verify: (a) the safe-copy const exists with the canonical text;
  // (b) it is funnelled through the failure-only path (errorCode set);
  // (c) the non-ready fallback still routes through OpenRouter.
  // 2026-09-16: the canonical text now carries the way out of a conversation
  // that is itself stuck. Alex hit a reply that kept failing with nothing on
  // screen saying a fresh chat would clear it, so he resent into the same
  // broken conversation. The sentence in front of the hint is unchanged.
  assert.match(
    workerSource,
    /export const DN1_4_01_SAFE_COPY\s*=\s*`I couldn't finish that\. Try again in a moment\. \$\{FRESH_CHAT_HINT\}`/,
    'last-resort error copy must stay exported as DN1_4_01_SAFE_COPY with the canonical text — the regression test pins the surface so downstream tests can rely on it',
  );
  assert.match(
    workerSource,
    /export const FRESH_CHAT_HINT\s*=\s*\n?\s*'If it keeps happening, start a fresh chat from the menu in the app/,
    'the hint itself must stay one exported sentence, so every generic failure words it the same way',
  );
  // The safe copy reaches the user only via the errorCode path
  // (userFacingErrorMessage). If errorCode is null this is a normal
  // success or "no error" finalize — the helper returns the const
  // explicitly for the fallback. The pattern asserts the helper exists.
  assert.match(
    workerSource,
    /function userFacingErrorMessage\([^)]*errorCode[^)]*\)\s*:\s*string\s*\{[\s\S]*?DN1_4_01_SAFE_COPY/,
    'userFacingErrorMessage(errorCode) must funnel DN1_4_01_SAFE_COPY through a single helper — otherwise non-failure paths could ship the copy by accident',
  );

  // v2.0.1: there is NO fallback path: a non-ready binding fails closed.
  assert.doesNotMatch(workerSource, /dispatchChatRunOpenRouterFallback/,
    'no direct-OpenRouter fallback may remain in the chat dispatch path');
});

test('[guard] mobile sign-in/copy must stay infrastructure-agnostic — no Hermes / Fly / Cloudflare leak', () => {
  // Catches "I added a Hermes reference to a comment that ships in
  // the bundle" regressions. Asserts the in-bundle source files
  // contain no provider/infra vocabulary that would betray the
  // agent abstraction.
  for (const [name, source] of [
    ['chatClient.ts', chatClientSource],
    ['voiceRecorder.ts', voiceRecorderSource],
  ]) {
    assert.doesNotMatch(
      source,
      /Hermes|Fly Machines|Cloudflare|OpenRouter|service_role|Railway/,
      `${name} must not name infrastructure providers (would leak in stack traces / logcat)`,
    );
  }
});
