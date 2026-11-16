begin;

create table if not exists public.gateway_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  gateway_id text not null,
  source_conversation_id text not null,
  status text not null default 'connected',
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  last_source_event_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gateway_connect_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  gateway_id text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gateway_task_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  task_run_id uuid references public.task_runs(id) on delete set null,
  gateway_id text not null,
  source_event_id text not null,
  source_conversation_id text not null,
  source_message_id text not null,
  idempotency_key text not null,
  status text not null default 'accepted',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gateway_connections enable row level security;
alter table public.gateway_connect_codes enable row level security;
alter table public.gateway_task_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gateway_connections_gateway_id_check') then
    alter table public.gateway_connections add constraint gateway_connections_gateway_id_check
      check (gateway_id in ('telegram'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gateway_connections_status_check') then
    alter table public.gateway_connections add constraint gateway_connections_status_check
      check (status in ('connected', 'disconnected'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gateway_connections_source_not_blank_check') then
    alter table public.gateway_connections add constraint gateway_connections_source_not_blank_check
      check (btrim(source_conversation_id) <> '');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gateway_connect_codes_gateway_id_check') then
    alter table public.gateway_connect_codes add constraint gateway_connect_codes_gateway_id_check
      check (gateway_id in ('telegram'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gateway_connect_codes_hash_shape_check') then
    alter table public.gateway_connect_codes add constraint gateway_connect_codes_hash_shape_check
      check (code_hash ~ '^[a-f0-9]{64}$');
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gateway_connect_codes_expiry_check') then
    alter table public.gateway_connect_codes add constraint gateway_connect_codes_expiry_check
      check (expires_at > created_at);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gateway_task_events_gateway_id_check') then
    alter table public.gateway_task_events add constraint gateway_task_events_gateway_id_check
      check (gateway_id in ('telegram'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gateway_task_events_status_check') then
    alter table public.gateway_task_events add constraint gateway_task_events_status_check
      check (status in ('accepted', 'dispatched', 'failed'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gateway_task_events_identifiers_not_blank_check') then
    alter table public.gateway_task_events add constraint gateway_task_events_identifiers_not_blank_check
      check (
        btrim(source_event_id) <> ''
        and btrim(source_conversation_id) <> ''
        and btrim(source_message_id) <> ''
        and btrim(idempotency_key) <> ''
      );
  end if;
end $$;

create unique index if not exists gateway_connections_connected_source_idx
  on public.gateway_connections(gateway_id, source_conversation_id)
  where status = 'connected';

create index if not exists gateway_connections_user_gateway_idx
  on public.gateway_connections(user_id, gateway_id, updated_at desc);

create unique index if not exists gateway_connect_codes_gateway_code_hash_idx
  on public.gateway_connect_codes(gateway_id, code_hash);

create index if not exists gateway_connect_codes_user_pending_idx
  on public.gateway_connect_codes(user_id, gateway_id, expires_at desc)
  where consumed_at is null;

create unique index if not exists gateway_task_events_gateway_idempotency_idx
  on public.gateway_task_events(gateway_id, idempotency_key);

create index if not exists gateway_task_events_user_created_idx
  on public.gateway_task_events(user_id, created_at desc);

drop trigger if exists gateway_connections_set_updated_at on public.gateway_connections;
create trigger gateway_connections_set_updated_at before update on public.gateway_connections
  for each row execute function public.set_updated_at();
drop trigger if exists gateway_connect_codes_set_updated_at on public.gateway_connect_codes;
create trigger gateway_connect_codes_set_updated_at before update on public.gateway_connect_codes
  for each row execute function public.set_updated_at();
drop trigger if exists gateway_task_events_set_updated_at on public.gateway_task_events;
create trigger gateway_task_events_set_updated_at before update on public.gateway_task_events
  for each row execute function public.set_updated_at();

revoke all on public.gateway_connections from anon, authenticated;
revoke all on public.gateway_connect_codes from anon, authenticated;
revoke all on public.gateway_task_events from anon, authenticated;

grant select, insert, update on public.gateway_connections to service_role;
grant select, insert, update on public.gateway_connect_codes to service_role;
grant select, insert, update on public.gateway_task_events to service_role;

create or replace function public.claim_gateway_task_event(
  p_user_id uuid,
  p_gateway_id text,
  p_source_event_id text,
  p_source_conversation_id text,
  p_source_message_id text,
  p_idempotency_key text,
  p_instruction text
)
returns table (
  kind text,
  task_run_id uuid,
  message_id uuid,
  gateway_task_event_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_gateway_task_event_id uuid;
  v_message_id uuid;
  v_task_run_id uuid;
begin
  if coalesce(p_gateway_id, '') <> 'telegram' then
    raise exception 'unsupported gateway';
  end if;
  if p_user_id is null
    or btrim(coalesce(p_source_event_id, '')) = ''
    or btrim(coalesce(p_source_conversation_id, '')) = ''
    or btrim(coalesce(p_source_message_id, '')) = ''
    or btrim(coalesce(p_idempotency_key, '')) = ''
    or btrim(coalesce(p_instruction, '')) = '' then
    raise exception 'invalid gateway task claim';
  end if;

  begin
    insert into public.gateway_task_events (
      user_id,
      gateway_id,
      source_event_id,
      source_conversation_id,
      source_message_id,
      idempotency_key,
      status
    ) values (
      p_user_id,
      p_gateway_id,
      p_source_event_id,
      p_source_conversation_id,
      p_source_message_id,
      p_idempotency_key,
      'accepted'
    )
    returning id into v_gateway_task_event_id;
  exception when unique_violation then
    select gte.id, gte.task_run_id
    into v_gateway_task_event_id, v_task_run_id
    from public.gateway_task_events gte
    where gte.gateway_id = p_gateway_id
      and gte.idempotency_key = p_idempotency_key
    limit 1;

    kind := 'duplicate';
    task_run_id := v_task_run_id;
    message_id := null;
    gateway_task_event_id := v_gateway_task_event_id;
    return next;
    return;
  end;

  insert into public.messages (user_id, role, content)
  values (p_user_id, 'user', p_instruction)
  returning id into v_message_id;

  insert into public.task_runs (user_id, message_id, status, instruction)
  values (p_user_id, v_message_id, 'queued', p_instruction)
  returning id into v_task_run_id;

  update public.gateway_task_events
  set task_run_id = v_task_run_id,
      updated_at = now()
  where id = v_gateway_task_event_id;

  kind := 'accepted';
  task_run_id := v_task_run_id;
  message_id := v_message_id;
  gateway_task_event_id := v_gateway_task_event_id;
  return next;
end;
$$;

revoke all on function public.claim_gateway_task_event(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_gateway_task_event(uuid, text, text, text, text, text, text) to service_role;

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
  end as gate_kind,
  exists (
    select 1
    from public.gateway_connections gc
    where gc.user_id = p.id
      and gc.gateway_id = 'telegram'
      and gc.status = 'connected'
  ) as telegram_connected
from public.profiles p
left join public.acknowledgements ack on ack.user_id = p.id
left join public.subscriptions s on s.user_id = p.id
left join public.hermes_instances hi on hi.user_id = p.id
left join public.usage_quotas uq on uq.user_id = p.id
left join current_usage cu on cu.user_id = p.id
left join queue_counts qc on qc.user_id = p.id
where p.id = auth.uid();

grant select on public.my_product_state to authenticated;

commit;
