-- =============================================================================
-- 0004_subscription_data_model.sql
-- =============================================================================
-- Credential-free Stripe/subscription data-model hardening.
--
-- This migration prepares the database for real Stripe webhook processing
-- without adding any provider credentials. It adds:
--   1. A service-owned billing_events ledger for webhook idempotency/auditing.
--   2. Constraints that keep active subscription entitlement tied to
--      provider-owned Stripe identifiers.
--   3. Period/status/identifier shape checks that fail closed before a webhook
--      patch can create an ambiguous entitlement row.
--
-- The mobile/client-facing product-state view deliberately does not expose
-- provider event ids, Stripe ids, price ids, payload hashes, or raw payloads.
-- =============================================================================

begin;

create table if not exists public.billing_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'stripe',
  provider_event_id text not null,
  event_type text not null,
  user_id uuid references public.profiles(id) on delete set null,
  status text not null default 'received',
  idempotency_key text not null,
  payload_hash text,
  error_code text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.billing_events enable row level security;

-- No authenticated/anon policies are created for billing_events. The table is
-- service-owned: webhooks may insert/update through the server role only, while
-- users see safe subscription state through public.my_product_state.
revoke all on public.billing_events from anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_events_provider_check') then
    alter table public.billing_events add constraint billing_events_provider_check check (provider = 'stripe');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_events_status_check') then
    alter table public.billing_events add constraint billing_events_status_check check (status in ('received', 'processed', 'ignored', 'failed'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_events_event_id_not_blank_check') then
    alter table public.billing_events add constraint billing_events_event_id_not_blank_check check (btrim(provider_event_id) <> '');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_events_type_not_blank_check') then
    alter table public.billing_events add constraint billing_events_type_not_blank_check check (btrim(event_type) <> '');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_events_idempotency_key_not_blank_check') then
    alter table public.billing_events add constraint billing_events_idempotency_key_not_blank_check check (btrim(idempotency_key) <> '');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_events_payload_hash_shape_check') then
    alter table public.billing_events add constraint billing_events_payload_hash_shape_check check (payload_hash is null or payload_hash ~ '^[a-f0-9]{64}$');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'billing_events_processed_at_check') then
    alter table public.billing_events add constraint billing_events_processed_at_check check ((status = 'received' and processed_at is null) or (status <> 'received' and processed_at is not null));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'subscriptions_period_order_check') then
    alter table public.subscriptions add constraint subscriptions_period_order_check check (
      current_period_start is null
      or current_period_end is null
      or current_period_end >= current_period_start
    );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'subscriptions_stripe_customer_shape_check') then
    alter table public.subscriptions add constraint subscriptions_stripe_customer_shape_check check (
      stripe_customer_id is null or (btrim(stripe_customer_id) <> '' and stripe_customer_id like 'cus_%')
    );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'subscriptions_stripe_subscription_shape_check') then
    alter table public.subscriptions add constraint subscriptions_stripe_subscription_shape_check check (
      stripe_subscription_id is null or (btrim(stripe_subscription_id) <> '' and stripe_subscription_id like 'sub_%')
    );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'subscriptions_price_shape_check') then
    alter table public.subscriptions add constraint subscriptions_price_shape_check check (
      price_id is null or (btrim(price_id) <> '' and price_id like 'price_%')
    );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'subscriptions_active_requires_provider_ids_check') then
    alter table public.subscriptions add constraint subscriptions_active_requires_provider_ids_check check (
      status not in ('trialing', 'active', 'past_due')
      or (
        stripe_customer_id is not null
        and stripe_subscription_id is not null
        and price_id is not null
        and current_period_start is not null
        and current_period_end is not null
      )
    );
  end if;
end $$;

create unique index if not exists billing_events_provider_event_id_idx on public.billing_events(provider, provider_event_id);
create unique index if not exists billing_events_idempotency_key_idx on public.billing_events(idempotency_key);
create index if not exists billing_events_user_created_idx on public.billing_events(user_id, created_at desc) where user_id is not null;
create index if not exists billing_events_status_created_idx on public.billing_events(status, created_at desc);

commit;
