begin;

-- 2026-06-03 pre-launch review P0 #4 — self-heal "stuck on Setting up".
--
-- When a Fly provision RECORDS its binding (recordSeries4FlyProvisioningOutput
-- succeeded -> hermes_instance_private.runner_base_url is set) but the runner is
-- never promoted (markSeries4FlyRunnerReady failed: /healthz timed out, or the
-- mark-ready RPC threw), the row stays status='provisioning' FOREVER: the normal
-- claim (claim_next_hermes_provisioning_job) skips it because a binding now
-- exists, and re-creating would orphan the live Fly Machine. Today only a human
-- operator can unstick it.
--
-- claim_next_series4_stuck_readiness claims one such row (binding present,
-- provisioning, lease expired, older than p_min_age_seconds), takes a short
-- fresh lease so two reclaimers don't both poll, and returns the job + the
-- runner URL. The provisioner's stuck-readiness pass then re-polls /healthz and
-- promotes it IN PLACE (no re-create) via markSeries4FlyRunnerReady.
create or replace function public.claim_next_series4_stuck_readiness(
  p_at timestamptz default now(),
  p_min_age_seconds int default 1800
)
returns table(user_id uuid, tier_id text, idempotency_key text, runner_base_url text, claimed_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select hi.user_id, hp.runner_base_url
    from public.hermes_instances hi
    join public.hermes_instance_private hp on hp.user_id = hi.user_id
    where hi.status = 'provisioning'
      and hp.runner_base_url is not null
      and btrim(hp.runner_base_url) <> ''
      and hi.updated_at < p_at - make_interval(secs => greatest(p_min_age_seconds, 300))
      and (hi.provisioning_lease_expires_at is null or hi.provisioning_lease_expires_at <= p_at)
    order by hi.updated_at nulls first, hi.user_id
    limit 1
    for update of hi skip locked
  ), claimed as (
    update public.hermes_instances hi
    set provisioning_lease_expires_at = p_at + make_interval(secs => 300)
    from candidate
    where hi.user_id = candidate.user_id
    returning hi.user_id, hi.provisioning_tier_id, hi.provisioning_idempotency_key
  )
  select
    claimed.user_id,
    claimed.provisioning_tier_id,
    claimed.provisioning_idempotency_key,
    candidate.runner_base_url,
    p_at
  from claimed
  join candidate on candidate.user_id = claimed.user_id;
end;
$$;

revoke all on function public.claim_next_series4_stuck_readiness(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_next_series4_stuck_readiness(timestamptz, integer) to service_role;

commit;
