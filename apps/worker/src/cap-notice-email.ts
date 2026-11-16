// Cap-reached notification (2026-07-30). Alex exhausted his Studio token
// allowance on 2026-07-20 and got nothing: no email, no notification, just a
// banner in the app that he happened to see nine days later on the day his month
// rolled over. The two events looked like one bug because nobody told him about
// the first one.
//
// So the first time a user is denied in a billing period, email them: which cap,
// when it clears, and what they can do about it now. Once per cap kind per
// billing period, keyed off the auth user's app_metadata (no migration).
//
// Only caps the USER can act on are notified. `rate`, `concurrent` and
// `global_spend` are our problems, not theirs, and emailing a customer about our
// org-wide spend guard would be both confusing and a disclosure.
//
// Best-effort throughout: the user is already being denied, and a failure to
// send must never turn a 402 into a 500.

// Device-aware redirect, not a store URL. See the note in welcome-email.ts:
// this button used to send every customer to Google Play, including iPhone
// customers who cannot install from there.
import { GET_THE_APP_URL } from '@sidekick/shared';

export const CAP_NOTICE_EMAIL_FROM = 'Delegent AI <hello@example.com>';
export const CAP_NOTICE_EMAIL_REPLY_TO = 'support@example.com';

/** app_metadata key holding capKind -> the billing cycle we last notified for. */
export const CAP_NOTICE_METADATA_KEY = 'cap_notice_periods';

export type NotifiableCapKind = 'token' | 'storage' | 'voice';

const NOTIFIABLE_CAP_KINDS = new Set<string>(['token', 'storage', 'voice']);

export function isNotifiableCapKind(capKind: string): capKind is NotifiableCapKind {
  return NOTIFIABLE_CAP_KINDS.has(capKind);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "1 August 2026" — the same wording the receipt email uses. */
export function formatCapNoticeDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Have we already told this user about this cap in this billing period?
 *
 * The marker is the billing cycle start, not a boolean, so the notice naturally
 * re-arms on the next cycle without anything having to clear it.
 */
export function hasNotifiedCapThisPeriod(
  metadata: Record<string, unknown> | null | undefined,
  capKind: string,
  billingCycleStartIso: string,
): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const periods = (metadata as Record<string, unknown>)[CAP_NOTICE_METADATA_KEY];
  if (!periods || typeof periods !== 'object' || Array.isArray(periods)) return false;
  return (periods as Record<string, unknown>)[capKind] === billingCycleStartIso;
}

/** Merge the marker for this cap kind into an existing app_metadata object. */
export function withCapNoticeMarker(
  metadata: Record<string, unknown> | null | undefined,
  capKind: string,
  billingCycleStartIso: string,
): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
  const existing = base[CAP_NOTICE_METADATA_KEY];
  const periods = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {};
  periods[capKind] = billingCycleStartIso;
  base[CAP_NOTICE_METADATA_KEY] = periods;
  return base;
}

interface CapCopy {
  subject: string;
  headline: string;
  /** What ran out, in the user's language. No token counts, no byte counts. */
  body: string;
  /** What they can do right now. */
  action: string;
}

function capCopy(capKind: NotifiableCapKind, resetsOnLabel: string | null): CapCopy {
  const resets = resetsOnLabel
    ? `Your allowance refreshes on <strong style="color:#1C1A15;">${escapeHtml(resetsOnLabel)}</strong>, when your plan renews.`
    : 'Your allowance refreshes when your plan next renews.';

  if (capKind === 'storage') {
    return {
      subject: 'Your coworker has run out of space',
      headline: 'Your coworker is out of space.',
      body: `Your private cloud space is full, so your coworker cannot save anything new until there is room. Everything already saved is safe and untouched.`,
      action: 'You can free up room by deleting files you no longer need in Files, or move up a plan for more space. Both take a moment in the app under Manage plan.',
    };
  }
  if (capKind === 'voice') {
    return {
      subject: 'You have used this month’s voice minutes',
      headline: 'Your voice minutes are used up.',
      body: `You have used all the voice minutes included in your plan for this period. Typing still works exactly as normal, so nothing is blocked, you just cannot speak to your coworker until the allowance refreshes. ${resets}`,
      action: 'If you would rather not wait, moving up a plan adds minutes straight away. You can do that in the app under Manage plan.',
    };
  }
  return {
    subject: 'Your coworker has reached this month’s limit',
    headline: 'Your coworker has hit this month’s limit.',
    body: `Your plan includes a set amount of thinking each month and this period’s is now used up, so your coworker has to pause on new work. Nothing has been lost: your files, your chat history, and everything it has learned about how you work are all still there. ${resets}`,
    action: 'If you need it working again before then, moving up a plan lifts the limit immediately. You can do that in the app under Manage plan, and you keep everything as it is.',
  };
}

export interface CapNoticeEmailDetails {
  capKind: NotifiableCapKind;
  /** Billing cycle start, used as the once-per-period marker. */
  billingCycleStartIso: string;
  /** When the allowance refreshes. Null when we genuinely do not know. */
  resetsOnIso: string | null;
}

export function capNoticeSubject(details: CapNoticeEmailDetails): string {
  return capCopy(details.capKind, details.resetsOnIso ? formatCapNoticeDate(details.resetsOnIso) : null).subject;
}

export function renderCapNoticeEmailHtml(details: CapNoticeEmailDetails): string {
  const copy = capCopy(details.capKind, details.resetsOnIso ? formatCapNoticeDate(details.resetsOnIso) : null);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(copy.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#F0EEE7;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#F0EEE7;">${escapeHtml(copy.subject)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEE7;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #E5E2DA;border-radius:18px;overflow:hidden;">

        <tr><td align="center" style="padding:36px 32px 8px 32px;">
          <img src="https://delegentai.co.uk/app-icon.png" width="56" height="56" alt="Delegent AI" style="display:block;border-radius:14px;">
        </td></tr>
        <tr><td align="center" style="padding:0 32px 4px 32px;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:15px;color:#8a8577;letter-spacing:.3px;">Delegent AI</p>
        </td></tr>

        <tr><td align="center" style="padding:14px 40px 0 40px;">
          <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:400;font-size:29px;line-height:1.15;color:#1C1A15;">${escapeHtml(copy.headline)}</h1>
        </td></tr>

        <tr><td style="padding:20px 40px 0 40px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.62;color:#3a382f;">${copy.body}</p>
        </td></tr>

        <tr><td style="padding:18px 40px 0 40px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.62;color:#3a382f;">${copy.action}</p>
        </td></tr>

        <tr><td align="center" style="padding:26px 32px 0 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td align="center" style="border-radius:12px;background:#2A4A3A;">
              <a href="${GET_THE_APP_URL}" style="display:inline-block;padding:13px 26px;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">Open the app</a>
            </td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:26px 32px 0 32px;"><div style="border-top:1px solid #ECE9E1;"></div></td></tr>

        <tr><td align="center" style="padding:22px 32px 4px 32px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#8a8577;">Not sure what to do next? Reply to this email and a person will answer.</p>
        </td></tr>
        <tr><td align="center" style="padding:14px 32px 4px 32px;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:15px;color:#2A4A3A;">The Delegent AI Team</p>
          <p style="margin:6px 0 0 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;color:#a09b8d;"><a href="https://delegentai.co.uk" style="color:#a09b8d;text-decoration:none;">delegentai.co.uk</a></p>
        </td></tr>

        <tr><td align="center" style="padding:16px 40px 32px 40px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#b7b2a4;">You are receiving this because you have a paid Delegent AI plan and we would rather tell you than leave you guessing. Delegent AI, registered in England and Wales ().</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Reads the recipient + the once-per-period marker, and persists it after a send. */
export interface CapNoticeEmailStore {
  /** null = user not found. */
  getUser(userId: string): Promise<{ email: string | null; appMetadata: Record<string, unknown> } | null>;
  markNotified(userId: string, appMetadata: Record<string, unknown>): Promise<void>;
}

export interface MaybeSendCapNoticeInput {
  userId: string;
  capKind: string;
  billingCycleStartIso: string | null;
  resetsOnIso: string | null;
  store: CapNoticeEmailStore;
  /** Returns true on a successful send. Must not throw. */
  send: (to: string, subject: string, html: string) => Promise<boolean>;
  warn?: (message: string) => void;
}

/**
 * Tell the user, once per billing period, that they have hit a cap they can act
 * on. Best-effort: never rejects, so a caller can `ctx.waitUntil` it safely.
 */
export async function maybeSendCapNoticeEmail(input: MaybeSendCapNoticeInput): Promise<void> {
  const warn = input.warn ?? ((m: string) => console.warn(m));
  try {
    if (!isNotifiableCapKind(input.capKind)) return;
    const cycleStart = input.billingCycleStartIso?.trim();
    // Without a cycle we have no way to stop this repeating on every denial, and
    // a mail loop is worse than silence.
    if (!cycleStart) return;

    const user = await input.store.getUser(input.userId);
    if (!user) return;
    if (hasNotifiedCapThisPeriod(user.appMetadata, input.capKind, cycleStart)) return;
    if (!user.email || !user.email.includes('@')) return;

    const details: CapNoticeEmailDetails = {
      capKind: input.capKind,
      billingCycleStartIso: cycleStart,
      resetsOnIso: input.resetsOnIso,
    };
    const ok = await input.send(user.email, capNoticeSubject(details), renderCapNoticeEmailHtml(details));
    if (!ok) {
      warn(`[cap-notice] send failed capKind=${input.capKind} (will retry on the next denial)`);
      return;
    }
    await input.store.markNotified(input.userId, withCapNoticeMarker(user.appMetadata, input.capKind, cycleStart));
  } catch (err) {
    warn(`[cap-notice] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
