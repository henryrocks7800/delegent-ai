begin;

-- 0047 — OAuth connections ("Connections", the user-facing name for plugins)
--
-- Custody model, and why it is not the on-box vault we already have.
--
-- The runner's encrypted vault (services/hermes-runner/skills/delegent/_shared/
-- credential_store.py) is the right home for a credential the AGENT is meant to
-- hold. A third-party OAuth REFRESH token is not that. Three reasons it lives
-- here instead:
--
--   1. The runner executes arbitrary agent-authored code, so anything a helper
--      script can decrypt, the agent can decrypt. The vault's "the agent cannot
--      echo a secret back" property is a convention, not an isolation boundary.
--      A refresh token is an offline, long-lived grant over the user's real
--      Dropbox; it should never be reachable from there.
--   2. The vault derives its key from a file on the same volume as the
--      ciphertext, so destroying or reimaging a runner destroys every
--      connection with it. Reimaging is routine for us.
--   3. Refresh-token rotation needs exactly one writer. With the token on the
--      box AND in a broker, two concurrent refreshes race and the loser holds a
--      token the provider has already invalidated, which presents as a
--      connection that silently dies days later.
--
-- So: the refresh token stays here, encrypted, service-role only. The runner is
-- handed a short-lived ACCESS token per use over the existing HMAC v1 channel.
-- This is also what ChatGPT does (the OAuth callback terminates on their own
-- backend, never on the device), which is the point of modelling it on them.

-- 1. The connection itself. One row per (user, provider).
create table if not exists public.user_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Matches the catalogue id in packages/shared/src/connections.ts.
  provider text not null check (provider ~ '^[a-z0-9_]{1,64}$'),
  -- 'connected'    usable now.
  -- 'needs_reauth' refresh failed terminally (revoked at the provider, password
  --                change, scope withdrawn). Never auto-retried; the user is
  --                asked to reconnect. Distinguishing this from a transient
  --                failure is what stops us hammering a dead grant forever.
  -- 'revoked'      we revoked it on the user's instruction; kept briefly for
  --                display, then deleted.
  status text not null default 'connected'
    check (status in ('connected', 'needs_reauth', 'revoked')),
  -- Non-secret, shown in the UI so the user can tell WHICH account is linked
  -- ("Connected as alex@..."). Read back from the provider, never guessed.
  account_label text,
  -- Exactly what the user consented to, so a client can refuse to offer an
  -- action outside the grant instead of failing at the provider.
  scopes text[] not null default '{}',
  -- AES-256-GCM, key held only by the Worker (SIDEKICK_CONNECTIONS_ENC_KEY).
  -- Postgres never sees plaintext, so a database compromise alone is not enough.
  access_token_enc text,
  refresh_token_enc text,
  access_expires_at timestamptz,
  -- Single-flight refresh lease. Held briefly by whichever request refreshes;
  -- see claim_connection_refresh below.
  refresh_lease_until timestamptz,
  -- Last terminal failure, for an honest message in the UI. Never a token.
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create index if not exists user_connections_user_idx
  on public.user_connections (user_id)
  where status = 'connected';

alter table public.user_connections enable row level security;

-- No anon/authenticated policy on purpose. Clients never read this table; they
-- go through the Worker, which returns a safe projection (provider, status,
-- account_label, scopes) and never the token columns.
revoke all on table public.user_connections from public, anon, authenticated;
grant select, insert, update, delete on table public.user_connections to service_role;

-- 2. In-flight authorisation attempts. Holds the PKCE verifier between the
--    start endpoint and the callback. Rows are short-lived and single use.
create table if not exists public.connection_oauth_flows (
  -- The `state` parameter. Primary key so a replayed callback collides rather
  -- than creating a second flow.
  state text primary key check (length(state) between 32 and 128),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider ~ '^[a-z0-9_]{1,64}$'),
  -- RFC 7636 code_verifier. Not a bearer credential on its own (useless without
  -- the authorization code) but still short-lived and service-role only.
  code_verifier text not null,
  -- Where to send the user afterwards. An enum, NOT a caller-supplied URL: the
  -- final redirect target is resolved from this server-side, which is what
  -- keeps the callback from becoming an open redirect.
  return_surface text not null check (return_surface in ('app', 'web')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists connection_oauth_flows_expiry_idx
  on public.connection_oauth_flows (expires_at);

alter table public.connection_oauth_flows enable row level security;
revoke all on table public.connection_oauth_flows from public, anon, authenticated;
grant select, insert, update, delete on table public.connection_oauth_flows to service_role;

-- 3. Atomically consume a flow. Returns the row only if it is unconsumed and
--    unexpired, and marks it consumed in the same statement. A replayed or
--    forged callback therefore gets nothing, even under concurrency.
create or replace function public.consume_connection_oauth_flow(p_state text)
returns table (
  user_id uuid,
  provider text,
  code_verifier text,
  return_surface text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.connection_oauth_flows f
     set consumed_at = now()
   where f.state = p_state
     and f.consumed_at is null
     and f.expires_at > now()
  returning f.user_id, f.provider, f.code_verifier, f.return_surface;
$$;

revoke all on function public.consume_connection_oauth_flow(text) from public, anon, authenticated;
grant execute on function public.consume_connection_oauth_flow(text) to service_role;

-- 4. Single-flight refresh lease.
--
-- This exists because of a specific, hard-to-debug failure: with rotating
-- refresh tokens, two concurrent refreshes both spend the same token, the
-- provider invalidates it, and we persist whichever response landed last. The
-- connection then works until the access token expires and dies permanently
-- some hours later, far from the cause. Only the caller that wins the lease
-- refreshes; everyone else waits and re-reads.
create or replace function public.claim_connection_refresh(
  p_user_id uuid,
  p_provider text,
  p_lease_seconds integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed boolean;
begin
  update public.user_connections c
     set refresh_lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 30), 5)),
         updated_at = now()
   where c.user_id = p_user_id
     and c.provider = p_provider
     and c.status = 'connected'
     and (c.refresh_lease_until is null or c.refresh_lease_until < now())
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_connection_refresh(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_connection_refresh(uuid, text, integer) to service_role;

-- 5. Housekeeping: drop spent and expired flows. Called opportunistically by
--    the callback so it needs no cron of its own.
create or replace function public.purge_expired_connection_flows()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with gone as (
    delete from public.connection_oauth_flows
     where expires_at < now() - interval '1 hour'
        or (consumed_at is not null and consumed_at < now() - interval '1 hour')
    returning 1
  )
  select coalesce(count(*), 0)::integer from gone;
$$;

revoke all on function public.purge_expired_connection_flows() from public, anon, authenticated;
grant execute on function public.purge_expired_connection_flows() to service_role;

commit;
