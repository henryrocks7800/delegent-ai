import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

// fileURLToPath, not .pathname: on Windows .pathname yields "/C:/repo/..." and
// join() then produces "C:\C:\repo\...", which ENOENTs the whole file.
const root = fileURLToPath(new URL('../../../../../../..', import.meta.url));
const appSource = readFileSync(join(root, 'apps/mobile/App.tsx'), 'utf8');
const packageSource = readFileSync(join(root, 'apps/mobile/package.json'), 'utf8');
const profileSource = readFileSync(join(root, 'apps/mobile/src/profile/mobileProfile.ts'), 'utf8');
const migrationSource = readFileSync(join(root, 'supabase/migrations/0013_editable_mobile_profile.sql'), 'utf8');

test('mobile profile edits use a narrow authenticated RPC with client-side validation', () => {
  assert.match(profileSource, /export function normalizeProfileUpdate/);
  assert.match(profileSource, /displayName/);
  assert.match(profileSource, /agentName/);
  assert.match(profileSource, /region/);
  assert.match(profileSource, /normalizeAgentName/);
  assert.match(profileSource, /mobileSupabase\.rpc\('update_mobile_profile'/);
  assert.match(profileSource, /getFreshMobileSupabaseSession\(mobileSupabase\)/);
  assert.doesNotMatch(profileSource, /from\('profiles'\)\.update/);
});

test('profile screen exposes editable supported profile fields while sign-in stays read-only', () => {
  assert.match(appSource, /import \{ updateMobileProfile/);
  assert.match(appSource, /function ProfileScreen\(\{[\s\S]*onProfileSave/);
  assert.match(appSource, /Edit profile/);
  assert.match(appSource, /Display name/);
  assert.match(appSource, /Personal Agent name/);
  assert.match(appSource, /Region/);
  assert.match(appSource, /Save profile/);
  assert.match(appSource, /onProfileSave\(\{ displayName, agentName, region \}\)/);
  assert.match(appSource, /ProfileInfoRow label="Sign-in" value=\{profile\.email\}/);
  const profileScreen = appSource.match(/function ProfileScreen[\s\S]*?function TabButton/);
  assert.ok(profileScreen, 'ProfileScreen source should be available');
  const signOutIndex = profileScreen[0].indexOf('>Sign out</Button>');
  const detailsIndex = profileScreen[0].indexOf('Account details');
  assert.ok(signOutIndex >= 0, 'Sign out should be visible on the profile screen');
  assert.ok(signOutIndex < detailsIndex, 'Sign out should sit in the top profile card before account details');
  assert.match(profileScreen[0], /profileHeroActions/);
  // 2026-05-16 defect J10: the verbose "Want to use a different email"
  // paragraph was removed for being noise. Sign-out is one tap up in the
  // top profile card; users who want a different account will find it.
  // The Entry index=4 surface is intentionally absent now.
  assert.doesNotMatch(profileScreen[0], /Want to use a different email or Google account\? Sign out/);
});

test('a profile field that is not ready says so instead of greying out Save', () => {
  // Save was disabled on a validity test with nothing on screen to explain it,
  // and the line that could have explained it sat inside saveProfile behind
  // that same test, so it could only be reached through the button the test
  // had already disabled. Clear your name to retype it and the control simply
  // died. The browser has no such test: Save always presses.
  const start = appSource.indexOf('function ProfileScreen({');
  const profileScreen = appSource.slice(start, appSource.indexOf('\nfunction TabButton(', start));

  assert.doesNotMatch(profileScreen, /const canSave =/, 'the silent validity flag is back');
  assert.match(profileScreen, /const saveBlockedReason = displayName\.trim\(\)\.length < 2/);
  assert.match(profileScreen, /!normalizeAgentName\(agentName\)/);
  assert.match(profileScreen, /region\.trim\(\)\.length < 2/);

  // The reason has to reach the reader, and each branch has to name its field
  // rather than telling them to go and check all three.
  assert.match(profileScreen, /if \(saveBlockedReason\) \{\s*\n\s*setSaveState\(\{ status: 'error', message: saveBlockedReason \}\);/);
  for (const field of [/Your name needs/, /Your coworker needs a name/, /Your region needs/]) {
    assert.match(profileScreen, field);
  }

  // And the button has to stay pressable, or none of the above can fire.
  assert.match(
    profileScreen,
    /testID="profile\.saveButton"[^\n]*disabled=\{saving\}[^\n]*onPress=\{saveProfile\}/,
  );

  // The message renders beside the button that produced it. Anywhere above the
  // fields and the reader has to scroll back past three inputs to find out why
  // the press did nothing, which is the same dead end in a longer form.
  assert.equal(
    (profileScreen.match(/\{saveState\.status === 'error' \?/g) || []).length,
    1,
    'exactly one place should draw the save failure',
  );
  const errorIdx = profileScreen.indexOf("{saveState.status === 'error' ?");
  const lastFieldIdx = profileScreen.indexOf('testID="profile.regionInput"');
  const buttonIdx = profileScreen.indexOf('testID="profile.saveButton"');
  assert.ok(lastFieldIdx > -1, 'the region input should be available');
  assert.ok(
    errorIdx > lastFieldIdx && buttonIdx > errorIdx,
    'the reason must sit between the last field and Save, not somewhere above the form',
  );
});

test('database profile update contract is RLS-safe and validates ownership server-side', () => {
  assert.match(migrationSource, /create or replace function public\.update_mobile_profile/);
  assert.match(migrationSource, /v_user_id uuid := auth\.uid\(\)/);
  assert.match(migrationSource, /update public\.profiles/);
  assert.match(migrationSource, /where id = v_user_id/);
  assert.match(migrationSource, /raise exception 'invalid agent name'/);
  assert.match(migrationSource, /revoke execute on function public\.update_mobile_profile/);
  assert.match(migrationSource, /grant execute on function public\.update_mobile_profile\(text, text, text\) to authenticated/);
});

test('mobile test suite includes profile edit regression coverage', () => {
  assert.match(packageSource, /profile-edit-readiness\.test\.mjs/);
});
