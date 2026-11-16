begin;

-- 0045 — expose each target's storage entitlement to the sweep
--
-- 0044 gave the cron a way to MEASURE storage. Auto-grow (P3) also needs the
-- ceiling it is allowed to grow to, and that ceiling is the user's entitlement
-- (usage_quotas.storage_quota_bytes), not the volume's current size. Returning
-- it from the same RPC keeps the sweep at one round-trip per tick.
--
-- storage_quota_bytes is nullable here on purpose: a user with no usage_quotas
-- row has no proven entitlement, and the sweep refuses to grow rather than
-- assuming a default.
--
-- The return type changes, so the function must be dropped before recreating.

drop function if exists public.list_storage_usage_targets(integer, integer);

create function public.list_storage_usage_targets(
  p_limit integer default 25,
  p_stale_seconds integer default 3600
)
returns table (
  user_id uuid,
  fly_app_name text,
  fly_volume_id text,
  storage_quota_bytes bigint
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select hp.user_id, hp.fly_app_name, hp.fly_volume_id, uq.storage_quota_bytes
    from public.hermes_instance_private hp
    join public.hermes_instances hi on hi.user_id = hp.user_id
    left join public.usage_quotas uq on uq.user_id = hp.user_id
   where hp.deleted_at is null
     and hp.provider = 'fly_machines'
     and hi.status in ('ready', 'degraded')
     and nullif(btrim(hp.fly_app_name), '') is not null
     and nullif(btrim(hp.fly_volume_id), '') is not null
     and (
       uq.storage_measured_at is null
       or uq.storage_measured_at < now() - make_interval(secs => greatest(coalesce(p_stale_seconds, 3600), 60))
     )
   order by uq.storage_measured_at asc nulls first
   limit greatest(coalesce(p_limit, 25), 1);
$$;

revoke all on function public.list_storage_usage_targets(integer, integer) from public, anon, authenticated;
grant execute on function public.list_storage_usage_targets(integer, integer) to service_role;

notify pgrst, 'reload schema';

commit;
