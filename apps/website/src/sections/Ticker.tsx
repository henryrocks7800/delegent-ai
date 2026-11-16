import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../motion/scroll';

// Things people actually ask it, drifting across the page. Only jobs done in
// the person's own apps (inbox, calendar, Money Finder, inbox sorting), never
// something any chatbot could answer (Alex, 2026-09-27), and every one works
// for every account. The ribbon picks up speed while you scroll, then eases
// back, which is what makes it feel alive rather than like a news crawl.
const ASKS = [
  'Find money I might be owed in my inbox',
  'Sort my inbox',
  'Draft a reply to Sarah, warm but brief',
  'What’s in my calendar tomorrow?',
  'File my emails into folders',
  'Which subscriptions am I still paying for?',
  'Summarise my unread emails',
  'Find the invoice BT sent me last month',
];

export function Ticker() {
  const trackRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    const wrap = wrapRef.current;
    if (!track || !wrap || prefersReducedMotion()) return;

    let x = 0;
    let boost = 0;
    let lastY = window.scrollY;
    let running = false;
    let frame = 0;
    let last = performance.now();

    const step = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const half = track.scrollWidth / 2;
      boost *= 0.92;
      x -= (0.045 + boost) * dt;
      if (half > 0 && -x >= half) x += half;
      track.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
      if (running) frame = requestAnimationFrame(step);
    };
    const onScroll = () => {
      const dy = Math.abs(window.scrollY - lastY);
      lastY = window.scrollY;
      boost = Math.min(1.4, boost + dy * 0.004);
    };
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !running) {
        running = true;
        last = performance.now();
        frame = requestAnimationFrame(step);
      } else if (!entry.isIntersecting) {
        running = false;
        cancelAnimationFrame(frame);
      }
    });
    io.observe(wrap);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      running = false;
      cancelAnimationFrame(frame);
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  const row = ASKS.map((ask) => (
    <span key={ask} className="flex items-center gap-6 pr-6">
      <span className="brand-serif whitespace-nowrap text-[30px] md:text-[44px] text-ink">
        <span className="text-sage">“</span>
        {ask}
        <span className="text-sage">”</span>
      </span>
      <span className="h-2 w-2 flex-none rounded-full bg-sage/50" />
    </span>
  ));

  return (
    <section aria-label="Things you can ask" className="relative border-y border-divider bg-surface/70 py-7 md:py-9">
      <div className="container-page mb-3 flex items-center gap-3">
        <span className="h-2 w-2 rounded-full bg-sage pulse-dot" aria-hidden />
        <p className="eyebrow">Just ask, in your own words</p>
      </div>
      <div ref={wrapRef} className="ticker-mask overflow-hidden" aria-hidden>
        <div ref={trackRef} className="flex w-max will-change-transform">
          <div className="flex">{row}</div>
          <div className="flex">{row}</div>
        </div>
      </div>
      <ul className="sr-only">
        {ASKS.map((ask) => (
          <li key={ask}>{ask}</li>
        ))}
      </ul>
    </section>
  );
}
