// No model vendor or family name may appear in customer-facing copy.
//
// 2026-08-01 we switched the chat model. Three surfaces carried on advertising
// the old one — the mobile paywall, the website hero, the website FAQ — plus a
// Play Store screenshot that is STILL live and still reads "Powered by Kimi
// K2.6". Nobody noticed, because copy that used to be true does not break
// anything; it just quietly misleads customers and misstates a claim in a
// listing we hold to an audit.
//
// The rule: the model we run is an implementation detail. Changing it is an
// engineering decision and must never require a marketing edit, a website
// redeploy, or a store re-review. Customer-facing text says "a frontier AI
// model" (packages/shared/src/content/modelClaim.ts) and nothing more specific.
//
// This scans SOURCE COPY only. Engineering code names models constantly and
// must keep doing so — the MODEL constant, provider chains, cost comments — so
// worker/provisioner/runner internals are out of scope by design. What is in
// scope is anything whose strings a customer can read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Vendors and model families, not the bare word "model". Word-boundary anchored
// so "Claude-Session" trailers and the like are not swept up by accident.
const MODEL_NAMES = [
  /\bkimi\b/i,
  /\bmoonshot(ai)?\b/i,
  /\bdeepseek\b/i,
  /\bk2[.\-]?6\b/i,
  /\bgpt-[0-9]/i,
  /\bclaude\s+(opus|sonnet|haiku)\b/i,
  /\banthropic\b/i,
  /\bllama\b/i,
  /\bqwen\b/i,
  /\bmistral\b/i,
  /\bgemini\b/i,
  /\bgrok\b/i,
];

// Surfaces a customer reads. Deliberately narrow and explicit: a glob over the
// whole repo would sweep in engineering code that must name models.
const COPY_SOURCES = [
  'apps/mobile/App.tsx',
  'apps/mobile/src',
  'apps/website/src',
  'packages/shared/src/content',
  'packages/shared/src/legal',
  'docs/play-store/LISTING.md',
];

// Voice transcription genuinely names a third-party model in an operator-facing
// config path, and the mobile app surfaces engine versions to support. Narrow,
// justified exemptions — each one is a file, not a blanket pattern.
const EXEMPT = new Set([
  'packages/shared/src/content/modelClaim.ts', // explains the rule; quotes the banned string
]);

function* walk(abs) {
  let st;
  try { st = statSync(abs); } catch { return; }
  if (st.isFile()) { yield abs; return; }
  if (!st.isDirectory()) return;
  for (const entry of readdirSync(abs)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    yield* walk(join(abs, entry));
  }
}

test('no model vendor or family name appears in customer-facing copy', () => {
  const offences = [];
  for (const source of COPY_SOURCES) {
    for (const abs of walk(join(REPO, source))) {
      const rel = relative(REPO, abs).replace(/\\/g, '/');
      if (EXEMPT.has(rel)) continue;
      if (!/\.(ts|tsx|js|jsx|md|json)$/.test(rel)) continue;
      const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const re of MODEL_NAMES) {
          if (re.test(line)) offences.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
        }
      });
    }
  }
  assert.deepEqual(
    offences,
    [],
    'Customer-facing copy names a specific AI model. Use the wording in\n'
      + 'packages/shared/src/content/modelClaim.ts instead — the model is an\n'
      + 'implementation detail and naming it means a marketing edit, a website\n'
      + 'redeploy and a Play Store re-review every time we change it.\n\n'
      + `Offending lines:\n${offences.join('\n')}`,
  );
});

test('[positioning] the capability claim is still present on both surfaces', () => {
  // Inherited from kimi-model-advertised.test.mjs (2026-05-31), which this file
  // replaces. That guard existed so a refactor could not silently delete the
  // model selling point, and it asserted the literal string "Kimi K2.6" on both
  // surfaces. The policy flipped on 2026-08-02 — we no longer name the model —
  // but the protective intent still holds: the CLAIM must survive, even though
  // the name must not. Same guarantee, one layer more abstract.
  const surfaces = [
    ['apps/website/src/sections/Hero.tsx', 'MODEL_CLAIM_SHORT'],
    ['apps/website/src/sections/FAQ.tsx', 'MODEL_CLAIM_FAQ'],
    ['apps/mobile/App.tsx', 'MODEL_CLAIM_PAYWALL'],
  ];
  for (const [file, symbol] of surfaces) {
    const text = readFileSync(join(REPO, file), 'utf8');
    assert.ok(
      text.includes(symbol),
      `${file} no longer renders ${symbol} — the capability selling point was `
        + 'dropped. Re-add it, or move it deliberately and update this guard.',
    );
  }
});

test('the website mirror matches the shared source of truth word for word', () => {
  // The website is a standalone Vite build with no workspace dependencies, so it
  // keeps its own copy — same arrangement as webAppLink.ts. Two copies of a
  // customer-facing claim is exactly how surfaces drift, so pin them together.
  const pick = (text, name) => {
    const m = text.match(new RegExp(`export const ${name} =([\\s\\S]*?);\\n`));
    assert.ok(m, `${name} not found`);
    return m[1].replace(/\s+/g, ' ').trim();
  };
  const shared = readFileSync(join(REPO, 'packages/shared/src/content/modelClaim.ts'), 'utf8');
  const website = readFileSync(join(REPO, 'apps/website/src/content/modelClaim.ts'), 'utf8');
  for (const name of ['MODEL_CLAIM_SHORT', 'MODEL_CLAIM_PAYWALL', 'MODEL_CLAIM_FAQ']) {
    assert.equal(
      pick(website, name),
      pick(shared, name),
      `${name} has drifted between the website copy and packages/shared. `
        + 'Edit packages/shared/src/content/modelClaim.ts and mirror it exactly.',
    );
  }
});
