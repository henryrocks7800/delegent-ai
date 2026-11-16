import type { CSSProperties } from 'react';
import { AGENT_PLAN } from '@sidekick/shared';
import { Reveal, SplitWords } from '../motion/Reveal';
import { useInView } from '../motion/hooks';

const POINTS = [
  {
    title: 'Speaks and listens',
    body: 'A natural voice, quick replies, and a follow-up question when it needs one. It feels like a call, not a form.',
  },
  {
    title: 'Hands it straight on',
    body: 'Say what you need and it passes the request to your coworker while you carry on talking.',
  },
  {
    title: 'The answer lands in chat',
    body: 'Everything it finds or makes is waiting in your chat afterwards, ready to read, send or save.',
  },
];

// Bar heights for the live waveform under the orb, and the stagger for each.
const BARS = [0.35, 0.6, 0.9, 0.55, 1, 0.7, 0.45, 0.85, 0.5, 0.95, 0.65, 0.4, 0.75, 0.55, 0.3];

export function VoiceHook() {
  const [orbRef, orbSeen] = useInView<HTMLDivElement>(0.3);
  return (
    <section id="voice" className="relative overflow-hidden bg-ink text-white">
      <div className="pointer-events-none absolute inset-0 opacity-60" aria-hidden>
        <div className="absolute left-[18%] top-1/2 h-[70vmax] w-[70vmax] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(79,97,82,0.55),transparent)]" />
      </div>
      <div className="container-page relative py-24 md:py-32">
        <div className="grid items-center gap-14 md:grid-cols-12 md:gap-16">
          <div ref={orbRef} className={`order-last md:order-first md:col-span-5 ${orbSeen ? 'is-in' : ''}`}>
            <div className="relative mx-auto h-64 w-64 md:h-80 md:w-80" aria-hidden>
              {[0, 1.2, 2.4].map((delay) => (
                <div
                  key={delay}
                  className="ripple absolute inset-6 rounded-full ring-1 ring-sage-soft/40"
                  style={{ '--rd': `${delay}s` } as CSSProperties}
                />
              ))}
              <div className="absolute inset-0 rounded-full bg-sage/40 blur-3xl animate-orb-halo" />
              <div className="absolute inset-10 rounded-full orb-core animate-orb-pulse shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]" />
              <div className="absolute inset-10 rounded-full ring-1 ring-white/40" />
            </div>

            <div className="mx-auto mt-2 flex h-10 w-48 items-center justify-center gap-[5px]" aria-hidden>
              {BARS.map((h, i) => (
                <span
                  key={i}
                  className="wave-bar block w-[3px] rounded-full bg-sage-soft/80"
                  style={{ height: `${h * 100}%`, '--wd': `${(i % 5) * 0.12}s` } as CSSProperties}
                />
              ))}
            </div>

            {/* A short exchange that writes itself out, like live captions */}
            <div className="mx-auto mt-6 max-w-sm space-y-2.5">
              <p className="kid rounded-2xl rounded-bl-md bg-white/10 px-4 py-2.5 text-[14px] text-white/90 backdrop-blur" style={{ '--d': '300ms' } as CSSProperties}>
                <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-sage-soft/70">You</span>
                Find me a plumber nearby with good reviews.
              </p>
              <p className="kid ml-auto rounded-2xl rounded-br-md bg-sage px-4 py-2.5 text-[14px] text-white shadow-lift" style={{ '--d': '1400ms' } as CSSProperties}>
                <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-white/70">Talk</span>
                Three with great reviews, all open today. I’ve put them in your chat.
              </p>
            </div>
            <p className="mt-6 text-center text-[13px] text-white/50">Talk, in the Delegent AI app</p>
          </div>

          <div className="md:col-span-7">
            <Reveal>
              <p className="eyebrow mb-4 !text-sage-soft/70">Talk</p>
            </Reveal>
            <h2 className="section-title">
              <SplitWords text="Just" />{' '}
              <SplitWords text="say it," start={1} className="brand-serif text-sage-soft" />{' '}
              <SplitWords text="hands-free." start={3} />
            </h2>
            <Reveal delay={2}>
              <p className="mt-6 text-body-lg text-white/70 max-w-prose">
                Tap Talk and speak. Your coworker answers in a natural voice and gets on with it while you carry on
                with your day. {AGENT_PLAN.talkMinutesMonthly} minutes of Talk are included every month.
              </p>
            </Reveal>

            <div className="mt-12 grid gap-8 sm:grid-cols-3">
              {POINTS.map((p, i) => (
                <Reveal key={p.title} delay={3 + i}>
                  <div className="h-px w-10 bg-sage-soft/50" />
                  <h3 className="mt-4 text-[16px] font-medium">{p.title}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-white/65">{p.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
