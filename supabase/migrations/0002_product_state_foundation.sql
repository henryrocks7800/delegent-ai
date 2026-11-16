begin;

alter table public.profiles add column if not exists updated_at timestamptz not null default now();
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists region text;

alter table public.subscriptions add column if not exists tier_id text not null default 'studio';
alter table public.subscriptions add column if not exists current_period_start timestamptz;
alter table public.subscriptions add column if not exists cancel_at_period_end boolean not null default false;

alter table public.hermes_instances add column if not exists ready_at timestamptz;
alter table public.hermes_instances add column if not exists error_code text;
alter table public.hermes_instances add column if not exists public_status_message text;

alter table public.usage_quotas add column if not exists tier_id text not null default 'studio';

create table if not exists public.hermes_instance_private (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  railway_project_id text,
  railway_service_id text,
  railway_volume_id text,
  runner_base_url text,
  raw_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.task_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,
  status text not null default 'queued',
  instruction text not null,
  runner_task_id text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  task_run_id uuid references public.task_runs(id) on delete set null,
  title text not null,
  kind text not null,
  detail text not null default '',
  status text not null default 'ready',
  storage_path text,
  viewer_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.hermes_instance_private enable row level security;
alter table public.task_runs enable row level security;
alter table public.artifacts enable row level security;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_status_check') then
    alter table public.subscriptions add constraint subscriptions_status_check check (status in ('inactive', 'trialing', 'active', 'past_due', 'canceled'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subscriptions_tier_id_check') then
    alter table public.subscriptions add constraint subscriptions_tier_id_check check (tier_id in ('studio', 'pro-office', 'enterprise-suite'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hermes_instances_status_check') then
    alter table public.hermes_instances add constraint hermes_instances_status_check check (status in ('not_requested', 'queued', 'provisioning', 'ready', 'degraded', 'error'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_role_check') then
    alter table public.messages add constraint messages_role_check check (role in ('user', 'assistant', 'system'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'token_usage_nonnegative_check') then
    alter table public.token_usage_events add constraint token_usage_nonnegative_check check (prompt_tokens >= 0 and completion_tokens >= 0 and total_tokens >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'usage_quotas_nonnegative_check') then
    alter table public.usage_quotas add constraint usage_quotas_nonnegative_check check (monthly_token_quota >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'usage_quotas_tier_id_check') then
    alter table public.usage_quotas add constraint usage_quotas_tier_id_check check (tier_id in ('studio', 'pro-office', 'enterprise-suite'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_runs_status_check') then
    alter table public.task_runs add constraint task_runs_status_check check (status in ('queued', 'running', 'succeeded', 'failed', 'canceled'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'artifacts_status_check') then
    alter table public.artifacts add constraint artifacts_status_check check (status in ('ready', 'review', 'saved', 'archived'));
  end if;
end $$;

create index if not exists messages_user_created_idx on public.messages(user_id, created_at desc);
create index if not exists token_usage_events_user_created_idx on public.token_usage_events(user_id, created_at desc);
create index if not exists provisioning_events_user_created_idx on public.provisioning_events(user_id, created_at desc);
create index if not exists task_runs_user_created_idx on public.task_runs(user_id, created_at desc);
create index if not exists artifacts_user_created_idx on public.artifacts(user_id, created_at desc);
create unique index if not exists subscriptions_stripe_customer_id_idx on public.subscriptions(stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists subscriptions_stripe_subscription_id_idx on public.subscriptions(stripe_subscription_id) where stripe_subscription_id is not null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at before update on public.subscriptions for each row execute function public.set_updated_at();
drop trigger if exists hermes_instances_set_updated_at on public.hermes_instances;
create trigger hermes_instances_set_updated_at before update on public.hermes_instances for each row execute function public.set_updated_at();
drop trigger if exists usage_quotas_set_updated_at on public.usage_quotas;
create trigger usage_quotas_set_updated_at before update on public.usage_quotas for each row execute function public.set_updated_at();
drop trigger if exists task_runs_set_updated_at on public.task_runs;
create trigger task_runs_set_updated_at before update on public.task_runs for each row execute function public.set_updated_at();
drop trigger if exists artifacts_set_updated_at on public.artifacts;
create trigger artifacts_set_updated_at before update on public.artifacts for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'))
  on conflict (id) do nothing;

  insert into public.subscriptions (user_id, status, tier_id)
  values (new.id, 'inactive', 'studio')
  on conflict (user_id) do nothing;

  insert into public.hermes_instances (user_id, status, public_status_message)
  values (new.id, 'not_requested', 'Waiting for subscription activation')
  on conflict (user_id) do nothing;

  insert into public.usage_quotas (user_id, monthly_token_quota, tier_id)
  values (new.id, 200000, 'studio')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

insert into public.subscriptions (user_id, status, tier_id)
select id, 'inactive', 'studio' from public.profiles
on conflict (user_id) do nothing;

insert into public.hermes_instances (user_id, status, public_status_message)
select id, 'not_requested', 'Waiting for subscription activation' from public.profiles
on conflict (user_id) do nothing;

insert into public.usage_quotas (user_id, monthly_token_quota, tier_id)
select id, 200000, 'studio' from public.profiles
on conflict (user_id) do nothing;

drop policy if exists "own acknowledgements" on public.acknowledgements;
drop policy if exists "acknowledgements read own" on public.acknowledgements;
drop policy if exists "acknowledgements insert own" on public.acknowledgements;
create policy "acknowledgements read own" on public.acknowledgements for select using (auth.uid() = user_id);
create policy "acknowledgements insert own" on public.acknowledgements for insert with check (auth.uid() = user_id and text_version = 'v1');

drop policy if exists "own messages" on public.messages;
drop policy if exists "messages read own" on public.messages;
drop policy if exists "messages insert own user messages" on public.messages;
create policy "messages read own" on public.messages for select using (auth.uid() = user_id);
create policy "messages insert own user messages" on public.messages for insert with check (auth.uid() = user_id and role = 'user');

drop policy if exists "task runs read own" on public.task_runs;
drop policy if exists "artifacts read own" on public.artifacts;
create policy "task runs read own" on public.task_runs for select using (auth.uid() = user_id);
create policy "artifacts read own" on public.artifacts for select using (auth.uid() = user_id);

revoke all on public.hermes_instance_private from anon, authenticated;
revoke select on public.hermes_instances from authenticated;

create or replace view public.my_product_state as
with subscription_windows as (
  select
    p.id as user_id,
    coalesce(s.current_period_start, date_trunc('month', now())) as period_start,
    coalesce(s.current_period_end, now() + interval '100 years') as period_end
  from public.profiles p
  left join public.subscriptions s on s.user_id = p.id
),
current_usage as (
  select
    sw.user_id,
    coalesce(sum(tue.total_tokens), 0)::int as used_tokens
  from subscription_windows sw
  left join public.token_usage_events tue
    on tue.user_id = sw.user_id
    and tue.created_at >= sw.period_start
    and tue.created_at < sw.period_end
  group by sw.user_id
),
queue_counts as (
  select user_id, count(*)::int as queue_count
  from public.task_runs
  where status in ('queued', 'running')
  group by user_id
)
select
  p.id as user_id,
  p.email,
  p.full_name,
  p.avatar_url,
  p.region,
  p.created_at as profile_created_at,
  p.updated_at as profile_updated_at,
  (ack.user_id is not null and ack.text_version = 'v1') as acknowledgement_accepted,
  ack.accepted_at as acknowledgement_accepted_at,
  ack.text_version as acknowledgement_text_version,
  s.status as subscription_status,
  s.tier_id,
  s.current_period_start,
  s.current_period_end,
  s.cancel_at_period_end,
  hi.status as worker_status,
  hi.last_health_at,
  hi.ready_at,
  hi.error_code,
  hi.public_status_message,
  uq.monthly_token_quota,
  coalesce(cu.used_tokens, 0) as used_tokens,
  greatest(coalesce(uq.monthly_token_quota, 0) - coalesce(cu.used_tokens, 0), 0) as remaining_tokens,
  case
    when coalesce(uq.monthly_token_quota, 0) = 0 and coalesce(cu.used_tokens, 0) > 0 then 1::numeric
    when coalesce(uq.monthly_token_quota, 0) = 0 then 0::numeric
    else coalesce(cu.used_tokens, 0)::numeric / uq.monthly_token_quota
  end as usage_ratio,
  case
    when coalesce(uq.monthly_token_quota, 0) = 0 and coalesce(cu.used_tokens, 0) > 0 then true
    when coalesce(uq.monthly_token_quota, 0) = 0 then false
    else (coalesce(cu.used_tokens, 0)::numeric / uq.monthly_token_quota) >= 0.8
  end as usage_near_limit,
  ((coalesce(uq.monthly_token_quota, 0) > 0 and coalesce(cu.used_tokens, 0) >= uq.monthly_token_quota)
    or (coalesce(uq.monthly_token_quota, 0) = 0 and coalesce(cu.used_tokens, 0) > 0)) as usage_hard_limited,
  coalesce(qc.queue_count, 0) as queue_count,
  case
    when ack.user_id is null or ack.text_version <> 'v1' then 'needs_acknowledgement'
    when coalesce(s.status, 'inactive') <> 'active' then 'needs_subscription'
    when ((coalesce(uq.monthly_token_quota, 0) > 0 and coalesce(cu.used_tokens, 0) >= uq.monthly_token_quota)
      or (coalesce(uq.monthly_token_quota, 0) = 0 and coalesce(cu.used_tokens, 0) > 0)) then 'hard_limited'
    when coalesce(hi.status, 'not_requested') in ('not_requested', 'queued') then 'subscribed_pending_worker'
    when hi.status = 'provisioning' then 'provisioning_worker'
    when hi.status = 'ready' then 'ready'
    when hi.status = 'degraded' then 'degraded'
    else 'error'
  end as gate_kind
from public.profiles p
left join public.acknowledgements ack on ack.user_id = p.id
left join public.subscriptions s on s.user_id = p.id
left join public.hermes_instances hi on hi.user_id = p.id
left join public.usage_quotas uq on uq.user_id = p.id
left join current_usage cu on cu.user_id = p.id
left join queue_counts qc on qc.user_id = p.id
where p.id = auth.uid();

grant select on public.my_product_state to authenticated;
grant select on public.artifacts to authenticated;
grant select on public.task_runs to authenticated;

commit;
