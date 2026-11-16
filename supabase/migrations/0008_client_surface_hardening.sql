begin;

-- Keep provider-owned and infrastructure-adjacent state off the direct
-- authenticated client surface. Mobile reads the safe aggregate view
-- public.my_product_state plus first-party task/artifact rows; server routes
-- and background workers use the service role for Stripe, Railway, usage, and
-- gateway state.

drop policy if exists "own subscriptions read" on public.subscriptions;
drop policy if exists "own hermes read" on public.hermes_instances;
drop policy if exists "own usage read" on public.token_usage_events;
drop policy if exists "own quotas read" on public.usage_quotas;
drop policy if exists "own provisioning read" on public.provisioning_events;

revoke all on public.subscriptions from anon, authenticated;
revoke all on public.hermes_instances from anon, authenticated;
revoke all on public.token_usage_events from anon, authenticated;
revoke all on public.usage_quotas from anon, authenticated;
revoke all on public.provisioning_events from anon, authenticated;
revoke all on public.billing_events from anon, authenticated;
revoke all on public.hermes_instance_private from anon, authenticated;
revoke all on public.gateway_connections from anon, authenticated;
revoke all on public.gateway_connect_codes from anon, authenticated;
revoke all on public.gateway_task_events from anon, authenticated;

grant select, insert, update on public.subscriptions to service_role;
grant select, insert, update on public.hermes_instances to service_role;
grant select, insert, update on public.token_usage_events to service_role;
grant select, insert, update on public.usage_quotas to service_role;
grant select, insert, update on public.provisioning_events to service_role;
grant select, insert, update on public.billing_events to service_role;
grant select, insert, update on public.hermes_instance_private to service_role;
grant select, insert, update on public.gateway_connections to service_role;
grant select, insert, update on public.gateway_connect_codes to service_role;
grant select, insert, update on public.gateway_task_events to service_role;

grant select on public.my_product_state to authenticated;
grant select on public.task_runs to authenticated;
grant select on public.artifacts to authenticated;

commit;
