export function portalConfiguration(id, targetPriceId) {
  const upgrade = Boolean(targetPriceId);
  return { id, active: true, livemode: false, is_default: !upgrade, login_page: { enabled: false }, features: {
    customer_update: { enabled: false },
    invoice_history: { enabled: !upgrade },
    // Enabled on BOTH shapes. Stripe refuses to enable subscription updates
    // while this is off, so an upgrade configuration with it off is a thing
    // Stripe will not create, and a fixture that says otherwise is a fixture
    // that lies. It lied until 2026-09-14, when the plan was applied for the
    // first time and Stripe rejected it.
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: !upgrade, mode: 'at_period_end' },
    subscription_update: { enabled: upgrade, default_allowed_updates: upgrade ? ['price'] : [],
      proration_behavior: 'always_invoice', billing_cycle_anchor: 'unchanged', trial_update_behavior: 'continue_trial',
      schedule_at_period_end: { conditions: [] },
      products: upgrade ? [{ product: 'prod_Fixture', prices: [targetPriceId],
        adjustable_quantity: { enabled: false } }] : [] },
  } };
}
