begin;

-- B07: generalize provider connection state so Telegram, WhatsApp, and
-- Signal can share the same service-owned connection table while the mobile
-- app still receives only a safe public projection.
alter table public.gateway_connections drop constraint if exists gateway_connections_gateway_id_check;
alter table public.gateway_connect_codes drop constraint if exists gateway_connect_codes_gateway_id_check;
alter table public.gateway_task_events drop constraint if exists gateway_task_events_gateway_id_check;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gateway_connections_gateway_id_check') then
    alter table public.gateway_connections add constraint gateway_connections_gateway_id_check
      check (gateway_id in ('telegram', 'whatsapp', 'signal'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gateway_connect_codes_gateway_id_check') then
    alter table public.gateway_connect_codes add constraint gateway_connect_codes_gateway_id_check
      check (gateway_id in ('telegram', 'whatsapp', 'signal'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'gateway_task_events_gateway_id_check') then
    alter table public.gateway_task_events add constraint gateway_task_events_gateway_id_check
      check (gateway_id in ('telegram', 'whatsapp', 'signal'));
  end if;
end $$;

-- If an environment accumulated multiple connected rows before this invariant,
-- keep the newest active provider and mark older ones disconnected before the
-- unique index is created.
with ranked_connections as (
  select
    id,
    row_number() over (
      partition by user_id
      order by connected_at desc nulls last, updated_at desc nulls last, id desc
    ) as active_rank
  from public.gateway_connections
  where status = 'connected'
)
update public.gateway_connections set status = 'disconnected',
    disconnected_at = coalesce(disconnected_at, now()),
    updated_at = now()
from ranked_connections
where public.gateway_connections.id = ranked_connections.id
  and ranked_connections.active_rank > 1;

create unique index if not exists gateway_connections_one_active_provider_per_user_idx
  on public.gateway_connections(user_id)
  where status = 'connected';

create or replace function public.set_active_gateway_connection(
  p_user_id uuid,
  p_gateway_id text,
  p_source_conversation_id text,
  p_source_event_id text default null
)
returns table(connection_id uuid, gateway_id text, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection_id uuid;
  v_existing_user_id uuid;
begin
  if p_user_id is null then
    raise exception 'user is required' using errcode = '22023';
  end if;

  if coalesce(p_gateway_id, '') not in ('telegram', 'whatsapp', 'signal') then
    raise exception 'unsupported messaging provider' using errcode = '22023';
  end if;

  if btrim(coalesce(p_source_conversation_id, '')) = '' then
    raise exception 'source conversation is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select public.gateway_connections.user_id into v_existing_user_id
  from public.gateway_connections
  where public.gateway_connections.gateway_id = p_gateway_id
    and public.gateway_connections.source_conversation_id = p_source_conversation_id
    and public.gateway_connections.status = 'connected'
  for update;

  if v_existing_user_id is not null and v_existing_user_id <> p_user_id then
    raise exception 'messaging conversation is already connected' using errcode = '23505';
  end if;

  update public.gateway_connections set status = 'disconnected',
      disconnected_at = coalesce(disconnected_at, now()),
      updated_at = now()
  where public.gateway_connections.user_id = p_user_id
    and public.gateway_connections.status = 'connected'
    and (
      public.gateway_connections.gateway_id <> p_gateway_id
      or public.gateway_connections.source_conversation_id <> p_source_conversation_id
    );

  update public.gateway_connections set
      status = 'connected',
      disconnected_at = null,
      last_source_event_id = nullif(btrim(coalesce(p_source_event_id, '')), ''),
      updated_at = now()
  where public.gateway_connections.user_id = p_user_id
    and public.gateway_connections.gateway_id = p_gateway_id
    and public.gateway_connections.source_conversation_id = p_source_conversation_id
  returning public.gateway_connections.id into v_connection_id;

  if v_connection_id is null then
    insert into public.gateway_connections (
      user_id,
      gateway_id,
      source_conversation_id,
      status,
      connected_at,
      disconnected_at,
      last_source_event_id
    ) values (
      p_user_id,
      p_gateway_id,
      p_source_conversation_id,
      'connected',
      now(),
      null,
      nullif(btrim(coalesce(p_source_event_id, '')), '')
    )
    returning public.gateway_connections.id into v_connection_id;
  end if;

  connection_id := v_connection_id;
  gateway_id := p_gateway_id;
  status := 'connected';
  return next;
end;
$$;

revoke all on function public.set_active_gateway_connection(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.set_active_gateway_connection(uuid, text, text, text) to service_role;

create or replace function public.disconnect_gateway_connection(
  p_user_id uuid,
  p_gateway_id text default null
)
returns table(gateway_id text, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_gateway_id text;
begin
  if p_user_id is null then
    raise exception 'user is required' using errcode = '22023';
  end if;

  if p_gateway_id is not null and p_gateway_id not in ('telegram', 'whatsapp', 'signal') then
    raise exception 'unsupported messaging provider' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  update public.gateway_connections set status = 'disconnected',
      disconnected_at = coalesce(disconnected_at, now()),
      updated_at = now()
  where public.gateway_connections.user_id = p_user_id
    and public.gateway_connections.status = 'connected'
    and (p_gateway_id is null or public.gateway_connections.gateway_id = p_gateway_id)
  returning public.gateway_connections.gateway_id into v_gateway_id;

  if v_gateway_id is null then
    return;
  end if;

  gateway_id := v_gateway_id;
  status := 'disconnected';
  return next;
end;
$$;

revoke all on function public.disconnect_gateway_connection(uuid, text) from public, anon, authenticated;
grant execute on function public.disconnect_gateway_connection(uuid, text) to service_role;

drop view if exists public.my_product_state;

create view public.my_product_state as
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
),
active_gateway_connection as (
  select distinct on (user_id)
    user_id,
    gateway_id,
    connected_at
  from public.gateway_connections
  where status = 'connected'
    and gateway_id in ('telegram', 'whatsapp', 'signal')
  order by user_id, connected_at desc nulls last, updated_at desc nulls last, id desc
),
provider_connections as (
  select
    user_id,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'provider_id', gateway_id,
          'status', status,
          'connected_at', connected_at,
          'disconnected_at', disconnected_at
        )
        order by updated_at desc nulls last, connected_at desc nulls last
      ) filter (where gateway_id in ('telegram', 'whatsapp', 'signal')),
      '[]'::jsonb
    ) as messaging_provider_connections
  from public.gateway_connections
  group by user_id
)
select
  p.id as user_id,
  p.email,
  p.full_name,
  p.agent_name,
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
  agc.gateway_id as active_gateway_id,
  agc.connected_at as active_gateway_connected_at,
  coalesce(pc.messaging_provider_connections, '[]'::jsonb) as messaging_provider_connections,
  (agc.gateway_id = 'telegram') as telegram_connected
from public.profiles p
left join public.acknowledgements ack on ack.user_id = p.id
left join public.subscriptions s on s.user_id = p.id
left join public.hermes_instances hi on hi.user_id = p.id
left join public.usage_quotas uq on uq.user_id = p.id
left join current_usage cu on cu.user_id = p.id
left join queue_counts qc on qc.user_id = p.id
left join active_gateway_connection agc on agc.user_id = p.id
left join provider_connections pc on pc.user_id = p.id
where p.id = auth.uid();

grant select on public.my_product_state to authenticated;

commit;
