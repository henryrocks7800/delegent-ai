begin;

alter table public.profiles add column onboarding_goal text
  check (onboarding_goal in ('receipts', 'inbox', 'admin', 'something_else'));

-- Only the authenticated person's own preference is readable/writable.
-- Separate RPCs preserve the existing onboarding contract for older binaries.
create function public.set_my_onboarding_goal(p_goal text)
returns void language plpgsql security definer
set search_path = public, pg_temp as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;
  if p_goal is null or p_goal not in ('receipts', 'inbox', 'admin', 'something_else') then
    raise exception 'invalid goal' using errcode = '22023';
  end if;
  insert into public.profiles (id, email, onboarding_goal)
  values (v_user_id, '', p_goal)
  on conflict (id) do update set onboarding_goal = excluded.onboarding_goal, updated_at = now();
end;
$$;

create function public.get_my_onboarding_goal()
returns text language sql stable security definer
set search_path = public, pg_temp as $$
  select onboarding_goal from public.profiles where id = auth.uid();
$$;

revoke execute on function public.set_my_onboarding_goal(text) from public, anon;
revoke execute on function public.get_my_onboarding_goal() from public, anon;
grant execute on function public.set_my_onboarding_goal(text) to authenticated;
grant execute on function public.get_my_onboarding_goal() to authenticated;

commit;
