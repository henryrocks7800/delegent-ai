import {
  DELEGENT_HOWTO_DEEPER_BODY,
  DELEGENT_HOWTO_DEEPER_LABEL,
  DELEGENT_HOWTO_DEEPER_TITLE,
  DELEGENT_HOWTO_DEEPER_URL,
  DELEGENT_HOWTO_INTRO,
  DELEGENT_HOWTO_SECTIONS,
  DELEGENT_HOWTO_TITLE,
} from '@sidekick/shared';
import { Notice, Screen } from '../../components/ui';

// Every word here comes from @sidekick/shared, which is the same module the
// phone app renders. Editing the guide once changes both surfaces; there is no
// copy of this text in this app to drift.

export function HelpScreen() {
  return (
    <Screen title={DELEGENT_HOWTO_TITLE} subtitle={DELEGENT_HOWTO_INTRO}>
      <Notice tone="info">
        This guide covers your coworker on both the phone app and here on the web, including the voice orb and the
        microphone, which both work in this browser. Connecting Telegram is the one step below that still has to be done
        in the phone app.
      </Notice>

      {DELEGENT_HOWTO_SECTIONS.map((section) => (
        <article key={section.title} className="card mb-3 p-4">
          <h2 className="text-body font-medium text-textPrimary">{section.title}</h2>
          {section.body.map((paragraph) => (
            <p key={paragraph} className="mt-2 text-body-sm leading-relaxed text-textSecondary">
              {paragraph}
            </p>
          ))}
        </article>
      ))}

      <article className="card mb-3 p-4">
        <h2 className="text-body font-medium text-textPrimary">{DELEGENT_HOWTO_DEEPER_TITLE}</h2>
        <p className="mt-2 text-body-sm leading-relaxed text-textSecondary">{DELEGENT_HOWTO_DEEPER_BODY}</p>
        <a
          className="btn-secondary mt-3 inline-flex"
          href={DELEGENT_HOWTO_DEEPER_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          {DELEGENT_HOWTO_DEEPER_LABEL}
        </a>
      </article>
    </Screen>
  );
}
