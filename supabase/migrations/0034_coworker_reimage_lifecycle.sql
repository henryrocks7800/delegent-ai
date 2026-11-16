begin;

-- 0034 — coworker reimage lifecycle (Feature 3: agent upgrade path)
--
-- The platform re-images a user's runner onto a newer golden image in place,
-- preserving their workspace volume (see reimageRunner in the Fly provider).
-- The user TRIGGERS the upgrade ("Update my coworker"); the runner never
-- self-updates its own runtime (reproducibility + security).
--
-- This migration adds:
--   * public hermes_instances flags the app reads — mobile-safe, no infra
--     internals (no digests, app names, machine ids).
--   * private hermes_instance_private bookkeeping (target ref, last error,
--     lease) — service-role only.
--   * RPCs the Worker (request) + provisioner cron (refresh / claim / complete)
--     call, all service-role only.
--   * my_product_state exposes the mobile-safe flags.

-- 1. Public, mobile-safe lifecycle flags on hermes_instances.
alter table public.hermes_instances
  add column if not exists coworker_update_available boolean not null default false;
alter table public.hermes_instances
  add column if not exists coworker_update_status text not null default 'idle';
alter table public.hermes_instances
  add column if not exists reimage_requested_at timestamptz;
alter table public.hermes_instances
  add column if not exists reimaged_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'hermes_instances_coworker_update_status_check'
  ) then
    alter table public.hermes_instances
      add constraint hermes_instances_coworker_update_status_check
      check (coworker_update_status in ('idle', 'available', 'updating', 'updated', 'failed'));
  end if;
end $$;

-- 2. Private, service-role-only reimage bookkeeping.
alter table public.hermes_instance_private
  add column if not exists target_image_ref text;
alter table public.hermes_instance_private
  add column if not exists latest_known_image_digest text;
alter table public.hermes_instance_private
  add column if not exists reimage_error text;
alter table public.hermes_instance_private
  add column if not exists reimage_leased_until timestamptz;

-- 3. RPC: user-triggered reimage request (called by the Worker with service-role).
--    Idempotent: a runner already 'updating' stays queued.
create or replace function public.request_coworker_reimage(p_user_id uuid)
returns table (queued boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_live boolean;
begin
  select (hi.user_id is not null and hi.status in ('ready', 'degraded', 'provisioning'))
    into v_live
  from public.hermes_instances hi
  where hi.user_id = p_user_id;

  if v_live is not true then
    return query select false;
    return;
  end if;

  update public.hermes_instances
     set reimage_requested_at = now(),
         coworker_update_status = 'updating',
         reimaged_at = null
   where user_id = p_user_id;

  return query select true;
end;
$$;

revoke all on function public.request_coworker_reimage(uuid) from public, anon, authenticated;
grant execute on function public.request_coworker_reimage(uuid) to service_role;

-- 4. RPC: refresh the public update-available flags from the latest pinned
--    digest. Marks behind-version live runners available; clears runners that
--    are already current. Leaves mid-update runners alone.
create or replace function public.refresh_coworker_update_flags(p_latest_digest text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_behind integer := 0;
  v_current integer := 0;
begin
  if nullif(btrim(p_latest_digest), '') is null then
    return 0;
  end if;

  update public.hermes_instances hi
     set coworker_update_available = true,
         coworker_update_status = 'available'
    from public.hermes_instance_private hp
   where hp.user_id = hi.user_id
     and hp.deleted_at is null
     and hi.status in ('ready', 'degraded')
     and coalesce(hp.image_digest, '') <> p_latest_digest
     and hi.coworker_update_status <> 'updating'
     and (hi.coworker_update_available is distinct from true
          or hi.coworker_update_status is distinct from 'available');
  get diagnostics v_behind = row_count;

  update public.hermes_instances hi
     set coworker_update_available = false,
         coworker_update_status = case
           when hi.coworker_update_status in ('available', 'failed') then 'idle'
           else hi.coworker_update_status
         end
    from public.hermes_instance_private hp
   where hp.user_id = hi.user_id
     and hp.deleted_at is null
     and coalesce(hp.image_digest, '') = p_latest_digest
     and (hi.coworker_update_available is distinct from false
          or hi.coworker_update_status = 'available');
  get diagnostics v_current = row_count;

  return v_behind + v_current;
end;
$$;

revoke all on function public.refresh_coworker_update_flags(text) from public, anon, authenticated;
grant execute on function public.refresh_coworker_update_flags(text) to service_role;

-- 5. RPC: claim user-requested reimage candidates for the cron, with a short
--    lease so overlapping runs do not double-reimage. Returns the fly
--    identifiers the provider needs (service-role only — never surfaced to
--    mobile). Request-driven only: a runner is claimed only after the user
--    asked (coworker_update_status='updating' with a request timestamp).
create or replace function public.claim_coworker_reimage_candidates(
  p_latest_image_ref text,
  p_lease_seconds integer,
  p_limit integer
)
returns table (
  user_id uuid,
  fly_app_name text,
  fly_machine_id text,
  fly_volume_id text,
  fly_region text,
  current_image_digest text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidates as (
    select hp.user_id
      from public.hermes_instance_private hp
      join public.hermes_instances hi on hi.user_id = hp.user_id
     where hp.deleted_at is null
       and hi.status in ('ready', 'degraded')
       and nullif(btrim(hp.fly_app_name), '') is not null
       and nullif(btrim(hp.fly_machine_id), '') is not null
       and (hp.reimage_leased_until is null or hp.reimage_leased_until < now())
       and hi.reimage_requested_at is not null
       and hi.coworker_update_status = 'updating'
       and hi.reimaged_at is null
     order by hi.reimage_requested_at asc nulls last
     limit greatest(coalesce(p_limit, 1), 1)
     for update of hp skip locked
  ),
  leased as (
    update public.hermes_instance_private hp
       set reimage_leased_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 60)),
           target_image_ref = coalesce(nullif(btrim(p_latest_image_ref), ''), hp.target_image_ref)
      from candidates c
     where hp.user_id = c.user_id
    returning hp.user_id, hp.fly_app_name, hp.fly_machine_id, hp.fly_volume_id, hp.fly_region, hp.image_digest
  )
  select l.user_id, l.fly_app_name, l.fly_machine_id, l.fly_volume_id, l.fly_region, l.image_digest
    from leased l;
end;
$$;

revoke all on function public.claim_coworker_reimage_candidates(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_coworker_reimage_candidates(text, integer, integer) to service_role;

-- 6. RPC: record a reimage outcome (called by the cron after reimageRunner).
create or replace function public.complete_coworker_reimage(
  p_user_id uuid,
  p_ok boolean,
  p_image_ref text,
  p_image_digest text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_ok then
    update public.hermes_instance_private
       set image_ref = coalesce(nullif(btrim(p_image_ref), ''), image_ref),
           image_digest = coalesce(nullif(btrim(p_image_digest), ''), image_digest),
           reimage_error = null,
           reimage_leased_until = null,
           target_image_ref = null
     where user_id = p_user_id;
    update public.hermes_instances
       set reimaged_at = now(),
           reimage_requested_at = null,
           coworker_update_available = false,
           coworker_update_status = 'updated'
     where user_id = p_user_id;
  else
    update public.hermes_instance_private
       set reimage_error = left(coalesce(p_error, 'reimage_failed'), 500),
           reimage_leased_until = null
     where user_id = p_user_id;
    update public.hermes_instances
       set coworker_update_status = 'failed'
     where user_id = p_user_id;
  end if;
end;
$$;

revoke all on function public.complete_coworker_reimage(uuid, boolean, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_coworker_reimage(uuid, boolean, text, text, text) to service_role;

-- 7. Recreate my_product_state to surface the mobile-safe flags (0031 body +
--    coworker update fields). No infra internals are exposed.
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

notify pgrst, 'reload schema';

commit;
