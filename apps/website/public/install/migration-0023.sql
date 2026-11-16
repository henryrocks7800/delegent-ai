-- 0023 — in-app chat foundation (v1.2.0 pivot)
--
-- Brings the existing `messages` + `task_runs` tables up to the shape the
-- new in-app chat API expects:
--   * messages gains a normalized lifecycle status (queued|dispatched|
--     complete|failed) + an attachment_metadata jsonb so the same row can
--     represent an in-flight assistant placeholder OR a finalized reply.
--   * messages gains task_run_id (uuid FK) so the new chat API can return
--     a single row that joins the message + its dispatch run without
--     having to do client-side correlation.
--   * messages gains conversation_id; for the MVP every user has exactly
--     one ongoing conversation, so conversation_id defaults to the
--     user_id. The column exists so the v1.3.0 multi-conversation
--     surface can land additively.
--   * task_runs.kind so we can distinguish chat dispatches from the
--     legacy Telegram-handoff path while both coexist during the shadow
--     period.

-- Messages lifecycle ---------------------------------------------------------

alter table public.messages
  add column if not exists status text not null default 'complete' check (status in ('queued', 'dispatched', 'complete', 'failed'));

alter table public.messages
  add column if not exists conversation_id uuid;

-- Backfill conversation_id to user_id for every existing row so the
-- MVP "one conversation per user" lookup never returns null.
update public.messages
   set conversation_id = user_id
 where conversation_id is null;

alter table public.messages
  alter column conversation_id set not null;

alter table public.messages
  add column if not exists task_run_id uuid references public.task_runs(id) on delete set null;

alter table public.messages
  add column if not exists attachment_metadata jsonb not null default '[]'::jsonb;

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at);

create index if not exists messages_status_idx
  on public.messages (status)
  where status in ('queued', 'dispatched');

-- task_runs lifecycle --------------------------------------------------------

alter table public.task_runs
  add column if not exists kind text not null default 'chat' check (kind in ('chat', 'telegram', 'whatsapp', 'signal', 'system'));

-- Legacy rows came from the Telegram pipeline; tag them retroactively so
-- the chat API can filter cleanly without scanning the instruction text.
update public.task_runs
   set kind = 'telegram'
 where kind = 'chat'
   and runner_task_id is not null
   and created_at < (now() - interval '1 hour');

create index if not exists task_runs_kind_idx
  on public.task_runs (kind, user_id, created_at desc);

-- RPC: enqueue_chat_message ---------------------------------------------------
--
-- Single transactional entry point for the POST chat-message API:
--   1. validates the caller has an active subscription + a ready runner
--   2. inserts the user-role message
--   3. creates a queued task_run pointing at it
--   4. inserts the assistant placeholder message (status='queued')
--   5. returns the assistant message id + task_run id + conversation id
--
-- All three writes happen under one transaction so the chat UI never
-- sees an orphan run or orphan placeholder. The Worker dispatches the
-- task to the user's Fly machine after this RPC returns.

create or replace function public.enqueue_chat_message(
  p_instruction text,
  p_attachment_metadata jsonb default '[]'::jsonb,
  p_now timestamptz default now()
)
returns table(
  conversation_id uuid,
  user_message_id uuid,
  assistant_message_id uuid,
  task_run_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_conversation_id uuid;
  v_user_message_id uuid;
  v_assistant_message_id uuid;
  v_task_run_id uuid;
  v_subscription_status text;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;

  if nullif(btrim(p_instruction), '') is null then
    raise exception 'instruction_required';
  end if;

  if length(p_instruction) > 8000 then
    raise exception 'instruction_too_long';
  end if;

  if jsonb_typeof(p_attachment_metadata) <> 'array' then
    raise exception 'attachment_metadata_must_be_array';
  end if;

  -- Entitlement: an active or trialing subscription. past_due is grace.
  -- v1.2.1: chat no longer waits on the per-user Fly runner — the Worker
  -- now calls OpenRouter directly. The runner stays available for long-
  -- running task execution (file work, scheduled jobs) but the chat path
  -- is decoupled so the user can talk to their coworker the moment they
  -- finish checkout.
  select status into v_subscription_status
    from public.subscriptions
   where user_id = v_user_id;
  if v_subscription_status is null
     or v_subscription_status not in ('active', 'trialing', 'past_due') then
    raise exception 'no_active_subscription';
  end if;

  v_conversation_id := v_user_id;

  insert into public.messages (user_id, conversation_id, role, content, attachment_metadata, status, created_at)
       values (v_user_id, v_conversation_id, 'user', p_instruction, p_attachment_metadata, 'complete', p_now)
    returning id into v_user_message_id;

  insert into public.task_runs (user_id, message_id, status, instruction, kind, created_at, updated_at)
       values (v_user_id, v_user_message_id, 'queued', p_instruction, 'chat', p_now, p_now)
    returning id into v_task_run_id;

  insert into public.messages (user_id, conversation_id, role, content, task_run_id, status, attachment_metadata, created_at)
       values (v_user_id, v_conversation_id, 'assistant', '', v_task_run_id, 'queued', '[]'::jsonb, p_now)
    returning id into v_assistant_message_id;

  return query select v_conversation_id, v_user_message_id, v_assistant_message_id, v_task_run_id;
end;
$$;

revoke all on function public.enqueue_chat_message(text, jsonb, timestamptz) from public, anon;
grant execute on function public.enqueue_chat_message(text, jsonb, timestamptz) to authenticated, service_role;

-- RPC: finalize_chat_message --------------------------------------------------
--
-- Called by the Worker after the runner returns. Updates the assistant
-- placeholder + closes the task_run + records artifacts in one shot.

create or replace function public.finalize_chat_message(
  p_assistant_message_id uuid,
  p_task_run_id uuid,
  p_content text,
  p_artifacts jsonb default '[]'::jsonb,
  p_succeeded boolean default true,
  p_error_code text default null,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match boolean;
begin
  -- Mirror the placeholder shape we expect; service-role only, so no RLS
  -- here, but pin the message + run to the same row pair to prevent a
  -- stale callback from clobbering newer state.
  select exists (
    select 1
      from public.messages m
      join public.task_runs t on t.id = m.task_run_id
     where m.id = p_assistant_message_id
       and t.id = p_task_run_id
       and m.role = 'assistant'
       and t.status in ('queued', 'dispatched')
  ) into v_match;
  if not v_match then return false; end if;

  update public.messages
     set content = coalesce(p_content, content),
         status = case when p_succeeded then 'complete' else 'failed' end,
         updated_at = p_now
   where id = p_assistant_message_id;

  update public.task_runs
     set status = case when p_succeeded then 'succeeded' else 'failed' end,
         error_code = p_error_code,
         completed_at = p_now,
         updated_at = p_now
   where id = p_task_run_id;

  -- Artifacts: each element is { title, kind, detail, status }
  if jsonb_typeof(p_artifacts) = 'array' then
    insert into public.artifacts (user_id, task_run_id, title, kind, detail, status, created_at)
    select
      m.user_id,
      p_task_run_id,
      coalesce(artifact->>'title', 'Untitled'),
      coalesce(artifact->>'kind', 'chat_result'),
      coalesce(artifact->>'detail', ''),
      coalesce(artifact->>'status', 'ready'),
      p_now
    from public.messages m
       , jsonb_array_elements(p_artifacts) as artifact
    where m.id = p_assistant_message_id;
  end if;

  return true;
end;
$$;

revoke all on function public.finalize_chat_message(uuid, uuid, text, jsonb, boolean, text, timestamptz) from public, anon, authenticated;
grant execute on function public.finalize_chat_message(uuid, uuid, text, jsonb, boolean, text, timestamptz) to service_role;

-- updated_at on messages so the finalize call can stamp it -------------------
alter table public.messages
  add column if not exists updated_at timestamptz not null default now();
