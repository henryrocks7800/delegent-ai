import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The web app cannot import the phone's profile rules: those modules pull in the
// React Native Supabase client. They are duplicated in
// src/features/profile/profileApi.ts instead, so these tests pin the copy to the
// original. A rule change on the phone that is not mirrored here fails the build
// rather than quietly letting the two surfaces validate differently.

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(here, relative), 'utf8');

const MOBILE_PROFILE = read('../../mobile/src/profile/mobileProfile.ts');
const MOBILE_ONBOARDING = read('../../mobile/src/onboarding/mobileOnboarding.ts');
const WEB_PROFILE = read('../src/features/profile/profileApi.ts');

/** The body of a named function, with whitespace flattened so formatting is not a diff. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i).replace(/\s+/g, ' ').trim();
    }
  }
  throw new Error(`${name} is unbalanced`);
}

function numericConstant(source, name) {
  const match = source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  assert.ok(match, `${name} not found`);
  return Number(match[1]);
}

test('normalizeTextField is character-for-character the phone rule', () => {
  assert.equal(functionBody(WEB_PROFILE, 'normalizeTextField'), functionBody(MOBILE_PROFILE, 'normalizeTextField'));
});

test('normalizeAgentName is character-for-character the phone rule', () => {
  assert.equal(functionBody(WEB_PROFILE, 'normalizeAgentName'), functionBody(MOBILE_ONBOARDING, 'normalizeAgentName'));
});

test('the length limits match the phone', () => {
  assert.equal(numericConstant(WEB_PROFILE, 'MAX_NAME_LENGTH'), numericConstant(MOBILE_PROFILE, 'MAX_DISPLAY_NAME_LENGTH'));
  assert.equal(numericConstant(WEB_PROFILE, 'MAX_NAME_LENGTH'), numericConstant(MOBILE_PROFILE, 'MAX_REGION_LENGTH'));
  assert.equal(
    numericConstant(WEB_PROFILE, 'MAX_AGENT_NAME_LENGTH'),
    numericConstant(MOBILE_ONBOARDING, 'MAX_AGENT_NAME_LENGTH'),
  );
});

test('the region falls back to the same default as the phone', () => {
  assert.match(MOBILE_PROFILE, /'United Kingdom'/);
  assert.match(WEB_PROFILE, /DEFAULT_REGION = 'United Kingdom'/);
});

test('both surfaces call the same RPC with the same parameter names', () => {
  for (const source of [MOBILE_PROFILE, WEB_PROFILE]) {
    assert.match(source, /rpc\('update_mobile_profile'/);
    assert.match(source, /p_full_name:/);
    assert.match(source, /p_agent_name:/);
    assert.match(source, /p_region:/);
  }
});

test('the save outcome never outlives the edit it describes', () => {
  // The phone can only show "Profile saved." over read-only rows: a save leaves
  // edit mode, and re-entering it resets the outcome to idle. The web page is
  // always editable, so it has to reset per keystroke instead. Without that the
  // confirmation sat above a field the reader had since changed, which told them
  // an unsaved edit was already safe, and leaving the page lost it.
  const web = read('../src/features/profile/ProfileScreen.tsx');
  const phone = read('../../mobile/App.tsx');

  assert.match(phone, /setEditing\(false\);\s*\n\s*setSaveState\(\{ status: 'saved'/, 'the phone no longer leaves edit mode on save');
  assert.match(phone, /setEditing\(\(current\) => !current\);\s*\n\s*setSaveState\(\{ status: 'idle' \}\);/, 'the phone no longer resets the outcome when edit is toggled');

  assert.match(
    web,
    /function edit\(set: \(value: string\) => void\) \{\s*\n\s*return \(event: React\.ChangeEvent<HTMLInputElement>\) => \{\s*\n\s*setSaved\(false\);\s*\n\s*setError\(null\);/,
    'editing a web profile field no longer clears the previous save outcome',
  );
  // Every field, not just the one that happened to be tested.
  for (const setter of ['setDisplayName', 'setAgentName', 'setRegion']) {
    assert.match(web, new RegExp(`onChange=\\{edit\\(${setter}\\)\\}`), `the ${setter} field bypasses the reset`);
  }
});

test('onboarding writes the acknowledgement version from shared, not a literal', () => {
  const web = read('../src/features/onboarding/OnboardingScreen.tsx');
  assert.match(web, /ACKNOWLEDGEMENT_VERSION/);
  assert.match(web, /complete_mobile_onboarding/);
  assert.match(web, /p_acknowledgement_text_version/);
  // A hard-coded 'v2' would silently stop matching when the text changes.
  assert.equal(/p_acknowledgement_text_version:\s*'/.test(web), false);
});
