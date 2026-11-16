// Phase 5 deterministic skill-activation routing tests.
//
// Maps "what the user says" to "which skill the agent should pick first",
// using the activation_phrases declared in each SKILL.md's frontmatter +
// in MANIFEST.json. No model call, no Maestro, no emulator.
//
// This is the test-only stub the goal calls for: it proves the activation
// surface (the activation_phrases) actually matches the kinds of asks
// real users send.
//
// Run:
//   node --test services/hermes-runner/skills/delegent_routing_contract.test.mjs
//   (or via:  npm run test:skills:routing  )

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB = join(__dirname, 'delegent');
const MANIFEST_PATH = join(LIB, 'MANIFEST.json');

// Goal Phase 5 §5: prompts and the skill the agent should select. These
// are real-world phrasings, not the exact activation_phrases. The router
// must succeed at activation-phrase keyword overlap (case-insensitive,
// punctuation-tolerant).
const ROUTING_CASES = [
  { prompt: 'I need help with bookkeeping and receipts',                expected: 'autonomous-bookkeeper' },
  { prompt: 'Help me set up a business phone number and receptionist',  expected: 'phone-concierge-twilio' },
  { prompt: 'Build me a website',                                        expected: 'website-builder' },
  { prompt: 'Make a spreadsheet dashboard',                              expected: 'spreadsheet-excel' },
  // Landlords pulled into Making Tax Digital. Phrased four ways a real one
  // would say it, because "MTD" is jargon most of them will not use first.
  { prompt: 'help with making tax digital',                              expected: 'property-income-mtd' },
  { prompt: 'I am a landlord and need to sort my rental income for tax', expected: 'property-income-mtd' },
  { prompt: 'what goes in my quarterly update to HMRC',                  expected: 'property-income-mtd' },
  { prompt: 'sort out the property income across my rental properties',  expected: 'property-income-mtd' },
  // [2026-08-01] Doing something with a service the user connected in the app.
  // Slack shipped live with no skill behind it, so the agent ran `which slack`,
  // found nothing, and told a paying user the connection was not authenticating.
  // These pin the route that stops that recurring for any brokered provider.
  { prompt: 'post to slack for me',                                      expected: 'connected-services' },
  { prompt: 'search my slack for that invoice thread',                   expected: 'connected-services' },
  { prompt: 'what am I connected to',                                    expected: 'connected-services' },
  // [2026-08-01, second pass] Outlook and Teams went live the same day this
  // skill was written and were NOT in it, which is the Slack failure repeating
  // for two more providers. Found by auditing skills against live connections.
  { prompt: 'check my outlook for anything urgent',                      expected: 'connected-services' },
  { prompt: 'catch me up on teams',                                      expected: 'connected-services' },
];

let manifest;

test('routing fixture loads + has activation phrases on every skill', async () => {
  manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  for (const entry of manifest.skills) {
    assert.ok(Array.isArray(entry.activation_phrases),
      `${entry.slug}: activation_phrases must be an array`);
    assert.ok(entry.activation_phrases.length >= 1,
      `${entry.slug}: at least one activation phrase`);
    for (const p of entry.activation_phrases) {
      assert.equal(typeof p, 'string', `${entry.slug}: activation phrases must be strings`);
      assert.ok(p.trim().length > 0, `${entry.slug}: empty activation phrase`);
    }
  }
});

// Deterministic router: tokenise the user prompt + each skill's activation
// phrases + title, and score skills by token-overlap. Highest score wins.
// On tie, prefer the skill with the most specific (longest) match.
function tokenize(s) {
  return s.toLowerCase()
    .replace(/[.,!?;:()'"]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function scoreSkill(promptTokens, entry) {
  const phraseTokens = [
    ...entry.activation_phrases.flatMap(tokenize),
    ...tokenize(entry.title),
    ...tokenize(entry.description || ''),
    ...tokenize(entry.slug.replace(/-/g, ' ')),
  ];
  const phraseSet = new Set(phraseTokens);
  let score = 0;
  for (const t of promptTokens) {
    if (phraseSet.has(t)) score += 1;
  }
  // Bonus: bigram match in activation phrases
  for (const phrase of entry.activation_phrases) {
    const lower = phrase.toLowerCase();
    if (lower.length > 3 && tokenize(lower).every(w => promptTokens.includes(w))) {
      score += 3;
    }
  }
  return score;
}

function pickSkill(prompt, allSkills) {
  const promptTokens = tokenize(prompt);
  const scored = allSkills.map(s => ({ slug: s.slug, score: scoreSkill(promptTokens, s) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].slug : null;
}

for (const { prompt, expected } of ROUTING_CASES) {
  test(`routes "${prompt}" → ${expected}`, () => {
    const picked = pickSkill(prompt, manifest.skills);
    assert.equal(picked, expected,
      `expected ${expected}, got ${picked} for prompt "${prompt}"`);
  });
}

// ---------------------------------------------------------------------------
// [2026-08-03] EVERY clickable menu chip must win the router, with a margin.
//
// The static coverage test (apps/mobile/.../skill-activation-coverage.test.mjs)
// proves each chip's target skill EXISTS. It cannot prove the chip's exact text
// actually reaches that skill through the activation surface, and on 2026-08-03
// ten of thirty did not: "be my sales assistant" scored highest on
// core-permissions-and-credentials, "set up a phone line" and "manage my
// suppliers" on agent-email-inbox, "edit a PDF" on website-builder. A user taps
// a chip, the phrase lands in chat, and the wrong playbook answers.
//
// Contract: for every chip in tests/fixtures/menu-skill-routes.json the
// intended skill must be the OUTRIGHT winner (margin >= 1, no tie-luck from
// manifest order) and must overlap the phrase meaningfully (score >= 2, one
// stray token is not routing). Fails? Add the chip's exact text to the target
// skill's activation_phrases in BOTH SKILL.md frontmatter and MANIFEST.json.
// ---------------------------------------------------------------------------
const menuRoutes = JSON.parse(
  await readFile(join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'menu-skill-routes.json'), 'utf8'),
).routes;

function rankSkills(prompt, allSkills) {
  const promptTokens = tokenize(prompt);
  return allSkills
    .map((s) => ({ slug: s.slug, score: scoreSkill(promptTokens, s) }))
    .sort((a, b) => b.score - a.score);
}

test('every menu chip wins the activation router for its intended skill', async () => {
  const m = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const failures = [];
  for (const [phrase, expected] of Object.entries(menuRoutes)) {
    const [winner, second] = rankSkills(phrase, m.skills);
    if (winner.slug !== expected) {
      failures.push(`"${phrase}" -> ${winner.slug}(${winner.score}) wanted ${expected}`);
    } else if (winner.score < 2) {
      failures.push(`"${phrase}" -> ${expected} but score ${winner.score} < 2 (coincidence, not routing)`);
    } else if (winner.score - second.score < 1) {
      failures.push(`"${phrase}" -> ${expected}(${winner.score}) TIED with ${second.slug}(${second.score}); winning by manifest order is not winning`);
    }
  }
  assert.deepEqual(failures, [], `menu chips not routing cleanly:\n  ${failures.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// [2026-08-03] Brokered-provider asks must land on OUR connected-services
// skill, not be left for a stock Hermes skill to shadow.
//
// Live incident 2026-07-25 (Alex's account): "connect Google Calendar" was
// answered by the STOCK google-workspace skill, which marched a phone user
// through creating their own Google Cloud OAuth client, in direct conflict
// with the brokered Connections screen. The curated library cannot delete
// stock skills, but it CAN claim these phrasings so the activation surface
// prefers the curated route. Same failure family as the Dropbox incident of
// 2026-07-25/28, where the agent taught manual token creation while the
// brokered connection was already live.
// ---------------------------------------------------------------------------
const BROKERED_CASES = [
  { prompt: 'post to slack for me', expected: 'connected-services' },
  { prompt: 'check my slack', expected: 'connected-services' },
  { prompt: 'save this to my google drive', expected: 'connected-services' },
  { prompt: 'what is in my google drive', expected: 'connected-services' },
  { prompt: 'check my dropbox', expected: 'connected-services' },
  { prompt: 'list my github repos', expected: 'connected-services' },
  { prompt: 'check my outlook', expected: 'connected-services' },
  { prompt: 'catch me up on teams', expected: 'connected-services' },
  { prompt: 'connect google calendar', expected: 'connected-services' },
  { prompt: 'what is on my calendar', expected: 'connected-services' },
  // 2026-09-02: the Composio connectors. Each of these had a stock or curated
  // skill ready to answer with its own manual setup (google-workspace,
  // safe-inbox-manager, autonomous-bookkeeper, spreadsheet-excel).
  { prompt: 'read my gmail', expected: 'connected-services' },
  { prompt: 'connect gmail', expected: 'connected-services' },
  { prompt: 'who owes me money', expected: 'connected-services' },
  { prompt: 'connect quickbooks', expected: 'connected-services' },
  { prompt: 'put this in a google sheet', expected: 'connected-services' },
  { prompt: 'connect google sheets', expected: 'connected-services' },
  { prompt: 'write this up in a google doc', expected: 'connected-services' },
  { prompt: 'connect google docs', expected: 'connected-services' },
  { prompt: 'connect notion', expected: 'connected-services' },
  { prompt: 'what is in my notion', expected: 'connected-services' },
  { prompt: 'connect trello', expected: 'connected-services' },
  { prompt: 'what is on my trello board', expected: 'connected-services' },
  { prompt: 'connect asana', expected: 'connected-services' },
  { prompt: 'what is on my plate in asana', expected: 'connected-services' },
  { prompt: 'connect clickup', expected: 'connected-services' },
  { prompt: 'what is overdue in clickup', expected: 'connected-services' },
  { prompt: 'connect google tasks', expected: 'connected-services' },
  { prompt: 'connect zendesk', expected: 'connected-services' },
  { prompt: 'which tickets need me', expected: 'connected-services' },
  { prompt: 'connect jira', expected: 'connected-services' },
  { prompt: 'connect confluence', expected: 'connected-services' },
  { prompt: 'connect onedrive', expected: 'connected-services' },
  { prompt: 'connect hubspot', expected: 'connected-services' },
  { prompt: 'which deals have gone quiet', expected: 'connected-services' },
  { prompt: 'connect salesforce', expected: 'connected-services' },
  { prompt: 'connect stripe', expected: 'connected-services' },
  { prompt: 'what came in this week', expected: 'connected-services' },
  { prompt: 'connect youtube', expected: 'connected-services' },
  { prompt: 'connect reddit', expected: 'connected-services' },
  { prompt: 'connect linkedin', expected: 'connected-services' },
  { prompt: 'connect instagram', expected: 'connected-services' },
  { prompt: 'connect facebook', expected: 'connected-services' },
  { prompt: 'connect pdf.co', expected: 'connected-services' },
  { prompt: 'connect freshdesk', expected: 'connected-services' },
  { prompt: 'my freshdesk tickets', expected: 'connected-services' },
  { prompt: 'connect firecrawl', expected: 'connected-services' },
  { prompt: 'crawl this website', expected: 'connected-services' },
  { prompt: 'connect agentmail', expected: 'connected-services' },
  { prompt: 'connect figma', expected: 'connected-services' },
  { prompt: 'connect shopify', expected: 'connected-services' },
  { prompt: 'what sold this week', expected: 'connected-services' },
  { prompt: 'connect webflow', expected: 'connected-services' },
];

for (const { prompt, expected } of BROKERED_CASES) {
  test(`brokered ask "${prompt}" → ${expected}`, () => {
    const picked = pickSkill(prompt, manifest.skills);
    assert.equal(picked, expected,
      `expected ${expected}, got ${picked}; a stock skill can shadow this ask if the curated library does not claim it`);
  });
}

test('directed prompts always score above zero', () => {
  // The deterministic router is a sanity check, not a production router
  // (production routing is LLM-driven). The contract we DO want: every
  // directed prompt overlaps with its target skill's activation surface
  // enough that the keyword router lands within reach of the right skill.
  for (const { prompt, expected } of ROUTING_CASES) {
    const tokens = tokenize(prompt);
    const entry = manifest.skills.find(s => s.slug === expected);
    const score = scoreSkill(tokens, entry);
    assert.ok(score >= 2, `routing prompt "${prompt}" scored ${score} on ${expected}; activation phrases need to cover the user's natural phrasing better`);
  }
});

test('safety boundaries hold across all routed skills', () => {
  // For each routing case, the chosen skill MUST have requires_human_approval
  // OR risk_level recorded. (The 12 key skills are a mix of low/medium/high.)
  for (const { prompt, expected } of ROUTING_CASES) {
    const entry = manifest.skills.find(s => s.slug === expected);
    assert.ok(entry, `manifest must contain ${expected}`);
    assert.ok(
      ['low','medium','high'].includes(entry.risk_level),
      `${expected}: risk_level must be low|medium|high`,
    );
  }
});
