import { strict as assert } from 'node:assert';
import test from 'node:test';

import { parseEnvFile, renderPublicEnv } from '../scripts/write-public-env.mjs';

// The build inlines these values into a public JS bundle. A server secret
// reaching this file would be published to every visitor, so the guard that
// stops it is worth a test of its own.

test('only the five public values are emitted', () => {
  const rendered = renderPublicEnv({
    EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    EXPO_PUBLIC_SIDEKICK_API_BASE_URL: 'https://api.delegantai.co.uk',
    EXPO_PUBLIC_SENTRY_DSN: 'https://ingest.example',
    EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: '000-abc.apps.googleusercontent.com',
    SUPABASE_SERVICE_ROLE_KEY: 'must-never-appear',
    STRIPE_SECRET_KEY: 'must-never-appear',
    FLY_API_TOKEN: 'must-never-appear',
  });

  const names = rendered
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.slice(0, line.indexOf('=')));

  assert.deepEqual(names, [
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_ANON_KEY',
    'VITE_API_BASE_URL',
    'VITE_SENTRY_DSN',
    'VITE_GOOGLE_WEB_CLIENT_ID',
  ]);
  assert.equal(rendered.includes('must-never-appear'), false);
});

test('a missing value renders empty rather than the literal undefined', () => {
  const rendered = renderPublicEnv({});
  assert.match(rendered, /^VITE_SUPABASE_URL=$/m);
  assert.equal(rendered.includes('undefined'), false);
  assert.equal(rendered.includes('null'), false);
});

test('the generated file warns against committing it', () => {
  assert.match(renderPublicEnv({}), /Do not commit/);
});

test('quoted and commented env lines are parsed the way a shell would read them', () => {
  const parsed = parseEnvFile(
    ['# a comment', '', 'PLAIN=value', 'QUOTED="quoted value"', "SINGLE='single value'", 'NOEQUALS'].join('\n'),
  );
  assert.deepEqual(parsed, {
    PLAIN: 'value',
    QUOTED: 'quoted value',
    SINGLE: 'single value',
  });
});
