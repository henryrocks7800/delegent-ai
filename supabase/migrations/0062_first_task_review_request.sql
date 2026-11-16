begin;

alter table public.profiles add column store_review_requested_at timestamptz;

-- One request per account across sessions and devices. Only server-confirmed
-- successful work qualifies; a client completion message alone is insufficient.
create function public.claim_my_first_task_review(p_expected_user_id uuid)
returns text language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_requested_at timestamptz;
begin
  if v_user_id is null or v_user_id is distinct from p_expected_user_id then
    raise exception 'sign in required' using errcode = '28000';
  end if;
  select store_review_requested_at into v_requested_at
    from public.profiles where id = v_user_id for update;
  if not found then return 'not_ready'; end if;
  if v_requested_at is not null then return 'already_requested'; end if;
  if not exists (select 1 from public.task_runs
    where user_id = v_user_id and status = 'succeeded'
      and completed_at is not null and error_code is null) then
    return 'not_ready';
  end if;
  update public.profiles set store_review_requested_at = now() where id = v_user_id;
  return 'claimed';
end;
$$;

revoke execute on function public.claim_my_first_task_review(uuid) from public, anon;
grant execute on function public.claim_my_first_task_review(uuid) to authenticated;

commit;
