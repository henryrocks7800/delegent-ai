-- Reserve the client key and display rows in ONE transaction, before execution.
-- A concurrent retry returns the same run and must not dispatch it again.
create or replace function public.claim_chat_message(
  p_instruction text,
  p_attachment_metadata jsonb default '[]'::jsonb,
  p_client_run_id text default null
)
returns table(conversation_id uuid, user_message_id uuid,
              assistant_message_id uuid, task_run_id uuid, claimed boolean)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.task_runs%rowtype;
  v_created record;
  v_assistant uuid;
begin
  if v_user_id is null then raise exception 'unauthenticated'; end if;
  if p_client_run_id is not null then
    if length(btrim(p_client_run_id)) = 0 or length(p_client_run_id) > 80 then
      raise exception 'invalid_client_run_id';
    end if;
    -- Transaction-scoped lock also covers the not-yet-inserted key. Hash
    -- collisions serialize unrelated requests harmlessly, never conflate them.
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_client_run_id, 0));
    select t.* into v_existing from public.task_runs t
      where t.user_id = v_user_id and t.client_run_id = p_client_run_id;
    if found then
      select m.id into v_assistant from public.messages m
        where m.user_id = v_user_id and m.task_run_id = v_existing.id and m.role = 'assistant'
        order by m.created_at, m.id limit 1;
      return query select v_user_id, v_existing.message_id, v_assistant, v_existing.id, false;
      return;
    end if;
  end if;
  select * into v_created from public.enqueue_chat_message(p_instruction, p_attachment_metadata);
  update public.task_runs t set client_run_id = p_client_run_id where t.id = v_created.task_run_id;
  return query select v_created.conversation_id, v_created.user_message_id,
    v_created.assistant_message_id, v_created.task_run_id, true;
end;
$$;
revoke all on function public.claim_chat_message(text, jsonb, text) from public, anon;
grant execute on function public.claim_chat_message(text, jsonb, text) to authenticated;
