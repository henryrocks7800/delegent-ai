import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACKNOWLEDGEMENT_VERSION,
  AUTH_PROVIDER_EMAIL,
  AUTH_PROVIDER_PHONE,
  DEFAULT_SUPABASE_AUTH_CALLBACK,
  MESSAGING_PROVIDER_IDS,
  SIDEKICK_GATEWAY_REGISTRY,
  SIDEKICK_PLAN_TIERS,
  buildUsageSummary,
  canUseSidekick,
  createDemoSidekickState,
  getPlanTier,
  maskE164PhoneNumber,
  normalizeE164PhoneNumber,
  normalizeEmailAddress,
  normalizeGatewayConnectCode,
  normalizeOtpCode,
  resolveGatewayConnectIntent,
  resolveGatewayConnections,
  resolveMessagingProviderConnections,
  resolveMessagingProviderStatus,
  resolveMessagingProviderSwitchEligibility,
  publicMessagingProviderLabel,
  isCurrentAcknowledgement,
  isSubscriptionEntitled,
  isCoworkerUpdateAvailable,
  isCoworkerUpdating,
  mapMyProductStateRow,
  resolveAuthSessionState,
  resolvePublicSupabaseConfig,
  resolveSidekickGate,
} from '../dist/index.js';

const profile = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'alex@example.com',
  fullName: 'Alex',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const acknowledgement = {
  userId: profile.id,
  acceptedAt: '2026-01-01T00:01:00.000Z',
  textVersion: ACKNOWLEDGEMENT_VERSION,
};

const activeSubscription = {
  userId: profile.id,
  status: 'active',
  tierId: 'pro-office',
  currentPeriodStart: '2026-01-01T00:00:00.000Z',
  currentPeriodEnd: '2026-02-01T00:00:00.000Z',
};

const readyInstance = {
  userId: profile.id,
  status: 'ready',
  lastHealthAt: '2026-01-01T00:05:00.000Z',
  readyAt: '2026-01-01T00:04:00.000Z',
};

function snapshot(overrides = {}) {
  return {
    profile,
    acknowledgement,
    subscription: activeSubscription,
    hermesInstance: readyInstance,
    usage: { usedTokens: 12_000, quotaTokens: 600_000, nearLimit: false, hardLimited: false, ratio: 0.02, remainingTokens: 588_000 },
    connections: [],
    artifacts: [],
    queueCount: 0,
    ...overrides,
  };
}

const anonSupabaseKey = `header.${Buffer.from(JSON.stringify({ role: 'anon', iss: 'supabase' })).toString('base64url')}.signature`;

function readySupabaseConfig(overrides = {}) {
  const result = resolvePublicSupabaseConfig({
    supabaseUrl: 'https://abc123.supabase.co',
    supabaseAnonKey: anonSupabaseKey,
    ...overrides,
  });
  assert.equal(result.ready, true);
  return result;
}

const googleSession = {
  provider: 'google',
  user: {
    id: profile.id,
    email: profile.email,
    fullName: profile.fullName,
    avatarUrl: 'https://example.com/avatar.png',
  },
  expiresAt: '2026-01-02T00:00:00.000Z',
};

const recoverableAuthError = {
  code: 'oauth_failed',
  message: 'Google sign-in could not be completed. Please try again.',
  recoverable: true,
  provider: 'google',
};

test('auth session boundary reports loading while restoring and disables OAuth', () => {
  const state = resolveAuthSessionState({
    supabaseConfig: readySupabaseConfig(),
    session: googleSession,
    restoring: true,
    error: recoverableAuthError,
  });

  assert.equal(state.status, 'loading');
  assert.equal(state.provider, 'google');
  assert.equal(state.supabaseReady, true);
  assert.equal(state.canStartOAuth, false);
  assert.equal(state.canStartEmailOtp, false);
  assert.equal(state.canStartPhoneOtp, false);
  assert.equal(state.oauthRedirectTo, null);
  assert.equal(state.session, null);
  assert.equal(state.user, null);
  assert.equal(state.error, null);
});

test('auth session boundary reports loading while loading and disables OAuth', () => {
  const state = resolveAuthSessionState({
    supabaseConfig: readySupabaseConfig(),
    session: googleSession,
    loading: true,
    error: recoverableAuthError,
  });

  assert.equal(state.status, 'loading');
  assert.equal(state.provider, 'google');
  assert.equal(state.supabaseReady, true);
  assert.equal(state.canStartOAuth, false);
  assert.equal(state.canStartEmailOtp, false);
  assert.equal(state.canStartPhoneOtp, false);
  assert.equal(state.oauthRedirectTo, null);
  assert.equal(state.session, null);
  assert.equal(state.user, null);
  assert.equal(state.error, null);
});

test('auth session boundary keeps errors explicit and never authenticates from a stale session', () => {
  const state = resolveAuthSessionState({
    supabaseConfig: readySupabaseConfig(),
    session: googleSession,
    error: recoverableAuthError,
  });

  assert.equal(state.status, 'error');
  assert.equal(state.canStartOAuth, false);
  assert.equal(state.canStartEmailOtp, false);
  assert.equal(state.canStartPhoneOtp, false);
  assert.equal(state.session, null);
  assert.equal(state.user, null);
  assert.deepEqual(state.error, recoverableAuthError);
});

test('auth session boundary authenticates a public Google identity without leaking token fields', () => {
  const state = resolveAuthSessionState({
    supabaseConfig: readySupabaseConfig(),
    session: {
      ...googleSession,
      accessToken: 'must-not-leak',
      refreshToken: 'must-not-leak',
      user: {
        ...googleSession.user,
        identities: [{ provider: 'google', access_token: 'must-not-leak' }],
      },
    },
  });

  assert.equal(state.status, 'authenticated');
  assert.equal(state.provider, 'google');
  assert.equal(state.canStartOAuth, false);
  assert.equal(state.canStartEmailOtp, false);
  assert.equal(state.canStartPhoneOtp, false);
  assert.equal(state.oauthRedirectTo, null);
  assert.deepEqual(state.user, googleSession.user);
  assert.deepEqual(state.session, googleSession);
  assert.equal('accessToken' in state.session, false);
  assert.equal('refreshToken' in state.session, false);
  assert.equal('identities' in state.user, false);
});

test('auth session boundary authenticates a public email identity without treating it as Google', () => {
  const emailSession = {
    provider: AUTH_PROVIDER_EMAIL,
    user: {
      id: profile.id,
      email: ' Alex@Example.COM ',
      fullName: '',
      accessToken: 'must-not-leak',
    },
    expiresAt: '2026-01-02T00:00:00.000Z',
  };

  const state = resolveAuthSessionState({
    supabaseConfig: readySupabaseConfig(),
    session: emailSession,
  });

  assert.equal(state.status, 'authenticated');
  assert.equal(state.provider, AUTH_PROVIDER_EMAIL);
  assert.equal(state.session.provider, AUTH_PROVIDER_EMAIL);
  assert.equal(state.user.email, 'Alex@Example.COM');
  assert.equal('accessToken' in state.user, false);
});

test('auth session boundary authenticates a public phone identity without exposing raw phone numbers', () => {
  const phoneSession = {
    provider: AUTH_PROVIDER_PHONE,
    user: {
      id: profile.id,
      phoneMasked: '•••• 7890',
      phone: '+447700900123',
      email: '',
    },
    expiresAt: '2026-01-02T00:00:00.000Z',
  };

  const state = resolveAuthSessionState({
    supabaseConfig: readySupabaseConfig(),
    session: phoneSession,
  });

  assert.equal(state.status, 'authenticated');
  assert.equal(state.provider, AUTH_PROVIDER_PHONE);
  assert.equal(state.session.provider, AUTH_PROVIDER_PHONE);
  assert.equal(state.user.phoneMasked, '•••• 7890');
  assert.equal('phone' in state.user, false);
  assert.equal('email' in state.user, false);
  assert.equal(JSON.stringify(state), JSON.stringify(state).replace('+447700900123', '[redacted]'));
});

test('auth session boundary refuses raw phone values passed as masked phone display', () => {
  for (const unsafePhoneMasked of ['+447700900123', '+44 7700 900123', '07700900123', '447700900123']) {
    const state = resolveAuthSessionState({
      supabaseConfig: readySupabaseConfig(),
      session: {
        provider: AUTH_PROVIDER_PHONE,
        user: {
          id: profile.id,
          phoneMasked: unsafePhoneMasked,
        },
      },
    });

    assert.equal(state.status, 'authenticated');
    assert.equal(state.provider, AUTH_PROVIDER_PHONE);
    assert.equal('phoneMasked' in state.user, false);
    assert.doesNotMatch(JSON.stringify(state), /\+?44\s?7700\s?900123|07700900123/);
  }
});

test('auth OTP helpers normalize email, require E.164 phone input, mask phone display, and normalize phone/email code lengths', () => {
  assert.equal(normalizeEmailAddress(' Alex@Example.COM '), 'alex@example.com');
  assert.equal(normalizeE164PhoneNumber(' +447700900123 '), '+447700900123');
  assert.equal(normalizeE164PhoneNumber('+1 (555) 123-4567'), '+15551234567');
  assert.equal(maskE164PhoneNumber('+447700900123'), '•••• 0123');
  assert.equal(normalizeOtpCode(' 123 456 '), '123456');
  assert.equal(normalizeOtpCode(' 1234 5678 ', 8), '12345678');

  for (const invalidEmail of ['', 'alex', 'alex@', '@example.com', 'alex@example']) {
    assert.throws(() => normalizeEmailAddress(invalidEmail), /email/);
  }

  for (const invalidPhone of ['07700900123', '+0123', '+1234567', '+1234567890123456', '+12abc']) {
    assert.throws(() => normalizeE164PhoneNumber(invalidPhone), /E\.164/);
  }

  for (const invalidPhoneCode of ['12345', '1234567', '12345678', '12-456', 'abcdef']) {
    assert.throws(() => normalizeOtpCode(invalidPhoneCode), /six-digit/);
  }

  for (const invalidEmailCode of ['12345', '123456', '1234567', '123456789', '12-4567', 'abcdef']) {
    assert.throws(() => normalizeOtpCode(invalidEmailCode, 8), /eight-digit/);
  }
});

test('auth session boundary stays signed out and cannot start OAuth without public Supabase config', () => {
  const state = resolveAuthSessionState({
    supabaseConfig: resolvePublicSupabaseConfig({}),
  });

  assert.equal(state.status, 'signed_out');
  assert.equal(state.supabaseReady, false);
  assert.deepEqual(state.configIssues, ['missing_url', 'missing_anon_key']);
  assert.equal(state.canStartOAuth, false);
  assert.equal(state.canStartEmailOtp, false);
  assert.equal(state.canStartPhoneOtp, false);
  assert.equal(state.oauthRedirectTo, null);
  assert.equal(state.session, null);
  assert.equal(state.user, null);
});

test('auth session boundary ignores stale sessions when public Supabase config is missing', () => {
  const state = resolveAuthSessionState({
    supabaseConfig: resolvePublicSupabaseConfig({}),
    session: googleSession,
  });

  assert.equal(state.status, 'signed_out');
  assert.equal(state.supabaseReady, false);
  assert.deepEqual(state.configIssues, ['missing_url', 'missing_anon_key']);
  assert.equal(state.canStartOAuth, false);
  assert.equal(state.canStartEmailOtp, false);
  assert.equal(state.canStartPhoneOtp, false);
  assert.equal(state.oauthRedirectTo, null);
  assert.equal(state.session, null);
  assert.equal(state.user, null);
  assert.equal(state.error, null);
});

test('auth session boundary can start Google OAuth with the default callback once public config is ready', () => {
  const state = resolveAuthSessionState({
    supabaseConfig: readySupabaseConfig(),
  });

  assert.equal(state.status, 'signed_out');
  assert.equal(state.provider, 'google');
  assert.equal(state.supabaseReady, true);
  assert.deepEqual(state.configIssues, []);
  assert.equal(state.canStartOAuth, true);
  assert.equal(state.canStartEmailOtp, true);
  assert.equal(state.canStartPhoneOtp, true);
  assert.equal(state.oauthRedirectTo, DEFAULT_SUPABASE_AUTH_CALLBACK);
  assert.equal(state.session, null);
  assert.equal(state.user, null);
});

test('plan tiers are canonical and expose quotas for mobile/web/billing copy', () => {
  assert.equal(SIDEKICK_PLAN_TIERS.length, 3);
  assert.equal(getPlanTier('pro-office').monthlyTokenQuota, 48_000_000);
  assert.equal(getPlanTier('enterprise-suite').name, 'Max');
});

test('subscription entitlement is explicit and does not accidentally allow inactive users', () => {
  assert.equal(isSubscriptionEntitled({ ...activeSubscription, status: 'active' }), true);
  assert.equal(isSubscriptionEntitled({ ...activeSubscription, status: 'trialing', currentPeriodEnd: new Date(Date.now() + 86400000).toISOString() }), true);
  assert.equal(isSubscriptionEntitled({ ...activeSubscription, status: 'past_due' }), true);
  assert.equal(isSubscriptionEntitled(null), false);
});

test('acknowledgement must match the current responsibility text version', () => {
  assert.equal(isCurrentAcknowledgement(acknowledgement), true);
  assert.equal(isCurrentAcknowledgement({ ...acknowledgement, textVersion: 'v0' }), false);
  assert.equal(resolveSidekickGate(snapshot({ acknowledgement: { ...acknowledgement, textVersion: 'v0' } })).kind, 'needs_acknowledgement');
});

test('resolveSidekickGate follows product contract order', () => {
  assert.equal(resolveSidekickGate(snapshot({ profile: null })).kind, 'signed_out');
  assert.equal(resolveSidekickGate(snapshot({ acknowledgement: null })).kind, 'needs_acknowledgement');
  assert.equal(resolveSidekickGate(snapshot({ subscription: { ...activeSubscription, status: 'inactive' } })).kind, 'needs_subscription');
  assert.equal(resolveSidekickGate(snapshot({ hermesInstance: null })).kind, 'subscribed_pending_worker');
  assert.equal(resolveSidekickGate(snapshot({ hermesInstance: { ...readyInstance, status: 'provisioning' } })).kind, 'provisioning_worker');
  assert.equal(resolveSidekickGate(snapshot()).kind, 'ready');
});

test('resolveSidekickGate distinguishes degraded/error/hard-limited states', () => {
  assert.equal(resolveSidekickGate(snapshot({ hermesInstance: { ...readyInstance, status: 'degraded' } })).kind, 'degraded');
  assert.equal(resolveSidekickGate(snapshot({ hermesInstance: { ...readyInstance, status: 'error', errorCode: 'runner_unhealthy' } })).kind, 'error');
  assert.equal(resolveSidekickGate(snapshot({ usage: { usedTokens: 600_000, quotaTokens: 600_000, nearLimit: true, hardLimited: true, ratio: 1, remainingTokens: 0 } })).kind, 'hard_limited');
});

test('resolveSidekickGate surfaces error when provisioner stalls with an error_code (regression: Alex, 2026-05-15)', () => {
  // qa@example.com's account on 2026-05-15: Stripe webhook succeeded
  // and hermes_instances.status stayed at 'provisioning' while error_code +
  // public_status_message were recorded because Railway free-plan capacity
  // was exhausted. The previous gate code branched on status alone and
  // returned 'provisioning_worker' ("Setting up your coworker's cloud
  // computer is starting up.") indefinitely — the user sat staring at
  // "preparing" for 15 minutes with no visible failure. The gate now
  // promotes any non-ready / non-degraded status with a recorded errorCode
  // to the 'error' kind and surfaces publicStatusMessage to the user.
  const stuck = {
    ...readyInstance,
    status: 'provisioning',
    errorCode: 'railway_free_plan_resource_provision_limit_exceeded_please_upgra',
    publicStatusMessage: 'Delegent AI setup needs a manual Railway check before continuing.',
  };
  const gate = resolveSidekickGate(snapshot({ hermesInstance: stuck }));
  assert.equal(gate.kind, 'error');
  assert.equal(gate.tone, 'danger');
  assert.equal(gate.label, 'Needs attention');
  assert.equal(gate.detail, 'Delegent AI setup needs a manual Railway check before continuing.');

  // Same treatment for queued / not_requested with an errorCode.
  for (const status of ['not_requested', 'queued']) {
    const queuedStuck = { ...readyInstance, status, errorCode: 'railway_temporary_failure' };
    assert.equal(resolveSidekickGate(snapshot({ hermesInstance: queuedStuck })).kind, 'error');
  }

  // 'ready' wins even if an errorCode is somehow set — the runner is
  // demonstrably online, so don't scare the user.
  const readyWithStaleError = { ...readyInstance, status: 'ready', errorCode: 'previous_transient_error' };
  assert.equal(resolveSidekickGate(snapshot({ hermesInstance: readyWithStaleError })).kind, 'ready');

  // Provisioning without an errorCode still shows the normal "Setting up"
  // copy — we only flip to error when the provisioner has actually recorded
  // a problem.
  const provisioningClean = { ...readyInstance, status: 'provisioning' };
  assert.equal(resolveSidekickGate(snapshot({ hermesInstance: provisioningClean })).kind, 'provisioning_worker');
});

test('canUseSidekick only permits ready and degraded states', () => {
  assert.equal(canUseSidekick({ kind: 'ready', label: 'Ready', tone: 'live' }), true);
  assert.equal(canUseSidekick({ kind: 'degraded', label: 'Degraded', tone: 'warning' }), true);
  assert.equal(canUseSidekick({ kind: 'needs_subscription', label: 'Choose a plan', tone: 'neutral' }), false);
});

test('buildUsageSummary sums events and applies near-limit / hard-limit thresholds', () => {
  const events = [
    { userId: profile.id, totalTokens: 200_000, promptTokens: 120_000, completionTokens: 80_000, createdAt: '2026-01-03T00:00:00.000Z' },
    { userId: profile.id, totalTokens: 285_000, promptTokens: 150_000, completionTokens: 135_000, createdAt: '2026-01-04T00:00:00.000Z' },
  ];

  assert.deepEqual(buildUsageSummary(events, { userId: profile.id, monthlyTokenQuota: 600_000, tierId: 'pro-office' }), {
    usedTokens: 485_000,
    quotaTokens: 600_000,
    remainingTokens: 115_000,
    ratio: 0.8083333333333333,
    nearLimit: true,
    hardLimited: false,
  });

  // D2 fix: an unconfigured quota row (monthlyTokenQuota === 0) must
  // NOT be treated as "instantly hard-limited on first token". Before
  // the fix that codepath locked Alex out of chat after his first
  // message on 2026-05-20.
  assert.equal(
    buildUsageSummary(
      [{ userId: profile.id, totalTokens: 1, createdAt: '2026-01-05T00:00:00.000Z' }],
      { userId: profile.id, monthlyTokenQuota: 0 },
    ).hardLimited,
    false,
    'unconfigured quota (0) must not auto-hard-limit on positive usage',
  );
  assert.equal(
    buildUsageSummary(
      [{ userId: profile.id, totalTokens: 600_001, createdAt: '2026-01-05T00:00:00.000Z' }],
      { userId: profile.id, monthlyTokenQuota: 600_000, tierId: 'pro-office' },
    ).hardLimited,
    true,
    'configured quota crossed by usage must hard-limit',
  );
});

test('database product-state rows treat missing quota as unconfigured after first chat usage', () => {
  const mapped = mapMyProductStateRow({
    user_id: profile.id,
    email: profile.email,
    full_name: profile.fullName,
    agent_name: 'Ruben',
    avatar_url: null,
    region: 'United Kingdom',
    profile_created_at: profile.createdAt,
    profile_updated_at: null,
    acknowledgement_accepted: true,
    acknowledgement_accepted_at: acknowledgement.acceptedAt,
    acknowledgement_text_version: ACKNOWLEDGEMENT_VERSION,
    subscription_status: 'active',
    tier_id: 'studio',
    current_period_start: activeSubscription.currentPeriodStart,
    current_period_end: activeSubscription.currentPeriodEnd,
    cancel_at_period_end: false,
    worker_status: 'provisioning',
    last_health_at: null,
    ready_at: null,
    error_code: null,
    public_status_message: 'Setting up your coworker.',
    monthly_token_quota: null,
    used_tokens: 1,
    remaining_tokens: 0,
    usage_ratio: 1,
    usage_near_limit: true,
    usage_hard_limited: true,
    queue_count: 0,
    telegram_connected: false,
    gate_kind: 'provisioning_worker',
  });

  assert.equal(mapped.usage.quotaTokens, 0);
  assert.equal(mapped.usage.usedTokens, 1);
  assert.equal(mapped.usage.ratio, 0, 'unconfigured quota must not look 100% consumed after first usage');
  assert.equal(mapped.usage.nearLimit, false, 'unconfigured quota must not show a near-limit warning');
  assert.equal(mapped.usage.hardLimited, false, 'unconfigured quota must not replace chat with quota recovery');
  assert.equal(resolveSidekickGate(mapped).kind, 'provisioning_worker');
});

test('subscription entitlement keeps trial and payment-grace users inside the workspace instead of sending them back to checkout', () => {
  for (const status of ['active', 'trialing', 'past_due']) {
    const subscription = { ...activeSubscription, status, currentPeriodEnd: new Date(Date.now() + 86400000).toISOString() };
    assert.equal(isSubscriptionEntitled(subscription), true, `${status} must retain workspace entitlement`);
    const gate = resolveSidekickGate(snapshot({ subscription }));
    assert.equal(gate.kind, 'ready', `${status} must not be downgraded to needs_subscription`);
    assert.equal(canUseSidekick(gate), true, `${status} should keep chat/workspace usable`);
  }

  for (const status of ['inactive', 'canceled', 'unpaid']) {
    const subscription = { ...activeSubscription, status };
    assert.equal(isSubscriptionEntitled(subscription), false, `${status} must not retain workspace entitlement`);
  }
});

test('canceled subscriptions with retained sleeping workspaces surface retained file access instead of checkout', () => {
  const volumeRetentionUntil = '2026-02-15T00:00:00.000Z';
  const retainedSnapshot = snapshot({
    subscription: { ...activeSubscription, status: 'canceled' },
    hermesInstance: {
      ...readyInstance,
      status: 'sleeping',
      volumeRetentionUntil,
      publicStatusMessage: 'Delegent AI is paused while your subscription is inactive.',
    },
  });

  const gate = resolveSidekickGate(retainedSnapshot);
  assert.equal(gate.kind, 'workspace_retained');
  assert.equal(gate.label, 'Workspace retained');
  assert.match(gate.detail ?? '', /Files stay saved/i);
  assert.equal(canUseSidekick(gate), false, 'retained files do not mean new chat/task entitlement');

  const mapped = mapMyProductStateRow({
    user_id: profile.id,
    email: profile.email,
    full_name: profile.fullName,
    agent_name: 'Ruben',
    avatar_url: null,
    region: 'United Kingdom',
    profile_created_at: profile.createdAt,
    profile_updated_at: null,
    acknowledgement_accepted: true,
    acknowledgement_accepted_at: acknowledgement.acceptedAt,
    acknowledgement_text_version: ACKNOWLEDGEMENT_VERSION,
    subscription_status: 'canceled',
    tier_id: 'pro-office',
    current_period_start: activeSubscription.currentPeriodStart,
    current_period_end: activeSubscription.currentPeriodEnd,
    cancel_at_period_end: false,
    worker_status: 'sleeping',
    last_health_at: readyInstance.lastHealthAt,
    ready_at: readyInstance.readyAt,
    error_code: null,
    public_status_message: 'Delegent AI is paused while your subscription is inactive.',
    volume_retention_until: volumeRetentionUntil,
    monthly_token_quota: 600_000,
    used_tokens: 372_000,
    remaining_tokens: 228_000,
    usage_ratio: 0.62,
    usage_near_limit: false,
    usage_hard_limited: false,
    queue_count: 0,
    telegram_connected: true,
    gate_kind: 'workspace_retained',
  });

  assert.equal(mapped.hermesInstance?.status, 'sleeping');
  assert.equal(mapped.hermesInstance?.volumeRetentionUntil, volumeRetentionUntil);
  assert.equal(resolveSidekickGate(mapped).kind, 'workspace_retained');
});

test('database product-state rows map into the shared snapshot contract', () => {
  const mapped = mapMyProductStateRow({
    user_id: profile.id,
    email: profile.email,
    full_name: profile.fullName,
    avatar_url: null,
    region: 'United Kingdom',
    profile_created_at: profile.createdAt,
    profile_updated_at: null,
    acknowledgement_accepted: true,
    acknowledgement_accepted_at: acknowledgement.acceptedAt,
    acknowledgement_text_version: ACKNOWLEDGEMENT_VERSION,
    subscription_status: 'active',
    tier_id: 'pro-office',
    current_period_start: activeSubscription.currentPeriodStart,
    current_period_end: activeSubscription.currentPeriodEnd,
    cancel_at_period_end: false,
    worker_status: 'ready',
    last_health_at: readyInstance.lastHealthAt,
    ready_at: readyInstance.readyAt,
    error_code: null,
    public_status_message: 'Sidekick is ready for tasks.',
    monthly_token_quota: 600_000,
    used_tokens: 372_000,
    remaining_tokens: 228_000,
    usage_ratio: 0.62,
    usage_near_limit: false,
    usage_hard_limited: false,
    queue_count: 0,
    telegram_connected: true,
    gate_kind: 'ready',
  });

  assert.equal(mapped.profile?.createdAt, profile.createdAt);
  assert.equal(mapped.acknowledgement?.textVersion, ACKNOWLEDGEMENT_VERSION);
  assert.equal(mapped.usage.ratio, 0.62);
  assert.equal(mapped.queueCount, 0);
  assert.equal(mapped.connections.find((connection) => connection.id === 'telegram')?.status, 'live');
  assert.equal(mapped.connections.find((connection) => connection.id === 'telegram')?.actionLabel, 'Connected');
  assert.doesNotMatch(JSON.stringify(mapped), /telegram:chat:|4101|source_conversation|source_event|idempotency/i);
  assert.equal(resolveSidekickGate(mapped).kind, 'ready');
});

test('generic messaging provider state maps live WhatsApp or Signal records without private identifiers', () => {
  assert.deepEqual(MESSAGING_PROVIDER_IDS, ['telegram', 'whatsapp', 'signal']);
  assert.equal(publicMessagingProviderLabel('telegram'), 'Telegram');
  assert.equal(publicMessagingProviderLabel('whatsapp'), 'WhatsApp');
  assert.equal(resolveMessagingProviderStatus('telegram', null), 'ready');
  assert.equal(resolveMessagingProviderStatus('whatsapp', 'whatsapp'), 'live');
  assert.equal(resolveMessagingProviderStatus('signal', null), 'paused');

  const connections = resolveMessagingProviderConnections([
    { providerId: 'whatsapp', status: 'connected', connectedAt: '2026-05-08T10:00:00.000Z' },
  ]);
  assert.equal(connections.find((connection) => connection.id === 'whatsapp')?.status, 'live');
  assert.equal(connections.find((connection) => connection.id === 'whatsapp')?.actionLabel, 'Connected');
  assert.equal(connections.find((connection) => connection.id === 'telegram')?.status, 'ready');
  assert.equal(connections.find((connection) => connection.id === 'signal')?.status, 'paused');

  const switchEligibility = resolveMessagingProviderSwitchEligibility({
    activeProviderId: 'whatsapp',
    targetProviderId: 'telegram',
  });
  assert.deepEqual(switchEligibility, {
    canSwitch: true,
    activeProviderId: 'whatsapp',
    targetProviderId: 'telegram',
    reason: 'switch_provider',
    publicLabel: 'Switch from WhatsApp to Telegram',
  });

  const mapped = mapMyProductStateRow({
    user_id: profile.id,
    email: profile.email,
    full_name: profile.fullName,
    agent_name: 'Ruben',
    avatar_url: null,
    region: 'United Kingdom',
    profile_created_at: profile.createdAt,
    profile_updated_at: null,
    acknowledgement_accepted: true,
    acknowledgement_accepted_at: acknowledgement.acceptedAt,
    acknowledgement_text_version: ACKNOWLEDGEMENT_VERSION,
    subscription_status: 'active',
    tier_id: 'pro-office',
    current_period_start: activeSubscription.currentPeriodStart,
    current_period_end: activeSubscription.currentPeriodEnd,
    cancel_at_period_end: false,
    worker_status: 'ready',
    last_health_at: readyInstance.lastHealthAt,
    ready_at: readyInstance.readyAt,
    error_code: null,
    public_status_message: 'Delegent AI is ready for tasks.',
    monthly_token_quota: 600_000,
    used_tokens: 372_000,
    remaining_tokens: 228_000,
    usage_ratio: 0.62,
    usage_near_limit: false,
    usage_hard_limited: false,
    queue_count: 0,
    active_gateway_id: 'signal',
    messaging_provider_connections: [{ provider_id: 'signal', status: 'connected', connected_at: '2026-05-08T10:00:00.000Z' }],
    telegram_connected: false,
    gate_kind: 'ready',
  });

  assert.equal(mapped.connections.find((connection) => connection.id === 'signal')?.status, 'live');
  assert.equal(mapped.connections.find((connection) => connection.id === 'telegram')?.status, 'ready');
  assert.doesNotMatch(JSON.stringify(mapped), /signal:phone|source_conversation|source_event|source_message|idempotency|code_hash/i);
});

test('generic messaging provider logic refuses multiple active providers before UI mapping', () => {
  assert.throws(
    () => resolveMessagingProviderConnections([
      { providerId: 'telegram', status: 'connected' },
      { providerId: 'whatsapp', status: 'connected' },
    ]),
    /one active messaging provider/i,
  );

  const sameProvider = resolveMessagingProviderSwitchEligibility({
    activeProviderId: 'telegram',
    targetProviderId: 'telegram',
  });
  assert.deepEqual(sameProvider, {
    canSwitch: false,
    activeProviderId: 'telegram',
    targetProviderId: 'telegram',
    reason: 'already_active',
    publicLabel: 'Telegram is already connected',
  });
});

test('public Supabase config stays disabled until URL and anon key are present', () => {
  const result = resolvePublicSupabaseConfig({});

  assert.equal(result.ready, false);
  assert.deepEqual(result.issues, ['missing_url', 'missing_anon_key']);
  assert.match(result.helpText, /EXPO_PUBLIC_SUPABASE_URL/);
  assert.match(result.helpText, /EXPO_PUBLIC_SUPABASE_ANON_KEY/);
});

test('public Supabase config accepts a cloud project URL and normalizes the auth callback', () => {
  const anonPayload = Buffer.from(JSON.stringify({ role: 'anon', iss: 'supabase' })).toString('base64url');
  const result = resolvePublicSupabaseConfig({
    supabaseUrl: ' https://abc123.supabase.co/ ',
    supabaseAnonKey: `header.${anonPayload}.signature`,
  });

  assert.equal(result.ready, true);
  assert.equal(result.config.url, 'https://abc123.supabase.co');
  assert.equal(result.config.projectRef, 'abc123');
  assert.equal(result.config.redirectTo, 'sidekick://auth/callback');
});

test('public Supabase config rejects service-role keys before they can reach mobile', () => {
  const servicePayload = Buffer.from(JSON.stringify({ role: 'service_role', iss: 'supabase' })).toString('base64url');
  const result = resolvePublicSupabaseConfig({
    supabaseUrl: 'https://abc123.supabase.co',
    supabaseAnonKey: `header.${servicePayload}.signature`,
  });

  assert.equal(result.ready, false);
  assert.deepEqual(result.issues, ['service_role_key']);
});

test('gateway registry is canonical, ordered, and product-safe', () => {
  const ids = SIDEKICK_GATEWAY_REGISTRY.map((gateway) => gateway.id);

  assert.deepEqual(ids, ['telegram', 'whatsapp', 'signal', 'email']);
  assert.equal(new Set(ids).size, ids.length);

  assert.deepEqual(
    SIDEKICK_GATEWAY_REGISTRY.map((gateway) => [gateway.id, gateway.status, gateway.badge, gateway.actionLabel]),
    [
      ['telegram', 'ready', 'First', 'Connect Telegram'],
      ['whatsapp', 'testing', 'Testing', 'Coming next'],
      ['signal', 'paused', 'Paused', 'Waiting'],
      ['email', 'ready', 'Planned', 'Coming later'],
    ],
  );

  const userFacingCopy = SIDEKICK_GATEWAY_REGISTRY
    .flatMap((gateway) => [gateway.name, gateway.description, gateway.badge, gateway.actionLabel])
    .join(' ');

  assert.doesNotMatch(userFacingCopy, /supabase|oauth|railway|cloudflare|openrouter|hermes|service-role|api key|token|secret|container|runtime|worker/i);
  assert.doesNotMatch(userFacingCopy, /setup later|parked|core flow|prepared for setup/i);

  const connections = resolveGatewayConnections({ telegram: { status: 'live', badge: 'Connected', actionLabel: 'Connected' } });
  assert.equal(connections.find((connection) => connection.id === 'telegram')?.status, 'live');
  assert.equal(connections.find((connection) => connection.id === 'telegram')?.actionLabel, 'Connected');
  assert.equal(connections.find((connection) => connection.id === 'whatsapp')?.status, 'testing');
  assert.equal(connections.find((connection) => connection.id === 'signal')?.status, 'paused');
});

test('Telegram connect intent presents a safe short code without provider secrets', () => {
  const intent = resolveGatewayConnectIntent({
    gatewayId: 'telegram',
    code: ' tg 7kq 9z2 ',
    expiresAt: '2026-05-05T13:00:00.000Z',
    now: '2026-05-05T12:45:00.000Z',
  });

  assert.equal(intent.status, 'code_ready');
  assert.equal(intent.gatewayId, 'telegram');
  assert.equal(intent.displayCode, 'TG 7KQ 9Z2');
  assert.equal(intent.title, 'Connect Telegram');
  assert.equal(intent.actionLabel, 'Copy code');
  assert.match(intent.body, /Send this code to your Delegent AI bot on Telegram/);
  assert.doesNotMatch(JSON.stringify(intent), /supabase|oauth|railway|cloudflare|openrouter|hermes|service-role|api key|secret|container|runtime|\bworker\b/i);
});

test('Telegram missing-code intent stays honest without saying the route is coming later', () => {
  const intent = resolveGatewayConnectIntent({ gatewayId: 'telegram', code: null, expiresAt: null, now: '2026-05-05T12:45:00.000Z' });

  assert.equal(intent.status, 'not_ready');
  assert.equal(intent.title, 'Telegram is being connected');
  assert.equal(intent.actionLabel, 'Waiting for code');
  assert.equal(intent.canStart, false);
  assert.doesNotMatch(`${intent.title} ${intent.body} ${intent.actionLabel}`, /coming later/i);
});

test('connect code normalization rejects unsafe or ambiguous values', () => {
  assert.equal(normalizeGatewayConnectCode(' tg 7kq 9z2 '), 'TG7KQ9Z2');
  assert.equal(normalizeGatewayConnectCode('DROP TABLE'), null);
  assert.equal(normalizeGatewayConnectCode('abc'), null);
  assert.equal(normalizeGatewayConnectCode('abcdefghijklm'), null);
});

test('expired Telegram connect intent tells the app to request a fresh code', () => {
  const intent = resolveGatewayConnectIntent({
    gatewayId: 'telegram',
    code: 'tg-7kq9z2',
    expiresAt: '2026-05-05T12:40:00.000Z',
    now: '2026-05-05T12:45:00.000Z',
  });

  assert.equal(intent.status, 'expired');
  assert.equal(intent.displayCode, null);
  assert.equal(intent.actionLabel, 'Get a new code');
  assert.match(intent.body, /expired/);
});

test('demo Sidekick state resolves ready and remains product-safe for mobile preview', () => {
  const demo = createDemoSidekickState();
  const gate = resolveSidekickGate(demo);
  assert.equal(gate.kind, 'ready');
  assert.equal(demo.profile?.email, 'alex@coworker.ai');
  assert.deepEqual(demo.connections.map((connection) => connection.id), ['telegram', 'whatsapp', 'signal', 'email']);
  assert.equal(demo.connections.some((connection) => connection.status === 'live'), false);
  assert.equal('railwayProjectId' in (demo.hermesInstance ?? {}), false);
});

// Feature 3 — coworker engine update lifecycle, surfaced mobile-safe.
function coworkerRow(overrides = {}) {
  return {
    user_id: profile.id,
    email: profile.email,
    full_name: profile.fullName,
    agent_name: 'Ruben',
    avatar_url: null,
    region: 'United Kingdom',
    profile_created_at: profile.createdAt,
    profile_updated_at: null,
    acknowledgement_accepted: true,
    acknowledgement_accepted_at: acknowledgement.acceptedAt,
    acknowledgement_text_version: ACKNOWLEDGEMENT_VERSION,
    subscription_status: 'active',
    tier_id: 'studio',
    current_period_start: activeSubscription.currentPeriodStart,
    current_period_end: activeSubscription.currentPeriodEnd,
    cancel_at_period_end: false,
    worker_status: 'ready',
    last_health_at: null,
    ready_at: '2026-05-01T09:15:00.000Z',
    error_code: null,
    public_status_message: null,
    monthly_token_quota: 1000,
    used_tokens: 0,
    remaining_tokens: 1000,
    usage_ratio: 0,
    usage_near_limit: false,
    usage_hard_limited: false,
    queue_count: 0,
    telegram_connected: false,
    gate_kind: 'ready',
    ...overrides,
  };
}

test('mapMyProductStateRow surfaces the mobile-safe coworker update fields', () => {
  const mapped = mapMyProductStateRow(coworkerRow({
    coworker_update_available: true,
    coworker_update_status: 'available',
    reimage_requested_at: null,
    reimaged_at: '2026-04-01T00:00:00.000Z',
  }));
  assert.equal(mapped.hermesInstance?.coworkerUpdateAvailable, true);
  assert.equal(mapped.hermesInstance?.coworkerUpdateStatus, 'available');
  assert.equal(mapped.hermesInstance?.reimagedAt, '2026-04-01T00:00:00.000Z');
  // No infra internals must ever leak through the mapper.
  assert.equal('railwayProjectId' in (mapped.hermesInstance ?? {}), false);
  assert.equal('image_ref' in (mapped.hermesInstance ?? {}), false);
});

test('isCoworkerUpdateAvailable is true only when flagged available and not mid-update', () => {
  const available = mapMyProductStateRow(coworkerRow({ coworker_update_available: true, coworker_update_status: 'available' }));
  assert.equal(isCoworkerUpdateAvailable(available.hermesInstance), true);
  assert.equal(isCoworkerUpdating(available.hermesInstance), false);

  const updating = mapMyProductStateRow(coworkerRow({ coworker_update_available: true, coworker_update_status: 'updating' }));
  assert.equal(isCoworkerUpdateAvailable(updating.hermesInstance), false, 'mid-update must not re-offer the button');
  assert.equal(isCoworkerUpdating(updating.hermesInstance), true);
});

test('coworker update helpers default to false when the platform has not flagged anything (backward compatible)', () => {
  const legacy = mapMyProductStateRow(coworkerRow());
  assert.equal(isCoworkerUpdateAvailable(legacy.hermesInstance), false);
  assert.equal(isCoworkerUpdating(legacy.hermesInstance), false);
  assert.equal(isCoworkerUpdateAvailable(null), false);
  assert.equal(isCoworkerUpdating(undefined), false);
});
