// Error + crash monitoring for the mobile app (Sentry `delegent-mobile` project).
//
// Gated on EXPO_PUBLIC_SENTRY_DSN: when the DSN is absent the SDK never
// initialises and `wrapWithSentry` is a pure pass-through, so this module is
// completely inert and the app behaves exactly as before. The DSN is a
// write-only ingest key (it can only send events, never read data), so it is
// safe to embed in the shipped APK. Full integration runbook: docs/SENTRY.md.
import * as Sentry from '@sentry/react-native';
import { generatedExpoPublicEnv } from '../auth/generatedExpoPublicEnv';

// Read from the build-time-generated public-env module first (the path the
// release build reliably populates), with process.env as the dev fallback - the
// same pattern publicSupabase.ts uses. Reading ONLY process.env left Sentry inert
// in the shipped APK because the release bundle does not inline
// process.env.EXPO_PUBLIC_* the way the generated module is populated.
const pub = generatedExpoPublicEnv as {
  EXPO_PUBLIC_SENTRY_DSN?: string;
  EXPO_PUBLIC_SENTRY_ENVIRONMENT?: string;
};
const dsn = (pub.EXPO_PUBLIC_SENTRY_DSN || process.env.EXPO_PUBLIC_SENTRY_DSN || '').trim();

export const sentryEnabled = dsn.length > 0;

if (sentryEnabled) {
  Sentry.init({
    dsn,
    // Lean MVP config: capture crashes + unhandled errors only. No performance
    // tracing and no session replay, so we stay well within the free plan and
    // never sample user interactions or screen content.
    tracesSampleRate: 0,
    // Never attach IP address or other PII to events.
    sendDefaultPii: false,
    environment: (pub.EXPO_PUBLIC_SENTRY_ENVIRONMENT || process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || 'production').trim() || 'production',
  });
}

// The chat runs in a WebView, and an exception raised inside it never reaches
// the native crash reporter: the document catches it and posts it out. This is
// the receiving end.
//
// The text arrives already truncated by the sender, but it is still a string we
// did not compose. A failure while parsing an init message can quote the input
// it choked on, and init carries the access token, so any long token-shaped run
// is removed before the event leaves the device.
export function reportChatFrameError(stage: string, message: string): void {
  const scrubbed = message.replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]').slice(0, 500);
  if (!sentryEnabled) {
    console.warn(`[chat-frame] ${stage}: ${scrubbed}`);
    return;
  }
  Sentry.captureMessage(`chat frame error (${stage})`, {
    level: 'error',
    tags: { surface: 'chat-webview', stage },
    extra: { message: scrubbed },
  });
}

/**
 * A sign-in failure, reported so it can be diagnosed WITHOUT the user catching
 * a message on screen.
 *
 * WHY THIS EXISTS. Sign in with Apple failed for Alex on every attempt
 * (2026-08-13) and the whole investigation stalled for hours, because an Apple
 * sheet failure never reaches Supabase (so there is no server log) and this
 * app reported it to the login screen and nowhere else. He was asked, more
 * than once, to read red text that vanished before he could. Sentry was
 * capturing chat-frame errors and native module crashes throughout; auth was
 * simply never wired into it.
 *
 * PII: the provider and the provider's own failure code only. Never the email,
 * the identity token, or anything from the session. The code is bounded
 * because it originates outside our control.
 */
export function reportAuthFailure(provider: string, code: string, stage: string): void {
  // The scrub must require a DIGIT. The first version redacted any run of 20+
  // word characters, which swallowed `ERR_REQUEST_CANCELED` (exactly 20) and
  // destroyed the only evidence of Dan's failure on 2026-08-13, while Alex's
  // `ERR_REQUEST_UNKNOWN` (19) survived by one character. Provider error codes
  // are SCREAMING_SNAKE words; tokens, JWTs and ids essentially always carry
  // digits. Requiring one keeps secrets out without eating the diagnosis.
  const safeCode = String(code)
    .replace(/[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/g, (run) => (run.length >= 20 ? '[redacted]' : run))
    .slice(0, 120);
  if (!sentryEnabled) {
    console.warn(`[auth] ${provider} ${stage}: ${safeCode}`);
    return;
  }
  Sentry.captureMessage(`auth failure (${provider})`, {
    level: 'error',
    tags: { surface: 'auth', provider, stage },
    extra: { code: safeCode },
  });
}

/**
 * What StoreKit actually told the paywall about the trial offer.
 *
 * WHY THIS EXISTS. On 2026-09-12 the iOS paywall showed no trial while Apple's
 * purchase sheet offered one, and nothing on the box could say which of the
 * three reads had come back short: the product fetch, the offer fields on the
 * product, or the eligibility check. The read swallows every failure by design
 * (the sheet is the real price confirmation), so the only evidence was a photo
 * of the phone. This is the missing evidence: one info event per paywall open
 * on iOS, carrying only the offer shape and the eligibility verdict.
 *
 * PII: none. Product ids are our own SKUs, the price is the public store price
 * for the storefront, and eligibility is a boolean. No account, no receipt.
 */
export function reportAppleOfferRead(outcome: string, fields: Record<string, string | boolean | number | null>): void {
  if (!sentryEnabled) {
    console.warn(`[apple-offer] ${outcome}`, fields);
    return;
  }
  Sentry.captureMessage(`apple offer read (${outcome})`, {
    level: 'info',
    tags: { surface: 'paywall', outcome },
    extra: fields,
  });
}

// Wrap the root component only when Sentry is enabled. When disabled this is a
// pure pass-through, so the rendered tree is byte-for-byte unchanged.
export function wrapWithSentry<C>(RootComponent: C): C {
  return sentryEnabled ? (Sentry.wrap(RootComponent as never) as C) : RootComponent;
}

export { Sentry };
