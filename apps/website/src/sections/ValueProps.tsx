import type { CSSProperties, ReactNode } from 'react';
import { Reveal, SplitWords } from '../motion/Reveal';
import { useInView, usePointerGlow, useProgress } from '../motion/hooks';

// What it does, as a bento grid. Each card carries a small live illustration
// that plays once as it scrolls into view. The words are unchanged from the
// previous design; the illustrations only ever show jobs the app does today.

const d = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties;

export function ValueProps() {
  const bloomRef = useProgress<HTMLDivElement>('enter');
  return (
    <section className="relative overflow-hidden">
      <div ref={bloomRef} className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="bloom" style={{ left: '15%', top: '12%', width: '70vmax', height: '70vmax' }} />
      </div>
      <div className="container-page relative py-24 md:py-32">
        <div className="max-w-narrow">
          <Reveal>
            <p className="eyebrow mb-4">What it does</p>
          </Reveal>
          <h2 className="section-title">
            <SplitWords text="A coworker that gets things done," className="brand-serif" />{' '}
            <SplitWords text="not just a chat window." start={5} />
          </h2>
          <Reveal delay={3}>
            <p className="mt-6 text-body-lg text-ink-muted">
              Ask in plain English, in the in-app chat or out loud. It works in the apps you connect, uses built-in
              tools for travel and the web, and comes back with the answer, the draft or the document.
            </p>
          </Reveal>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-3 md:gap-5">
          <Card
            className="md:col-span-2"
            delay={0}
            title="Your inbox, handled"
            body="Reads and sorts your Gmail or Outlook, tells you what needs you, and drafts replies in your tone for you to review and send."
            art={<InboxArt />}
          />
          <Card
            delay={1}
            title="Travel, sorted"
            body="Finds and compares flights, hotels and things to do for your dates, with prices and links to book. You always make the booking."
            art={<TravelArt />}
          />
          <Card
            delay={0}
            title="Documents in seconds"
            body="Invoices, quotes, letters and itineraries as polished PDFs, and it reads the PDFs, receipts and photos you send it."
            art={<DocArt />}
          />
          <Card
            delay={1}
            title="Answers from the live web"
            body="Search, news, the weather, local businesses and price checks, with the sources, so you are not relying on guesswork."
            art={<WebArt />}
          />
          <Card
            delay={2}
            title="The boring jobs, done"
            body="Complaint letters, refund requests, a plumber with good reviews, the best price on a new chair. Ask once and get the time back."
            art={<ChecklistArt />}
          />
          <Card
            className="md:col-span-3"
            wide
            delay={0}
            title="Remembers you, asks first"
            body="It remembers your name, your people and how you like things done, and anything that sends, posts or spends comes back for your yes."
            art={<MemoryArt />}
          />
        </div>
      </div>
    </section>
  );
}

function Card({
  title,
  body,
  art,
  className = '',
  delay,
  wide = false,
}: {
  title: string;
  body: string;
  art: ReactNode;
  className?: string;
  delay: number;
  wide?: boolean;
}) {
  const [viewRef, seen] = useInView<HTMLDivElement>(0.25);
  const glowRef = usePointerGlow<HTMLElement>(4);
  return (
    <div ref={viewRef} className={`fx fx-rise ${seen ? 'is-in' : ''} ${className}`} style={{ '--d': `${delay * 90}ms` } as CSSProperties}>
      <article
        ref={glowRef}
        className={`glow-card h-full overflow-hidden rounded-[28px] bg-white/80 p-6 ring-1 ring-divider shadow-quiet backdrop-blur-sm md:p-8 ${
          wide ? 'grid items-center gap-8 md:grid-cols-2' : 'flex flex-col'
        }`}
      >
        <div className={wide ? '' : 'order-2 mt-6'}>
          <h3 className="text-[21px] font-medium tracking-[-0.01em]">{title}</h3>
          <p className="mt-2 text-body text-ink-muted">{body}</p>
        </div>
        <div className={`${seen ? 'is-in' : ''} ${wide ? '' : 'order-1'}`} aria-hidden>
          {art}
        </div>
      </article>
    </div>
  );
}

function InboxArt() {
  const mails = [
    { from: 'Sarah (client)', subject: 'Can you do Thursday instead?', tag: 'Needs you', hot: true },
    { from: 'Your bank', subject: 'Your statement is ready', tag: 'Sorted' },
    { from: 'Landlord', subject: 'Boiler engineer booked', tag: 'Needs you', hot: true },
    { from: 'Newsletter', subject: 'This week in design', tag: 'Sorted' },
  ];
  return (
    <div className="rounded-2xl bg-bg p-3 ring-1 ring-divider">
      {mails.map((m, i) => (
        <div key={m.subject} className="kid flex items-center gap-3 rounded-xl px-2 py-2" style={d(150 + i * 140)}>
          <span className={`h-2 w-2 flex-none rounded-full ${m.hot ? 'bg-sage' : 'bg-divider'}`} />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px] font-medium">{m.from}</span>
            <span className="block truncate text-[12px] text-ink-muted">{m.subject}</span>
          </span>
          <span
            className={`kid flex-none rounded-pill px-2 py-0.5 text-[10.5px] font-medium ${
              m.hot ? 'bg-sage text-white' : 'bg-sage-soft text-sage-deep'
            }`}
            style={d(800 + i * 160)}
          >
            {m.tag}
          </span>
        </div>
      ))}
      <div className="kid mt-2 rounded-xl bg-white px-3 py-2 text-[12px] text-ink ring-1 ring-divider" style={d(1500)}>
        <span className="font-mono text-[10px] text-sage">DRAFT</span> Thursday works well, see you at 10.
      </div>
    </div>
  );
}

function TravelArt() {
  const options = [
    { label: 'Direct, 07:10', price: '£84', w: '62%' },
    { label: 'Direct, 12:45', price: '£97', w: '72%' },
    { label: '1 stop, 09:30', price: '£112', w: '84%' },
  ];
  return (
    <div className="rounded-2xl bg-bg p-4 ring-1 ring-divider">
      <div className="kid flex items-center justify-between text-[13px] font-medium" style={d(100)}>
        <span>LHR</span>
        <span className="relative mx-3 h-px flex-1 bg-divider">
          <span className="grow-x absolute inset-0 bg-sage" style={d(300)} />
          <span className="absolute -top-2 right-0 text-[13px]">✈</span>
        </span>
        <span>LIS</span>
      </div>
      <div className="mt-4 space-y-2.5">
        {options.map((o, i) => (
          <div key={o.label} className="kid" style={d(500 + i * 150)}>
            <div className="flex justify-between text-[11.5px] text-ink-muted">
              <span>{o.label}</span>
              <span className="font-medium text-ink">{o.price}</span>
            </div>
            <div className="mt-1 h-1.5 rounded-full bg-divider/70">
              <div className="grow-x h-full rounded-full bg-sage/70" style={{ width: o.w, ...d(650 + i * 150) }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DocArt() {
  return (
    <div className="relative mx-auto h-[170px] w-[140px]">
      <div className="kid absolute inset-0 rounded-xl bg-white p-3 shadow-lift ring-1 ring-divider" style={d(100)}>
        <div className="flex items-center justify-between">
          <span className="brand-serif text-[13px]">Invoice</span>
          <span className="font-mono text-[8px] text-ink-faint">INV-0042</span>
        </div>
        <div className="mt-3 space-y-1.5">
          {[70, 88, 54, 80, 40].map((w, i) => (
            <div key={i} className="grow-x h-1.5 rounded-full bg-divider" style={{ width: `${w}%`, ...d(300 + i * 120) }} />
          ))}
        </div>
        <div className="mt-4 flex justify-between border-t border-divider pt-2 text-[10px]">
          <span className="text-ink-muted">Total</span>
          <span className="kid font-medium" style={d(1000)}>£480.00</span>
        </div>
      </div>
      <span className="pop-in absolute -right-4 -top-3 rounded-pill bg-sage px-2 py-1 text-[10px] font-medium text-white shadow-lift" style={d(1300)}>
        PDF ready
      </span>
    </div>
  );
}

function WebArt() {
  return (
    <div className="rounded-2xl bg-bg p-3 ring-1 ring-divider">
      <div className="kid flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-[12px] ring-1 ring-divider" style={d(100)}>
        <span>🔎</span>
        <span className="typing-in">Boiler repair near me, good reviews</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {['4.9 ★ 212 reviews', 'Open today', 'Source: reviews site', 'Source: the council'].map((chip, i) => (
          <span key={chip} className="pop-in rounded-pill bg-white px-2.5 py-1 text-[11px] text-ink-muted ring-1 ring-divider" style={d(700 + i * 150)}>
            {chip}
          </span>
        ))}
      </div>
    </div>
  );
}

function ChecklistArt() {
  const jobs = ['Refund request to the airline', 'Letter to the council', 'Cheapest price on the chair'];
  return (
    <div className="space-y-2">
      {jobs.map((job, i) => (
        <div key={job} className="kid flex items-center gap-3 rounded-xl bg-bg px-3 py-2.5 ring-1 ring-divider" style={d(150 + i * 180)}>
          <span className="flex h-5 w-5 flex-none items-center justify-center rounded-md bg-sage text-white">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" className="draw" style={d(400 + i * 220)}>
              <path d="M2.5 6.5L5 9l4.5-5.5" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
            </svg>
          </span>
          <span className="text-[13px]">{job}</span>
        </div>
      ))}
    </div>
  );
}

function MemoryArt() {
  const facts = ['Signs off “Best, Sam”', 'Prefers a window seat', 'Partner: Jo', 'Accountant: Priya'];
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-wrap content-start gap-2">
        {facts.map((fact, i) => (
          <span key={fact} className="pop-in rounded-pill bg-sage-soft px-3 py-1.5 text-[12px] text-sage-deep" style={d(150 + i * 140)}>
            🌿 {fact}
          </span>
        ))}
      </div>
      <div className="kid rounded-2xl bg-bg p-4 ring-1 ring-divider" style={d(700)}>
        <p className="text-[12.5px] text-ink">Send this email to Sarah?</p>
        <p className="mt-1 text-[11.5px] text-ink-muted">“Thursday works well, see you at 10.”</p>
        <div className="mt-3 flex gap-2">
          <span className="rounded-pill bg-sage px-3 py-1 text-[11.5px] font-medium text-white shadow-quiet">Yes, send</span>
          <span className="rounded-pill bg-white px-3 py-1 text-[11.5px] text-ink-muted ring-1 ring-divider">Not yet</span>
        </div>
      </div>
    </div>
  );
}
