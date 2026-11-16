begin;

-- Fallback when Stripe/Apple's trial-end webhook is delayed. Lock the
-- subscription through suspension so a concurrent paid renewal cannot be
-- suspended after it activates. Live request gates also check the deadline.
create or replace function public.expire_unpaid_trials(
  p_retention_seconds integer default 2592000,
  p_limit integer default 100,
  p_at timestamptz default now(),
  p_only_user_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_count integer := 0;
begin
  for v_user_id in
    select s.user_id from public.subscriptions s
    where s.status = 'trialing'
      and (s.current_period_end is null or s.current_period_end <= p_at)
      and (p_only_user_id is null or s.user_id = p_only_user_id)
    order by s.current_period_end nulls first, s.user_id
    limit greatest(1, least(coalesce(p_limit, 100), 100))
    for update of s skip locked
  loop
    update public.subscriptions
    set status = 'canceled', updated_at = p_at
    where user_id = v_user_id;
    -- Leave provider_updated_at unchanged: a delayed real paid invoice must
    -- still be able to restore the account using its provider timestamp.
    perform public.mark_hermes_runner_suspended(
      v_user_id, p_retention_seconds,
      'Your free trial has ended. Update your billing to resume your digital employee.',
      p_at
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.expire_unpaid_trials(integer, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.expire_unpaid_trials(integer, integer, timestamptz, uuid) to service_role;

commit;
