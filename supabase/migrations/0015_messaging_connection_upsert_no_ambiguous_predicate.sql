begin;

-- B09: remove the partial-index ON CONFLICT predicate from the active
-- messaging-connection RPC. In PL/pgSQL the output columns `gateway_id` and
-- `status` are variables, so the predicate can remain ambiguous at runtime.
create or replace function public.set_active_gateway_connection(
  p_user_id uuid,
  p_gateway_id text,
  p_source_conversation_id text,
  p_source_event_id text default null
)
returns table(connection_id uuid, gateway_id text, status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection_id uuid;
  v_existing_user_id uuid;
begin
  if p_user_id is null then
    raise exception 'user is required' using errcode = '22023';
  end if;

  if coalesce(p_gateway_id, '') not in ('telegram', 'whatsapp', 'signal') then
    raise exception 'unsupported messaging provider' using errcode = '22023';
  end if;

  if btrim(coalesce(p_source_conversation_id, '')) = '' then
    raise exception 'source conversation is required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select public.gateway_connections.user_id into v_existing_user_id
  from public.gateway_connections
  where public.gateway_connections.gateway_id = p_gateway_id
    and public.gateway_connections.source_conversation_id = p_source_conversation_id
    and public.gateway_connections.status = 'connected'
  for update;

  if v_existing_user_id is not null and v_existing_user_id <> p_user_id then
    raise exception 'messaging conversation is already connected' using errcode = '23505';
  end if;

  update public.gateway_connections set status = 'disconnected',
      disconnected_at = coalesce(disconnected_at, now()),
      updated_at = now()
  where public.gateway_connections.user_id = p_user_id
    and public.gateway_connections.status = 'connected'
    and (
      public.gateway_connections.gateway_id <> p_gateway_id
      or public.gateway_connections.source_conversation_id <> p_source_conversation_id
    );

  update public.gateway_connections set
      status = 'connected',
      disconnected_at = null,
      last_source_event_id = nullif(btrim(coalesce(p_source_event_id, '')), ''),
      updated_at = now()
  where public.gateway_connections.user_id = p_user_id
    and public.gateway_connections.gateway_id = p_gateway_id
    and public.gateway_connections.source_conversation_id = p_source_conversation_id
  returning public.gateway_connections.id into v_connection_id;

  if v_connection_id is null then
    insert into public.gateway_connections (
      user_id,
      gateway_id,
      source_conversation_id,
      status,
      connected_at,
      disconnected_at,
      last_source_event_id
    ) values (
      p_user_id,
      p_gateway_id,
      p_source_conversation_id,
      'connected',
      now(),
      null,
      nullif(btrim(coalesce(p_source_event_id, '')), '')
    )
    returning public.gateway_connections.id into v_connection_id;
  end if;

  connection_id := v_connection_id;
  gateway_id := p_gateway_id;
  status := 'connected';
  return next;
end;
$$;

revoke all on function public.set_active_gateway_connection(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.set_active_gateway_connection(uuid, text, text, text) to service_role;

commit;
