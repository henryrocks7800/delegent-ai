import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const productStateSource = readFileSync(new URL('../../../../../src/state/productState.ts', import.meta.url), 'utf8');
const connectionsStateSource = readFileSync(new URL('../../../../../src/state/connectionsState.ts', import.meta.url), 'utf8');

test('authenticated mobile app loads product state from Supabase instead of staying in preview mode', () => {
  assert.match(productStateSource, /useMobileProductState/);
  assert.match(productStateSource, /mobileSupabase/);
  assert.match(productStateSource, /\.from\('my_product_state'\)/);
  assert.match(productStateSource, /mapMyProductStateRow/);
  // The second argument says the account is on the assistant engine (no workspace to wait for).
  assert.match(appSource, /useMobileProductState\(authState, coworkerEngine === 'agent'\)/);
  assert.doesNotMatch(productStateSource, /export const sidekickProductState = createDemoSidekickState\(\);\s*export const sidekickProductGate = resolveSidekickGate\(sidekickProductState\);/);
});

test('mobile product-state queries fetch only client-safe fields', () => {
  // The safe projections are still declared, and the mappers that parse them
  // still fail closed, but nothing on the snapshot path asks for them.
  assert.match(productStateSource, /id,user_id,title,kind,detail,status,created_at,updated_at,viewer_url/);
  assert.doesNotMatch(productStateSource, /runner_base_url|railway_project_id|railway_service_id|stripe_customer_id|stripe_subscription_id|price_id|provider_event_id|payload_hash|source_conversation_id|source_message_id|source_event_id|code_hash|idempotency_key|storage_path/);
});

test('the snapshot read asks for the entitlement view and nothing else', () => {
  // It used to read artifacts, task_runs and messages as well, twenty rows
  // apiece, on EVERY refresh including the five-second provisioning poll. The
  // fields they filled reached no screen, and a 503 on any of them rejected an
  // otherwise valid entitlement snapshot: a customer with a working
  // subscription was told their workspace could not be loaded because a piece
  // of decoration was briefly unavailable.
  const fetchBody = sourceBetween(productStateSource, 'export async function fetchMobileProductSnapshot', '\nexport function useMobileProductState');
  const reads = [...fetchBody.matchAll(/\.from\('([a-z_]+)'\)/g)].map(match => match[1]);
  assert.deepEqual(reads, ['my_product_state'],
    'the authoritative read must not depend on optional side feeds');
  assert.doesNotMatch(fetchBody, /Promise\.all/);
});

test('connection view model still exists for the worker side, but the mobile App no longer renders it (v1.2.1 chat-first redesign retired the messenger UI)', () => {
  // The state module is kept on disk for the future "external channels"
  // beta — it lets the worker keep ingesting messenger payloads while
  // the in-app chat is the only thing the user sees.
  assert.match(connectionsStateSource, /buildMobileConnections/);
  assert.match(connectionsStateSource, /snapshot\.connections/);
  assert.match(connectionsStateSource, /primaryMobileConnection/);
  // App.tsx no longer imports or renders connections data.
  assert.doesNotMatch(appSource, /buildMobileConnections/);
  assert.doesNotMatch(appSource, /<ConnectionsScreen\b/);
});

test('live product-state loading and failure states are honest in the signed-in shell', () => {
  assert.match(appSource, /ProductStateNotice/);
  // 2026-05-15 copy pass: "Loading your workspace…" replaced with
  // "Checking on your coworker…" so the loading state speaks in product terms.
  assert.match(appSource, /Checking on your coworker/);
  // 2026-05-15 copy pass: technical "Workspace details didn't refresh" trimmed
  // to the consumer-friendly "Couldn't refresh.".
  assert.match(appSource, /Couldn.t refresh\./);
  assert.match(appSource, /Retry workspace refresh/);
  assert.doesNotMatch(appSource, /live preview|preview live/i);
});

test('authenticated loading and error states fail closed instead of showing demo active worker state', () => {
  assert.match(productStateSource, /createAuthenticatedFailClosedProductSnapshot/);
  assert.match(productStateSource, /const failClosedSnapshot = createAuthenticatedFailClosedProductSnapshot\(authState\.user\);/);
  // publish() rather than setSnapshot(): every write goes through one place now
  // so the fence cannot be bypassed by a path that forgot it.
  assert.match(productStateSource, /publish\(failClosedSnapshot\)/);
  // Accept either `mobileSupabase` directly or a `client` parameter
  // (some call sites pass it through a wrapper for testability).
  assert.match(productStateSource, /getFreshMobileSupabaseSession\((mobileSupabase|client)\)/);
  assert.match(productStateSource, /if \(!productStateResult\.data\) \{[\s\S]*?if \(emptyStateSnapshot\) return emptyStateSnapshot;/);
  assert.match(productStateSource, /fetchMobileProductSnapshot\((mobileSupabase|client), failClosedSnapshot\)/);
  // catch may bind the error or use bare-catch ; both are valid.
  assert.match(productStateSource, /catch (\(\w+\) )?\{[\s\S]*?setStatus\('error'\);[\s\S]*?setErrorMessage\(/);
  assert.doesNotMatch(productStateSource, /catch (\(\w+\) )?\{[\s\S]{0,120}?setStatus\('live'\);[\s\S]{0,120}?setErrorMessage\(null\);/);
  assert.match(productStateSource, /mode: authState\.status === 'authenticated' \? 'live' : 'preview'/);
  assert.match(productStateSource, /subscription: null/);
  assert.match(productStateSource, /hermesInstance: null/);
  assert.match(productStateSource, /connections: \[\]/);
  assert.match(productStateSource, /artifacts: \[\]/);
});

test('transient provisioning gates escalate after a prolonged stall', () => {
  // The timeout and the wording both live in @sidekick/shared so the browser
  // cannot drift from the phone; this only holds the phone to using them.
  assert.match(productStateSource, /PRODUCT_STATE_TRANSIENT_GATE_STALL_TIMEOUT_MS\s*=\s*PROVISIONING_STALL_TIMEOUT_MS/);
  assert.match(productStateSource, /transientGateEnteredAtRef/);
  // The watchdog owns a timer rather than re-reading the clock whenever `status`
  // happens to change. Borrowing the refresh poll as a heartbeat means the
  // escalation never fires at all if that poll ever goes quiet.
  const watchdog = sourceBetween(productStateSource, 'Defect #57', '// Defect #47');
  assert.match(watchdog, /const remaining = PRODUCT_STATE_TRANSIENT_GATE_STALL_TIMEOUT_MS - \(Date\.now\(\) - transientGateEnteredAtRef\.current\)/);
  assert.match(watchdog, /setTimeout\(\(\) => setProvisioningStalled\(true\), remaining\)/);
  assert.match(watchdog, /clearTimeout\(timer\)/);
  assert.doesNotMatch(watchdog, /\}, \[authState\.status, gate\.kind, status\]\)/);
  // Entering a transient gate must not reset the clock every render, and leaving
  // one must clear the flag, or a workspace that recovers stays "stalled".
  assert.match(watchdog, /transientGateEnteredAtRef\.current = null;\s*\n\s*setProvisioningStalled\(false\);/);
  // The escalation must NOT ride on `status`. The setup poll rewrites status
  // every few seconds, and the shell suppresses the error banner for anyone who
  // has ever loaded live data precisely to absorb that churn — which is every
  // user this watchdog can fire for, since it only fires from 'live'. Routing
  // the stall through status therefore reaches nobody on the phone.
  assert.doesNotMatch(productStateSource, /setErrorMessage\(PROVISIONING_STALLED_MESSAGE\)/);
  assert.match(productStateSource, /provisioningStalled: boolean;/);
  assert.match(productStateSource, /^\s*provisioningStalled,$/m);
});

test('the provisioning stall message reaches a surface the shell does not suppress', () => {
  // ProductStateNotice renders null for both loading and error once
  // suppressTransientLoading is set, so the stall has to land on the
  // provisioning notice, which is stable and always rendered during setup.
  assert.match(appSource, /function ProvisioningWaitNotice\(\{ gateKind, stalled = false \}/);
  assert.match(appSource, /testID="shell\.provisioningWaitNotice\.stalled"/);
  const noticeBody = sourceBetween(appSource, 'function ProvisioningWaitNotice', '\nfunction CheckoutThankYouBanner');
  assert.match(noticeBody, /\{PROVISIONING_STALLED_MESSAGE\}/);
  // And it has to actually be wired from the hook to the call site, or the
  // prop defaults to false forever and the escalation is dead code again.
  assert.match(appSource, /<ProvisioningWaitNotice gateKind=\{productGate\.kind\} stalled=\{productProvisioningStalled\} \/>/);
  assert.match(appSource, /productProvisioningStalled: boolean;/);
  assert.match(appSource, /productProvisioningStalled=\{productState\.provisioningStalled\}/);
});

test('every load is fenced by account and by generation, not just the mount effect', () => {
  // The defect: refresh() wrote its result unconditionally after its await, and
  // manual refresh and the transient provisioning poll both go through it. Two
  // loads for two accounts could be in flight and the slower one won. Executed
  // against the actual hook, account B finished, then account A finished, and
  // the signed-in account stayed B while the rendered profile became A.
  // Behaviour is executed in tests/e2e/product-state-fencing.test.mjs; this
  // holds the shape that makes it possible.
  assert.match(productStateSource, /const loadGeneration = useRef\(0\);/);
  assert.match(productStateSource, /const generation = \+\+loadGeneration\.current;/);
  assert.match(productStateSource, /const current = \(\) => generation === loadGeneration\.current;/);
  assert.match(productStateSource, /if \(!current\(\)\) return publishedRef\.current;/);
  // One load path. The effect used to carry its own copy with a `cancelled`
  // flag while refresh carried none, which is how the two drifted apart.
  const effects = (productStateSource.match(/createAuthenticatedFailClosedProductSnapshot\(authState\.user\)/g) ?? []).length;
  assert.ok(effects <= 3, 'the duplicated load body should be gone, not copied again');
  assert.match(productStateSource, /void refresh\(\);\n\s*\}, \[refresh\]\);/);
});

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker ${startMarker}`);
  assert.ok(end > start, `missing end marker ${endMarker}`);
  return source.slice(start, end);
}

test('first authenticated product-state failure stays in signed-in retry shell instead of login or setup', () => {
  // End marker is the module's single `export default` line. App.tsx wraps the
  // root component for crash reporting (`export default wrapWithSentry(App)`),
  // so we slice up to the default export rather than the older
  // `export default function App` form. Same AppContent region either way.
  const appContent = sourceBetween(appSource, 'function AppContent', '\nexport default ');
  const shellSource = sourceBetween(appSource, 'function Shell', 'type SidekickAppProps');

  assert.match(
    appContent,
    /const productStateReadyForShell = productState\.status === 'live'\s*\|\|\s*productState\.status === 'error';/,
    'an authenticated user must enter the signed-in shell on either live product state or a retryable product-state error',
  );
  assert.match(
    appContent,
    /const productStateIsAuthoritative = productState\.status === 'live';/,
    'only live product state is authoritative enough to route a user into onboarding/setup',
  );
  assert.match(
    appContent,
    /const initialAuthReadyForShell = authState\.status === 'authenticated' && productStateReadyForShell;/,
    'first signed-in render must use the retry-safe shell gate, not the live-only onboarding gate',
  );

  const needsOnboarding = sourceBetween(appContent, 'const needsOnboarding', 'const handleOnboardingComplete');
  assert.match(needsOnboarding, /productStateIsAuthoritative/);
  assert.doesNotMatch(needsOnboarding, /productStateReadyForShell/);

  const firstErrorBranch = shellSource.indexOf("if (productStatus === 'error' && !productEverLive)");
  const subscriptionSetupGate = shellSource.indexOf('if (appOpenPaywallOpen && !productView.hasActiveSubscription)');
  assert.ok(firstErrorBranch >= 0, 'Shell must have a first-load product-state error branch');
  assert.ok(subscriptionSetupGate >= 0, 'Shell subscription setup gate should still exist after first-error handling');
  assert.ok(
    firstErrorBranch < subscriptionSetupGate,
    'a first product-state error must render retry UI before the fail-closed snapshot can look unsubscribed and open setup',
  );
  assert.match(shellSource, /testID="shell\.productStateError"/);

  const preserving = (productStateSource.match(/publish\(publishedRef\.current\.profile\?\.id === authState\.user\.id \? publishedRef\.current : failClosedSnapshot\);/g) ?? []).length;
  assert.ok(
    preserving >= 2,
    'load/refresh error paths should preserve a same-user live snapshot instead of replacing it with an unsubscribed fail-closed snapshot',
  );
});
