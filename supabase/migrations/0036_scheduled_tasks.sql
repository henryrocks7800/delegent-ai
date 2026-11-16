-- 0036_scheduled_tasks.sql
-- Scheduled / recurring tasks + the external "waker" contract.
--
-- Runners use autostop=suspend (COST_MODEL 2026-05-31): an idle machine cannot
-- fire its own timer, so recurring "brief once, repeat forever" jobs are driven
-- by an EXTERNAL waker. The Worker scheduled() cron (every 5 min) claims due
-- tasks via claim_due_scheduled_tasks() and dispatches each to the user's runner
-- (the dispatch request auto-starts the suspended machine). This closes the
-- scheduled-jobs gap flagged by forensic C-POS-07 / R-AGENT-05.
--
-- Trust boundary: service-role table with owner-only RLS. The cron claims via a
-- security-definer RPC; no provider internals are exposed to the client.

create table if not exists public.scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  prompt text not null,
  label text,
  -- 'interval' recurs every interval_seconds; 'once' fires a single time then done.
  schedule_kind text not null default 'interval' check (schedule_kind in ('interval', 'once')),
  -- minimum 300s: the waker cron cadence is every 5 minutes, so a finer schedule
  -- could not be honoured precisely.
  interval_seconds integer check (interval_seconds is null or interval_seconds >= 300),
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_task_run_id uuid,
  status text not null default 'active' check (status in ('active', 'paused', 'cancelled', 'done')),
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_tasks_prompt_len check (char_length(prompt) between 1 and 4000),
  constraint scheduled_tasks_interval_required check (schedule_kind <> 'interval' or interval_seconds is not null)
);

create index if not exists scheduled_tasks_user_idx on public.scheduled_tasks (user_id);
create index if not exists scheduled_tasks_due_idx on public.scheduled_tasks (next_run_at) where status = 'active';

alter table public.scheduled_tasks enable row level security;

-- Owner can read + manage their own (mobile list / pause / cancel). Inserts are
-- service-role only (the Worker creates them after authenticating the user), so
-- there is deliberately no client INSERT policy.
drop policy if exists scheduled_tasks_owner_select on public.scheduled_tasks;
create policy scheduled_tasks_owner_select on public.scheduled_tasks
  for select using (auth.uid() = user_id);

drop policy if exists scheduled_tasks_owner_update on public.scheduled_tasks;
create policy scheduled_tasks_owner_update on public.scheduled_tasks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists scheduled_tasks_owner_delete on public.scheduled_tasks;
create policy scheduled_tasks_owner_delete on public.scheduled_tasks
  for delete using (auth.uid() = user_id);

create or replace function public.scheduled_tasks_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scheduled_tasks_set_updated_at on public.scheduled_tasks;
create trigger scheduled_tasks_set_updated_at
  before update on public.scheduled_tasks
  for each row execute function public.scheduled_tasks_touch_updated_at();

-- Cron claim (service-role): atomically take up to p_limit due active tasks,
-- advance their schedule so the next tick does not re-claim them, and return the
-- rows the Worker should dispatch. SECURITY DEFINER + revoked from clients so
-- only the service-role cron can drive it.
create or replace function public.claim_due_scheduled_tasks(p_limit integer default 25)
returns table (id uuid, user_id uuid, prompt text, label text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select st.id
    from public.scheduled_tasks st
    where st.status = 'active'
      and st.next_run_at <= now()
    order by st.next_run_at asc
    limit greatest(1, p_limit)
    for update skip locked
  )
  update public.scheduled_tasks st
  set last_run_at = now(),
      next_run_at = case
        when st.schedule_kind = 'interval'
          then now() + make_interval(secs => st.interval_seconds)
        else st.next_run_at
      end,
      status = case when st.schedule_kind = 'once' then 'done' else st.status end
  from due
  where st.id = due.id
  returning st.id, st.user_id, st.prompt, st.label;
end;
$$;

revoke all on function public.claim_due_scheduled_tasks(integer) from public;

-- Record dispatch outcome (service-role). Resets/increments the failure counter
-- and auto-pauses a task that fails 5 times in a row so the cron does not hammer
-- a broken runner indefinitely.
create or replace function public.record_scheduled_task_dispatch(p_id uuid, p_task_run_id uuid, p_ok boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.scheduled_tasks
  set last_task_run_id = case when p_ok then p_task_run_id else last_task_run_id end,
      consecutive_failures = case when p_ok then 0 else consecutive_failures + 1 end,
      status = case
        when (not p_ok) and consecutive_failures + 1 >= 5 then 'paused'
        else status
      end
  where id = p_id;
end;
$$;

revoke all on function public.record_scheduled_task_dispatch(uuid, uuid, boolean) from public;

-- The waker writes task_runs rows tagged kind='scheduled' for each dispatched
-- recurring job (so the chat surface and analytics can tell scheduled runs
-- apart from chat/telegram ones). The original task_runs_kind_check (added in
-- 0023) does not include 'scheduled', so widen it defensively. Wrapped in a
-- do-block so a partially-applied / divergent prod schema can't abort the whole
-- migration: drop-if-exists then re-add the full allowed set, downgrading any
-- failure to a NOTICE rather than letting the migration fail closed.
do $$
begin
  alter table public.task_runs drop constraint if exists task_runs_kind_check;
  alter table public.task_runs
    add constraint task_runs_kind_check
    check (kind in ('chat', 'telegram', 'whatsapp', 'signal', 'system', 'scheduled'));
exception when others then
  raise notice 'task_runs_kind_check widen (scheduled) skipped: %', sqlerrm;
end $$;
