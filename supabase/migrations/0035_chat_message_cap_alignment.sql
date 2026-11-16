-- 0035_chat_message_cap_alignment.sql
--
-- Integration audit 2026-05-30 (finding F3): the in-app chat path had a cap
-- mismatch. The Worker accepts up to CHAT_MESSAGE_MAX_CHARS = 96_000 characters
-- (apps/worker/src/index.ts:2809, enforced at :3036) and the mobile attachment
-- picker sizes inlined attachments to fit "within the worker's
-- CHAT_MESSAGE_MAX_CHARS" (apps/mobile/src/chat/attachmentPicker.ts:34). But the
-- enqueue_chat_message RPC introduced in 0023 hard-rejected anything over 8_000
-- chars ("instruction_too_long"). Net effect: any in-app message or attachment
-- between 8_001 and 96_000 chars passed the Worker check and then failed at the
-- database, surfacing as a generic chat failure. Long pastes and document
-- attachments were the common trigger.
--
-- Fix: raise the RPC cap to 96_000 so the database agrees with the Worker (the
-- documented intent). This is the single behavioural change; the rest of the
-- function body is reproduced verbatim from 0023 because plpgsql functions can
-- only be replaced whole. enqueue_chat_message is defined exactly once (0023),
-- so this create-or-replace is a clean, additive swap.

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

  -- F3 fix: align with the Worker's CHAT_MESSAGE_MAX_CHARS (96_000). Previously
  -- 8000, which silently rejected long pastes + attachments the Worker accepted.
  if length(p_instruction) > 96000 then
    raise exception 'instruction_too_long';
  end if;

  if jsonb_typeof(p_attachment_metadata) <> 'array' then
    raise exception 'attachment_metadata_must_be_array';
  end if;

  -- Entitlement: an active or trialing subscription. past_due is grace.
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
