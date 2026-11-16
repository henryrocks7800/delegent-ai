interface UseCase {
  who: string;
  task: string;
  brief: string;
  result: string;
}

// Each `brief` and `result` is a tuple of parts so we can highlight the
// operative verbs/nouns inline without resorting to dangerouslySetInnerHTML.
type Segment = { text: string; bold?: boolean };

interface RichCase extends Omit<UseCase, 'brief' | 'result'> {
  // `category` is the canonical use-case bucket the card maps to. The
  // mobile app keeps the master list as `useCaseLines` in App.tsx; each
  // website card maps 1:1 to one of those lines so the public-facing
  // surface stays aligned with the in-app menu.
  category: string;
  brief: Segment[];
  result: Segment[];
}

const CASES: RichCase[] = [
  // 1 — Autonomous bookkeeping
  {
    category: 'Autonomous bookkeeping',
    who: 'A sole-trader bookkeeper',
    task: 'When receipts arrive',
    brief: [
      { text: '“I’ve pasted receipt lines and a bank export, ' },
      { text: 'draft the reconciliation notes', bold: true },
      { text: ', group the spend, and ' },
      { text: 'flag anything I should look at before my accountant does', bold: true },
      { text: '.”' },
    ],
    result: [
      { text: 'A review-ready pack lands in Files. You decide what gets filed, synced, or sent to your accountant.' },
    ],
  },
  // 2 — Digital secretary
  {
    category: 'Digital secretary',
    who: 'A solo founder',
    task: 'When inbox triage starts',
    brief: [
      { text: '“' },
      { text: 'Summarise', bold: true },
      { text: ' the customer emails I pasted, ' },
      { text: 'flag the angry ones', bold: true },
      { text: ', and ' },
      { text: 'draft three polite replies', bold: true },
      { text: '.”' },
    ],
    result: [
      { text: 'Five-line summary plus reply drafts saved for review. Nothing is sent or starred without you.' },
    ],
  },
  // 3 — Forms and bureaucracy
  {
    category: 'Forms and bureaucracy',
    who: 'A busy parent',
    task: 'When the paperwork lands',
    brief: [
      { text: '“Here’s a school form, ' },
      { text: 'draft the standard bits', bold: true },
      { text: ', flag what needs my signature, and ' },
      { text: 'list the deadlines I need to add', bold: true },
      { text: '.”' },
    ],
    result: [
      { text: 'Completed draft and deadline checklist in Files. You handle signatures and official submission.' },
    ],
  },
  // 4 — E-commerce monitor
  {
    category: 'E-commerce monitor',
    who: 'A small e-commerce owner',
    task: 'After an export',
    brief: [
      { text: '“' },
      { text: 'Compare today’s order export', bold: true },
      { text: ' with the tracking statuses I uploaded; ' },
      { text: 'flag anything stuck', bold: true },
      { text: ' for more than 24 hours.”' },
    ],
    result: [
      { text: 'Exception list in Files, with reorder or customer-update drafts ready for your review.' },
    ],
  },
  // 5 — Chasing drafts
  {
    category: 'Chasing drafts',
    who: 'A freelancer chasing invoices',
    task: 'When invoices need a nudge',
    brief: [
      { text: '“Look at the invoices I sent last month, ' },
      { text: 'chase the unpaid ones', bold: true },
      { text: ' with my standard polite-then-firmer escalation.”' },
    ],
    result: [
      { text: 'Polite-to-firmer drafts are ready in your tone. You stay in the loop and choose when to send.' },
    ],
  },
  // 6 — Meeting actions
  {
    category: 'Meeting actions',
    who: 'A part-time consultant',
    task: 'Before client calls',
    brief: [
      { text: '“Pull the last three meetings’ notes, ' },
      { text: 'write a one-page brief', bold: true },
      { text: ' I can read on the train.”' },
    ],
    result: [
      { text: 'A one-page brief is saved in Files when you ask, ready to read before the call.' },
    ],
  },
  // 7 — Quick research
  {
    category: 'Quick research',
    who: 'A first-time author',
    task: 'During research week',
    brief: [
      { text: '“' },
      { text: 'Read these notes and source links', bold: true },
      { text: ' and ' },
      { text: 'pull the three strongest quotes', bold: true },
      { text: ' on supply-chain resilience, with page numbers.”' },
    ],
    result: [
      { text: 'Quotes with citations land in your “Research” folder, ready to footnote.' },
    ],
  },
  // 8 — Repeatable workflows
  {
    category: 'Repeatable workflows',
    who: 'A landlord',
    task: 'Repeatable recipe',
    brief: [
      { text: '“When I paste receipt details, ' },
      { text: 'name the file and update the expense sheet draft', bold: true },
      { text: ' for that property.”' },
    ],
    result: [
      { text: 'A saved checklist and draft sheet are ready to reuse, with every update visible in Files.' },
    ],
  },
  // 9 — Drafts and edits in your tone
  {
    category: 'Drafts in your tone',
    who: 'A landlady',
    task: 'Whenever a tenant gets in touch',
    brief: [
      { text: '“When tenants ask about the boiler, ' },
      { text: 'draft the manual link and the engineer’s number', bold: true },
      { text: ', same tone every time.”' },
    ],
    result: [
      { text: 'A consistent reply draft appears in chat and Files, ready for you to send.' },
    ],
  },
  // 10 — Small business PA
  {
    category: 'A small business PA',
    who: 'A consulting solo',
    task: 'Before invoicing',
    brief: [
      { text: '“' },
      { text: 'Pull my hours from the timesheet', bold: true },
      { text: ', match them to projects, ' },
      { text: 'draft the invoice', bold: true },
      { text: ' in my usual template.”' },
    ],
    result: [
      { text: 'Draft invoice saved for review. You copy it into your billing tool and send it.' },
    ],
  },
];

export function UseCases() {
  return (
    <section id="use-cases" className="container-page pt-28 pb-24 md:pt-32 md:pb-28">
      <div className="max-w-narrow">
        <p className="eyebrow mb-4">Use cases</p>
        <h2 className="text-[34px] md:text-[44px] leading-[1.1] tracking-[-0.015em] font-medium">
          The <span className="brand-serif">small stuff</span> that quietly eats your week.
        </h2>
        <p className="mt-5 text-body-lg text-ink-muted">
          Delegent is built for the admin you keep putting off, the chasing, the filing, the drafts you already
          know how to write but never get to. Teach your digital employee the pattern once; next time they reuse it with
          the new inputs.
        </p>
      </div>

      <div className="mt-14 grid md:grid-cols-2 gap-6 md:gap-8">
        {CASES.map((c) => (
          <article key={c.who} className="rounded-card bg-white ring-1 ring-divider p-7 md:p-8 shadow-quiet">
            <header className="flex items-center justify-between gap-3">
              <p className="font-mono text-[11px] tracking-[0.14em] uppercase text-ink-muted">{c.who}</p>
              <p className="text-[12.5px] text-sage-deep bg-sage-soft rounded-pill px-2.5 py-0.5 whitespace-nowrap">
                {c.task}
              </p>
            </header>
            <p className="mt-2 text-[12.5px] tracking-[0.04em] text-sage-deep/80 font-medium">{c.category}</p>
            <p className="mt-4 text-[17px] md:text-[18px] leading-[1.45] text-ink">
              <span className="text-ink-faint mr-1.5 font-mono text-[11px] tracking-[0.14em] uppercase align-middle">
                Brief
              </span>
              <span className="italic">
                {c.brief.map((seg, i) =>
                  seg.bold ? (
                    <strong key={i} className="font-medium not-italic text-sage-deep">
                      {seg.text}
                    </strong>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  ),
                )}
              </span>
            </p>
            <p className="mt-4 text-[15px] text-ink-muted leading-[1.55]">
              <span className="text-sage font-medium">→</span>{' '}
              {c.result.map((seg, i) =>
                seg.bold ? (
                  <strong key={i} className="font-medium text-ink">
                    {seg.text}
                  </strong>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
