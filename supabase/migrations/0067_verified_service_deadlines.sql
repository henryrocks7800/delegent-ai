-- PASS13: verified Apple service expiry across requests, fleet and read models.
begin;

-- Expiry blocks new work immediately. Workspace deletion still requires the
-- separate sleeping state and elapsed retention window enforced by 0065.
create or replace function public.runner_has_entitlement(p_user_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.subscriptions s where s.user_id=p_user_id
    and public.subscription_service_access_allowed(s.status,s.billing_provider,
      s.current_period_end,s.service_access_until,now()))
$$;
revoke all on function public.runner_has_entitlement(uuid) from public,anon,authenticated;
grant execute on function public.runner_has_entitlement(uuid) to service_role;

create or replace function public.claim_next_hermes_provisioning_job(
  p_claimed_at timestamptz default now(),
  p_lease_seconds int default 1800
)
returns table(user_id uuid, tier_id text, idempotency_key text, claimed_at timestamptz, agent_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select
      hi.user_id,
      coalesce(nullif(btrim(p.agent_name), ''), 'Ruben') as agent_name
    from public.hermes_instances hi
    join public.subscriptions s on s.user_id = hi.user_id
    left join public.profiles p on p.id = hi.user_id
    where (
        hi.status = 'queued'
        or (
          hi.status = 'provisioning'
          and hi.provisioning_lease_expires_at is not null
          and hi.provisioning_lease_expires_at <= p_claimed_at
        )
      )
      and not exists (
        select 1
        from public.hermes_instance_private hp
        where hp.user_id = hi.user_id
          and hp.deleted_at is null
          and (
            hp.railway_project_id is not null
            or hp.railway_workflow_id is not null
            or hp.runner_base_url is not null
            or hp.fly_app_name is not null
            or hp.fly_machine_id is not null
            or hp.fly_volume_id is not null
          )
      )
      and public.subscription_service_access_allowed(s.status,s.billing_provider,s.current_period_end,s.service_access_until,now())
      and hi.provisioning_tier_id = s.tier_id
    order by hi.provisioning_requested_at nulls first, hi.updated_at nulls first, hi.user_id
    limit 1
    for update of hi skip locked
  ), claimed as (
    update public.hermes_instances hi
    set
      status = 'provisioning',
      provisioning_claimed_at = p_claimed_at,
      provisioning_lease_expires_at = p_claimed_at + make_interval(secs => greatest(p_lease_seconds, 300)),
      public_status_message = 'Preparing your Delegent AI workspace...',
      error_code = null
    from candidate
    where hi.user_id = candidate.user_id
    returning hi.user_id, hi.provisioning_tier_id, hi.provisioning_idempotency_key, candidate.agent_name
  )
  select
    claimed.user_id,
    claimed.provisioning_tier_id,
    claimed.provisioning_idempotency_key,
    p_claimed_at,
    left(regexp_replace(claimed.agent_name, '\s+', ' ', 'g'), 40)
  from claimed;
end;
$$;

revoke all on function public.claim_next_hermes_provisioning_job(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_next_hermes_provisioning_job(timestamptz, integer) to service_role;


create or replace function public.expire_unpaid_trials(
  p_retention_seconds integer default 5184000,
  p_limit integer default 100,
  p_at timestamptz default now(),
  p_only_user_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_count integer := 0;
begin
  for v_user_id in
    select s.user_id from public.subscriptions s
    where s.status in ('active','trialing','past_due')
      and (s.billing_provider='apple' or s.status='trialing')
      and not public.subscription_service_access_allowed(s.status,s.billing_provider,s.current_period_end,s.service_access_until,p_at)
      and (p_only_user_id is null or s.user_id = p_only_user_id)
    order by s.current_period_end nulls first, s.user_id
    limit greatest(1, least(coalesce(p_limit, 100), 100))
    for update of s skip locked
  loop
    update public.subscriptions
    set status = 'canceled', updated_at = p_at
    where user_id = v_user_id;
    -- Leave provider_updated_at unchanged: a delayed real paid invoice must
    -- still be able to restore the account using its provider timestamp.
    update public.hermes_instances set status='sleeping',
      suspended_at=coalesce(suspended_at,p_at),
      volume_retention_until=coalesce(volume_retention_until,p_at+make_interval(secs=>greatest(p_retention_seconds,60))),
      public_status_message='Your subscription access has ended. Update your billing to resume your digital employee.',
      updated_at=p_at
      where user_id=v_user_id and status in ('not_requested','error','queued','ready','degraded','provisioning','sleeping');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.expire_unpaid_trials(integer, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.expire_unpaid_trials(integer, integer, timestamptz, uuid) to service_role;


create or replace function public.enqueue_chat_message(
  p_instruction text,
  p_attachment_metadata jsonb default '[]'::jsonb,
  p_now timestamptz default now()
)
returns table(
  conversation_id uuid,
  user_message_id uuid,
  assistant_message_id uuid,
  task_run_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_conversation_id uuid;
  v_user_message_id uuid;
  v_assistant_message_id uuid;
  v_task_run_id uuid;

begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;

  if nullif(btrim(p_instruction), '') is null then
    raise exception 'instruction_required';
  end if;

  -- F3 fix: align with the Worker's CHAT_MESSAGE_MAX_CHARS (96_000). Previously
  -- 8000, which silently rejected long pastes + attachments the Worker accepted.
  if length(p_instruction) > 96000 then
    raise exception 'instruction_too_long';
  end if;

  if jsonb_typeof(p_attachment_metadata) <> 'array' then
    raise exception 'attachment_metadata_must_be_array';
  end if;

  -- Use the server clock, never the caller's optional message timestamp.
  if not exists(select 1 from public.subscriptions s where s.user_id=v_user_id
    and public.subscription_service_access_allowed(s.status,s.billing_provider,
      s.current_period_end,s.service_access_until,now())) then
    raise exception 'no_active_subscription';
  end if;

  v_conversation_id := v_user_id;

  insert into public.messages (user_id, conversation_id, role, content, attachment_metadata, status, created_at)
       values (v_user_id, v_conversation_id, 'user', p_instruction, p_attachment_metadata, 'complete', p_now)
    returning id into v_user_message_id;

  insert into public.task_runs (user_id, message_id, status, instruction, kind, created_at, updated_at)
       values (v_user_id, v_user_message_id, 'queued', p_instruction, 'chat', p_now, p_now)
    returning id into v_task_run_id;

  insert into public.messages (user_id, conversation_id, role, content, task_run_id, status, attachment_metadata, created_at)
       values (v_user_id, v_conversation_id, 'assistant', '', v_task_run_id, 'queued', '[]'::jsonb, p_now)
    returning id into v_assistant_message_id;

  return query select v_conversation_id, v_user_message_id, v_assistant_message_id, v_task_run_id;
end;
$$;

revoke all on function public.enqueue_chat_message(text, jsonb, timestamptz) from public, anon;
grant execute on function public.enqueue_chat_message(text, jsonb, timestamptz) to authenticated, service_role;

create or replace view public.my_product_state as
with subscription_windows as (
  select
    p.id as user_id,
    coalesce(s.current_period_start, date_trunc('month', now())) as period_start,
    case when s.billing_provider='apple' then greatest(s.current_period_end,s.service_access_until)
      else coalesce(s.current_period_end, now() + interval '100 years') end as period_end
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
    when not public.subscription_service_access_allowed(s.status,s.billing_provider,s.current_period_end,s.service_access_until,now())
      and hi.status = 'sleeping'
      and hi.volume_retention_until is not null then 'workspace_retained'
    when not public.subscription_service_access_allowed(s.status,s.billing_provider,s.current_period_end,s.service_access_until,now()) then 'needs_subscription'
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
  (agc.gateway_id = 'telegram') as telegram_connected,
  s.billing_provider,
  s.service_access_until
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

notify pgrst,'reload schema';
commit;
