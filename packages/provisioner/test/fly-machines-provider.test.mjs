// Series 4 — FlyMachinesProvider unit tests against a fake Fly Machines API.
//
// These tests run without network access. They cover:
//   - preflight blocking when FLY_API_TOKEN / FLY_ORG / FLY_PRIMARY_REGION
//     or SIDEKICK_RUNNER_PROVIDER are missing or set to the legacy provider.
//   - createRunner calls /apps, /apps/<name>/volumes, /apps/<name>/machines
//     in order with the expected body shapes.
//   - resource names use a deterministic hash suffix and never embed raw
//     user id / email.
//   - per-user env injection (SIDEKICK_USER_ID, SIDEKICK_RUNNER_SHARED_SECRET,
//     etc.) and explicit refusal to embed forbidden secret names.
//   - createRunner is idempotent enough to recover from "app already exists"
//     (HTTP 422 on /apps create).
//   - start / stop / delete (Option A vs. force teardown) call the right
//     Fly endpoints and never blow up if the resource is already gone.
//   - deleteRunner with force=false keeps the volume + app (Option A).
//   - errors from Fly do not leak the FLY_API_TOKEN into errorCode/message.
//   - The provider rejects bindings from another provider (no Railway
//     binding can ever be passed to FlyMachinesProvider methods).
import test from 'node:test';
import assert from 'node:assert/strict';
import { posix as posixPath } from 'node:path';

import {
  createFlyMachinesProvider,
  buildFlyRunnerEnv,
  flyRunnerRouteBEnabled,
  flyRunnerAutostop,
  flyRunnerAutostopForUser,
  normalizeAutostop,
  buildDelegentRunnerToolsets,
  flyMachinesAppName,
  FLY_MACHINES_API_BASE,
  FLY_WORKSPACE_MOUNT_PATH,
  FLY_VOLUME_MOUNT_PATH,
  FLY_RUNNER_INTERNAL_PORT,
  chooseVolumeSizeGb,
  storageEntitlementGb,
  nextVolumeSizeGb,
  START_VOLUME_SIZE_GB,
  STORAGE_GROW_AT_FRACTION,
  chooseComputeTier,
  DEFAULT_COMPUTE_TIER_BY_PLAN,
  deriveRunnerResourceSuffix,
  resolveActiveRunnerProviderId,
} from '../dist/index.js';

const FLY_TOKEN = 'FlyV1 fm2_test_token_value_that_must_not_leak_in_errors';
const FLY_ORG = 'personal';
const FLY_REGION = 'lhr';
const IMAGE_REF = 'registry.fly.io/delegent-hermes-runner@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const WORKER_URL = 'https://sidekick-worker-production.alex-coworker-ai.workers.dev';
const RUNNER_SECRET = 'rs_test_per_user_secret_32_chars_min_xyz';
const USER_A = '00000000-0000-4000-8000-000000000a01';
const USER_B = '00000000-0000-4000-8000-000000000b02';

function defaultCreateInput(overrides = {}) {
  return {
    userId: USER_A,
    tierId: 'studio',
    agentName: 'Nova',
    workerProxyUrl: WORKER_URL,
    runnerSharedSecret: RUNNER_SECRET,
    imageRef: IMAGE_REF,
    idempotencyKey: 'idempotency-key-aaaa',
    ...overrides,
  };
}

/**
 * Tiny request recorder + scripted-response fake of fetch for the Fly API.
 * Each call captures method + path + parsed JSON body so tests can assert
 * the exact request sequence the provider issued.
 */
const FLY_GRAPHQL_API = 'https://api.fly.io/graphql';

function makeFakeFly(scripts = {}, graphqlScripts = {}) {
  const calls = [];
  const graphqlCalls = [];
  function impl(url, init = {}) {
    // GraphQL endpoint — Series 4 uses it only for AllocateIpAddress.
    if (url === FLY_GRAPHQL_API) {
      const body = typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : null;
      graphqlCalls.push({ url, body, authorization: (init.headers ?? {}).authorization });
      const op = body?.variables?.type ?? 'unknown';
      const script = graphqlScripts[op] ?? { data: { allocateIpAddress: { ipAddress: { address: op === 'v6' ? 'fdaa::1' : '66.241.124.10', type: op } } } };
      const status = script.status ?? 200;
      const responseBody = script.body !== undefined ? script.body : script;
      return Promise.resolve(new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } }));
    }
    if (!url.startsWith(FLY_MACHINES_API_BASE)) {
      return Promise.resolve(new Response('not a fly call', { status: 500 }));
    }
    const path = url.slice(FLY_MACHINES_API_BASE.length);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : null;
    calls.push({ method, path, body, authorization: (init.headers ?? {}).authorization });
    const key = `${method} ${path.split('?')[0]}`;
    const script = scripts[key];
    if (!script) {
      return Promise.resolve(new Response(JSON.stringify({ error: `no script for ${key}` }), { status: 599, headers: { 'content-type': 'application/json' } }));
    }
    const next = typeof script === 'function' ? script({ method, path, body, call: calls.length - 1 }) : script;
    const status = next.status ?? 200;
    const responseBody = next.body !== undefined ? next.body : { ok: true };
    return Promise.resolve(new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } }));
  }
  return { fetchImpl: impl, calls, graphqlCalls };
}

async function happyScriptsFor(input = defaultCreateInput()) {
  // The Fly app name is derived from SHA-256(userId + idempotencyKey); compute
  // it once here so the scripted responses are keyed correctly regardless of
  // the specific user/key under test.
  const appName = await flyMachinesAppName(input, 'delegent-runner');
  return {
    appName,
    scripts: {
      'POST /apps': { status: 201, body: {} },
      [`POST /apps/${appName}/volumes`]: { status: 201, body: { id: 'vol_fixture_a', region: FLY_REGION, size_gb: 10 } },
      [`POST /apps/${appName}/machines`]: { status: 200, body: { id: 'machine_fixture_a', state: 'started', private_ip: 'fdaa::1' } },
    },
  };
}

function configFor(scripts, overrides = {}, graphqlScripts = {}) {
  const { fetchImpl, calls, graphqlCalls } = makeFakeFly(scripts, graphqlScripts);
  const config = {
    apiToken: FLY_TOKEN,
    org: FLY_ORG,
    primaryRegion: FLY_REGION,
    fetchImpl,
    probeRunnerHealth: async () => ({ ok: true, status: 200 }),
    now: () => new Date('2026-05-15T20:30:00Z'),
    sleep: async () => {},
    ...overrides,
  };
  return { config, calls, graphqlCalls };
}

// -----------------------------------------------------------------------------
// Resource naming + helpers
// -----------------------------------------------------------------------------

test('deriveRunnerResourceSuffix is deterministic + 12 hex chars', async () => {
  const a1 = await deriveRunnerResourceSuffix(USER_A, 'idempotency-key-aaaa');
  const a2 = await deriveRunnerResourceSuffix(USER_A, 'idempotency-key-aaaa');
  const aDiffKey = await deriveRunnerResourceSuffix(USER_A, 'idempotency-key-bbbb');
  const bSameKey = await deriveRunnerResourceSuffix(USER_B, 'idempotency-key-aaaa');
  assert.equal(a1, a2);
  assert.match(a1, /^[0-9a-f]{12}$/);
  assert.notEqual(a1, aDiffKey);
  assert.notEqual(a1, bSameKey);
});

test('flyMachinesAppName never embeds raw user id and uses the prefix', async () => {
  const name = await flyMachinesAppName(defaultCreateInput({ userId: USER_A }), 'delegent-runner');
  assert.match(name, /^delegent-runner-[0-9a-f]{12}$/);
  assert.equal(name.includes(USER_A), false);
  assert.equal(name.includes('email'), false);
  assert.ok(name.length <= 63);
});

test('buildFlyRunnerEnv injects per-user envs and refuses forbidden secret names', () => {
  const env = buildFlyRunnerEnv(defaultCreateInput());
  assert.equal(env.SIDEKICK_USER_ID, USER_A);
  assert.equal(env.SIDEKICK_RUNNER_SHARED_SECRET, RUNNER_SECRET);
  assert.equal(env.SIDEKICK_WORKER_PROXY_URL, WORKER_URL);
  assert.equal(env.SIDEKICK_WORKSPACE_DIR, FLY_WORKSPACE_MOUNT_PATH);
  assert.equal(env.SIDEKICK_ALLOW_UNSIGNED_HEALTH, 'true');
  assert.equal(env.SIDEKICK_RUNNER_PUBLIC_NAME, 'Nova');
  // Nothing else snuck in.
  for (const forbidden of ['FLY_API_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY', 'OPENROUTER_API_KEY', 'RAILWAY_API_TOKEN', 'SIDEKICK_TELEGRAM_BOT_TOKEN']) {
    assert.equal(forbidden in env, false, `${forbidden} must never be injected into a runner Machine`);
  }
});

// RAM ladder. This test used to enforce a 2GB "Chromium floor" on every tier so
// the headless browser would not OOM. **That floor was removed on 2026-08-06**
// along with Chromium itself, after checking every assistant message the product
// has ever produced and finding zero browser_* invocations. The floor was
// costing memory on every runner, every month, for a toolset nobody called.
//
// What this test now protects is the opposite risk: that someone quietly raises
// the ladder again without a reason, or lowers it below what Fly will accept.
test('the RAM ladder stays lean, and respects Fly guest minimums', () => {
  // Pin the values. A change here should be deliberate and explained.
  assert.equal(DEFAULT_COMPUTE_TIER_BY_PLAN['studio'].memoryMb, 1024);
  assert.equal(DEFAULT_COMPUTE_TIER_BY_PLAN['pro-office'].memoryMb, 2048);
  assert.equal(DEFAULT_COMPUTE_TIER_BY_PLAN['enterprise-suite'].memoryMb, 4096);

  // Fly rejects a guest below its per-CPU-class minimum with
  // "invalid_config_guest_memory", which is a provisioning failure in a
  // customer's face rather than a build error. shared: 256MB per CPU;
  // performance: 2048MB per CPU.
  for (const tierId of ['studio', 'pro-office', 'enterprise-suite']) {
    const tier = DEFAULT_COMPUTE_TIER_BY_PLAN[tierId];
    const perCpuMin = tier.cpuKind === 'performance' ? 2048 : 256;
    assert.ok(
      tier.memoryMb >= perCpuMin * tier.cpus,
      `${tierId}: ${tier.memoryMb}MB is below Fly's minimum of ${perCpuMin * tier.cpus}MB for ${tier.cpus} ${tier.cpuKind} CPUs`,
    );
  }

  // Nothing should need 2GB+ now that there is no browser. If a tier climbs
  // back over that, something reintroduced a heavy dependency and the memory
  // bill went with it. enterprise-suite is exempt: it is pinned at 4096 by
  // Fly's performance-CPU minimum, not by an appetite for RAM.
  for (const tierId of ['studio', 'pro-office']) {
    assert.ok(
      DEFAULT_COMPUTE_TIER_BY_PLAN[tierId].memoryMb <= 2048,
      `${tierId} has crept back up to ${DEFAULT_COMPUTE_TIER_BY_PLAN[tierId].memoryMb}MB. `
        + 'The 2GB floor was removed with Chromium on 2026-08-06; if something needs that memory again, '
        + 'say what and why, and check verify-golden-image.sh still asserts the image is browser-free.',
    );
  }

  // Unknown tier falls back to studio.
  assert.equal(chooseComputeTier({ tierId: 'unknown-tier' }).memoryMb, 1024);
});

// Regression guard for the 2026-05-30 capability-parity gap: buildFlyRunnerEnv
// (the LIVE path) used to never set HERMES_TOOLSETS, so every real runner fell
// back to server.py's minimal `file,web,terminal` default and browser /
// code_execution / memory / etc. stayed OFF for everyone. The un-tiering had
// landed only in the dead Railway path. These assertions are intentionally
// INDEPENDENT of DELEGENT_RUNNER_TOOLSETS (we pin the capabilities by name) so a
// future edit that quietly drops one is CAUGHT here rather than silently
// followed. Tiers differ only by compute + token allowance, never by toolset.
test('buildFlyRunnerEnv injects the FULL un-tiered Hermes toolset on every tier (no minimal fallback)', () => {
  const REQUIRED = [
    'file', 'web', 'search', 'terminal', 'process', 'code_execution',
    'memory', 'cronjob', 'vision', 'delegate_task', 'skills',
  ];
  // 2026-06-05: 'browser' (Chromium/agent-browser) intentionally dropped. It
  // rendered pages locally (slow) for little gain (interactive web is already
  // refused), and the product no longer claims interactive web browsing.
  // 'session_search' was also dropped on 2026-06-10, back when the live chat
  // path kept no resumable sessions and the tool always returned empty (the
  // agent would deny real stored history). Route B restored durable per-user
  // sessions, so it is expected again and is asserted below instead.
  const FORBIDDEN = ['browser'];
  for (const tierId of ['studio', 'pro-office', 'agency']) {
    const env = buildFlyRunnerEnv(defaultCreateInput({ tierId }));
    assert.ok(
      typeof env.HERMES_TOOLSETS === 'string' && env.HERMES_TOOLSETS.length > 0,
      `HERMES_TOOLSETS must be set on the Fly runner env for tier ${tierId} (else server.py falls back to file,web,terminal)`,
    );
    const got = env.HERMES_TOOLSETS.split(',').map((s) => s.trim());
    for (const toolset of REQUIRED) {
      assert.ok(
        got.includes(toolset),
        `tier ${tierId}: HERMES_TOOLSETS is missing "${toolset}" (got: ${env.HERMES_TOOLSETS})`,
      );
    }
    for (const toolset of FORBIDDEN) {
      assert.ok(
        !got.includes(toolset),
        `tier ${tierId}: HERMES_TOOLSETS must NOT include "${toolset}" (Chromium dropped 2026-06-05)`,
      );
    }
    assert.ok(
      got.includes('session_search'),
      `tier ${tierId}: Route B is on by default, so session_search must be present (got: ${env.HERMES_TOOLSETS})`,
    );
  }
});

// Route B (docs/CHAT_ROUTE_B_DESIGN.md): session_search + the delegent gateway
// platform are coupled to the operator flag, which now defaults ON because the
// cutover is complete. Setting it false-y is still an explicit kill switch.
test('normalizeAutostop: Fly returns boolean true/false for stop/off; normalize for comparison', () => {
  assert.equal(normalizeAutostop(true), 'stop', 'legacy boolean true == stop');
  assert.equal(normalizeAutostop(false), 'off', 'legacy boolean false == off');
  assert.equal(normalizeAutostop('suspend'), 'suspend', 'suspend round-trips as a string');
  assert.equal(normalizeAutostop('stop'), 'stop');
});

test('flyRunnerAutostop: defaults to stop (scale-to-zero, safe again via busy-aware keepalive); FLY_RUNNER_AUTOSTOP overrides to off/suspend', () => {
  const prev = process.env.FLY_RUNNER_AUTOSTOP;
  try {
    delete process.env.FLY_RUNNER_AUTOSTOP;
    assert.equal(flyRunnerAutostop(), 'stop', 'default is stop again since 2026-06-14: the runner busy-aware keepalive keeps Fly from stopping a machine mid-run, so scale-to-zero is safe');
    process.env.FLY_RUNNER_AUTOSTOP = 'off';
    assert.equal(flyRunnerAutostop(), 'off');
    process.env.FLY_RUNNER_AUTOSTOP = 'suspend';
    assert.equal(flyRunnerAutostop(), 'suspend');
    process.env.FLY_RUNNER_AUTOSTOP = 'garbage';
    assert.equal(flyRunnerAutostop(), 'stop', 'unknown value falls back to the default (stop)');
  } finally {
    if (prev === undefined) delete process.env.FLY_RUNNER_AUTOSTOP;
    else process.env.FLY_RUNNER_AUTOSTOP = prev;
  }
});

test('buildDelegentRunnerToolsets: session_search only on the Route B path', () => {
  const off = buildDelegentRunnerToolsets(false);
  assert.ok(!off.includes('session_search'), 'base toolset must NOT include session_search');
  assert.ok(off.includes('memory'), 'base toolset keeps the durable memory tool');
  const on = buildDelegentRunnerToolsets(true);
  assert.ok(on.includes('session_search'), 'Route B toolset adds session_search');
  // additive, not a replacement — every base tool survives.
  for (const t of off) assert.ok(on.includes(t), `Route B toolset must keep base tool "${t}"`);
});

test('buildFlyRunnerEnv: Route B platform flag is ON by default (cutover complete), and stays an explicit kill switch', () => {
  const prev = process.env.SIDEKICK_DELEGENT_PLATFORM_ENABLED;
  try {
    // An operator env without the flag must still produce a Route B machine.
    // Provisioning without it created boxes that accepted messages and never
    // replied (relay=log-only, no user allowlist).
    delete process.env.SIDEKICK_DELEGENT_PLATFORM_ENABLED;
    assert.equal(flyRunnerRouteBEnabled(), true);
    const defaultEnv = buildFlyRunnerEnv(defaultCreateInput());
    assert.equal(defaultEnv.DELEGENT_PLATFORM_ENABLED, 'true', 'platform must be on by default');
    assert.ok(defaultEnv.HERMES_TOOLSETS.split(',').includes('session_search'), 'default adds session_search');

    process.env.SIDEKICK_DELEGENT_PLATFORM_ENABLED = 'true';
    assert.equal(flyRunnerRouteBEnabled(), true);
    const onEnv = buildFlyRunnerEnv(defaultCreateInput());
    assert.equal(onEnv.DELEGENT_PLATFORM_ENABLED, 'true', 'Route B sets DELEGENT_PLATFORM_ENABLED');
    assert.ok(onEnv.HERMES_TOOLSETS.split(',').includes('session_search'), 'Route B adds session_search');
    // The runner derives DELEGENT_RELAY_URL itself (loopback ingest); the
    // provisioner must NOT bake a relay URL or extra secret in.
    assert.equal('DELEGENT_RELAY_URL' in onEnv, false, 'relay URL is runner-derived, not provisioned');

    process.env.SIDEKICK_DELEGENT_PLATFORM_ENABLED = 'false';
    assert.equal(flyRunnerRouteBEnabled(), false);
    const offEnv = buildFlyRunnerEnv(defaultCreateInput());
    assert.equal('DELEGENT_PLATFORM_ENABLED' in offEnv, false, 'explicit false still disables');
    assert.ok(!offEnv.HERMES_TOOLSETS.split(',').includes('session_search'), 'explicit false drops session_search');
  } finally {
    if (prev === undefined) delete process.env.SIDEKICK_DELEGENT_PLATFORM_ENABLED;
    else process.env.SIDEKICK_DELEGENT_PLATFORM_ENABLED = prev;
  }
});

// 2026-06-03 bug #2 guard. The operator reported the agent "couldn't reach the
// internet". RCA proved the opposite: Fly egress is fully open and verified from
// inside the box (github/pypi/google all 200; urllib/requests/httpx all download).
// The ONE way we could silently break that is by injecting a TRANSPARENT proxy env
// that hijacks every outbound request from the agent's web/download tools.
// SIDEKICK_WORKER_PROXY_URL is a model-call ENDPOINT the runner explicitly POSTs to,
// not a transparent proxy. This guards that buildFlyRunnerEnv never sets an
// HTTP(S)_PROXY / ALL_PROXY / NO_PROXY env — so the coworker keeps full internet.
test('buildFlyRunnerEnv: no transparent egress proxy — the agent keeps FULL internet access (bug #2 guard)', () => {
  const env = buildFlyRunnerEnv(defaultCreateInput());
  const proxyKeys = Object.keys(env).filter((k) => /^(https?|all|no)_proxy$/i.test(k));
  assert.deepEqual(
    proxyKeys,
    [],
    `buildFlyRunnerEnv injected an egress-proxy env that would hijack the agent's internet: ${proxyKeys.join(', ')}`,
  );
  // The worker proxy URL must remain a plain model-call endpoint, never a proxy directive.
  assert.equal(env.SIDEKICK_WORKER_PROXY_URL, WORKER_URL);
});

// 2026-06-04: web-search provider config (Firecrawl etc.) passthrough — enables
// Hermes' `web` toolset (web_search/web_extract). §24. Provider-agnostic + swappable.
test('buildFlyRunnerEnv: passes through web-search provider config when set, skips when absent', () => {
  const keys = ['FIRECRAWL_API_URL', 'FIRECRAWL_API_KEY', 'SEARXNG_URL', 'TAVILY_API_KEY', 'EXA_API_KEY', 'PARALLEL_API_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    const envEmpty = buildFlyRunnerEnv(defaultCreateInput());
    for (const k of keys) assert.equal(k in envEmpty, false, `${k} must NOT be injected when unset (web stays gated, but no junk env)`);

    process.env.FIRECRAWL_API_URL = 'https://firecrawl.internal.example';
    process.env.FIRECRAWL_API_KEY = 'fc-test-123';
    const env = buildFlyRunnerEnv(defaultCreateInput());
    assert.equal(env.FIRECRAWL_API_URL, 'https://firecrawl.internal.example', 'self-host URL must reach the runner so web_search loads');
    assert.equal(env.FIRECRAWL_API_KEY, 'fc-test-123');
    assert.equal('TAVILY_API_KEY' in env, false, 'unset providers stay absent (swappable by config)');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('storageEntitlementGb is the per-tier cap, unchanged by small-start provisioning', () => {
  // Internal provisioning sizing (PlanTier.storageGb); not shown to users.
  assert.equal(storageEntitlementGb('studio'), 10);
  assert.equal(storageEntitlementGb('pro-office'), 40);
  assert.equal(storageEntitlementGb('enterprise-suite'), 100);
});

test('chooseVolumeSizeGb starts every new volume small and respects an explicit override', () => {
  // We pay for provisioned GB, so a new runner starts at START_VOLUME_SIZE_GB
  // regardless of tier and auto-grows toward its entitlement.
  assert.equal(START_VOLUME_SIZE_GB, 3);
  assert.equal(chooseVolumeSizeGb(defaultCreateInput({ tierId: 'studio' })), 3);
  assert.equal(chooseVolumeSizeGb(defaultCreateInput({ tierId: 'pro-office' })), 3);
  assert.equal(chooseVolumeSizeGb(defaultCreateInput({ tierId: 'enterprise-suite' })), 3);
  assert.equal(chooseVolumeSizeGb(defaultCreateInput({ tierId: 'studio', volumeSizeGb: 42 })), 42);
});

test('resolveActiveRunnerProviderId defaults to fly_machines and only opts into railway_legacy explicitly', () => {
  assert.equal(resolveActiveRunnerProviderId({}), 'fly_machines');
  assert.equal(resolveActiveRunnerProviderId({ SIDEKICK_RUNNER_PROVIDER: 'fly_machines' }), 'fly_machines');
  assert.equal(resolveActiveRunnerProviderId({ SIDEKICK_RUNNER_PROVIDER: 'something_else' }), 'fly_machines');
  assert.equal(resolveActiveRunnerProviderId({ SIDEKICK_RUNNER_PROVIDER: 'railway_legacy' }), 'railway_legacy');
  assert.equal(resolveActiveRunnerProviderId({ SIDEKICK_RUNNER_PROVIDER: 'RAILWAY_LEGACY' }), 'railway_legacy');
});

// -----------------------------------------------------------------------------
// preflight
// -----------------------------------------------------------------------------

test('preflight fails when FLY_API_TOKEN is missing', () => {
  const { config } = configFor({});
  const provider = createFlyMachinesProvider(config);
  const report = provider.preflight({
    FLY_ORG: FLY_ORG,
    FLY_PRIMARY_REGION: FLY_REGION,
    SIDEKICK_RUNNER_PROVIDER: 'fly_machines',
    FLY_REQUIRE_DEDICATED_RUNNER: 'true',
  });
  assert.equal(report.providerId, 'fly_machines');
  assert.equal(report.ok, false);
  assert.deepEqual([...report.missingSecrets], ['FLY_API_TOKEN']);
});

test('preflight fails when FLY_ORG or FLY_PRIMARY_REGION is missing', () => {
  const { config } = configFor({});
  const provider = createFlyMachinesProvider(config);
  const report = provider.preflight({
    FLY_API_TOKEN: FLY_TOKEN,
    SIDEKICK_RUNNER_PROVIDER: 'fly_machines',
  });
  assert.equal(report.ok, false);
  assert.ok([...report.missingVariables].includes('FLY_ORG'));
  assert.ok([...report.missingVariables].includes('FLY_PRIMARY_REGION'));
});

test('preflight fails when SIDEKICK_RUNNER_PROVIDER is set to railway_legacy', () => {
  const { config } = configFor({});
  const provider = createFlyMachinesProvider(config);
  const report = provider.preflight({
    FLY_API_TOKEN: FLY_TOKEN,
    FLY_ORG, FLY_PRIMARY_REGION: FLY_REGION,
    SIDEKICK_RUNNER_PROVIDER: 'railway_legacy',
  });
  assert.equal(report.ok, false);
  const providerCheck = report.checks.find((c) => c.id === 'sidekick_runner_provider_is_fly_machines');
  assert.equal(providerCheck.ok, false);
});

test('preflight passes with full env and warns when FLY_REQUIRE_DEDICATED_RUNNER is not true', () => {
  const { config } = configFor({});
  const provider = createFlyMachinesProvider(config);
  const okReport = provider.preflight({
    FLY_API_TOKEN: FLY_TOKEN,
    FLY_ORG, FLY_PRIMARY_REGION: FLY_REGION,
    SIDEKICK_RUNNER_PROVIDER: 'fly_machines',
    FLY_REQUIRE_DEDICATED_RUNNER: 'true',
  });
  assert.equal(okReport.ok, true);
  assert.equal(okReport.checks.every((c) => c.ok), true);

  const warnReport = provider.preflight({
    FLY_API_TOKEN: FLY_TOKEN,
    FLY_ORG, FLY_PRIMARY_REGION: FLY_REGION,
    SIDEKICK_RUNNER_PROVIDER: 'fly_machines',
    FLY_REQUIRE_DEDICATED_RUNNER: 'false',
  });
  // Blocking checks all pass; warning surfaces in the per-check list.
  assert.equal(warnReport.ok, true);
  const warn = warnReport.checks.find((c) => c.id === 'fly_require_dedicated_runner');
  assert.equal(warn.ok, false);
  assert.equal(warn.severity, 'warning');
});

// -----------------------------------------------------------------------------
// createRunner — request shape + idempotency
// -----------------------------------------------------------------------------

test('createRunner calls /apps -> /volumes -> /machines with expected bodies and per-user env', async () => {
  const { scripts } = await happyScriptsFor();
  const { config, calls } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  const binding = await provider.createRunner(defaultCreateInput());

  assert.equal(binding.providerId, 'fly_machines');
  assert.equal(binding.userId, USER_A);
  assert.equal(binding.runnerSharedSecret, RUNNER_SECRET);
  assert.equal(binding.fly.org, FLY_ORG);
  assert.equal(binding.fly.region, FLY_REGION);
  assert.match(binding.fly.appName, /^delegent-runner-[0-9a-f]{12}$/);
  assert.equal(binding.fly.machineId, 'machine_fixture_a');
  assert.equal(binding.fly.volumeId, 'vol_fixture_a');
  assert.equal(binding.runnerBaseUrl, `https://${binding.fly.appName}.fly.dev`);
  assert.equal(binding.status, 'ready'); // health probe succeeded

  // Exactly 3 Fly calls in the expected order.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`), [
    'POST /apps',
    `POST /apps/${binding.fly.appName}/volumes`,
    `POST /apps/${binding.fly.appName}/machines`,
  ]);

  // /apps body
  assert.equal(calls[0].body.app_name, binding.fly.appName);
  assert.equal(calls[0].body.org_slug, FLY_ORG);
  assert.equal(calls[0].body.network, binding.fly.appName); // #28 — per-app isolated 6PN network, not shared 'default'

  // /volumes body — small start size (auto-grow takes it to the cap), region passed through
  assert.equal(calls[1].body.region, FLY_REGION);
  assert.equal(calls[1].body.size_gb, START_VOLUME_SIZE_GB);
  assert.equal(calls[1].body.name, 'workspace');

  // /machines body — image, env, ports, mounts, healthcheck
  const machineBody = calls[2].body;
  assert.equal(machineBody.region, FLY_REGION);
  assert.equal(machineBody.config.image, IMAGE_REF);
  assert.equal(machineBody.config.env.SIDEKICK_USER_ID, USER_A);
  assert.equal(machineBody.config.env.SIDEKICK_RUNNER_SHARED_SECRET, RUNNER_SECRET);
  assert.equal(machineBody.config.env.SIDEKICK_WORKSPACE_DIR, FLY_WORKSPACE_MOUNT_PATH);
  assert.equal(machineBody.config.mounts[0].volume, 'vol_fixture_a');
  // 2026-06-11 durable-store fix: the volume mounts at HERMES_HOME (= /data/hermes),
  // NOT the workspace subdir. This is what puts Hermes' state.db / memories /
  // sessions on the persistent volume instead of ephemeral container disk.
  assert.equal(machineBody.config.mounts[0].path, FLY_VOLUME_MOUNT_PATH);
  const effectiveHermesHome = machineBody.config.env.HERMES_HOME ?? '/data/hermes';
  assert.equal(
    effectiveHermesHome,
    machineBody.config.mounts[0].path,
    'Fly volume must mount at HERMES_HOME so state.db/memories/sessions are durable (not ephemeral)',
  );
  assert.equal(
    posixPath.join(effectiveHermesHome, 'workspace'),
    FLY_WORKSPACE_MOUNT_PATH,
    'the workspace (Files tab / /files API) is a subdir on the volume, under HERMES_HOME',
  );
  assert.equal(machineBody.config.services[0].internal_port, FLY_RUNNER_INTERNAL_PORT);
  assert.equal(machineBody.config.checks.healthz.path, '/healthz');

  // Cost control: default autostop=stop (scale-to-zero when idle). Safe again
  // since 2026-06-14 — the runner's busy-aware keepalive keeps the Fly proxy's
  // idle timer alive while a run is in flight, so Fly can't stop a machine
  // mid-run. Auto-start stays on. FLY_RUNNER_AUTOSTOP=off|suspend overrides. See
  // flyRunnerAutostop.
  assert.equal(machineBody.config.services[0].autostop, 'stop');
  assert.equal(machineBody.config.services[0].autostart, true);
  // A new studio runner is created at the post-Chromium size. The old assertion
  // here demanded >= 2GB for the headless browser; that floor went with Chromium
  // on 2026-08-06 (zero browser_* calls in the product's entire history), so
  // this now pins the lean value instead. defaultCreateInput is the studio tier.
  assert.equal(machineBody.config.guest.memory_mb, 1024);
  // Inference model is pinned explicitly (not openrouter/auto); luna-pro
  // since 2026-08-04 evening (vision restored after the text-only DeepSeek
  // defect, then raised a tier for agentic capability at the same warm cost).
  assert.equal(machineBody.config.env.HERMES_MODEL, 'openai/gpt-6-luna');

  // Forbidden secret names never appear in the machine env we sent.
  for (const forbidden of ['FLY_API_TOKEN', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENROUTER_API_KEY']) {
    assert.equal(forbidden in machineBody.config.env, false);
  }

  // Authorization header carries the token; nothing in the response body
  // serialisation echoes it back into the binding.
  for (const call of calls) {
    assert.equal(call.authorization, `Bearer ${FLY_TOKEN}`);
  }
  assert.equal(JSON.stringify(binding).includes(FLY_TOKEN), false);
});

test('createRunner on a retry (app already exists) REUSES the existing volume + machine — no duplicate create (#11)', async () => {
  // A prior attempt created the app + volume + machine but failed before the
  // binding was recorded, so the lease was re-claimed and createRunner runs
  // again. It must reuse those resources, not leak a second 10-100 GB volume
  // (and a second machine) every retry.
  const input = defaultCreateInput();
  const appName = await flyMachinesAppName(input, 'delegent-runner');
  const scripts = {
    'POST /apps': { status: 422, body: { error: 'app already exists' } },
    [`GET /apps/${appName}/volumes`]: { status: 200, body: [{ id: 'vol_existing', name: 'workspace', region: FLY_REGION, size_gb: 10, state: 'created' }] },
    [`GET /apps/${appName}/machines`]: { status: 200, body: [{ id: 'machine_existing', state: 'started', config: { image: IMAGE_REF, env: { SIDEKICK_USER_ID: USER_A, SIDEKICK_RUNNER_SHARED_SECRET: RUNNER_SECRET }, mounts: [{ volume: 'vol_existing', path: FLY_VOLUME_MOUNT_PATH }] } }] },
    // These would only be hit by the buggy duplicate-create path; the asserts
    // below prove they are NOT called.
    [`POST /apps/${appName}/volumes`]: { status: 201, body: { id: 'vol_LEAKED_DUPLICATE' } },
    [`POST /apps/${appName}/machines`]: { status: 200, body: { id: 'machine_LEAKED_DUPLICATE' } },
  };
  const { config, calls } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  const binding = await provider.createRunner(input);

  assert.equal(binding.fly.volumeId, 'vol_existing', 'must reuse the existing volume');
  assert.equal(binding.fly.machineId, 'machine_existing', 'must reuse the existing machine');

  const posted = calls.filter((c) => c.method === 'POST').map((c) => c.path.split('?')[0]);
  assert.equal(posted.includes(`/apps/${appName}/volumes`), false, 'must NOT POST a duplicate volume on retry');
  assert.equal(posted.includes(`/apps/${appName}/machines`), false, 'must NOT POST a duplicate machine on retry');

  const got = calls.filter((c) => c.method === 'GET').map((c) => c.path.split('?')[0]);
  assert.ok(got.includes(`/apps/${appName}/volumes`), 'discovers the existing volume via GET');
  assert.ok(got.includes(`/apps/${appName}/machines`), 'discovers the existing machine via GET');
});

test('createRunner on a retry keeps the REUSED machine\'s baked-in shared secret, not the fresh one (#111)', async () => {
  // The lifecycle mints a fresh runnerSharedSecret on every provisioning
  // attempt, but a reused machine still carries the env injected when IT was
  // created. Persisting the fresh secret would leave the DB and the machine
  // disagreeing — every HMAC-signed runner→Worker call would then fail. The
  // binding must surface the machine's own secret.
  const OLD_SECRET = 'rs_old_secret_baked_into_machine_env_32c';
  const input = defaultCreateInput();
  const appName = await flyMachinesAppName(input, 'delegent-runner');
  const scripts = {
    'POST /apps': { status: 422, body: { error: 'app already exists' } },
    [`GET /apps/${appName}/volumes`]: { status: 200, body: [{ id: 'vol_existing', name: 'workspace', region: FLY_REGION, size_gb: 10, state: 'created' }] },
    [`GET /apps/${appName}/machines`]: {
      status: 200,
      body: [{
        id: 'machine_existing',
        state: 'stopped',
        config: { image: IMAGE_REF, env: { SIDEKICK_USER_ID: USER_A, SIDEKICK_RUNNER_SHARED_SECRET: OLD_SECRET }, mounts: [{ volume: 'vol_existing', path: FLY_VOLUME_MOUNT_PATH }] },
      }],
    },
  };
  const { config } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  const binding = await provider.createRunner(input);

  assert.equal(binding.fly.machineId, 'machine_existing');
  assert.equal(binding.runnerSharedSecret, OLD_SECRET, 'must persist the secret the machine actually signs with');
  assert.notEqual(binding.runnerSharedSecret, RUNNER_SECRET);
});

test('createRunner refuses a reused machine without verifiable identity, mount and secret', async () => {
  const input = defaultCreateInput();
  const appName = await flyMachinesAppName(input, 'delegent-runner');
  const scripts = {
    'POST /apps': { status: 422, body: { error: 'app already exists' } },
    [`GET /apps/${appName}/volumes`]: { status: 200, body: [{ id: 'vol_existing', name: 'workspace', region: FLY_REGION, size_gb: 10, state: 'created' }] },
    [`GET /apps/${appName}/machines`]: { status: 200, body: [{ id: 'machine_existing', state: 'started' }] },
  };
  const { config } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  await assert.rejects(provider.createRunner(input), /invalid_machine_binding/);
});

test('retry uses the actual mounted disk and image even when another workspace volume appears first', async () => {
  const input = defaultCreateInput();
  const app = await flyMachinesAppName(input, 'delegent-runner');
  const actualImage = 'registry.fly.io/runner@sha256:actual';
  const machine = { id: 'm_actual', state: 'started', region: 'ams', config: {
    image: actualImage,
    env: { SIDEKICK_USER_ID: USER_A, SIDEKICK_RUNNER_SHARED_SECRET: RUNNER_SECRET },
    mounts: [{ path: FLY_VOLUME_MOUNT_PATH, volume: 'vol_actual' }],
  } };
  const volume = { name: 'workspace', state: 'created', region: 'ams', size_gb: 3 };
  const { config, calls } = configFor({
    'POST /apps': { status: 422, body: {} },
    [`GET /apps/${app}/machines`]: { body: [machine] },
    [`GET /apps/${app}/volumes`]: { body: [
      { ...volume, id: 'vol_pending', state: 'pending_destroy' },
      { ...volume, id: 'vol_unattached' },
      { ...volume, id: 'vol_actual', attached_machine_id: machine.id },
    ] },
  });
  const binding = await createFlyMachinesProvider(config).createRunner(input);
  assert.equal(binding.fly.volumeId, 'vol_actual');
  assert.equal(binding.fly.imageRef, actualImage);
  assert.equal(binding.fly.imageDigest, 'sha256:actual');
  assert.equal(binding.fly.region, 'ams');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
});

test('retry never creates a resource when machine or volume inventory is unavailable', async () => {
  const input = defaultCreateInput();
  const app = await flyMachinesAppName(input, 'delegent-runner');
  for (const failed of ['machines', 'volumes']) {
    const { config, calls } = configFor({
      'POST /apps': { status: 422, body: {} },
      [`GET /apps/${app}/machines`]: { status: failed === 'machines' ? 503 : 200, body: [] },
      [`GET /apps/${app}/volumes`]: { status: failed === 'volumes' ? 503 : 200, body: [] },
    });
    await assert.rejects(createFlyMachinesProvider(config).createRunner(input), /inventory_unavailable/);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  }
});

test('retry refuses a mounted pending-destroy volume or another account identity', async () => {
  const input = defaultCreateInput();
  const app = await flyMachinesAppName(input, 'delegent-runner');
  for (const invalid of ['volume', 'owner']) {
    const { config } = configFor({
      'POST /apps': { status: 422, body: {} },
      [`GET /apps/${app}/machines`]: { body: [{ id: 'm', state: 'started', config: {
        image: IMAGE_REF, mounts: [{ path: FLY_VOLUME_MOUNT_PATH, volume: 'v' }],
        env: { SIDEKICK_USER_ID: invalid === 'owner' ? USER_B : USER_A, SIDEKICK_RUNNER_SHARED_SECRET: RUNNER_SECRET },
      } }] },
      [`GET /apps/${app}/volumes`]: { body: [{ id: 'v', name: 'workspace', region: FLY_REGION, state: invalid === 'volume' ? 'pending_destroy' : 'created' }] },
    });
    await assert.rejects(createFlyMachinesProvider(config).createRunner(input), /invalid_machine_binding/);
  }
});

test('createRunner allocates a shared_v4 + v6 public IP after app create (so <app>.fly.dev resolves)', async () => {
  // Apps created via the Machines API don't auto-allocate public IPs.
  // Without this step the Machine boots and Fly's internal /healthz check
  // passes, but the public <app>.fly.dev hostname never resolves to it.
  // This test pins the requirement.
  const { scripts } = await happyScriptsFor();
  const { config, calls, graphqlCalls } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  const binding = await provider.createRunner(defaultCreateInput());

  // Two GraphQL allocate calls, one for v4 and one for v6, in order.
  const allocateTypes = graphqlCalls
    .filter((c) => /AllocateIpAddress/.test(c.body?.query ?? ''))
    .map((c) => c.body.variables.type);
  assert.deepEqual(allocateTypes, ['shared_v4', 'v6']);

  // Each allocate call references the app we just created.
  for (const c of graphqlCalls) {
    assert.equal(c.body.variables.appId, binding.fly.appName);
    assert.equal(c.authorization, `Bearer ${FLY_TOKEN}`);
  }

  // The IP allocation MUST happen after app create and BEFORE volume/machine
  // create (otherwise the Machine would be created without ingress wired up,
  // matching the live-smoke failure mode we caught).
  const appCreateIdx = calls.findIndex((c) => c.path === '/apps' && c.method === 'POST');
  const volumeCreateIdx = calls.findIndex((c) => c.path.endsWith('/volumes') && c.method === 'POST');
  assert.ok(appCreateIdx >= 0 && volumeCreateIdx > appCreateIdx);
});

test('createRunner tolerates "already allocated" from Fly when re-resuming a partially-provisioned app', async () => {
  const { scripts } = await happyScriptsFor();
  const graphqlScripts = {
    shared_v4: { status: 200, body: { errors: [{ message: 'IP already allocated for this app' }] } },
    v6: { status: 200, body: { errors: [{ message: 'IP already allocated for this app' }] } },
  };
  const { config, graphqlCalls } = configFor(scripts, {}, graphqlScripts);
  const provider = createFlyMachinesProvider(config);
  // No throw — both allocations report "already allocated" and createRunner
  // treats that as success.
  const binding = await provider.createRunner(defaultCreateInput());
  assert.equal(binding.providerId, 'fly_machines');
  assert.equal(graphqlCalls.length, 2);
});

test('createRunner fails closed when IP allocation returns a non-idempotent error', async () => {
  const { scripts } = await happyScriptsFor();
  const graphqlScripts = {
    shared_v4: { status: 200, body: { errors: [{ message: 'organization quota exceeded' }] } },
  };
  const { config } = configFor(scripts, {}, graphqlScripts);
  const provider = createFlyMachinesProvider(config);
  await assert.rejects(
    () => provider.createRunner(defaultCreateInput()),
    /fly_app_ip_allocation_failed/,
  );
});

test('createRunner produces distinct app names + machine ids for two different users', async () => {
  // User A scripts (suffix derived from USER_A + key 'idemp-A')
  const suffixA = await deriveRunnerResourceSuffix(USER_A, 'idemp-A');
  const suffixB = await deriveRunnerResourceSuffix(USER_B, 'idemp-B');
  const appNameA = `delegent-runner-${suffixA}`;
  const appNameB = `delegent-runner-${suffixB}`;

  const scripts = {
    'POST /apps': { status: 201, body: {} },
    [`POST /apps/${appNameA}/volumes`]: { status: 201, body: { id: 'vol_a', region: FLY_REGION, size_gb: 10 } },
    [`POST /apps/${appNameA}/machines`]: { status: 200, body: { id: 'machine_a' } },
    [`POST /apps/${appNameB}/volumes`]: { status: 201, body: { id: 'vol_b', region: FLY_REGION, size_gb: 25 } },
    [`POST /apps/${appNameB}/machines`]: { status: 200, body: { id: 'machine_b' } },
  };
  const { config } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  const a = await provider.createRunner(defaultCreateInput({ userId: USER_A, idempotencyKey: 'idemp-A' }));
  const b = await provider.createRunner(defaultCreateInput({ userId: USER_B, idempotencyKey: 'idemp-B', tierId: 'pro-office', runnerSharedSecret: 'rs_test_per_user_secret_for_user_b_x' }));

  assert.notEqual(a.fly.appName, b.fly.appName);
  assert.notEqual(a.fly.machineId, b.fly.machineId);
  assert.notEqual(a.fly.volumeId, b.fly.volumeId);
  assert.notEqual(a.runnerSharedSecret, b.runnerSharedSecret);
  assert.notEqual(a.runnerBaseUrl, b.runnerBaseUrl);
});

test('createRunner treats "app already exists" (HTTP 422) as a retryable resume — checks for existing resources, then creates the missing ones', async () => {
  const input = defaultCreateInput();
  const appName = await flyMachinesAppName(input, 'delegent-runner');
  const scripts = {
    'POST /apps': { status: 422, body: { error: 'app already exists' } },
    // A prior attempt created the app but nothing else, so the reuse GETs find
    // nothing and createRunner creates the missing volume + machine.
    [`GET /apps/${appName}/volumes`]: { status: 200, body: [] },
    [`GET /apps/${appName}/machines`]: { status: 200, body: [] },
    [`POST /apps/${appName}/volumes`]: { status: 201, body: { id: 'vol_resume', region: FLY_REGION, size_gb: 10 } },
    [`POST /apps/${appName}/machines`]: { status: 200, body: { id: 'machine_resume' } },
  };
  const { config, calls } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  const binding = await provider.createRunner(input);
  assert.equal(binding.fly.machineId, 'machine_resume');
  assert.equal(binding.fly.volumeId, 'vol_resume');
  // On a 422 resume it GETs (reuse check) then POSTs (create the missing ones) —
  // it did not bail, and (because the GETs were empty) did not skip the create.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`), [
    'POST /apps',
    `GET /apps/${appName}/machines`,
    `GET /apps/${appName}/volumes`,
    `POST /apps/${appName}/volumes`,
    `POST /apps/${appName}/machines`,
  ]);
});

test('createRunner reports provisioning when post-create /healthz probe never returns ok', async () => {
  const { scripts } = await happyScriptsFor();
  const { config } = configFor(scripts, { probeRunnerHealth: async () => ({ ok: false, status: 503 }) });
  const provider = createFlyMachinesProvider(config);
  const binding = await provider.createRunner(defaultCreateInput());
  assert.equal(binding.status, 'provisioning');
  assert.equal(binding.lastHealthAt, null);
});

test('createRunner rejects short runnerSharedSecret', async () => {
  const { scripts } = await happyScriptsFor();
  const { config } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  await assert.rejects(
    () => provider.createRunner(defaultCreateInput({ runnerSharedSecret: 'too-short' })),
    /fly_create_runner_shared_secret_too_short/,
  );
});

test('createRunner rejects http (non-https) worker proxy URL', async () => {
  const { scripts } = await happyScriptsFor();
  const { config } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  await assert.rejects(
    () => provider.createRunner(defaultCreateInput({ workerProxyUrl: 'http://insecure.example.com' })),
    /fly_create_runner_worker_proxy_url_must_be_https/,
  );
});

test('createRunner rejects empty imageRef and empty userId / idempotencyKey', async () => {
  const { scripts } = await happyScriptsFor();
  const { config } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  await assert.rejects(() => provider.createRunner(defaultCreateInput({ imageRef: null })), /fly_create_runner_missing_image_ref/);
  await assert.rejects(() => provider.createRunner(defaultCreateInput({ userId: '' })), /fly_create_runner_missing_user_id/);
  await assert.rejects(() => provider.createRunner(defaultCreateInput({ idempotencyKey: '' })), /fly_create_runner_missing_idempotency_key/);
});

// -----------------------------------------------------------------------------
// start / stop
// -----------------------------------------------------------------------------

async function bindingFor(scripts) {
  const { config } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  return { provider, binding: await provider.createRunner(defaultCreateInput()) };
}

test('startRunner calls the Machine start endpoint and reports ok', async () => {
  const { provider, binding } = await bindingFor((await happyScriptsFor()).scripts);
  const startScripts = {
    [`POST /apps/${binding.fly.appName}/machines/${binding.fly.machineId}/start`]: { status: 200, body: { state: 'started' } },
  };
  const { config: startConfig, calls } = configFor(startScripts);
  const startProvider = createFlyMachinesProvider(startConfig);
  const result = await startProvider.startRunner(binding);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/apps/${binding.fly.appName}/machines/${binding.fly.machineId}/start`);
});

test('stopRunner calls the Machine stop endpoint and reports ok', async () => {
  const { provider, binding } = await bindingFor((await happyScriptsFor()).scripts);
  const stopScripts = {
    [`POST /apps/${binding.fly.appName}/machines/${binding.fly.machineId}/stop`]: { status: 200, body: { state: 'stopped' } },
  };
  const { config: stopConfig, calls } = configFor(stopScripts);
  const stopProvider = createFlyMachinesProvider(stopConfig);
  const result = await stopProvider.stopRunner(binding);
  assert.equal(result.ok, true);
  assert.equal(calls[0].path, `/apps/${binding.fly.appName}/machines/${binding.fly.machineId}/stop`);
});

// -----------------------------------------------------------------------------
// getStorageUsage — volume block accounting
// -----------------------------------------------------------------------------

test('getStorageUsage derives used bytes from the volume block accounting', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const usageScripts = {
    [`GET /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`]: {
      status: 200,
      body: { id: binding.fly.volumeId, size_gb: 10, blocks: 2_621_440, blocks_free: 2_558_976, block_size: 4096 },
    },
  };
  const { config, calls } = configFor(usageScripts);
  const result = await createFlyMachinesProvider(config).getStorageUsage(binding);
  assert.equal(result.ok, true);
  assert.equal(result.usedBytes, (2_621_440 - 2_558_976) * 4096);
  assert.equal(result.capacityBytes, 2_621_440 * 4096);
  // Read-only: exactly one GET, and nothing that could restart the machine.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`), [
    `GET /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`,
  ]);
});

test('getStorageUsage reports unavailable when the volume has no block accounting', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const usageScripts = {
    [`GET /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`]: {
      status: 200,
      body: { id: binding.fly.volumeId, size_gb: 10 },
    },
  };
  const { config } = configFor(usageScripts);
  const result = await createFlyMachinesProvider(config).getStorageUsage(binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fly_volume_usage_unavailable');
});

test('getStorageUsage surfaces a non-200 without leaking the Fly token', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const usageScripts = {
    [`GET /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`]: { status: 404, body: { error: 'not found' } },
  };
  const { config } = configFor(usageScripts);
  const result = await createFlyMachinesProvider(config).getStorageUsage(binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fly_volume_usage_failed_404');
  assert.ok(!result.reason.includes(FLY_TOKEN));
});

test('getStorageUsage reports unavailable while a just-extended volume reports zero blocks', async () => {
  // Observed live 2026-07-25: for a few seconds after an extend the volume GET
  // returns blocks: 0 / block_size: 0, which would otherwise read as "empty".
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const usageScripts = {
    [`GET /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`]: {
      status: 200,
      body: { id: binding.fly.volumeId, size_gb: 20, blocks: 0, blocks_free: 0, block_size: 0 },
    },
  };
  const { config } = configFor(usageScripts);
  const result = await createFlyMachinesProvider(config).getStorageUsage(binding);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fly_volume_usage_unavailable');
});

// -----------------------------------------------------------------------------
// growStorage — online volume extend
// -----------------------------------------------------------------------------

test('growStorage extends the volume and touches nothing else', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const growScripts = {
    [`PUT /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}/extend`]: {
      status: 200,
      body: { volume: { id: binding.fly.volumeId, size_gb: 20 } },
    },
  };
  const { config, calls } = configFor(growScripts);
  const result = await createFlyMachinesProvider(config).growStorage(binding, { targetSizeGb: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.appliedSizeGb, 20);
  // No machine stop/start/update: the extend is applied to the mounted fs online.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`), [
    `PUT /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}/extend`,
  ]);
  assert.deepEqual(calls[0].body, { size_gb: 20 });
});

test('growStorage refuses a nonsense target without calling Fly', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const { config, calls } = configFor({});
  const result = await createFlyMachinesProvider(config).growStorage(binding, { targetSizeGb: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fly_volume_grow_invalid_target');
  assert.equal(calls.length, 0);
});

test('growStorage surfaces a non-200 without leaking the Fly token', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const growScripts = {
    [`PUT /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}/extend`]: {
      status: 422,
      body: { error: 'volume size can only be increased' },
    },
  };
  const { config } = configFor(growScripts);
  const result = await createFlyMachinesProvider(config).growStorage(binding, { targetSizeGb: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fly_volume_grow_failed_422');
  assert.ok(!result.reason.includes(FLY_TOKEN));
});

test('nextVolumeSizeGb only doubles once a volume crosses 75% and never passes the cap', () => {
  const GB = 1024 * 1024 * 1024;
  const at = (usedGb, currentGb, capGb) => nextVolumeSizeGb({
    currentGb,
    usedBytes: usedGb * GB,
    capacityBytes: currentGb * GB,
    capGb,
  });
  assert.equal(STORAGE_GROW_AT_FRACTION, 0.75);
  assert.equal(at(7, 10, 40), null, 'below the threshold');
  assert.equal(at(7.5, 10, 40), 20, 'exactly at the threshold');
  assert.equal(at(9, 10, 40), 20);
  assert.equal(at(9, 10, 15), 15, 'clamped to the cap rather than overshooting');
  assert.equal(at(9, 10, 10), null, 'already at the cap');
  assert.equal(at(9, 10, 9), null, 'never shrinks when the cap is below the current size');
  assert.equal(nextVolumeSizeGb({ currentGb: 10, usedBytes: 9 * GB, capacityBytes: 0, capGb: 40 }), null,
    'a volume with no readable capacity is never grown');
});

// -----------------------------------------------------------------------------
// deleteRunner — Option A (default) vs force teardown
// -----------------------------------------------------------------------------

test('deleteRunner with force=false stops Machine + retains volume + app (Option A)', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const deleteScripts = {
    [`DELETE /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { status: 200, body: {} },
  };
  const { config: deleteConfig, calls } = configFor(deleteScripts);
  const deleteProvider = createFlyMachinesProvider(deleteConfig);
  const result = await deleteProvider.deleteRunner(binding); // force defaults to false
  assert.equal(result.ok, true);
  // Only the machine delete went out — volume + app are preserved.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`), [
    `DELETE /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`,
  ]);
});

test('deleteRunner with force=true also destroys volume + app', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const deleteScripts = {
    [`DELETE /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { status: 200, body: {} },
    [`DELETE /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`]: { status: 200, body: {} },
    [`DELETE /apps/${binding.fly.appName}`]: { status: 202, body: {} },
  };
  const { config: deleteConfig, calls } = configFor(deleteScripts);
  const deleteProvider = createFlyMachinesProvider(deleteConfig);
  const result = await deleteProvider.deleteRunner(binding, { force: true });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`), [
    `DELETE /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`,
    `DELETE /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`,
    `DELETE /apps/${binding.fly.appName}`,
  ]);
});

test('deleteRunner tolerates already-gone resources (404)', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const deleteScripts = {
    [`DELETE /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { status: 404, body: { error: 'not found' } },
    [`DELETE /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`]: { status: 404, body: { error: 'not found' } },
    [`DELETE /apps/${binding.fly.appName}`]: { status: 404, body: { error: 'not found' } },
  };
  const { config: deleteConfig } = configFor(deleteScripts);
  const deleteProvider = createFlyMachinesProvider(deleteConfig);
  const result = await deleteProvider.deleteRunner(binding, { force: true });
  assert.equal(result.ok, true);
});

// -----------------------------------------------------------------------------
// Cross-provider safety
// -----------------------------------------------------------------------------

test('start/stop/delete reject a railway_legacy binding', async () => {
  const { config } = configFor({});
  const provider = createFlyMachinesProvider(config);
  const railwayBinding = {
    providerId: 'railway_legacy',
    userId: USER_A,
    runnerBaseUrl: 'https://something.up.railway.app',
    runnerSharedSecret: RUNNER_SECRET,
    status: 'ready',
    createdAt: '2026-05-15T00:00:00Z',
    lastHealthAt: null,
    railway: { projectId: 'fixture-railway-project' },
  };
  await assert.rejects(() => provider.startRunner(railwayBinding), /fly_provider_wrong_binding_for_start/);
  await assert.rejects(() => provider.stopRunner(railwayBinding), /fly_provider_wrong_binding_for_stop/);
  await assert.rejects(() => provider.deleteRunner(railwayBinding), /fly_provider_wrong_binding_for_delete/);
});

// -----------------------------------------------------------------------------
// Token redaction in errors
// -----------------------------------------------------------------------------

test('startRunner errors never leak the Fly API token, even when the inner fetch throws with the token in the message', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  // Synthetic fetch that throws with the token in the message — the provider
  // must NOT propagate that message to the caller, either by dropping it
  // entirely (current behaviour: a sanitised "fly_api_request_failed:..."
  // error) or by redacting it ([fly-token-redacted]). The acceptance bar is
  // simple: the caller-visible errorMessage/errorCode must not contain the
  // token.
  const failingFetch = () => { throw new Error(`network call failed and somehow leaked ${FLY_TOKEN} into the message`); };
  const provider = createFlyMachinesProvider({
    apiToken: FLY_TOKEN,
    org: FLY_ORG,
    primaryRegion: FLY_REGION,
    fetchImpl: failingFetch,
  });
  const result = await provider.startRunner(binding);
  assert.equal(result.ok, false);
  const merged = `${result.errorCode ?? ''} ${result.errorMessage ?? ''}`;
  assert.equal(merged.includes(FLY_TOKEN), false, 'token must not appear in errorCode or errorMessage');
  // Also: the safe surface should be a sanitised string a human + the
  // mobile app can show without surprise.
  assert.match(result.errorCode ?? '', /^fly_(machine_start_failed|api_request_failed)/);
});

// -----------------------------------------------------------------------------
// getHealth
// -----------------------------------------------------------------------------

test('getHealth probes /healthz and reports ready on success', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const provider = createFlyMachinesProvider({
    apiToken: FLY_TOKEN,
    org: FLY_ORG,
    primaryRegion: FLY_REGION,
    probeRunnerHealth: async () => ({ ok: true, status: 200 }),
    now: () => new Date('2026-05-15T20:31:00Z'),
  });
  const health = await provider.getHealth(binding);
  assert.equal(health.ok, true);
  assert.equal(health.status, 'ready');
  assert.equal(health.lastCheckedAt, '2026-05-15T20:31:00.000Z');
});

test('getHealth reports error and sanitised code when /healthz returns non-2xx', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const provider = createFlyMachinesProvider({
    apiToken: FLY_TOKEN,
    org: FLY_ORG,
    primaryRegion: FLY_REGION,
    probeRunnerHealth: async () => ({ ok: false, status: 503 }),
    now: () => new Date('2026-05-15T20:32:00Z'),
  });
  const health = await provider.getHealth(binding);
  assert.equal(health.ok, false);
  assert.equal(health.status, 'error');
  assert.equal(health.errorCode, 'fly_runner_health_503');
});

// -----------------------------------------------------------------------------
// reimageRunner — volume-preserving in-place upgrade (Feature 3 vehicle)
// -----------------------------------------------------------------------------

const NEW_IMAGE_REF = 'registry.fly.io/delegent-runner-images@sha256:812df8dc0136db9d29190d248eb1e2873ea7a55f1d930438d856ba446abad028';

test('reimageRunner GET-modify-POSTs the full config: image swapped + toolset env refreshed (per-user env + volume + checks preserved)', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const oldConfig = {
    image: IMAGE_REF,
    guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
    env: { SIDEKICK_USER_ID: USER_A, SIDEKICK_RUNNER_SHARED_SECRET: RUNNER_SECRET, SIDEKICK_AGENT_NAME: 'Nova' },
    mounts: [{ volume: binding.fly.volumeId, path: FLY_WORKSPACE_MOUNT_PATH }],
    services: [{ internal_port: FLY_RUNNER_INTERNAL_PORT, protocol: 'tcp' }],
    checks: { healthz: { type: 'http', port: FLY_RUNNER_INTERNAL_PORT, path: '/healthz' } },
  };
  const scripts = {
    [`GET /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { status: 200, body: { id: binding.fly.machineId, state: 'started', config: oldConfig } },
    [`POST /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { status: 200, body: { id: binding.fly.machineId, state: 'started' } },
  };
  const { config, calls } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  const result = await provider.reimageRunner(binding, { targetImageRef: NEW_IMAGE_REF });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyCurrent, false);
  assert.equal(result.appliedImageRef, NEW_IMAGE_REF);
  assert.equal(result.appliedImageDigest, 'sha256:812df8dc0136db9d29190d248eb1e2873ea7a55f1d930438d856ba446abad028');
  assert.equal(result.healthy, true);
  // GET first, then POST the update — exactly two Fly calls.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'POST');
  const posted = calls[1].body.config;
  assert.equal(posted.image, NEW_IMAGE_REF, 'image must be swapped to target');
  assert.deepEqual(posted.mounts, oldConfig.mounts, 'volume mount must be preserved');
  // Per-user env preserved verbatim...
  assert.equal(posted.env.SIDEKICK_USER_ID, USER_A, 'per-user id must be preserved');
  assert.equal(posted.env.SIDEKICK_RUNNER_SHARED_SECRET, RUNNER_SECRET, 'shared secret must be preserved');
  assert.equal(posted.env.SIDEKICK_AGENT_NAME, 'Nova', 'agent name must be preserved');
  // ...and the capability toolset env is REFRESHED to the full un-tiered list so
  // the rolling reimage heals an existing runner whose env predates the toolset
  // injection (web/code_execution must be on after the reimage; 'browser'/Chromium
  // was dropped 2026-06-05 and must NOT come back).
  assert.ok(
    typeof posted.env.HERMES_TOOLSETS === 'string'
      && posted.env.HERMES_TOOLSETS.includes('web')
      && posted.env.HERMES_TOOLSETS.includes('code_execution')
      && !posted.env.HERMES_TOOLSETS.includes('browser'),
    `reimage must refresh HERMES_TOOLSETS to the full toolset without browser (got: ${posted.env.HERMES_TOOLSETS})`,
  );
  assert.deepEqual(posted.guest, oldConfig.guest, 'compute sizing must be preserved');
  assert.deepEqual(posted.checks, oldConfig.checks, 'health checks must be preserved');
  // Services keep their ports/protocol AND gain auto-stop, so the rolling reimage
  // heals an existing runner onto the configured idle policy (stop by default,
  // 2026-06-11) without dropping the port mapping.
  assert.equal(posted.services[0].internal_port, oldConfig.services[0].internal_port, 'service port preserved');
  assert.equal(posted.services[0].protocol, oldConfig.services[0].protocol, 'service protocol preserved');
  assert.equal(posted.services[0].autostop, 'stop', 'reimage applies autostop=stop');
  assert.equal(posted.services[0].autostart, true, 'reimage applies autostart');
});

test('reimageRunner is a no-op when the machine is already on the target image (idempotent, GET only)', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  // No-op now requires image current AND toolset env current AND auto-stop
  // current, so the fixture carries all three (the toolset value is derived from
  // buildFlyRunnerEnv so it can never drift from the provider logic).
  const currentToolsets = buildFlyRunnerEnv(defaultCreateInput()).HERMES_TOOLSETS;
  const scripts = {
    // Already on the target image + current toolset env + autostop — a stray POST would hit no script (HTTP 599) and fail the assertion below.
    // autostop: true is what Fly RETURNS for 'stop' (legacy boolean form); the
    // no-op idempotency check must normalize it to match the desired default 'stop'.
    // DELEGENT_PLATFORM_ENABLED is part of "current" now that Route B defaults on;
    // a machine missing it is deliberately NOT a no-op so the cron heals it.
    [`GET /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { status: 200, body: { id: binding.fly.machineId, config: { image: NEW_IMAGE_REF, env: { HERMES_TOOLSETS: currentToolsets, DELEGENT_PLATFORM_ENABLED: 'true' }, services: [{ internal_port: FLY_RUNNER_INTERNAL_PORT, protocol: 'tcp', autostop: true, autostart: true }] } } },
  };
  const { config, calls } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  const result = await provider.reimageRunner(binding, { targetImageRef: NEW_IMAGE_REF });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyCurrent, true);
  assert.equal(result.appliedImageRef, NEW_IMAGE_REF);
  assert.equal(calls.length, 1, 'idempotent path must not POST a config update');
  assert.equal(calls[0].method, 'GET');
});

test('force deletion rechecks authorization before machine, volume and app separately', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  for (const denyAt of [1,2,3]) {
    let checks = 0;
    const { config, calls } = configFor({
      [`DELETE /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { body: {} },
      [`DELETE /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`]: { body: {} },
      [`DELETE /apps/${binding.fly.appName}`]: { body: {} },
    });
    const result = await createFlyMachinesProvider(config).deleteRunner(binding, {
      force: true, beforeDelete: async () => ++checks !== denyAt,
    });
    assert.equal(result.ok, false);
    assert.equal(checks, denyAt);
    assert.equal(calls.length, denyAt-1);
  }
});

test('reimage health failure is never reported as success, including a current config', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  for (const alreadyCurrent of [true, false]) {
    let probes = 0;
    const { config, calls } = configFor({
      [`GET /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { body: { config: {
        image: alreadyCurrent ? NEW_IMAGE_REF : IMAGE_REF,
        env: { HERMES_TOOLSETS: buildFlyRunnerEnv(defaultCreateInput()).HERMES_TOOLSETS, DELEGENT_PLATFORM_ENABLED: 'true' },
        services: [{ autostop: true, autostart: true }],
      } } },
      [`POST /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { body: {} },
    }, { probeRunnerHealth: async () => { probes++; return { ok: false, status: 503 }; } });
    const result = await createFlyMachinesProvider(config).reimageRunner(binding, { targetImageRef: NEW_IMAGE_REF });
    assert.equal(result.ok, false);
    assert.match(result.reason, /health/);
    assert.ok(probes > 0);
    assert.equal(calls.filter((c) => c.method === 'POST').length, alreadyCurrent ? 0 : 1);
  }
});

test('reimageRunner surfaces a Fly update failure with the status, never leaking the token', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const scripts = {
    [`GET /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { status: 200, body: { id: binding.fly.machineId, config: { image: IMAGE_REF, mounts: [] } } },
    [`POST /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { status: 422, body: { error: `unprocessable ${FLY_TOKEN}` } },
  };
  const { config } = configFor(scripts);
  const provider = createFlyMachinesProvider(config);
  const result = await provider.reimageRunner(binding, { targetImageRef: NEW_IMAGE_REF });
  assert.equal(result.ok, false);
  assert.match(result.reason, /fly_machine_reimage_failed_422/);
  assert.ok(!result.reason.includes(FLY_TOKEN), 'FLY_API_TOKEN must never appear in the failure reason');
});

test('reimageRunner rejects a missing target image and a binding from another provider', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const { config } = configFor({});
  const provider = createFlyMachinesProvider(config);

  const missing = await provider.reimageRunner(binding, { targetImageRef: '   ' });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /reimage_missing_target_image_ref/);

  const railwayBinding = {
    providerId: 'railway_legacy',
    userId: USER_A,
    runnerBaseUrl: 'https://legacy.example.com',
    runnerSharedSecret: RUNNER_SECRET,
    status: 'ready',
    createdAt: '2026-05-15T20:30:00Z',
    lastHealthAt: null,
    railway: { projectId: 'proj_legacy' },
  };
  await assert.rejects(
    () => provider.reimageRunner(railwayBinding, { targetImageRef: NEW_IMAGE_REF }),
    /fly_provider_wrong_binding_for_reimage/,
  );
});

// -----------------------------------------------------------------------------
// resizeRunner — defect hunt 2026-09-03 (D8): a plan change never pre-extends
// the volume. Fly bills every provisioned GB, so jumping a fresh Pro Office
// upgrade from 3 GB straight to 40 GB paid for empty disk. Compute is resized
// here; storage keeps growing on demand through the hourly sweep, capped at
// the tier's quota.
// -----------------------------------------------------------------------------

test('resizeRunner on an upgrade patches compute only and never extends the volume up front', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const resizeScripts = {
    [`GET /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`]: {
      status: 200,
      body: { id: binding.fly.volumeId, size_gb: 10 },
    },
    [`POST /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: {
      status: 200,
      body: { id: binding.fly.machineId },
    },
  };
  const { config, calls } = configFor(resizeScripts);
  const result = await createFlyMachinesProvider(config).resizeRunner(binding, { targetTierId: 'pro-office' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.appliedVolumeGb, 10, 'reports the untouched current size, not the tier allowance');
  assert.deepEqual(result.appliedCompute, DEFAULT_COMPUTE_TIER_BY_PLAN['pro-office']);
  assert.equal(result.deferred, undefined);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`), [
    `GET /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`,
    `POST /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`,
  ], 'no PUT .../extend anywhere in the resize');
  const guest = calls[1].body.config.guest;
  assert.equal(guest.cpus, DEFAULT_COMPUTE_TIER_BY_PLAN['pro-office'].cpus);
  assert.equal(guest.memory_mb, DEFAULT_COMPUTE_TIER_BY_PLAN['pro-office'].memoryMb);
});

test('resizeRunner on a downgrade below the current size still flags the deferred shrink', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  const resizeScripts = {
    [`GET /apps/${binding.fly.appName}/volumes/${binding.fly.volumeId}`]: {
      status: 200,
      body: { id: binding.fly.volumeId, size_gb: 40 },
    },
    [`POST /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: {
      status: 200,
      body: { id: binding.fly.machineId },
    },
  };
  const { config, calls } = configFor(resizeScripts);
  const result = await createFlyMachinesProvider(config).resizeRunner(binding, { targetTierId: 'studio' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.deferred, 'shrink_on_renewal');
  assert.equal(result.appliedVolumeGb, 40);
  assert.equal(calls.some((c) => c.method === 'PUT'), false, 'a volume is never extended or shrunk here');
});

// -----------------------------------------------------------------------------
// flyRunnerAutostopForUser: per-user escape hatch from the fleet autostop policy
// -----------------------------------------------------------------------------
// The cron pins FLY_RUNNER_AUTOSTOP=off for the whole fleet, which is right for
// paying customers (a cold start hangs their first message; that is what the
// 2026-07-09 incident cost). But our own accounts then burn compute doing
// nothing, and the reimage path heals every machine back to the fleet value, so
// setting one to sleep by hand silently gets undone. Added 2026-09-05.

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const ALEX = '272b9ffd-3097-4d59-a1b4-c0fc2dddffc2';
const CUSTOMER = '11111111-2222-4333-8444-555555555555';

test('an allowlisted user sleeps even while the fleet is pinned always-on', () => {
  withEnv({ FLY_RUNNER_AUTOSTOP: 'off', FLY_RUNNER_AUTOSTOP_SLEEP_USER_IDS: ALEX }, () => {
    assert.equal(flyRunnerAutostop(), 'off', 'fleet default is unchanged');
    assert.equal(flyRunnerAutostopForUser(ALEX), 'stop', 'the allowlisted account sleeps');
  });
});

test('a paying customer NEVER inherits sleep from the allowlist', () => {
  withEnv({ FLY_RUNNER_AUTOSTOP: 'off', FLY_RUNNER_AUTOSTOP_SLEEP_USER_IDS: ALEX }, () => {
    assert.equal(flyRunnerAutostopForUser(CUSTOMER), 'off');
    assert.equal(flyRunnerAutostopForUser(null), 'off');
    assert.equal(flyRunnerAutostopForUser(undefined), 'off');
    assert.equal(flyRunnerAutostopForUser(''), 'off');
  });
});

test('the allowlist takes several ids, tolerates spacing and ignores case', () => {
  withEnv({
    FLY_RUNNER_AUTOSTOP: 'off',
    FLY_RUNNER_AUTOSTOP_SLEEP_USER_IDS: `  ${ALEX.toUpperCase()} , ${CUSTOMER}  ,`,
  }, () => {
    assert.equal(flyRunnerAutostopForUser(ALEX), 'stop');
    assert.equal(flyRunnerAutostopForUser(CUSTOMER), 'stop');
    assert.equal(flyRunnerAutostopForUser('someone-else'), 'off');
  });
});

test('with no allowlist set, every user follows the fleet default', () => {
  withEnv({ FLY_RUNNER_AUTOSTOP: 'off', FLY_RUNNER_AUTOSTOP_SLEEP_USER_IDS: undefined }, () => {
    assert.equal(flyRunnerAutostopForUser(ALEX), 'off');
  });
  withEnv({ FLY_RUNNER_AUTOSTOP: undefined, FLY_RUNNER_AUTOSTOP_SLEEP_USER_IDS: undefined }, () => {
    assert.equal(flyRunnerAutostopForUser(ALEX), 'stop', 'code default is stop when nothing is pinned');
  });
});

test('reimage applies the per-user value, which is what makes it survive the cron', async () => {
  const { binding } = await bindingFor((await happyScriptsFor()).scripts);
  await withEnv({ FLY_RUNNER_AUTOSTOP: 'off', FLY_RUNNER_AUTOSTOP_SLEEP_USER_IDS: binding.userId }, async () => {
    const scripts = {
      [`GET /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: {
        status: 200,
        body: {
          id: binding.fly.machineId,
          config: {
            image: 'registry.fly.io/old@sha256:' + '0'.repeat(64),
            env: {},
            services: [{ ports: [{ port: 443 }], autostop: false, autostart: true }],
          },
        },
      },
      [`POST /apps/${binding.fly.appName}/machines/${binding.fly.machineId}`]: { status: 200, body: { id: binding.fly.machineId } },
    };
    const { config, calls } = configFor(scripts);
    await createFlyMachinesProvider(config).reimageRunner(binding, { targetImageRef: IMAGE_REF });
    const post = calls.find((c) => c.method === 'POST' && c.path.includes('/machines/'));
    assert.ok(post, 'reimage POSTs the new config');
    assert.equal(post.body.config.services[0].autostop, 'stop',
      'the allowlisted account keeps sleep through a reimage instead of being healed back to off');
  });
});
