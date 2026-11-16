// 2026-09-09: a paying customer who signed up through a Proton Pass alias
// (passmail.net) vanished from the admin dashboard because that domain was on
// the test-account list. Aliases are real people; only the box's own throwaway
// identities are tests. Source pin, because the filter is a closure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/admin.ts'), 'utf8');
const filter = src.match(/const testAccount = \(email: string\) =>\s*\n\s*(.+);/)?.[1] ?? '';

test('the admin test-account filter exists and still hides the box\'s own throwaway identities', () => {
  assert.ok(filter.length > 0, 'testAccount closure must exist');
  for (const domain of [String.raw`delegent-test\.invalid`, String.raw`example\.com`, String.raw`mailinator\.com`]) assert.ok(filter.includes(domain), `${domain} must stay on the list`);
  assert.ok(filter.includes("startsWith('contract-')"), 'contract probes must stay on the list');
});

test('a Proton Pass alias (passmail.net) is a real customer, never a test account', () => {
  assert.ok(!/passmail/i.test(filter), 'passmail.net must not be on the test-account list');
  assert.ok(!/passmail/i.test(src.replace(/\/\/.*$/gm, '')), 'no other passmail rule anywhere in admin.ts');
});
