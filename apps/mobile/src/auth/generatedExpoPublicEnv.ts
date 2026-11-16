// This file is committed with empty public values for local type-checking.
// scripts/sidekick-mobile-fresh-emulator.sh temporarily rewrites it with
// EXPO_PUBLIC_* values from PUBLIC_ENV_FILE before Gradle release bundling,
// then restores this placeholder so live values are not committed.
// DO NOT COMMIT LIVE VALUES.
export const generatedExpoPublicEnv = {
  EXPO_PUBLIC_SUPABASE_URL: '',
  EXPO_PUBLIC_SUPABASE_ANON_KEY: '',
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: '',
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: '',
  EXPO_PUBLIC_SIDEKICK_API_BASE_URL: '',
  EXPO_PUBLIC_SENTRY_DSN: '',
  EXPO_PUBLIC_SENTRY_ENVIRONMENT: '',
  EXPO_PUBLIC_GA4_MEASUREMENT_ID: '',
  // 'iap' turns on StoreKit purchasing for iOS. ANYTHING ELSE, including empty,
  // means the Guideline 3.1.3(f) shape: no prices and no purchase path on iOS.
  // Empty is the correct default; see packages/shared/src/appleIap.ts.
  EXPO_PUBLIC_IOS_PURCHASE_MODE: '',
} as const;
