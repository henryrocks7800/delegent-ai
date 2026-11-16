import { SIDEKICK_PLAN_TIERS } from '@sidekick/shared';

export default function CheckoutPage({ searchParams }: { searchParams?: { plan?: string } }) {
  const requestedPlan = searchParams?.plan ?? 'pro-office';
  const selectedPlan = SIDEKICK_PLAN_TIERS.find((tier) => tier.id === requestedPlan) ?? SIDEKICK_PLAN_TIERS[1];

  return (
    <main style={{ fontFamily: 'Geist, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', minHeight: '100vh', background: '#f6f4ee', color: '#17201a', padding: 24 }}>
      <section style={{ maxWidth: 760, margin: '0 auto', paddingTop: 56 }}>
        <p style={{ color: '#3d6b45', fontWeight: 800, letterSpacing: 1.2, textTransform: 'uppercase', fontSize: 12 }}>Secure checkout</p>
        <h1 style={{ fontSize: 48, lineHeight: 1, letterSpacing: -1.8, margin: '12px 0 16px' }}>Subscribe to {selectedPlan.name}</h1>
        <p style={{ color: '#667263', fontSize: 18, lineHeight: 1.55, maxWidth: 620 }}>{selectedPlan.summary}</p>

        <div style={{ marginTop: 28, borderRadius: 28, background: '#fffaf0', border: '1px solid #e5decf', padding: 28 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 28, letterSpacing: -0.8 }}>{selectedPlan.name}</h2>
              <p style={{ color: '#667263', lineHeight: 1.5, marginBottom: 0 }}>{selectedPlan.summary}</p>
            </div>
            <strong style={{ fontSize: 30, letterSpacing: -1 }}>£{selectedPlan.priceGbpMonthly}/mo</strong>
          </div>

          <div style={{ marginTop: 24, borderRadius: 18, background: '#eef4ea', color: '#2f4f36', padding: '16px 18px', fontWeight: 700 }}>
            Choose your plan from inside the Delegent AI app.
          </div>
          <p style={{ color: '#7c8677', fontSize: 13, lineHeight: 1.45, marginTop: 16 }}>
            Open Delegent AI and pick a plan. Your signed-in session takes you straight to a secure Stripe Checkout — no direct browser purchases.
          </p>
        </div>
      </section>
    </main>
  );
}
