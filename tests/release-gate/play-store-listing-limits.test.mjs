// Release-gate scanner for the Google Play store listing copy.
//
// Why this exists: the listing copy lived in three contradictory files and none
// of it was measured, so drafts were written that BREAK Play's hard limits (a
// 44-character title against a 30 limit, a 165-character short description
// against an 80 limit). Play truncates or rejects those, and you only find out
// at review time, days later.
//
// docs/play-store/LISTING.md is now the single source of truth. Each field
// carries a machine marker declaring its own limit:
//
//   <!-- play:title max=30 -->
//   ```
//   Delegent AI: Digital Employee
//   ```
//
// The marker sits directly above the fenced block a human edits, so the check
// measures exactly the text that gets pasted into Play Console. There is no
// second copy to drift out of sync.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LISTING = fileURLToPath(new URL('../../docs/play-store/LISTING.md', import.meta.url));

// Play counts characters, and it counts them the way a person would: an emoji
// or an accented letter is one character, not the two UTF-16 code units that
// String.length would report. Array.from splits on code points.
const countChars = (s) => Array.from(s).length;

function parseFields(markdown) {
  const fields = [];
  const marker = /<!--\s*play:([a-z-]+)\s+max=(\d+)\s*-->\s*\r?\n```[a-z]*\r?\n([\s\S]*?)\r?\n```/g;
  let match;
  while ((match = marker.exec(markdown)) !== null) {
    fields.push({ name: match[1], max: Number(match[2]), text: match[3] });
  }
  return fields;
}

const markdown = readFileSync(LISTING, 'utf8');
const fields = parseFields(markdown);

test('every marked listing field parses', () => {
  // A marker whose fenced block is malformed would silently vanish from the
  // scan and take its limit check with it, so prove the markers found blocks.
  const markerCount = (markdown.match(/<!--\s*play:[a-z-]+\s+max=\d+\s*-->/g) || []).length;
  assert.ok(markerCount > 0, 'LISTING.md declares no play: fields at all');
  assert.equal(fields.length, markerCount,
    `${markerCount} play: markers but only ${fields.length} parsed a fenced block below them`);
});

test('the fields Play actually requires are present', () => {
  for (const required of ['title', 'short-description', 'full-description']) {
    assert.ok(fields.some((f) => f.name === required), `LISTING.md is missing the ${required} field`);
  }
});

test('the limits declared match what Google Play actually enforces', () => {
  // Guards against someone "fixing" a failure by raising the limit in the
  // marker. These are Play's numbers, not ours.
  const PLAY_LIMITS = {
    'title': 30,
    'short-description': 80,
    'full-description': 4000,
    'whats-new': 500,
  };
  for (const field of fields) {
    const real = PLAY_LIMITS[field.name];
    assert.ok(real !== undefined, `unknown listing field "${field.name}" (add it to PLAY_LIMITS with Play's real limit)`);
    assert.equal(field.max, real, `${field.name} declares max=${field.max} but Play enforces ${real}`);
  }
});

test('no field exceeds its limit', () => {
  const over = fields
    .map((f) => ({ ...f, length: countChars(f.text) }))
    .filter((f) => f.length > f.max);
  if (over.length > 0) {
    const lines = ['Listing copy exceeds Google Play limits and would be truncated or rejected:', ''];
    for (const f of over) {
      lines.push(`  ${f.name}: ${f.length} chars, limit ${f.max} (${f.length - f.max} over)`);
      lines.push(`    ${f.text.slice(0, 100)}...`);
    }
    assert.fail(lines.join('\n'));
  }
});

test('no field is empty', () => {
  // An empty fenced block passes a length check trivially. It would also wipe
  // the live listing if pasted.
  for (const field of fields) {
    assert.ok(field.text.trim().length > 0, `${field.name} is empty`);
  }
});

test('listing copy uses no em-dashes', () => {
  // Same editorial rule as the app and website copy, see
  // no-em-dashes-in-user-facing-copy.test.mjs. This is customer-facing text.
  const offenders = fields.filter((f) => f.text.includes('—'));
  assert.deepEqual(offenders.map((f) => f.name), [],
    'em-dash (U+2014) in listing copy, use a comma / colon / parentheses instead');
});

test('listing copy never names our infrastructure', () => {
  // Same principle as the architecture banned-vocabulary gate: the store
  // listing is the most public surface we have, and naming the stack tells
  // customers nothing while handing an attacker a map.
  const BANNED = ['OpenRouter', 'Cloudflare', 'Supabase', 'Hermes', 'Fly Machines', 'Fly.io', 'Kimi'];
  const offenders = [];
  for (const field of fields) {
    for (const word of BANNED) {
      if (new RegExp(`\\b${word.replace('.', '\\.')}\\b`, 'i').test(field.text)) {
        offenders.push(`${field.name} names "${word}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('; '));
});
