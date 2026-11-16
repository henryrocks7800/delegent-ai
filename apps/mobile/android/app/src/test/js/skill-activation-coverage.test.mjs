import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// 2026-07-24 (Alex): "solid as a rock" coverage for every clickable skill in the
// menu. Live incident 2026-07-22: the curated skills drifted off a runner and
// the agent answered "skill not found" for connect-telegram / write-me-a-report.
// The durable per-message self-heal (services/hermes-runner) fixes the runtime
// drift; THIS test locks the *other* failure mode: a menu phrase that promises a
// skill the library does not actually ship (a rename, a removal, or a new chip
// added with no backing skill). It also enforces the "bare minimum" contract
// Alex asked for: any skill that connects an external service must document the
// get-access -> hand-to-agent -> stored-safely handoff.
//
// It is a STATIC contract test (no live agent calls): fast, deterministic, CI-
// safe. Live invocation coverage (does the phrase actually route at runtime)
// lives in the gated persona-runner Maestro suite, not here.

// The catalogue now lives in @sidekick/shared so the web app renders the same
// menu; the phone reads it from there. Scrape the shared source, not App.tsx.
const catalogueSource = readFileSync(
  new URL('../../../../../../../packages/shared/src/content/skills.ts', import.meta.url),
  'utf8',
);
const manifestUrl = new URL('../../../../../../../services/hermes-runner/skills/delegent/MANIFEST.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

function skillMdUrl(slug) {
  return new URL(`../../../../../../../services/hermes-runner/skills/delegent/skills/${slug}/SKILL.md`, import.meta.url);
}

// Every phrase a user can TAP in the menu (Skills & use cases): the per-skill
// `say:` triggers and the per-category `tryPhrase:` headline. Extracted from the
// source so a newly added chip is picked up automatically and forced through the
// routing table below (an unrouted chip fails the test).
const clickablePhrases = [
  ...catalogueSource.matchAll(/(?:say|tryPhrase): '([^']+)'/g),
].map((m) => m[1]);

// Intended routing: clickable phrase -> the curated skill that must handle it.
// The target slug MUST exist in the shipped library (that is the drift guard).
//
// 2026-08-03: moved to a shared fixture so the routing contract test
// (services/hermes-runner/skills/delegent_routing_contract.test.mjs) enforces
// the SAME table from the other end: this test proves each target exists, that
// one proves each target actually WINS the activation-phrase router. When the
// two tables were separate in spirit, ten chips existed but routed wrong.
const routesFixture = JSON.parse(
  readFileSync(
    new URL('../../../../../../../tests/fixtures/menu-skill-routes.json', import.meta.url),
    'utf8',
  ),
);
const SKILL_ROUTES = routesFixture.routes;

// Clickable phrases deliberately handled by the base agent or an MCP connector
// rather than a curated SKILL.md. Kept as an explicit, FIXED allowlist so a new
// unrouted chip cannot silently fall in here: it forces a decision (add a skill,
// route to an existing one, or knowingly add it below).
//
// 2026-07-24 (Alex's call): the four other menu gaps were UNADVERTISED rather
// than backed by a skill. The whole "Technical & developer" category (which
// carried "help with a technical task" + "review my code") was removed from the
// menu, and "post to X" / "make a slide deck" chips were dropped. The underlying
// capabilities still exist on the workspace, they are just no longer promised in
// the menu.
//
// 2026-07-25 (Alex's call): the last two entries, "connect Google Workspace" and
// "manage my calendar", are gone too. They leaned on a connector nobody had
// vetted, so a user who tapped them got a walkthrough rather than a working
// connection. The menu now advertises only what a curated SKILL.md backs. Google
// comes back when the real OAuth connection ships. The set is deliberately left
// empty so the next unrouted chip fails this test instead of quietly landing here.
const GENERAL_CAPABILITY = new Set([]);

// Skills that connect an EXTERNAL service and therefore must document the
// credential handoff (get access -> give it to the agent -> stored safely).
const CREDENTIAL_SKILLS = [
  'agent-email-inbox',
  'phone-concierge-twilio',
  'crm-sales-pipeline',
  'database-setup',
  'social-content-marketing',
  'core-permissions-and-credentials',
];

const manifestSlugs = new Set(manifest.skills.map((s) => s.slug));

test('the menu catalogue is real, and every category still names something', () => {
  // Until 2026-09-03 this test walked every TAPPABLE phrase in the menu and
  // forced it through a routing table, because a chip that fired an unrouted
  // phrase was a dead end. Alex removed the chips that day: the Skills drawer
  // now describes what the coworker can do, and a connection is reached by
  // asking for it by name, so there is no phrase left to route.
  //
  // What still has to hold is that the catalogue is not empty and every
  // category names some capability, which is the drift guard that the
  // extraction below is reading a real file rather than silently nothing.
  const names = [...catalogueSource.matchAll(/\bname: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 15, `expected the full menu catalogue, saw ${names.length}`);
  const categories = [...catalogueSource.matchAll(/\btitle: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(categories.length >= 7, `expected every first-layer category, saw ${categories.length}`);
  for (const c of ['Money & bookkeeping', 'Email & messages', 'Sales & marketing', 'Documents & office', 'Operations & admin', 'Web, files & storage', 'Phone']) {
    assert.ok(categories.includes(c), `the first layer lost "${c}"; Alex asked for it to stay`);
  }
});

test('every routed skill actually ships in the curated library (drift / rename guard)', () => {
  for (const [phrase, slug] of Object.entries(SKILL_ROUTES)) {
    assert.ok(manifestSlugs.has(slug), `"${phrase}" routes to "${slug}" which is missing from MANIFEST.json`);
    assert.ok(existsSync(skillMdUrl(slug)), `"${slug}" has no SKILL.md on disk (routed from "${phrase}")`);
  }
});

test('the two skills that broke live (connect-telegram, report-writer) are present with their trigger phrases', () => {
  for (const slug of ['connect-telegram', 'report-writer']) {
    assert.ok(manifestSlugs.has(slug), `${slug} missing from MANIFEST.json`);
    assert.ok(existsSync(skillMdUrl(slug)), `${slug} has no SKILL.md`);
  }
  const telegram = manifest.skills.find((s) => s.slug === 'connect-telegram');
  assert.ok(telegram.activation_phrases.includes('connect telegram'), 'connect-telegram must trigger on "connect telegram"');
  const report = manifest.skills.find((s) => s.slug === 'report-writer');
  assert.ok(report.activation_phrases.some((p) => /report/i.test(p)), 'report-writer must trigger on a report phrase');
});

test('every external-service skill documents the credential handoff (get access + stored safely)', () => {
  const getAccess = /api key|access token|oauth|client id|client secret|consent screen|authori[sz]e|connect (your|the)|sign in|create a key|generate a key/i;
  const safeStore = /credential|encrypt|stored safely|store it safely|securely|never share/i;
  for (const slug of CREDENTIAL_SKILLS) {
    const url = skillMdUrl(slug);
    assert.ok(existsSync(url), `credential skill ${slug} has no SKILL.md`);
    const md = readFileSync(url, 'utf8');
    assert.match(md, getAccess, `${slug} must guide the user to obtain access (api key / connect / authorise)`);
    assert.match(md, safeStore, `${slug} must state the credential is handled safely`);
  }
});

// ---------------------------------------------------------------------------
// Behaviour classes (2026-08-03, Alex): every menu-routed skill must promise a
// KNOWN first response. Two classes, and a skill is in exactly one:
//
//   credential-first — the skill's value needs external access, so the bare
//     minimum bar is "teach the user to get the key, take it over, state it is
//     stored safely". These are CREDENTIAL_SKILLS above plus the ones the
//     original list missed.
//
//   build-now — the skill must start producing WITHOUT demanding a credential.
//     The failure this guards: a chip like "write me a report" walking the user
//     through a Google Cloud Console detour before doing anything. (These may
//     still MENTION optional integrations; what they must not do is teach
//     key-creation as a precondition.)
//
// The completeness check below means a NEW chip's skill cannot dodge
// classification: adding a route forces a decision about its first response.
// ---------------------------------------------------------------------------
const CREDENTIAL_FIRST = new Set([
  ...CREDENTIAL_SKILLS,
  // Missed by the original list, added 2026-08-03:
  'website-builder', // Firebase project + CI token before a site can deploy
  'autonomous-bookkeeper', // accounting provider (e.g. FreeAgent OAuth) before entries
  'operations-manager', // needs its calendar/email/tasks blocks connected
]);

const BUILD_NOW = new Set([
  'report-writer',
  'proposal-writer',
  'pdf-document-creation',
  'spreadsheet-excel',
  'voice-note-triage',
  'file-workspace-manager',
  'browser-automation',
  'lead-research',
  'customer-support-desk',
  'property-income-mtd',
  'cashflow-dashboard',
  'workflow-automation',
  'procurement-supplier-manager',
  'security-audit',
  'invoice-chasing',
]);

test('every menu-routed skill is classified credential-first or build-now, never both', () => {
  const routedSlugs = new Set(Object.values(SKILL_ROUTES));
  for (const slug of routedSlugs) {
    const inCred = CREDENTIAL_FIRST.has(slug);
    const inBuild = BUILD_NOW.has(slug);
    assert.ok(
      inCred || inBuild,
      `${slug} is reachable from the menu but has no behaviour class; add it to CREDENTIAL_FIRST or BUILD_NOW (this is a decision about its FIRST response, make it deliberately)`,
    );
    assert.ok(!(inCred && inBuild), `${slug} is in both behaviour classes; pick one`);
  }
  // No orphans pointing at nothing: a class entry for a skill the menu cannot
  // reach is stale and should be pruned (core-permissions-and-credentials is
  // the deliberate exception; it backs the others rather than a chip).
  for (const slug of [...BUILD_NOW]) {
    assert.ok(routedSlugs.has(slug), `${slug} is classified build-now but no menu chip routes to it`);
  }
});

test('build-now skills do not teach credential creation as a precondition', () => {
  // The specific behaviour that burned trust: a chip tap answered with "go to
  // a developer console and create an OAuth client / API key" before any work.
  // Mentioning an optional integration is fine; a key-creation walkthrough in a
  // build-now skill is not.
  const keyCreationWalkthrough =
    /create (an? )?(api key|oauth (client|app|2\.0 client))|developer console|cloud console.*credentials|client secret/i;
  for (const slug of BUILD_NOW) {
    const url = skillMdUrl(slug);
    assert.ok(existsSync(url), `build-now skill ${slug} has no SKILL.md`);
    const md = readFileSync(url, 'utf8');
    assert.ok(
      !keyCreationWalkthrough.test(md),
      `${slug} is classified build-now but its SKILL.md teaches credential creation (${keyCreationWalkthrough.exec(md)?.[0] ?? ''}); either reclassify it as credential-first or move the setup behind the first deliverable`,
    );
  }
});

test('the seeded library still ships its full curated set', () => {
  assert.ok(manifest.skills.length >= 30, `expected >=30 curated skills, manifest declares ${manifest.skills.length}`);
});

test('mobile test suite includes skill-activation coverage', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /skill-activation-coverage\.test\.mjs/);
});
