import { googleWebClientId } from '../../lib/env';

// Google Identity Services, drawn on our own page.
//
// The redirect flow this replaces sent the reader to <project>.supabase.co and
// back, so Google's account picker had to name that host: "to continue to
// your-project-ref.supabase.co". Readers reported it as looking like a
// phishing attempt, and no branding setting removes it, because Google names
// whatever host it is returning to. Getting the token here instead means the
// picker names our own origin, and it puts the browser on the same code path
// the phone already uses (apps/mobile/src/auth/googleSignIn.ts): take an ID
// token from Google, hand it straight to Supabase.
//
// No nonce, deliberately. The phone passes none and the project accepts that,
// so matching it keeps one behaviour across both surfaces rather than two.

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const LOAD_TIMEOUT_MS = 8_000;
// Google rejects a render wider than this.
const MAX_BUTTON_WIDTH = 400;

type GoogleIdApi = {
  initialize(config: {
    client_id: string;
    callback: (response: { credential?: string }) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
  }): void;
  renderButton(parent: HTMLElement, options: Record<string, unknown>): void;
};

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } };
  }
}

let loader: Promise<GoogleIdApi | null> | null = null;

function loadGoogleIdentity(): Promise<GoogleIdApi | null> {
  if (loader) return loader;
  loader = new Promise<GoogleIdApi | null>((resolve) => {
    const ready = window.google?.accounts?.id;
    if (ready) {
      resolve(ready);
      return;
    }

    // A content blocker, an offline tab or a corporate proxy can all stop this
    // script arriving, and a script that never loads fires neither onload nor
    // onerror. Time out instead, so the caller can fall back to the redirect
    // rather than leaving the reader with no Google option at all.
    const timer = window.setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      window.clearTimeout(timer);
      resolve(window.google?.accounts?.id ?? null);
    };
    script.onerror = () => {
      window.clearTimeout(timer);
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return loader;
}

function buttonWidth(container: HTMLElement): number {
  const measured = Math.round(container.getBoundingClientRect().width);
  return Math.max(200, Math.min(MAX_BUTTON_WIDTH, measured || MAX_BUTTON_WIDTH));
}

export type GoogleButtonHandle = { dispose(): void };

/**
 * Draw Google's button into `container`, or return null if Google is not
 * reachable. `onCredential` receives a Google ID token.
 */
export async function mountGoogleButton(
  container: HTMLElement,
  onCredential: (idToken: string) => void,
): Promise<GoogleButtonHandle | null> {
  if (!googleWebClientId) return null;

  const api = await loadGoogleIdentity();
  if (!api) return null;

  try {
    api.initialize({
      client_id: googleWebClientId,
      callback: (response) => {
        if (response.credential) onCredential(response.credential);
      },
      auto_select: false,
      cancel_on_tap_outside: true,
    });
  } catch {
    return null;
  }

  // Google bakes the width in at render time, so a rotation would otherwise
  // leave a button that no longer fits the card it sits in.
  let rendered = 0;
  const draw = () => {
    const width = buttonWidth(container);
    if (width === rendered) return;
    rendered = width;
    container.replaceChildren();
    api.renderButton(container, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'rectangular',
      logo_alignment: 'center',
      width,
    });
  };

  try {
    draw();
  } catch {
    return null;
  }

  window.addEventListener('resize', draw);
  return {
    dispose() {
      window.removeEventListener('resize', draw);
      container.replaceChildren();
    },
  };
}
