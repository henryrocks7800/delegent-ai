begin;

-- 0048 — a cancellation landing mid-provision must not be silently undone.
--
-- record_hermes_fly_provisioning_output (0021) writes the Fly binding, then
-- updates the public row with `where hi.user_id = p_user_id` and nothing else,
-- unconditionally setting status='provisioning', suspended_at=null and
-- volume_retention_until=null.
--
-- Provisioning takes 1-2 minutes. If customer.subscription.deleted arrives in
-- that window, mark_hermes_runner_suspended (0021:285) flips the row to
-- 'sleeping' and starts the 30-day retention clock. The stale-claim guard at
-- 0021:181 does NOT catch this, because suspension leaves
-- provisioning_idempotency_key and provisioning_claimed_at untouched, so the
-- claim still matches and the update proceeds.
--
-- Net effect: the cancelled user's machine is un-suspended and served, AND
-- volume_retention_until is wiped, so the grace-expiry job has no deadline to
-- act on and never tears the machine down. The daily dunning reconcile is the
-- only thing that catches it, so the exposure is roughly a day of compute plus
-- a coworker briefly answering someone who has stopped paying.
--
-- Fix: skip ONLY the public-row update when the row has left the provisioning
-- lifecycle. The hermes_instance_private upsert above it deliberately still
-- runs: the Fly machine and volume genuinely exist by this point, so the
-- binding has to be recorded or the teardown job cannot find what to delete
-- and we orphan a paid volume (the failure mode 0040 already had to repair).
--
-- Deny-list rather than allow-list on purpose: a status added later should keep
-- the existing behaviour by default, and only the three terminal-or-suspended
-- states are known to be wrong to resurrect.

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

  -- Refuse to overwrite a binding owned by a different stale claim.
  select exists (
    select 1
    from public.hermes_instances hi
    where hi.user_id = p_user_id
      and (
        hi.provisioning_idempotency_key is null
        or hi.provisioning_idempotency_key = p_idempotency_key
      )
      and (
        hi.provisioning_claimed_at is null
        or hi.provisioning_claimed_at = p_claimed_at
      )
  ) into v_match;
  if not v_match then
    return false;
  end if;

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
    and hi.status not in ('sleeping', 'deleting', 'deleted');

  return true;
end;
$$;

revoke all on function public.record_hermes_fly_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.record_hermes_fly_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, integer, timestamptz) to service_role;

commit;
