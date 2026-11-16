import { useState } from 'react';
import { DELEGENT_USE_CASE_CATEGORIES, type UseCaseCategory } from '@sidekick/shared';
import { Screen } from '../../components/ui';

// The same categories the phone shows, from @sidekick/shared. The shared how-to
// guide and FAQ both tell the reader to open "Skills & use cases", so this
// screen has to exist here or that instruction is wrong on the web.
//
// Tapping a phrase sends it straight into chat, the same one-tap the phone got
// on 2026-07-24. The phone can do that because its chat is always mounted; here
// the phrase is parked and played when the chat route has finished loading.

export function SkillsScreen() {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  return (
    <Screen
      title="Skills and use cases"
      subtitle="Your coworker comes with dozens of trained specialities, grouped below."
    >
      <p className="mb-4 text-body-sm text-textSecondary">
        Open a category to see what it covers, then tap a phrase to say it in chat. Describing what you need in your own
        words works just as well.
      </p>

      {DELEGENT_USE_CASE_CATEGORIES.map((category) => (
        <CategoryCard
          key={category.key}
          category={category}
          expanded={expandedKey === category.key}
          onToggle={() => setExpandedKey((prev) => (prev === category.key ? null : category.key))}
        />
      ))}

      <p className="mt-6 text-body-sm text-textSecondary">
        This is a selection, not the whole list. Describe what you need and your coworker picks the right skill.
      </p>
    </Screen>
  );
}

function CategoryCard({
  category,
  expanded,
  onToggle,
}: {
  category: UseCaseCategory;
  expanded: boolean;
  onToggle: () => void;
}) {
  const panelId = `skills-panel-${category.key}`;

  return (
    <article className="card mb-3 overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-3 p-4 text-left hover:bg-bg"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-2xl ${
            category.muted ? 'border border-border bg-surfaceHigh' : 'bg-accentMuted'
          }`}
          aria-hidden="true"
        >
          {category.emoji}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium text-textPrimary">{category.title}</span>
          <span className="mt-0.5 block text-body-sm text-textSecondary">{category.hook}</span>
        </span>
        <span aria-hidden="true" className={`shrink-0 text-textSecondary transition-transform ${expanded ? 'rotate-180' : ''}`}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {expanded ? (
        <div id={panelId} className="border-t border-border p-4">
          <p className="text-body-sm text-textSecondary">Use it to {category.useItTo}</p>

          <ul className="mt-4 space-y-4">
            {category.skills.map((skill) => (
              <li key={skill.name}>
                <p className="text-body font-medium text-textPrimary">{skill.name}</p>
                <p className="mt-0.5 text-body-sm text-textSecondary">{skill.desc}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}
