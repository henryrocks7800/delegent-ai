// Series 4 — Stripe webhook lifecycle hook unit tests.
//
// shouldSuspendSeries4Runner is the only purely-functional decision in the
// hook path; the rest is plumbing into the existing Stripe webhook handler.
// The handler invokes deps.store.markSeries4RunnerSuspended only when this
// returns true, so testing the predicate directly is enough to prove the
// "no suspension on past_due, suspension on canceled" invariant.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSupabaseStripeBillingStore,
  handleStripeWebhookRequest,
  shouldSuspendSeries4Runner,
} from '../dist/stripe-flow.js';

test('shouldSuspendSeries4Runner returns true ONLY for canceled', () => {
  assert.equal(shouldSuspendSeries4Runner('canceled'), true);
});

test('shouldSuspendSeries4Runner keeps past_due users running (entitlement retry window)', () => {
  assert.equal(shouldSuspendSeries4Runner('past_due'), false);
});

test('shouldSuspendSeries4Runner returns false for active / trialing / inactive', () => {
  assert.equal(shouldSuspendSeries4Runner('active'), false);
  assert.equal(shouldSuspendSeries4Runner('trialing'), false);
  assert.equal(shouldSuspendSeries4Runner('inactive'), false);
});

test('shouldSuspendSeries4Runner tolerates null / undefined / unknown values', () => {
  assert.equal(shouldSuspendSeries4Runner(null), false);
  assert.equal(shouldSuspendSeries4Runner(undefined), false);
  // intentionally cast — guarding the runtime check
  assert.equal(shouldSuspendSeries4Runner(/** @type {any} */ ('whatever_status')), false);
});

const userId = '11111111-1111-4111-8111-111111111111';
const webhookEnv = {
  STRIPE_WEBHOOK_SECRET: 'whsec_worker_observability_test',
  SUPABASE_URL: 'https://unit.supabase.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service_role_test_secret',
};

function signedWorkerWebhookRequest(event) {
  return new Request('https://worker.sidekick.test/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 'unit_signature_present' },
    body: JSON.stringify(event),
  });
}

function checkoutCompletedEvent(overrides = {}) {
  return {
    id: 'evt_worker_checkout_completed_123',
    type: 'checkout.session.completed',
    created: 0,
    data: {
      object: {
        id: 'cs_worker_observability_123',
        client_reference_id: userId,
        customer: 'cus_worker_observability',
        subscription: {
          id: 'sub_worker_observability',
          status: 'active',
          current_period_start: 0,
          current_period_end: 3600,
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: {
                  id: 'price_worker_pro',
                  lookup_key: 'sidekick_pro_office_monthly',
                },
              },
            ],
          },
        },
        metadata: {
          priceLookupKey: 'sidekick_pro_office_monthly',
        },
      },
    },
    ...overrides,
  };
}

test('R-OBS-04 webhook records a retryable failure when the entitlement transaction fails', async () => {
  const provisioningEvents = [];
  const billingUpdates = [];
  const store = {
    async claimBillingEvent(input) {
      return {
        state: 'claimed',
        event: {
          id: 'billing_event_observability',
          provider: input.provider,
          provider_event_id: input.provider_event_id,
          event_type: input.event_type,
          idempotency_key: input.idempotency_key,
          payload_hash: input.payload_hash,
          status: 'processing',
          user_id: input.user_id,
          error_code: null,
          processed_at: null,
          processing_started_at: new Date(0).toISOString(),
          processing_expires_at: new Date(5 * 60 * 1000).toISOString(),
        },
      };
    },
    async updateBillingEvent(_id, patch) {
      billingUpdates.push({ ...patch });
    },
    async upsertSubscription() {
      return true;
    },
    async applyEntitlement() {
      throw new Error('billing_entitlement_apply_failed_40001');
    },
    async enqueueHermesProvisioning() {
      throw new Error('stale quota skip must not enqueue provisioning');
    },
    async recordProvisioningEvent(input) {
      provisioningEvents.push(structuredClone(input));
    },
  };

  const response = await handleStripeWebhookRequest(
    signedWorkerWebhookRequest(checkoutCompletedEvent()),
    {
      env: webhookEnv,
      store,
      async verifyStripeWebhookEvent(rawBody) {
        return JSON.parse(rawBody);
      },
    },
  );

  assert.equal(response.status, 500);
  assert.deepEqual(provisioningEvents, []);
  assert.equal(billingUpdates.at(-1)?.status, 'failed');
  assert.equal(billingUpdates.at(-1)?.error_code, 'billing_entitlement_apply_failed_40001');
});

test('R-OBS-04 Worker real Supabase Stripe webhook preserves upstream Supabase error code in failed billing ledger', async () => {
  const billingUpdates = [];
  const store = createSupabaseStripeBillingStore({
    async rpc(name) {
      assert.equal(name, 'apply_billing_entitlement');
      return { error: { code: '23503', message: `User ${userId} does not exist` } };
    },
    from(table) {
      if (table === 'billing_events') {
        return {
          insert(row) {
            return {
              select() {
                return {
                  async single() {
                    return {
                      error: null,
                      data: {
                        id: 'billing_event_postgrest_failure',
                        provider: row.provider,
                        provider_event_id: row.provider_event_id,
                        event_type: row.event_type,
                        idempotency_key: row.idempotency_key,
                        payload_hash: row.payload_hash,
                        status: 'processing',
                        user_id: row.user_id,
                        error_code: null,
                        processed_at: null,
                        processing_started_at: row.processing_started_at,
                        processing_expires_at: row.processing_expires_at,
                      },
                    };
                  },
                };
              },
            };
          },
          update(value) {
            billingUpdates.push(structuredClone(value));
            return {
              async eq() {
                return { error: null };
              },
            };
          },
        };
      }
      if (table === 'subscriptions') {
        return {
          async insert() {
            return { error: null };
          },
        };
      }
      if (table === 'usage_quotas') {
        return {
          async insert() {
            return {
              error: {
                code: '23503',
                message: 'insert or update on table "usage_quotas" violates foreign key constraint "usage_quotas_user_id_fkey"',
                details: `Key (user_id)=(${userId}) is not present in table "users".`,
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  });

  const response = await handleStripeWebhookRequest(
    signedWorkerWebhookRequest(checkoutCompletedEvent()),
    {
      env: webhookEnv,
      store,
      async verifyStripeWebhookEvent(rawBody) {
        return JSON.parse(rawBody);
      },
    },
  );

  assert.equal(response.status, 500);
  assert.match(String(billingUpdates.at(-1)?.error_code), /^billing_entitlement_apply_failed_23503/);
  assert.doesNotMatch(String(billingUpdates.at(-1)?.error_code), /11111111-1111-4111-8111-111111111111/);
});

test('R-PROV-05 Supabase Stripe store refreshes an unclaimed queued Fly job when Stripe upgrades the tier before provisioner claim', async () => {
  const operations = [];
  const store = createSupabaseStripeBillingStore({
    from(table) {
      return {
        update(value) {
          operations.push({ op: 'update', table, value: structuredClone(value) });
          return {
            eq(column, value) {
              operations.push({ op: 'eq', table, value: { column, value } });
              return {
                in(column, values) {
                  operations.push({ op: 'in', table, value: { column, values: [...values] } });
                  return {
                    select(value) {
                      operations.push({ op: 'select', table, value });
                      return {
                        async maybeSingle() {
                          return values.includes('queued')
                            ? { data: { user_id: userId }, error: null }
                            : { data: null, error: null };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
        insert(value) {
          operations.push({ op: 'insert', table, value: structuredClone(value) });
          if (table === 'hermes_instances') {
            return {
              select() {
                return {
                  async maybeSingle() {
                    return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
                  },
                };
              },
            };
          }
          return { error: null };
        },
      };
    },
  });

  await store.enqueueHermesProvisioning({
    user_id: userId,
    tier_id: 'enterprise-suite',
    billing_event_id: 'billing_event_upgrade_123',
    provider_event_id: 'evt_upgrade_123',
    idempotency_key: 'hermes-provisioning:evt_upgrade_123',
    requested_at: '2026-05-22T06:33:48.193Z',
    public_status_message: "Your coworker's cloud computer is queued for setup.",
  });

  const statusGate = operations.find((operation) => operation.op === 'in' && operation.table === 'hermes_instances');
  assert.deepEqual(
    statusGate?.value,
    // 'deleted' joined the list in the 2026-06-10 defect hunt (H3): a
    // returning customer whose workspace was grace-expired must re-enqueue,
    // not rot on a terminal error gate while paying.
    { column: 'status', values: ['not_requested', 'error', 'queued', 'deleted'] },
    'queued-but-unclaimed workspaces must be eligible for a tier/idempotency refresh before provisioner claim',
  );
  const hermesUpdate = operations.find((operation) => operation.op === 'update' && operation.table === 'hermes_instances');
  assert.equal(hermesUpdate?.value.provider, 'fly_machines');
  assert.equal(hermesUpdate?.value.provisioning_tier_id, 'enterprise-suite');
  assert.equal(hermesUpdate?.value.provisioning_idempotency_key, 'hermes-provisioning:evt_upgrade_123');
  const eventInsert = operations.find((operation) => operation.op === 'insert' && operation.table === 'provisioning_events');
  assert.deepEqual(eventInsert?.value.details, {
    tier_id: 'enterprise-suite',
    requested_at: '2026-05-22T06:33:48.193Z',
    reason: 'stripe_entitlement_active',
  });
  assert.doesNotMatch(JSON.stringify(eventInsert?.value), /billing_event_upgrade_123|evt_upgrade_123|hermes-provisioning/);
});

test('R-OBS-04 real Supabase Stripe store exposes recordProvisioningEvent for webhook skip observability', async () => {
  const inserts = [];
  const store = createSupabaseStripeBillingStore({
    from(table) {
      return {
        async insert(row) {
          inserts.push({ table, row: structuredClone(row) });
          return { error: null };
        },
      };
    },
  });

  assert.equal(typeof store.recordProvisioningEvent, 'function');
  await store.recordProvisioningEvent({
    userId,
    event: 'hermes_provisioning_skipped',
    details: {
      reason: 'usage_quota_upsert_failed',
      subscriptionApplied: true,
      usageQuotaApplied: false,
      shouldPrepareCoworker: true,
      ledger_id: 'billing_event_observability',
    },
  });

  assert.deepEqual(inserts, [
    {
      table: 'provisioning_events',
      row: {
        user_id: userId,
        event: 'hermes_provisioning_skipped',
        details: {
          reason: 'usage_quota_upsert_failed',
          subscriptionApplied: true,
          usageQuotaApplied: false,
          shouldPrepareCoworker: true,
          ledger_id: 'billing_event_observability',
        },
      },
    },
  ]);
});
