-- 0049 — stop hardcoding the model name in SQL.
--
-- 0037 created the reservation row with the model literal baked in:
--
--     values (p_user_id, 0, 0, ..., 'worker_reservation', 'moonshotai/kimi-k2.6')
--
-- That row IS the usage record (the Worker later PATCHes it with the real token
-- counts via reconcileReservation, which never touches `model`). So the model
-- column has always been reported by this function, not by the Worker's MODEL
-- constant.
--
-- On 2026-08-01 the Worker switched to deepseek/deepseek-v4-flash-0731. Chat
-- genuinely ran on DeepSeek from the moment that deployed, because the model
-- actually sent to OpenRouter is the MODEL constant. But every usage row still
-- said Kimi, so the cost tooling, the economics page and anyone reading the table
-- would have concluded the switch had not taken. It cost an hour to find, and it
-- would have quietly corrupted the before/after cost comparison that justified
-- the switch in the first place.
--
-- Fix: the caller passes the model. One source of truth (the Worker's MODEL
-- constant), so this cannot drift again on the next change.
--
-- The parameter carries a default so the old three-argument call still works: the
-- Worker falls back to the legacy snapshot gate on ANY RPC failure, so a
-- signature mismatch would not break chat, but it would silently disable atomic
-- reservation until both sides deployed. The default removes that window in
-- either deploy order.

drop function if exists public.reserve_chat_tokens(uuid, integer, timestamptz);

create or replace function public.reserve_chat_tokens(
  p_user_id uuid,
  p_requested integer,
  p_cycle_start timestamptz,
  p_model text default 'unspecified'
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
    (p_user_id, 0, 0, greatest(coalesce(p_requested, 0), 0), 'worker_reservation',
     nullif(btrim(coalesce(p_model, '')), ''))
  returning id into v_id;

  allowed := true; reservation_id := v_id; return next;
end;
$$;

-- Service-role only (the Worker holds the service-role key); never exposed to
-- anon or authenticated, same as 0037.
revoke all on function public.reserve_chat_tokens(uuid, integer, timestamptz, text) from public;
revoke all on function public.reserve_chat_tokens(uuid, integer, timestamptz, text) from anon;
revoke all on function public.reserve_chat_tokens(uuid, integer, timestamptz, text) from authenticated;
