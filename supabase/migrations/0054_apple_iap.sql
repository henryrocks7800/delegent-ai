-- Apple in-app purchase as a second billing provider alongside Stripe.
--
-- THE CONSTRAINT THAT MAKES THIS MIGRATION NECESSARY
--   `subscriptions_active_requires_provider_ids_check` (migration 0004) says an
--   active/trialing/past_due row MUST carry stripe_customer_id,
--   stripe_subscription_id and price_id. An Apple subscription has none of
--   those: it has an originalTransactionId and a product id. Without this
--   migration every Apple activation fails on a check constraint, and it fails
--   at write time in the Worker where it is easy to misread as an auth problem.
--
--   So the constraint is replaced with a provider-aware version rather than
--   dropped. Stripe rows keep exactly the guarantee they had; Apple rows get
--   the equivalent one. Dropping it outright would let a half-written row of
--   either kind go active.
--
-- ONE APPLE SUBSCRIPTION, ONE ACCOUNT
--   apple_original_transaction_id is UNIQUE. Apple identifies a subscription by
--   originalTransactionId, which belongs to an Apple ID, not to us. Without the
--   unique index one Apple ID could be replayed against several Delegent
--   accounts and entitle all of them from a single payment. The Worker checks
--   this too, but the database is where it has to be true.

begin;

alter table public.subscriptions
  add column if not exists billing_provider text not null default 'stripe';

alter table public.subscriptions
  add column if not exists apple_original_transaction_id text;

alter table public.subscriptions
  add column if not exists apple_product_id text;

-- The environment the transaction came from. Sandbox rows must never be
-- mistaken for real money: a sandbox purchase is free and infinitely
-- repeatable, so anything reporting revenue has to be able to exclude them.
alter table public.subscriptions
  add column if not exists apple_environment text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_billing_provider_check') then
    alter table public.subscriptions add constraint subscriptions_billing_provider_check
      check (billing_provider in ('stripe', 'apple'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'subscriptions_apple_environment_check') then
    alter table public.subscriptions add constraint subscriptions_apple_environment_check
      check (apple_environment is null or apple_environment in ('Sandbox', 'Production'));
  end if;

  -- Apple identifiers belong only to Apple rows, and vice versa. This is what
  -- stops a half-migrated row claiming to be both.
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_apple_ids_shape_check') then
    alter table public.subscriptions add constraint subscriptions_apple_ids_shape_check check (
      (billing_provider = 'apple')
      or (apple_original_transaction_id is null and apple_product_id is null and apple_environment is null)
    );
  end if;
end $$;

-- Replace the Stripe-only rule with the provider-aware one. Dropped by name
-- first so re-running this migration is safe.
alter table public.subscriptions
  drop constraint if exists subscriptions_active_requires_provider_ids_check;

alter table public.subscriptions
  add constraint subscriptions_active_requires_provider_ids_check check (
    status not in ('trialing', 'active', 'past_due')
    or (
      billing_provider = 'stripe'
      and stripe_customer_id is not null
      and stripe_subscription_id is not null
      and price_id is not null
      and current_period_start is not null
      and current_period_end is not null
    )
    or (
      billing_provider = 'apple'
      and apple_original_transaction_id is not null
      and apple_product_id is not null
      and current_period_start is not null
      and current_period_end is not null
    )
  );

create unique index if not exists subscriptions_apple_original_transaction_idx
  on public.subscriptions(apple_original_transaction_id)
  where apple_original_transaction_id is not null;

-- An append-only record of every Apple notification and verification we acted
-- on. Two jobs: idempotency (Apple retries notifications, and a retry must not
-- double-apply), and an audit trail for a refund dispute months later.
create table if not exists public.apple_iap_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  notification_uuid text,
  notification_type text,
  subtype text,
  original_transaction_id text,
  transaction_id text,
  product_id text,
  environment text,
  applied boolean not null default false,
  -- Why we did or did not act. Populated on the refusal paths too, because
  -- "nothing happened" is the case that is hardest to diagnose later.
  outcome text,
  received_at timestamptz not null default now()
);

-- Apple's own dedup key. Unique so a retried notification is a no-op rather
-- than a second grant. Partial, because the verification path has no
-- notification uuid and must still be able to insert.
create unique index if not exists apple_iap_events_notification_uuid_idx
  on public.apple_iap_events(notification_uuid)
  where notification_uuid is not null;

create index if not exists apple_iap_events_original_transaction_idx
  on public.apple_iap_events(original_transaction_id, received_at desc);

alter table public.apple_iap_events enable row level security;

-- No policies at all, deliberately. RLS with zero policies denies every row to
-- any role that does not bypass it, and only the Worker's service role should
-- ever read this. The revokes below are the belt to that braces: migration
-- 0051 proved that enabling RLS alone leaves anon and authenticated holding
-- the grants Supabase hands out by default, and 0052 had to come back and fix
-- it. Do both, in the same migration, every time.
revoke all on public.apple_iap_events from anon;
revoke all on public.apple_iap_events from authenticated;

commit;
