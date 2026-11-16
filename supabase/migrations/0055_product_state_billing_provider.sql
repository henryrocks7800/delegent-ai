-- 0055_product_state_billing_provider.sql
--
-- Surface billing_provider on my_product_state.
--
-- WHY. The app could not tell an Apple subscription from a Stripe one, because
-- this view exposed status, tier and period but not the provider. So
-- purchaseTierWithStoreKit had to refuse on ANY active subscription, and an
-- Apple subscriber tapping upgrade was told "This account already has a
-- subscription billed outside the App Store". For them that is simply false,
-- and it leaves them unable to change tier from inside the app at all, which
-- is the sort of thing App Review notices.
--
-- The refusal was deliberate and correctly reasoned at the time: blocking only
-- what we could PROVE was Stripe would have meant blocking nothing, because the
-- snapshot carried no provider. This migration removes that constraint rather
-- than the guard.
--
-- THE NEW COLUMN GOES LAST, AND THAT IS NOT A STYLE CHOICE. create or replace
-- view requires the new query to produce the SAME columns, with the same names,
-- types and ORDER, and permits additions only at the END of the select list.
-- The first draft of this migration inserted billing_provider next to the other
-- subscription fields, where it reads better, and would have failed on apply.
--
-- The body below is otherwise 0042 verbatim, reproduced in full because
-- create or replace view cannot add a column without restating the query. The
-- grant is re-issued because replacing a view drops its grants.

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
  (agc.gateway_id = 'telegram') as telegram_connected,
  s.billing_provider
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
