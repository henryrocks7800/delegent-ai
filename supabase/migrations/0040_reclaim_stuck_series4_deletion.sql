begin;

-- 0040 — reclaim runners stuck in 'deleting' (GO_LIVE_TRACKER #12).
--
-- The grace-expiry teardown flips a row 'sleeping' -> 'deleting' (via
-- claim_next_hermes_runner_grace_expired, 0021) then force-deletes
-- machine -> volume -> app. If one of those deletes returns a transient
-- non-404 error (Fly 5xx / timeout / rate-limit), the orchestrator returns
-- 'failed' WITHOUT recording the deletion, so the row is STUCK in 'deleting'
-- forever: the claim only matched 'sleeping', so nothing ever retried it.
-- Net effect — every transient Fly error during teardown permanently orphaned
-- a 10-100 GB volume + app and wedged the user row.
--
-- Fix: the SAME claim also re-picks rows stuck in 'deleting' whose updated_at is
-- stale (> 15 min — comfortably longer than a real teardown, so an in-flight
-- teardown is never reclaimed), refreshing the lease so the daily grace-expiry
-- job retries. deleteRunner is 404-tolerant, so re-running the teardown is safe
-- and idempotent. No new cron/CLI surface — the existing grace-expiry path
-- drives it.

-- Partial index so the stuck-deleting scan stays cheap as the fleet grows.
create index if not exists hermes_instances_stuck_deleting_idx
  on public.hermes_instances(updated_at)
  where status = 'deleting';

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
    where (
        -- (a) original: a sleeping runner whose grace window has expired.
        (hi.status = 'sleeping'
          and hi.volume_retention_until is not null
          and hi.volume_retention_until < p_at)
        -- (b) #12: a runner stuck mid-teardown (a prior force-delete failed
        --     partway and was never retried). 15 min >> a real teardown, so
        --     we never reclaim an in-flight one.
        or (hi.status = 'deleting'
          and hi.updated_at < p_at - interval '15 minutes')
      )
    -- Finish genuinely-stuck teardowns first, then sleeping rows by grace deadline.
    order by
      case when hi.status = 'deleting' then 0 else 1 end,
      coalesce(hi.volume_retention_until, hi.updated_at),
      hi.user_id
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

commit;
