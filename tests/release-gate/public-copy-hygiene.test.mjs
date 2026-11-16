// FU-3 (Batch C3, May 18 hardening pass): public-copy hygiene scanner.
//
// Fails if user-facing source files reintroduce any of:
//   1. Legacy company-name variants ("Delegate AI Limited", "Delegent AI", "Delegent AI")
//      — the canonical Companies House name is "Delegent AI" (Batch C1).
//   2. The fictional @delegent.ai domain — real mailboxes are @delegentai.co.uk.
//   3. Invented mailbox prefixes (hello@, privacy@, security@, billing@) when
//      paired with the delegent[ai] domain. Alex confirmed only contact / support /
//      accounts / admin are real mailboxes.
//   4. Unsupported "UK-based server" / "servers in the UK" / similar claims.
//      Our infra is multi-region; making a UK-server claim would be misleading.
//
// Scope: same USER_FACING_ROOTS as the em-dash scanner. Scans .ts/.tsx/.js/.jsx.
//
// What this does NOT scan for:
//   - Telegram/WhatsApp/Signal headline references. The existing FAQ + ValueProps
//     legitimately mention them as future channels; pattern is too easy to
//     trigger false positives. The Batch 25/26 "messenger options as they come
//     online" pattern is the editorial guideline, not a CI gate.
//   - Em-dashes — covered by tests/e2e/no-em-dashes-in-user-facing-copy.test.mjs.
//   - Server secrets — covered by tests/e2e/no-server-secrets-in-public-surfaces.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

const USER_FACING_ROOTS = [
  'apps/mobile/src',
  'apps/mobile/App.tsx',
  'apps/website/src',
  'packages/shared/src/legal',
];

const ALLOW_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

const IGNORE_SUBPATHS = [
  'node_modules',
  '__tests__',
  '.test.',
  '.spec.',
  'android/build',
  'allure-report',
  'dist/',
];

// Forbidden patterns. Each rule has a name, a regex, and a description that
// surfaces in the failure message so the next dev knows what to do.
const RULES = [
  {
    name: 'legacy-company-name-Delegate',
    pattern: /Delegate AI Limited/,
    fix: 'Use "Delegent AI" (the Companies House name confirmed in Batch C1).',
  },
  {
    name: 'legacy-company-name-Limited',
    pattern: /Delegent AI Limited\b/,
    fix: 'Use "Delegent AI" (Companies House suffix is LTD, not Limited).',
  },
  {
    name: 'legacy-company-name-Ltd',
    pattern: /Delegent AI Ltd\b/,
    fix: 'Use "Delegent AI" (Companies House suffix is LTD all-caps).',
  },
  {
    name: 'fictional-delegent.ai-domain',
    pattern: /@delegent\.ai\b/,
    fix: 'Real mailboxes live at @delegentai.co.uk. See docs/EMAIL_ADDRESS_MIGRATION.md.',
  },
  {
    name: 'invented-mailbox-hello',
    pattern: /hello@delegent(ai)?\.(co\.uk|ai)\b/,
    fix: 'Only 4 real mailboxes exist: contact / support / accounts / admin @delegentai.co.uk. Use contact@ for general enquiries.',
  },
  {
    name: 'invented-mailbox-privacy',
    pattern: /privacy@delegent(ai)?\.(co\.uk|ai)\b/,
    fix: 'Privacy / DPA queries route to admin@example.com per Alex-confirmed mapping. See docs/EMAIL_ADDRESS_MIGRATION.md.',
  },
  {
    name: 'invented-mailbox-security',
    pattern: /security@delegent(ai)?\.(co\.uk|ai)\b/,
    fix: 'No security@ mailbox exists. Route to admin@example.com for formal notices.',
  },
  {
    name: 'invented-mailbox-billing',
    pattern: /billing@delegent(ai)?\.(co\.uk|ai)\b/,
    fix: 'No billing@ mailbox exists. Route to accounts@example.com for billing queries.',
  },
  {
    name: 'unsupported-UK-server-claim',
    pattern: /UK[ -]based server|servers? in the UK|UK servers|data (?:lives|hosted) (?:in|inside) the UK/i,
    fix: 'Do not make UK-server claims. Infra is multi-region. Say "UK-based" only about the company / its operations.',
  },
];

function* walk(root) {
  const stack = [root];
  while (stack.length > 0) {
    const entry = stack.pop();
    let stats;
    try { stats = statSync(entry); } catch { continue; }
    if (stats.isFile()) { yield entry; continue; }
    let children;
    try { children = readdirSync(entry); } catch { continue; }
    for (const child of children) stack.push(join(entry, child));
  }
}

function shouldScan(absolutePath) {
  const rel = relative(REPO, absolutePath);
  if (IGNORE_SUBPATHS.some((needle) => rel.includes(needle))) return false;
  const ext = absolutePath.slice(absolutePath.lastIndexOf('.'));
  return ALLOW_EXTENSIONS.has(ext);
}

function scanFileForRule(absolutePath, rule) {
  const text = readFileSync(absolutePath, 'utf8');
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (rule.pattern.test(lines[i])) {
      hits.push({ line: i + 1, snippet: lines[i].trim().slice(0, 140) });
    }
  }
  return hits;
}

test('no forbidden public-copy patterns in user-facing source', () => {
  const allFiles = [];
  for (const root of USER_FACING_ROOTS) {
    const absRoot = join(REPO, root);
    let stats;
    try { stats = statSync(absRoot); } catch { continue; }
    if (stats.isFile()) {
      if (shouldScan(absRoot)) allFiles.push(absRoot);
      continue;
    }
    for (const file of walk(absRoot)) {
      if (shouldScan(file)) allFiles.push(file);
    }
  }

  const offenders = [];
  for (const rule of RULES) {
    for (const file of allFiles) {
      const hits = scanFileForRule(file, rule);
      if (hits.length > 0) {
        offenders.push({ rule, file: relative(REPO, file), hits });
      }
    }
  }

  if (offenders.length > 0) {
    const lines = [
      'Public-copy hygiene scanner found forbidden patterns in user-facing source.',
      'See the per-rule fix line for what to do.',
      '',
    ];
    for (const o of offenders) {
      lines.push(`  [${o.rule.name}] ${o.file}`);
      lines.push(`    fix: ${o.rule.fix}`);
      for (const h of o.hits) lines.push(`    line ${h.line}: ${h.snippet}`);
      lines.push('');
    }
    assert.fail(lines.join('\n'));
  }
});
