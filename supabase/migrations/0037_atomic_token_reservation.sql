begin;

-- 2026-06-03 pre-launch review P0 #2 — close the token-quota TOCTOU race.
--
-- The Worker chat proxy used to: read SUM(token_usage_events) -> gate against
-- the snapshot -> call OpenRouter -> write the debit. With no lock, two
-- concurrent runner tool-loop calls for the SAME user both read the same
-- pre-debit snapshot, both pass the gate, and both spend tokens — and because
-- the OpenRouter key is SHARED across all users, one user near their cap can
-- over-spend and 402 everyone else.
--
-- reserve_chat_tokens makes the gate atomic: under a per-user advisory lock it
-- re-checks consumed+requested <= quota and, if ok, INSERTS a reservation row
-- (an estimated-budget token_usage_events row) so a concurrent call sees it.
-- The Worker reconciles that row to the ACTUAL usage after the model responds
-- (a normal PATCH by id). Unconfigured quota (0) fails open exactly like the
-- snapshot path did, returning a null reservation so the Worker persists
-- actuals post-call as before.
create or replace function public.reserve_chat_tokens(
  p_user_id uuid,
  p_requested integer,
  p_cycle_start timestamptz
)
returns table(allowed boolean, reservation_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_quota integer;
  v_consumed bigint;
  v_id uuid;
begin
  -- Serialise per user so concurrent reservations can't both pass a stale read.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select monthly_token_quota into v_quota
    from public.usage_quotas
    where user_id = p_user_id;

  -- Unconfigured quota (0 / no row) => fail open, no reservation; the Worker
  -- records the actual usage post-call, mirroring fetchUsageSnapshot's D2 path.
  if v_quota is null or v_quota = 0 then
    allowed := true; reservation_id := null; return next; return;
  end if;

  select coalesce(sum(total_tokens), 0) into v_consumed
    from public.token_usage_events
    where user_id = p_user_id
      and created_at >= p_cycle_start;

  if v_consumed + greatest(coalesce(p_requested, 0), 0) > v_quota then
    allowed := false; reservation_id := null; return next; return;
  end if;

  insert into public.token_usage_events
    (user_id, prompt_tokens, completion_tokens, total_tokens, source, model)
  values
    (p_user_id, 0, 0, greatest(coalesce(p_requested, 0), 0), 'worker_reservation', 'moonshotai/kimi-k2.6')
  returning id into v_id;

  allowed := true; reservation_id := v_id; return next;
end;
$$;

-- Service-role only (the Worker holds the service-role key); never exposed to
-- the anon/authenticated roles.
revoke all on function public.reserve_chat_tokens(uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_chat_tokens(uuid, integer, timestamptz) to service_role;

commit;
