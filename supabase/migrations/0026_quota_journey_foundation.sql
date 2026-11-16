-- 0026 — quota-journey foundation (AGENT_TODO_CHECKLIST §2.5 / Batch 4a)
--
-- Adds the schema the Worker needs to enforce the per-tier caps designed in
-- docs/INTEGRATION_USAGE_CAPS.md and surface the friendly out-of-credits journey
-- copy in docs/QUOTA_JOURNEY.md:
--
--   1. Per-tier storage + voice caps + per-user consumption counters on
--      usage_quotas (current schema only tracks token quota).
--   2. usage_violations ledger so support + future incident-response can see
--      when a user hit a cap, what they tried, and when.
--   3. delegent_billing_guard singleton — org-wide spend ceiling protecting us
--      from the failure mode where the OpenRouter free tier disappears and
--      runaway usage burns unplanned money before per-user caps catch it.
--
-- The Worker's token-cap window also moves from a calendar-month boundary to
-- the user's actual Stripe billing-cycle boundary (subscriptions.current_period_start
-- already exists per 0002). That's a code change, not a schema change — handled
-- in the Worker patch that lands alongside this migration.

-- 1. New per-tier capacity columns on usage_quotas + consumption counters.
alter table public.usage_quotas
  add column if not exists storage_quota_bytes bigint not null default 10737418240;        -- 10 GB
alter table public.usage_quotas
  add column if not exists voice_seconds_quota int not null default 3600;                  -- 60 min
alter table public.usage_quotas
  add column if not exists consumed_storage_bytes bigint not null default 0;
alter table public.usage_quotas
  add column if not exists consumed_voice_seconds int not null default 0;
alter table public.usage_quotas
  add column if not exists billing_cycle_anchor timestamptz;                                -- mirror of subscriptions.current_period_start; null = fall back to calendar month

-- Non-negative constraints (mirror the existing token-quota check).
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'usage_quotas'
      and constraint_name = 'usage_quotas_storage_nonneg_check'
  ) then
    alter table public.usage_quotas
      add constraint usage_quotas_storage_nonneg_check
      check (storage_quota_bytes >= 0 and consumed_storage_bytes >= 0);
  end if;

  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'usage_quotas'
      and constraint_name = 'usage_quotas_voice_nonneg_check'
  ) then
    alter table public.usage_quotas
      add constraint usage_quotas_voice_nonneg_check
      check (voice_seconds_quota >= 0 and consumed_voice_seconds >= 0);
  end if;
end$$;

-- 2. Violations ledger.
create table if not exists public.usage_violations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  cap_kind text not null,                                                                    -- 'token' | 'storage' | 'voice' | 'concurrent' | 'rate' | 'global_spend'
  requested bigint not null default 0,
  available bigint not null default 0,
  billing_cycle_start timestamptz,
  notes text,
  occurred_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'usage_violations'
      and constraint_name = 'usage_violations_cap_kind_check'
  ) then
    alter table public.usage_violations
      add constraint usage_violations_cap_kind_check
      check (cap_kind in ('token', 'storage', 'voice', 'concurrent', 'rate', 'global_spend'));
  end if;
end$$;

create index if not exists usage_violations_user_idx     on public.usage_violations (user_id, occurred_at desc);
create index if not exists usage_violations_kind_idx     on public.usage_violations (cap_kind, occurred_at desc);

alter table public.usage_violations enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'usage_violations'
      and policyname = 'own usage_violations read'
  ) then
    create policy "own usage_violations read"
      on public.usage_violations for select
      using (auth.uid() = user_id);
  end if;
end$$;

-- 3. Org-wide spend guard (singleton row enforced via primary-key partial index).
create table if not exists public.delegent_billing_guard (
  id smallint primary key default 1,
  monthly_budget_gbp_pence bigint not null default 750000,                                   -- £7,500
  monthly_spend_gbp_pence  bigint not null default 0,
  spend_cycle_start        timestamptz not null default date_trunc('month', now() at time zone 'utc'),
  updated_at               timestamptz not null default now()
);

-- Force singleton: only the row with id=1 can exist.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'public'
      and table_name   = 'delegent_billing_guard'
      and constraint_name = 'delegent_billing_guard_singleton_check'
  ) then
    alter table public.delegent_billing_guard
      add constraint delegent_billing_guard_singleton_check check (id = 1);
  end if;
end$$;

-- Seed the singleton if missing.
insert into public.delegent_billing_guard (id) values (1) on conflict (id) do nothing;

-- The guard is org-internal: no client-facing SELECT, no INSERT/UPDATE from
-- anon/auth roles. Worker uses service-role which bypasses RLS, so we still
-- enable RLS to lock everyone else out.
alter table public.delegent_billing_guard enable row level security;
-- (intentionally no policies — RLS-on without policies = service-role only)

-- 4. Helper view: per-user current-cycle usage summary, billing-cycle aware.
-- The Worker can SELECT from this in one round-trip instead of joining
-- subscriptions → token_usage_events itself.
create or replace view public.usage_cycle_summary as
select
  uq.user_id,
  uq.tier_id,
  uq.monthly_token_quota,
  uq.storage_quota_bytes,
  uq.voice_seconds_quota,
  uq.consumed_storage_bytes,
  uq.consumed_voice_seconds,
  coalesce(
    s.current_period_start,
    date_trunc('month', now() at time zone 'utc')
  ) as cycle_start,
  s.current_period_end as cycle_end,
  coalesce(s.status, 'inactive') as subscription_status,
  coalesce((
    select sum(t.total_tokens)::bigint
    from public.token_usage_events t
    where t.user_id = uq.user_id
      and t.created_at >= coalesce(
        s.current_period_start,
        date_trunc('month', now() at time zone 'utc')
      )
  ), 0) as consumed_tokens_this_cycle
from public.usage_quotas uq
left join public.subscriptions s on s.user_id = uq.user_id;

-- The view should be readable by the user it concerns (via service-role on the
-- Worker side; the mobile reads via product_state_for_user instead, so we
-- explicitly grant nothing to anon/auth — service-role bypasses).
revoke all on public.usage_cycle_summary from anon, authenticated;
