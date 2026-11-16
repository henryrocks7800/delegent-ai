-- Composio tool executions, counted per user so a looping agent can be caught
-- and named.
--
-- Why our own table rather than asking Composio: their spend cap protects the
-- ACCOUNT, this protects the CUSTOMER whose agent is stuck, and it tells us
-- which customer it was. Without it the ceiling in apps/worker/src/composio.ts
-- has nothing to count and silently never fires.
--
-- Deliberately one row per attempt, not per success. A loop that fails every
-- time still costs money and still needs stopping.
create table if not exists public.composio_executions (
  id          bigserial primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  tool        text not null,
  created_at  timestamptz not null default now()
);

-- The only query this table serves: "how many has this user run this cycle".
create index if not exists composio_executions_user_created_idx
  on public.composio_executions (user_id, created_at desc);

-- Service role only. Nothing customer-facing reads or writes this, and RLS with
-- no policy denies every anon and authenticated request by default.
alter table public.composio_executions enable row level security;

revoke all on public.composio_executions from anon, authenticated;
