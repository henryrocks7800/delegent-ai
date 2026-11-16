// Series 4 — Fly Machines RunnerProvider implementation.
//
// One paid user = one Fly app + one Fly Machine + one Fly volume + one
// per-user runner shared secret. The provider is the only thing that holds
// the FLY_API_TOKEN; nothing else in the codebase touches the Machines API.
//
// Tested via packages/provisioner/test/fly-machines-provider.test.mjs which
// exercises every method against a fake Fly API. No real network calls are
// made by unit tests; the live smoke is gated behind
// SIDEKICK_ALLOW_LIVE_FLY_PROVISIONING=true (Phase 5+).
import type { PlanTierId } from '@sidekick/shared';
import {
  chooseComputeTier,
  chooseVolumeSizeGb,
  deriveRunnerResourceSuffix,
  DEFAULT_COMPUTE_TIER_BY_PLAN,
  DEFAULT_VOLUME_SIZE_GB_BY_TIER,
  type ComputeTier,
  type CreateRunnerInput,
  type DeleteRunnerOptions,
  type FlyMachinesRunnerBinding,
  type GrowStorageResult,
  type ReimageRunnerRequest,
  type ReimageRunnerResult,
  type ResizeRunnerResult,
  type RunnerBinding,
  type RunnerHealth,
  type RunnerProvider,
  type RunnerProviderActionResult,
  type RunnerProviderPreflight,
  type RunnerProviderPreflightCheck,
  type StorageUsageResult,
} from './runnerProvider.js';
import {
  buildDelegentSystemPrompt,
  buildDelegentExamplePromptsEnvValue,
  DELEGENT_TURN_VERBOSITY,
  DELEGENT_EMOJI_LEVEL,
  DELEGENT_GREETING_TONE,
  DELEGENT_TOOL_APPROVAL,
  DELEGENT_MEMORY_ENABLED,
  DELEGENT_SKILLS_DIR_DEFAULT,
  buildDelegentRunnerToolsets,
  DELEGENT_RUNNER_MODEL,
  DELEGENT_WEB_SEARCH_ENV_PASSTHROUGH,
} from '../delegentAgentDefaults.js';

export const FLY_MACHINES_API_BASE = 'https://api.machines.dev/v1';
/**
 * Fly's GraphQL endpoint. The Machines REST API doesn't expose IP
 * allocation, so we have to fall through to GraphQL for that one step.
 * Everything else stays on the REST surface.
 */
export const FLY_GRAPHQL_API = 'https://api.fly.io/graphql';
/** Default app-name prefix. Overridable via FLY_RUNNER_APP_PREFIX env. */
export const FLY_RUNNER_APP_PREFIX_DEFAULT = 'delegent-runner';
/** Default primary region when neither input nor env specifies one. */
export const FLY_PRIMARY_REGION_DEFAULT = 'lhr';
/** Machine config defaults — shared:1cpu / 1GB RAM is fine for Hermes's idle footprint. */
export const FLY_MACHINE_CPU_KIND_DEFAULT = 'shared';
export const FLY_MACHINE_CPUS_DEFAULT = 1;
export const FLY_MACHINE_MEMORY_MB_DEFAULT = 1024;
/**
 * Where the per-user Fly volume attaches inside the Machine. This MUST equal
 * HERMES_HOME so Hermes' durable state -- state.db (session transcripts),
 * memories/ (the memory tool), and sessions/ -- lives ON the persistent
 * volume. Before 2026-06-11 the volume mounted one level deeper (at the
 * workspace dir), so all of that sat on ephemeral container disk and was wiped
 * on every machine recreate/reimage. See docs/CHAT_ROUTE_B_DESIGN.md Phase 0.
 */
export const FLY_VOLUME_MOUNT_PATH = '/data/hermes';
/** The agent's user-facing workspace -- a subdirectory ON the volume (created
 *  at runtime by ensure_runner_workspace). = HERMES_HOME/workspace in
 *  server.py; surfaced to the app as the Files tab and SIDEKICK_WORKSPACE_DIR. */
export const FLY_WORKSPACE_MOUNT_PATH = '/data/hermes/workspace';
/** Internal port the FastAPI wrapper listens on. */
export const FLY_RUNNER_INTERNAL_PORT = 8642;
/** Network timeout for any single Fly API call. */
export const FLY_REQUEST_TIMEOUT_MS = 30_000;
/** Max attempts for the post-create health probe loop. */
export const FLY_HEALTH_PROBE_MAX_ATTEMPTS = 60;
export const FLY_HEALTH_PROBE_INTERVAL_MS = 2_000;

const FLY_RESERVED_FORBIDDEN_ENV_NAMES = new Set([
  'FLY_API_TOKEN',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'OPENROUTER_API_KEY',
  'RAILWAY_API_TOKEN',
  'SIDEKICK_TELEGRAM_BOT_TOKEN',
]);

export interface FlyMachinesProviderConfig {
  apiToken: string;
  org: string;
  primaryRegion?: string;
  appPrefix?: string;
  /** Image ref the provisioner should boot Machines from when CreateRunnerInput doesn't override. */
  defaultImageRef?: string | null;
  /** Optional override for fetch — tests inject a stub. */
  fetchImpl?: typeof fetch;
  /**
   * Optional override for the post-create health probe. Tests inject a
   * fake that resolves immediately so the unit tests don't sleep.
   */
  probeRunnerHealth?: (input: { runnerBaseUrl: string; attemptIndex: number }) => Promise<{ ok: boolean; status: number }>;
  /** Optional clock for deterministic timestamps in tests. */
  now?: () => Date;
  /** Optional sleep override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

interface FlyApiCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

interface FlyApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T | null;
  /** Raw text — never includes the API token. Use for diagnostic strings only. */
  rawBody: string;
}

/**
 * Sanitise any string that's about to appear in an errorCode/errorMessage so
 * we never accidentally leak the token. Belt-and-braces — the token never
 * appears in API response bodies, but a misconfigured proxy could echo it
 * back, and one slip would be a customer-impacting incident.
 */
function redactFlyToken(value: string | undefined | null, token: string): string {
  if (!value) return '';
  if (!token) return value;
  return value.split(token).join('[fly-token-redacted]');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(now: (() => Date) | undefined): string {
  return (now ? now() : new Date()).toISOString();
}

function normalizeAppPrefix(value: string | undefined | null): string {
  const raw = (value ?? '').trim() || FLY_RUNNER_APP_PREFIX_DEFAULT;
  // Fly app names are lowercase, hex/dash only, ≤63 chars. We control the
  // suffix, so just ensure the prefix is well-formed.
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || FLY_RUNNER_APP_PREFIX_DEFAULT;
}

function normalizeRegion(value: string | undefined | null): string {
  const raw = (value ?? '').trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(raw) ? raw : FLY_PRIMARY_REGION_DEFAULT;
}

/** Operator flag (provisioner env) opting new/reimaged Machines into Route B:
 *  boot the `delegent` gateway platform (durable per-user session + slash
 *  commands + /goal) and add session_search to the toolset.
 *
 *  Route B completed cutover, so an unset flag now means ON; setting it to a
 *  false-y value is still an explicit kill switch. It was OFF-by-default during
 *  the cutover, which left a trap: an operator running series4:provision-once
 *  by hand (the documented cron-failure recovery in
 *  docs/FLY_MACHINES_PROVISIONING.md) from an env without the flag created a
 *  Machine with no DELEGENT_PLATFORM_ENABLED, and the runner's baked-in adapter
 *  then bound relay=log-only with no user allowlist. The box looked healthy and
 *  accepted messages but never replied. See docs/CHAT_ROUTE_B_DESIGN.md. */
export function flyRunnerRouteBEnabled(): boolean {
  const raw = (process.env.SIDEKICK_DELEGENT_PLATFORM_ENABLED ?? '').trim().toLowerCase();
  if (!raw) return true;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/** Idle-machine policy for the per-user runner service. Default 'stop'
 *  (scale-to-zero when idle).
 *
 *  History: on 2026-06-14 'stop' caused a mid-run hang — Fly's proxy judged a
 *  runner idle during a long, tool-heavy agent turn (the agent's model calls are
 *  loopback, invisible to the proxy) and STOPPED it mid-run, killing the run,
 *  wiping the in-memory run records, and hanging the chat. We briefly defaulted
 *  to 'off' (always-on) as a stopgap. The proper fix shipped same day: the
 *  runner now runs a BUSY-AWARE keepalive (server.py `_delegent_autostop_keepalive`)
 *  that pings its own public Fly host through the proxy while — and only while —
 *  a run is in flight, so Fly never stops a busy machine but an idle one still
 *  scales to zero. With that backstopped by the Worker's orphan-reaper, 'stop'
 *  is safe again and restores the cost savings. Operator can set
 *  FLY_RUNNER_AUTOSTOP=off|suspend to override. ('suspend' wedged a live runner
 *  on 2026-06-11, so it is not the default either.) */
export type FlyAutostop = 'stop' | 'suspend' | 'off';
export function flyRunnerAutostop(): FlyAutostop {
  const raw = (process.env.FLY_RUNNER_AUTOSTOP ?? '').trim().toLowerCase();
  return raw === 'off' || raw === 'suspend' ? raw : 'stop';
}

/**
 * Per-user escape hatch from the fleet-wide autostop policy.
 *
 * The cron pins `FLY_RUNNER_AUTOSTOP=off` for everyone, which is the right
 * call for paying customers: a cold start hangs their first message, and that
 * is what the 2026-07-09 incident cost us. But it also means OUR OWN accounts
 * burn compute around the clock doing nothing, and the reimage path actively
 * heals every machine back to the fleet value, so setting a machine to sleep
 * by hand does not survive.
 *
 * `FLY_RUNNER_AUTOSTOP_SLEEP_USER_IDS` is a comma-separated allowlist of user
 * ids that always get `stop` regardless of the fleet default. It is for
 * internal and test accounts, where a cold start costs nobody anything.
 * Never put a paying customer in it.
 */
export function flyRunnerAutostopForUser(userId: string | null | undefined): FlyAutostop {
  const wanted = String(userId ?? '').trim().toLowerCase();
  if (!wanted) return flyRunnerAutostop();
  const allow = (process.env.FLY_RUNNER_AUTOSTOP_SLEEP_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(wanted) ? 'stop' : flyRunnerAutostop();
}

/** Normalize a Fly service `autostop` value to the enum string. Fly returns the
 *  legacy boolean `true` for 'stop' and `false` for 'off' on a GET (but the
 *  string 'suspend' round-trips), so compare normalized values. */
export function normalizeAutostop(value: unknown): FlyAutostop | string {
  if (value === true) return 'stop';
  if (value === false) return 'off';
  return typeof value === 'string' ? value : String(value ?? '');
}

export function buildFlyRunnerEnv(input: CreateRunnerInput, options: { agentNameDefault?: string } = {}): Record<string, string> {
  const agent = (input.agentName ?? options.agentNameDefault ?? '').trim();
  const env: Record<string, string> = {
    SIDEKICK_USER_ID: input.userId,
    SIDEKICK_RUNNER_SHARED_SECRET: input.runnerSharedSecret,
    SIDEKICK_WORKER_PROXY_URL: input.workerProxyUrl,
    SIDEKICK_WORKSPACE_DIR: FLY_WORKSPACE_MOUNT_PATH,
    // Pin HERMES_HOME to the volume mount explicitly (the image default is the
    // same path, but making it explicit keeps the durable-store invariant
    // visible in the Machine config and lets the consistency test assert it).
    HERMES_HOME: FLY_VOLUME_MOUNT_PATH,
    // Allow the Worker's on-demand /healthz probe to succeed without HMAC.
    // /tasks still requires HMAC; only /health/healthz is reachable unsigned
    // when this is set. See server.py:health().
    SIDEKICK_ALLOW_UNSIGNED_HEALTH: 'true',
  };
  if (agent) env.SIDEKICK_RUNNER_PUBLIC_NAME = agent;
  // Defect #55 (2026-05-21): the runner-side identity defense
  // (services/hermes-runner/server.py: inject_agent_identity_into_runs_payload)
  // reads SIDEKICK_AGENT_NAME + HERMES_SYSTEM_PROMPT off the machine env to
  // frame the upstream model. The Fly provider used to drop ALL of the
  // personality vars on the floor — the machine booted with the runner's
  // built-in DEFAULT_AGENT_NAME='Ruben' fallback and the agent introduced
  // itself as Ruben rather than the user's chosen name. Inject the same set
  // that buildHermesRunnerEnvironment in index.ts produces.
  if (agent) {
    env.SIDEKICK_AGENT_NAME = agent;
    env.HERMES_AGENT_NAME = agent;
    env.HERMES_SYSTEM_PROMPT = buildDelegentSystemPrompt(agent);
  }
  // Capability parity (2026-05-30): inject the FULL Hermes toolset on the LIVE
  // Fly path. Without this, server.py falls back to its minimal
  // file,web,terminal default and browser/code_execution/memory/session_search/
  // cronjob/vision stay off for every user. Tiers differ only by compute +
  // tokens, never by toolset. This is the line that actually delivers parity.
  const routeBEnabled = flyRunnerRouteBEnabled();
  env.HERMES_TOOLSETS = buildDelegentRunnerToolsets(routeBEnabled).join(',');
  // Route B: boot the `delegent` gateway platform so in-app chat routes through
  // handle_message (durable session + slash commands + /goal). The runner
  // self-derives DELEGENT_RELAY_URL (its own loopback ingest) and reuses
  // SIDEKICK_RUNNER_SHARED_SECRET for the loopback gate, so this flag is all the
  // provisioner needs to set. See docs/CHAT_ROUTE_B_DESIGN.md.
  if (routeBEnabled) {
    env.DELEGENT_PLATFORM_ENABLED = 'true';
  }
  // Pin the inference model explicitly (was 'openrouter/auto'). The Worker still
  // hard-pins the same model at the trust boundary, so this is just honest
  // runner-side config that says what we actually run: Kimi K2.6.
  env.HERMES_MODEL = DELEGENT_RUNNER_MODEL;
  env.HERMES_INFERENCE_MODEL = DELEGENT_RUNNER_MODEL;
  env.HERMES_EXAMPLE_PROMPTS = buildDelegentExamplePromptsEnvValue();
  env.HERMES_TURN_VERBOSITY = DELEGENT_TURN_VERBOSITY;
  env.HERMES_EMOJI_LEVEL = DELEGENT_EMOJI_LEVEL;
  env.HERMES_GREETING_TONE = DELEGENT_GREETING_TONE;
  env.HERMES_TOOL_APPROVAL = DELEGENT_TOOL_APPROVAL;
  env.HERMES_MEMORY_ENABLED = DELEGENT_MEMORY_ENABLED;
  env.DELEGENT_SKILLS_DIR = DELEGENT_SKILLS_DIR_DEFAULT;
  // 2026-06-04: enable Hermes' `web` toolset (web_search/web_extract) by passing
  // through whichever search-provider config the provisioner env carries. Without
  // one of these, Hermes silently drops web_search (PRODUCTION_READINESS §24).
  // Operator chose Firecrawl: FIRECRAWL_API_URL (self-hosted, no per-search cost) or
  // FIRECRAWL_API_KEY (Firecrawl Cloud). Provider stays swappable by config, never a
  // rebuild. Interim model is key/URL on the box; the Worker-proxy hardening (§24.2)
  // moves it off-box at scale.
  for (const passthrough of DELEGENT_WEB_SEARCH_ENV_PASSTHROUGH) {
    const value = process.env[passthrough];
    if (typeof value === 'string' && value.trim().length > 0) {
      env[passthrough] = value.trim();
    }
  }

  // Defence in depth: refuse to inject any provider-token-shaped name even
  // if a caller accidentally fills CreateRunnerInput from a wider env. The
  // unit tests pin this; if someone widens CreateRunnerInput later they have
  // to revisit this list.
  for (const forbidden of FLY_RESERVED_FORBIDDEN_ENV_NAMES) {
    if (forbidden in env) {
      throw new Error(`fly_runner_env_must_not_contain_${forbidden.toLowerCase()}`);
    }
  }
  return env;
}

/** Build the public per-user app name. Never embeds raw email/UUID. */
export async function flyMachinesAppName(input: CreateRunnerInput, appPrefix: string): Promise<string> {
  const suffix = await deriveRunnerResourceSuffix(input.userId, input.idempotencyKey);
  const prefix = normalizeAppPrefix(appPrefix);
  return `${prefix}-${suffix}`.slice(0, 63);
}

export function createFlyMachinesProvider(config: FlyMachinesProviderConfig): RunnerProvider {
  const apiToken = (config.apiToken ?? '').trim();
  const org = (config.org ?? '').trim();
  const primaryRegion = normalizeRegion(config.primaryRegion);
  const appPrefix = normalizeAppPrefix(config.appPrefix);
  const defaultImageRef = (config.defaultImageRef ?? '').trim() || null;
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? defaultSleep;

  async function flyGraphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        init.signal = AbortSignal.timeout(FLY_REQUEST_TIMEOUT_MS);
      }
      response = await fetchImpl(FLY_GRAPHQL_API, init);
    } catch (err) {
      throw new Error('fly_graphql_request_failed');
    }
    const text = await response.text();
    let body: { data?: T; errors?: Array<{ message?: string }> } | null = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!response.ok || !body || body.errors) {
      const firstError = body?.errors?.[0]?.message ?? `http_${response.status}`;
      // Don't propagate the FLY_API_TOKEN value if it somehow appears.
      const safe = redactFlyToken(firstError, apiToken);
      throw new Error(`fly_graphql_error:${safe}`);
    }
    return body.data as T;
  }

  /**
   * Allocate a shared IPv4 + a dedicated IPv6 to the app so its public
   * `<app>.fly.dev` hostname routes to the Machine. The Machines REST API
   * doesn't expose IP allocation, so this falls through to Fly's GraphQL.
   *
   * Idempotent: Fly's AllocateIpAddress mutation tolerates "already
   * allocated" and returns the existing record. We swallow that case.
   */
  async function ensureFlyAppPublicIps(appName: string): Promise<void> {
    const ALLOCATE = `
      mutation AllocateIpAddress($appId: ID!, $type: IPAddressType!) {
        allocateIpAddress(input: { appId: $appId, type: $type }) {
          ipAddress { address type }
        }
      }`;
    for (const type of ['shared_v4', 'v6'] as const) {
      try {
        await flyGraphql(ALLOCATE, { appId: appName, type });
      } catch (err) {
        const message = String((err as Error)?.message ?? '');
        // "already allocated" is the idempotent success path; anything else
        // is a real failure.
        if (/already.*allocated|already.*exists|duplicate/i.test(message)) continue;
        throw err;
      }
    }
  }

  async function fly<T = unknown>(call: FlyApiCall): Promise<FlyApiResponse<T>> {
    const url = `${FLY_MACHINES_API_BASE}${call.path}`;
    const init: RequestInit = {
      method: call.method,
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
    };
    if (call.body !== undefined) init.body = JSON.stringify(call.body);
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(FLY_REQUEST_TIMEOUT_MS);
    }
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      throw new Error(`fly_api_request_failed:${call.method}:${call.path}`);
    }
    const rawBody = await response.text();
    let body: T | null = null;
    if (rawBody.trim().length > 0) {
      try { body = JSON.parse(rawBody) as T; } catch { body = null; }
    }
    return { status: response.status, ok: response.ok, body, rawBody };
  }

  function preflight(env: Record<string, string | undefined>): RunnerProviderPreflight {
    const requiredVariables = ['FLY_ORG', 'FLY_PRIMARY_REGION', 'SIDEKICK_RUNNER_PROVIDER'] as const;
    const requiredSecrets = ['FLY_API_TOKEN'] as const;
    const missingVariables: string[] = [];
    const missingSecrets: string[] = [];

    if (!(env.FLY_ORG ?? '').trim()) missingVariables.push('FLY_ORG');
    if (!(env.FLY_PRIMARY_REGION ?? '').trim()) missingVariables.push('FLY_PRIMARY_REGION');
    if (!(env.FLY_API_TOKEN ?? '').trim()) missingSecrets.push('FLY_API_TOKEN');

    const providerSetting = (env.SIDEKICK_RUNNER_PROVIDER ?? '').trim().toLowerCase();
    const providerCheck: RunnerProviderPreflightCheck = providerSetting === 'fly_machines'
      ? { id: 'sidekick_runner_provider_is_fly_machines', ok: true, severity: 'blocking', requiredNames: ['SIDEKICK_RUNNER_PROVIDER'], missingNames: [], reason: 'SIDEKICK_RUNNER_PROVIDER is set to fly_machines' }
      : { id: 'sidekick_runner_provider_is_fly_machines', ok: false, severity: 'blocking', requiredNames: ['SIDEKICK_RUNNER_PROVIDER'], missingNames: providerSetting ? [] : ['SIDEKICK_RUNNER_PROVIDER'], reason: providerSetting ? `SIDEKICK_RUNNER_PROVIDER must be "fly_machines"; got "${providerSetting}"` : 'SIDEKICK_RUNNER_PROVIDER must be set to "fly_machines"' };

    const dedicatedSetting = (env.FLY_REQUIRE_DEDICATED_RUNNER ?? '').trim().toLowerCase();
    const dedicatedCheck: RunnerProviderPreflightCheck = dedicatedSetting === 'true'
      ? { id: 'fly_require_dedicated_runner', ok: true, severity: 'blocking', requiredNames: ['FLY_REQUIRE_DEDICATED_RUNNER'], missingNames: [], reason: 'FLY_REQUIRE_DEDICATED_RUNNER=true (worker fails closed on missing binding)' }
      : { id: 'fly_require_dedicated_runner', ok: false, severity: 'warning', requiredNames: ['FLY_REQUIRE_DEDICATED_RUNNER'], missingNames: ['FLY_REQUIRE_DEDICATED_RUNNER'], reason: 'FLY_REQUIRE_DEDICATED_RUNNER is not "true"; worker may permit a shared fallback' };

    const tokenCheck: RunnerProviderPreflightCheck = missingSecrets.length === 0
      ? { id: 'fly_api_token_present', ok: true, severity: 'blocking', requiredNames: ['FLY_API_TOKEN'], missingNames: [], reason: 'FLY_API_TOKEN is set' }
      : { id: 'fly_api_token_present', ok: false, severity: 'blocking', requiredNames: ['FLY_API_TOKEN'], missingNames: ['FLY_API_TOKEN'], reason: 'FLY_API_TOKEN is required for org-scoped app/Machine/volume creation' };

    const orgCheck: RunnerProviderPreflightCheck = (env.FLY_ORG ?? '').trim()
      ? { id: 'fly_org_present', ok: true, severity: 'blocking', requiredNames: ['FLY_ORG'], missingNames: [], reason: 'FLY_ORG is set' }
      : { id: 'fly_org_present', ok: false, severity: 'blocking', requiredNames: ['FLY_ORG'], missingNames: ['FLY_ORG'], reason: 'FLY_ORG is required to create apps' };

    const regionCheck: RunnerProviderPreflightCheck = (env.FLY_PRIMARY_REGION ?? '').trim()
      ? { id: 'fly_primary_region_present', ok: true, severity: 'blocking', requiredNames: ['FLY_PRIMARY_REGION'], missingNames: [], reason: 'FLY_PRIMARY_REGION is set' }
      : { id: 'fly_primary_region_present', ok: false, severity: 'blocking', requiredNames: ['FLY_PRIMARY_REGION'], missingNames: ['FLY_PRIMARY_REGION'], reason: 'FLY_PRIMARY_REGION is required for volume/machine creation' };

    const checks: RunnerProviderPreflightCheck[] = [tokenCheck, orgCheck, regionCheck, providerCheck, dedicatedCheck];
    const ok = checks.filter((c) => c.severity === 'blocking').every((c) => c.ok);
    return {
      providerId: 'fly_machines',
      ok,
      requiredVariables,
      requiredSecrets,
      missingVariables,
      missingSecrets,
      checks,
    };
  }

  async function createRunner(input: CreateRunnerInput): Promise<RunnerBinding> {
    if (!apiToken) throw new Error('fly_provider_missing_api_token');
    if (!org) throw new Error('fly_provider_missing_org');
    if (!input.userId.trim()) throw new Error('fly_create_runner_missing_user_id');
    if (!input.idempotencyKey.trim()) throw new Error('fly_create_runner_missing_idempotency_key');
    if (!input.runnerSharedSecret || input.runnerSharedSecret.length < 32) {
      throw new Error('fly_create_runner_shared_secret_too_short');
    }
    if (!input.workerProxyUrl.startsWith('https://')) {
      throw new Error('fly_create_runner_worker_proxy_url_must_be_https');
    }

    const imageRef = (input.imageRef ?? defaultImageRef ?? '').trim();
    if (!imageRef) throw new Error('fly_create_runner_missing_image_ref');

    const region = normalizeRegion(input.region ?? primaryRegion);
    const appName = await flyMachinesAppName(input, appPrefix);
    const volumeSizeGb = chooseVolumeSizeGb(input);
    const computeTier: ComputeTier = chooseComputeTier(input);
    const runtimeEnv = buildFlyRunnerEnv(input);

    // 1. Create the app (idempotent for our purposes — a second call with
    //    the same name returns 422 'app already exists' which we treat as
    //    an in-progress resume per the spec's idempotency requirement).
    // #28 — each runner app gets its OWN private 6PN network (named after the
    // app, which is unique per user) instead of the shared 'default' network.
    // On 'default' every org app shares the private network, so a compromised
    // runner (the agent has shell/code-exec as a feature) could reach a peer
    // runner's private endpoints. A per-app network isolates them; the runner
    // only needs public egress (to the Worker) + its loopback adapter, neither
    // of which depends on the 6PN, so this is pure isolation with no downside.
    const appResult = await fly({
      method: 'POST',
      path: '/apps',
      body: { app_name: appName, org_slug: org, network: appName },
    });
    if (!appResult.ok && appResult.status !== 422) {
      throw new Error(`fly_app_create_failed:${appResult.status}`);
    }
    // 422 = app already exists → we are resuming a prior (possibly partial)
    // provision, so the volume/machine steps below must REUSE, not duplicate,
    // any resources a previous attempt already created (GO_LIVE_TRACKER #11).
    const appAlreadyExisted = appResult.status === 422;

    // 1.5. Allocate public IPs. Apps created via the Machines API don't
    //      automatically get public ingress — `flyctl deploy` does this
    //      implicitly, the bare API doesn't. Without these, /healthz on
    //      `<app>.fly.dev` from the public internet returns "fetch failed"
    //      even though Fly's *internal* health check on the Machine's
    //      private IPv6 passes. We allocate both a shared v4 (free,
    //      multiplexes by SNI hostname) and a dedicated v6 (also free).
    //
    //      Idempotent: calling AllocateIpAddress twice returns 'already
    //      allocated' from Fly, which we treat as success.
    try {
      await ensureFlyAppPublicIps(appName);
    } catch (err) {
      throw new Error(`fly_app_ip_allocation_failed:${(err as Error)?.message ?? err}`);
    }

    // 2. Create (or reuse) the persistent volume. Volume-create is NOT
    //    idempotent on Fly — duplicate names are allowed — so a retried provision
    //    would leak a fresh 10-100 GB volume every attempt. On a retry, reuse the
    //    existing 'workspace' volume; only create one when the app was just made
    //    fresh (GO_LIVE_TRACKER #11).
    type FlyVolume = { id: string; region: string; size_gb: number; name?: string; state?: string; attached_machine_id?: string | null };
    type FlyMachine = {
      id: string;
      state?: string;
      region?: string;
      config?: { image?: string; env?: Record<string, string | undefined>; mounts?: Array<{ volume?: string; path?: string }> };
    };
    let volumeId: string | null = null;
    let machineId: string | null = null;
    let reusedMachineSecret: string | null = null;
    let appliedImageRef = imageRef;
    let appliedRegion = region;
    if (appAlreadyExisted) {
      // Discover the machine first. An independent first-volume choice can
      // bind the user's account to a different disk from their actual history.
      const existingMachines = await fly<FlyMachine[]>({
        method: 'GET', path: `/apps/${encodeURIComponent(appName)}/machines`,
      });
      const existingVolumes = await fly<FlyVolume[]>({
        method: 'GET',
        path: `/apps/${encodeURIComponent(appName)}/volumes`,
      });
      if (!existingMachines.ok || !Array.isArray(existingMachines.body)
        || !existingVolumes.ok || !Array.isArray(existingVolumes.body)) {
        throw new Error('fly_resource_inventory_unavailable');
      }
      const machines = existingMachines.body.filter((m) =>
        m && m.state !== 'destroyed' && m.state !== 'destroying' && m.state !== 'pending_destroy');
      const volumes = existingVolumes.body.filter((v) =>
        v?.name === 'workspace' && typeof v.id === 'string' && v.state === 'created');
      if (machines.length > 1) throw new Error('fly_resource_reconciliation_required:multiple_machines');
      const machine = machines[0];
      if (machine) {
        const mounts = machine.config?.mounts?.filter((m) => m.path === FLY_VOLUME_MOUNT_PATH) ?? [];
        const volume = volumes.find((v) => v.id === mounts[0]?.volume);
        const secret = machine.config?.env?.SIDEKICK_RUNNER_SHARED_SECRET;
        const actualImage = machine.config?.image;
        if (!machine.id || mounts.length !== 1 || !volume
          || (volume.attached_machine_id && volume.attached_machine_id !== machine.id)
          || machine.config?.env?.SIDEKICK_USER_ID !== input.userId
          || typeof secret !== 'string' || secret.length < 32
          || typeof actualImage !== 'string' || !actualImage.trim()) {
          throw new Error('fly_resource_reconciliation_required:invalid_machine_binding');
        }
        machineId = machine.id;
        volumeId = volume.id;
        reusedMachineSecret = secret;
        appliedImageRef = actualImage;
        appliedRegion = machine.region || volume.region;
      } else {
        const unattached = volumes.filter((v) => !v.attached_machine_id);
        if (volumes.length !== unattached.length || unattached.length > 1) {
          throw new Error('fly_resource_reconciliation_required:ambiguous_volumes');
        }
        if (unattached[0]) {
          volumeId = unattached[0].id;
          appliedRegion = unattached[0].region;
        }
      }
    }
    if (!volumeId) {
      const volumeResult = await fly<FlyVolume>({
        method: 'POST',
        path: `/apps/${encodeURIComponent(appName)}/volumes`,
        body: { name: 'workspace', region, size_gb: volumeSizeGb },
      });
      if (!volumeResult.ok || !volumeResult.body?.id) {
        throw new Error(`fly_volume_create_failed:${volumeResult.status}`);
      }
      volumeId = volumeResult.body.id;
    }

    // 3. Create (or reuse) the Machine from the golden image, with workspace
    //    mounted and per-user env injected. Same idempotency concern as the
    //    volume: on a retry, reuse an existing non-destroyed machine rather than
    //    spawning (and leaking) a second one (GO_LIVE_TRACKER #11).
    if (!machineId) {
    const machineResult = await fly<FlyMachine>({
      method: 'POST',
      path: `/apps/${encodeURIComponent(appName)}/machines`,
      body: {
        region: appliedRegion,
        config: {
          image: imageRef,
          guest: {
            cpu_kind: computeTier.cpuKind,
            cpus: computeTier.cpus,
            memory_mb: computeTier.memoryMb,
          },
          env: runtimeEnv,
          services: [{
            ports: [
              { port: 443, handlers: ['tls', 'http'] },
              { port: 80, handlers: ['http'] },
            ],
            protocol: 'tcp',
            internal_port: FLY_RUNNER_INTERNAL_PORT,
            // Cost control: stop the machine when idle, auto-start on the next
            // inbound request. 2026-06-11 — switched suspend->stop after a live
            // runner WEDGED (machine `started` but the uvicorn wrapper
            // unresponsive, /healthz timing out, needing a manual restart).
            // Root cause: `suspend` (pause-to-RAM) resume is intermittently
            // unreliable for this heavy ~2GB image (Chromium + Python + the
            // gateway subprocess), and Fly does NOT auto-restart on a failing
            // health check (only on process EXIT), so a bad resume has no
            // recovery. `stop` makes every wake a clean cold boot — the same
            // well-tested path as create — so `restart: on-failure` actually
            // covers a failed boot. Trade-off: ~30s cold start vs suspend's ~1s
            // (the Worker's readiness preflight already shows "waking up" + the
            // mobile client retries), in exchange for no wedge. Override with
            // FLY_RUNNER_AUTOSTOP if a future image makes suspend reliable.
            // Per-user allowlist first, so an internal account sleeps even
            // while the fleet is pinned always-on. See flyRunnerAutostopForUser.
            autostop: flyRunnerAutostopForUser(input.userId),
            autostart: true,
          }],
          // Mount at HERMES_HOME (NOT the workspace subdir) so state.db /
          // memories / sessions persist on the volume; the workspace is a
          // subdir created on the volume at runtime (defect: 2026-06-11).
          mounts: [{ volume: volumeId, path: FLY_VOLUME_MOUNT_PATH }],
          checks: {
            healthz: {
              type: 'http',
              port: FLY_RUNNER_INTERNAL_PORT,
              method: 'GET',
              path: '/healthz',
              interval: '15s',
              timeout: '5s',
              grace_period: '60s',
            },
          },
        },
      },
    });
    if (!machineResult.ok || !machineResult.body?.id) {
      // Surface Fly's error body in the thrown message so operators
      // can see WHAT broke instead of just the status code. Redact
      // the FLY token defensively in case it accidentally appears.
      const safeBody = redactFlyToken((machineResult.rawBody ?? '').slice(0, 400), apiToken);
      throw new Error(`fly_machine_create_failed:${machineResult.status}:${safeBody}`);
    }
    machineId = machineResult.body.id;
    }
    if (!machineId) {
      throw new Error('fly_machine_unavailable');
    }

    // Fly assigns <appName>.fly.dev as the public host for any app with
    // services defined. We never construct anything user-provided here.
    const runnerBaseUrl = `https://${appName}.fly.dev`;

    // 4. Wait for /healthz to pass. Surface 'provisioning' status until the
    //    runner is ready; the readiness loop in shared control plane code
    //    is then free to flip it to ready.
    const probe = config.probeRunnerHealth ?? defaultProbeRunnerHealth(fetchImpl);
    let healthOk = false;
    for (let attempt = 0; attempt < FLY_HEALTH_PROBE_MAX_ATTEMPTS; attempt += 1) {
      const result = await probe({ runnerBaseUrl, attemptIndex: attempt });
      if (result.ok) { healthOk = true; break; }
      await sleep(FLY_HEALTH_PROBE_INTERVAL_MS);
    }

    const binding: FlyMachinesRunnerBinding = {
      providerId: 'fly_machines',
      userId: input.userId,
      runnerBaseUrl,
      runnerSharedSecret: reusedMachineSecret ?? input.runnerSharedSecret,
      status: healthOk ? 'ready' : 'provisioning',
      createdAt: nowIso(config.now),
      lastHealthAt: healthOk ? nowIso(config.now) : null,
      fly: {
        org,
        appName,
        machineId,
        volumeId,
        region: appliedRegion,
        imageRef: appliedImageRef,
        // Slice from the digest marker itself: split('@')[1] mis-parses any
        // ref that carries more than one '@' (the digest is the persisted
        // reimage-idempotency comparand, so parse it precisely).
        imageDigest: appliedImageRef.includes('@sha256:') ? appliedImageRef.slice(appliedImageRef.indexOf('@sha256:') + 1) : null,
      },
    };
    return binding;
  }

  function requireFlyBinding(binding: RunnerBinding, op: string): FlyMachinesRunnerBinding {
    if (binding.providerId !== 'fly_machines') {
      throw new Error(`fly_provider_wrong_binding_for_${op}:${binding.providerId}`);
    }
    return binding;
  }

  async function startRunner(binding: RunnerBinding): Promise<RunnerProviderActionResult> {
    const fb = requireFlyBinding(binding, 'start');
    try {
      const result = await fly({
        method: 'POST',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}/machines/${encodeURIComponent(fb.fly.machineId)}/start`,
      });
      if (!result.ok && result.status !== 200 && result.status !== 202) {
        return { ok: false, errorCode: `fly_machine_start_failed_${result.status}`.slice(0, 64), errorMessage: 'Could not start the runner.' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, errorCode: 'fly_machine_start_failed', errorMessage: redactFlyToken(String((err as Error)?.message ?? err), apiToken).slice(0, 200) };
    }
  }

  async function stopRunner(binding: RunnerBinding): Promise<RunnerProviderActionResult> {
    const fb = requireFlyBinding(binding, 'stop');
    try {
      const result = await fly({
        method: 'POST',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}/machines/${encodeURIComponent(fb.fly.machineId)}/stop`,
      });
      if (!result.ok && result.status !== 200 && result.status !== 202) {
        return { ok: false, errorCode: `fly_machine_stop_failed_${result.status}`.slice(0, 64), errorMessage: 'Could not stop the runner.' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, errorCode: 'fly_machine_stop_failed', errorMessage: redactFlyToken(String((err as Error)?.message ?? err), apiToken).slice(0, 200) };
    }
  }

  async function deleteRunner(binding: RunnerBinding, options: DeleteRunnerOptions = {}): Promise<RunnerProviderActionResult> {
    const fb = requireFlyBinding(binding, 'delete');
    const force = options.force === true;
    const authorize = async () => {
      if (options.beforeDelete && !await options.beforeDelete()) throw new Error('stale_deletion_claim');
    };
    try {
      // Always destroy the Machine first; under Option A cancellation this
      // is the only step.
      await authorize();
      const machineResult = await fly({
        method: 'DELETE',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}/machines/${encodeURIComponent(fb.fly.machineId)}?force=true`,
      });
      if (!machineResult.ok && machineResult.status !== 404) {
        return { ok: false, errorCode: `fly_machine_delete_failed_${machineResult.status}`.slice(0, 64), errorMessage: 'Could not delete the runner machine.' };
      }
      if (!force) {
        // Option A: keep volume + app around so the user can resume.
        return { ok: true };
      }
      // Force teardown: destroy volume + app too. Gated upstream by
      // SIDEKICK_ALLOW_FLY_TEST_DESTROY=true; this method just executes.
      await authorize();
      const volumeResult = await fly({
        method: 'DELETE',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}/volumes/${encodeURIComponent(fb.fly.volumeId)}`,
      });
      if (!volumeResult.ok && volumeResult.status !== 404) {
        return { ok: false, errorCode: `fly_volume_delete_failed_${volumeResult.status}`.slice(0, 64), errorMessage: 'Could not delete the runner volume.' };
      }
      await authorize();
      const appResult = await fly({
        method: 'DELETE',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}`,
      });
      if (!appResult.ok && appResult.status !== 404) {
        return { ok: false, errorCode: `fly_app_delete_failed_${appResult.status}`.slice(0, 64), errorMessage: 'Could not delete the runner app.' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, errorCode: 'fly_runner_delete_failed', errorMessage: redactFlyToken(String((err as Error)?.message ?? err), apiToken).slice(0, 200) };
    }
  }

  async function getHealth(binding: RunnerBinding): Promise<RunnerHealth> {
    const fb = requireFlyBinding(binding, 'getHealth');
    const probe = config.probeRunnerHealth ?? defaultProbeRunnerHealth(fetchImpl);
    const checkedAt = nowIso(config.now);
    let result: { ok: boolean; status: number };
    try {
      result = await probe({ runnerBaseUrl: fb.runnerBaseUrl, attemptIndex: 0 });
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        hermesAvailable: false,
        workspaceReady: false,
        hermesVersion: null,
        lastCheckedAt: checkedAt,
        errorCode: 'fly_runner_health_probe_failed',
        errorMessage: redactFlyToken(String((err as Error)?.message ?? err), apiToken).slice(0, 200),
      };
    }
    if (!result.ok) {
      return {
        ok: false,
        status: 'error',
        hermesAvailable: false,
        workspaceReady: false,
        hermesVersion: null,
        lastCheckedAt: checkedAt,
        errorCode: `fly_runner_health_${result.status}`.slice(0, 64),
        errorMessage: 'Runner health probe did not return ok.',
      };
    }
    // The probe interface intentionally doesn't surface hermesAvailable /
    // workspaceReady / hermesVersion — those come from the runner's own
    // /healthz body. For Phase 2 we report the bare ok/status; Phase 5's
    // richer health probe pulls those fields directly.
    return {
      ok: true,
      status: 'ready',
      hermesAvailable: true,
      workspaceReady: true,
      hermesVersion: null,
      lastCheckedAt: checkedAt,
    };
  }

  async function resizeRunner(
    binding: RunnerBinding,
    request: { targetTierId: PlanTierId },
  ): Promise<ResizeRunnerResult> {
    const fb = requireFlyBinding(binding, 'resize');
    const targetVolumeGb = DEFAULT_VOLUME_SIZE_GB_BY_TIER[request.targetTierId]
      ?? DEFAULT_VOLUME_SIZE_GB_BY_TIER.studio;
    const targetCompute = DEFAULT_COMPUTE_TIER_BY_PLAN[request.targetTierId]
      ?? DEFAULT_COMPUTE_TIER_BY_PLAN.studio;

    let deferred: 'shrink_on_renewal' | undefined;
    let currentVolumeGb = 0;

    // Step 1: read the current volume size. Defect hunt 2026-09-03 (D8): this
    // used to extend the volume straight to the tier's full allowance (40 GB
    // for Pro Office, 100 GB for Enterprise Suite) the moment the plan
    // changed, and Fly bills every provisioned GB whether it holds anything
    // or not. Provisioning already starts every workspace at
    // START_VOLUME_SIZE_GB and lets the hourly storage sweep double the
    // volume on demand once it is STORAGE_GROW_AT_FRACTION full, capped at
    // the tier's storage_quota_bytes, which the billing webhook rewrites on
    // every tier change. A plan change now follows the same rule: compute is
    // resized here, storage keeps growing on demand under the new cap. The
    // inspect stays so a downgrade below the current size is still flagged.
    try {
      type FlyVolumeInfo = { size_gb?: number };
      const inspect = await fly<FlyVolumeInfo>({
        method: 'GET',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}/volumes/${encodeURIComponent(fb.fly.volumeId)}`,
      });
      currentVolumeGb = typeof inspect.body?.size_gb === 'number' ? inspect.body.size_gb : 0;

      if (targetVolumeGb < currentVolumeGb) {
        // Fly volumes cannot shrink in place. The caller (lifecycle handler)
        // is expected to persist the desired-size and run a snapshot+swap
        // at the next renewal window.
        deferred = 'shrink_on_renewal';
      }
    } catch (err) {
      return {
        ok: false,
        reason: `fly_volume_inspect_failed:${redactFlyToken(String((err as Error)?.message ?? err), apiToken).slice(0, 120)}`,
      };
    }

    // Step 2: resize compute. Fly supports PATCH on /machines/{id} with new
    // guest spec. Machine is restarted in place; downtime is sub-second.
    try {
      const patch = await fly({
        method: 'POST',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}/machines/${encodeURIComponent(fb.fly.machineId)}`,
        body: {
          config: {
            guest: {
              cpu_kind: targetCompute.cpuKind,
              cpus: targetCompute.cpus,
              memory_mb: targetCompute.memoryMb,
            },
          },
        },
      });
      if (!patch.ok) {
        return { ok: false, reason: `fly_machine_resize_failed_${patch.status}` };
      }
    } catch (err) {
      return {
        ok: false,
        reason: `fly_machine_resize_failed:${redactFlyToken(String((err as Error)?.message ?? err), apiToken).slice(0, 120)}`,
      };
    }

    return {
      ok: true,
      // The volume is untouched here; the storage sweep grows it on demand.
      appliedVolumeGb: currentVolumeGb,
      appliedCompute: targetCompute,
      ...(deferred ? { deferred } : {}),
    };
  }

  async function reimageRunner(
    binding: RunnerBinding,
    request: ReimageRunnerRequest,
  ): Promise<ReimageRunnerResult> {
    const fb = requireFlyBinding(binding, 'reimage');
    const targetImageRef = (request.targetImageRef ?? defaultImageRef ?? '').trim();
    if (!targetImageRef) {
      return { ok: false, reason: 'reimage_missing_target_image_ref' };
    }
    const targetDigest = targetImageRef.includes('@sha256:') ? targetImageRef.slice(targetImageRef.indexOf('@sha256:') + 1) : null;

    // 1. Read the FULL current machine config. Fly's machine-update endpoint
    //    (POST /machines/{id}) REPLACES the config wholesale, so we must
    //    round-trip the entire config and swap only `image`; a partial body
    //    would drop the volume mount, per-user env, services + health checks.
    type FlyMachineGet = { id?: string; config?: Record<string, unknown>; state?: string };
    let current: FlyApiResponse<FlyMachineGet>;
    try {
      current = await fly<FlyMachineGet>({
        method: 'GET',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}/machines/${encodeURIComponent(fb.fly.machineId)}`,
      });
    } catch (err) {
      return { ok: false, reason: `fly_machine_inspect_failed:${redactFlyToken(String((err as Error)?.message ?? err), apiToken).slice(0, 120)}` };
    }
    if (!current.ok || !current.body?.config) {
      return { ok: false, reason: `fly_machine_inspect_failed_${current.status}` };
    }
    const currentConfig = current.body.config as Record<string, unknown>;
    const currentImage = typeof currentConfig.image === 'string' ? currentConfig.image : '';

    // Refresh the capability toolset env on every reimage so the rolling-reimage
    // cron HEALS existing runners' toolsets, not just their image. Without this,
    // a runner provisioned before HERMES_TOOLSETS was injected (2026-05-30) would
    // gain the new Chromium image but keep its stale env, leaving browser /
    // code_execution / memory / etc. off. We merge ONLY HERMES_TOOLSETS, so every
    // per-user value (identity, shared secret, worker proxy URL, agent name) is
    // preserved verbatim.
    const routeBEnabled = flyRunnerRouteBEnabled();
    const desiredToolsets = buildDelegentRunnerToolsets(routeBEnabled).join(',');
    const currentEnv = (currentConfig.env && typeof currentConfig.env === 'object')
      ? (currentConfig.env as Record<string, string>)
      : {};
    const platformCurrent = !routeBEnabled || currentEnv.DELEGENT_PLATFORM_ENABLED === 'true';
    const toolsetsCurrent = currentEnv.HERMES_TOOLSETS === desiredToolsets && platformCurrent;

    // Heal the system prompt too. It is the agent's whole rulebook (what it may
    // do unattended, where it must save files, to check the key vault before
    // claiming it has no access), and it used to be refreshed ONLY on create.
    // A user pressing "Update my coworker" therefore got the new image and the
    // new skills but kept whatever behaviour rules they were provisioned with,
    // so half of every behavioural fix silently never reached existing users.
    // The agent name is per-user and stays exactly as it is.
    const agentName = currentEnv.HERMES_AGENT_NAME || currentEnv.SIDEKICK_AGENT_NAME || '';
    const desiredPrompt = agentName ? buildDelegentSystemPrompt(agentName) : null;
    const promptCurrent = desiredPrompt === null || currentEnv.HERMES_SYSTEM_PROMPT === desiredPrompt;

    // Also heal the cost-control auto-stop config on reimage, so the rolling cron
    // brings the EXISTING fleet onto the configured idle policy (autostop=stop by
    // default since 2026-06-11 — see flyRunnerAutostop + the create-path comment;
    // older runners may carry autostop=suspend, which wedged a live box). We set
    // autostop + autostart=true on every service, preserving ports/handlers/checks.
    // Per-user allowlist first: without this the reimage cron heals an
    // internal account's idle-sleep setting straight back to the fleet's
    // always-on value, silently undoing it.
    const desiredAutostop = flyRunnerAutostopForUser(binding.userId);
    const currentServices = Array.isArray(currentConfig.services)
      ? (currentConfig.services as Array<Record<string, unknown>>)
      : [];
    // Fly's Machines API is inconsistent here: we POST the string 'stop', but a
    // GET returns the LEGACY BOOLEAN `true` for it (and `false` for 'off');
    // 'suspend' has no boolean form so it round-trips as the string. Normalize
    // both representations or the idempotency check never matches a real runner
    // and the reimage cron re-POSTs every tick. (Verified live 2026-06-11.)
    const autostopCurrent = currentServices.length > 0
      && currentServices.every((s) => s && normalizeAutostop(s.autostop) === desiredAutostop && s.autostart === true);

    // Idempotent no-op: already on the target image AND the toolset env AND the
    // system prompt AND the auto-stop config are all current. If ANY is stale we
    // apply (this is what lets the cron refresh a runner whose image is current
    // but env/prompt/autostop old).
    if (currentImage && currentImage === targetImageRef && toolsetsCurrent && promptCurrent && autostopCurrent) {
      const probe = config.probeRunnerHealth ?? defaultProbeRunnerHealth(fetchImpl);
      const health = await probe({ runnerBaseUrl: fb.runnerBaseUrl, attemptIndex: 0 }).catch(() => ({ ok: false }));
      if (!health.ok) return { ok: false, reason: 'fly_reimage_health_unavailable' };
      return { ok: true, alreadyCurrent: true, appliedImageRef: targetImageRef, appliedImageDigest: targetDigest, healthy: true };
    }

    // 2. POST the full config back with the image swapped + the toolset env
    //    refreshed + auto-stop applied. The volume mount in config.mounts is
    //    preserved verbatim, so /data/hermes/workspace survives the swap; downtime
    //    is a single machine restart.
    const nextServices = currentServices.map((s) => ({ ...s, autostop: desiredAutostop, autostart: true }));
    const nextConfig = {
      ...currentConfig,
      image: targetImageRef,
      env: {
        ...currentEnv,
        HERMES_TOOLSETS: desiredToolsets,
        ...(desiredPrompt ? { HERMES_SYSTEM_PROMPT: desiredPrompt } : {}),
        // Route B: heal the delegent gateway-platform opt-in onto existing
        // runners on reimage (the session_search toolset is already folded into
        // desiredToolsets above). See docs/CHAT_ROUTE_B_DESIGN.md.
        ...(routeBEnabled ? { DELEGENT_PLATFORM_ENABLED: 'true' } : {}),
        // Heal the web-search config onto existing runners on reimage (so the
        // Firecrawl URL/key reaches already-provisioned users), same source as
        // buildFlyRunnerEnv. Skips any not set in the provisioner env.
        ...Object.fromEntries(
          DELEGENT_WEB_SEARCH_ENV_PASSTHROUGH
            .map((name) => [name, process.env[name]])
            .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
            .map(([name, v]) => [name, String(v).trim()]),
        ),
      },
      ...(nextServices.length > 0 ? { services: nextServices } : {}),
    };
    let update: FlyApiResponse;
    try {
      update = await fly({
        method: 'POST',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}/machines/${encodeURIComponent(fb.fly.machineId)}`,
        body: { config: nextConfig },
      });
    } catch (err) {
      return { ok: false, reason: `fly_machine_reimage_failed:${redactFlyToken(String((err as Error)?.message ?? err), apiToken).slice(0, 120)}` };
    }
    if (!update.ok) {
      const safeBody = redactFlyToken((update.rawBody ?? '').slice(0, 200), apiToken);
      return { ok: false, reason: `fly_machine_reimage_failed_${update.status}:${safeBody}` };
    }

    // 3. Wait for /healthz to pass again after the restart, mirroring the
    //    post-create probe loop.
    const probe = config.probeRunnerHealth ?? defaultProbeRunnerHealth(fetchImpl);
    let healthy = false;
    for (let attempt = 0; attempt < FLY_HEALTH_PROBE_MAX_ATTEMPTS; attempt += 1) {
      let result: { ok: boolean; status: number };
      try {
        result = await probe({ runnerBaseUrl: fb.runnerBaseUrl, attemptIndex: attempt });
      } catch {
        result = { ok: false, status: 0 };
      }
      if (result.ok) { healthy = true; break; }
      await sleep(FLY_HEALTH_PROBE_INTERVAL_MS);
    }

    if (!healthy) return { ok: false, reason: 'fly_reimage_health_timeout' };
    return { ok: true, alreadyCurrent: false, appliedImageRef: targetImageRef, appliedImageDigest: targetDigest, healthy: true };
  }

  // Volume-level usage, not `du` inside the machine: Fly reports the ext4
  // block accounting on the volume itself, so this works while the runner is
  // busy or stopped and needs no shell tooling in the golden image.
  async function getStorageUsage(binding: RunnerBinding): Promise<StorageUsageResult> {
    const fb = requireFlyBinding(binding, 'getStorageUsage');
    type FlyVolumeUsage = { blocks?: number; blocks_free?: number; block_size?: number; size_gb?: number };
    let inspect: Awaited<ReturnType<typeof fly<FlyVolumeUsage>>>;
    try {
      inspect = await fly<FlyVolumeUsage>({
        method: 'GET',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}/volumes/${encodeURIComponent(fb.fly.volumeId)}`,
      });
    } catch (err) {
      return { ok: false, reason: `fly_volume_usage_failed:${redactFlyToken(String((err as Error)?.message ?? err), apiToken).slice(0, 120)}` };
    }
    if (!inspect.ok) {
      return { ok: false, reason: `fly_volume_usage_failed_${inspect.status}` };
    }
    const blocks = numberOrNull(inspect.body?.blocks);
    const blocksFree = numberOrNull(inspect.body?.blocks_free);
    const blockSize = numberOrNull(inspect.body?.block_size);
    const sizeGb = numberOrNull(inspect.body?.size_gb);
    if (blocks === null || blocksFree === null || blockSize === null || blockSize <= 0 || blocks <= 0) {
      // A volume that has never been mounted reports no block accounting, and
      // Fly also zeroes these fields briefly right after an extend.
      return { ok: false, reason: 'fly_volume_usage_unavailable' };
    }
    return {
      ok: true,
      usedBytes: Math.max(0, Math.round((blocks - blocksFree) * blockSize)),
      capacityBytes: Math.max(0, Math.round(blocks * blockSize)),
      sizeGb: sizeGb ?? 0,
    };
  }

  // Online: verified 2026-07-25 that the mounted filesystem reports the new
  // size within seconds with no restart, so this never interrupts a session.
  async function growStorage(
    binding: RunnerBinding,
    request: { targetSizeGb: number },
  ): Promise<GrowStorageResult> {
    const fb = requireFlyBinding(binding, 'growStorage');
    const targetSizeGb = Math.floor(request.targetSizeGb);
    if (!Number.isFinite(targetSizeGb) || targetSizeGb <= 0) {
      return { ok: false, reason: 'fly_volume_grow_invalid_target' };
    }
    let extend: Awaited<ReturnType<typeof fly<{ volume?: { size_gb?: number } }>>>;
    try {
      extend = await fly<{ volume?: { size_gb?: number } }>({
        method: 'PUT',
        path: `/apps/${encodeURIComponent(fb.fly.appName)}/volumes/${encodeURIComponent(fb.fly.volumeId)}/extend`,
        body: { size_gb: targetSizeGb },
      });
    } catch (err) {
      return { ok: false, reason: `fly_volume_grow_failed:${redactFlyToken(String((err as Error)?.message ?? err), apiToken).slice(0, 120)}` };
    }
    if (!extend.ok) {
      return { ok: false, reason: `fly_volume_grow_failed_${extend.status}` };
    }
    return { ok: true, appliedSizeGb: numberOrNull(extend.body?.volume?.size_gb) ?? targetSizeGb };
  }

  return {
    providerId: 'fly_machines',
    preflight,
    createRunner,
    startRunner,
    stopRunner,
    deleteRunner,
    getHealth,
    resizeRunner,
    reimageRunner,
    getStorageUsage,
    growStorage,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function defaultProbeRunnerHealth(
  fetchImpl: typeof fetch,
): (input: { runnerBaseUrl: string; attemptIndex: number }) => Promise<{ ok: boolean; status: number }> {
  return async (input) => {
    const url = `${input.runnerBaseUrl.replace(/\/+$/, '')}/healthz`;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      try { await response.text(); } catch { /* ignore */ }
      return { ok: response.ok, status: response.status };
    } catch {
      return { ok: false, status: 0 };
    }
  };
}
