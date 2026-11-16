import { AGENT_FAQ_ORDERED, supportedDevicesSentence } from '@sidekick/shared';
import { useState, type CSSProperties } from 'react';
import { Reveal, SplitWords } from '../motion/Reveal';
import { useInView } from '../motion/hooks';
import { WEB_APP_DISPLAY_URL } from '../components/webAppLink';
import { MODEL_CLAIM_FAQ } from '../content/modelClaim';

interface QA {
  q: string;
  a: string;
}

// The app's own FAQ for the coworker plan (AGENT_FAQ_ORDERED), so the site and
// the product give the same answers. Three questions are the website's own:
// connecting apps (worded for someone who has not installed it yet), devices,
// and who runs the company. The app's email and support answers point at its
// menus, which a visitor does not have yet, so those two are left out here.
const APP_ONLY = new Set(['Can it use my email?', 'Something not working, or want a new feature?']);

const CONNECTING: QA = {
  q: 'Can my coworker use my email or other services?',
  a: "Yes. Open Connections in the app to connect supported services, such as Gmail, Outlook, Google Calendar, Drive, Slack, Notion or QuickBooks, then sign in and approve access on the provider's own website. Your coworker can work with the access you grant, and anything that sends, posts or spends comes back to you first. It cannot create accounts or complete identity checks for you, and you can disconnect any app at any time.",
};

const FAQS: QA[] = [
  ...AGENT_FAQ_ORDERED.filter((item) => !APP_ONLY.has(item.question)).map((item) => ({ q: item.question, a: item.answer })),
  CONNECTING,
  {
    q: 'What AI powers my assistant?',
    a: MODEL_CLAIM_FAQ,
  },
  {
    q: 'Which devices can I use it on?',
    a: supportedDevicesSentence(WEB_APP_DISPLAY_URL, { assistant: true }),
  },
  {
    q: 'Who runs Delegent AI, and how do I make a complaint?',
    a: 'Delegent AI is operated by Delegent AI, registered in England and Wales. For help, write to support@example.com; for privacy and data questions, admin@example.com. If you are unhappy with how we handle your data, you can also raise it with the UK data protection regulator (the ICO).',
  },
];

export function FAQ() {
  return (
    <section id="faq" className="container-page py-24 md:py-32">
      <div className="grid md:grid-cols-12 gap-10 md:gap-16 items-start">
        <div className="md:col-span-4 md:sticky md:top-28 self-start">
          <Reveal>
            <p className="eyebrow mb-4">FAQ</p>
          </Reveal>
          <h2 className="section-title">
            <SplitWords text="The" />{' '}
            <SplitWords text="honest answers." start={1} className="brand-serif text-sage" />
          </h2>
          <Reveal delay={2}>
            <p className="mt-6 text-body text-ink-muted max-w-prose">
              Built by a small team. Quiet support, write to{' '}
              <a href="mailto:support@example.com" className="underline decoration-divider underline-offset-4 hover:text-ink">
                support@example.com
              </a>{' '}
              if you don&apos;t see your question here.
            </p>
          </Reveal>
        </div>
        <ul className="md:col-span-8 divide-y divide-divider">
          {FAQS.map((qa, i) => (
            <FaqItem key={qa.q} qa={qa} index={i} defaultOpen={i === 0} />
          ))}
        </ul>
      </div>
    </section>
  );
}

function FaqItem({ qa, index, defaultOpen }: { qa: QA; index: number; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [ref, seen] = useInView<HTMLLIElement>(0.1);
  return (
    <li
      ref={ref}
      className={`fx fx-rise ${seen ? 'is-in' : ''}`}
      style={{ '--d': `${Math.min(index, 6) * 50}ms` } as CSSProperties}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-6 py-6 text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-sage focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-md"
        aria-expanded={open}
      >
        <span className={`text-[17px] md:text-[19px] font-medium leading-snug transition-colors duration-300 ${open ? 'text-sage-deep' : 'text-ink group-hover:text-sage-deep'}`}>
          {qa.q}
        </span>
        <span
          className={`flex-none h-8 w-8 rounded-full flex items-center justify-center transition-all duration-500 ease-quiet ${
            open ? 'rotate-45 bg-sage text-white' : 'bg-sage-soft text-sage-deep group-hover:scale-110'
          }`}
          aria-hidden
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-500 ease-quiet ${
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="overflow-hidden">
          <p className="text-body text-ink-muted leading-[1.7] pb-6 pr-10">{qa.a}</p>
        </div>
      </div>
    </li>
  );
}
