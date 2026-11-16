begin;

-- Preferences only. These IDs are never evidence of a connected account.
alter table public.profiles add column onboarding_apps text[]
  check (cardinality(onboarding_apps) <= 50);

create function public.set_my_onboarding_apps(p_service_ids text[])
returns void language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_ids text[];
begin
  if v_user_id is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;
  if p_service_ids is null or cardinality(p_service_ids) > 50
    or coalesce(array_ndims(p_service_ids), 1) <> 1
    or exists (select 1 from unnest(p_service_ids) id where id is null or id not in (
      'dropbox', 'slack', 'github', 'google_drive', 'google_calendar',
      'microsoft_outlook', 'microsoft_teams', 'freeagent', 'gmail', 'quickbooks',
      'google_sheets', 'google_docs', 'notion', 'trello', 'asana', 'clickup',
      'google_tasks', 'zendesk', 'jira', 'confluence', 'onedrive', 'hubspot',
      'salesforce', 'stripe', 'youtube', 'reddit', 'linkedin', 'instagram',
      'facebook', 'pdf_co', 'freshdesk', 'firecrawl', 'agent_mail', 'figma',
      'shopify', 'webflow'
    )) then
    raise exception 'invalid app selection' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct id order by id), '{}'::text[]) into v_ids
    from unnest(p_service_ids) id;
  insert into public.profiles (id, email, onboarding_goal, onboarding_apps)
    values (v_user_id, '', 'something_else', v_ids)
    on conflict (id) do update set onboarding_goal = excluded.onboarding_goal,
      onboarding_apps = excluded.onboarding_apps, updated_at = now();
end;
$$;

create function public.get_my_onboarding_apps()
returns text[] language sql stable security definer
set search_path = public, pg_temp as $$
  select onboarding_apps from public.profiles where id = auth.uid();
$$;

revoke execute on function public.set_my_onboarding_apps(text[]) from public, anon;
revoke execute on function public.get_my_onboarding_apps() from public, anon;
grant execute on function public.set_my_onboarding_apps(text[]) to authenticated;
grant execute on function public.get_my_onboarding_apps() to authenticated;

commit;
