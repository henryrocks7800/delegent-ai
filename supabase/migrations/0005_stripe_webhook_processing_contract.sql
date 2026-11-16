-- =============================================================================
-- 0005_stripe_webhook_processing_contract.sql
-- =============================================================================
-- Hardens the real Stripe webhook route against retry/race edge cases that
-- cannot be solved safely with a plain insert/read idempotency ledger:
--   1. Adds an explicit processing lease state for billing_events claims.
--   2. Keeps terminal processed/ignored duplicate events as safe no-ops, while
--      nonterminal/expired events remain retryable or claimable.
--   3. Adds provider_updated_at columns so webhook ordering is based on Stripe
--      event time, not trigger-managed updated_at timestamps.
-- =============================================================================

begin;

alter table public.billing_events add column if not exists processing_started_at timestamptz;
alter table public.billing_events add column if not exists processing_expires_at timestamptz;

alter table public.subscriptions add column if not exists provider_updated_at timestamptz;
alter table public.usage_quotas add column if not exists provider_updated_at timestamptz;

-- Existing rows predate provider ordering. Backfill with the application
-- timestamp only as a migration baseline; new webhook writes use Stripe event
-- created_at via the server route.
update public.subscriptions
set provider_updated_at = updated_at
where provider_updated_at is null;

update public.usage_quotas
set provider_updated_at = updated_at
where provider_updated_at is null;

alter table public.billing_events drop constraint if exists billing_events_status_check;
alter table public.billing_events add constraint billing_events_status_check check (
  status in ('received', 'processing', 'processed', 'ignored', 'failed')
);

alter table public.billing_events drop constraint if exists billing_events_processed_at_check;
alter table public.billing_events add constraint billing_events_processed_at_check check (
  (status in ('received', 'processing') and processed_at is null)
  or (status in ('processed', 'ignored', 'failed') and processed_at is not null)
);

alter table public.billing_events drop constraint if exists billing_events_processing_lease_check;
alter table public.billing_events add constraint billing_events_processing_lease_check check (
  status <> 'processing'
  or (
    processing_started_at is not null
    and processing_expires_at is not null
    and processing_expires_at > processing_started_at
  )
);

alter table public.subscriptions drop constraint if exists subscriptions_provider_updated_active_check;
alter table public.subscriptions add constraint subscriptions_provider_updated_active_check check (
  status not in ('trialing', 'active', 'past_due')
  or provider_updated_at is not null
);

create index if not exists billing_events_processing_lease_idx
  on public.billing_events(processing_expires_at)
  where status = 'processing';

create index if not exists subscriptions_provider_updated_idx
  on public.subscriptions(user_id, provider_updated_at desc);

create index if not exists usage_quotas_provider_updated_idx
  on public.usage_quotas(user_id, provider_updated_at desc);

commit;
