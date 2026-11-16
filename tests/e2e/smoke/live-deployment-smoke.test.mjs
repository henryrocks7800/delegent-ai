// Live deployment smoke tests.
//
// These hit the actual deployed worker + Supabase project to confirm
// recent changes survived deploy. They are SKIPPED by default (since
// CI may not have provider credentials) and only run when
// LIVE_SMOKE=1 is in the environment.
//
// Locally:  LIVE_SMOKE=1 npm test
// CI:       leave LIVE_SMOKE unset → these skip cleanly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LIVE = process.env.LIVE_SMOKE === '1';
const skip = !LIVE;
const reason = 'set LIVE_SMOKE=1 to run live deployment smoke tests';

// Tolerant loaders: prefer the operator's local mirror, fall back to env vars
// (so this can run from GitHub secrets), and degrade to null instead of throwing.
// The Supabase-management checks then SKIP — rather than error — when no
// project-admin PAT is present. The scheduled CI run is deliberately
// credential-light: the worker checks below are the deploy-survival signal and
// need no secrets, so we don't ship a project-admin token into CI for them.
function loadEnv() {
  const out = {};
  try {
    const path = join(homedir(), '.coworker-ai/live-provider.env');
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* no local mirror — fall through to env */ }
  if (!out.SUPABASE_URL && process.env.SUPABASE_URL) out.SUPABASE_URL = process.env.SUPABASE_URL;
  return out;
}

function loadPat() {
  try {
    return readFileSync(join(homedir(), '.supabase/access-token'), 'utf8').trim();
  } catch {
    return process.env.SUPABASE_ACCESS_TOKEN?.trim() || null;
  }
}

// Resolved once so the Supabase-management tests can skip cleanly when no PAT is
// present (the credential-light CI run), while the worker tests still run.
const PAT = LIVE ? loadPat() : null;
const skipNoPat = skip ? reason : (PAT ? false : 'no Supabase management PAT (credential-light run)');

// ---------------------------------------------------------------------------
// Worker health + transcribe-route auth gate
// ---------------------------------------------------------------------------

test('[live] production Worker /health returns ok', { skip: skip && reason }, async () => {
  const response = await fetch('https://sidekick-worker-production.alex-coworker-ai.workers.dev/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.engine, 'sidekick-worker');
});

test('[live][v1.2.8 DN6] /api/audio/transcribe is deployed and rejects unauthenticated calls', { skip: skip && reason }, async () => {
  // The v1.2.8 DN6 microphone work added this route. A 401 (not 404)
  // proves the route is actually wired up — a future regression that
  // dropped the route registration would 404 here.
  const response = await fetch(
    'https://sidekick-worker-production.alex-coworker-ai.workers.dev/api/audio/transcribe',
    { method: 'POST' },
  );
  assert.equal(response.status, 401, '/api/audio/transcribe must be registered AND auth-gated');
  const body = await response.json();
  assert.equal(body.error, 'unauthenticated');
});

// ---------------------------------------------------------------------------
// Supabase email template freshness
// ---------------------------------------------------------------------------

test('[live][v1.2.7 D1 + v1.2.8 DN10] live magic-link email template has the branded content (no broken button, no recipient leak)', { skip: skipNoPat }, async () => {
  const env = loadEnv();
  const pat = PAT;
  const projectRef = new URL(env.SUPABASE_URL).hostname.split('.')[0];

  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
    { headers: { Authorization: `Bearer ${pat}` } },
  );
  assert.equal(response.status, 200);
  const config = await response.json();

  const subject = config.mailer_subjects_magic_link;
  const template = config.mailer_templates_magic_link_content;

  assert.ok(subject, 'magic_link subject must be set');
  assert.match(subject, /Delegent AI/, 'subject must be branded');

  assert.ok(template, 'magic_link template must be set');
  assert.match(template, /Delegent/, 'body must include the brand');
  assert.match(template, /\{\{ \.Token \}\}/, 'body must render the OTP token');

  // DN10 — the broken "Open Delegent AI" button must NOT come back.
  // Gmail's WebView can't launch sidekick:// from a sandboxed
  // in-app browser, so users would dead-end at about:blank.
  assert.doesNotMatch(template, />Open Delegent AI</);
  assert.doesNotMatch(template, /\{\{ \.ConfirmationURL \}\}/, 'the dead-end magic link button must not come back');

  // DN10 — the recipient's email must not appear in the body copy.
  assert.doesNotMatch(template, /to \{\{ \.Email \}\}/);
});

test('[live] Supabase auth project still allowlists the sidekick:// callback', { skip: skipNoPat }, async () => {
  // The admin generate_link only honors `redirect_to` if it's in the
  // project's URL allowlist. If this drops out, every magic link
  // silently falls back to site_url and the deep-link sign-in stops
  // working — which is exactly what bit the prior session.
  const env = loadEnv();
  const pat = PAT;
  const projectRef = new URL(env.SUPABASE_URL).hostname.split('.')[0];
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/config/auth`,
    { headers: { Authorization: `Bearer ${pat}` } },
  );
  const config = await response.json();
  const allowList = String(config.uri_allow_list || '');
  assert.match(allowList, /sidekick:\/\/auth\/callback/, 'auth allowlist must include sidekick://auth/callback');
});

// ---------------------------------------------------------------------------
// Per-user runner readiness (catches the v1.2.7 regression Alex hit)
// ---------------------------------------------------------------------------

test('[live] No Fly Hermes runner is left marked ready (fleet retired 2026-09-18)', { skip: skipNoPat }, async () => {
  // This used to assert >=1 ready runner (the v1.2.7 regression, when every
  // paying user sat at not_requested and chat hit the fallback). Since
  // 2026-09-18 every account runs on the agent engine, the runners were
  // destroyed and the Fly account closed (Alex's call), so a row still
  // claiming a ready fly_machines runner is now the regression: it means the
  // decommission bookkeeping was skipped and the Worker could route a chat
  // at a machine that no longer exists.
  const env = loadEnv();
  const pat = PAT;
  const projectRef = new URL(env.SUPABASE_URL).hostname.split('.')[0];

  const sql = "select count(*) as ready_count from public.hermes_instances where status = 'ready' and provider = 'fly_machines'";
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    },
  );
  // Management API returns 201 for /database/query (Created) — not 200.
  assert.ok(response.ok, `Management API query failed: ${response.status}`);
  const rows = await response.json();
  const readyCount = Number(rows?.[0]?.ready_count ?? 0);
  assert.equal(
    readyCount,
    0,
    `Expected no fly_machines runner with status='ready' after the 2026-09-18 retirement; found ${readyCount}. Run scripts/decommission-runner.mjs for the row(s) still claiming a runner.`,
  );
});
