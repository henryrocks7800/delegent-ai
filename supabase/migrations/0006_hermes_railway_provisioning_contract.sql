begin;

alter table public.hermes_instances add column if not exists provisioning_tier_id text;
alter table public.hermes_instances add column if not exists provisioning_idempotency_key text;
alter table public.hermes_instances add column if not exists provisioning_requested_at timestamptz;
alter table public.hermes_instances add column if not exists provisioning_claimed_at timestamptz;
alter table public.hermes_instances add column if not exists provisioning_lease_expires_at timestamptz;

alter table public.hermes_instance_private add column if not exists railway_workflow_id text;
alter table public.hermes_instance_private add column if not exists railway_template_id text;
alter table public.hermes_instance_private add column if not exists railway_template_code text;
alter table public.hermes_instance_private add column if not exists volume_mount_path text;
alter table public.hermes_instance_private add column if not exists volume_gb int;
alter table public.hermes_instance_private add column if not exists runner_shared_secret text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hermes_instances_provisioning_tier_id_check') then
    alter table public.hermes_instances add constraint hermes_instances_provisioning_tier_id_check
      check (provisioning_tier_id is null or provisioning_tier_id in ('studio', 'pro-office', 'enterprise-suite'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'hermes_instances_provisioning_lease_check') then
    alter table public.hermes_instances add constraint hermes_instances_provisioning_lease_check
      check (
        (provisioning_claimed_at is null and provisioning_lease_expires_at is null)
        or (
          provisioning_claimed_at is not null
          and provisioning_lease_expires_at is not null
          and provisioning_lease_expires_at > provisioning_claimed_at
        )
      );
  end if;

  if not exists (select 1 from pg_constraint where conname = 'hermes_instance_private_volume_gb_check') then
    alter table public.hermes_instance_private add constraint hermes_instance_private_volume_gb_check
      check (volume_gb is null or volume_gb > 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'hermes_instance_private_volume_mount_path_check') then
    alter table public.hermes_instance_private add constraint hermes_instance_private_volume_mount_path_check
      check (volume_mount_path is null or volume_mount_path like '/%');
  end if;
end $$;

create unique index if not exists hermes_instances_provisioning_idempotency_key_idx
  on public.hermes_instances(provisioning_idempotency_key)
  where provisioning_idempotency_key is not null;

create index if not exists hermes_instances_queued_idx
  on public.hermes_instances(provisioning_requested_at, user_id)
  where status = 'queued';

create index if not exists hermes_instances_claimable_idx
  on public.hermes_instances(status, provisioning_requested_at, user_id)
  where status = 'queued';

create or replace function public.claim_next_hermes_provisioning_job(
  p_claimed_at timestamptz default now(),
  p_lease_seconds int default 1800
)
returns table(user_id uuid, tier_id text, idempotency_key text, claimed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select hi.user_id
    from public.hermes_instances hi
    join public.subscriptions s on s.user_id = hi.user_id
    where hi.status = 'queued'
      and not exists (
        select 1
        from public.hermes_instance_private hp
        where hp.user_id = hi.user_id
          and (
            hp.railway_project_id is not null
            or hp.railway_workflow_id is not null
            or hp.runner_base_url is not null
          )
      )
      and coalesce(s.status, 'inactive') = 'active'
      and hi.provisioning_tier_id = s.tier_id
    order by hi.provisioning_requested_at nulls first, hi.updated_at nulls first, hi.user_id
    limit 1
    for update skip locked
  ), claimed as (
    update public.hermes_instances hi
    set
      status = 'provisioning',
      provisioning_claimed_at = p_claimed_at,
      provisioning_lease_expires_at = p_claimed_at + make_interval(secs => greatest(p_lease_seconds, 300)),
      public_status_message = 'Preparing Coworker AI workspace...',
      error_code = null
    from candidate
    where hi.user_id = candidate.user_id
    returning hi.user_id, hi.provisioning_tier_id, hi.provisioning_idempotency_key
  )
  select claimed.user_id, claimed.provisioning_tier_id, claimed.provisioning_idempotency_key, p_claimed_at
  from claimed;
end;
$$;

drop function if exists public.record_hermes_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, int, timestamptz);

create or replace function public.record_hermes_provisioning_output(
  p_user_id uuid,
  p_idempotency_key text,
  p_claimed_at timestamptz,
  p_railway_project_id text,
  p_runner_base_url text default null,
  p_runner_shared_secret text default null,
  p_railway_service_id text default null,
  p_railway_volume_id text default null,
  p_railway_workflow_id text default null,
  p_railway_template_id text default null,
  p_railway_template_code text default null,
  p_volume_mount_path text default null,
  p_volume_gb int default null,
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
  select * into locked
  from public.hermes_instances hi
  where hi.user_id = p_user_id
  for update;

  if not found then
    return false;
  end if;

  if locked.status <> 'provisioning'
    or locked.provisioning_idempotency_key is distinct from p_idempotency_key
    or locked.provisioning_claimed_at is distinct from p_claimed_at
    or locked.provisioning_lease_expires_at is null
    or locked.provisioning_lease_expires_at <= p_recorded_at then
    return false;
  end if;

  if nullif(trim(p_railway_project_id), '') is null then
    raise exception 'missing_railway_project_id' using errcode = '22023';
  end if;

  if nullif(trim(p_runner_shared_secret), '') is null then
    raise exception 'missing_runner_shared_secret' using errcode = '22023';
  end if;

  insert into public.hermes_instance_private (
    user_id,
    railway_project_id,
    railway_service_id,
    railway_volume_id,
    railway_workflow_id,
    railway_template_id,
    railway_template_code,
    volume_mount_path,
    volume_gb,
    runner_base_url,
    runner_shared_secret,
    raw_error,
    updated_at
  ) values (
    p_user_id,
    p_railway_project_id,
    p_railway_service_id,
    p_railway_volume_id,
    p_railway_workflow_id,
    p_railway_template_id,
    p_railway_template_code,
    p_volume_mount_path,
    p_volume_gb,
    nullif(trim(p_runner_base_url), ''),
    nullif(trim(p_runner_shared_secret), ''),
    null,
    p_recorded_at
  )
  on conflict (user_id) do update set
    railway_project_id = excluded.railway_project_id,
    railway_service_id = excluded.railway_service_id,
    railway_volume_id = excluded.railway_volume_id,
    railway_workflow_id = excluded.railway_workflow_id,
    railway_template_id = excluded.railway_template_id,
    railway_template_code = excluded.railway_template_code,
    volume_mount_path = excluded.volume_mount_path,
    volume_gb = excluded.volume_gb,
    runner_base_url = coalesce(excluded.runner_base_url, hermes_instance_private.runner_base_url),
    runner_shared_secret = excluded.runner_shared_secret,
    raw_error = null,
    updated_at = excluded.updated_at;

  update public.hermes_instances
  set
    status = 'provisioning',
    error_code = null,
    public_status_message = 'Coworker AI workspace is being prepared.',
    provisioning_claimed_at = null,
    provisioning_lease_expires_at = null,
    updated_at = p_recorded_at
  where user_id = p_user_id;

  return true;
end;
$$;

revoke all on function public.claim_next_hermes_provisioning_job(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_next_hermes_provisioning_job(timestamptz, integer) to service_role;

revoke all on function public.record_hermes_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, int, timestamptz) from public, anon, authenticated;
grant execute on function public.record_hermes_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, int, timestamptz) to service_role;

commit;
