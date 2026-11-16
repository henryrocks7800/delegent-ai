-- =============================================================================
-- 0003_security_hardening.sql
-- =============================================================================
-- Hardening pass against the read-only security review.
--
-- 1. Tighten `search_path` on every SECURITY DEFINER function so a malicious
--    schema cannot shadow the public objects the functions reference. The
--    canonical Supabase recommendation is `set search_path = public, pg_temp`
--    (the prior `set search_path = public` omitted `pg_temp`, which made the
--    functions slightly brittle against extension/schema-shadowing attacks).
--
-- 2. Re-declare the `set_updated_at` trigger as SECURITY INVOKER explicitly,
--    with the same hardened search_path. It was previously defined without
--    SECURITY DEFINER, so it already runs as the invoker, but locking the
--    search_path closes the same shadowing class for completeness.
--
-- This migration is additive and idempotent. Re-running it has no effect.
-- =============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'))
  on conflict (id) do nothing;

  insert into public.subscriptions (user_id, status, tier_id)
  values (new.id, 'inactive', 'studio')
  on conflict (user_id) do nothing;

  insert into public.hermes_instances (user_id, status, public_status_message)
  values (new.id, 'not_requested', 'Waiting for subscription activation')
  on conflict (user_id) do nothing;

  insert into public.usage_quotas (user_id, monthly_token_quota, tier_id)
  values (new.id, 200000, 'studio')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

-- The `EXECUTE` privilege on `handle_new_user` should not be public — only
-- the auth trigger needs it. Lock it down explicitly so a future privilege
-- regression is loud rather than silent.
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;
