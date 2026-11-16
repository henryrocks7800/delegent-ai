begin;

-- 0071 — account erasure that can be resumed, fenced and proven
--
-- Three confirmed defects, all of them the same shape: the request row knew
-- that a deletion had been asked for and nothing about how far it had got.
--
--  1. INTERRUPTED ERASURE HAD NO RECOVERY. The endpoint inserts the durable
--     request, then deletes the Supabase auth user. When that returned 503 the
--     endpoint correctly answered 503, but the queue behind it only ever did
--     Fly teardown, and then reported `completed` with the auth user still
--     there. A second attempt by the same person collided with the open-request
--     unique index (23505) before it reached auth deletion at all, so the retry
--     path was closed too. Reproduced against the live functions.
--
--  2. FAILED CONNECTOR CLEANUP DIED WITH THE ACCOUNT. A Composio DELETE
--     returning 503 left the grant live, and the only record of it was a
--     warning line plus a provisioning_events row, which the same auth/profile
--     cascade then deleted. The evidence for work still owed vanished with the
--     account that owed it.
--
--  3. COMPLETION WAS NOT FENCED. record_account_deletion_request_completed
--     took only the request id, so a claimant whose lease had expired could
--     complete a row a newer claimant was in the middle of processing.
--
-- The answer is phases, a claim token, and a cleanup list that lives on a table
-- with no foreign key to the account. Completion now requires every phase, so
-- no single worker can declare an account erased on the strength of its own
-- half of the job.

alter table public.account_deletion_requests
  -- Minted on every claim and required by every terminal write. An expired
  -- claimant holds a token that no longer matches.
  add column if not exists processing_token uuid,
  add column if not exists auth_deleted_at timestamptz,
  add column if not exists connections_cleared_at timestamptz,
  add column if not exists infrastructure_cleared_at timestamptz,
  -- What is still owed at a broker, by id. Deliberately NOT credentials: a
  -- Composio revoke needs only the connected-account id and our own API key,
  -- and the one native connector left has no server-side revoke endpoint at
  -- all, so there is nothing a retained token could retry. Keeping encrypted
  -- grants here to "enable retries" would extend credential retention for a
  -- retry that cannot exist.
  add column if not exists pending_cleanup jsonb not null default '[]'::jsonb,
  add column if not exists cleanup_attempts integer not null default 0;

alter table public.account_deletion_requests
  drop constraint if exists account_deletion_requests_pending_cleanup_check;
alter table public.account_deletion_requests
  add constraint account_deletion_requests_pending_cleanup_check
  check (jsonb_typeof(pending_cleanup) = 'array');

-- Historical rows predate the phases. There are none live as at 2026-09-13;
-- this exists so a restored backup does not read as half-finished work.
update public.account_deletion_requests
   set auth_deleted_at = coalesce(auth_deleted_at, completed_at),
       connections_cleared_at = coalesce(connections_cleared_at, completed_at),
       infrastructure_cleared_at = coalesce(infrastructure_cleared_at, completed_at)
 where status = 'completed';

create index if not exists account_deletion_requests_unfinished_idx
  on public.account_deletion_requests(requested_at)
  where completed_at is null;

-- ---------------------------------------------------------------------------
-- open_account_deletion_request — asking twice is not an error
-- ---------------------------------------------------------------------------
-- The partial unique index is right: one open request per account. Treating a
-- second attempt as a failure was not. Somebody whose first attempt died on a
-- 503 pressed the button again and got another failure, with no way through.

create or replace function public.open_account_deletion_request(
  p_user_id uuid,
  p_user_email text,
  p_requested_via text,
  p_teardown_by timestamptz,
  p_subject_snapshot jsonb default '{}'::jsonb,
  p_teardown_snapshot jsonb default '{}'::jsonb,
  p_at timestamptz default now()
)
returns setof public.account_deletion_requests
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.account_deletion_requests as adr (
    user_id, user_email, status, requested_via, requested_at, teardown_by,
    subject_snapshot, teardown_snapshot, created_at, updated_at
  )
  values (
    p_user_id, p_user_email, 'requested', coalesce(p_requested_via, 'mobile_app'), p_at, p_teardown_by,
    coalesce(p_subject_snapshot, '{}'::jsonb), coalesce(p_teardown_snapshot, '{}'::jsonb), p_at, p_at
  )
  on conflict (user_id) where status in ('requested', 'processing')
  do update set
    updated_at = p_at,
    user_email = coalesce(adr.user_email, excluded.user_email),
    -- A later attempt may know more about the workspace than the first one
    -- did, and an empty snapshot is exactly the state that produced a teardown
    -- reporting success with nothing torn down.
    teardown_snapshot = case
      when adr.teardown_snapshot = '{}'::jsonb then excluded.teardown_snapshot
      else adr.teardown_snapshot
    end,
    subject_snapshot = case
      when adr.subject_snapshot = '{}'::jsonb then excluded.subject_snapshot
      else adr.subject_snapshot
    end
  returning adr.*;
$$;

revoke all on function public.open_account_deletion_request(uuid, text, text, timestamptz, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.open_account_deletion_request(uuid, text, text, timestamptz, jsonb, jsonb, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- record_account_deletion_origin_progress — what the request endpoint knows
-- ---------------------------------------------------------------------------
-- The endpoint is not a claimant and holds no token, so it is fenced on the
-- account instead: it may only write to its own user's open request. It records
-- the connector sweep and the auth deletion at the moment they happen, which is
-- the moment the old code recorded them nowhere.

create or replace function public.record_account_deletion_origin_progress(
  p_request_id uuid,
  p_user_id uuid,
  p_pending_cleanup jsonb default null,
  p_connections_swept boolean default false,
  p_auth_deleted boolean default false,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pending jsonb;
begin
  select case
           when p_pending_cleanup is null then adr.pending_cleanup
           else p_pending_cleanup
         end
    into v_pending
    from public.account_deletion_requests adr
   where adr.id = p_request_id
     and adr.user_id = p_user_id
     and adr.completed_at is null;

  if v_pending is null then
    return false;
  end if;

  update public.account_deletion_requests adr
     set pending_cleanup = v_pending,
         -- Swept is not the same as finished. The phase only closes when
         -- nothing is still owed at a broker.
         connections_cleared_at = case
           when p_connections_swept and jsonb_array_length(v_pending) = 0
             then coalesce(adr.connections_cleared_at, p_at)
           else adr.connections_cleared_at
         end,
         auth_deleted_at = case
           when p_auth_deleted then coalesce(adr.auth_deleted_at, p_at)
           else adr.auth_deleted_at
         end,
         updated_at = p_at
   where adr.id = p_request_id
     and adr.user_id = p_user_id
     and adr.completed_at is null;

  return found;
end;
$$;

revoke all on function public.record_account_deletion_origin_progress(uuid, uuid, jsonb, boolean, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_account_deletion_origin_progress(uuid, uuid, jsonb, boolean, boolean, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- claim_next_account_deletion_request — now hands out a token and the phases
-- ---------------------------------------------------------------------------
-- Dropped rather than replaced: the returned shape changes, and CREATE OR
-- REPLACE cannot change a function's return type.

drop function if exists public.claim_next_account_deletion_request(timestamptz, integer);

create function public.claim_next_account_deletion_request(
  p_at timestamptz default now(),
  p_processing_lease_seconds integer default 900
)
returns table(
  id uuid,
  user_id uuid,
  user_email text,
  claimed_at timestamptz,
  teardown_by timestamptz,
  teardown_snapshot jsonb,
  processing_token uuid,
  auth_deleted_at timestamptz,
  connections_cleared_at timestamptz,
  infrastructure_cleared_at timestamptz,
  pending_cleanup jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease_seconds integer := greatest(coalesce(p_processing_lease_seconds, 900), 60);
  v_token uuid := gen_random_uuid();
begin
  return query
  with candidate as (
    select adr.id
    from public.account_deletion_requests adr
    where adr.completed_at is null
      and (
        adr.status in ('requested', 'failed')
        or (
          adr.status = 'processing'
          and coalesce(adr.processing_expires_at, adr.processing_started_at + interval '15 minutes') < p_at
        )
      )
    order by
      case when adr.teardown_by <= p_at then 0 else 1 end,
      adr.teardown_by,
      adr.requested_at,
      adr.id
    limit 1
    for update of adr skip locked
  ), touched as (
    update public.account_deletion_requests adr
    set
      status = 'processing',
      processing_started_at = p_at,
      processing_expires_at = p_at + make_interval(secs => v_lease_seconds),
      processing_token = v_token,
      last_error = null,
      updated_at = p_at
    from candidate
    where adr.id = candidate.id
    returning
      adr.id,
      adr.user_id,
      adr.user_email,
      p_at as claimed_at,
      adr.teardown_by,
      adr.teardown_snapshot,
      adr.processing_token,
      adr.auth_deleted_at,
      adr.connections_cleared_at,
      adr.infrastructure_cleared_at,
      adr.pending_cleanup
  )
  select
    touched.id,
    touched.user_id,
    touched.user_email,
    touched.claimed_at,
    touched.teardown_by,
    touched.teardown_snapshot,
    touched.processing_token,
    touched.auth_deleted_at,
    touched.connections_cleared_at,
    touched.infrastructure_cleared_at,
    touched.pending_cleanup
  from touched;
end;
$$;

revoke all on function public.claim_next_account_deletion_request(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_next_account_deletion_request(timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------------
-- record_account_deletion_phase — one step done, by the claimant that did it
-- ---------------------------------------------------------------------------

create or replace function public.record_account_deletion_phase(
  p_request_id uuid,
  p_processing_token uuid,
  p_phase text,
  p_pending_cleanup jsonb default null,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pending jsonb;
begin
  if p_phase not in ('connections', 'auth', 'infrastructure') then
    return false;
  end if;

  select coalesce(p_pending_cleanup, adr.pending_cleanup)
    into v_pending
    from public.account_deletion_requests adr
   where adr.id = p_request_id
     and adr.processing_token is not null
     and adr.processing_token = p_processing_token
     and adr.status = 'processing'
     and adr.completed_at is null;

  if v_pending is null then
    return false;
  end if;

  update public.account_deletion_requests adr
     set pending_cleanup = v_pending,
         connections_cleared_at = case
           when p_phase = 'connections' and jsonb_array_length(v_pending) = 0
             then coalesce(adr.connections_cleared_at, p_at)
           else adr.connections_cleared_at
         end,
         cleanup_attempts = case
           when p_phase = 'connections' then adr.cleanup_attempts + 1
           else adr.cleanup_attempts
         end,
         auth_deleted_at = case
           when p_phase = 'auth' then coalesce(adr.auth_deleted_at, p_at)
           else adr.auth_deleted_at
         end,
         infrastructure_cleared_at = case
           when p_phase = 'infrastructure' then coalesce(adr.infrastructure_cleared_at, p_at)
           else adr.infrastructure_cleared_at
         end,
         updated_at = p_at
   where adr.id = p_request_id
     and adr.processing_token = p_processing_token
     and adr.status = 'processing'
     and adr.completed_at is null;

  return found;
end;
$$;

revoke all on function public.record_account_deletion_phase(uuid, uuid, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_account_deletion_phase(uuid, uuid, text, jsonb, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- record_account_deletion_request_completed — every phase, and the right token
-- ---------------------------------------------------------------------------
-- Dropped and recreated: the token is a new required argument, and leaving the
-- old two-argument form in place would be an unfenced way to declare an account
-- erased, which is the defect.

drop function if exists public.record_account_deletion_request_completed(uuid, jsonb, timestamptz);

create function public.record_account_deletion_request_completed(
  p_request_id uuid,
  p_processing_token uuid,
  p_result jsonb default '{}'::jsonb,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.account_deletion_requests adr
  set
    status = 'completed',
    completed_at = p_at,
    completed_result = coalesce(p_result, '{}'::jsonb),
    processing_expires_at = null,
    processing_token = null,
    last_error = null,
    updated_at = p_at
  where adr.id = p_request_id
    and adr.processing_token is not null
    and adr.processing_token = p_processing_token
    and adr.status = 'processing'
    -- Fly teardown finishing is not the same as the account being gone. This
    -- is the line that used to be missing, and it is why a request could read
    -- `completed` with the sign-in still working.
    and adr.auth_deleted_at is not null
    and adr.connections_cleared_at is not null
    and adr.infrastructure_cleared_at is not null
    and jsonb_array_length(adr.pending_cleanup) = 0;

  return found;
end;
$$;

revoke all on function public.record_account_deletion_request_completed(uuid, uuid, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_account_deletion_request_completed(uuid, uuid, jsonb, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- purge_expired_connection_flows — bounded
-- ---------------------------------------------------------------------------
-- Dropped and recreated with a limit, rather than overloaded: two functions of
-- the same name reachable from PostgREST with an empty body is an ambiguity
-- waiting to happen. The default bound is far above any real backlog (29 rows
-- on 2026-09-13) and exists so one bad run cannot hold a statement open.

drop function if exists public.purge_expired_connection_flows();

create function public.purge_expired_connection_flows(p_limit integer default 5000)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with due as (
    select f.state
      from public.connection_oauth_flows f
     where f.expires_at < now() - interval '1 hour'
        or (f.consumed_at is not null and f.consumed_at < now() - interval '1 hour')
     order by f.expires_at
     limit greatest(coalesce(p_limit, 5000), 1)
  ), gone as (
    delete from public.connection_oauth_flows f
     using due
     where f.state = due.state
    returning 1
  )
  select coalesce(count(*), 0)::integer from gone;
$$;

revoke all on function public.purge_expired_connection_flows(integer) from public, anon, authenticated;
grant execute on function public.purge_expired_connection_flows(integer) to service_role;

commit;
