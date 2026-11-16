-- 0024 — add 'dispatched' to task_runs.status allow-list (v1.2.4 chat dispatch fix)
--
-- Migration 0023 introduced the chat dispatch flow that PATCHes
-- task_runs.status = 'dispatched' as soon as the worker hands the
-- prompt off to OpenRouter. The original task_runs check constraint
-- (created with the Hermes-era schema) only allowed
--   'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
-- so the dispatch PATCH was rejected by PostgREST with a 23514
-- check_violation error. The worker's try/catch swallowed the throw
-- and marked the run as `dispatch_threw_...` failed, which is what
-- Alex saw as "I couldn't finish that. Try again in a moment."
-- — the agent never even reached the OpenRouter call.
--
-- This migration aligns task_runs.status with messages.status so the
-- 'dispatched' intermediate state is valid for both tables.

alter table public.task_runs
  drop constraint if exists task_runs_status_check;

alter table public.task_runs
  add constraint task_runs_status_check
  check (status in ('queued', 'dispatched', 'running', 'succeeded', 'failed', 'canceled'));
