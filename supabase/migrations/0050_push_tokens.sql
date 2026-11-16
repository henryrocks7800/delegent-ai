-- Push notification device tokens.
--
-- The coworker does work the user is not watching: a routine runs on a
-- schedule, a long task finishes after the app is closed, or the safety gate
-- blocks on an approval and waits. Today all three are silent, so the user has
-- to open the app and check. This table is the first half of fixing that.
--
-- One row per (user, device token). A user can have several devices; the same
-- token can migrate between users on a shared device (sign out, sign in as
-- someone else), so the token alone is the natural key and its owner is simply
-- overwritten on re-registration.

create table if not exists public.push_tokens (
  token         text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  platform      text not null default 'android',
  -- Cleared when Expo tells us a token is dead (DeviceNotRegistered). Keeping
  -- the row rather than deleting it means a device that re-registers keeps its
  -- identity, and lets us see churn instead of it silently vanishing.
  disabled_at   timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint push_tokens_platform_known check (platform in ('android', 'ios')),
  constraint push_tokens_token_shape check (length(btrim(token)) between 8 and 512)
);

create index if not exists push_tokens_user_active_idx
  on public.push_tokens (user_id)
  where disabled_at is null;

alter table public.push_tokens enable row level security;

-- The Worker (service-role) does all reading and sending; it bypasses RLS.
-- A signed-in user may see and remove their OWN device rows so "sign me out of
-- this device" is possible from the client, but never write one directly:
-- registration goes through the Worker, which is the only party that should
-- decide a token belongs to a user. No anon access at all.
drop policy if exists push_tokens_owner_select on public.push_tokens;
create policy push_tokens_owner_select on public.push_tokens
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists push_tokens_owner_delete on public.push_tokens;
create policy push_tokens_owner_delete on public.push_tokens
  for delete to authenticated
  using (user_id = auth.uid());

-- Revoke BEFORE granting, from both roles. Supabase's default privileges grant
-- new public-schema tables to anon and authenticated, so a bare `grant select,
-- delete` leaves INSERT and UPDATE in place — proved on the live database,
-- where has_table_privilege('authenticated', ..., 'insert') came back true
-- after the first apply. RLS still refused those writes (there is no INSERT or
-- UPDATE policy), so this was defence-in-depth rather than an open door, but a
-- grant that contradicts the intent is exactly what someone later reads as
-- permission to add the missing policy.
revoke all on public.push_tokens from anon;
revoke all on public.push_tokens from authenticated;
grant select, delete on public.push_tokens to authenticated;
