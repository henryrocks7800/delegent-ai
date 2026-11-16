// Release-gate scanner for the marketing suite's claims.
//
// Why this exists: docs/play-store/LISTING.md carries a softened-claims table
// listing wordings that were audited against the shipped product on 2026-07-26
// and found not to be defensible. marketing/PLAN.md, marketing/social/COPY.md
// and marketing/social/FACEBOOK_PAGE.md all say in prose that they are bound by
// that table, and nothing checked it. A rule written down but not enforced is
// how the store screenshots reached 2.231:1 against Play's 2:1 limit with no
// one noticing, so this closes the same gap for copy.
//
// Misrepresenting functionality is a Play policy violation, and the account has
// takedown history, so a reintroduced claim is not a cosmetic problem.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKETING = fileURLToPath(new URL('../../marketing', import.meta.url));

// Each entry is a wording from the softened-claims table, plus what to say
// instead. The pattern has to be specific enough that it only fires on an
// actual claim: "an inbox you create" is approved copy, "your inbox" is not.
const BANNED_CLAIMS = [
  {
    pattern: /files? (?:the |your )?expenses?\b|into your accounts\b|running set of accounts\b/i,
    instead: 'reads receipts, categorises, and prepares review-ready notes and a monthly pack',
    why: 'filing into an accounting system is not shipped',
  },
  // "your inbox" was banned here from 2026-07-26 to 2026-09-08. It is no
  // longer banned because the claim is now true: Gmail (read, draft, send, the
  // mail.google.com grant) and Microsoft Outlook (can send) are live
  // Connections cards brokered by Composio since 2026-09-01, the softened-claims
  // table in docs/play-store/LISTING.md marks its inbox row "Stale as of
  // 2026-09-03 ... The personal-inbox path IS shipped", and the live Play
  // listing itself says "it reads your inbox". A gate that outlives the fact it
  // guards blocks true copy; this one blocked the Google Ads brief. Put the rule
  // back the day either card leaves the catalogue (packages/shared/src/connections.ts).
  {
    pattern: /brows(?:e|es|ing) the web\b|searches? the (?:web|internet)\b/i,
    instead: 'build and publish a simple website, then update it on request',
    why: 'interactive browsing is off for every live workspace',
  },
  {
    pattern: /learns your (?:repeatable )?workflows?\b|figures out your workflow\b/i,
    instead: 'save a routine once and it reuses it on a schedule you set',
    why: 'nothing infers a workflow, the user creates a routine explicitly',
  },
  {
    pattern: /hosted in the UK\b|UK-hosted\b/i,
    instead: 'a UK workspace, plus the note that some processing happens outside the UK',
    why: 'an unqualified claim contradicts the Privacy Policy a reviewer reads',
  },
  {
    pattern: /one fixed (?:monthly )?price\b|fixed price forever\b/i,
    instead: 'a monthly subscription with a capacity allowance, so no surprise usage bills',
    why: 'the launch promo raises the price after two months',
  },
];

// A passage telling you NOT to say something necessarily contains the thing.
// Two lessons are baked in here. First, the test runs per PARAGRAPH, not per
// line: the negation and the phrase it forbids usually land on different lines
// of the same wrapped sentence, and scanning line by line flagged this file's
// own warning six times. Second, the markers are narrow editorial phrases, not
// general negatives: "never" and "avoid" appear in real copy ("it never sends
// without asking"), so keying on them would silence genuine claims.
const GUIDANCE = /do not reintroduce|do not put them back|do not use|not defensible|say instead|was reworded/i;

// Markdown paragraphs: runs of non-blank lines. Fenced code keeps its own
// paragraph shape, which is fine, the copy inside it is what we want to read.
function paragraphs(text) {
  const out = [];
  let start = 0;
  let buf = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') {
      if (buf.length) out.push({ start, lines: buf });
      buf = [];
    } else {
      if (!buf.length) start = i;
      buf.push(line);
    }
  });
  if (buf.length) out.push({ start, lines: buf });
  return out;
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const files = markdownFiles(MARKETING);

test('the marketing suite has copy to audit', () => {
  assert.ok(files.length > 0, 'no markdown found under marketing/');
});

test('no marketing copy reintroduces a claim the audit removed', () => {
  const violations = [];
  for (const file of files) {
    const rel = file.slice(MARKETING.length + 1);
    for (const para of paragraphs(readFileSync(file, 'utf8'))) {
      const joined = para.lines.join(' ');
      if (GUIDANCE.test(joined)) continue;
      for (const claim of BANNED_CLAIMS) {
        if (!claim.pattern.test(joined)) continue;
        const hit = para.lines.findIndex((l) => claim.pattern.test(l));
        const line = hit === -1 ? para.lines[0] : para.lines[hit];
        violations.push(
          `${rel}:${para.start + (hit === -1 ? 0 : hit) + 1}\n    said: ${line.trim()}\n    why it fails: ${claim.why}\n    say instead: ${claim.instead}`,
        );
      }
    }
  }
  assert.equal(
    violations.length,
    0,
    `marketing copy reintroduced ${violations.length} audited claim(s):\n\n${violations.join('\n\n')}`,
  );
});

test('the Facebook Page copy points at an image set that exists', () => {
  const page = join(MARKETING, 'social', 'FACEBOOK_PAGE.md');
  const text = readFileSync(page, 'utf8');
  const shots = fileURLToPath(
    new URL('../../docs/play-store/screenshots/device-2026-07-26', import.meta.url),
  );
  const available = new Set(readdirSync(shots).filter((f) => f.endsWith('.png')));
  const referenced = [...text.matchAll(/^Image: `([^`]+)`/gm)].map((m) => m[1]);

  assert.ok(referenced.length > 0, 'no post declares an image');
  for (const name of referenced) {
    assert.ok(available.has(name), `${name} is referenced but not in the screenshot set`);
    assert.ok(!name.includes('REJECTED'), `${name} is a rejected frame and must not be posted`);
  }
});
