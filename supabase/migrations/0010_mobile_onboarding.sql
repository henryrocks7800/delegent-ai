begin;

alter table public.profiles add column if not exists agent_name text;

create or replace function public.complete_mobile_onboarding(
  p_agent_name text,
  p_acknowledgement_text_version text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_agent_name text := left(regexp_replace(coalesce(nullif(trim(p_agent_name), ''), 'Ruben'), '\s+', ' ', 'g'), 40);
begin
  if v_user_id is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;

  if p_acknowledgement_text_version <> 'v1' then
    raise exception 'unsupported acknowledgement version' using errcode = '22023';
  end if;

  update public.profiles
  set agent_name = v_agent_name,
      updated_at = now()
  where id = v_user_id;

  if not found then
    insert into public.profiles (id, email, agent_name)
    values (v_user_id, '', v_agent_name)
    on conflict (id) do update
      set agent_name = v_agent_name,
          updated_at = now();
  end if;

  insert into public.acknowledgements (user_id, accepted_at, text_version)
  values (v_user_id, now(), p_acknowledgement_text_version)
  on conflict (user_id) do update
    set accepted_at = excluded.accepted_at,
        text_version = excluded.text_version;
end;
$$;

revoke execute on function public.complete_mobile_onboarding(text, text) from public, anon;
grant execute on function public.complete_mobile_onboarding(text, text) to authenticated;

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
  ) as telegram_connected,
  p.agent_name
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
