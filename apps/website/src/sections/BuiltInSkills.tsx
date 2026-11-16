// "What your coworker can help with" section. The same categories as the app's
// Skills & use cases screen for the coworker plan (agentUseCaseCategories in
// packages/shared/src/content/agentEngine.ts), read from that one source so the
// site and the product always tell the same story.
//
// Safety contracts enforced by website-content-scanner.test.mjs:
//   - never say it opens bank accounts, makes payments, or submits filings
//     without approval, or replaces regulated professionals.
//   - keep review language: drafts and documents come back for review.
//   - em-dash-free per the release-gate scanner.
//
// 2026-09-26 redesign: each card opens in place to show the skills inside it,
// the same list the app shows, so a visitor can go one level deeper without
// leaving the page.

import { useState, type CSSProperties } from 'react';
import { agentUseCaseCategories } from '@sidekick/shared';
import { Reveal, SplitWords } from '../motion/Reveal';
import { useInView, usePointerGlow } from '../motion/hooks';

const CATEGORIES = agentUseCaseCategories();

export function BuiltInSkills() {
  const [open, setOpen] = useState<string | null>(CATEGORIES[0]?.key ?? null);
  return (
    <section id="built-in-skills" data-testid="builtInSkills.section" className="relative overflow-hidden">
      <div className="container-page py-24 md:py-32">
        <header className="mb-12 max-w-2xl">
          <Reveal>
            <p className="eyebrow mb-4">Everyday jobs, done</p>
          </Reveal>
          <h2 className="section-title">
            <SplitWords text="What your coworker can help with from day one" accentFrom={6} accentClass="brand-serif text-sage" />
          </h2>
          <Reveal delay={3}>
            <p className="mt-6 text-body-lg text-ink-muted">
              Everyday life and the admin nobody enjoys, grouped the way you would think about it. Ask in your own
              words; it works from what you tell it, the files and photos you send, and the apps you connect, and
              brings drafts back for your review. Tap a group to see what is inside.
            </p>
          </Reveal>
        </header>

        {/* items-start and a dense flow: an opened card grows on its own, rather
            than stretching the closed cards beside it into tall empty boxes. */}
        <ul className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-4 grid-flow-dense" data-testid="builtInSkills.categories">
          {CATEGORIES.map((cat, i) => (
            <SkillCard
              key={cat.key}
              cat={cat}
              index={i}
              open={open === cat.key}
              onToggle={() => setOpen((current) => (current === cat.key ? null : cat.key))}
            />
          ))}
        </ul>

        <Reveal>
          <p className="mt-10 max-w-2xl text-sm text-ink-muted" data-testid="builtInSkills.safetyNote">
            Your coworker finds, compares, drafts and prepares, and brings anything important back to you for review.
            It never books or pays for anything itself. It does not open bank accounts, make payments, or submit
            official filings without your approval, or replace regulated professionals such as accountants,
            solicitors, doctors, or therapists.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function SkillCard({
  cat,
  index,
  open,
  onToggle,
}: {
  cat: (typeof CATEGORIES)[number];
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  const [viewRef, seen] = useInView<HTMLLIElement>(0.2);
  const glowRef = usePointerGlow<HTMLDivElement>(3);
  const panelId = `skills-${cat.key}`;
  return (
    <li
      ref={viewRef}
      className={`fx fx-bloom ${seen ? 'is-in' : ''} ${open ? 'sm:col-span-2' : ''}`}
      style={{ '--d': `${(index % 4) * 90}ms` } as CSSProperties}
      data-testid={`builtInSkills.category.${cat.key}`}
    >
      <div
        ref={glowRef}
        className={`glow-card h-full rounded-[24px] p-5 ring-1 transition-colors duration-500 ease-quiet ${
          open ? 'bg-white ring-sage/40 shadow-lift' : 'bg-white/75 ring-divider shadow-quiet'
        }`}
      >
        {/* The whole header row is the tap target, via a transparent button laid
            over it. The title stays a real heading beside it: a heading placed
            INSIDE a button stops being a heading to a screen reader. */}
        <div className="relative flex items-start gap-3">
          <span
            className={`flex h-11 w-11 flex-none items-center justify-center rounded-2xl text-xl transition-transform duration-500 ease-quiet ${
              open ? 'scale-110 rotate-[-6deg]' : ''
            }`}
            style={{ backgroundColor: cat.tint }}
            aria-hidden
          >
            {cat.emoji}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[17px] font-semibold leading-tight text-ink">{cat.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-ink-muted">{cat.hook}</p>
          </div>
          <span
            className={`mt-1 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-sage-soft text-sage-deep transition-transform duration-500 ease-quiet ${
              open ? 'rotate-45' : ''
            }`}
            aria-hidden
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${open ? 'Hide' : 'Show'} the skills in ${cat.title}`}
            className="absolute -inset-2 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-sage"
          />
        </div>

        <div
          id={panelId}
          className={`grid transition-[grid-template-rows,opacity] duration-500 ease-quiet ${
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="overflow-hidden">
            <ul className={`mt-5 grid gap-2.5 ${open ? 'is-in' : ''} sm:grid-cols-2`}>
              {cat.skills.map((skill, i) => (
                <li
                  key={skill.name}
                  className="kid rounded-2xl bg-bg px-3.5 py-3 ring-1 ring-divider"
                  style={{ '--d': `${120 + i * 70}ms` } as CSSProperties}
                >
                  <p className="text-[14px] font-medium text-ink">{skill.name}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">{skill.desc}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </li>
  );
}
