import { useState } from 'react';
import { AGENT_FAQ_ORDERED, DELEGENT_FAQ_ORDERED } from '@sidekick/shared';
import { Screen } from '../../components/ui';
import { useCoworkerEngine } from '../../state/coworkerEngine';

// Same shared module as the phone app's FAQ. One edit updates both. An account
// on the agent engine gets that engine's answers, as the phone app does; the
// workspace answers describe a private cloud computer it does not have.

export function FaqScreen() {
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const faq = useCoworkerEngine() === 'agent' ? AGENT_FAQ_ORDERED : DELEGENT_FAQ_ORDERED;

  return (
    <Screen title="Questions" subtitle="The things people ask most often.">
      {faq.map((item) => {
        const open = openQuestion === item.question;
        return (
          <article key={item.question} className="card mb-2 overflow-hidden">
            <button
              type="button"
              className="flex w-full items-start justify-between gap-3 p-4 text-left"
              aria-expanded={open}
              onClick={() => setOpenQuestion(open ? null : item.question)}
            >
              <span className="text-body-sm font-medium text-textPrimary">{item.question}</span>
              <span aria-hidden="true" className="shrink-0 text-textTertiary">
                {open ? '−' : '+'}
              </span>
            </button>
            {open ? <p className="px-4 pb-4 text-body-sm leading-relaxed text-textSecondary">{item.answer}</p> : null}
          </article>
        );
      })}
    </Screen>
  );
}
