-- A definite native user cancellation releases admission, never billing.
begin;
create function public.cancel_billing_apple_purchase_intent(p_user_id uuid,p_intent_id uuid)
returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare v_intent public.billing_purchase_intents%rowtype;
begin
  if p_user_id is null or p_intent_id is null then return 'not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('billing-entitlement:'||p_user_id::text,0));
  select * into v_intent from public.billing_purchase_intents
    where id=p_intent_id and user_id=p_user_id and provider='apple' for update;
  if not found then return 'not_found'; end if;
  if v_intent.phase='completed' then return 'completed'; end if;
  if v_intent.phase='abandoned' then return 'canceled'; end if;
  if v_intent.phase not in ('reserved','open') then return 'not_pending'; end if;
  -- Keep the identity. A payment that later arrives still passes the atomic
  -- entitlement fence and becomes durable reconciliation work if superseded.
  update public.billing_purchase_intents set phase='abandoned',lease_token=null,
    lease_expires_at=null,updated_at=now() where id=p_intent_id;
  return 'canceled';
end; $$;
revoke all on function public.cancel_billing_apple_purchase_intent(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cancel_billing_apple_purchase_intent(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
