begin;

-- 0072 — the advertising choice, recorded where the server can honour it
--
-- The app asks one question: may we measure whether an advert brought you
-- here. The answer lived only in AsyncStorage on the handset, and the server
-- never saw it. So the Worker's Conversions API call, which sends Meta a
-- user-level click identifier tied to the account, ran for everybody with a
-- click id in their install referrer regardless of the answer. Reproduced on
-- 2026-09-13: a request carrying advertisingConsent=false still sent the signup
-- event, because nothing read it.
--
-- The published copy made it worse by describing that send as identifying the
-- advert rather than the person, and as involving nothing read from the device.
-- The click identifier is per click and is stored against the account, and the
-- app does read the Play referrer.
--
-- NULL means never answered, which behaves exactly like no. Consent is a thing
-- somebody gives, not a thing they fail to withhold.

alter table public.profiles
  add column if not exists advertising_consent boolean,
  add column if not exists advertising_consent_at timestamptz;

comment on column public.profiles.advertising_consent is
  'The in-app advertising measurement answer. NULL = never asked, and treated as no. Governs user-level click-id collection and transmission.';

-- ---------------------------------------------------------------------------
-- set_advertising_consent — the answer, and withdrawal that actually withdraws
-- ---------------------------------------------------------------------------
-- Withdrawal is not just "stop asking". It also clears the user-level click
-- identifier already held against the install, so a later send cannot use it.
-- The campaign fields stay: those identify the advert, which is the anonymous
-- count the privacy policy describes and which needs no consent.

create or replace function public.set_advertising_consent(
  p_user_id uuid,
  p_granted boolean,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.profiles
     set advertising_consent = p_granted,
         advertising_consent_at = p_at
   where id = p_user_id;

  if not found then
    return false;
  end if;

  if p_granted is not true then
    update public.install_attribution
       set fbclid = null
     where user_id = p_user_id
       and fbclid is not null;
  end if;

  return true;
end;
$$;

revoke all on function public.set_advertising_consent(uuid, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.set_advertising_consent(uuid, boolean, timestamptz) to service_role;

commit;
