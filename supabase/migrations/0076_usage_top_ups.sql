begin;

-- Usage top-ups for agent-engine accounts (Alex, 2026-09-15). A top-up is used
-- only once the monthly allowance is spent, and lasts 12 months, the way OpenAI
-- and Google sell extra AI usage. Written only by the Worker with the service
-- role: from the signed Stripe webhook (usage_top_ups) and after each reply
-- (settle_usage_top_ups). No client reads or writes either table.

create table public.usage_top_ups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  tokens bigint not null check (tokens > 0),
  amount_pence integer not null check (amount_pence > 0),
  currency text not null default 'gbp' check (currency = 'gbp'),
  stripe_checkout_session_id text not null unique check (stripe_checkout_session_id like 'cs\_%'),
  stripe_payment_intent_id text,
  purchased_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > purchased_at),
  created_at timestamptz not null default now()
);

create index usage_top_ups_user_expiry_idx on public.usage_top_ups (user_id, expires_at);

-- What each billing cycle took from which top-up. A cycle's overage is only
-- ever drawn once: settlement reads what the cycle has already drawn under a
-- per-user lock before it takes any more.
create table public.usage_top_up_draws (
  id bigint generated always as identity primary key,
  top_up_id uuid not null references public.usage_top_ups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  cycle_start timestamptz not null,
  tokens bigint not null check (tokens > 0),
  drawn_at timestamptz not null default now()
);

create index usage_top_up_draws_user_cycle_idx on public.usage_top_up_draws (user_id, cycle_start);
create index usage_top_up_draws_top_up_idx on public.usage_top_up_draws (top_up_id);

alter table public.usage_top_ups enable row level security;
alter table public.usage_top_up_draws enable row level security;
-- Supabase grants new tables to anon AND authenticated; RLS alone is one switch.
revoke all on public.usage_top_ups from anon, authenticated;
revoke all on public.usage_top_up_draws from anon, authenticated;
revoke all on sequence public.usage_top_up_draws_id_seq from anon, authenticated;

-- Charge this cycle's use beyond the allowance to the account's top-ups, oldest
-- expiry first, and report what is left. Idempotent: calling it again in the
-- same cycle only draws for use recorded since the last call.
create function public.settle_usage_top_ups(p_user_id uuid, p_cycle_start timestamptz, p_allowance bigint)
returns table (balance bigint, drawn_this_cycle bigint, used_this_cycle bigint)
language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_used bigint;
  v_drawn bigint;
  v_need bigint;
  v_take bigint;
  v_top_up record;
begin
  if p_user_id is null or p_cycle_start is null or p_allowance is null or p_allowance < 0 then
    raise exception 'invalid settlement' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('usage_top_ups:' || p_user_id::text, 0));

  select coalesce(sum(e.total_tokens), 0) into v_used
    from public.token_usage_events e
    where e.user_id = p_user_id and e.created_at >= p_cycle_start;
  select coalesce(sum(d.tokens), 0) into v_drawn
    from public.usage_top_up_draws d
    where d.user_id = p_user_id and d.cycle_start = p_cycle_start;

  v_need := greatest(0, v_used - p_allowance) - v_drawn;
  if v_need > 0 then
    for v_top_up in
      select t.id, t.tokens - coalesce((select sum(d.tokens) from public.usage_top_up_draws d where d.top_up_id = t.id), 0) as remaining
        from public.usage_top_ups t
        where t.user_id = p_user_id and t.expires_at > now()
        order by t.expires_at, t.purchased_at
    loop
      exit when v_need <= 0;
      continue when v_top_up.remaining <= 0;
      v_take := least(v_top_up.remaining, v_need);
      insert into public.usage_top_up_draws (top_up_id, user_id, cycle_start, tokens)
        values (v_top_up.id, p_user_id, p_cycle_start, v_take);
      v_need := v_need - v_take;
      v_drawn := v_drawn + v_take;
    end loop;
  end if;

  return query
    select coalesce(sum(greatest(0, t.tokens - coalesce((select sum(d.tokens) from public.usage_top_up_draws d where d.top_up_id = t.id), 0))), 0)::bigint,
      v_drawn,
      v_used
    from public.usage_top_ups t
    where t.user_id = p_user_id and t.expires_at > now();
end;
$$;

revoke execute on function public.settle_usage_top_ups(uuid, timestamptz, bigint) from public, anon, authenticated;
grant execute on function public.settle_usage_top_ups(uuid, timestamptz, bigint) to service_role;

commit;
