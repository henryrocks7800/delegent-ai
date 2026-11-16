import { Wordmark } from '../brand/Wordmark';
import { clearConsent } from '../lib/consent';
import { useInView } from '../motion/hooks';

export function Footer() {
  // Triggered on sight rather than scrubbed by scroll: the footer is the end of
  // the page, so on a tall screen the scroll position that would finish the
  // rise can never be reached.
  const [markRef, markSeen] = useInView<HTMLDivElement>(0.2, '0px');
  return (
    <footer className="relative overflow-hidden border-t border-divider">
      <div className="container-page py-12 md:py-16 grid md:grid-cols-12 gap-10">
        <div className="md:col-span-5">
          <Wordmark size="md" />
          <p className="mt-4 text-[14px] text-ink-muted max-w-[34ch] leading-[1.55]">
            Your connected AI coworker. Built by Delegent AI.
          </p>
        </div>

        <nav className="md:col-span-2">
          <p className="eyebrow mb-3">Product</p>
          <ul className="space-y-2 text-[14px] text-ink">
            <li>
              <a href="#how" className="hover:text-sage-deep">
                How it works
              </a>
            </li>
            <li>
              <a href="/#money" className="hover:text-sage-deep">
                Money Finder
              </a>
            </li>
            <li>
              <a href="/#built-in-skills" className="hover:text-sage-deep">
                Use cases
              </a>
            </li>
            <li>
              <a href="#pricing" className="hover:text-sage-deep">
                Pricing
              </a>
            </li>
            <li>
              <a href="#trust" className="hover:text-sage-deep">
                Trust
              </a>
            </li>
            <li>
              <a href="#faq" className="hover:text-sage-deep">
                FAQ
              </a>
            </li>
            <li>
              <a href="/guides" className="hover:text-sage-deep">
                Guides
              </a>
            </li>
            <li>
              <a href="/help" className="hover:text-sage-deep">
                Help articles
              </a>
            </li>
          </ul>
        </nav>

        <nav className="md:col-span-2">
          <p className="eyebrow mb-3">Legal</p>
          <ul className="space-y-2 text-[14px] text-ink">
            <li>
              <a href="/legal/privacy" className="hover:text-sage-deep">
                Privacy Policy
              </a>
            </li>
            <li>
              <a href="/legal/terms" className="hover:text-sage-deep">
                Terms of Service
              </a>
            </li>
            <li>
              <a href="/legal/delete" className="hover:text-sage-deep">
                Delete your data
              </a>
            </li>
            <li>
              <a href="/legal/notices" className="hover:text-sage-deep">
                Open source notices
              </a>
            </li>
            {/* Withdrawing consent must be as easy as giving it. ICO guidance is
                explicit about that, and without this the ONLY routes on offer
                were "clear your browser cookies" or "email us", neither of
                which is equal to clicking one button. clearConsent() existed
                from the start but nothing called it, and its doc comment
                claimed a footer link that had never been written. This is it.
                Reload so the banner re-reads storage and asks again, which also
                covers someone who said no and later wants to say yes. */}
            <li>
              <button
                type="button"
                onClick={() => {
                  clearConsent();
                  window.location.reload();
                }}
                className="hover:text-sage-deep"
              >
                Cookie choices
              </button>
            </li>
            {/* Deliberately quiet: the dashboard behind it refuses everyone
                except the two allowlisted admin accounts, so this link is a
                door with its own lock, not an exposure. delegentai.co.uk/admin
                also works typed directly (firebase.json redirect). */}
            <li>
              <a href="/admin" className="hover:text-sage-deep">
                Admin
              </a>
            </li>
          </ul>
        </nav>

        <div className="md:col-span-3">
          <p className="eyebrow mb-3">Contact</p>
          <ul className="space-y-2 text-[14px] text-ink">
            <li>
              <a href="mailto:customer82@example.com" className="hover:text-sage-deep">
                customer82@example.com
              </a>
            </li>
            <li>
              <a href="mailto:support@example.com" className="hover:text-sage-deep">
                support@example.com
              </a>
            </li>
            <li>
              <a href="mailto:accounts@example.com" className="hover:text-sage-deep">
                accounts@example.com
              </a>
            </li>
            <li>
              <a href="mailto:admin@example.com" className="hover:text-sage-deep">
                admin@example.com
              </a>
            </li>
          </ul>
        </div>
      </div>

      {/* The name, very large, rising into place as you reach the end of the page */}
      <div ref={markRef} className="container-page pointer-events-none select-none overflow-hidden" aria-hidden>
        <p
          className={`whitespace-nowrap text-center leading-[0.8] text-sage/[0.13] transition-[transform,opacity] duration-[1400ms] ease-quiet ${
            markSeen ? 'translate-y-0 opacity-100' : 'translate-y-[60%] opacity-0'
          }`}
        >
          <span className="brand-serif text-[22vw] md:text-[17vw]">Delegent</span>
          <span className="ml-[1.5vw] font-sans text-[11vw] font-medium tracking-[0.02em] md:text-[8.5vw]">AI</span>
        </p>
      </div>

      <div className="hairline">
        <div className="container-page py-6 flex flex-col md:flex-row md:items-center justify-between gap-2 text-[12.5px] text-ink-faint">
          <p>
            © {new Date().getFullYear()} Delegent AI.
            Registered office: [registered office address]
          </p>
          <p>
            Built with quiet care.{' '}
            <span className="brand-serif text-sage-deep">delegentai.co.uk</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
