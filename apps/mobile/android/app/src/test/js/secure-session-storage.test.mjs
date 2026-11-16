// Structural contract only. The BEHAVIOUR is executed against the installed
// expo-secure-store wrapper and the installed Supabase auth client in
// tests/e2e/auth-session.test.mjs, with only the native I/O and the network
// supplied locally.
//
// It has to be, because this file used to be the whole of the coverage and it
// was green throughout. Every session over 1,500 characters was being written
// to plaintext AsyncStorage, because the chunk keys contained '::' and the
// library rejects any key outside /^[\w.-]+$/, and a source-text assertion
// cannot see that. Two of the patterns below pinned internal function names,
// which is coverage of the spelling rather than of the behaviour; they are
// replaced with the properties that actually matter.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const url = new URL('../../../../../src/auth/secureSessionStorage.ts', import.meta.url);

test('secureSessionStorage source exists', () => {
  assert.ok(existsSync(url), 'apps/mobile/src/auth/secureSessionStorage.ts should exist');
});

const source = readFileSync(url, 'utf8');

test('Audit #15 — secureSessionStorage prefers expo-secure-store with an AsyncStorage fallback', () => {
  // Both modules must be imported.
  assert.match(source, /import\s+.*from\s+['"]expo-secure-store['"]/);
  assert.match(source, /import\s+AsyncStorage\s+from\s+['"]@react-native-async-storage\/async-storage['"]/);
  // Platform-aware branching: SecureStore on ios/android, AsyncStorage otherwise.
  assert.match(source, /Platform\.OS\s*===\s*['"]ios['"]/);
  assert.match(source, /Platform\.OS\s*===\s*['"]android['"]/);
});

test('Audit #15 — secureSessionStorage exposes the Supabase storage interface', () => {
  assert.match(source, /async\s+getItem\s*\(/);
  assert.match(source, /async\s+setItem\s*\(/);
  assert.match(source, /async\s+removeItem\s*\(/);
  // The exported binding must be a const named `secureSessionStorage`.
  assert.match(source, /export\s+const\s+secureSessionStorage\s*:/);
});

test('Audit #15 — secureSessionStorage chunks large values to fit within SecureStore item limits', () => {
  // The 2KB cap on Android requires chunking. The module must implement it.
  assert.match(source, /CHUNK/);
  assert.match(source, /SecureStore\.setItemAsync/);
  assert.match(source, /SecureStore\.getItemAsync/);
  assert.match(source, /SecureStore\.deleteItemAsync/);
});

test('Audit #15 — secureSessionStorage falls back gracefully when SecureStore throws or has no value', () => {
  // Each method must catch SecureStore errors and fall back to AsyncStorage,
  // never lock the user out of their session because of a transient store error.
  assert.match(source, /AsyncStorage\.getItem/);
  assert.match(source, /AsyncStorage\.setItem/);
  assert.match(source, /AsyncStorage\.removeItem/);
});

test('the chunk keys are ones expo-secure-store will actually accept', () => {
  // The library's own rule, read out of the installed package rather than
  // copied, so this fails loudly if they ever change it.
  const library = readFileSync(new URL('../../../../../../../node_modules/expo-secure-store/build/SecureStore.js', import.meta.url), 'utf8');
  const rule = library.match(/function isValidKey\(key\)\s*\{[\s\S]*?return[^;]*?(\/\^[^/]+\/)/);
  assert.ok(rule, 'expo-secure-store must still validate keys in isValidKey');
  const accepted = new RegExp(rule[1].slice(1, -1));
  // Every SecureStore key this module builds, taken from the template literals
  // it passes to the library.
  const templates = [...source.matchAll(/SecureStore\.(?:set|get|delete)ItemAsync\(([^,)]+)/g)].map(match => match[1].trim());
  assert.ok(templates.length >= 3, 'the adapter must still address SecureStore directly');
  const sample = { key: 'sb-project-auth-token', generation: 'a', index: 0 };
  for (const template of templates) {
    if (!template.includes('`')) continue;
    const resolved = template
      .replace(/\$\{key\}/g, sample.key)
      .replace(/\$\{generation\}/g, sample.generation)
      .replace(/\$\{index\}/g, String(sample.index))
      .replace(/`/g, '');
    assert.match(resolved, accepted, 'a key the library would refuse: ' + resolved);
  }
});

test('one store answers for a key, and the pointer between them is not in the keystore', () => {
  // A failed secure write used to store the new session in AsyncStorage while
  // an older session stayed readable in SecureStore, and the read preferred
  // SecureStore, so a successful write was followed by the previous session
  // coming back. Executed in tests/e2e/auth-session.test.mjs.
  assert.match(source, /backendKey/, 'there must be a pointer naming the committed store');
  assert.match(source, /export\s+async\s+function\s+clearPersistedAuthStorage/,
    'sign-out must be able to clear persistence without the SDK');
  assert.match(source, /export\s+function\s+fenceAuthStorageWrites/,
    'a refresh resolving after a sign-out must be refusable');
});

test('Defect A8 regression — removeItem clears BOTH SecureStore and AsyncStorage', () => {
  // 2026-05-29 forensic-p11 reproduced: sign-out + force-stop relaunch
  // restored the session because removeItem only deleted from
  // SecureStore. setItem can fall back to AsyncStorage on a SecureStore
  // failure (line ~107) and getItem reads from AsyncStorage when
  // SecureStore is empty (line ~93). The remove path MUST mirror that —
  // clear both stores, otherwise a stale AsyncStorage token survives
  // sign-out.
  //
  // We assert the structural pattern: inside the SecureStore-available
  // branch of removeItem, both SecureStore.deleteItemAsync AND
  // AsyncStorage.removeItem must be reachable (each in its own
  // try/catch so a failure in one does not skip the other).
  const removeBlock = source.match(/async\s+removeItem[\s\S]*?^\s*\},/m);
  assert.ok(removeBlock, 'removeItem implementation must be locatable in source');
  // clearSecure is where the SecureStore deletes live now, because the same
  // sweep is needed by sign-out and by a failed write. The property is that
  // removeItem reaches BOTH stores, not that it names one particular call.
  assert.match(removeBlock[0], /clearSecure\(key\)|SecureStore\.deleteItemAsync/);
  assert.match(removeBlock[0], /AsyncStorage\.removeItem/);
});

test('Audit #15 — secureSessionStorage never logs or returns secret values', () => {
  // Sanity: the adapter must not contain any console.log, since the secret
  // session JSON would land in the device log.
  assert.doesNotMatch(source, /console\.log\b/);
});
