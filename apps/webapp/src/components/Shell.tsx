import { useCallback, useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { gateNotice, PROVISIONING_STALLED_MESSAGE, type GateNoticeTone, type ProductGate } from '@sidekick/shared';
import type { WebAuthUser } from '../features/auth/useAuth';
import { signOut } from '../features/auth/useAuth';
import { useProductStateContext } from '../features/state/productStateContext';
import { useCoworkerEngine } from '../state/coworkerEngine';
import { Icon, type IconName } from './Icon';

// Phone-first chrome: a compact top bar, a bottom tab bar for the four surfaces
// a user touches constantly, and a slide-over for everything else. On a wide
// screen the same links move into a left rail, so there is one source of
// navigation truth rather than two component trees to keep in step.

export type NavItem = { to: string; label: string; icon: IconName };

// The icon for each destination is the one the phone's burger menu already uses
// for the same destination, so the two surfaces are recognisably one product.
export const PRIMARY_NAV: readonly NavItem[] = [
  { to: '/chat', label: 'Chat', icon: 'message-circle' },
  { to: '/files', label: 'Files', icon: 'folder' },
  { to: '/routines', label: 'Routines', icon: 'repeat' },
  { to: '/connections', label: 'Connections', icon: 'link' },
];

export const SECONDARY_NAV: readonly NavItem[] = [
  { to: '/skills', label: 'Skills and use cases', icon: 'zap' },
  { to: '/commands', label: 'Commands', icon: 'command' },
  { to: '/help', label: 'How-to guide', icon: 'book-open' },
  { to: '/faq', label: 'Questions', icon: 'help-circle' },
  { to: '/plan', label: 'Plan and billing', icon: 'credit-card' },
  { to: '/capacity', label: 'Monthly capacity', icon: 'bar-chart-2' },
  { to: '/support', label: 'Help and suggestions', icon: 'life-buoy' },
  { to: '/profile', label: 'Profile', icon: 'user' },
  { to: '/legal', label: 'Terms and privacy', icon: 'file-text' },
];

function initials(user: WebAuthUser): string {
  const source = user.fullName ?? user.email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '');
  return letters.join('') || 'D';
}

export function Shell({ user, children }: { user: WebAuthUser; children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  // A Google photo URL can start returning 404 long after sign-in. Without this
  // the header shows a broken-image glyph, so fall back to the initials.
  const [avatarBroken, setAvatarBroken] = useState(false);
  const location = useLocation();
  // The agent engine runs nothing on a schedule, so Routines would be a dead end.
  const agentEngine = useCoworkerEngine() === 'agent';
  const primaryNav = agentEngine ? PRIMARY_NAV.filter((item) => item.to !== '/routines') : PRIMARY_NAV;

  // Closing on the route change alone is not enough: tapping the entry for the
  // page you are already on leaves the path identical, so the effect never runs
  // and the slide-over just sits there over the content, having apparently
  // ignored the tap. The phone closes on the press itself, whether or not the
  // destination changed. This stays as well, for a route change that starts
  // somewhere other than a menu tap.
  useEffect(() => setMenuOpen(false), [location.pathname]);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surfaceHigh px-4"
        style={{ paddingTop: 'calc(var(--safe-top) + 0.625rem)', paddingBottom: '0.625rem' }}
      >
        <div className="min-w-0">
          <span className="block font-brand text-display-md italic leading-none text-textPrimary">Delegent AI</span>
          <StatusChip />
        </div>
        <button
          type="button"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-bg text-body-sm font-medium text-textPrimary"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
        >
          {user.avatarUrl && !avatarBroken ? (
            <img
              src={user.avatarUrl}
              alt=""
              className="h-full w-full rounded-full object-cover"
              referrerPolicy="no-referrer"
              onError={() => setAvatarBroken(true)}
            />
          ) : (
            initials(user)
          )}
        </button>
      </header>

      <GateNoticeBanner />

      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-56 shrink-0 border-r border-border bg-surfaceHigh p-3 md:block">
          {[...primaryNav, ...SECONDARY_NAV].map((item) => (
            <RailLink key={item.to} item={item} />
          ))}
        </nav>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      <nav
        className="flex shrink-0 border-t border-border bg-surfaceHigh md:hidden"
        style={{ paddingBottom: 'var(--safe-bottom)' }}
        aria-label="Main"
      >
        {primaryNav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              // textTertiary sits at 2.4:1 on this background, under the WCAG AA
              // floor, and these labels are the app's primary navigation.
              `flex flex-1 flex-col items-center gap-0.5 py-2 text-caption ${
                isActive ? 'text-accent' : 'text-textSecondary'
              }`
            }
          >
            <Icon name={item.icon} size={22} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {menuOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/30"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <div
            className="fixed inset-y-0 right-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-l border-border bg-surfaceHigh p-4"
            style={{ paddingTop: 'calc(var(--safe-top) + 1rem)', paddingBottom: 'calc(var(--safe-bottom) + 1rem)' }}
            role="dialog"
            aria-label="Menu"
          >
            <p className="text-body font-medium text-textPrimary">{user.fullName ?? user.email}</p>
            {user.fullName ? <p className="text-body-sm text-textSecondary">{user.email}</p> : null}

            <div className="mt-4 md:hidden">
              {primaryNav.map((item) => (
                <RailLink key={item.to} item={item} onNavigate={closeMenu} />
              ))}
              <div className="my-3 h-px bg-border" />
            </div>

            {SECONDARY_NAV.map((item) => (
              <RailLink key={item.to} item={item} onNavigate={closeMenu} />
            ))}

            <button className="btn-secondary mt-6 w-full" type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** The phone's gateDisplayLabel. Two gates read badly in three words on their own. */
function statusLabel(gate: ProductGate): string {
  if (gate.kind === 'needs_acknowledgement') return 'Setup needed';
  if (gate.kind === 'subscribed_pending_worker' || gate.kind === 'provisioning_worker') return 'Preparing workspace';
  return gate.label;
}

/** The phone's gateDotState, mapped onto the web's names for the same colours. */
function statusDot(gate: ProductGate): string {
  if (gate.tone === 'live') return 'bg-success animate-pulse';
  if (gate.tone === 'accent') return 'bg-accent';
  return 'bg-textTertiary';
}

/**
 * The quiet always-on twin of the banner below.
 *
 * The banner is loud and only appears when something needs saying, so on a good
 * day the browser said nothing at all about the workspace while the phone was
 * showing a green dot and the word Ready. Silence reads the same as not knowing.
 * This is deliberately not a live region: the banner already announces the
 * states worth interrupting for, and two announcements of one change is worse
 * than one.
 */
function StatusChip() {
  const { gate } = useProductStateContext();
  // Before the first snapshot lands there is genuinely nothing to report, and a
  // chip that guesses is worse than no chip.
  if (!gate) return null;
  const label = statusLabel(gate);
  return (
    <span className="mt-0.5 flex items-center gap-1.5">
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${statusDot(gate)}`} />
      <span className="truncate text-body-sm text-textSecondary">{label}</span>
    </span>
  );
}

// warning (#B8956E) is 2.78:1 on white and fails AA as text, so its hue rides on
// the border and the words stay dark. danger (#B64949) is 5.20:1 and can be read.
const TONE: Record<GateNoticeTone, { badge: string; icon: IconName; title: string }> = {
  accent: { badge: 'border-accent bg-accentMuted text-accent', icon: 'clock', title: 'text-textPrimary' },
  warning: { badge: 'border-warning bg-surfaceHigh text-textPrimary', icon: 'alert-triangle', title: 'text-textPrimary' },
  danger: { badge: 'border-danger bg-surfaceHigh text-danger', icon: 'alert-circle', title: 'text-danger' },
};

function GateNoticeBanner() {
  const { gate, provisioningStalled } = useProductStateContext();
  const notice = gateNotice(gate, 'web');
  if (!notice) return null;
  const tone = TONE[notice.tone];
  // Above the content rather than inside a screen, because it is true on every
  // screen and it is the answer to "why did nothing happen when I sent that".
  // Not dismissible, matching the phone: these states outlast a page load, so a
  // reader who closed it and came back would be left guessing again.
  return (
    <div className="shrink-0 border-b border-borderStrong bg-surfaceHigh px-4 py-3" role="status">
      <div className="mx-auto flex max-w-3xl items-start gap-3">
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${tone.badge}`}>
          <Icon name={tone.icon} size={18} />
        </span>
        <div className="min-w-0">
          <p className={`text-title ${tone.title}`}>{notice.title}</p>
          <p className="mt-0.5 text-body-sm text-textSecondary">{notice.body}</p>
          {provisioningStalled ? (
            // The escalation rides here rather than on the status, which used to
            // swap the whole app for an error screen over a wait and switched off
            // the poll that would have noticed the workspace arriving.
            <p className="mt-1 text-body-sm text-danger" data-testid="shell.gateNotice.stalled">
              {PROVISIONING_STALLED_MESSAGE}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RailLink({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        `mb-1 flex items-center gap-3 rounded-md px-3 py-2.5 text-body ${
          isActive ? 'bg-accentMuted font-medium text-accent' : 'text-textPrimary hover:bg-bg'
        }`
      }
    >
      <Icon name={item.icon} size={18} className="shrink-0" />
      {item.label}
    </NavLink>
  );
}
