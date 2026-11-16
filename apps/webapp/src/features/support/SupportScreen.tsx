import { useState } from 'react';
import { Screen } from '../../components/ui';
import { apiFetch } from '../../lib/api';
import { useProductStateContext } from '../state/productStateContext';

// The web half of the phone's "Help & suggestions" destination, posting to the
// same /api/support/ticket the phone uses. The shared FAQ points every reader
// here, so without it that answer is wrong in a browser.
//
// Two doors, one inbox: a problem report and a feature idea, tagged so the team
// can triage them apart. The Worker attaches the account identity server-side,
// which is why nothing here sends an email address.

type TicketKind = 'issue' | 'suggestion';

export function SupportScreen() {
  const { snapshot } = useProductStateContext();
  const [kind, setKind] = useState<TicketKind>('issue');
  const [message, setMessage] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const isSuggestion = kind === 'suggestion';
  const replyTo = snapshot?.profile?.email?.trim() || 'your account email';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (state === 'sending' || message.trim().length < 5) return;
    setError(null);
    setState('sending');
    const result = await apiFetch('/api/support/ticket', { method: 'POST', body: { message: message.trim(), kind } });
    if (!result.ok) {
      setState('idle');
      setError(result.message);
      return;
    }
    setState('sent');
  }

  if (state === 'sent') {
    return (
      <Screen title="Help and suggestions">
        <article className="card p-4">
          <p className="text-title text-textPrimary">{isSuggestion ? 'Thanks for the idea.' : 'Got it. We are on it.'}</p>
          <p className="mt-2 text-body-sm text-textSecondary">
            {isSuggestion
              ? `Your suggestion is with the team. We read every one, and we will reply to ${replyTo} if we need more detail.`
              : `Your message is with the team, and we will reply to ${replyTo}. Most issues get a same-day response.`}
          </p>
          <button
            className="btn-secondary mt-5 w-full"
            type="button"
            onClick={() => {
              setMessage('');
              setState('idle');
            }}
          >
            Send another
          </button>
        </article>
      </Screen>
    );
  }

  return (
    <Screen title="Help and suggestions" subtitle="Report something that is not working, or ask for a feature.">
      <form onSubmit={submit}>
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={kind === 'issue' ? 'chip-on' : 'chip-off'}
            aria-pressed={kind === 'issue'}
            onClick={() => setKind('issue')}
          >
            Something is not working
          </button>
          <button
            type="button"
            className={isSuggestion ? 'chip-on' : 'chip-off'}
            aria-pressed={isSuggestion}
            onClick={() => setKind('suggestion')}
          >
            Suggest a feature
          </button>
        </div>

        <p className="mb-3 text-body-sm text-textSecondary">
          {isSuggestion
            ? 'Got an idea that would make your coworker better? Tell us what you would love it to do.'
            : 'Something not working, or just confusing? Tell us what happened and we will sort it out.'}
        </p>

        <label className="label" htmlFor="support-message">
          {isSuggestion ? 'Your idea' : 'What happened'}
        </label>
        <textarea
          id="support-message"
          className="field min-h-[132px]"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={isSuggestion ? 'I would love it if the app could…' : 'What went wrong, and what were you trying to do?'}
          maxLength={4000}
        />

        {/* Beside the button that produces it, the way the phone renders the
            same failure. At the top of the screen it sat above two chips, a
            paragraph, a label and a 132px box, so on a phone-width browser the
            reader pressed Send, the send failed, and the screen they were
            looking at did not change at all. */}
        {error ? (
          <p className="mt-4 text-body-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}

        <button className="btn-primary mt-4 w-full" type="submit" disabled={state === 'sending' || message.trim().length < 5}>
          {state === 'sending' ? 'Sending…' : isSuggestion ? 'Send suggestion' : 'Send report'}
        </button>
      </form>

      <p className="mt-6 text-body-sm text-textSecondary">
        You can also email support@example.com if you would rather write to us directly.
      </p>
    </Screen>
  );
}
