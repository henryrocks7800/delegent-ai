begin;

-- A lease timestamp alone cannot identify its writer or protect a newer grant.
alter table public.user_connections
  add column credential_version uuid not null default gen_random_uuid(),
  add column refresh_attempt_id uuid,
  add column refresh_attempt_state text check (
    refresh_attempt_state in ('in_flight', 'uncertain', 'succeeded', 'terminal'));

-- An old non-null lease may already have spent a rotating token, including
-- leases that expired after an unacknowledged write. Never reclaim it blindly.
update public.user_connections set refresh_attempt_id=gen_random_uuid(),
  refresh_attempt_state='uncertain', status='needs_reauth',
  last_error='refresh_outcome_unknown', refresh_lease_until=null
where status='connected' and refresh_lease_until is not null;

-- Reject unfenced writes from an older Worker during cutover. A reconnect
-- supplies a fresh version; all other lifecycle writes use the RPCs below.
create function public.guard_connection_credential_write()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.credential_version = old.credential_version
     and current_setting('delegent.connection_refresh_rpc', true) is distinct from 'on'
     and (new.access_token_enc, new.refresh_token_enc, new.access_expires_at,
          new.status, new.account_label, new.scopes, new.refresh_lease_until,
          new.refresh_attempt_id, new.refresh_attempt_state)
       is distinct from
         (old.access_token_enc, old.refresh_token_enc, old.access_expires_at,
          old.status, old.account_label, old.scopes, old.refresh_lease_until,
          old.refresh_attempt_id, old.refresh_attempt_state) then
    raise exception 'connection_credential_version_required';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_connection_credential_write() from public, anon, authenticated;
create trigger guard_connection_credential_write before update on public.user_connections
  for each row execute function public.guard_connection_credential_write();

-- An old caller cannot begin an unfenced provider refresh after this migration.
create or replace function public.claim_connection_refresh(p_user_id uuid, p_provider text, p_lease_seconds integer default 30)
returns boolean language sql security definer set search_path = public, pg_temp as $$ select false $$;

create function public.claim_native_connection_refresh(
  p_user_id uuid, p_provider text, p_version uuid, p_attempt_id uuid
) returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.user_connections%rowtype;
begin
  if p_user_id is null or p_version is null or p_attempt_id is null
     or p_attempt_id = p_version then raise exception 'invalid_refresh_claim'; end if;
  select * into c from public.user_connections where user_id=p_user_id and provider=p_provider for update;
  if not found or c.status='revoked' then return 'not_connected'; end if;
  if c.credential_version <> p_version then return 'changed'; end if;
  if c.refresh_attempt_state='uncertain' then return 'refresh_recovery_required'; end if;
  if c.status='needs_reauth' then return 'needs_reauth'; end if;
  if c.refresh_attempt_state='in_flight' then
    if c.refresh_lease_until > clock_timestamp() then
      -- A response-lost claim may be retried by this request BEFORE it sends
      -- anything to the provider. A different request always mints a new id.
      if c.refresh_attempt_id=p_attempt_id then return 'claimed'; end if;
      return 'busy';
    end if;
    perform set_config('delegent.connection_refresh_rpc','on',true);
    update public.user_connections set status='needs_reauth',
      refresh_attempt_state='uncertain', last_error='refresh_outcome_unknown',
      refresh_lease_until=null, updated_at=clock_timestamp() where id=c.id;
    return 'refresh_recovery_required';
  end if;
  -- Fail closed on an unexpected lease outside the current attempt protocol.
  if c.refresh_lease_until > clock_timestamp() then return 'busy'; end if;
  perform set_config('delegent.connection_refresh_rpc','on',true);
  update public.user_connections set refresh_attempt_id=p_attempt_id,
    refresh_attempt_state='in_flight', refresh_lease_until=clock_timestamp()+interval '60 seconds',
    last_error=null, updated_at=clock_timestamp() where id=c.id;
  return 'claimed';
end;
$$;

create function public.finish_native_connection_refresh(
  p_user_id uuid, p_provider text, p_version uuid, p_attempt_id uuid,
  p_outcome text, p_access_token_enc text default null,
  p_refresh_token_enc text default null, p_expires_at timestamptz default null
) returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.user_connections%rowtype;
begin
  if p_user_id is null or p_version is null or p_attempt_id is null
     or p_attempt_id=p_version or p_outcome not in ('succeeded','terminal','uncertain')
     or p_outcome is null then raise exception 'invalid_refresh_completion'; end if;
  if p_outcome='succeeded' and (
    p_access_token_enc is null or p_access_token_enc not like 'v1.%'
    or p_refresh_token_enc is null or p_refresh_token_enc not like 'v1.%'
    or p_expires_at is null or p_expires_at <= clock_timestamp()
  ) then raise exception 'invalid_refreshed_credentials'; end if;
  select * into c from public.user_connections where user_id=p_user_id and provider=p_provider for update;
  if not found or c.status='revoked' then return 'changed'; end if;
  if c.refresh_attempt_id is distinct from p_attempt_id then return 'changed'; end if;
  -- A successful write whose HTTP response was lost is verifiable and safely
  -- repeatable, without another provider request or another token encryption.
  if c.credential_version=p_attempt_id and c.refresh_attempt_state=p_outcome then
    if p_outcome='succeeded' and
      (c.access_token_enc,c.refresh_token_enc,c.access_expires_at) is distinct from
      (p_access_token_enc,p_refresh_token_enc,p_expires_at) then return 'changed'; end if;
    return 'stored';
  end if;
  if c.credential_version <> p_version then return 'changed'; end if;
  if c.refresh_attempt_state is null or c.refresh_attempt_state not in ('in_flight','uncertain') then return 'changed'; end if;
  perform set_config('delegent.connection_refresh_rpc','on',true);
  if p_outcome='succeeded' then
    -- An expired lease is NOT handed to another refresher. Its original owner
    -- may still persist the returned pair, unless a reconnect/deletion won.
    update public.user_connections set credential_version=p_attempt_id,
      status='connected', access_token_enc=p_access_token_enc,
      refresh_token_enc=p_refresh_token_enc, access_expires_at=p_expires_at,
      refresh_attempt_state='succeeded', refresh_lease_until=null,
      last_error=null, updated_at=clock_timestamp() where id=c.id;
  elsif p_outcome='terminal' then
    update public.user_connections set credential_version=p_attempt_id,
      status='needs_reauth', access_token_enc=null, refresh_token_enc=null,
      access_expires_at=null, refresh_attempt_state='terminal', refresh_lease_until=null,
      last_error='refresh_rejected', updated_at=clock_timestamp() where id=c.id;
  else
    -- No new pair was confirmed. Keep the encrypted evidence and fence the
    -- attempt; replaying the old refresh token could spend a rotated grant.
    update public.user_connections set status='needs_reauth',
      refresh_attempt_state='uncertain', refresh_lease_until=null,
      last_error='refresh_outcome_unknown', updated_at=clock_timestamp() where id=c.id;
  end if;
  return 'stored';
end;
$$;

revoke all on function public.claim_native_connection_refresh(uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_native_connection_refresh(uuid,text,uuid,uuid) to service_role;
revoke all on function public.finish_native_connection_refresh(uuid,text,uuid,uuid,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.finish_native_connection_refresh(uuid,text,uuid,uuid,text,text,text,timestamptz) to service_role;

commit;
