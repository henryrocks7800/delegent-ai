// Runtime regression test for DN1.3-01.
//
// Asserts the actual timeout BEHAVIOR — not just that the source references
// withProductStateTimeout. Without this, a future refactor could keep the
// helper name but break the 15s deadline (e.g. by passing a wrong-shaped
// argument that never reaches the setTimeout) and the static check would
// still pass.
//
// Strategy: import the wrapper, give it a `work()` that never resolves,
// confirm that the returned promise rejects with ProductStateTimeoutError
// within (timeoutMs + a small skew). Uses an artificially short 50ms
// timeout so the test runs in <1s.
//
// Why this lives under tests/e2e/: the rest of the productState
// regression suite is here, and this file is intentionally pure-JS
// (no react / no Supabase) so it doesn't need a transpiler.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE = readFileSync(REPO + 'apps/mobile/src/state/productState.ts', 'utf8');

// Pull the helper + the error class out of the TS source via a tiny inline
// transpile. This keeps the test free of a project-wide tsc step.
function evalHelper() {
  // Match from the class through the end of the withProductStateTimeout
  // function body. The closing `}` of the function is at column 0 — anchor
  // to the multiline `^}` so we don't accidentally stop at an inner brace.
  const helperMatch = SOURCE.match(/class ProductStateTimeoutError[\s\S]+?function withProductStateTimeout[\s\S]+?^\}/m);
  assert.ok(helperMatch, 'Could not extract ProductStateTimeoutError + withProductStateTimeout from source');
  // Strip the TS generics + types so plain JS can eval it.
  const js = helperMatch[0]
    .replace(/withProductStateTimeout<T>/, 'withProductStateTimeout')
    .replace(/: \([^)]*\) => Promise<T>/g, '')
    .replace(/: number = PRODUCT_STATE_FETCH_TIMEOUT_MS/, '')
    .replace(/: Promise<T>/g, '')
    .replace(/new Promise<T>/g, 'new Promise')
    .replace(/PRODUCT_STATE_FETCH_TIMEOUT_MS/g, '15000');
  // eslint-disable-next-line no-new-func
  return new Function(js + '\nreturn { ProductStateTimeoutError, withProductStateTimeout };')();
}

const { ProductStateTimeoutError, withProductStateTimeout } = evalHelper();

test('[v1.3.0 DN1.3-01 runtime] timeout rejects with ProductStateTimeoutError when work hangs', async () => {
  const start = Date.now();
  const hangForever = () => new Promise(() => { /* never resolves */ });
  await assert.rejects(
    () => withProductStateTimeout(hangForever, 80),
    (err) => err instanceof ProductStateTimeoutError && err.message === 'product_state_timeout',
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 60 && elapsed < 250, `timeout fired at ${elapsed}ms — expected close to 80ms`);
});

test('[v1.3.0 DN1.3-01 runtime] timeout resolves with work value when work succeeds before deadline', async () => {
  const out = await withProductStateTimeout(async () => ({ ok: true, value: 42 }), 200);
  assert.deepEqual(out, { ok: true, value: 42 });
});

test('[v1.3.0 DN1.3-01 runtime] timeout propagates non-timeout rejection without wrapping', async () => {
  class CustomError extends Error {}
  await assert.rejects(
    () => withProductStateTimeout(async () => { throw new CustomError('inner'); }, 200),
    (err) => err instanceof CustomError && err.message === 'inner',
  );
});

test('[v1.3.0 DN1.3-01 runtime] late work completion after timeout does not double-settle', async () => {
  let resolveLate;
  const work = () => new Promise((resolve) => { resolveLate = resolve; });
  await assert.rejects(() => withProductStateTimeout(work, 30), (err) => err instanceof ProductStateTimeoutError);
  // Resolving after the timeout fired must not crash or throw an
  // UnhandledPromiseRejection. The helper sets `settled = true` so the
  // late resolve becomes a no-op.
  resolveLate({ ok: true });
  // Give the event loop a tick to let any late handler fire.
  await new Promise((resolve) => setTimeout(resolve, 20));
  // If we reach here without a thrown exception, the no-op guard worked.
  assert.ok(true);
});
