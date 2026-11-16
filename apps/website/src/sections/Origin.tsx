// Founder origin story, between ValueProps and HowItWorks on the homepage.
//
// Sourced from docs/tmp/hermes_agent_optimized_copy_v2.md §1 (Origin Story &
// Founder Testimonial). Reworked into legally-safer public copy: the source
// document named specific third-party brands (MetaBank, Xero) and made
// dollar-savings claims; the public version uses generic categories ("banking
// API", "accounting software") and removes hard-currency numbers in favour of
// the directional "the price of a broadband bill". Preserves the core message:
//   - the founder built this from a personal admin-pain motivator
//   - it's not just chat, it's a digital employee that does the work
//   - it runs in a private cloud workspace
//   - examples are bookkeeping-adjacent, anchoring the §2 flagship use case

export function Origin() {
  return (
    <section id="origin" className="bg-surface border-y border-divider">
      <div className="container-page py-20 md:py-28">
        <div className="grid md:grid-cols-12 gap-10 md:gap-16 items-start">
          <div className="md:col-span-4">
            <p className="eyebrow mb-4">Why this exists</p>
            <h2 className="text-[34px] md:text-[44px] leading-[1.1] tracking-[-0.015em] font-medium">
              <span className="brand-serif">Built</span> to fire my own
              administrative overhead.
            </h2>
          </div>

          <div className="md:col-span-8">
            <blockquote className="text-body-lg text-ink leading-[1.55] max-w-prose">
              <p className="text-[20px] md:text-[22px] font-medium mb-6">
                I built this because I wanted to fire my own administrative overhead.
              </p>
              <p className="mt-4 text-ink-muted">
                Before launching this platform, I hooked an autonomous agent directly up to a banking
                API and my accounting software. I set up a secure folder, dropped in a messy pile of
                digital receipts, and watched it extract the data, reconcile the bank feeds, and
                categorise every line item without me lifting a finger.
              </p>
              <p className="mt-4 text-ink-muted">
                Seeing a digital employee manage my entire bookkeeping, saving me hundreds of hours
                and a meaningful slice of accounting fees for what amounts to the price of a broadband
                bill, is exactly why I provisioned this dedicated cloud workspace for you. I didn&apos;t
                want a chatbot that gives advice. I wanted a digital employee that does the work.
              </p>
              <p className="mt-4 text-ink-muted">That&apos;s why this platform exists.</p>
              <footer className="mt-6 text-[13px] text-ink-faint">
                <span className="brand-serif">Founder &amp; Creator, Delegent AI</span>
              </footer>
            </blockquote>
          </div>
        </div>
      </div>
    </section>
  );
}
