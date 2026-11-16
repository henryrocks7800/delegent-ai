// Regression test for DN1.3-01.
//
// Symptom (before fix): unsubscribed-onboarded user cold-launched via deep
// link gets stuck on "Checking on your coworker…" indefinitely. Same root
// cause as v1.2.9 DN12 (Monthly Capacity sub-view goes blank).
//
// Root cause: useMobileProductState left status === 'loading' if the
// Supabase JS client got stuck (observed on the deep-link-injected session
// path), and Shell early-returned a loading-only screen whenever
// productStatus wasn't 'live' or 'error'.
//
// Fix:
//   (a) productState.ts wraps the fetch in a Promise.race with a
//       PRODUCT_STATE_FETCH_TIMEOUT_MS deadline (15s). On timeout the
//       hook transitions to 'error' so the existing ProductStateNotice
//       retry path renders.
//   (b) App.tsx Shell latches `productEverAuthoritative` after the first
//       'live'|'error' transition; subsequent 'loading' refreshes no
//       longer hide the shell content.
//
// These source-level assertions catch a regression of either fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PRODUCT_STATE_PATH = REPO + 'apps/mobile/src/state/productState.ts';
const APP_PATH = REPO + 'apps/mobile/App.tsx';

const productStateSource = readFileSync(PRODUCT_STATE_PATH, 'utf8');
const appSource = readFileSync(APP_PATH, 'utf8');

test('[v1.3.0 DN1.3-01a] productState exports PRODUCT_STATE_FETCH_TIMEOUT_MS', () => {
  assert.match(
    productStateSource,
    /export const PRODUCT_STATE_FETCH_TIMEOUT_MS = \d+/,
    'PRODUCT_STATE_FETCH_TIMEOUT_MS must be exported so callers and tests can reference it',
  );
});

test('[v1.3.0 DN1.3-01b] productState wraps fetch in withProductStateTimeout', () => {
  assert.match(
    productStateSource,
    /function withProductStateTimeout/,
    'withProductStateTimeout helper must be defined',
  );
  // The two fetch call sites (useCallback refresh + useEffect load) both
  // need to route through the timeout wrapper. Match the bare identifier so
  // both the generic definition (`<T>(`) and call sites (`(async () =>`) count.
  const callsites = productStateSource.match(/\bwithProductStateTimeout\b/g) ?? [];
  assert.ok(
    callsites.length >= 3,
    `Expected ≥3 references to withProductStateTimeout (1 def + 2 call sites); found ${callsites.length}`,
  );
});

test('[v1.3.0 DN1.3-01c] productState surfaces a timeout-specific error message', () => {
  assert.match(
    productStateSource,
    /ProductStateTimeoutError/,
    'ProductStateTimeoutError class must be defined',
  );
  assert.match(
    productStateSource,
    /Workspace took too long to load\. Tap retry\./,
    'Timeout path must surface a retry-able message rather than the generic load error',
  );
});

test('[v1.3.0 DN1.3-01d] Shell latches productEverAuthoritative after first live|error', () => {
  assert.match(
    appSource,
    /productEverAuthoritative/,
    'Shell must keep a latch so subsequent loading transitions do not hide content',
  );
  assert.match(
    appSource,
    /if \(!productStateIsAuthoritative && !productEverAuthoritative\)/,
    'Shell early-return must gate on both !authoritative AND !ever-authoritative',
  );
});

test('[v1.3.0 DN12] DN12 cross-reference is preserved in the comment block', () => {
  // The fix targets both DN1.3-01 (cold-launch hang) and DN12 (Monthly
  // Capacity blank). The Shell latch closes both; the comment must keep
  // both IDs so a future reader can trace the rationale. The comment lives
  // immediately ABOVE the productEverAuthoritative declaration, so slice
  // backwards from the first occurrence to capture it.
  const firstUse = appSource.indexOf('productEverAuthoritative');
  const shellSection = appSource.slice(Math.max(0, firstUse - 1500), firstUse + 500);
  assert.match(shellSection, /DN12/);
  assert.match(shellSection, /DN1\.3-01/);
});
