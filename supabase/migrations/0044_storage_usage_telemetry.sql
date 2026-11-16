begin;

-- 0044 — storage usage telemetry
--
-- usage_quotas.consumed_storage_bytes has existed since 0026 and is READ by the
-- Worker's downgrade guard (apps/worker/src/stripe-flow.ts), but nothing has
-- ever WRITTEN it, so it is 0 for every user and the guard is a no-op. That also
-- blocks every part of docs/DYNAMIC_RESOURCE_SIZING.md: we cannot start volumes
-- small, auto-grow at 75%, or enforce a fair-use cap without measuring usage.
--
-- The measurement comes from the Fly volumes API (blocks/blocks_free/block_size),
-- read by the provisioner cron, which is the only place that holds FLY_API_TOKEN.
-- No runner endpoint and therefore no golden-image rebuild is needed.
--
-- Server-side only: consumed_storage_bytes is deliberately NOT added to
-- my_product_state in this migration. Surfacing storage in the app is a separate
-- product decision (and needs the auto-grow work first, otherwise the number is
-- measured against a quota the disk cannot actually honour).

-- 1. Freshness stamp so the sweep can skip recently-measured users and so
--    auto-grow (P3) can refuse to act on a stale reading.
alter table public.usage_quotas
  add column if not exists storage_measured_at timestamptz;

-- 2. RPC: list live Fly-backed runners whose storage reading is stale.
--    Read-only and lease-free: the sweep is idempotent, cheap (one Fly GET per
--    user), and the cron workflow already serialises itself via a concurrency
--    group, so a lease would be ceremony without benefit.
create or replace function public.list_storage_usage_targets(
  p_limit integer default 25,
  p_stale_seconds integer default 3600
)
returns table (
  user_id uuid,
  fly_app_name text,
  fly_volume_id text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select hp.user_id, hp.fly_app_name, hp.fly_volume_id
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

-- 3. RPC: record one measurement. Upserts so a user whose quota row was never
--    created (pre-0002 profile) still gets a reading instead of silently
--    dropping it. Negative readings are clamped to satisfy
--    usage_quotas_storage_nonneg_check.
create or replace function public.record_storage_usage(
  p_user_id uuid,
  p_consumed_bytes bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.usage_quotas (user_id, consumed_storage_bytes, storage_measured_at)
  values (p_user_id, greatest(coalesce(p_consumed_bytes, 0), 0), now())
  on conflict (user_id) do update
     set consumed_storage_bytes = greatest(coalesce(excluded.consumed_storage_bytes, 0), 0),
         storage_measured_at = now();
end;
$$;

revoke all on function public.record_storage_usage(uuid, bigint) from public, anon, authenticated;
grant execute on function public.record_storage_usage(uuid, bigint) to service_role;

notify pgrst, 'reload schema';

commit;
