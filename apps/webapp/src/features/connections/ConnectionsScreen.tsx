import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CONNECTIONS_CUSTODY_NOTE,
  CONNECTIONS_FINISHING_LABEL,
  CONNECTIONS_MORE_COMING_NOTE,
  CONNECTIONS_RETRY_LABEL,
  connectedAnnouncement,
  firstPromptLabel,
  findConnectableService,
  handoffNotice,
  type BrandMark,
  type ConnectableService,
} from '@sidekick/shared';
import { buildConnectionGroups, buildConnectionRows, type ConnectionRow } from '@mobile-logic/connections/connections';
import type { ConnectionInventory } from '@mobile-logic/connections/connectionInventory';
import {
  connectionHandoffOutcome, restoredConnectionHandoff, type ConnectionHandoff,
} from '@mobile-logic/connections/connectionHandoff';
import {
  createConnectionHandoffStore, newConnectionAttemptId, sessionConnectionHandoffStorage,
  type PendingConnectionHandoff,
} from '@mobile-logic/connections/connectionHandoffStore';
import { useConnectionInventory } from '@mobile-logic/connections/useConnectionInventory';
import { ConfirmDialog, Notice, Screen, Spinner } from '../../components/ui';
import { useRearmOnBack } from '../../lib/useRearmOnBack';
import {
  completeConnection,
  disconnectComposioService,
  disconnectConnection,
  fetchComposioConnections,
  fetchConnectionStates,
  startComposioConnection,
  startConnection,
} from './connectionsApi';

export function ConnectionsScreen({ userId }: { userId: string }) {
  // Keyed on the account, so coming back to Connections opens complete (2026-09-28).
  const { inventory, load } = useConnectionInventory(fetchConnectionStates, fetchComposioConnections, userId);
  const { available, pending: loading, error } = inventory;
  // Keyed on the signed-in id. A hand-off leaves this page entirely, so the
  // only record that survives the round trip is the one on disk, and it has to
  // belong to exactly one account. See connectionHandoffStore.ts for what is
  // written and what is deliberately never written.
  const store = useMemo(() => createConnectionHandoffStore(sessionConnectionHandoffStorage(), { userId }), [userId]);
  const [reviewing, setReviewing] = useState<ConnectableService | null>(null);
  const [disconnecting, setDisconnecting] = useState<ConnectableService | null>(null);
  const [busy, setBusy] = useState(false);
  // Kept apart from `error`, which lives at the top of the page behind the
  // safety sheet's scrim. A failure to open the hand-off has to be readable
  // next to the button the reader just pressed.
  const [sheetError, setSheetError] = useState<string | null>(null);
  // A disconnect that was refused, carried with the service it was refused for.
  // It used to write `error` at the top of the page, above every card in every
  // group. The confirmation dialog closes on the press, so the only thing that
  // changed was a line the reader had scrolled past, and it never named which
  // account had not been disconnected.
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // Which service the announcement is about. Held rather than derived, because
  // the announcement outlives the hand-off that produced it.
  const [announcedService, setAnnouncedService] = useState<ConnectableService | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The beat between the browser handing back and the grant being stored. Held
  // so nothing on the page claims an outcome while the exchange is still in the
  // air, and so the reader is not looking at a Connect button for a connection
  // that is halfway made.
  const [finishing, setFinishing] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const pendingReturn = useRef<ConnectionHandoff | null>(null);
  const hydration = useRef<Promise<PendingConnectionHandoff | null> | null>(null);
  const lifetime = useRef(new AbortController());

  // Same shape as the phone's: one controller per mounted signed-in screen, so
  // a reply that arrives after this account's screen is gone cannot navigate,
  // write state or answer for the next account. StrictMode's cleanup/setup
  // cycle aborts and then resumes the same instance, so it is rebuilt here.
  useEffect(() => {
    if (lifetime.current.signal.aborted) {
      lifetime.current = new AbortController();
      setBusy(false);
      setFinishing(false);
    }
    const controller = lifetime.current;
    return () => controller.abort();
  }, []);

  // The hand-off below leaves `busy` set while the browser navigates to the
  // provider. Coming back with the Back button restores this component with
  // that flag intact, so Continue would sit disabled on "Opening…" forever.
  useRearmOnBack(useCallback(() => setBusy(false), []));

  const settleReturn = useCallback((pending: ConnectionHandoff, nextInventory: ConnectionInventory | null) => {
    if (lifetime.current.signal.aborted || pendingReturn.current !== pending || !nextInventory) return;
    const outcome = connectionHandoffOutcome(pending, nextInventory);
    if (outcome.kind === 'checking') return;
    if (outcome.kind === 'connected') {
      setAnnouncement(connectedAnnouncement(pending.service, outcome.accountLabel));
      setAnnouncedService(pending.service);
      setNotice(null);
      pendingReturn.current = null;
      if (pending.attemptId) void store.clear(pending.attemptId);
      return;
    }
    setAnnouncement(null);
    setAnnouncedService(null);
    setNotice(outcome.notice.message);
    // The attempt stays on record so Try again can re-read status. It never
    // repeats the completion request, which is single use.
  }, [store]);

  const refreshReturn = useCallback(async () => {
    const pending = pendingReturn.current;
    const nextInventory = await load();
    if (pending) settleReturn(pending, nextInventory);
  }, [load, settleReturn]);

  // Read back once per mount, and shared by both effects below so the store is
  // read once however the page was arrived at.
  const hydrate = useCallback(() => {
    if (!hydration.current) hydration.current = store.read();
    return hydration.current;
  }, [store]);

  // The provider bounced the browser back here. Read the outcome once, then
  // strip it out of the URL so a refresh does not re-announce a connection the
  // reader already saw, and so an authorization code cannot sit in the address
  // bar, in history, or in whatever the next link leaks as a referrer.
  useEffect(() => {
    const provider = searchParams.get('provider');
    // Composio's return carries no service id at all, only whether it went
    // through. Which service that refers to is answered by this account's own
    // record of what it started, never by the query string.
    const connected = searchParams.get('connected');
    if (!provider && !connected) return;
    const failure = searchParams.get('connection_error');
    const state = searchParams.get('connection_state');
    const code = searchParams.get('connection_code');
    // Before the await, or a re-render re-reads the same params and completes
    // the same flow twice. The second attempt would find it spent and report an
    // expired link over a connection that had just been made.
    setSearchParams({}, { replace: true });
    const signal = lifetime.current.signal;

    void (async () => {
      const record = await hydrate();
      if (signal.aborted) return;
      const saved = record && (!provider || record.serviceId === provider) ? record : null;
      const attemptId = saved?.attemptId;
      const withAttempt = attemptId ? { attemptId } : {};

      if (!provider) {
        // A Composio return. `connected=ok` is the broker's word for it and
        // proves nothing on its own, so the exact grant this account initiated
        // is looked for in a fresh authenticated read.
        const service = saved ? findConnectableService(saved.serviceId) : null;
        if (!service || saved?.backend !== 'composio') return;
        const outcome = connected === 'ok' ? {} : { outcome: 'failed' as const };
        pendingReturn.current = { service, kind: 'composio', connectedAccountId: saved.connectedAccountId, ...outcome, ...withAttempt };
        if (attemptId && connected !== 'ok') await store.recordReceipt(attemptId, { outcome: 'failed' });
        await refreshReturn();
        return;
      }

      const service = findConnectableService(provider);
      if (!service) return;
      // A record naming a different flow is somebody being walked back through
      // a link this account did not begin.
      if (saved && !failure && state && saved.state && saved.state !== state) return;

      if (failure || !state || !code) {
        // `connected=1` is the older broker, which linked the account in the
        // callback itself. Still honoured so a browser loading this build
        // against a Worker that has not been deployed yet is not told its
        // connection failed. It carries no account id, so only the owning
        // broker's fresh read can confirm it.
        pendingReturn.current = failure
          ? { service, kind: 'native', outcome: 'failed', code: failure, ...withAttempt }
          : connected === '1'
            ? (service.backend === 'composio'
              ? { service, kind: 'composio', connectedAccountId: null, ...withAttempt }
              : { service, kind: 'native', outcome: 'confirmed', ...withAttempt })
            : { service, kind: 'native', outcome: 'unconfirmed', ...withAttempt };
        if (attemptId && failure) await store.recordReceipt(attemptId, { outcome: 'failed', code: failure });
        await refreshReturn();
        return;
      }

      // The exchange may already have been sent before this tab was replaced.
      // Completion is single use, so a restored attempt that got that far
      // re-reads status rather than spending it again.
      if (saved?.completionSent) {
        pendingReturn.current = { service, kind: 'native', outcome: 'unconfirmed', ...withAttempt };
        await refreshReturn();
        return;
      }

      // The broker handed the code back rather than spending it, because only a
      // signed-in request can say which account is asking for the link. Nothing
      // is announced until that request answers.
      const pending: ConnectionHandoff = { service, kind: 'native', outcome: 'completing', ...withAttempt };
      pendingReturn.current = pending;
      setFinishing(true);
      // Written before the request leaves, not after it answers.
      if (attemptId) await store.markCompletionSent(attemptId);
      const result = await completeConnection(provider, state, code, { signal });
      if (signal.aborted || pendingReturn.current !== pending) return;
      const outcome = result.ok ? 'confirmed' as const
        : ['invalid_state', 'wrong_account', 'declined', 'unknown_provider', 'invalid_request'].includes(result.code) ? 'failed' as const
          : 'unconfirmed' as const;
      pendingReturn.current = { service, kind: 'native', outcome, ...(result.ok ? {} : { code: result.code }), ...withAttempt };
      if (attemptId) await store.recordReceipt(attemptId, { outcome, ...(result.ok ? {} : { code: result.code }) });
      await refreshReturn();
      if (!signal.aborted) setFinishing(false);
    })();
  }, [searchParams, setSearchParams, hydrate, refreshReturn, store]);

  // Arrived without a return in the URL, but this account had a hand-off in
  // flight: the tab was replaced, or the reader navigated back by hand. The
  // record can never revive a completion, only ask the broker where it stands.
  useEffect(() => {
    const signal = lifetime.current.signal;
    void (async () => {
      const record = await hydrate();
      if (signal.aborted || !record || pendingReturn.current) return;
      const handoff = restoredConnectionHandoff(record);
      if (!handoff) return;
      pendingReturn.current = handoff;
      await refreshReturn();
    })();
  }, [hydrate, refreshReturn]);

  const rows = useMemo(() => buildConnectionRows(inventory.states, available), [inventory.states, available]);
  const groups = useMemo(() => buildConnectionGroups(rows), [rows]);

  async function handOff(service: ConnectableService) {
    const signal = lifetime.current.signal;
    if (signal.aborted) return;
    setBusy(true);
    // Cleared here, not only on failure, or a second attempt sits under the
    // previous attempt's failure and reads as though it had failed again.
    setSheetError(null);
    setNotice(null);
    setAnnouncement(null);
    setAnnouncedService(null);
    pendingReturn.current = null;
    hydration.current = Promise.resolve(null);
    // A new hand-off retires the old one on disk too. Left behind, a previous
    // service's record would be answered for as though this reader had just
    // come back from it.
    await store.clear();
    const result = service.backend === 'composio'
      ? await startComposioConnection(service.id, { signal })
      : await startConnection(service.id, { signal });
    if (signal.aborted) return;
    if (!result.ok) {
      setBusy(false);
      setSheetError(result.message);
      return;
    }
    const state = service.backend === 'native' ? new URL(result.authorizeUrl).searchParams.get('state') : null;
    if ((service.backend === 'native' && !state) || (service.backend === 'composio' && !result.connectedAccountId)) {
      setBusy(false);
      setSheetError('We could not prepare that connection. Try again in a moment.');
      return;
    }
    // Before the navigation, and awaited. Leaving this page is exactly the
    // moment every mounted reference stops existing.
    const attemptId = newConnectionAttemptId();
    await store.start({ attemptId, serviceId: service.id, backend: service.backend,
      state, connectedAccountId: result.connectedAccountId ?? null });
    hydration.current = null;
    if (signal.aborted) return;
    // Busy deliberately stays set. Clearing it first re-arms Continue for the
    // whole page-unload window, which on a slow connection is seconds, and a
    // second press there mints a second authorize URL with a second state. Only
    // one navigation wins, so the provider can come back carrying the state
    // record that lost, which surfaces as "that connection link had expired"
    // to someone who did nothing wrong. Plan and billing already guards its
    // hand-off this way; this is the one that did not.
    //
    // A full-page navigation, not a popup: the provider's consent screen is
    // where the reader signs in, and it has to be unmistakably their own
    // browser showing their own address bar, not a window we drew.
    window.location.assign(result.authorizeUrl);
  }

  async function confirmDisconnect() {
    if (!disconnecting) return;
    const signal = lifetime.current.signal;
    if (signal.aborted) return;
    const target = disconnecting;
    setBusy(true);
    setRowError(null);
    pendingReturn.current = null;
    hydration.current = Promise.resolve(null);
    void store.clear();
    const result = target.backend === 'composio'
      ? await disconnectComposioService(target.id, { signal })
      : await disconnectConnection(target.id, { signal });

    // A refusal that lands after this account's screen is gone must not reopen
    // a dialog or write a row error into the next account's page.
    if (signal.aborted) return;
    setBusy(false);
    setDisconnecting(null);
    if (!result.ok) {
      setRowError({ id: target.id, message: result.message });
      return;
    }
    setAnnouncement(null);
    setAnnouncedService(null);
    setNotice(null);
    await load();
  }

  return (
    <Screen title="Connections" subtitle="Accounts your coworker can use on your behalf.">
      {error ? (
        <Notice tone="danger">
          {error}
          {/* refreshReturn rather than a plain read: a read that failed is also
              the read a hand-off is waiting on, and the phone's retry already
              settles both. Reading alone left a return unanswered until
              something else happened to re-render the page. */}
          <button
            className="btn-secondary mt-3 flex w-full justify-center"
            type="button"
            disabled={loading}
            onClick={() => { void refreshReturn(); }}
            data-testid="connections.retry"
          >
            {CONNECTIONS_RETRY_LABEL}
          </button>
        </Notice>
      ) : null}
      {finishing ? (
        <div data-testid="connections.finishing">
          <Spinner label={CONNECTIONS_FINISHING_LABEL} />
        </div>
      ) : null}
      {notice ? (
        <Notice tone="danger">
          <span data-testid="connections.notice">{notice}</span>
          {/* Reading status again is the whole of this button. It never repeats
              the completion request, which the broker will only honour once. */}
          {!error && pendingReturn.current ? (
            <button
              className="btn-secondary mt-3 flex w-full justify-center"
              type="button"
              disabled={loading || finishing}
              onClick={() => { void refreshReturn(); }}
              data-testid="connections.returnRetry"
            >
              {CONNECTIONS_RETRY_LABEL}
            </button>
          ) : null}
        </Notice>
      ) : null}

      {announcement ? (
        <article className="card mb-4 border-accent p-4" data-testid="connections.announcement">
          <p className="text-caption text-textSecondary">Your coworker</p>
          <p className="mt-1 text-body text-textPrimary">{announcement}</p>
          <Link className="btn-primary mt-4 inline-flex" to="/chat">
            {announcedService ? firstPromptLabel(announcedService) : 'Open chat'}
          </Link>
        </article>
      ) : null}

      {loading ? <Spinner label="Loading your connections…" /> : null}
      {groups.map((group) => (
          <section key={group.category} className="mb-6">
            <h2 className="mb-2 text-caption uppercase tracking-wide text-textSecondary">{group.label}</h2>
            {group.rows.map((row) => (
              <ConnectionCard
                key={row.service.id}
                row={row}
                error={rowError?.id === row.service.id ? rowError.message : null}
                onSetUp={() => {
                  // This used to clear the page-level notice too. Pressing
                  // Connect on any card does not resolve a read the broker
                  // never answered, and clearing that line took away both the
                  // account of what we know and the retry attached to it.
                  setSheetError(null);
                  setReviewing(row.service);
                }}
                onDisconnect={() => setDisconnecting(row.service)}
              />
            ))}
          </section>
        ))}

      {loading ? null : (
        <p className="text-body-sm text-textSecondary" data-testid="connections.moreComing">
          {CONNECTIONS_MORE_COMING_NOTE}
        </p>
      )}

      <p className="mt-6 text-body-sm text-textSecondary">{CONNECTIONS_CUSTODY_NOTE}</p>

      {reviewing ? (
        <SafetySheet
          service={reviewing}
          busy={busy}
          error={sheetError}
          onCancel={() => {
            setReviewing(null);
            setSheetError(null);
          }}
          onContinue={() => void handOff(reviewing)}
        />
      ) : null}

      {disconnecting ? (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.name}?`}
          message="Your coworker will lose access straight away. You can reconnect any time."
          confirmLabel="Disconnect"
          destructive
          busy={busy}
          onConfirm={() => void confirmDisconnect()}
          onCancel={() => setDisconnecting(null)}
        />
      ) : null}
    </Screen>
  );
}

/**
 * A full-screen dialog backdrop that can always be scrolled back to the top.
 *
 * 2026-07-28 (Alex): the safety sheet was unreadable in the browser on a short
 * window. The backdrop was itself the flex container, so a sheet taller than
 * the viewport overflowed a fixed-height box in BOTH directions, and no browser
 * will scroll above a scroll container's own top edge: the first paragraph of a
 * consent screen was simply unreachable. The scroller has to be a plain block
 * (this outer div) with the centring flex box inside it at min-h-full, so the
 * flex box grows with its content instead of overflowing, and scrolling starts
 * at the top. Centring still happens whenever the sheet is short enough.
 */
function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/30">
      <div className="flex min-h-full items-end justify-center p-4 sm:items-center">{children}</div>
    </div>
  );
}

/**
 * The provider's own mark. Drawn from the shared catalogue's path data, so the
 * phone draws the identical shape, and unmodified in the provider's own colour.
 * Hidden from screen readers because the service name sits right beside it and
 * hearing it twice tells the listener nothing new.
 */
function BrandMarkGlyph({ mark, size = 20 }: { mark: BrandMark; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.viewBox}
      fill={mark.color}
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d={mark.path} />
    </svg>
  );
}

/**
 * The one screen where we ask for real access to somebody's account. It cannot
 * be skipped: pressing Connect opens this, and the only way to the provider is
 * the button at the bottom, after the permissions and the risk have been on
 * screen. Every word comes from the shared catalogue so the phone shows the
 * same sheet.
 */
function SafetySheet({
  service,
  busy,
  error,
  onCancel,
  onContinue,
}: {
  service: ConnectableService;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onContinue: () => void;
}) {
  return (
    <Overlay>
      <div
        className="card w-full max-w-md p-5"
        role="dialog"
        aria-modal="true"
        aria-label={`Connect ${service.name}`}
        data-testid="connections.safetySheet"
      >
        <div className="flex items-center gap-2">
          {service.brandMark ? <BrandMarkGlyph mark={service.brandMark} size={22} /> : null}
          <p className="text-body font-medium text-textPrimary">Connect {service.name}</p>
        </div>
        <p className="mt-1 text-body-sm text-textSecondary">{service.blurb}</p>

        <p className="mt-5 text-caption uppercase tracking-wide text-textSecondary">What it will be able to do</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-body-sm text-textPrimary">
          {service.capabilities.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <p className="mt-5 text-caption uppercase tracking-wide text-textSecondary">What you are granting</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-body-sm text-textPrimary">
          {service.permissions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        {service.safety.map((statement) => (
          <div key={statement.heading} className="mt-5">
            <p className="text-body-sm font-medium text-textPrimary">{statement.heading}</p>
            <p className="mt-1 text-body-sm text-textSecondary">{statement.body}</p>
          </div>
        ))}

        <p className="mt-5 text-body-sm text-textSecondary">{handoffNotice(service)}</p>

        {error ? (
          <p className="mt-3 text-body-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex gap-2">
          <button className="btn-secondary flex-1" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary flex-1"
            type="button"
            onClick={onContinue}
            disabled={busy}
            data-testid="connections.continue"
          >
            {busy ? 'Opening…' : `Continue to ${service.name}`}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function ConnectionCard({
  row,
  error,
  onSetUp,
  onDisconnect,
}: {
  row: ConnectionRow;
  error: string | null;
  onSetUp: () => void;
  onDisconnect: () => void;
}) {
  const connected = row.status === 'connected';
  return (
    <article className="card mb-3 p-4">
      {/* The badge is short and the text is not, so on a narrow screen the badge
          drops to its own line rather than squeezing the description into a
          column three words wide. */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-[11rem] flex-1">
          <div className="flex items-center gap-2">
            {row.service.brandMark ? <BrandMarkGlyph mark={row.service.brandMark} /> : null}
            <p className="text-body font-medium text-textPrimary">{row.service.name}</p>
          </div>
          <p className="mt-0.5 text-body-sm text-textSecondary">{row.service.blurb}</p>
          {/* Wrapped, not clipped. This line is a sentence when the grant has
              lapsed ("Sign in to Slack again to reconnect."), and a one-line
              clip cut it to "Sign in to Sla…", the only instruction on the
              screen, unreadable. A long account name wraps too, which beats
              cutting it. Primary ink because this is the reader's own account,
              not a third line of the description above it. */}
          {row.detail ? <p className="mt-1 break-words text-body-sm text-textPrimary">{row.detail}</p> : null}
        </div>
        {/* No badge when nothing is connected, matching the phone: the Connect
            button below already says so, and the muted grey a "Not connected"
            chip wanted sits below the contrast floor. */}
        {connected ? (
          <span className="shrink-0 rounded-full bg-accentMuted px-2.5 py-1 text-caption text-accent">Connected</span>
        ) : row.status === 'needs_attention' ? (
          // The warning hue rides on the border so the text can stay dark
          // enough to read; warning as a text colour fails AA on this surface.
          <span className="shrink-0 rounded-full border border-warning px-2.5 py-1 text-caption text-textPrimary">
            Needs attention
          </span>
        ) : null}
      </div>

      <div className="mt-4 flex gap-2">
        <button className="btn-secondary flex-1" type="button" onClick={onSetUp}>
          {connected ? 'Reconnect' : 'Connect'}
        </button>
        {connected || row.status === 'needs_attention' ? (
          <button className="btn-danger flex-1" type="button" onClick={onDisconnect}>
            Disconnect
          </button>
        ) : null}
      </div>

      {/* Beneath the button that produced it, in the card for the account it
          happened to. */}
      {error ? (
        <p className="mt-3 text-body-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </article>
  );
}
