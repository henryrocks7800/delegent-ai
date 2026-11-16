import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const path = (relativePath) => join(repoRoot, relativePath);
const read = (relativePath) => readFileSync(path(relativePath), 'utf8');
const manifest = JSON.parse(read('apps/mobile/android/integration/production-flow-manifest.json'));

// v1.2.x — manifest was pruned during the chat-first pivot. Flows that
// no longer exist (Telegram connect sheet, bot greeting, file preview
// variants, "home.ready_and_preparing_states") were retired. The map
// below mirrors the current production-flow-manifest.json shape.
const requiredObservableCoverage = new Map([
  ['auth.email_magic_link_callback', ['auth', 'auth-email']],
  ['auth.returning_active_subscriber_bypass', ['auth', 'billing', 'onboarding']],
  ['onboarding.first_run_validation', ['onboarding']],
  // v1.2.8 — chat-panel first land needs an authenticated session;
  // runner readiness is no longer the gate (graceful OpenRouter
  // fallback covers the cold-start window).
  ['home.chat_panel_first_land', ['auth']],
  // 2026-09-28: no `files` proof any more. Files went with the runners on
  // 2026-09-18, and with them home.file_open_from_chat and
  // files.empty_drawer_state.
  ['home.chat_send_text_message', ['chat', 'usage']],
  ['setup.plan_checkout_new_user', ['billing', 'checkout']],
  ['billing.current_plan_no_checkout', ['billing', 'usage']],
  ['billing.upgrade_plan_portal', ['billing']],
  ['billing.deep_link_returns', ['billing', 'webhook']],
  ['profile.edit_and_signout', ['auth', 'onboarding']],
  ['menu.terms_page', ['onboarding']],
  ['menu.capacity_page', ['usage', 'billing']],
  ['session.restore_and_signout', ['auth']],
  ['resilience.offline_api_errors', ['auth']],
]);

const flowsById = new Map(manifest.flows.map((flow) => [flow.id, flow]));

const providerExpectationNames = [
  'auth',
  'auth-email',
  'onboarding',
  'billing',
  'webhook',
  'runner-ready',
  'telegram-connect-code',
  'telegram-connected',
  'telegram-task',
  'chat',
  'files',
  'usage',
  'task-and-files',
  'live-happy-path',
];

function walkFiles(rootDir) {
  const results = [];
  for (const entry of readdirSync(rootDir)) {
    const full = join(rootDir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      results.push(...walkFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

test('production mobile manifest marks every provider-backed journey with backend observables', () => {
  for (const [flowId, expectedObservables] of requiredObservableCoverage) {
    const flow = flowsById.get(flowId);
    assert.ok(flow, `missing flow ${flowId}`);
    assert.ok(Array.isArray(flow.backendObservables), `${flowId} should declare backendObservables`);
    for (const observable of expectedObservables) {
      assert.ok(flow.backendObservables.includes(observable), `${flowId} should prove ${observable}`);
    }
    assert.ok(flow.evidence.includes('screenshot'), `${flowId} should retain front-end screenshot proof`);
    assert.ok(flow.evidence.includes('ui-hierarchy'), `${flowId} should retain Android hierarchy proof`);
  }

  // v1.2.x — the Telegram bot-greeting flow was retired with the
  // messenger wizard. Home chat/file flows now carry current-run
  // provider proof for chat + file + usage boundaries.
});

test('signed-out Google handoff flow does not claim completed auth provider proof', () => {
  const flow = flowsById.get('auth.google_native_handoff');
  assert.ok(flow, 'missing auth.google_native_handoff flow');
  assert.equal(flow.requiredState, 'signed_out');
  assert.deepEqual(
    flow.backendObservables,
    [],
    'native Google handoff accepts provider/setup/error surfaces and must not require Supabase auth proof',
  );
  const yaml = read(flow.maestroFile);
  assert.match(yaml, /Choose an account|Use another account|sign-in needs setup|couldn't complete/);
});

test('visual page sweep that taps authenticated tabs is not selected for signed-out runs', () => {
  const flow = flowsById.get('visual.page_sweep');
  assert.ok(flow, 'missing visual.page_sweep flow');
  const yaml = read(flow.maestroFile);
  // The sweep must target an authenticated surface: it starts from the
  // signed-in ready step (which waits for the chat) and taps post-auth shell
  // controls, the menu button and the header's profile button, rather than
  // anything on a signed-out screen. 2026-09-28: the Chat / Files tabs it used
  // to tap went with the runners; everything is reached from the menu now.
  assert.match(yaml, /runFlow:\s*_signed_in_ready\.yaml/);
  assert.match(yaml, /id:\s*"main-menu-button"/);
  assert.match(yaml, /id:\s*"menu\.connectionsRow"/);
  assert.match(yaml, /id:\s*"header\.profileButton"/);
  const ready = read('apps/mobile/android/integration/maestro/production/_signed_in_ready.yaml');
  assert.match(ready, /id:\s*"home\.chatPanel"/);
  assert.notEqual(
    flow.requiredState,
    'any',
    'authenticated tab sweep cannot be requiredState:any because signed-out release gates would select it',
  );
  assert.notEqual(flow.requiredState, 'signed_out');
  assert.doesNotMatch(yaml, /Continue with Google|Continue with email/);
});

test('live-flow inspector supports the provider expectations claimed by the production UI suite', () => {
  const inspector = read('scripts/inspect-live-flow.mjs');

  for (const expectation of providerExpectationNames) {
    assert.match(inspector, new RegExp(expectation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `missing ${expectation}`);
  }

  assert.match(inspector, /hashIdentifier/, 'provider evidence should hash stable identifiers');
  assert.match(inspector, /redacted|redact/i, 'provider evidence output should be redacted');
  assert.match(inspector, /gateway_connections/);
  assert.match(inspector, /gateway_task_events/);
  assert.match(inspector, /token_usage_events/);
  assert.match(inspector, /hermes_instances/);
});

test('production UI runner produces an evidence pack without requiring service secrets in the app layer', () => {
  const runner = read('scripts/run-production-mobile-ui-flows.sh');

  assert.match(runner, /flow-status\.jsonl/);
  assert.match(runner, /summary\.json/);
  assert.match(runner, /provider/);
  assert.match(runner, /ALLOW_MISSING_MAESTRO/);
  assert.match(runner, /RUN_ALL_PRODUCTION_UI_FLOWS/);
  assert.match(runner, /PRODUCTION_UI_STATE/);
  assert.match(runner, /screencap/);
  assert.match(runner, /uiautomator/);
  assert.match(runner, /auth\|auth-email\|onboarding\|billing\|webhook\|runner-ready\|telegram-connect-code\|telegram-connected\|telegram-task\|chat\|files\|usage/);
  assert.match(runner, /if ! expectation="\$\(map_backend_observable_to_expectation "\$observable"\)"; then/);
});

test('production mobile UI artifacts do not bake server-secret names into public mobile flows', () => {
  const forbidden = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'OPENROUTER_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'RAILWAY_API_TOKEN',
    'RUNNER_SHARED_SECRET',
  ];
  const files = [
    path('apps/mobile/android/integration/production-flow-manifest.json'),
    path('scripts/run-production-mobile-ui-flows.sh'),
    ...walkFiles(path('apps/mobile/android/integration/maestro/production')),
  ];

  for (const file of files) {
    assert.ok(existsSync(file), `${file} should exist`);
    const source = readFileSync(file, 'utf8');
    for (const secretName of forbidden) {
      assert.doesNotMatch(source, new RegExp(secretName), `${file} should not mention ${secretName}`);
    }
  }
});

test('live test reset clears public Hermes state while preserving private runner binding', () => {
  const migration = read('supabase/migrations/0018_live_test_user_product_reset.sql');
  const preserveStart = migration.indexOf('if p_preserve_runner then');
  const preserveEnd = migration.indexOf('else', preserveStart);
  assert.ok(preserveStart > -1, 'migration should have a preserve-runner branch');
  assert.ok(preserveEnd > preserveStart, 'migration should have a reset-runner branch after preserve branch');
  const preserveBranch = migration.slice(preserveStart, preserveEnd);

  assert.match(preserveBranch, /insert into public\.hermes_instances/);
  assert.match(preserveBranch, /status,\s*railway_project_id,\s*railway_service_id/s);
  assert.match(preserveBranch, /'not_requested'/);
  assert.match(preserveBranch, /on conflict \(user_id\) do update set/);
  assert.match(preserveBranch, /status = excluded\.status/);
  assert.doesNotMatch(preserveBranch, /on conflict \(user_id\) do nothing/);

  const resetScript = read('scripts/reset-live-test-user-state.mjs');
  assert.match(resetScript, /await upsertUserRow\(supabase, 'hermes_instances'/);
  assert.match(resetScript, /status:\s*'not_requested'/);
  assert.match(resetScript, /ready_at:\s*null/);
  assert.doesNotMatch(resetScript, /insertUserRowIfMissing\(supabase, 'hermes_instances'/);
});

test('production UI backend proof requires current-run windows by default', () => {
  const runner = read('scripts/run-production-mobile-ui-flows.sh');

  assert.match(runner, /PRODUCTION_UI_REQUIRE_CURRENT_RUN_PROOF="\$\{PRODUCTION_UI_REQUIRE_CURRENT_RUN_PROOF:-1\}"/);
  assert.match(runner, /--run-started-at/);
  assert.match(runner, /--run-ended-at/);
  assert.match(runner, /--timestamp-tolerance-seconds/);
  assert.doesNotMatch(runner, /\/home\/alex\/\.coworker-ai\/live-provider\.env/);
});

test('release APK guard prevents Supabase JS env and native auth-link drift', () => {
  const freshEmulator = read('scripts/sidekick-mobile-fresh-emulator.sh');

  assert.match(freshEmulator, /verifyAndroidManifestMatchesPublicSupabaseHost/);
  assert.match(freshEmulator, /EXPO_PUBLIC_SUPABASE_URL/);
  assert.match(freshEmulator, /AndroidManifest Supabase auth-link host does not match/);

  // The call order at the bottom of the script, not the function definitions.
  const calls = freshEmulator.slice(freshEmulator.lastIndexOf('\nloadPublicExpoEnv '));
  const at = (needle) => calls.indexOf(needle);
  assert.ok(
    at('verifyAndroidManifestMatchesPublicSupabaseHost') < at('writeGeneratedPublicEnvModule'),
    'the manifest host check must run before live values are written',
  );
  // Arming the restore after the write leaves live secrets in the working tree if
  // anything between the two steps fails. That is how a stale hand-written
  // placeholder got committed once already.
  assert.ok(
    at('trap restoreGeneratedPublicEnvModule EXIT') < at('writeGeneratedPublicEnvModule'),
    'the placeholder restore must be armed before live values are written',
  );
});

test('state preparation does not default destructive provider runs to a personal account', () => {
  const statePrep = read('scripts/prepare-production-ui-state.mjs');

  assert.doesNotMatch(statePrep, /\/home\/alex\/\.coworker-ai\/live-provider\.env/);
  assert.doesNotMatch(statePrep, /qa-account@gmail\.com/);
  assert.match(statePrep, /missing_test_email/);
});

test('android Allure report writes a plain-English human summary', () => {
  const allure = read('scripts/android-allure-report.mjs');

  assert.match(allure, /writePlainEnglishReport\(summary\)/);
  assert.match(allure, /plain-english-report\.md/);
  assert.match(allure, /What the user does/);
  assert.match(allure, /Backend proof/);
  assert.match(allure, /First failing or skipped reason/);
});
