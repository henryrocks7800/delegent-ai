// Front-of-mind flagship use case: Autonomous Bookkeeper.
//
// Sourced from docs/tmp/hermes_agent_optimized_copy_v2.md §2 'Front-of-Mind
// Anchor: The Autonomous Bookkeeper'.
//
// Safety rewrites applied vs the source document:
//   - 'Fort Knox-secure' -> 'secure private cloud workspace' (the
//     source phrasing risks an exaggerated-security claim).
//   - Xero / QuickBooks are framed as 'connect the accounting tool you
//     already use', not 'Hermes autonomously logs into your accounting
//     suite'. We do not claim a live, pre-built integration with either
//     vendor; the user provides the API access.
//   - 'Saves thousands in accounting overhead' -> directional 'saves a
//     meaningful slice of accounting fees' (no specific currency claim).
//   - receipt upload via the chat paperclip is LIVE (2026-06-06): attached
//     files (photos/PDFs/files) reach the agent workspace under uploads/ and the
//     agent reads them (verified end to end). Copy reflects that. Ledger posting
//     + filing still stay behind explicit human approval (review-ready drafts).
//   - 'Runs a full-scale digital accounting digital employee' -> 'runs an
//     autonomous bookkeeping digital employee' (less hype, accurate).
//
// Placement: between Origin and HowItWorks on the homepage. The
// front-of-mind position is intentional per the source brief.

export function BookkeeperFlagship() {
  return (
    <section id="bookkeeper" className="container-page py-20 md:py-28">
      <div className="grid md:grid-cols-12 gap-10 md:gap-16">
        <div className="md:col-span-5">
          <p className="eyebrow mb-4">Flagship use case</p>
          <h2 className="text-[34px] md:text-[44px] leading-[1.1] tracking-[-0.015em] font-medium">
            Your <span className="brand-serif">autonomous bookkeeper</span>, working in the background.
          </h2>
          <p className="mt-5 text-body-lg text-ink-muted max-w-prose">
            Bookkeeping is a tedious, expensive drain on your week. We built the workspace that
            makes most of it disappear.
          </p>
        </div>

        <div className="md:col-span-7 space-y-8">
          <div>
            <p className="eyebrow text-sage-deep mb-2">The problem</p>
            <p className="text-body text-ink">
              Receipts pile up in a drawer, your camera roll and your inbox. Someone sorts them on a Sunday,
              or an accountant charges a monthly fee to do the same.
            </p>
          </div>

          <div>
            <p className="eyebrow text-sage-deep mb-2">How Delegent fixes it</p>
            <p className="text-body text-ink">
              Brief your digital employee in chat and attach receipts with the paperclip, or paste the details.
              It keeps organised outputs in its private workspace, visible from Files, and drafts reconciliation
              notes for you or your accountant to review.
            </p>
          </div>

          <div>
            <p className="eyebrow text-sage-deep mb-2">The bottom line</p>
            <p className="text-body text-ink">
              It runs everything up to the final approval step. You save hours and a meaningful slice of
              accounting fees, with a private bookkeeper ready when you need it, for a predictable monthly
              subscription.
            </p>
          </div>

          <ul className="pt-2 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-[14px] text-ink-muted">
            <li className="flex items-start gap-2"><Tick /> Attach receipts (photos, PDFs) from your phone</li>
            <li className="flex items-start gap-2"><Tick /> Review-ready reconciliation drafts</li>
            <li className="flex items-start gap-2"><Tick /> Monthly review pack prepared</li>
            <li className="flex items-start gap-2"><Tick /> Final filing stays with you</li>
          </ul>

          <p className="text-[12.5px] text-ink-faint max-w-prose">
            Your digital employee never presses &quot;file with HMRC&quot; on your behalf. It prepares the pack;
            you (or your accountant) approve and submit. Delegent AI is a software platform, not a
            firm of qualified accountants.
          </p>
        </div>
      </div>
    </section>
  );
}

function Tick() {
  return (
    <span className="mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full bg-sage-soft text-sage-deep" aria-hidden>
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M2.5 6.5L5 9l4.5-5.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
