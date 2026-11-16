import { useEffect, type CSSProperties } from 'react';
import { AGENT_PLAN, agentConnectableServices, formatAgentPlanPrice, platformAvailabilityLine } from '@sidekick/shared';
import { StoreButtons } from '../components/StoreButtons';
import { MODEL_CLAIM_SHORT } from '../content/modelClaim';
import { SplitWords } from '../motion/Reveal';
import { useProgress } from '../motion/hooks';
import { hasFinePointer, prefersReducedMotion } from '../motion/scroll';

const PLAY_STORE_LISTING = 'https://play.google.com/store/apps/details?id=com.sidekick.v2';
const APP_COUNT = agentConnectableServices().length;

// The little result cards that float round the phone. Each one is something the
// app genuinely does, worded the way the app words it; depth sets how far it
// drifts with the pointer and the scroll, so they separate into layers.
const CHIPS: Array<{ icon: string; title: string; detail: string; pos: string; z: string; sy: string; fd: string }> = [
  { icon: '\u{1F4B7}', title: 'Money you may be owed', detail: 'A cancelled flight, worth up to £220', pos: 'left-[-8%] top-[14%]', z: '26px', sy: '-150px', fd: '0s' },
  { icon: '✉️', title: 'Inbox sorted', detail: '4 emails need you today', pos: 'right-[-10%] top-[36%]', z: '-18px', sy: '-60px', fd: '-2s' },
  { icon: '✈️', title: 'Flights compared', detail: 'Three options, links to book', pos: 'left-[-12%] top-[62%]', z: '14px', sy: '-110px', fd: '-4s' },
  { icon: '\u{1F4C4}', title: 'Invoice ready', detail: 'PDF made, waiting for your yes', pos: 'right-[-6%] top-[80%]', z: '-26px', sy: '-30px', fd: '-1s' },
];

export function Hero() {
  const heroRef = useProgress<HTMLElement>('leave');

  // Desktop only: the background and the phone lean towards the pointer.
  useEffect(() => {
    const el = heroRef.current;
    if (!el || !hasFinePointer() || prefersReducedMotion()) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      const x = (e.clientX / window.innerWidth) * 2 - 1;
      const y = (e.clientY / window.innerHeight) * 2 - 1;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        el.style.setProperty('--mx', x.toFixed(3));
        el.style.setProperty('--my', y.toFixed(3));
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
    };
  }, [heroRef]);

  return (
    <section ref={heroRef} id="top" className="relative overflow-hidden" data-listing={PLAY_STORE_LISTING}>
      <div className="aurora absolute inset-0 pointer-events-none" aria-hidden>
        <span className="a1" />
        <span className="a2" />
        <span className="a3" />
      </div>
      <div className="absolute inset-0 grain pointer-events-none" aria-hidden />

      <div className="container-page relative pt-10 md:pt-20 pb-24 md:pb-32">
        <div className="grid md:grid-cols-12 gap-14 md:gap-10 items-center">
          <div className="md:col-span-7">
            <a
              href="#money"
              className="pill-new fade-up fade-up-1 inline-flex items-center gap-2 rounded-pill px-3.5 py-1.5 text-[13px] text-ink shadow-quiet"
            >
              <span className="rounded-pill bg-sage px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-white">New</span>
              <span>Find money you may be owed</span>
              <span aria-hidden className="text-sage">→</span>
            </a>
            <p className="eyebrow mt-7 mb-5 fade-up fade-up-2">Your connected AI coworker</p>
            <h1 className="text-[46px] sm:text-[58px] md:text-[80px] leading-[1.0] tracking-[-0.035em] font-medium">
              <SplitWords eager text="The AI coworker" className="brand-serif text-sage" />
              <br />
              <SplitWords eager start={3} text="that works in your apps." />
            </h1>
            <p className="mt-7 text-body-lg text-ink-muted max-w-prose fade-up fade-up-4" style={{ animationDelay: '0.55s' }}>
              It sorts your inbox, plans your trips, finds money you may be owed and writes the letters.
              {` ${APP_COUNT} apps, one coworker. `}
              <span className="text-ink">Free for your first month</span>
              {`, then ${formatAgentPlanPrice()} a month.`}
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3 fade-up" style={{ animationDelay: '0.7s' }}>
              <StoreButtons size="lg" />
              <a href="#pricing" className="btn-primary text-[15px] group">
                See pricing
                <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">→</span>
              </a>
            </div>
            <p className="mt-3 text-[13px] text-ink-faint fade-up" style={{ animationDelay: '0.8s' }}>
              {platformAvailabilityLine()}
            </p>

            <ul className="mt-10 flex flex-wrap gap-x-7 gap-y-2.5 text-[13.5px] text-ink-muted">
              {[
                'Replies in seconds, by chat or voice',
                `Your first ${AGENT_PLAN.freeTrialDays === 30 ? 'month' : `${AGENT_PLAN.freeTrialDays} days`} free`,
                MODEL_CLAIM_SHORT,
                'UK GDPR compliant, ICO-registered',
              ].map((item, i) => (
                <li key={item} className="flex items-center gap-2 fade-up" style={{ animationDelay: `${0.9 + i * 0.08}s` }}>
                  <Dot /> {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="md:col-span-5">
            <div className="relative mx-auto w-full max-w-[290px] md:max-w-[310px] fade-up" style={{ animationDelay: '0.35s' }}>
              <div className="hero-phone">
                <div className="rounded-[44px] bg-ink p-2.5 shadow-[0_50px_100px_-40px_rgba(14,14,12,0.55)] ring-1 ring-black/10">
                  <img
                    src="/app-chat.png"
                    alt="The Delegent AI chat, where you ask your coworker for help"
                    width={780}
                    height={1624}
                    className="block w-full rounded-[36px]"
                  />
                </div>
              </div>
              <div className="absolute -bottom-6 left-1/2 -z-10 h-24 w-4/5 -translate-x-1/2 rounded-full bg-sage/25 blur-3xl" aria-hidden />

              {CHIPS.map((chip) => (
                <div
                  key={chip.title}
                  className={`chip-depth pointer-events-none absolute ${chip.pos} hidden min-[380px]:block`}
                  style={{ '--z': chip.z, '--sy': chip.sy } as CSSProperties}
                  aria-hidden
                >
                  <div className="chip-float" style={{ '--fd': chip.fd } as CSSProperties}>
                    <div className="flex items-center gap-2.5 rounded-2xl bg-white/85 px-3 py-2.5 shadow-lift ring-1 ring-divider backdrop-blur-md">
                      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-xl bg-sage-soft text-[15px]">{chip.icon}</span>
                      <span className="leading-tight">
                        <span className="block text-[12.5px] font-medium text-ink whitespace-nowrap">{chip.title}</span>
                        <span className="block text-[11px] text-ink-muted whitespace-nowrap">{chip.detail}</span>
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Scroll cue */}
      <a
        href="#money"
        className="absolute bottom-6 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-ink-faint md:flex fade-up"
        style={{ animationDelay: '1.4s' }}
        aria-label="Scroll to Money Finder"
      >
        <span className="relative h-10 w-6 rounded-full ring-1 ring-ink-faint/50">
          <span className="absolute left-1/2 top-2 h-2 w-1 -translate-x-1/2 rounded-full bg-ink-faint animate-[float_1.8s_ease-in-out_infinite]" />
        </span>
        Scroll
      </a>
    </section>
  );
}

function Dot() {
  return <span className="inline-block h-1.5 w-1.5 rounded-full bg-sage" aria-hidden />;
}
