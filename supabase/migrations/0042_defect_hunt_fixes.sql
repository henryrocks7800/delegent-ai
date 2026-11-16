begin;

-- 0042 - defect hunt fixes (2026-06-10 schema review)
--
-- 1. messages.conversation_id BEFORE INSERT default. 0023 made the column
--    NOT NULL but three service-role writers never supply it; the MVP
--    invariant is conversation == user, so default it to user_id.
-- 2. claim_gateway_task_event re-created: its messages insert predates 0023
--    (no conversation_id, so every Telegram claim now aborts on the NOT NULL)
--    and never tagged channel; its task_runs insert left kind at the 'chat'
--    default. Now conversation_id => p_user_id, channel => 'telegram',
--    kind => 'telegram'.
-- 3. claim_due_scheduled_tasks / record_scheduled_task_dispatch: 0036 only
--    revoked from PUBLIC, leaving anon/authenticated able to execute via
--    PostgREST. Revoke from public, anon, authenticated; keep the 0041
--    service_role grants (re-stated for idempotency).
-- 4. claim_next_series4_stuck_readiness re-created: the claiming UPDATE set
--    only provisioning_lease_expires_at, violating the both-NULL-or-both-set
--    hermes_instances_provisioning_lease_check from 0006 on rows with NULL
--    provisioning_claimed_at and wedging the reclaim cron. Now also sets
--    provisioning_claimed_at = coalesce(existing, p_at).
-- 5. Drop the stale 0002 "messages insert own user messages" policy: all
--    legitimate writes flow through enqueue_chat_message or service-role.
-- 6. my_product_state queue_count ignored 'dispatched' runs (status added in
--    0024), undercounting in-flight work. queue_counts now includes it.
-- 7. Hot-path partial indexes for the chat sweeper, the reservation sweep,
--    message-by-run lookups and gateway-event-by-run lookups.
-- 8. increment_voice_usage RPC: atomic consumed_voice_seconds increment,
--    replacing a read-modify-write race in the Worker.

-- 1. Default messages.conversation_id to user_id on insert -------------------

create or replace function public.messages_default_conversation_id()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.conversation_id := coalesce(new.conversation_id, new.user_id);
  return new;
end;
$$;

drop trigger if exists messages_default_conversation_id on public.messages;
create trigger messages_default_conversation_id
  before insert on public.messages
  for each row execute function public.messages_default_conversation_id();

-- 2. claim_gateway_task_event: supply conversation_id / channel / kind -------

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

  insert into public.messages (user_id, conversation_id, role, content, channel)
  values (p_user_id, p_user_id, 'user', p_instruction, 'telegram')
  returning id into v_message_id;

  insert into public.task_runs (user_id, message_id, status, instruction, kind)
  values (p_user_id, v_message_id, 'queued', p_instruction, 'telegram')
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

-- 3. Lock the scheduled-task RPCs to service_role only ------------------------

revoke all on function public.claim_due_scheduled_tasks(integer) from public, anon, authenticated;
revoke all on function public.record_scheduled_task_dispatch(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_due_scheduled_tasks(integer) to service_role;
grant execute on function public.record_scheduled_task_dispatch(uuid, uuid, boolean) to service_role;

-- 4. claim_next_series4_stuck_readiness: satisfy the 0006 lease-pair check ---

create or replace function public.claim_next_series4_stuck_readiness(
  p_at timestamptz default now(),
  p_min_age_seconds int default 1800
)
returns table(user_id uuid, tier_id text, idempotency_key text, runner_base_url text, claimed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select hi.user_id, hp.runner_base_url
    from public.hermes_instances hi
    join public.hermes_instance_private hp on hp.user_id = hi.user_id
    where hi.status = 'provisioning'
      and hp.runner_base_url is not null
      and btrim(hp.runner_base_url) <> ''
      and hi.updated_at < p_at - make_interval(secs => greatest(p_min_age_seconds, 300))
      and (hi.provisioning_lease_expires_at is null or hi.provisioning_lease_expires_at <= p_at)
    order by hi.updated_at nulls first, hi.user_id
    limit 1
    for update of hi skip locked
  ), claimed as (
    update public.hermes_instances hi
    set provisioning_claimed_at = coalesce(hi.provisioning_claimed_at, p_at),
        provisioning_lease_expires_at = p_at + make_interval(secs => 300)
    from candidate
    where hi.user_id = candidate.user_id
    returning hi.user_id, hi.provisioning_tier_id, hi.provisioning_idempotency_key
  )
  select
    claimed.user_id,
    claimed.provisioning_tier_id,
    claimed.provisioning_idempotency_key,
    candidate.runner_base_url,
    p_at
  from claimed
  join candidate on candidate.user_id = claimed.user_id;
end;
$$;

revoke all on function public.claim_next_series4_stuck_readiness(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_next_series4_stuck_readiness(timestamptz, integer) to service_role;

-- 5. Drop the stale direct-client messages INSERT policy ----------------------

drop policy if exists "messages insert own user messages" on public.messages;

-- 6. my_product_state: count dispatched runs in queue_count -------------------
--    Full 0034 body; the only change is the queue_counts status filter.

drop view if exists public.my_product_state;

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
  where status in ('queued', 'dispatched', 'running')
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
  (ack.user_id is not null and ack.text_version = 'v2') as acknowledgement_accepted,
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
  hi.suspended_at,
  hi.volume_retention_until,
  hi.deleted_at,
  hi.coworker_update_available,
  hi.coworker_update_status,
  hi.reimage_requested_at,
  hi.reimaged_at,
  uq.monthly_token_quota,
  coalesce(cu.used_tokens, 0) as used_tokens,
  greatest(coalesce(uq.monthly_token_quota, 0) - coalesce(cu.used_tokens, 0), 0) as remaining_tokens,
  case
    when coalesce(uq.monthly_token_quota, 0) = 0 then 0::numeric
    else coalesce(cu.used_tokens, 0)::numeric / uq.monthly_token_quota
  end as usage_ratio,
  case
    when coalesce(uq.monthly_token_quota, 0) = 0 then false
    else (coalesce(cu.used_tokens, 0)::numeric / uq.monthly_token_quota) >= 0.8
  end as usage_near_limit,
  (coalesce(uq.monthly_token_quota, 0) > 0 and coalesce(cu.used_tokens, 0) >= uq.monthly_token_quota) as usage_hard_limited,
  coalesce(qc.queue_count, 0) as queue_count,
  case
    when ack.user_id is null or ack.text_version <> 'v2' then 'needs_acknowledgement'
    when coalesce(s.status, 'inactive') not in ('active', 'trialing', 'past_due')
      and hi.status = 'sleeping'
      and hi.volume_retention_until is not null then 'workspace_retained'
    when coalesce(s.status, 'inactive') not in ('active', 'trialing', 'past_due') then 'needs_subscription'
    when coalesce(uq.monthly_token_quota, 0) > 0 and coalesce(cu.used_tokens, 0) >= uq.monthly_token_quota then 'hard_limited'
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

-- 7. Hot-path indexes ----------------------------------------------------------

create index if not exists task_runs_chat_sweeper_idx
  on public.task_runs (updated_at)
  where status in ('queued', 'dispatched');

create index if not exists token_usage_events_reservation_sweep_idx
  on public.token_usage_events (created_at)
  where source = 'worker_reservation' and total_tokens > 0;

create index if not exists messages_task_run_id_idx
  on public.messages (task_run_id)
  where task_run_id is not null;

create index if not exists gateway_task_events_task_run_id_idx
  on public.gateway_task_events (task_run_id);

-- 8. Atomic voice-seconds increment (service-role only) ------------------------

create or replace function public.increment_voice_usage(p_user_id uuid, p_seconds integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_new integer;
begin
  if p_user_id is null or p_seconds is null or p_seconds < 0 then
    raise exception 'invalid voice usage increment';
  end if;

  update public.usage_quotas
     set consumed_voice_seconds = coalesce(consumed_voice_seconds, 0) + p_seconds,
         updated_at = now()
   where user_id = p_user_id
  returning consumed_voice_seconds into v_new;

  return v_new;
end;
$$;

revoke all on function public.increment_voice_usage(uuid, integer) from public, anon, authenticated;
grant execute on function public.increment_voice_usage(uuid, integer) to service_role;

notify pgrst, 'reload schema';

commit;
