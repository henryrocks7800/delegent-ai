-- Take the default grants off install_attribution.
--
-- 0051 created the table and enabled RLS, which is what actually protects it:
-- RLS with no policies denies every row to any role that does not bypass it, so
-- the table was never readable by a client. But it was left holding the grants
-- Supabase issues to `anon` and `authenticated` on every new public-schema
-- table, verified live on 2026-08-06 as SELECT/INSERT/UPDATE/DELETE for both.
--
-- That is one mistake away from being real. Anything that later adds a
-- permissive policy, or disables RLS during an investigation, immediately hands
-- anon full DELETE on the table. Defence should not rest on a single switch.
--
-- The model here is `hermes_instance_private` (revoked from both roles), not
-- `push_tokens` (which still grants `authenticated`), because no client ever
-- touches this table: the mobile app posts its referrer to the Worker, and the
-- Worker writes here with the service role, which bypasses RLS and is unaffected
-- by these revokes.
--
-- Attribution data says which advert a given person responded to. That is not
-- something one user should be able to read about another, and not something an
-- unauthenticated caller should be able to destroy.

revoke all on public.install_attribution from anon;
revoke all on public.install_attribution from authenticated;

-- Re-assert RLS. It is already on from 0051 and this is a no-op today; it is
-- here so that this migration alone is sufficient to leave the table in the
-- intended state if it is ever replayed against a database where 0051 landed
-- differently. It does NOT stop default privileges being re-granted, and no
-- statement here does: a future `create table` in this schema will still pick
-- up the default grants, which is why the check belongs in review, not here.
alter table public.install_attribution enable row level security;
