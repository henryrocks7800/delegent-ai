// PREOP-C01 regression — "new agent introduces itself as 'atlas' despite the
// user naming it 'Perry'".
//
// Determination (see tmp/preop-fixer-report.md): NOT a backend data leak.
//   - messages RLS is auth.uid()=user_id (migrations 0001/0002) and the worker
//     scopes every chat read by user_id, so no cross-user message bleed.
//   - The server-side fallback name is 'Ruben' EVERYWHERE (complete_mobile_
//     onboarding, claim_next_hermes_provisioning_job, provisioner + runner TS).
//     'Atlas' is ONLY a suggested onboarding chip + the seed-test-user.mjs
//     default — never a server fallback.
//   - The worker chat dispatch reads profiles.agent_name FRESH per task and
//     passes it to the runner, so the chat-time identity is always current.
//
// The genuine, fixable propagation defect: the wake message + runner-baked
// greeting were frozen at provisioning time and ALWAYS asserted a concrete
// name ("Hi, I'm <name>") even when the name was the platform fallback (the
// user hadn't chosen one). That is the class of bug behind a first chat entry
// that claims an identity the user never picked.
//
// The fix (buildDelegentWakeMessageForName in delegentAgentDefaults.ts, wired
// into buildHermesRunnerEnvironment + markSeries4FlyRunnerReady):
//   1. a user-CHOSEN name propagates into SIDEKICK_AGENT_NAME and the NAMED
//      wake;
//   2. a missing / fallback name yields a NAME-NEUTRAL wake (no hardcoded
//      identity).
//
// Fails-without: pre-fix the env builder used buildDelegentWakeMessage(name),
// which for the default 'Ruben' produced "Hi, I'm Ruben." — so the
// name-neutral assertions below fail.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDelegentWakeMessageForName,
  buildDelegentWakeMessage,
  DELEGENT_DEFAULT_AGENT_NAME,
} from '../dist/delegentAgentDefaults.js';
import { buildHermesRunnerEnvironment } from '../dist/index.js';

const baseEnvInput = {
  userId: 'user_c01',
  workerProxyUrl: 'https://worker.sidekick.dev/v1/chat/completions',
  runnerSharedSecret: 'fixture_runner_secret',
  tierId: 'studio',
};

test('PREOP-C01 a user-CHOSEN name propagates into SIDEKICK_AGENT_NAME + the named wake', () => {
  const env = buildHermesRunnerEnvironment({ ...baseEnvInput, agentName: 'Perry' });
  assert.equal(env.SIDEKICK_AGENT_NAME, 'Perry');
  assert.equal(env.HERMES_AGENT_NAME, 'Perry');
  // The baked greeting introduces the chosen name.
  assert.match(env.HERMES_WAKE_MESSAGE, /^Hi, I'm Perry\./);
  // The system prompt also carries the chosen name for first-person voice.
  assert.match(env.HERMES_SYSTEM_PROMPT, /You are Perry,/);
});

test('PREOP-C01 a MISSING name does NOT bake a hardcoded identity into the wake', () => {
  // No agentName supplied -> the env builder falls back to the platform default.
  const env = buildHermesRunnerEnvironment({ ...baseEnvInput, agentName: undefined });

  // SIDEKICK_AGENT_NAME still carries the default for the model's voice...
  assert.equal(env.SIDEKICK_AGENT_NAME, DELEGENT_DEFAULT_AGENT_NAME);

  // ...but the WAKE message must be NAME-NEUTRAL: it must not greet "Hi, I'm
  // <default>." with a name the user never chose. This is the core regression.
  assert.doesNotMatch(env.HERMES_WAKE_MESSAGE, /Hi, I'm /);
  assert.doesNotMatch(env.HERMES_WAKE_MESSAGE, new RegExp(`\\b${DELEGENT_DEFAULT_AGENT_NAME}\\b`));
  // And it must never produce the suggested-chip name 'Atlas' as an intro.
  assert.doesNotMatch(env.HERMES_WAKE_MESSAGE, /\bAtlas\b/i);
  // Still a real greeting (not empty) so the chat surface shows something warm.
  assert.match(env.HERMES_WAKE_MESSAGE, /Nice to meet you/);
});

test('PREOP-C01 buildDelegentWakeMessageForName: chosen name -> named, fallback -> neutral', () => {
  assert.match(buildDelegentWakeMessageForName('Perry'), /^Hi, I'm Perry\./);

  // The platform default (any case / whitespace) collapses to the neutral wake.
  for (const fallback of [undefined, null, '', '   ', 'Ruben', ' ruben ']) {
    const wake = buildDelegentWakeMessageForName(fallback);
    assert.doesNotMatch(wake, /Hi, I'm /, `fallback "${String(fallback)}" must be name-neutral`);
    assert.doesNotMatch(wake, /\bRuben\b/i, `fallback "${String(fallback)}" must not name Ruben`);
    assert.match(wake, /Nice to meet you/);
  }
});

test('PREOP-C01 the legacy named builder still works for explicitly-named callers', () => {
  // buildDelegentWakeMessage is the unconditional named builder; keep its
  // contract pinned so any remaining caller behaves predictably.
  assert.match(buildDelegentWakeMessage('Wren'), /^Hi, I'm Wren\./);
});

// R-PROV-06 regression, found on the 2026-08-16 release gate.
//
// buildDelegentWakeMessageForName has always had a correct name-neutral branch,
// and the tests above pin it. But the CALL SITE in markSeries4FlyRunnerReady
// was wrapped in `if (job.agentName) { ... }`, and the claim path only sets
// agentName when profiles.agent_name is non-empty. So for a user provisioned
// without a chosen name the neutral branch was unreachable and NO greeting row
// was written at all: they opened the app to a completely empty chat.
//
// The unit was tested, the call site was not, which is exactly how this
// survived. This is a source-level guard (the insert lives behind a Supabase
// client that the stuck-readiness tests stub out), so it asserts the shape that
// broke rather than re-testing the builder.
test('R-PROV-06 the wake-message insert is NOT gated on a chosen agent name', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  // fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/...".
  const src = readFileSync(
    fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    'utf8',
  );
  const rawBlock = src.slice(
    src.indexOf('Insert the wake-up assistant message'),
    src.indexOf('series4_wake_message_insert_failed'),
  );
  assert.ok(rawBlock.length > 0, 'could not locate the wake-message insert block');
  // Strip // comments before matching. The first version of this test failed on
  // the explanatory comment above the fix, which quotes the very guard it
  // forbids. Assert on code, not on prose about the code.
  const wakeBlock = rawBlock.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(
    wakeBlock,
    /if\s*\(\s*job\.agentName\s*\)/,
    'the wake-message insert is gated on job.agentName again — a user who never chose a name gets no greeting and lands in an empty chat',
  );
  assert.match(
    wakeBlock,
    /buildDelegentWakeMessageForName\(\s*job\.agentName\s*\?\?\s*null\s*\)/,
    'the wake message must be built via buildDelegentWakeMessageForName(job.agentName ?? null) so a missing name falls back to the neutral greeting',
  );
});
