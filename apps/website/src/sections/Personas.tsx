// Persona filters for the homepage, Developers / Small Business / Non-technical.
//
// Sourced from docs/tmp/hermes_agent_optimized_copy_v2.md §3 'Website
// Integration: Optional Persona Filters'. Implemented as a three-card
// strip rather than a true filter (we don't have enough downstream
// persona-tagged content to make filtering useful yet). Each card uses
// the source headline + body, with safety rewrites applied.
//
// Placement: between BookkeeperFlagship and HowItWorks. Bookkeeper is
// the flagship; Personas widens the audience without diluting the lead.
//
// Safety rewrites:
//   - Persona examples must describe reviewable workspace artefacts,
//     user-provided context, and explicit approval for irreversible external
//     pushes, sends, filings, or live-store changes.
//   - No persona card should imply direct file upload, pre-built Shopify,
//     Stripe, GitHub, browser, inbox, or calendar automation is available for
//     every account on day one.
//   - 'fully stateful secretary' is kept as memory/context framing, but
//     official submissions and external messages remain user-reviewed.

interface Persona {
  audience: string;
  headline: string;
  body: string;
}

const PERSONAS: Persona[] = [
  {
    audience: 'Developers & technical power users',
    headline: 'Keep your workflow, lose the overhead.',
    body: 'No need to configure complex VPS servers, manage networking gates, or handle token burn. Your digital employee boots into a dedicated cloud environment out of the box. Paste a repo brief, source snippets, or an authorised repo link; it can run terminal checks, draft patches, write test notes, and save review artefacts in the workspace. You choose what gets pushed back to GitHub.',
  },
  {
    audience: 'Small business owners & entrepreneurs',
    headline: 'An always-on operations manager.',
    body: 'Bring order, stock, payment, or support exports, and add scoped API details only when you are ready. Your digital employee can compare the data, spot exceptions, draft customer replies, and save margin or refund notes in the workspace for review before any live store or customer record changes.',
  },
  {
    audience: 'Non-technical professionals & consumers',
    headline: 'Crush your everyday admin.',
    body: 'Use chat, small readable attachments, and links to turn bureaucracy into drafts: parking-ticket appeal letters, insurance-claim checklists, inbox summaries, and calendar-email wording. Your digital employee is a fully stateful secretary that remembers details you have already told it, while you review and submit anything official.',
  },
];

export function Personas() {
  return (
    <section id="personas" className="container-page py-20 md:py-28 border-t border-divider">
      <div className="max-w-narrow">
        <p className="eyebrow mb-4">Who it&apos;s for</p>
        <h2 className="text-[34px] md:text-[44px] leading-[1.1] tracking-[-0.015em] font-medium">
          Three audiences. <span className="brand-serif">One digital employee.</span>
        </h2>
        <p className="mt-5 text-body-lg text-ink-muted">
          The same private cloud workspace works whether you ship code, run a small business, or want to
          stop dreading your admin. Pick the angle that sounds like you.
        </p>
      </div>

      <div className="mt-14 grid md:grid-cols-3 gap-6">
        {PERSONAS.map((persona) => (
          <article
            key={persona.audience}
            className="bg-white rounded-card ring-1 ring-divider shadow-quiet p-7 md:p-8 flex flex-col gap-4"
          >
            <p className="eyebrow text-sage-deep">{persona.audience}</p>
            <h3 className="text-[20px] leading-[1.2] font-medium text-ink">{persona.headline}</h3>
            <p className="text-body text-ink-muted">{persona.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
