begin;

create or replace function public.update_mobile_profile(
  p_full_name text,
  p_agent_name text,
  p_region text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_full_name text := left(regexp_replace(coalesce(nullif(trim(p_full_name), ''), ''), '\s+', ' ', 'g'), 80);
  v_agent_name text := left(regexp_replace(coalesce(nullif(trim(p_agent_name), ''), ''), '\s+', ' ', 'g'), 40);
  v_region text := left(regexp_replace(coalesce(nullif(trim(p_region), ''), 'United Kingdom'), '\s+', ' ', 'g'), 80);
  v_email text := coalesce(nullif(auth.jwt() ->> 'email', ''), 'signed-in account');
begin
  if v_user_id is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;

  if length(v_full_name) < 2 or v_full_name !~ '[[:alnum:]]' then
    raise exception 'invalid display name' using errcode = '22023';
  end if;

  if length(v_agent_name) < 1 or v_agent_name !~ '[[:alpha:]]' then
    raise exception 'invalid agent name' using errcode = '22023';
  end if;

  if length(v_region) < 2 or v_region !~ '[[:alnum:]]' then
    raise exception 'invalid region' using errcode = '22023';
  end if;

  update public.profiles
    set full_name = v_full_name,
        agent_name = v_agent_name,
        region = v_region,
        updated_at = now()
  where id = v_user_id;

  if not found then
    insert into public.profiles (id, email, full_name, agent_name, region, updated_at)
    values (v_user_id, v_email, v_full_name, v_agent_name, v_region, now());
  end if;
end;
$$;

revoke execute on function public.update_mobile_profile(text, text, text) from public, anon;
grant execute on function public.update_mobile_profile(text, text, text) to authenticated;

commit;
