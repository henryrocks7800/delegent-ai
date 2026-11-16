import { ACKNOWLEDGEMENT_TEXT } from '@sidekick/shared';

// This page is currently a placeholder — there is no real billing dashboard
// behind it. The previous copy implied otherwise ("Google sign-in, Stripe
// Checkout, and Billing Portal routes live here"), which would have been
// misleading on a deployed environment. Once the real dashboard is wired up
// it must be gated behind a server-side Supabase auth check (read the session
// cookie via `@supabase/auth-helpers-nextjs` or equivalent and redirect
// unauthenticated users to /login). The placeholder is otherwise harmless
// because no protected data is exposed.
export default function Page() {
  return (
    <main style={{ fontFamily: 'Inter, system-ui, sans-serif', padding: 40, maxWidth: 860, margin: '0 auto' }}>
      <h1>Delegent AI</h1>
      <p>An AI coworker with their own cloud computer. You message them; they handle the admin.</p>
      <section style={{ padding: 24, border: '1px solid #dbeafe', borderRadius: 24, background: '#f8fbff' }}>
        <h2>Status</h2>
        <p>
          This page is a public placeholder. The billing dashboard, Google sign-in flow, Stripe Checkout
          handoff, and Billing Portal redirect have not been implemented yet — see the engineering
          backlog. Sensitive surfaces will land behind an authenticated route.
        </p>
        <p>
          <strong>Acknowledgement:</strong> {ACKNOWLEDGEMENT_TEXT}
        </p>
      </section>
    </main>
  );
}
