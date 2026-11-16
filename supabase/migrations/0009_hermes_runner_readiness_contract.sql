begin;

alter table public.hermes_instance_private add column if not exists runner_shared_secret text;

create index if not exists hermes_instance_private_runner_readiness_idx
  on public.hermes_instance_private(user_id, runner_base_url)
  where runner_base_url is not null
    and runner_shared_secret is not null;

create index if not exists hermes_instances_runner_readiness_idx
  on public.hermes_instances(updated_at, user_id)
  where status in ('provisioning', 'ready', 'degraded');

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
      and coalesce(s.status, 'inactive') = 'active'
      and (
        hi.last_health_at is null
        or hi.last_health_at <= now() - make_interval(secs => greatest(60, p_stale_after_seconds))
      )
      and (
        hi.status <> 'provisioning'
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

create or replace function public.record_hermes_runner_ready(
  p_user_id uuid,
  p_runner_base_url text,
  p_claimed_at timestamptz,
  p_checked_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(trim(p_runner_base_url), '') is null or p_claimed_at is null then
    return false;
  end if;

  update public.hermes_instances hi
  set
    status = 'ready',
    last_health_at = p_checked_at,
    ready_at = coalesce(ready_at, p_checked_at),
    error_code = null,
    public_status_message = 'Coworker AI is online.',
    provisioning_claimed_at = null,
    provisioning_lease_expires_at = null,
    updated_at = p_checked_at
  where hi.user_id = p_user_id
    and hi.updated_at = p_claimed_at
    and hi.status in ('provisioning', 'ready', 'degraded')
    and exists (
      select 1
      from public.hermes_instance_private hp
      where hp.user_id = hi.user_id
        and hp.runner_base_url is not null
        and hp.runner_base_url = p_runner_base_url
    );

  return found;
end;
$$;

create or replace function public.record_hermes_runner_readiness_failure(
  p_user_id uuid,
  p_runner_base_url text,
  p_claimed_at timestamptz,
  p_error_code text default 'runner_health_not_ready',
  p_public_status_message text default 'Coworker AI is still coming online.',
  p_checked_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(trim(p_runner_base_url), '') is null or p_claimed_at is null then
    return false;
  end if;

  update public.hermes_instances hi
  set
    status = 'provisioning',
    error_code = left(regexp_replace(lower(coalesce(nullif(p_error_code, ''), 'runner_health_not_ready')), '[^a-z0-9_-]+', '_', 'g'), 64),
    public_status_message = coalesce(nullif(p_public_status_message, ''), 'Coworker AI is still coming online.'),
    updated_at = p_checked_at
  where hi.user_id = p_user_id
    and hi.updated_at = p_claimed_at
    and hi.status in ('provisioning', 'ready', 'degraded')
    and exists (
      select 1
      from public.hermes_instance_private hp
      where hp.user_id = hi.user_id
        and hp.runner_base_url is not null
        and hp.runner_base_url = p_runner_base_url
    );

  return found;
end;
$$;

revoke all on function public.claim_next_hermes_readiness_check(integer) from public, anon, authenticated;
grant execute on function public.claim_next_hermes_readiness_check(integer) to service_role;

revoke all on function public.record_hermes_runner_ready(uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.record_hermes_runner_ready(uuid, text, timestamptz, timestamptz) to service_role;

revoke all on function public.record_hermes_runner_readiness_failure(uuid, text, timestamptz, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_hermes_runner_readiness_failure(uuid, text, timestamptz, text, text, timestamptz) to service_role;

commit;
