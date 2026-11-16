-- PASS2: immutable provider ownership plus one entitlement/quota/lifecycle commit.
begin;

alter table public.subscriptions add column stripe_entitlement_invoice_id text,
  add column billing_revision bigint not null default 0,
  add column service_access_until timestamptz;
-- Existing Apple rows get the verified receipt boundary. Reconcile current
-- Apple grace states before rollout, then enable the new request gates.
update public.subscriptions set service_access_until=current_period_end where billing_provider='apple';

create function public.subscription_service_access_allowed(
  p_status text,p_provider text,p_period_end timestamptz,p_service_until timestamptz,p_at timestamptz
) returns boolean language sql immutable as $$
  select coalesce(p_status in ('active','trialing','past_due') and
    case when p_provider='apple' then p_service_until>p_at
      when p_status='trialing' then p_period_end>p_at else true end,false)
$$;
create function public.advance_billing_revision() returns trigger language plpgsql
  set search_path=public,pg_temp as $$ begin new.billing_revision:=old.billing_revision+1; return new; end; $$;
create trigger subscriptions_billing_revision before update on public.subscriptions
  for each row execute function public.advance_billing_revision();

create table public.billing_subscription_ownership (
  provider text not null check(provider in ('stripe','apple')),
  provider_environment text not null default '',
  provider_subscription_id text not null check(length(provider_subscription_id)>0),
  provider_customer_id text,
  user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  last_event_key text,
  last_applied_at timestamptz,
  primary key(provider,provider_environment,provider_subscription_id),
  check((provider='stripe' and provider_environment='') or
    (provider='apple' and provider_environment in ('Production','Sandbox')))
);
alter table public.billing_subscription_ownership enable row level security;
revoke all on public.billing_subscription_ownership from public,anon,authenticated;
grant select,insert,update,delete on public.billing_subscription_ownership to service_role;
create index billing_subscription_owner_idx on public.billing_subscription_ownership(user_id);
create index billing_stripe_customer_owner_idx on public.billing_subscription_ownership(provider_customer_id)
  where provider='stripe';

-- The latest event alone is insufficient: a response-lost event can retry
-- after another event from the same Stripe second has already committed.
create table public.billing_entitlement_commits (
  provider text not null check(provider in ('stripe','apple')),
  event_key text not null,
  user_id uuid references public.profiles(id) on delete set null,
  applied_at timestamptz not null default now(),
  primary key(provider,event_key)
);
alter table public.billing_entitlement_commits enable row level security;
revoke all on public.billing_entitlement_commits from public,anon,authenticated;
grant select,insert,update,delete on public.billing_entitlement_commits to service_role;

create table public.billing_payment_reversals (
  event_key text primary key,
  user_id uuid references public.profiles(id) on delete set null,
  stripe_subscription_id text not null,
  stripe_invoice_id text not null,
  stripe_charge_id text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  reason text not null check(reason in ('refund','dispute')),
  reversed_at timestamptz not null,
  created_at timestamptz not null default now(),
  check(period_end>period_start)
);
alter table public.billing_payment_reversals enable row level security;
revoke all on public.billing_payment_reversals from public,anon,authenticated;
grant select,insert,update,delete on public.billing_payment_reversals to service_role;
create index billing_reversed_period_idx on public.billing_payment_reversals(stripe_subscription_id,period_start,period_end);

-- Preserve both historical identifiers before cleaning the current projection.
insert into public.billing_subscription_ownership(provider,provider_subscription_id,provider_customer_id,user_id,retired_at)
  select 'stripe',stripe_subscription_id,stripe_customer_id,user_id,
    case when billing_provider<>'stripe' then now() else null end
  from public.subscriptions where stripe_subscription_id is not null;
insert into public.billing_subscription_ownership(provider,provider_environment,provider_subscription_id,user_id,retired_at)
  select 'apple',apple_environment,apple_original_transaction_id,user_id,
    case when billing_provider<>'apple' then now() else null end
  from public.subscriptions where apple_original_transaction_id is not null;

update public.subscriptions set stripe_customer_id=null,stripe_subscription_id=null,price_id=null,stripe_entitlement_invoice_id=null
  where billing_provider='apple';
update public.subscriptions set apple_original_transaction_id=null,apple_product_id=null,apple_environment=null
  where billing_provider='stripe';
drop index public.subscriptions_apple_original_transaction_idx;
create unique index subscriptions_apple_original_transaction_idx
  on public.subscriptions(apple_environment,apple_original_transaction_id)
  where apple_original_transaction_id is not null;
alter table public.subscriptions add constraint subscriptions_current_provider_identity_check check(
  (billing_provider='apple' and stripe_customer_id is null and stripe_subscription_id is null and price_id is null and stripe_entitlement_invoice_id is null)
  or (billing_provider='stripe' and apple_original_transaction_id is null and apple_product_id is null and apple_environment is null));

create or replace function public.apply_billing_entitlement(
  p_provider text,p_subscription jsonb,p_quota jsonb,p_event_key text,
  p_allow_provider_switch boolean default false,p_retention_seconds integer default 5184000
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_user uuid := (p_subscription->>'user_id')::uuid;
  v_external text := case when p_provider='stripe' then p_subscription->>'stripe_subscription_id'
    else p_subscription->>'apple_original_transaction_id' end;
  v_environment text := case when p_provider='stripe' then '' else p_subscription->>'apple_environment' end;
  v_status text := p_subscription->>'status';
  v_tier text := p_subscription->>'tier_id';
  v_provider_at timestamptz := (p_subscription->>'provider_updated_at')::timestamptz;
  v_start timestamptz := (p_subscription->>'current_period_start')::timestamptz;
  v_end timestamptz := (p_subscription->>'current_period_end')::timestamptz;
  v_service_until timestamptz := case when p_provider='apple' then (p_subscription->>'service_access_until')::timestamptz end;
  v_current public.subscriptions%rowtype;
  v_owner public.billing_subscription_ownership%rowtype;
  v_hi public.hermes_instances%rowtype;
  v_current_external text;
  v_invoice text;
  v_same boolean := false;
  v_entitled boolean := v_status in ('active','trialing','past_due');
  v_resumed boolean := false;
  v_at timestamptz := now();
begin
  if v_user is null or p_provider not in ('stripe','apple') or nullif(v_external,'') is null
    or nullif(p_event_key,'') is null or length(p_event_key)>500 or v_provider_at is null
    or v_status not in ('inactive','trialing','active','past_due','canceled')
    or v_tier not in ('studio','pro-office','enterprise-suite')
    or p_quota->>'user_id' is distinct from v_user::text or p_quota->>'tier_id' is distinct from v_tier
    or (p_quota->>'monthly_token_quota')::bigint is null or (p_quota->>'monthly_token_quota')::bigint<0
    or (p_quota->>'storage_quota_bytes')::bigint is null or (p_quota->>'storage_quota_bytes')::bigint<0
    or (p_quota->>'voice_seconds_quota')::integer is null or (p_quota->>'voice_seconds_quota')::integer<0 then
    raise exception 'invalid_billing_entitlement';
  end if;
  if v_entitled and (v_start is null or v_end is null or v_end<v_start) then
    raise exception 'missing_billing_period';
  end if;
  if v_entitled and p_provider='apple' and v_service_until is null then raise exception 'missing_apple_service_deadline'; end if;
  v_entitled := public.subscription_service_access_allowed(v_status,p_provider,v_end,v_service_until,v_at);
  if p_provider='apple' and not v_entitled then v_status:='canceled'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing-entitlement:'||v_user::text,0));
  perform 1 from public.profiles where id=v_user for key share;
  if not found then raise exception 'billing_account_missing'; end if;

  insert into public.billing_subscription_ownership(provider,provider_environment,provider_subscription_id,provider_customer_id,user_id)
    values(p_provider,v_environment,v_external,p_subscription->>'stripe_customer_id',v_user)
    on conflict do nothing;
  select * into v_owner from public.billing_subscription_ownership
    where provider=p_provider and provider_environment=v_environment and provider_subscription_id=v_external for update;
  if v_owner.user_id is distinct from v_user then raise exception 'billing_subscription_owned_elsewhere'; end if;
  select * into v_current from public.subscriptions where user_id=v_user for update;
  if exists(select 1 from public.billing_entitlement_commits where provider=p_provider and event_key=p_event_key) then
    if not exists(select 1 from public.billing_entitlement_commits where provider=p_provider and event_key=p_event_key and user_id=v_user) then
      raise exception 'billing_event_owned_elsewhere';
    end if;
    return jsonb_build_object('outcome','duplicate','resumed',false);
  end if;
  v_current_external := case when v_current.billing_provider='apple' then v_current.apple_original_transaction_id
    else v_current.stripe_subscription_id end;
  v_same := v_current.billing_provider=p_provider and v_current_external=v_external
    and (p_provider='stripe' or v_current.apple_environment=v_environment);
  if coalesce(v_same,false) then
    if v_owner.last_event_key=p_event_key then return jsonb_build_object('outcome','duplicate','resumed',false); end if;
    if v_current.provider_updated_at>v_provider_at then
      return jsonb_build_object('outcome','ignored_stale','resumed',false);
    end if;
  elsif v_current_external is not null then
    -- Historical cancellations never cancel another current provider/lineage.
    if not v_entitled or (v_owner.retired_at is not null and not p_allow_provider_switch) then
      return jsonb_build_object('outcome','ignored_historical','resumed',false);
    end if;
    if public.subscription_service_access_allowed(v_current.status,v_current.billing_provider,
      v_current.current_period_end,v_current.service_access_until,v_at) then
      return jsonb_build_object('outcome','provider_conflict','resumed',false);
    end if;
    if not p_allow_provider_switch then
      return jsonb_build_object('outcome','activation_pending','resumed',false);
    end if;
  end if;

  v_invoice := case when p_provider='stripe' then coalesce(p_subscription->>'stripe_entitlement_invoice_id',
    case when v_same then v_current.stripe_entitlement_invoice_id end) end;
  if v_entitled and p_provider='stripe' and exists(select 1 from public.billing_payment_reversals r
    where r.user_id=v_user and r.stripe_subscription_id=v_external and r.period_start=v_start and r.period_end=v_end
      and (v_invoice is null or r.stripe_invoice_id=v_invoice)) then
    return jsonb_build_object('outcome','ignored_reversed_payment','resumed',false);
  end if;

  -- This update also takes the retirement fence from migration 0065. A billing
  -- event must retry if a provider deletion may already be in flight.
  insert into public.subscriptions(user_id,status,tier_id,billing_provider,
    stripe_customer_id,stripe_subscription_id,price_id,apple_original_transaction_id,apple_product_id,apple_environment,
    current_period_start,current_period_end,cancel_at_period_end,provider_updated_at,updated_at,stripe_entitlement_invoice_id,service_access_until)
  values(v_user,v_status,v_tier,p_provider,
    case when p_provider='stripe' then p_subscription->>'stripe_customer_id' end,
    case when p_provider='stripe' then v_external end,
    case when p_provider='stripe' then p_subscription->>'price_id' end,
    case when p_provider='apple' then v_external end,
    case when p_provider='apple' then p_subscription->>'apple_product_id' end,
    case when p_provider='apple' then v_environment end,
    coalesce(v_start,case when v_same then v_current.current_period_start end),
    coalesce(v_end,case when v_same then v_current.current_period_end end),
    coalesce((p_subscription->>'cancel_at_period_end')::boolean,false),v_provider_at,v_at,v_invoice,v_service_until)
  on conflict(user_id) do update set status=excluded.status,tier_id=excluded.tier_id,billing_provider=excluded.billing_provider,
    stripe_customer_id=excluded.stripe_customer_id,stripe_subscription_id=excluded.stripe_subscription_id,price_id=excluded.price_id,
    apple_original_transaction_id=excluded.apple_original_transaction_id,apple_product_id=excluded.apple_product_id,apple_environment=excluded.apple_environment,
    current_period_start=excluded.current_period_start,current_period_end=excluded.current_period_end,
    cancel_at_period_end=excluded.cancel_at_period_end,provider_updated_at=excluded.provider_updated_at,updated_at=excluded.updated_at,
    stripe_entitlement_invoice_id=excluded.stripe_entitlement_invoice_id,service_access_until=excluded.service_access_until;
  insert into public.usage_quotas(user_id,tier_id,monthly_token_quota,storage_quota_bytes,voice_seconds_quota,provider_updated_at,updated_at)
    values(v_user,v_tier,(p_quota->>'monthly_token_quota')::bigint,(p_quota->>'storage_quota_bytes')::bigint,
      (p_quota->>'voice_seconds_quota')::integer,v_provider_at,v_at)
    on conflict(user_id) do update set tier_id=excluded.tier_id,monthly_token_quota=excluded.monthly_token_quota,
      storage_quota_bytes=excluded.storage_quota_bytes,voice_seconds_quota=excluded.voice_seconds_quota,
      provider_updated_at=excluded.provider_updated_at,updated_at=excluded.updated_at;

  select * into v_hi from public.hermes_instances where user_id=v_user for update;
  if v_entitled then
    if v_hi.status='sleeping' then
      update public.hermes_instances set status='provisioning',provisioning_tier_id=v_tier,
        suspended_at=null,volume_retention_until=null,error_code=null,
        provisioning_claimed_at=null,provisioning_lease_expires_at=null,
        public_status_message='Delegent AI is coming back online.',updated_at=v_at where user_id=v_user;
      v_resumed := true;
    elsif v_hi.user_id is null or v_hi.status in ('not_requested','error','queued','deleted') then
      insert into public.hermes_instances(user_id,status,provider,provisioning_tier_id,provisioning_idempotency_key,
        provisioning_requested_at,provisioning_claimed_at,provisioning_lease_expires_at,provisioning_failure_count,
        error_code,ready_at,public_status_message,updated_at)
      values(v_user,'queued','fly_machines',v_tier,
        case when v_hi.status<>'deleted' then coalesce(v_hi.provisioning_idempotency_key,'billing:'||p_event_key) else 'billing:'||p_event_key end,
        v_at,null,null,0,null,null,'Your coworker is queued for setup.',v_at)
      on conflict(user_id) do update set status=excluded.status,provider=excluded.provider,
        provisioning_tier_id=excluded.provisioning_tier_id,provisioning_idempotency_key=excluded.provisioning_idempotency_key,
        provisioning_requested_at=excluded.provisioning_requested_at,provisioning_claimed_at=null,provisioning_lease_expires_at=null,
        provisioning_failure_count=0,error_code=null,ready_at=null,public_status_message=excluded.public_status_message,updated_at=v_at;
    end if;
  elsif v_hi.status in ('not_requested','error','queued','ready','degraded','provisioning','sleeping') then
    update public.hermes_instances set status='sleeping',
      suspended_at=coalesce(suspended_at,v_at),
      volume_retention_until=coalesce(volume_retention_until,v_at+make_interval(secs=>greatest(p_retention_seconds,60))),
      public_status_message='Delegent AI is paused while your subscription is inactive.',updated_at=v_at
      where user_id=v_user;
  end if;
  if not coalesce(v_same,false) then
    update public.billing_subscription_ownership set retired_at=coalesce(retired_at,v_at)
      where user_id=v_user and (provider,provider_environment,provider_subscription_id)<>(p_provider,v_environment,v_external);
  end if;
  update public.billing_subscription_ownership set retired_at=null,last_event_key=p_event_key,last_applied_at=v_at,
    provider_customer_id=coalesce(p_subscription->>'stripe_customer_id',provider_customer_id)
    where provider=p_provider and provider_environment=v_environment and provider_subscription_id=v_external;
  insert into public.billing_entitlement_commits(provider,event_key,user_id) values(p_provider,p_event_key,v_user);
  return jsonb_build_object('outcome','applied','resumed',v_resumed);
end;
$$;
revoke all on function public.apply_billing_entitlement(text,jsonb,jsonb,text,boolean,integer) from public,anon,authenticated;
grant execute on function public.apply_billing_entitlement(text,jsonb,jsonb,text,boolean,integer) to service_role;

create function public.apply_stripe_payment_reversal(
  p_user_id uuid,p_customer_id text,p_subscription_id text,p_invoice_id text,p_charge_id text,
  p_expected_revision bigint,p_period_start timestamptz,p_period_end timestamptz,
  p_event_key text,p_event_at timestamptz,p_reason text,p_retention_seconds integer default 5184000
) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v_sub public.subscriptions%rowtype; v_owner public.billing_subscription_ownership%rowtype; v_at timestamptz:=now();
begin
  if p_user_id is null or nullif(p_customer_id,'') is null or nullif(p_subscription_id,'') is null
    or nullif(p_invoice_id,'') is null or nullif(p_charge_id,'') is null or nullif(p_event_key,'') is null
    or p_event_at is null or p_expected_revision is null or p_reason not in ('refund','dispute')
    or p_period_start is null or p_period_end is null or p_period_end<=p_period_start then
    raise exception 'invalid_payment_reversal';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('billing-entitlement:'||p_user_id::text,0));
  perform 1 from public.profiles where id=p_user_id for key share;
  if not found then raise exception 'billing_account_missing'; end if;
  select * into v_owner from public.billing_subscription_ownership where provider='stripe'
    and provider_environment='' and provider_subscription_id=p_subscription_id for update;
  if v_owner.user_id is distinct from p_user_id or v_owner.provider_customer_id is distinct from p_customer_id then
    raise exception 'reversal_subscription_owner_mismatch';
  end if;
  if exists(select 1 from public.billing_payment_reversals where event_key=p_event_key and user_id=p_user_id) then return 'duplicate'; end if;
  select * into v_sub from public.subscriptions where user_id=p_user_id for update;
  if v_sub.billing_provider is distinct from 'stripe' or v_sub.stripe_subscription_id is distinct from p_subscription_id then
    return 'ignored_historical_subscription';
  end if;
  if v_sub.stripe_customer_id is distinct from p_customer_id or v_sub.billing_revision<>p_expected_revision or v_sub.current_period_start is distinct from p_period_start
    or v_sub.current_period_end is distinct from p_period_end
    or (v_sub.stripe_entitlement_invoice_id is not null and v_sub.stripe_entitlement_invoice_id<>p_invoice_id) then
    raise exception using errcode='40001',message='reversal_subscription_state_changed';
  end if;
  insert into public.billing_payment_reversals(event_key,user_id,stripe_subscription_id,stripe_invoice_id,
    stripe_charge_id,period_start,period_end,reason,reversed_at)
    values(p_event_key,p_user_id,p_subscription_id,p_invoice_id,p_charge_id,p_period_start,p_period_end,p_reason,p_event_at);
  update public.subscriptions set status='canceled',stripe_entitlement_invoice_id=p_invoice_id,
    provider_updated_at=greatest(provider_updated_at,p_event_at),updated_at=v_at where user_id=p_user_id;
  update public.hermes_instances set status='sleeping',suspended_at=coalesce(suspended_at,v_at),
    volume_retention_until=coalesce(volume_retention_until,v_at+make_interval(secs=>greatest(p_retention_seconds,60))),
    public_status_message=case when p_reason='refund' then 'Delegent AI is paused following a refund.'
      else 'Delegent AI is paused while a payment dispute is resolved.' end,updated_at=v_at
    where user_id=p_user_id and status in ('not_requested','error','queued','ready','degraded','provisioning','sleeping');
  insert into public.billing_entitlement_commits(provider,event_key,user_id) values('stripe',p_event_key,p_user_id);
  return 'applied';
end; $$;
revoke all on function public.apply_stripe_payment_reversal(uuid,text,text,text,text,bigint,timestamptz,timestamptz,text,timestamptz,text,integer)
  from public,anon,authenticated;
grant execute on function public.apply_stripe_payment_reversal(uuid,text,text,text,text,bigint,timestamptz,timestamptz,text,timestamptz,text,integer) to service_role;

notify pgrst,'reload schema';
commit;
