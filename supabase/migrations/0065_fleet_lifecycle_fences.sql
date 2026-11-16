-- PASS4: owned leases, bounded creation retries and serialized retirement.
begin;

alter table public.hermes_instances
  add column if not exists provisioning_failure_count integer not null default 0,
  add column if not exists deletion_claimed_at timestamptz,
  add column if not exists deletion_started_at timestamptz;

-- Conservative retention eligibility: an entitlement-bearing status always
-- protects the workspace. Provider-specific expiry is handled by billing.
create or replace function public.runner_has_entitlement(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select exists(select 1 from public.subscriptions
  where user_id = p_user_id and status in ('active','trialing','past_due')) $$;
revoke all on function public.runner_has_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.runner_has_entitlement(uuid) to service_role;

create or replace function public.transition_hermes_provisioning(
  p_user_id uuid, p_idempotency_key text, p_claimed_at timestamptz,
  p_outcome text, p_runner_base_url text default null,
  p_error_code text default null, p_public_message text default null,
  p_at timestamptz default now()
)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_failures integer;
begin
  if p_outcome not in ('ready','retry','reconcile') then raise exception 'invalid_provisioning_outcome'; end if;
  -- Serialize with billing updates as well as with the provisioning lease.
  perform 1 from public.subscriptions where user_id = p_user_id for share;
  select hi.provisioning_failure_count into v_failures from public.hermes_instances hi
    where hi.user_id = p_user_id and hi.status = 'provisioning'
      and hi.provisioning_idempotency_key = p_idempotency_key
      and hi.provisioning_claimed_at = p_claimed_at
      and hi.deletion_started_at is null for update;
  if not found or not public.runner_has_entitlement(p_user_id) then return false; end if;
  if p_outcome = 'ready' then
    if not exists(select 1 from public.hermes_instance_private hp where hp.user_id = p_user_id
      and hp.deleted_at is null and hp.runner_base_url = p_runner_base_url) then return false; end if;
    update public.hermes_instances set status='ready', base_url=p_runner_base_url,
      ready_at=p_at, last_health_at=p_at, error=null, error_code=null,
      provisioning_claimed_at=null, provisioning_lease_expires_at=null,
      provisioning_failure_count=0, public_status_message='Delegent AI is online.', updated_at=p_at
      where user_id=p_user_id;
  elsif p_outcome = 'retry' then
    v_failures := v_failures + 1;
    update public.hermes_instances set
      status=case when v_failures < 5 then 'provisioning' else 'error' end,
      provisioning_failure_count=v_failures,
      provisioning_claimed_at=case when v_failures < 5 then p_claimed_at else null end,
      provisioning_lease_expires_at=case when v_failures < 5 then
        p_at + make_interval(secs => least(3600, 300 * (2 ^ (v_failures - 1))::integer)) else null end,
      error_code=left(p_error_code,64), updated_at=p_at,
      public_status_message=case when v_failures < 5 then 'Workspace setup will retry shortly.'
        else 'Workspace setup needs a support check. Your progress is saved.' end
      where user_id=p_user_id;
  else
    update public.hermes_instances set status='error',
      provisioning_claimed_at=null, provisioning_lease_expires_at=null,
      error_code=left(p_error_code,64), public_status_message=p_public_message, updated_at=p_at
      where user_id=p_user_id;
  end if;
  return true;
end;
$$;
revoke all on function public.transition_hermes_provisioning(uuid,text,timestamptz,text,text,text,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.transition_hermes_provisioning(uuid,text,timestamptz,text,text,text,text,timestamptz)
  to service_role;

create or replace function public.claim_next_series4_stuck_readiness(
  p_at timestamptz default now(), p_min_age_seconds int default 1800
)
returns table(user_id uuid,tier_id text,idempotency_key text,runner_base_url text,claimed_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  return query with candidate as (
    select hi.user_id, hp.runner_base_url from public.hermes_instances hi
    join public.hermes_instance_private hp on hp.user_id=hi.user_id
    where hi.status='provisioning' and hp.deleted_at is null
      and nullif(btrim(hp.runner_base_url),'') is not null
      and public.runner_has_entitlement(hi.user_id)
      and hi.updated_at < p_at-make_interval(secs=>greatest(p_min_age_seconds,300))
      and (hi.provisioning_lease_expires_at is null or hi.provisioning_lease_expires_at<=p_at)
    order by hi.updated_at nulls first,hi.user_id limit 1 for update of hi skip locked
  ), claimed as (
    update public.hermes_instances hi set provisioning_claimed_at=p_at,
      provisioning_lease_expires_at=p_at+interval '5 minutes'
    from candidate where hi.user_id=candidate.user_id
    returning hi.user_id,hi.provisioning_tier_id,hi.provisioning_idempotency_key,hi.provisioning_claimed_at
  ) select claimed.user_id,claimed.provisioning_tier_id,claimed.provisioning_idempotency_key,
    candidate.runner_base_url,claimed.provisioning_claimed_at
    from claimed join candidate on candidate.user_id=claimed.user_id;
end;
$$;
revoke all on function public.claim_next_series4_stuck_readiness(timestamptz,integer) from public,anon,authenticated;
grant execute on function public.claim_next_series4_stuck_readiness(timestamptz,integer) to service_role;

create or replace function public.claim_next_hermes_runner_grace_expired(p_at timestamptz default now())
returns table(user_id uuid,claimed_at timestamptz,fly_org text,fly_app_name text,fly_machine_id text,
  fly_volume_id text,fly_region text,runner_base_url text,runner_shared_secret text,image_ref text)
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  return query with candidate as (
    select hi.user_id from public.hermes_instances hi
    join public.hermes_instance_private hp on hp.user_id=hi.user_id
    where ((hi.status='sleeping' and hi.volume_retention_until<p_at)
      or (hi.status='deleting' and hi.updated_at<p_at-interval '15 minutes'))
      and not public.runner_has_entitlement(hi.user_id)
      and hp.deleted_at is null and hp.provider='fly_machines'
      and nullif(hp.fly_app_name,'') is not null and nullif(hp.fly_machine_id,'') is not null
      and nullif(hp.fly_volume_id,'') is not null
    order by case when hi.status='deleting' then 0 else 1 end,
      coalesce(hi.volume_retention_until,hi.updated_at),hi.user_id
    limit 1 for update of hi skip locked
  ), claimed as (
    update public.hermes_instances hi set status='deleting', deletion_claimed_at=p_at,
      public_status_message='Releasing the workspace after the cancellation retention period.',updated_at=p_at
      from candidate where hi.user_id=candidate.user_id returning hi.user_id
  ) select claimed.user_id,p_at,hp.fly_org,hp.fly_app_name,hp.fly_machine_id,hp.fly_volume_id,
      hp.fly_region,hp.runner_base_url,hp.runner_shared_secret,hp.image_ref
    from claimed join public.hermes_instance_private hp on hp.user_id=claimed.user_id;
end;
$$;
revoke all on function public.claim_next_hermes_runner_grace_expired(timestamptz) from public,anon,authenticated;
grant execute on function public.claim_next_hermes_runner_grace_expired(timestamptz) to service_role;

-- A renewal can cancel an unstarted claim. Once a provider DELETE may have
-- started, billing must retry instead of reviving a partially destroyed disk.
-- The barrier persists through an ambiguous provider response until recovery
-- completes, rather than expiring while an external operation may still run.
create or replace function public.fence_entitlement_during_retirement()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_instance public.hermes_instances%rowtype;
begin
  if new.status in ('active','trialing','past_due') then
    select * into v_instance from public.hermes_instances where user_id=new.user_id for update;
    if found and v_instance.deletion_started_at is not null then
      raise exception 'workspace_retirement_in_progress' using errcode='40001';
    end if;
    if found and v_instance.status='deleting' then
      update public.hermes_instances set status='sleeping',deletion_claimed_at=null,updated_at=now()
        where user_id=new.user_id;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.fence_entitlement_during_retirement() from public,anon,authenticated;
drop trigger if exists subscriptions_retirement_fence on public.subscriptions;
create trigger subscriptions_retirement_fence before insert or update on public.subscriptions
  for each row execute function public.fence_entitlement_during_retirement();

create or replace function public.authorize_hermes_grace_deletion(
  p_user_id uuid,p_claimed_at timestamptz,p_app_name text,p_machine_id text,p_volume_id text
)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.subscriptions where user_id=p_user_id for share;
  perform 1 from public.hermes_instances hi where hi.user_id=p_user_id
    and hi.status='deleting' and hi.deletion_claimed_at=p_claimed_at
    and hi.updated_at>now()-interval '15 minutes' for update;
  if not found or public.runner_has_entitlement(p_user_id) then return false; end if;
  if not exists(select 1 from public.hermes_instance_private hp where hp.user_id=p_user_id
    and hp.deleted_at is null and hp.fly_app_name=p_app_name
    and hp.fly_machine_id=p_machine_id and hp.fly_volume_id=p_volume_id) then return false; end if;
  update public.hermes_instances set deletion_started_at=coalesce(deletion_started_at,now()),updated_at=now()
    where user_id=p_user_id;
  return true;
end;
$$;
revoke all on function public.authorize_hermes_grace_deletion(uuid,timestamptz,text,text,text) from public,anon,authenticated;
grant execute on function public.authorize_hermes_grace_deletion(uuid,timestamptz,text,text,text) to service_role;

create or replace function public.finish_hermes_grace_deletion(
  p_user_id uuid,p_claimed_at timestamptz,p_app_name text,p_machine_id text,p_volume_id text
)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not public.authorize_hermes_grace_deletion(p_user_id,p_claimed_at,p_app_name,p_machine_id,p_volume_id)
    then return false; end if;
  if not public.record_hermes_runner_deleted(p_user_id) then return false; end if;
  update public.hermes_instances set deletion_claimed_at=null,deletion_started_at=null,
    provisioning_claimed_at=null,provisioning_lease_expires_at=null,provisioning_failure_count=0
    where user_id=p_user_id;
  return true;
end;
$$;
revoke all on function public.record_hermes_runner_deleted(uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.finish_hermes_grace_deletion(uuid,timestamptz,text,text,text) from public,anon,authenticated;
grant execute on function public.finish_hermes_grace_deletion(uuid,timestamptz,text,text,text) to service_role;

create or replace function public.record_hermes_fly_provisioning_output(
  p_user_id uuid,
  p_idempotency_key text,
  p_claimed_at timestamptz,
  p_fly_org text,
  p_fly_app_name text,
  p_fly_machine_id text,
  p_fly_volume_id text,
  p_fly_region text,
  p_runner_base_url text,
  p_runner_shared_secret text,
  p_image_ref text,
  p_image_digest text,
  p_image_ref_label text,
  p_region_label text,
  p_storage_quota_gb integer,
  p_recorded_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(btrim(p_fly_app_name), '') is null then return false; end if;
  if nullif(btrim(p_fly_machine_id), '') is null then return false; end if;
  if nullif(btrim(p_fly_volume_id), '') is null then return false; end if;
  if nullif(btrim(p_runner_base_url), '') is null then return false; end if;
  if nullif(btrim(p_runner_shared_secret), '') is null then return false; end if;

  -- Keep the claim row locked through both binding and public writes.
  -- Cancellation retains its claim so the actual resource can still be
  -- recorded for cleanup, but a reclaimed or cleared claim cannot overwrite it.
  perform 1 from public.hermes_instances hi where hi.user_id=p_user_id
    and hi.provisioning_idempotency_key=p_idempotency_key
    and hi.provisioning_claimed_at=p_claimed_at
    and hi.status in ('provisioning','sleeping')
    and hi.deletion_started_at is null for update;
  if not found then return false; end if;

  insert into public.hermes_instance_private (
    user_id,
    provider,
    fly_org,
    fly_app_name,
    fly_machine_id,
    fly_volume_id,
    fly_region,
    runner_base_url,
    runner_shared_secret,
    image_ref,
    image_digest,
    updated_at,
    deleted_at
  ) values (
    p_user_id,
    'fly_machines',
    p_fly_org,
    p_fly_app_name,
    p_fly_machine_id,
    p_fly_volume_id,
    p_fly_region,
    p_runner_base_url,
    p_runner_shared_secret,
    p_image_ref,
    p_image_digest,
    p_recorded_at,
    null
  )
  on conflict (user_id) do update set
    provider = 'fly_machines',
    fly_org = excluded.fly_org,
    fly_app_name = excluded.fly_app_name,
    fly_machine_id = excluded.fly_machine_id,
    fly_volume_id = excluded.fly_volume_id,
    fly_region = excluded.fly_region,
    runner_base_url = excluded.runner_base_url,
    runner_shared_secret = excluded.runner_shared_secret,
    image_ref = excluded.image_ref,
    image_digest = excluded.image_digest,
    updated_at = excluded.updated_at,
    deleted_at = null;

  update public.hermes_instances hi
  set
    provider = 'fly_machines',
    status = 'provisioning',
    image_ref_label = p_image_ref_label,
    region_label = p_region_label,
    storage_quota_gb = p_storage_quota_gb,
    public_status_message = 'Coworker AI workspace is being prepared.',
    error_code = null,
    suspended_at = null,
    volume_retention_until = null,
    deleted_at = null,
    updated_at = p_recorded_at
  where hi.user_id = p_user_id
    -- 0048: do not resurrect a row that cancelled, or began teardown, while
    -- this provisioning run was in flight.
    and hi.status = 'provisioning'
    and public.runner_has_entitlement(p_user_id);

  return true;
end;
$$;

revoke all on function public.record_hermes_fly_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.record_hermes_fly_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, integer, timestamptz) to service_role;

notify pgrst,'reload schema';
commit;
