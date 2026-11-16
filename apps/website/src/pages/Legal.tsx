import type { LegalSection } from '@sidekick/shared';
import { Footer } from '../sections/Footer';
import { Header } from '../sections/Header';

interface LegalPageProps {
  title: string;
  updated: string;
  intro: string;
  sections: readonly LegalSection[];
}

export function LegalPage({ title, updated, intro, sections }: LegalPageProps) {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <article className="container-narrow py-16 md:py-24">
          <p className="eyebrow mb-4">Legal · Last updated {updated}</p>
          <h1 className="text-[36px] md:text-[48px] leading-[1.1] tracking-[-0.015em] font-medium">
            <span className="brand-serif text-sage">{title.split(' ')[0]}</span> {title.split(' ').slice(1).join(' ')}
          </h1>
          <p className="mt-6 text-body-lg text-ink-muted">{intro}</p>

          <div className="mt-12 space-y-12">
            {sections.map((s) => (
              <section key={s.title}>
                <h2 className="text-title font-medium">{s.title}</h2>
                <div className="mt-3 space-y-3 text-body text-ink leading-[1.65]">
                  {s.body.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <hr className="mt-16" />
          <p className="mt-8 text-[13.5px] text-ink-muted">
            Questions? Email{' '}
            <a href="mailto:admin@example.com" className="underline decoration-divider underline-offset-4">
              admin@example.com
            </a>{' '}
            or{' '}
            <a href="mailto:support@example.com" className="underline decoration-divider underline-offset-4">
              support@example.com
            </a>
            .
          </p>
        </article>
      </main>
      <Footer />
    </div>
  );
}
