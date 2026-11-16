begin;

-- Series 4 — Fly Machines dedicated runner provider.
--
-- Adds a `provider` discriminator to hermes_instances + hermes_instance_private
-- so the provisioner orchestration knows whether to talk to Fly Machines or
-- the legacy Railway path. Adds Fly-specific identifiers to the private
-- table only (never exposed via my_product_state).
--
-- Lifecycle vocabulary (per Series 4 Option A cancellation policy chosen by
-- the operator on 2026-05-15):
--   provisioning -> ready -> sleeping -> deleting -> deleted
--                                  ^-------|  (resume on subscription renewal)
--
-- Backwards compatibility
--   All existing rows get provider='railway_legacy' by default so the v1.0.0
--   Alex-style runners keep working through cutover. The Worker reads the
--   provider column and routes accordingly (Phase 4).
--
-- No data is destroyed; no column is dropped. Railway columns stay where
-- they are during the cutover window and are cleared in a future migration
-- once the last railway_legacy runner has been re-provisioned on Fly.

-- ---------------------------------------------------------------------------
-- hermes_instances — public-safe lifecycle
-- ---------------------------------------------------------------------------

alter table public.hermes_instances
  add column if not exists provider text not null default 'railway_legacy';

-- Public-safe labels that mobile is allowed to see (no provider IDs / app
-- names / volume IDs). These are display-only.
alter table public.hermes_instances
  add column if not exists image_ref_label text;
alter table public.hermes_instances
  add column if not exists region_label text;
alter table public.hermes_instances
  add column if not exists storage_quota_gb integer;

-- Option A suspend/resume bookkeeping. suspended_at marks when the machine
-- was stopped on cancel/past-due; volume_retention_until is when the daily
-- grace-expiry job is allowed to force-destroy the volume + app.
alter table public.hermes_instances
  add column if not exists suspended_at timestamptz;
alter table public.hermes_instances
  add column if not exists volume_retention_until timestamptz;
alter table public.hermes_instances
  add column if not exists deleted_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hermes_instances_provider_check') then
    alter table public.hermes_instances add constraint hermes_instances_provider_check
      check (provider in ('railway_legacy', 'fly_machines'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'hermes_instances_storage_quota_gb_check') then
    alter table public.hermes_instances add constraint hermes_instances_storage_quota_gb_check
      check (storage_quota_gb is null or storage_quota_gb > 0);
  end if;

  -- Expand the status enum to cover sleeping/deleting/deleted. Drop the
  -- prior constraint by name (if any) to make this idempotent.
  if exists (select 1 from pg_constraint where conname = 'hermes_instances_status_check') then
    alter table public.hermes_instances drop constraint hermes_instances_status_check;
  end if;
  alter table public.hermes_instances add constraint hermes_instances_status_check
    check (status in (
      'not_requested', 'queued', 'provisioning', 'ready', 'degraded', 'error',
      'sleeping', 'deleting', 'deleted'
    ));

  if not exists (select 1 from pg_constraint where conname = 'hermes_instances_suspend_window_check') then
    alter table public.hermes_instances add constraint hermes_instances_suspend_window_check
      check (
        (suspended_at is null and volume_retention_until is null)
        or (suspended_at is not null and volume_retention_until is not null and volume_retention_until > suspended_at)
      );
  end if;
end $$;

create index if not exists hermes_instances_provider_idx
  on public.hermes_instances(provider, status, user_id);

create index if not exists hermes_instances_grace_expiry_idx
  on public.hermes_instances(volume_retention_until)
  where status = 'sleeping';

-- ---------------------------------------------------------------------------
-- hermes_instance_private — Fly identifiers (service-role only)
-- ---------------------------------------------------------------------------

alter table public.hermes_instance_private
  add column if not exists provider text not null default 'railway_legacy';

alter table public.hermes_instance_private
  add column if not exists fly_org text;
alter table public.hermes_instance_private
  add column if not exists fly_app_name text;
alter table public.hermes_instance_private
  add column if not exists fly_machine_id text;
alter table public.hermes_instance_private
  add column if not exists fly_volume_id text;
alter table public.hermes_instance_private
  add column if not exists fly_region text;
alter table public.hermes_instance_private
  add column if not exists image_ref text;
alter table public.hermes_instance_private
  add column if not exists image_digest text;
alter table public.hermes_instance_private
  add column if not exists deleted_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'hermes_instance_private_provider_check') then
    alter table public.hermes_instance_private add constraint hermes_instance_private_provider_check
      check (provider in ('railway_legacy', 'fly_machines'));
  end if;

  -- A non-deleted fly_machines runner must carry a fly_app_name. Once
  -- deleted_at is set the row may carry only audit fields.
  if not exists (select 1 from pg_constraint where conname = 'hermes_instance_private_fly_complete_check') then
    alter table public.hermes_instance_private add constraint hermes_instance_private_fly_complete_check
      check (
        provider <> 'fly_machines'
        or deleted_at is not null
        or (nullif(btrim(fly_app_name), '') is not null
            and nullif(btrim(fly_machine_id), '') is not null
            and nullif(btrim(fly_volume_id), '') is not null)
      );
  end if;
end $$;

-- Unique fly_app_name across non-deleted rows so we cannot accidentally
-- bind two users to the same Fly app.
create unique index if not exists hermes_instance_private_fly_app_name_idx
  on public.hermes_instance_private(fly_app_name)
  where fly_app_name is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- record_hermes_fly_provisioning_output — Fly-specific binding persistence
-- ---------------------------------------------------------------------------
-- Mirrors record_hermes_provisioning_output (used by the Railway path) but
-- writes the new fly_* fields and flips the provider discriminator. The
-- shared idempotency / claim semantics carry over so a stale claim cannot
-- overwrite a live runner.

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
  where hi.user_id = p_user_id;

  return true;
end;
$$;

revoke all on function public.record_hermes_fly_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.record_hermes_fly_provisioning_output(uuid, text, timestamptz, text, text, text, text, text, text, text, text, text, text, text, integer, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- mark_hermes_runner_suspended — Option A cancel/past-due entry point
-- ---------------------------------------------------------------------------
-- Sets status='sleeping' and stamps suspended_at + volume_retention_until.
-- Callers MUST pass the configured retention window in seconds; the daily
-- grace-expiry job then picks up rows where volume_retention_until < now().

create or replace function public.mark_hermes_runner_suspended(
  p_user_id uuid,
  p_retention_seconds integer,
  p_public_status_message text default 'Coworker AI is paused while your subscription is inactive.',
  p_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_retention integer;
begin
  v_retention := greatest(coalesce(p_retention_seconds, 0), 60);
  update public.hermes_instances hi
  set
    status = 'sleeping',
    suspended_at = p_at,
    volume_retention_until = p_at + make_interval(secs => v_retention),
    public_status_message = coalesce(nullif(btrim(p_public_status_message), ''), 'Coworker AI is paused while your subscription is inactive.'),
    error_code = null,
    updated_at = p_at
  where hi.user_id = p_user_id
    and hi.status in ('ready', 'degraded', 'provisioning', 'sleeping');
  return found;
end;
$$;

revoke all on function public.mark_hermes_runner_suspended(uuid, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.mark_hermes_runner_suspended(uuid, integer, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- mark_hermes_runner_resumed — back from sleeping when subscription renews
-- ---------------------------------------------------------------------------

create or replace function public.mark_hermes_runner_resumed(
  p_user_id uuid,
  p_public_status_message text default 'Coworker AI is coming back online.',
  p_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.hermes_instances hi
  set
    status = 'provisioning',
    suspended_at = null,
    volume_retention_until = null,
    public_status_message = coalesce(nullif(btrim(p_public_status_message), ''), 'Coworker AI is coming back online.'),
    error_code = null,
    updated_at = p_at
  where hi.user_id = p_user_id
    and hi.status = 'sleeping';
  return found;
end;
$$;

revoke all on function public.mark_hermes_runner_resumed(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.mark_hermes_runner_resumed(uuid, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- claim_next_hermes_runner_grace_expired — daily teardown queue
-- ---------------------------------------------------------------------------
-- Returns one sleeping runner whose grace window has expired so the daily
-- script can issue a force-teardown (Machine + volume + app delete) and then
-- call record_hermes_runner_deleted. Uses SKIP LOCKED so concurrent runs of
-- the daily script won't double-handle.

create or replace function public.claim_next_hermes_runner_grace_expired(
  p_at timestamptz default now()
)
returns table(
  user_id uuid,
  claimed_at timestamptz,
  fly_org text,
  fly_app_name text,
  fly_machine_id text,
  fly_volume_id text,
  fly_region text,
  runner_base_url text,
  runner_shared_secret text,
  image_ref text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select hi.user_id
    from public.hermes_instances hi
    where hi.status = 'sleeping'
      and hi.volume_retention_until is not null
      and hi.volume_retention_until < p_at
    order by hi.volume_retention_until, hi.user_id
    limit 1
    for update of hi skip locked
  ), touched as (
    update public.hermes_instances hi
    set
      status = 'deleting',
      public_status_message = 'Releasing the workspace volume after the cancellation grace period.',
      updated_at = p_at
    from candidate
    where hi.user_id = candidate.user_id
    returning hi.user_id, p_at as claimed_at
  )
  select
    touched.user_id,
    touched.claimed_at,
    hp.fly_org,
    hp.fly_app_name,
    hp.fly_machine_id,
    hp.fly_volume_id,
    hp.fly_region,
    hp.runner_base_url,
    hp.runner_shared_secret,
    hp.image_ref
  from touched
  left join public.hermes_instance_private hp on hp.user_id = touched.user_id;
end;
$$;

revoke all on function public.claim_next_hermes_runner_grace_expired(timestamptz) from public, anon, authenticated;
grant execute on function public.claim_next_hermes_runner_grace_expired(timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- record_hermes_runner_deleted — final state after force teardown succeeds
-- ---------------------------------------------------------------------------
-- Clears the private binding (so a re-provisioning starts clean) and marks
-- the public row deleted. The audit trail in provisioning_events captures
-- the actual destruction events.

create or replace function public.record_hermes_runner_deleted(
  p_user_id uuid,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.hermes_instance_private hp
  set
    runner_base_url = null,
    runner_shared_secret = null,
    fly_machine_id = null,
    fly_volume_id = null,
    -- keep fly_app_name + fly_org for the audit trail; deleted_at marks
    -- the row as inactive without losing what we provisioned.
    deleted_at = p_at,
    updated_at = p_at
  where hp.user_id = p_user_id;

  update public.hermes_instances hi
  set
    status = 'deleted',
    suspended_at = null,
    volume_retention_until = null,
    deleted_at = p_at,
    public_status_message = 'Coworker AI workspace has been released.',
    error_code = null,
    updated_at = p_at
  where hi.user_id = p_user_id;

  return found;
end;
$$;

revoke all on function public.record_hermes_runner_deleted(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.record_hermes_runner_deleted(uuid, timestamptz) to service_role;

commit;
