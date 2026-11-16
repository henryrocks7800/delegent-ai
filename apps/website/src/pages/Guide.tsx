import type { Guide } from '../content/guides';
import { Footer } from '../sections/Footer';
import { Header } from '../sections/Header';

export function GuidePage({ guide }: { guide: Guide }) {
  const [first, ...rest] = guide.title.split(' ');
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <article className="container-narrow py-16 md:py-24">
          <p className="eyebrow mb-4">
            <a href="/guides" className="hover:text-sage-deep">Guides</a>
          </p>
          <h1 className="text-[36px] md:text-[48px] leading-[1.1] tracking-[-0.015em] font-medium">
            <span className="brand-serif text-sage">{first}</span> {rest.join(' ')}
          </h1>
          <p className="mt-6 text-body-lg text-ink-muted">{guide.intro}</p>

          <div className="mt-12 space-y-12">
            {guide.sections.map((s) => (
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

          {guide.relatedHref ? (
            <>
              <hr className="mt-16" />
              <a
                href={guide.relatedHref}
                className="mt-8 inline-flex items-center gap-2 text-[15px] font-medium text-sage hover:text-sage-deep"
              >
                {guide.relatedLabel}
                <span aria-hidden>→</span>
              </a>
            </>
          ) : null}
        </article>
      </main>
      <Footer />
    </div>
  );
}
