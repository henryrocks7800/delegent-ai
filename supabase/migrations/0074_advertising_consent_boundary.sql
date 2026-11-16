begin;

-- Raw referrers can hide click identifiers in arbitrary/encoded parameters.
-- Keep parsed campaign fields, never a second copy of the original payload.
update public.install_attribution a
   set raw_referrer = '',
       fbclid = case when p.advertising_consent is true then a.fbclid else null end
  from public.profiles p where p.id = a.user_id;
update public.install_attribution set raw_referrer = '' where raw_referrer <> '';
update public.install_attribution set decrypt_error = 'decrypt_failed'
  where decrypt_error like 'decrypt_failed:%';
alter table public.install_attribution
  add constraint install_attribution_no_raw_referrer check (raw_referrer = '');
comment on column public.install_attribution.raw_referrer is
  'Retired by 0074. Always empty; raw referral payloads must never be retained.';

-- This also protects older Workers during a rolling release. Inserts take the
-- SAME profile lock as withdrawal before touching the attribution row. A late
-- insert either precedes withdrawal (and is cleared) or sees no consent.
create function public.guard_install_attribution_consent()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
declare allowed boolean;
begin
  new.raw_referrer := '';
  if new.decrypt_error like 'decrypt_failed:%' then new.decrypt_error := 'decrypt_failed'; end if;
  if tg_op = 'INSERT' then
    select advertising_consent into allowed from public.profiles
      where id = new.user_id for update;
    if allowed is not true then return null; end if;
  elsif new.user_id is distinct from old.user_id
     or (new.fbclid is not null and new.fbclid is distinct from old.fbclid) then
    raise exception 'First attribution cannot be replaced or restored';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_install_attribution_consent() from public, anon, authenticated;
create trigger install_attribution_consent_guard before insert or update
  on public.install_attribution for each row
  execute function public.guard_install_attribution_consent();

create or replace function public.set_advertising_consent(
  p_user_id uuid, p_granted boolean, p_at timestamptz default now()
) returns boolean language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  update public.profiles set advertising_consent = p_granted,
    advertising_consent_at = p_at where id = p_user_id;
  if not found then return false; end if;
  if p_granted is not true then
    update public.install_attribution set fbclid = null, raw_referrer = ''
      where user_id = p_user_id;
  end if;
  return true;
end;
$$;

-- Persist each device's last intent so an HTTP request delayed past its timeout
-- cannot reapply an older grant after a newer withdrawal. Replays acknowledge
-- the current answer without overwriting a subsequent choice on another device.
create table public.advertising_consent_devices (
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_id text not null check (length(device_id) between 1 and 128),
  revision bigint not null check (revision > 0),
  primary key (user_id, device_id)
);
alter table public.advertising_consent_devices enable row level security;
revoke all on public.advertising_consent_devices from anon, authenticated;
grant select on public.advertising_consent_devices to service_role;
create function public.set_advertising_consent_versioned(
  p_user_id uuid, p_granted boolean, p_device_id text, p_revision bigint
) returns boolean language plpgsql security definer
set search_path = public, pg_temp as $$
declare current_answer boolean; previous_revision bigint;
begin
  if p_granted is null or p_revision is null or p_revision <= 0
     or p_device_id is null or length(p_device_id) not between 1 and 128 then
    return false;
  end if;
  select advertising_consent into current_answer from public.profiles
    where id = p_user_id for update;
  if not found then return false; end if;
  select revision into previous_revision from public.advertising_consent_devices
    where user_id = p_user_id and device_id = p_device_id;
  if previous_revision > p_revision then return false; end if;
  if previous_revision = p_revision then
    return current_answer is not distinct from p_granted;
  end if;
  insert into public.advertising_consent_devices values (p_user_id, p_device_id, p_revision)
    on conflict (user_id, device_id) do update set revision = excluded.revision;
  return public.set_advertising_consent(p_user_id, p_granted);
end;
$$;
revoke all on function public.set_advertising_consent_versioned(uuid, boolean, text, bigint) from public, anon, authenticated;
grant execute on function public.set_advertising_consent_versioned(uuid, boolean, text, bigint) to service_role;

create function public.record_consented_install_attribution(p_user_id uuid, p_attribution jsonb)
returns boolean language plpgsql security definer
set search_path = public, pg_temp as $$
declare allowed boolean;
begin
  select advertising_consent into allowed from public.profiles
    where id = p_user_id for update;
  if allowed is not true then return false; end if;
  insert into public.install_attribution (
    user_id, raw_referrer, utm_source, utm_medium, utm_campaign,
    meta_campaign_id, meta_adgroup_id, meta_ad_id, meta_account_id,
    meta_placement, fbclid, decrypt_error, referrer_click_at, install_begin_at
  ) values (
    p_user_id, '', left(p_attribution->>'utm_source',512), left(p_attribution->>'utm_medium',512),
    left(p_attribution->>'utm_campaign',512), left(p_attribution->>'meta_campaign_id',128),
    left(p_attribution->>'meta_adgroup_id',128), left(p_attribution->>'meta_ad_id',128),
    left(p_attribution->>'meta_account_id',128), left(p_attribution->>'meta_placement',128),
    left(p_attribution->>'fbclid',512), left(p_attribution->>'decrypt_error',512),
    (p_attribution->>'referrer_click_at')::timestamptz,
    (p_attribution->>'install_begin_at')::timestamptz
  ) on conflict (user_id) do nothing;
  return true;
end;
$$;
revoke all on function public.record_consented_install_attribution(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_consented_install_attribution(uuid, jsonb) to service_role;

-- A single database snapshot joins the CURRENT answer to the retained click.
-- Consumers call this immediately before dispatch, never send a cached click.
create function public.get_consented_install_attribution(p_user_id uuid)
returns table (fbclid text, referrer_click_at timestamptz, captured_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.fbclid, a.referrer_click_at, a.captured_at
    from public.install_attribution a join public.profiles p on p.id = a.user_id
   where a.user_id = p_user_id and p.advertising_consent is true and a.fbclid is not null;
$$;
revoke all on function public.get_consented_install_attribution(uuid) from public, anon, authenticated;
grant execute on function public.get_consented_install_attribution(uuid) to service_role;

commit;
