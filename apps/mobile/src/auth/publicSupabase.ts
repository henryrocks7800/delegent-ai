import { DEFAULT_SUPABASE_AUTH_CALLBACK, resolvePublicSupabaseConfig } from '@sidekick/shared';

import { generatedExpoPublicEnv } from './generatedExpoPublicEnv';

declare const process: {
  env: Record<string, string | undefined>;
};

// Expo CLI statically inlines direct `process.env.EXPO_PUBLIC_*` member reads.
// Gradle release bundling can bypass that Expo dotenv path, so the release
// handoff script temporarily writes generatedExpoPublicEnv with the same public
// values before bundling. Keep the direct reads as the fallback for Expo CLI/dev.
const expoPublicSupabaseUrl =
  generatedExpoPublicEnv.EXPO_PUBLIC_SUPABASE_URL ||
  process.env.EXPO_PUBLIC_SUPABASE_URL;
const expoPublicSupabaseAnonKey =
  generatedExpoPublicEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const expoPublicGoogleWebClientId =
  generatedExpoPublicEnv.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
const expoPublicGoogleIosClientId =
  generatedExpoPublicEnv.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ||
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;

export const mobileSupabaseConfig = resolvePublicSupabaseConfig({
  supabaseUrl: expoPublicSupabaseUrl,
  supabaseAnonKey: expoPublicSupabaseAnonKey,
  redirectTo: DEFAULT_SUPABASE_AUTH_CALLBACK,
});

export const mobileGoogleWebClientId = expoPublicGoogleWebClientId?.trim() ?? '';

// iOS ONLY, and deliberately NOT part of `ready`. The google-signin library
// needs either an iosClientId or a GoogleService-Info.plist to start the flow
// on iOS, and this project ships neither a plist nor a checked-in ios/ dir.
// Android is unaffected and must not be blocked by its absence, so readiness
// stays keyed on the web client id alone.
export const mobileGoogleIosClientId = expoPublicGoogleIosClientId?.trim() ?? '';

export const mobileAuthConfig = {
  supabase: mobileSupabaseConfig,
  googleWebClientId: mobileGoogleWebClientId,
  googleIosClientId: mobileGoogleIosClientId,
  ready: mobileSupabaseConfig.ready && mobileGoogleWebClientId.length > 0,
  issues: [
    ...mobileSupabaseConfig.issues,
    ...(mobileGoogleWebClientId.length > 0 ? [] : ['missing_google_web_client_id' as const]),
  ],
} as const;

export const googleAuthSetupChecklist = [
  'Set EXPO_PUBLIC_SUPABASE_URL to the Supabase project URL.',
  'Set EXPO_PUBLIC_SUPABASE_ANON_KEY to the anon/public key only.',
  'Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID to the Google Web client ID.',
  'Enable Google provider in Supabase Auth.',
  'Set Google redirect to https://<project-ref>.supabase.co/auth/v1/callback.',
  `Allow the app callback ${DEFAULT_SUPABASE_AUTH_CALLBACK}.`,
] as const;

export function getAuthReadinessCopy(result = mobileAuthConfig) {
  if (result.ready) {
    return {
      badge: 'Ready to connect',
      title: 'Sign in with Google',
      body: 'Google sign-in is ready. Users choose a Google account, approve access, then return to Delegent AI.',
      detail: 'After sign-in, Delegent AI fills the profile with the Google name, email, and avatar returned by the account.',
      action: 'Continue with Google',
    };
  }

  return {
    badge: 'Needs setup',
    title: 'Sign in with Google',
    body: 'Google sign-in needs the public mobile values before it can open the real Google account screen.',
    detail: 'The finished flow is one tap: choose a Google account, approve, then see the profile details appear automatically.',
    action: 'Try again',
  };
}
