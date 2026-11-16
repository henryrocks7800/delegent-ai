-- PASS13: one durable purchase attempt per account across providers.
begin;

create table public.billing_purchase_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  provider text not null check(provider in ('stripe','apple')),
  tier_id text not null check(tier_id in ('studio','pro-office','enterprise-suite')),
  phase text not null default 'reserved'
    check(phase in ('reserved','prepared','open','awaiting_entitlement','completed','expired','abandoned')),
  request jsonb not null check(jsonb_typeof(request)='object'),
  prepared_params jsonb,
  provider_session_id text unique,
  provider_subscription_id text,
  provider_environment text,
  lease_token uuid,
  lease_expires_at timestamptz,
  expires_at timestamptz not null default now()+interval '1 hour',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((lease_token is null)=(lease_expires_at is null))
);
create unique index billing_purchase_one_pending_account on public.billing_purchase_intents(user_id)
  where phase in ('reserved','prepared','open','awaiting_entitlement');
alter table public.billing_purchase_intents enable row level security;
revoke all on public.billing_purchase_intents from public,anon,authenticated;
grant select,insert,update,delete on public.billing_purchase_intents to service_role;

-- Conflicting provider-confirmed payments are durable operator work, never a
-- reason to overwrite the current entitlement or automatically refund/cancel.
create table public.billing_purchase_conflicts (
  provider text not null check(provider in ('stripe','apple')),
  event_key text not null,
  user_id uuid references public.profiles(id) on delete set null,
  purchase_intent_id uuid references public.billing_purchase_intents(id),
  provider_subscription_id text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  primary key(provider,event_key)
);
alter table public.billing_purchase_conflicts enable row level security;
revoke all on public.billing_purchase_conflicts from public,anon,authenticated;
grant select,insert,update,delete on public.billing_purchase_conflicts to service_role;

create function public.claim_billing_purchase_intent(
  p_user_id uuid,p_provider text,p_tier_id text,p_request jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_intent public.billing_purchase_intents%rowtype; v_sub public.subscriptions%rowtype;
  v_action text:='resume'; v_at timestamptz:=now();
begin
  if p_user_id is null or p_provider not in ('stripe','apple')
    or p_tier_id not in ('studio','pro-office','enterprise-suite')
    or jsonb_typeof(p_request) is distinct from 'object' then raise exception 'invalid_purchase_request'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing-entitlement:'||p_user_id::text,0));
  perform 1 from public.profiles where id=p_user_id for key share;
  if not found then raise exception 'billing_account_missing'; end if;
  if exists(select 1 from public.billing_purchase_conflicts where user_id=p_user_id and resolved_at is null) then
    return jsonb_build_object('kind','reconciliation_required');
  end if;
  select * into v_sub from public.subscriptions where user_id=p_user_id for share;
  if public.subscription_service_access_allowed(v_sub.status,v_sub.billing_provider,
    v_sub.current_period_end,v_sub.service_access_until,v_at)
    and not(p_provider='apple' and v_sub.billing_provider='apple') then
    return jsonb_build_object('kind','already_entitled');
  end if;
  select * into v_intent from public.billing_purchase_intents where user_id=p_user_id
    and phase in ('reserved','prepared','open','awaiting_entitlement') for update;
  if found then
    if v_intent.phase='awaiting_entitlement' then return jsonb_build_object('kind','payment_pending'); end if;
    if v_intent.lease_expires_at>v_at then return jsonb_build_object('kind','busy'); end if;
    if v_intent.provider='apple' and v_intent.expires_at<=v_at then
      -- Apple cannot expire a sheet remotely. A later payment must pass the
      -- entitlement fence and be recorded for reconciliation if superseded.
      update public.billing_purchase_intents set phase='abandoned',lease_token=null,lease_expires_at=null,
        updated_at=v_at where id=v_intent.id;
      v_intent:=null;
    elsif v_intent.provider<>p_provider or v_intent.tier_id<>p_tier_id then
      if v_intent.provider='apple' then return jsonb_build_object('kind','purchase_pending'); end if;
      v_action:='replace';
    end if;
  end if;
  if v_intent.id is null then
    insert into public.billing_purchase_intents(user_id,provider,tier_id,request)
      values(p_user_id,p_provider,p_tier_id,p_request || jsonb_build_object('hasPriorSubscription',
        exists(select 1 from public.billing_subscription_ownership where user_id=p_user_id)
        or coalesce(v_sub.current_period_end is not null or v_sub.status<>'inactive',false)))
      returning * into v_intent;
    v_action:='create';
  end if;
  update public.billing_purchase_intents set lease_token=gen_random_uuid(),lease_expires_at=v_at+interval '90 seconds',
    updated_at=v_at where id=v_intent.id returning * into v_intent;
  return jsonb_build_object('kind','claimed','action',v_action,'intent',to_jsonb(v_intent));
end; $$;
revoke all on function public.claim_billing_purchase_intent(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.claim_billing_purchase_intent(uuid,text,text,jsonb) to service_role;

create function public.update_billing_purchase_intent(
  p_user_id uuid,p_intent_id uuid,p_lease_token uuid,p_action text,p_value jsonb default '{}'
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_intent public.billing_purchase_intents%rowtype; v_status text; v_at timestamptz:=now();
begin
  perform pg_advisory_xact_lock(hashtextextended('billing-entitlement:'||p_user_id::text,0));
  select * into v_intent from public.billing_purchase_intents where id=p_intent_id and user_id=p_user_id for update;
  if not found or v_intent.lease_token is distinct from p_lease_token or p_lease_token is null
    or v_intent.phase not in ('reserved','prepared','open','awaiting_entitlement') then return false; end if;
  if p_action='prepare' then
    if v_intent.provider<>'stripe' or v_intent.provider_session_id is not null
      or p_value->'metadata'->>'purchaseIntentId' is distinct from v_intent.id::text
      or p_value->'metadata'->>'sidekickUserId' is distinct from p_user_id::text
      or p_value->'metadata'->>'tierId' is distinct from v_intent.tier_id
      or p_value->'subscription_data'->'metadata' is distinct from p_value->'metadata'
      or p_value->>'client_reference_id' is distinct from p_user_id::text
      or (p_value->>'expires_at')::bigint is distinct from floor(extract(epoch from v_intent.expires_at))::bigint
      then raise exception 'invalid_prepared_purchase'; end if;
    if v_intent.prepared_params is not null and v_intent.prepared_params<>p_value then
      raise exception 'purchase_parameters_already_frozen'; end if;
    update public.billing_purchase_intents set prepared_params=p_value,phase='prepared',updated_at=v_at where id=p_intent_id;
  elsif p_action='session' then
    v_status:=p_value->>'status';
    if v_intent.provider<>'stripe' or v_intent.prepared_params is null or nullif(p_value->>'id','') is null
      or v_status not in ('open','complete','expired')
      or (v_intent.provider_session_id is not null and v_intent.provider_session_id<>p_value->>'id') then
      raise exception 'invalid_purchase_session'; end if;
    if v_intent.phase='awaiting_entitlement' and v_status<>'complete' then raise exception 'purchase_already_paid'; end if;
    update public.billing_purchase_intents set provider_session_id=p_value->>'id',
      provider_subscription_id=coalesce(p_value->>'subscription',provider_subscription_id),
      phase=case v_status when 'complete' then 'awaiting_entitlement' when 'expired' then 'expired' else 'open' end,
      updated_at=v_at where id=p_intent_id;
  elsif p_action='expire_missing' then
    if v_intent.provider<>'stripe' or v_intent.provider_session_id is not null
      or (v_intent.prepared_params is not null and v_intent.expires_at>v_at) then
      raise exception 'purchase_absence_not_safe'; end if;
    update public.billing_purchase_intents set phase='expired',updated_at=v_at where id=p_intent_id;
  elsif p_action='authorize_apple' then
    if v_intent.provider<>'apple' then raise exception 'invalid_purchase_provider'; end if;
    update public.billing_purchase_intents set phase='open',updated_at=v_at where id=p_intent_id;
  elsif p_action<>'release' then
    raise exception 'invalid_purchase_action';
  end if;
  if p_action='release' then
    update public.billing_purchase_intents set lease_token=null,lease_expires_at=null,updated_at=v_at where id=p_intent_id;
  end if;
  return true;
end; $$;
revoke all on function public.update_billing_purchase_intent(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.update_billing_purchase_intent(uuid,uuid,uuid,text,jsonb) to service_role;


-- Keep entitlement, quota, runner transition and purchase completion atomic.
alter function public.apply_billing_entitlement(text,jsonb,jsonb,text,boolean,integer)
  rename to apply_billing_entitlement_core;
revoke all on function public.apply_billing_entitlement_core(text,jsonb,jsonb,text,boolean,integer)
  from public,anon,authenticated,service_role;

create function public.apply_billing_entitlement(
  p_provider text,p_subscription jsonb,p_quota jsonb,p_event_key text,
  p_allow_provider_switch boolean default false,p_retention_seconds integer default 5184000
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_user uuid:=(p_subscription->>'user_id')::uuid;
  v_external text:=case when p_provider='stripe' then p_subscription->>'stripe_subscription_id'
    else p_subscription->>'apple_original_transaction_id' end;
  v_environment text:=case when p_provider='stripe' then '' else p_subscription->>'apple_environment' end;
  v_token text:=nullif(p_subscription->>'purchase_intent_id','');
  v_sub public.subscriptions%rowtype;
  v_intent public.billing_purchase_intents%rowtype;
  v_owner public.billing_subscription_ownership%rowtype;
  v_same boolean:=false; v_admitted boolean:=false; v_conflict text; v_result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('billing-entitlement:'||v_user::text,0));
  perform 1 from public.profiles where id=v_user for key share;
  if not found then raise exception 'billing_account_missing'; end if;
  select * into v_sub from public.subscriptions where user_id=v_user for update;
  v_same:=coalesce(v_sub.billing_provider=p_provider and
    (case when p_provider='stripe' then v_sub.stripe_subscription_id else v_sub.apple_original_transaction_id end)=v_external
    and (p_provider='stripe' or v_sub.apple_environment=v_environment),false);
  select * into v_owner from public.billing_subscription_ownership where provider=p_provider
    and provider_environment=v_environment and provider_subscription_id=v_external;
  if exists(select 1 from public.billing_entitlement_commits where provider=p_provider and event_key=p_event_key and user_id=v_user)
    or (not v_same and v_owner.user_id=v_user and v_owner.retired_at is not null and not p_allow_provider_switch
      and (v_sub.stripe_subscription_id is not null or v_sub.apple_original_transaction_id is not null)) then
    return public.apply_billing_entitlement_core(p_provider,p_subscription,p_quota,p_event_key,p_allow_provider_switch,p_retention_seconds);
  end if;
  if v_token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_intent from public.billing_purchase_intents where id=v_token::uuid for update;
  end if;
  v_admitted:=coalesce(v_intent.user_id=v_user and v_intent.provider=p_provider
    and v_intent.phase in ('reserved','prepared','open','awaiting_entitlement')
    and v_intent.tier_id=p_subscription->>'tier_id'
    and (v_intent.provider_subscription_id is null or v_intent.provider_subscription_id=v_external)
    and (p_provider='apple' or v_intent.prepared_params is not null),false);
  if not v_same then
    if exists(select 1 from public.billing_purchase_conflicts where user_id=v_user and resolved_at is null) then
      v_conflict:='unresolved_paid_conflict';
    elsif v_token is not null and not v_admitted and (v_intent.id is not null
      or exists(select 1 from public.billing_purchase_intents where user_id=v_user)) then
      v_conflict:='unrecognized_or_superseded_purchase';
    elsif v_token is null and exists(select 1 from public.billing_purchase_intents where user_id=v_user) then
      v_conflict:='purchase_admission_missing';
    end if;
  end if;
  if v_conflict is null then
    v_result:=public.apply_billing_entitlement_core(p_provider,p_subscription,p_quota,p_event_key,
      p_allow_provider_switch or v_admitted,p_retention_seconds);
    if v_result->>'outcome'='provider_conflict' then v_conflict:='current_provider_entitled'; end if;
  end if;
  if v_conflict is not null then
    insert into public.billing_purchase_conflicts(provider,event_key,user_id,purchase_intent_id,provider_subscription_id,reason)
      values(p_provider,p_event_key,v_user,case when v_intent.user_id=v_user then v_intent.id end,v_external,v_conflict)
      on conflict(provider,event_key) do nothing;
    return jsonb_build_object('outcome','purchase_conflict','resumed',false);
  end if;
  if v_admitted and v_result->>'outcome' in ('applied','duplicate') then
    update public.billing_purchase_intents set phase='completed',provider_subscription_id=v_external,
      provider_environment=v_environment,lease_token=null,lease_expires_at=null,updated_at=now() where id=v_intent.id;
  end if;
  return v_result;
end; $$;
revoke all on function public.apply_billing_entitlement(text,jsonb,jsonb,text,boolean,integer) from public,anon,authenticated;
grant execute on function public.apply_billing_entitlement(text,jsonb,jsonb,text,boolean,integer) to service_role;

notify pgrst,'reload schema';
commit;
