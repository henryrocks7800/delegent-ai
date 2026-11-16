begin;

-- 0028 — durable account erasure request queue
--
-- `/api/account/delete` is a GDPR/Trust promise, not just an audit event.
-- The existing provisioning_events table is user-scoped with `on delete cascade`,
-- so it is intentionally unsuitable as the source of truth for an erasure
-- request: the row can disappear during the same profile/auth cascade that the
-- request is supposed to coordinate. This table deliberately has no FK to
-- public.profiles. It stores the minimum subject + teardown snapshot needed for
-- service-role workers to complete account/workspace deletion after product rows
-- are gone.

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  user_email text,
  status text not null default 'requested',
  requested_via text not null default 'mobile_app',
  requested_at timestamptz not null default now(),
  teardown_by timestamptz not null,
  subject_snapshot jsonb not null default '{}'::jsonb,
  teardown_snapshot jsonb not null default '{}'::jsonb,
  processing_started_at timestamptz,
  processing_expires_at timestamptz,
  completed_at timestamptz,
  completed_result jsonb not null default '{}'::jsonb,
  failure_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_deletion_requests_status_check
    check (status in ('requested', 'processing', 'completed', 'failed', 'canceled')),
  constraint account_deletion_requests_failure_count_check
    check (failure_count >= 0),
  constraint account_deletion_requests_teardown_window_check
    check (teardown_by > requested_at)
);

alter table public.account_deletion_requests
  add column if not exists processing_expires_at timestamptz,
  add column if not exists completed_result jsonb not null default '{}'::jsonb;

-- At most one actively open erasure request per account. Completed/failed/
-- canceled rows remain as operator evidence without blocking a future
-- user-created account that happens to reuse the same UUID in a non-production
-- test reset.
create unique index if not exists account_deletion_requests_open_user_idx
  on public.account_deletion_requests(user_id)
  where status in ('requested', 'processing');

create index if not exists account_deletion_requests_queue_idx
  on public.account_deletion_requests(status, processing_expires_at, teardown_by, requested_at)
  where status in ('requested', 'processing', 'failed');

create index if not exists account_deletion_requests_user_requested_idx
  on public.account_deletion_requests(user_id, requested_at desc);

alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from public, anon, authenticated;
grant select, insert, update on public.account_deletion_requests to service_role;

-- Keep updated_at monotonic for the deletion worker without relying on clients
-- to remember it. set_updated_at() is introduced by 0002.
drop trigger if exists set_account_deletion_requests_updated_at on public.account_deletion_requests;
create trigger set_account_deletion_requests_updated_at
  before update on public.account_deletion_requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- claim_next_account_deletion_request — durable account deletion processor
-- ---------------------------------------------------------------------------
-- Claims a fresh request immediately (teardown_by is the SLA deadline, not a
-- future start time), uses SKIP LOCKED for concurrent workers, and reclaims a
-- stale processing row if a worker crashed mid-teardown.

create or replace function public.claim_next_account_deletion_request(
  p_at timestamptz default now(),
  p_processing_lease_seconds integer default 900
)
returns table(
  id uuid,
  user_id uuid,
  user_email text,
  claimed_at timestamptz,
  teardown_by timestamptz,
  teardown_snapshot jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease_seconds integer := greatest(coalesce(p_processing_lease_seconds, 900), 60);
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
      adr.teardown_snapshot
  )
  select
    touched.id,
    touched.user_id,
    touched.user_email,
    touched.claimed_at,
    touched.teardown_by,
    touched.teardown_snapshot
  from touched;
end;
$$;

revoke all on function public.claim_next_account_deletion_request(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_next_account_deletion_request(timestamptz, integer) to service_role;

-- ---------------------------------------------------------------------------
-- record_account_deletion_request_completed — terminal state after teardown
-- ---------------------------------------------------------------------------

create or replace function public.record_account_deletion_request_completed(
  p_request_id uuid,
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
    last_error = null,
    updated_at = p_at
  where adr.id = p_request_id
    and adr.status = 'processing';

  return found;
end;
$$;

revoke all on function public.record_account_deletion_request_completed(uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.record_account_deletion_request_completed(uuid, jsonb, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- record_account_deletion_request_failed — retryable/escalatable failure
-- ---------------------------------------------------------------------------

create or replace function public.record_account_deletion_request_failed(
  p_request_id uuid,
  p_error_code text,
  p_public_status_message text default 'Delegent AI account deletion needs an operator check before continuing.',
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
    status = 'failed',
    failure_count = adr.failure_count + 1,
    processing_expires_at = null,
    last_error = left(coalesce(nullif(trim(p_error_code), ''), 'account_deletion_failed'), 128),
    updated_at = p_at
  where adr.id = p_request_id
    and adr.status = 'processing';

  return found;
end;
$$;

revoke all on function public.record_account_deletion_request_failed(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_account_deletion_request_failed(uuid, text, text, timestamptz) to service_role;

commit;
