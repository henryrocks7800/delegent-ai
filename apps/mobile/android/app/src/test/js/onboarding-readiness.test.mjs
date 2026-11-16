import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const productStateSource = readFileSync(new URL('../../../../../src/state/productState.ts', import.meta.url), 'utf8');
const sharedSource = readFileSync(new URL('../../../../../../../packages/shared/src/index.ts', import.meta.url), 'utf8');
const onboardingPath = new URL('../../../../../src/onboarding/mobileOnboarding.ts', import.meta.url);
const onboardingSource = existsSync(onboardingPath) ? readFileSync(onboardingPath, 'utf8') : '';
const migrationPath = new URL('../../../../../../../supabase/migrations/0010_mobile_onboarding.sql', import.meta.url);
const migrationSource = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';
const latestProductStateMigrationPath = new URL('../../../../../../../supabase/migrations/0029_acknowledgement_v2_contract.sql', import.meta.url);
const latestProductStateMigrationSource = existsSync(latestProductStateMigrationPath) ? readFileSync(latestProductStateMigrationPath, 'utf8') : '';
const migrationsDir = new URL('../../../../../../../supabase/migrations/', import.meta.url);
const allMigrationSource = existsSync(migrationsDir)
  ? readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      // fileURLToPath, not .pathname: on Windows .pathname yields "/C:/repo/..."
      // and join() then produces "C:\C:\repo\...", which ENOENTs.
      .map((name) => readFileSync(join(fileURLToPath(migrationsDir), name), 'utf8'))
      .join('\n')
  : '';
const acknowledgementVersionMatch = sharedSource.match(/export const ACKNOWLEDGEMENT_VERSION = '([^']+)'/);
const currentAcknowledgementVersion = acknowledgementVersionMatch?.[1] ?? '';

test('product state exposes a safe persisted coworker name', () => {
  assert.match(sharedSource, /agentName\?: string/);
  assert.match(sharedSource, /agent_name: string \| null/);
  assert.match(sharedSource, /agentName: row\.agent_name \?\? undefined/);
  assert.match(productStateSource, /agentName: text\(user\.fullName\) \?\? undefined/);
  assert.match(productStateSource, /agentName: 'Nova'/);
  assert.doesNotMatch(productStateSource, /agentName: 'Ruben'/);
  assert.match(migrationSource, /alter table public\.profiles add column if not exists agent_name text/);
  assert.match(migrationSource, /p\.agent_name/);
  assert.doesNotMatch(migrationSource, /runner_base_url|railway_project_id|stripe_customer_id|stripe_subscription_id|source_conversation_id|code_hash|runner_shared_secret/i);
});

test('mobile onboarding persists through a narrow Supabase RPC, not direct table writes', () => {
  assert.match(onboardingSource, /normalizeAgentName/);
  assert.match(onboardingSource, /completeMobileOnboarding/);
  assert.match(onboardingSource, /ACKNOWLEDGEMENT_VERSION/);
  assert.match(onboardingSource, /getFreshMobileSupabaseSession\(/);
  assert.match(onboardingSource, /getRememberedMobileAccessToken\(\)/);
  assert.match(onboardingSource, /\.rpc\('complete_mobile_onboarding'/);
  assert.match(onboardingSource, /\/rest\/v1\/rpc\/complete_mobile_onboarding/);
  assert.match(onboardingSource, /authorization:\s*`Bearer \$\{accessToken\}`/);
  assert.match(onboardingSource, /p_agent_name: agentName/);
  assert.match(onboardingSource, /p_acknowledgement_text_version: ACKNOWLEDGEMENT_VERSION/);
  assert.doesNotMatch(onboardingSource, /\.from\('profiles'\)[\s\S]{0,200}\.update\(/);
  assert.doesNotMatch(onboardingSource, /\.from\('acknowledgements'\)[\s\S]{0,200}\.insert\(/);
});

test('database onboarding API is RLS-safe and captures acknowledgement atomically', () => {
  assert.match(migrationSource, /create or replace function public\.complete_mobile_onboarding/);
  assert.match(migrationSource, /security definer/);
  assert.match(migrationSource, /auth\.uid\(\)/);
  assert.match(migrationSource, /update public\.profiles/);
  assert.match(migrationSource, /agent_name = v_agent_name/);
  assert.match(migrationSource, /insert into public\.acknowledgements/);
  assert.match(migrationSource, /on conflict \(user_id\) do update/);
  assert.match(migrationSource, /grant execute on function public\.complete_mobile_onboarding\(text, text\) to authenticated/);
  assert.match(migrationSource, /revoke execute on function public\.complete_mobile_onboarding\(text, text\) from public, anon/);
});

test('database acknowledgement contract follows the current responsibility text version (#36)', () => {
  assert.match(currentAcknowledgementVersion, /^v[2-9]\d*$/, 'The shared current acknowledgement version should have moved beyond v1');
  assert.match(
    allMigrationSource,
    new RegExp(`p_acknowledgement_text_version\\s*<>\\s*'${currentAcknowledgementVersion}'`),
    'complete_mobile_onboarding must accept the same current acknowledgement version that mobile sends',
  );
  assert.match(
    allMigrationSource,
    new RegExp(`ack\\.text_version\\s*=\\s*'${currentAcknowledgementVersion}'`),
    'public.my_product_state must mark only the current acknowledgement version as accepted',
  );
  assert.match(
    allMigrationSource,
    new RegExp(`ack\\.text_version\\s*<>\\s*'${currentAcknowledgementVersion}'`),
    'public.my_product_state must re-open the first-run gate for stale acknowledgement versions',
  );
  assert.match(
    allMigrationSource,
    new RegExp(`text_version\\s*=\\s*'${currentAcknowledgementVersion}'`),
    'direct acknowledgement insert policy must be narrowed to the current version',
  );
});

test('product-state subscription gate follows the same entitlement statuses as chat dispatch (#42)', () => {
  assert.match(
    sharedSource,
    /status === 'active' \|\| status === 'trialing' \|\| status === 'past_due'/,
    'shared mobile gate must keep trialing and past_due users inside chat/workspace',
  );
  assert.match(
    latestProductStateMigrationSource,
    /when\s+coalesce\(s\.status, 'inactive'\)\s+not\s+in\s+\('active', 'trialing', 'past_due'\)\s+then\s+'needs_subscription'/i,
    'public.my_product_state must not downgrade trialing or past_due users to needs_subscription',
  );
  assert.doesNotMatch(
    latestProductStateMigrationSource,
    /when\s+coalesce\(s\.status, 'inactive'\)\s+<>\s+'active'\s+then\s+'needs_subscription'/i,
    'the latest product-state view must not gate subscription on active-only status',
  );
});

test('authenticated first-run users see onboarding before the main shell is considered complete', () => {
  assert.match(appSource, /function OnboardingScreen/);
  assert.match(appSource, /Name your personal Agent/);
  assert.match(onboardingSource, /const DEFAULT_AGENT_NAME = 'Nova'/);
  assert.doesNotMatch(onboardingSource, /const DEFAULT_AGENT_NAME = 'Ruben'/);
  assert.match(appSource, /const \[agentName, setAgentName\] = useState\(''\)/);
  assert.match(appSource, /const effectiveAgentName = normalizedAgentName \?\? defaultAgentName\(\)/);
  assert.match(appSource, /completeMobileOnboarding\(effectiveAgentName\)/);
  assert.match(appSource, /placeholder="Nova"/);
  assert.doesNotMatch(appSource, /useState\(defaultAgentName\(\)\)/);
  assert.doesNotMatch(appSource, /You can start with Ruben/);
  // The name has been optional since 1822c2e8 and the screen never said so.
  // Two thirds of the people who picked a goal stopped here
  // (docs/ACTIVATION_2026-09-22.md), so the screen now says it out loud. Pinned
  // because the empty field above is pinned: if someone removes the hint, the
  // screen goes back to reading like a task nobody can skip.
  assert.match(appSource, /testID="onboarding\.agentNameHint"/);
  assert.match(appSource, /Optional\. Leave it blank and yours will be called/);
  assert.match(appSource, /I understand and accept Delegent AI Terms/);
  assert.match(appSource, /completeMobileOnboarding/);
  assert.match(appSource, /onboardingCompletedUserId/);
  assert.match(appSource, /handleOnboardingComplete/);
  assert.match(appSource, /productState\.gate\.kind === 'needs_acknowledgement'/);
  assert.match(appSource, /!onboardingCompleteForUser/);
  assert.match(appSource, /!productState\.snapshot\.profile\?\.agentName/);
  assert.match(appSource, /<OnboardingScreen/);
  assert.match(appSource, /onComplete=\{handleOnboardingComplete\}/);
  assert.match(appSource, /<Shell/);
  assert.ok(appSource.indexOf('<OnboardingScreen') < appSource.indexOf('<Shell'), 'Onboarding gate must render before Shell in the authenticated branch.');
});

test('successful onboarding advances into the setup guide instead of looping on the terms step', () => {
  assert.match(appSource, /setOnboardingCompletedUserId\(authState\.user\.id\)/);
  assert.match(appSource, /setSetupGuideLaunchKey\(\(key\) => key \+ 1\)/);
  assert.match(appSource, /setupGuideLaunchKey=\{setupGuideLaunchKey\}/);
  assert.match(appSource, /handledSetupGuideLaunchKey/);
  assert.match(appSource, /setSetupOpen\(true\)/);
  assert.match(appSource, /setDrawerOpen\(true\)/);
});

test('configured coworker name appears in user-facing product copy', () => {
  assert.match(appSource, /agentDisplayName/);
  assert.match(appSource, /productView\.agentName/);
  // The agent's name surfaces through the chat panel header, the setup wizard
  // plan picker, and the post-pay primary button copy. 2026-05-30 (USP: tiers =
  // compute + tokens) reworded the plan-picker intro; the name still
  // personalises it and the line now also carries the "every plan is the same
  // full coworker" message, so assert the current phrasing.
  assert.match(appSource, /GOAL_HEADLINES\[onboardingGoal\]/);
  // Until 2026-09-23 the post-pay button said "Meet ${agentName}"; a subscriber
  // opening Plan & billing now reads "Your plan", the name in the line under it,
  // and a "Go to chat" button whose spoken label still carries the name.
  assert.match(appSource, /\$\{productView\.agentName\} is ready when you are\./);
  assert.match(appSource, /Continue to chat with \$\{productView\.agentName\}/);
  assert.doesNotMatch(appSource, /Supabase|service-role|anon key|env var|Railway|Cloudflare/);
});
