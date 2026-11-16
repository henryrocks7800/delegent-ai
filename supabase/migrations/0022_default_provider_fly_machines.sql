-- 0022 — make 'fly_machines' the default provider for new hermes_instances
-- and hermes_instance_private rows.
--
-- Why: migration 0021 set the column default to 'railway_legacy' so existing
-- rows would be tagged correctly during the v1.0.0 cutover. The cutover is
-- complete; Series 4 is the only active provider. New rows must default to
-- 'fly_machines' or the Stripe webhook ends up enqueueing jobs against a
-- decommissioned provider (defect J2, May 2026 — first real-device test
-- queued a runner that never came up because nothing was processing the
-- railway_legacy queue).
--
-- Also rewrites the leaky "Coworker AI workspace is being prepared." copy
-- in record_hermes_fly_provisioning_output to use the current brand string
-- (defect J12).

alter table public.hermes_instances
  alter column provider set default 'fly_machines';

alter table public.hermes_instance_private
  alter column provider set default 'fly_machines';

-- Replace the function so its emitted public_status_message matches the
-- current brand. Body otherwise unchanged from 0021.
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
declare
  v_match boolean;
begin
  if nullif(btrim(p_fly_app_name), '') is null then return false; end if;
  if nullif(btrim(p_fly_machine_id), '') is null then return false; end if;
  if nullif(btrim(p_fly_volume_id), '') is null then return false; end if;
  if nullif(btrim(p_runner_base_url), '') is null then return false; end if;
  if nullif(btrim(p_runner_shared_secret), '') is null then return false; end if;

  select exists (
    select 1
      from public.hermes_instances hi
     where hi.user_id = p_user_id
       and hi.provisioning_idempotency_key = p_idempotency_key
       and hi.provisioning_claimed_at = p_claimed_at
  ) into v_match;
  if not v_match then return false; end if;

  insert into public.hermes_instance_private (
    user_id, provider,
    fly_org, fly_app_name, fly_machine_id, fly_volume_id, fly_region,
    runner_base_url, runner_shared_secret,
    image_ref, image_digest, updated_at
  )
  values (
    p_user_id, 'fly_machines',
    p_fly_org, p_fly_app_name, p_fly_machine_id, p_fly_volume_id, p_fly_region,
    p_runner_base_url, p_runner_shared_secret,
    p_image_ref, p_image_digest, p_recorded_at
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
    public_status_message = 'Delegent AI is being prepared.',
    error_code = null,
    suspended_at = null,
    volume_retention_until = null,
    deleted_at = null,
    updated_at = p_recorded_at
  where hi.user_id = p_user_id;

  return true;
end;
$$;

revoke all on function public.record_hermes_fly_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.record_hermes_fly_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, integer, timestamptz) to service_role;
