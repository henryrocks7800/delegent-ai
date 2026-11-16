import { useEffect, useRef, useState } from 'react';
import { Mark } from '../brand/Mark';
import { Wordmark } from '../brand/Wordmark';
import { GET_THE_APP_URL } from '@sidekick/shared';
import { WEB_APP_URL } from '../components/webAppLink';

// Absolute-path anchors (leading "/") so the nav works from sub-pages like
// /guides too, not only the homepage. From "/" they scroll in-place; from a
// sub-page they navigate home and then to the section.
const NAV_LINKS: Array<{ href: string; label: string }> = [
  { href: '/#money', label: 'Money Finder' },
  { href: '/#how', label: 'How it works' },
  { href: '/#built-in-skills', label: 'Skills' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/guides', label: 'Guides' },
];

export function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // One listener does two jobs: the glass background once you leave the top,
  // and the thin progress line along the bottom edge. The line is written
  // straight to the DOM so scrolling never re-renders the header.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      barRef.current?.style.setProperty('--page', ratio.toFixed(4));
      setScrolled(window.scrollY > 8);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [menuOpen]);

  const glass = scrolled || menuOpen;

  return (
    <header className="sticky top-0 z-40">
      <div
        className={`transition-all duration-500 ease-quiet ${
          glass ? 'bg-bg/80 backdrop-blur-xl backdrop-saturate-150 shadow-[0_1px_0_rgba(14,14,12,0.06)]' : 'bg-transparent'
        }`}
      >
        <div className={`container-page flex items-center justify-between transition-[height] duration-500 ease-quiet ${glass ? 'h-14 md:h-16' : 'h-16 md:h-20'}`}>
          <a href="/" className="group flex items-center gap-3" aria-label="Delegent AI home" onClick={() => setMenuOpen(false)}>
            <span className="transition-transform duration-700 ease-quiet group-hover:rotate-[-8deg] group-hover:scale-110">
              <Mark size={32} />
            </span>
            {/* A phone header cannot hold the wordmark and both doors into the
                product at once: at 390px the two buttons wrap onto second lines
                and run over the "AI". The mark carries the brand here, and the
                wordmark is still the first thing in the hero just below. */}
            <span className="hidden sm:inline-flex">
              <Wordmark size="md" />
            </span>
          </a>
          <nav className="hidden lg:flex items-center gap-1 text-[14px] text-ink-muted" aria-label="Primary">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="relative rounded-pill px-3 py-2 transition hover:text-ink hover:bg-sage-soft/70"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            {/* Two doors, side by side, at every width: the store for people who
                want it on a phone, the browser version for everyone else. A
                transparent ghost link next to a filled green button read as
                decoration, so this is a filled control in its own right. */}
            <a href={WEB_APP_URL} className="hidden sm:inline-flex btn-soft">
              Log in to the web app
            </a>
            <a
              href={GET_THE_APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline-flex btn-primary"
            >
              Get the app
            </a>
            {/* Phone widths cannot hold both full labels beside the wordmark, so
                they shorten rather than disappear. */}
            <a href={WEB_APP_URL} className="sm:hidden btn-soft whitespace-nowrap text-[13px] px-3 py-2">
              Log in
            </a>
            <a
              href={GET_THE_APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="sm:hidden btn-primary whitespace-nowrap text-[13px] px-3 py-2"
            >
              Get the app
            </a>
            <button
              type="button"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              aria-controls="primary-mobile-nav"
              onClick={() => setMenuOpen((prev) => !prev)}
              className="lg:hidden inline-flex h-10 w-10 items-center justify-center rounded-full text-ink hover:bg-sage-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-sage"
            >
              <BurgerIcon open={menuOpen} />
            </button>
          </div>
        </div>
        <div
          id="primary-mobile-nav"
          className={`lg:hidden overflow-hidden transition-[max-height,opacity] duration-500 ease-quiet ${
            menuOpen ? 'max-h-[28rem] opacity-100' : 'max-h-0 opacity-0'
          }`}
          aria-hidden={!menuOpen}
        >
          <nav className="container-page pb-6 flex flex-col gap-1 text-[17px] text-ink" aria-label="Mobile primary">
            {NAV_LINKS.map((link, i) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className={`py-3 border-b border-divider/60 last:border-b-0 hover:text-sage transition-all duration-500 ease-quiet ${
                  menuOpen ? 'translate-x-0 opacity-100' : '-translate-x-3 opacity-0'
                }`}
                style={{ transitionDelay: menuOpen ? `${80 + i * 45}ms` : '0ms' }}
              >
                {link.label}
              </a>
            ))}
            {/* The header button says only "Log in" at this width, so spell out
                where it goes for anyone who opens the menu to look for it. */}
            <a
              href={WEB_APP_URL}
              onClick={() => setMenuOpen(false)}
              className="py-3 border-b border-divider/60 last:border-b-0 hover:text-sage transition"
            >
              Log in to the web app
            </a>
          </nav>
        </div>
        {/* How far down the page you are: a hairline of sage along the bottom edge. */}
        <div className="h-[2px] w-full bg-transparent" aria-hidden>
          <div ref={barRef} className="page-progress h-full w-full bg-gradient-to-r from-sage via-sage to-[#C9A97E]" />
        </div>
      </div>
    </header>
  );
}

function BurgerIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {open ? (
        <>
          <line x1="4" y1="4" x2="16" y2="16" />
          <line x1="16" y1="4" x2="4" y2="16" />
        </>
      ) : (
        <>
          <line x1="3" y1="6" x2="17" y2="6" />
          <line x1="3" y1="10" x2="17" y2="10" />
          <line x1="3" y1="14" x2="17" y2="14" />
        </>
      )}
    </svg>
  );
}
