import { useEffect, useRef, useState } from 'react';
import { mountGoogleButton, type GoogleButtonHandle } from './googleIdentity';
import { sendSignInCode, signInWithGoogle, signInWithGoogleCredential, verifySignInCode } from './useAuth';

type Stage = { name: 'email' } | { name: 'code'; email: string };

// Supabase rate-limits sign-in emails, and the phone already stops the reader
// walking into that with a countdown on the resend control. Same number here.
const RESEND_COOLDOWN_SECONDS = 30;

export function SignIn({ message }: { message?: string }) {
  const [stage, setStage] = useState<Stage>({ name: 'email' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(message ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [googleMode, setGoogleMode] = useState<'pending' | 'google' | 'redirect'>('pending');
  const codeInput = useRef<HTMLInputElement>(null);
  const googleSlot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => seconds - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  // Google's own button, drawn by Google inside our page. If it cannot be
  // reached we fall back to the redirect rather than dropping the option.
  useEffect(() => {
    const container = googleSlot.current;
    if (stage.name !== 'email' || !container) return;

    let cancelled = false;
    let handle: GoogleButtonHandle | null = null;

    void mountGoogleButton(container, (idToken) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      void signInWithGoogleCredential(idToken).then((result) => {
        // On success useAuth's subscription swaps the whole tree, so there is
        // nothing to reset here.
        if (result.ok) return;
        setBusy(false);
        setError(result.message);
      });
    }).then((mounted) => {
      if (cancelled) {
        mounted?.dispose();
        return;
      }
      handle = mounted;
      setGoogleMode(mounted ? 'google' : 'redirect');
    });

    return () => {
      cancelled = true;
      handle?.dispose();
    };
  }, [stage.name]);

  async function submitEmail(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await sendSignInCode(email);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setStage({ name: 'code', email: result.email });
    setNotice(`We sent an eight-digit code to ${result.email}.`);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    // The input only exists after this render, so focus on the next frame.
    requestAnimationFrame(() => codeInput.current?.focus());
  }

  async function useGoogle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await signInWithGoogle();
    // On success the browser is already leaving for Google, so nothing here
    // needs to clear busy; on failure the reader has to be able to try again.
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
    }
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (busy || stage.name !== 'code') return;
    setBusy(true);
    setError(null);
    const result = await verifySignInCode(stage.email, code);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // useAuth's onAuthStateChange subscription swaps the whole tree; nothing
    // to do here.
  }

  async function resend() {
    if (busy || cooldown > 0 || stage.name !== 'code') return;
    setBusy(true);
    setError(null);
    const result = await sendSignInCode(stage.email);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNotice(`We sent a new code to ${stage.email}.`);
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="mb-8 text-center">
        <p className="font-brand text-display-lg italic text-textPrimary">Delegent AI</p>
        <p className="mt-2 text-body text-textSecondary">Sign in to reach your coworker.</p>
      </div>

      <div className="card p-5">
        {stage.name === 'email' ? (
          <form onSubmit={submitEmail} noValidate>
            <label className="label" htmlFor="signin-email">
              Email address
            </label>
            <input
              id="signin-email"
              className="field"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy}
            />
            <button className="btn-primary mt-4 w-full" type="submit" disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Send sign-in code'}
            </button>

            <div className="my-4 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-border" />
              <span className="text-body-sm text-textSecondary">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            {/* Most people already signed in on the phone with Google, and the
                account is keyed on the email address, so this lands on the same
                workspace rather than starting a second one. */}
            <div className="mx-auto w-full max-w-[400px]">
              <div ref={googleSlot} className="flex justify-center" />
              {googleMode === 'redirect' ? (
                <button className="btn-secondary w-full" type="button" onClick={useGoogle} disabled={busy}>
                  <GoogleMark />
                  Continue with Google
                </button>
              ) : null}
              {/* Hold the space while Google's script arrives, so the card does
                  not jump under a thumb that is already reaching for it. */}
              {googleMode === 'pending' ? <div className="h-11" aria-hidden="true" /> : null}
            </div>
          </form>
        ) : (
          <form onSubmit={submitCode} noValidate>
            <label className="label" htmlFor="signin-code">
              Eight-digit code
            </label>
            <input
              id="signin-code"
              ref={codeInput}
              className="field text-center tracking-[0.4em]"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              placeholder="00000000"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={busy}
            />
            <button className="btn-primary mt-4 w-full" type="submit" disabled={busy || code.trim().length < 8}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            {/* Full-height hit areas: these read as quiet text links but they
                are the way out when the code never arrives, so they have to be
                as easy to hit with a thumb as the button above them. */}
            <div className="mt-1 flex items-center justify-between">
              <button
                className="inline-flex min-h-[44px] items-center text-body-sm text-textSecondary underline underline-offset-2"
                type="button"
                onClick={resend}
                disabled={busy || cooldown > 0}
              >
                {cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
              </button>
              <button
                className="inline-flex min-h-[44px] items-center text-body-sm text-textSecondary underline underline-offset-2"
                type="button"
                onClick={() => {
                  setStage({ name: 'email' });
                  setCode('');
                  setError(null);
                  setNotice(null);
                }}
                disabled={busy}
              >
                Use a different email
              </button>
            </div>
          </form>
        )}

        {notice && !error ? (
          <p className="mt-4 text-body-sm text-textSecondary" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="mt-4 text-body-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <p className="mt-6 text-center text-body-sm text-textSecondary">
        Same account as the Delegent AI app on your phone.
      </p>
    </main>
  );
}

// Google's brand guidelines require their own mark on the button, at its own
// colours, so this is inline rather than tinted with currentColor.
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
