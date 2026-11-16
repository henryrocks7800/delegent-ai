begin;

-- Railway templateDeployV2 returns project/workflow output immediately, while the
-- generated service domain can appear a few seconds later. These service-role
-- helpers let the provisioner reconcile that private runner URL without
-- re-claiming/re-deploying the paid user's runner.
create or replace function public.claim_next_hermes_runner_domain_discovery(
  p_claimed_at timestamptz default now(),
  p_stale_after_seconds integer default 60
)
returns table(user_id uuid, railway_project_id text, claimed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select
      hi.user_id,
      hp.railway_project_id,
      p_claimed_at as claimed_at
    from public.hermes_instances hi
    join public.hermes_instance_private hp on hp.user_id = hi.user_id
    join public.subscriptions s on s.user_id = hi.user_id
    where hi.status = 'provisioning'
      and coalesce(s.status, 'inactive') in ('active', 'trialing', 'past_due')
      and hi.provisioning_tier_id = s.tier_id
      and nullif(btrim(hp.railway_project_id), '') is not null
      and nullif(btrim(hp.runner_shared_secret), '') is not null
      and nullif(btrim(hp.runner_base_url), '') is null
      and (
        hi.updated_at is null
        or hi.updated_at <= p_claimed_at - make_interval(secs => greatest(60, p_stale_after_seconds))
      )
    order by hi.updated_at nulls first, hi.user_id
    limit 1
    for update of hi skip locked
  ), touched as (
    update public.hermes_instances hi
    set
      public_status_message = 'Checking Coworker AI workspace address...',
      error_code = null,
      updated_at = candidate.claimed_at
    from candidate
    where hi.user_id = candidate.user_id
    returning hi.user_id, candidate.railway_project_id, candidate.claimed_at
  )
  select touched.user_id, touched.railway_project_id, touched.claimed_at
  from touched;
end;
$$;

create or replace function public.record_hermes_runner_domain_discovered(
  p_user_id uuid,
  p_railway_project_id text,
  p_runner_base_url text,
  p_claimed_at timestamptz,
  p_railway_service_id text default null,
  p_railway_volume_id text default null,
  p_recorded_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  locked public.hermes_instances%rowtype;
begin
  if p_user_id is null
    or nullif(btrim(p_railway_project_id), '') is null
    or nullif(btrim(p_runner_base_url), '') is null
    or p_claimed_at is null then
    return false;
  end if;

  select * into locked
  from public.hermes_instances hi
  where hi.user_id = p_user_id
  for update;

  if not found
    or locked.status <> 'provisioning'
    or locked.updated_at is distinct from p_claimed_at then
    return false;
  end if;

  update public.hermes_instance_private hp
  set
    runner_base_url = btrim(p_runner_base_url),
    railway_service_id = coalesce(nullif(btrim(p_railway_service_id), ''), hp.railway_service_id),
    railway_volume_id = coalesce(nullif(btrim(p_railway_volume_id), ''), hp.railway_volume_id),
    raw_error = null,
    updated_at = p_recorded_at
  where hp.user_id = p_user_id
    and hp.railway_project_id = btrim(p_railway_project_id)
    and nullif(btrim(hp.runner_base_url), '') is null;

  if not found then
    return false;
  end if;

  update public.hermes_instances hi
  set
    status = 'provisioning',
    error_code = null,
    public_status_message = 'Coworker AI workspace address found. Checking health...',
    updated_at = p_recorded_at
  where hi.user_id = p_user_id;

  return true;
end;
$$;

-- Let a newly-discovered private runner URL be health-checked immediately. The
-- original 60s updated_at guard is still kept for repeatedly-failing checks.
create or replace function public.claim_next_hermes_readiness_check(
  p_stale_after_seconds integer default 600
)
returns table(user_id uuid, runner_base_url text, runner_shared_secret text, claimed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select
      hi.user_id,
      hp.runner_base_url,
      hp.runner_shared_secret,
      now() as claimed_at
    from public.hermes_instances hi
    join public.hermes_instance_private hp on hp.user_id = hi.user_id
    join public.subscriptions s on s.user_id = hi.user_id
    where hi.status in ('provisioning', 'ready', 'degraded')
      and hp.runner_base_url is not null
      and btrim(hp.runner_base_url) <> ''
      and hp.runner_shared_secret is not null
      and btrim(hp.runner_shared_secret) <> ''
      and coalesce(s.status, 'inactive') in ('active', 'trialing', 'past_due')
      and (
        hi.last_health_at is null
        or hi.last_health_at <= now() - make_interval(secs => greatest(60, p_stale_after_seconds))
      )
      and (
        hi.status <> 'provisioning'
        or hi.last_health_at is null
        or hi.updated_at is null
        or hi.updated_at <= now() - make_interval(secs => 60)
      )
    order by hi.updated_at nulls first, hi.user_id
    limit 1
    for update of hi skip locked
  ), touched as (
    update public.hermes_instances hi
    set
      public_status_message = 'Checking Coworker AI workspace health...',
      error_code = null,
      updated_at = candidate.claimed_at
    from candidate
    where hi.user_id = candidate.user_id
    returning hi.user_id, candidate.runner_base_url, candidate.runner_shared_secret, candidate.claimed_at
  )
  select touched.user_id, touched.runner_base_url, touched.runner_shared_secret, touched.claimed_at
  from touched;
end;
$$;

revoke all on function public.claim_next_hermes_runner_domain_discovery(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_next_hermes_runner_domain_discovery(timestamptz, integer) to service_role;

revoke all on function public.record_hermes_runner_domain_discovered(uuid, text, text, timestamptz, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_hermes_runner_domain_discovered(uuid, text, text, timestamptz, text, text, timestamptz) to service_role;

revoke all on function public.claim_next_hermes_readiness_check(integer) from public, anon, authenticated;
grant execute on function public.claim_next_hermes_readiness_check(integer) to service_role;

commit;
