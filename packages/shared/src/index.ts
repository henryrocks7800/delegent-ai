import { AGENT_PLAN } from './content/agentEngine.ts';

export type SubscriptionStatus = 'inactive' | 'trialing' | 'active' | 'past_due' | 'canceled';

/**
 * Who bills this subscription. Mirrors subscriptions.billing_provider, added by
 * migration 0054 and surfaced on my_product_state by 0055.
 *
 * WHY IT HAS TO BE ON THE PUBLIC SNAPSHOT. Without it the app cannot tell an
 * Apple subscription from a Stripe one, so it has to refuse a tier change to
 * EVERY subscriber, and an Apple customer gets told their plan is billed
 * elsewhere when it is not. Apple treats a tier change within a subscription
 * group as an upgrade rather than a second purchase, so refusing it is both
 * wrong and a poor look at review.
 */
export type BillingProvider = 'stripe' | 'apple';
export type HermesInstanceStatus =
  | 'not_requested'
  | 'queued'
  | 'provisioning'
  | 'ready'
  | 'degraded'
  | 'error'
  | 'sleeping'
  | 'deleting'
  | 'deleted';
export type ChatRole = 'user' | 'assistant' | 'system';
export type PlanTierId = 'studio' | 'pro-office' | 'enterprise-suite';
export type ProductGateKind =
  | 'signed_out'
  | 'needs_acknowledgement'
  | 'needs_subscription'
  | 'workspace_retained'
  | 'subscribed_pending_worker'
  | 'provisioning_worker'
  | 'ready'
  | 'degraded'
  | 'hard_limited'
  | 'error';

export type GateTone = 'neutral' | 'accent' | 'live' | 'warning' | 'danger';
export type GatewayId = 'telegram' | 'whatsapp' | 'signal' | 'email';
export type MessagingProviderId = Exclude<GatewayId, 'email'>;
export type GatewayStatus = 'live' | 'ready' | 'testing' | 'paused';
export type MessagingProviderConnectionStatus = 'connected' | 'disconnected';
export type ArtifactStatus = 'ready' | 'review' | 'saved' | 'archived';
// 'dispatched' was added to the DB enum in migration 0024 and is what the
// live chat pipeline parks in-flight runs at; without it here, mobile's
// status coercion rendered every in-flight run as 'queued'.
export type TaskRunStatus = 'queued' | 'dispatched' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface PlanTier {
  id: PlanTierId;
  shortName: string;
  name: string;
  priceGbpMonthly: number;
  monthlyTokenQuota: number;
  /** Storage volume size provisioned on Fly for this tier. Internal only; never shown to users. */
  storageGb: number;
  /** Voice-transcription minutes per billing cycle, expressed in seconds for the schema. */
  voiceSecondsQuota: number;
  stripePriceLookupKey: string;
  summary: string;
  /**
   * Honest, everyday-terms capacity line for user-facing copy. Framed as a
   * rough guide ("around"/"roughly"), never a hard promise, and never in
   * tokens or infra terms. One sentence. An "involved task" is a multi-step
   * job (research with sources, a built spreadsheet or deck, a drafted-and-
   * saved reply).
   */
  capacityNote?: string;
  /**
   * Plain-terms inference line for the value story: roughly how much monthly
   * thinking the plan buys, stated as a big concrete number plus the tasks it
   * equates to. Alex 2026-07-24: lead the plans on inference (not fixed storage,
   * which is internal only). One sentence, everyday framing, "around"/"roughly".
   */
  inferenceNote?: string;
  features: readonly string[];
  /** R-UX-04 — ribbon label rendered above the most-chosen tier card. */
  ribbon?: string;
  /** R-UX-04 — convenience boolean for surfaces that want to branch on it. */
  isMostChosen?: boolean;
}

export interface Profile {
  id: string;
  email: string;
  fullName?: string;
  agentName?: string;
  avatarUrl?: string;
  region?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface Acknowledgement {
  userId: string;
  acceptedAt: string;
  textVersion: string;
}

export interface Subscription {
  userId: string;
  status: SubscriptionStatus;
  tierId?: PlanTierId;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  priceId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  /** Verified Apple service/grace deadline, separate from its billing period. */
  serviceAccessUntil?: string;
  cancelAtPeriodEnd?: boolean;
  /**
   * Undefined means UNKNOWN, not Stripe. A client reading a database without
   * migration 0055 sees undefined, and every caller must treat that as
   * "not provably Apple" so the safe refusal still happens.
   */
  billingProvider?: BillingProvider;
  updatedAt?: string;
}

/**
 * Coworker engine (golden image) update lifecycle, surfaced mobile-safe. The
 * platform re-images the runner onto a newer image in place (preserving the
 * workspace volume); the user triggers it. Never exposes digests / app names /
 * machine ids — only the coarse state the app needs for a badge + button.
 */
export type CoworkerUpdateStatus = 'idle' | 'available' | 'updating' | 'updated' | 'failed';

export interface HermesInstance {
  userId: string;
  status: HermesInstanceStatus;
  /** Private infrastructure identifiers must stay server-side. Mobile should receive only public fields below. */
  railwayProjectId?: string;
  railwayServiceId?: string;
  railwayVolumeId?: string;
  baseUrl?: string;
  lastHealthAt?: string;
  readyAt?: string;
  error?: string;
  errorCode?: string;
  publicStatusMessage?: string;
  suspendedAt?: string;
  volumeRetentionUntil?: string;
  deletedAt?: string;
  coworkerUpdateAvailable?: boolean;
  coworkerUpdateStatus?: CoworkerUpdateStatus;
  reimageRequestedAt?: string;
  reimagedAt?: string;
  updatedAt?: string;
}

export interface PublicHermesInstance {
  userId: string;
  status: HermesInstanceStatus;
  lastHealthAt?: string;
  readyAt?: string;
  errorCode?: string;
  publicStatusMessage?: string;
  suspendedAt?: string;
  volumeRetentionUntil?: string;
  deletedAt?: string;
  coworkerUpdateAvailable?: boolean;
  coworkerUpdateStatus?: CoworkerUpdateStatus;
  reimageRequestedAt?: string;
  reimagedAt?: string;
  updatedAt?: string;
}

export interface ChatMessage {
  id: string;
  userId: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  taskId?: string;
}

export interface TokenUsageEvent {
  userId: string;
  totalTokens: number;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  source?: string;
  createdAt: string;
}

export interface UsageQuota {
  userId: string;
  monthlyTokenQuota: number;
  tierId?: PlanTierId;
  updatedAt?: string;
}

export interface UsageSummary {
  usedTokens: number;
  quotaTokens: number;
  remainingTokens: number;
  ratio: number;
  nearLimit: boolean;
  hardLimited: boolean;
}

export interface GatewayConnection {
  id: GatewayId;
  name: string;
  description: string;
  status: GatewayStatus;
  badge: string;
  actionLabel: string;
}

export interface MessagingProviderConnectionRecord {
  providerId: MessagingProviderId;
  status: MessagingProviderConnectionStatus;
  connectedAt?: string;
  disconnectedAt?: string;
}

export type MessagingProviderSwitchReason = 'connect_provider' | 'switch_provider' | 'already_active';

export interface MessagingProviderSwitchEligibility {
  canSwitch: boolean;
  activeProviderId: MessagingProviderId | null;
  targetProviderId: MessagingProviderId;
  reason: MessagingProviderSwitchReason;
  publicLabel: string;
}

export type GatewayConnectionOverrides = Partial<Record<GatewayId, Partial<Omit<GatewayConnection, 'id'>>>>;

export const MESSAGING_PROVIDER_IDS = ['telegram', 'whatsapp', 'signal'] as const satisfies readonly MessagingProviderId[];

const MESSAGING_PROVIDER_ID_SET = new Set<string>(MESSAGING_PROVIDER_IDS);

export const SIDEKICK_GATEWAY_REGISTRY = [
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'First messenger for quick task handoff and short updates.',
    status: 'ready',
    badge: 'First',
    actionLabel: 'Connect Telegram',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'For personal and client requests where they already arrive.',
    status: 'testing',
    badge: 'Testing',
    actionLabel: 'Coming next',
  },
  {
    id: 'signal',
    name: 'Signal',
    description: 'Private route for sensitive follow-ups, coming later.',
    status: 'paused',
    badge: 'Paused',
    actionLabel: 'Waiting',
  },
  {
    id: 'email',
    name: 'Email',
    description: 'Inbox route for forms, attachments, and longer requests.',
    status: 'ready',
    badge: 'Planned',
    actionLabel: 'Coming later',
  },
] as const satisfies readonly GatewayConnection[];

export function resolveGatewayConnections(overrides: GatewayConnectionOverrides = {}): readonly GatewayConnection[] {
  return SIDEKICK_GATEWAY_REGISTRY.map((connection) => ({
    ...connection,
    ...(overrides[connection.id] ?? {}),
    id: connection.id,
  }));
}

export function isMessagingProviderId(value: unknown): value is MessagingProviderId {
  return typeof value === 'string' && MESSAGING_PROVIDER_ID_SET.has(value);
}

export function publicMessagingProviderLabel(providerId: MessagingProviderId): string {
  return SIDEKICK_GATEWAY_REGISTRY.find((gateway) => gateway.id === providerId)?.name ?? providerId;
}

export function resolveMessagingProviderStatus(
  providerId: MessagingProviderId,
  activeProviderId: MessagingProviderId | null | undefined = null,
): GatewayStatus {
  if (activeProviderId === providerId) return 'live';
  return SIDEKICK_GATEWAY_REGISTRY.find((gateway) => gateway.id === providerId)?.status ?? 'paused';
}

export function resolveActiveMessagingProviderId(
  records: readonly MessagingProviderConnectionRecord[] = [],
): MessagingProviderId | null {
  const activeIds = Array.from(new Set(records
    .filter((record) => record.status === 'connected')
    .map((record) => record.providerId)));

  if (activeIds.length > 1) {
    throw new Error('Expected one active messaging provider per user.');
  }

  return activeIds[0] ?? null;
}

export function resolveMessagingProviderConnections(
  records: readonly MessagingProviderConnectionRecord[] = [],
): readonly GatewayConnection[] {
  const activeProviderId = resolveActiveMessagingProviderId(records);
  return MESSAGING_PROVIDER_IDS.map((providerId) => {
    const connection = SIDEKICK_GATEWAY_REGISTRY.find((gateway) => gateway.id === providerId) as GatewayConnection;
    const status = resolveMessagingProviderStatus(providerId, activeProviderId);
    if (status === 'live') {
      return {
        ...connection,
        status,
        badge: 'Connected',
        actionLabel: 'Connected',
        description: `${connection.name} is connected for task handoff.`,
      };
    }

    return {
      ...connection,
      status,
    };
  });
}

export function normalizeMessagingProviderConnectionRecords(input: unknown): readonly MessagingProviderConnectionRecord[] {
  if (!Array.isArray(input)) return [];

  return input.flatMap((row): MessagingProviderConnectionRecord[] => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return [];
    const record = row as Record<string, unknown>;
    const providerValue = record.providerId ?? record.provider_id ?? record.gatewayId ?? record.gateway_id;
    if (!isMessagingProviderId(providerValue)) return [];
    const status = record.status === 'connected' ? 'connected' : 'disconnected';
    const normalized: MessagingProviderConnectionRecord = {
      providerId: providerValue,
      status,
    };
    if (typeof record.connectedAt === 'string' && record.connectedAt.trim()) normalized.connectedAt = record.connectedAt.trim();
    if (typeof record.connected_at === 'string' && record.connected_at.trim()) normalized.connectedAt = record.connected_at.trim();
    if (typeof record.disconnectedAt === 'string' && record.disconnectedAt.trim()) normalized.disconnectedAt = record.disconnectedAt.trim();
    if (typeof record.disconnected_at === 'string' && record.disconnected_at.trim()) normalized.disconnectedAt = record.disconnected_at.trim();
    return [normalized];
  });
}

export function resolveMessagingProviderSwitchEligibility(input: {
  activeProviderId?: MessagingProviderId | null;
  targetProviderId: MessagingProviderId;
}): MessagingProviderSwitchEligibility {
  const activeProviderId = input.activeProviderId ?? null;
  const targetProviderId = input.targetProviderId;
  const targetLabel = publicMessagingProviderLabel(targetProviderId);

  if (activeProviderId === targetProviderId) {
    return {
      canSwitch: false,
      activeProviderId,
      targetProviderId,
      reason: 'already_active',
      publicLabel: `${targetLabel} is already connected`,
    };
  }

  if (activeProviderId) {
    return {
      canSwitch: true,
      activeProviderId,
      targetProviderId,
      reason: 'switch_provider',
      publicLabel: `Switch from ${publicMessagingProviderLabel(activeProviderId)} to ${targetLabel}`,
    };
  }

  return {
    canSwitch: true,
    activeProviderId,
    targetProviderId,
    reason: 'connect_provider',
    publicLabel: `Connect ${targetLabel}`,
  };
}

export type GatewayConnectIntentStatus = 'not_ready' | 'code_ready' | 'expired';

export interface GatewayConnectIntentInput {
  gatewayId: GatewayId;
  code?: string | null;
  expiresAt?: string | null;
  now?: string | Date;
}

export interface GatewayConnectIntent {
  gatewayId: GatewayId;
  providerName: string;
  status: GatewayConnectIntentStatus;
  title: string;
  body: string;
  actionLabel: string;
  displayCode: string | null;
  expiresAt: string | null;
  canStart: boolean;
}

export function normalizeGatewayConnectCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const compact = input.replace(/[\s-]/g, '').toUpperCase();
  if (!/^TG[A-Z0-9]{6}$/.test(compact)) return null;
  return compact;
}

function displayGatewayConnectCode(code: string): string {
  return `${code.slice(0, 2)} ${code.slice(2, 5)} ${code.slice(5)}`;
}

function gatewayName(gatewayId: GatewayId): string {
  return SIDEKICK_GATEWAY_REGISTRY.find((gateway) => gateway.id === gatewayId)?.name ?? gatewayId;
}

export function resolveGatewayConnectIntent(input: GatewayConnectIntentInput): GatewayConnectIntent {
  const providerName = gatewayName(input.gatewayId);
  const normalizedCode = normalizeGatewayConnectCode(input.code);
  const expiresAt = input.expiresAt ?? null;
  const nowMs = input.now ? new Date(input.now).getTime() : Date.now();
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  const expired = Number.isFinite(expiresMs) && expiresMs <= nowMs;

  if (!normalizedCode || !expiresAt) {
    if (input.gatewayId === 'telegram') {
      return {
        gatewayId: input.gatewayId,
        providerName,
        status: 'not_ready',
        title: 'Telegram is being connected',
        body: 'A short Telegram link code will appear here when your account is ready to pair.',
        actionLabel: 'Waiting for code',
        displayCode: null,
        expiresAt,
        canStart: false,
      };
    }

    return {
      gatewayId: input.gatewayId,
      providerName,
      status: 'not_ready',
      title: `${providerName} is coming later`,
      body: `${providerName} will appear here when its connection code is available.`,
      actionLabel: 'Coming later',
      displayCode: null,
      expiresAt,
      canStart: false,
    };
  }

  if (expired) {
    return {
      gatewayId: input.gatewayId,
      providerName,
      status: 'expired',
      title: `${providerName} code expired`,
      body: `This ${providerName} code has expired. Ask for a new code before trying again.`,
      actionLabel: 'Get a new code',
      displayCode: null,
      expiresAt,
      canStart: false,
    };
  }

  return {
    gatewayId: input.gatewayId,
    providerName,
    status: 'code_ready',
    title: `Connect ${providerName}`,
    body: `Send this code to your Delegent AI bot on ${providerName} to link this chat.`,
    actionLabel: 'Copy code',
    displayCode: displayGatewayConnectCode(normalizedCode),
    expiresAt,
    canStart: true,
  };
}

export type GatewayTaskHandoffKind = 'task_handoff' | 'connect_code' | 'needs_connection' | 'ignored';
export type TelegramWebhookIgnoreReason = 'missing_message' | 'unsupported_chat' | 'empty_text' | 'too_long' | 'unsupported_payload';

export interface TelegramWebhookHandoffInput {
  update: unknown;
  linkedUserId?: string | null;
  now?: string | Date;
  maxInstructionChars?: number;
}

export interface GatewayTaskDraft {
  gatewayId: 'telegram';
  userId: string;
  instruction: string;
  title: string;
  sourceEventId: string;
  sourceConversationId: string;
  sourceMessageId: string;
  idempotencyKey: string;
  requesterDisplayName: string | null;
  receivedAt: string;
}

export type TelegramWebhookHandoff =
  | (GatewayTaskDraft & {
      kind: 'task_handoff';
      publicReply: string;
    })
  | {
      kind: 'connect_code';
      gatewayId: 'telegram';
      code: string;
      sourceEventId: string;
      sourceConversationId: string;
      sourceMessageId: string;
      idempotencyKey: string;
      receivedAt: string;
      publicReply: string;
    }
  | {
      kind: 'needs_connection';
      gatewayId: 'telegram';
      sourceEventId: string;
      sourceConversationId: string;
      sourceMessageId: string;
      idempotencyKey: string;
      receivedAt: string;
      publicReply: string;
    }
  | {
      kind: 'ignored';
      gatewayId: 'telegram';
      reason: TelegramWebhookIgnoreReason;
      sourceEventId?: string;
      idempotencyKey?: string;
    };

function isSharedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idToString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function extractGatewayConnectCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const startMatch = trimmed.match(/^\/start(?:@\w+)?\s+(.+)$/i);
  if (startMatch) return normalizeGatewayConnectCode(startMatch[1]);
  return normalizeGatewayConnectCode(trimmed);
}

function telegramTimestamp(input: TelegramWebhookHandoffInput, message: Record<string, unknown>): string {
  if (input.now) return new Date(input.now).toISOString();
  if (typeof message.date === 'number' && Number.isFinite(message.date)) return new Date(message.date * 1000).toISOString();
  return new Date().toISOString();
}

function telegramIgnored(reason: TelegramWebhookIgnoreReason, updateId?: string | null, messageId?: string | null): TelegramWebhookHandoff {
  return {
    kind: 'ignored',
    gatewayId: 'telegram',
    reason,
    sourceEventId: updateId ? `telegram:update:${updateId}` : undefined,
    idempotencyKey: updateId && messageId ? `telegram:${updateId}:${messageId}:ignored` : undefined,
  };
}

export function resolveTelegramWebhookHandoff(input: TelegramWebhookHandoffInput): TelegramWebhookHandoff {
  const update = isSharedRecord(input.update) ? input.update : null;
  const updateId = update ? idToString(update.update_id) : null;
  const message = update && isSharedRecord(update.message) ? update.message : null;
  if (!update || !message || !updateId) return telegramIgnored('missing_message', updateId);

  const messageId = idToString(message.message_id);
  const chat = isSharedRecord(message.chat) ? message.chat : null;
  const chatId = chat ? idToString(chat.id) : null;
  const chatType = typeof chat?.type === 'string' ? chat.type : null;
  const sourceEventId = `telegram:update:${updateId}`;

  if (!messageId || !chatId) return telegramIgnored('unsupported_payload', updateId, messageId);
  if (chatType !== 'private') return telegramIgnored('unsupported_chat', updateId, messageId);

  const sourceConversationId = `telegram:chat:${chatId}`;
  const sourceMessageId = `telegram:message:${messageId}`;
  const receivedAt = telegramTimestamp(input, message);
  const text = typeof message.text === 'string' ? message.text.trim() : '';

  if (!text) return telegramIgnored('empty_text', updateId, messageId);

  const connectCode = extractGatewayConnectCode(text);
  if (connectCode) {
    return {
      kind: 'connect_code',
      gatewayId: 'telegram',
      code: connectCode,
      sourceEventId,
      sourceConversationId,
      sourceMessageId,
      idempotencyKey: `telegram:${updateId}:${messageId}:connect`,
      receivedAt,
      publicReply: 'Almost connected. Finish the link in the Delegent AI app.',
    };
  }

  if (!input.linkedUserId) {
    return {
      kind: 'needs_connection',
      gatewayId: 'telegram',
      sourceEventId,
      sourceConversationId,
      sourceMessageId,
      idempotencyKey: `telegram:${updateId}:${messageId}:needs-connection`,
      receivedAt,
      publicReply: 'Connect Telegram in the Delegent AI app first, then resend this task.',
    };
  }

  const maxInstructionChars = input.maxInstructionChars ?? 4_000;
  if (text.length > maxInstructionChars) return telegramIgnored('too_long', updateId, messageId);

  const from = isSharedRecord(message.from) ? message.from : null;
  const requesterDisplayName = from ? firstString([from.first_name, from.last_name].filter(Boolean).join(' '), from.username) : null;
  const title = text.length > 80 ? `${text.slice(0, 77).trimEnd()}…` : text;

  return {
    kind: 'task_handoff',
    gatewayId: 'telegram',
    userId: input.linkedUserId,
    instruction: text,
    title,
    sourceEventId,
    sourceConversationId,
    sourceMessageId,
    idempotencyKey: `telegram:${updateId}:${messageId}`,
    requesterDisplayName,
    receivedAt,
    publicReply: "Got it. I'm on it.",
  };
}

export type StripeBillingDryRunEventType =
  | 'checkout.session.completed'
  | 'customer.subscription.created'
  | 'customer.subscription.updated'
  | 'customer.subscription.deleted'
  | 'invoice.payment_succeeded'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | (string & {});

export interface StripeBillingDryRunEventInput {
  id: string;
  type: StripeBillingDryRunEventType;
  mode: 'dry_run';
  userId?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
  priceId?: string | null;
  priceLookupKey?: string | null;
  status?: SubscriptionStatus | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean | null;
  occurredAt: string;
}

export type StripeBillingDryRunResolution =
  | {
      kind: 'subscription_patch';
      provider: 'stripe';
      mode: 'dry_run';
      eventId: string;
      idempotencyKey: string;
      subscription: Subscription;
      usageQuota: UsageQuota;
      shouldPrepareCoworker: boolean;
      publicMessage: string;
    }
  | {
      kind: 'ignored';
      provider: 'stripe';
      mode: 'dry_run';
      eventId: string;
      reason: 'missing_user' | 'unknown_price_lookup_key' | 'unsupported_event' | 'incomplete_provider_entitlement';
    };

const SUPPORTED_STRIPE_DRY_RUN_EVENTS = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_succeeded',
  'invoice.paid',
  'invoice.payment_failed',
]);

export function planTierIdForStripeLookupKey(lookupKey: string | null | undefined): PlanTierId | null {
  if (!lookupKey) return null;
  // The coworker plan's price records under its tier, so a subscription on it
  // is entitled like any other instead of being ignored as an unknown price.
  if (lookupKey.trim() === AGENT_PLAN.stripePriceLookupKey) return AGENT_PLAN.tierId;
  return SIDEKICK_PLAN_TIERS.find((tier) => tier.stripePriceLookupKey === lookupKey.trim())?.id ?? null;
}

export function resolveStripeBillingDryRunEvent(input: StripeBillingDryRunEventInput): StripeBillingDryRunResolution {
  if (!SUPPORTED_STRIPE_DRY_RUN_EVENTS.has(input.type)) {
    return { kind: 'ignored', provider: 'stripe', mode: 'dry_run', eventId: input.id, reason: 'unsupported_event' };
  }

  const userId = input.userId?.trim();
  if (!userId) return { kind: 'ignored', provider: 'stripe', mode: 'dry_run', eventId: input.id, reason: 'missing_user' };

  const tierId = planTierIdForStripeLookupKey(input.priceLookupKey);
  if (!tierId) return { kind: 'ignored', provider: 'stripe', mode: 'dry_run', eventId: input.id, reason: 'unknown_price_lookup_key' };

  const tier = getPlanTier(tierId);
  const status: SubscriptionStatus = input.type === 'customer.subscription.deleted' ? 'canceled' : input.status ?? 'inactive';
  const stripeCustomerId = input.customerId?.trim() || undefined;
  const stripeSubscriptionId = input.subscriptionId?.trim() || undefined;
  const priceId = input.priceId?.trim() || undefined;
  const currentPeriodStart = input.currentPeriodStart ?? undefined;
  const currentPeriodEnd = input.currentPeriodEnd ?? undefined;

  if (requiresProviderEntitlementFields(status) && !hasCompleteProviderEntitlementFields({
    stripeCustomerId,
    stripeSubscriptionId,
    priceId,
    currentPeriodStart,
    currentPeriodEnd,
  })) {
    return {
      kind: 'ignored',
      provider: 'stripe',
      mode: 'dry_run',
      eventId: input.id,
      reason: 'incomplete_provider_entitlement',
    };
  }

  const subscription: Subscription = {
    userId,
    status,
    tierId,
    stripeCustomerId,
    stripeSubscriptionId,
    priceId,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? undefined,
    updatedAt: input.occurredAt,
  };
  const usageQuota: UsageQuota = {
    userId,
    tierId,
    monthlyTokenQuota: tier.monthlyTokenQuota,
    updatedAt: input.occurredAt,
  };
  const shouldPrepareCoworker = status === 'active' || status === 'trialing';

  return {
    kind: 'subscription_patch',
    provider: 'stripe',
    mode: 'dry_run',
    eventId: input.id,
    idempotencyKey: `stripe:${input.id}`,
    subscription,
    usageQuota,
    shouldPrepareCoworker,
    publicMessage: shouldPrepareCoworker
      ? "Plan active. Your coworker's cloud computer is being set up."
      : 'Plan needs attention before your coworker can take new tasks.',
  };
}

function requiresProviderEntitlementFields(status: SubscriptionStatus): boolean {
  return status === 'trialing' || status === 'active' || status === 'past_due';
}

function hasCompleteProviderEntitlementFields(input: {
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  priceId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
}): boolean {
  if (!input.stripeCustomerId || !input.stripeSubscriptionId || !input.priceId) return false;
  if (!input.currentPeriodStart || !input.currentPeriodEnd) return false;

  const currentPeriodStart = Date.parse(input.currentPeriodStart);
  const currentPeriodEnd = Date.parse(input.currentPeriodEnd);
  if (!Number.isFinite(currentPeriodStart) || !Number.isFinite(currentPeriodEnd)) return false;

  return currentPeriodEnd >= currentPeriodStart;
}

export type InspirationCategory = 'admin' | 'research' | 'writing';
export type InspirationId = 'tidy-admin-notes' | 'compare-options' | 'draft-reply';

export interface InspirationStarter {
  id: InspirationId;
  title: string;
  category: InspirationCategory;
  summary: string;
  request: string;
  resultHint: string;
}

export const SIDEKICK_INSPIRATION_STARTERS = [
  {
    id: 'tidy-admin-notes',
    title: 'Tidy admin notes',
    category: 'admin',
    summary: 'Turn rough notes into a clean checklist and next message.',
    request: 'Turn these rough notes into a clear checklist. Group the tasks, call out anything missing, and suggest the next message I should send: [paste notes]',
    resultHint: 'Checklist, missing details, and a draft follow-up.',
  },
  {
    id: 'compare-options',
    title: 'Compare my options',
    category: 'research',
    summary: 'Compare choices in plain English and end with a recommendation.',
    request: 'Compare these options in plain English. Use price, effort, risks, and best fit. End with a short recommendation: [paste links or notes]',
    resultHint: 'Simple comparison and recommendation.',
  },
  {
    id: 'draft-reply',
    title: 'Draft a reply',
    category: 'writing',
    summary: 'Write a polite, concise response with the next step included.',
    request: 'Draft a polite reply to this message. Confirm the next step, ask for any missing details, and keep it warm but concise: [paste message]',
    resultHint: 'Ready-to-edit reply.',
  },
] as const satisfies readonly InspirationStarter[];

export type LiveProviderId = 'google' | 'telegram' | 'stripe' | 'whatsapp' | 'cloudflare' | 'railway' | 'signal';

export interface LiveProviderRequirement {
  id: string;
  label: string;
  kind: 'account' | 'setup' | 'server_secret' | 'approval' | 'decision';
}

export interface LiveProviderReadiness {
  providerId: LiveProviderId;
  providerName: string;
  ready: boolean;
  requirementIds: readonly string[];
  missingRequirementIds: readonly string[];
  publicSummary: string;
}

export type ProvisioningProviderId = Extract<LiveProviderId, 'railway' | 'cloudflare'>;
export type ProvisioningReadinessStatus = 'blocked' | 'ready';

export interface ProvisioningReadinessInput {
  railwayCompletedRequirementIds?: readonly string[];
  cloudflareCompletedRequirementIds?: readonly string[];
}

export interface ProvisioningReadinessReport {
  ready: boolean;
  status: ProvisioningReadinessStatus;
  requiredProviderIds: readonly ProvisioningProviderId[];
  missingProviderIds: readonly ProvisioningProviderId[];
  missingRequirementIdsByProvider: Record<ProvisioningProviderId, readonly string[]>;
  publicTitle: string;
  publicSummary: string;
  nextActionLabel: string;
}

export const SIDEKICK_LIVE_PROVIDER_REQUIREMENTS: Record<LiveProviderId, readonly LiveProviderRequirement[]> = {
  google: [
    { id: 'supabase_project_ready', label: 'Project is ready', kind: 'setup' },
    { id: 'google_provider_enabled', label: 'Google sign-in is enabled', kind: 'setup' },
    { id: 'public_mobile_values_saved', label: 'Mobile sign-in values are saved', kind: 'setup' },
  ],
  telegram: [
    { id: 'bot_name', label: 'Bot name is chosen', kind: 'account' },
    { id: 'bot_token_saved', label: 'Bot access is saved safely', kind: 'server_secret' },
    { id: 'webhook_url_ready', label: 'Telegram handoff route is ready', kind: 'setup' },
  ],
  stripe: [
    { id: 'account_ready', label: 'Stripe account is ready', kind: 'account' },
    { id: 'products_ready', label: 'Plans are created', kind: 'setup' },
    { id: 'server_keys_saved', label: 'Billing access is saved safely', kind: 'server_secret' },
    { id: 'webhook_secret_saved', label: 'Webhook verification is saved safely', kind: 'server_secret' },
  ],
  whatsapp: [
    { id: 'business_account_ready', label: 'Business account is ready', kind: 'account' },
    { id: 'phone_number_ready', label: 'Phone number is connected', kind: 'setup' },
    { id: 'webhook_ready', label: 'Message handoff route is ready', kind: 'setup' },
  ],
  cloudflare: [
    { id: 'account_ready', label: 'Cloud account is ready', kind: 'account' },
    { id: 'route_ready', label: 'Route is ready', kind: 'setup' },
    { id: 'server_keys_saved', label: 'Access is saved safely', kind: 'server_secret' },
  ],
  railway: [
    { id: 'account_ready', label: 'Railway account is ready', kind: 'account' },
    { id: 'project_ready', label: 'Project is ready', kind: 'setup' },
    { id: 'server_keys_saved', label: 'Access is saved safely', kind: 'server_secret' },
  ],
  signal: [
    { id: 'feasibility_approved', label: 'Signal route is approved', kind: 'decision' },
    { id: 'account_ready', label: 'Signal account is ready', kind: 'account' },
  ],
};

function liveProviderName(providerId: LiveProviderId): string {
  const names: Record<LiveProviderId, string> = {
    google: 'Google sign-in',
    telegram: 'Telegram',
    stripe: 'Stripe',
    whatsapp: 'WhatsApp',
    cloudflare: 'Model access',
    railway: 'Coworker workspace',
    signal: 'Signal',
  };
  return names[providerId];
}

export function resolveLiveProviderReadiness(providerId: LiveProviderId, completedRequirementIds: readonly string[] = []): LiveProviderReadiness {
  const requirements = SIDEKICK_LIVE_PROVIDER_REQUIREMENTS[providerId];
  const completed = new Set(completedRequirementIds);
  const requirementIds = requirements.map((requirement) => requirement.id);
  const missingRequirementIds = requirementIds.filter((id) => !completed.has(id));
  const ready = missingRequirementIds.length === 0;
  const providerName = liveProviderName(providerId);

  return {
    providerId,
    providerName,
    ready,
    requirementIds,
    missingRequirementIds,
    publicSummary: ready
      ? `${providerName} is ready for a live test.`
      : `${providerName} is not live yet. A few setup steps still need finishing.`,
  };
}

const SIDEKICK_PROVISIONING_PROVIDER_IDS = ['railway', 'cloudflare'] as const satisfies readonly ProvisioningProviderId[];

export function resolveProvisioningReadiness(input: ProvisioningReadinessInput = {}): ProvisioningReadinessReport {
  const readinessByProvider: Record<ProvisioningProviderId, LiveProviderReadiness> = {
    railway: resolveLiveProviderReadiness('railway', input.railwayCompletedRequirementIds ?? []),
    cloudflare: resolveLiveProviderReadiness('cloudflare', input.cloudflareCompletedRequirementIds ?? []),
  };
  const missingProviderIds = SIDEKICK_PROVISIONING_PROVIDER_IDS.filter((providerId) => !readinessByProvider[providerId].ready);
  const ready = missingProviderIds.length === 0;

  return {
    ready,
    status: ready ? 'ready' : 'blocked',
    requiredProviderIds: SIDEKICK_PROVISIONING_PROVIDER_IDS,
    missingProviderIds,
    missingRequirementIdsByProvider: {
      railway: readinessByProvider.railway.missingRequirementIds,
      cloudflare: readinessByProvider.cloudflare.missingRequirementIds,
    },
    publicTitle: ready ? 'Ready to set up your coworker' : 'Setup is waiting',
    publicSummary: ready
      ? "Your coworker's cloud computer is ready to start."
      : "Some setup is still needed before your coworker can come online.",
    nextActionLabel: ready ? 'Set up your coworker' : 'Finish setup',
  };
}

export interface Artifact {
  id: string;
  userId: string;
  title: string;
  kind: string;
  detail: string;
  status: ArtifactStatus;
  createdAt: string;
  updatedAt?: string;
  storagePath?: string;
  viewerUrl?: string;
}

export interface TaskRun {
  id: string;
  userId: string;
  status: TaskRunStatus;
  instruction: string;
  messageId?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface ProvisioningEvent {
  id: string;
  userId: string;
  event: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface ProductGate {
  kind: ProductGateKind;
  label: string;
  tone: GateTone;
  detail?: string;
}

export interface SidekickProductSnapshot {
  profile: Profile | null;
  acknowledgement: Acknowledgement | null;
  subscription: Subscription | null;
  hermesInstance: PublicHermesInstance | null;
  usage: UsageSummary;
  connections: readonly GatewayConnection[];
  artifacts: readonly Artifact[];
  recentTasks: readonly TaskRun[];
  latestAssistantMessage: ChatMessage | null;
  queueCount: number;
}

export interface MyProductStateRow {
  user_id: string;
  email: string;
  full_name: string | null;
  agent_name: string | null;
  avatar_url: string | null;
  region: string | null;
  profile_created_at: string;
  profile_updated_at: string | null;
  acknowledgement_accepted: boolean;
  acknowledgement_accepted_at: string | null;
  acknowledgement_text_version: string | null;
  subscription_status: SubscriptionStatus | null;
  tier_id: PlanTierId | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  // Added by migration 0055. OPTIONAL on the row type on purpose: a client
  // reading a database that has not had 0055 applied yet must degrade to
  // "unknown provider" rather than crash, and unknown is treated as
  // not-Apple, which is the safe direction.
  billing_provider?: BillingProvider | null;
  service_access_until?: string | null;
  worker_status: HermesInstanceStatus | null;
  last_health_at: string | null;
  ready_at: string | null;
  error_code: string | null;
  public_status_message: string | null;
  volume_retention_until?: string | null;
  suspended_at?: string | null;
  deleted_at?: string | null;
  coworker_update_available?: boolean | null;
  coworker_update_status?: CoworkerUpdateStatus | null;
  reimage_requested_at?: string | null;
  reimaged_at?: string | null;
  monthly_token_quota: number | null;
  used_tokens: number | null;
  remaining_tokens: number | null;
  usage_ratio: number | null;
  usage_near_limit: boolean | null;
  usage_hard_limited: boolean | null;
  queue_count: number | null;
  telegram_connected?: boolean | null;
  active_gateway_id?: string | null;
  active_gateway_connected_at?: string | null;
  messaging_provider_connections?: unknown;
  gate_kind: ProductGateKind;
}

export type SupabaseConfigIssue = 'missing_url' | 'invalid_url' | 'missing_anon_key' | 'service_role_key';

export interface PublicSupabaseConfigInput {
  supabaseUrl?: string | null;
  supabaseAnonKey?: string | null;
  redirectTo?: string | null;
}

export interface PublicSupabaseConfig {
  url: string;
  anonKey: string;
  redirectTo: string;
  projectRef: string;
}

export type PublicSupabaseConfigResult =
  | { ready: true; config: PublicSupabaseConfig; issues: readonly [] }
  | { ready: false; config: null; issues: SupabaseConfigIssue[]; helpText: string };

export const DEFAULT_SUPABASE_AUTH_CALLBACK = 'sidekick://auth/callback';
export const AUTH_PROVIDER_GOOGLE = 'google';
export const AUTH_PROVIDER_APPLE = 'apple';
export const AUTH_PROVIDER_EMAIL = 'email';
export const AUTH_PROVIDER_PHONE = 'phone';

export type AuthProvider =
  | typeof AUTH_PROVIDER_GOOGLE
  | typeof AUTH_PROVIDER_APPLE
  | typeof AUTH_PROVIDER_EMAIL
  | typeof AUTH_PROVIDER_PHONE;
export type AuthSessionStatus = 'loading' | 'signed_out' | 'authenticated' | 'error';
export type AuthSessionErrorCode =
  | 'oauth_cancelled'
  | 'oauth_failed'
  | 'email_otp_invalid'
  | 'email_otp_failed'
  | 'phone_otp_invalid'
  | 'phone_otp_failed'
  | 'session_restore_failed'
  | 'session_expired'
  | 'missing_config'
  | 'unknown'
  | (string & {});

export interface PublicAuthUserIdentity {
  id: string;
  email?: string;
  phoneMasked?: string;
  fullName?: string;
  avatarUrl?: string;
}

export interface PublicAuthSession {
  provider: AuthProvider;
  user: PublicAuthUserIdentity;
  issuedAt?: string;
  expiresAt?: string;
}

export interface AuthSessionError {
  code: AuthSessionErrorCode;
  message: string;
  recoverable: true;
  provider?: AuthProvider;
}

export interface ResolveAuthSessionStateInput {
  supabaseConfig: PublicSupabaseConfigResult;
  session?: PublicAuthSession | null;
  restoring?: boolean;
  loading?: boolean;
  error?: AuthSessionError | null;
}

interface AuthSessionStateBase {
  provider: AuthProvider;
  supabaseReady: boolean;
  supabaseProjectRef?: string;
  configIssues: readonly SupabaseConfigIssue[];
}

export type AuthSessionState =
  | (AuthSessionStateBase & {
      status: 'loading';
      user: null;
      session: null;
      canStartOAuth: false;
      canStartEmailOtp: false;
      canStartPhoneOtp: false;
      oauthRedirectTo: null;
      error: null;
    })
  | (AuthSessionStateBase & {
      status: 'signed_out';
      user: null;
      session: null;
      canStartOAuth: boolean;
      canStartEmailOtp: boolean;
      canStartPhoneOtp: boolean;
      oauthRedirectTo: string | null;
      error: null;
    })
  | (AuthSessionStateBase & {
      status: 'authenticated';
      user: PublicAuthUserIdentity;
      session: PublicAuthSession;
      canStartOAuth: false;
      canStartEmailOtp: false;
      canStartPhoneOtp: false;
      oauthRedirectTo: null;
      error: null;
    })
  | (AuthSessionStateBase & {
      status: 'error';
      user: null;
      session: null;
      canStartOAuth: false;
      canStartEmailOtp: false;
      canStartPhoneOtp: false;
      oauthRedirectTo: null;
      error: AuthSessionError;
    });

export const ACKNOWLEDGEMENT_VERSION = 'v2';
export const ACKNOWLEDGEMENT_TEXT =
  'Your coworker works from your instructions, the files you share, and any scoped details you choose to provide. By continuing, you agree to review their work, use your own judgement, and stay responsible for the tasks you give them.';

// The Hermes Agent engine version the platform currently provisions runners
// with. Keep in lockstep with the published golden image
// (SIDEKICK_FLY_RUNNER_IMAGE_REF) when a new image ships. Surfaced read-only in
// Profile ("Coworker engine") and referenced by the updates FAQ. Public,
// non-secret — safe to embed in the app + website.
export const RUNNER_ENGINE_VERSION = 'v2026.5.7';

/**
 * True when the platform has flagged a newer coworker engine build as available
 * for this runner and it isn't already mid-update. Drives the Profile
 * "Update available" badge + button. The comparison itself happens server-side
 * (the provisioner cron compares the runner's pinned image digest to the latest
 * vetted image); the client only trusts the resulting flag.
 */
export function isCoworkerUpdateAvailable(instance: PublicHermesInstance | null | undefined): boolean {
  return !!instance && instance.coworkerUpdateAvailable === true && instance.coworkerUpdateStatus !== 'updating';
}

/** True while a user-triggered re-image is in flight. */
export function isCoworkerUpdating(instance: PublicHermesInstance | null | undefined): boolean {
  return !!instance && instance.coworkerUpdateStatus === 'updating';
}

// 2026-09-07 price cut: Studio £30 -> £9.99, Pro Office £75 -> £24.99,
// Enterprise Suite £150 -> £59.99. Alex's call: customers over margin while
// the business is being sold. Runners now sleep between sessions, so a typical
// Studio user costs ~£1.40/month and a heavy one ~£5.70, and £9.99 still
// clears a heavy user by ~£4. Stripe prices carry the same lookup keys
// (transferred 2026-09-07), the Apple base prices follow, and the launch promo
// became 70% off the first 2 months, so Studio's intro is £2.99 (fixed-amount coupons per tier).
export const SIDEKICK_PLAN_TIERS: readonly PlanTier[] = [
  {
    id: 'studio',
    shortName: 'Studio',
    name: 'Studio',
    // 2026-09-07: £30 -> £9.99. Rationale above SIDEKICK_PLAN_TIERS.
    priceGbpMonthly: 9.99,
    // Cost-proportional quota (COST_MODEL 2026-06-05): a full burn costs us AT MOST
    // ~£11.5/mo of Kimi K2.6 -- a hard ceiling for any in/out mix (output weighted
    // x4.7). History: 8M -> 17M (2026-06-05, ~£10 ceiling) -> 19.55M (2026-07-14,
    // +15% per Alex after a paying Studio user ran dry mid-month; margin per
    // COST_MODEL Scenario C stays comfortable).
    monthlyTokenQuota: 19_550_000,
    storageGb: 10,
    voiceSecondsQuota: 3_600,
    stripePriceLookupKey: 'sidekick_studio_monthly',
    summary: 'An AI coworker for your daily admin. Drafts, forms, and the everyday back-and-forth.',
    capacityNote: 'Room for around 460 involved tasks a month, or thousands of quick questions.',
    inferenceNote: 'Around 19.5 million tokens of thinking a month, roughly 460 involved tasks or thousands of quick questions.',
    features: [
      'Daily admin, drafts, and quick research',
      'Private cloud space that grows with your plan',
      'Filing, summaries, and replies in your tone',
    ],
  },
  {
    id: 'pro-office',
    shortName: 'Pro',
    name: 'Pro',
    // R-UX-04 / Pro Office is the most-chosen plan; the ribbon tag is
    // surfaced via this `ribbon` property so any rendering surface can
    // display "Most chosen" without hardcoded copy. Kept high in the block
    // so growing descriptive copy below cannot displace the tag.
    ribbon: 'Most chosen',
    isMostChosen: true,
    priceGbpMonthly: 24.99,
    // Cost-proportional quota: full burn costs AT MOST ~£28/mo. Raised 34M -> 48M
    // 2026-07-19 (old caps shrank up-tier so higher payers got the least compute;
    // re-levelled to ~Studio's 38% cost/price ratio; ~63% margin). See COST_MODEL.md.
    monthlyTokenQuota: 48_000_000,
    storageGb: 40,
    voiceSecondsQuota: 10_800,
    stripePriceLookupKey: 'sidekick_pro_office_monthly',
    capacityNote: 'Room for around 800 involved tasks a month, with plenty left for quick questions.',
    inferenceNote: 'Around 48 million tokens of thinking a month, roughly 800 involved tasks with plenty left for quick questions.',
    summary: 'An AI coworker for most of your working week. Ongoing tasks, follow-ups, and bigger jobs.',
    features: [
      'Most of your working week, handled',
      'Private cloud space that grows with your plan',
      'Repeatable workflows, invoice chasing, meeting prep',
    ],
  },
  {
    id: 'enterprise-suite',
    shortName: 'Max',
    name: 'Max',
    priceGbpMonthly: 59.99,
    // Cost-proportional quota: full burn costs AT MOST ~£59/mo. Raised 51M -> 100M
    // 2026-07-19: Max was the worst compute-per-pound (~20% of £150) and a live Max
    // user was locking out mid-period; re-levelled to ~38%, ~61% margin. Durable fix
    // = tuning Hermes compression (docs/CHAT_MEMORY_ARCHITECTURE.md).
    monthlyTokenQuota: 100_000_000,
    storageGb: 100,
    voiceSecondsQuota: 36_000,
    stripePriceLookupKey: 'sidekick_enterprise_suite_monthly',
    summary: 'An AI coworker for a heavy back office. Bookkeeping, chasing, and multi-step work at volume.',
    capacityNote: 'Room for around 1200 involved tasks a month, for the heaviest workloads.',
    inferenceNote: 'Around 100 million tokens of thinking a month, roughly 1,200 involved tasks for the heaviest workloads.',
    features: [
      'Full-week capacity for bigger workloads',
      'Private cloud space that grows with your plan',
      'Bookkeeping, secretary help, multi-step jobs',
    ],
  },
] as const;

export function getPlanTier(id: PlanTierId): PlanTier {
  const tier = SIDEKICK_PLAN_TIERS.find((candidate) => candidate.id === id);
  if (!tier) throw new Error(`Unknown Delegent AI plan tier: ${id}`);
  return tier;
}

/**
 * Rank of a plan tier by capacity/price, from the canonical SIDEKICK_PLAN_TIERS
 * order: studio (0) < pro-office (1) < enterprise-suite (2). Higher rank = more
 * expensive / more capacity. Used to tell an upgrade (rank goes up, applies
 * immediately) from a downgrade (rank goes down, scheduled for the next renewal
 * so a paid tier is never shrunk mid-cycle). See docs/BILLING (downgrade timing).
 */
export function getPlanTierRank(id: PlanTierId): number {
  const rank = SIDEKICK_PLAN_TIERS.findIndex((candidate) => candidate.id === id);
  if (rank === -1) throw new Error(`Unknown Delegent AI plan tier: ${id}`);
  return rank;
}

/**
 * Launch promotion: a discount on the first two months of every tier (half
 * price from 2026-07-24, 70% off from the 2026-09-07 price cut). The
 * struck-through full price plus this badge are shown at the plan picker and
 * the website; the ACTUAL discount is applied by a Stripe coupon carrying the
 * same promise, so the displayed price and the charged price can never diverge.
 *
 * `stripeCouponId` is empty until the live coupon exists. `isLaunchPromoLive`
 * gates every promo surface on it, so we never advertise a discount that would
 * not actually be charged: ship this inert, create the coupon, set the id, and
 * the promo lights up everywhere at once.
 */
/** Staged until Stripe, StoreKit, paywalls and marketing agree on the offer. */
export const SIDEKICK_FREE_TRIAL = {
  enabled: true,
  days: 3 as const,
  offerId: 'three_day_trial_2026_09',
};

export function freeTrialTermsLine(tier: PlanTier): string {
  return `${SIDEKICK_FREE_TRIAL.days} days free, then ${formatGbp(tier.priceGbpMonthly)} per month automatically. Cancel before the trial ends to avoid being charged. New subscribers only.`;
}

export function shouldQuoteFreeTrial(
  subscription: Pick<Subscription, 'status' | 'currentPeriodEnd'> | null | undefined,
): boolean {
  return SIDEKICK_FREE_TRIAL.enabled && subscription?.status === 'inactive' && !subscription.currentPeriodEnd;
}

export interface LaunchPromo {
  percentOff: number;
  durationMonths: number;
  /** Short chip shown above/near the price, e.g. "70% off for 2 months". */
  badge: string;
  /** One-line explainer, e.g. "70% off your first 2 months, then the usual price". */
  headline: string;
  /** Stripe coupon id (duration=repeating, duration_in_months, percent_off). Empty until created. */
  stripeCouponId: string;
  /**
   * The EXACT percent the Stripe coupon carries, which may differ from the
   * headline `percentOff` by hundredths. Stripe rounds the discount to the
   * nearest penny, so 70% of £9.99 charges £3.00 while the adverts say £2.99;
   * 70.03% charges exactly £2.99 (999 x 0.7003 = 699.6 -> 700 off). The
   * displayed promo price is derived from this same number with the same
   * rounding, so the card and the charge can never differ by a penny.
   */
  stripeCouponPercentOff: number;
  /** Optional per-tier coupon override; unused since 2026-09-08. Falls back to `stripeCouponId`. */
  stripeCouponIdByTier?: Partial<Record<PlanTierId, string>>;
}

export const SIDEKICK_LAUNCH_PROMO: LaunchPromo = {
  // 2026-09-07: 50% -> 70% with the price cut. Alex wants the intro to READ
  // £2.99. The evening of 2026-09-07 did that with one AMOUNT-OFF coupon per
  // tier (£7 / £17.50 / £42 off), but a fixed amount lives on the subscription
  // and is the wrong amount once the customer changes tier inside the promo
  // window (Studio's £7 off on Pro charged £17.99, Pro's £17.50 off on Studio
  // charged £0). 2026-09-08, Alex's call: ONE percent coupon at 70.03%, which
  // Stripe proved live to charge 2.99 / 7.49 / 17.98 and which carries across
  // any tier change exactly by construction. percentOff stays the headline.
  percentOff: 70,
  stripeCouponPercentOff: 70.03,
  durationMonths: 2,
  badge: '70% off for 2 months',
  headline: '70% off your first 2 months, then the usual monthly price. Cancel anytime.',
  // Live Stripe coupon (percent_off=70.03, duration=repeating,
  // duration_in_months=2), created 2026-09-08. The old
  // delegent_launch_half_price_2mo (50%) stays valid on the subscriptions
  // still inside their promo months. Setting this flips isLaunchPromoLive()
  // true, so the promo lights up in the app and checkout auto-applies it.
  stripeCouponId: 'delegent_launch_7003_2mo',
};

/** Whether the promo is safe to advertise (a real Stripe coupon backs it). */
export function isLaunchPromoLive(promo: LaunchPromo = SIDEKICK_LAUNCH_PROMO): boolean {
  return promo.percentOff > 0 && promo.durationMonths > 0 && promo.stripeCouponId.trim().length > 0;
}

/**
 * The discounted monthly price for a tier under the promo: the tier price less
 * the coupon's percent, rounded to the nearest penny exactly as Stripe rounds
 * it (verified live 2026-09-08: 9.99 -> 2.99, 24.99 -> 7.49, 59.99 -> 17.98).
 */
export function promoPriceGbpMonthly(tier: PlanTier, promo: LaunchPromo = SIDEKICK_LAUNCH_PROMO): number {
  const pricePence = Math.round(tier.priceGbpMonthly * 100);
  const offPence = Math.round(pricePence * (promo.stripeCouponPercentOff / 100));
  return (pricePence - offPence) / 100;
}

/** The Stripe coupon to apply at checkout for a tier. */
export function launchPromoCouponIdForTier(tierId: PlanTierId, promo: LaunchPromo = SIDEKICK_LAUNCH_PROMO): string {
  return promo.stripeCouponIdByTier?.[tierId] ?? promo.stripeCouponId;
}

/** Format a GBP amount for display: "£15" (whole) or "£37.50" (with pence). */
export function formatGbp(amount: number): string {
  return '£' + (Number.isInteger(amount) ? String(amount) : amount.toFixed(2));
}

/**
 * Promo terms naming the exact price the discount reverts to. `headline` says
 * "then the usual monthly price", which is too vague for the payment page: the
 * user must be told they will be billed £24.99 from month 3 before they pay.
 */
export function launchPromoTermsLine(tier: PlanTier, promo: LaunchPromo = SIDEKICK_LAUNCH_PROMO): string {
  const months = promo.durationMonths === 1 ? 'first month' : `first ${promo.durationMonths} months`;
  const ordinal = promo.durationMonths + 1;
  return (
    `${promo.percentOff}% off your ${months}. ` +
    `From month ${ordinal} you are billed the standard ${formatGbp(tier.priceGbpMonthly)} per month automatically. ` +
    'Cancel anytime.'
  );
}

/**
 * Whether the promo price is the price THIS reader would actually be charged.
 *
 * The server asks the same question with better information: checkout refuses
 * the coupon to any customer Stripe has ever really billed
 * (customerHasStripeSubscriptionHistory in the billing package), and a portal
 * tier change never applies it at all. The client cannot see the server's
 * answer, and quoting half price to someone the server will charge in full is
 * the page promising less than Stripe's confirm screen takes.
 *
 * So the discount is only quoted to a reader Stripe has never seen. Status alone
 * cannot tell you that: a customer who subscribed, cancelled and lapsed reads as
 * 'inactive', exactly like someone who has never paid, so the plan page offered a
 * returning customer half price and Stripe then charged him in full (2026-07-30,
 * reported on his own account). A billing period is the honest signal, because
 * only a real Stripe subscription ever sets one, and it survives the plan
 * lapsing. Nothing here needs the customer id, which must not reach a client.
 *
 * Being quoted the standard price when the coupon does land is the harmless
 * direction to be wrong in, so an unknown case falls that way.
 */
export function shouldQuotePromoPrice(
  subscription: Pick<Subscription, 'status' | 'currentPeriodEnd'> | null | undefined,
  promo: LaunchPromo = SIDEKICK_LAUNCH_PROMO,
): boolean {
  if (SIDEKICK_FREE_TRIAL.enabled) return false;
  if (!isLaunchPromoLive(promo)) return false;
  if ((subscription?.status ?? 'inactive') !== 'inactive') return false;
  return !subscription?.currentPeriodEnd;
}

/**
 * What an existing subscriber is told instead. A discount lives on the
 * subscription rather than the price, so months still owed survive a plan
 * change; this says so without promising a discount to someone who has spent it.
 */
export const LAUNCH_PROMO_CARRY_OVER_LINE =
  'Any launch-offer months you have left carry across to your new plan.';

/** Plain "millions" label for a tier's monthly inference allowance, e.g. "19.5 million". */
export function tokenAllowanceMillions(tier: PlanTier): string {
  const millions = tier.monthlyTokenQuota / 1_000_000;
  const rounded = Math.round(millions * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

/** True when moving from `current` to `target` LOWERS the tier (a downgrade). */
export function isPlanDowngrade(current: PlanTierId, target: PlanTierId): boolean {
  return getPlanTierRank(target) < getPlanTierRank(current);
}

/** True when moving from `current` to `target` RAISES the tier (an upgrade). */
export function isPlanUpgrade(current: PlanTierId, target: PlanTierId): boolean {
  return getPlanTierRank(target) > getPlanTierRank(current);
}

function decodeBase64UrlAscii(segment: string): string | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/g, '');
  let buffer = 0;
  let bits = 0;
  let output = '';

  for (const character of normalized) {
    const value = alphabet.indexOf(character);
    if (value === -1) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }

  return output;
}

function jwtPayloadRole(token: string): string | null {
  const [, payload] = token.split('.');
  if (!payload) return null;

  const decoded = decodeBase64UrlAscii(payload);
  if (!decoded) return null;

  try {
    const parsed = JSON.parse(decoded) as { role?: unknown };
    return typeof parsed.role === 'string' ? parsed.role : null;
  } catch {
    return null;
  }
}

function normalizeSupabaseProjectUrl(rawUrl: string): { url: string; projectRef: string } | null {
  try {
    const parsed = new URL(rawUrl.trim());
    const projectRef = parsed.hostname.endsWith('.supabase.co') ? parsed.hostname.slice(0, -'.supabase.co'.length) : '';

    if (
      parsed.protocol !== 'https:' ||
      !projectRef ||
      !/^[a-z0-9-]+$/.test(projectRef) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      return null;
    }

    return { url: `https://${parsed.hostname}`, projectRef };
  } catch {
    return null;
  }
}

export function resolvePublicSupabaseConfig(input: PublicSupabaseConfigInput): PublicSupabaseConfigResult {
  const issues: SupabaseConfigIssue[] = [];
  const rawUrl = input.supabaseUrl?.trim() ?? '';
  const anonKey = input.supabaseAnonKey?.trim() ?? '';
  const normalizedUrl = rawUrl ? normalizeSupabaseProjectUrl(rawUrl) : null;

  if (!rawUrl) {
    issues.push('missing_url');
  } else if (!normalizedUrl) {
    issues.push('invalid_url');
  }

  if (!anonKey) {
    issues.push('missing_anon_key');
  } else if (jwtPayloadRole(anonKey) === 'service_role') {
    issues.push('service_role_key');
  }

  if (issues.length > 0 || !normalizedUrl) {
    return {
      ready: false,
      config: null,
      issues,
      helpText:
        'Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to enable Google, email code, or phone sign-in. Use the Supabase anon/public key only; never put a service-role key in the mobile app.',
    };
  }

  return {
    ready: true,
    config: {
      url: normalizedUrl.url,
      anonKey,
      projectRef: normalizedUrl.projectRef,
      redirectTo: input.redirectTo?.trim() || DEFAULT_SUPABASE_AUTH_CALLBACK,
    },
    issues: [],
  };
}

export function normalizeE164PhoneNumber(input: string): string {
  const normalized = input.trim().replace(/[\s().-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error('Phone number must be in E.164 format, for example +447700900123.');
  }

  return normalized;
}

export function maskE164PhoneNumber(input: string): string {
  const normalized = normalizeE164PhoneNumber(input);
  return `•••• ${normalized.slice(-4)}`;
}

export function normalizeEmailAddress(input: string): string {
  const normalized = input.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('Email sign-in needs a valid email address.');
  }

  return normalized;
}

export function normalizeOtpCode(input: string, expectedLength: 6 | 8 = 6): string {
  const normalized = input.trim().replace(/\s/g, '');
  const codeLength = expectedLength === 8 ? 8 : 6;
  const codePattern = codeLength === 8 ? /^\d{8}$/ : /^\d{6}$/;
  if (!codePattern.test(normalized)) {
    const lengthName = codeLength === 8 ? 'an eight-digit' : 'a six-digit';
    throw new Error(`Sign-in code must be ${lengthName} code.`);
  }

  return normalized;
}

function sanitizeAuthProvider(provider: AuthProvider | undefined): AuthProvider {
  if (provider === AUTH_PROVIDER_PHONE) return AUTH_PROVIDER_PHONE;
  if (provider === AUTH_PROVIDER_EMAIL) return AUTH_PROVIDER_EMAIL;
  if (provider === AUTH_PROVIDER_APPLE) return AUTH_PROVIDER_APPLE;
  return AUTH_PROVIDER_GOOGLE;
}

function publicAuthUserIdentity(user: PublicAuthUserIdentity): PublicAuthUserIdentity {
  const identity: PublicAuthUserIdentity = {
    id: user.id,
  };

  if (user.email !== undefined && user.email.trim().length > 0) identity.email = user.email.trim();
  const phoneMasked = user.phoneMasked?.trim();
  if (phoneMasked && /^•••• \d{4}$/.test(phoneMasked)) identity.phoneMasked = phoneMasked;
  if (user.fullName !== undefined) identity.fullName = user.fullName;
  if (user.avatarUrl !== undefined) identity.avatarUrl = user.avatarUrl;

  return identity;
}

function publicAuthSession(session: PublicAuthSession): PublicAuthSession {
  const publicSession: PublicAuthSession = {
    provider: sanitizeAuthProvider(session.provider),
    user: publicAuthUserIdentity(session.user),
  };

  if (session.issuedAt !== undefined) publicSession.issuedAt = session.issuedAt;
  if (session.expiresAt !== undefined) publicSession.expiresAt = session.expiresAt;

  return publicSession;
}

function publicAuthSessionError(error: AuthSessionError): AuthSessionError {
  return {
    code: error.code,
    message: error.message,
    recoverable: true,
    provider: sanitizeAuthProvider(error.provider),
  };
}

export function resolveAuthSessionState(input: ResolveAuthSessionStateInput): AuthSessionState {
  const supabaseReady = input.supabaseConfig.ready;
  const provider = sanitizeAuthProvider(input.error?.provider ?? input.session?.provider);
  const base: AuthSessionStateBase = {
    provider,
    supabaseReady,
    supabaseProjectRef: supabaseReady ? input.supabaseConfig.config.projectRef : undefined,
    configIssues: supabaseReady ? [] : input.supabaseConfig.issues,
  };

  if (input.restoring || input.loading) {
    return {
      ...base,
      status: 'loading',
      user: null,
      session: null,
      canStartOAuth: false,
      canStartEmailOtp: false,
      canStartPhoneOtp: false,
      oauthRedirectTo: null,
      error: null,
    };
  }

  if (input.error) {
    return {
      ...base,
      status: 'error',
      user: null,
      session: null,
      canStartOAuth: false,
      canStartEmailOtp: false,
      canStartPhoneOtp: false,
      oauthRedirectTo: null,
      error: publicAuthSessionError(input.error),
    };
  }

  if (!supabaseReady) {
    return {
      ...base,
      status: 'signed_out',
      user: null,
      session: null,
      canStartOAuth: false,
      canStartEmailOtp: false,
      canStartPhoneOtp: false,
      oauthRedirectTo: null,
      error: null,
    };
  }

  if (input.session) {
    const session = publicAuthSession(input.session);
    return {
      ...base,
      status: 'authenticated',
      user: session.user,
      session,
      canStartOAuth: false,
      canStartEmailOtp: false,
      canStartPhoneOtp: false,
      oauthRedirectTo: null,
      error: null,
    };
  }

  return {
    ...base,
    status: 'signed_out',
    user: null,
    session: null,
    canStartOAuth: true,
    canStartEmailOtp: true,
    canStartPhoneOtp: true,
    oauthRedirectTo: input.supabaseConfig.config.redirectTo || DEFAULT_SUPABASE_AUTH_CALLBACK,
    error: null,
  };
}

export function isCurrentAcknowledgement(acknowledgement: Acknowledgement | null | undefined): boolean {
  return acknowledgement?.textVersion === ACKNOWLEDGEMENT_VERSION;
}

/**
 * The three statuses that mean the reader currently has a plan. Exposed at the
 * status level as well as the object level because the plan card only has the
 * status to hand, and it had been asking `status !== 'inactive'` instead, which
 * counts a cancelled subscription as a live one.
 */
export function isEntitledSubscriptionStatus(status: SubscriptionStatus | null | undefined): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

export function isSubscriptionEntitled(subscription: Subscription | null | undefined): boolean {
  return subscriptionAccessAllowed(subscription?.status, subscription?.currentPeriodEnd, Date.now(),
    subscription?.billingProvider, subscription?.serviceAccessUntil);
}

/** Apple service ends at its verified deadline, including an explicit grace period. */
export function subscriptionAccessAllowed(
  status: string | null | undefined,
  currentPeriodEnd: string | null | undefined,
  nowMs: number = Date.now(),
  billingProvider?: string | null,
  serviceAccessUntil?: string | null,
): boolean {
  if (billingProvider === 'apple') {
    const end = typeof serviceAccessUntil === 'string' ? Date.parse(serviceAccessUntil) : NaN;
    return (status === 'active' || status === 'trialing' || status === 'past_due')
      && Number.isFinite(end) && end > nowMs;
  }
  if (status === 'trialing') {
    const end = typeof currentPeriodEnd === 'string' ? Date.parse(currentPeriodEnd) : NaN;
    return Number.isFinite(end) && end > nowMs;
  }
  return status === 'active' || status === 'past_due';
}

export function publicHermesInstance(instance: HermesInstance | PublicHermesInstance | null | undefined): PublicHermesInstance | null {
  if (!instance) return null;
  return {
    userId: instance.userId,
    status: instance.status,
    lastHealthAt: instance.lastHealthAt,
    readyAt: instance.readyAt,
    errorCode: instance.errorCode,
    publicStatusMessage: instance.publicStatusMessage,
    suspendedAt: instance.suspendedAt,
    volumeRetentionUntil: instance.volumeRetentionUntil,
    deletedAt: instance.deletedAt,
    coworkerUpdateAvailable: instance.coworkerUpdateAvailable,
    coworkerUpdateStatus: instance.coworkerUpdateStatus,
    reimageRequestedAt: instance.reimageRequestedAt,
    reimagedAt: instance.reimagedAt,
    updatedAt: instance.updatedAt,
  };
}

export function buildUsageSummary(events: readonly TokenUsageEvent[], quota: UsageQuota): UsageSummary {
  const usedTokens = events.reduce((sum, event) => sum + Math.max(0, event.totalTokens), 0);
  const quotaTokens = Math.max(0, quota.monthlyTokenQuota);
  // When quotaTokens === 0 the row is unconfigured (e.g. webhook hasn't
  // populated usage_quotas yet for a newly-active sub). We must NOT
  // treat that as "instantly hard-limited the moment any token is
  // used" — that bug locked Alex out of chat after his first message
  // on 2026-05-20. An unconfigured quota means "no limit known"; the
  // safe default is unlimited / unmetered, not zero.
  const quotaUnconfigured = quotaTokens === 0;
  const ratio = quotaUnconfigured ? 0 : usedTokens / quotaTokens;
  const remainingTokens = Math.max(0, quotaTokens - usedTokens);

  return {
    usedTokens,
    quotaTokens,
    remainingTokens,
    ratio,
    nearLimit: !quotaUnconfigured && ratio >= 0.8,
    hardLimited: !quotaUnconfigured && usedTokens >= quotaTokens,
  };
}

export function mapMyProductStateRow(
  row: MyProductStateRow,
  extras: {
    connections?: readonly GatewayConnection[];
    artifacts?: readonly Artifact[];
    recentTasks?: readonly TaskRun[];
    latestAssistantMessage?: ChatMessage | null;
  } = {},
): SidekickProductSnapshot {
  const usedTokens = Math.max(0, row.used_tokens ?? 0);
  const quotaTokens = Math.max(0, row.monthly_token_quota ?? 0);
  const quotaUnconfigured = quotaTokens === 0;
  const ratio = quotaUnconfigured ? 0 : (row.usage_ratio ?? usedTokens / quotaTokens);
  const remainingTokens = Math.max(0, row.remaining_tokens ?? quotaTokens - usedTokens);
  const parsedMessagingRecords = normalizeMessagingProviderConnectionRecords(row.messaging_provider_connections);
  const activeGatewayRecord: MessagingProviderConnectionRecord[] = isMessagingProviderId(row.active_gateway_id)
    ? [{ providerId: row.active_gateway_id, status: 'connected', connectedAt: row.active_gateway_connected_at ?? undefined }]
    : [];
  const legacyTelegramRecord: MessagingProviderConnectionRecord[] = row.telegram_connected
    ? [{ providerId: 'telegram', status: 'connected' }]
    : [];
  const messagingProviderRecords = parsedMessagingRecords.some((record) => record.status === 'connected')
    ? parsedMessagingRecords
    : [...parsedMessagingRecords, ...activeGatewayRecord, ...(activeGatewayRecord.length === 0 ? legacyTelegramRecord : [])];

  return {
    profile: {
      id: row.user_id,
      email: row.email,
      fullName: row.full_name ?? undefined,
      agentName: row.agent_name ?? undefined,
      avatarUrl: row.avatar_url ?? undefined,
      region: row.region ?? undefined,
      createdAt: row.profile_created_at,
      updatedAt: row.profile_updated_at ?? undefined,
    },
    acknowledgement: row.acknowledgement_accepted && row.acknowledgement_accepted_at && row.acknowledgement_text_version
      ? {
          userId: row.user_id,
          acceptedAt: row.acknowledgement_accepted_at,
          textVersion: row.acknowledgement_text_version,
        }
      : null,
    subscription: row.subscription_status
      ? {
          userId: row.user_id,
          status: row.subscription_status,
          tierId: row.tier_id ?? undefined,
          currentPeriodStart: row.current_period_start ?? undefined,
          currentPeriodEnd: row.current_period_end ?? undefined,
          serviceAccessUntil: row.service_access_until ?? undefined,
          cancelAtPeriodEnd: row.cancel_at_period_end ?? undefined,
          // Narrowed rather than cast: an unrecognised provider string becomes
          // undefined, which every caller reads as "not provably Apple". A
          // future third provider must therefore be added here deliberately
          // instead of silently inheriting Apple's upgrade path.
          billingProvider: row.billing_provider === 'apple' || row.billing_provider === 'stripe'
            ? row.billing_provider
            : undefined,
        }
      : null,
    hermesInstance: row.worker_status
      ? {
          userId: row.user_id,
          status: row.worker_status,
          lastHealthAt: row.last_health_at ?? undefined,
          readyAt: row.ready_at ?? undefined,
          errorCode: row.error_code ?? undefined,
          publicStatusMessage: row.public_status_message ?? undefined,
          suspendedAt: row.suspended_at ?? undefined,
          volumeRetentionUntil: row.volume_retention_until ?? undefined,
          deletedAt: row.deleted_at ?? undefined,
          coworkerUpdateAvailable: row.coworker_update_available ?? undefined,
          coworkerUpdateStatus: row.coworker_update_status ?? undefined,
          reimageRequestedAt: row.reimage_requested_at ?? undefined,
          reimagedAt: row.reimaged_at ?? undefined,
        }
      : null,
    usage: {
      usedTokens,
      quotaTokens,
      remainingTokens,
      ratio,
      nearLimit: quotaUnconfigured ? false : (row.usage_near_limit ?? ratio >= 0.8),
      hardLimited: quotaUnconfigured ? false : (row.usage_hard_limited ?? usedTokens >= quotaTokens),
    },
    connections: extras.connections ?? resolveMessagingProviderConnections(messagingProviderRecords),
    artifacts: extras.artifacts ?? [],
    recentTasks: extras.recentTasks ?? [],
    latestAssistantMessage: extras.latestAssistantMessage ?? null,
    queueCount: Math.max(0, row.queue_count ?? 0),
  };
}

export function resolveSidekickGate(snapshot: SidekickProductSnapshot, options: { agentEngine?: boolean } = {}): ProductGate {
  if (!snapshot.profile) {
    return { kind: 'signed_out', label: 'Sign in', tone: 'neutral', detail: 'Sign in to set up your coworker.' };
  }

  if (!isCurrentAcknowledgement(snapshot.acknowledgement)) {
    return { kind: 'needs_acknowledgement', label: 'Accept terms', tone: 'neutral', detail: 'Accept the Terms before your coworker can start.' };
  }

  const status = snapshot.hermesInstance?.status ?? 'not_requested';
  const errorCode = snapshot.hermesInstance?.errorCode ?? null;
  const publicStatusMessage = snapshot.hermesInstance?.publicStatusMessage ?? null;
  const volumeRetentionUntil = snapshot.hermesInstance?.volumeRetentionUntil ?? null;

  if (!isSubscriptionEntitled(snapshot.subscription) && status === 'sleeping' && volumeRetentionUntil) {
    return {
      kind: 'workspace_retained',
      label: 'Workspace retained',
      tone: 'warning',
      detail: 'Files stay saved in your private workspace. Choose a plan to resume new chat and task work.',
    };
  }

  if (!isSubscriptionEntitled(snapshot.subscription)) {
    return { kind: 'needs_subscription', label: 'Choose a plan', tone: 'accent', detail: "Pick a plan to set up your coworker's cloud computer." };
  }

  if (snapshot.usage.hardLimited) {
    return { kind: 'hard_limited', label: 'Capacity full', tone: 'warning', detail: 'Monthly capacity is full. Upgrade or wait for next month.' };
  }

  // An assistant account has no workspace to wait for: its assistant is ready
  // the moment the plan is. Without this a new subscriber, who never gets a
  // runner, would sit on "Preparing" for ever (2026-09-15).
  if (options.agentEngine) {
    return { kind: 'ready', label: 'Online', tone: 'live', detail: 'Your coworker is online and ready.' };
  }

  // 2026-05-15 fix: the provisioner records `error_code` + `publicStatusMessage`
  // on the public hermes_instance row when Railway provisioning fails (e.g.
  // capacity exhausted on the free plan, or a reconcile_required handoff
  // after a partial Railway call). The runner row stays at status
  // 'provisioning' or 'queued' while the error_code is set. Without this
  // branch, the UI shows a cheerful "Setting up" indefinitely while the
  // user's account is actually stuck and needs intervention — exactly what
  // qa@example.com hit (Railway free-plan limit exceeded; sat at
  // "preparing" for 15 minutes with no visible failure). Treat any non-ready
  // status with a recorded error_code as the error gate so the user sees
  // the real status and can take action.
  if (errorCode && status !== 'ready' && status !== 'degraded') {
    return {
      kind: 'error',
      label: 'Needs attention',
      tone: 'danger',
      detail: publicStatusMessage ?? "Your coworker's cloud computer needs attention. Contact support if this stays stuck for more than a few minutes.",
    };
  }

  if (status === 'not_requested' || status === 'queued') {
    return { kind: 'subscribed_pending_worker', label: 'Preparing', tone: 'accent', detail: "Plan active. We're spinning up your private workspace, a few minutes, sometimes up to ten." };
  }

  if (status === 'provisioning') {
    return { kind: 'provisioning_worker', label: 'Setting up', tone: 'accent', detail: "Your private workspace is booting. A few minutes, sometimes up to ten, you can close the app." };
  }

  if (status === 'ready') {
    return { kind: 'ready', label: 'Online', tone: 'live', detail: 'Your coworker is online and ready.' };
  }

  if (status === 'degraded') {
    return { kind: 'degraded', label: 'Limited', tone: 'warning', detail: publicStatusMessage ?? 'Your coworker is online but something needs a check.' };
  }

  return { kind: 'error', label: 'Needs attention', tone: 'danger', detail: publicStatusMessage ?? errorCode ?? "Your coworker's cloud computer isn't healthy." };
}

export function canUseSidekick(gate: Pick<ProductGate, 'kind'>): boolean {
  return gate.kind === 'ready' || gate.kind === 'degraded';
}

export function createDemoSidekickState(): SidekickProductSnapshot {
  const userId = '00000000-0000-4000-8000-000000000001';
  const tier = getPlanTier('pro-office');
  const usage = buildUsageSummary(
    [
      {
        userId,
        totalTokens: 372_000,
        promptTokens: 214_000,
        completionTokens: 158_000,
        source: 'worker',
        createdAt: '2026-05-01T10:00:00.000Z',
      },
    ],
    { userId, monthlyTokenQuota: tier.monthlyTokenQuota },
  );

  return {
    profile: {
      id: userId,
      email: 'alex@coworker.ai',
      fullName: 'Alex',
      agentName: 'Ruben',
      region: 'United Kingdom',
      createdAt: '2026-05-01T09:00:00.000Z',
    },
    acknowledgement: {
      userId,
      acceptedAt: '2026-05-01T09:05:00.000Z',
      textVersion: ACKNOWLEDGEMENT_VERSION,
    },
    subscription: {
      userId,
      status: 'active',
      tierId: 'pro-office',
      currentPeriodStart: '2026-05-01T00:00:00.000Z',
      currentPeriodEnd: '2026-06-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
    },
    hermesInstance: publicHermesInstance({
      userId,
      status: 'ready',
      lastHealthAt: '2026-05-04T21:00:00.000Z',
      readyAt: '2026-05-01T09:15:00.000Z',
    }),
    usage,
    connections: resolveGatewayConnections(),
    artifacts: [
      {
        id: 'form-draft',
        userId,
        title: 'Company form draft',
        kind: 'PDF',
        detail: 'Prepared from the latest request · 18 mins ago',
        status: 'ready',
        createdAt: '2026-05-04T20:40:00.000Z',
      },
      {
        id: 'research-pack',
        userId,
        title: 'Supplier research pack',
        kind: 'Markdown',
        detail: 'Notes, links, and short recommendation · Yesterday',
        status: 'review',
        createdAt: '2026-05-03T17:20:00.000Z',
      },
    ],
    recentTasks: [
      {
        id: 'supplier-research-task',
        userId,
        status: 'succeeded',
        instruction: 'Compare supplier options and return a short recommendation.',
        messageId: 'supplier-research-message',
        createdAt: '2026-05-04T20:32:00.000Z',
        updatedAt: '2026-05-04T20:40:00.000Z',
        completedAt: '2026-05-04T20:40:00.000Z',
      },
    ],
    latestAssistantMessage: {
      id: 'supplier-research-reply',
      userId,
      role: 'assistant',
      content: 'I prepared the supplier notes and saved the recommendation pack in Files.',
      createdAt: '2026-05-04T20:41:00.000Z',
      taskId: 'supplier-research-task',
    },
    queueCount: 0,
  };
}

// Re-export the quota-journey copy + helpers from a sibling module so the
// public surface stays at `@sidekick/shared` (no `@sidekick/shared/quotaJourney`
// path needed by consumers).
export {
  buildQuotaPauseResponse,
  formatCycleEndLine,
  QUOTA_PAUSE_BASE_COPY,
  summariseBillingPeriod,
} from './quotaJourney.ts';
export type {
  BillingPeriodState,
  BillingPeriodSummary,
  QuotaCapKind,
  QuotaPauseAction,
  QuotaPauseResponse,
} from './quotaJourney.ts';

// The connectable-service catalogue — what a user's coworker can plug into,
// and the exact vault field names the on-box skills read back.
export {
  CONNECTABLE_SERVICES,
  CONNECTION_CATEGORY_LABELS,
  CONNECTION_CATEGORY_ORDER,
  CONNECTIONS_CUSTODY_NOTE,
  CONNECTIONS_MORE_COMING_NOTE,
  findConnectableService,
  connectionCategoryGroups,
  findConnectionState,
  connectedAnnouncement,
  firstPromptLabel,
  isServiceOffered,
  connectionReturnNotice,
  handoffNotice,
} from './connections.ts';
export type {
  BrandMark,
  ConnectionMode,
  ConnectionCategory,
  ConnectionSafetyStatement,
  ConnectionCategoryGroup,
  ConnectionReturnNotice,
  ConnectionStatus,
  ConnectionState,
  ConnectableService,
} from './connections.ts';

// Canonical legal copy. Mobile + website used to ship near-identical duplicates
// (apps/mobile/src/legal/* and apps/website/src/content/*) which drifted on
// quote style and constant naming. Consolidated here so a single edit lands
// on both surfaces; both apps now import from @sidekick/shared.
//
// Extension note: the ".ts" suffixes below let every bundler (Vite, Metro,
// Turbopack) resolve directly to the TypeScript source. The shared
// tsconfig sets `rewriteRelativeImportExtensions: true` (TypeScript 5.7+)
// so `tsc` rewrites them to ".js" in the compiled `dist/` output — that
// is what Node-ESM-strict consumers (worker tests, hermes-runner scripts,
// the shared package's own dist tests) load at runtime.
export {
  DELEGENT_PRIVACY_TITLE,
  DELEGENT_PRIVACY_UPDATED,
  DELEGENT_PRIVACY_INTRO,
  DELEGENT_PRIVACY_SECTIONS,
} from './legal/privacy.ts';
export type { PrivacySection } from './legal/privacy.ts';
export {
  DELEGENT_TERMS_TITLE,
  DELEGENT_TERMS_UPDATED,
  DELEGENT_TERMS_INTRO,
  DELEGENT_TERMS_SECTIONS,
} from './legal/terms.ts';
export type { TermsSection } from './legal/terms.ts';
export {
  DELEGENT_DELETION_TITLE,
  DELEGENT_DELETION_UPDATED,
  DELEGENT_DELETION_INTRO,
  DELEGENT_DELETION_SECTIONS,
  DELEGENT_EXPORT_SCOPE_NOTE,
  DELEGENT_WORKSPACE_RETENTION_DAYS,
} from './legal/deletion.ts';
export type { DeletionSection } from './legal/deletion.ts';
export {
  DELEGENT_NOTICES_TITLE,
  DELEGENT_NOTICES_UPDATED,
  DELEGENT_NOTICES_INTRO,
  DELEGENT_NOTICES_SECTIONS,
} from './legal/notices.ts';
export type { NoticesSection } from './legal/notices.ts';

// Structural alias: privacy + terms sections share the {title, body[]} shape,
// so a renderer that handles either takes LegalSection. Used by the website's
// LegalPage component.
export type { PrivacySection as LegalSection } from './legal/privacy.ts';

// Canonical in-product help copy (how-to guide + FAQ), shared by mobile and web
// for the same reason as the legal copy above.
export {
  DELEGENT_HOWTO_TITLE,
  DELEGENT_HOWTO_INTRO,
  DELEGENT_HOWTO_SECTIONS,
  DELEGENT_HOWTO_DEEPER_TITLE,
  DELEGENT_HOWTO_DEEPER_BODY,
  DELEGENT_HOWTO_DEEPER_LABEL,
  DELEGENT_HOWTO_DEEPER_URL,
  DELEGENT_FAQ_ITEMS,
  DELEGENT_FEATURE_FAQ_ITEMS,
  DELEGENT_FAQ_ORDERED,
} from './content/help.ts';
export type { HelpSection, FaqItem } from './content/help.ts';

// Where the browser version lives, and how each surface points at it.
export {
  WEB_APP_URL,
  WEB_APP_DISPLAY_URL,
  WEB_APP_MENU_LABEL,
  WEB_APP_MENU_DETAIL,
  WEB_APP_DEVICES_ANSWER,
} from './content/webApp.ts';

// How the model is described to customers. Named only in the app FAQ and the
// Talk note, from MODEL_NAME_PUBLIC (2026-09-28); see the file header, and the
// release-gate test that keeps the name out of every other surface.
export {
  MODEL_CLAIM_SHORT,
  MODEL_CLAIM_PAYWALL,
  MODEL_CLAIM_FAQ,
  MODEL_NAME_PUBLIC,
  MODEL_FAQ_QUESTION,
  MODEL_FAQ_ANSWER,
} from './content/modelClaim.ts';

// Live Talk's voice Worker (2026-09-28).
export { LIVE_TALK_HOST } from './liveTalk.ts';

// Which platforms we are allowed to SAY the app is on. One place, because
// this line was hard-coded in four files and that is how a launch ends up
// half-announced.
export {
  IOS_LIVE,
  WINDOWS_ANNOUNCED,
  PLAY_STORE_URL,
  APP_STORE_URL,
  GET_THE_APP_URL,
  platformAvailabilityLine,
  supportedDevicesSentence,
} from './content/platformAvailability.ts';

// The skills catalogue the how-to guide and the FAQ both point users at.
export { DELEGENT_USE_CASE_CATEGORIES } from './content/skills.ts';
export {
  AGENT_BUILT_IN_BADGE,
  AGENT_CONNECTION_CATEGORIES,
  AGENT_CONNECTIONS_INTRO,
  AGENT_ENGINE_UNSUPPORTED_CONNECTIONS,
  AGENT_EVERYDAY_TOOLS,
  AGENT_CHECKOUT_THANK_YOU,
  AGENT_DATA_COPY_NOTE,
  AGENT_FAQ_ORDERED,
  AGENT_HOWTO_INTRO,
  AGENT_HOWTO_SECTIONS,
  AGENT_HOWTO_TITLE,
  AGENT_PLAN,
  AGENT_PLAN_HEADLINE_OFFER,
  AGENT_PLAN_HEADLINE_PERIOD,
  AGENT_PLAN_PRICE_NOTE,
  AGENT_PLAN_SUMMARY,
  AGENT_PLAN_TRIAL_CTA,
  AGENT_TOP_UP,
  AGENT_USAGE,
  agentConnectableServices,
  agentFreeTrialTermsLine,
  agentPlanHighlights,
  agentPlanThenLine,
  agentTopUpConsentBody,
  agentUseCaseCategories,
  assistantWording,
  formatAgentPlanPrice,
  formatTopUpPrice,
} from './content/agentEngine.ts';
export type { AgentConnectionCategory, CoworkerEngine, EverydayTool, PlanHighlight } from './content/agentEngine.ts';
export type { UseCaseCategory, CategorySkill } from './content/skills.ts';

// The quick actions the ☰ menu offers on both surfaces.
export { DELEGENT_CHAT_COMMANDS } from './content/commands.ts';
export type { ChatCommand, ChatCommandOption } from './content/commands.ts';

// What both surfaces say when the workspace behind the chat is not simply
// working, and the screen would otherwise look perfectly healthy.
export {
  PROVISIONING_NOTICE_TITLE,
  PROVISIONING_GATE_KINDS,
  PROVISIONING_STALL_TIMEOUT_MS,
  PROVISIONING_STALLED_MESSAGE,
  gateNotice,
  isProvisioningGate,
  provisioningNoticeBody,
} from './content/gateNotices.ts';
export type { GateNotice, GateNoticeTone, ProvisioningSurface } from './content/gateNotices.ts';

// The window between Stripe returning the buyer and the webhook writing the
// entitlement, which both surfaces have to poll through rather than read once.
export {
  CHECKOUT_CONFIRMATION_POLL_ATTEMPTS,
  CHECKOUT_CONFIRMATION_POLL_INTERVAL_MS,
  CHECKOUT_CONFIRMING_MESSAGE,
  purchaseCoordinationNotice,
  SCHEDULED_PLAN_CHANGE_CONFIRMATION,
  SCHEDULED_PLAN_CHANGE_CHANGED_MESSAGE,
  parseScheduledPlanChangeConfirmation,
  CHECKOUT_CONFIRMATION_SLOW_MESSAGE,
  SUBSCRIPTION_ALREADY_ACTIVE_CONFIRMING,
  SUBSCRIPTION_ALREADY_ACTIVE_SLOW_MESSAGE,
  CAPACITY_NO_ALLOWANCE_BODY,
  CAPACITY_NO_ALLOWANCE_CTA,
  CAPACITY_NO_ALLOWANCE_TITLE,
  checkoutThankYouBody,
  PLAN_DOWNGRADE_TIMING_NOTE,
  PLAN_UPGRADE_PRORATION_NOTE,
  STORAGE_DOWNGRADE_BLOCK_TITLE,
  BILLING_CUSTOMER_REQUIRED_MESSAGE,
  BILLING_SUBSCRIPTION_SYNCING_MESSAGE,
  planChangeNote,
  friendlyBillingDate,
  formatStorageGb,
  storageDowngradeBlockBody,
  downgradeScheduledMessage,
} from './content/checkoutNotices.ts';
export type { CheckoutSurface, ScheduledPlanChangeConfirmation } from './content/checkoutNotices.ts';

export {
  ROUTINE_CREATED_REFRESH_FAILED,
  ROUTINE_LIMIT_REACHED_MESSAGE,
  ROUTINE_MAX_STANDING,
} from './content/routineNotices.ts';

// Which billing controls a surface may offer, and what to say when it may not.
// The same mistake was made independently on both surfaces; see the file.
export {
  APPLE_MANAGE_SUBSCRIPTIONS_URL,
  billingControlsFor,
  type BillingControls,
  type BillingSurfaceBiller,
} from './content/billingControls.ts';

// One home for what the two surfaces say when setting up a connection fails.
export {
  CONNECTIONS_DISCONNECT_UNCONFIRMED,
  CONNECTIONS_FINISHING_LABEL,
  CONNECTIONS_NOT_TURNED_ON,
  CONNECTIONS_NO_PLAN,
  CONNECTIONS_PARTLY_DISCONNECTED,
  CONNECTIONS_RATE_LIMITED,
  CONNECTIONS_RETRY_LABEL,
  CONNECTIONS_SIGN_IN_AGAIN,
  CONNECTIONS_UNREACHABLE,
  CONNECTIONS_WORKSPACE_STARTING,
} from './content/connectionNotices.ts';

// The Files surface: folder grouping, noise filtering, collapse state and
// multi-select. Generic over the row shape, because the phone carries
// modifiedAt as epoch ms and the browser as an ISO string.
export {
  DEFAULT_FOLDERS,
  FOLDER_ORDER,
  FILES_EXPANDED_FOLDERS_STORAGE_KEY,
  modifiedAtMs,
  fullDirectoryPath,
  isNoiseFile,
  buildFolderGroups,
  allCollapsibleKeys,
  recentFiles,
  serializeExpandedKeys,
  parseExpandedKeys,
  collapsedKeysFromExpanded,
  isHiddenByCollapsedAncestor,
} from './files/folderGroups.ts';
export type { WorkspaceFileLike, FolderGroup } from './files/folderGroups.ts';

export {
  DELETE_SELECTION_CONCURRENCY,
  toggleSelectedFile,
  selectAllInFolder,
  fileIdsInFolderTree,
  selectAllInFolderTree,
  toggleFolderTree,
  deleteSelectionConfirmCopy,
  deleteSelectionOutcomeCopy,
  runSelectionDelete,
} from './files/multiSelect.ts';
export type { FileMutationOutcome } from './files/multiSelect.ts';

// The inline first look at a text file. Both surfaces ask for the same byte
// range and have to reach the same verdict on whether it is the whole file.
export {
  PREVIEW_BYTE_LIMIT,
  PREVIEW_LINE_LIMIT,
  PREVIEW_RETRY_LABEL,
  isPreviewableFile,
  buildFilePreview,
} from './files/preview.ts';
export type { PreviewableFile, FilePreview } from './files/preview.ts';

// Apple in-app purchase. The switch between Guideline 3.1.3(f) ("hidden": no
// price and no purchase anywhere on iOS) and Guideline 3.1.1 ("iap": StoreKit
// does the purchase). Both surfaces and the Worker read the product ids from
// here so a rename cannot land in one place only.
export {
  APPLE_IAP_BUNDLE_ID,
  APPLE_IAP_PRODUCT_IDS,
  ALL_APPLE_IAP_PRODUCT_IDS,
  APPLE_ASSISTANT_PRODUCT_ID,
  IOS_NO_SUBSCRIPTION_TITLE,
  IOS_NO_SUBSCRIPTION_BODY,
  appleProductIdForTier,
  appleProductIdForPurchase,
  isAppleAssistantProduct,
  isUsableAppleTransactionId,
  mayShowPurchaseUi,
  planTierIdForAppleProduct,
  resolveIosPurchaseMode,
  shouldUseStoreKit,
} from './appleIap.ts';
export type { IosPurchaseMode } from './appleIap.ts';
