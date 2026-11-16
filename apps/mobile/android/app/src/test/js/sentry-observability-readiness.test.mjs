import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Source-contract test for the mobile Sentry wiring (same readiness style as the
// other suites: assert on source text, not a runtime import — @sentry/react-native
// is a native module that cannot load in a plain node test). Guards the privacy +
// gating invariants of apps/mobile/src/observability/sentry.ts and its use in App.tsx.
const sentrySource = readFileSync(new URL('../../../../../src/observability/sentry.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const boundarySource = readFileSync(new URL('../../../../../src/observability/ErrorBoundary.tsx', import.meta.url), 'utf8');

test('mobile Sentry init is gated on EXPO_PUBLIC_SENTRY_DSN and inert without it', () => {
  assert.match(sentrySource, /process\.env\.EXPO_PUBLIC_SENTRY_DSN/);
  assert.match(sentrySource, /sentryEnabled\s*=\s*dsn\.length\s*>\s*0/);
  // Sentry.init must be reached only inside the `if (sentryEnabled)` guard.
  assert.match(sentrySource, /if\s*\(sentryEnabled\)\s*\{[\s\S]*?Sentry\.init\(/);
});

test('mobile Sentry config is privacy-lean: no PII, no performance tracing, no replay', () => {
  assert.match(sentrySource, /sendDefaultPii:\s*false/);
  assert.match(sentrySource, /tracesSampleRate:\s*0\b/);
  // Guard against accidentally enabling perf sampling or session replay later.
  assert.doesNotMatch(sentrySource, /tracesSampleRate:\s*0?\.?[1-9]/);
  assert.doesNotMatch(sentrySource, /replaysSessionSampleRate|replaysOnErrorSampleRate|Sentry\.mobileReplayIntegration/);
});

test('wrapWithSentry is a pure pass-through when Sentry is disabled', () => {
  assert.match(sentrySource, /return\s+sentryEnabled\s*\?\s*\(Sentry\.wrap[\s\S]*?\)\s*:\s*RootComponent/);
});

test('App.tsx imports the gated Sentry module and wraps the root export', () => {
  assert.match(appSource, /from\s+'\.\/src\/observability\/sentry'/);
  assert.match(appSource, /export default wrapWithSentry\(RootApp\)/);
  // App must remain a plain (hoisted) function declaration so RootApp can reference it.
  assert.match(appSource, /\nfunction App\(/);
});

test('App root is error-boundaried (#15) so a render fault is recoverable, not a white screen', () => {
  assert.match(appSource, /from\s+'\.\/src\/observability\/ErrorBoundary'/);
  // RootApp renders App inside <MobileErrorBoundary>.
  assert.match(appSource, /<MobileErrorBoundary>[\s\S]*?<App\b[\s\S]*?<\/MobileErrorBoundary>/);
});

test('ErrorBoundary reports to Sentry and renders a reload fallback', () => {
  assert.match(boundarySource, /static getDerivedStateFromError/);
  assert.match(boundarySource, /componentDidCatch/);
  assert.match(boundarySource, /Sentry\.captureException/);
  assert.match(boundarySource, /testID="app\.errorBoundary\.reload"/);
});
