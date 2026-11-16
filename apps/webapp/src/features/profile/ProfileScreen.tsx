import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AGENT_PLAN, DELEGENT_EXPORT_SCOPE_NOTE, SIDEKICK_PLAN_TIERS, summariseBillingPeriod } from '@sidekick/shared';
import { Screen, Spinner } from '../../components/ui';
import { useCoworkerEngine } from '../../state/coworkerEngine';
import { useProductStateContext } from '../state/productStateContext';
import { requestAccountDeletion, requestAccountExport, updateProfile } from './profileApi';

export function ProfileScreen() {
  const { status, snapshot, refresh } = useProductStateContext();
  const profile = snapshot?.profile ?? null;
  const subscription = snapshot?.subscription ?? null;
  // On the agent engine the plan is "Delegent AI", whatever legacy tier the subscription row holds.
  const agentEngine = useCoworkerEngine() === 'agent';
  const planName = subscription?.tierId
    ? (agentEngine ? AGENT_PLAN.name : SIDEKICK_PLAN_TIERS.find((tier) => tier.id === subscription.tierId)?.name ?? null)
    : null;
  const billingPeriod = summariseBillingPeriod({
    cycleEndAtIso: subscription?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
  });

  const [displayName, setDisplayName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [region, setRegion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [deleteState, setDeleteState] = useState<
    { status: 'idle' | 'confirming' | 'sending' } | { status: 'requested' | 'error'; message: string }
  >({ status: 'idle' });
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  // Seed the form from the snapshot once it arrives. Keyed on the profile's
  // updatedAt so a save that changes the server value re-seeds, but ordinary
  // polling does not overwrite what the user is typing.
  useEffect(() => {
    if (!profile) return;
    setDisplayName(profile.fullName ?? '');
    setAgentName(profile.agentName ?? '');
    setRegion(profile.region ?? 'United Kingdom');
  }, [profile?.id, profile?.updatedAt]);

  // The phone has an edit mode: a save collapses these fields back to read-only
  // rows, and re-entering edit resets the outcome, so "Profile saved." can only
  // ever describe what is actually on screen. This page is always editable, so
  // the same rule has to be applied per keystroke instead. Without it the
  // confirmation stayed put while the reader carried on typing, so a page
  // holding an unsaved change told them it was safe, and leaving lost it.
  function edit(set: (value: string) => void) {
    return (event: React.ChangeEvent<HTMLInputElement>) => {
      setSaved(false);
      setError(null);
      set(event.target.value);
    };
  }

  async function save() {
    setError(null);
    setSaved(false);
    setBusy(true);
    const result = await updateProfile({ displayName, agentName, region });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSaved(true);
    refresh();
  }

  return (
    <Screen title="Profile" subtitle="Your name, your coworker’s name, and where you are based.">
      {status === 'loading' && !profile ? (
        <Spinner label="Loading your profile…" />
      ) : (
        <>
          <div className="card p-4">
            <label className="label" htmlFor="profile-email">
              Email
            </label>
            <input id="profile-email" className="field" value={profile?.email ?? ''} readOnly disabled />
            <p className="mt-1 text-body-sm text-textSecondary">
              This is the account you sign in with. To change it, email support@example.com.
            </p>

            <label className="label mt-4" htmlFor="profile-name">
              Your name
            </label>
            <input
              id="profile-name"
              className="field"
              value={displayName}
              maxLength={80}
              autoComplete="name"
              onChange={edit(setDisplayName)}
            />

            <label className="label mt-4" htmlFor="profile-agent">
              Your coworker’s name
            </label>
            <input
              id="profile-agent"
              className="field"
              value={agentName}
              maxLength={40}
              autoComplete="off"
              onChange={edit(setAgentName)}
            />
            <p className="mt-1 text-body-sm text-textSecondary">This is what your coworker answers to in chat.</p>

            <label className="label mt-4" htmlFor="profile-region">
              Where you are based
            </label>
            <input
              id="profile-region"
              className="field"
              value={region}
              maxLength={80}
              autoComplete="country-name"
              onChange={edit(setRegion)}
            />

            {/* Both of these used to sit at the top of the page, four fields
                above the button that produces them. On a phone the reader
                presses Save and sees nothing at all: not the failure, and not
                the confirmation that the change went through. */}
            {error ? (
              <p className="mt-5 text-body-sm text-danger" role="alert">
                {error}
              </p>
            ) : null}
            {saved ? (
              <p className="mt-5 text-body-sm text-accent" role="status">
                Saved.
              </p>
            ) : null}

            <button className="btn-primary mt-5 w-full" type="button" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>

          {/* The rollover date belongs on the page the reader opens to check
              their account, not only on the capacity page. The phone shows the
              same label, date, note and button. */}
          {billingPeriod ? (
            <div className="card mt-5 p-4" data-testid="profile.billingPeriod">
              <p className="text-caption uppercase tracking-wide text-textSecondary">Your plan</p>
              <dl className="mt-3">
                {planName ? (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-body-sm text-textSecondary">Plan</dt>
                    <dd className="text-body-sm text-textPrimary">{planName}</dd>
                  </div>
                ) : null}
                <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-border pt-2">
                  <dt className="text-body-sm text-textSecondary">{billingPeriod.label}</dt>
                  <dd className="text-body-sm text-textPrimary" data-testid="profile.billingPeriodValue">
                    {billingPeriod.value}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-body-sm text-textSecondary">{billingPeriod.note}</p>
              {billingPeriod.actionLabel ? (
                <Link className="btn-primary mt-4 flex w-full justify-center" to="/plan" data-testid="profile.resubscribe">
                  {billingPeriod.actionLabel}
                </Link>
              ) : (
                <Link className="btn-secondary mt-4 flex w-full justify-center" to="/plan">
                  Manage plan
                </Link>
              )}
            </div>
          ) : null}

          {/* Account deletion. Restored 2026-08-16 in step with the mobile
              control, so the two surfaces offer the same thing. It is a
              REQUEST: the endpoint schedules teardown within 24 hours rather
              than erasing on click, and the copy says so. */}
          <div className="mt-6 border-t border-border pt-6">
            <h2 className="text-title text-textPrimary">Your data</h2>
            <p className="mt-1 text-body-sm text-textSecondary">
              Take a copy of your data, or close your account entirely.
            </p>

            <button
              type="button"
              className="btn-secondary mt-4 mr-2"
              data-testid="profile.exportDataButton"
              disabled={exportBusy}
              onClick={() => {
                setExportBusy(true);
                setExportMessage(null);
                void requestAccountExport().then((result) => {
                  setExportBusy(false);
                  setExportMessage(result.ok ? `Downloaded ${result.fileName}.` : result.message);
                });
              }}
            >
              {exportBusy ? 'Preparing…' : 'Export my data'}
            </button>
            {/* Under the button, not inside the file. Somebody deciding
                whether to press it should not have to open a JSON bundle to
                find out what is and is not in it. */}
            <p className="mt-3 text-caption text-textSecondary" data-testid="profile.exportDataScope">
              {DELEGENT_EXPORT_SCOPE_NOTE}
            </p>
            {exportMessage ? (
              <p className="mt-3 text-body-sm text-textSecondary" data-testid="profile.exportDataMessage">
                {exportMessage}
              </p>
            ) : null}

            {deleteState.status === 'confirming' || deleteState.status === 'sending' ? (
              <div className="mt-4 rounded-2xl border border-border bg-surface p-4">
                <p className="text-body-sm text-textPrimary">We will start this within 24 hours. It cannot be undone.</p>
                <ul className="mt-2 list-disc pl-5 text-body-sm text-textSecondary">
                  <li>Your subscription ends and will not renew</li>
                  <li>Your private workspace is shut down and its files are destroyed</li>
                  <li>Your sign-in is removed, so you cannot log back in</li>
                </ul>
                <p className="mt-2 text-caption text-textSecondary">
                  We keep billing records where the law requires it. See the privacy policy.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {/* Keeping the account is the primary action, deliberately. */}
                  <button
                    type="button"
                    className="btn-primary"
                    data-testid="profile.deleteAccountCancel"
                    disabled={deleteState.status === 'sending'}
                    onClick={() => setDeleteState({ status: 'idle' })}
                  >
                    Keep my account
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    data-testid="profile.deleteAccountConfirm"
                    disabled={deleteState.status === 'sending'}
                    onClick={() => {
                      setDeleteState({ status: 'sending' });
                      void requestAccountDeletion().then((result) =>
                        setDeleteState(
                          result.ok
                            ? { status: 'requested', message: result.message }
                            : { status: 'error', message: result.message },
                        ),
                      );
                    }}
                  >
                    {deleteState.status === 'sending' ? 'Sending request…' : 'Yes, delete it'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn-secondary mt-4"
                data-testid="profile.deleteAccountButton"
                onClick={() => setDeleteState({ status: 'confirming' })}
              >
                Delete my account
              </button>
            )}

            {deleteState.status === 'requested' ? (
              <p className="mt-3 text-body-sm text-textSecondary" data-testid="profile.deleteAccountDone">
                {deleteState.message}
              </p>
            ) : null}
            {deleteState.status === 'error' ? (
              <p className="mt-3 text-body-sm text-warning" data-testid="profile.deleteAccountError">
                {deleteState.message}
              </p>
            ) : null}

            <p className="mt-4 text-body-sm text-textSecondary">
              You can also email admin@example.com from this address, including if you cannot sign in.
            </p>
          </div>
        </>
      )}
    </Screen>
  );
}
