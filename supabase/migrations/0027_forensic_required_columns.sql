begin;

-- Forensic pack required columns.
--
-- The 2026-05-21 forensic spec inventory exposed three observability
-- gaps where the criterion text requires a falsifiable column and the
-- enforcement code already exists but the storage shape didn't:
--
--   1. R-CHAT-05 / R-SEC-17: chat dispatch must be idempotent on a
--      caller-supplied idempotency_key. The Worker derives the key
--      today but it isn't persisted on task_runs, so replay detection
--      relies on a derived hash. Adding the column makes the
--      criterion behaviourally observable (two POSTs with the same
--      key → one row).
--
--   2. R-MSG-03: cross-channel state contract requires identifying
--      which inbound channel a message arrived from. The application
--      currently only persists in-app chat, but the column is needed
--      so the Telegram + WhatsApp + Signal scaffolding lands behind
--      a defaulted-safe column.
--
--   3. R-PROV-04 state-machine: hermes_instances has no `ready_at`
--      timestamp, so "ready without ready_at" cannot be a defect to
--      fix. Add it; the provisioner stamps it on transition.
--
-- All columns are additive + defaulted + nullable. No data is moved.

alter table public.task_runs
  add column if not exists idempotency_key text;

create unique index if not exists task_runs_user_idempotency_idx
  on public.task_runs(user_id, idempotency_key)
  where idempotency_key is not null;

alter table public.messages
  add column if not exists channel text not null default 'in_app';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_channel_check') then
    alter table public.messages
      add constraint messages_channel_check check (channel in (
        'in_app', 'telegram', 'whatsapp', 'signal', 'email', 'system'
      ));
  end if;
end $$;

alter table public.hermes_instances
  add column if not exists ready_at timestamptz;

create index if not exists hermes_instances_ready_at_idx
  on public.hermes_instances(ready_at)
  where status = 'ready';

-- Backfill ready_at for legacy rows so the R-PROV-04 forensic check
-- doesn't spike on stale historical data.
update public.hermes_instances
   set ready_at = updated_at
 where status = 'ready'
   and ready_at is null;

commit;
