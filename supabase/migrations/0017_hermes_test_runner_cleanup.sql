begin;

-- Live provider acceptance sometimes creates a paid-user test runner in a
-- constrained Railway workspace. These service-role-only helpers let an
-- operator delete that exact Railway project and reset only the matching
-- Hermes runner row so the same entitlement can be provisioned again.
create or replace function public.verify_hermes_test_runner_cleanup_target(
  p_user_id uuid,
  p_railway_project_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null or nullif(btrim(p_railway_project_id), '') is null then
    return false;
  end if;

  return exists (
    select 1
    from public.hermes_instance_private hp
    join public.hermes_instances hi on hi.user_id = hp.user_id
    where hp.user_id = p_user_id
      and hp.railway_project_id = btrim(p_railway_project_id)
      and hi.status in ('queued', 'provisioning', 'ready', 'degraded', 'error')
  );
end;
$$;

create or replace function public.cleanup_hermes_test_runner(
  p_user_id uuid,
  p_railway_project_id text,
  p_cleaned_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  locked public.hermes_instance_private%rowtype;
begin
  if p_user_id is null or nullif(btrim(p_railway_project_id), '') is null then
    return false;
  end if;

  select * into locked
  from public.hermes_instance_private hp
  where hp.user_id = p_user_id
    and hp.railway_project_id = btrim(p_railway_project_id)
  for update;

  if not found then
    return false;
  end if;

  update public.hermes_instance_private
  set
    railway_project_id = null,
    railway_service_id = null,
    railway_volume_id = null,
    railway_workflow_id = null,
    railway_template_id = null,
    railway_template_code = null,
    volume_mount_path = null,
    volume_gb = null,
    runner_base_url = null,
    runner_shared_secret = null,
    raw_error = null,
    updated_at = p_cleaned_at
  where user_id = p_user_id
    and railway_project_id = btrim(p_railway_project_id);

  update public.hermes_instances
  set
    status = 'queued',
    railway_project_id = null,
    railway_service_id = null,
    railway_volume_id = null,
    base_url = null,
    last_health_at = null,
    ready_at = null,
    error = null,
    error_code = null,
    public_status_message = 'Coworker AI test runner was cleaned up.',
    provisioning_requested_at = p_cleaned_at,
    provisioning_claimed_at = null,
    provisioning_lease_expires_at = null,
    updated_at = p_cleaned_at
  where user_id = p_user_id;

  insert into public.provisioning_events (user_id, event, details, created_at)
  values (
    p_user_id,
    'hermes_test_runner_cleaned',
    jsonb_build_object('provider', 'railway', 'project_deleted', true),
    p_cleaned_at
  );

  return true;
end;
$$;

revoke all on function public.verify_hermes_test_runner_cleanup_target(uuid, text) from public, anon, authenticated;
grant execute on function public.verify_hermes_test_runner_cleanup_target(uuid, text) to service_role;

revoke all on function public.cleanup_hermes_test_runner(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.cleanup_hermes_test_runner(uuid, text, timestamptz) to service_role;

commit;
