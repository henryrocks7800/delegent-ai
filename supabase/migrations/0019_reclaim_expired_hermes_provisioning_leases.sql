begin;

-- Reclaim a provisioning job only when the worker lease has expired AND no
-- private Railway/provider output was ever recorded. This preserves the
-- duplicate-deploy guard while letting provider-side preflight failures such as
-- Railway free-plan limits recover after an operator frees capacity.
create or replace function public.claim_next_hermes_provisioning_job(
  p_claimed_at timestamptz default now(),
  p_lease_seconds int default 1800
)
returns table(user_id uuid, tier_id text, idempotency_key text, claimed_at timestamptz, agent_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with candidate as (
    select
      hi.user_id,
      coalesce(nullif(btrim(p.agent_name), ''), 'Ruben') as agent_name
    from public.hermes_instances hi
    join public.subscriptions s on s.user_id = hi.user_id
    left join public.profiles p on p.id = hi.user_id
    where (
        hi.status = 'queued'
        or (
          hi.status = 'provisioning'
          and hi.provisioning_lease_expires_at is not null
          and hi.provisioning_lease_expires_at <= p_claimed_at
        )
      )
      and not exists (
        select 1
        from public.hermes_instance_private hp
        where hp.user_id = hi.user_id
          and (
            hp.railway_project_id is not null
            or hp.railway_workflow_id is not null
            or hp.runner_base_url is not null
          )
      )
      and coalesce(s.status, 'inactive') in ('active', 'trialing', 'past_due')
      and hi.provisioning_tier_id = s.tier_id
    order by hi.provisioning_requested_at nulls first, hi.updated_at nulls first, hi.user_id
    limit 1
    for update of hi skip locked
  ), claimed as (
    update public.hermes_instances hi
    set
      status = 'provisioning',
      provisioning_claimed_at = p_claimed_at,
      provisioning_lease_expires_at = p_claimed_at + make_interval(secs => greatest(p_lease_seconds, 300)),
      public_status_message = 'Preparing Coworker AI workspace...',
      error_code = null
    from candidate
    where hi.user_id = candidate.user_id
    returning hi.user_id, hi.provisioning_tier_id, hi.provisioning_idempotency_key, candidate.agent_name
  )
  select
    claimed.user_id,
    claimed.provisioning_tier_id,
    claimed.provisioning_idempotency_key,
    p_claimed_at,
    left(regexp_replace(claimed.agent_name, '\s+', ' ', 'g'), 40)
  from claimed;
end;
$$;

revoke all on function public.claim_next_hermes_provisioning_job(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_next_hermes_provisioning_job(timestamptz, integer) to service_role;

commit;
