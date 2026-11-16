// Phase 4 — deterministic contract tests for the Delegent Hermes skills library.
//
// Runs without OpenRouter / model calls. Pins the schema, validates every
// SKILL.md, scans for forbidden instructions, asserts the 12 key skills the
// production-readiness goal calls out, and proves the runner image will
// receive the skills via the Dockerfile + provisioner env path.
//
// Run:
//   node --test --import tsx services/hermes-runner/skills/delegent_library_contract.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_ROOT = join(__dirname, 'delegent');
const MANIFEST_PATH = join(LIB_ROOT, 'MANIFEST.json');
const SKILLS_DIR = join(LIB_ROOT, 'skills');

// The key skills the goal doc named (Phase 4 §7). Library has more, but THESE
// must exist and pass schema.
//
// 2026-09-03: bank-and-accounting-setup and api-integration-builder were
// DELETED, at Alex's request, because their whole job was walking the user
// through a developer console to mint an API key. FreeAgent, QuickBooks,
// Stripe and Shopify are Connections cards now, and a generic "build an API
// integration" wizard is the exact path a connection exists to replace. The
// goal doc predates connections; keeping them required here would force back a
// worse route than the product now offers.
const KEY_SKILLS = [
  'autonomous-bookkeeper',
  'agent-email-inbox',
  'phone-concierge-twilio',
  'website-builder',
  'spreadsheet-excel',
  'monthly-capacity-advisor',
];

// SKILL.md sections we require, mapped to acceptable header variants. The
// library uses Markdown headings (`#`, `##`, etc.) so we match case-insensitive
// on the heading text or a near-equivalent keyword.
const REQUIRED_SECTIONS = [
  { name: 'name',                 patterns: [/^name\b/im, /^slug\b/im] },
  { name: 'title',                patterns: [/^title\b/im, /^# /m] },
  { name: 'category',             patterns: [/category\b/im] },
  { name: 'activation phrases',   patterns: [/activation\s*phrases/im, /when to (use|activate)/im, /triggers?\b/im] },
  { name: 'safety rules',         patterns: [/safety\b/im, /never\b/im, /must not\b/im] },
  { name: 'intake questions',     patterns: [/intake/im, /questions to ask/im, /what to ask/im, /ask the user/im] },
  { name: 'execution playbook',   patterns: [/playbook/im, /steps?\b/im, /execution\b/im, /workflow\b/im] },
  { name: 'verification checklist', patterns: [/verif(?:y|ication)/im, /checklist/im, /done when/im] },
  { name: 'handover template',    patterns: [/handover\b/im, /handoff\b/im, /deliverables?\b/im, /final\s+(?:summary|report)/im] },
];

// Things a SKILL.md must NEVER ACTIVELY ENCOURAGE. We deliberately match
// only ACTIVE-VOICE bypass instructions, not negative safety rules like
// "do not X without approval" (which is GOOD and appears throughout the
// library). Each pattern is anchored so accidental matches in safety
// clauses don't poison the build.
const FORBIDDEN_PATTERNS = [
  // "print/log/echo the API key" — actively leaking secrets
  { name: 'print secrets', re: /(?:print|log|echo|output|display)\s+(?:the\s+)?(?:api\s+)?(?:key|token|secret|password)\b/i },
  // "bypass/skip/ignore approval" — explicit instructions to skip approval
  { name: 'bypass approval', re: /\b(?:bypass|skip|ignore|override)\s+(?:the\s+|user\s+|human\s+|explicit\s+)*approval\b/i },
  // "ignore/disable safety" / "ignore the rules" — telling the agent to disregard guardrails
  { name: 'ignore safety', re: /\b(?:ignore|disable|disregard|override)\s+(?:safety|the\s+rules|the\s+boundar|guardrail)/i },
  // "pretend the task is done" / "fake the result" — manufacturing fake success
  { name: 'fake completion', re: /\b(?:pretend|fake|fabricate)\s+(?:the\s+)?(?:task|work|integration|result|outcome|completion|success)/i },
  // "make payments anyway" / "send payment without confirmation" — actively pushing irreversible $ action
  { name: 'payments anyway', re: /\b(?:make|send|process|push)\s+(?:the\s+|a\s+)?payment(?:s)?\s+(?:anyway|regardless|without\s+(?:asking|confirming))/i },
  // "submit filing anyway" / "file without confirmation"
  { name: 'submit filings anyway', re: /\b(?:submit|file|post)\s+(?:the\s+)?(?:filing|form|return|application)s?\s+(?:anyway|regardless|without\s+(?:asking|confirming))/i },
];

// Pull the YAML frontmatter from a SKILL.md (everything between the first
// pair of `---` lines at the top of the file). Returns null if no
// frontmatter is present.
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const obj = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) obj[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return obj;
}

let manifest;
test('MANIFEST.json exists and is valid JSON', async () => {
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  manifest = JSON.parse(raw);
  assert.equal(typeof manifest.name, 'string', 'manifest.name');
  assert.equal(manifest.format, 'SKILL.md folder packages', 'manifest.format');
  assert.equal(typeof manifest.count, 'number', 'manifest.count');
  assert.ok(Array.isArray(manifest.skills), 'manifest.skills array');
  assert.equal(manifest.skills.length, manifest.count,
    `manifest.count (${manifest.count}) must match skills.length (${manifest.skills.length})`);
  assert.ok(manifest.count >= 30, `should have at least 30 skills; got ${manifest.count}`);
});

test('every manifest entry points to an existing SKILL.md', async () => {
  for (const entry of manifest.skills) {
    assert.equal(typeof entry.slug, 'string', `entry.slug for ${JSON.stringify(entry)}`);
    assert.equal(typeof entry.path, 'string', `entry.path for ${entry.slug}`);
    const skillPath = join(LIB_ROOT, entry.path);
    const s = await stat(skillPath).catch(() => null);
    assert.ok(s && s.isFile(), `SKILL.md missing for ${entry.slug} at ${entry.path}`);
  }
});

test('every SKILL.md has all required schema sections', async () => {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  assert.ok(dirs.length >= 30, `expected at least 30 skill dirs; got ${dirs.length}`);

  const failures = [];
  for (const slug of dirs) {
    const skillFile = join(SKILLS_DIR, slug, 'SKILL.md');
    const content = await readFile(skillFile, 'utf8').catch(() => null);
    if (!content) { failures.push(`${slug}: SKILL.md missing`); continue; }

    for (const section of REQUIRED_SECTIONS) {
      const ok = section.patterns.some(re => re.test(content));
      if (!ok) failures.push(`${slug}: missing required section "${section.name}"`);
    }
  }
  assert.equal(failures.length, 0, `schema failures:\n${failures.slice(0, 30).join('\n')}`);
});

test('no SKILL.md contains forbidden instructions', async () => {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

  const violations = [];
  for (const slug of dirs) {
    const content = await readFile(join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
    for (const f of FORBIDDEN_PATTERNS) {
      const m = content.match(f.re);
      if (m) violations.push(`${slug}: forbidden "${f.name}" matched: "${m[0]}"`);
    }
  }
  assert.equal(violations.length, 0, `forbidden patterns:\n${violations.join('\n')}`);
});

async function collectRuntimeCopyFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRuntimeCopyFiles(fullPath));
    } else if (/\.(?:md|json)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

test('runtime skills do not reintroduce unsupported v1 scheduling or external-write promises', async () => {
  // The public app now promises on-demand chat, reviewable Files artefacts,
  // and repeatable checklists. The runner skill library is part of the
  // runtime prompt surface, so it must not pull the assistant back toward
  // unattended recurring jobs, automatic sending, official submissions, or
  // direct accounting writes unless a shipped integration path proves them.
  const unsupportedRuntimeClaims = [
    { name: 'autonomous bookkeeping label', re: /\bAutonomous Bookkeeper\b/i },
    { name: 'accounting workflow automation', re: /\baccounting workflow automation\b/i },
    { name: 'recurring workflow scheduler', re: /\brecurring workflow\b/i },
    { name: 'automatic external sending', re: /\bsend automatically\b/i },
    { name: 'approved accounting posting', re: /\bapproved posting\b/i },
    { name: 'direct accounting-system posting', re: /\bposting (?:to accounting systems|anything into accounting software)\b/i },
    { name: 'official submit-or-draft choice', re: /\bCan I submit or draft only\?/i },
    { name: 'scheduled invoice escalation artefact', re: /\bescalation schedule\b|\bEscalation calendar\b/i },
  ];

  const files = await collectRuntimeCopyFiles(LIB_ROOT);
  const violations = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const relative = file.slice(LIB_ROOT.length + 1);
    for (const claim of unsupportedRuntimeClaims) {
      const match = content.match(claim.re);
      if (match) violations.push(`${relative}: unsupported ${claim.name}: "${match[0]}"`);
    }
  }

  assert.equal(violations.length, 0, `unsupported runtime promises:\n${violations.join('\n')}`);
});

// ---- Brokered connections -------------------------------------------------
// A user can connect a provider for themselves on the Connections screen. That
// happens in their own browser, so the agent never sees it and has no way to
// find out except by asking. A skill that does not ask will cheerfully walk
// somebody through a developer console for an account they connected last week,
// which is the most visible way for the coworker to look like it was not paying
// attention. These tests hold every skill that could hit that to the check.

const CONNECT_CHECK = 'delegent-connect list';

test('every skill that takes a typed credential also checks the brokered feed', async () => {
  // The vault callout marks the skills that handle credentials at all. Each one
  // has to name the other custody model too, because checking only the vault is
  // exactly how you miss a connection the user already made.
  const dirs = (await readdir(SKILLS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory());
  const missing = [];
  for (const { name: slug } of dirs) {
    const content = await readFile(join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
    if (!content.includes('delegent-keys put')) continue;
    if (!content.includes(CONNECT_CHECK)) missing.push(slug);
  }
  assert.deepEqual(missing, [], `skills that know the vault but not the broker:\n${missing.join('\n')}`);
});

test('no skill sends a user to a developer console for a brokered provider without checking first', async () => {
  // Read the provider names off the shared catalogue rather than a list here,
  // so adding a sixth provider fails this test until its skills are told.
  const catalogue = await readFile(
    join(__dirname, '..', '..', '..', 'packages', 'shared', 'src', 'connections.ts'),
    'utf8',
  );
  const names = [...catalogue.matchAll(/^\s*name: '([^']+)',$/gm)].map((m) => m[1]);
  assert.ok(names.length >= 1, 'the connections catalogue is empty, so this test proves nothing');

  // The words a manual-setup walkthrough uses. Naming a provider is fine; only
  // naming it next to "go and create an OAuth client" is the problem.
  const console = /developer(?:s)? (?:portal|console|section)|cloud console|app console|create an? (?:oauth|api) (?:client|app|key)|client secret/i;

  const dirs = (await readdir(SKILLS_DIR, { withFileTypes: true })).filter((e) => e.isDirectory());
  const violations = [];
  for (const { name: slug } of dirs) {
    const content = await readFile(join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
    if (content.includes(CONNECT_CHECK)) continue;
    if (!console.test(content)) continue;
    const named = names.filter((n) => new RegExp(`\\b${n}\\b`, 'i').test(content));
    if (named.length) violations.push(`${slug}: walks through a console for ${named.join(', ')}`);
  }
  assert.deepEqual(violations, [], `brokered providers set up by hand:\n${violations.join('\n')}`);
});

test('the canonical credentials skill documents both custody models', async () => {
  const content = await readFile(join(SKILLS_DIR, 'core-permissions-and-credentials', 'SKILL.md'), 'utf8');
  assert.match(content, /delegent-connect run --service/, 'no way to actually use a brokered connection');
  assert.match(content, new RegExp(CONNECT_CHECK), 'the broker is never listed');
  // Ordering is the whole point: the check has to come before the questions
  // that ask the user to go and make a credential.
  assert.ok(
    content.indexOf(CONNECT_CHECK) < content.indexOf('## Intake questions'),
    'the brokered check sits after the intake questions, so it will be read too late',
  );
});

test('high-risk skills declare requires_human_approval: true in frontmatter', async () => {
  // The library's canonical contract for "this skill needs human approval"
  // is the YAML frontmatter field `requires_human_approval: true`. Test
  // that EVERY high-risk skill declares it (and that the field surfaces
  // in narrative form somewhere in the body).
  const highRisk = manifest.skills.filter(s => s.risk_level === 'high');
  assert.ok(highRisk.length >= 1, 'expected at least one high-risk skill in manifest');

  const failures = [];
  for (const entry of highRisk) {
    const content = await readFile(join(LIB_ROOT, entry.path), 'utf8');
    const fm = parseFrontmatter(content);

    if (!fm || fm.requires_human_approval !== 'true') {
      failures.push(`${entry.slug} (high-risk): frontmatter missing requires_human_approval: true`);
      continue;
    }
    // Body-level sanity: must mention approval / confirmation / permission
    // SOMEWHERE so the human reader doesn't miss the contract.
    const bodyMentions =
      /approval/i.test(content) ||
      /confirm/i.test(content) ||
      /permission/i.test(content) ||
      /sign[- ]?off/i.test(content);
    if (!bodyMentions) failures.push(`${entry.slug} (high-risk): body has no approval/confirm/permission language`);
  }
  assert.equal(failures.length, 0, `high-risk approval contract failures:\n${failures.join('\n')}`);
});

for (const slug of KEY_SKILLS) {
  test(`key skill "${slug}" exists and is referenced in manifest`, async () => {
    const skillFile = join(SKILLS_DIR, slug, 'SKILL.md');
    const s = await stat(skillFile).catch(() => null);
    assert.ok(s && s.isFile(), `SKILL.md missing for required skill ${slug}`);
    const manifestEntry = manifest.skills.find(e => e.slug === slug);
    assert.ok(manifestEntry, `manifest has no entry for required skill ${slug}`);
    assert.equal(manifestEntry.path, `skills/${slug}/SKILL.md`,
      `manifest path mismatch for ${slug}`);
  });
}

test('docs/ contains BOOTSTRAP_SKILL_LOADER_PROMPT, CATALOG, SECURITY_NOTES', async () => {
  const docs = join(LIB_ROOT, 'docs');
  for (const name of ['BOOTSTRAP_SKILL_LOADER_PROMPT.md', 'CATALOG.md', 'SECURITY_NOTES.md']) {
    const p = join(docs, name);
    const s = await stat(p).catch(() => null);
    assert.ok(s && s.isFile(), `expected ${name} in docs/`);
  }
});

// ---- Runtime install contract --------------------------------------------
// Prove the runner image will receive the skills via the Dockerfile.fly COPY
// line, and the provisioner env will inject DELEGENT_SKILLS_DIR. These are
// the two integration points without which the agent cannot find the skills.

test('Dockerfile.fly COPYs skills to /opt/delegent/skills + sets ENV', async () => {
  const dockerfile = await readFile(join(__dirname, '..', 'Dockerfile.fly'), 'utf8');
  assert.match(dockerfile, /COPY\s+services\/hermes-runner\/skills\/delegent\s+\/opt\/delegent\/skills/,
    'Dockerfile.fly must COPY skills lib into /opt/delegent/skills');
  assert.match(dockerfile, /DELEGENT_SKILLS_DIR=\/opt\/delegent\/skills/,
    'Dockerfile.fly must set ENV DELEGENT_SKILLS_DIR=/opt/delegent/skills');
});

test('provisioner injects DELEGENT_SKILLS_DIR into runner env', async () => {
  // Read the compiled provisioner if present, otherwise the source. Both
  // are valid contract surfaces.
  const candidates = [
    join(__dirname, '..', '..', '..', 'packages', 'provisioner', 'dist', 'index.js'),
    join(__dirname, '..', '..', '..', 'packages', 'provisioner', 'src', 'index.ts'),
  ];
  let content = null;
  for (const c of candidates) {
    content = await readFile(c, 'utf8').catch(() => null);
    if (content) break;
  }
  assert.ok(content, 'provisioner index.ts/index.js not found at expected paths');
  assert.match(content, /DELEGENT_SKILLS_DIR/,
    'provisioner must reference DELEGENT_SKILLS_DIR (env var injection)');
});

test('agent system prompt references the skills library', async () => {
  const defaultsPath = join(__dirname, '..', '..', '..', 'packages', 'provisioner', 'src', 'delegentAgentDefaults.ts');
  const content = await readFile(defaultsPath, 'utf8');
  assert.match(content, /Built-in skills/i, 'system prompt should have a Built-in skills section');
  assert.match(content, /DELEGENT_SKILLS_DIR/, 'system prompt should reference the env var');
  assert.match(content, /MANIFEST\.json/, 'system prompt should mention MANIFEST.json');
  assert.match(content, /SKILL\.md/, 'system prompt should mention SKILL.md');
});
