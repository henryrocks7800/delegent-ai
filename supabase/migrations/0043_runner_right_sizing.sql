begin;

-- 0043 — runner right-sizing (auto-resize on tier change)
--
-- The bug: a Stripe subscription upgrade updates public.subscriptions.tier_id
-- (entitlement) + public.usage_quotas (token allowance) but NEVER resizes the
-- user's Fly Machine. enqueueHermesProvisioning deliberately no-ops a runner
-- that's already 'ready', so an upgrader keeps running on their OLD tier's
-- compute + volume. Dan upgraded Studio -> Max and stayed on shared-2x/2048MB
-- with a 10 GB volume until it was corrected by hand.
--
-- The Fly provider has always had resizeRunner() (extend volume + PATCH the
-- machine guest), but nothing ever CALLED it. This migration adds the durable
-- state + RPCs a cron reconciler (series4:resize-once) needs to detect the
-- drift and drive the resize, mirroring the coworker-reimage lifecycle (0034).
--
-- Right-sizing is server-side only: no mobile-facing flags, so my_product_state
-- is intentionally left untouched (the app already shows the subscription tier).
-- The "tier the machine was actually sized for" is tracked privately.

-- 1. Private, service-role-only right-sizing bookkeeping on the runner record.
--    sized_compute_tier: the plan tier the machine's compute + volume were last
--    sized to. NULL for rows provisioned before this migration / by an older
--    provisioner; the claim RPC falls back to the provisioning tier in that case.
alter table public.hermes_instance_private
  add column if not exists sized_compute_tier text;
alter table public.hermes_instance_private
  add column if not exists resize_leased_until timestamptz;
alter table public.hermes_instance_private
  add column if not exists resize_error text;
alter table public.hermes_instance_private
  add column if not exists resized_at timestamptz;
-- Attempt counter so a permanently-failing resize (bad tier map, Fly refusing
-- the guest spec) stops hot-looping the cron after a handful of tries instead
-- of re-alerting every tick forever. Reset to 0 on success.
alter table public.hermes_instance_private
  add column if not exists resize_attempts integer not null default 0;

-- 2. Backfill: stamp existing live runners as already sized to their CURRENT
--    entitlement so the reconciler doesn't spuriously resize a correctly-sized
--    machine on first run. Every live runner today has been hand-verified to
--    match its plan (Dan's Max machine was corrected on 2026-07-18), so
--    entitlement is the accurate "sized" value. New drift (a future upgrade)
--    is what the reconciler is here to catch.
update public.hermes_instance_private hp
   set sized_compute_tier = coalesce(
         (select s.tier_id from public.subscriptions s where s.user_id = hp.user_id),
         (select hi.provisioning_tier_id from public.hermes_instances hi where hi.user_id = hp.user_id),
         'studio'
       )
 where hp.deleted_at is null
   and hp.sized_compute_tier is null;

-- 3. RPC: claim one runner whose machine size has drifted from its entitlement.
--    A candidate is a LIVE runner (ready/degraded) with an ACTIVE-ish
--    subscription whose current tier differs from the tier the machine was last
--    sized for. Lease-protected (skip locked + resize_leased_until) so
--    overlapping cron ticks never double-resize the same machine.
create or replace function public.claim_runner_resize_candidates(
  p_lease_seconds integer,
  p_limit integer,
  p_max_attempts integer default 5
)
returns table (
  user_id uuid,
  fly_app_name text,
  fly_machine_id text,
  fly_volume_id text,
  fly_region text,
  current_sized_tier text,
  target_tier text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidates as (
    select
      hp.user_id,
      coalesce(nullif(btrim(hp.sized_compute_tier), ''), hi.provisioning_tier_id, 'studio') as sized_tier,
      s.tier_id as entitlement_tier
      from public.hermes_instance_private hp
      join public.hermes_instances hi on hi.user_id = hp.user_id
      join public.subscriptions s on s.user_id = hp.user_id
     where hp.deleted_at is null
       and hp.provider = 'fly_machines'
       and hi.status in ('ready', 'degraded')
       and s.status in ('active', 'trialing', 'past_due')
       and nullif(btrim(hp.fly_app_name), '') is not null
       and nullif(btrim(hp.fly_machine_id), '') is not null
       and nullif(btrim(hp.fly_volume_id), '') is not null
       and nullif(btrim(s.tier_id), '') is not null
       and s.tier_id is distinct from coalesce(nullif(btrim(hp.sized_compute_tier), ''), hi.provisioning_tier_id, 'studio')
       and (hp.resize_leased_until is null or hp.resize_leased_until < now())
       and coalesce(hp.resize_attempts, 0) < greatest(coalesce(p_max_attempts, 5), 1)
     order by hp.resized_at asc nulls first, hp.updated_at asc nulls last
     limit greatest(coalesce(p_limit, 1), 1)
     for update of hp skip locked
  ),
  leased as (
    update public.hermes_instance_private hp
       set resize_leased_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 60)),
           resize_attempts = coalesce(hp.resize_attempts, 0) + 1
      from candidates c
     where hp.user_id = c.user_id
    returning hp.user_id, hp.fly_app_name, hp.fly_machine_id, hp.fly_volume_id, hp.fly_region,
              c.sized_tier as current_sized_tier, c.entitlement_tier as target_tier
  )
  select l.user_id, l.fly_app_name, l.fly_machine_id, l.fly_volume_id, l.fly_region,
         l.current_sized_tier, l.target_tier
    from leased l;
end;
$$;

revoke all on function public.claim_runner_resize_candidates(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_runner_resize_candidates(integer, integer, integer) to service_role;

-- 4. RPC: record a resize outcome (called by the cron after resizeRunner).
--    On success we stamp sized_compute_tier = the applied tier, clear the lease,
--    reset the error + attempt counter. On failure we keep the recorded
--    sized_compute_tier as-is (so the drift is still detected next tick), record
--    the error, and clear the lease so the row is re-claimable until the attempt
--    cap is reached.
create or replace function public.complete_runner_resize(
  p_user_id uuid,
  p_ok boolean,
  p_applied_tier text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_ok then
    update public.hermes_instance_private
       set sized_compute_tier = coalesce(nullif(btrim(p_applied_tier), ''), sized_compute_tier),
           resize_error = null,
           resize_leased_until = null,
           resize_attempts = 0,
           resized_at = now()
     where user_id = p_user_id;
  else
    update public.hermes_instance_private
       set resize_error = left(coalesce(p_error, 'resize_failed'), 500),
           resize_leased_until = null
     where user_id = p_user_id;
  end if;
end;
$$;

revoke all on function public.complete_runner_resize(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.complete_runner_resize(uuid, boolean, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
