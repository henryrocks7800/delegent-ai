import { createHmac } from 'node:crypto';
import type { PlanTierId } from '@sidekick/shared';
import {
  DELEGENT_EMOJI_LEVEL,
  DELEGENT_GREETING_TONE,
  DELEGENT_MEMORY_ENABLED,
  DELEGENT_SKILLS_DIR_DEFAULT,
  DELEGENT_TOOL_APPROVAL,
  DELEGENT_TURN_VERBOSITY,
  DELEGENT_RUNNER_MODEL,
  buildDelegentExamplePromptsEnvValue,
  buildDelegentSystemPrompt,
  buildDelegentWakeMessageForName,
} from './delegentAgentDefaults.js';

export const RAILWAY_GRAPHQL_ENDPOINT = 'https://api.railway.app/graphql/v2';

export const HERMES_AGENT_RAILWAY_TEMPLATE = {
  id: '0aff3c95-d48f-45c0-9fb9-81d1324091db',
  code: 'hermes-agent-ai',
  serviceRef: 'cc1c77a9-ba80-4ba2-834d-d280903ff225',
  sourceRepo: 'https://github.com/praveen-ks-2001/hermes-agent-template',
  sourceRootDirectory: null,
  runnerServerUrlVariable: 'SIDEKICK_RUNNER_SERVER_URL',
  icon: 'https://raw.githubusercontent.com/NousResearch/hermes-agent/refs/heads/main/website/static/img/apple-touch-icon.png',
  port: '8642',
  volumeMountPath: '/data',
} as const;

export const SIDEKICK_RUNNER_RUNTIME_BASE_IMAGE = 'ghcr.io/astral-sh/uv:python3.12-bookworm-slim';

export const RAILWAY_TEMPLATE_DEPLOY_V2_MUTATION = `
mutation DeployHermesAgentTemplate($input: TemplateDeployV2Input!) {
  templateDeployV2(input: $input) {
    projectId
    workflowId
  }
}
`;

export const RAILWAY_PROJECT_DELETE_MUTATION = `
mutation DeleteRailwayProject($id: String!) {
  projectDelete(id: $id)
}
`;

export const RAILWAY_PROJECT_RUNNER_ENDPOINT_QUERY = `
query DiscoverHermesRunnerProject($projectId: String!) {
  project(id: $projectId) {
    id
    services {
      edges {
        node {
          id
          name
          templateId
          templateServiceId
        }
      }
    }
    environments {
      edges {
        node {
          id
          name
        }
      }
    }
    volumes {
      edges {
        node {
          id
          name
        }
      }
    }
  }
}
`;

export const RAILWAY_RUNNER_SERVICE_ENDPOINT_QUERY = `
query DiscoverHermesRunnerServiceEndpoint($projectId: String!, $serviceId: String!, $environmentId: String!) {
  domains(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId) {
    serviceDomains {
      id
      domain
      targetPort
      syncStatus
    }
    customDomains {
      id
      domain
      targetPort
      syncStatus
    }
  }
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    latestDeployment {
      status
      url
      staticUrl
    }
    activeDeployments {
      status
      url
      staticUrl
    }
  }
}
`;

export const RAILWAY_RUNNER_SERVICE_INSTANCE_UPDATE_MUTATION = `
mutation ConfigureHermesRunnerServiceInstance($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}
`;

export const RAILWAY_RUNNER_SERVICE_INSTANCE_REDEPLOY_MUTATION = `
mutation RedeployHermesRunnerServiceInstance($serviceId: String!, $environmentId: String!) {
  serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
}
`;

export const RAILWAY_RUNNER_VARIABLE_COLLECTION_UPSERT_MUTATION = `
mutation UpsertHermesRunnerBootstrapVariables($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}
`;

export const RAILWAY_RUNNER_SERVICE_CONNECT_MUTATION = `
mutation ConnectHermesRunnerServiceToRuntimeImage($serviceId: String!, $input: ServiceConnectInput!) {
  serviceConnect(id: $serviceId, input: $input) {
    id
  }
}
`;

export const RAILWAY_RUNNER_VOLUME_INSTANCE_UPDATE_MUTATION = `
mutation UpdateHermesRunnerVolumeInstance($volumeId: String!, $environmentId: String!, $input: VolumeInstanceUpdateInput!) {
  volumeInstanceUpdate(volumeId: $volumeId, environmentId: $environmentId, input: $input)
}
`;

export interface ProvisionInput {
  userId: string;
  railwayToken: string;
  tierId: PlanTierId;
  agentName?: string | null;
  railwayWorkspaceId?: string | null;
  railwayProjectId?: string | null;
  railwayEnvironmentId?: string | null;
  adminUsername?: string | null;
  adminPassword?: string | null;
  image?: string | null;
  workerProxyUrl?: string | null;
  runnerSharedSecret?: string | null;
  runnerServerUrl?: string | null;
  allowedToolsets?: readonly string[];
}

export interface RailwayPreflightInput {
  env: Record<string, string | undefined>;
  image?: string | null;
  workerProxyUrl?: string | null;
  runnerSharedSecret?: string | null;
  runnerServerUrl?: string | null;
  tierId: PlanTierId;
  allowedToolsets?: readonly string[];
}

export interface RailwayPreflightCheck {
  id: string;
  ok: boolean;
  severity: 'blocking' | 'warning';
  requiredNames: readonly string[];
  missingNames: readonly string[];
  reason: string;
}

export interface RailwayProvisionerPreflightReport {
  ok: boolean;
  provider: 'railway';
  requiredVariables: readonly string[];
  requiredSecrets: readonly string[];
  missingVariables: readonly string[];
  missingSecrets: readonly string[];
  checks: readonly RailwayPreflightCheck[];
}

export interface RunnerEnvironmentInput {
  userId: string;
  workerProxyUrl: string;
  runnerSharedSecret: string;
  tierId: PlanTierId;
  agentName?: string | null;
  allowedToolsets?: readonly string[];
}

export interface RailwayTemplateVariableSpec {
  isOptional: boolean;
  description: string;
  defaultValue: string;
}

export interface RailwayTemplateServiceConfig {
  icon: string;
  name: string;
  deploy: {
    startCommand: string | null;
    healthcheckPath: string | null;
    preDeployCommand?: readonly string[];
    restartPolicyType: 'ON_FAILURE';
    restartPolicyMaxRetries: 10;
  };
  source: {
    repo: string;
    rootDirectory: string | null;
  };
  variables: Record<string, RailwayTemplateVariableSpec>;
  networking: {
    serviceDomains: Record<string, Record<string, never>>;
  };
  volumeMounts: Record<string, { mountPath: string }>;
}

export interface RailwayTemplateSerializedConfig {
  buckets: Record<string, never>;
  services: Record<string, RailwayTemplateServiceConfig>;
}

export interface RailwayTemplateDeployInput {
  templateId: string;
  workspaceId?: string;
  projectId?: string;
  environmentId?: string;
  serializedConfig: RailwayTemplateSerializedConfig;
}

export interface RailwayProvisioningPlan {
  idempotencyKey: string;
  engine: 'hermes-agent';
  deploymentMode: 'railway-template';
  template: typeof HERMES_AGENT_RAILWAY_TEMPLATE;
  templateDeployInput: RailwayTemplateDeployInput;
  serviceImage?: string;
  persistentVolumeGb: 40;
  volumeMountPath: '/data';
  environment: Record<string, string>;
}

export interface RailwayTemplateDeployPayload {
  projectId: string;
  workflowId?: string | null;
  runnerBaseUrl?: string | null;
}

export interface RailwayRunnerEndpointPayload {
  projectId: string;
  environmentId?: string | null;
  serviceId?: string | null;
  volumeId?: string | null;
  runnerBaseUrl?: string | null;
  deploymentStatus?: string | null;
}

export interface RailwayApiClient {
  templateDeployV2(input: RailwayTemplateDeployInput, railwayToken: string): Promise<RailwayTemplateDeployPayload>;
  discoverHermesRunnerEndpoint?(projectId: string, railwayToken: string): Promise<RailwayRunnerEndpointPayload>;
  configureHermesRunnerServiceInstance?(input: RailwayRunnerServiceInstanceConfigInput, railwayToken: string): Promise<void>;
  projectDelete?(projectId: string, railwayToken: string): Promise<boolean>;
}

export interface ProvisionDeps {
  railway?: RailwayApiClient;
}

export interface ProvisionResult {
  railwayProjectId: string;
  railwayWorkflowId?: string;
  railwayServiceId?: string;
  railwayVolumeId?: string;
  runnerBaseUrl?: string;
  runnerSharedSecret: string;
  status: 'provisioning';
  volumeGb: 40;
  volumeMountPath: '/data';
  idempotencyKey: string;
  templateId: string;
  templateCode: string;
  adminUsername: string;
}

export interface RailwayRunnerServiceInstanceConfigInput {
  serviceId: string;
  environmentId: string;
  projectId?: string | null;
  volumeId?: string | null;
}

export interface ClaimedHermesProvisioningJob {
  userId: string;
  tierId: PlanTierId;
  idempotencyKey: string;
  claimedAt: string;
  agentName?: string;
}

export interface HermesProvisioningFailure {
  errorCode: string;
  publicStatusMessage: string;
}

export interface HermesProvisioningStateStore {
  claimNextQueuedHermesJob(): Promise<ClaimedHermesProvisioningJob | null>;
  markHermesProvisioningRequested(job: ClaimedHermesProvisioningJob, result: ProvisionResult): Promise<void>;
  markHermesProvisioningFailed(job: ClaimedHermesProvisioningJob, failure: HermesProvisioningFailure): Promise<void>;
  markHermesProvisioningReconciliationRequired(job: ClaimedHermesProvisioningJob, failure: HermesProvisioningFailure): Promise<void>;
}

export interface HermesTestRunnerCleanupTarget {
  userId: string;
  railwayProjectId: string;
}

export interface HermesTestRunnerCleanupStateStore {
  verifyHermesTestRunnerCleanupTarget(target: HermesTestRunnerCleanupTarget): Promise<void>;
  markHermesTestRunnerCleanedUp(target: HermesTestRunnerCleanupTarget): Promise<void>;
}

export interface CleanupHermesTestRunnerInput extends HermesTestRunnerCleanupTarget {
  railwayToken: string;
  allowRailwayDelete?: boolean;
  protectedRailwayProjectId?: string | null;
}

export interface CleanupHermesTestRunnerDeps {
  railway?: RailwayApiClient;
  store: HermesTestRunnerCleanupStateStore;
}

export interface CleanupHermesTestRunnerResult {
  status: 'deleted';
  railwayProjectId: string;
}

export interface ClaimedHermesReadinessJob {
  userId: string;
  runnerBaseUrl: string;
  runnerSharedSecret: string;
  claimedAt: string;
}

export interface HermesRunnerReadinessStateStore {
  claimNextHermesReadinessCheck(): Promise<ClaimedHermesReadinessJob | null>;
  markHermesRunnerReady(job: ClaimedHermesReadinessJob): Promise<void>;
  markHermesRunnerReadinessFailed(job: ClaimedHermesReadinessJob, failure: HermesProvisioningFailure): Promise<void>;
}

export interface ClaimedHermesRunnerDomainDiscoveryJob {
  userId: string;
  railwayProjectId: string;
  claimedAt: string;
}

export interface HermesRunnerDomainDiscoveryStateStore {
  claimNextHermesRunnerDomainDiscovery(): Promise<ClaimedHermesRunnerDomainDiscoveryJob | null>;
  markHermesRunnerDomainDiscovered(job: ClaimedHermesRunnerDomainDiscoveryJob, endpoint: RailwayRunnerEndpointPayload): Promise<void>;
}

export interface RunnerHealthRequest {
  url: string;
  userId: string;
  runnerSharedSecret: string;
}

export interface RunnerHealthClient {
  fetchHealth(request: RunnerHealthRequest): Promise<Record<string, unknown>>;
}

export interface ProcessHermesRunnerReadinessInput {}

export interface ProcessHermesRunnerReadinessDeps {
  store: HermesRunnerReadinessStateStore;
  runnerHealth?: RunnerHealthClient;
}

export type ProcessHermesRunnerReadinessResult =
  | { status: 'idle' }
  | { status: 'ready' }
  | { status: 'not_ready'; errorCode: string }
  | { status: 'failed'; errorCode: string };

export interface ProcessHermesRunnerDomainDiscoveryInput {
  env: Record<string, string | undefined>;
}

export interface ProcessHermesRunnerDomainDiscoveryDeps extends ProvisionDeps {
  store: HermesRunnerDomainDiscoveryStateStore;
}

export type ProcessHermesRunnerDomainDiscoveryResult =
  | { status: 'idle' }
  | { status: 'domain_found' }
  | { status: 'domain_pending'; errorCode?: string; deploymentStatus?: string }
  | { status: 'failed'; errorCode: string };

export interface ProcessHermesProvisioningInput {
  env: Record<string, string | undefined>;
}

export interface ProcessHermesProvisioningDeps extends ProvisionDeps {
  store: HermesProvisioningStateStore;
}

export type ProcessHermesProvisioningResult =
  | {
      status: 'blocked';
      missingSecrets: readonly string[];
      missingVariables: readonly string[];
    }
  | { status: 'idle' }
  | {
      status: 'provisioning';
      railwayProjectId: string;
      railwayWorkflowId?: string;
      templateId: string;
      templateCode: string;
    }
  | {
      status: 'failed';
      errorCode: string;
    }
  | {
      status: 'reconcile_required';
      errorCode: string;
    };

// Capability parity (2026-05-30): toolsets are NO LONGER gated by tier. Every
// paid plan gets the full Hermes toolset out of the box - the goal is that our
// agent can do everything the upstream Hermes agent can. Tiers differ ONLY by
// the compute (server size) and the monthly token allowance you get, never by
// what the agent is allowed to do. See docs/HERMES_PARITY.md.
//
// These are upstream Hermes toolset names. The matching backends are installed
// in the golden image (services/hermes-runner/Dockerfile.fly): a headless
// Chromium for `browser`, Python for `terminal`/`code_execution`, and a
// volume-backed HERMES_HOME for `memory`/`session_search`/`cronjob`.
const FULL_TOOLSETS: readonly string[] = [
  'file',
  'web',
  'search',
  'terminal',
  'process',
  'browser',
  'code_execution',
  'memory',
  // 'session_search' removed 2026-06-10 (kept in sync with the canonical
  // DELEGENT_RUNNER_TOOLSETS): the gateway path persists no resumable sessions,
  // so it always returned empty and made the agent deny real chat history.
  'cronjob',
  'vision',
  'todo',
  'clarify',
  'delegate_task',
  'skills',
  'debugging',
];
const TOOLSETS_BY_TIER: Record<PlanTierId, readonly string[]> = {
  studio: FULL_TOOLSETS,
  'pro-office': FULL_TOOLSETS,
  'enterprise-suite': FULL_TOOLSETS,
};

const SIDEKICK_RUNNER_LOCAL_OPENAI_BASE_URL = `http://127.0.0.1:${HERMES_AGENT_RAILWAY_TEMPLATE.port}/v1`;
const LOCAL_ADAPTER_KEY_MESSAGE = 'sidekick-local-adapter:v1';
const DEFAULT_AGENT_NAME = 'Ruben';
const DEFAULT_RUNNER_HEALTH_TIMEOUT_MS = 15_000;
const SECRET_LIKE_RUNNER_ENV_NAMES = new Set([
  'SIDEKICK_RUNNER_SHARED_SECRET',
  'OPENAI_API_KEY',
  'HERMES_API_KEY',
  'ADMIN_PASSWORD',
]);

function deriveLocalAdapterApiKey(runnerSharedSecret: string): string {
  const digest = createHmac('sha256', runnerSharedSecret).update(LOCAL_ADAPTER_KEY_MESSAGE).digest('hex');
  return `sidekick-local.${digest}`;
}

function redactRunnerEnvironment(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, SECRET_LIKE_RUNNER_ENV_NAMES.has(key) ? '[REDACTED]' : value]),
  );
}

function requireNonEmpty(value: string | null | undefined, field: string): string {
  if (!value || value.trim().length === 0) throw new Error(`${field} required`);
  return value.trim();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function sanitizeRailwayGraphqlError(errors: readonly unknown[]): string {
  const firstMessage = errors
    .map((error) => nonEmptyString(recordOrNull(error)?.message))
    .find((message): message is string => Boolean(message));
  if (!firstMessage) return 'railway_graphql_error';

  const detail = firstMessage
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72);
  return detail ? `railway_${detail}` : 'railway_graphql_error';
}

function normalizeAgentName(value: string | null | undefined): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return normalized || DEFAULT_AGENT_NAME;
}

/**
 * Allow-listed parent suffixes for Sidekick-owned worker hostnames. Substring
 * matching (`includes('.sidekick.')`) was previously used here, which let
 * attacker-controlled hostnames such as `evil.sidekick.attacker.com` slip
 * through. Suffix matching closes that hole — only canonical Sidekick hosts
 * are accepted.
 *
 * Add additional suffixes here when new canonical domains are stood up;
 * never reach for substring matches.
 */
export const SIDEKICK_ALLOWED_WORKER_HOST_SUFFIXES: readonly string[] = [
  '.sidekick.dev',
  '.sidekick.app',
  '.workers.dev', // Cloudflare's per-account default subdomain, e.g. sidekick-worker.<acct>.workers.dev
];

/**
 * Allow-listed image-name patterns for the optional Sidekick Hermes runner.
 * The Railway template path does not require an image, but if a custom image is
 * supplied later it must be an exact canonical runner image rather than a
 * substring lookalike such as `evil/sidekick/hermes-runner-fake`.
 */
export const SIDEKICK_ALLOWED_RUNNER_IMAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /^ghcr\.io\/sidekick\/hermes-runner(?:[:@][\w.\-+:]+)?$/,
  /^registry\.railway\.app\/sidekick\/hermes-runner(?:[:@][\w.\-+:]+)?$/,
];

export const SIDEKICK_ALLOWED_RUNNER_ARTIFACT_HOST_SUFFIXES: readonly string[] = [
  '.supabase.co',
  '.sidekick.dev',
  '.sidekick.app',
  'raw.githubusercontent.com',
];

function validateRunnerServerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('runnerServerUrl must use HTTPS');
  if (url.username || url.password) throw new Error('runnerServerUrl must not include credentials');
  const hostname = url.hostname.toLowerCase();
  const allowed = SIDEKICK_ALLOWED_RUNNER_ARTIFACT_HOST_SUFFIXES.some((suffix) => (
    suffix.startsWith('.') ? hostname.endsWith(suffix) : hostname === suffix
  ));
  if (!allowed) throw new Error('runnerServerUrl must point at an approved Sidekick runner artifact host');
  url.hash = '';
  return url.toString();
}

function validateWorkerProxyUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('workerProxyUrl must use HTTPS');
  if (url.username || url.password) throw new Error('workerProxyUrl must not include credentials');
  const hostname = url.hostname.toLowerCase();
  const allowed = SIDEKICK_ALLOWED_WORKER_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix.toLowerCase()));
  if (!allowed) throw new Error('workerProxyUrl must point at a Sidekick-owned worker host');
  return url.toString();
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0   // 0.0.0.0/8 "this host"
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

// IPv6 loopback / link-local / unique-local + IPv4-mapped private addresses
// (#29). url.hostname strips the [] brackets, so we match the bare address.
function isPrivateOrLocalIpv6(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // A ':' marks a candidate IPv6 literal. Detected with a regex test rather
  // than a substring helper, so the R-ARCH-13 provisioner-validator rule
  // (no bypassable substring matching in the allow-list block) keeps holding.
  if (!/:/.test(h)) return false;
  if (h === '::1' || h === '::') return true;                 // loopback / unspecified
  if (/^fe[89ab]/.test(h)) return true;                       // fe80::/10 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true;  // fc00::/7 unique-local
  const mapped = /::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h); // IPv4-mapped
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

function validateRunnerBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('runnerBaseUrl must use HTTPS');
  if (url.username || url.password) throw new Error('runnerBaseUrl must not include credentials');
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || isPrivateIpv4(hostname)
    || isPrivateOrLocalIpv6(hostname)
  ) {
    throw new Error('runnerBaseUrl must be publicly reachable');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function normalizeRailwayRunnerEndpoint(value: string | undefined): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return validateRunnerBaseUrl(withProtocol);
}

function candidateRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordOrNull).filter((record): record is Record<string, unknown> => Boolean(record)) : [];
}

function connectionNodes(value: unknown): Record<string, unknown>[] {
  return candidateRecords(recordOrNull(value)?.edges)
    .map((edge) => recordOrNull(edge.node))
    .filter((record): record is Record<string, unknown> => Boolean(record));
}

function chooseHermesRailwayService(project: Record<string, unknown>): Record<string, unknown> | undefined {
  const services = connectionNodes(project.services);
  return services.find((service) => nonEmptyString(service.templateServiceId) === HERMES_AGENT_RAILWAY_TEMPLATE.serviceRef)
    ?? services.find((service) => nonEmptyString(service.templateId) === HERMES_AGENT_RAILWAY_TEMPLATE.id)
    ?? services.find((service) => nonEmptyString(service.name)?.toLowerCase() === 'hermes agent')
    ?? services[0];
}

function chooseRailwayEnvironment(project: Record<string, unknown>): Record<string, unknown> | undefined {
  const environments = connectionNodes(project.environments);
  return environments.find((environment) => nonEmptyString(environment.name)?.toLowerCase() === 'production') ?? environments[0];
}

function chooseRailwayVolumeId(project: Record<string, unknown>): string | undefined {
  const volumes = connectionNodes(project.volumes);
  return nonEmptyString(volumes.find((volume) => nonEmptyString(volume.name)?.toLowerCase().includes('hermes'))?.id)
    ?? nonEmptyString(volumes[0]?.id);
}

function chooseRailwayRunnerBaseUrl(endpoint: Record<string, unknown>): string | undefined {
  const domains = recordOrNull(endpoint.domains);
  const serviceDomains = candidateRecords(domains?.serviceDomains);
  const customDomains = candidateRecords(domains?.customDomains);
  const preferredDomains = [...serviceDomains, ...customDomains];
  const activeDomain = preferredDomains.find((domain) => nonEmptyString(domain.syncStatus)?.toUpperCase() === 'ACTIVE')
    ?? preferredDomains[0];
  const normalizedDomain = normalizeRailwayRunnerEndpoint(nonEmptyString(activeDomain?.domain));
  if (normalizedDomain) return normalizedDomain;

  const instance = recordOrNull(endpoint.serviceInstance);
  const deployments = [
    recordOrNull(instance?.latestDeployment),
    ...candidateRecords(instance?.activeDeployments),
  ].filter((deployment): deployment is Record<string, unknown> => Boolean(deployment));
  for (const deployment of deployments) {
    const normalized = normalizeRailwayRunnerEndpoint(nonEmptyString(deployment.url) ?? nonEmptyString(deployment.staticUrl));
    if (normalized) return normalized;
  }
  return undefined;
}

function chooseRailwayDeploymentStatus(endpoint: Record<string, unknown>): string | undefined {
  const instance = recordOrNull(endpoint.serviceInstance);
  return nonEmptyString(recordOrNull(instance?.latestDeployment)?.status)
    ?? nonEmptyString(candidateRecords(instance?.activeDeployments)[0]?.status);
}

function buildRunnerHealthUrl(runnerBaseUrl: string): string {
  const baseUrl = validateRunnerBaseUrl(requireNonEmpty(runnerBaseUrl, 'runnerBaseUrl'));
  return `${baseUrl}/health`;
}

function validateRunnerImage(value: string): string {
  const trimmed = value.trim();
  if (!SIDEKICK_ALLOWED_RUNNER_IMAGE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    throw new Error('image must point at the Sidekick Hermes runner image');
  }
  return trimmed;
}

function normalizeToolsets(tierId: PlanTierId, requested?: readonly string[]): readonly string[] {
  const allowed = TOOLSETS_BY_TIER[tierId];
  if (!allowed) throw new Error(`unknown tier: ${tierId}`);
  if (!requested || requested.length === 0) return allowed;

  for (const toolset of requested) {
    if (!allowed.includes(toolset) || toolset.includes(',') || toolset.trim() !== toolset || toolset.length === 0) {
      throw new Error(`toolset not allowed for ${tierId}: ${toolset}`);
    }
  }

  return requested;
}

export function buildHermesRunnerEnvironment(input: RunnerEnvironmentInput): Record<string, string> {
  const userId = requireNonEmpty(input.userId, 'userId');
  const workerProxyUrl = validateWorkerProxyUrl(requireNonEmpty(input.workerProxyUrl, 'workerProxyUrl'));
  const runnerSharedSecret = requireNonEmpty(input.runnerSharedSecret, 'runnerSharedSecret');
  const localAdapterApiKey = deriveLocalAdapterApiKey(runnerSharedSecret);
  const tierId = input.tierId;
  const allowedToolsets = normalizeToolsets(tierId, input.allowedToolsets);
  const agentName = normalizeAgentName(input.agentName);

  return {
    PORT: HERMES_AGENT_RAILWAY_TEMPLATE.port,
    HERMES_HOME: '/data/hermes',
    SIDEKICK_USER_ID: userId,
    SIDEKICK_TIER_ID: tierId,
    SIDEKICK_AGENT_NAME: agentName,
    HERMES_AGENT_NAME: agentName,
    SIDEKICK_WORKER_PROXY_URL: workerProxyUrl,
    SIDEKICK_RUNNER_SHARED_SECRET: runnerSharedSecret,
    SIDEKICK_ALLOW_UNSIGNED_HEALTH: 'true',
    HERMES_TOOLSETS: allowedToolsets.join(','),
    HERMES_MODEL_PROVIDER: 'custom',
    HERMES_MODEL: DELEGENT_RUNNER_MODEL,
    HERMES_MODEL_BASE_URL: SIDEKICK_RUNNER_LOCAL_OPENAI_BASE_URL,
    CUSTOM_BASE_URL: SIDEKICK_RUNNER_LOCAL_OPENAI_BASE_URL,
    OPENAI_BASE_URL: SIDEKICK_RUNNER_LOCAL_OPENAI_BASE_URL,
    OPENAI_API_KEY: localAdapterApiKey,
    HERMES_API_KEY: localAdapterApiKey,
    HERMES_SYSTEM_PROMPT: buildDelegentSystemPrompt(agentName),
    // PREOP-C01 — name-neutral wake when the name is the platform fallback, so
    // the runner's baked greeting never asserts an identity the user didn't
    // choose. The system prompt above still carries the name for first-person
    // voice when the user asks "who are you?".
    HERMES_WAKE_MESSAGE: buildDelegentWakeMessageForName(input.agentName),
    HERMES_EXAMPLE_PROMPTS: buildDelegentExamplePromptsEnvValue(),
    HERMES_TURN_VERBOSITY: DELEGENT_TURN_VERBOSITY,
    HERMES_EMOJI_LEVEL: DELEGENT_EMOJI_LEVEL,
    HERMES_GREETING_TONE: DELEGENT_GREETING_TONE,
    HERMES_TOOL_APPROVAL: DELEGENT_TOOL_APPROVAL,
    HERMES_MEMORY_ENABLED: DELEGENT_MEMORY_ENABLED,
    // Path to the read-only Delegent skills library baked into the runner
    // image. The system prompt references this path so the agent can find
    // MANIFEST.json and SKILL.md files at planning time.
    DELEGENT_SKILLS_DIR: DELEGENT_SKILLS_DIR_DEFAULT,
    // R-INT-04 / R-AGENT-34 — agent inbound email address. The
    // per-user AgentMail-style address is derived from userId so it is
    // stable across resumes. The runner Communications skills read
    // HERMES_AGENT_EMAIL to know where mail addressed to the agent
    // lands; sending to it triggers an inbox-poller -> messages row
    // within ~60s.
    HERMES_AGENT_EMAIL: buildDelegentAgentInboundEmail(userId),
  };
}

// R-INT-04 / R-AGENT-34 — derive the user's agent inbound email address.
// We hash the userId so the address doesn't leak the underlying uuid, and
// route under the agent-mail subdomain that the worker's email-inbox poller
// watches. AgentMail-style scoped sub-account, as recommended by FAQ Q8.
export function buildDelegentAgentInboundEmail(userId: string): string {
  const slug = String(userId).replace(/-/g, '').slice(0, 16).toLowerCase();
  const domain = (process.env.DELEGENT_AGENT_EMAIL_DOMAIN ?? '').trim() || 'agent.delegentai.co.uk';
  return `${slug}@${domain}`;
}

export const SIDEKICK_RUNNER_BOOTSTRAP_PRE_DEPLOY_COMMAND = '/bin/true';
export const SIDEKICK_RUNNER_BOOTSTRAP_START_COMMAND = "/bin/bash -lc 'set -euo pipefail; mkdir -p /data/hermes/workspace; apt-get update; apt-get install -y --no-install-recommends curl ca-certificates git nodejs npm; rm -rf /var/lib/apt/lists/*; if ! command -v hermes >/dev/null 2>&1; then rm -rf /tmp/hermes-agent-src; git clone --depth 1 --branch v2026.5.7 https://github.com/NousResearch/hermes-agent.git /tmp/hermes-agent-src; cd /tmp/hermes-agent-src; uv pip install --system --no-cache -e \".[modal,daytona,vercel,messaging,matrix,cron,cli,dev,tts-premium,slack,pty,honcho,mcp,homeassistant,sms,acp,voice,dingtalk,feishu,google,bedrock,web]\"; fi; python -m pip install --no-cache-dir fastapi==0.115.6 \"uvicorn[standard]==0.34.0\"; curl -fsSL \"$SIDEKICK_RUNNER_SERVER_URL\" -o /tmp/sidekick-runner-server.py; python -m py_compile /tmp/sidekick-runner-server.py; exec python /tmp/sidekick-runner-server.py'";
export const SIDEKICK_RUNNER_RAILWAY_CONFIG_FILE = '/sidekick-runner-no-railway-config.toml';

export function buildRailwayTemplateSerializedConfig(
  input: Pick<ProvisionInput, 'userId' | 'tierId' | 'agentName' | 'allowedToolsets' | 'adminUsername' | 'adminPassword' | 'workerProxyUrl' | 'runnerSharedSecret' | 'runnerServerUrl'>,
  options: { includeSecrets?: boolean } = {},
): RailwayTemplateSerializedConfig {
  const adminUsername = nonEmptyString(input.adminUsername) ?? 'admin';
  const adminPassword = options.includeSecrets
    ? requireNonEmpty(input.adminPassword, 'adminPassword')
    : '[REDACTED]';
  const runnerServerUrl = validateRunnerServerUrl(requireNonEmpty(input.runnerServerUrl, 'runnerServerUrl'));
  const runnerEnvironment = buildHermesRunnerEnvironment({
    userId: input.userId,
    workerProxyUrl: requireNonEmpty(input.workerProxyUrl, 'workerProxyUrl'),
    runnerSharedSecret: requireNonEmpty(input.runnerSharedSecret, 'runnerSharedSecret'),
    tierId: input.tierId,
    agentName: input.agentName,
    allowedToolsets: input.allowedToolsets,
  });
  const runnerVariables = Object.fromEntries(
    Object.entries(runnerEnvironment).map(([name, value]) => [
      name,
      {
        isOptional: false,
        description: 'Sidekick-controlled Hermes runner setting',
        defaultValue: SECRET_LIKE_RUNNER_ENV_NAMES.has(name) && !options.includeSecrets ? '[REDACTED]' : value,
      } satisfies RailwayTemplateVariableSpec,
    ]),
  ) as Record<string, RailwayTemplateVariableSpec>;

  const service: RailwayTemplateServiceConfig = {
    icon: HERMES_AGENT_RAILWAY_TEMPLATE.icon,
    name: 'Hermes Agent',
    deploy: {
      startCommand: SIDEKICK_RUNNER_BOOTSTRAP_START_COMMAND,
      healthcheckPath: '/healthz',
      preDeployCommand: [SIDEKICK_RUNNER_BOOTSTRAP_PRE_DEPLOY_COMMAND],
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
    },
    source: {
      repo: HERMES_AGENT_RAILWAY_TEMPLATE.sourceRepo,
      rootDirectory: HERMES_AGENT_RAILWAY_TEMPLATE.sourceRootDirectory,
    },
    variables: {
      ...runnerVariables,
      [HERMES_AGENT_RAILWAY_TEMPLATE.runnerServerUrlVariable]: {
        isOptional: false,
        description: 'HTTPS artifact URL for the Sidekick Hermes runner bootstrap server',
        defaultValue: runnerServerUrl,
      },
      ADMIN_USERNAME: {
        isOptional: false,
        description: 'Create admin login username credential',
        defaultValue: adminUsername,
      },
      ADMIN_PASSWORD: {
        isOptional: false,
        description: 'Create admin login password credential',
        defaultValue: adminPassword,
      },
    },
    networking: {
      serviceDomains: {
        '<hasDomain>': {},
      },
    },
    volumeMounts: {
      [HERMES_AGENT_RAILWAY_TEMPLATE.serviceRef]: {
        mountPath: HERMES_AGENT_RAILWAY_TEMPLATE.volumeMountPath,
      },
    },
  };

  return {
    buckets: {},
    services: {
      [HERMES_AGENT_RAILWAY_TEMPLATE.serviceRef]: service,
    },
  };
}

export function buildRailwayTemplateDeployInput(
  input: ProvisionInput,
  options: { includeSecrets?: boolean } = {},
): RailwayTemplateDeployInput {
  const projectId = nonEmptyString(input.railwayProjectId);
  const workspaceId = nonEmptyString(input.railwayWorkspaceId);
  const environmentId = nonEmptyString(input.railwayEnvironmentId);
  if (!projectId && !workspaceId) throw new Error('railwayWorkspaceId or railwayProjectId required');

  return {
    templateId: HERMES_AGENT_RAILWAY_TEMPLATE.id,
    ...(workspaceId ? { workspaceId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(environmentId ? { environmentId } : {}),
    serializedConfig: buildRailwayTemplateSerializedConfig(input, options),
  };
}

export function buildRailwayProvisioningPlan(input: ProvisionInput): RailwayProvisioningPlan {
  const userId = requireNonEmpty(input.userId, 'userId');
  // Validate the token for live provision calls, but never include it in plans.
  requireNonEmpty(input.railwayToken, 'railwayToken');

  const image = nonEmptyString(input.image) ? validateRunnerImage(requireNonEmpty(input.image, 'image')) : undefined;
  const workerProxyUrl = requireNonEmpty(input.workerProxyUrl, 'workerProxyUrl');
  const runnerSharedSecret = requireNonEmpty(input.runnerSharedSecret, 'runnerSharedSecret');
  const environment = buildHermesRunnerEnvironment({
    userId,
    workerProxyUrl,
    runnerSharedSecret,
    tierId: input.tierId,
    agentName: input.agentName,
    allowedToolsets: input.allowedToolsets,
  });

  return {
    idempotencyKey: `sidekick-user-${userId}`,
    engine: 'hermes-agent',
    deploymentMode: 'railway-template',
    template: HERMES_AGENT_RAILWAY_TEMPLATE,
    templateDeployInput: buildRailwayTemplateDeployInput(input, { includeSecrets: false }),
    ...(image ? { serviceImage: image } : {}),
    persistentVolumeGb: 40,
    volumeMountPath: HERMES_AGENT_RAILWAY_TEMPLATE.volumeMountPath,
    environment: redactRunnerEnvironment(environment),
  };
}

function hasNonEmptyValue(env: Record<string, string | undefined>, name: string): boolean {
  return typeof env[name] === 'string' && env[name]?.trim().length > 0;
}

function hasRailwayTarget(env: Record<string, string | undefined>): boolean {
  return hasNonEmptyValue(env, 'RAILWAY_WORKSPACE_ID') || hasNonEmptyValue(env, 'RAILWAY_PROJECT_ID');
}

export function preflightRailwayProvisioner(input: RailwayPreflightInput): RailwayProvisionerPreflightReport {
  const requiredVariables: string[] = ['RAILWAY_WORKSPACE_ID', 'SIDEKICK_WORKER_PROXY_URL', 'SIDEKICK_RUNNER_SERVER_URL'];
  const requiredSecrets: string[] = ['RAILWAY_API_TOKEN', 'HERMES_ADMIN_PASSWORD', 'SIDEKICK_RUNNER_SHARED_SECRET'];
  const proxyUrl = nonEmptyString(input.workerProxyUrl) ?? nonEmptyString(input.env.SIDEKICK_WORKER_PROXY_URL);
  const runnerSharedSecret = nonEmptyString(input.runnerSharedSecret) ?? nonEmptyString(input.env.SIDEKICK_RUNNER_SHARED_SECRET);
  const runnerServerUrl = nonEmptyString(input.runnerServerUrl) ?? nonEmptyString(input.env.SIDEKICK_RUNNER_SERVER_URL);
  const missingSecrets = requiredSecrets.filter((name) => {
    if (name === 'SIDEKICK_RUNNER_SHARED_SECRET') return !runnerSharedSecret;
    return !hasNonEmptyValue(input.env, name);
  });
  const missingVariables: string[] = [];
  const missingRailwayTargetVariables: string[] = [];
  if (!hasRailwayTarget(input.env)) {
    missingRailwayTargetVariables.push('RAILWAY_WORKSPACE_ID');
    missingVariables.push('RAILWAY_WORKSPACE_ID');
  }
  if (!proxyUrl) missingVariables.push('SIDEKICK_WORKER_PROXY_URL');
  if (!runnerServerUrl) missingVariables.push('SIDEKICK_RUNNER_SERVER_URL');
  const checks: RailwayPreflightCheck[] = [
    {
      id: 'required-secrets',
      ok: missingSecrets.length === 0,
      severity: 'blocking',
      requiredNames: requiredSecrets,
      missingNames: missingSecrets,
      reason: missingSecrets.length === 0 ? 'Required private Railway API token is present.' : 'Required private Railway API token is missing.',
    },
    {
      id: 'railway-target',
      ok: missingRailwayTargetVariables.length === 0,
      severity: 'blocking',
      requiredNames: ['RAILWAY_WORKSPACE_ID', 'RAILWAY_PROJECT_ID'],
      missingNames: missingRailwayTargetVariables,
      reason: missingRailwayTargetVariables.length === 0
        ? 'A Railway workspace or existing project target is configured.'
        : 'A Railway workspace or existing project target is required before automation can deploy the template.',
    },
    {
      id: 'railway-template-contract',
      ok: true,
      severity: 'blocking',
      requiredNames: [HERMES_AGENT_RAILWAY_TEMPLATE.code, HERMES_AGENT_RAILWAY_TEMPLATE.id],
      missingNames: [],
      reason: 'Provisioning uses Railway templateDeployV2 with the researched Hermes Agent template contract.',
    },
  ];

  if (nonEmptyString(input.image)) {
    try {
      validateRunnerImage(requireNonEmpty(input.image, 'image'));
      checks.push({
        id: 'runner-image',
        ok: true,
        severity: 'warning',
        requiredNames: ['SIDEKICK_RUNNER_IMAGE'],
        missingNames: [],
        reason: 'Optional custom runner image is allowed.',
      });
    } catch {
      missingVariables.push('SIDEKICK_RUNNER_IMAGE');
      checks.push({
        id: 'runner-image',
        ok: false,
        severity: 'blocking',
        requiredNames: ['SIDEKICK_RUNNER_IMAGE'],
        missingNames: ['SIDEKICK_RUNNER_IMAGE'],
        reason: 'Optional custom runner image is present but not allowed.',
      });
    }
  }

  if (!runnerServerUrl) {
    checks.push({
      id: 'runner-artifact',
      ok: false,
      severity: 'blocking',
      requiredNames: ['SIDEKICK_RUNNER_SERVER_URL'],
      missingNames: ['SIDEKICK_RUNNER_SERVER_URL'],
      reason: 'Sidekick runner bootstrap requires a public HTTPS runner artifact URL.',
    });
  } else {
    try {
      validateRunnerServerUrl(runnerServerUrl);
      checks.push({
        id: 'runner-artifact',
        ok: true,
        severity: 'warning',
        requiredNames: ['SIDEKICK_RUNNER_SERVER_URL'],
        missingNames: [],
        reason: 'Sidekick runner artifact URL is valid.',
      });
    } catch {
      missingVariables.push('SIDEKICK_RUNNER_SERVER_URL');
      checks.push({
        id: 'runner-artifact',
        ok: false,
        severity: 'blocking',
        requiredNames: ['SIDEKICK_RUNNER_SERVER_URL'],
        missingNames: ['SIDEKICK_RUNNER_SERVER_URL'],
        reason: 'Sidekick runner artifact URL is present but invalid.',
      });
    }
  }

  const missingRunnerEnvironmentNames = [
    ...(!proxyUrl ? ['SIDEKICK_WORKER_PROXY_URL'] : []),
    ...(!runnerSharedSecret ? ['SIDEKICK_RUNNER_SHARED_SECRET'] : []),
  ];
  if (missingRunnerEnvironmentNames.length > 0) {
    checks.push({
      id: 'runner-environment',
      ok: false,
      severity: 'blocking',
      requiredNames: ['SIDEKICK_WORKER_PROXY_URL', 'SIDEKICK_RUNNER_SHARED_SECRET'],
      missingNames: missingRunnerEnvironmentNames,
      reason: 'Sidekick runner settings need worker proxy URL and runner auth material before provisioning can start.',
    });
  } else {
    try {
      const proxyUrlValue = requireNonEmpty(proxyUrl, 'workerProxyUrl');
      const runnerSharedSecretValue = requireNonEmpty(runnerSharedSecret, 'runnerSharedSecret');
      validateWorkerProxyUrl(proxyUrlValue);
      buildHermesRunnerEnvironment({
        userId: 'preflight-user',
        workerProxyUrl: proxyUrlValue,
        runnerSharedSecret: runnerSharedSecretValue,
        tierId: input.tierId,
        allowedToolsets: input.allowedToolsets,
      });
      checks.push({
        id: 'runner-environment',
        ok: true,
        severity: 'warning',
        requiredNames: ['SIDEKICK_WORKER_PROXY_URL', 'SIDEKICK_RUNNER_SHARED_SECRET'],
        missingNames: [],
        reason: 'Sidekick runner settings are valid.',
      });
    } catch {
      missingVariables.push('SIDEKICK_WORKER_PROXY_URL');
      checks.push({
        id: 'runner-environment',
        ok: false,
        severity: 'blocking',
        requiredNames: ['SIDEKICK_WORKER_PROXY_URL'],
        missingNames: ['SIDEKICK_WORKER_PROXY_URL'],
        reason: 'Sidekick worker proxy URL is present but invalid.',
      });
    }
  }

  return {
    ok: checks.every((check) => check.ok),
    provider: 'railway',
    requiredVariables,
    requiredSecrets,
    missingVariables: Array.from(new Set(missingVariables)),
    missingSecrets,
    checks,
  };
}

export function createRailwayGraphqlClient(input: {
  endpoint?: string;
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
} = {}): RailwayApiClient {
  const endpoint = input.endpoint ?? RAILWAY_GRAPHQL_ENDPOINT;
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as NonNullable<typeof input.fetchImpl>);
  if (!fetchImpl) throw new Error('fetch implementation required');

  async function railwayGraphql(railwayToken: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = requireNonEmpty(railwayToken, 'railwayToken');
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`railway_graphql_http_${response.status}`);
    const record = recordOrNull(body);
    const errors = Array.isArray(record?.errors) ? record.errors : [];
    if (errors.length > 0) throw new Error(sanitizeRailwayGraphqlError(errors));
    return recordOrNull(record?.data) ?? {};
  }

  return {
    async templateDeployV2(deployInput, railwayToken) {
      const data = await railwayGraphql(railwayToken, RAILWAY_TEMPLATE_DEPLOY_V2_MUTATION, { input: deployInput });
      const payload = recordOrNull(data.templateDeployV2);
      const projectId = nonEmptyString(payload?.projectId);
      if (!projectId) throw new Error('railway_template_deploy_missing_project');
      return {
        projectId,
        workflowId: nonEmptyString(payload?.workflowId) ?? null,
        runnerBaseUrl: nonEmptyString(payload?.runnerBaseUrl) ?? null,
      };
    },

    async discoverHermesRunnerEndpoint(projectId, railwayToken) {
      const id = requireNonEmpty(projectId, 'railwayProjectId');
      const projectData = await railwayGraphql(railwayToken, RAILWAY_PROJECT_RUNNER_ENDPOINT_QUERY, { projectId: id });
      const project = recordOrNull(projectData.project);
      if (!project) throw new Error('railway_project_missing');
      const service = chooseHermesRailwayService(project);
      const environment = chooseRailwayEnvironment(project);
      const serviceId = nonEmptyString(service?.id);
      const environmentId = nonEmptyString(environment?.id);
      if (!serviceId) throw new Error('railway_hermes_service_missing');
      if (!environmentId) throw new Error('railway_environment_missing');

      const endpointData = await railwayGraphql(railwayToken, RAILWAY_RUNNER_SERVICE_ENDPOINT_QUERY, {
        projectId: id,
        serviceId,
        environmentId,
      });
      return {
        projectId: id,
        environmentId,
        serviceId,
        volumeId: chooseRailwayVolumeId(project) ?? null,
        runnerBaseUrl: chooseRailwayRunnerBaseUrl(endpointData) ?? null,
        deploymentStatus: chooseRailwayDeploymentStatus(endpointData) ?? null,
      };
    },

    async configureHermesRunnerServiceInstance(input, railwayToken) {
      const serviceId = requireNonEmpty(input.serviceId, 'railwayServiceId');
      const environmentId = requireNonEmpty(input.environmentId, 'railwayEnvironmentId');
      const projectId = nonEmptyString(input.projectId);
      const volumeId = nonEmptyString(input.volumeId);
      const connectData = await railwayGraphql(railwayToken, RAILWAY_RUNNER_SERVICE_CONNECT_MUTATION, {
        serviceId,
        input: {
          image: SIDEKICK_RUNNER_RUNTIME_BASE_IMAGE,
        },
      });
      const connectedServiceId = nonEmptyString(recordOrNull(connectData.serviceConnect)?.id);
      if (!connectedServiceId || connectedServiceId !== serviceId) throw new Error('railway_runner_service_connect_failed');
      if (volumeId) {
        const volumeData = await railwayGraphql(railwayToken, RAILWAY_RUNNER_VOLUME_INSTANCE_UPDATE_MUTATION, {
          volumeId,
          environmentId,
          input: {
            serviceId,
            mountPath: HERMES_AGENT_RAILWAY_TEMPLATE.volumeMountPath,
          },
        });
        if (volumeData.volumeInstanceUpdate !== true) throw new Error('railway_runner_volume_update_failed');
      }
      if (projectId) {
        const variableData = await railwayGraphql(railwayToken, RAILWAY_RUNNER_VARIABLE_COLLECTION_UPSERT_MUTATION, {
          input: {
            projectId,
            environmentId,
            serviceId,
            skipDeploys: true,
            variables: {
              SIDEKICK_ALLOW_UNSIGNED_HEALTH: 'true',
            },
          },
        });
        if (variableData.variableCollectionUpsert !== true) throw new Error('railway_runner_variable_upsert_failed');
      }
      const updateData = await railwayGraphql(railwayToken, RAILWAY_RUNNER_SERVICE_INSTANCE_UPDATE_MUTATION, {
        serviceId,
        environmentId,
        input: {
          preDeployCommand: SIDEKICK_RUNNER_BOOTSTRAP_PRE_DEPLOY_COMMAND,
          startCommand: SIDEKICK_RUNNER_BOOTSTRAP_START_COMMAND,
          healthcheckPath: '/healthz',
          healthcheckTimeout: 900,
          railwayConfigFile: SIDEKICK_RUNNER_RAILWAY_CONFIG_FILE,
          restartPolicyType: 'ON_FAILURE',
          restartPolicyMaxRetries: 10,
        },
      });
      if (updateData.serviceInstanceUpdate !== true) throw new Error('railway_service_instance_update_failed');

      const redeployData = await railwayGraphql(railwayToken, RAILWAY_RUNNER_SERVICE_INSTANCE_REDEPLOY_MUTATION, {
        serviceId,
        environmentId,
      });
      if (redeployData.serviceInstanceRedeploy !== true) throw new Error('railway_service_instance_redeploy_failed');
    },

    async projectDelete(projectId, railwayToken) {
      const id = requireNonEmpty(projectId, 'railwayProjectId');
      const data = await railwayGraphql(railwayToken, RAILWAY_PROJECT_DELETE_MUTATION, { id });
      return data.projectDelete === true;
    },
  };
}

export async function cleanupHermesTestRunner(
  input: CleanupHermesTestRunnerInput,
  deps: CleanupHermesTestRunnerDeps,
): Promise<CleanupHermesTestRunnerResult> {
  if (input.allowRailwayDelete !== true) throw new Error('railway_delete_not_allowed');
  const userId = requireNonEmpty(input.userId, 'userId');
  const railwayProjectId = requireNonEmpty(input.railwayProjectId, 'railwayProjectId');
  const protectedRailwayProjectId = nonEmptyString(input.protectedRailwayProjectId);
  if (protectedRailwayProjectId && protectedRailwayProjectId === railwayProjectId) {
    throw new Error('railway_cleanup_target_matches_configured_project');
  }
  const railwayToken = requireNonEmpty(input.railwayToken, 'railwayToken');
  const railway = deps.railway ?? createRailwayGraphqlClient();
  if (typeof railway.projectDelete !== 'function') throw new Error('railway_project_delete_not_supported');

  await deps.store.verifyHermesTestRunnerCleanupTarget({ userId, railwayProjectId });
  const deleted = await railway.projectDelete(railwayProjectId, railwayToken);
  if (deleted !== true) throw new Error('railway_project_delete_failed');
  await deps.store.markHermesTestRunnerCleanedUp({ userId, railwayProjectId });

  return {
    status: 'deleted',
    railwayProjectId,
  };
}

export async function provisionHermesWorker(input: ProvisionInput, deps: ProvisionDeps = {}): Promise<ProvisionResult> {
  const plan = buildRailwayProvisioningPlan(input);
  const deployInput = buildRailwayTemplateDeployInput(input, { includeSecrets: true });
  const railway = deps.railway ?? createRailwayGraphqlClient();
  const railwayToken = requireNonEmpty(input.railwayToken, 'railwayToken');
  const payload = await railway.templateDeployV2(deployInput, railwayToken);
  const projectId = requireNonEmpty(payload.projectId, 'railwayProjectId');
  const runnerBaseUrl = nonEmptyString(payload.runnerBaseUrl);
  let normalizedRunnerBaseUrl = runnerBaseUrl ? validateRunnerBaseUrl(runnerBaseUrl) : undefined;
  let discoveredEndpoint: RailwayRunnerEndpointPayload | null = null;
  if (typeof railway.discoverHermesRunnerEndpoint === 'function') {
    try {
      discoveredEndpoint = await railway.discoverHermesRunnerEndpoint(projectId, railwayToken);
    } catch {
      discoveredEndpoint = null;
    }
  }
  if (discoveredEndpoint) {
    if (!normalizedRunnerBaseUrl) {
      normalizedRunnerBaseUrl = nonEmptyString(discoveredEndpoint.runnerBaseUrl)
        ? validateRunnerBaseUrl(requireNonEmpty(discoveredEndpoint.runnerBaseUrl, 'runnerBaseUrl'))
        : undefined;
    }
    const serviceId = nonEmptyString(discoveredEndpoint.serviceId);
    const environmentId = nonEmptyString(discoveredEndpoint.environmentId);
    const volumeId = nonEmptyString(discoveredEndpoint.volumeId);
    if (serviceId && environmentId && typeof railway.configureHermesRunnerServiceInstance === 'function') {
      await railway.configureHermesRunnerServiceInstance({ projectId, serviceId, environmentId, volumeId }, railwayToken);
    }
  }
  const runnerSharedSecret = requireNonEmpty(input.runnerSharedSecret, 'runnerSharedSecret');
  const adminUsername = nonEmptyString(input.adminUsername) ?? 'admin';

  return {
    railwayProjectId: projectId,
    ...(nonEmptyString(payload.workflowId) ? { railwayWorkflowId: payload.workflowId! } : {}),
    ...(nonEmptyString(discoveredEndpoint?.serviceId) ? { railwayServiceId: discoveredEndpoint!.serviceId! } : {}),
    ...(nonEmptyString(discoveredEndpoint?.volumeId) ? { railwayVolumeId: discoveredEndpoint!.volumeId! } : {}),
    ...(normalizedRunnerBaseUrl ? { runnerBaseUrl: normalizedRunnerBaseUrl } : {}),
    runnerSharedSecret,
    status: 'provisioning',
    volumeGb: plan.persistentVolumeGb,
    volumeMountPath: plan.volumeMountPath,
    idempotencyKey: plan.idempotencyKey,
    templateId: HERMES_AGENT_RAILWAY_TEMPLATE.id,
    templateCode: HERMES_AGENT_RAILWAY_TEMPLATE.code,
    adminUsername,
  };
}

export async function processNextHermesProvisioningJob(
  input: ProcessHermesProvisioningInput,
  deps: ProcessHermesProvisioningDeps,
): Promise<ProcessHermesProvisioningResult> {
  const readiness = preflightRailwayProvisioner({
    env: input.env,
    image: nonEmptyString(input.env.SIDEKICK_RUNNER_IMAGE),
    workerProxyUrl: nonEmptyString(input.env.SIDEKICK_WORKER_PROXY_URL),
    runnerSharedSecret: nonEmptyString(input.env.SIDEKICK_RUNNER_SHARED_SECRET),
    runnerServerUrl: nonEmptyString(input.env.SIDEKICK_RUNNER_SERVER_URL),
    tierId: 'studio',
  });
  if (!readiness.ok) {
    return {
      status: 'blocked',
      missingSecrets: readiness.missingSecrets,
      missingVariables: readiness.missingVariables,
    };
  }

  const job = await deps.store.claimNextQueuedHermesJob();
  if (!job) return { status: 'idle' };

  let railwayCallStarted = false;
  const railway: RailwayApiClient = {
    async templateDeployV2(deployInput, railwayToken) {
      railwayCallStarted = true;
      return (deps.railway ?? createRailwayGraphqlClient()).templateDeployV2(deployInput, railwayToken);
    },
    async discoverHermesRunnerEndpoint(projectId, railwayToken) {
      return (deps.railway ?? createRailwayGraphqlClient()).discoverHermesRunnerEndpoint?.(projectId, railwayToken)
        ?? { projectId, runnerBaseUrl: null };
    },
    async configureHermesRunnerServiceInstance(config, railwayToken) {
      return (deps.railway ?? createRailwayGraphqlClient()).configureHermesRunnerServiceInstance?.(config, railwayToken);
    },
  };

  let result: ProvisionResult;
  try {
    result = await provisionHermesWorker({
      userId: job.userId,
      tierId: job.tierId,
      railwayToken: requireNonEmpty(input.env.RAILWAY_API_TOKEN, 'railwayToken'),
      railwayWorkspaceId: nonEmptyString(input.env.RAILWAY_WORKSPACE_ID),
      railwayProjectId: nonEmptyString(input.env.RAILWAY_PROJECT_ID),
      railwayEnvironmentId: nonEmptyString(input.env.RAILWAY_ENVIRONMENT_ID),
      adminUsername: nonEmptyString(input.env.HERMES_ADMIN_USERNAME),
      adminPassword: requireNonEmpty(input.env.HERMES_ADMIN_PASSWORD, 'adminPassword'),
      image: nonEmptyString(input.env.SIDEKICK_RUNNER_IMAGE),
      workerProxyUrl: nonEmptyString(input.env.SIDEKICK_WORKER_PROXY_URL),
      runnerSharedSecret: requireNonEmpty(input.env.SIDEKICK_RUNNER_SHARED_SECRET, 'runnerSharedSecret'),
      runnerServerUrl: requireNonEmpty(input.env.SIDEKICK_RUNNER_SERVER_URL, 'runnerServerUrl'),
      agentName: job.agentName,
    }, { ...deps, railway });
  } catch (error) {
    const failure = {
      errorCode: sanitizeProvisioningErrorCode(error),
      publicStatusMessage: railwayCallStarted
        ? 'Delegent AI setup needs a manual Railway check before continuing.'
        : 'Delegent AI setup paused because the workspace could not be prepared. We will check it before continuing.',
    };
    if (railwayCallStarted) {
      await markReconciliationRequiredBestEffort(deps.store, job, failure);
      return { status: 'reconcile_required', errorCode: failure.errorCode };
    }
    await deps.store.markHermesProvisioningFailed(job, failure);
    return { status: 'failed', errorCode: failure.errorCode };
  }

  try {
    await deps.store.markHermesProvisioningRequested(job, result);
    return {
      status: 'provisioning',
      railwayProjectId: result.railwayProjectId,
      ...(result.railwayWorkflowId ? { railwayWorkflowId: result.railwayWorkflowId } : {}),
      templateId: result.templateId,
      templateCode: result.templateCode,
    };
  } catch (error) {
    const failure = {
      errorCode: sanitizeProvisioningErrorCode(error),
      publicStatusMessage: 'Delegent AI setup needs a manual Railway check before continuing.',
    };
    await markReconciliationRequiredBestEffort(deps.store, job, failure);
    return { status: 'reconcile_required', errorCode: failure.errorCode };
  }
}

function buildSidekickRunnerAuthorizationHeaders(input: {
  userId: string;
  runnerSharedSecret: string;
  nowSeconds?: number;
}): Record<string, string> {
  const userId = requireNonEmpty(input.userId, 'user_id');
  const runnerSharedSecret = requireNonEmpty(input.runnerSharedSecret, 'runner_shared_secret');
  const timestamp = String(Math.trunc(input.nowSeconds ?? Date.now() / 1000));
  const digest = createHmac('sha256', runnerSharedSecret).update(`v1:${userId}:${timestamp}`).digest('hex');
  return {
    'x-sidekick-user-id': userId,
    'x-sidekick-runner-timestamp': timestamp,
    'x-sidekick-runner-token': `v1.${digest}`,
  };
}

export function createHermesRunnerHealthClient(input: {
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  timeoutMs?: number;
} = {}): RunnerHealthClient {
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as NonNullable<typeof input.fetchImpl>);
  if (!fetchImpl) throw new Error('fetch implementation required');
  const timeoutMs = input.timeoutMs ?? DEFAULT_RUNNER_HEALTH_TIMEOUT_MS;

  return {
    async fetchHealth(request) {
      const controller = typeof AbortController === 'undefined' ? null : new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (controller && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeout = setTimeout(() => controller.abort(), timeoutMs);
      }

      try {
        const response = await fetchImpl(request.url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            ...buildSidekickRunnerAuthorizationHeaders({
              userId: request.userId,
              runnerSharedSecret: request.runnerSharedSecret,
            }),
          },
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response.ok) return { ok: false, status: response.status };
        const body = await response.json();
        const record = recordOrNull(body);
        return {
          ok: record?.ok === true,
          engine: nonEmptyString(record?.engine) ?? 'unknown',
        };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}

function isHermesRunnerHealthy(health: Record<string, unknown>): boolean {
  return health.ok === true && nonEmptyString(health.engine) === 'hermes-agent';
}

function isMissingSupabaseRpc(error: unknown, rpcName: string): boolean {
  const raw = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return raw.includes(rpcName.toLowerCase()) && (
    raw.includes('could not find the function')
    || raw.includes('does not exist')
    || raw.includes('pgrst202')
  );
}

export async function processNextHermesRunnerDomainDiscoveryJob(
  input: ProcessHermesRunnerDomainDiscoveryInput,
  deps: ProcessHermesRunnerDomainDiscoveryDeps,
): Promise<ProcessHermesRunnerDomainDiscoveryResult> {
  const railwayToken = nonEmptyString(input.env.RAILWAY_API_TOKEN);
  if (!railwayToken) return { status: 'idle' };

  let job: ClaimedHermesRunnerDomainDiscoveryJob | null;
  try {
    job = await deps.store.claimNextHermesRunnerDomainDiscovery();
  } catch (error) {
    if (isMissingSupabaseRpc(error, 'claim_next_hermes_runner_domain_discovery')) return { status: 'idle' };
    return { status: 'domain_pending', errorCode: sanitizeProvisioningErrorCode(error) };
  }
  if (!job) return { status: 'idle' };

  try {
    const railway = deps.railway ?? createRailwayGraphqlClient();
    if (typeof railway.discoverHermesRunnerEndpoint !== 'function') {
      return { status: 'domain_pending', errorCode: 'railway_domain_discovery_not_supported' };
    }
    const endpoint = await railway.discoverHermesRunnerEndpoint(job.railwayProjectId, railwayToken);
    const runnerBaseUrl = nonEmptyString(endpoint.runnerBaseUrl);
    if (!runnerBaseUrl) {
      return {
        status: 'domain_pending',
        ...(nonEmptyString(endpoint.deploymentStatus) ? { deploymentStatus: endpoint.deploymentStatus! } : {}),
      };
    }
    const serviceId = nonEmptyString(endpoint.serviceId);
    const environmentId = nonEmptyString(endpoint.environmentId);
    const volumeId = nonEmptyString(endpoint.volumeId);
    if (serviceId && environmentId && typeof railway.configureHermesRunnerServiceInstance === 'function') {
      await railway.configureHermesRunnerServiceInstance({ projectId: endpoint.projectId, serviceId, environmentId, volumeId }, railwayToken);
    }
    await deps.store.markHermesRunnerDomainDiscovered(job, {
      ...endpoint,
      runnerBaseUrl: validateRunnerBaseUrl(runnerBaseUrl),
    });
    return { status: 'domain_found' };
  } catch (error) {
    return { status: 'domain_pending', errorCode: sanitizeProvisioningErrorCode(error) };
  }
}

export async function processNextHermesRunnerReadinessCheck(
  _input: ProcessHermesRunnerReadinessInput = {},
  deps: ProcessHermesRunnerReadinessDeps,
): Promise<ProcessHermesRunnerReadinessResult> {
  const job = await deps.store.claimNextHermesReadinessCheck();
  if (!job) return { status: 'idle' };

  const failure: HermesProvisioningFailure = {
    errorCode: 'runner_health_not_ready',
    publicStatusMessage: 'Delegent AI is still coming online.',
  };

  try {
    const healthUrl = buildRunnerHealthUrl(job.runnerBaseUrl);
    const health = await (deps.runnerHealth ?? createHermesRunnerHealthClient()).fetchHealth({
      url: healthUrl,
      userId: job.userId,
      runnerSharedSecret: job.runnerSharedSecret,
    });
    if (!isHermesRunnerHealthy(health)) {
      await deps.store.markHermesRunnerReadinessFailed(job, failure);
      return { status: 'not_ready', errorCode: failure.errorCode };
    }
    await deps.store.markHermesRunnerReady(job);
    return { status: 'ready' };
  } catch (error) {
    try {
      await deps.store.markHermesRunnerReadinessFailed(job, failure);
      return { status: 'not_ready', errorCode: failure.errorCode };
    } catch (storeError) {
      return { status: 'failed', errorCode: sanitizeProvisioningErrorCode(storeError) };
    }
  }
}

async function markReconciliationRequiredBestEffort(
  store: HermesProvisioningStateStore,
  job: ClaimedHermesProvisioningJob,
  failure: HermesProvisioningFailure,
): Promise<void> {
  try {
    await store.markHermesProvisioningReconciliationRequired(job, failure);
  } catch {
    // If Supabase is unavailable after a Railway call was attempted, leave the
    // claimed row in provisioning rather than clearing it into an auto-retryable
    // error state that could create a duplicate live Railway project.
  }
}

type SupabaseHermesResult = { data?: unknown; error?: { message?: string } | null };
type SupabaseHermesMaybePromise<T> = T | PromiseLike<T>;

export interface SupabaseHermesFilterBuilder {
  match(filters: Record<string, unknown>): SupabaseHermesFilterBuilder;
  eq(column: string, value: string): SupabaseHermesFilterBuilder;
  is(column: string, value: null): SupabaseHermesFilterBuilder;
  limit(count: number): SupabaseHermesFilterBuilder;
  select(columns: string): SupabaseHermesMaybePromise<SupabaseHermesResult>;
}

export interface SupabaseHermesProvisioningClient {
  rpc(name: string, args: Record<string, unknown>): SupabaseHermesMaybePromise<SupabaseHermesResult>;
  from(table: string): {
    update(row: Record<string, unknown>): SupabaseHermesFilterBuilder;
    insert(row: Record<string, unknown>): SupabaseHermesMaybePromise<SupabaseHermesResult>;
    select(columns: string): SupabaseHermesFilterBuilder;
  };
}

export interface SupabaseServiceRoleRestClientInput {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

const RAILWAY_PROVISIONING_LEASE_SECONDS = 30 * 60;
const HERMES_RUNNER_READINESS_STALE_SECONDS = 10 * 60;

function normalizeSupabaseRestBaseUrl(rawUrl: string): string {
  const url = new URL(requireNonEmpty(rawUrl, 'supabaseUrl'));
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return `${url.toString().replace(/\/$/, '')}/rest/v1`;
}

function encodePostgrestFilterValue(value: unknown): string {
  return String(value).replace(/"/g, '');
}

async function parseSupabaseRestResponse(response: { ok: boolean; status: number; json(): Promise<unknown> }): Promise<SupabaseHermesResult> {
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = nonEmptyString(recordOrNull(data)?.message) ?? `supabase_rest_http_${response.status}`;
    return { data, error: { message } };
  }
  return { data, error: null };
}

export function createSupabaseServiceRoleRestClient(input: SupabaseServiceRoleRestClientInput): SupabaseHermesProvisioningClient {
  const baseUrl = normalizeSupabaseRestBaseUrl(input.supabaseUrl);
  const serviceRoleKey = requireNonEmpty(input.serviceRoleKey, 'supabaseServiceRoleKey');
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as unknown as NonNullable<SupabaseServiceRoleRestClientInput['fetchImpl']>);
  if (!fetchImpl) throw new Error('fetch implementation required');
  const baseHeaders = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json',
  };

  return {
    async rpc(name, args) {
      const url = `${baseUrl}/rpc/${encodeURIComponent(requireNonEmpty(name, 'rpcName'))}`;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify(args),
      });
      return parseSupabaseRestResponse(response);
    },
    from(table) {
      const tableName = requireNonEmpty(table, 'table');

      function makeBuilder(method: string, payload?: Record<string, unknown>) {
        const filters: Record<string, unknown> = {};
        const isFilters: Record<string, null> = {};
        let limitCount: number | null = null;
        const builder: SupabaseHermesFilterBuilder = {
          match(nextFilters) {
            Object.assign(filters, nextFilters);
            return builder;
          },
          eq(column, value) {
            filters[requireNonEmpty(column, 'column')] = value;
            return builder;
          },
          is(column, value) {
            isFilters[requireNonEmpty(column, 'column')] = value;
            return builder;
          },
          limit(count) {
            limitCount = count;
            return builder;
          },
          async select(columns) {
            const params = new URLSearchParams();
            for (const [column, value] of Object.entries(filters)) {
              params.append(column, `eq.${encodePostgrestFilterValue(value)}`);
            }
            for (const column of Object.keys(isFilters)) {
              params.append(column, 'is.null');
            }
            params.set('select', requireNonEmpty(columns, 'columns'));
            if (limitCount !== null) params.set('limit', String(limitCount));
            const url = `${baseUrl}/${encodeURIComponent(tableName)}?${params.toString()}`;
            const hdrs = method === 'PATCH'
              ? { ...baseHeaders, prefer: 'return=representation' }
              : baseHeaders;
            const response = await fetchImpl(url, {
              method,
              headers: hdrs,
              ...(payload ? { body: JSON.stringify(payload) } : {}),
            });
            return parseSupabaseRestResponse(response);
          },
        };
        return builder;
      }

      return {
        update(row: Record<string, unknown>) {
          return makeBuilder('PATCH', row);
        },
        async insert(row: Record<string, unknown>) {
          const url = `${baseUrl}/${encodeURIComponent(tableName)}`;
          const response = await fetchImpl(url, {
            method: 'POST',
            headers: baseHeaders,
            body: JSON.stringify(row),
          });
          return parseSupabaseRestResponse(response);
        },
        select(columns: string) {
          return makeBuilder('GET');
        },
      };
    },
  };
}

export function createSupabaseHermesProvisioningStore(
  client: SupabaseHermesProvisioningClient,
): HermesProvisioningStateStore & HermesRunnerReadinessStateStore & HermesRunnerDomainDiscoveryStateStore & HermesTestRunnerCleanupStateStore {
  return {
    async claimNextQueuedHermesJob() {
      const result = await client.rpc('claim_next_hermes_provisioning_job', { p_lease_seconds: RAILWAY_PROVISIONING_LEASE_SECONDS });
      throwIfSupabaseError(result, 'claim_next_hermes_provisioning_job_failed');
      const rows = Array.isArray(result.data) ? result.data : [];
      const row = recordOrNull(rows[0]);
      if (!row) return null;
      return {
        userId: requireNonEmpty(nonEmptyString(row.user_id), 'user_id'),
        tierId: normalizePlanTierId(row.tier_id),
        idempotencyKey: requireNonEmpty(nonEmptyString(row.idempotency_key), 'idempotency_key'),
        claimedAt: requireNonEmpty(nonEmptyString(row.claimed_at), 'claimed_at'),
        agentName: normalizeAgentName(nonEmptyString(row.agent_name)),
      };
    },

    async markHermesProvisioningRequested(job, result) {
      const recorded = await client.rpc('record_hermes_provisioning_output', {
        p_user_id: job.userId,
        p_idempotency_key: job.idempotencyKey,
        p_claimed_at: job.claimedAt,
        p_railway_project_id: result.railwayProjectId,
        p_runner_base_url: result.runnerBaseUrl ?? null,
        p_runner_shared_secret: result.runnerSharedSecret,
        p_railway_service_id: result.railwayServiceId ?? null,
        p_railway_volume_id: result.railwayVolumeId ?? null,
        p_railway_workflow_id: result.railwayWorkflowId ?? null,
        p_railway_template_id: result.templateId,
        p_railway_template_code: result.templateCode,
        p_volume_mount_path: result.volumeMountPath,
        p_volume_gb: result.volumeGb,
        p_recorded_at: new Date().toISOString(),
      });
      throwIfSupabaseError(recorded, 'record_hermes_provisioning_output_failed');
      if (recorded.data !== true) throw new Error('stale_hermes_provisioning_claim');
    },

    async markHermesProvisioningFailed(job, failure) {
      const publicResult = await client.from('hermes_instances').update({
        status: 'error',
        error_code: sanitizeProvisioningErrorCode(failure.errorCode),
        public_status_message: failure.publicStatusMessage,
        provisioning_claimed_at: null,
        provisioning_lease_expires_at: null,
        updated_at: new Date().toISOString(),
      }).match(currentHermesProvisioningClaimFilters(job)).select('user_id');
      throwIfSupabaseError(publicResult, 'hermes_instance_failure_update_failed');
    },

    async markHermesProvisioningReconciliationRequired(job, failure) {
      const publicResult = await client.from('hermes_instances').update({
        status: 'provisioning',
        error_code: sanitizeProvisioningErrorCode(failure.errorCode),
        public_status_message: failure.publicStatusMessage,
        updated_at: new Date().toISOString(),
      }).match(currentHermesProvisioningClaimFilters(job)).select('user_id');
      throwIfSupabaseError(publicResult, 'hermes_instance_reconciliation_update_failed');
    },

    async verifyHermesTestRunnerCleanupTarget(target) {
      const result = await client.rpc('verify_hermes_test_runner_cleanup_target', {
        p_user_id: target.userId,
        p_railway_project_id: target.railwayProjectId,
      });
      throwIfSupabaseError(result, 'verify_hermes_test_runner_cleanup_target_failed');
      if (result.data !== true) throw new Error('invalid_hermes_test_runner_cleanup_target');
    },

    async markHermesTestRunnerCleanedUp(target) {
      const result = await client.rpc('cleanup_hermes_test_runner', {
        p_user_id: target.userId,
        p_railway_project_id: target.railwayProjectId,
      });
      throwIfSupabaseError(result, 'cleanup_hermes_test_runner_failed');
      if (result.data !== true) throw new Error('stale_hermes_test_runner_cleanup');
    },

    async claimNextHermesRunnerDomainDiscovery() {
      const result = await client.rpc('claim_next_hermes_runner_domain_discovery', { p_stale_after_seconds: 60 });
      throwIfSupabaseError(result, 'claim_next_hermes_runner_domain_discovery_failed');
      const rows = Array.isArray(result.data) ? result.data : [];
      const row = recordOrNull(rows[0]);
      if (!row) return null;
      return {
        userId: requireNonEmpty(nonEmptyString(row.user_id), 'user_id'),
        railwayProjectId: requireNonEmpty(nonEmptyString(row.railway_project_id), 'railway_project_id'),
        claimedAt: requireNonEmpty(nonEmptyString(row.claimed_at), 'claimed_at'),
      };
    },

    async markHermesRunnerDomainDiscovered(job, endpoint) {
      const runnerBaseUrl = validateRunnerBaseUrl(requireNonEmpty(endpoint.runnerBaseUrl, 'runnerBaseUrl'));
      const result = await client.rpc('record_hermes_runner_domain_discovered', {
        p_user_id: job.userId,
        p_railway_project_id: job.railwayProjectId,
        p_runner_base_url: runnerBaseUrl,
        p_claimed_at: job.claimedAt,
        p_railway_service_id: endpoint.serviceId ?? null,
        p_railway_volume_id: endpoint.volumeId ?? null,
        p_recorded_at: new Date().toISOString(),
      });
      throwIfSupabaseError(result, 'record_hermes_runner_domain_discovered_failed');
      if (result.data !== true) throw new Error('stale_hermes_runner_domain_discovery_claim');
    },

    async claimNextHermesReadinessCheck() {
      const result = await client.rpc('claim_next_hermes_readiness_check', { p_stale_after_seconds: HERMES_RUNNER_READINESS_STALE_SECONDS });
      throwIfSupabaseError(result, 'claim_next_hermes_readiness_check_failed');
      const rows = Array.isArray(result.data) ? result.data : [];
      const row = recordOrNull(rows[0]);
      if (!row) return null;
      return {
        userId: requireNonEmpty(nonEmptyString(row.user_id), 'user_id'),
        runnerBaseUrl: validateRunnerBaseUrl(requireNonEmpty(nonEmptyString(row.runner_base_url), 'runner_base_url')),
        runnerSharedSecret: requireNonEmpty(nonEmptyString(row.runner_shared_secret), 'runner_shared_secret'),
        claimedAt: requireNonEmpty(nonEmptyString(row.claimed_at), 'claimed_at'),
      };
    },

    async markHermesRunnerReady(job) {
      const result = await client.rpc('record_hermes_runner_ready', {
        p_user_id: job.userId,
        p_runner_base_url: job.runnerBaseUrl,
        p_claimed_at: job.claimedAt,
        p_checked_at: new Date().toISOString(),
      });
      throwIfSupabaseError(result, 'record_hermes_runner_ready_failed');
      if (result.data !== true) throw new Error('stale_hermes_runner_readiness_claim');
    },

    async markHermesRunnerReadinessFailed(job, failure) {
      const result = await client.rpc('record_hermes_runner_readiness_failure', {
        p_user_id: job.userId,
        p_runner_base_url: job.runnerBaseUrl,
        p_claimed_at: job.claimedAt,
        p_error_code: sanitizeProvisioningErrorCode(failure.errorCode),
        p_public_status_message: failure.publicStatusMessage,
        p_checked_at: new Date().toISOString(),
      });
      throwIfSupabaseError(result, 'record_hermes_runner_readiness_failure_failed');
      if (result.data !== true) throw new Error('stale_hermes_runner_readiness_claim');
    },
  };
}

function normalizePlanTierId(value: unknown): PlanTierId {
  if (value === 'studio' || value === 'pro-office' || value === 'enterprise-suite') return value;
  throw new Error('invalid_provisioning_tier');
}

// ---------------------------------------------------------------------------
// Series 4 — Supabase store wired to the new 0021 RPCs.
// ---------------------------------------------------------------------------
// Lives next to createSupabaseHermesProvisioningStore so the Series 4 CLI
// commands can build it from the same SupabaseHermesProvisioningClient.

import type {
  Series4LifecycleStore,
  Series4ClaimedFlyProvisioningJob,
  Series4StuckReadinessClaim,
  ProcessSeries4StuckReadinessInput,
  ProcessSeries4StuckReadinessDeps,
  ProcessSeries4StuckReadinessResult,
  Series4FlyProvisioningOutput,
  Series4GraceExpiredRunner,
  AccountDeletionRequestClaim,
  AccountDeletionCompletion,
  AccountDeletionFailure,
  StorageUsageTarget,
  SuspendedRunnerStopTarget,
} from './series4Lifecycle.js';
import type { FlyMachinesRunnerBinding } from './providers/runnerProvider.js';

export function createSeries4SupabaseLifecycleStore(
  client: SupabaseHermesProvisioningClient,
): Series4LifecycleStore {
  return {
    async claimNextSeries4FlyProvisioningJob() {
      // Series 4 reuses the existing claim_next_hermes_provisioning_job RPC
      // — it returns any queued row regardless of provider. The fly_machines
      // /railway_legacy decision is made by the orchestration layer based on
      // SIDEKICK_RUNNER_PROVIDER.
      const result = await client.rpc('claim_next_hermes_provisioning_job', { p_lease_seconds: RAILWAY_PROVISIONING_LEASE_SECONDS });
      throwIfSupabaseError(result, 'claim_next_hermes_provisioning_job_failed');
      const rows = Array.isArray(result.data) ? result.data : [];
      const row = recordOrNull(rows[0]);
      if (!row) return null;
      const claimed: Series4ClaimedFlyProvisioningJob = {
        userId: requireNonEmpty(nonEmptyString(row.user_id), 'user_id'),
        tierId: normalizePlanTierId(row.tier_id),
        idempotencyKey: requireNonEmpty(nonEmptyString(row.idempotency_key), 'idempotency_key'),
        claimedAt: requireNonEmpty(nonEmptyString(row.claimed_at), 'claimed_at'),
        ...(nonEmptyString(row.agent_name) ? { agentName: normalizeAgentName(nonEmptyString(row.agent_name)) } : {}),
      };
      return claimed;
    },

    async recordSeries4FlyProvisioningOutput(job, output) {
      const recorded = await client.rpc('record_hermes_fly_provisioning_output', {
        p_user_id: job.userId,
        p_idempotency_key: job.idempotencyKey,
        p_claimed_at: job.claimedAt,
        p_fly_org: output.flyOrg,
        p_fly_app_name: output.flyAppName,
        p_fly_machine_id: output.flyMachineId,
        p_fly_volume_id: output.flyVolumeId,
        p_fly_region: output.flyRegion,
        p_runner_base_url: output.runnerBaseUrl,
        p_runner_shared_secret: output.runnerSharedSecret,
        p_image_ref: output.imageRef,
        p_image_digest: output.imageDigest,
        p_image_ref_label: output.imageRefLabel,
        p_region_label: output.regionLabel,
        p_storage_quota_gb: output.storageQuotaGb,
        p_recorded_at: new Date().toISOString(),
      });
      throwIfSupabaseError(recorded, 'record_hermes_fly_provisioning_output_failed');
      if (recorded.data !== true) throw new Error('stale_hermes_fly_provisioning_claim');
    },

    async markSeries4FlyProvisioningFailed(job, failure) {
      const result = await client.rpc('transition_hermes_provisioning', {
        p_user_id: job.userId, p_idempotency_key: job.idempotencyKey,
        p_claimed_at: job.claimedAt, p_outcome: 'retry',
        p_error_code: sanitizeProvisioningErrorCode(failure.errorCode),
        p_public_message: failure.publicStatusMessage,
      });
      throwIfSupabaseError(result, 'series4_fly_provisioning_failure_update_failed');
      if (result.data !== true) throw new Error('stale_hermes_provisioning_failure');
    },

    async markSeries4FlyRunnerReady(job, runnerBaseUrl) {
      // D8 — fold the readiness publish into the provisioner pass so a
      // user doesn't need a separate readiness-once cron to flip the
      // public hermes_instances row to 'ready'. Updates status, sets
      // base_url + last_health_at + ready_at, clears any lingering
      // provisioning lease columns.
      const nowIso = new Date().toISOString();
      const result = await client.rpc('transition_hermes_provisioning', {
        p_user_id: job.userId, p_idempotency_key: job.idempotencyKey,
        p_claimed_at: job.claimedAt, p_outcome: 'ready',
        p_runner_base_url: runnerBaseUrl, p_at: nowIso,
      });
      throwIfSupabaseError(result, 'series4_mark_runner_ready_failed');
      if (result.data !== true) throw new Error('stale_hermes_provisioning_readiness');

      // Insert the wake-up assistant message so the mobile chat UI
      // shows a greeting on first load (architecture §6 step 19).
      // PREOP-C01 — name-neutral when the name is the platform fallback so the
      // FIRST message in the user's history never claims an identity they did
      // not choose (the "hey I'm atlas/Ruben" first-entry defect).
      // 2026-08-16: this used to be guarded by `if (job.agentName)`, which made
      // the name-neutral branch of buildDelegentWakeMessageForName unreachable.
      // The claim path above only sets agentName when profiles.agent_name is
      // non-empty, so a user provisioned without a chosen name got NO greeting
      // at all and landed in a completely empty chat on first open. Caught by
      // R-PROV-06 on the 2026-08-16 release gate. buildDelegentWakeMessageForName
      // already returns WAKE_MESSAGE_NAME_NEUTRAL ("Hi there. Nice to meet you")
      // for a null/fallback name, which is exactly what PREOP-C01 intended, so
      // always write a greeting and let the builder pick the right wording.
      const wakeContent = buildDelegentWakeMessageForName(job.agentName ?? null);
      const existing = await client.from('messages').select('id')
        .eq('user_id', job.userId)
        .eq('role', 'assistant')
        .is('task_run_id', null)
        .limit(1)
        // The second .select() is NOT redundant: this repo's typed
        // SupabaseHermesFilterBuilder only exposes .data after a terminal
        // select(). Dropping it fails typecheck with TS2339.
        .select('id');
      const existingRows = Array.isArray(existing.data) ? existing.data : [];
      if (existingRows.length === 0) {
        const msgResult = await client.from('messages').insert({
          user_id: job.userId,
          conversation_id: job.userId,
          role: 'assistant',
          content: wakeContent,
          status: 'complete',
          task_run_id: null,
          attachment_metadata: [],
          tool_calls: [],
          channel: 'in_app',
          created_at: nowIso,
        });
        throwIfSupabaseError(msgResult, 'series4_wake_message_insert_failed');
      }
    },

    async markSeries4FlyProvisioningReconciliationRequired(job, failure) {
      const result = await client.rpc('transition_hermes_provisioning', {
        p_user_id: job.userId, p_idempotency_key: job.idempotencyKey,
        p_claimed_at: job.claimedAt, p_outcome: 'reconcile',
        p_error_code: sanitizeProvisioningErrorCode(failure.errorCode),
        p_public_message: failure.publicStatusMessage,
      });
      throwIfSupabaseError(result, 'series4_fly_provisioning_reconciliation_update_failed');
      if (result.data !== true) throw new Error('stale_hermes_provisioning_reconciliation');
    },

    async markSeries4RunnerSuspended(userId, retentionSeconds, publicStatusMessage) {
      const result = await client.rpc('mark_hermes_runner_suspended', {
        p_user_id: userId,
        p_retention_seconds: retentionSeconds,
        p_public_status_message: publicStatusMessage,
      });
      throwIfSupabaseError(result, 'mark_hermes_runner_suspended_failed');
      return result.data === true;
    },

    async markSeries4RunnerResumed(userId, publicStatusMessage) {
      const result = await client.rpc('mark_hermes_runner_resumed', {
        p_user_id: userId,
        p_public_status_message: publicStatusMessage,
      });
      throwIfSupabaseError(result, 'mark_hermes_runner_resumed_failed');
      return result.data === true;
    },

    async claimNextSeries4GraceExpiredRunner() {
      const claim = await client.rpc('claim_next_hermes_runner_grace_expired', { p_at: new Date().toISOString() });
      throwIfSupabaseError(claim, 'claim_next_hermes_runner_grace_expired_failed');
      const rows = Array.isArray(claim.data) ? claim.data : [];
      const row = recordOrNull(rows[0]);
      if (!row) return null;
      const userId = requireNonEmpty(nonEmptyString(row.user_id), 'user_id');
      const claimedAt = requireNonEmpty(nonEmptyString(row.claimed_at), 'claimed_at');
      // The RPC joins hermes_instance_private to return the binding inline
      // so the daily grace-expiry orchestrator has everything it needs to
      // call FlyMachinesProvider.deleteRunner({force:true}).
      const binding: FlyMachinesRunnerBinding = {
        providerId: 'fly_machines',
        userId,
        runnerBaseUrl: nonEmptyString(row.runner_base_url) ?? '',
        runnerSharedSecret: nonEmptyString(row.runner_shared_secret) ?? '',
        status: 'deleting',
        createdAt: '1970-01-01T00:00:00.000Z',
        lastHealthAt: null,
        fly: {
          org: nonEmptyString(row.fly_org) ?? '',
          appName: nonEmptyString(row.fly_app_name) ?? '',
          machineId: nonEmptyString(row.fly_machine_id) ?? '',
          volumeId: nonEmptyString(row.fly_volume_id) ?? '',
          region: nonEmptyString(row.fly_region) ?? '',
          imageRef: nonEmptyString(row.image_ref) ?? '',
          imageDigest: null,
        },
      };
      const claimed: Series4GraceExpiredRunner = { userId, claimedAt, binding };
      return claimed;
    },

    async claimNextSeries4StuckReadiness() {
      const claim = await client.rpc('claim_next_series4_stuck_readiness', { p_at: new Date().toISOString() });
      throwIfSupabaseError(claim, 'claim_next_series4_stuck_readiness_failed');
      const rows = Array.isArray(claim.data) ? claim.data : [];
      const row = recordOrNull(rows[0]);
      if (!row) return null;
      const userId = requireNonEmpty(nonEmptyString(row.user_id), 'user_id');
      const runnerBaseUrl = requireNonEmpty(nonEmptyString(row.runner_base_url), 'runner_base_url');
      return {
        job: {
          userId,
          tierId: (nonEmptyString(row.tier_id) ?? 'studio') as Series4ClaimedFlyProvisioningJob['tierId'],
          idempotencyKey: nonEmptyString(row.idempotency_key) ?? '',
          claimedAt: nonEmptyString(row.claimed_at) ?? new Date().toISOString(),
        },
        runnerBaseUrl,
      };
    },

    async authorizeSeries4GraceDeletion(claim) {
      const result = await client.rpc('authorize_hermes_grace_deletion', {
        p_user_id: claim.userId, p_claimed_at: claim.claimedAt,
        p_app_name: claim.binding.fly.appName, p_machine_id: claim.binding.fly.machineId,
        p_volume_id: claim.binding.fly.volumeId,
      });
      throwIfSupabaseError(result, 'authorize_hermes_grace_deletion_failed');
      return result.data === true;
    },

    async recordSeries4RunnerDeleted(claim) {
      const result = await client.rpc('finish_hermes_grace_deletion', {
        p_user_id: claim.userId, p_claimed_at: claim.claimedAt,
        p_app_name: claim.binding.fly.appName, p_machine_id: claim.binding.fly.machineId,
        p_volume_id: claim.binding.fly.volumeId,
      });
      throwIfSupabaseError(result, 'finish_hermes_grace_deletion_failed');
      if (result.data !== true) throw new Error('stale_hermes_grace_deletion');
    },

    async claimNextAccountDeletionRequest() {
      const claim = await client.rpc('claim_next_account_deletion_request', {
        p_at: new Date().toISOString(),
        p_processing_lease_seconds: 15 * 60,
      });
      throwIfSupabaseError(claim, 'claim_next_account_deletion_request_failed');
      const rows = Array.isArray(claim.data) ? claim.data : [];
      const row = recordOrNull(rows[0]);
      if (!row) return null;
      const userEmail = nonEmptyString(row.user_email);
      const claimed: AccountDeletionRequestClaim = {
        id: requireNonEmpty(nonEmptyString(row.id), 'id'),
        userId: requireNonEmpty(nonEmptyString(row.user_id), 'user_id'),
        ...(userEmail ? { userEmail } : {}),
        claimedAt: requireNonEmpty(nonEmptyString(row.claimed_at), 'claimed_at'),
        teardownBy: requireNonEmpty(nonEmptyString(row.teardown_by), 'teardown_by'),
        teardownSnapshot: recordOrNull(row.teardown_snapshot) ?? {},
        processingToken: requireNonEmpty(nonEmptyString(row.processing_token), 'processing_token'),
        authDeletedAt: nonEmptyString(row.auth_deleted_at) ?? null,
        connectionsClearedAt: nonEmptyString(row.connections_cleared_at) ?? null,
        infrastructureClearedAt: nonEmptyString(row.infrastructure_cleared_at) ?? null,
        pendingCleanup: (Array.isArray(row.pending_cleanup) ? row.pending_cleanup : [])
          .map((entry) => recordOrNull(entry))
          .filter((entry): entry is Record<string, unknown> => entry !== null),
      };
      return claimed;
    },

    async recordAccountDeletionPhase(requestId, processingToken, phase) {
      const recorded = await client.rpc('record_account_deletion_phase', {
        p_request_id: requestId,
        p_processing_token: processingToken,
        p_phase: phase,
      });
      throwIfSupabaseError(recorded, 'record_account_deletion_phase_failed');
      return recorded.data === true;
    },

    async recordAccountDeletionRequestCompleted(requestId, processingToken, result) {
      const recorded = await client.rpc('record_account_deletion_request_completed', {
        p_request_id: requestId,
        p_processing_token: processingToken,
        p_result: result,
      });
      throwIfSupabaseError(recorded, 'record_account_deletion_request_completed_failed');
      // false is not an error. It means the account is not fully erased yet, so
      // this run has no business calling it done.
      return recorded.data === true;
    },

    async recordAccountDeletionRequestFailed(requestId, failure) {
      const recorded = await client.rpc('record_account_deletion_request_failed', {
        p_request_id: requestId,
        p_error_code: sanitizeProvisioningErrorCode(failure.errorCode),
        p_public_status_message: failure.publicStatusMessage,
      });
      throwIfSupabaseError(recorded, 'record_account_deletion_request_failed_failed');
      if (recorded.data !== true) throw new Error('stale_account_deletion_request_failure');
    },

    async refreshCoworkerUpdateFlags(latestDigest) {
      const result = await client.rpc('refresh_coworker_update_flags', { p_latest_digest: latestDigest });
      throwIfSupabaseError(result, 'refresh_coworker_update_flags_failed');
      return typeof result.data === 'number' ? result.data : 0;
    },

    async claimCoworkerReimageCandidate(latestImageRef, leaseSeconds) {
      const result = await client.rpc('claim_coworker_reimage_candidates', {
        p_latest_image_ref: latestImageRef,
        p_lease_seconds: leaseSeconds,
        p_limit: 1,
      });
      throwIfSupabaseError(result, 'claim_coworker_reimage_candidates_failed');
      const rows = Array.isArray(result.data) ? result.data : [];
      const row = recordOrNull(rows[0]);
      if (!row) return null;
      return {
        userId: requireNonEmpty(nonEmptyString(row.user_id), 'user_id'),
        flyAppName: requireNonEmpty(nonEmptyString(row.fly_app_name), 'fly_app_name'),
        flyMachineId: requireNonEmpty(nonEmptyString(row.fly_machine_id), 'fly_machine_id'),
        flyVolumeId: nonEmptyString(row.fly_volume_id) ?? '',
        flyRegion: nonEmptyString(row.fly_region) ?? '',
        currentImageDigest: nonEmptyString(row.current_image_digest) ?? null,
      };
    },

    async recordCoworkerReimageOutcome(userId, ok, imageRef, imageDigest, error) {
      const result = await client.rpc('complete_coworker_reimage', {
        p_user_id: userId,
        p_ok: ok,
        p_image_ref: imageRef,
        p_image_digest: imageDigest,
        p_error: error,
      });
      throwIfSupabaseError(result, 'complete_coworker_reimage_failed');
    },

    async claimRunnerResizeCandidate(leaseSeconds) {
      const result = await client.rpc('claim_runner_resize_candidates', {
        p_lease_seconds: leaseSeconds,
        p_limit: 1,
      });
      throwIfSupabaseError(result, 'claim_runner_resize_candidates_failed');
      const rows = Array.isArray(result.data) ? result.data : [];
      const row = recordOrNull(rows[0]);
      if (!row) return null;
      return {
        userId: requireNonEmpty(nonEmptyString(row.user_id), 'user_id'),
        flyAppName: requireNonEmpty(nonEmptyString(row.fly_app_name), 'fly_app_name'),
        flyMachineId: requireNonEmpty(nonEmptyString(row.fly_machine_id), 'fly_machine_id'),
        flyVolumeId: requireNonEmpty(nonEmptyString(row.fly_volume_id), 'fly_volume_id'),
        flyRegion: nonEmptyString(row.fly_region) ?? '',
        currentSizedTier: normalizePlanTierId(row.current_sized_tier),
        targetTier: normalizePlanTierId(row.target_tier),
      };
    },

    async recordRunnerResizeOutcome(userId, ok, appliedTier, error) {
      const result = await client.rpc('complete_runner_resize', {
        p_user_id: userId,
        p_ok: ok,
        p_applied_tier: appliedTier,
        p_error: error,
      });
      throwIfSupabaseError(result, 'complete_runner_resize_failed');
    },

    async listStorageUsageTargets(limit, staleSeconds) {
      const result = await client.rpc('list_storage_usage_targets', {
        p_limit: limit,
        p_stale_seconds: staleSeconds,
      });
      throwIfSupabaseError(result, 'list_storage_usage_targets_failed');
      const rows = Array.isArray(result.data) ? result.data : [];
      const targets: StorageUsageTarget[] = [];
      for (const raw of rows) {
        const row = recordOrNull(raw);
        if (!row) continue;
        const userId = nonEmptyString(row.user_id);
        const flyAppName = nonEmptyString(row.fly_app_name);
        const flyVolumeId = nonEmptyString(row.fly_volume_id);
        if (!userId || !flyAppName || !flyVolumeId) continue;
        const quota = Number(row.storage_quota_bytes);
        targets.push({
          userId,
          flyAppName,
          flyVolumeId,
          storageQuotaBytes: Number.isFinite(quota) && quota > 0 ? quota : null,
        });
      }
      return targets;
    },

    async recordStorageUsage(userId, consumedBytes) {
      const result = await client.rpc('record_storage_usage', {
        p_user_id: userId,
        p_consumed_bytes: consumedBytes,
      });
      throwIfSupabaseError(result, 'record_storage_usage_failed');
    },

    // Plain reads rather than an RPC: stopping a suspended machine is
    // idempotent, so this needs no lease and no claim, and therefore no
    // migration. The per-user binding read is bounded by the sweep's batch
    // limit, and suspended runners are rare.
    async listSuspendedRunnerStopTargets(limit) {
      const sleeping = await client
        .from('hermes_instances')
        .select('user_id')
        .eq('status', 'sleeping')
        .limit(limit)
        .select('user_id');
      throwIfSupabaseError(sleeping, 'list_suspended_runners_failed');

      const targets: SuspendedRunnerStopTarget[] = [];
      for (const raw of Array.isArray(sleeping.data) ? sleeping.data : []) {
        const userId = nonEmptyString(recordOrNull(raw)?.user_id);
        if (!userId) continue;
        const binding = await client
          .from('hermes_instance_private')
          .select('user_id,fly_app_name,fly_machine_id,fly_volume_id,fly_region')
          .eq('user_id', userId)
          .limit(1)
          .select('user_id,fly_app_name,fly_machine_id,fly_volume_id,fly_region');
        throwIfSupabaseError(binding, 'list_suspended_runner_bindings_failed');
        const row = recordOrNull(Array.isArray(binding.data) ? binding.data[0] : null);
        if (!row) continue;
        const flyAppName = nonEmptyString(row.fly_app_name);
        const flyMachineId = nonEmptyString(row.fly_machine_id);
        // A row with no machine id is a Railway-era or half-provisioned
        // binding; there is nothing to stop.
        if (!flyAppName || !flyMachineId) continue;
        targets.push({
          userId,
          flyAppName,
          flyMachineId,
          flyVolumeId: nonEmptyString(row.fly_volume_id) ?? '',
          flyRegion: nonEmptyString(row.fly_region) ?? '',
        });
      }
      return targets;
    },
  };
}


function currentHermesProvisioningClaimFilters(job: ClaimedHermesProvisioningJob): Record<string, unknown> {
  return {
    user_id: job.userId,
    status: 'provisioning',
    provisioning_idempotency_key: job.idempotencyKey,
    provisioning_claimed_at: job.claimedAt,
  };
}

function throwIfSupabaseError(result: SupabaseHermesResult, fallback: string): void {
  if (result.error) throw new Error(nonEmptyString(result.error.message) ?? fallback);
}

function throwIfNoSupabaseRows(result: SupabaseHermesResult, fallback: string): void {
  if (!Array.isArray(result.data) || result.data.length === 0) throw new Error(fallback);
}

function sanitizeProvisioningErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return sanitized || 'hermes_provisioning_failed';
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// -----------------------------------------------------------------------------
// Series 4 — provider abstraction exports
// -----------------------------------------------------------------------------
// Re-exported from ./providers so callers can do
//   import { createFlyMachinesProvider, type RunnerProvider } from '@sidekick/provisioner';
// without reaching into ./providers/* directly. The legacy Railway path
// above is left unchanged for the cutover window; new code must go through
// the RunnerProvider interface, and SIDEKICK_RUNNER_PROVIDER controls which
// implementation the orchestration layer picks.
export {
  createFlyMachinesProvider,
  buildFlyRunnerEnv,
  flyRunnerRouteBEnabled,
  flyRunnerAutostop,
  flyRunnerAutostopForUser,
  normalizeAutostop,
  flyMachinesAppName,
  FLY_MACHINES_API_BASE,
  FLY_RUNNER_APP_PREFIX_DEFAULT,
  FLY_PRIMARY_REGION_DEFAULT,
  FLY_WORKSPACE_MOUNT_PATH,
  FLY_VOLUME_MOUNT_PATH,
  FLY_RUNNER_INTERNAL_PORT,
} from './providers/flyMachines.js';
export type { FlyMachinesProviderConfig } from './providers/flyMachines.js';
export {
  buildDelegentRunnerToolsets,
  DELEGENT_ROUTE_B_EXTRA_TOOLSETS,
  DELEGENT_RUNNER_TOOLSETS,
} from './delegentAgentDefaults.js';
export {
  deriveRunnerResourceSuffix,
  chooseVolumeSizeGb,
  storageEntitlementGb,
  nextVolumeSizeGb,
  START_VOLUME_SIZE_GB,
  STORAGE_GROW_AT_FRACTION,
  DEFAULT_VOLUME_SIZE_GB_BY_TIER,
  chooseComputeTier,
  DEFAULT_COMPUTE_TIER_BY_PLAN,
} from './providers/runnerProvider.js';
export type {
  RunnerProvider,
  RunnerProviderId,
  RunnerStatus,
  RunnerBinding,
  RunnerBindingCommon,
  FlyMachinesRunnerBinding,
  RailwayLegacyRunnerBinding,
  CreateRunnerInput,
  RunnerHealth,
  RunnerProviderActionResult,
  RunnerProviderPreflight,
  RunnerProviderPreflightCheck,
  DeleteRunnerOptions,
  StorageUsageResult,
  GrowStorageResult,
} from './providers/runnerProvider.js';

/**
 * Resolves which RunnerProvider implementation should be active from the
 * SIDEKICK_RUNNER_PROVIDER env var. Defaults to fly_machines in Series 4.
 * Returns 'railway_legacy' only when explicitly requested.
 */
export function resolveActiveRunnerProviderId(env: Record<string, string | undefined>): 'fly_machines' | 'railway_legacy' {
  const raw = (env.SIDEKICK_RUNNER_PROVIDER ?? '').trim().toLowerCase();
  return raw === 'railway_legacy' ? 'railway_legacy' : 'fly_machines';
}

// Re-export Series 4 lifecycle orchestrators + types.
export {
  processNextSeries4FlyProvisioningJob,
  processSeries4SubscriptionSuspension,
  processNextSeries4GraceExpiry,
  processNextSeries4StuckReadiness,
  processNextAccountDeletionRequest,
  processNextCoworkerReimage,
  processNextSeries4RunnerResize,
  processSeries4StorageUsageSweep,
  processSeries4SuspendedRunnerStop,
  COWORKER_REIMAGE_LEASE_SECONDS,
  RUNNER_RESIZE_LEASE_SECONDS,
  STORAGE_USAGE_BATCH_LIMIT,
  STORAGE_USAGE_STALE_SECONDS,
  SUSPENDED_STOP_BATCH_LIMIT,
  resolveFlyVolumeRetentionSeconds,
  sanitizeSeries4ErrorCode,
  imageRefLabel,
} from './series4Lifecycle.js';
export type {
  Series4LifecycleStore,
  Series4ClaimedFlyProvisioningJob,
  Series4FlyProvisioningOutput,
  Series4GraceExpiredRunner,
  AccountDeletionRequestClaim,
  AccountDeletionCompletion,
  AccountDeletionFailure,
  ProcessSeries4FlyProvisioningInput,
  ProcessSeries4FlyProvisioningDeps,
  ProcessSeries4FlyProvisioningResult,
  ProcessSeries4SubscriptionSuspensionInput,
  ProcessSeries4SubscriptionSuspensionDeps,
  ProcessSeries4SubscriptionSuspensionResult,
  ProcessSeries4GraceExpiryInput,
  ProcessSeries4GraceExpiryDeps,
  ProcessSeries4GraceExpiryResult,
  ProcessAccountDeletionRequestInput,
  ProcessAccountDeletionRequestDeps,
  ProcessAccountDeletionRequestResult,
  CoworkerReimageClaim,
  ProcessCoworkerReimageInput,
  ProcessCoworkerReimageDeps,
  ProcessCoworkerReimageResult,
  RunnerResizeClaim,
  ProcessRunnerResizeInput,
  ProcessRunnerResizeDeps,
  ProcessRunnerResizeResult,
  StorageUsageTarget,
  ProcessStorageUsageInput,
  ProcessStorageUsageDeps,
  ProcessStorageUsageResult,
  SuspendedRunnerStopTarget,
  ProcessSuspendedRunnerStopInput,
  ProcessSuspendedRunnerStopDeps,
  ProcessSuspendedRunnerStopResult,
} from './series4Lifecycle.js';
