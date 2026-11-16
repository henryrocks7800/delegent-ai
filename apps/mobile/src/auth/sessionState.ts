import {
  resolveAuthSessionState,
  type AuthSessionState,
  type AuthSessionStatus,
} from '@sidekick/shared';
import { mobileSupabaseConfig } from './publicSupabase';

export const mobileAuthSessionState = resolveAuthSessionState({
  supabaseConfig: mobileSupabaseConfig,
  session: null,
  restoring: false,
  loading: false,
  error: null,
});

export type MobileAuthBoundaryTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export type MobileAuthBoundaryRow = {
  status: AuthSessionStatus;
  label: string;
  title: string;
  tone: MobileAuthBoundaryTone;
  detail: string;
};

export type MobileAuthSessionCopy = {
  badge: string;
  title: 'Profile sign-in';
  stateLabel: string;
  summary: string;
  detail: string;
  sessionStorage: string;
  previewData: 'Preview data stays separate until Google sign-in is switched on.';
};

function signInSetupDetail(state: AuthSessionState) {
  return state.supabaseReady
    ? 'Continue with Google, choose an account, then return to Delegent AI.'
    : 'Continue with Google will use the standard Google account screen.';
}

export const mobileAuthBoundaryRows = [
  {
    status: 'loading',
    label: 'Checking',
    title: 'Looking for an existing sign-in',
    tone: 'neutral',
    detail: 'Delegent AI will check whether a Google account is already connected before showing private profile details.',
  },
  {
    status: 'signed_out',
    label: 'Not signed in',
    title: 'Ready for the Google button',
    tone: 'neutral',
    detail: 'This is the safe state before a real Google account has been connected.',
  },
  {
    status: 'authenticated',
    label: 'Signed in',
    title: 'Profile details available',
    tone: 'neutral',
    detail: 'This state appears only after Google returns a real account name, email, and avatar.',
  },
  {
    status: 'error',
    label: 'Try again',
    title: 'Sign-in needs attention',
    tone: 'neutral',
    detail: 'If the Google screen is cancelled or fails, Delegent AI will ask the user to try again instead of showing sample details.',
  },
] as const satisfies readonly MobileAuthBoundaryRow[];

export function getMobileAuthSessionCopy(state: AuthSessionState = mobileAuthSessionState): MobileAuthSessionCopy {
  const sessionStorage = state.status === 'authenticated'
    ? 'Google profile details are available for this account.'
    : state.supabaseReady
    ? 'No Google account is connected yet.'
    : 'Google sign-in is still being connected.';

  if (state.status === 'loading') {
    return {
      badge: 'Checking sign-in',
      title: 'Profile sign-in',
      stateLabel: 'Checking',
      summary: 'Checking whether a Google account is already connected before showing profile details.',
      detail: signInSetupDetail(state),
      sessionStorage,
      previewData: 'Preview data stays separate until Google sign-in is switched on.',
    };
  }

  if (state.status === 'error') {
    return {
      badge: 'Sign-in needs attention',
      title: 'Profile sign-in',
      stateLabel: 'Try again',
      summary: 'Google sign-in needs another try. Preview data stays separate from real account details.',
      detail: `${state.error.message} ${sessionStorage}`,
      sessionStorage,
      previewData: 'Preview data stays separate until Google sign-in is switched on.',
    };
  }

  if (state.status === 'authenticated') {
    return {
      badge: 'Signed in',
      title: 'Profile sign-in',
      stateLabel: 'Signed in',
      summary: `Signed in as ${state.user.email}. Profile details can now come from Google.`,
      detail: sessionStorage,
      sessionStorage,
      previewData: 'Preview data stays separate until Google sign-in is switched on.',
    };
  }

  return {
    badge: 'Not signed in',
    title: 'Profile sign-in',
    stateLabel: 'Not signed in',
    summary: state.canStartOAuth
      ? 'Delegent AI is ready for the Google sign-in button to be connected.'
      : 'Google sign-in is not available yet.',
    detail: signInSetupDetail(state),
    sessionStorage,
    previewData: 'Preview data stays separate until Google sign-in is switched on.',
  };
}
