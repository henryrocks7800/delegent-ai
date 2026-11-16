import { useState } from 'react';
import { ACKNOWLEDGEMENT_TEXT, ACKNOWLEDGEMENT_VERSION } from '@sidekick/shared';
import { Notice } from '../../components/ui';
import { supabase } from '../../lib/supabase';
import { normalizeAgentName } from '../profile/profileApi';

// The needs_acknowledgement gate. Without this a user who signs up in a browser
// is stuck: the gate never clears, so no other screen is reachable. Calls the
// same `complete_mobile_onboarding` RPC the phone app calls.

const DEFAULT_AGENT_NAME = 'Nova';

export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const [agentName, setAgentName] = useState(DEFAULT_AGENT_NAME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const name = normalizeAgentName(agentName);
    if (!name) {
      setError('Give your coworker a name with at least one letter.');
      return;
    }
    if (!supabase) {
      setError('Sign in again, then finish setting up.');
      return;
    }

    setError(null);
    setBusy(true);
    const { error: rpcError } = await supabase.rpc('complete_mobile_onboarding', {
      p_agent_name: name,
      p_acknowledgement_text_version: ACKNOWLEDGEMENT_VERSION,
    });
    setBusy(false);

    if (rpcError) {
      setError('We could not save that. Try again in a moment.');
      return;
    }
    onDone();
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10">
      <p className="font-brand text-display-lg italic text-textPrimary">Delegent AI</p>
      <h1 className="mt-4 text-display-md text-textPrimary">Name your coworker</h1>
      <p className="mt-1 text-body-sm text-textSecondary">
        This is what they answer to in chat. You can change it later in Profile.
      </p>

      {error ? (
        <div className="mt-4">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}

      <label className="label mt-5" htmlFor="onboarding-agent-name">
        Their name
      </label>
      <input
        id="onboarding-agent-name"
        className="field"
        value={agentName}
        maxLength={40}
        autoComplete="off"
        autoCapitalize="words"
        onChange={(event) => setAgentName(event.target.value)}
      />

      <p className="mt-6 text-body-sm leading-relaxed text-textSecondary">{ACKNOWLEDGEMENT_TEXT}</p>

      <button className="btn-primary mt-5 w-full" type="button" onClick={() => void submit()} disabled={busy}>
        {busy ? 'Saving…' : 'Agree and continue'}
      </button>
    </main>
  );
}
