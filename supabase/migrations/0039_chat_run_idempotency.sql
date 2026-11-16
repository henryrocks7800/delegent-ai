-- 0039_chat_run_idempotency.sql
-- DEFECT #1 (defect hunt 2026-06-05): handleChatRunCreate accepted a `clientRunId`
-- in the request body but never used it, so a mobile retry (its 120s timeout, a
-- re-tap, or a network replay — all likelier on the long tasks that time out)
-- created a DUPLICATE user message + task_run + a second runner dispatch + a
-- second set of token reservations, double-charging the user and duplicating the
-- turn. The Worker now dedupes on (user_id, client_run_id): a repeat with the same
-- key REPLAYS the existing successfully-dispatched run instead of enqueuing +
-- dispatching again. This adds the column that backs that dedup plus a partial
-- unique index that keeps the rare sub-second race from ever persisting two rows
-- for one key.
--
-- Additive + idempotent: a nullable column + a partial unique index (NULL keys
-- exempt). Existing rows and non-idempotent callers are unaffected. task_runs is
-- service-role-written, so no RLS/grant change is needed.

alter table public.task_runs
  add column if not exists client_run_id text;

create unique index if not exists task_runs_user_client_run_id_uniq
  on public.task_runs (user_id, client_run_id)
  where client_run_id is not null;

comment on column public.task_runs.client_run_id is
  'Client-supplied idempotency key for chat-run create (DEFECT #1, 2026-06-05). A repeat with the same (user_id, client_run_id) replays the existing run instead of dispatching again.';
