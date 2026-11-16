-- 0046_scheduled_task_local_time.sql
-- Keep a routine on the clock time the user picked.
--
-- 0036 advanced a recurring task with `next_run_at = now() + interval_seconds`,
-- which drifted two different ways:
--
--   1. Wall clock. A daily routine is a fixed 86400 seconds, so a 09:00 brief
--      created in winter fires at 10:00 from the spring clock change onward.
--   2. Cumulative lateness. The waker cron runs every 5 minutes, so a task is
--      claimed up to 5 minutes after it was due; re-anchoring on now() folded
--      that lateness into the next interval permanently. A daily routine slips
--      by up to 5 minutes a day, so roughly 2.5 hours a month.
--
-- Both are fixed by advancing from the SCHEDULED time rather than the claim
-- time, and by stepping whole-day cadences in the user's own timezone so the
-- local hour is preserved across an offset change.

begin;

alter table public.scheduled_tasks
  add column if not exists timezone text not null default 'UTC';

comment on column public.scheduled_tasks.timezone is
  'IANA zone the routine''s wall-clock time is anchored to (e.g. Europe/London). Falls back to UTC when unknown.';

-- The next due moment strictly after now(), advancing from p_prev.
--
-- Missed occurrences are skipped rather than replayed: after a long outage the
-- user wants tomorrow's morning brief, not six of them at once.
create or replace function public.next_scheduled_run_at(
  p_prev timestamptz,
  p_interval_seconds integer,
  p_timezone text
)
returns timestamptz
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
  v_tz text;
  v_days integer;
  v_next timestamptz;
  v_guard integer := 0;
begin
  if p_prev is null or p_interval_seconds is null or p_interval_seconds <= 0 then
    return p_prev;
  end if;

  -- An unrecognised zone must never break the sweep for every other user.
  select name into v_tz from pg_timezone_names where name = coalesce(p_timezone, 'UTC') limit 1;
  v_tz := coalesce(v_tz, 'UTC');

  v_next := p_prev;

  if p_interval_seconds % 86400 = 0 then
    -- Whole-day cadence: step in local wall-clock days, so 09:00 stays 09:00
    -- through a daylight-saving change.
    v_days := p_interval_seconds / 86400;
    while v_next <= now() and v_guard < 4000 loop
      v_next := ((v_next at time zone v_tz) + make_interval(days => v_days)) at time zone v_tz;
      v_guard := v_guard + 1;
    end loop;
  else
    -- Sub-day cadence (hourly): elapsed seconds are what the user means.
    while v_next <= now() and v_guard < 100000 loop
      v_next := v_next + make_interval(secs => p_interval_seconds);
      v_guard := v_guard + 1;
    end loop;
  end if;

  -- Guard tripped on a pathological gap: still move forward, never stall on a
  -- past timestamp that the cron would re-claim every five minutes forever.
  if v_next <= now() then
    v_next := now() + make_interval(secs => p_interval_seconds);
  end if;

  return v_next;
end;
$$;

revoke all on function public.next_scheduled_run_at(timestamptz, integer, text) from public;

-- Same contract as 0036, with the drift-free advance.
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
          then public.next_scheduled_run_at(st.next_run_at, st.interval_seconds, st.timezone)
        else st.next_run_at
      end,
      status = case when st.schedule_kind = 'once' then 'done' else st.status end
  from due
  where st.id = due.id
  returning st.id, st.user_id, st.prompt, st.label;
end;
$$;

revoke all on function public.claim_due_scheduled_tasks(integer) from public;
grant execute on function public.claim_due_scheduled_tasks(integer) to service_role;
grant execute on function public.next_scheduled_run_at(timestamptz, integer, text) to service_role;

notify pgrst, 'reload schema';

commit;
