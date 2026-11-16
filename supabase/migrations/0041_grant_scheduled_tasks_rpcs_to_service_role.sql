begin;

-- 0041 — grant the scheduled-tasks RPCs to service_role (GO_LIVE_TRACKER #27).
--
-- 0036 created claim_due_scheduled_tasks + record_scheduled_task_dispatch and did
-- `revoke all ... from public` to lock out anon/authenticated — but, unlike every
-- other service-role RPC in this schema, it never re-granted execute to
-- service_role. After the revoke, service_role inherits nothing from PUBLIC, so
-- the Worker (which calls these as service_role to drive recurring tasks) gets
-- `42501 permission denied` — which it swallows — so scheduled/recurring tasks
-- silently never dispatch. Re-grant execute to match every other RPC here.

grant execute on function public.claim_due_scheduled_tasks(integer) to service_role;
grant execute on function public.record_scheduled_task_dispatch(uuid, uuid, boolean) to service_role;

commit;
