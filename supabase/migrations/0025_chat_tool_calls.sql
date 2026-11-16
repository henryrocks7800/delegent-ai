-- 0025 — chat tool-call surface (v1.2.7)
--
-- v1.2.7 routes mobile chat through the user's Hermes runner so the
-- agent has terminal/file/web tools. The runner returns the final
-- assistant reply plus an ordered list of tool invocations that fired
-- during the run. We surface those as inline cards in the chat so the
-- user sees what the coworker actually did (✎ creating test.txt /
-- ✔ created).
--
-- This migration:
--   1. Adds messages.tool_calls jsonb (default '[]') so the assistant
--      message row can carry its own activity trail.
--   2. Extends finalize_chat_message to accept and persist p_tool_calls
--      (validated as an array; entries are { tool, summary } objects).
--   3. Reloads PostgREST so the new function signature is callable
--      immediately.

alter table public.messages
  add column if not exists tool_calls jsonb not null default '[]'::jsonb;

-- Drop the v0023 signature so we can introduce one new optional arg
-- without colliding with the historic function.
drop function if exists public.finalize_chat_message(uuid, uuid, text, jsonb, boolean, text, timestamptz);

create or replace function public.finalize_chat_message(
  p_assistant_message_id uuid,
  p_task_run_id uuid,
  p_content text,
  p_artifacts jsonb default '[]'::jsonb,
  p_succeeded boolean default true,
  p_error_code text default null,
  p_tool_calls jsonb default '[]'::jsonb,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_match boolean;
  v_tool_calls jsonb;
begin
  if jsonb_typeof(p_tool_calls) = 'array' then
    v_tool_calls := p_tool_calls;
  else
    v_tool_calls := '[]'::jsonb;
  end if;

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
         tool_calls = v_tool_calls,
         updated_at = p_now
   where id = p_assistant_message_id;

  update public.task_runs
     set status = case when p_succeeded then 'succeeded' else 'failed' end,
         error_code = p_error_code,
         completed_at = p_now,
         updated_at = p_now
   where id = p_task_run_id;

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

revoke all on function public.finalize_chat_message(uuid, uuid, text, jsonb, boolean, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.finalize_chat_message(uuid, uuid, text, jsonb, boolean, text, jsonb, timestamptz) to service_role;

-- Reload PostgREST so the new signature is callable without restarting
-- the API gateway.
notify pgrst, 'reload schema';
