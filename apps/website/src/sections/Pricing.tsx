import type { CSSProperties } from 'react';
import {
  AGENT_PLAN,
  AGENT_PLAN_SUMMARY,
  AGENT_TOP_UP,
  agentFreeTrialTermsLine,
  agentPlanHighlights,
  formatAgentPlanPrice,
  formatTopUpPrice,
} from '@sidekick/shared';
import { Reveal, SplitWords } from '../motion/Reveal';
import { useInView, usePointerGlow, useProgress } from '../motion/hooks';

// One plan, from the same constants the app and the Worker use
// (packages/shared/src/content/agentEngine.ts): the price, the free month, the
// Talk minutes, the monthly allowance and top-ups. The highlights are the app's
// own "What you get" list, so the site cannot promise more than the product.
const HIGHLIGHTS = agentPlanHighlights();

export function Pricing() {
  const cardRef = useProgress<HTMLElement>('pass');
  const [listRef, listSeen] = useInView<HTMLUListElement>(0.15);
  const glowRef = usePointerGlow<HTMLDivElement>(2);
  return (
    <section id="pricing" className="relative overflow-hidden">
      <div className="container-page pt-28 pb-24 md:pt-32 md:pb-28">
        <div className="max-w-narrow">
          <Reveal>
            <p className="eyebrow mb-4">Pricing</p>
          </Reveal>
          <h2 className="section-title">
            <SplitWords text="One plan." />{' '}
            <SplitWords text="Free for a month." start={2} className="brand-serif text-sage" />
          </h2>
          <Reveal delay={2}>
            <p className="mt-6 text-body-lg text-ink-muted">
              Everything included, for one simple monthly price with no usage bills. Your first month is free, and you
              can cancel any time.
            </p>
          </Reveal>
        </div>

        <div className="mt-14 grid items-stretch gap-6 md:grid-cols-12">
          <Reveal effect="bloom" className="md:col-span-7">
            <div ref={glowRef} className="glow-card h-full rounded-card">
              {/* Outside the card, which clips its own glow, so the tag is not cut in half. */}
              <span className="absolute -top-3 left-7 z-10 rounded-pill bg-bg px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-sage-deep ring-1 ring-divider">
                First month free
              </span>
              <article
                ref={cardRef}
                className="shimmer-edge relative flex h-full flex-col overflow-hidden rounded-card bg-sage p-7 text-white shadow-lift md:p-9"
              >
                <div className="sheen pointer-events-none absolute inset-0" aria-hidden />
                <header className="relative mt-3">
                  <h3 className="text-title text-white">Delegent AI</h3>
                  <p className="mt-2 text-[13.5px] text-white/80">{AGENT_PLAN_SUMMARY}</p>
                </header>
                {/* The free month is the offer, so it takes the big type and the
                    price sits beside it. The full renewal terms stay directly
                    underneath, unchanged. */}
                <div className="relative mt-6 flex items-baseline gap-3">
                  <span className="brand-serif text-[72px] leading-none text-white md:text-[88px]">Free</span>
                  <span className="text-[14px] text-white/75">for a month, then {formatAgentPlanPrice()} / month</span>
                </div>
                <p className="relative mt-2 text-[13px] text-white/80">{agentFreeTrialTermsLine()}</p>

                <ul ref={listRef} className={`relative mt-7 flex-1 space-y-3 text-[14.5px] ${listSeen ? 'is-in' : ''}`}>
                  {HIGHLIGHTS.map((item, i) => (
                    <li key={item.lead} className="kid flex items-start gap-2.5" style={{ '--d': `${150 + i * 110}ms` } as CSSProperties}>
                      <Check delay={350 + i * 110} />
                      <span className="text-white/90">
                        <strong className="font-semibold text-white">{item.lead}</strong> {item.text}
                      </span>
                    </li>
                  ))}
                </ul>

                <a href="#cta" className="btn relative mt-8 bg-white text-sage-deep hover:bg-bg group">
                  Start your free month
                  <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">→</span>
                </a>
              </article>
            </div>
          </Reveal>

          <aside className="flex flex-col gap-4 md:col-span-5">
            {[
              {
                title: 'A generous monthly allowance',
                body: 'Enough for hundreds of requests a month. You can see what is left in the app under Manage plan. It refreshes at the start of each billing month.',
              },
              {
                title: `Top up from ${formatTopUpPrice()}`,
                body: `If you ever run out, buy a top-up in the app and carry on straight away. Top-ups are only used once your monthly allowance runs out, and they last ${AGENT_TOP_UP.validMonths} months.`,
              },
              {
                title: 'Hands-free Talk included',
                body: `${AGENT_PLAN.talkMinutesMonthly} minutes of voice conversation a month, or ${AGENT_PLAN.trialTalkMinutes} during your free month. Dictating a message with the mic does not count.`,
              },
            ].map((item, i) => (
              <Reveal key={item.title} effect="right" delay={1 + i}>
                <div className="rounded-card bg-white/80 p-6 shadow-quiet ring-1 ring-divider backdrop-blur-sm md:p-7">
                  <h3 className="text-title">{item.title}</h3>
                  <p className="mt-2 text-body text-ink-muted">{item.body}</p>
                </div>
              </Reveal>
            ))}
          </aside>
        </div>

        <Reveal>
          <p className="mx-auto mt-10 max-w-narrow text-center text-[13px] text-ink-muted">
            Prices in GBP, billed monthly in advance. Cancel any time from your profile in the app, and you keep your access
            until the end of the month you have paid for. The free month comes with a smaller allowance. Plans and top-ups
            are not refundable except where the law requires; your UK statutory rights are unaffected.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function Check({ delay }: { delay: number }) {
  return (
    <span
      className="mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full bg-white/15 text-white"
      aria-hidden
    >
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" className="draw" style={{ '--d': `${delay}ms` } as CSSProperties}>
        <path d="M2.5 6.5L5 9l4.5-5.5" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
      </svg>
    </span>
  );
}
