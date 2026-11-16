import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useCountUp, useProgress } from '../motion/hooks';
import { AskScreen, ConnectScreen, ReadScreen, ReportScreen } from './moneyStoryScreens';

// Money Finder, told by scrolling. The phone stays pinned while the page moves
// underneath it, and each quarter of the section is one step of the real
// journey: connect an inbox, ask, it reads, the report lands.
//
// HONESTY RULES FOR THIS SECTION (same as the adverts, 2026-09-26):
//   - The report lines are the words the app really produced for one inbox in
//     September 2026. The flight is "worth up to", per passenger, because
//     British Airways has not paid yet; the claim is lodged.
//   - The three refunds are real Google Play refunds, issued the same day.
//   - The small print says it is one inbox and that results vary.
// The phone screens (moneyStoryScreens.tsx) are drawn in HTML in the app's own
// colours, not a screenshot, so they stay sharp at every size.

// `short` is what a phone shows: the phone mock needs the height more than the
// longer sentence does, and the long version is still there on bigger screens.
const STEPS = [
  {
    key: 'connect',
    label: 'Connect',
    title: 'Connect your email.',
    body: 'Sign in to Gmail or Outlook on Google’s or Microsoft’s own page. Money Finder only reads: nothing is sent, moved or deleted.',
    short: 'Sign in to Gmail or Outlook on their own page. Money Finder only reads.',
  },
  {
    key: 'ask',
    label: 'Ask',
    title: 'Just ask.',
    body: 'Type or say “find money I might be owed in my inbox”. That is the whole instruction.',
    short: 'Say “find money I might be owed in my inbox”. That is all.',
  },
  {
    key: 'read',
    label: 'It reads',
    title: 'It joins the dots.',
    body: 'It reads the emails that look relevant, never spam, drafts or sent mail, and checks them against the rules for cancelled flights, refunds that never came and double charges.',
    short: 'It checks the likely emails for cancelled flights, missing refunds and double charges.',
  },
  {
    key: 'report',
    label: 'The report',
    title: 'The report lands.',
    body: 'Within about 15 minutes: what you may be owed, the subscriptions you pay for, and an offer to draft the claim for you.',
    short: 'Within about 15 minutes: what you may be owed, and an offer to draft the claim.',
  },
] as const;

export function MoneyStory() {
  const [step, setStep] = useState(0);
  const lastStep = useRef(0);
  const onProgress = useCallback((p: number) => {
    const next = Math.min(STEPS.length - 1, Math.floor(p * STEPS.length * 0.999));
    if (next !== lastStep.current) {
      lastStep.current = next;
      setStep(next);
    }
  }, []);
  const sectionRef = useProgress<HTMLElement>('sticky', onProgress);

  const checked = useCountUp(255, step >= 2, 1800);
  const found = useCountUp(440, step >= 3, 1600);

  const goTo = (i: number) => {
    const el = sectionRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const travel = el.offsetHeight - window.innerHeight;
    window.scrollTo({ top: top + travel * ((i + 0.35) / STEPS.length), behavior: 'smooth' });
  };

  return (
    <section ref={sectionRef} id="money" className="relative" style={{ height: '400svh' }} aria-labelledby="money-title">
      <div className="sticky top-0 h-[100svh] overflow-hidden">
        <div className="bloom" style={{ left: '72%', top: '52%', width: '90vmax', height: '90vmax' } as CSSProperties} aria-hidden />
        <div className="bloom bloom-warm" style={{ left: '12%', top: '20%', width: '60vmax', height: '60vmax' } as CSSProperties} aria-hidden />

        <div className="container-page relative flex h-full flex-col justify-center gap-4 pt-16 pb-4 md:grid md:grid-cols-12 md:items-center md:gap-10 md:pt-16 md:pb-0">
          {/* Words */}
          <div className="md:col-span-6 lg:col-span-5">
            <p className="eyebrow mb-3 md:mb-5">Money Finder</p>
            <h2 id="money-title" className="sr-only">
              Money Finder: find money you may be owed in your inbox
            </h2>

            <ol className="mb-4 flex gap-1.5 md:mb-8" aria-label="Steps">
              {STEPS.map((s, i) => (
                <li key={s.key} className="flex-1">
                  <button
                    type="button"
                    onClick={() => goTo(i)}
                    className="group w-full text-left focus:outline-none"
                    aria-current={i === step ? 'step' : undefined}
                  >
                    <span className="block h-[3px] overflow-hidden rounded-full bg-divider">
                      <span
                        className="block h-full origin-left rounded-full bg-sage transition-transform duration-700 ease-quiet"
                        style={{ transform: `scaleX(${i <= step ? 1 : 0})` }}
                      />
                    </span>
                    <span
                      className={`mt-2 hidden text-[12px] transition-colors duration-500 sm:block ${
                        i === step ? 'text-ink' : 'text-ink-faint group-hover:text-ink-muted'
                      }`}
                    >
                      {s.label}
                    </span>
                  </button>
                </li>
              ))}
            </ol>

            {/* All four sit in the same grid cell, so the block is always as tall
                as the longest step and can never spill over the phone. */}
            <div className="grid">
              {STEPS.map((s, i) => (
                <div key={s.key} className={`story-copy [grid-area:1/1] ${i === step ? '' : 'off'}`}>
                  <p className="font-mono text-[11px] tracking-[0.16em] text-sage">{`0${i + 1} / 0${STEPS.length}`}</p>
                  <h3 className="mt-1.5 text-[27px] leading-[1.05] tracking-[-0.02em] font-medium md:mt-2 md:text-[52px]">
                    <span className="brand-serif">{s.title}</span>
                  </h3>
                  <p className="mt-2 max-w-[46ch] text-[14px] leading-relaxed text-ink-muted md:mt-5 md:text-body-lg">
                    <span className="md:hidden">{s.short}</span>
                    <span className="hidden md:inline">{s.body}</span>
                  </p>
                  {s.key === 'report' ? (
                    <p className="mt-2 inline-flex items-baseline gap-2 rounded-pill bg-sage px-3 py-1 text-white md:hidden">
                      <span className="text-[11px] uppercase tracking-[0.12em] text-white/75">Worth up to</span>
                      <span className="brand-serif text-[22px] leading-none">£{Math.round(found)}</span>
                      <span className="text-[11px] text-white/80">for two</span>
                    </p>
                  ) : null}
                  {s.key === 'report' ? (
                    <div className="mt-5 hidden rounded-2xl bg-white/80 p-4 shadow-quiet ring-1 ring-divider backdrop-blur md:block">
                      <p className="text-[14.5px] leading-relaxed text-ink">
                        <span className="font-medium">Our first test:</span> a British Airways flight cancelled in 2021, worth
                        up to <span className="font-medium text-sage-deep">£440</span> for two passengers and never claimed.
                        And three double charges, refunded the same day.
                      </p>
                      <p className="mt-2 text-[11.5px] text-ink-faint">
                        Real report from one inbox, September 2026. The flight claim is lodged, not yet paid. Results vary.
                      </p>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          {/* Phone */}
          <div className="relative flex justify-center md:col-span-6 lg:col-span-7" aria-hidden>
            <Phone
              badge={
                // The number, arriving beside the phone on the last step (bigger screens; phones get it in the words)
                <div className={`pointer-events-none absolute left-[88%] top-[14%] hidden md:block ${step === 3 ? 'on' : ''}`}>
                  <div className="pop-in rounded-3xl bg-sage px-6 py-4 text-white shadow-lift" style={{ '--d': '900ms' } as CSSProperties}>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-white/75">Worth up to</p>
                    <p className="brand-serif text-[64px] leading-none">£{Math.round(found)}</p>
                    <p className="mt-1 text-[12px] text-white/80">for two passengers</p>
                  </div>
                </div>
              }
            >
              <Screen on={step === 0}>
                <ConnectScreen />
              </Screen>
              <Screen on={step === 1}>
                <AskScreen on={step === 1} />
              </Screen>
              <Screen on={step === 2}>
                <ReadScreen checked={Math.round(checked)} />
              </Screen>
              <Screen on={step === 3}>
                <ReportScreen />
              </Screen>
            </Phone>
          </div>

          {/* Phones get the proof and the small print under the phone */}
          <p className={`text-center text-[11px] leading-snug text-ink-faint transition-opacity duration-500 md:hidden ${step === 3 ? 'opacity-100' : 'opacity-0'}`}>
            Real report from one inbox, Sept 2026. Flight claim lodged, not yet paid. Results vary.
          </p>
        </div>
      </div>
    </section>
  );
}

// The phone is drawn at one fixed size (PHONE_W x PHONE_H) and scaled to fit
// the space, so the screen inside looks the same on a phone and on a big
// monitor instead of its text staying tiny while the frame grows.
const PHONE_W = 300;
const PHONE_H = 624;

function Phone({ children, badge }: { children: ReactNode; badge?: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.8);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => setScale(box.clientHeight / PHONE_H);
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={boxRef} className="relative h-[min(58svh,560px)] md:h-[min(80vh,720px)]" style={{ aspectRatio: `${PHONE_W} / ${PHONE_H}` }}>
      <div className="absolute left-0 top-0 origin-top-left" style={{ width: PHONE_W, height: PHONE_H, transform: `scale(${scale})` }}>
        <div className="absolute inset-0 rounded-[46px] bg-ink p-[10px] shadow-[0_60px_120px_-50px_rgba(14,14,12,0.6)] ring-1 ring-black/10">
          <div className="relative h-full w-full overflow-hidden rounded-[37px] bg-[#F4F2EC]">
            <div className="absolute left-1/2 top-2.5 z-20 h-[22px] w-[34%] -translate-x-1/2 rounded-full bg-ink" />
            {children}
          </div>
        </div>
      </div>
      {badge}
    </div>
  );
}

function Screen({ on, children }: { on: boolean; children: ReactNode }) {
  return <div className={`story-screen ${on ? 'on' : ''}`}>{children}</div>;
}

