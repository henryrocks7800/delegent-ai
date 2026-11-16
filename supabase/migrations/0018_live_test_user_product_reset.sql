begin;

-- Service-role-only helper for repeatable live/test-mode checkout rehearsals.
-- It resets one known test user's billing, messaging, task, usage, and file
-- metadata without touching auth.users, profiles, global provider config, or
-- shared infrastructure. Runner infrastructure is preserved by default so an
-- operator does not accidentally orphan/delete a Railway deployment.
create or replace function public.reset_live_test_user_product_state(
  p_user_id uuid,
  p_preserve_runner boolean default true,
  p_reset_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_counts jsonb := '{}'::jsonb;
begin
  if p_user_id is null then
    raise exception 'user is required' using errcode = '22023';
  end if;

  perform 1 from public.profiles where id = p_user_id;
  if not found then
    raise exception 'profile not found' using errcode = '22023';
  end if;

  delete from public.gateway_task_events where user_id = p_user_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('gatewayTaskEventsDeleted', v_count);

  delete from public.gateway_connect_codes where user_id = p_user_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('gatewayConnectCodesDeleted', v_count);

  delete from public.gateway_connections where user_id = p_user_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('gatewayConnectionsDeleted', v_count);

  delete from public.artifacts where user_id = p_user_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('artifactsDeleted', v_count);

  delete from public.task_runs where user_id = p_user_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('taskRunsDeleted', v_count);

  delete from public.messages where user_id = p_user_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('messagesDeleted', v_count);

  delete from public.token_usage_events where user_id = p_user_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('tokenUsageEventsDeleted', v_count);

  delete from public.billing_events where user_id = p_user_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('billingEventsDeleted', v_count);

  delete from public.provisioning_events where user_id = p_user_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('provisioningEventsDeleted', v_count);

  insert into public.subscriptions (
    user_id,
    status,
    tier_id,
    stripe_customer_id,
    stripe_subscription_id,
    price_id,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    updated_at,
    provider_updated_at
  ) values (
    p_user_id,
    'inactive',
    'studio',
    null,
    null,
    null,
    null,
    null,
    false,
    p_reset_at,
    p_reset_at
  )
  on conflict (user_id) do update set
    status = excluded.status,
    tier_id = excluded.tier_id,
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    price_id = excluded.price_id,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    updated_at = excluded.updated_at,
    provider_updated_at = excluded.provider_updated_at;

  insert into public.usage_quotas (
    user_id,
    monthly_token_quota,
    tier_id,
    updated_at,
    provider_updated_at
  ) values (
    p_user_id,
    200000,
    'studio',
    p_reset_at,
    p_reset_at
  )
  on conflict (user_id) do update set
    monthly_token_quota = excluded.monthly_token_quota,
    tier_id = excluded.tier_id,
    updated_at = excluded.updated_at,
    provider_updated_at = excluded.provider_updated_at;

  if p_preserve_runner then
    -- Preserve private Railway/Hermes binding rows, but reset the public product
    -- state. A live-test reset must make the mobile app behave like a new or
    -- unsubscribed user; otherwise stale `ready` rows from an earlier run can
    -- make checkout/setup/Telegram flows look successful when the current run
    -- did not actually re-prove them.
    insert into public.hermes_instances (
      user_id,
      status,
      railway_project_id,
      railway_service_id,
      railway_volume_id,
      base_url,
      last_health_at,
      ready_at,
      error,
      error_code,
      public_status_message,
      updated_at
    ) values (
      p_user_id,
      'not_requested',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'Waiting for subscription activation',
      p_reset_at
    )
    on conflict (user_id) do update set
      status = excluded.status,
      railway_project_id = excluded.railway_project_id,
      railway_service_id = excluded.railway_service_id,
      railway_volume_id = excluded.railway_volume_id,
      base_url = excluded.base_url,
      last_health_at = excluded.last_health_at,
      ready_at = excluded.ready_at,
      error = excluded.error,
      error_code = excluded.error_code,
      public_status_message = excluded.public_status_message,
      updated_at = excluded.updated_at;
  else
    update public.hermes_instance_private set
      railway_project_id = null,
      railway_service_id = null,
      railway_volume_id = null,
      railway_workflow_id = null,
      railway_template_id = null,
      railway_template_code = null,
      volume_mount_path = null,
      volume_gb = null,
      runner_base_url = null,
      runner_shared_secret = null,
      raw_error = null,
      deleted_at = p_reset_at,
      updated_at = p_reset_at
    where user_id = p_user_id;
    get diagnostics v_count = row_count;
    v_counts := v_counts || jsonb_build_object('runnerPrivateRowsReset', v_count);

    insert into public.hermes_instances (
      user_id,
      status,
      railway_project_id,
      railway_service_id,
      railway_volume_id,
      base_url,
      last_health_at,
      ready_at,
      error,
      error_code,
      public_status_message,
      updated_at
    ) values (
      p_user_id,
      'not_requested',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'Waiting for subscription activation',
      p_reset_at
    )
    on conflict (user_id) do update set
      status = excluded.status,
      railway_project_id = excluded.railway_project_id,
      railway_service_id = excluded.railway_service_id,
      railway_volume_id = excluded.railway_volume_id,
      base_url = excluded.base_url,
      last_health_at = excluded.last_health_at,
      ready_at = excluded.ready_at,
      error = excluded.error,
      error_code = excluded.error_code,
      public_status_message = excluded.public_status_message,
      updated_at = excluded.updated_at;
  end if;

  return jsonb_build_object(
    'ok', true,
    'userId', p_user_id,
    'preservedRunner', p_preserve_runner,
    'resetAt', p_reset_at
  ) || v_counts;
end;
$$;

revoke all on function public.reset_live_test_user_product_state(uuid, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.reset_live_test_user_product_state(uuid, boolean, timestamptz) to service_role;

commit;
