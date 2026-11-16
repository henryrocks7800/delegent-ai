import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// The admin page told an administrator he was not an administrator.
//
// On 2026-09-14 Alex opened /admin and read "This account is not on the list",
// so he went looking for his account having been dropped from the allowlist.
// It had not been: the admin API answered 200 for his user id throughout. His
// browser had no usable session, and the screen mapped 401 and 403 to the same
// sentence. A wrong diagnosis in the copy costs more than a blank screen: it
// sends the reader to fix something that is not broken.
//
// Executed rather than grepped. The last defect that reached his phone got
// through a wall of source-text assertions, so the decision lives in a pure
// function and this runs it.

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../src/features/admin/adminError.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exported = {};
new Function('exports', compiled)(exported);
const { adminLoadErrorMessage } = exported;

test('401 says the session is stale, and never that the account lacks access', () => {
  const message = adminLoadErrorMessage({ status: 401, message: 'unauthenticated' });
  assert.match(message, /sign in again/i);
  assert.doesNotMatch(message, /not on the list|administrator/i,
    'a signed-out reader must not be told they lack permission');
});

test('403 is the only status that says the account is not an administrator', () => {
  const message = adminLoadErrorMessage({ status: 403, message: 'forbidden' });
  assert.match(message, /not on the list/i);
  assert.doesNotMatch(message, /sign in again/i);
});

test('anything else is reported as it came back, not guessed at', () => {
  assert.equal(adminLoadErrorMessage({ status: 503, message: 'Service unavailable' }), 'Service unavailable');
  assert.equal(adminLoadErrorMessage({ status: 0, message: 'offline' }), 'offline');
  assert.equal(adminLoadErrorMessage({ status: 500, message: 'something broke' }), 'something broke');
});

test('the two sentences are different, whatever they are later reworded to', () => {
  const unauthenticated = adminLoadErrorMessage({ status: 401, message: 'x' });
  const forbidden = adminLoadErrorMessage({ status: 403, message: 'x' });
  assert.notEqual(unauthenticated, forbidden);
});
