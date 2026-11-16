/** Reject configuration drift before issuing a customer-facing portal URL. */
export function assertPortalConfiguration(value: unknown, expected: {
  id: string; livemode: boolean; targetPriceId?: string;
}): void {
  const cfg = record(value);
  const features = record(cfg?.features);
  const update = record(features?.subscription_update);
  const fail = () => { throw new Error('Stripe billing portal configuration unsafe or unavailable'); };
  if (!/^bpc_[A-Za-z0-9]+$/.test(expected.id) || !cfg || cfg.id !== expected.id
    || cfg.active !== true || cfg.livemode !== expected.livemode || !features || !update) return fail();
  if (!expected.targetPriceId) {
    if (update.enabled !== false || record(features.payment_method_update)?.enabled !== true
      || record(features.invoice_history)?.enabled !== true
      || record(features.subscription_cancel)?.enabled !== true
      || record(features.subscription_cancel)?.mode !== 'at_period_end') return fail();
    return;
  }
  // One exact destination price. No quantities, promotion codes, login page
  // or other portal actions may expand this targeted confirmation's scope.
  // Stripe does NOT return `subscription_update.products` on a billing portal
  // configuration on this account. It accepts the parameter with a 200 and the
  // field is simply absent from the object afterwards, on every API version
  // tried including the account default (2026-04-22.dahlia) and a pinned older
  // one. Verified against live Stripe on 2026-09-14 after the configuration
  // was created; that is why the first three attempts to open an upgrade all
  // returned 503 with "configuration unsafe or unavailable".
  //
  // So this is checked WHEN PRESENT and cannot be required. What actually binds
  // the destination is per session, not per configuration: createParams.
  // flow_data.subscription_update_confirm.items[0].price is set from our own
  // tier table on every session, and a confirm flow shows exactly that one
  // change. The configuration still forbids everything around it, which is the
  // rest of this condition: price-only updates, no quantity, no promotion code,
  // no cancel, no invoice history, no customer edits, no login page, never the
  // default configuration.
  const products = update.products;
  const productsPinned = products !== undefined && products !== null;
  const product = Array.isArray(products) && products.length === 1 ? record(products[0]) : null;
  const prices = product?.prices;
  const allowed = update.default_allowed_updates;
  // Absent means Stripe's own default, which IS an empty list. The field is
  // always present on a configuration read back from Stripe and absent on a
  // proposal, because Stripe refuses an empty array in a create request. Both
  // mean the same thing: never defer an update to the period end.
  const scheduleAtPeriodEnd = update.schedule_at_period_end;
  const conditions = scheduleAtPeriodEnd === undefined ? [] : record(scheduleAtPeriodEnd)?.conditions;
  if (cfg.is_default !== false || record(cfg.login_page)?.enabled !== false
    || update.enabled !== true || !Array.isArray(allowed) || allowed.length !== 1 || allowed[0] !== 'price'
    || update.proration_behavior !== 'always_invoice'
    || update.trial_update_behavior !== 'continue_trial'
    || (update.billing_cycle_anchor !== 'unchanged' && update.billing_cycle_anchor !== null)
    || !Array.isArray(conditions) || conditions.length !== 0
    // Only when Stripe gives us something to check. Absent is not "anything
    // goes": it is Stripe not modelling the field, and the destination price is
    // pinned per session regardless. Present and wrong is still a refusal.
    || (productsPinned && (!product || typeof product.product !== 'string'
      || !/^prod_[A-Za-z0-9]+$/.test(product.product)
      || !Array.isArray(prices) || prices.length !== 1 || prices[0] !== expected.targetPriceId
      || record(product.adjustable_quantity)?.enabled !== false))
    // Stripe REFUSES to enable subscription updates while payment method
    // update is off ("Cannot enable subscription updates while payment method
    // update is disabled"), so this one cannot be shut and the original policy,
    // which required it shut, described a configuration Stripe will not create.
    // Found on 2026-09-14 by applying the plan for the first time; it had only
    // ever been read. Letting somebody fix their own card is also what an
    // upgrade blocked by a declined card needs.
    || record(features.payment_method_update)?.enabled !== true
    // The rest stay shut. A confirmation sent to change one price must not be
    // a door into cancelling, editing billing details or browsing invoices.
    || ['customer_update', 'invoice_history', 'subscription_cancel']
      .some(feature => record(features[feature])?.enabled !== false)) return fail();
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
