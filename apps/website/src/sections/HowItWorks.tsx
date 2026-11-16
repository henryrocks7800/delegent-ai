import type { CSSProperties } from 'react';
import { agentConnectableServices } from '@sidekick/shared';
import { Reveal, SplitWords } from '../motion/Reveal';
import { useProgress } from '../motion/hooks';

interface Step {
  n: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    n: '01',
    title: 'Get the app and start your free month',
    body: 'Download Delegent AI, sign in with Google or your email, and give your coworker a name. There is nothing to set up: it is ready as soon as you are.',
  },
  {
    n: '02',
    title: 'Connect what you use, or do not',
    body: `Travel, web search, news and the weather work straight away. To use your own apps, open Connections and sign in to any of ${agentConnectableServices().length}, such as Gmail, Outlook, Google Calendar or Drive, on the app's own website.`,
  },
  {
    n: '03',
    title: 'Just ask',
    body: 'Type it, speak it, or open Talk. Quick answers come back in seconds. Drafts and documents land in your chat for you to review, and anything that sends, posts or spends asks you first.',
  },
];

export function HowItWorks() {
  // The rail fills as the list scrolls through the middle of the screen, and
  // each step lights up when the fill reaches it (--k is its threshold).
  const listRef = useProgress<HTMLOListElement>('read');
  return (
    <section id="how" className="relative border-y border-divider bg-surface">
      <div className="container-page py-24 md:py-32">
        <div className="grid items-start gap-12 md:grid-cols-12 md:gap-16">
          <div className="md:col-span-5 md:sticky md:top-28">
            <Reveal>
              <p className="eyebrow mb-4">How it works</p>
            </Reveal>
            <h2 className="section-title">
              <SplitWords text="From" />{' '}
              <SplitWords text="download" start={1} className="brand-serif text-sage" />{' '}
              <SplitWords text="to" start={2} />{' '}
              <SplitWords text="done," start={3} className="brand-serif text-sage" />{' '}
              <SplitWords text="without a setup maze." start={4} />
            </h2>
            <Reveal delay={3}>
              <p className="mt-6 text-body-lg text-ink-muted max-w-prose">
                No prompts to learn and no models to choose. A coworker that knows your name, works in your apps and
                remembers how you like things done.
              </p>
            </Reveal>
          </div>

          <ol ref={listRef} className="relative md:col-span-7">
            <span className="absolute bottom-6 left-[19px] top-6 w-[2px] rounded-full bg-divider" aria-hidden />
            <span className="rail-fill absolute bottom-6 left-[19px] top-6 w-[2px] rounded-full bg-gradient-to-b from-sage to-[#C9A97E]" aria-hidden />
            {STEPS.map((s, i) => (
              <li
                key={s.n}
                className="relative grid grid-cols-[40px_1fr] gap-6 py-8 first:pt-2"
                style={{ '--k': `${0.12 + i * 0.28}` } as CSSProperties}
              >
                <span
                  className="step-node relative z-10 flex h-10 w-10 items-center justify-center rounded-full font-mono text-[12px] tracking-[0.1em] ring-4 ring-surface"
                  aria-hidden
                >
                  {s.n}
                </span>
                <div className="step-lit">
                  <h3 className="text-[22px] font-medium tracking-[-0.01em]">{s.title}</h3>
                  <p className="mt-2 text-body text-ink-muted max-w-prose">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
