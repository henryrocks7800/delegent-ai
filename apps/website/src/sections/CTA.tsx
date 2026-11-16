import type { CSSProperties } from 'react';
import { formatAgentPlanPrice, platformAvailabilityLine } from '@sidekick/shared';
import { StoreButtons } from '../components/StoreButtons';
import { WEB_APP_URL } from '../components/webAppLink';
import { Reveal, SplitWords } from '../motion/Reveal';

// A few sparks drifting up through the panel. Positions and timings are fixed
// so the panel looks the same on every visit.
const SPARKS = [
  { left: '8%', sd: '11s', sdl: '0s', sx: '30px' },
  { left: '22%', sd: '9s', sdl: '-3s', sx: '-20px' },
  { left: '37%', sd: '13s', sdl: '-6s', sx: '24px' },
  { left: '51%', sd: '10s', sdl: '-1s', sx: '-30px' },
  { left: '66%', sd: '12s', sdl: '-8s', sx: '18px' },
  { left: '79%', sd: '9.5s', sdl: '-4s', sx: '-16px' },
  { left: '91%', sd: '14s', sdl: '-10s', sx: '22px' },
];

export function CTA() {
  return (
    <section id="cta" className="container-page py-24 md:py-32">
      <Reveal effect="bloom">
        <div className="relative overflow-hidden rounded-[32px] bg-sage px-8 py-16 text-white shadow-lift md:px-16 md:py-24">
          <div className="mesh pointer-events-none absolute inset-0" aria-hidden>
            <span className="m1" />
            <span className="m2" />
          </div>
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            {SPARKS.map((s) => (
              <span
                key={s.left}
                className="spark"
                style={{ left: s.left, '--sd': s.sd, '--sdl': s.sdl, '--sx': s.sx } as CSSProperties}
              />
            ))}
          </div>
          <div className="relative max-w-narrow">
            <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.16em] text-white/70">Get started</p>
            <h2 className="text-[42px] font-medium leading-[1.02] tracking-[-0.025em] md:text-[64px]">
              <SplitWords text="Meet your connected AI coworker." className="brand-serif" />
              <br />
              <SplitWords text="Hand it something today." start={5} />
            </h2>
            <p className="mt-7 max-w-prose text-[17.5px] leading-[1.55] text-white/85">
              Download the app, sign in and ask. Your first month is free, then {formatAgentPlanPrice()} a month, and you
              can cancel any time.
            </p>

            <div className="mt-10 flex flex-wrap items-center gap-3">
              <StoreButtons variant="inverted" size="lg" />
              {/* Someone who read to the bottom and does not want to install
                  anything needs the browser door offered here too, not only in
                  the header they scrolled away from. */}
              <a href={WEB_APP_URL} className="btn bg-white text-[15px] text-ink hover:bg-white/90">
                Log in to the web app
              </a>
              <a href="#pricing" className="btn group bg-transparent text-[15px] text-white ring-1 ring-white/30 hover:bg-white/10">
                See pricing
                <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">→</span>
              </a>
            </div>
            <p className="mt-4 text-[13px] text-white/60">{platformAvailabilityLine()}</p>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
