-- PASS3/PASS10: one terminal winner and one immutable settlement per reservation.
begin;

alter table public.token_usage_events
  add column if not exists cached_tokens integer check (cached_tokens >= 0),
  add column if not exists provider_cost_usd numeric check (provider_cost_usd >= 0),
  add column if not exists upstream_provider text,
  add column if not exists provider_request_id text;

create or replace function public.settle_chat_usage(
  p_reservation_id uuid, p_user_id uuid,
  p_prompt_tokens integer, p_completion_tokens integer, p_total_tokens integer,
  p_cached_tokens integer default null, p_provider_cost_usd numeric default null,
  p_upstream_provider text default null, p_provider_request_id text default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_row public.token_usage_events%rowtype;
begin
  if p_prompt_tokens < 0 or p_completion_tokens < 0 or p_total_tokens < 0
    or p_prompt_tokens is null or p_completion_tokens is null or p_total_tokens is null
    or p_cached_tokens < 0 or p_cached_tokens > p_prompt_tokens or p_provider_cost_usd < 0 then
    raise exception 'invalid_usage';
  end if;
  select * into v_row from public.token_usage_events
    where id = p_reservation_id and user_id = p_user_id for update;
  if not found then raise exception 'usage_reservation_not_found'; end if;
  if v_row.source <> 'worker_reservation' then
    -- A timed-out response may already have committed. Never insert another
    -- debit or overwrite a different settled result while recovering it.
    if v_row.source = 'worker' and v_row.prompt_tokens = p_prompt_tokens
      and v_row.completion_tokens = p_completion_tokens and v_row.total_tokens = p_total_tokens then
      return true;
    end if;
    raise exception 'usage_settlement_conflict';
  end if;
  update public.token_usage_events set
    prompt_tokens = p_prompt_tokens, completion_tokens = p_completion_tokens,
    total_tokens = p_total_tokens, source = 'worker', cached_tokens = p_cached_tokens,
    provider_cost_usd = p_provider_cost_usd,
    upstream_provider = left(p_upstream_provider, 120),
    provider_request_id = left(p_provider_request_id, 200)
    where id = p_reservation_id;
  return true;
end;
$$;
revoke all on function public.settle_chat_usage(uuid,uuid,integer,integer,integer,integer,numeric,text,text)
  from public, anon, authenticated;
grant execute on function public.settle_chat_usage(uuid,uuid,integer,integer,integer,integer,numeric,text,text)
  to service_role;

create or replace function public.finalize_chat_message(
  p_assistant_message_id uuid, p_task_run_id uuid, p_content text,
  p_artifacts jsonb default '[]'::jsonb, p_succeeded boolean default true,
  p_error_code text default null, p_tool_calls jsonb default '[]'::jsonb,
  p_now timestamptz default now()
)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  -- The conditional UPDATE locks and rechecks the live row after a concurrent
  -- winner commits. A prior SELECT EXISTS did not serialize finalizers.
  update public.task_runs t set
    status = case when p_succeeded then 'succeeded' else 'failed' end,
    error_code = p_error_code, completed_at = p_now, updated_at = p_now
    where t.id = p_task_run_id and t.status in ('queued', 'dispatched')
      and exists (select 1 from public.messages m
        where m.id = p_assistant_message_id and m.task_run_id = t.id
          and m.user_id = t.user_id and m.role = 'assistant')
    returning t.user_id into v_user_id;
  if not found then return false; end if;

  update public.messages set
    content = coalesce(p_content, content),
    status = case when p_succeeded then 'complete' else 'failed' end,
    tool_calls = case when jsonb_typeof(p_tool_calls) = 'array' then p_tool_calls else '[]'::jsonb end,
    updated_at = p_now
    where id = p_assistant_message_id and user_id = v_user_id;
  if not found then raise exception 'assistant_message_missing'; end if;

  if jsonb_typeof(p_artifacts) = 'array' then
    insert into public.artifacts(user_id,task_run_id,title,kind,detail,status,created_at)
    select v_user_id, p_task_run_id, coalesce(a->>'title','Untitled'),
      coalesce(a->>'kind','chat_result'), coalesce(a->>'detail',''),
      coalesce(a->>'status','ready'), p_now
      from jsonb_array_elements(p_artifacts) a;
  end if;
  return true;
end;
$$;
revoke all on function public.finalize_chat_message(uuid,uuid,text,jsonb,boolean,text,jsonb,timestamptz)
  from public, anon, authenticated;
grant execute on function public.finalize_chat_message(uuid,uuid,text,jsonb,boolean,text,jsonb,timestamptz)
  to service_role;
notify pgrst, 'reload schema';
commit;
