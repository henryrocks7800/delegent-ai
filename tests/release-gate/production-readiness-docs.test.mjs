import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const file = (path) => new URL(path, root);
const read = (path) => readFileSync(file(path), 'utf8');

function assertExists(path) {
  assert.ok(existsSync(file(path)), `${path} should exist`);
}

test('production readiness plan is committed with four-proof release evidence docs', () => {
  // Post-launch (v1.3.x): the pre-launch DELEGENT_AI_PRODUCTION_TESTING_PLAN
  // and pre-launch DEFECTS ledger are archived under docs/archive/2026-05-28/.
  // The active readiness gates are:
  //   - tests/release-gate/ (this folder)
  //   - tests/forensic/ (live-data drift)
  //   - docs/TESTING.md (canonical test runbook)
  //   - docs/mission/evidence/TEMPLATE/ (evidence manifest contract)
  //   - .github/pull_request_template.md (PR-level proof checklist)
  assertExists('docs/mission/evidence/TEMPLATE/manifest.json');
  assertExists('docs/mission/evidence/TEMPLATE/result.md');
  assertExists('docs/mission/evidence/TEMPLATE/commands.log');
  assertExists('docs/TESTING.md');
  assertExists('tests/README.md');
  assertExists('tests/release-gate/README.md');
  assertExists('tests/forensic/README.md');

  const testing = read('docs/TESTING.md');
  assert.match(testing, /four-proof|four proof|user proof|integration proof|regression proof/i,
    'docs/TESTING.md must describe the proof framework');

  const runbook = read('docs/DEVELOPER_RUNBOOK.md');
  assert.match(runbook, /first broken boundary/i);
  assert.match(runbook, /manifest\.json/);

  const prTemplate = read('.github/pull_request_template.md');
  assert.match(prTemplate, /Four-proof rule/);
  assert.match(prTemplate, /Evidence path/);
});

test('Android evidence template matches the production acceptance manifest shape', () => {
  const manifest = JSON.parse(read('docs/mission/evidence/TEMPLATE/manifest.json'));
  assert.deepEqual(Object.keys(manifest), [
    'run_id',
    'git_sha',
    'branch',
    'apk_sha256',
    'package',
    'test_user_email',
    'environment',
    'started_at',
    'completed_at',
    'result',
    'failed_at_boundary',
  ]);
  assert.equal(manifest.package, 'com.sidekick.v2');
  assert.match(manifest.failed_at_boundary, /android_launch/);
});

test('integration provider access guide and safe env templates are committed', () => {
  assertExists('docs/INTEGRATION_SECRETS_AND_PROVIDER_ACCESS.md');
  assertExists('.env.integration.example');
  assertExists('docs/templates/live-provider.env.example');
  assertExists('docs/DOCS_INDEX.md');

  const readme = read('README.md');
  assert.match(readme, /docs\/DOCS_INDEX\.md/);

  const docsIndex = read('docs/DOCS_INDEX.md');
  assert.match(docsIndex, /Active docs/);
  assert.match(docsIndex, /INTEGRATION_SECRETS_AND_PROVIDER_ACCESS/);

  const guide = read('docs/INTEGRATION_SECRETS_AND_PROVIDER_ACCESS.md');
  assert.match(guide, /\$HOME\/\.coworker-ai\/live-provider\.env/);
  assert.match(guide, /android:test-production-ui/);
  assert.match(guide, /android:allure/);
  assert.match(guide, /inspect-live-flow\.mjs/);
  assert.match(guide, /Do not commit real keys/i);
});

test('committed integration examples are placeholders only and .gitignore blocks local secret files', () => {
  const integrationEnv = read('.env.integration.example');
  const liveProviderEnv = read('docs/templates/live-provider.env.example');
  const gitignore = read('.gitignore');

  for (const source of [integrationEnv, liveProviderEnv]) {
    const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const [, rawValue] = line.split(/=(.*)/, 2);
      const value = rawValue.trim();
      assert.match(
        value,
        /^(?:REPLACE_WITH_[A-Z0-9_]+|https:\/\/REPLACE_WITH_[A-Z0-9_]+)$/,
        `example env value must be a placeholder, got ${line}`,
      );
    }
    assert.doesNotMatch(source, /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+\b/);
    assert.doesNotMatch(source, /\bSUPABASE_SERVICE_ROLE_KEY=eyJ[A-Za-z0-9._-]+\b/);
  }

  for (const pattern of [
    '!.env.integration.example',
    '.env.integration.local',
    '.env.live',
    '.coworker-ai/*.env',
    '**/.coworker-ai/*.env',
  ]) {
    assert.match(gitignore, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
