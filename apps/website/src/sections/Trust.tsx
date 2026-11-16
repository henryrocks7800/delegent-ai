import type { CSSProperties } from 'react';
import { Reveal, SplitWords } from '../motion/Reveal';
import { useInView } from '../motion/hooks';

interface TrustPoint {
  title: string;
  body: string;
  glyph: React.ReactNode;
}

// 2026-09-26: "Nothing kept by the AI" said the AI "does not keep your prompts
// or data". That stopped being true when the model moved to OpenAI without
// zero data retention (PR 665): the FAQ, the app and the privacy policy all say
// it may keep a message for up to 30 days to check for misuse. The card now
// says the same thing, so the site agrees with itself.
const POINTS: TrustPoint[] = [
  {
    title: 'Private to you',
    body: 'Your conversation, what your coworker remembers about you and the files you send are kept for your account alone, and you can have them deleted any time.',
    glyph: <LockGlyph />,
  },
  {
    title: 'You stay in charge',
    body: 'You control what it can reach. Anything that sends, posts, deletes or spends comes back to you first, showing exactly what will happen.',
    glyph: <HandshakeGlyph />,
  },
  {
    title: 'Never used for training',
    body: 'Nothing you send is used to train anyone’s AI model. Our AI provider may keep a message for up to 30 days to check for misuse, then deletes it.',
    glyph: <NoRetentionGlyph />,
  },
  {
    title: 'UK GDPR compliant by design',
    body: 'Registered with the ICO. Ask for a copy of your data, or for your account to be deleted, whenever you like.',
    glyph: <ShieldGlyph />,
  },
  {
    title: 'Your passwords stay yours',
    body: 'You sign in to each app on its own website, so we never see your password. Connections are held encrypted by our broker, and you can disconnect any app at any time.',
    glyph: <WalletGlyph />,
  },
];

export function Trust() {
  return (
    <section id="trust" className="relative overflow-hidden border-y border-divider bg-surface">
      <div className="container-page py-24 md:py-32">
        <div className="max-w-narrow">
          <Reveal>
            <p className="eyebrow mb-4">Trust & privacy</p>
          </Reveal>
          <h2 className="section-title">
            <SplitWords text="A coworker you can" />{' '}
            <SplitWords text="actually trust" start={4} className="brand-serif text-sage" />{' '}
            <SplitWords text="with the boring stuff." start={6} />
          </h2>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {POINTS.map((p, i) => (
            <TrustCard key={p.title} point={p} index={i} />
          ))}
        </div>

        <Reveal>
          <p className="mt-12 text-[13.5px] text-ink-muted max-w-prose">
            Delegent AI is a product of Delegent AI. See our{' '}
            <a href="/legal/privacy" className="underline decoration-divider underline-offset-4 hover:text-ink">
              Privacy Policy
            </a>{' '}
            and{' '}
            <a href="/legal/terms" className="underline decoration-divider underline-offset-4 hover:text-ink">
              Terms of Service
            </a>{' '}
            for the full picture.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function TrustCard({ point, index }: { point: TrustPoint; index: number }) {
  const [ref, seen] = useInView<HTMLDivElement>(0.25);
  return (
    <div
      ref={ref}
      className={`fx fx-rise ${seen ? 'is-in' : ''} flex gap-5 rounded-[24px] bg-white/70 p-6 ring-1 ring-divider`}
      style={{ '--d': `${(index % 3) * 100}ms` } as CSSProperties}
    >
      <div className="flex h-12 w-12 flex-none items-center justify-center rounded-2xl bg-sage-soft text-sage-deep">
        {point.glyph}
      </div>
      <div>
        <h3 className="text-title font-medium">{point.title}</h3>
        <p className="mt-2 text-body text-ink-muted">{point.body}</p>
      </div>
    </div>
  );
}

// Every glyph draws itself in (the .draw class and pathLength=1) once its card arrives.
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="draw" aria-hidden>
      {children}
    </svg>
  );
}
function LockGlyph() {
  return (
    <Glyph>
      <rect x="4" y="11" width="16" height="10" rx="2" pathLength={1} />
      <path d="M8 11V8a4 4 0 1 1 8 0v3" pathLength={1} />
    </Glyph>
  );
}
function HandshakeGlyph() {
  return (
    <Glyph>
      <path d="M3 13l5-5 4 3 4-3 5 5-5 5-3-3-3 3-2-2-5-3z" strokeLinejoin="round" pathLength={1} />
    </Glyph>
  );
}
function NoRetentionGlyph() {
  return (
    <Glyph>
      <path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z" strokeLinejoin="round" pathLength={1} />
      <path d="M4 7v10c0 1.7 3.6 3 8 3 1.4 0 2.8-.14 4-.4" strokeLinecap="round" pathLength={1} />
      <path d="M20 7v5" strokeLinecap="round" pathLength={1} />
      <path d="M16 18l5 5M21 18l-5 5" strokeLinecap="round" pathLength={1} />
    </Glyph>
  );
}
function ShieldGlyph() {
  return (
    <Glyph>
      <path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z" strokeLinejoin="round" pathLength={1} />
      <path d="M8.5 12l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
    </Glyph>
  );
}
function WalletGlyph() {
  return (
    <Glyph>
      <rect x="3" y="6" width="18" height="13" rx="2" pathLength={1} />
      <path d="M3 10h13a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2H3" pathLength={1} />
    </Glyph>
  );
}
