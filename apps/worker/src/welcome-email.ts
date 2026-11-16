// Welcome email (2026-07-18). When a brand-new customer completes Stripe
// Checkout (`checkout.session.completed`), we send them the branded onboarding
// email exactly once. Idempotency is keyed off the auth user's app_metadata
// (`welcome_email_sent_at`), so a Stripe redelivery, a re-subscribe, or two
// concurrent webhook deliveries can't double-send, and existing customers
// (who never re-fire `checkout.session.completed`) are never back-mailed.
//
// Strictly best-effort + fire-and-forget, exactly like
// maybeDispatchProvisionOnActivation: a failure here can NEVER affect the
// webhook response, billing, or provisioning. The copy mirrors the version
// Alex signed off (see /home/alex/delegent-legal/welcome_email.py, the
// throwaway sender used to preview it).

// The device-aware redirect, NOT a store URL. Android goes to Play, iPhone
// goes to the App Store, everyone else gets a page offering both plus the
// browser. Until 2026-08-31 all three "Open the app" buttons in the customer
// emails were hardcoded to Google Play, so an iPhone customer who had just
// paid was sent to a store they cannot install from.
import { GET_THE_APP_URL } from '@sidekick/shared';

export const WELCOME_EMAIL_FROM = 'The Delegent AI Team <hello@example.com>';
export const WELCOME_EMAIL_REPLY_TO = 'customer82@example.com';
// "Welcome to Delegent AI 👋"
export const WELCOME_EMAIL_SUBJECT = 'Welcome to Delegent AI \u{1F44B}';
// "Welcome back to Delegent AI 👋" — sent instead of the onboarding email when
// the checkout belongs to a RETURNING customer (2026-07-30 defect: a
// resubscriber whose account predated the welcome-email feature was greeted
// with "Welcome to Delegent AI" as if they had never been here).
export const WELCOME_BACK_EMAIL_SUBJECT = 'Welcome back to Delegent AI \u{1F44B}';

const PREHEADER = 'Your new AI coworker is ready. Here is how to get the most out of it.';
const WELCOME_BACK_PREHEADER = 'Your coworker is coming back online.';

function section(title: string, body: string): string {
  return `
      <tr><td style="padding:22px 32px 0 32px;">
        <p style="margin:0 0 6px 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#2A4A3A;letter-spacing:.2px;">${title}</p>
        <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.62;color:#3a382f;">${body}</p>
      </td></tr>`;
}

// The agent name is the one user-chosen string that reaches this HTML. Today's
// caller passes nothing (the default fills the slots), but the parameter exists
// to be personalised, and a name like "<img src=…>" must render as text.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render the welcome email HTML. `agentName` fills the "your coworker" slots. */
export function renderWelcomeEmailHtml(agentName: string): string {
  const AGENT = escapeHtml(agentName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Welcome to Delegent AI</title>
</head>
<body style="margin:0;padding:0;background:#F0EEE7;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#F0EEE7;">${PREHEADER}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEE7;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #E5E2DA;border-radius:18px;overflow:hidden;">

        <!-- Header -->
        <tr><td align="center" style="padding:36px 32px 8px 32px;">
          <img src="https://delegentai.co.uk/app-icon.png" width="56" height="56" alt="Delegent AI" style="display:block;border-radius:14px;">
        </td></tr>
        <tr><td align="center" style="padding:0 32px 4px 32px;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:15px;color:#8a8577;letter-spacing:.3px;">Delegent AI</p>
        </td></tr>

        <!-- Headline -->
        <tr><td align="center" style="padding:14px 40px 0 40px;">
          <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:400;font-size:30px;line-height:1.15;color:#1C1A15;">Welcome aboard.</h1>
        </td></tr>
        <tr><td align="center" style="padding:12px 44px 0 44px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#3a382f;">You have just hired an AI coworker. Not another chatbot, a colleague you can hand real work to. Here is how to get the best out of ${AGENT} from day one.</p>
        </td></tr>

        ${section('Just talk to it', 'Tell it what you need, by voice or by typing, the way you would brief a colleague. It gets to work in the background while you carry on, and the results land in your chat and your Files. No special commands, no prompt wizardry.')}
        ${section('Give it a little patience', 'Think of it like a brilliant new hire in their first week. The more you show it how you work, the sharper it gets. Upload your templates and manuals, tell it your do&rsquo;s and don&rsquo;ts, and correct it once, it remembers. A little patience early on pays off quickly.')}
        ${section('Treat it like a member of your team', 'Your coworker is a separate colleague, not you. Never give it the passwords to your own accounts, your email, your bank, your logins, exactly as you would not hand those to a new colleague on their first day.')}
        ${section('A few things it will always leave to you', 'By design, and for your safety, it cannot make payments, it cannot sign you up to new services, and it cannot create API keys. (An API key is simply the secure pass that lets your coworker connect to a service you have signed up for, you create it once on that service and hand it over.) Anything like that, it guides you through rather than doing it behind your back.')}
        ${section('When in doubt, just ask', 'Not sure how to get something done? Just ask. It will walk you through it step by step, what it needs from you, anything it needs to set up or install, and what happens next, before it does anything.')}

        <!-- CTA -->
        <tr><td align="center" style="padding:30px 32px 8px 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td align="center" style="border-radius:12px;background:#2A4A3A;">
              <a href="${GET_THE_APP_URL}" style="display:inline-block;padding:13px 26px;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">Open the app</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" style="padding:6px 40px 4px 40px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13.5px;line-height:1.55;color:#8a8577;">Tap the orb and just say what is on your plate. That is genuinely it.</p>
        </td></tr>
        <tr><td align="center" style="padding:10px 40px 0 40px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13.5px;line-height:1.55;color:#8a8577;">Prefer to look around on the web first? Visit <a href="https://delegentai.co.uk" style="color:#2A4A3A;font-weight:600;text-decoration:none;">delegentai.co.uk</a></p>
        </td></tr>

        <!-- Guides link -->
        <tr><td style="padding:24px 32px 0 32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F4EE;border:1px solid #ECE9E1;border-radius:12px;">
            <tr><td style="padding:15px 18px;">
              <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#3a382f;">New to working with an AI coworker? Our short guides walk you through the basics, and how it all works. <a href="https://delegentai.co.uk/guides" style="color:#2A4A3A;font-weight:600;text-decoration:none;white-space:nowrap;">Read the guides &rarr;</a></p>
            </td></tr>
          </table>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:26px 32px 0 32px;"><div style="border-top:1px solid #ECE9E1;"></div></td></tr>

        <!-- Footer signature -->
        <tr><td align="center" style="padding:22px 32px 4px 32px;">
          <img src="https://delegentai.co.uk/app-icon.png" width="30" height="30" alt="Delegent AI" style="display:block;border-radius:8px;margin:0 auto 8px auto;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:15px;color:#2A4A3A;">The Delegent AI Team</p>
          <p style="margin:6px 0 0 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;color:#a09b8d;"><a href="https://delegentai.co.uk" style="color:#a09b8d;text-decoration:none;">delegentai.co.uk</a></p>
        </td></tr>

        <tr><td align="center" style="padding:16px 40px 32px 40px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#b7b2a4;">You are receiving this because you signed up for Delegent AI. Delegent AI, registered in England and Wales ().</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Render the welcome-back email HTML for a returning customer.
 * `workspaceRetained` = their previous workspace volume is still held (they
 * resubscribed inside the retention window), so we can truthfully promise
 * continuity; otherwise the workspace starts fresh and the copy must not
 * claim their old files survived.
 */
export function renderWelcomeBackEmailHtml(agentName: string, workspaceRetained: boolean): string {
  const AGENT = escapeHtml(agentName);
  const continuity = workspaceRetained
    ? `Good news: ${AGENT} kept your files and everything you taught it. Your workspace is coming back online now, usually within a couple of minutes, and it will pick up right where you left off.`
    : `We are setting your workspace up fresh now. It is usually ready within a couple of minutes, and ${AGENT} will be ready to take work straight away.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Welcome back to Delegent AI</title>
</head>
<body style="margin:0;padding:0;background:#F0EEE7;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#F0EEE7;">${WELCOME_BACK_PREHEADER}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0EEE7;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #E5E2DA;border-radius:18px;overflow:hidden;">

        <!-- Header -->
        <tr><td align="center" style="padding:36px 32px 8px 32px;">
          <img src="https://delegentai.co.uk/app-icon.png" width="56" height="56" alt="Delegent AI" style="display:block;border-radius:14px;">
        </td></tr>
        <tr><td align="center" style="padding:0 32px 4px 32px;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:15px;color:#8a8577;letter-spacing:.3px;">Delegent AI</p>
        </td></tr>

        <!-- Headline -->
        <tr><td align="center" style="padding:14px 40px 0 40px;">
          <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:400;font-size:30px;line-height:1.15;color:#1C1A15;">Welcome back.</h1>
        </td></tr>
        <tr><td align="center" style="padding:12px 44px 0 44px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#3a382f;">It is really good to have you back. Your subscription is active again.</p>
        </td></tr>

        ${section('Your workspace', continuity)}
        ${section('Your receipt', 'Your payment receipt is on its way in a separate email, with the plan and the exact period it covers.')}

        <!-- CTA -->
        <tr><td align="center" style="padding:30px 32px 8px 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td align="center" style="border-radius:12px;background:#2A4A3A;">
              <a href="${GET_THE_APP_URL}" style="display:inline-block;padding:13px 26px;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">Open the app</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" style="padding:10px 40px 0 40px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13.5px;line-height:1.55;color:#8a8577;">Prefer the web? Visit <a href="https://delegentai.co.uk" style="color:#2A4A3A;font-weight:600;text-decoration:none;">delegentai.co.uk</a></p>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:26px 32px 0 32px;"><div style="border-top:1px solid #ECE9E1;"></div></td></tr>

        <!-- Footer signature -->
        <tr><td align="center" style="padding:22px 32px 4px 32px;">
          <img src="https://delegentai.co.uk/app-icon.png" width="30" height="30" alt="Delegent AI" style="display:block;border-radius:8px;margin:0 auto 8px auto;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:15px;color:#2A4A3A;">The Delegent AI Team</p>
          <p style="margin:6px 0 0 0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:13px;color:#a09b8d;"><a href="https://delegentai.co.uk" style="color:#a09b8d;text-decoration:none;">delegentai.co.uk</a></p>
        </td></tr>

        <tr><td align="center" style="padding:16px 40px 32px 40px;">
          <p style="margin:0;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.5;color:#b7b2a4;">You are receiving this because you resubscribed to Delegent AI. Delegent AI, registered in England and Wales ().</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Pull the Delegent user id out of a peeked checkout.session object. */
export function extractCheckoutUserId(session: Record<string, unknown> | null | undefined): string | null {
  if (!session || typeof session !== 'object') return null;
  const cri = session.client_reference_id;
  if (typeof cri === 'string' && cri.length > 0) return cri;
  const meta = session.metadata;
  if (meta && typeof meta === 'object') {
    const v = (meta as Record<string, unknown>).sidekickUserId;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/** A returning customer's workspace state at checkout time. */
export type WorkspaceHistory = 'none' | 'retained' | 'expired';

/** Looks up the recipient + whether they've already been welcomed. */
export interface WelcomeEmailUserStore {
  /** null = user not found. */
  getUser(userId: string): Promise<{ email: string | null; alreadySent: boolean; welcomeBackSessionIds?: string[] } | null>;
  /** Persist the once-per-account marker. */
  markSent(userId: string): Promise<void>;
  /**
   * 'none' = a genuinely new customer (send the onboarding email).
   * 'retained' / 'expired' = a returning customer (send the welcome-back
   * variant; 'retained' means their old workspace volume is still held so
   * the copy may promise continuity). Optional so legacy fakes keep working;
   * absent means 'none'.
   */
  getWorkspaceHistory?(userId: string): Promise<WorkspaceHistory>;
  /** Persist the per-checkout-session welcome-back marker (Stripe redelivers events). */
  markWelcomeBackSent?(userId: string, sessionId: string): Promise<void>;
}

export interface MaybeSendWelcomeEmailInput {
  responseOk: boolean;
  eventType: string;
  /** The peeked (already signature-verified upstream) checkout.session object. */
  session: Record<string, unknown> | null;
  store: WelcomeEmailUserStore;
  /** Returns true on a successful send. Must not throw. */
  send: (to: string, html: string, subject: string) => Promise<boolean>;
  /** Personalises the "your coworker" slots. Defaults to "your coworker". */
  agentName?: string;
  /** Diagnostic sink (defaults to console.warn). */
  warn?: (message: string) => void;
}

/**
 * Send the welcome email once, if this webhook was a fresh, successful
 * `checkout.session.completed`. Best-effort: every failure path is caught and
 * logged; this never rejects, so a caller can `ctx.waitUntil` it safely.
 */
export async function maybeSendWelcomeEmailOnCheckout(input: MaybeSendWelcomeEmailInput): Promise<void> {
  const warn = input.warn ?? ((m: string) => console.warn(m));
  try {
    if (!input.responseOk) return;
    if (input.eventType !== 'checkout.session.completed') return;

    const userId = extractCheckoutUserId(input.session);
    if (!userId) {
      warn('[welcome-email] skipped: no user id on checkout session');
      return;
    }

    const user = await input.store.getUser(userId);
    if (!user) {
      warn(`[welcome-email] skipped: user not found userId=${userId}`);
      return;
    }
    if (!user.email || !user.email.includes('@')) {
      warn(`[welcome-email] skipped: no usable email userId=${userId}`);
      return;
    }

    const agentName = input.agentName?.trim() || 'your coworker';
    const history: WorkspaceHistory =
      typeof input.store.getWorkspaceHistory === 'function'
        ? await input.store.getWorkspaceHistory(userId)
        : 'none';

    if (history !== 'none') {
      // Returning customer: greet them with "welcome back", never the
      // onboarding email (regardless of whether they were ever welcomed —
      // the 2026-07-30 resubscribe sent "Welcome to Delegent AI" to an
      // account that predated the welcome-email feature). Idempotency is
      // per checkout session, so a Stripe redelivery cannot double-send but
      // a genuine later resubscribe greets them again.
      const rawSessionId = input.session ? input.session.id : null;
      const sessionId = typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : null;
      if (sessionId && (user.welcomeBackSessionIds ?? []).includes(sessionId)) return;
      const html = renderWelcomeBackEmailHtml(agentName, history === 'retained');
      const ok = await input.send(user.email, html, WELCOME_BACK_EMAIL_SUBJECT);
      if (!ok) {
        warn(`[welcome-email] welcome-back send failed userId=${userId} (will retry on a future matching event)`);
        return;
      }
      if (sessionId && typeof input.store.markWelcomeBackSent === 'function') {
        await input.store.markWelcomeBackSent(userId, sessionId);
      }
      return;
    }

    if (user.alreadySent) return; // idempotent — already welcomed

    const html = renderWelcomeEmailHtml(agentName);
    const ok = await input.send(user.email, html, WELCOME_EMAIL_SUBJECT);
    if (!ok) {
      warn(`[welcome-email] send failed userId=${userId} (will retry on a future matching event)`);
      return;
    }
    await input.store.markSent(userId);
  } catch (err) {
    // Best-effort: a welcome email must never disturb billing/provisioning.
    warn(`[welcome-email] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
