import { useState } from 'react';
import {
  DELEGENT_DELETION_INTRO,
  DELEGENT_DELETION_SECTIONS,
  DELEGENT_DELETION_TITLE,
  DELEGENT_DELETION_UPDATED,
  DELEGENT_NOTICES_INTRO,
  DELEGENT_NOTICES_SECTIONS,
  DELEGENT_NOTICES_TITLE,
  DELEGENT_NOTICES_UPDATED,
  DELEGENT_PRIVACY_INTRO,
  DELEGENT_PRIVACY_SECTIONS,
  DELEGENT_PRIVACY_TITLE,
  DELEGENT_PRIVACY_UPDATED,
  DELEGENT_TERMS_INTRO,
  DELEGENT_TERMS_SECTIONS,
  DELEGENT_TERMS_TITLE,
  DELEGENT_TERMS_UPDATED,
  type LegalSection,
} from '@sidekick/shared';
import { Screen } from '../../components/ui';

// The same legal copy the phone app renders, from @sidekick/shared. These are
// published documents, so a second copy here would be a compliance problem as
// well as a drift problem.

type Doc = {
  key: string;
  tab: string;
  title: string;
  updated: string;
  intro: string;
  sections: readonly LegalSection[];
};

const DOCS: readonly Doc[] = [
  {
    key: 'privacy',
    tab: 'Privacy',
    title: DELEGENT_PRIVACY_TITLE,
    updated: DELEGENT_PRIVACY_UPDATED,
    intro: DELEGENT_PRIVACY_INTRO,
    sections: DELEGENT_PRIVACY_SECTIONS,
  },
  {
    key: 'terms',
    tab: 'Terms',
    title: DELEGENT_TERMS_TITLE,
    updated: DELEGENT_TERMS_UPDATED,
    intro: DELEGENT_TERMS_INTRO,
    sections: DELEGENT_TERMS_SECTIONS,
  },
  {
    key: 'deletion',
    tab: 'Deleting your account',
    title: DELEGENT_DELETION_TITLE,
    updated: DELEGENT_DELETION_UPDATED,
    intro: DELEGENT_DELETION_INTRO,
    sections: DELEGENT_DELETION_SECTIONS,
  },
  {
    key: 'notices',
    tab: 'Open source',
    title: DELEGENT_NOTICES_TITLE,
    updated: DELEGENT_NOTICES_UPDATED,
    intro: DELEGENT_NOTICES_INTRO,
    sections: DELEGENT_NOTICES_SECTIONS,
  },
];

export function LegalScreen() {
  const [activeKey, setActiveKey] = useState(DOCS[0].key);
  const active = DOCS.find((doc) => doc.key === activeKey) ?? DOCS[0];

  return (
    <Screen title="Terms and privacy">
      <div className="mb-4 flex flex-wrap gap-2">
        {DOCS.map((doc) => (
          <button
            key={doc.key}
            type="button"
            aria-pressed={doc.key === active.key}
            onClick={() => setActiveKey(doc.key)}
            className={doc.key === active.key ? 'chip-on' : 'chip-off'}
          >
            {doc.tab}
          </button>
        ))}
      </div>

      <article className="card p-4">
        <h2 className="text-body font-medium text-textPrimary">{active.title}</h2>
        <p className="mt-0.5 text-body-sm text-textSecondary">Last updated {active.updated}</p>
        <p className="mt-3 text-body-sm leading-relaxed text-textSecondary">{active.intro}</p>

        {active.sections.map((section) => (
          <section key={section.title} className="mt-5">
            <h3 className="text-body-sm font-medium text-textPrimary">{section.title}</h3>
            {section.body.map((paragraph) => (
              <p key={paragraph} className="mt-2 text-body-sm leading-relaxed text-textSecondary">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </article>
    </Screen>
  );
}
