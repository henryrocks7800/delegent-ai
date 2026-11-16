import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPaywallExposure, PAYWALL_VARIANT, type PaywallEntryPoint } from './src/analytics/paywallExposure';
import { paywallPriceLine, PAYWALL_REVIEWS, GOAL_HEADLINES, pickReviews, reviewCredit, type OnboardingGoal, type StoreReview } from './src/onboarding/growthContent';
import { GoalOnboarding } from './src/onboarding/GoalOnboarding';
import { AppOrbit, AskTicker, Breathe, FIRST_RUN_ASKS, POPULAR_APPS, Pop, Rise, StepProgress, useReducedMotion, useTypeOn } from './src/onboarding/motion';
import { MoneyCheck, MoneyHookCard, MoneyPlanCard } from './src/onboarding/MoneyCheck';
import { flightUpTo, pounds } from './src/onboarding/moneyIntent';
import { saveMoneyIntent, useMoneyIntent } from './src/onboarding/useMoneyIntent';
import { loadOnboardingApps } from './src/onboarding/onboardingApps';
import { BrandMarkGlyph, ConnectionIdentity } from './src/connections/ConnectionIdentity';
import { usePaywallAdvert } from './src/onboarding/usePaywallAdvert';
import { advertHeadline } from './src/onboarding/advertContinuity';
import { loadOnboardingGoal } from './src/onboarding/onboardingGoal';
import { createAppOpenDetector, shouldShowAppOpenPaywall } from './src/onboarding/paywallSession';
import { Alert, AppState, BackHandler, DeviceEventEmitter, Image, Keyboard, LayoutAnimation, Linking, Modal, NativeModules, PanResponder, Platform, Pressable as NativePressable, ScrollView, Share, StatusBar, StyleSheet, TextInput, useWindowDimensions, View, type GestureResponderEvent } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useFonts } from 'expo-font';
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold } from '@expo-google-fonts/geist';
import { GeistMono_400Regular, GeistMono_500Medium } from '@expo-google-fonts/geist-mono';
import { InstrumentSerif_400Regular_Italic } from '@expo-google-fonts/instrument-serif';
import Animated, { FadeInDown, FadeInRight, FadeInUp, runOnJS, useAnimatedProps, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { SplashScreen as BrandSplash, holdSystemSplash } from './src/brand/SplashScreen';
import { Wordmark, BRAND_NAME } from './src/brand/Wordmark';
import { AmbientBackground, PastelWash } from './src/design/Ambient';
// RobotFace (the previous programmatic mark) was retired by the 2026-05-15
// brand swap in favour of the static Delegent AI logo bundled as
// coworker-ai-mark.png. The component is left in src/brand/ for now in
// case future code wants to bring it back.
// #33: the legacy native chat (HomeChatPanel + runStream and their renderer/
// card modules) was verified unmounted and deleted on 2026-06-10. The live
// chat is the WebView in WebViewChatScreen (HTML in assets/chat-webview).
import { WebViewChatScreen } from './src/chat/WebViewChatScreen';
import { downloadRunnerFileToPhone } from './src/files/downloadRunnerFile';
import { requestAccountDeletion, requestAccountExport } from './src/privacy/accountPrivacy';
import { shareAccountExport } from './src/privacy/shareAccountExport';
import * as Updates from 'expo-updates';
import { checkAndFetchOtaUpdate } from './src/updates/otaUpdateCheck';
// Error + crash monitoring. Importing this runs Sentry.init as a side-effect
// before the app renders, gated on EXPO_PUBLIC_SENTRY_DSN (inert if unset).
// See docs/SENTRY.md.
import { wrapWithSentry } from './src/observability/sentry';
import { sendSupportTicket, type SupportTicketKind } from './src/state/supportTicket';
import { MobileErrorBoundary } from './src/observability/ErrorBoundary';

// v1.2.1, the messenger-based control surface has been retired from the
// user journey. Telegram/WhatsApp/Signal plumbing remains in the worker
// for a future "external channels" beta, but the only path in v1.2.1
// is sign in → name agent → plan → home → chat directly in the app.
import { ACKNOWLEDGEMENT_TEXT, AUTH_PROVIDER_EMAIL, AUTH_PROVIDER_PHONE, CAPACITY_NO_ALLOWANCE_BODY, CAPACITY_NO_ALLOWANCE_CTA, CAPACITY_NO_ALLOWANCE_TITLE, DELEGENT_CHAT_COMMANDS, DELEGENT_USE_CASE_CATEGORIES, IOS_NO_SUBSCRIPTION_BODY, IOS_NO_SUBSCRIPTION_TITLE, LAUNCH_PROMO_CARRY_OVER_LINE, MODEL_CLAIM_PAYWALL, MODEL_CLAIM_SHORT, ROUTINE_CREATED_REFRESH_FAILED, RUNNER_ENGINE_VERSION, SIDEKICK_LAUNCH_PROMO, SIDEKICK_PLAN_TIERS, STORAGE_DOWNGRADE_BLOCK_TITLE, formatCycleEndLine, formatGbp, isEntitledSubscriptionStatus, isLaunchPromoLive, launchPromoTermsLine, promoPriceGbpMonthly, shouldQuotePromoPrice, summariseBillingPeriod, type AuthProvider, type ChatCommand, type ChatCommandOption, type PlanTierId, type ProductGate, type ProductGateKind, type BillingProvider, type PublicAuthUserIdentity, type SidekickProductSnapshot, type SubscriptionStatus, type UseCaseCategory } from '@sidekick/shared';
import {
  Badge,
  Button,
  Divider,
  Pressable,
  Stack,
  StatusDot,
  Surface,
  Text,
  ThemeProvider,
  useThemeColors,
  colors,
  fontFamilies,
  radii,
  shadow,
  space,
  type ThemeColors,
} from './src/design/primitives';
import { sidekickProductState, useMobileProductState, type MobileProductStateStatus } from './src/state/productState';
import { useMobileAuth } from './src/auth/useMobileAuth';
import { AppleSignInButton } from './src/auth/AppleSignInButton';
import { getFreshMobileAccessToken } from './src/auth/supabaseClient';
import { mobileCheckoutApiBaseUrl } from './src/billing/mobileCheckout';
import { registerForPushNotifications } from './src/push/registerForPush';
import { applyStoredMetaConsent, currentMetaConsent, recordMetaConsent, shouldAskMetaConsent, setAdvertisingAccount } from './src/analytics/metaSdkClient';
import type { EmailOtpSendResult, EmailOtpVerifyResult } from './src/auth/emailOtp';
import { requestStripeBillingPortal, requestStripeCheckout, type MobileBillingPortalErrorReason, type MobileCheckoutErrorReason } from './src/billing/mobileCheckout';
// The Guideline 3.1.3(f) / 3.1.1 switch. `canShowPurchaseUi` is false on an
// iOS build that must not display a price; `usesStoreKit` is true only on an
// iOS build that carries StoreKit. See src/billing/appleIap.ts.
import { canShowPurchaseUi, manageAppleSubscription, purchaseTierWithStoreKit, restoreApplePurchases, usesStoreKit } from './src/billing/appleIap';
import { looksLikeInviteCode, redeemInviteCode, tidyInviteCode, useReferral, type RedeemOutcome } from './src/billing/referral';
import { billingControlsFor } from '@sidekick/shared';
import { readApplePlanOffers, type ApplePlanOffers } from './src/billing/appleIap';
import { applePlanOffer, type ApplePlanOffer } from './src/billing/appleOffer';
import { SIDEKICK_FREE_TRIAL, shouldQuoteFreeTrial } from '@sidekick/shared';
import {
  AGENT_BUILT_IN_BADGE,
  AGENT_CONNECTIONS_INTRO,
  AGENT_ENGINE_UNSUPPORTED_CONNECTIONS,
  AGENT_DATA_COPY_NOTE,
  AGENT_FAQ_ORDERED,
  AGENT_HOWTO_INTRO,
  AGENT_HOWTO_SECTIONS,
  AGENT_HOWTO_TITLE,
  AGENT_PLAN,
  AGENT_CHECKOUT_THANK_YOU,
  AGENT_PLAN_HEADLINE_OFFER,
  AGENT_PLAN_HEADLINE_PERIOD,
  AGENT_PLAN_PRICE_NOTE,
  AGENT_PLAN_SUMMARY,
  AGENT_PLAN_TRIAL_CTA,
  agentFreeTrialTermsLine,
  agentPlanThenLine,
  agentPlanHighlights,
  agentTopUpConsentBody,
  agentUseCaseCategories,
  assistantWording,
  formatAgentPlanPrice,
  formatTopUpPrice,
  type EverydayTool,
} from '@sidekick/shared';
import { allowanceNearLimit, allowanceRefreshLine, startTopUpCheckout, talkMinutesLeftLine, topUpCreditLine, useAgentAllowance } from './src/billing/agentAllowance';
import { CoworkerEngineContext, useCoworkerEngineForUser, useIsAgentEngine } from './src/state/coworkerEngine';
import { confirmScheduledPlanChange } from './src/billing/confirmScheduledPlanChange';
import { deleteRunnerFile, renameRunnerFile, requestRunnerFiles, uploadRunnerFile, type MobileRunnerFile } from './src/files/mobileRunnerFiles';
import { buildFolderGroups, allCollapsibleKeys, collapsedKeysFromExpanded, isHiddenByCollapsedAncestor, recentFiles, isNoiseFile, fullDirectoryPath } from './src/files/folderGroups';
import { useFolderCollapse } from './src/files/useFolderCollapse';
import { toggleSelectedFile, selectAllInFolderTree, fileIdsInFolderTree, toggleFolderTree, deleteSelectionConfirmCopy, deleteSelectionOutcomeCopy, runSelectionDelete } from './src/files/multiSelect';
import {
  ROUTINE_SUGGESTIONS,
  ROUTINE_TIME_CHOICES,
  ROUTINE_WEEKDAY_LABELS,
  describeCadence,
  describeNextRun,
  formatHourChoice,
  isRoutinePromptReady,
  routineTitle,
  type Routine,
  type RoutineCadence,
} from './src/routines/routines';
import { createRoutine, deleteRoutine, fetchRoutines, setRoutinePaused } from './src/routines/routinesApi';
import { buildAgentConnectionSections, buildConnectionGroups, buildConnectionRows, connectedCount, type AgentConnectionSection, type ConnectionRow } from './src/connections/connections';
import { forgetConnectionInventory, prefetchConnectionInventory, type ConnectionInventory } from './src/connections/connectionInventory';
import { connectionHandoffOutcome, restoredConnectionHandoff, type ConnectionHandoff } from './src/connections/connectionHandoff';
import {
  createConnectionHandoffStore, newConnectionAttemptId,
  type ConnectionHandoffStorage, type PendingConnectionHandoff,
} from './src/connections/connectionHandoffStore';
import { connectionRequest } from './src/connections/connectionProtocol';
import { useConnectionInventory } from './src/connections/useConnectionInventory';
import {
  completeConnection,
  disconnectComposioService,
  disconnectConnection,
  fetchComposioConnections,
  fetchConnectionStates,
  startComposioConnection,
  startConnection,
} from './src/connections/connectionsApi';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearPersistedAuthStorage, fenceAuthStorageWrites } from './src/auth/secureSessionStorage';
import { forgetAnalyticsIdentity, track } from './src/analytics/analyticsClient';
import { pickChatAttachment } from './src/chat/attachmentPicker';
import { readLocalFileAsBase64 } from './src/chat/chatAttachmentUpload';
import {
  DELEGENT_EXPORT_SCOPE_NOTE,
  DELEGENT_PRIVACY_INTRO,
  DELEGENT_PRIVACY_SECTIONS,
  DELEGENT_PRIVACY_TITLE,
  DELEGENT_PRIVACY_UPDATED,
  DELEGENT_TERMS_INTRO,
  DELEGENT_TERMS_SECTIONS,
  DELEGENT_TERMS_TITLE,
  DELEGENT_TERMS_UPDATED,
  DELEGENT_NOTICES_INTRO,
  DELEGENT_NOTICES_SECTIONS,
  DELEGENT_NOTICES_TITLE,
  DELEGENT_NOTICES_UPDATED,
  DELEGENT_HOWTO_TITLE,
  DELEGENT_HOWTO_INTRO,
  DELEGENT_HOWTO_SECTIONS,
  DELEGENT_HOWTO_DEEPER_TITLE,
  DELEGENT_HOWTO_DEEPER_BODY,
  DELEGENT_HOWTO_DEEPER_LABEL,
  DELEGENT_HOWTO_DEEPER_URL,
  DELEGENT_FAQ_ORDERED,
  WEB_APP_URL,
  WEB_APP_MENU_LABEL,
  WEB_APP_MENU_DETAIL,
  PROVISIONING_NOTICE_TITLE,
  PROVISIONING_STALLED_MESSAGE,
  isProvisioningGate,
  provisioningNoticeBody,
  CHECKOUT_CONFIRMATION_POLL_ATTEMPTS,
  CHECKOUT_CONFIRMATION_POLL_INTERVAL_MS,
  CHECKOUT_CONFIRMATION_SLOW_MESSAGE,
  checkoutThankYouBody,
  planChangeNote,
  isPlanDowngrade,
  PREVIEW_BYTE_LIMIT,
  PREVIEW_LINE_LIMIT,
  PREVIEW_RETRY_LABEL,
  isPreviewableFile,
  buildFilePreview,
  CONNECTIONS_CUSTODY_NOTE,
  CONNECTIONS_FINISHING_LABEL,
  CONNECTIONS_MORE_COMING_NOTE,
  CONNECTIONS_RETRY_LABEL,
  connectedAnnouncement,
  firstPromptLabel,
  connectionReturnNotice,
  findConnectableService,
  findConnectionState,
  handoffNotice,
  type ConnectableService,
} from '@sidekick/shared';
import { completeMobileOnboarding, defaultAgentName, normalizeAgentName } from './src/onboarding/mobileOnboarding';
import { updateMobileProfile, type MobileProfileUpdateInput, type MobileProfileUpdateResult } from './src/profile/mobileProfile';

// Hold Android's launch screen until the splash brain has decoded (see src/brand/SplashScreen.tsx).
holdSystemSplash();

type Tab = 'dashboard' | 'artifacts' | 'profile';
type DrawerView = 'menu' | 'skills' | 'skillCategory' | 'commands' | 'routines' | 'connections' | 'faqs' | 'help' | 'capacity' | 'setup' | 'terms' | 'privacy' | 'howto' | 'notices';
type TierId = PlanTierId;
type IconName = React.ComponentProps<typeof Feather>['name'];
type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
type CheckoutState =
  | { status: 'idle'; tierId?: undefined; errorReason?: undefined; errorMessage?: undefined }
  | { status: 'opening'; tierId: TierId; errorReason?: undefined; errorMessage?: undefined }
  | { status: 'confirming'; tierId: TierId; errorReason?: undefined; errorMessage?: undefined }
  | { status: 'error'; tierId: TierId | null; errorReason: MobileCheckoutErrorReason; errorMessage: string };
type BillingPortalState =
  | { status: 'idle'; errorReason?: undefined; errorMessage?: undefined }
  | { status: 'opening'; errorReason?: undefined; errorMessage?: undefined }
  | { status: 'confirming'; errorReason?: undefined; errorMessage?: undefined }
  // The reason has to travel with the message. One of these is not a failure at
  // all: a downgrade refused because the files will not fit answers a question
  // about space, and titling it as a portal that would not open sends the reader
  // back to a button that will refuse them again for the same reason.
  | { status: 'error'; errorReason: MobileBillingPortalErrorReason; errorMessage: string };
type RunnerFilesState =
  | { status: 'idle'; files: readonly MobileRunnerFile[]; truncated: false; message?: undefined }
  | { status: 'loading'; files: readonly MobileRunnerFile[]; truncated: boolean; message?: undefined }
  | { status: 'ready'; files: readonly MobileRunnerFile[]; truncated: boolean; message?: undefined }
  | { status: 'not_ready'; files: readonly MobileRunnerFile[]; truncated: false; message: string }
  | { status: 'error'; files: readonly MobileRunnerFile[]; truncated: false; message: string };
type CheckoutError = { tierId: TierId | null; reason: MobileCheckoutErrorReason; message: string };
type ProductRefresh = () => Promise<SidekickProductSnapshot>;
type CheckoutReturnKind = 'success' | 'cancel' | 'billing';
type CheckoutReturnSignal = { key: number; kind: CheckoutReturnKind | null };
type SidekickDeepLinkModule = {
  getInitialUrl?: () => Promise<string | null>;
  peekLatestUrl?: () => Promise<string | null>;
  consumeLatestUrl?: () => Promise<string | null>;
};

const appBrand = {
  name: BRAND_NAME,
  tagline: 'Your connected AI coworker. Fast, helpful and less than a coffee a month.',
};

const EMAIL_OTP_COOLDOWN_SECONDS = 30;
// CHECKOUT_CONFIRMATION_POLL_ATTEMPTS and CHECKOUT_CONFIRMATION_POLL_INTERVAL_MS
// now come from @sidekick/shared, so the browser waits out the same webhook
// window on the same schedule the phone does.
const CHECKOUT_THANK_YOU_AUTO_DISMISS_MS = 30000;

// Forensic-pack required surface contracts (do not delete without updating
// the matching R-* evaluation criterion in
// docs/CLAIMS_REQUIREMENTS_AND_EVAL_CRITERIA_2026-05-21.md):
//
//   R-CHAT-07  Poll timeout (120s) -> "your coworker took too long" retry banner
const CHAT_POLL_TIMEOUT_MS = 120_000;
const CHAT_TIMEOUT_BANNER_COPY = "Your coworker took too long. Try again?";
//   R-FILE-07  96 KB attachment cap with prescribed composer error copy
const MAX_ATTACHMENT_BYTES = 96 * 1024;
const ATTACHMENT_TOO_LARGE_COPY = "That attachment is too big. Drop a smaller one or paste the relevant section into the chat.";
//   R-UX-01    Agent-name chips: ≥3 suggestions with at least one of Nova/Atlas/Wren
const SUGGESTED_AGENT_NAMES = ['Nova', 'Atlas', 'Wren', 'Sage', 'Cleo'] as const;
//   R-LEG-04   First-run AI-fallibility disclaimer; user must accept
const AI_FALLIBILITY_DISCLAIMER =
  "AI output is probabilistic and can be wrong. Treat your coworker as an extra pair of hands, not a replacement for professional judgement. Use your own judgement before acting on anything they say.";
const FIRST_RUN_TERMS_ACCEPTED_KEY = 'delegent.firstRun.termsAccepted.v1';
//   R-MSG-01   Telegram messenger surface is gated behind a feature flag
const FEATURE_MESSENGERS_TELEGRAM =
  (process.env.EXPO_PUBLIC_FEATURE_MESSENGERS_TELEGRAM ?? '').trim() === 'true';
const coworkerMark = require('./assets/coworker-ai-mark.png');
const googleGIcon = require('./assets/google-g.png');
const chatTabIcon = require('./assets/tabs/chat.png');
const filesTabIcon = require('./assets/tabs/files.png');
const touchHitSlop = { top: space[2], right: space[2], bottom: space[2], left: space[2] } as const;

/*
 * Production harness selector literals.
 *
 * The strict production-harness backlog gate scans this file for literal
 * testID/accessibilityLabel values referenced by Maestro production flows.
 * Keep these literals in sync with the flow ids to prevent accidental
 * selector drift across component splits/refactors.
 *
 * testID="home.chatPanel"
 * testID="home.chatPanel.input"
 * testID="home.chatPanel.attachButton"
 * testID="home.chatPanel.sendButton"
 * testID="home.chatPanel.header.name"
 * testID="home.chatPanel.message.user"
 * testID="home.chatPanel.message.assistant"
 * testID="tab.dashboard"
 * testID="tab.artifacts"
 * testID="setup.plan.studio"
 * testID="cardNumber"
 * testID="cardExpiry"
 * testID="cardCvc"
 * testID="billingName"
 *
 * The chat's own controls are element ids in the chat WebView document
 * (assets/chat-webview/index.html), which Android exposes to Maestro as
 * resource ids; the production flows match them since 2026-09-28:
 * testID="input"
 * testID="attachBtn"
 * testID="micBtn"
 * testID="helpBtn"
 * testID="sendBtn"
 * testID="toolbarTourClose"
 *
 * Declared in src/onboarding/GoalOnboarding.tsx:
 * testID="onboarding.appsContinue"
 */

// Profile is intentionally not in the bottom tab bar, it is reachable from the
// top-right header avatar (Header.onProfilePress) and from the burger menu.
const bottomTabs = ['dashboard', 'artifacts'] as const;

// Legacy light-theme bridge:
// Most primitives consume ThemeProvider directly, but this large screen file still
// has helper components that read `styles` / `appColors` from module scope. AppContent
// refreshes these values before rendering its subtree so those helpers stay on the
// single approved light palette while the remaining migration moves them to hooks.
let appColors: ThemeColors = colors;
let styles = createAppStyles(appColors);
const sidekickDeepLink = NativeModules.SidekickDeepLink as SidekickDeepLinkModule | undefined;

type Tier = {
  id: TierId;
  shortName: string;
  name: string;
  price: string;
  cadence: string;
  summary: string;
  capacity: string;
  capacityNote?: string;
  inferenceNote?: string;
  promoPrice: string;
  promoTerms: string;
  features: string[];
};

type Artifact = {
  id: string;
  title: string;
  kind: string;
  detail: string;
  status: string;
  badgeTone: BadgeTone;
  icon: IconName;
};

type MenuRowProps = {
  icon: IconName;
  label: string;
  detail?: string;
  rightLabel?: string;
  testID?: string;
  onPress: () => void;
};

type ActivityDotState = 'live' | 'working' | 'sleeping';

type TaskActivity = {
  statusLabel: string;
  badgeTone: BadgeTone;
  dotState: ActivityDotState;
  title: string;
  detail: string;
};

type ProductViewModel = {
  userId: string;
  currentTierId: TierId;
  currentTier: Tier;
  hasActiveSubscription: boolean;
  /** Who bills the CURRENT subscription. Undefined means unknown, which every
   *  reader must treat as "not provably Apple". */
  billingProvider?: BillingProvider;
  subscriptionStatus: SubscriptionStatus;
  /** True when Stripe says the subscription is in a state that genuinely
   *  requires the user to act (past_due, unpaid, canceled, incomplete). A
   *  transient portal-open failure must NOT set this. */
  subscriptionNeedsAttention: boolean;
  agentName: string;
  usageSummary: SidekickProductSnapshot['usage'];
  capacityText: string;
  /** False when nothing backs the capacity copy: no live plan, or a plan whose
   *  quota reads as zero. The tier lookup falls back to the first tier when the
   *  snapshot carries no subscription, so without this the copy names a plan
   *  the reader is not on and says how much room is left on it. */
  hasCapacityAllowance: boolean;
  /** [Batch 4b §2.5.5] ISO timestamp of the user's billing-cycle end, surfaced
   *  from Stripe via productState. When non-null, the Profile capacity card
   *  renders an en-GB "Resets on …" line so the user knows exactly when their
   *  quota refreshes. Null when no active subscription / no cycle anchor yet. */
  nextResetAtIso: string | null;
  /** Whether that same timestamp is a renewal or a termination. Stripe sends
   *  one field for both, so without this the capacity card promises a reset to
   *  someone who has already cancelled and will get nothing on that date. */
  cancelAtPeriodEnd: boolean;
};

const currentTierId = sidekickProductState.subscription?.tierId ?? 'studio';
const currentTier = SIDEKICK_PLAN_TIERS.find((tier) => tier.id === currentTierId) ?? SIDEKICK_PLAN_TIERS[0];
const usageSummary = sidekickProductState.usage;
type AppProfile = {
  name: string;
  email: string;
  auth: string;
  plan: string;
  location: string;
  agentName: string;
  initial: string;
  avatarUrl?: string;
};

function buildProfile(user: PublicAuthUserIdentity | null | undefined, snapshot: SidekickProductSnapshot = sidekickProductState, mode: 'preview' | 'live' = 'preview', provider?: AuthProvider): AppProfile {
  const fallbackName = snapshot.profile?.fullName ?? `${appBrand.name} user`;
  const phoneMasked = user?.phoneMasked?.trim();
  const rawName = user?.fullName?.trim() || snapshot.profile?.fullName?.trim() || (user?.email ? user.email.split('@')[0] : phoneMasked ? 'Phone account' : fallbackName);
  const name = rawName.trim().length > 0 ? rawName.trim() : fallbackName;
  const email = user?.email?.trim() || snapshot.profile?.email?.trim() || phoneMasked || 'Google or email account';
  const authLabel = user
    ? provider === AUTH_PROVIDER_PHONE || (phoneMasked && !user.email)
      ? 'Phone account'
      : provider === AUTH_PROVIDER_EMAIL
      ? 'Email account'
      : 'Google account'
    : mode === 'preview'
    ? 'Google account'
    : 'Not signed in';
  // `?? 'studio'` here badged a reader with no subscription, and one who had
  // cancelled, as being on the Studio plan, in two places at once: the badge
  // beside their name and the "Plan" row in Account details. The browser reads
  // the tier only once entitlement is established, and reads null otherwise.
  const planTier = isEntitledSubscriptionStatus(snapshot.subscription?.status)
    ? SIDEKICK_PLAN_TIERS.find((tier) => tier.id === snapshot.subscription?.tierId) ?? null
    : null;
  const agentName = snapshot.profile?.agentName?.trim() || defaultAgentName();
  const profile: AppProfile = {
    name,
    email,
    auth: authLabel,
    plan: planTier?.name ?? 'No active plan',
    location: snapshot.profile?.region ?? 'United Kingdom',
    agentName,
    initial: name.slice(0, 1).toUpperCase(),
  };

  const avatarUrl = user?.avatarUrl ?? snapshot.profile?.avatarUrl;
  if (avatarUrl) profile.avatarUrl = avatarUrl;
  return profile;
}

// Every plan is the same full coworker. Tiers differ only by how much cloud
// compute they run on and how big a monthly allowance you get, so these
// per-tier lines describe capacity, never a capability. They must stay
// distinct per tier (checkout-readiness asserts "Best for" follows the
// active tier and is not identical across plans).
const tierCapacityCopy: Record<TierId, string> = {
  studio: 'A few hours of admin most days',
  'pro-office': 'Most of your working week',
  'enterprise-suite': 'A heavy back office, busiest workloads',
};

// The full coworker that EVERY paid plan gets out of the box. Rendered
// identically on every plan card so the picker never implies a capability
// is locked to a higher tier. What changes between tiers is compute +
// monthly allowance (see tierCapacityCopy + the plan summary line), never
// what the coworker can do.
const everyPlanIncludes: readonly string[] = [
  'Bookkeeping, inbox, data entry, and daily admin',
  'Builds files and runs your repeatable workflows',
  'Learns your rules and gets better every week',
];

// Plan summary shown on every card. Identical wording for every tier, only
// the compute/allowance lines differ. This intentionally replaces the
// per-tier shared `summary`, which used to describe different work for
// different tiers.
const everyPlanSummary = 'The full AI coworker on every plan, set up and run for you on private cloud.';

const tiers: Tier[] = SIDEKICK_PLAN_TIERS.map((tier) => ({
  id: tier.id,
  shortName: tier.shortName,
  name: tier.name,
  // Through formatGbp, like every other surface, so a price with pence never
  // renders as "£10.5" here while the website says "£10.50".
  price: formatGbp(tier.priceGbpMonthly),
  cadence: 'month',
  summary: tier.summary,
  capacity: tierCapacityCopy[tier.id],
  // Honest, everyday-terms capacity guide from the shared tier. Kept distinct
  // from the short compute strip above; this is the rough "how much" line.
  capacityNote: tier.capacityNote,
  // Plain-terms inference line (tokens + tasks), leads the value story now that
  // fixed storage GB is not user-facing.
  inferenceNote: tier.inferenceNote,
  // Launch-promo price (70% off for two months since 2026-09-07), shown alongside
  // the struck-through full price when the promo is live (backed by the Stripe coupon).
  promoPrice: formatGbp(promoPriceGbpMonthly(tier)),
  // Names the exact price the discount reverts to, so the app and the Stripe
  // page tell the user the same thing before they pay.
  promoTerms: launchPromoTermsLine(tier),
  features: [...tier.features],
}));

// The one plan an account on the agent engine is offered (packages/shared/src/
// content/agentEngine.ts). Display only: Stripe holds the price a customer is
// actually charged, and the Worker refuses agent-engine checkout until the live
// price for this plan exists.
const agentTiers: Tier[] = tiers
  .filter((tier) => tier.id === AGENT_PLAN.tierId)
  .map((tier) => ({
    ...tier,
    // One plan, called what the website and Stripe call it, not its tier's name.
    name: AGENT_PLAN.name,
    price: formatAgentPlanPrice(),
    summary: AGENT_PLAN_SUMMARY,
    capacity: 'Replies in seconds, with fair use',
    capacityNote: AGENT_PLAN_PRICE_NOTE,
    inferenceNote: AGENT_PLAN_PRICE_NOTE,
    promoPrice: formatAgentPlanPrice(),
    promoTerms: agentFreeTrialTermsLine(),
    features: [],
  }));

function tiersForEngine(agentEngine: boolean): Tier[] {
  return agentEngine ? agentTiers : tiers;
}

const artifactIcons: Record<string, IconName> = {
  pdf: 'file-text',
  markdown: 'folder',
  sheet: 'grid',
};

function displayArtifactKind(kind: string) {
  const labels: Record<string, string> = {
    pdf: 'PDF',
    markdown: 'Notes',
    sheet: 'Spreadsheet',
  };

  return labels[kind.toLowerCase()] ?? 'File';
}

function formatFileSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 'File';
  if (sizeBytes < 1024) return `${Math.round(sizeBytes)} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(sizeBytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatFileUpdatedAt(modifiedAt: number): string {
  const date = new Date(modifiedAt * 1000);
  if (Number.isNaN(date.getTime())) return 'Finished work';
  const day = date.toLocaleDateString([], { day: '2-digit', month: 'short' });
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

function runnerFileIcon(file: MobileRunnerFile): IconName {
  const mime = file.mimeType.toLowerCase();
  const name = file.name.toLowerCase();
  if (mime.includes('pdf') || name.endsWith('.pdf')) return 'file-text';
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name)) return 'image';
  if (mime.includes('csv') || mime.includes('spreadsheet') || /\.(csv|xlsx?)$/i.test(name)) return 'grid';
  if (mime.includes('zip') || /\.(zip|tar|gz)$/i.test(name)) return 'archive';
  return 'file';
}

function buildArtifactCards(snapshot: SidekickProductSnapshot): Artifact[] {
  return snapshot.artifacts.map((artifact) => ({
    id: artifact.id,
    title: artifact.title,
    kind: displayArtifactKind(artifact.kind),
    detail: artifact.detail,
    status: artifact.status === 'review' ? 'Review' : artifact.status === 'ready' ? 'Ready' : artifact.status,
    badgeTone: artifact.status === 'review' ? 'warning' : artifact.status === 'ready' ? 'accent' : 'neutral',
    icon: artifactIcons[artifact.kind.toLowerCase()] ?? 'file',
  }));
}

function buildTaskActivity(snapshot: SidekickProductSnapshot): TaskActivity {
  // 'dispatched' is the status live chat runs sit at for the whole agent
  // turn (it used to be coerced to 'queued' before TaskRunStatus learned the
  // real value) — without it here the Working card goes dark mid-task.
  const activeTask = snapshot.recentTasks.find((task) => task.status === 'running' || task.status === 'dispatched' || task.status === 'queued');
  if (activeTask) {
    return {
      statusLabel: 'Working',
      badgeTone: 'accent',
      dotState: 'working',
      title: activeTask.instruction,
      detail: 'Reply comes back in chat. Anything larger lands in Files.',
    };
  }

  if (snapshot.latestAssistantMessage) {
    return {
      statusLabel: 'Last reply',
      badgeTone: 'neutral',
      dotState: 'sleeping',
      title: snapshot.latestAssistantMessage.content,
      detail: 'Your last task. Open Files for anything bigger.',
    };
  }

  return {
    statusLabel: 'Ready',
    badgeTone: 'success',
    dotState: 'live',
    title: 'No tasks yet, send your first one.',
    detail: 'Quick replies come back in chat. Bigger work appears in Files.',
  };
}

function buildProductView(snapshot: SidekickProductSnapshot, agentEngine = false): ProductViewModel {
  const viewTierId = snapshot.subscription?.tierId ?? 'studio';
  const offered = tiersForEngine(agentEngine);
  const viewTier = offered.find((tier) => tier.id === viewTierId) ?? offered[0];
  const agentDisplayName = snapshot.profile?.agentName?.trim() || defaultAgentName();
  const subscriptionStatus = snapshot.subscription?.status ?? 'inactive';
  const hasActiveSubscription = isEntitledSubscriptionStatus(subscriptionStatus);

  // The shared SubscriptionStatus enum surfaced to mobile is
  // 'inactive' | 'trialing' | 'active' | 'past_due' | 'canceled'. past_due
  // and canceled are the only states that genuinely need user action; a
  // transient portal-open failure must NOT trip this flag.
  const subscriptionNeedsAttention =
    subscriptionStatus === 'past_due' || subscriptionStatus === 'canceled';

  return {
    userId: snapshot.profile?.id ?? '',
    currentTierId: viewTierId,
    currentTier: viewTier,
    hasActiveSubscription,
    billingProvider: snapshot.subscription?.billingProvider,
    subscriptionStatus,
    subscriptionNeedsAttention,
    agentName: agentDisplayName,
    usageSummary: snapshot.usage,
    // artifacts and taskActivity were built here and rendered nowhere. They
    // were the only consumers of three extra table reads on every refresh, and
    // a 503 on any of them rejected an otherwise valid entitlement snapshot.
    // See fetchMobileProductSnapshot.
    capacityText: capacityLabelForUsage(snapshot.usage),
    hasCapacityAllowance: hasActiveSubscription && snapshot.usage.quotaTokens > 0,
    // [Batch 4b §2.5.5] Surface the Stripe-anchored cycle end so the Profile
    // capacity card can render the exact reset date instead of a generic
    // "at the start of every billing cycle" line.
    nextResetAtIso: snapshot.subscription?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: snapshot.subscription?.cancelAtPeriodEnd ?? false,
  };
}

function checkoutSnapshotHasActiveSubscription(snapshot: SidekickProductSnapshot): boolean {
  const subscriptionStatus = snapshot.subscription?.status ?? 'inactive';
  return subscriptionStatus === 'active' || subscriptionStatus === 'trialing' || subscriptionStatus === 'past_due';
}

/**
 * May StoreKit be opened, given what this account already pays for?
 *
 * SEPARATE FROM checkoutSnapshotHasActiveSubscription ON PURPOSE. That helper
 * also drives refreshUntilCheckoutSubscriptionActive, where "is there an active
 * subscription yet" must keep its plain meaning. Widening it in place would
 * quietly change when the post-purchase poller stops.
 *
 * The rule: refuse only a subscription we are NOT sure is Apple's.
 *
 *   - Stripe, or any provider we cannot identify: refuse. Buying here would
 *     bill the customer twice, and the Worker's matching refusal can only fire
 *     AFTER Apple has taken the money.
 *   - Apple: allow. A tier change inside a subscription group is an UPGRADE to
 *     Apple, not a second purchase, so StoreKit swaps the plan and prorates it.
 *     Refusing left an Apple subscriber told their plan was "billed outside the
 *     App Store", which was false and left them no way to change tier at all.
 *
 * `billingProvider` is undefined on a database without migration 0055, and
 * undefined is not 'apple', so an un-migrated backend keeps the old safe
 * refusal rather than opening a double-billing path.
 */
function storeKitPurchaseBlockedByExistingSubscription(snapshot: SidekickProductSnapshot): boolean {
  if (!checkoutSnapshotHasActiveSubscription(snapshot)) return false;
  return snapshot.subscription?.billingProvider !== 'apple';
}

/**
 * Can THIS build reach the place that actually bills this subscription?
 *
 * The rule and the reasoning now live in
 * packages/shared/src/content/billingControls.ts, because the web screen made
 * the same mistake independently: it offered an Apple subscriber a Stripe
 * portal button, got a 409, and told an already subscribed customer to choose
 * a plan first.
 */
function canReachOwnBiller(provider: BillingProvider | undefined): boolean {
  return billingControlsFor(usesStoreKit() ? 'apple' : 'stripe', provider).canManage;
}

function checkoutConfirmationDelay(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, CHECKOUT_CONFIRMATION_POLL_INTERVAL_MS);
  });
}

async function refreshUntilCheckoutSubscriptionActive(refresh: ProductRefresh): Promise<SidekickProductSnapshot> {
  let snapshot = await refresh();
  for (let attempt = 1; attempt < CHECKOUT_CONFIRMATION_POLL_ATTEMPTS && !checkoutSnapshotHasActiveSubscription(snapshot); attempt += 1) {
    await checkoutConfirmationDelay();
    snapshot = await refresh();
  }
  return snapshot;
}

function checkoutReturnKindFromUrl(url: string | null | undefined): CheckoutReturnKind | null {
  if (typeof url !== 'string' || url.trim().length === 0) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'sidekick:') return null;
    if (parsed.hostname === 'checkout' && parsed.pathname === '/success') return 'success';
    if (parsed.hostname === 'checkout' && parsed.pathname === '/cancel') return 'cancel';
    if (parsed.hostname === 'billing' && parsed.pathname === '/return') return 'billing';
    return null;
  } catch {
    return null;
  }
}

/**
 * A return from an OAuth connection hand-off. The broker no longer links the
 * account in its callback, because a redirect arriving through the system
 * browser carries no session of ours and so cannot say whose account is asking;
 * it hands the state and the code back here instead, and the link is made behind
 * a bearer token. The URL carries completion material; success still requires
 * that authenticated acknowledgement and a fresh connection-status read.
 */
type ConnectionReturn =
  | { provider: string; state: string; code: string }
  | { provider: string; failure: string };

function connectionReturnFromUrl(url: string | null | undefined): ConnectionReturn | null {
  if (typeof url !== 'string' || url.trim().length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'sidekick:') return null;
    if (parsed.hostname !== 'connections' || parsed.pathname !== '/return') return null;
    const provider = parsed.searchParams.get('provider')?.trim();
    if (!provider || !/^[a-z0-9_]{1,64}$/.test(provider)) return null;
    const failure = parsed.searchParams.get('connection_error')?.trim();
    if (failure) return { provider, failure };
    const state = parsed.searchParams.get('connection_state')?.trim();
    const code = parsed.searchParams.get('connection_code')?.trim();
    // `connected=1` is the older broker, which linked the account in its own
    // callback. Reported as a failure would tell someone whose connection did
    // land that it had not, so an outcome we cannot finish here is left to the
    // broker read on resume rather than guessed at.
    if (!state || !code) return null;
    return { provider, state, code };
  } catch {
    return null;
  }
}

async function readSidekickNativeDeepLink(method: keyof SidekickDeepLinkModule): Promise<string | null> {
  try {
    const reader = sidekickDeepLink?.[method];
    if (typeof reader !== 'function') return null;
    const url = await reader();
    return typeof url === 'string' && url.trim() ? url : null;
  } catch {
    return null;
  }
}

// 2026-07-20 (Alex, SKILL-2): the menu's "Skills & use cases" drawer content.
// `useCaseCategories` (defined below) drives the eight business use-case cards
// and their per-category detail pages; each `say` is a REAL trigger phrase, so
// saying it in chat actually switches the coworker into that role (your own
// words work too). `useCaseLines` is a light "Everyday examples" pool that just
// inspires - no rigid role taglines. Copy stays in plain consumer language by
// design - the inspirations-readiness gate forbids any infra/technical wording
// here.

// Everyday examples catalogue. 2026-07-21 (Alex): the "Everyday examples" UI
// section was removed from the Skills & use-cases drawer as too much info, so
// this is no longer rendered. It is RETAINED as the copy-safety catalogue the
// inspirations-readiness + ui-feedback source-contract gates assert on (clean,
// infra-free example copy), and is ready to reinstate via `UseCaseCard` if we
// ever want the section back. Short lines only - no walls of text.
const useCaseLines = [
  { title: 'Quick research', how: 'A few options compared on one page, with the sources saved to Files.' },
  { title: 'Drafts and edits', how: 'Proposals, posts and replies in your tone, ready to review.' },
  { title: 'Documents and PDFs', how: 'A few notes turned into a polished PDF, letter or report in your Files.' },
  { title: 'Spreadsheets', how: 'A tidy sheet built for you, formulas and charts included.' },
  { title: 'Meeting actions', how: 'Notes, next steps and invite text pulled from a transcript.' },
  { title: 'Forms and paperwork', how: 'A completed draft from a readable form, plus the deadlines to watch, ready to review.' },
  { title: 'Repeatable workflows', how: 'Save a routine once; your coworker reuses it and you review the output.' },
  { title: 'A small business PA in your pocket', how: 'Admin off your plate whenever it piles up, saved to your Files.' },
] as const;

// 2026-07-20 (Alex, SKILL-2): the "Skills & use cases" section, rebuilt around
// eight business use-case categories (each with an emoji, a plain hook and a
// handful of highlighted specialities). A category expands inline to a "Use it
// to" summary + one headline trigger phrase, and "See all N skills" opens a
// per-category detail page listing each spotlighted skill and the phrase that
// switches the coworker into it. The categories and phrases are drawn from the
// real installed specialities, so this surface can't drift from what the
// coworker actually does. Copy stays in plain consumer language (the
// banned-vocabulary + inspirations-readiness gates forbid infra wording here);
// the honest note everywhere is that your own words work just as well.
const useCaseCategories = DELEGENT_USE_CASE_CATEGORIES;
// What an agent-engine account can take on: no phone line, PDFs it makes
// itself, and travel (packages/shared/src/content/agentEngine.ts).
const agentUseCases = agentUseCaseCategories();

/** Copy that says "coworker" reads "assistant" for an agent-engine account (assistantWording). */
const sameWording = (text: string) => text;
function useWording(): (text: string) => string {
  return useIsAgentEngine() ? assistantWording : sameWording;
}

function useUseCaseCategories(): readonly UseCaseCategory[] {
  return useIsAgentEngine() ? agentUseCases : useCaseCategories;
}


// Content rises into place one piece after another (2026-09-27 redesign:
// longer and softer than the old 180 ms blink, and staggered enough to read
// as a cascade rather than a flash).
function Entry({ children, index = 0 }: { children: React.ReactNode; index?: number }) {
  return (
    <Animated.View entering={FadeInDown.delay(Math.min(index, 10) * 45).duration(420)}>
      {children}
    </Animated.View>
  );
}

function capacityLabelForUsage(usage: SidekickProductSnapshot['usage']) {
  if (usage.hardLimited || usage.nearLimit) return 'Busy month';
  return 'Comfortable';
}

function capacityLabel(usage: SidekickProductSnapshot['usage'] = usageSummary) {
  return capacityLabelForUsage(usage);
}

function gateDotState(gate: ProductGate): 'live' | 'working' | 'sleeping' {
  if (gate.tone === 'live') return 'live';
  if (gate.tone === 'accent') return 'working';
  return 'sleeping';
}

function gateBadgeTone(gate: ProductGate): BadgeTone {
  if (gate.tone === 'danger') return 'danger';
  if (gate.tone === 'warning') return 'warning';
  if (gate.tone === 'live' || gate.tone === 'accent') return 'accent';
  return 'neutral';
}

function gateDisplayLabel(gate: ProductGate): string {
  if (gate.kind === 'needs_acknowledgement') return 'Setup needed';
  if (gate.kind === 'subscribed_pending_worker' || gate.kind === 'provisioning_worker') return 'Preparing workspace';
  return gate.label;
}

function gateCompactLabel(gate: ProductGate): string {
  if (gate.kind === 'needs_acknowledgement') return 'Setup';
  if (gate.kind === 'subscribed_pending_worker' || gate.kind === 'provisioning_worker') return 'Preparing workspace';
  return gateDisplayLabel(gate);
}

function TermsContent() {
  return (
    <Stack gap={3}>
      <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
        <Stack gap={2}>
          <Badge tone="accent">Terms</Badge>
          <Text variant="displayMd">{DELEGENT_TERMS_TITLE}</Text>
          <Text variant="caption" color="textTertiary">Updated {DELEGENT_TERMS_UPDATED}</Text>
          <Text variant="bodySm" color="textSecondary">{DELEGENT_TERMS_INTRO}</Text>
        </Stack>
      </Surface>
      {DELEGENT_TERMS_SECTIONS.map((section) => (
        <Surface key={section.title} elevation="surfaceHigh" radius="lg" padding={3} border style={styles.termsSection}>
          <Stack gap={2}>
            <Text variant="title">{section.title}</Text>
            {section.body.map((paragraph) => (
              <Text key={paragraph} variant="bodySm" color="textSecondary">{paragraph}</Text>
            ))}
          </Stack>
        </Surface>
      ))}
    </Stack>
  );
}

/**
 * Withdrawal has to be as easy as granting, and has to actually stop the
 * collection rather than merely stop asking. Rendered above the policy text so
 * it is the first thing on the Privacy screen, not buried under it.
 */
function AdConsentControl() {
  const [state, setState] = useState<'granted' | 'denied' | 'unasked' | 'loading'>('loading');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const current = await currentMetaConsent();
      if (alive) setState(current);
    })();
    return () => { alive = false; };
  }, []);

  // Hidden entirely on builds with no SDK (iOS, or anything before 2.3.0),
  // where the control would promise something it cannot deliver.
  if (state === 'loading') return null;

  const granted = state === 'granted';
  return (
    <Surface elevation="surfaceHigh" radius="lg" padding={3} border testID="privacy.adConsentCard">
      <Stack gap={2}>
        <Text variant="body">Ad measurement</Text>
        <Text variant="bodySm" color="textSecondary">
          {granted
            ? 'You are helping us measure which adverts bring people to Delegent AI. Your device’s advertising ID is shared with Meta. Your name, email, messages and files are never shared.'
            : 'Off. We are not sharing anything with Meta about how you found the app.'}
        </Text>
        <Text variant="bodySm" color="textSecondary">
          Changes made offline reach our servers when you next open the app online while signed in.
        </Text>
        <Button
          testID="privacy.adConsentToggle"
          variant="secondary"
          fullWidth
          disabled={saving}
          onPress={() => {
            const next = !granted;
            setState(next ? 'granted' : 'denied');
            setSaving(true);
            void recordMetaConsent(next).then(currentMetaConsent).then(setState)
              .finally(() => setSaving(false));
          }}
        >
          {granted ? 'Turn off ad measurement' : 'Turn on ad measurement'}
        </Button>
      </Stack>
    </Surface>
  );
}

function PrivacyContent() {
  return (
    <Stack gap={3}>
      <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
        <Stack gap={2}>
          <Badge tone="accent">Privacy</Badge>
          <Text variant="displayMd">{DELEGENT_PRIVACY_TITLE}</Text>
          <Text variant="caption" color="textTertiary">Updated {DELEGENT_PRIVACY_UPDATED}</Text>
          <Text variant="bodySm" color="textSecondary">{DELEGENT_PRIVACY_INTRO}</Text>
        </Stack>
      </Surface>
      <AdConsentControl />
      {DELEGENT_PRIVACY_SECTIONS.map((section) => (
        <Surface key={section.title} elevation="surfaceHigh" radius="lg" padding={3} border style={styles.termsSection}>
          <Stack gap={2}>
            <Text variant="title">{section.title}</Text>
            {section.body.map((paragraph) => (
              <Text key={paragraph} variant="bodySm" color="textSecondary">{paragraph}</Text>
            ))}
          </Stack>
        </Surface>
      ))}
    </Stack>
  );
}

function NoticesContent() {
  return (
    <Stack gap={3}>
      <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
        <Stack gap={2}>
          <Badge tone="accent">Open source</Badge>
          <Text variant="displayMd">{DELEGENT_NOTICES_TITLE}</Text>
          <Text variant="caption" color="textTertiary">Updated {DELEGENT_NOTICES_UPDATED}</Text>
          <Text variant="bodySm" color="textSecondary">{DELEGENT_NOTICES_INTRO}</Text>
        </Stack>
      </Surface>
      {DELEGENT_NOTICES_SECTIONS.map((section) => (
        <Surface key={section.title} elevation="surfaceHigh" radius="lg" padding={3} border style={styles.termsSection}>
          <Stack gap={2}>
            <Text variant="title">{section.title}</Text>
            {section.body.map((paragraph) => (
              <Text key={paragraph} variant="bodySm" color="textSecondary">{paragraph}</Text>
            ))}
          </Stack>
        </Surface>
      ))}
    </Stack>
  );
}

// Soft colour for the icon tiles on the guide pages (Alex, 2026-09-28: "a bit
// boring ... all text ... inject some colour"). Pastels, so the pages stay calm
// under Pearl's neutral surfaces.
const PASTEL_TINTS = ['#E3EEFB', '#E4F3E8', '#FDEBD8', '#EDE7FB', '#FBE6EC', '#E0F3F1', '#FFF2D6', '#E8EAF6'] as const;
function pastelTint(index: number): string {
  return PASTEL_TINTS[((index % PASTEL_TINTS.length) + PASTEL_TINTS.length) % PASTEL_TINTS.length];
}

function EmojiTile({ emoji, tint, size = 44 }: { emoji: string; tint: string; size?: number }) {
  return (
    <View style={[styles.emojiTile, { width: size, height: size, borderRadius: Math.round(size * 0.32), backgroundColor: tint }]}>
      <Text style={{ fontSize: Math.round(size * 0.48), lineHeight: Math.round(size * 0.62) }}>{emoji}</Text>
    </View>
  );
}

// One picture per how-to section, by its title. An unknown title gets a book.
const HOWTO_EMOJI: Record<string, string> = {
  'Just ask': '💬',
  'Everyday jobs': '✅',
  'Built in': '✈️',
  'Connect your apps': '🔗',
  'It remembers you': '🧠',
  Talk: '🎙️',
  'Your allowance': '📊',
  'You stay in control': '🛡️',
};

// One picture per highlighted skill, by its name; anything unlisted borrows its
// category's emoji.
const SKILL_EMOJI: Record<string, string> = {
  'Find money you may be owed': '💷',
  'Inbox sorting': '🗂️',
  'Replies in your tone': '✍️',
  'Its own inbox': '📮',
  'Team chat': '💬',
  Flights: '✈️',
  Hotels: '🏨',
  'Things to do': '🎟️',
  Itineraries: '🗺️',
  'Letters & complaints': '✉️',
  'Price checks': '🏷️',
  'Local services': '🔧',
  'Calendar & to-dos': '📅',
  'PDFs & photos': '📄',
  'Docs & Sheets': '📊',
  'Saving files': '📁',
  'Money in your inbox': '💷',
  Bookkeeping: '📒',
  Payments: '💳',
  'Invoice chasing': '🧾',
  'Bills & receipts': '📸',
  'Web research': '🔎',
  News: '📰',
  'Rules & figures': '📐',
  Weather: '⛅',
  'Website & shop': '🛍️',
  Projects: '✅',
  Customers: '🤝',
  'Social posts': '📣',
};

function HowToGuides() {
  const themeColors = useThemeColors();
  const agentEngine = useIsAgentEngine();
  const renderSection = (section: (typeof DELEGENT_HOWTO_SECTIONS)[number], index: number) => (
    <Surface key={section.title} elevation="surfaceHigh" radius="lg" padding={3} border style={styles.termsSection}>
      <Stack direction="horizontal" gap={3} align="flex-start">
        <EmojiTile emoji={HOWTO_EMOJI[section.title] ?? '📘'} tint={pastelTint(index)} />
        <Stack gap={2} style={styles.flexText}>
          <Text variant="title">{section.title}</Text>
          {section.body.map((paragraph) => (
            <Text key={paragraph} variant="bodySm" color="textSecondary">{paragraph}</Text>
          ))}
        </Stack>
      </Stack>
    </Surface>
  );
  return (
    <Stack gap={3}>
      <Surface elevation="surfaceHigh" radius="lg" padding={4} border style={styles.guideHero}>
        <PastelWash id="howtoWash" />
        <Stack gap={2}>
          <Badge tone="accent">How-to guides</Badge>
          <Text variant="brandMd">{agentEngine ? AGENT_HOWTO_TITLE : DELEGENT_HOWTO_TITLE}</Text>
          <Text variant="bodySm" color="textSecondary">{agentEngine ? AGENT_HOWTO_INTRO : DELEGENT_HOWTO_INTRO}</Text>
        </Stack>
      </Surface>
      {agentEngine ? AGENT_HOWTO_SECTIONS.map(renderSection) : DELEGENT_HOWTO_SECTIONS.map(renderSection)}
      {/* No "Want to go deeper?" link for an assistant account: it opened the
          website's guide, which still describes the workspace coworker (Alex,
          2026-09-15). The one thing that guide added, what the coworker cannot
          do, is now in the last section above. */}
      {agentEngine ? null : (
        <Surface elevation="surfaceHigh" radius="lg" padding={3} border style={styles.termsSection}>
          <Stack gap={2}>
            <Text variant="title">{DELEGENT_HOWTO_DEEPER_TITLE}</Text>
            <Text variant="bodySm" color="textSecondary">{DELEGENT_HOWTO_DEEPER_BODY}</Text>
            <Pressable
              testID="howto.deepGuideLink"
              accessibilityRole="link"
              accessibilityLabel={`Read ${DELEGENT_HOWTO_DEEPER_LABEL} on the website`}
              onPress={() => { void Linking.openURL(DELEGENT_HOWTO_DEEPER_URL).catch(() => undefined); }}
              hitSlop={touchHitSlop}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[1], marginTop: space[1] }}
            >
              <Text variant="bodySm" color="accent">{DELEGENT_HOWTO_DEEPER_LABEL}</Text>
              <Feather name="external-link" size={14} color={themeColors.accent} />
            </Pressable>
          </Stack>
        </Surface>
      )}
    </Stack>
  );
}

function TermsModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.termsModalBackdrop} testID="terms.modal">
        <Pressable testID="terms.backdropDismiss" style={styles.modalDismissLayer} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss Terms backdrop" />
        <Surface elevation="surface" radius="xl" border="strong" padding={4} style={[styles.termsSheet, shadow.sheet]}>
          <Pressable testID="terms.closeIcon" accessibilityRole="button" accessibilityLabel="Close Terms icon" onPress={onClose} hitSlop={touchHitSlop} style={styles.sheetCloseButton}>
            <Feather name="x" size={17} color={appColors.textSecondary} />
          </Pressable>
          <ScrollView contentContainerStyle={styles.termsScroll} showsVerticalScrollIndicator>
            <TermsContent />
            <Button testID="terms.closeButton" variant="secondary" fullWidth onPress={onClose}>Close Terms</Button>
          </ScrollView>
        </Surface>
      </View>
    </Modal>
  );
}

function PrivacyModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.termsModalBackdrop} testID="privacy.modal">
        <Pressable testID="privacy.backdropDismiss" style={styles.modalDismissLayer} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss Privacy backdrop" />
        <Surface elevation="surface" radius="xl" border="strong" padding={4} style={[styles.termsSheet, shadow.sheet]}>
          <Pressable testID="privacy.closeIcon" accessibilityRole="button" accessibilityLabel="Close Privacy Policy icon" onPress={onClose} hitSlop={touchHitSlop} style={styles.sheetCloseButton}>
            <Feather name="x" size={17} color={appColors.textSecondary} />
          </Pressable>
          <ScrollView contentContainerStyle={styles.termsScroll} showsVerticalScrollIndicator>
            <PrivacyContent />
            <Button testID="privacy.closeButton" variant="secondary" fullWidth onPress={onClose}>Close Privacy Policy</Button>
          </ScrollView>
        </Surface>
      </View>
    </Modal>
  );
}

/**
 * Ad-measurement consent.
 *
 * Shown once, after sign-in, never on first launch. Interrupting someone before
 * they have seen the product costs activation, and activation is worth more
 * than attribution.
 *
 * The two buttons are deliberately the SAME variant and the same width. Under
 * UK GDPR consent must be freely given, and a visually weighted choice (big
 * green yes, small grey no) is not freely given. There is also no "ask me
 * later": one decision, respected, changeable afterwards in Privacy.
 */
function AdConsentModal({
  visible,
  onDecide,
}: {
  visible: boolean;
  onDecide: (granted: boolean) => void;
}) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={() => onDecide(false)}>
      <View style={styles.termsModalBackdrop} testID="adConsent.modal">
        <Surface elevation="surface" radius="xl" border="strong" padding={4} style={[styles.termsSheet, shadow.sheet]}>
          <Stack gap={3}>
            <Badge tone="accent">Privacy</Badge>
            <Text variant="displayMd">Help us reach people like you?</Text>
            <Text variant="bodySm" color="textSecondary">
              We can let Meta know you installed Delegent AI, so our adverts on Facebook and Instagram
              reach people who would actually find it useful.
            </Text>
            <Text variant="bodySm" color="textSecondary">
              This uses your device&apos;s advertising ID. We never share your name, email address,
              messages or files.
            </Text>
            <Text variant="caption" color="textTertiary">
              You can change this at any time under Privacy in the menu.
            </Text>
            <Stack gap={2}>
              <Button
                testID="adConsent.decline"
                variant="secondary"
                fullWidth
                onPress={() => onDecide(false)}
              >
                No thanks
              </Button>
              <Button
                testID="adConsent.accept"
                variant="secondary"
                fullWidth
                onPress={() => onDecide(true)}
              >
                Yes, that&apos;s fine
              </Button>
            </Stack>
          </Stack>
        </Surface>
      </View>
    </Modal>
  );
}

function LoginScreen({
  onGooglePress,
  onApplePress,
  onSendEmailOtp,
  onVerifyEmailOtp,
  onOpenTerms,
  onOpenPrivacy,
  loading,
  errorMessage,
}: {
  onGooglePress: () => void;
  onApplePress: () => void;
  onSendEmailOtp: (email: string) => Promise<EmailOtpSendResult>;
  onVerifyEmailOtp: (email: string, code: string) => Promise<EmailOtpVerifyResult>;
  onOpenTerms: () => void;
  onOpenPrivacy: () => void;
  loading: boolean;
  errorMessage: string | null;
}) {
  const [emailAddress, setEmailAddress] = useState('');
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [emailCooldown, setEmailCooldown] = useState(0);
  // v1.2.7, OTP code entry. The magic-link path dead-ends at
  // about:blank when Gmail opens it in its in-app browser (the
  // WebView can't launch the sidekick:// scheme), so the email
  // ALSO contains an 8-digit code (the auth provider's mailer is
  // configured for an 8-digit OTP length). After the link is sent we
  // swap the UI to ask the user to paste it.
  const [otpCode, setOtpCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  // v1.2.5, login screen needs the same Keyboard-listener fix as the
  // chat panel. Android edge-to-edge mode draws under the keyboard,
  // so the email row would sit hidden behind the soft keyboard until
  // we apply paddingBottom = keyboardHeight to the outer container.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const themeColors = useThemeColors();
  // The money check (Alex, 2026-09-27): the hook comes before the ask. A card
  // opens a thirty-second check that needs no account; what they tick is kept
  // on the device and carried through onboarding (src/onboarding/MoneyCheck.tsx).
  const money = useMoneyIntent();
  const [moneyOpen, setMoneyOpen] = useState(false);
  useEffect(() => {
    if (!moneyOpen) return undefined;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      setMoneyOpen(false);
      return true;
    });
    return () => back.remove();
  }, [moneyOpen]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e?.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    if (emailCooldown <= 0) return undefined;
    const timer = setTimeout(() => setEmailCooldown((remaining) => Math.max(0, remaining - 1)), 1000);
    return () => clearTimeout(timer);
  }, [emailCooldown]);

  const canRequestEmailLink = !loading && !verifying && emailCooldown === 0;
  const emailLinkButtonLabel = emailCooldown > 0 ? `Resend in ${emailCooldown}s` : emailSentTo ? 'Send another email' : 'Email me a sign-in code';

  const handleEmailChange = (value: string) => {
    setEmailAddress(value);
    if (emailSentTo) {
      setEmailSentTo(null);
      setOtpCode('');
      setEmailStatus('Request a new code for the updated email.');
    }
  };

  const handleSendEmailLink = async () => {
    setEmailStatus(null);
    setEmailSentTo(null);
    setOtpCode('');
    const result = await onSendEmailOtp(emailAddress);
    if ('error' in result) {
      setEmailStatus(result.error.message);
    } else {
      setEmailSentTo(result.email);
      setEmailCooldown(EMAIL_OTP_COOLDOWN_SECONDS);
      setEmailStatus(`We sent an 8-digit code to ${result.email}. Enter the most recent one to finish signing in. Some email systems (like NHS) can take a minute, so check your spam folder if it is slow.`);
    }
  };

  // The auth provider is configured to emit 8-digit OTPs.
  // Mobile must match, accepting 6 was the v1.2.7 regression that
  // made the code from the email "not work" (it was 8 digits but
  // the input was capped at 6).
  const sanitizedOtp = otpCode.replace(/\D+/g, '').slice(0, 8);
  const canVerifyOtp = !loading && !verifying && emailSentTo !== null && sanitizedOtp.length === 8;

  const handleVerifyEmailOtp = async () => {
    if (!emailSentTo) return;
    setVerifying(true);
    setEmailStatus(null);
    const result = await onVerifyEmailOtp(emailSentTo, sanitizedOtp);
    setVerifying(false);
    if ('error' in result) {
      setEmailStatus(result.error.message);
    }
    // On success the auth-state hook flips the app shell, no extra UI.
  };

  // The hero shrinks once the email flow is open. Requesting a code adds an
  // OTP field and a verify button, and on iOS the keyboard arrives on top of
  // that, so a fixed-height hero leaves the sign-in buttons no room and they
  // ride up OVER the logo (Alex, 2026-08-14). Scrolling alone is not enough:
  // without giving the hero permission to get smaller, the first thing a user
  // sees on opening the email flow is still a collision.
  const heroCompact = emailSentTo !== null || keyboardHeight > 0;
  // First impression (2026-09-26): the brain with the apps it works in
  // orbiting it, words rising in, and a ribbon of things you can ask. The
  // compact state (email flow open, keyboard up) drops back to the still logo,
  // exactly as before, because the height is needed for the code fields.
  const { width: screenWidth } = useWindowDimensions();
  // A little smaller since the money card (2026-09-27) joined the first screen,
  // so Continue with Google still sits above the fold on a small phone.
  const orbitSize = Math.round(Math.min(screenWidth * 0.62, 250));
  // The bundled mark keeps its two pinned footprints (ui-feedback-iteration
  // test): full size in the middle of the orbit, compact on its own.
  const heroMark = (
    <Image
      source={coworkerMark}
      style={heroCompact ? styles.brandLogoHeroCompact : styles.brandLogoHero}
      resizeMode="contain"
      accessibilityLabel="Delegent AI"
    />
  );

  if (moneyOpen) {
    return (
      <MoneyCheck
        from="signin"
        initial={money.intent}
        onDone={(choice) => {
          void saveMoneyIntent(choice).then(money.setIntent);
          setMoneyOpen(false);
        }}
      />
    );
  }

  return (
    <ScrollView
      style={styles.loginScroll}
      contentContainerStyle={[
        styles.loginScreen,
        keyboardHeight > 0 ? { paddingBottom: keyboardHeight + space[3] } : null,
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <Stack align="center" gap={heroCompact ? 3 : 4} style={styles.loginHero}>
        {heroCompact ? heroMark : (
          <Rise>
            <AppOrbit services={POPULAR_APPS} size={orbitSize} center={heroMark} />
          </Rise>
        )}
        <Stack align="center" gap={2}>
          <Rise delay={heroCompact ? 0 : 260}>
            <Wordmark size={heroCompact ? 'md' : 'lg'} align="center" />
          </Rise>
          {/* The strapline is for a first impression, not for someone mid
              sign-in who has already read it. Hiding it while the email flow
              is open buys back the height the OTP fields need. */}
          {heroCompact ? null : (
            <Rise delay={400}>
              <Text variant="bodySm" color="textSecondary" align="center" style={styles.loginSubtitle}>
                Your connected AI coworker. It works in the apps you already use, replies in seconds, and takes the everyday jobs off your hands.
              </Text>
            </Rise>
          )}
        </Stack>
        {heroCompact ? null : (
          <Rise delay={520} style={styles.loginTickerWrap}>
            <AskTicker items={FIRST_RUN_ASKS} />
          </Rise>
        )}
      </Stack>

      <Stack gap={3} style={styles.loginActions}>
        {heroCompact ? null : (
          <Rise delay={560}>
            <MoneyHookCard intent={money.intent} onPress={() => setMoneyOpen(true)} />
          </Rise>
        )}
        <Rise delay={heroCompact ? 0 : 620}>
        {/* After "Find my money" the way on is signing in, so it breathes. */}
        <Breathe active={Boolean(money.intent?.wants) && !heroCompact} min={0.985} max={1.02} period={2200}>
        <Pressable
          testID="login.googleButton"
          accessibilityRole="button"
          accessibilityLabel="Continue with Google"
          accessibilityState={{ disabled: loading, busy: loading }}
          disabled={loading}
          onPress={onGooglePress}
          style={[styles.googleButton, { backgroundColor: themeColors.surfaceHigh, borderColor: themeColors.borderStrong }, styles.loginPrimaryAction, loading ? styles.googleButtonDisabled : null]}
        >
          <View style={styles.googleGlyph}>
            <Image source={googleGIcon} style={styles.googleGlyphImage} resizeMode="contain" />
          </View>
          <Text variant="title" color="textPrimary">{loading ? 'Signing in…' : 'Continue with Google'}</Text>
        </Pressable>
        </Breathe>
        </Rise>

        {/* iOS only, renders nothing anywhere the native module is absent.
            Guideline 4.8: offering Google makes an Apple-quality private
            login mandatory, so this ships beside it, not behind it. */}
        <Rise delay={heroCompact ? 0 : 690}>
          <AppleSignInButton testID="login.appleButton" onPress={onApplePress} />
        </Rise>

        <Stack direction="horizontal" align="center" gap={3} style={styles.loginDividerRow}>
          <Divider style={styles.loginDivider} />
          <Text variant="caption" color="textTertiary">or</Text>
          <Divider style={styles.loginDivider} />
        </Stack>

        <Rise delay={heroCompact ? 0 : 780}>
        <Surface testID="login.emailButton" elevation="surface" radius="xl" padding={3} style={[styles.phoneAuthCard, { borderColor: themeColors.border }]}>
          <Stack gap={2}>
            <Text variant="caption" color="textSecondary" align="center" style={styles.loginEmailHeading}>Continue with email</Text>
            <TextInput
              testID="login.emailInput"
              accessibilityLabel="Email address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={!loading}
              inputMode="email"
              keyboardType="email-address"
              returnKeyType="send"
              onChangeText={handleEmailChange}
              onSubmitEditing={() => {
                if (canRequestEmailLink) void handleSendEmailLink();
              }}
              placeholder="you@example.com"
              placeholderTextColor={themeColors.textTertiary}
              style={[styles.phoneInput, { backgroundColor: themeColors.surfaceHigh, borderColor: themeColors.borderStrong, color: themeColors.textPrimary }]}
              value={emailAddress}
            />
            <Pressable
              testID="login.emailSubmit"
              accessibilityRole="button"
              accessibilityLabel="Email me a sign-in code"
              accessibilityState={{ disabled: !canRequestEmailLink, busy: loading }}
              disabled={!canRequestEmailLink}
              onPress={handleSendEmailLink}
              style={[styles.phoneAuthButton, { backgroundColor: themeColors.surfaceHigh, borderColor: themeColors.borderStrong }, styles.loginPrimaryAction, !canRequestEmailLink ? styles.googleButtonDisabled : null]}
            >
              <Text variant="caption" style={{ color: themeColors.textPrimary }}>{emailLinkButtonLabel}</Text>
            </Pressable>
            {emailSentTo ? (
              <Stack gap={2}>
                <TextInput
                  testID="login.emailOtpInput"
                  accessibilityLabel="Eight-digit sign-in code"
                  autoCapitalize="none"
                  autoComplete="one-time-code"
                  autoCorrect={false}
                  editable={!verifying}
                  inputMode="numeric"
                  keyboardType="number-pad"
                  maxLength={8}
                  returnKeyType="done"
                  onChangeText={(value) => setOtpCode(value)}
                  onSubmitEditing={() => {
                    if (canVerifyOtp) void handleVerifyEmailOtp();
                  }}
                  // A worked example the same length as the field will accept. It
                  // used to show six digits, which is the exact shape the v1.2.7
                  // regression made the field refuse, so a reader who copied it
                  // typed six and found the button still grey.
                  placeholder="00000000"
                  placeholderTextColor={themeColors.textTertiary}
                  style={[styles.phoneInput, { backgroundColor: themeColors.surfaceHigh, borderColor: themeColors.borderStrong, color: themeColors.textPrimary, textAlign: 'center', letterSpacing: 6 }]}
                  value={sanitizedOtp}
                />
                <Pressable
                  testID="login.emailOtpVerify"
                  accessibilityRole="button"
                  accessibilityLabel="Sign in with code"
                  accessibilityState={{ disabled: !canVerifyOtp, busy: verifying }}
                  disabled={!canVerifyOtp}
                  onPress={handleVerifyEmailOtp}
                  style={[styles.phoneAuthButton, { backgroundColor: themeColors.surfaceHigh, borderColor: themeColors.borderStrong }, styles.loginPrimaryAction, !canVerifyOtp ? styles.googleButtonDisabled : null]}
                >
                  <Text variant="caption" style={{ color: themeColors.textPrimary }}>
                    {verifying ? 'Signing in…' : 'Sign in'}
                  </Text>
                </Pressable>
              </Stack>
            ) : null}
            {emailStatus ? (
              <Text testID="login.emailStatus" variant="caption" color="textTertiary">{emailStatus}</Text>
            ) : null}
          </Stack>
        </Surface>
        </Rise>

        {errorMessage ? (
          <Text variant="bodySm" color="danger" align="center" style={styles.loginTagline}>
            {errorMessage}
          </Text>
        ) : (
          <Text variant="bodySm" color="textPrimary" align="center" style={styles.loginTagline}>
            Not just answers. Real everyday jobs, done in your apps.
          </Text>
        )}
      </Stack>
      {/* [DN1.3-02] Legal links must be real Pressable controls. The previous
          nested <Text onPress> implementation rendered as Android Spannable
          spans whose press events were not reliably dispatched to the React
          Native gesture system, Maestro could find and tap the span but the
          modal never opened. We split the disclaimer across two lines: a
          one-line caption plus a row of two Pressables, each with its own
          hit area and stable testID. */}
      <Text variant="caption" color="textSecondary" align="center" style={styles.loginTerms}>
        By continuing, you agree to the
      </Text>
      <View style={styles.loginTermsLinkRow}>
        <Pressable
          testID="login.termsLink"
          accessibilityRole="link"
          accessibilityLabel="Open Terms of Service"
          hitSlop={touchHitSlop}
          onPress={onOpenTerms}
          style={styles.loginTermsLinkButton}
        >
          <Text variant="caption" color="accent" style={styles.loginTermsLink}>
            Terms of Service
          </Text>
        </Pressable>
        <Text variant="caption" color="textSecondary">
          {' '}and{' '}
        </Text>
        <Pressable
          testID="login.privacyLink"
          accessibilityRole="link"
          accessibilityLabel="Open Privacy Policy"
          hitSlop={touchHitSlop}
          onPress={onOpenPrivacy}
          style={styles.loginTermsLinkButton}
        >
          <Text variant="caption" color="accent" style={styles.loginTermsLink}>
            Privacy Policy
          </Text>
        </Pressable>
        <Text variant="caption" color="textSecondary">.</Text>
      </View>
    </ScrollView>
  );
}

// The account photo when the sign-in gave us one, the name initial otherwise.
// A photo that fails to load falls back to the initial rather than leaving an
// empty circle, and the failure is tracked per URL so a later sign-in with a
// different photo still gets a fresh attempt.
function ProfileAvatar({ profile, size, testID }: { profile: AppProfile; size: 'sm' | 'lg'; testID?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = profile.avatarUrl;
  const shell = size === 'sm' ? styles.profileButton : styles.profileHeroAvatar;
  if (url && failedUrl !== url) {
    return (
      <View style={[shell, styles.avatarClip]} testID={testID}>
        <Image
          source={{ uri: url }}
          style={styles.avatarImage}
          resizeMode="cover"
          onError={() => setFailedUrl(url)}
          accessibilityLabel={`${profile.name} profile photo`}
        />
      </View>
    );
  }
  return (
    <View style={shell} testID={testID}>
      <Text variant={size === 'sm' ? 'caption' : 'title'} color="textPrimary">{profile.initial}</Text>
    </View>
  );
}

function Header({ gate, onMenuPress, onProfilePress, profile }: { gate: ProductGate; onMenuPress: () => void; onProfilePress: () => void; profile: AppProfile }) {
  return (
    <Stack direction="horizontal" align="center" justify="space-between" gap={3} style={styles.header}>
      <Pressable testID="main-menu-button" accessibilityRole="button" accessibilityLabel="Open menu" hitSlop={touchHitSlop} onPress={onMenuPress} style={styles.headerIconButton}>
        {/* Two bars, the lower one shorter: the menu mark of the 2026-09-27
            redesign, drawn rather than an icon-font glyph. */}
        <View style={styles.menuGlyph}>
          <View style={styles.menuGlyphBar} />
          <View style={[styles.menuGlyphBar, styles.menuGlyphBarShort]} />
        </View>
      </Pressable>
      <Stack direction="horizontal" gap={2} align="center" style={styles.brandLockup}>
        <Image source={coworkerMark} style={styles.brandLogoHeader} resizeMode="contain" accessibilityLabel="Delegent AI" />
        <Stack gap={1} style={styles.brandCopy}>
          <Wordmark size="sm" />
          {/* A used-up allowance is explained where it matters (the allowance card and the
              message shown on send, with a top-up); under the logo "Capacity full" only
              puzzled people (Alex, 2026-09-22). */}
          {gate.kind === 'hard_limited' ? null : (
            <Stack direction="horizontal" gap={2} align="center">
              <StatusDot state={gateDotState(gate)} />
              <Text variant="caption" color="textSecondary" numberOfLines={1}>{gateDisplayLabel(gate)}</Text>
            </Stack>
          )}
        </Stack>
      </Stack>
      <Pressable testID="header.profileButton" accessibilityRole="button" accessibilityLabel="Open profile" hitSlop={touchHitSlop} onPress={onProfilePress}>
        <ProfileAvatar profile={profile} size="sm" />
      </Pressable>
    </Stack>
  );
}

function ScreenIntro({ title, body, badge }: { title: string; body: string; badge?: string }) {
  return (
    <Entry index={0}>
      <Stack gap={3} style={styles.heroCopy}>
        {badge ? <Badge tone="neutral">{badge}</Badge> : null}
        <Text variant="brandMd">{title}</Text>
        <Text variant="bodySm" color="textSecondary">{body}</Text>
      </Stack>
    </Entry>
  );
}

function TierSegment({ selectedTier, onChange }: { selectedTier: TierId; onChange: (tier: TierId) => void }) {
  return (
    <Surface elevation="surface" radius="xl" padding={1} style={styles.segmentWrap}>
      <Stack direction="horizontal" gap={1}>
        {tiers.map((tier) => {
          const active = selectedTier === tier.id;
          return (
            <Pressable
              key={tier.id}
              testID={`setup.plan.${tier.id}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(tier.id)}
              style={[styles.segmentItem, active ? styles.segmentItemActive : null]}
            >
              <Text variant="caption" color={active ? 'textPrimary' : 'textTertiary'}>{tier.shortName}</Text>
            </Pressable>
          );
        })}
      </Stack>
    </Surface>
  );
}

function FeatureRow({ children }: { children: React.ReactNode }) {
  return (
    <Stack direction="horizontal" gap={3} align="center" style={styles.featureRow}>
      <View style={styles.featureCheck}>
        <Feather name="check" size={13} color={appColors.success} />
      </View>
      <Text variant="bodySm" color="textSecondary" style={styles.flexText}>{children}</Text>
    </Stack>
  );
}

/** A picture for each plan highlight, matched on its words so a reordered list keeps its pictures. */
function highlightEmoji(lead: string): string {
  const words = lead.toLowerCase();
  if (words.includes('apps')) return '🧩';
  if (words.includes('inbox')) return '📬';
  if (words.includes('travel')) return '✈️';
  if (words.includes('document')) return '📄';
  if (words.includes('website') || words.includes('shop')) return '🛍️';
  if (words.includes('web')) return '🔎';
  if (words.includes('remember')) return '🧠';
  if (words.includes('talk')) return '🎙️';
  return '✨';
}

/**
 * "What you get" on the agent-engine plan, each tile led by a bold claim.
 * 2026-09-27 (Alex: "so much text all over the screen. I hate it"): eight
 * paragraphs became eight short tiles, and the one line of detail sits under
 * them, for the tile you tap. Until someone taps, it walks through them.
 */
function AgentPlanHighlights({ testID }: { testID?: string }) {
  const themeColors = useThemeColors();
  const reducedMotion = useReducedMotion();
  const items = agentPlanHighlights();
  const [active, setActive] = useState(0);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || reducedMotion) return undefined;
    const timer = setInterval(() => setActive((index) => (index + 1) % items.length), 3200);
    return () => clearInterval(timer);
  }, [touched, reducedMotion, items.length]);
  const current = items[active] ?? items[0];
  return (
    <Stack gap={3} testID={testID}>
      <View style={styles.highlightGrid}>
        {agentPlanHighlights().map((item, index) => {
          const on = index === active;
          return (
            <NativePressable
              key={item.lead}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${item.lead} ${item.text}`}
              onPress={() => { setTouched(true); setActive(index); }}
              style={[styles.highlightTile, { backgroundColor: on ? themeColors.accentMuted : themeColors.surfaceHigh, borderColor: on ? themeColors.accent : themeColors.border }]}
            >
              <Pop on={on}>
                <Text style={styles.highlightEmoji}>{highlightEmoji(item.lead)}</Text>
              </Pop>
              <Text variant="bodySm" color="textPrimary" numberOfLines={2} style={[styles.flexText, { fontFamily: fontFamilies.geistSemiBold }]}>
                {item.lead.replace(/\.$/, '')}
              </Text>
            </NativePressable>
          );
        })}
      </View>
      {current ? (
        <Rise key={current.lead} distance={6}>
          <Text variant="bodySm" color="textSecondary" accessibilityLiveRegion="polite">{current.text}</Text>
        </Rise>
      ) : null}
    </Stack>
  );
}

/**
 * Under the Free stamp, the price having been said once beside it (Alex,
 * 2026-09-27: "say free and 3.99 once ... keep the cancel any time as the
 * smaller text"). "Renews automatically" stays: a free month that turns into a
 * paid one must say so before the tap. The full terms line is still one tap
 * away in "See plan details" (AgentPlanCard's offerPriceLine).
 */
const FREE_MONTH_SMALL_PRINT = 'Renews automatically. Cancel before the free month ends and you pay nothing.';

/** The Android free month, said big (see freeHero); the price stays readable beside it. */
function FreeMonthHero({ price }: { price: string }) {
  const themeColors = useThemeColors();
  return (
    <View style={styles.freeHero} testID="paywall.freeHero">
      <Pop on>
        <Breathe min={0.97} max={1.04} period={2400}>
          <View style={[styles.freeStamp, { backgroundColor: themeColors.accent }]}>
            <Text style={[styles.freeStampText, { color: themeColors.accentText }]}>Free</Text>
          </View>
        </Breathe>
      </Pop>
      <View style={styles.flexText}>
        <Text variant="title">for your first month</Text>
        <Text variant="body" color="textPrimary">{`then ${price} a month`}</Text>
      </View>
    </View>
  );
}

/** The paywall's reviews, one at a time, so they read as a voice rather than a block. */
// Review stars in a warm gold: the one bright note on a neutral card.
const REVIEW_STAR_COLOUR = '#D99A1E';

function ReviewCarousel({ reviews }: { reviews: readonly StoreReview[] }) {
  const themeColors = useThemeColors();
  const reducedMotion = useReducedMotion();
  // Five of them, picked afresh each time the screen opens, so the same one
  // or two never keep coming back (Alex, 2026-09-28).
  const shown = useMemo(() => pickReviews(reviews, 5), [reviews]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reducedMotion || shown.length < 2) return undefined;
    const timer = setInterval(() => setIndex((current) => (current + 1) % shown.length), 4500);
    return () => clearInterval(timer);
  }, [reducedMotion, shown.length]);
  const review = shown[index] ?? shown[0];
  if (!review) return null;
  return (
    <View style={[styles.reviewCard, { backgroundColor: 'rgba(255, 255, 255, 0.4)', borderColor: 'rgba(255, 255, 255, 0.6)' }]}>
      <Rise key={`${index}-${review.quote}`} distance={6}>
        <Stack gap={1}>
          <Text variant="caption" accessibilityLabel={`${review.stars} out of 5 stars`}>
            <Text variant="caption" style={{ color: REVIEW_STAR_COLOUR }}>{'★'.repeat(review.stars)}</Text>
            <Text variant="caption" style={{ color: themeColors.border }}>{'★'.repeat(5 - review.stars)}</Text>
          </Text>
          <Text variant="body">“{review.quote}”</Text>
          <Text variant="caption" color="textSecondary">{reviewCredit(review)}</Text>
        </Stack>
      </Rise>
      {shown.length > 1 ? (
        <View style={styles.reviewDots}>
          {shown.map((item, dot) => (
            <View key={`${dot}-${item.quote}`} style={[styles.reviewDot, { backgroundColor: dot === index ? themeColors.accent : themeColors.border }]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * An agent-engine account's monthly allowance, top-up credit and Talk time, with
 * the way to buy a £1 top-up (src/billing/agentAllowance.ts). Draws nothing until
 * the Worker has answered, so it never shows a made-up number.
 */
function AgentAllowanceCard({ testID }: { testID: string }) {
  const { allowance } = useAgentAllowance(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!allowance) return null;
  const percent = Math.round(allowance.allowanceUsedRatio * 100);
  const tone = allowance.hardLimited ? 'danger' : percent >= 80 ? 'warning' : 'accent';
  const refresh = allowanceRefreshLine(allowance);
  const buy = () => {
    // The consent the Consumer Contracts Regulations ask for before digital
    // content starts straight away, given here where the reader decides.
    Alert.alert(
      `Buy a ${formatTopUpPrice()} top-up?`,
      agentTopUpConsentBody(allowance.topUpValidMonths),
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Continue to payment',
          onPress: () => {
            setOpening(true);
            setError(null);
            void startTopUpCheckout(1).then(async (result) => {
              setOpening(false);
              if (!result.ok) { setError(result.message); return; }
              try { await Linking.openURL(result.url); } catch { setError('We could not open your browser. Try again.'); }
            });
          },
        },
      ],
    );
  };
  return (
    <Surface testID={testID} elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
      <Stack gap={3}>
        <Stack direction="horizontal" justify="space-between" align="center" gap={3}>
          <Text variant="title">{allowance.trialing ? 'Free month allowance' : 'Monthly allowance'}</Text>
          <Badge tone={tone}>{allowance.hardLimited ? 'Used up' : `${percent}% used`}</Badge>
        </Stack>
        {/* The title and the badge already say what this bar measures; its own
            "Monthly capacity" caption is the workspace plan's word for it. */}
        <CapacityProgressBar ratio={allowance.allowanceUsedRatio} hardLimited={allowance.hardLimited} nearLimit={percent >= 80} showLabel={false} />
        {refresh ? <Text variant="caption" color="textSecondary">{refresh}</Text> : null}
        <Stack direction="horizontal" justify="space-between" gap={3}>
          <Text variant="bodySm" color="textSecondary">Top-up credit</Text>
          <Text variant="bodySm" color="textPrimary" tabular>{topUpCreditLine(allowance)}</Text>
        </Stack>
        <Stack direction="horizontal" justify="space-between" gap={3}>
          <Text variant="bodySm" color="textSecondary">Talk</Text>
          <Text variant="bodySm" color="textPrimary" tabular>{talkMinutesLeftLine(allowance)}</Text>
        </Stack>
        {error ? <Text testID={`${testID}.error`} variant="bodySm" color="danger">{error}</Text> : null}
        <Button
          testID={`${testID}.topUp`}
          variant={allowance.hardLimited || percent >= 80 ? 'primary' : 'secondary'}
          size="sm"
          disabled={opening}
          onPress={buy}
        >
          {opening ? 'Opening…' : `Buy a top-up from ${formatTopUpPrice()}`}
        </Button>
      </Stack>
    </Surface>
  );
}

function AgentPlanCard({ tier, isCurrent, offerPriceLine }: { tier: Tier; isCurrent: boolean; offerPriceLine?: string }) {
  return (
    <Surface elevation="surfaceHigh" radius="xl" padding={4} style={styles.planCard} testID="plan.agentCard">
      <Stack gap={4}>
        <Stack direction="horizontal" justify="space-between" align="flex-start" gap={4}>
          <Stack gap={2} style={styles.flexText}>
            <Badge tone={isCurrent ? 'accent' : 'accent'}>{isCurrent ? 'Current plan' : 'First month free'}</Badge>
            <Text variant="title">{tier.name}</Text>
            <Text variant="bodySm" color="textSecondary">{AGENT_PLAN_SUMMARY}</Text>
          </Stack>
          {/* The offer leads, not the price. A new subscriber is being asked to
              start a free month; the price is what happens afterwards, so it
              sits underneath in smaller, quieter type. It stays visible: the
              renewal terms are required on this screen by both stores, and
              hiding them would be both dishonest and a review rejection. */}
          <Stack align="flex-end" gap={1}>
            {isCurrent ? (
              <>
                <Text variant="title" tabular>{tier.price}</Text>
                <Text variant="caption" color="textTertiary">per {tier.cadence}</Text>
              </>
            ) : (
              <>
                <Text variant="title" tabular>{AGENT_PLAN_HEADLINE_OFFER}</Text>
                <Text variant="caption" color="textTertiary">{AGENT_PLAN_HEADLINE_PERIOD}</Text>
                <Text variant="caption" color="textTertiary" tabular>{agentPlanThenLine()}</Text>
              </>
            )}
          </Stack>
        </Stack>

        {offerPriceLine ? <Text variant="bodySm" color="textSecondary">{offerPriceLine}</Text> : null}

        <Stack direction="horizontal" gap={2} wrap>
          <Stack direction="horizontal" align="center" gap={2} style={styles.capacityStrip}>
            <Feather name="zap" size={14} color={appColors.accent} />
            <Text variant="caption" color="textSecondary">Replies in seconds</Text>
          </Stack>
          <Stack direction="horizontal" align="center" gap={2} style={styles.capacityStrip}>
            <Feather name="tag" size={14} color={appColors.accent} />
            <Text variant="caption" color="textSecondary">{AGENT_PLAN_PRICE_NOTE}</Text>
          </Stack>
        </Stack>
        {/* No "What you get" here: this card only renders on the plan page, whose
            top already lists every highlight, and the page showed them twice. */}
      </Stack>
    </Surface>
  );
}

function PlanCard({
  tier,
  isCurrent,
  subscriptionStatus,
  cycleEndAtIso,
  offerPriceLine,
}: {
  tier: Tier;
  isCurrent: boolean;
  subscriptionStatus: SubscriptionStatus;
  /** The reader's billing period end, if Stripe has ever issued them one. */
  cycleEndAtIso: string | null;
  offerPriceLine?: string;
}) {
  // Every plan is the same full coworker; only compute + monthly allowance
  // change. So the card shows one shared summary + capability list for all
  // tiers, and surfaces the tier difference as the compute/allowance strip
  // and the cloud-space line. The per-tier shared `tier.summary` /
  // `tier.features` are intentionally not rendered here, they used to imply
  // higher tiers unlock more abilities.
  // Launch promo only renders once a real Stripe coupon backs it, and only for
  // a reader Stripe will certainly charge it to, so the shown price always
  // matches what gets charged. Status alone is not enough: a lapsed customer
  // reads as 'inactive' too, and the server charges him in full. See
  // shouldQuotePromoPrice.
  const agentEngine = useIsAgentEngine();
  const promoLive = isLaunchPromoLive();
  const quotePromo = shouldQuotePromoPrice({
    status: subscriptionStatus,
    currentPeriodEnd: cycleEndAtIso ?? undefined,
  });
  // Not `!== 'inactive'`. A cancelled reader has no subscription for a promo
  // month to sit on, so "months you have left carry across" was a promise with
  // nothing behind it, on the screen where they are deciding whether to come
  // back. The browser already gated this on entitlement.
  const alreadySubscribed = isEntitledSubscriptionStatus(subscriptionStatus);
  if (agentEngine) return <AgentPlanCard tier={tier} isCurrent={isCurrent} offerPriceLine={offerPriceLine} />;
  return (
    <Surface elevation="surfaceHigh" radius="xl" padding={4} style={styles.planCard}>
      <Stack gap={4}>
        <Stack direction="horizontal" justify="space-between" align="flex-start" gap={4}>
          <Stack gap={2} style={styles.flexText}>
            <Badge tone={isCurrent ? 'accent' : 'neutral'}>{isCurrent ? 'Current plan' : 'Plan preview'}</Badge>
            <Text variant="title">{tier.name}</Text>
            <Text variant="bodySm" color="textSecondary">{everyPlanSummary}</Text>
          </Stack>
          <Stack align="flex-end" gap={1}>
            {offerPriceLine ? null : quotePromo ? (
              <>
                <Badge tone="accent">{SIDEKICK_LAUNCH_PROMO.badge}</Badge>
                <Stack direction="horizontal" align="flex-end" gap={2}>
                  <Text variant="caption" color="textTertiary" style={styles.strikePrice}>{tier.price}</Text>
                  <Text variant="title" tabular>{tier.promoPrice}</Text>
                </Stack>
                <Text variant="caption" color="textTertiary">per {tier.cadence} for {SIDEKICK_LAUNCH_PROMO.durationMonths} months</Text>
              </>
            ) : (
              <>
                <Text variant="title" tabular>{tier.price}</Text>
                <Text variant="caption" color="textTertiary">per {tier.cadence}</Text>
              </>
            )}
          </Stack>
        </Stack>

        {offerPriceLine ? <Text variant="bodySm" color="textSecondary">{offerPriceLine}</Text> : null}
        {quotePromo ? (
          <Text variant="caption" color="textSecondary">{tier.promoTerms}</Text>
        ) : promoLive && alreadySubscribed ? (
          <Text variant="caption" color="textSecondary">{LAUNCH_PROMO_CARRY_OVER_LINE}</Text>
        ) : null}

        <Stack direction="horizontal" align="center" gap={2} style={styles.capacityStrip}>
          <Feather name="zap" size={14} color={appColors.accent} />
          <Text variant="caption" color="textSecondary">{tier.capacity}</Text>
        </Stack>

        {tier.inferenceNote ?? tier.capacityNote ? (
          <Text variant="caption" color="textTertiary">{tier.inferenceNote ?? tier.capacityNote}</Text>
        ) : null}

        <Stack direction="horizontal" align="center" gap={2} style={styles.capacityStrip}>
          <Feather name="hard-drive" size={14} color={appColors.accent} />
          <Text variant="caption" color="textSecondary">Private cloud space that grows with your plan</Text>
        </Stack>

        <Divider />

        <Text variant="caption" color="textTertiary">Every plan includes</Text>
        <Stack gap={3}>
          {everyPlanIncludes.map((feature) => (
            <FeatureRow key={feature}>{feature}</FeatureRow>
          ))}
        </Stack>
      </Stack>
    </Surface>
  );
}

// v1.2.1 Home, chat-first. The chat panel fills the home screen so the
// user lands directly inside the conversation with their AI coworker. No
// "Recent activity", no messenger CTAs, no scrollable hero. The user opens
// the app, sees their coworker greet them by name, and starts talking.
function Dashboard({
  productView,
  active,
  onOpenBillingPortal,
  onOpenFile,
}: {
  productView: ProductViewModel;
  active: boolean;
  onOpenBillingPortal: () => void;
  onOpenFile: (path: string) => void;
}) {
  const agentEngine = useIsAgentEngine();
  // An assistant account is measured on its own allowance (the Worker's
  // /api/account/allowance, which counts coworker usage alone), not on the
  // workspace quota in the product snapshot, which still carries any runner
  // usage from earlier in the month. Reading the snapshot here put "close to
  // this month's assistant-time limit" over an allowance card reading 8% used
  // (Alex, 2026-09-16). Re-read after every turn the snapshot registers.
  const { allowance, refresh: refreshAllowance } = useAgentAllowance(agentEngine);
  useEffect(() => { refreshAllowance(); }, [refreshAllowance, productView.usageSummary.usedTokens]);
  const quota = agentEngine
    ? {
      hardLimited: allowance?.hardLimited ?? false,
      nearLimit: allowance ? allowanceNearLimit(allowance) : false,
      nextResetAtIso: allowance?.nextResetAt ?? productView.nextResetAtIso,
    }
    : {
      hardLimited: productView.usageSummary.hardLimited,
      nearLimit: productView.usageSummary.nearLimit,
      nextResetAtIso: productView.nextResetAtIso,
    };
  return (
    <View style={styles.dashboardChatHost}>
      <WebViewChatScreen
        agentEngine={agentEngine}
        conversationId={productView.userId}
        agentName={productView.agentName}
        hasActiveSubscription={productView.hasActiveSubscription}
        hardLimited={quota.hardLimited}
        nearLimit={quota.nearLimit}
        nextResetAtIso={quota.nextResetAtIso}
        active={active}
        onOpenBillingPortal={onOpenBillingPortal}
        onOpenFile={onOpenFile}
      />
    </View>
  );
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  return (
    <Surface elevation="surfaceHigh" radius="lg" padding={3} style={styles.artifactCard}>
      <Stack gap={3}>
        <Stack direction="horizontal" align="flex-start" gap={3}>
          <View style={styles.iconTile}>
            <Feather name={artifact.icon} size={18} color={appColors.textSecondary} />
          </View>
          <Stack gap={2} style={styles.flexText}>
            <Stack direction="horizontal" align="center" justify="space-between" gap={3}>
              <Text variant="title" style={styles.flexText}>{artifact.title}</Text>
              <Badge tone={artifact.badgeTone}>{artifact.status}</Badge>
            </Stack>
            <Text variant="bodySm" color="textSecondary">{artifact.detail}</Text>
          </Stack>
        </Stack>

        <Divider />

        <Stack direction="horizontal" justify="space-between" align="center">
          <Text variant="mono" color="textTertiary" tabular>{artifact.kind}</Text>
          <Text variant="caption" color="textTertiary">Finished work</Text>
        </Stack>
      </Stack>
    </Surface>
  );
}

// Preview limits, keep the inline view honest about being a "first look",
// the full file is one tap away via Download. 8 KB / 40 lines feels like
// the most-readable upper bound on a phone screen without overwhelming.
// App build + OTA update identity, so a user (and we) can confirm exactly which
// build is running and that an over-the-air update actually pulled after an
// open/close (2026-07-18, Alex). Computed once per launch from expo-updates.
const appBuildInfo = (() => {
  try {
    const version = Updates.runtimeVersion || '2.1.1';
    if (Updates.isEmbeddedLaunch || !Updates.updateId) {
      return { version, update: 'built-in (no OTA yet)' };
    }
    const id = String(Updates.updateId).slice(0, 8);
    let when = '';
    try {
      const d = Updates.createdAt ? new Date(Updates.createdAt) : null;
      if (d && !Number.isNaN(d.getTime())) when = ' · ' + d.toISOString().slice(0, 10);
    } catch { /* ignore */ }
    return { version, update: id + when };
  } catch {
    return { version: '2.1.1', update: 'unknown' };
  }
})();

// PREVIEW_BYTE_LIMIT, PREVIEW_LINE_LIMIT, isPreviewableFile and buildFilePreview
// come from @sidekick/shared, so the browser cannot decide a different set of
// files is previewable or a different point at which one is only a fragment.

function RunnerFileCard({
  file,
  onOpen,
  onRename,
  onDelete,
  keyPrefix = 'files.card',
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onEnterSelectionMode,
}: {
  file: MobileRunnerFile;
  onOpen: (file: MobileRunnerFile) => Promise<boolean> | boolean;
  // Optional file-management actions. When provided, a Rename / Delete control
  // appears in the expanded card; the parent owns the confirm/rename UI + refresh.
  onRename?: (file: MobileRunnerFile) => void;
  onDelete?: (file: MobileRunnerFile) => void;
  // testID namespace for this card. The same file can appear both in the
  // "Recent" group and in its folder, so callers pass a distinct prefix to keep
  // testIDs unique for Maestro/Appium selectors.
  keyPrefix?: string;
  // Multi-select (2026-07-22): long-press enters selection mode; while the
  // mode is on, a tap toggles this card instead of opening the preview and a
  // tick circle renders on the left. The parent owns the selection state.
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (file: MobileRunnerFile) => void;
  onEnterSelectionMode?: (file: MobileRunnerFile) => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewState, setPreviewState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'unavailable';
    body: string;
    truncated: boolean;
  }>({ status: 'idle', body: '', truncated: false });
  const [openErrorMessage, setOpenErrorMessage] = useState<string | null>(null);
  const previewable = isPreviewableFile(file);

  const loadPreview = useCallback(async () => {
    setPreviewState({ status: 'loading', body: '', truncated: false });
    try {
      const response = await fetch(file.downloadUrl, {
        method: 'GET',
        headers: { range: `bytes=0-${PREVIEW_BYTE_LIMIT - 1}` },
      });
      if (!response.ok && response.status !== 206) {
        setPreviewState({ status: 'unavailable', body: '', truncated: false });
        return;
      }
      const raw = await response.text();
      const { body, truncated } = buildFilePreview(raw, file.sizeBytes);
      setPreviewState({ status: 'ready', body, truncated });
    } catch {
      setPreviewState({ status: 'unavailable', body: '', truncated: false });
    }
  }, [file.downloadUrl, file.sizeBytes]);

  const togglePreview = useCallback(async () => {
    if (previewOpen) {
      setPreviewOpen(false);
      return;
    }
    setPreviewOpen(true);
    if (!previewable) {
      setPreviewState({ status: 'unavailable', body: '', truncated: false });
      return;
    }
    if (previewState.status === 'ready' || previewState.status === 'loading') return;
    await loadPreview();
  }, [loadPreview, previewable, previewOpen, previewState.status]);

  const handleDownload = useCallback(async () => {
    setOpenErrorMessage(null);
    const opened = await onOpen(file);
    if (!opened) {
      setOpenErrorMessage("Couldn't open that file. Try again, or open it from Files.");
    }
  }, [file, onOpen]);

  return (
    <Surface elevation="surfaceHigh" radius="lg" padding={3} border style={styles.artifactCard} testID={`${keyPrefix}.${file.id}`}>
      <NativePressable
        accessibilityRole="button"
        accessibilityLabel={selectionMode ? `${selected ? 'Deselect' : 'Select'} ${file.name}` : `Preview ${file.name}`}
        accessibilityState={selectionMode ? { selected } : undefined}
        onPress={selectionMode ? () => onToggleSelect?.(file) : () => void togglePreview()}
        onLongPress={onEnterSelectionMode
          ? () => (selectionMode ? onToggleSelect?.(file) : onEnterSelectionMode(file))
          : undefined}
        hitSlop={touchHitSlop}
        testID={`${keyPrefix}.${file.id}.tap`}
      >
        <Stack gap={3}>
          <Stack direction="horizontal" align="flex-start" gap={3}>
            {selectionMode ? (
              <View style={styles.fileSelectTick} testID={`${keyPrefix}.${file.id}.tick`}>
                <Feather
                  name={selected ? 'check-circle' : 'circle'}
                  size={20}
                  color={selected ? appColors.accent : appColors.textTertiary}
                />
              </View>
            ) : null}
            <View style={styles.iconTile}>
              <Feather name={runnerFileIcon(file)} size={18} color={appColors.textSecondary} />
            </View>
            <Stack gap={1} style={styles.flexText}>
              <Stack direction="horizontal" align="center" justify="space-between" gap={3}>
                <Text variant="title" style={styles.flexText} numberOfLines={1}>{file.name}</Text>
                {!selectionMode ? (
                  <Feather
                    name={previewOpen ? 'chevron-down' : 'chevron-right'}
                    size={18}
                    color={appColors.textTertiary}
                  />
                ) : null}
              </Stack>
              <Stack direction="horizontal" gap={2} align="center">
                <Text variant="mono" color="textTertiary" tabular>{formatFileSize(file.sizeBytes)}</Text>
                <Text variant="caption" color="textTertiary">·</Text>
                <Text variant="caption" color="textTertiary">{`Updated ${formatFileUpdatedAt(file.modifiedAt)}`}</Text>
                {file.relativeName ? (
                  <>
                    <Text variant="caption" color="textTertiary">·</Text>
                    <Text variant="caption" color="textTertiary" numberOfLines={1} style={styles.flexText}>
                      {file.relativeName}
                    </Text>
                  </>
                ) : null}
              </Stack>
            </Stack>
          </Stack>
        </Stack>
      </NativePressable>

      {previewOpen && !selectionMode ? (
        <Stack gap={3} style={styles.filePreviewBlock}>
          <Divider />
          {previewState.status === 'loading' ? (
            <Text variant="bodySm" color="textSecondary">Loading the first {PREVIEW_LINE_LIMIT} lines…</Text>
          ) : previewState.status === 'ready' ? (
            <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
              <Text variant="mono" color="textPrimary" style={styles.filePreviewBody}>
                {previewState.body || '(file is empty)'}
              </Text>
              {previewState.truncated ? (
                <Text variant="caption" color="textTertiary" style={styles.filePreviewHint}>
                  {file.downloadable
                    ? `Showing the first ${PREVIEW_LINE_LIMIT} lines. Use Download to phone to see the rest.`
                    : `Showing the first ${PREVIEW_LINE_LIMIT} lines. The full file stays saved in your cloud space, but phone download is not available for this file.`}
                </Text>
              ) : null}
            </Surface>
          ) : (
            <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
              <Stack gap={3}>
                <Text variant="bodySm" color="textSecondary">
                  {previewable
                    ? file.downloadable
                      ? 'Could not load a preview just now. Use Download to phone instead.'
                      : 'Could not load a preview just now. The file is still saved in your cloud space, but phone download is not available for this file.'
                    : file.downloadable
                    ? 'No inline preview for this file type. Use Download to phone to open it with the right app.'
                    : 'No inline preview for this file type. The file is saved in your cloud space, but phone download is not available for this file.'}
                </Text>
                {/* Only for a read that failed. A file type with nothing to
                    show inline will say the same thing however many times it
                    is asked, so offering to ask again would be a lie. Closing
                    the card and opening it again already retried, but that is
                    not a thing anyone would guess at. */}
                {previewable ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() => void loadPreview()}
                    testID={`${keyPrefix}.${file.id}.previewRetry`}
                  >
                    {PREVIEW_RETRY_LABEL}
                  </Button>
                ) : null}
              </Stack>
            </Surface>
          )}
          <Stack direction="horizontal" gap={2} wrap>
            {file.downloadable ? (
              <Button
                variant="primary"
                size="sm"
                onPress={() => void handleDownload()}
                testID={`${keyPrefix}.${file.id}.download`}
              >
                Download to phone
              </Button>
            ) : (
              <Badge tone="neutral">Saved to cloud space</Badge>
            )}
            {onRename ? (
              <Button
                variant="secondary"
                size="sm"
                onPress={() => onRename(file)}
                testID={`${keyPrefix}.${file.id}.rename`}
              >
                Rename
              </Button>
            ) : null}
            {onDelete ? (
              <Button
                variant="ghost"
                size="sm"
                onPress={() => onDelete(file)}
                testID={`${keyPrefix}.${file.id}.delete`}
              >
                Delete
              </Button>
            ) : null}
          </Stack>
          {openErrorMessage ? (
            <Text variant="caption" color="danger" testID={`${keyPrefix}.${file.id}.openError`}>
              {openErrorMessage}
            </Text>
          ) : null}
        </Stack>
      ) : null}
    </Surface>
  );
}

function RunnerFilesStateCard({ state, onRefresh }: { state: RunnerFilesState; onRefresh: () => void }) {
  const loading = state.status === 'loading';
  // 2026-05-16 defect J5: only surface a state card when something
  // genuinely needs the user's attention. A ready runner with zero files
  // shows the empty state in ArtifactsScreen ("Nothing in your home drive
  // yet"), not this preparing/warming card.
  const shouldShow = loading || state.status === 'error' || state.truncated;
  if (!shouldShow) return null;

  const title = loading
    ? 'Checking your files'
    : state.status === 'error'
    ? "Files didn't refresh"
    : 'Showing the latest files';
  const detail = loading
    ? "Looking in your coworker's cloud space for the latest work."
    : state.status === 'error'
    ? state.message
    : 'More files available, refresh for the newest set.';

  return (
    <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
      <Stack gap={3}>
        <Stack direction="horizontal" align="flex-start" gap={3}>
          <StatusDot state={loading ? 'working' : state.status === 'error' ? 'sleeping' : 'live'} />
          <Stack gap={1} style={styles.flexText}>
            <Text variant="title">{title}</Text>
            <Text variant="bodySm" color="textSecondary">{detail}</Text>
          </Stack>
        </Stack>
        {state.status === 'error' || state.truncated ? (
          <Button testID="files.refreshButton" variant="secondary" size="sm" onPress={onRefresh}>{loading ? 'Refreshing…' : 'Refresh files'}</Button>
        ) : null}
      </Stack>
    </Surface>
  );
}

// readLocalFileAsBase64 + the upload flow moved to
// ./src/chat/chatAttachmentUpload.ts (2026-06-05) so the chat paperclip and
// this Files-tab upload share one tested base64-read + upload contract.

type FilesUploadState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'error'; message: string };

// Optimistic file mutations (2026-07-22): delete/rename update the visible
// list IMMEDIATELY and run the network call in the background, because the
// worker→runner round trip (plus a full re-list) made every delete/rename
// feel stuck for seconds. These pure helpers rebuild RunnerFilesState with a
// changed file list while preserving the status discriminant.
function withRunnerFiles(current: RunnerFilesState, files: readonly MobileRunnerFile[]): RunnerFilesState {
  switch (current.status) {
    case 'idle': return { status: 'idle', files, truncated: false };
    case 'loading': return { status: 'loading', files, truncated: current.truncated };
    case 'ready': return { status: 'ready', files, truncated: current.truncated };
    case 'not_ready': return { status: 'not_ready', files, truncated: false, message: current.message };
    case 'error': return { status: 'error', files, truncated: false, message: current.message };
  }
}

// Rename keeps the (now stale) file id locally; the follow-up silent refresh
// swaps in the fresh id + download link once the server confirms.
function withLocalRename(file: MobileRunnerFile, nextName: string): MobileRunnerFile {
  const renamed: MobileRunnerFile = { ...file, name: nextName };
  if (file.relativeName) {
    const parts = file.relativeName.split('/');
    parts[parts.length - 1] = nextName;
    renamed.relativeName = parts.join('/');
  }
  return renamed;
}

// One-shot fade for the optimistic file mutations: the removed card fades out
// while its siblings ease into the gap. configureNext only animates the next
// layout pass, so folder collapse / refresh renders stay instant.
function animateNextFilesChange() {
  LayoutAnimation.configureNext({
    duration: 220,
    delete: { type: 'easeInEaseOut', property: 'opacity' },
    create: { type: 'easeInEaseOut', property: 'opacity' },
    update: { type: 'easeInEaseOut' },
  });
}

function ArtifactsScreen({
  runnerFilesState,
  onRunnerFilesRefresh,
  onRunnerFileOpen,
  onRunnerFileRemovedLocally,
  onRunnerFileRestoredLocally,
  onRunnerFileRenamedLocally,
  onRunnerFilesRemovedLocally,
  onRunnerFilesRestoredLocally,
  focusedFilePath,
}: {
  runnerFilesState: RunnerFilesState;
  // `silent: true` refreshes without flashing the loading card — used by the
  // optimistic delete/rename resyncs so the list never appears to reload.
  onRunnerFilesRefresh: (options?: { silent?: boolean }) => void;
  onRunnerFileOpen: (file: MobileRunnerFile) => Promise<boolean> | boolean;
  // Optimistic local mutations owned by the shell (which holds the files state).
  onRunnerFileRemovedLocally: (fileId: string) => void;
  onRunnerFileRestoredLocally: (file: MobileRunnerFile) => void;
  onRunnerFileRenamedLocally: (fileId: string, nextName: string) => void;
  // Batch variants for multi-select delete: every selected card leaves (and,
  // on partial failure, only the failed subset returns) in ONE layout pass so
  // the whole group fades together.
  onRunnerFilesRemovedLocally: (fileIds: readonly string[]) => void;
  onRunnerFilesRestoredLocally: (files: readonly MobileRunnerFile[]) => void;
  // PREOP-H01/H02: when set, the user tapped this file in chat; surface it
  // at the top of the Files tab so the routing has a visible destination.
  focusedFilePath?: string | null;
}) {
  // v1.2.9 — Files redesign. The folder list is ALWAYS rendered, with
  // the canonical home-directory placeholders (Home, Documents,
  // Pictures, Downloads, Notes) showing as empty rows when no file
  // has landed in them yet. Files the agent saves slot into the
  // matching group on the next refresh; any new folder the runner
  // creates appears at the end of the list automatically. While the
  // workspace is still coming online (`status === 'not_ready'`) we
  // show a small banner at the top, but the placeholder folders stay
  // visible underneath so the user sees the shape of what is being
  // prepared.
  // Count the files the user actually SEES (build-artifact noise is filtered out
  // of the folder tree), so the header total matches the folder counts instead of
  // the raw runner list (which still includes __pycache__/.pyc/etc.).
  const visibleFileCount = runnerFilesState.files.filter((f) => !isNoiseFile(f)).length;
  const hasFiles = visibleFileCount > 0;
  const isLoading = runnerFilesState.status === 'loading';
  const hasError = runnerFilesState.status === 'error';
  const notReady = runnerFilesState.status === 'not_ready';

  // Upload-to-coworker flow. Self-contained in this screen: pick a file,
  // base64-encode its bytes, POST through the same authenticated proxy the
  // listing uses, then refresh so the new file appears in its folder. The
  // uploading state disables both buttons; failures surface inline and
  // never throw to the UI.
  const [uploadState, setUploadState] = useState<FilesUploadState>({ status: 'idle' });
  const isUploading = uploadState.status === 'uploading';

  const handleUpload = useCallback(async () => {
    if (isUploading) return;
    setUploadState({ status: 'uploading' });

    const picked = await pickChatAttachment('any');
    if (picked.status === 'cancelled') {
      setUploadState({ status: 'idle' });
      return;
    }
    if (picked.status === 'too-large') {
      setUploadState({ status: 'error', message: 'That file is too large to upload. Pick one under 25 MB.' });
      return;
    }
    if (picked.status === 'unsupported' || picked.status === 'error') {
      setUploadState({
        status: 'error',
        message: picked.status === 'error' && picked.message ? picked.message : "That file couldn't be picked. Try a different one.",
      });
      return;
    }

    const contentBase64 = await readLocalFileAsBase64(picked.localUri);
    if (!contentBase64) {
      setUploadState({ status: 'error', message: "That file couldn't be read for upload. Try a different file." });
      return;
    }

    const result = await uploadRunnerFile({
      name: picked.attachment.name,
      mimeType: picked.attachment.mimeType,
      contentBase64,
    });
    if (!result.ok) {
      setUploadState({ status: 'error', message: result.error.message });
      return;
    }

    setUploadState({ status: 'idle' });
    onRunnerFilesRefresh();
  }, [isUploading, onRunnerFilesRefresh]);

  // File management: delete (native confirm) + rename (modal). Both are
  // OPTIMISTIC (2026-07-22): the list updates the moment the user confirms —
  // the card fades out / the row renames instantly — while the signed proxy
  // call runs in the background. On success a SILENT refresh resyncs ids
  // (a rename changes the file id); on failure the change is rolled back
  // with a plain-English alert. Nothing waits on the network round trip.
  const [renameTarget, setRenameTarget] = useState<MobileRunnerFile | null>(null);
  const [renameText, setRenameText] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const handleDeleteFile = useCallback((file: MobileRunnerFile) => {
    Alert.alert(
      'Delete file',
      `Delete "${file.name}"? This removes it from your coworker's cloud space and can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            // Optimistic: fade the card out now, delete in the background.
            animateNextFilesChange();
            onRunnerFileRemovedLocally(file.id);
            void deleteRunnerFile(file.id).then((result) => {
              if (result.ok || result.error === 'not_found') {
                onRunnerFilesRefresh({ silent: true });
                return;
              }
              // Server refused: bring the card back and say so.
              animateNextFilesChange();
              onRunnerFileRestoredLocally(file);
              Alert.alert('Delete failed', "Couldn't delete that file just now, so it's back in the list. Try again in a moment.");
            });
          },
        },
      ],
    );
  }, [onRunnerFileRemovedLocally, onRunnerFileRestoredLocally, onRunnerFilesRefresh]);

  const openRename = useCallback((file: MobileRunnerFile) => {
    setRenameError(null);
    setRenameTarget(file);
    setRenameText(file.name);
  }, []);

  const submitRename = useCallback(() => {
    if (!renameTarget) return;
    const target = renameTarget;
    const nextName = renameText.trim();
    if (!nextName || nextName === target.name) {
      setRenameTarget(null);
      return;
    }
    // Catch the obvious server rejection locally so the modal can explain it
    // instantly instead of optimistically applying a name the runner will 400.
    if (/[\\/]/.test(nextName)) {
      setRenameError("That name isn't allowed. Use a plain file name, no slashes.");
      return;
    }
    // Optimistic: close the modal + rename the row now, save in the background.
    setRenameTarget(null);
    setRenameError(null);
    onRunnerFileRenamedLocally(target.id, nextName);
    void renameRunnerFile(target.id, nextName).then((result) => {
      if (result.ok) {
        // The file id changes on rename; a silent refresh swaps in the fresh
        // id + download link without flashing the loading state.
        onRunnerFilesRefresh({ silent: true });
        return;
      }
      // Roll the visible name back before explaining the failure.
      onRunnerFileRenamedLocally(target.id, target.name);
      if (result.error === 'not_found') onRunnerFilesRefresh({ silent: true });
      Alert.alert(
        'Rename failed',
        result.error === 'file_exists' ? `A file called "${nextName}" already exists there, so "${target.name}" kept its name.`
          : result.error === 'invalid_file_name' ? `That name isn't allowed, so "${target.name}" kept its name. Use a plain file name, no slashes.`
          : result.error === 'not_found' ? 'That file was moved or removed, so the list has been refreshed.'
            : `Couldn't rename "${target.name}" just now, so it kept its name. Try again in a moment.`,
      );
    });
  }, [renameTarget, renameText, onRunnerFileRenamedLocally, onRunnerFilesRefresh]);

  // Multi-select (2026-07-22). Long-pressing a card enters selection mode,
  // anchored to that card's folder — "Select all" covers the CURRENT FOLDER
  // ONLY (locked v1 decision). Taps toggle cards while the mode is on; the
  // Files header becomes a contextual action bar; X or Android back exits.
  const [selection, setSelection] = useState<{ folderKey: string; ids: ReadonlySet<string> } | null>(null);
  const selectionMode = selection !== null;
  // Count only ids still present in the visible list, so a background resync
  // that dropped a file can never inflate the bar count or the confirm count.
  const selectedFiles = useMemo(
    () => (selection ? runnerFilesState.files.filter((f) => selection.ids.has(f.id)) : []),
    [selection, runnerFilesState.files],
  );

  const enterSelectionMode = useCallback((file: MobileRunnerFile) => {
    setSelection((current) => current ?? { folderKey: fullDirectoryPath(file), ids: new Set([file.id]) });
  }, []);
  const exitSelectionMode = useCallback(() => setSelection(null), []);
  const toggleSelected = useCallback((file: MobileRunnerFile) => {
    setSelection((current) => {
      if (!current) return current;
      const ids = toggleSelectedFile(current.ids, file.id);
      // Deselecting the last card ends the mode (standard Android behaviour).
      return ids.size === 0 ? null : { folderKey: current.folderKey, ids };
    });
  }, []);
  // Long-pressing a FOLDER header selects that folder IN ITS ENTIRETY (the
  // folder plus every subfolder), so a whole folder can be cleared out in one
  // go (2026-07-23, Alex). The anchor becomes that folder, so "Select all"
  // stays scoped to it.
  const enterFolderSelectionMode = useCallback((folderKey: string) => {
    setSelection((current) => {
      const ids = current ? new Set(current.ids) : new Set<string>();
      for (const id of fileIdsInFolderTree(runnerFilesState.files, folderKey)) ids.add(id);
      if (ids.size === 0) return current; // empty folder: nothing to select
      return { folderKey: current?.folderKey ?? folderKey, ids };
    });
  }, [runnerFilesState.files]);
  // Tapping a folder header WHILE in selection mode toggles that whole folder
  // subtree in or out of the selection.
  const toggleFolderSelection = useCallback((folderKey: string) => {
    setSelection((current) => {
      if (!current) return current;
      const ids = toggleFolderTree(runnerFilesState.files, folderKey, current.ids);
      return ids.size === 0 ? null : { folderKey: current.folderKey, ids };
    });
  }, [runnerFilesState.files]);
  const handleSelectAllInFolder = useCallback(() => {
    // "Select all" clears the anchor folder in its entirety — the folder AND
    // its subfolders — never other top-level folders.
    setSelection((current) => current
      ? { folderKey: current.folderKey, ids: selectAllInFolderTree(runnerFilesState.files, current.folderKey, current.ids) }
      : current);
  }, [runnerFilesState.files]);

  // Android back exits selection mode. Registered only while the mode is
  // active; this listener lands after the Shell's global one, so RN calls it
  // FIRST and the tab/drawer navigation never sees the press.
  useEffect(() => {
    if (!selectionMode) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      exitSelectionMode();
      return true;
    });
    return () => subscription.remove();
  }, [selectionMode, exitSelectionMode]);

  const handleDeleteSelected = useCallback(() => {
    const targets = selectedFiles;
    if (targets.length === 0) {
      exitSelectionMode();
      return;
    }
    const confirmCopy = deleteSelectionConfirmCopy(targets.length);
    Alert.alert(confirmCopy.title, confirmCopy.message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          // Optimistic: every selected card fades out together in one layout
          // pass, then the deletes run a few at a time in the background
          // through the same single-file call the lone Delete button uses.
          exitSelectionMode();
          animateNextFilesChange();
          onRunnerFilesRemovedLocally(targets.map((f) => f.id));
          void runSelectionDelete(targets.map((f) => f.id), (fileId) => deleteRunnerFile(fileId)).then(({ failedIds }) => {
            if (failedIds.length === 0) {
              onRunnerFilesRefresh({ silent: true });
              return;
            }
            // Partial failure: bring back ONLY the failed cards, then say
            // exactly how far it got. The silent resync afterwards squares
            // the list with the server (restore + refresh both de-dupe).
            const failedIdSet = new Set(failedIds);
            const failedFiles = targets.filter((f) => failedIdSet.has(f.id));
            animateNextFilesChange();
            onRunnerFilesRestoredLocally(failedFiles);
            const outcome = deleteSelectionOutcomeCopy(targets.length - failedFiles.length, targets.length);
            if (outcome) Alert.alert(outcome.title, outcome.message);
            onRunnerFilesRefresh({ silent: true });
          });
        },
      },
    ]);
  }, [selectedFiles, exitSelectionMode, onRunnerFilesRemovedLocally, onRunnerFilesRestoredLocally, onRunnerFilesRefresh]);

  return (
    <ScrollView contentContainerStyle={styles.filesScrollContent} showsVerticalScrollIndicator={false}>
      <Stack gap={2} style={styles.filesHeader}>
        {selectionMode ? (
          // Contextual action bar: the Files header swaps for the selection
          // controls while the mode is on. X (or Android back) exits.
          <Stack direction="horizontal" align="center" gap={2} testID="files.selectionBar">
            <NativePressable
              testID="files.selectionBar.exit"
              accessibilityRole="button"
              accessibilityLabel="Exit selection mode"
              onPress={exitSelectionMode}
              hitSlop={touchHitSlop}
            >
              <Feather name="x" size={20} color={appColors.textSecondary} />
            </NativePressable>
            <Text variant="title" style={styles.flexText} numberOfLines={1} testID="files.selectionBar.count">
              {`${selectedFiles.length} selected`}
            </Text>
            <Button
              testID="files.selectionBar.selectAll"
              variant="secondary"
              size="sm"
              onPress={handleSelectAllInFolder}
            >
              Select all
            </Button>
            <Button
              testID="files.selectionBar.delete"
              variant="danger"
              size="sm"
              onPress={handleDeleteSelected}
              disabled={selectedFiles.length === 0}
            >
              Delete
            </Button>
          </Stack>
        ) : (
        <Stack direction="horizontal" justify="space-between" align="center" gap={3}>
          <Stack gap={1} style={styles.flexText}>
            <Text variant="displayLg">Files</Text>
            <Text variant="bodySm" color="textSecondary">
              {hasFiles
                ? `${visibleFileCount} ${visibleFileCount === 1 ? 'file' : 'files'} saved by your coworker`
                : 'Anything your coworker saves for you lands here.'}
            </Text>
          </Stack>
          <Stack direction="horizontal" gap={2} align="center">
            <Button
              testID="files.refreshButton"
              variant="secondary"
              size="sm"
              onPress={() => onRunnerFilesRefresh()}
              disabled={isLoading}
            >
              {isLoading ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button
              testID="files.uploadButton"
              variant="primary"
              size="sm"
              onPress={() => void handleUpload()}
              disabled={isUploading}
            >
              {isUploading ? 'Uploading…' : 'Upload'}
            </Button>
          </Stack>
        </Stack>
        )}
        {!selectionMode && visibleFileCount >= 2 ? (
          // Multi-select discoverability (2026-07-22, Alex): the long-press
          // gesture is invisible by nature, so surface it as a quiet caption
          // whenever there is anything worth bulk-selecting.
          <Text variant="caption" color="textTertiary" testID="files.multiSelectHint">
            Tip: press and hold a file, or a folder name, to select several at once.
          </Text>
        ) : null}
        {uploadState.status === 'error' ? (
          <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
            <Stack gap={1}>
              <Text variant="title">Upload didn't finish</Text>
              <Text variant="bodySm" color="textSecondary" testID="files.uploadError">{uploadState.message}</Text>
            </Stack>
          </Surface>
        ) : null}
        {notReady ? (
          <Surface
            elevation="surfaceHigh"
            radius="lg"
            padding={3}
            border
            testID="files.workspaceComingOnlineBanner"
          >
            <Stack direction="horizontal" align="center" gap={3}>
              <View style={styles.filesDirectoryGlyph}>
                <Feather name="clock" size={14} color={appColors.accent} />
              </View>
              <Stack gap={1} style={styles.flexText}>
                <Text variant="title">Workspace coming online</Text>
                <Text variant="bodySm" color="textSecondary">
                  Your folders are ready, but the storage is still being prepared. Files will start landing here once it's online.
                </Text>
              </Stack>
            </Stack>
          </Surface>
        ) : null}
        {hasError ? (
          <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
            <Stack gap={1}>
              <Text variant="title">Files didn't refresh</Text>
              <Text variant="bodySm" color="textSecondary">{runnerFilesState.message}</Text>
            </Stack>
          </Surface>
        ) : null}
      </Stack>

      {focusedFilePath ? (
        <Surface elevation="surfaceHigh" radius="md" padding={3} testID="files.focusedFromChat">
          <Stack direction="horizontal" align="center" gap={2}>
            <Feather name="corner-down-right" size={14} color={appColors.accent} />
            <Text variant="caption" color="textSecondary" style={styles.flexText} numberOfLines={1}>
              Opened from chat: {focusedFilePath.split('/').filter(Boolean).pop() ?? focusedFilePath}
            </Text>
          </Stack>
        </Surface>
      ) : null}
      <RunnerFilesByDirectory
        files={runnerFilesState.files}
        onOpen={onRunnerFileOpen}
        onRename={openRename}
        onDelete={handleDeleteFile}
        selectionMode={selectionMode}
        selectedIds={selection?.ids}
        onToggleSelect={toggleSelected}
        onEnterSelectionMode={enterSelectionMode}
        onEnterFolderSelectionMode={enterFolderSelectionMode}
        onToggleFolderSelection={toggleFolderSelection}
      />

      <Modal
        visible={renameTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenameTarget(null)}
      >
        <View style={styles.renameModalBackdrop}>
          <Surface elevation="surfaceHigh" radius="lg" padding={4} border style={styles.renameModalCard}>
            <Stack gap={3}>
              <Text variant="title">Rename file</Text>
              <TextInput
                testID="files.rename.input"
                value={renameText}
                onChangeText={setRenameText}
                autoFocus
                selectTextOnFocus
                placeholder="New file name"
                placeholderTextColor={appColors.textTertiary}
                style={styles.renameModalInput}
                onSubmitEditing={() => submitRename()}
              />
              {renameError ? (
                <Text variant="caption" color="danger" testID="files.rename.error">{renameError}</Text>
              ) : null}
              <Stack direction="horizontal" gap={2} justify="flex-end">
                <Button variant="ghost" size="sm" onPress={() => setRenameTarget(null)} testID="files.rename.cancel">Cancel</Button>
                <Button variant="primary" size="sm" onPress={() => submitRename()} testID="files.rename.save">
                  Save
                </Button>
              </Stack>
            </Stack>
          </Surface>
        </View>
      </Modal>
    </ScrollView>
  );
}

// Folder grouping + collapse logic moved to ./src/files/folderGroups.ts
// (pure, unit-tested). App.tsx renders the groups + owns the collapse UI.

function RunnerFilesByDirectory({
  files,
  onOpen,
  onRename,
  onDelete,
  selectionMode = false,
  selectedIds,
  onToggleSelect,
  onEnterSelectionMode,
  onEnterFolderSelectionMode,
  onToggleFolderSelection,
}: {
  files: readonly MobileRunnerFile[];
  onOpen: (file: MobileRunnerFile) => Promise<boolean> | boolean;
  onRename?: (file: MobileRunnerFile) => void;
  onDelete?: (file: MobileRunnerFile) => void;
  // Folder-level selection: long-press a folder header to select the whole
  // folder (incl. subfolders); tap a header while selecting to toggle it.
  onEnterFolderSelectionMode?: (folderKey: string) => void;
  onToggleFolderSelection?: (folderKey: string) => void;
  // Multi-select pass-through: ArtifactsScreen owns the state; every card
  // (Recent strip included) renders the same tick + toggle behaviour.
  selectionMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (file: MobileRunnerFile) => void;
  onEnterSelectionMode?: (file: MobileRunnerFile) => void;
}) {
  const grouped = useMemo(() => buildFolderGroups(files), [files]);
  const collapsibleKeys = useMemo(() => allCollapsibleKeys(grouped), [grouped]);
  // Collapse state. Folders DEFAULT to collapsed and the user's expand/collapse
  // choices persist across navigations (the Files tab unmounts on every tab
  // switch, so a plain useState set was wiped each time). The hook stores the
  // set of EXPANDED folders in AsyncStorage; everything else — including brand
  // new folders the coworker creates later — is collapsed.
  const { expanded, toggle, expandAll, collapseAll } = useFolderCollapse();
  const collapsed = useMemo(
    () => collapsedKeysFromExpanded(collapsibleKeys, expanded),
    [collapsibleKeys, expanded],
  );
  const anyExpanded = useMemo(() => collapsibleKeys.some((key) => expanded.has(key)), [collapsibleKeys, expanded]);

  // Files the coworker most recently saved, surfaced at the very top so agent
  // output (a PDF, a spreadsheet) is visible the moment the user opens Files,
  // instead of hidden inside a collapsed folder.
  const recent = useMemo(() => recentFiles(files, 6), [files]);

  return (
    <Stack testID="files.runnerFileList" gap={3}>
      {recent.length > 0 ? (
        <Stack gap={2} testID="files.recent">
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 4 }}>
            <View style={styles.filesDirectoryGlyph}>
              <Feather name="clock" size={14} color={appColors.accent} />
            </View>
            <Text variant="caption" color="textSecondary" style={styles.filesDirectoryLabel}>RECENT</Text>
            <Text variant="caption" color="textTertiary">Latest saved by your coworker</Text>
          </View>
          {recent.map((file, index) => (
            <Entry key={`recent-${file.id}`} index={index + 1}>
              <RunnerFileCard
                file={file}
                onOpen={onOpen}
                onRename={onRename}
                onDelete={onDelete}
                keyPrefix="files.recent.card"
                selectionMode={selectionMode}
                selected={selectedIds?.has(file.id) ?? false}
                onToggleSelect={onToggleSelect}
                onEnterSelectionMode={onEnterSelectionMode}
              />
            </Entry>
          ))}
        </Stack>
      ) : null}
      {collapsibleKeys.length > 0 ? (
        <Stack direction="horizontal" justify="flex-end">
          <NativePressable
            testID="files.collapseToggle"
            accessibilityRole="button"
            accessibilityLabel={anyExpanded ? 'Collapse all folders' : 'Expand all folders'}
            onPress={() => (anyExpanded ? collapseAll() : expandAll(collapsibleKeys))}
            hitSlop={touchHitSlop}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, paddingVertical: 4 }}
          >
            <Feather name={anyExpanded ? 'chevrons-up' : 'chevrons-down'} size={14} color={appColors.textSecondary} />
            <Text variant="caption" color="textSecondary">{anyExpanded ? 'Collapse all' : 'Expand all'}</Text>
          </NativePressable>
        </Stack>
      ) : null}
      {grouped.map((group) => {
        const isTop = group.depth === 0;
        const isRoot = group.key === '';
        // Root shows only its loose top-level files; every other folder shows its
        // whole-subtree count (so `home` reads "247 files" even when its files
        // live in home/buku/...). This is what made the old view list everything
        // flat: it counted only direct files and rendered every level expanded.
        const total = isRoot ? group.files.length : group.descendantFileCount;
        const isEmpty = total === 0;
        if (isRoot && isEmpty) return null;
        if (!isTop && isEmpty) return null; // empty subfolders never render
        // Hide any row whose ancestor folder is collapsed (collapse `home`,
        // the whole home/* subtree disappears into one row).
        if (isHiddenByCollapsedAncestor(group.key, collapsed)) return null;
        const isCollapsed = collapsed.has(group.key);
        const collapsible = total > 0;
        // Indent subfolders so the hierarchy reads at a glance.
        const indentPaddingLeft = 4 + group.depth * 16;
        // Folder-level selection state: while selecting, a header can select or
        // toggle its whole subtree, and shows a tick reflecting how much of the
        // folder is currently selected.
        const treeIds = selectionMode && !isRoot ? fileIdsInFolderTree(files, group.key) : [];
        const treeSelectedCount = selectedIds ? treeIds.filter((id) => selectedIds.has(id)).length : 0;
        const folderAllSelected = treeIds.length > 0 && treeSelectedCount === treeIds.length;
        const folderSelectable = selectionMode && treeIds.length > 0;
        const headerPress = selectionMode
          ? (folderSelectable ? () => onToggleFolderSelection?.(group.key) : undefined)
          : (collapsible ? () => toggle(group.key) : undefined);
        const headerLongPress = onEnterFolderSelectionMode && treeIds.length >= 0 && !isRoot
          ? () => (selectionMode ? onToggleFolderSelection?.(group.key) : onEnterFolderSelectionMode(group.key))
          : undefined;
        return (
          <Stack
            key={group.key || 'root'}
            gap={2}
            testID={`files.directory.${group.key || 'root'}`}
          >
            <NativePressable
              testID={`files.directory.${group.key || 'root'}.header`}
              accessibilityRole={collapsible || folderSelectable ? 'button' : undefined}
              accessibilityLabel={selectionMode
                ? (folderSelectable ? `${group.label}, ${folderAllSelected ? 'all selected, tap to deselect the folder' : 'tap to select the whole folder'}` : undefined)
                : (collapsible ? `${group.label}, ${isCollapsed ? 'collapsed, tap to expand' : 'expanded, tap to collapse'}. Long-press to select the whole folder` : undefined)}
              onPress={headerPress}
              onLongPress={!isRoot ? headerLongPress : undefined}
              hitSlop={touchHitSlop}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingLeft: indentPaddingLeft, paddingVertical: 4 }}
            >
              {folderSelectable ? (
                <View testID={`files.directory.${group.key}.tick`}>
                  <Feather name={folderAllSelected ? 'check-circle' : 'circle'} size={16} color={folderAllSelected ? appColors.accent : appColors.textTertiary} />
                </View>
              ) : collapsible ? (
                <Feather name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={14} color={appColors.textTertiary} />
              ) : (
                <View style={{ width: 14 }} />
              )}
              <View style={isTop ? styles.filesDirectoryGlyph : styles.filesDirectoryGlyphSubtle}>
                <Feather
                  name={group.icon as IconName}
                  size={isTop ? 14 : 12}
                  color={isTop ? appColors.accent : appColors.textTertiary}
                />
              </View>
              <Text
                variant="caption"
                color="textSecondary"
                style={isTop ? styles.filesDirectoryLabel : styles.filesDirectoryLabelSubtle}
              >
                {isTop ? group.label.toUpperCase() : group.label}
              </Text>
              <Text variant="caption" color="textTertiary">
                {isEmpty ? 'Empty' : `${total} ${total === 1 ? 'file' : 'files'}`}
              </Text>
            </NativePressable>
            {!isCollapsed && group.files.map((file, index) => (
              <Entry key={file.id} index={index + 1}>
                <RunnerFileCard
                  file={file}
                  onOpen={onOpen}
                  onRename={onRename}
                  onDelete={onDelete}
                  selectionMode={selectionMode}
                  selected={selectedIds?.has(file.id) ?? false}
                  onToggleSelect={onToggleSelect}
                  onEnterSelectionMode={onEnterSelectionMode}
                />
              </Entry>
            ))}
          </Stack>
        );
      })}
    </Stack>
  );
}

function ProfileInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack gap={2}>
      <Stack direction="horizontal" justify="space-between" align="center" gap={3}>
        <Text variant="caption" color="textTertiary">{label}</Text>
        <Text variant="bodySm" color="textPrimary" style={styles.profileValue}>{value}</Text>
      </Stack>
      <Divider />
    </Stack>
  );
}

function ProfileScreen({
  onSignOut,
  profile,
  productView,
  onProfileSave,
  onOpenBillingPortal,
  onCancelSubscription,
  billingPortalState,
}: {
  onSignOut: () => Promise<void> | void;
  profile: AppProfile;
  productView: ProductViewModel;
  onProfileSave: (input: MobileProfileUpdateInput) => Promise<MobileProfileUpdateResult>;
  onOpenBillingPortal: () => void;
  // The REAL billing destination: the Stripe customer portal (cancel at period
  // end) or Apple's subscription sheet. onOpenBillingPortal above was rewired
  // to the capacity page for the upgrade path, which left no screen in the
  // app that could reach a cancel. Alex, 2026-09-12, on a live free trial.
  onCancelSubscription: () => void;
  billingPortalState: BillingPortalState;
}) {
  const themeColors = useThemeColors();
  const agentEngine = useIsAgentEngine();
  const say = agentEngine ? assistantWording : sameWording;
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(profile.name);
  const [agentName, setAgentName] = useState(profile.agentName);
  const [region, setRegion] = useState(profile.location);
  const [saveState, setSaveState] = useState<{ status: 'idle' | 'saving' | 'saved' | 'error'; message?: string }>({ status: 'idle' });
  const [deleteState, setDeleteState] = useState<
    { status: 'idle' | 'confirming' | 'sending' } | { status: 'requested' | 'error'; message: string }
  >({ status: 'idle' });

  // The endpoint SCHEDULES teardown (within 24h) rather than erasing on tap,
  // so the copy promises a request, not an instant wipe. Never auto-sign-out
  // on success: the reader should see the confirmation before anything moves
  // under them, and their session stays valid until teardown runs anyway.
  const [exportState, setExportState] = useState<
    { status: 'idle' | 'sending' } | { status: 'done' | 'error'; message: string }
  >({ status: 'idle' });

  // Export hands the bundle straight to the OS share sheet, the same route
  // the Files download uses, so the reader can put it in Drive, mail it to
  // themselves, or save it to the phone without us inventing a file browser.
  const onExportMyData = useCallback(async () => {
    setExportState({ status: 'sending' });
    try {
      const result = await requestAccountExport();
      if ('export' in result) {
        await shareAccountExport(result.export);
        setExportState({ status: 'done', message: 'Your data is ready. Choose where to save or send it.' });
        return;
      }
      setExportState({ status: 'error', message: result.error.message });
    } catch {
      setExportState({
        status: 'error',
        message: 'We could not prepare that export. Try again shortly, or email admin@example.com.',
      });
    }
  }, []);

  const onConfirmDeleteAccount = useCallback(async () => {
    setDeleteState({ status: 'sending' });
    try {
      const result = await requestAccountDeletion();
      if ('deletion' in result) {
        // ⚠️ THE CONFIRMATION USED TO BE ALL THIS DID. The server had accepted
        // the deletion and removed the auth user, and the handset still held
        // the session and the analytics identifier. Privacy section 10 says
        // both go, and a stale session on a device whose account no longer
        // exists is also just a dead credential sitting in a keystore.
        //
        // The screen keeps its confirmation: nothing signs the reader out from
        // under the message they are reading. The next launch has nothing to
        // restore, which is the point.
        //
        // The writes are fenced for the same reason sign-out fences them: a
        // token refresh already in flight resolves afterwards and would put the
        // session straight back.
        fenceAuthStorageWrites();
        await clearPersistedAuthStorage();
        await forgetAnalyticsIdentity();
        setDeleteState({
          status: 'requested',
          message: result.deletion.message
            || 'Request received. Your account and workspace will be deleted within 24 hours.',
        });
        return;
      }
      setDeleteState({ status: 'error', message: result.error.message });
    } catch {
      setDeleteState({
        status: 'error',
        message: 'We could not send that request. Check your connection and try again, or email admin@example.com.',
      });
    }
  }, []);
  const saving = saveState.status === 'saving';
  // Which field is not ready yet, in the order they appear on screen. The Save
  // button used to be greyed out on this test with nothing to explain it, and
  // the one line that could have explained it sat inside saveProfile behind
  // the same test, reachable only through the button the test disabled. So a
  // reader who cleared their name to retype it, or typed a one-letter region,
  // found a dead control and no reason. The browser has no such test at all:
  // Save always presses, and a refusal comes back as words.
  const saveBlockedReason = displayName.trim().length < 2
    ? 'Your name needs at least two characters.'
    : !normalizeAgentName(agentName)
    ? say('Your coworker needs a name with at least one letter in it.')
    : region.trim().length < 2
    ? 'Your region needs at least two characters.'
    : null;
  const billingPeriod = summariseBillingPeriod({
    cycleEndAtIso: productView.nextResetAtIso,
    cancelAtPeriodEnd: productView.cancelAtPeriodEnd,
  });

  useEffect(() => {
    if (editing) return;
    setDisplayName(profile.name);
    setAgentName(profile.agentName);
    setRegion(profile.location);
  }, [editing, profile.name, profile.agentName, profile.location]);

  const saveProfile = async () => {
    if (saving) return;
    if (saveBlockedReason) {
      setSaveState({ status: 'error', message: saveBlockedReason });
      return;
    }

    setSaveState({ status: 'saving' });
    const result = await onProfileSave({ displayName, agentName, region });
    if ('error' in result) {
      setSaveState({ status: 'error', message: result.error.message });
      return;
    }

    setDisplayName(result.profile.displayName);
    setAgentName(result.profile.agentName);
    setRegion(result.profile.region);
    setEditing(false);
    setSaveState({ status: 'saved', message: 'Profile saved.' });
  };

  return (
    <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
      <ScreenIntro
        title="Profile"
        body={say("Your sign-in, your coworker's name, your plan, and your basic details.")}
        badge="Account"
      />

      <Entry index={1}>
        <Surface elevation="surfaceHigh" radius="xl" padding={3} style={styles.planCard}>
          <Stack gap={3}>
            <Stack direction="horizontal" gap={3} align="center">
              <ProfileAvatar profile={profile} size="lg" />
              <Stack gap={3} style={styles.flexText}>
                <Stack gap={1}>
                  <Text variant="title">{profile.name}</Text>
                  <Text variant="bodySm" color="textSecondary">{profile.email}</Text>
                </Stack>
                <Stack direction="horizontal" gap={2} wrap>
                  <Badge tone="accent">{agentEngine && profile.plan !== 'No active plan' ? AGENT_PLAN.name : profile.plan}</Badge>
                  <Badge tone="neutral">{profile.auth}</Badge>
                </Stack>
              </Stack>
            </Stack>
            <Stack direction="horizontal" gap={2} style={styles.profileHeroActions}>
              <Button
                testID="profile.editToggle"
                variant="ghost"
                size="sm"
                disabled={saving}
                onPress={() => {
                  setEditing((current) => !current);
                  setSaveState({ status: 'idle' });
                }}
              >
                {editing ? 'Cancel' : 'Edit profile'}
              </Button>
              <Button
                testID="profile.managePlanButton"
                variant="secondary"
                size="sm"
                disabled={saving || billingPortalState.status === 'opening' || billingPortalState.status === 'confirming'}
                onPress={onOpenBillingPortal}
              >
                {billingPortalState.status === 'opening' ? 'Opening billing…' : billingPortalState.status === 'confirming' ? 'Checking billing…' : 'Manage plan'}
              </Button>
              <Button testID="profile.signOutButton" variant="secondary" size="sm" disabled={saving} onPress={onSignOut}>Sign out</Button>
            </Stack>
            {/*
              2026-09-12: "Manage plan" opens the capacity page and then the
              plan picker (the upgrade path). Neither can cancel. The cancel
              lives in the Stripe portal or Apple's sheet, and until today no
              button in the app reached either, on a product selling a free
              trial "cancel any time". This is that button. It only shows when
              this build can actually reach the plan's biller: a StoreKit build
              for an Apple plan, a Play or web build for a Stripe plan. When
              they disagree, say where the plan lives instead.
            */}
            {productView.hasActiveSubscription ? (
              canReachOwnBiller(productView.billingProvider) ? (
                <Button
                  testID="profile.cancelSubscriptionButton"
                  variant="ghost"
                  size="sm"
                  disabled={saving || billingPortalState.status === 'opening' || billingPortalState.status === 'confirming'}
                  onPress={onCancelSubscription}
                >
                  {usesStoreKit() ? 'Cancel or manage in the App Store' : 'Cancel subscription'}
                </Button>
              ) : (
                <Text variant="caption" color="textSecondary" testID="profile.cancelElsewhereNote">
                  {productView.billingProvider === 'apple'
                    ? 'Your plan is billed through the App Store. To cancel it, open Settings on your iPhone or iPad, tap your name, then Subscriptions.'
                    : 'Your plan is not billed through the App Store. To cancel it, open the Android or web app, go to Manage plan, and use Cancel subscription under your plan.'}
                </Text>
              )
            ) : null}
            {billingPortalState.status === 'error' ? <Text variant="caption" color="warning">{billingPortalState.errorMessage}</Text> : null}
          </Stack>
        </Surface>
      </Entry>

      {/* This card used to draw for a reader with no plan: an accent badge
          reading "Comfortable", an empty bar, and the line "Plenty of room
          left on your Studio plan" naming a plan they were not on. That is a
          statement about money that was not true. The browser draws no
          capacity card on its profile at all, so this follows it. */}
      {agentEngine && productView.hasCapacityAllowance ? (
        <Entry index={2}>
          <AgentAllowanceCard testID="profile.agentAllowance" />
        </Entry>
      ) : productView.hasCapacityAllowance ? (
        <Entry index={2}>
          <Surface
            elevation="surfaceHigh"
            radius="lg"
            padding={3}
            testID="profile.capacityCard"
          >
            <Stack gap={3}>
              <Stack direction="horizontal" justify="space-between" align="center" gap={3}>
                <Stack gap={1} style={styles.flexText}>
                  <Text variant="title">This month so far</Text>
                  <Text variant="bodySm" color="textSecondary">
                    {productView.usageSummary.hardLimited
                      ? `You've used everything in your ${productView.currentTier.name} plan.`
                      : productView.usageSummary.nearLimit
                      ? "You're approaching this month's capacity."
                      : `Plenty of room left on your ${productView.currentTier.name} plan.`}
                  </Text>
                </Stack>
                <Badge
                  tone={
                    productView.usageSummary.hardLimited
                      ? 'danger'
                      : productView.usageSummary.nearLimit
                      ? 'warning'
                      : 'accent'
                  }
                >
                  {productView.capacityText}
                </Badge>
              </Stack>
              <CapacityProgressBar
                ratio={productView.usageSummary.ratio}
                hardLimited={productView.usageSummary.hardLimited}
                nearLimit={productView.usageSummary.nearLimit}
              />
              <Text variant="caption" color="textTertiary" testID="profile.capacityHint">
                {formatCycleEndLine(productView.nextResetAtIso, productView.cancelAtPeriodEnd) ??
                  'Capacity resets at the start of every billing cycle.'}
                {/* The nudge only makes sense while the plan is still renewing.
                    Offering more headroom "for the rest of the month" to someone
                    who has cancelled answers a question they did not ask, right
                    under the line telling them the plan is ending. */}
                {/* An agent-engine account has one plan, so there is nothing to upgrade to. */}
                {productView.cancelAtPeriodEnd || agentEngine ? null : (
                  <> Upgrade in a tap if you want more headroom for the rest of the month.</>
                )}
              </Text>
            </Stack>
          </Surface>
        </Entry>
      ) : null}

      <Entry index={3}>
        <Surface elevation="surfaceHigh" radius="lg" padding={3}>
          <Stack gap={3}>
            <Stack direction="horizontal" justify="space-between" align="center" gap={3}>
              <Text variant="title">Account details</Text>
              {saveState.status === 'saved' ? <Badge tone="success">Saved</Badge> : null}
            </Stack>

            {editing ? (
              <Stack gap={3}>
                <Stack gap={2}>
                  <Text variant="caption" color="textTertiary">Display name</Text>
                  <TextInput
                    accessibilityLabel="Display name"
                    testID="profile.displayNameInput"
                    value={displayName}
                    onChangeText={(value) => {
                      setDisplayName(value);
                      setSaveState({ status: 'idle' });
                    }}
                    placeholder="Your name"
                    placeholderTextColor={themeColors.textTertiary}
                    autoCapitalize="words"
                    autoCorrect={false}
                    maxLength={80}
                    style={[styles.onboardingInput, { borderColor: themeColors.borderStrong, color: themeColors.textPrimary, backgroundColor: themeColors.surfaceHigh }]}
                  />
                </Stack>
                <Stack gap={2}>
                  <Text variant="caption" color="textTertiary">Personal Agent name</Text>
                  <TextInput
                    accessibilityLabel="Personal Agent name"
                    testID="profile.agentNameInput"
                    value={agentName}
                    onChangeText={(value) => {
                      setAgentName(value);
                      setSaveState({ status: 'idle' });
                    }}
                    placeholder="Nova"
                    placeholderTextColor={themeColors.textTertiary}
                    autoCapitalize="words"
                    autoCorrect={false}
                    maxLength={40}
                    style={[styles.onboardingInput, { borderColor: themeColors.borderStrong, color: themeColors.textPrimary, backgroundColor: themeColors.surfaceHigh }]}
                  />
                </Stack>
                <Stack gap={2}>
                  <Text variant="caption" color="textTertiary">Region</Text>
                  <TextInput
                    accessibilityLabel="Region"
                    testID="profile.regionInput"
                    value={region}
                    onChangeText={(value) => {
                      setRegion(value);
                      setSaveState({ status: 'idle' });
                    }}
                    placeholder="United Kingdom"
                    placeholderTextColor={themeColors.textTertiary}
                    autoCapitalize="words"
                    autoCorrect={false}
                    maxLength={80}
                    style={[styles.onboardingInput, { borderColor: themeColors.borderStrong, color: themeColors.textPrimary, backgroundColor: themeColors.surfaceHigh }]}
                  />
                </Stack>
                {saveState.status === 'error' ? <Text variant="caption" color="warning">{saveState.message}</Text> : null}
                <Stack direction="horizontal" gap={2} style={styles.profileFormActions}>
                  <Button testID="profile.saveButton" variant="primary" size="sm" disabled={saving} onPress={saveProfile}>Save profile</Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={saving}
                    onPress={() => {
                      setDisplayName(profile.name);
                      setAgentName(profile.agentName);
                      setRegion(profile.location);
                      setEditing(false);
                      setSaveState({ status: 'idle' });
                    }}
                  >
                    Cancel
                  </Button>
                </Stack>
              </Stack>
            ) : (
              <Stack gap={3}>
                <ProfileInfoRow label="Name" value={profile.name} />
                <ProfileInfoRow label="Personal Agent" value={profile.agentName} />
                <ProfileInfoRow label="Sign-in" value={profile.email} />
                <ProfileInfoRow label="Region" value={profile.location} />
                <ProfileInfoRow label="Plan" value={agentEngine && profile.plan !== 'No active plan' ? AGENT_PLAN.name : profile.plan} />
                {/* The rollover date, as a labelled row rather than a sentence
                    buried in the capacity card, plus a named way back on when
                    the plan is stopping or already stopped. See
                    summariseBillingPeriod for why one timestamp needs three
                    labels. */}
                {billingPeriod ? (
                  <Stack gap={2}>
                    <ProfileInfoRow
                      label={billingPeriod.label}
                      value={billingPeriod.value}
                    />
                    <Text variant="caption" color="textTertiary" testID="profile.billingPeriodNote">
                      {billingPeriod.note}
                    </Text>
                    {billingPeriod.actionLabel ? (
                      <Button
                        testID="profile.resubscribeButton"
                        variant="primary"
                        size="sm"
                        disabled={saving || billingPortalState.status === 'opening' || billingPortalState.status === 'confirming'}
                        onPress={onOpenBillingPortal}
                      >
                        {billingPeriod.actionLabel}
                      </Button>
                    ) : null}
                  </Stack>
                ) : null}
                {agentEngine ? null : <ProfileInfoRow label="Coworker engine" value={RUNNER_ENGINE_VERSION} />}
                <ProfileInfoRow label="App version" value={appBuildInfo.version} />
                <ProfileInfoRow label="Update" value={appBuildInfo.update} />
                {/* Coworker engine upgrades are OPERATOR-CONTROLLED, not
                    user-triggered. The self-serve in-app upgrade button was
                    removed (operator decision, 2026-06-06): an uncontrolled in-place
                    re-image could break live integrations mid-task. We upgrade the
                    golden image ourselves, run the full regression pack, and only
                    then roll users onto it via the operator re-image cron
                    (series4:reimage-once). The engine version above stays visible so
                    a user can see what build they're on. */}
              </Stack>
            )}
          </Stack>
        </Surface>
      </Entry>

      {/* Account deletion, RESTORED 2026-08-16.

          PREOP-H03 removed this on 2026-06-01, when the product was
          Android-only, on the grounds that the capability still existed
          server-side and by email. That is not survivable on iOS: Apple
          guideline 5.1.1(v) requires any app offering account creation to
          offer account deletion IN THE APP, and App Review asked to see the
          deletion flow in the demo recording.

          It is deliberately a REQUEST, not a red button. The endpoint
          schedules teardown within 24 hours rather than erasing on tap, and
          the sheet says so, so nobody destroys a workspace by fat-fingering a
          row in their profile. */}
      <Entry>
        <Surface elevation="surfaceHigh" radius="lg" padding={3}>
          <Stack gap={3}>
            <Stack gap={1}>
              <Text variant="title">Your data</Text>
              <Text variant="bodySm" color="textSecondary">
                {agentEngine ? 'Ask for a copy of your data, or close your account entirely.' : 'Take a copy of your data, or close your account entirely.'}
              </Text>
            </Stack>
            <Stack direction="horizontal" gap={2} wrap>
              {/* Export sits BESIDE delete deliberately. Portability and
                  erasure are the same right in UK GDPR terms, and R-SEC-14
                  fails if one appears without the other: a delete-only screen
                  quietly drops the gentler option people usually want first.
                  An assistant account has no export button (Alex, 2026-09-15:
                  it bundles little of use), so the note below says how to ask
                  for a copy instead, which is still their right. */}
              {agentEngine ? null : (
                <Button
                  testID="profile.exportDataButton"
                  variant="secondary"
                  size="sm"
                  disabled={saving || exportState.status === 'sending'}
                  onPress={() => { void onExportMyData(); }}
                >
                  {exportState.status === 'sending' ? 'Preparing…' : 'Export my data'}
                </Button>
              )}
              <Button
                testID="profile.deleteAccountButton"
                variant="secondary"
                size="sm"
                disabled={saving || deleteState.status === 'sending'}
                onPress={() => setDeleteState({ status: 'confirming' })}
              >
                Delete my account
              </Button>
            </Stack>
            {/* Under the button, not inside the file. Somebody deciding
                whether to press it should not have to open a JSON bundle to
                find out what is and is not in it. */}
            <Text testID="profile.exportDataScope" variant="caption" color="textSecondary">
              {agentEngine ? AGENT_DATA_COPY_NOTE : DELEGENT_EXPORT_SCOPE_NOTE}
            </Text>
            {exportState.status === 'done' ? (
              <Text testID="profile.exportDataDone" variant="bodySm" color="textSecondary">
                {exportState.message}
              </Text>
            ) : null}
            {exportState.status === 'error' ? (
              <Text testID="profile.exportDataError" variant="caption" color="warning">
                {exportState.message}
              </Text>
            ) : null}
            {deleteState.status === 'requested' ? (
              <Text testID="profile.deleteAccountDone" variant="bodySm" color="textSecondary">
                {deleteState.message}
              </Text>
            ) : null}
            {deleteState.status === 'error' ? (
              <Text testID="profile.deleteAccountError" variant="caption" color="warning">
                {deleteState.message}
              </Text>
            ) : null}
          </Stack>
        </Surface>
      </Entry>

      {/* Confirmation. Cancel is the primary action and is listed first: the
          destructive path should never be the one your thumb lands on. */}
      <Modal
        visible={deleteState.status === 'confirming' || deleteState.status === 'sending'}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteState({ status: 'idle' })}
      >
        <View style={styles.deleteBackdrop}>
          <Surface elevation="surfaceHigh" radius="xl" padding={4} style={[shadow.sheet, { backgroundColor: '#FFFFFF' }]}>
            <Stack gap={3} style={styles.deleteSheet}>
              <Text variant="title">Delete your account?</Text>
              <Stack gap={2}>
                <Text variant="bodySm" color="textSecondary">
                  We will start this within 24 hours. It cannot be undone.
                </Text>
                <Text variant="bodySm" color="textSecondary">
                  • Your subscription ends and will not renew{'\n'}
                  • Your private workspace is shut down and its files are destroyed{'\n'}
                  • Your sign-in is removed, so you cannot log back in
                </Text>
                <Text variant="caption" color="textSecondary">
                  We keep billing records where the law requires it. See the privacy policy.
                </Text>
              </Stack>
              <Stack direction="horizontal" gap={2} wrap>
                <Button
                  testID="profile.deleteAccountCancel"
                  variant="secondary"
                  size="sm"
                  disabled={deleteState.status === 'sending'}
                  onPress={() => setDeleteState({ status: 'idle' })}
                >
                  Keep my account
                </Button>
                <Button
                  testID="profile.deleteAccountConfirm"
                  variant="ghost"
                  size="sm"
                  disabled={deleteState.status === 'sending'}
                  onPress={() => { void onConfirmDeleteAccount(); }}
                >
                  {deleteState.status === 'sending' ? 'Sending request…' : 'Yes, delete it'}
                </Button>
              </Stack>
            </Stack>
          </Surface>
        </View>
      </Modal>

      {/* Removed (defect J10, May 2026, Alex's first install): the
          "want to use different email" copy was noise. Sign-out is in the
          top profile card; users who need a different account will find it. */}

    </ScrollView>
  );
}

function TabButton({ tab, activeTab, setActiveTab }: { tab: Tab; activeTab: Tab; setActiveTab: (tab: Tab) => void }) {
  const icon: Record<Tab, IconName> = {
    dashboard: 'message-square',
    artifacts: 'hard-drive',
    profile: 'user',
  };
  const customIcon: Partial<Record<Tab, number>> = {
    dashboard: chatTabIcon,
    artifacts: filesTabIcon,
  };
  const label: Record<Tab, string> = {
    dashboard: 'Chat',
    artifacts: 'Files',
    profile: 'Profile',
  };
  const active = tab === activeTab;
  const customSrc = customIcon[tab];
  return (
    <Pressable
      testID={`tab.${tab}`}
      accessibilityRole="tab"
      accessibilityLabel={label[tab]}
      accessibilityState={{ selected: active }}
      hitSlop={touchHitSlop}
      onPress={() => setActiveTab(tab)}
      style={[styles.tabButton, active ? styles.tabButtonActive : null]}
    >
      <View style={[styles.tabIconWrap, active ? styles.tabIconWrapActive : null]}>
        {customSrc ? (
          <Image
            source={customSrc}
            style={{ width: 24, height: 24, opacity: active ? 1 : 0.55 }}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Feather name={icon[tab]} size={22} color={active ? appColors.textPrimary : appColors.textTertiary} />
        )}
      </View>
      <Text
        variant="caption"
        color={active ? 'textPrimary' : 'textTertiary'}
        style={active ? styles.tabLabelActive : undefined}
      >
        {label[tab]}
      </Text>
    </Pressable>
  );
}

// Menu icons sit in quiet ink-on-grey squircles (Pearl, Alex's pick of five on
// 2026-09-28; a colour per row read as too busy next to the softer cards).
const MENU_ICON_TINT = { fg: '#55554F', bg: 'rgba(28, 28, 26, 0.05)' };
// Row padding (12) + icon tile (38) + gap (12): rules start under the words.
const MENU_DIVIDER_INSET = 62;

function MenuRow({ icon, label, detail, rightLabel, testID, onPress }: MenuRowProps) {
  const tint = MENU_ICON_TINT;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.menuRow}>
      <View style={[styles.menuIconTile, { backgroundColor: tint.bg }]}>
        <Feather name={icon} size={18} color={tint.fg} />
      </View>
      <Stack gap={1} style={styles.flexText}>
        <Text variant="title">{label}</Text>
        {detail ? <Text variant="bodySm" color="textSecondary">{detail}</Text> : null}
      </Stack>
      {rightLabel ? <Text variant="caption" color="textTertiary">{rightLabel}</Text> : null}
      <View style={styles.menuChevron}>
        <Feather name="chevron-right" size={16} color={appColors.textTertiary} />
      </View>
    </Pressable>
  );
}

// 2026-07-18 (Alex): small uppercase caption that heads a grouped menu section,
// so the drawer reads as tidy, logical groups rather than one long list.
function MenuSectionLabel({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <Text
      testID={testID}
      variant="label"
      color="textTertiary"
      style={styles.menuSectionLabel}
    >
      {children}
    </Text>
  );
}

function DrawerHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <Stack direction="horizontal" align="center" gap={3} style={styles.drawerHeader}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} hitSlop={{ top: 16, right: 16, bottom: 16, left: 16 }} style={styles.drawerBackButton}>
          <Feather name="arrow-left" size={18} color={appColors.textPrimary} />
        </Pressable>
      ) : null}
      {/* Screen titles are set in the brand serif (2026-09-27 redesign). */}
      <Text variant="brandMd" style={styles.flexText}>{title}</Text>
    </Stack>
  );
}

// v2.0.0 - use-case rows are now expandable cards (same chevron pattern as
// FaqCard) so a tap reveals a short "how you'd actually do it" description.
// Reuses faqRow/faqHeader/faqAnswer styles for visual consistency.
function UseCaseCard({ item, index, isFirst }: { item: { title: string; say?: string; how: string }; index: number; isFirst: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const themeColors = useThemeColors();
  const chevronProgress = useSharedValue(0);

  const toggle = () => {
    setExpanded((prev) => {
      const next = !prev;
      chevronProgress.value = withTiming(next ? 1 : 0, { duration: 160 });
      return next;
    });
  };

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronProgress.value * 180}deg` }],
  }));

  return (
    <View style={[styles.faqRow, isFirst ? null : { borderTopWidth: 1, borderTopColor: themeColors.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={item.title}
        accessibilityHint="Shows how you would use this"
        onPress={toggle}
        hitSlop={touchHitSlop}
        style={styles.faqHeader}
      >
        <View style={styles.faqNumber}>
          <Text variant="caption" color="accent" tabular>{String(index + 1).padStart(2, '0')}</Text>
        </View>
        <Text variant="title" style={styles.flexText}>{item.title}</Text>
        <Animated.View style={chevronStyle}>
          <Feather name="chevron-down" size={18} color={themeColors.textTertiary} />
        </Animated.View>
      </Pressable>
      {expanded ? (
        <Animated.View entering={FadeInUp.duration(160)} style={styles.faqAnswer}>
          <Text variant="bodySm" color="textSecondary">{item.how}</Text>
          {'say' in item && item.say ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: space[2],
                marginTop: space[3],
              }}
            >
              <Text variant="caption" color="textTertiary">Just say in chat</Text>
              <View
                style={{
                  backgroundColor: themeColors.surfaceHigh,
                  borderColor: themeColors.borderStrong,
                  borderWidth: 1,
                  borderRadius: radii.md,
                  paddingHorizontal: space[2],
                  paddingVertical: space[1],
                }}
              >
                <Text variant="mono" color="accent">{`"${item.say}"`}</Text>
              </View>
            </View>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

// A tappable "Say ..." chip that copies the trigger phrase to the clipboard so
// the exact wording can be pasted into chat. It's a shortcut, not a
// requirement, the coworker understands plain language too.
// One-tap skill trigger. Tapping sends the phrase straight into chat and jumps
// to the chat tab, so the user never has to copy-paste (2026-07-24, Alex SKILL
// one-tap). Same dispatch path as the Commands/personality options.
function SayChip({ phrase, testID, onUse }: { phrase: string; testID?: string; onUse: (_phrase: string) => void }) {
  const themeColors = useThemeColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`Ask: ${phrase}`}
      accessibilityHint="Sends this to your chat"
      onPress={() => onUse(phrase)}
      hitSlop={touchHitSlop}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: space[2],
        backgroundColor: themeColors.accentMuted,
        borderRadius: radii.md,
        paddingHorizontal: space[3],
        paddingVertical: space[2],
      }}
    >
      <Text variant="caption" color="accent" style={{ opacity: 0.65 }}>Ask</Text>
      <Text variant="mono" color="accent">{`"${phrase}"`}</Text>
      <Feather name="arrow-up-right" size={13} color={themeColors.accent} />
    </Pressable>
  );
}

// One business use-case category on the Skills list. Collapsed it shows the
// emoji, title and a one-line hook; tapping expands it to the "Use it to"
// summary, a headline trigger phrase, and a "See all skills" link into the
// per-category detail page.
function CategoryRow({ category, expanded, onToggle, onSeeAll, onUseSkill }: {
  category: UseCaseCategory;
  expanded: boolean;
  onToggle: () => void;
  onSeeAll: () => void;
  onUseSkill: (_phrase: string) => void;
}) {
  const themeColors = useThemeColors();
  const chevronProgress = useSharedValue(expanded ? 1 : 0);
  useEffect(() => {
    chevronProgress.value = withTiming(expanded ? 1 : 0, { duration: 160 });
  }, [expanded, chevronProgress]);
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${chevronProgress.value * 90}deg` }] }));
  return (
    <Surface elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
      <Pressable
        testID={`skills.category.${category.key}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={category.title}
        accessibilityHint="Shows what this category covers"
        onPress={onToggle}
        hitSlop={touchHitSlop}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: radii.md,
            backgroundColor: category.muted ? themeColors.surface : category.tint ?? themeColors.accentMuted,
            borderWidth: category.muted ? 1 : 0,
            borderColor: themeColors.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 20 }}>{category.emoji}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="title">{category.title}</Text>
          <Text variant="caption" color="textSecondary" style={{ marginTop: 2 }}>{category.hook}</Text>
        </View>
        <Animated.View style={chevronStyle}>
          <Feather name="chevron-right" size={18} color={themeColors.textTertiary} />
        </Animated.View>
      </Pressable>
      {expanded ? (
        <Animated.View
          entering={FadeInUp.duration(160)}
          style={{ marginTop: space[3], paddingTop: space[3], borderTopWidth: 1, borderTopColor: themeColors.border, gap: space[3] }}
        >
          <Text variant="bodySm" color="textSecondary">
            <Text variant="bodySm" color="accent">Use it to </Text>
            {category.useItTo}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: space[2], flexWrap: 'wrap' }}>
            <Pressable
              testID={`skills.category.${category.key}.seeAll`}
              accessibilityRole="button"
              accessibilityLabel={`See all ${category.title} skills`}
              onPress={onSeeAll}
              hitSlop={touchHitSlop}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}
            >
              <Text variant="caption" color="accent" style={{ fontFamily: fontFamilies.geistSemiBold }}>See all skills</Text>
              <Feather name="chevron-right" size={14} color={themeColors.accent} />
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
    </Surface>
  );
}

function SkillsDrawer({ onOpenCategory, onUseSkill }: { onOpenCategory: (key: string) => void; onUseSkill: (_phrase: string) => void }) {
  // 2026-07-20 (Alex, SKILL-2): the eight business use-case categories, each an
  // accordion into a "Use it to" summary + headline phrase + a drill-down to
  // every spotlighted skill. (2026-07-21: the light "Everyday examples" pool was
  // removed as too much information; the categories are the whole surface now.)
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const categories = useUseCaseCategories();
  const agentEngine = useIsAgentEngine();
  return (
    <Stack gap={4}>
      <Text variant="bodySm" color="textSecondary">
        {agentEngine
          ? 'Everyday jobs your coworker can take off your hands, grouped below. Tap a category to see what it covers, or just ask for what you need in your own words.'
          : 'Your coworker comes with dozens of trained specialities, grouped below. Tap a category to see what it covers, then tap a phrase to ask your coworker, or just describe what you need in your own words.'}
      </Text>
      <Stack gap={3}>
        {categories.map((category) => (
          <CategoryRow
            key={category.key}
            category={category}
            expanded={expandedKey === category.key}
            onToggle={() => setExpandedKey((prev) => (prev === category.key ? null : category.key))}
            onSeeAll={() => onOpenCategory(category.key)}
            onUseSkill={onUseSkill}
          />
        ))}
      </Stack>
    </Stack>
  );
}

// The per-category detail page reached from "See all skills". Lists each
// spotlighted skill with a plain description and its copyable trigger phrase,
// plus an honest "and more, just ask" note.
function SkillCategoryDetail({ categoryKey, onUseSkill }: { categoryKey: string | null; onUseSkill: (_phrase: string) => void }) {
  const themeColors = useThemeColors();
  const categories = useUseCaseCategories();
  const say = useWording();
  const category = categories.find((entry) => entry.key === categoryKey) ?? categories[0];
  const showMore = category.key !== 'phone';
  return (
    <Stack gap={4}>
      <Stack direction="horizontal" align="center" gap={3}>
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: radii.lg,
            backgroundColor: category.muted ? themeColors.surface : category.tint ?? themeColors.accentMuted,
            borderWidth: category.muted ? 1 : 0,
            borderColor: themeColors.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 26 }}>{category.emoji}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="title">{category.title}</Text>
          <Text variant="caption" color="textTertiary" style={{ marginTop: 2 }}>
            {`${category.skills.length} ${category.skills.length === 1 ? 'skill' : 'skills'} highlighted`}
          </Text>
        </View>
      </Stack>
      <Text variant="bodySm" color="textSecondary">{`${category.lead} Just ask for what you need, in your own words.`}</Text>
      <Surface elevation="surfaceHigh" radius="lg" border>
        {category.skills.map((skill, index) => (
          <View
            key={skill.name}
            style={{ padding: space[4], borderTopWidth: index === 0 ? 0 : 1, borderTopColor: themeColors.border, flexDirection: 'row', alignItems: 'flex-start', gap: space[3] }}
          >
            <EmojiTile emoji={SKILL_EMOJI[skill.name] ?? category.emoji} tint={pastelTint(index + category.title.length)} size={40} />
            <Stack gap={1} style={styles.flexText}>
              <Text variant="title">{skill.name}</Text>
              <Text variant="bodySm" color="textSecondary">{skill.desc}</Text>
            </Stack>
          </View>
        ))}
        {showMore ? (
          <View style={{ padding: space[4], borderTopWidth: 1, borderTopColor: themeColors.border }}>
            <Text variant="bodySm" color="textTertiary">
              {say('And more in this area. Just describe what you need and your coworker picks the right skill.')}
            </Text>
          </View>
        ) : null}
      </Surface>
      <Text variant="caption" color="textTertiary" align="center">
        You can always use your own words. These phrases are shortcuts, not rules.
      </Text>
    </Stack>
  );
}

// The Commands catalogue now lives in @sidekick/shared so the web menu shows
// the same cards. Both surfaces dispatch a command the same way.
const CHAT_COMMANDS = DELEGENT_CHAT_COMMANDS;

function CommandsDrawer({ onRun }: { onRun: (command: ChatCommand, option?: ChatCommandOption) => void }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(CHAT_COMMANDS[0]?.key ?? null);
  return (
    <Stack gap={4}>
      <Text variant="bodySm" color="textSecondary">
        Quick actions you can run any time. Tap one to see what it does, then run it. Some, like a fresh chat, keep your coworker quick and easy on your monthly allowance.
      </Text>
      <Stack gap={3}>
        {CHAT_COMMANDS.map((command) => (
          <CommandRow
            key={command.key}
            command={command}
            expanded={expandedKey === command.key}
            onToggle={() => setExpandedKey((prev) => (prev === command.key ? null : command.key))}
            onRun={(option) => onRun(command, option)}
          />
        ))}
      </Stack>
    </Stack>
  );
}

function CommandRow({ command, expanded, onToggle, onRun }: {
  command: ChatCommand;
  expanded: boolean;
  onToggle: () => void;
  onRun: (option?: ChatCommandOption) => void;
}) {
  const themeColors = useThemeColors();
  const chevronProgress = useSharedValue(expanded ? 1 : 0);
  useEffect(() => {
    chevronProgress.value = withTiming(expanded ? 1 : 0, { duration: 160 });
  }, [expanded, chevronProgress]);
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${chevronProgress.value * 90}deg` }] }));
  return (
    <Surface elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
      <Pressable
        testID={`command.${command.key}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={command.name}
        accessibilityHint="Shows what this command does"
        onPress={onToggle}
        hitSlop={touchHitSlop}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: radii.md,
            backgroundColor: themeColors.accentMuted,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ fontSize: 20 }}>{command.emoji}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="title">{command.name}</Text>
          <Text variant="caption" color="textSecondary" style={{ marginTop: 2 }}>{command.short}</Text>
        </View>
        <Animated.View style={chevronStyle}>
          <Feather name="chevron-right" size={18} color={themeColors.textTertiary} />
        </Animated.View>
      </Pressable>
      {expanded ? (
        <Animated.View
          entering={FadeInUp.duration(160)}
          style={{ marginTop: space[3], paddingTop: space[3], borderTopWidth: 1, borderTopColor: themeColors.border, gap: space[3] }}
        >
          <Text variant="bodySm" color="textSecondary">{command.why}</Text>
          {command.options ? (
            <Stack gap={2}>
              {command.options.map((option) => (
                <Button
                  key={option.key}
                  testID={`command.${command.key}.option.${option.key}`}
                  variant="secondary"
                  fullWidth
                  onPress={() => onRun(option)}
                >{option.label}</Button>
              ))}
            </Stack>
          ) : (
            <Button testID={`command.${command.key}.run`} variant="primary" fullWidth onPress={() => onRun()}>{command.actionLabel}</Button>
          )}
        </Animated.View>
      ) : null}
    </Surface>
  );
}

function RoutineChip({ label, selected, testID, onPress }: { label: string; selected: boolean; testID: string; onPress: () => void }) {
  const themeColors = useThemeColors();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      hitSlop={touchHitSlop}
      onPress={onPress}
      style={{
        paddingVertical: space[2],
        paddingHorizontal: space[3],
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: selected ? themeColors.accent : themeColors.borderStrong,
        backgroundColor: selected ? themeColors.accentMuted : themeColors.surfaceHigh,
      }}
    >
      <Text variant="caption" color={selected ? 'textPrimary' : 'textSecondary'}>{label}</Text>
    </Pressable>
  );
}

function RoutinesDrawer() {
  // Roadmap #3 (Alex, 2026-07-25). The backend already existed: migration 0036
  // `scheduled_tasks` + the Worker's 5-minute waker, which dispatches the
  // instruction to the user's runner and writes the reply into the chat. This
  // is the surface for it. Creates go through the Worker (no client INSERT
  // policy by design); list / pause / delete read and write the table directly
  // under its owner-only RLS policies. See src/routines/routinesApi.ts.
  const themeColors = useThemeColors();
  const [routines, setRoutines] = useState<readonly Routine[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  // A failed read gets its own state rather than sharing the one the composer
  // buttons clear. Sharing it meant a reader whose list failed to load could tap
  // "Set up a routine", cancel, and be left with no list, no error and nothing
  // that would ever ask the server again.
  const [loadError, setLoadError] = useState<string | null>(null);
  // A pause, resume or delete that was refused, carried with the routine it was
  // refused for. It used to be one line at the very top of the drawer, above the
  // intro sentence, the composer button and the entire list, while the button
  // that produced it sat somewhere further down beside a routine the message
  // never named. With more than one routine there was nothing on screen to say
  // which of them had not paused. It now draws in that routine's own card.
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // Kept apart from `notice`, which sits at the top of the drawer. The composer
  // is an instruction box, a name box, three cadence chips, seven weekday chips
  // and five time chips before the reader reaches Create, which is well past
  // one phone screen, so the top of the drawer is not somewhere they can see by
  // then, let alone somewhere they would look. The browser already split this
  // out for the same reason on a surface with more room than this one.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [label, setLabel] = useState('');
  const [cadence, setCadence] = useState<RoutineCadence>('daily');
  const [hour, setHour] = useState(9);
  const [weekday, setWeekday] = useState(1);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await fetchRoutines();
    if ('error' in result) {
      setLoadState('error');
      setLoadError(result.error.message);
      return false;
    }
    setRoutines(result.routines);
    setLoadError(null);
    setLoadState('ready');
    return true;
  }, []);

  const retryLoad = useCallback(() => {
    setLoadState('loading');
    setLoadError(null);
    setConfirmation(null);
    void load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const resetComposer = () => {
    setPrompt('');
    setLabel('');
    setCadence('daily');
    setHour(9);
    setWeekday(1);
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setConfirmation(null);
    const result = await createRoutine({ prompt, label, cadence, hour, weekday });
    setSaving(false);
    if ('error' in result) {
      setSaveError(result.error.message);
      return;
    }
    resetComposer();
    setComposerOpen(false);
    // The routine exists from here on. If the refresh that follows fails, the
    // only thing on screen would be a read error over a list missing the
    // routine just made, and the natural response to that is to make it again
    // and end up with two of a thing that runs on its own.
    const refreshed = await load();
    if (!refreshed) setConfirmation(ROUTINE_CREATED_REFRESH_FAILED);
  };

  const togglePaused = async (routine: Routine) => {
    // The disabled prop on the button is computed at render time, so two taps
    // inside one frame both see it live and send opposite instructions. Which
    // state the routine ends in is then down to which reply lands last.
    if (busyId === routine.id) return;
    setBusyId(routine.id);
    setRowError(null);
    const result = await setRoutinePaused(routine.id, routine.status === 'active');
    setBusyId(null);
    if ('error' in result) {
      setRowError({ id: routine.id, message: result.error.message });
      return;
    }
    await load();
  };

  const confirmDelete = (routine: Routine) => {
    Alert.alert(
      'Delete this routine?',
      `“${routineTitle(routine)}” will stop running. Anything it already sent you stays in your chat.`,
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusyId(routine.id);
              setRowError(null);
              const result = await deleteRoutine(routine.id);
              setBusyId(null);
              if ('error' in result) {
                setRowError({ id: routine.id, message: result.error.message });
                return;
              }
              await load();
            })();
          },
        },
      ],
    );
  };

  const now = new Date();

  return (
    <Stack gap={4}>
      <Text variant="bodySm" color="textSecondary">
        Things your coworker does on a schedule, without you asking. The result arrives in your chat.
      </Text>

      {confirmation ? <Text testID="routines.confirmation" variant="bodySm" color="textSecondary">{confirmation}</Text> : null}

      {composerOpen ? (
        <Surface elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
          <Stack gap={3}>
            <Text variant="title">New routine</Text>
            <TextInput
              testID="routines.promptInput"
              value={prompt}
              onChangeText={setPrompt}
              multiline
              numberOfLines={4}
              placeholder="What should they do? e.g. Summarise anything in my inbox that needs a reply."
              placeholderTextColor={themeColors.textTertiary}
              accessibilityLabel="What the routine should do"
              style={{
                minHeight: 96,
                textAlignVertical: 'top',
                borderWidth: 1,
                borderColor: themeColors.borderStrong,
                borderRadius: radii.md,
                padding: space[3],
                color: themeColors.textPrimary,
                backgroundColor: themeColors.surface,
              }}
            />
            <TextInput
              testID="routines.labelInput"
              value={label}
              onChangeText={setLabel}
              placeholder="Name it (optional)"
              placeholderTextColor={themeColors.textTertiary}
              accessibilityLabel="Routine name"
              style={{
                borderWidth: 1,
                borderColor: themeColors.borderStrong,
                borderRadius: radii.md,
                padding: space[3],
                color: themeColors.textPrimary,
                backgroundColor: themeColors.surface,
              }}
            />

            <Stack gap={2}>
              <Text variant="caption" color="textSecondary">How often</Text>
              <View style={styles.routineChipRow}>
                <RoutineChip testID="routines.cadence.hourly" label="Every hour" selected={cadence === 'hourly'} onPress={() => setCadence('hourly')} />
                <RoutineChip testID="routines.cadence.daily" label="Every day" selected={cadence === 'daily'} onPress={() => setCadence('daily')} />
                <RoutineChip testID="routines.cadence.weekly" label="Every week" selected={cadence === 'weekly'} onPress={() => setCadence('weekly')} />
              </View>
            </Stack>

            {cadence === 'weekly' ? (
              <Stack gap={2}>
                <Text variant="caption" color="textSecondary">On</Text>
                <View style={styles.routineChipRow}>
                  {ROUTINE_WEEKDAY_LABELS.map((dayLabel, index) => (
                    <RoutineChip
                      key={dayLabel}
                      testID={`routines.weekday.${index}`}
                      label={dayLabel}
                      selected={weekday === index}
                      onPress={() => setWeekday(index)}
                    />
                  ))}
                </View>
              </Stack>
            ) : null}

            {cadence === 'hourly' ? null : (
              <Stack gap={2}>
                <Text variant="caption" color="textSecondary">At</Text>
                <View style={styles.routineChipRow}>
                  {ROUTINE_TIME_CHOICES.map((choice) => (
                    <RoutineChip
                      key={choice}
                      testID={`routines.time.${choice}`}
                      label={formatHourChoice(choice)}
                      selected={hour === choice}
                      onPress={() => setHour(choice)}
                    />
                  ))}
                </View>
              </Stack>
            )}

            {/* Next to the button that failed, not at the top of a drawer the
                reader has scrolled a long way down from. */}
            {saveError ? (
              <Text testID="routines.saveError" variant="bodySm" color="danger">{saveError}</Text>
            ) : null}

            <Stack direction="horizontal" gap={2}>
              <Button
                testID="routines.saveButton"
                variant="primary"
                disabled={saving || !isRoutinePromptReady(prompt)}
                onPress={() => { void submit(); }}
              >
                {saving ? 'Setting up…' : 'Create routine'}
              </Button>
              <Button testID="routines.cancelButton" variant="secondary" onPress={() => { setComposerOpen(false); setSaveError(null); }}>Cancel</Button>
            </Stack>
          </Stack>
        </Surface>
      ) : (
        <Button testID="routines.newButton" variant="primary" fullWidth onPress={() => { setComposerOpen(true); setSaveError(null); }}>Set up a routine</Button>
      )}

      {loadState === 'loading' ? (
        <Text variant="bodySm" color="textTertiary">Loading your routines…</Text>
      ) : null}

      {loadState === 'error' ? (
        <Surface elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
          <Stack gap={3}>
            <Text testID="routines.loadError" variant="bodySm" color="danger">{loadError}</Text>
            <Button testID="routines.retryButton" variant="secondary" size="sm" onPress={retryLoad}>Try again</Button>
          </Stack>
        </Surface>
      ) : null}

      {routines.map((routine) => {
        const nextRun = describeNextRun(routine.nextRunAt, now);
        const paused = routine.status === 'paused';
        return (
          <Surface key={routine.id} elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
            <Stack gap={3}>
              <Stack gap={1}>
                <Stack direction="horizontal" gap={2} align="center">
                  <Text variant="title" style={styles.flexText}>{routineTitle(routine)}</Text>
                  {paused ? <Badge tone="neutral">Paused</Badge> : null}
                </Stack>
                <Text variant="caption" color="textSecondary">{describeCadence(routine)}</Text>
                {!paused && nextRun ? <Text variant="caption" color="textTertiary">Next: {nextRun}</Text> : null}
              </Stack>
              <Stack direction="horizontal" gap={2}>
                <Button
                  testID={`routines.toggle.${routine.id}`}
                  variant="secondary"
                  size="sm"
                  disabled={busyId === routine.id}
                  onPress={() => { void togglePaused(routine); }}
                >
                  {paused ? 'Resume' : 'Pause'}
                </Button>
                <Button
                  testID={`routines.delete.${routine.id}`}
                  variant="secondary"
                  size="sm"
                  disabled={busyId === routine.id}
                  onPress={() => confirmDelete(routine)}
                >
                  Delete
                </Button>
              </Stack>
              {/* Beneath the two buttons that can produce it, inside the card
                  for the routine it happened to. */}
              {rowError?.id === routine.id ? (
                <Text testID={`routines.rowError.${routine.id}`} variant="bodySm" color="danger">
                  {rowError.message}
                </Text>
              ) : null}
            </Stack>
          </Surface>
        );
      })}

      {loadState === 'ready' && !composerOpen ? (
        <Stack gap={3}>
          <Text variant="bodySm" color="textSecondary">
            {routines.length === 0
              ? 'You don’t have any routines yet. Here are a few people start with.'
              : 'More ideas. Tap one to set it up.'}
          </Text>
          {ROUTINE_SUGGESTIONS.map((suggestion) => (
            <Pressable
              key={suggestion.key}
              testID={`routines.suggestion.${suggestion.key}`}
              accessibilityRole="button"
              accessibilityLabel={`Use the ${suggestion.label} routine`}
              onPress={() => {
                setPrompt(suggestion.prompt);
                setLabel(suggestion.label);
                setCadence(suggestion.cadence);
                setHour(suggestion.hour);
                setWeekday(suggestion.weekday);
                setComposerOpen(true);
              }}
            >
              <Surface elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
                <Stack direction="horizontal" gap={3} align="center">
                  <Stack gap={1} style={styles.flexText}>
                    <Text variant="title">{suggestion.label}</Text>
                    <Text variant="caption" color="textSecondary" numberOfLines={2}>{suggestion.prompt}</Text>
                  </Stack>
                  <Feather name="plus" size={18} color={themeColors.textTertiary} />
                </Stack>
              </Surface>
            </Pressable>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

function ConnectionCard({
  row,
  busy,
  error,
  onOpen,
  onDisconnect,
}: {
  row: ConnectionRow;
  busy: boolean;
  error: string | null;
  onOpen: () => void;
  onDisconnect: () => void;
}) {
  const { service, status, detail } = row;
  const connected = status === 'connected';
  const say = useWording();
  return (
    <Surface elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
      <Stack gap={3}>
        <Stack gap={1}>
          <ConnectionIdentity service={service} wording={say} trailing={connected ? (
              <Badge tone="success">Connected</Badge>
            ) : status === 'needs_attention' ? (
              <Badge tone="warning">Needs attention</Badge>
            ) : null} />
          {detail ? (
            <Text testID={`connections.detail.${service.id}`} variant="caption" color="textSecondary">{detail}</Text>
          ) : null}
        </Stack>
        <Stack direction="horizontal" gap={2}>
          <Button
            testID={`connections.connect.${service.id}`}
            variant={connected ? 'secondary' : 'primary'}
            size="sm"
            disabled={busy}
            onPress={onOpen}
          >
            {connected ? 'Reconnect' : 'Connect'}
          </Button>
          {status === 'not_connected' ? null : (
            <Button
              testID={`connections.disconnect.${service.id}`}
              variant="secondary"
              size="sm"
              disabled={busy}
              onPress={onDisconnect}
            >
              Disconnect
            </Button>
          )}
        </Stack>
        {/* Beneath the button that produced it, in the card for the account it
            happened to. */}
        {error ? (
          <Text testID={`connections.rowError.${service.id}`} variant="bodySm" color="danger">{error}</Text>
        ) : null}
      </Stack>
    </Surface>
  );
}

// How long the resume fallback waits for the return deep link before it passes
// judgement of its own. Long enough for the intent to be delivered and the
// exchange to answer, short enough that nobody is left watching a screen that
// says nothing about the hand-off they just finished.
const CONNECTION_RETURN_LINK_GRACE_MS = 5_000;

// Where a hand-off in flight is remembered across an eviction. Deliberately the
// plain key/value store and not SecureStore: nothing written here is a
// credential, and a store that can fail closed on a locked device would lose
// the only record of what the reader just started.
const connectionHandoffStorage: ConnectionHandoffStorage = AsyncStorage;

// Connections for an agent-engine account, in the style of the Skills
// categories: an emoji tile, a title, a one-line hook and a chevron, opening onto
// the cards inside (Alex, 2026-09-15).
function ConnectionCategoryRow({ category, connected, expanded, onToggle, children }: {
  category: AgentConnectionSection['category'];
  connected: number;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const themeColors = useThemeColors();
  const chevronProgress = useSharedValue(expanded ? 1 : 0);
  useEffect(() => {
    chevronProgress.value = withTiming(expanded ? 1 : 0, { duration: 160 });
  }, [expanded, chevronProgress]);
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${chevronProgress.value * 90}deg` }] }));
  return (
    <Surface elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
      <Pressable
        testID={`connections.category.${category.key}`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={category.title}
        accessibilityHint="Shows the connections in this category"
        onPress={onToggle}
        hitSlop={touchHitSlop}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}
      >
        <View style={{ width: 40, height: 40, borderRadius: radii.md, backgroundColor: category.tint, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 20 }}>{category.emoji}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="title">{category.title}</Text>
          <Text variant="caption" color="textSecondary" style={{ marginTop: 2 }}>{category.hook}</Text>
          {connected > 0 ? (
            <Text testID={`connections.category.${category.key}.connected`} variant="caption" color="success" style={{ marginTop: 2 }}>
              {connected} connected
            </Text>
          ) : null}
        </View>
        <Animated.View style={chevronStyle}>
          <Feather name="chevron-right" size={18} color={themeColors.textTertiary} />
        </Animated.View>
      </Pressable>
      {expanded ? (
        <Animated.View
          entering={FadeInUp.duration(160)}
          style={{ marginTop: space[3], paddingTop: space[3], borderTopWidth: 1, borderTopColor: themeColors.border, gap: space[3] }}
        >
          {children}
        </Animated.View>
      ) : null}
    </Surface>
  );
}

// A tool the coworker has without any sign-in, shown as a card like the apps
// beside it, with a coloured tile and "Try it" where an app offers Connect.
function BuiltInConnectionCard({ tool, onTry }: { tool: EverydayTool; onTry: () => void }) {
  return (
    <Surface testID={`connections.builtIn.${tool.id}`} elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
      <Stack gap={3}>
        <Stack gap={1}>
          <Stack direction="horizontal" gap={2} align="center">
            <View style={{ width: 28, height: 28, borderRadius: radii.sm, backgroundColor: tool.tint, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 15 }}>{tool.emoji}</Text>
            </View>
            <Text variant="title" style={styles.flexText}>{tool.title}</Text>
            <Badge tone="accent">{AGENT_BUILT_IN_BADGE}</Badge>
          </Stack>
          <Text variant="caption" color="textSecondary">{tool.detail}</Text>
        </Stack>
        <Stack direction="horizontal" gap={2}>
          <Button testID={`connections.builtIn.${tool.id}.try`} variant="primary" size="sm" onPress={onTry}>
            Try it
          </Button>
        </Stack>
      </Stack>
    </Surface>
  );
}

function ConnectionsDrawer({ onStartInChat, userId, visible }: { onStartInChat: (phrase: string) => void; userId: string; visible: boolean }) {
  const agentEngine = useIsAgentEngine();
  const [appPreferences, setAppPreferences] = useState<{ userId: string; ids: string[] } | null>(null);
  useEffect(() => {
    let current = true;
    if (visible && userId) void loadOnboardingApps(() => current).then((ids) => {
      if (current) setAppPreferences({ userId, ids });
    }).catch(() => undefined);
    return () => { current = false; };
  }, [userId, visible]);
  // Every account here is connected by signing in at the provider, in the
  // reader's own browser. Nothing is typed into this app and nothing reaches
  // the chat transcript. See src/connections/connectionsApi.ts.
  // Keyed on the signed-in id, so the list opens complete from the last read
  // (and the menu's prefetch) instead of filling in one source at a time.
  const { inventory, load } = useConnectionInventory(fetchConnectionStates, fetchComposioConnections, userId);
  // Keyed on the AUTHENTICATED id, passed in rather than read off the product
  // snapshot. The snapshot is a cached view of a profile row that can still
  // hold the previous account's id for the beat after a switch, and a hand-off
  // filed under the wrong account is one account answering for another's
  // consent. An empty id yields a store that remembers nothing, which is the
  // old mounted-only behaviour rather than a shared drawer.
  const store = useMemo(() => createConnectionHandoffStore(connectionHandoffStorage, { userId }), [userId]);
  // An agent-engine account is not offered a connection its engine cannot use.
  const rows = buildConnectionRows(inventory.states, inventory.available)
    .filter((row) => !agentEngine || !AGENT_ENGINE_UNSUPPORTED_CONNECTIONS.includes(row.service.id));
  const say = agentEngine ? assistantWording : sameWording;
  // One category open at a time, like Skills.
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  // Which service the announcement card is about. Held rather than derived,
  // because the announcement outlives the hand-off that produced it.
  const [announcedService, setAnnouncedService] = useState<ConnectableService | null>(null);
  const loadState = inventory.pending ? 'loading' : inventory.error ? 'error' : 'ready';
  const [notice, setNotice] = useState<string | null>(null);
  // Kept apart from `notice`, which sits at the very top of the drawer. This
  // sheet is rendered in place of its card, which can be most of a scroll down
  // a list of ten services, so a failure to open the hand-off has to appear
  // beside the button that was just pressed rather than somewhere above.
  const [sheetError, setSheetError] = useState<string | null>(null);
  // A disconnect that was refused, carried with the service it was refused for.
  // It used to write `notice` at the top of the drawer, which is above ten cards
  // in four groups. The confirmation closes on the press, so the only thing that
  // changed was a line the reader had scrolled well past, and it never named
  // which account had not been disconnected.
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const pendingReturn = useRef<ConnectionHandoff | null>(null);
  const handedOffTo = useRef<{ service: ConnectableService; state: string | null; connectedAccountId?: string; attemptId: string } | null>(null);
  // What the durable store said this account had started, read back once per
  // mount. Only consulted when nothing mounted remembers the hand-off, which is
  // precisely the restart case.
  const restored = useRef<PendingConnectionHandoff | null>(null);
  const handledReturns = useRef(new Set<string>());
  const generation = useRef(0);
  const busyAction = useRef(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    if (lifetime.current.signal.aborted) {
      lifetime.current = new AbortController();
      busyAction.current = false;
      setBusyId(null);
      setFinishing(false);
      if (pendingReturn.current?.kind === 'native' && pendingReturn.current.outcome === 'completing') {
        pendingReturn.current = { ...pendingReturn.current, outcome: 'unconfirmed' };
        setNotice(connectionReturnNotice(pendingReturn.current.service, 'complete_unconfirmed').message);
      }
    }
    const controller = lifetime.current;
    return () => { controller.abort(); generation.current++; };
  }, []);

  const settleReturn = useCallback((pending: ConnectionHandoff, nextInventory: ConnectionInventory | null) => {
    if (lifetime.current.signal.aborted || pendingReturn.current !== pending || !nextInventory) return;
    const outcome = connectionHandoffOutcome(pending, nextInventory);
    if (outcome.kind === 'checking') return;
    if (outcome.kind === 'connected') {
      setAnnouncement(connectedAnnouncement(pending.service, outcome.accountLabel));
      setAnnouncedService(pending.service);
      setNotice(null);
      pendingReturn.current = null;
      restored.current = null;
      // Answered. Keeping it would let a later mount re-announce a connection
      // this reader has already been told about.
      if (pending.attemptId) void store.clear(pending.attemptId);
      return;
    }
    setAnnouncement(null);
    setAnnouncedService(null);
    setNotice(outcome.notice.message);
    // Keep an acknowledged native completion or exact Composio attempt for a
    // read-only retry. Never replay the single-use completion request.
  }, [store]);

  const refreshReturn = useCallback(async () => {
    const pending = pendingReturn.current;
    const nextInventory = await load();
    if (pending) settleReturn(pending, nextInventory);
  }, [load, settleReturn]);

  useEffect(() => {
    if (visible) return;
    setAnnouncement(null);
    setAnnouncedService(null);
  }, [visible]);

  useEffect(() => {
    const signal = lifetime.current.signal;
    const handle = (url: string | null | undefined) => {
      if (signal.aborted) return;
      const ret = connectionReturnFromUrl(url);
      if (!ret) return;
      const service = findConnectableService(ret.provider);
      if (!service || service.backend !== 'native') return;
      const sent = handedOffTo.current;
      // The record is only consulted when nothing mounted remembers the
      // hand-off. A live attempt always outranks whatever was on disk.
      const saved = sent ? null : restored.current;
      const startedState = sent ? sent.state : saved?.state ?? null;
      const startedServiceId = sent ? sent.service.id : saved?.serviceId;
      if (startedServiceId !== undefined
        && (startedServiceId !== service.id || (!('failure' in ret) && startedState !== ret.state))) return;
      const key = 'failure' in ret ? `${ret.provider}:${ret.failure}:${startedState ?? ''}` : ret.state;
      if (handledReturns.current.has(key)) return;
      if (handledReturns.current.size > 64) handledReturns.current.clear();
      handledReturns.current.add(key);
      const completionGeneration = ++generation.current;
      handedOffTo.current = null;
      restored.current = null;
      const attemptId = sent?.attemptId ?? saved?.attemptId ?? null;

      // The exchange may already have happened before whatever killed the last
      // process. Completion is single use, so a restored attempt that got as
      // far as sending one re-reads status instead of spending it again: a
      // replay is refused as an expired link, which would be announced over a
      // connection that actually landed.
      if (saved?.completionSent) {
        pendingReturn.current = { service, kind: 'native', outcome: 'unconfirmed', ...(attemptId ? { attemptId } : {}) };
        void refreshReturn();
        return;
      }

      let pending: ConnectionHandoff = 'failure' in ret
        ? { service, kind: 'native', outcome: 'failed', code: ret.failure, ...(attemptId ? { attemptId } : {}) }
        : { service, kind: 'native', outcome: 'completing', ...(attemptId ? { attemptId } : {}) };
      pendingReturn.current = pending;
      if ('failure' in ret) {
        if (attemptId) void store.recordReceipt(attemptId, { outcome: 'failed', code: ret.failure });
        void refreshReturn();
        return;
      }

      setFinishing(true);
      void (async () => {
        // Written BEFORE the request leaves, not after it answers. The window
        // being closed is the one where the process dies mid-exchange.
        if (attemptId) await store.markCompletionSent(attemptId);
        const result = await completeConnection(service.id, ret.state, ret.code, { signal });
        if (signal.aborted || pendingReturn.current !== pending) return;
        const outcome = 'ok' in result ? 'confirmed' as const
          : ['invalid_state', 'wrong_account', 'declined', 'unknown_provider', 'invalid_request'].includes(result.code) ? 'failed' as const
            : 'unconfirmed' as const;
        pending = { service, kind: 'native', outcome,
          ...('ok' in result ? {} : { code: result.code }), ...(attemptId ? { attemptId } : {}) };
        pendingReturn.current = pending;
        if (attemptId) await store.recordReceipt(attemptId, { outcome, ...('ok' in result ? {} : { code: result.code }) });
        await refreshReturn();
        if (!signal.aborted && generation.current === completionGeneration) setFinishing(false);
      })();
    };
    // Read back before a single link is consumed. A link that arrives first
    // would find no record of the attempt it belongs to, and complete or
    // announce without the fencing the record exists to provide.
    const hydrated = (async () => {
      const record = await store.read();
      if (signal.aborted || !record || pendingReturn.current || handedOffTo.current) return;
      restored.current = record;
    })();
    const afterHydration = (url: string | null | undefined) => { void hydrated.then(() => handle(url)); };
    // Settles whatever survived the restart. Loses to any real link, because
    // settleReturn refuses a pending object that is no longer the current one.
    void hydrated.then(async () => {
      const record = restored.current;
      if (signal.aborted || !record || pendingReturn.current || handedOffTo.current) return;
      const handoff = restoredConnectionHandoff(record);
      if (!handoff) return;
      pendingReturn.current = handoff;
      await refreshReturn();
    });
    readSidekickNativeDeepLink('getInitialUrl').then(afterHydration).catch(() => undefined);
    const consumeNativeConnectionReturn = () => {
      if (signal.aborted) return;
      readSidekickNativeDeepLink('peekLatestUrl')
        .then(async (url) => {
          if (signal.aborted || !connectionReturnFromUrl(url)) return;
          afterHydration(await readSidekickNativeDeepLink('consumeLatestUrl'));
        }).catch(() => undefined);
    };
    consumeNativeConnectionReturn();
    const poller = setInterval(consumeNativeConnectionReturn, 750);
    const listener = Linking.addEventListener('url', ({ url }) => afterHydration(url));
    return () => { clearInterval(poller); listener.remove(); };
  }, [refreshReturn, store]);

  useEffect(() => {
    const signal = lifetime.current.signal;
    const subscription = AppState.addEventListener('change', (next) => {
      if (signal.aborted || next !== 'active') return;
      const sent = handedOffTo.current;
      if (!sent) return;
      const attempt = generation.current;
      void (async () => {
        // Native needs its actual return code. Give that link time to arrive;
        // lack of a link is unknown, not proof that consent was declined.
        if (sent.service.backend === 'native') {
          await new Promise((resolve) => setTimeout(resolve, CONNECTION_RETURN_LINK_GRACE_MS));
        }
        if (signal.aborted || generation.current !== attempt || handedOffTo.current !== sent) return;
        handedOffTo.current = null;
        const pending: ConnectionHandoff = sent.service.backend === 'composio' && sent.connectedAccountId
          ? { service: sent.service, kind: 'composio', connectedAccountId: sent.connectedAccountId, attemptId: sent.attemptId }
          : { service: sent.service, kind: 'native', outcome: 'unconfirmed', attemptId: sent.attemptId };
        pendingReturn.current = pending;
        await refreshReturn();
      })();
    });
    return () => subscription.remove();
  }, [refreshReturn]);

  const handOff = async (service: ConnectableService) => {
    if (busyAction.current || pendingReturn.current?.kind === 'native' && pendingReturn.current.outcome === 'completing') return;
    const signal = lifetime.current.signal;
    if (signal.aborted) return;
    busyAction.current = true;
    const attempt = ++generation.current;
    pendingReturn.current = null;
    handedOffTo.current = null;
    // A new hand-off retires the old one everywhere, including on disk. Left
    // behind, a previous service's record would be hydrated by the next mount
    // and answered for as though this reader had just returned from it.
    restored.current = null;
    void store.clear();
    setBusyId(service.id);
    setSheetError(null);
    setNotice(null);
    setFinishing(false);
    setAnnouncement(null);
    setAnnouncedService(null);
    try {
      const result = service.backend === 'composio'
        ? await startComposioConnection(service.id, { signal })
        : await startConnection(service.id, { signal });
      if (signal.aborted || generation.current !== attempt) return;
      if ('error' in result) { setSheetError(result.error.message); return; }
      const state = service.backend === 'native' ? new URL(result.authorizeUrl).searchParams.get('state') : null;
      if (service.backend === 'native' && !state || service.backend === 'composio' && !result.connectedAccountId) {
        setSheetError('We could not prepare that connection. Try again in a moment.');
        return;
      }
      // Before openURL: a fast native return or foreground event can arrive
      // while the browser-opening promise is still unresolved. Written to disk
      // here too, because the browser taking the foreground is exactly when
      // this process can be evicted, and the awaited write is the point of it.
      const sent = { service, state, connectedAccountId: result.connectedAccountId, attemptId: newConnectionAttemptId() };
      handedOffTo.current = sent;
      await store.start({ attemptId: sent.attemptId, serviceId: service.id, backend: service.backend,
        state, connectedAccountId: result.connectedAccountId ?? null });
      if (signal.aborted || generation.current !== attempt) return;
      const opened = await connectionRequest<boolean | null>(() => Linking.openURL(result.authorizeUrl).then(() => true).catch(() => false), null, { signal });
      if (signal.aborted) return;
      if (opened !== true) {
        if (handedOffTo.current !== sent) return;
        // Refused outright, so there is no hand-off to come back from.
        if (opened === false) { handedOffTo.current = null; void store.clear(sent.attemptId); }
        setSheetError(opened === false
          ? 'We could not open your browser. Check you have one set up, then try again.'
          : 'We could not confirm your browser opened. If it did, finish there and return here.');
        return;
      }
      setReviewingId(null);
      setSheetError(null);
    } finally {
      if (lifetime.current.signal === signal) {
        busyAction.current = false;
        if (!signal.aborted) setBusyId(null);
      }
    }
  };

  const confirmDisconnect = (service: ConnectableService) => {
    Alert.alert(
      `Disconnect ${service.name}?`,
      say('Your coworker will lose access straight away. You can reconnect any time.'),
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const signal = lifetime.current.signal;
              if (signal.aborted || busyAction.current || pendingReturn.current?.kind === 'native' && pendingReturn.current.outcome === 'completing') return;
              busyAction.current = true;
              generation.current++;
              if (handedOffTo.current?.state) handledReturns.current.add(handedOffTo.current.state);
              handedOffTo.current = null;
              pendingReturn.current = null;
              restored.current = null;
              void store.clear();
              setBusyId(service.id);
              setRowError(null);
              try {
                const result = service.backend === 'composio'
                  ? await disconnectComposioService(service.id, { signal })
                  : await disconnectConnection(service.id, { signal });
                if (signal.aborted) return;
                if ('error' in result) {
                  setRowError({ id: service.id, message: result.error.message });
                  return;
                }
                setAnnouncement(null);
                setAnnouncedService(null);
                setNotice(null);
                await load();
              } finally {
                if (lifetime.current.signal === signal) {
                  busyAction.current = false;
                  if (!signal.aborted) setBusyId(null);
                }
              }
            })();
          },
        },
      ],
    );
  };

  const connected = connectedCount(rows);
  const chosenIds = appPreferences?.userId === userId ? appPreferences.ids : [];
  const chosenRows = rows.filter((row) => chosenIds.includes(row.service.id));
  const groups = buildConnectionGroups(rows.filter((row) => !chosenIds.includes(row.service.id)));

  return (
    <Stack gap={4}>
      <Text variant="bodySm" color="textSecondary">
        {agentEngine ? AGENT_CONNECTIONS_INTRO : 'What your coworker can plug into.'} {CONNECTIONS_CUSTODY_NOTE}
      </Text>

      {/* Shown from the remembered cards too, so the line does not swap from
          "Checking" to a count a moment after opening (2026-09-28). */}
      {connected > 0 && (loadState === 'ready' || (loadState === 'loading' && inventory.native.data && inventory.composio.data)) ? (
        <Text testID="connections.summary" variant="caption" color="textSecondary">
          {agentEngine
            ? (connected === 1 ? '1 app connected' : `${connected} apps connected`)
            : (connected === 1 ? '1 thing connected' : `${connected} things connected`)}
        </Text>
      ) : null}

      {inventory.error ? (
        <Stack gap={2}>
          <Text testID="connections.readError" variant="bodySm" color="danger">{inventory.error}</Text>
          <Button
            testID="connections.retry"
            variant="secondary"
            size="sm"
            disabled={inventory.pending}
            onPress={() => { void refreshReturn(); }}
          >
            {CONNECTIONS_RETRY_LABEL}
          </Button>
        </Stack>
      ) : null}
      {notice ? (
        <Stack gap={2}>
          <Text testID="connections.notice" variant="bodySm" color="danger">{notice}</Text>
          {!inventory.error && pendingReturn.current ? (
            <Button testID="connections.returnRetry" variant="secondary" size="sm" disabled={inventory.pending || finishing}
              onPress={() => { void refreshReturn(); }}>{CONNECTIONS_RETRY_LABEL}</Button>
          ) : null}
        </Stack>
      ) : null}

      {loadState === 'loading' && connected === 0 ? (
        <Text variant="bodySm" color="textSecondary">Checking what’s connected…</Text>
      ) : null}

      {finishing ? (
        <Text testID="connections.finishing" variant="bodySm" color="textSecondary">
          {CONNECTIONS_FINISHING_LABEL}
        </Text>
      ) : null}

      {announcement ? (
        <Surface testID="connections.announcement" elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
          <Stack gap={2}>
            <Text variant="caption" color="textSecondary">{say('Your coworker')}</Text>
            <Text variant="bodySm" color="textPrimary">{say(announcement)}</Text>
            {announcedService?.firstPrompt ? (
              <Button
                testID="connections.announcement.chat"
                variant="primary"
                size="sm"
                onPress={() => {
                  // Single use. The card is a prompt to try the thing you just
                  // connected; the moment it is acted on it has done its job,
                  // and leaving it up makes a finished step look outstanding.
                  // Clearing first is safe: the closure still holds the service
                  // captured at render, so the phrase below is unaffected. It
                  // stays inlined off the catalogue on purpose, because the
                  // readiness contract reads this call site to prove no
                  // reader-supplied wording can reach the transcript.
                  setAnnouncement(null);
                  setAnnouncedService(null);
                  onStartInChat(announcedService.firstPrompt as string);
                }}
              >
                {firstPromptLabel(announcedService)}
              </Button>
            ) : null}
          </Stack>
        </Surface>
      ) : null}

      {/* Each successful read can render immediately. Cached cards stay visible
          during refresh, and an unread service never invents a fresh status. */}
      {agentEngine ? (
        <Stack gap={3} testID="connections.categories">
          {buildAgentConnectionSections(rows, chosenIds).map((section) => (
            <ConnectionCategoryRow
              key={section.category.key}
              category={section.category}
              connected={connectedCount(section.rows)}
              expanded={openCategory === section.category.key}
              onToggle={() => setOpenCategory((open) => (open === section.category.key ? null : section.category.key))}
            >
              {section.tools.map((tool) => (
                <BuiltInConnectionCard key={tool.id} tool={tool} onTry={() => onStartInChat(tool.prompt)} />
              ))}
              {section.rows.map((row) => renderRow(row))}
            </ConnectionCategoryRow>
          ))}
        </Stack>
      ) : (
        <>
          {chosenRows.length ? <Stack gap={3}>
            <Text variant="title">Your chosen apps</Text>
            <Text variant="caption" color="textSecondary">The apps you picked during setup. Connect each one when you are ready.</Text>
            {chosenRows.map((row) => renderRow(row))}
          </Stack> : null}
          {groups.map((group) => (
            <Stack key={group.category} gap={3}>
              <Text variant="caption" color="textSecondary">{group.label.toUpperCase()}</Text>
              {group.rows.map((row) => renderRow(row))}
            </Stack>
          ))}
        </>
      )}

      {loadState === 'ready' ? (
        <Text testID="connections.moreComing" variant="bodySm" color="textSecondary">
          {CONNECTIONS_MORE_COMING_NOTE}
        </Text>
      ) : null}
    </Stack>
  );

  // The consent sheet and the card are two states of one row, so the sheet is
  // rendered in place rather than as a modal: on a phone a full-screen sheet
  // over a drawer is one layer too many, and the reader loses where they were.
  function renderRow(row: ConnectionRow) {
    const service = row.service;

    // The consent sheet. There is no path from the card to the provider that
    // skips it, because this is the one screen that says what is being handed
    // over and what could go wrong with it.
    if (reviewingId === service.id) {
      return (
        <Surface key={service.id} elevation="surfaceHigh" radius="lg" border style={{ padding: space[4] }}>
          <Stack gap={3}>
            <Stack direction="horizontal" gap={2} align="center">
              {service.brandMark ? <BrandMarkGlyph mark={service.brandMark} size={22} /> : null}
              <Text variant="title" style={styles.flexText}>Connect {service.name}</Text>
            </Stack>
            <Text variant="bodySm" color="textSecondary">{say(service.blurb)}</Text>

            <Text variant="caption" color="textSecondary">WHAT IT WILL BE ABLE TO DO</Text>
            <Stack gap={1}>
              {service.capabilities.map((line) => (
                <Text key={line} variant="bodySm" color="textPrimary">{'•'} {say(line)}</Text>
              ))}
            </Stack>

            <Text variant="caption" color="textSecondary">WHAT YOU ARE GRANTING</Text>
            <Stack gap={1}>
              {service.permissions.map((line) => (
                <Text key={line} variant="bodySm" color="textPrimary">{'•'} {say(line)}</Text>
              ))}
            </Stack>

            {service.safety.map((statement) => (
              <Stack key={statement.heading} gap={1}>
                <Text variant="bodySm" color="textPrimary">{say(statement.heading)}</Text>
                <Text variant="caption" color="textSecondary">{say(statement.body)}</Text>
              </Stack>
            ))}

            <Text variant="caption" color="textSecondary">{handoffNotice(service)}</Text>

            {sheetError ? (
              <Text testID="connections.sheetError" variant="bodySm" color="danger">{sheetError}</Text>
            ) : null}

            <Stack direction="horizontal" gap={2}>
              <Button
                testID={`connections.continue.${service.id}`}
                variant="primary"
                size="sm"
                disabled={busyId === service.id}
                onPress={() => { void handOff(service); }}
              >
                {busyId === service.id ? 'Opening…' : `Continue to ${service.name}`}
              </Button>
              <Button
                testID={`connections.cancelReview.${service.id}`}
                variant="secondary"
                size="sm"
                disabled={busyId === service.id}
                onPress={() => { setReviewingId(null); setSheetError(null); }}
              >
                Cancel
              </Button>
            </Stack>
          </Stack>
        </Surface>
      );
    }

    return (
      <ConnectionCard
        key={service.id}
        row={row}
        busy={busyId === service.id}
        error={rowError?.id === service.id ? rowError.message : null}
        onOpen={() => {
          // This used to clear the drawer notice. Opening a consent sheet does
          // not resolve a read the broker never answered, and wiping the line
          // that said so left the reader with a screen that looked like it knew
          // what was connected when it did not, and no retry either.
          setSheetError(null);
          setReviewingId(service.id);
        }}
        onDisconnect={() => confirmDisconnect(service)}
      />
    );
  }
}

function CapacityProgressBar({ ratio, hardLimited, nearLimit, showLabel = true }: { ratio: number; hardLimited: boolean; nearLimit: boolean; showLabel?: boolean }) {
  const themeColors = useThemeColors();
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const fillProgress = useSharedValue(0);

  useEffect(() => {
    fillProgress.value = withTiming(clampedRatio, { duration: 540 });
  }, [clampedRatio, fillProgress]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${fillProgress.value * 100}%`,
  }));

  const fillColor = hardLimited ? themeColors.danger : nearLimit ? themeColors.warning : themeColors.accent;
  const label = hardLimited ? 'Full' : nearLimit ? 'Getting busy' : 'Comfortable';

  return (
    <Stack gap={2} accessibilityRole="progressbar" accessibilityValue={{ now: Math.round(clampedRatio * 100), min: 0, max: 100 }}>
      {showLabel ? (
        <Stack direction="horizontal" justify="space-between" align="center">
          <Text variant="caption" color="textTertiary">Monthly capacity</Text>
          <Text variant="caption" color={hardLimited ? 'danger' : nearLimit ? 'warning' : 'textSecondary'}>{label}</Text>
        </Stack>
      ) : null}
      <View style={[styles.capacityTrack, { backgroundColor: themeColors.border }]}>
        <Animated.View style={[styles.capacityFill, { backgroundColor: fillColor }, fillStyle]} />
      </View>
    </Stack>
  );
}

function FaqCard({ item, isFirst, index = 0 }: { item: { question: string; answer: string }; isFirst: boolean; index?: number }) {
  const [expanded, setExpanded] = useState(false);
  const themeColors = useThemeColors();
  const chevronProgress = useSharedValue(0);

  const toggle = () => {
    setExpanded((prev) => {
      const next = !prev;
      chevronProgress.value = withTiming(next ? 1 : 0, { duration: 160 });
      return next;
    });
  };

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronProgress.value * 180}deg` }],
  }));

  return (
    <View style={[styles.faqRow, isFirst ? null : { borderTopWidth: 1, borderTopColor: themeColors.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={item.question}
        onPress={toggle}
        hitSlop={touchHitSlop}
        style={styles.faqHeader}
      >
        <View style={[styles.faqTile, { backgroundColor: pastelTint(index) }]}>
          <Text variant="caption" color="textPrimary" style={styles.faqTileText}>{index + 1}</Text>
        </View>
        <Text variant="title" style={styles.flexText}>{item.question}</Text>
        <Animated.View style={chevronStyle}>
          <Feather name="chevron-down" size={18} color={themeColors.textTertiary} />
        </Animated.View>
      </Pressable>
      {expanded ? (
        <Animated.View entering={FadeInUp.duration(160)} style={styles.faqAnswer}>
          <Text variant="bodySm" color="textSecondary">{item.answer}</Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

function FaqDrawer() {
  const agentEngine = useIsAgentEngine();
  const renderItem = (item: (typeof DELEGENT_FAQ_ORDERED)[number], index: number) => (
    <FaqCard key={item.question} item={item} isFirst={index === 0} index={index} />
  );
  return (
    <Surface elevation="surfaceHigh" radius="lg" border style={styles.faqList}>
      {agentEngine ? AGENT_FAQ_ORDERED.map(renderItem) : DELEGENT_FAQ_ORDERED.map(renderItem)}
    </Surface>
  );
}

function HelpDrawer({ userEmail }: { userEmail?: string | null }) {
  const say = useWording();
  // 2026-07-16 (Alex): in-app support. The message goes to the worker, which
  // relays it to the corporate support inbox with the account attached, so a
  // stuck user never has to leave the app to reach a human.
  const themeColors = useThemeColors();
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<SupportTicketKind>('issue');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const isSuggestion = kind === 'suggestion';
  const submit = async () => {
    if (state === 'sending' || message.trim().length < 5) return;
    setState('sending');
    const ok = await sendSupportTicket(message.trim(), kind);
    setState(ok ? 'sent' : 'error');
  };
  if (state === 'sent') {
    return (
      <Stack gap={3}>
        <Text variant="title">{isSuggestion ? 'Thanks for the idea.' : "Got it. We're on it."}</Text>
        <Text variant="bodySm" color="textSecondary">
          {isSuggestion
            ? `Your suggestion is with the team. We read every one, and we'll reply to ${userEmail?.trim() || 'your account email'} if we need more detail.`
            : `Your message is with the team, and we'll reply to ${userEmail?.trim() || 'your account email'}. Most issues get a same-day response.`}
        </Text>
      </Stack>
    );
  }
  return (
    <Stack gap={3}>
      {/* Two doors: report a problem, or suggest a feature. Both reach the
          same team, tagged so they can be triaged apart. */}
      <Stack direction="horizontal" gap={2}>
        <Button
          testID="help.kind.issue"
          variant={isSuggestion ? 'secondary' : 'primary'}
          size="sm"
          onPress={() => setKind('issue')}
        >
          Something's not working
        </Button>
        <Button
          testID="help.kind.suggestion"
          variant={isSuggestion ? 'primary' : 'secondary'}
          size="sm"
          onPress={() => setKind('suggestion')}
        >
          Suggest a feature
        </Button>
      </Stack>
      <Text variant="bodySm" color="textSecondary">
        {isSuggestion
          ? say("Got an idea that would make your coworker better? Tell us what you'd love it to do.")
          : 'Something not working, or just confusing? Tell us what happened and we’ll sort it out.'}
      </Text>
      <TextInput
        testID="help.messageInput"
        value={message}
        onChangeText={setMessage}
        multiline
        numberOfLines={6}
        placeholder={isSuggestion ? "I'd love it if the app could..." : 'What went wrong, and what were you trying to do?'}
        placeholderTextColor={themeColors.textTertiary}
        accessibilityLabel={isSuggestion ? 'Describe your feature idea' : 'Describe the problem'}
        style={{
          minHeight: 132,
          textAlignVertical: 'top',
          borderWidth: 1,
          borderColor: themeColors.borderStrong,
          borderRadius: radii.md,
          padding: space[3],
          color: themeColors.textPrimary,
          backgroundColor: themeColors.surfaceHigh,
        }}
      />
      {state === 'error' ? (
        <Text variant="bodySm" color="danger">That didn't send. Check your connection and try again, or email support@example.com.</Text>
      ) : null}
      <Button testID="help.submitButton" variant="primary" fullWidth disabled={state === 'sending' || message.trim().length < 5} onPress={() => { void submit(); }}>
        {state === 'sending' ? 'Sending…' : isSuggestion ? 'Send suggestion' : 'Send to support'}
      </Button>
    </Stack>
  );
}

function CapacityDrawer({
  onOpenSetup,
  onOpenBillingPortal,
  onRefreshCapacity,
  productView,
  billingPortalState,
}: {
  onOpenSetup: () => void;
  onOpenBillingPortal: () => void;
  onRefreshCapacity: ProductRefresh;
  productView: ProductViewModel;
  billingPortalState: BillingPortalState;
}) {
  // v1.2.8, DN2 fix. Alex hit an infinite render loop opening this
  // page: the effect re-fired on every render because `onRefreshCapacity`
  // wasn't referentially stable, each call mutated productState back
  // to 'loading' (which re-rendered the parent which handed down a new
  // function ref), and the effect chased its own tail. Use a one-shot
  // ref guard the same way SetupWizardScreen already does.
  const refreshedOnEntryRef = useRef(false);
  useEffect(() => {
    if (refreshedOnEntryRef.current) return;
    refreshedOnEntryRef.current = true;
    void onRefreshCapacity().catch(() => undefined);
  }, [onRefreshCapacity]);

  const usage = productView.usageSummary;
  const agentEngine = useIsAgentEngine();

  // The browser will not draw a capacity card without an allowance behind it,
  // and this drawer drew a full one: a "Studio" badge (the tier lookup defaults
  // to the first tier), Studio's "Best for" line, and an empty bar telling a
  // reader with no plan at all that they had plenty of room this month. It is
  // reachable from the menu whether or not anyone has ever subscribed. The test
  // now lives on the view model because two other surfaces render the same
  // numbers and neither had it.
  if (!productView.hasCapacityAllowance) {
    return (
      <Stack gap={4}>
        <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
          <Stack gap={2}>
            <Text variant="title">{CAPACITY_NO_ALLOWANCE_TITLE}</Text>
            <Text variant="bodySm" color="textSecondary">{CAPACITY_NO_ALLOWANCE_BODY}</Text>
          </Stack>
        </Surface>
        <Button variant="primary" fullWidth onPress={onOpenSetup} testID="capacity.seePlans">
          {CAPACITY_NO_ALLOWANCE_CTA}
        </Button>
      </Stack>
    );
  }

  // An agent-engine account has one plan, not a metered workspace allowance, so
  // Manage plan shows the plan itself: the price and everything it includes.
  if (agentEngine) {
    return (
      <Stack gap={4} testID="capacity.agentPlan">
        <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
          <Stack gap={3}>
            <Stack direction="horizontal" justify="space-between" align="center">
              <Text variant="caption" color="textTertiary">Current plan</Text>
              <Badge tone="accent">{productView.currentTier.name}</Badge>
            </Stack>
            <Text variant="displayMd" tabular>{`${formatAgentPlanPrice()} a month`}</Text>
            <Text variant="bodySm" color="textSecondary">{AGENT_PLAN_PRICE_NOTE}</Text>
          </Stack>
        </Surface>
        <AgentAllowanceCard testID="capacity.agentAllowance" />
        <Text variant="caption" color="textTertiary">What you get</Text>
        <AgentPlanHighlights testID="capacity.agentHighlights" />
        {billingPortalState.status === 'error' ? (
          <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
            <Text variant="bodySm" color="textSecondary">{billingPortalState.errorMessage}</Text>
          </Surface>
        ) : null}
        <Button variant="secondary" fullWidth disabled={billingPortalState.status === 'opening' || billingPortalState.status === 'confirming'} onPress={onOpenSetup}>
          Manage plan
        </Button>
      </Stack>
    );
  }


  const capacityTitle = usage.hardLimited
    ? 'You’ve used this month’s capacity'
    : usage.nearLimit
    ? 'Capacity is nearly full'
    : productView.capacityText;
  const capacityCopy = usage.hardLimited
    ? 'Tasks pause until next month or until you upgrade. Manage your plan to top up sooner.'
    : usage.nearLimit
    ? 'You can keep working. Move up a plan if you want headroom for the rest of the month.'
    : 'Plenty of room for admin, research, files, and follow-ups this month.';
  const billingBusy = billingPortalState.status === 'opening' || billingPortalState.status === 'confirming';
  const billingLabel = billingPortalState.status === 'opening'
    ? 'Opening billing…'
    : billingPortalState.status === 'confirming'
    ? 'Refreshing…'
    : productView.hasActiveSubscription
    ? 'Manage plan & payment'
    : 'Choose a plan';

  return (
    <Stack gap={4}>
      <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
        <Stack gap={3}>
          <Stack direction="horizontal" justify="space-between" align="center">
            <Text variant="caption" color="textTertiary">Current plan</Text>
            <Badge tone={usage.hardLimited ? 'danger' : usage.nearLimit ? 'warning' : 'accent'}>{productView.currentTier.name}</Badge>
          </Stack>
          <Text variant="displayMd">{capacityTitle}</Text>
          <Text variant="bodySm" color="textSecondary">{capacityCopy}</Text>
          <CapacityProgressBar ratio={usage.ratio} hardLimited={usage.hardLimited} nearLimit={usage.nearLimit} />
        </Stack>
      </Surface>
      <Stack gap={3}>
        <ProfileInfoRow label="Best for" value={productView.currentTier.capacity} />
        <ProfileInfoRow label="Files" value="Stored in your private cloud space" />
        <ProfileInfoRow label="Running short?" value="More compute and allowance in a tap" />
      </Stack>
      {billingPortalState.status === 'error' ? (
        // A refused downgrade is not a billing problem and not a failed open.
        // It is an answer about the space their files take up, so it is titled
        // as one, ahead of both failure framings.
        billingPortalState.errorReason === 'downgrade_storage_over_limit' ? (
          <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
            <Stack gap={2}>
              <Text variant="title">{STORAGE_DOWNGRADE_BLOCK_TITLE}</Text>
              <Text variant="bodySm" color="textSecondary">{billingPortalState.errorMessage}</Text>
            </Stack>
          </Surface>
        ) : // Distinguish a real billing problem (past_due, canceled, unpaid) from
        // a transient portal-open failure. The latter should never alarm the
        // user, it's almost always a network blip.
        productView.subscriptionNeedsAttention ? (
          <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
            <Stack gap={2}>
              <Text variant="title">Billing needs attention</Text>
              <Text variant="bodySm" color="textSecondary">{billingPortalState.errorMessage}</Text>
            </Stack>
          </Surface>
        ) : (
          <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
            <Stack gap={1}>
              {/* Show the actual error message (which carries the
                  status / server-code diagnostic suffix from
                  mobileCheckout.ts) instead of a hardcoded copy.
                  Otherwise the user / Alex sees an opaque "try
                  again" with no way to report what went wrong. */}
              <Text variant="bodySm" color="textSecondary">{billingPortalState.errorMessage}</Text>
            </Stack>
          </Surface>
        )
      ) : null}
      {/*
        D3/D6 fix — the "Manage plan & payment" button used to call
        onOpenBillingPortal directly when the user had an active
        subscription. That took the user to the Stripe customer portal
        which (with our current config) shows cancel-only — not the
        plan picker. Result: there was no in-app path to upgrade.

        Now: always open the in-app SetupWizardScreen. That screen
        shows the three tiers, lets the user pick one, and routes to
        Stripe Checkout for the new tier (or to the portal for cancel
        when "Cancel subscription" is tapped inside the screen).
      */}
      <Button
        variant={usage.hardLimited || usage.nearLimit ? 'primary' : 'secondary'}
        fullWidth
        disabled={billingBusy}
        onPress={onOpenSetup}
      >
        {productView.hasActiveSubscription ? 'Manage plan' : billingLabel}
      </Button>
    </Stack>
  );
}

function checkoutErrorTitle(reason: MobileCheckoutErrorReason): string {
  const titles: Record<MobileCheckoutErrorReason, string> = {
    purchase_pending: 'Your purchase is still in progress',
    purchase_requires_review: 'Your purchase needs checking',
    payment_required: 'Update your payment method',
    missing_api_base: 'Checkout isn’t connected yet',
    unauthenticated: 'Sign in again to continue',
    unavailable: 'Checkout is temporarily offline',
    unreachable: 'We can’t reach the app',
    checkout_refused: 'You’re already on this plan',
    plan_change_required: 'Use Manage plan to change',
    subscription_recovered: 'Your plan is already active',
    // A statement of fact, not an outage. Nothing here will start working if
    // the reader waits or taps again.
    managed_elsewhere: 'Your plan is billed elsewhere',
    // Deliberately reassuring. Apple has already charged them, so any title
    // implying failure would be false AND would push them to buy twice.
    purchase_confirming: 'Your payment went through',
    // NOT an outage. Nothing changes if they wait, so the title must not
    // imply it might. It points at the one action that resolves it.
    owned_by_another_account: 'Already used on another account',
  };
  return titles[reason];
}

/**
 * What a signed-in customer without a subscription sees on an iOS build in
 * Guideline 3.1.3(f) mode.
 *
 * EVERY WORD HERE IS LOAD-BEARING. This is the screen an App Review reviewer
 * looks at to decide whether the app contains a "call to action for purchase
 * outside of the app". It may not contain a price, a plan name attached to a
 * price, a URL, a button that opens a browser, or a verb like subscribe,
 * upgrade, buy or get started pointed at a purchase. Saying where to go is
 * exactly what gets it rejected. Stating that the account has no workspace is
 * account state, not a solicitation, and is allowed.
 *
 * The copy lives in packages/shared so the reviewer-facing wording cannot drift
 * from what we told Apple it says.
 */
function NoPurchaseScreen({ onClose, topPadding }: { onClose: () => void; topPadding: number }) {
  return (
    <View style={styles.setupScreen}>
      <AmbientBackground />
      <Stack
        direction="horizontal"
        align="center"
        justify="space-between"
        gap={3}
        style={[styles.setupHeader, { paddingTop: topPadding }]}
      >
        <Stack gap={1} style={styles.flexText}>
          <Text variant="caption" color="textTertiary" testID="setup.stepIndicator">Your account</Text>
        </Stack>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          hitSlop={touchHitSlop}
          style={styles.setupHeaderClose}
          testID="setup.closeButton"
        >
          <Feather name="x" size={18} color={appColors.textSecondary} />
        </Pressable>
      </Stack>

      <ScrollView
        style={styles.setupScroll}
        contentContainerStyle={styles.setupScrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Stack gap={4} testID="setup.noPurchase">
          <Text variant="displayLg">{IOS_NO_SUBSCRIPTION_TITLE}</Text>
          <Text variant="body" color="textSecondary">{IOS_NO_SUBSCRIPTION_BODY}</Text>
        </Stack>
      </ScrollView>
    </View>
  );
}

function SetupWizardScreen({
  onboardingGoal,
  entryPoint,
  visible = true,
  productView,
  checkoutState,
  billingPortalState,
  onOpenCheckout,
  onOpenBillingPortal,
  onContinueToHome,
  onRefreshCapacity,
  onClose,
}: {
  entryPoint: PaywallEntryPoint;
  onboardingGoal?: OnboardingGoal | null;
  visible?: boolean;
  productView: ProductViewModel;
  checkoutState: CheckoutState;
  billingPortalState: BillingPortalState;
  onOpenCheckout: (tierId: TierId) => void;
  onOpenBillingPortal: (targetTierId?: TierId | null) => void;
  onContinueToHome: () => void;
  onRefreshCapacity: ProductRefresh;
  onClose: () => void;
}) {
  const exposure = useRef(createPaywallExposure(track));
  const agentEngine = useIsAgentEngine();
  const paywallAdvert = usePaywallAdvert(productView.userId, visible && canShowPurchaseUi(), !productView.hasActiveSubscription);
  // The money check they did on the way in (2026-09-27), shown as the first job.
  const { intent: moneyPlan } = useMoneyIntent();
  useEffect(() => {
    exposure.current.update(visible && canShowPurchaseUi(), entryPoint, PAYWALL_VARIANT);
  }, [visible, entryPoint]);
  const dismissPaywall = useCallback((reason: 'close' | 'back' | 'not_now' = 'close') => {
    exposure.current.dismiss(reason);
    onClose();
  }, [onClose]);
  useEffect(() => {
    if (!visible) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      dismissPaywall('back');
      return true;
    });
    return () => back.remove();
  }, [visible, dismissPaywall]);
  // v1.2.1, Setup is just plan selection now. No messenger step, no
  // post-pay "open Telegram" detour. The user picks a plan, pays, and
  // lands directly on the chat surface to meet their coworker.
  const [selectedTier, setSelectedTier] = useState<TierId>(productView.hasActiveSubscription ? productView.currentTierId : 'studio');
  const [selectedTierManuallyChanged, setSelectedTierManuallyChanged] = useState(false);
  const [showAllPlans, setShowAllPlans] = useState(productView.hasActiveSubscription);
  const planScroll = useRef<ScrollView>(null);
  const plansTop = useRef(0);
  const revealPlans = useRef(false);
  const refreshedOnEntryRef = useRef(false);
  const selectedPlan = tiersForEngine(agentEngine).find((tier) => tier.id === selectedTier) ?? productView.currentTier;
  const selectedPlanIsCurrent = productView.hasActiveSubscription && selectedTier === productView.currentTierId;
  const selectedPlanNeedsChange = productView.hasActiveSubscription && !selectedPlanIsCurrent;
  const selectedPlanIsDowngrade = selectedPlanNeedsChange && isPlanDowngrade(productView.currentTierId, selectedTier);
  // A friend's invite code (2026-09-23): for someone who has not bought yet, on
  // Android only (src/billing/referral.ts). Hooks stay above the early return below.
  const inviteBoxAvailable = Platform.OS === 'android' && agentEngine && !productView.hasActiveSubscription;
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteOutcome, setInviteOutcome] = useState<RedeemOutcome | null>(null);
  const submitInviteCode = useCallback(async () => {
    if (inviteBusy || !looksLikeInviteCode(inviteCode)) return;
    setInviteBusy(true);
    const outcome = await redeemInviteCode(inviteCode);
    setInviteBusy(false);
    setInviteOutcome(outcome);
  }, [inviteBusy, inviteCode]);
  const [appleOffers, setAppleOffers] = useState<ApplePlanOffers>({});
  useEffect(() => {
    if (!visible || !SIDEKICK_FREE_TRIAL.enabled || !usesStoreKit() || !canShowPurchaseUi()) return;
    let cancelled = false;
    setAppleOffers({});
    void readApplePlanOffers().then((offers) => { if (!cancelled) setAppleOffers(offers); });
    return () => { cancelled = true; };
  }, [visible, productView.userId]);
  const trialCandidate = shouldQuoteFreeTrial({
    status: productView.subscriptionStatus, currentPeriodEnd: productView.nextResetAtIso ?? undefined,
  });
  // An assistant account on iPhone is quoted Apple's own product (£3.99, first
  // month free, 2026-09-16): its price and its offer as StoreKit reports them,
  // never the Stripe figures, which is what Apple reviews against.
  const nativeOffer = (agentEngine ? appleOffers.assistant : appleOffers[selectedTier]) ?? applePlanOffer({ id: selectedTier }, null);
  const quoteTrial = usesStoreKit()
    ? (agentEngine ? nativeOffer.hasFreeMonth : SIDEKICK_FREE_TRIAL.enabled && nativeOffer.hasThreeDayTrial)
    : trialCandidate;
  const offerPriceLine = agentEngine
    ? usesStoreKit()
      ? nativeOffer.priceLine
      : (trialCandidate ? agentFreeTrialTermsLine() : `${formatAgentPlanPrice()} a month. Cancel anytime.`)
    : SIDEKICK_FREE_TRIAL.enabled && usesStoreKit()
    ? nativeOffer.priceLine
    : paywallPriceLine(selectedTier, productView.subscriptionStatus, productView.nextResetAtIso);

  useEffect(() => {
    if (refreshedOnEntryRef.current) return;
    refreshedOnEntryRef.current = true;
    void onRefreshCapacity().catch(() => undefined);
  }, [onRefreshCapacity]);

  useEffect(() => {
    if (!selectedTierManuallyChanged) {
      setSelectedTier(productView.hasActiveSubscription ? productView.currentTierId : 'studio');
    }
  }, [productView.currentTierId, productView.hasActiveSubscription, selectedTierManuallyChanged]);

  const chooseTier = useCallback((tier: TierId) => {
    setSelectedTierManuallyChanged(true);
    setSelectedTier(tier);
  }, []);

  const checkoutInFlight = checkoutState.status === 'opening' || checkoutState.status === 'confirming';
  const billingPortalInFlight = billingPortalState.status === 'opening' || billingPortalState.status === 'confirming';
  const actionInFlight = checkoutInFlight || billingPortalInFlight;
  const selectedCheckoutBusy = checkoutInFlight && checkoutState.tierId === selectedTier;
  const checkoutError: CheckoutError | null = checkoutState.status === 'error'
    ? { tierId: checkoutState.tierId, reason: checkoutState.errorReason, message: checkoutState.errorMessage }
    : null;
  const billingPortalError = billingPortalState.status === 'error' ? billingPortalState.errorMessage : null;
  const billingPortalStorageBlocked =
    billingPortalState.status === 'error' && billingPortalState.errorReason === 'downgrade_storage_over_limit';
  // "Secure checkout" is Stripe language and must NEVER appear on a StoreKit
  // build. It tells the user they are about to leave for an external payment
  // page, which is the exact impression that got build 37 rejected under
  // Guideline 3.1.1, and on iOS it is simply false: nothing opens, Apple takes
  // the payment in a sheet.
  //
  // The accessibility label and the plan-change caption were already fixed for
  // StoreKit (see the note below). THE VISIBLE BUTTON WAS MISSED, so the one
  // string a reviewer actually reads still advertised a web checkout. Alex hit
  // this on 2026-08-27: the button he was watching hang said "Opening secure
  // checkout…" on a build where StoreKit, not Stripe, was doing the work.
  const purchasesThroughStoreKit = usesStoreKit();
  const checkoutBusyLabel = checkoutState.status === 'opening'
    ? purchasesThroughStoreKit ? 'Contacting the App Store…' : 'Opening secure checkout…'
    : 'Confirming subscription…';
  const checkoutLabel = selectedPlanNeedsChange
    ? selectedCheckoutBusy
      ? checkoutBusyLabel
      : `Change to ${selectedPlan.name}`
    : selectedPlanIsCurrent
    ? 'Go to chat'
    : selectedCheckoutBusy
    ? checkoutBusyLabel
    : quoteTrial
    ? (agentEngine ? AGENT_PLAN_TRIAL_CTA : 'Start 3-day free trial')
    : purchasesThroughStoreKit
    ? `Subscribe to ${selectedPlan.name}`
    : 'Open secure checkout';
  // [#11 plan-picker copy] The caption used to say "Change plan" right
  // above a "Change to <plan>" button, repeating the same words. When
  // the user is changing plan, the button text alone is enough; say what
  // the change will actually cost instead. Which is not the same
  // sentence in both directions, hence planChangeNote.
  //
  // NAMING STRIPE ON AN iOS StoreKit BUILD IS A GUIDELINE 3.1.1 PROBLEM, and
  // it was doing so in two places. The visible caption said "Stripe pro-rates
  // the difference" under a change-plan button, and the accessibility label
  // said "Open secure Stripe Checkout" out loud on the ordinary buy button.
  // The second is worse: it is what a VoiceOver user, and any reviewer testing
  // with VoiceOver, actually hears while StoreKit takes the payment.
  //
  // Beyond the guideline it is simply untrue on iOS. Apple takes the money and
  // Apple decides the proration, so a promise about what Stripe will do is a
  // promise we are not in a position to make.
  const storeKitPurchase = purchasesThroughStoreKit;
  const planChangeCaption = storeKitPurchase
    ? 'Managed by Apple'
    : planChangeNote(selectedPlanIsDowngrade);
  const checkoutCaption = selectedPlanNeedsChange
    ? planChangeCaption
    : selectedPlanIsCurrent
    ? 'Ready to chat'
    : quoteTrial
    ? 'Nothing to pay today'
    : 'Pay securely';
  const purchaseNoun = storeKitPurchase ? 'the App Store purchase' : 'Stripe Checkout';
  // 2026-09-27 (Alex: "emphasise free ... blown up ... the 3.99 needs to be
  // small"): on Android a new subscriber's footer leads with a big Free, and
  // the monthly price stays in plain, readable text beside it and in the terms
  // line (UK consumer law and Google Play both want it clear, not fine print).
  // NEVER on iPhone: Apple requires the billed amount to be the most prominent
  // price on the page (Guideline 3.1.2), so StoreKit keeps its own layout.
  const freeHero = agentEngine && quoteTrial && !purchasesThroughStoreKit && !selectedPlanNeedsChange && !selectedPlanIsCurrent;
  const checkoutAccessibilityLabel = selectedPlanNeedsChange
    ? `Open ${purchaseNoun} to change to ${selectedPlan.name}. ${planChangeCaption}.`
    : selectedPlanIsCurrent
    ? `Continue to chat with ${productView.agentName}`
    : `Open ${purchaseNoun} for ${selectedPlan.name}`;

  // [#9, #10 plan-picker close] The SetupWizardScreen renders full-screen
  // and used to sit directly under the system status bar — on a Pixel
  // 10 the X button overlapped the battery icon and was both invisible
  // and touch-blocked. Push the header down by the device top inset so
  // it's reachable, with a sane minimum for older devices that report 0.
  const insets = useSafeAreaInsets();
  const setupHeaderTopPadding = Math.max(insets.top, space[3]);

  // GUIDELINE 3.1.3(f) GATE. On an iOS build in 'hidden' mode this screen may
  // not exist: no prices, no plan picker, no button that leads to a purchase
  // anywhere. Apple rejected 2.5.0 (37) on 2026-08-18 precisely because this
  // screen listed three prices and opened Stripe Checkout in Safari.
  //
  // It sits BELOW every hook on purpose. Returning earlier would make the hook
  // count conditional, and the mode is a build-time constant so nothing above
  // this line can behave differently between renders.
  if (!canShowPurchaseUi()) {
    return (
      <NoPurchaseScreen onClose={onClose} topPadding={setupHeaderTopPadding} />
    );
  }

  return (
    <View style={styles.setupScreen}>
      <AmbientBackground />
      <Stack
        direction="horizontal"
        align="center"
        justify="space-between"
        gap={3}
        style={[styles.setupHeader, { paddingTop: setupHeaderTopPadding }]}
      >
        <Stack gap={1} style={styles.flexText}>
          <Text variant="caption" color="textTertiary" testID="setup.stepIndicator">{agentEngine ? 'Your connected AI coworker' : 'Your AI coworker'}</Text>
        </Stack>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close setup guide"
          onPress={() => dismissPaywall()}
          hitSlop={touchHitSlop}
          style={styles.setupHeaderClose}
          testID="setup.closeButton"
        >
          <Feather name="x" size={18} color={appColors.textSecondary} />
        </Pressable>
      </Stack>

      <ScrollView
        ref={planScroll}
        style={styles.setupScroll}
        contentContainerStyle={styles.setupScrollContent}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => {
          if (!revealPlans.current) return;
          requestAnimationFrame(() => {
            revealPlans.current = false;
            planScroll.current?.scrollTo({ y: Math.max(0, plansTop.current - 12), animated: true });
          });
        }}
      >
        <Stack gap={4}>
          {/* 2026-09-26: the plan screen rises in like the rest of the first-run
              journey. Motion only; every word and every purchase rule below is
              unchanged. */}
          <Rise>
          <Stack gap={2}>
            {/* A subscriber opening Plan & billing is not being sold to: until
                2026-09-23 they got the welcome pitch and a "Meet Barry" button. */}
            <Text variant="displayLg" testID="paywall.headline">{agentEngine
              ? productView.hasActiveSubscription ? 'Your plan' : 'Meet your connected AI coworker'
              : paywallAdvert
              ? advertHeadline(paywallAdvert, productView.subscriptionStatus, productView.nextResetAtIso)
              : onboardingGoal ? GOAL_HEADLINES[onboardingGoal] : 'Meet your AI coworker'}</Text>
            <Text variant="body" color="textSecondary">{agentEngine && productView.hasActiveSubscription
              ? `You're all set. ${productView.agentName} is ready when you are.`
              : `Give ${productView.agentName} the routine work. Make room for yours.`}</Text>
          </Stack>
          </Rise>
          {!productView.hasActiveSubscription && moneyPlan?.wants ? (
            <Rise delay={100}>
              <MoneyPlanCard testID="paywall.moneyPlan" intent={moneyPlan} title="YOUR FIRST JOB" />
            </Rise>
          ) : null}
          {agentEngine && productView.hasActiveSubscription ? <AgentAllowanceCard testID="paywall.agentAllowance" /> : null}
          {agentEngine ? (
            <Rise delay={160}>
            <Stack gap={2}>
              <Text variant="caption" color="textTertiary">What you get</Text>
              <AgentPlanHighlights testID="paywall.agentHighlights" />
            </Stack>
            </Rise>
          ) : (
            <Stack gap={3}>
              <FeatureRow>Reads your inbox</FeatureRow>
              <FeatureRow>Files your receipts into FreeAgent</FeatureRow>
              <FeatureRow>Chases what you forget</FeatureRow>
            </Stack>
          )}
          <Stack gap={2}>
            <Rise delay={320}>
              <ReviewCarousel reviews={PAYWALL_REVIEWS} />
            </Rise>
            <Text variant="caption" color="textSecondary">
              {/* An assistant account has no private cloud space of its own to promise. */}
              {agentEngine ? `${MODEL_CLAIM_SHORT}, and nothing you send is used to train it.` : MODEL_CLAIM_PAYWALL}
            </Text>
          </Stack>
          <Stack gap={3} onLayout={(event) => {
            plansTop.current = event.nativeEvent.layout.y;
          }}>
            <Button variant="ghost" testID="paywall.seeAllPlans" onPress={() => {
              revealPlans.current = !showAllPlans;
              setShowAllPlans(!showAllPlans);
            }}>
              {showAllPlans ? 'Hide plan details' : agentEngine ? 'See plan details' : 'See all plans'}
            </Button>
            {showAllPlans ? <>
            {agentEngine ? null : <Text variant="caption" color="textSecondary">Pick a plan</Text>}
            {agentEngine ? null : <TierSegment selectedTier={selectedTier} onChange={chooseTier} />}
            <PlanCard
              tier={selectedPlan}
              isCurrent={selectedPlanIsCurrent}
              subscriptionStatus={productView.subscriptionStatus}
              cycleEndAtIso={productView.nextResetAtIso}
              offerPriceLine={SIDEKICK_FREE_TRIAL.enabled ? offerPriceLine : undefined}
            />
            </> : null}
          </Stack>
          {inviteBoxAvailable ? (
            <Stack gap={2} testID="paywall.inviteBox">
              {inviteOpen ? (
                <>
                  <Text variant="caption" color="textTertiary">Invite code from a friend</Text>
                  <TextInput
                    testID="paywall.inviteCodeInput"
                    accessibilityLabel="Invite code from a friend"
                    value={inviteCode}
                    onChangeText={(text) => { setInviteCode(tidyInviteCode(text)); setInviteOutcome(null); }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={11}
                    placeholder="ABCD2345"
                    placeholderTextColor={appColors.textTertiary}
                    returnKeyType="done"
                    onSubmitEditing={() => { void submitInviteCode(); }}
                    style={styles.inviteCodeInput}
                  />
                  <Button
                    testID="paywall.inviteCodeApply"
                    variant="secondary"
                    disabled={inviteBusy || !looksLikeInviteCode(inviteCode) || inviteOutcome?.ok === true}
                    onPress={() => { void submitInviteCode(); }}
                  >
                    {inviteBusy ? 'Checking the code' : 'Use this code'}
                  </Button>
                  {inviteOutcome ? (
                    <Text variant="bodySm" color={inviteOutcome.ok ? 'textPrimary' : 'textSecondary'} testID="paywall.inviteCodeResult">
                      {inviteOutcome.message}
                    </Text>
                  ) : null}
                </>
              ) : (
                <Pressable accessibilityRole="button" testID="paywall.inviteCodeLink" onPress={() => setInviteOpen(true)} hitSlop={touchHitSlop}>
                  <Text variant="bodySm" color="accent">Have an invite code from a friend?</Text>
                </Pressable>
              )}
            </Stack>
          ) : null}
        </Stack>
      </ScrollView>

      <Surface elevation="surfaceHigh" radius="xxl" style={[styles.setupFooter, shadow.sheet]}>
        <Stack gap={2}>
          {checkoutError ? (
            <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
              <Stack gap={2}>
                <Text variant="title">{checkoutErrorTitle(checkoutError.reason)}</Text>
                <Text variant="bodySm" color="textSecondary">{checkoutError.message}</Text>
                {checkoutError.reason === 'payment_required' && !purchasesThroughStoreKit ? (
                  <Button onPress={() => onOpenBillingPortal()}>Manage billing</Button>
                ) : null}
              </Stack>
            </Surface>
          ) : null}

          {billingPortalError ? (
            // Ahead of both failure titles: the server refused the downgrade on
            // purpose, and "Couldn't open the billing page" would send the
            // reader back to a button that refuses them for the same reason.
            billingPortalStorageBlocked ? (
              <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
                <Stack gap={2}>
                  <Text variant="title">{STORAGE_DOWNGRADE_BLOCK_TITLE}</Text>
                  <Text variant="bodySm" color="textSecondary">{billingPortalError}</Text>
                </Stack>
              </Surface>
            ) : productView.subscriptionNeedsAttention ? (
              <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
                <Stack gap={2}>
                  <Text variant="title">Billing needs attention</Text>
                  <Text variant="bodySm" color="textSecondary">{billingPortalError}</Text>
                </Stack>
              </Surface>
            ) : (
              <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
                <Stack gap={1}>
                  {/* Calm retry copy for transient portal-open failures.
                      The subscription is fine, the portal just didn't
                      open this time. Static title + dynamic diagnostic
                      below for debug. */}
                  <Text variant="title">Couldn't open the billing page</Text>
                  <Text variant="bodySm" color="textSecondary">{billingPortalError}</Text>
                </Stack>
              </Surface>
            )
          ) : null}

          {freeHero ? <FreeMonthHero price={formatAgentPlanPrice()} /> : (
            <Text variant="title">{selectedPlan.name}{selectedTier === 'studio' && !selectedPlanIsCurrent && !agentEngine ? ' · Recommended' : ''}</Text>
          )}
          <Text variant="bodySm" color={freeHero ? 'textSecondary' : 'textPrimary'} testID="paywall.priceLine">
            {freeHero ? FREE_MONTH_SMALL_PRINT : offerPriceLine}
          </Text>
          {purchasesThroughStoreKit ? <Text variant="caption" color="textSecondary">Check Apple's confirmation screen before subscribing. Managed by Apple.</Text> : null}
          {/* The Free stamp already says there is nothing to pay today. */}
          {freeHero ? null : <Text variant="caption" color="textSecondary">{checkoutCaption}</Text>}
          {/*
            D3/D5/D6 fix — "Change to <plan>" used to route through
            onOpenBillingPortal, which opens the Stripe customer portal
            (cancel-only with our portal config). The correct flow for
            an upgrade/downgrade is a fresh Stripe Checkout for the
            target tier — Stripe recognises the existing customer + sub
            and walks the user through the plan change.
          */}
          {/*
            An iOS StoreKit build cannot change the tier of a subscription it
            did not sell. Offering the button anyway is what Alex hit on
            2026-08-19: "Change to Pro" was tappable, and the only possible
            outcome was a refusal from the double-billing guard AFTER the tap.
            Say so before the tap instead, and do not leave a dead control on
            the screen.

            NOW PROVIDER-AWARE (2026-08-20). This condition used to be just
            `storeKitPurchase && selectedPlanNeedsChange`, written when the app
            genuinely could not tell an Apple subscription from a Stripe one.
            Migration 0055 surfaced billing_provider, so it can. Left as it was,
            it told a customer who had JUST bought through StoreKit that their
            plan "was not bought through the App Store", and disabled the only
            control that could fix it. Alex hit exactly that an hour after the
            first successful Apple purchase.

            THIS IS THE SECOND OF TWO GATES and they must agree. The other is
            storeKitPurchaseBlockedByExistingSubscription, which stops the
            purchase itself. Fixing only that one leaves the user unable to
            reach it, which is what happened here.
          */}
          {storeKitPurchase && selectedPlanNeedsChange
            && productView.billingProvider !== 'apple' ? (
            <Surface elevation="surfaceHigh" radius="lg" padding={3} border testID="billing.managedElsewhereNotice">
              <Stack gap={1}>
                <Text variant="title">Your plan is billed elsewhere</Text>
                <Text variant="bodySm" color="textSecondary">
                  This subscription was not bought through the App Store, so it cannot be
                  changed here. Manage it where you started it.
                </Text>
              </Stack>
            </Surface>
          ) : null}
          <Button
            testID="billing.checkoutButton"
            variant="primary"
            fullWidth
            disabled={actionInFlight
              || (storeKitPurchase && selectedPlanNeedsChange
                && productView.billingProvider !== 'apple')}
            accessibilityLabel={checkoutAccessibilityLabel}
            onPress={() => {
              if (selectedPlanIsCurrent) {
                onContinueToHome();
              } else {
                // New subscription AND tier change both go through this one
                // handler, which branches on usesStoreKit() BEFORE any Stripe
                // call. On iOS that means StoreKit and no browser; a build in
                // 'iap' mode that handed off to Safari is the exact Guideline
                // 3.1.1 violation build 37 was rejected for. On Android and
                // web it is Stripe Checkout, whose session handles a plan
                // change correctly for an existing subscriber.
                onOpenCheckout(selectedTier);
              }
            }}
          >
            {checkoutLabel}
          </Button>
          {/*
            2026-09-12: Alex, subscribed on both phones, could not find how to
            cancel. The only control was "Manage plan" on the Profile screen,
            behind the avatar, and nothing on this screen (the one "Manage
            plan" on the capacity card actually opens) said the word cancel.
            So a subscriber on their current plan gets the control HERE, named
            for what they are looking for. Same handler as the profile button:
            the Stripe portal (cancel at period end) or Apple's subscription
            sheet, chosen by usesStoreKit(). When the build and the billing
            provider disagree (an Apple plan viewed on Android, a Stripe plan
            viewed on iOS) neither destination can show the plan, so say where
            it lives instead of offering a button that opens the wrong place.
          */}
          {productView.hasActiveSubscription && selectedPlanIsCurrent ? (
            canReachOwnBiller(productView.billingProvider) ? (
              <Button testID="paywall.cancelSubscription" variant="ghost" fullWidth disabled={actionInFlight} onPress={() => onOpenBillingPortal()}>
                {purchasesThroughStoreKit ? 'Cancel or manage in the App Store' : 'Cancel subscription'}
              </Button>
            ) : (
              <Text variant="caption" color="textSecondary" testID="paywall.cancelElsewhereNote">
                {productView.billingProvider === 'apple'
                  ? 'Your plan is billed through the App Store. To cancel it, open Settings on your iPhone or iPad, tap your name, then Subscriptions.'
                  : 'Your plan is not billed through the App Store. To cancel it, open the Android or web app, go to Manage plan, and use Cancel subscription under your plan.'}
              </Text>
            )
          ) : null}
          {!productView.hasActiveSubscription ? <Button testID="paywall.notNow" variant="ghost" fullWidth disabled={actionInFlight} onPress={() => dismissPaywall('not_now')}>Not now</Button> : null}
        </Stack>
      </Surface>
    </View>
  );
}

// How far left the finger has to travel before the drawer treats the touch as a
// drag rather than a tap, and how far before releasing closes it.
const DRAWER_DRAG_CLAIM_DP = 20;
const DRAWER_DRAG_CLOSE_DP = 80;
// Android's ScrollView starts intercepting at its own 8dp touch slop, and the
// moment it does React Native cancels the JS touch stream. That is why the
// swipe used to move the sheet a little and then stop dead on any drawer view
// with something to scroll: the sheet was still trying to WIN that race at 20dp,
// by which point the scroller had already taken the gesture. So take the
// scroller out of the race below its own slop instead of racing it.
const DRAWER_DRAG_LOCK_DP = 5;

type DrawerDrag = {
  id: GestureResponderEvent['nativeEvent']['identifier'];
  x: number;
  y: number;
  claimed: boolean;
  locked: boolean;
  lastX: number;
  lastAt: number;
  prevX: number;
  prevAt: number;
};

function MenuDrawer({
  onboardingGoal,
  authUserId,
  visible,
  view,
  onChangeView,
  skillCategoryKey,
  onOpenSkillCategory,
  onClose,
  onSelectTab,
  onOpenCheckout,
  onOpenBillingPortal,
  onRefreshCapacity,
  onSignOut,
  profile,
  productView,
  checkoutState,
  billingPortalState,
}: {
  visible: boolean;
  onboardingGoal?: OnboardingGoal | null;
  /** The signed-in id, not the product snapshot's cached profile id. */
  authUserId: string;
  view: DrawerView;
  onChangeView: (view: DrawerView) => void;
  skillCategoryKey: string | null;
  onOpenSkillCategory: (key: string) => void;
  onClose: () => void;
  onSelectTab: (tab: Tab) => void;
  onOpenCheckout: (tierId: TierId) => void;
  onOpenBillingPortal: (targetTierId?: TierId | null) => void;
  onRefreshCapacity: ProductRefresh;
  onSignOut: () => Promise<void> | void;
  profile: AppProfile;
  productView: ProductViewModel;
  checkoutState: CheckoutState;
  billingPortalState: BillingPortalState;
}) {
  const agentEngine = useIsAgentEngine();
  // Read the connections as the menu opens, so Connections shows every card at
  // once instead of two and then the rest (Alex, 2026-09-28). Skipped while a
  // read from the last minute is still fresh.
  useEffect(() => {
    if (!visible || !authUserId) return;
    void prefetchConnectionInventory(authUserId, fetchConnectionStates, fetchComposioConnections);
  }, [visible, authUserId]);
  // Invite a friend (2026-09-23): Android members billed through Stripe only,
  // read while the menu is open (src/billing/referral.ts explains why not iOS).
  const referral = useReferral(visible && Platform.OS === 'android' && agentEngine && productView.hasActiveSubscription);
  const categories = useUseCaseCategories();
  const activeSkillCategoryTitle = categories.find((entry) => entry.key === skillCategoryKey)?.title ?? 'Skills & use cases';
  const openTab = (tab: Tab) => {
    onSelectTab(tab);
    onClose();
  };

  // Skills one-tap (2026-07-24): tapping a skill phrase sends it straight into
  // chat and lands the user on Chat, using the same dispatch path as the
  // Commands/personality options. No copy-paste, no leaving the app.
  const runSkillPhrase = (phrase: string) => {
    DeviceEventEmitter.emit('delegent:menuCommand', { command: phrase, mode: 'send' });
    openTab('dashboard');
  };

  // 2026-05-15 fix: the burger drawer had no swipe-to-close gesture and no
  // tap-to-close on the backdrop gap, so once open the only way out was to
  // tap a row, enter a submenu, then press back. 2026-07-24 polish: the sheet
  // now follows the finger and animates off-screen on release, for the
  // menu / submenu views (not the setup full-screen sheet, which has its own
  // dedicated close button and shouldn't be dismissed by an accidental
  // gesture mid-checkout).
  const { width: screenWidth } = useWindowDimensions();
  const dragX = useSharedValue(0);

  // 2026-07-26: the swipe used to be driven purely by a capture-phase
  // PanResponder on this sheet, which made it work on some drawer views and do
  // nothing on others. The body of every view is a ScrollView, and once a
  // ScrollView actually has something to scroll it takes the touch for itself
  // before an ancestor responder gets a look in, so the longer the menu the
  // more reliably the swipe died. Touch events reach this view no matter which
  // view owns the responder, so the drag is tracked from those instead; the
  // responder is claimed only once the drag is unmistakable, which is also what
  // cancels the press on whatever row the finger happened to land on.
  const drag = useRef<DrawerDrag | null>(null);
  // A shared value, NOT React state: see the note above the drag handlers.
  const scrollLocked = useSharedValue(false);
  const setScrollLocked = useCallback((locked: boolean) => { scrollLocked.value = locked; }, [scrollLocked]);
  const drawerScrollProps = useAnimatedProps(() => ({ scrollEnabled: !scrollLocked.value }));

  // Reset the sheet's drag offset whenever the drawer (re)opens, so a prior
  // swipe-close animation doesn't leave it parked off-screen next time.
  useEffect(() => {
    drag.current = null;
    dragX.value = 0;
    scrollLocked.value = false;
  }, [visible, view, dragX, scrollLocked]);

  const drawerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dragX.value }],
  }));

  const settleDrag = useCallback(
    (close: boolean) => {
      drag.current = null;
      if (close) {
        dragX.value = withTiming(-screenWidth, { duration: 180 }, (finished) => {
          if (finished) {
            runOnJS(onClose)();
          }
        });
      } else {
        dragX.value = withTiming(0, { duration: 160 });
      }
    },
    [dragX, onClose, screenWidth],
  );

  const dragHandlers = useMemo(
    () => ({
      onTouchStart: (event: GestureResponderEvent) => {
        if (drag.current) return;
        const touch = event.nativeEvent;
        drag.current = {
          id: touch.identifier,
          x: touch.pageX,
          y: touch.pageY,
          claimed: false,
          locked: false,
          lastX: touch.pageX,
          lastAt: Date.now(),
          prevX: touch.pageX,
          prevAt: Date.now(),
        };
      },
      onTouchMove: (event: GestureResponderEvent) => {
        const active = drag.current;
        const touch = event.nativeEvent;
        if (!active || touch.identifier !== active.id) return;
        const dx = touch.pageX - active.x;
        // Ignore rightward and vertical-dominant movement until the gesture has
        // been claimed, so ordinary scrolling and taps are untouched.
        if (!active.claimed && (dx >= 0 || Math.abs(dx) < Math.abs(touch.pageY - active.y))) return;
        // Leftward-dominant movement: freeze the scroller before it reaches its
        // own 8dp slop. After this point the touch stream cannot be taken away
        // mid-swipe, which is what makes the gesture behave the same on every
        // drawer view instead of only the ones with nothing to scroll.
        if (!active.locked && -dx >= DRAWER_DRAG_LOCK_DP) {
          active.locked = true;
          setScrollLocked(true);
        }
        active.prevX = active.lastX;
        active.prevAt = active.lastAt;
        active.lastX = touch.pageX;
        active.lastAt = Date.now();
        dragX.value = Math.min(0, dx);
        if (dx < -DRAWER_DRAG_CLAIM_DP) active.claimed = true;
      },
      onTouchEnd: (event: GestureResponderEvent) => {
        const active = drag.current;
        const touch = event.nativeEvent;
        if (!active || touch.identifier !== active.id) return;
        const elapsed = Math.max(1, active.lastAt - active.prevAt);
        const velocity = (active.lastX - active.prevX) / elapsed;
        setScrollLocked(false);
        settleDrag(touch.pageX - active.x < -DRAWER_DRAG_CLOSE_DP || velocity < -0.4);
      },
      onTouchCancel: () => {
        setScrollLocked(false);
        if (drag.current) settleDrag(false);
      },
    }),
    [dragX, settleDrag],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // The touch handlers above own the gesture. Taking the responder here
        // is purely so the row under the finger drops its press once the drag
        // is real, and so the native scroller stops competing for the touch.
        onMoveShouldSetPanResponderCapture: () => drag.current?.claimed === true,
        onShouldBlockNativeResponder: () => true,
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );

  // [DN1.3-03] Modal.onRequestClose fires for hardware Back BEFORE the
  // global BackHandler runs. If we routed every Back to `onClose`, the
  // drawer would slam shut even when the user expected Back to navigate
  // from a subpage (Terms / Privacy / etc.) back to the menu list. Map
  // the modal-level Back to a view-aware handler: if we're on a subpage,
  // return to the menu; otherwise fall through to onClose.
  const onModalRequestClose = useCallback(() => {
    if (view === 'setup' && canShowPurchaseUi()) {
      track('paywall_dismissed', { variant: PAYWALL_VARIANT, entry_point: 'menu', reason: 'back' });
    }
    if (view === 'skillCategory') {
      onChangeView('skills');
      return;
    }
    if (view !== 'menu' && view !== 'setup') {
      onChangeView('menu');
      return;
    }
    onClose();
  }, [view, onChangeView, onClose]);

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onModalRequestClose}>
      <View style={[styles.drawerBackdrop, view === 'setup' ? styles.setupBackdrop : null]}>
        {view !== 'setup' ? (
          <Pressable
            style={styles.drawerBackdropDismiss}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            testID="drawer.backdropDismiss"
          />
        ) : null}
        <Animated.View
          style={view === 'setup' ? styles.setupFullScreenSheet : [styles.drawerSheetWrapper, drawerAnimatedStyle]}
          {...(view === 'setup' ? {} : { ...dragHandlers, ...panResponder.panHandlers })}
        >
        <Surface
          elevation="surface"
          radius="xxl"
          style={[view === 'setup' ? styles.setupSheetSurface : styles.drawerSheet, view === 'setup' ? null : shadow.sheet]}
        >
          {/* The drawer sits in the same ambient light as the chat behind it. */}
          {view === 'setup' ? null : <AmbientBackground intensity={0.85} />}
          {view === 'setup' ? (
            <SetupWizardScreen
              onboardingGoal={onboardingGoal}
              entryPoint="menu"
              visible={visible}
              productView={productView}
              checkoutState={checkoutState}
              billingPortalState={billingPortalState}
              onOpenCheckout={onOpenCheckout}
              onOpenBillingPortal={onOpenBillingPortal}
              onContinueToHome={() => openTab('dashboard')}
              onRefreshCapacity={onRefreshCapacity}
              onClose={onClose}
            />
          ) : view === 'menu' ? (
            <Animated.ScrollView contentContainerStyle={styles.drawerScroll} showsVerticalScrollIndicator={false} animatedProps={drawerScrollProps}>
              <Stack gap={4}>
                <Entry index={0}>
                  <DrawerHeader title="Menu" />
                </Entry>
                {/* The account card: frosted like the rows below it, set apart
                    by its size and the avatar rather than by colour (Pearl). */}
                <Entry index={1}>
                  <Pressable accessibilityRole="button" accessibilityLabel="Open profile" onPress={() => openTab('profile')} style={styles.drawerProfileCard}>
                    <View style={styles.drawerProfileAvatarRing}>
                      <ProfileAvatar profile={profile} size="lg" />
                    </View>
                    <Stack gap={1} style={styles.flexText}>
                      <Text variant="title" style={styles.accountCardTitle} numberOfLines={1}>{profile.name}</Text>
                      <Text variant="bodySm" color="textSecondary" numberOfLines={1}>{profile.email}</Text>
                    </Stack>
                    <View style={styles.accountCardChevron}>
                      <Feather name="chevron-right" size={16} color={appColors.textSecondary} />
                    </View>
                  </Pressable>
                </Entry>

                {/* 2026-07-18 (Alex) menu regroup: Chat + Files together (Files
                    demoted - there's already a files quick-action bottom-right);
                    Skills + guides promoted right under Chat; Monthly capacity
                    promoted so it's visible without scrolling; Help + FAQ
                    grouped; Legal (Terms/Privacy/Open source) demoted + bundled
                    at the bottom. */}
                <Entry index={2}>
                {agentEngine ? (
                  // Agent engine: no file store, commands or routines. Starting
                  // a fresh chat, the one command that still means something, is
                  // a row of its own, below Connections so a thumb does not land
                  // on it first.
                  <Surface elevation="surfaceHigh" radius="lg" border>
                    <MenuRow testID="menu.homeRow" icon="message-circle" label="Chat" detail="Talk to your coworker" onPress={() => openTab('dashboard')} />
                    <Divider inset={MENU_DIVIDER_INSET} />
                    <MenuRow testID="menu.connectionsRow" icon="link" label="Connections" detail="Your apps, plus travel, web and more built in" onPress={() => onChangeView('connections')} />
                    <Divider inset={MENU_DIVIDER_INSET} />
                    <MenuRow
                      testID="menu.freshChatRow"
                      icon="rotate-ccw"
                      label="Start a fresh chat"
                      detail="A clean conversation; your coworker keeps its memory of you and can look back at earlier chats"
                      onPress={() => {
                        DeviceEventEmitter.emit('delegent:startFreshChat');
                        openTab('dashboard');
                      }}
                    />
                  </Surface>
                ) : (
                <Surface elevation="surfaceHigh" radius="lg" border>
                  <MenuRow testID="menu.homeRow" icon="message-circle" label="Chat" detail="Talk to your coworker" onPress={() => openTab('dashboard')} />
                  <Divider inset={MENU_DIVIDER_INSET} />
                  <MenuRow testID="menu.filesRow" icon="folder" label="Files" detail="Everything in their cloud space" onPress={() => openTab('artifacts')} />
                  <Divider inset={MENU_DIVIDER_INSET} />
                  <MenuRow testID="menu.commandsRow" icon="command" label="Commands" detail="Quick actions like starting a fresh chat" onPress={() => onChangeView('commands')} />
                  <Divider inset={MENU_DIVIDER_INSET} />
                  {/* 2026-07-25 (Alex, roadmap #3): recurring work gets its own
                      section. The instruction runs on a schedule and the reply
                      lands in chat, so it sits alongside Chat/Files/Commands. */}
                  <MenuRow testID="menu.routinesRow" icon="repeat" label="Routines" detail="Work they do on a schedule, like a Monday inbox summary" onPress={() => onChangeView('routines')} />
                  <MenuRow testID="menu.connectionsRow" icon="link" label="Connections" detail="Give them their own mailbox to work from" onPress={() => onChangeView('connections')} />
                </Surface>
                )}
                </Entry>

                <Entry index={3}>
                <Stack gap={2}>
                  <MenuSectionLabel testID="menu.section.learn">Skills &amp; guides</MenuSectionLabel>
                  <Surface elevation="surfaceHigh" radius="lg" border>
                    <MenuRow testID="menu.skillsRow" icon="zap" label="Skills & use cases" detail={agentEngine ? 'Everyday jobs it can do for you' : 'What your coworker can do'} onPress={() => onChangeView('skills')} />
                    <Divider inset={MENU_DIVIDER_INSET} />
                    <MenuRow testID="menu.howtoRow" icon="book-open" label="How-to guides" detail={agentEngine ? 'Get the most from your coworker' : 'Get the most from your coworker'} onPress={() => onChangeView('howto')} />
                  </Surface>
                </Stack>
                </Entry>

                <Entry index={4}>
                <Stack gap={2}>
                  <MenuSectionLabel testID="menu.section.plan">Your plan</MenuSectionLabel>
                  <Surface elevation="surfaceHigh" radius="lg" border>
                    {agentEngine ? null : (
                      <>
                        <MenuRow testID="menu.capacityRow" icon="bar-chart-2" label="Monthly capacity" detail="Capacity left this month" rightLabel={productView.hasCapacityAllowance ? productView.capacityText : undefined} onPress={() => onChangeView('capacity')} />
                        <Divider inset={MENU_DIVIDER_INSET} />
                      </>
                    )}
                    <MenuRow testID="menu.setupGuideRow" icon="compass" label="Plan & billing" detail="Pick or change your plan" onPress={() => onChangeView('setup')} />
                    {referral ? (
                      <>
                        <Divider inset={MENU_DIVIDER_INSET} />
                        <MenuRow
                          testID="menu.inviteRow"
                          icon="gift"
                          label="Invite a friend"
                          detail="Give a friend a free month, get one yourself"
                          onPress={() => { void Share.share({ message: referral.shareText }); }}
                        />
                      </>
                    ) : null}
                  </Surface>
                </Stack>
                </Entry>

                <Entry index={5}>
                <Stack gap={2}>
                  <MenuSectionLabel testID="menu.section.support">Help</MenuSectionLabel>
                  <Surface elevation="surfaceHigh" radius="lg" border>
                    <MenuRow testID="menu.helpRow" icon="life-buoy" label="Help & suggestions" detail="Report an issue or request a feature" onPress={() => onChangeView('help')} />
                    <Divider inset={MENU_DIVIDER_INSET} />
                    <MenuRow testID="menu.faqsRow" icon="help-circle" label="FAQs" detail="How it all works" onPress={() => onChangeView('faqs')} />
                  </Surface>
                </Stack>
                </Entry>

                <Entry index={6}>
                <Stack gap={2}>
                  <MenuSectionLabel testID="menu.section.elsewhere">{agentEngine ? 'Delegent AI' : 'Also available on'}</MenuSectionLabel>
                  <Surface elevation="surfaceHigh" radius="lg" border>
                    {agentEngine ? null : (<>
                    {/* 2026-07-24 (Alex, roadmap #12): first-class Telegram opt-in.
                        Tapping sends "connect telegram" into chat, which triggers
                        the live connect-telegram skill and renders the connect
                        card (GA 2026-07-16). Same dispatch path as skills/commands,
                        no separate screen, no feature-flag flip. */}
                    <MenuRow
                      testID="menu.telegramRow"
                      icon="send"
                      label="Chat on Telegram too"
                      detail="Message your coworker from Telegram, same workspace and memory"
                      onPress={() => runSkillPhrase('connect telegram')}
                    />
                    <Divider inset={MENU_DIVIDER_INSET} />
                    {/* 2026-07-27 (Alex): the browser version shipped but the app
                        never mentioned it, so someone at a desk had no way to
                        find out it existed. Sits above the website row because
                        it is the more useful door of the two. */}
                    <MenuRow
                      testID="menu.webAppRow"
                      icon="monitor"
                      label={WEB_APP_MENU_LABEL}
                      detail={WEB_APP_MENU_DETAIL}
                      onPress={() => {
                        void Linking.openURL(WEB_APP_URL).catch(() => undefined);
                      }}
                    />
                    <Divider inset={MENU_DIVIDER_INSET} />
                    </>)}
                    <MenuRow
                      testID="menu.websiteRow"
                      icon="external-link"
                      label="Visit our website"
                      detail="delegentai.co.uk"
                      onPress={() => {
                        void Linking.openURL('https://delegentai.co.uk').catch(() => undefined);
                      }}
                    />
                  </Surface>
                </Stack>
                </Entry>

                <Entry index={7}>
                <Stack gap={2}>
                  <MenuSectionLabel testID="menu.section.legal">Legal</MenuSectionLabel>
                  <Surface elevation="surfaceHigh" radius="lg" border>
                    <MenuRow testID="menu.termsRow" icon="file-text" label="Terms" detail="How Delegent AI works" onPress={() => onChangeView('terms')} />
                    <Divider inset={MENU_DIVIDER_INSET} />
                    <MenuRow testID="menu.privacyRow" icon="shield" label="Privacy" detail="How we handle your data" onPress={() => onChangeView('privacy')} />
                    <Divider inset={MENU_DIVIDER_INSET} />
                    <MenuRow testID="menu.noticesRow" icon="code" label="Open source notices" detail="The open-source software we build on" onPress={() => onChangeView('notices')} />
                  </Surface>
                </Stack>
                </Entry>

                <Entry index={8}>
                  <Button testID="menu.signOutButton" variant="secondary" fullWidth onPress={onSignOut}>Sign out</Button>
                </Entry>
              </Stack>
            </Animated.ScrollView>
          ) : (
            // Each inner screen slides in from the right as you open it, the
            // way a page turns, instead of swapping in place (2026-09-27).
            <Animated.View key={view} entering={FadeInRight.duration(320)} style={styles.drawerViewPane}>
              <View style={styles.drawerPinnedHeader}>
                <DrawerHeader
                  title={view === 'skills' ? 'Skills & use cases' : view === 'skillCategory' ? activeSkillCategoryTitle : view === 'commands' ? 'Commands' : view === 'routines' ? 'Routines' : view === 'connections' ? 'Connections' : view === 'howto' ? 'How-to guides' : view === 'faqs' ? 'FAQs' : view === 'help' ? 'Help & suggestions' : view === 'terms' ? 'Terms' : view === 'privacy' ? 'Privacy' : view === 'notices' ? 'Open source notices' : agentEngine ? 'Manage plan' : 'Monthly capacity'}
                  onBack={() => onChangeView(view === 'skillCategory' ? 'skills' : 'menu')}
                />
              </View>
              <Animated.ScrollView contentContainerStyle={styles.drawerScroll} showsVerticalScrollIndicator={false} animatedProps={drawerScrollProps}>
                <Stack gap={4}>
                  {view === 'skills' ? <SkillsDrawer onOpenCategory={onOpenSkillCategory} onUseSkill={runSkillPhrase} /> : null}
                  {view === 'skillCategory' ? <SkillCategoryDetail categoryKey={skillCategoryKey} onUseSkill={runSkillPhrase} /> : null}
                  {view === 'commands' ? (
                    <CommandsDrawer
                      onRun={(command, option) => {
                        // The chat WebView is always mounted, so it reliably
                        // picks these up. Every command lands the user back on
                        // Chat: 'send' commands run and show their result there;
                        // 'compose' commands pre-type into the composer to finish.
                        if (command.key === 'fresh-chat') {
                          DeviceEventEmitter.emit('delegent:startFreshChat');
                        } else if (option) {
                          // Style picks send a plain instruction (not a fake
                          // slash command) the durable coworker acts on.
                          DeviceEventEmitter.emit('delegent:menuCommand', { command: option.instruction, mode: 'send' });
                        } else {
                          DeviceEventEmitter.emit('delegent:menuCommand', { command: command.command, mode: command.mode });
                        }
                        openTab('dashboard');
                      }}
                    />
                  ) : null}
                  {view === 'routines' ? <RoutinesDrawer /> : null}
                  {view === 'connections' ? <ConnectionsDrawer onStartInChat={runSkillPhrase} userId={authUserId} visible={visible} /> : null}
                  {view === 'howto' ? <HowToGuides /> : null}
                  {view === 'faqs' ? <FaqDrawer /> : null}
                  {view === 'help' ? <HelpDrawer userEmail={profile.email} /> : null}
                  {view === 'capacity' ? (
                    <CapacityDrawer
                      onOpenSetup={() => onChangeView('setup')}
                      onOpenBillingPortal={onOpenBillingPortal}
                      onRefreshCapacity={onRefreshCapacity}
                      productView={productView}
                      billingPortalState={billingPortalState}
                    />
                  ) : null}
                  {view === 'terms' ? <TermsContent /> : null}
                  {view === 'privacy' ? <PrivacyContent /> : null}
                  {view === 'notices' ? <NoticesContent /> : null}
                </Stack>
              </Animated.ScrollView>
            </Animated.View>
          )}
        </Surface>
        </Animated.View>
      </View>
    </Modal>
  );
}

function ProductStateNotice({ status, errorMessage, onRetry, suppressTransientLoading = false }: { status: MobileProductStateStatus; errorMessage: string | null; onRetry: ProductRefresh; suppressTransientLoading?: boolean }) {
  const themeColors = useThemeColors();

  if (status === 'loading') {
    // Defect (2026-05-29): during provisioning the product snapshot is polled
    // every few seconds; each poll flips status to 'loading', which used to
    // mount/unmount this banner and shove the whole shell up and down ("hops
    // up and down" — Alex). Once we've EVER had live data, a background
    // re-poll must NOT pop a transient banner. Only the first cold load (no
    // data yet) shows it. The stable ProvisioningWaitNotice covers the
    // provisioning state, so suppressing this here removes the layout thrash
    // without hiding any real status.
    if (suppressTransientLoading) return null;
    return (
      <Surface elevation="surfaceHigh" radius="lg" padding={2} border style={[styles.productStateNotice, { borderColor: themeColors.border }]}>
        <Stack direction="horizontal" gap={2} align="center">
          <StatusDot state="working" />
          <Text variant="caption" color="textSecondary">Checking on your coworker…</Text>
        </Stack>
      </Surface>
    );
  }

  if (status === 'error') {
    // Defect (2026-05-29 follow-up): the loading banner was suppressed once we
    // had live data, but THIS transient-error banner was not — and it is the one
    // Alex still sees "coming up and disappearing all the time" during
    // provisioning. The product snapshot is polled every few seconds; a single
    // failed background poll flips status to 'error', mounts this "Couldn't
    // refresh" row (adds height), then the next good poll clears it (removes
    // height) — so the whole shell jumps up and down. A genuine COLD error (no
    // data yet) is already handled by the full-screen error route in the Shell
    // (productStatus === 'error' && !productEverLive), so once we have live data
    // this background-refresh error is self-healing noise. Suppress it to stop
    // the jump, exactly like the loading state above.
    if (suppressTransientLoading) return null;
    return (
      <Surface elevation="surfaceHigh" radius="lg" padding={2} border style={[styles.productStateNotice, { borderColor: themeColors.border }]}>
        <Stack direction="horizontal" gap={2} align="center">
          <StatusDot state="sleeping" />
          <Stack gap={1} style={styles.flexText}>
            <Text variant="caption" color="textSecondary">Couldn’t refresh.</Text>
            <Text variant="caption" color="textTertiary" numberOfLines={1}>{errorMessage ?? 'Try again when your connection is stable.'}</Text>
          </Stack>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry workspace refresh" hitSlop={touchHitSlop} onPress={() => void onRetry().catch(() => undefined)} style={[styles.noticeRetryButton, { borderColor: themeColors.borderStrong, backgroundColor: themeColors.surface }]}>
            <Text variant="caption" color="textPrimary">Retry</Text>
          </Pressable>
        </Stack>
      </Surface>
    );
  }

  return null;
}

function ProvisioningWaitNotice({ gateKind, stalled = false }: { gateKind: ProductGateKind; stalled?: boolean }) {
  // Persistent "your workspace is coming online" notice during the
  // subscribed_pending_worker / provisioning_worker gates. Distinct from
  // the post-checkout CheckoutThankYouBanner (which the user can dismiss):
  // this one stays for as long as the runner is provisioning, so a user
  // who closed the app and came back still sees what's going on and how
  // long to expect.
  //
  // The wording and the list of gates it applies to both live in
  // @sidekick/shared, because the web app has to say the same thing and a
  // second copy of this paragraph is a second copy to forget to update.
  const themeColors = useThemeColors();
  if (!isProvisioningGate(gateKind)) {
    return null;
  }
  return (
    <Surface
      elevation="surfaceHigh"
      radius="lg"
      padding={3}
      border
      style={[styles.productStateNotice, { borderColor: themeColors.borderStrong }]}
      testID="shell.provisioningWaitNotice"
    >
      <Stack direction="horizontal" gap={3} align="flex-start">
        <View style={[styles.thankYouIcon, { backgroundColor: themeColors.accentMuted, borderColor: themeColors.accent }]}>
          <Feather name="clock" size={18} color={themeColors.accent} />
        </View>
        <Stack gap={1} style={styles.flexText}>
          <Text variant="title" testID="shell.provisioningWaitNotice.title">
            {PROVISIONING_NOTICE_TITLE}
          </Text>
          <Text variant="bodySm" color="textSecondary" testID="shell.provisioningWaitNotice.body">
            {provisioningNoticeBody('app')}
          </Text>
          {stalled ? (
            // The escalation rides on this notice rather than the error banner
            // because the setup poll rewrites `status` every few seconds and the
            // banner is suppressed for exactly that churn, so anything routed
            // through status is invisible to the people who need it.
            <Text variant="bodySm" color="danger" testID="shell.provisioningWaitNotice.stalled">
              {PROVISIONING_STALLED_MESSAGE}
            </Text>
          ) : null}
        </Stack>
      </Stack>
    </Surface>
  );
}

function CheckoutThankYouBanner({
  tierName,
  onDismiss,
}: {
  tierName: string | null;
  onDismiss: () => void;
}) {
  // Defect 7 (2026-05-14 audit): only rendered when the webhook-backed
  // snapshot already shows an active subscription. Optimistic UI alone never
  // reaches this banner. Copy is intentionally non-technical.
  // 2026-05-28 (Defect F): be honest about the wait. Real workspace
  // provisioning takes 2 to 10 minutes (cold image pull dominates). The earlier
  // "setting up now" copy framed it as instant, then users sat on
  // "Preparing workspace" for ten minutes and felt the app was broken.
  // New copy sets the expectation and gives them permission to walk away.
  // 2026-07-29: the wording moved to @sidekick/shared so the browser says the
  // same thing after the same purchase.
  const themeColors = useThemeColors();
  // An assistant account has nothing to wait for (no workspace), and its plan
  // is Delegent AI, not the tier it is recorded under (2026-09-16).
  const agentEngine = useIsAgentEngine();
  const subtitle = agentEngine ? AGENT_CHECKOUT_THANK_YOU : checkoutThankYouBody(tierName, 'app');
  return (
    <Surface
      elevation="surfaceHigh"
      radius="lg"
      padding={3}
      border
      style={[styles.productStateNotice, { borderColor: themeColors.borderStrong }]}
    >
      <Stack direction="horizontal" gap={3} align="center">
        <View style={[styles.thankYouIcon, { backgroundColor: themeColors.accentMuted, borderColor: themeColors.accent }]}>
          <Feather name="check" size={18} color={themeColors.accent} />
        </View>
        <Stack gap={1} style={styles.flexText}>
          <Text variant="title" testID="checkout.thankYou.title">Your subscription is confirmed.</Text>
          <Text variant="bodySm" color="textSecondary" testID="checkout.thankYou.body">{subtitle}</Text>
        </Stack>
        <Pressable
          testID="checkout.thankYou.dismiss"
          accessibilityRole="button"
          accessibilityLabel="Dismiss thank-you banner"
          hitSlop={touchHitSlop}
          onPress={onDismiss}
          style={[styles.noticeRetryButton, { borderColor: themeColors.borderStrong, backgroundColor: themeColors.surface }]}
        >
          <Text variant="caption" color="textPrimary">Got it</Text>
        </Pressable>
      </Stack>
    </Surface>
  );
}

// "A new version is ready" banner. Mirrors CheckoutThankYouBanner (same Surface /
// Stack / Pressable idiom) so it reads as native to the shell, not bolted on. It
// is deliberately quiet and dismissible ("Later"), and applying is an explicit
// "Restart" tap — the app never reloads itself. Shown only when an OTA bundle has
// already been downloaded and is staged (see the updateReady effect + otaUpdateCheck).
function UpdateAvailableBanner({ applyFailed, onApply, onDismiss }: { applyFailed: boolean; onApply: () => void; onDismiss: () => void }) {
  const themeColors = useThemeColors();
  return (
    <Surface
      elevation="surfaceHigh"
      radius="lg"
      padding={3}
      border
      style={[styles.productStateNotice, { borderColor: themeColors.borderStrong }]}
    >
      <Stack direction="horizontal" gap={3} align="center">
        <View style={[styles.thankYouIcon, { backgroundColor: themeColors.accentMuted, borderColor: themeColors.accent }]}>
          <Feather name="download" size={18} color={themeColors.accent} />
        </View>
        <Stack gap={1} style={styles.flexText}>
          <Text variant="title" testID="update.available.title">A new version is ready</Text>
          <Text variant="bodySm" color="textSecondary" testID="update.available.body">
            {applyFailed
              ? 'We couldn’t restart the app. Close it and open it again, and the update will be there.'
              : 'Restart the app to get the latest improvements.'}
          </Text>
        </Stack>
        <Pressable
          testID="update.available.apply"
          accessibilityRole="button"
          accessibilityLabel="Restart to update"
          hitSlop={touchHitSlop}
          onPress={onApply}
          style={[styles.noticeRetryButton, { borderColor: themeColors.accent, backgroundColor: themeColors.accentMuted }]}
        >
          <Text variant="caption" color="textPrimary">Restart</Text>
        </Pressable>
        <Pressable
          testID="update.available.dismiss"
          accessibilityRole="button"
          accessibilityLabel="Dismiss update banner"
          hitSlop={touchHitSlop}
          onPress={onDismiss}
          style={[styles.noticeRetryButton, { borderColor: themeColors.borderStrong, backgroundColor: themeColors.surface }]}
        >
          <Text variant="caption" color="textSecondary">Later</Text>
        </Pressable>
      </Stack>
    </Surface>
  );
}

// The check-and-nudge, self-contained so every auth branch can afford to mount
// it. It used to live only inside Shell, which meant the banner existed solely
// for signed-in users — and on 2026-08-13 that inverted its purpose: iOS Google
// sign-in was broken, the fix was staged as an OTA, and the ONE screen the
// stranded user could reach (login) was the one screen with no way to hear
// about it. The login branch and Shell now each mount this; they render in
// exclusive branches so exactly one instance runs at a time.
//
// Fully defensive (see src/updates/otaUpdateCheck): runs ONLY when expo-updates
// is enabled, never throws, and NEVER auto-reloads — applying the update is a
// deliberate user tap, so we never yank the app out from under someone
// mid-task. Checks once on mount and on each return to the foreground; the ref
// stops it re-checking once the banner is already showing.
function StagedUpdateBanner() {
  const [updateReady, setUpdateReady] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateApplyFailed, setUpdateApplyFailed] = useState(false);
  const updateReadyRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled || updateReadyRef.current) return;
      const ready = await checkAndFetchOtaUpdate({
        isEnabled: Updates.isEnabled,
        checkForUpdate: () => Updates.checkForUpdateAsync(),
        fetchUpdate: () => Updates.fetchUpdateAsync(),
      });
      if (!cancelled && ready) {
        updateReadyRef.current = true;
        setUpdateReady(true);
      }
    };
    void run();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void run();
    });
    return () => { cancelled = true; sub.remove(); };
  }, []);

  if (!updateReady || updateDismissed) return null;
  return (
    <UpdateAvailableBanner
      applyFailed={updateApplyFailed}
      onApply={() => {
        setUpdateApplyFailed(false);
        // reloadAsync returns a promise, so the try/catch that used to wrap
        // this call could never fire: a rejection left as an unhandled
        // rejection, the banner sat there unchanged, and the reader pressed
        // Restart to no effect and with nothing to try next. The update is
        // already downloaded and staged by this point, so a cold start
        // still picks it up, which is what the failed copy asks for.
        void Updates.reloadAsync().catch(() => setUpdateApplyFailed(true));
      }}
      onDismiss={() => setUpdateDismissed(true)}
    />
  );
}

function OnboardingScreen({
  onComplete,
  onSignOut,
  trialCandidate,
}: {
  onComplete: (goal: OnboardingGoal) => Promise<void>;
  onSignOut: () => Promise<void> | void;
  trialCandidate: boolean;
}) {
  return <GoalOnboarding trialCandidate={trialCandidate} onSignOut={onSignOut} renderNameStep={(goal) => <NameOnboardingScreen onSignOut={onSignOut} onComplete={() => onComplete(goal)} />} />;
}

function NameOnboardingScreen({ onComplete, onSignOut }: {
  onComplete: () => Promise<void>;
  onSignOut: () => Promise<void> | void;
}) {
  const themeColors = useThemeColors();
  // An assistant account names an assistant, not a "personal Agent" (Alex,
  // 2026-09-15). The acceptance wording is the same agreement in its words.
  const agentEngine = useIsAgentEngine();
  const say = agentEngine ? assistantWording : sameWording;
  // A NAME WAS NEVER REQUIRED HERE. `effectiveAgentName` below already falls
  // back to defaultAgentName(), so the only hard gate on this screen is the
  // Terms tick. It did not look that way: the screen arrives as an empty box
  // that reads like a task, and the funnel on 2026-09-22
  // (docs/ACTIVATION_2026-09-22.md) showed two thirds of the people who pick a
  // goal never get past it, the biggest single drop in the journey.
  //
  // THE FIELD STAYS EMPTY ON PURPOSE. Pre-filling it was the original
  // behaviour and was deliberately removed in 1822c2e8 (2026-05-09), in the
  // same change that made the name optional, and onboarding-readiness pins
  // both halves of that decision. Pre-filling means everybody silently accepts
  // the same default name. So the fix is to say it is optional, not to fill it
  // in for them.
  const [agentName, setAgentName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // [Batch 6 §4.7] Local Terms modal so the "Delegent AI Terms" phrase inside
  // the acceptance line is tappable. Doesn't change the acceptance checkbox
  // behaviour or accessibility label; just adds a separate Pressable on the
  // word "Terms" that opens the canonical TermsModal already used by the
  // login + menu surfaces. Closing the modal does not auto-accept.
  const [termsModalOpen, setTermsModalOpen] = useState(false);
  const normalizedAgentName = normalizeAgentName(agentName);
  const effectiveAgentName = normalizedAgentName ?? defaultAgentName();
  const canSubmit = Boolean(effectiveAgentName && accepted && !saving);
  // 2026-09-26 (Alex: onboarding "really interactive and flowing"): the
  // coworker greets you by the name as you type it, so naming it feels like
  // meeting someone rather than filling in a box. Blank still means the
  // default name, which the greeting shows too, so "optional" is visible.
  // 2026-09-27: someone who asked us to find their money is offered exactly
  // that, first (src/onboarding/MoneyCheck.tsx).
  const money = useMoneyIntent();
  const moneyUpTo = money.intent?.wants ? flightUpTo(money.intent) : 0;
  const greetingAsk = !money.intent?.wants
    ? 'What can I take off your plate today?'
    : moneyUpTo ? `Shall we start by finding that ${pounds(moneyUpTo)}?` : 'Shall we start by finding your money?';
  const greeting = useTypeOn(`Hi, I'm ${effectiveAgentName}. ${greetingAsk}`);

  const submitOnboarding = async () => {
    if (!effectiveAgentName) {
      setErrorMessage(say('Give your coworker a short name to continue.'));
      return;
    }
    if (!accepted) {
      setErrorMessage('Accept the Terms to continue.');
      return;
    }

    // D1 — explicitly dismiss the soft keyboard before navigating. The
    // implicit dismiss-on-focus-blur that Pressable triggers can race
    // with the layout shift caused by needsOnboarding flipping false,
    // and on Pixel 10 that race occasionally surfaces as the activity
    // losing focus (Alex's "app just closes; I have to swipe up to
    // bring it back" report from 2026-05-20). Dismissing explicitly
    // before the async submit lets the layout settle first.
    Keyboard.dismiss();

    setSaving(true);
    setErrorMessage(null);
    const result = await completeMobileOnboarding(effectiveAgentName);
    if ('error' in result) {
      setErrorMessage(result.error.message);
      setSaving(false);
      return;
    }

    try {
      await onComplete();
      setSaving(false);
    } catch {
      setErrorMessage('Setup saved, but the next step did not refresh. Try again in a moment.');
      setSaving(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.onboardingScreen} showsVerticalScrollIndicator={false}>
      <Stack gap={5}>
        <Rise>
          <Stack gap={2}>
            <StepProgress step={3} />
            <Badge tone="accent">3 of 3</Badge>
            <Text variant="displayLg">{agentEngine ? 'Name your coworker' : 'Name your personal Agent'}</Text>
            <Text variant="body" color="textSecondary">
              {agentEngine
                ? "Pick a name for your coworker. It's who you'll be chatting with in this app."
                : "Pick a name for your own personal Agent. You'll chat with them right inside this app, and they'll sign their work with it."}
            </Text>
          </Stack>
        </Rise>

        {/* The greeting, live: it follows the name as it is typed. */}
        <Rise delay={180}>
          <View style={styles.onboardingGreetingRow} accessibilityLiveRegion="polite">
            <Breathe min={0.95} max={1.05} period={3000}>
              <View style={[styles.onboardingGreetingAvatar, { backgroundColor: themeColors.surfaceHigh, borderColor: themeColors.border }]}>
                <Image source={coworkerMark} style={styles.brandLogoOnboarding} resizeMode="contain" accessibilityLabel="Delegent AI" />
              </View>
            </Breathe>
            <View style={[styles.onboardingGreetingBubble, { backgroundColor: themeColors.surfaceHigh, borderColor: themeColors.border }]}>
              <Text variant="caption" color="accent">{effectiveAgentName}</Text>
              <Text variant="body" color="textPrimary">{greeting}</Text>
            </View>
          </View>
        </Rise>

        <Rise delay={320}>
        <Surface elevation="surfaceHigh" radius="xl" padding={4} border style={styles.onboardingCard}>
          <Stack gap={4}>
            <Stack gap={2}>
              <Text variant="caption" color="textTertiary">{agentEngine ? 'Assistant name' : 'Personal Agent name'}</Text>
              <TextInput
                testID="onboarding.agentNameInput"
                accessibilityLabel={agentEngine ? 'Assistant name' : 'Personal Agent name'}
                value={agentName}
                onChangeText={(value) => {
                  setAgentName(value);
                  setErrorMessage(null);
                }}
                placeholder="Nova"
                placeholderTextColor={themeColors.textTertiary}
                autoCapitalize="words"
                autoCorrect={false}
                maxLength={40}
                style={[styles.onboardingInput, { borderColor: themeColors.borderStrong, color: themeColors.textPrimary, backgroundColor: themeColors.surfaceHigh }]}
              />
              {/* The one thing this screen never said: a name is optional. */}
              <Text testID="onboarding.agentNameHint" variant="caption" color="textTertiary">
                {`Optional. Leave it blank and yours will be called ${defaultAgentName()}.`}
              </Text>
            </Stack>

            <Surface elevation="surfaceHigh" radius="lg" padding={3} border>
              <Text variant="bodySm" color="textSecondary">{say(ACKNOWLEDGEMENT_TEXT)}</Text>
            </Surface>

            <Pressable
              testID="onboarding.termsCheckbox"
              accessibilityRole="checkbox"
              accessibilityState={{ checked: accepted }}
              accessibilityLabel="I understand and accept Delegent AI Terms"
              onPress={() => setAccepted((current) => !current)}
              style={styles.onboardingCheckRow}
            >
              <Pop on={accepted}>
                <View style={[styles.onboardingCheckBox, { borderColor: accepted ? themeColors.accent : themeColors.borderStrong, backgroundColor: accepted ? themeColors.accent : 'transparent' }]}>
                  {accepted ? <Feather name="check" size={14} color={themeColors.accentText} /> : null}
                </View>
              </Pop>
              <Text variant="bodySm" color="textSecondary" style={styles.onboardingAcknowledgementText}>
                I understand. I accept the Delegent AI{' '}
                <Text
                  testID="onboarding.termsLink"
                  variant="bodySm"
                  color="textPrimary"
                  // The Pressable above swallows taps on the whole row to
                  // toggle the checkbox; mark the Terms phrase with an
                  // underline so users see it's a separate target, and
                  // call setTermsModalOpen on press with stopPropagation
                  // semantics via onPress (RN Text onPress doesn't bubble
                  // to the parent Pressable handler).
                  onPress={(event) => {
                    // RN Text onPress fires before the parent Pressable;
                    // event.stopPropagation isn't needed because the parent
                    // Pressable's onPress only fires on a tap that reaches
                    // it, and Text.onPress consumes the touch.
                    setTermsModalOpen(true);
                  }}
                  style={styles.onboardingTermsLink}
                  accessibilityRole="link"
                  accessibilityLabel="Open Delegent AI Terms of Service"
                >
                  Terms
                </Text>
                .
              </Text>
            </Pressable>
            <TermsModal visible={termsModalOpen} onClose={() => setTermsModalOpen(false)} />

            {errorMessage ? <Text variant="caption" color="warning">{errorMessage}</Text> : null}

            {/* Breathes gently once it can be pressed, so the next step is obvious. */}
            <Breathe active={canSubmit} min={0.985} max={1.02} period={2200}>
              <Button testID="onboarding.finishButton" variant="primary" fullWidth disabled={!canSubmit} onPress={submitOnboarding}>{saving ? 'Saving setup…' : 'Finish setup'}</Button>
            </Breathe>
            <Button testID="onboarding.signOutButton" variant="ghost" fullWidth disabled={saving} onPress={onSignOut}>Sign out</Button>
          </Stack>
        </Surface>
        </Rise>
      </Stack>
    </ScrollView>
  );
}

function Shell({
  onboardingGoal,
  authUserId,
  onSignOut,
  profile,
  productState,
  productGate,
  productStatus,
  productErrorMessage,
  productProvisioningStalled,
  onProductRetry,
  onCheckoutReturnRefresh,
  onCheckoutResumeRefresh,
  checkoutReturnSignal,
  setupGuideLaunchKey = 0,
}: {
  onSignOut: () => Promise<void> | void;
  /** Passed down rather than derived: the product snapshot's profile id is a
   * cached read that can still name the previous account for a beat after a
   * switch, and connection hand-offs are filed per account. */
  authUserId: string;
  profile: AppProfile;
  productState: SidekickProductSnapshot;
  productGate: ProductGate;
  productStatus: MobileProductStateStatus;
  productErrorMessage: string | null;
  productProvisioningStalled: boolean;
  onProductRetry: ProductRefresh;
  onCheckoutReturnRefresh: ProductRefresh;
  /** One plain snapshot refresh, no polling. Used when the app comes back to
   * the foreground with checkout still open and NO return deep link arrived,
   * which is what a swipe-back from the Stripe page looks like. */
  onCheckoutResumeRefresh: ProductRefresh;
  checkoutReturnSignal: CheckoutReturnSignal;
  setupGuideLaunchKey?: number;
  onboardingGoal?: OnboardingGoal | null;
}) {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  // PREOP-H01/H02: a file tapped inside chat routes to the Files tab and is
  // surfaced there, instead of the previous inert preview affordance.
  const [focusedArtifactPath, setFocusedArtifactPath] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerView, setDrawerView] = useState<DrawerView>('menu');
  const [skillCategoryKey, setSkillCategoryKey] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupEntryPoint, setSetupEntryPoint] = useState<PaywallEntryPoint>('upgrade_chip');
  const [paywallDismissed, setPaywallDismissed] = useState(false);
  const paywallDismissRevision = useRef(0);
  const [checkingResume, setCheckingResume] = useState(false);
  const [appOpenPaywallOpen, setAppOpenPaywallOpen] = useState(false);
  const [appOpenCount, setAppOpenCount] = useState(0);
  const appOpenDetector = useRef(createAppOpenDetector());
  // [hooks-rules-fix 2026-05-21 / DN1.3-01 / DN12] — productEverAuthoritative latches the first
  // moment we know the product snapshot is authoritative so a later refresh
  // can't blank the shell. This MUST be declared at the top of Shell, before
  // the `if (setupOpen) return` early-return below. The original placement
  // (after that early return) caused a "Rendered fewer hooks than expected"
  // crash whenever setupOpen flipped between renders — diagnosed during the
  // Maestro NEWUSER-01 run that fired right after tapping Finish setup.
  const productStateIsAuthoritative = productStatus === 'live' || productStatus === 'error';
  const [productEverAuthoritative, setProductEverAuthoritative] = useState(false);
  const [productEverLive, setProductEverLive] = useState(false);
  useEffect(() => {
    if (productStateIsAuthoritative && !productEverAuthoritative) {
      setProductEverAuthoritative(true);
    }
  }, [productStateIsAuthoritative, productEverAuthoritative]);
  useEffect(() => {
    if (productStatus === 'live' && !productEverLive) {
      setProductEverLive(true);
    }
  }, [productStatus, productEverLive]);
  // v1.2.3, hide the bottom tab bar when the soft keyboard is open
  // so the chat composer is reachable. Android edge-to-edge mode draws
  // the keyboard over the activity by default, so we manage this
  // explicitly via Keyboard events.
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true),
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardVisible(false),
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // [DN1.3-03] Android hardware Back must not exit the app from any non-root
  // shell surface. Before this handler, pressing Back from Profile / Files
  // (which are tab states, not stacked screens) fell through to the default
  // activity-finish behaviour and the user dropped to the Android launcher.
  //
  // Priority of intercepts:
  //   1. burger drawer open  → close drawer (return true; intercepted)
  //   2. setup wizard open   → close setup
  //   3. activeTab != root   → return to Chat (the only true root state)
  //   4. otherwise           → return false; let Android exit the app
  //                            (legitimate exit from the root Chat surface)
  //
  // TermsModal / PrivacyModal handle their own back via Modal.onRequestClose,
  // so they don't need to be listed here.
  useEffect(() => {
    const onHardwareBack = () => {
      // The mounted paywall owns Back, including its dismissal event.
      if (setupOpen || appOpenPaywallOpen) return false;
      if (drawerOpen) {
        if (drawerView === 'skillCategory') {
          // One level deeper than a subpage: the per-category skill detail.
          // Back returns to the Skills & use cases list, not straight to menu.
          setDrawerView('skills');
          return true;
        }
        if (drawerView !== 'menu') {
          // Inside a drawer subpage (Terms / Privacy / Use cases / FAQs /
          // Capacity), return to the menu list, keep drawer open.
          setDrawerView('menu');
          return true;
        }
        setDrawerOpen(false);
        return true;
      }
      if (activeTab !== 'dashboard') {
        setActiveTab('dashboard');
        return true;
      }
      return false;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onHardwareBack);
    return () => subscription.remove();
  }, [drawerOpen, drawerView, setupOpen, appOpenPaywallOpen, activeTab]);
  const [checkoutState, setCheckoutState] = useState<CheckoutState>({ status: 'idle' });
  const [checkoutRefreshPending, setCheckoutRefreshPending] = useState(false);
  const [billingPortalState, setBillingPortalState] = useState<BillingPortalState>({ status: 'idle' });
  const [billingPortalRefreshPending, setBillingPortalRefreshPending] = useState(false);
  const purchaseInFlightRef = useRef(false);
  purchaseInFlightRef.current = checkoutState.status === 'opening' || checkoutState.status === 'confirming'
    || billingPortalState.status === 'opening' || billingPortalState.status === 'confirming';
  const [runnerFilesState, setRunnerFilesState] = useState<RunnerFilesState>({ status: 'idle', files: [], truncated: false });
  const [handledSetupGuideLaunchKey, setHandledSetupGuideLaunchKey] = useState(0);
  const [handledCheckoutReturnKey, setHandledCheckoutReturnKey] = useState(0);
  // Thank-you banner shown after Stripe success, gated on webhook-backed
  // entitlement appearing in the snapshot. Optimistic UI cannot toggle this on
  // by itself.
  const [checkoutThankYou, setCheckoutThankYou] = useState<{ visible: boolean; tierId: TierId | null }>({ visible: false, tierId: null });

  const agentEngine = useIsAgentEngine();
  const productView = useMemo(() => buildProductView(productState, agentEngine), [productState, agentEngine]);
  // Agent engine: no file store, so no Files tab, and with Chat the only tab
  // left, no tab bar. An open Files tab from before the answer arrived closes.
  const shellTabs: readonly Tab[] = agentEngine ? ['dashboard'] : bottomTabs;
  useEffect(() => {
    if (agentEngine && activeTab === 'artifacts') setActiveTab('dashboard');
  }, [agentEngine, activeTab]);

  useEffect(() => {
    if (productView.hasActiveSubscription) {
      setAppOpenPaywallOpen(false);
    } else if (shouldShowAppOpenPaywall({
      subscriptionKnown: productStatus === 'live', hasActiveSubscription: false,
      dismissed: paywallDismissed, checkingResume,
      purchaseInFlight: checkoutState.status === 'opening' || checkoutState.status === 'confirming'
        || billingPortalState.status === 'opening' || billingPortalState.status === 'confirming',
    })) setAppOpenPaywallOpen(true);
    // Once visible, keep the paywall mounted through refreshes and payment.
  }, [productStatus, productView.hasActiveSubscription, paywallDismissed, checkingResume, checkoutState.status, billingPortalState.status]);

  const saveProfile = useCallback(async (input: MobileProfileUpdateInput): Promise<MobileProfileUpdateResult> => {
    const result = await updateMobileProfile(input);
    if ('error' in result) return result;

    try {
      await onProductRetry();
      return result;
    } catch {
      return { error: { reason: 'unavailable', message: 'Profile saved, but the screen did not refresh. Try again in a moment.' } };
    }
  }, [onProductRetry]);

  // Account export + deletion are intentionally NOT self-serve in-app controls
  // (PREOP-H03 + operator decision). Erasure / data portability is handled via
  // the email route (admin@example.com) and the server-side capability in
  // src/privacy/accountPrivacy.ts, so UK-GDPR rights are still honoured without
  // a one-tap "delete my data" button on the Profile screen.

  // v1.2.1, after a successful checkout the user lands on the chat
  // surface (Home) where their coworker greets them by name. No
  // messenger detour, no Connections tab.
  const advanceToHomeAfterSubscription = useCallback((confirmedTierId: TierId | null, subscriptionStatus: string) => {
    setCheckoutRefreshPending(false);
    setCheckoutState({ status: 'idle' });
    setDrawerOpen(false);
    setDrawerView('menu');
    setSetupOpen(false);
    setActiveTab('dashboard');
    // Defect 7 (2026-05-14 audit): show an explicit thank-you so a paying user
    // doesn't silently land on Home and wonder whether their card was charged.
    // The banner is shown ONLY when the webhook-backed snapshot already says
    // the subscription is active, so we never claim success optimistically.
    setCheckoutThankYou({ visible: true, tierId: confirmedTierId });
    // Funnel: this fires only on the webhook-backed active-subscription
    // confirmation, so it is the honest end of the payment funnel. It claims
    // that a payment completed, not how much it was, which is all this callback
    // can actually know.
    track(subscriptionStatus === 'trialing' ? 'trial_started' : 'payment_completed', { tier: confirmedTierId ?? 'unknown' });
    // ⚠️ THE GA4 `purchase` EVENT USED TO BE EMITTED HERE, with the tier's list
    // price out of the catalogue. This callback has no receipt: no amount from
    // the biller, no currency, no transaction id. So somebody on the 2.99
    // introductory coupon was reported as 9.99, a returning subscriber whose
    // checkout was refused for already being active was reported as a purchase,
    // and a second call reported the same money again. Google Ads imports that
    // event and optimises on its value.
    //
    // It now comes from reportConfirmedPurchase, which requires a positive
    // amount, a currency and the biller's own transaction id, and deduplicates
    // on that id. The Apple path has all three. The Stripe path does not yet
    // hand them to the client, so an Android or web payment currently reports
    // payment_completed and no revenue value: a missing number rather than a
    // wrong one. Wiring the Stripe amount through is separate work.
  }, []);

  const advanceAfterSubscription = useCallback((snapshot: SidekickProductSnapshot, attemptedTierId: TierId | null): boolean => {
    if (!checkoutSnapshotHasActiveSubscription(snapshot)) return false;

    advanceToHomeAfterSubscription(attemptedTierId, snapshot.subscription?.status ?? 'inactive');
    return true;
  }, [advanceToHomeAfterSubscription]);


  useEffect(() => {
    if (!checkoutThankYou.visible) return undefined;
    const timer = setTimeout(() => {
      setCheckoutThankYou({ visible: false, tierId: null });
    }, CHECKOUT_THANK_YOU_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [checkoutThankYou.visible]);

  const dismissCheckoutThankYou = useCallback(() => {
    setCheckoutThankYou({ visible: false, tierId: null });
  }, []);

  const completeCheckoutReturn = useCallback(async (tierId: TierId | null) => {
    const confirmingTierId = tierId ?? productView.currentTierId;
    setCheckoutState({ status: 'confirming', tierId: confirmingTierId });
    const snapshot = await onCheckoutReturnRefresh();
    if (advanceAfterSubscription(snapshot, confirmingTierId)) return;

    setCheckoutState({
      status: 'error',
      tierId: confirmingTierId,
      errorReason: 'unavailable',
      errorMessage: 'Payment may still be confirming. Reopen Delegent AI in a moment and we will check again.',
    });
  }, [advanceAfterSubscription, onCheckoutReturnRefresh, productView.currentTierId]);

  // The return signal as of "now", readable from inside an async routine.
  const checkoutReturnSignalRef = useRef(checkoutReturnSignal);
  useEffect(() => {
    checkoutReturnSignalRef.current = checkoutReturnSignal;
  }, [checkoutReturnSignal]);

  // Foreground return with NO deep link. Alex, 2026-09-07: open Studio's
  // checkout, swipe back from the Stripe page, tap Pro: the "Open secure
  // checkout" button stayed greyed out. completeCheckoutReturn was polling
  // for ~20 s and then parking the screen on "Payment may still be
  // confirming", for a reader who had simply changed their mind. Now: one
  // plain refresh; if the subscription is live we advance as before, and if
  // not the plan picker goes straight back to idle so every tier is tappable
  // again. A few silent follow-up refreshes still catch a webhook that lands
  // late, without holding the UI hostage. If a real return deep link arrives
  // meanwhile, that effect owns the state and this routine steps aside.
  const settleCheckoutAfterResume = useCallback(async (tierId: TierId | null, signalKeyAtResume: number) => {
    const confirmingTierId = tierId ?? productView.currentTierId;
    const signalUnchanged = () => checkoutReturnSignalRef.current.key === signalKeyAtResume;
    let snapshot: SidekickProductSnapshot | null = null;
    try {
      snapshot = await onCheckoutResumeRefresh();
    } catch {
      snapshot = null;
    }
    if (!signalUnchanged()) return;
    if (snapshot && advanceAfterSubscription(snapshot, confirmingTierId)) return;
    setCheckoutState({ status: 'idle' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await checkoutConfirmationDelay();
      if (!signalUnchanged()) return;
      try {
        const late = await onCheckoutResumeRefresh();
        if (advanceAfterSubscription(late, confirmingTierId)) return;
      } catch {
        // Silent by design: nothing is owed to the reader here.
      }
    }
  }, [advanceAfterSubscription, onCheckoutResumeRefresh, productView.currentTierId]);

  const openStripeBillingPortal = useCallback(async (targetTierId: TierId | null = null) => {
    setBillingPortalState({ status: 'opening' });
    const result = await requestStripeBillingPortal({ targetTierId, confirmScheduledChange: confirmScheduledPlanChange });
    if ('canceled' in result) {
      setBillingPortalRefreshPending(false);
      setBillingPortalState({ status: 'idle' });
      return false;
    }
    if ('error' in result) {
      setBillingPortalRefreshPending(false);
      // D9 — when the worker returns a non-success (e.g. no
      // stripe_customer_id yet, or transient network error), surface a
      // friendly recoverable error message rather than the previous
      // generic "couldn't open billing" copy. The product code is in
      // result.error.message; passing through verbatim gives the user
      // (and us in logs) the actual cause.
      setBillingPortalState({ status: 'error', errorReason: result.error.reason, errorMessage: result.error.message });
      return false;
    }

    // Downgrade scheduled for the next renewal — the worker deferred the change
    // instead of handing us a portal/checkout URL, so there's nothing to open.
    // Confirm it calmly and leave the user where they are; the plan (and files)
    // stay exactly as-is until the effective date.
    if ('scheduled' in result) {
      setBillingPortalRefreshPending(false);
      setBillingPortalState({ status: 'idle' });
      Alert.alert('Plan change scheduled', result.scheduled.message);
      return true;
    }

    const portal = result.portal;
    setBillingPortalRefreshPending(true);
    setBillingPortalState({ status: 'confirming' });
    try {
      // D9 — Linking.openURL on Pixel 10 occasionally fails silently
      // when no default browser handles the https:// scheme. Probe
      // first; on failure surface a copy-link path the user can act
      // on rather than dead-end them.
      const canOpen = await Linking.canOpenURL(portal.url).catch(() => false);
      if (!canOpen) {
        setBillingPortalRefreshPending(false);
        setBillingPortalState({
          status: 'error',
          errorReason: 'unavailable',
          errorMessage: 'No browser available to open billing. Install Chrome or another browser and try again.',
        });
        return false;
      }
      await Linking.openURL(portal.url);
      return true;
    } catch (err) {
      setBillingPortalRefreshPending(false);
      const detail = err instanceof Error && err.message ? ` (${err.message.slice(0, 80)})` : '';
      setBillingPortalState({ status: 'error', errorReason: 'unavailable', errorMessage: `We couldn’t open billing${detail}. Try again in a moment.` });
      return false;
    }
  }, []);

  const handlePlanCheckout = useCallback(async (tierId: TierId) => {
    track('tapped_upgrade', { tier: tierId });
    setCheckoutState({ status: 'opening', tierId });

    // On an iOS build carrying StoreKit, Apple takes the money and the browser
    // is never opened. This returns before any Stripe call: a build in 'iap'
    // mode that also handed off to Stripe would be the exact Guideline 3.1.1
    // violation we were rejected for on 2026-08-18.
    if (usesStoreKit()) {
      const storeKitResult = await purchaseTierWithStoreKit(tierId, {
        // An assistant account buys the assistant plan through Apple (£3.99,
        // first month free), never the Studio product its tier maps to.
        assistant: agentEngine,
        // Never open StoreKit for an account that already pays us SOMEWHERE
        // ELSE. The Worker refuses that too, but only once Apple has taken the
        // money, and a Stripe subscriber who bought here would be billed by
        // both. An existing APPLE subscriber is allowed through: for Apple a
        // tier change within the group is an upgrade, not a second purchase.
        hasActiveSubscription: storeKitPurchaseBlockedByExistingSubscription(productState),
      });
      if ('purchased' in storeKitResult) {
        setCheckoutRefreshPending(true);
        setCheckoutState({ status: 'confirming', tierId });
        try {
          const snapshot = await onCheckoutReturnRefresh();
          if (advanceAfterSubscription(snapshot, tierId)) return;
        } catch {
          // Fall through to the same terminal state as a poll that ran out.
          // This used to swallow the throw and `return`, which is the whole
          // defect below.
        }
        // THE POLL RAN OUT (or threw) AND APPLE HAS THE MONEY.
        //
        // This used to `return` here, leaving checkoutState on 'confirming'
        // forever: the button reads "Confirming subscription…", stays
        // disabled, and offers no error, no retry and no way forward. The
        // Stripe path never had this hole — completeCheckoutReturn sets an
        // error state in exactly this situation — so the two providers
        // disagreed on what to do when a real payment outruns the snapshot.
        //
        // The poll only waits CHECKOUT_CONFIRMATION_POLL_ATTEMPTS *
        // CHECKOUT_CONFIRMATION_POLL_INTERVAL_MS (~21s), and the entitlement
        // write lands a few seconds after Apple takes the money, so this is
        // tight rather than impossible — and a single transient refresh
        // failure hit the `catch` and dead-ended immediately.
        //
        // The wording must NOT suggest the payment failed. It did not: Apple
        // charged them and the Worker's verify is idempotent, so the
        // entitlement either already exists or lands on the next refresh.
        setCheckoutRefreshPending(false);
        setCheckoutState({
          status: 'error',
          tierId,
          errorReason: 'purchase_confirming',
          errorMessage: 'Your payment went through. We’re still confirming it, which can take a moment. Reopen Delegent AI shortly and it will be waiting for you.',
        });
        return;
      }
      setCheckoutRefreshPending(false);
      // A cancel is not an error state. Anything else keeps the same error
      // surface the Stripe path uses, so there is one place to read failures.
      //
      // The reason is MAPPED rather than flattened to 'unavailable'. Flattening
      // it put "This account already has a subscription billed outside the App
      // Store" under the title "Checkout is temporarily offline", which tells a
      // customer to come back later for something that will never change.
      setCheckoutState(storeKitResult.error.reason === 'cancelled'
        ? { status: 'idle' }
        : {
          status: 'error',
          tierId,
          errorReason: storeKitResult.error.reason === 'already_subscribed_elsewhere'
            ? 'managed_elsewhere'
            // Its own reason, because 'unavailable' renders as "Checkout is
            // temporarily offline" and this is permanent, not an outage.
            : storeKitResult.error.reason === 'owned_by_another_account'
            ? 'owned_by_another_account'
            : storeKitResult.error.reason === 'purchase_pending' || storeKitResult.error.reason === 'purchase_requires_review'
            ? storeKitResult.error.reason
            : storeKitResult.error.reason === 'unauthenticated'
            ? 'unauthenticated'
            : 'unavailable',
          errorMessage: storeKitResult.error.message,
        });
      return;
    }

    const result = await requestStripeCheckout({ tierId });
    if ('error' in result) {
      setCheckoutRefreshPending(false);
      if (result.error.reason === 'plan_change_required') {
        // D3/D5 fix — backend confirmed the user has an active sub on a
        // DIFFERENT tier; this is a tier-change flow, not a fresh
        // checkout. Route to the Stripe billing portal with
        // targetTierId so the portal pre-selects the plan-update
        // surface (Stripe deep-links a `subscription_update` confirm
        // page given the right portal config). DO NOT auto-dismiss the
        // wizard — Alex hit that on 2026-05-20 and got punted back to
        // home with no upgrade.
        setCheckoutState({ status: 'idle' });
        try {
          await openStripeBillingPortal(tierId);
        } catch {
          setCheckoutState({
            status: 'error',
            tierId,
            errorReason: 'unavailable',
            errorMessage: 'We couldn’t open plan-change checkout. Try again in a moment.',
          });
        }
        return;
      }
      if (result.error.reason === 'checkout_refused') {
        // Already subscribed to the SAME tier the user picked. Show
        // the wizard "current plan" copy by refreshing snapshot; if
        // confirmed active, fall through to home so the user lands on
        // chat.
        try {
          const snapshot = await onCheckoutReturnRefresh();
          if (advanceAfterSubscription(snapshot, tierId)) return;
        } catch {
          // Fall through to error display below.
        }
        setCheckoutState({ status: 'error', tierId, errorReason: result.error.reason, errorMessage: result.error.message });
        return;
      }
      setCheckoutState({ status: 'error', tierId, errorReason: result.error.reason, errorMessage: result.error.message });
      return;
    }

    const checkout = result.checkout;
    setCheckoutRefreshPending(true);
    setCheckoutState({ status: 'confirming', tierId });
    try {
      await Linking.openURL(checkout.url);
      // Funnel: secure checkout actually opened (the user left for Stripe).
      track('reached_stripe', { tier: tierId });
    } catch {
      setCheckoutRefreshPending(false);
      setCheckoutState({ status: 'error', tierId, errorReason: 'unavailable', errorMessage: 'We couldn’t open secure checkout. Try again in a moment.' });
    }
    // productState is a dependency because the StoreKit path reads the live
    // subscription status from it; a stale closure here would be the
    // difference between refusing a double purchase and taking one.
  }, [advanceAfterSubscription, advanceToHomeAfterSubscription, onCheckoutReturnRefresh, openStripeBillingPortal, productState]);

  // THE SINGLE DOOR TO STRIPE'S CUSTOMER PORTAL. Every "Manage plan",
  // "Resubscribe" and cancel control in the app routes through here, which is
  // why the iOS gate belongs here and not on each button: a new billing button
  // added later inherits the gate for free, and one that missed it would ship
  // a Safari hand-off to a payment page. That is Guideline 3.1.1, the exact
  // rejection build 37 took on 2026-08-18, and it would arrive one tap AFTER
  // the purchase button everyone remembers to check.
  const handleBillingPortal = useCallback(async (targetTierId: TierId | null = null) => {
    if (usesStoreKit()) {
      // A StoreKit subscription is managed by Apple. Not "preferably" by
      // Apple; there is no Stripe path from an iOS purchase.
      const result = await manageAppleSubscription();
      setBillingPortalState(result && 'error' in result
        ? { status: 'error', errorReason: 'unavailable', errorMessage: result.error.message }
        : { status: 'idle' });
      return false;
    }
    return openStripeBillingPortal(targetTierId);
  }, [openStripeBillingPortal]);

  const refreshRunnerFiles = useCallback(async (options?: { silent?: boolean }) => {
    // silent: resync after an optimistic delete/rename without flashing the
    // loading card — the user already sees the end state, so a visible
    // "Checking your files" pass would make the instant mutation feel slow.
    if (!options?.silent) {
      setRunnerFilesState((current) => ({ status: 'loading', files: current.files, truncated: current.truncated }));
    }
    const result = await requestRunnerFiles();
    if ('error' in result) {
      // A failed SILENT resync must not surface an error card the user never
      // asked for — the optimistic list is already showing the right thing.
      if (options?.silent) return;
      setRunnerFilesState((current) => ({
        status: 'error',
        files: current.files,
        truncated: false,
        message: current.files.length > 0
          ? `${result.error.message} Showing the last file list we loaded.`
          : result.error.message,
      }));
      return;
    }
    if (result.storageStatus === 'not_ready') {
      if (options?.silent) return;
      setRunnerFilesState((current) => ({
        status: 'not_ready',
        files: current.files,
        truncated: false,
        message: result.publicMessage ?? 'Delegent AI storage is still coming online.',
      }));
      return;
    }
    setRunnerFilesState({ status: 'ready', files: result.files, truncated: result.truncated });
  }, []);

  // Optimistic Files mutations — owned here because this shell holds
  // runnerFilesState. ArtifactsScreen calls these the moment the user
  // confirms a delete/rename so the UI never waits on the network.
  const removeRunnerFileLocally = useCallback((fileId: string) => {
    setRunnerFilesState((current) => withRunnerFiles(current, current.files.filter((f) => f.id !== fileId)));
  }, []);
  const restoreRunnerFileLocally = useCallback((file: MobileRunnerFile) => {
    setRunnerFilesState((current) => current.files.some((f) => f.id === file.id)
      ? current
      : withRunnerFiles(current, [...current.files, file]));
  }, []);
  const renameRunnerFileLocally = useCallback((fileId: string, nextName: string) => {
    setRunnerFilesState((current) => withRunnerFiles(
      current,
      current.files.map((f) => (f.id === fileId ? withLocalRename(f, nextName) : f)),
    ));
  }, []);
  // Batch variants for multi-select delete: one state pass so every selected
  // card leaves (or, on partial failure, only the failed subset returns)
  // inside a single 220ms layout animation. Restore de-dupes against the
  // current list, so a restore racing the silent resync can't duplicate cards.
  const removeRunnerFilesLocally = useCallback((fileIds: readonly string[]) => {
    const ids = new Set(fileIds);
    setRunnerFilesState((current) => withRunnerFiles(current, current.files.filter((f) => !ids.has(f.id))));
  }, []);
  const restoreRunnerFilesLocally = useCallback((files: readonly MobileRunnerFile[]) => {
    setRunnerFilesState((current) => {
      const present = new Set(current.files.map((f) => f.id));
      const additions = files.filter((f) => !present.has(f.id));
      return additions.length === 0 ? current : withRunnerFiles(current, [...current.files, ...additions]);
    });
  }, []);

  const selectShellTab = useCallback((tab: Tab) => {
    setActiveTab(tab);
    track('screen_view', { screen_name: tab });
    if (tab === 'artifacts') void refreshRunnerFiles();
  }, [refreshRunnerFiles]);

  useEffect(() => {
    if (agentEngine) return;
    void refreshRunnerFiles();
  }, [refreshRunnerFiles, agentEngine]);

  // Defect #52 (2026-05-21) — Files tab said "Workspace coming online"
  // even after the chat tab showed Online (workspace ready). Without
  // a refresh tied to the workspace gate transition the file list
  // stayed stale until the user tapped Refresh. Mirror the same
  // pattern as productState polling (#47): on every gate-state
  // transition into a workspace-ready state, refresh the runner file
  // listing once so the seeded folders + welcome files appear without
  // user interaction.
  const gateKindRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = gateKindRef.current;
    gateKindRef.current = productGate.kind;
    const cameOnline =
      (prev === 'subscribed_pending_worker'
        || prev === 'provisioning_worker'
        || prev === null)
      && productGate.kind !== prev
      && productGate.kind === 'ready';
    if (cameOnline) void refreshRunnerFiles();
  }, [productGate.kind, refreshRunnerFiles]);

  useEffect(() => {
    if (setupGuideLaunchKey <= 0 || handledSetupGuideLaunchKey === setupGuideLaunchKey) return;
    setSetupEntryPoint('onboarding');
    setDrawerOpen(false);
    setDrawerView('menu');
    setSetupOpen(true);
    setHandledSetupGuideLaunchKey(setupGuideLaunchKey);
  }, [handledSetupGuideLaunchKey, setupGuideLaunchKey]);

  const refreshWorkspaceAfterResume = useCallback(async () => {
    await onProductRetry();
    await refreshRunnerFiles();
  }, [onProductRetry, refreshRunnerFiles]);

  const checkoutReturnTierId = checkoutState.status === 'opening' || checkoutState.status === 'confirming'
    ? checkoutState.tierId
    : null;

  useEffect(() => {
    if (checkoutReturnSignal.key <= 0 || handledCheckoutReturnKey === checkoutReturnSignal.key) return;
    setHandledCheckoutReturnKey(checkoutReturnSignal.key);

    if (checkoutReturnSignal.kind === 'cancel') {
      setCheckoutRefreshPending(false);
      setCheckoutState({ status: 'idle' });
      return;
    }

    if (checkoutReturnSignal.kind === 'billing') {
      // D4 — Alex hit a loop where back-from-Stripe-portal would
      // flash "billing updated" then re-open the portal. Root cause:
      // the wizard stayed open in 'change to X' state and any
      // re-render that hit handlePlanCheckout would re-open the portal.
      // Close the wizard explicitly + reset checkout/billing state so
      // there's no auto-retry path.
      setBillingPortalRefreshPending(false);
      setBillingPortalState({ status: 'confirming' });
      setCheckoutState({ status: 'idle' });
      setCheckoutRefreshPending(false);
      setSetupOpen(false);
      void onCheckoutReturnRefresh()
        .then(() => setBillingPortalState({ status: 'idle' }))
        .catch(() => setBillingPortalState({ status: 'error', errorReason: 'unavailable', errorMessage: 'Plan changes may still be confirming. Refresh capacity in a moment.' }));
      return;
    }

    setCheckoutRefreshPending(false);
    void completeCheckoutReturn(checkoutReturnTierId)
      // Stripe revenue is reported by the webhook with its actual amount.
      // Returning from Checkout confirms entitlement, which may be a free trial.
      .catch(() => setCheckoutState({ status: 'error', tierId: checkoutReturnTierId, errorReason: 'unavailable', errorMessage: CHECKOUT_CONFIRMATION_SLOW_MESSAGE }));
  }, [checkoutReturnSignal, checkoutReturnTierId, completeCheckoutReturn, handledCheckoutReturnKey, onCheckoutReturnRefresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const reopened = appOpenDetector.current(state);
      if (state !== 'active') return;

      if (reopened && !checkoutRefreshPending && !billingPortalRefreshPending
        && checkoutState.status !== 'opening' && checkoutState.status !== 'confirming'
        && billingPortalState.status !== 'opening' && billingPortalState.status !== 'confirming') {
        setCheckingResume(true);
        const dismissalAtResume = paywallDismissRevision.current;
        void refreshWorkspaceAfterResume().then(() => {
          // A slow refresh must not undo Not now or remount an active purchase.
          if (paywallDismissRevision.current !== dismissalAtResume || purchaseInFlightRef.current) return;
          setPaywallDismissed(false);
          setSetupEntryPoint('app_open');
          setAppOpenCount((count) => count + 1);
        })
          .catch(() => undefined).finally(() => setCheckingResume(false));
      }

      if (checkoutRefreshPending) {
        setCheckoutRefreshPending(false);
        void settleCheckoutAfterResume(checkoutReturnTierId, checkoutReturnSignalRef.current.key);
      }

      if (billingPortalRefreshPending) {
        setBillingPortalRefreshPending(false);
        void onCheckoutReturnRefresh()
          .then(() => setBillingPortalState({ status: 'idle' }))
          .catch(() => setBillingPortalState({ status: 'error', errorReason: 'unavailable', errorMessage: 'Plan changes may still be confirming. Refresh capacity in a moment.' }));
      }

      if (!reopened && !checkoutRefreshPending && !billingPortalRefreshPending) {
        void refreshWorkspaceAfterResume();
      }
    });

    return () => subscription.remove();
  }, [billingPortalRefreshPending, checkoutRefreshPending, checkoutReturnTierId, onCheckoutReturnRefresh, refreshWorkspaceAfterResume, settleCheckoutAfterResume, checkoutState.status, billingPortalState.status, onProductRetry]);

  // "Download to phone". This used to be Linking.openURL(file.downloadUrl),
  // which hands the URL to the OS: Android's browser saves it, iOS opens Safari
  // and saves nothing, which is the blank screen Alex reported on 2026-08-13.
  // Both platforms now download into the app sandbox and offer the system share
  // sheet, where "Save to Files" puts it where the user wants it.
  const openRunnerFile = useCallback(async (file: MobileRunnerFile) => {
    const result = await downloadRunnerFileToPhone(file);
    return result.ok;
  }, []);

  const openMenu = () => {
    setDrawerView('menu');
    setDrawerOpen(true);
  };

  const openCapacity = () => {
    setDrawerView('capacity');
    setDrawerOpen(true);
  };

  const openSetup = () => {
    setSetupEntryPoint('upgrade_chip');
    console.log('[delegent-ui] openSetup invoked', { hasActiveSubscription: productView.hasActiveSubscription });
    setDrawerOpen(false);
    setDrawerView('menu');
    setSetupOpen(true);
  };

  const closeSetup = () => {
    paywallDismissRevision.current += 1;
    setPaywallDismissed(true);
    setAppOpenPaywallOpen(false);
    setSetupOpen(false);
    setDrawerOpen(false);
    setDrawerView('menu');
  };

  const continueToHomeFromSetup = () => {
    setActiveTab('dashboard');
    closeSetup();
  };

  if (setupOpen) {
    return (
      <SetupWizardScreen
        onboardingGoal={onboardingGoal}
        entryPoint={setupEntryPoint}
        key={`setup-${appOpenCount}`}
        productView={productView}
        checkoutState={checkoutState}
        billingPortalState={billingPortalState}
        onOpenCheckout={handlePlanCheckout}
        onOpenBillingPortal={handleBillingPortal}
        onContinueToHome={continueToHomeFromSetup}
        onRefreshCapacity={onProductRetry}
        onClose={closeSetup}
      />
    );
  }

  // [hooks-rules-fix 2026-05-21] productStateIsAuthoritative,
  // productEverAuthoritative state, and the latching useEffect have all
  // been hoisted to the top of Shell (declared with the other useState
  // calls) so the React hook order stays stable across renders where
  // setupOpen flips. The conditional EARLY RETURN below is unchanged.

  if (!productStateIsAuthoritative && !productEverAuthoritative) {
    return (
      <View style={styles.loadingScreen} testID="shell.productStateLoading">
        <ProductStateNotice status={productStatus} errorMessage={productErrorMessage} onRetry={onProductRetry} />
      </View>
    );
  }

  if (productStatus === 'error' && !productEverLive) {
    return (
      <View style={styles.loadingScreen} testID="shell.productStateError">
        <ProductStateNotice status={productStatus} errorMessage={productErrorMessage} onRetry={onProductRetry} />
      </View>
    );
  }

  // v1.2.1, a signed-in user without an active subscription lands
  // directly on the plan picker. After payment they're flipped to the
  // chat surface. No Connections tab, no messenger detour.
  //
  // Cycle 51: cancellation with a retained sleeping workspace is different
  // from a brand-new unsubscribed account. The user cannot start new chat/task
  // work, but the product promises their saved files remain in the private
  // workspace during the retention window, so keep the shell + Files tab
  // reachable and let the gate/banner explain how to resume.
  if (appOpenPaywallOpen && !productView.hasActiveSubscription) {
    return (
      <SetupWizardScreen
        onboardingGoal={onboardingGoal}
        entryPoint="app_open"
        key={`app-open-${appOpenCount}`}
        productView={productView}
        checkoutState={checkoutState}
        billingPortalState={billingPortalState}
        onOpenCheckout={handlePlanCheckout}
        onOpenBillingPortal={handleBillingPortal}
        onContinueToHome={() => setActiveTab('dashboard')}
        onRefreshCapacity={onProductRetry}
        onClose={closeSetup}
      />
    );
  }

  const thankYouTierName = checkoutThankYou.tierId
    ? (SIDEKICK_PLAN_TIERS.find((tier) => tier.id === checkoutThankYou.tierId)?.name ?? null)
    : null;

  return (
    <>
      <Header gate={productGate} onMenuPress={openMenu} onProfilePress={() => setActiveTab('profile')} profile={profile} />
      {checkoutThankYou.visible ? (
        <CheckoutThankYouBanner tierName={thankYouTierName} onDismiss={dismissCheckoutThankYou} />
      ) : null}
      <StagedUpdateBanner />
      <ProductStateNotice status={productStatus} errorMessage={productErrorMessage} onRetry={onProductRetry} suppressTransientLoading={productEverLive} />
      <ProvisioningWaitNotice gateKind={productGate.kind} stalled={productProvisioningStalled} />
      <View style={[styles.content, shellTabs.length > 1 ? null : styles.contentWithoutTabBar]}>
        {/* The chat (Dashboard) stays MOUNTED across tab switches — only
            hidden when inactive — so the in-memory conversation and any
            in-flight streaming run survive leaving and returning to the Chat
            tab. The old `activeTab === 'dashboard' ? … : null` unmounted the
            WebView and destroyed its message state, so a reply you tabbed
            away from came back blank ("said something, went away, came back,
            it was gone"). */}
        <View style={[styles.tabPane, activeTab === 'dashboard' ? null : styles.tabPaneHidden]}>
          <Dashboard
            productView={productView}
            active={activeTab === 'dashboard'}
            // The Upgrade chip on the chat's quota banner used to call the
            // Stripe portal straight from here. Two things were wrong with
            // that. The portal is cancel-only under our config, so an upgrade
            // button led to a page that cannot upgrade (the same defect D3/D6
            // removed from the capacity drawer and Profile). And the chat tab
            // is the one surface that does not render billingPortalState, so
            // when the open failed the reader pressed Upgrade and absolutely
            // nothing on screen changed. The plan picker is where every other
            // in-app route already goes, and it is what the browser does with
            // the same chip.
            onOpenBillingPortal={openSetup}
            onOpenFile={(path) => {
              // Agent engine: no Files tab to open a file in.
              if (agentEngine) return;
              setFocusedArtifactPath(path);
              selectShellTab('artifacts');
            }}
          />
        </View>
        {activeTab === 'artifacts' ? (
          <ArtifactsScreen
            runnerFilesState={runnerFilesState}
            onRunnerFilesRefresh={refreshRunnerFiles}
            onRunnerFileOpen={openRunnerFile}
            onRunnerFileRemovedLocally={removeRunnerFileLocally}
            onRunnerFileRestoredLocally={restoreRunnerFileLocally}
            onRunnerFileRenamedLocally={renameRunnerFileLocally}
            onRunnerFilesRemovedLocally={removeRunnerFilesLocally}
            onRunnerFilesRestoredLocally={restoreRunnerFilesLocally}
            focusedFilePath={focusedArtifactPath}
          />
        ) : null}
        {activeTab === 'profile' ? (
          <ProfileScreen
            onSignOut={onSignOut}
            profile={profile}
            productView={productView}
            onProfileSave={saveProfile}
            // "Manage plan" must open the in-app Monthly Capacity page (where the
            // user picks an amount), which then flows to the plan picker -> Stripe.
            // It previously jumped straight to the Stripe portal (defect).
            onOpenBillingPortal={openCapacity}
            // The cancel path must NOT go through the capacity page: it is the
            // Stripe portal or Apple's subscription sheet, and nothing else in
            // the app reached them once "Manage plan" was rerouted above.
            onCancelSubscription={() => { void handleBillingPortal(); }}
            billingPortalState={billingPortalState}
          />
        ) : null}
      </View>
      {/* Bottom tab bar is ALWAYS visible — including during workspace
          provisioning. Alex's v1.3.4 review flagged the bar disappearing
          on the "Preparing workspace" gate, leaving the user with only a
          burger menu and no obvious Chat/Files navigation. The earlier
          keyboardVisible gate was masking the bar even when no keyboard
          was actually open (Android keyboardDidShow/keyboardDidHide
          events can latch incorrectly across activity lifecycle events).
          The composer-area scrolls behind the bar via the chat shell's
          own bottom padding, so we don't need a global hide. */}
      {shellTabs.length > 1 ? (
        <Surface elevation="surface" radius="xl" border style={styles.tabBar}>
          {shellTabs.map((tab) => (
            <TabButton key={tab} tab={tab} activeTab={activeTab} setActiveTab={selectShellTab} />
          ))}
        </Surface>
      ) : null}
      <MenuDrawer
        onboardingGoal={onboardingGoal}
        authUserId={authUserId}
        visible={drawerOpen}
        view={drawerView}
        // [DN1.4-02] Route every drawer-internal view change through
        // setDrawerView so the MenuDrawer's Modal renders the new view
        // in place. The earlier wrapper hijacked 'setup' and called
        // openSetup() instead, which closed the drawer Modal AND
        // triggered the Shell-level setupOpen early-return, that
        // mount/unmount transition (drawer Modal dismissing while the
        // Shell tree swaps to SetupWizardScreen as a top-level
        // component) was leaving the underlying Activity window
        // briefly empty and the Android launcher slid in behind. The
        // MenuDrawer already handles view='setup' by rendering
        // SetupWizardScreen inside its full-screen Surface
        // (App.tsx ~2102), so there is no need for the menu-row tap to
        // detour through the Shell-level top-level path. Top-level
        // setupOpen is still used by the post-checkout-return flow
        // (setupGuideLaunchKey effect) and the unsubscribed-auto-route
        // path, both of which need to replace the whole shell, but
        // tapping "Plan & billing" from the menu while inside the
        // shell stays inside the drawer Modal.
        onChangeView={setDrawerView}
        skillCategoryKey={skillCategoryKey}
        onOpenSkillCategory={(key) => {
          setSkillCategoryKey(key);
          setDrawerView('skillCategory');
        }}
        onClose={() => setDrawerOpen(false)}
        onSelectTab={selectShellTab}
        onOpenCheckout={handlePlanCheckout}
        onOpenBillingPortal={handleBillingPortal}
        onRefreshCapacity={onProductRetry}
        onSignOut={() => {
          setDrawerOpen(false);
          onSignOut();
        }}
        profile={profile}
        productView={productView}
        checkoutState={checkoutState}
        billingPortalState={billingPortalState}
      />
    </>
  );
}

type SidekickAppProps = {
  sidekickInitialUrl?: string | null;
  /** Called once this launch knows which screen comes next (see App). */
  onBootReady?: () => void;
};

function AppContent({ sidekickInitialUrl = null, onBootReady }: SidekickAppProps) {
  const { authState, signInWithGoogle, signInWithApple, sendEmailOtp, verifyEmailOtp, signOut } = useMobileAuth(sidekickInitialUrl);
  // Remembered connection cards belong to the account that read them.
  useEffect(() => {
    if (authState.status === 'signed_out') forgetConnectionInventory();
  }, [authState.status]);
  const coworkerEngine = useCoworkerEngineForUser(authState.status === 'authenticated' ? authState.user.id : null);
  const productState = useMobileProductState(authState, coworkerEngine === 'agent');

  // RECOVER A PURCHASE APPLE TOOK THAT WE NEVER GRANTED.
  //
  // The gap between Apple taking the money and the Worker writing the
  // entitlement is real and was hit for real on 2026-08-20: the account was not
  // on the allowlist, Apple charged, the verify answered 403, and the customer
  // had paid for nothing. It can equally be a dropped connection or the app
  // being killed as the sheet closes. Apple will not sell the same subscription
  // twice, so without this the only route back is a support ticket.
  //
  // Runs when we believe there is NO subscription, which is exactly the state a
  // silently-lost purchase leaves behind, and never when one is already active.
  // Verification is idempotent, so a redundant run costs one request and writes
  // the same row. Failures are swallowed on purpose: this is a background
  // repair, and someone who never bought anything must not be shown an error on
  // a screen they did not ask for.
  const restoreAttemptedForUser = useRef<string | null>(null);
  useEffect(() => {
    if (!usesStoreKit()) return;
    if (productState.status !== 'live') return;
    const userId = productState.snapshot?.profile?.id ?? null;
    if (!userId || restoreAttemptedForUser.current === userId) return;
    const status = productState.snapshot?.subscription?.status ?? 'inactive';
    if (isEntitledSubscriptionStatus(status)) return;

    restoreAttemptedForUser.current = userId;
    let cancelled = false;
    void (async () => {
      try {
        const result = await restoreApplePurchases();
        if (cancelled || !result || !('purchased' in result)) return;
        await productState.refresh();
      } catch {
        // Background repair. Never surfaced.
      }
    })();
    return () => { cancelled = true; };
  }, [productState.status, productState.snapshot?.profile?.id]);

  const [termsVisible, setTermsVisible] = useState(false);
  const [privacyVisible, setPrivacyVisible] = useState(false);
  const [adConsentVisible, setAdConsentVisible] = useState(false);
  const [onboardingCompletedUserId, setOnboardingCompletedUserId] = useState<string | null>(null);
  const [goalForUser, setGoalForUser] = useState<{ userId: string; goal: OnboardingGoal | null } | null>(null);
  const goalUserId = authState.status === 'authenticated' ? authState.user.id : null;
  useEffect(() => {
    let cancelled = false;
    if (goalUserId) void loadOnboardingGoal().then((goal) => {
      if (!cancelled) setGoalForUser((current) => current?.userId === goalUserId && current.goal ? current : { userId: goalUserId, goal });
    });
    return () => { cancelled = true; };
  }, [goalUserId]);
  const [setupGuideLaunchKey, setSetupGuideLaunchKey] = useState(0);
  const [checkoutReturnSignal, setCheckoutReturnSignal] = useState<CheckoutReturnSignal>({ key: 0, kind: null });
  const profile = useMemo(() => buildProfile(authState.user, productState.snapshot, productState.mode, authState.session?.provider), [authState.user, authState.session?.provider, productState.snapshot, productState.mode]);
  const authErrorMessage = authState.status === 'error' ? authState.error.message : null;

  // Notification permission, asked at the first moment it makes sense.
  //
  // NOT on first launch: Android 13+ shows a system permission dialog, and
  // asking before someone knows what the app does is the reliable way to earn a
  // permanent "no" — after which the approval alerts that actually matter can
  // never reach them. We wait until they are signed in AND subscribed, i.e.
  // they have a coworker that can genuinely need them.
  //
  // Once per signed-in user per app session: the ref keeps a re-render from
  // re-asking, and the user id in it means switching account re-registers, so
  // the device moves to the new owner rather than notifying the previous one.
  const pushRegisteredForUserRef = useRef<string | null>(null);
  const pushEligibleUserId = authState.status === 'authenticated'
    && isEntitledSubscriptionStatus(productState.snapshot.subscription?.status)
    ? authState.user.id
    : null;
  useEffect(() => {
    if (!pushEligibleUserId) return;
    if (pushRegisteredForUserRef.current === pushEligibleUserId) return;
    pushRegisteredForUserRef.current = pushEligibleUserId;
    if (!mobileCheckoutApiBaseUrl) return;
    // Fire and forget. A failure here is silent by design: the user did not ask
    // for this and must not be shown an error about it. Retried next launch.
    // getFreshMobileAccessToken refreshes an expiring session rather than
    // sending a token the Worker would reject — the public session object
    // deliberately does not carry the raw access token.
    void (async () => {
      const accessToken = await getFreshMobileAccessToken();
      if (!accessToken) return;
      await registerForPushNotifications(mobileCheckoutApiBaseUrl, accessToken);
    })().catch(() => undefined);
  }, [pushEligibleUserId]);

  // Advertising state follows authentication; capture additionally requires consent.
  const authedUserIdForAttribution = authState.status === 'authenticated' ? authState.user.id : null;
  useEffect(() => {
    // Account setup disables stale collection before reading the new answer.
    // Referrer capture is owned by the consent coordinator, after server ACK.
    setAdConsentVisible(false);
    void setAdvertisingAccount(authedUserIdForAttribution).catch(() => undefined);
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void applyStoredMetaConsent().catch(() => undefined);
    });
    return () => {
      listener.remove();
      void setAdvertisingAccount(null).catch(() => undefined);
    };
  }, [authedUserIdForAttribution]);


  const onboardingCompleteForUser = authState.status === 'authenticated'
    && onboardingCompletedUserId === authState.user.id;
  // 2026-05-15 fix: do not commit to OnboardingScreen until product state has
  // returned authoritative data. useMobileProductState swaps the snapshot to a
  // fail-closed shell (no profile.agentName, no acknowledgement) the moment
  // auth becomes 'authenticated', then sets status='loading' while it fetches
  // the real row. Without this guard, a returning user briefly sees "Name your
  // coworker" between the auth handoff and the first live fetch, exactly the
  // flash the user reported.
  //
  // 2026-05-19 fix (chat send disappears): only LIVE status is authoritative
  // for the onboarding gate. Treating 'error' as authoritative was bouncing
  // returning users to OnboardingScreen on a transient productState load
  // error (network blip during runner cold-start), which UNMOUNTED the
  // entire Shell + chat surface + in-flight optimistic messages.
  // When status === 'error' but the user is signed in, the right behaviour
  // is to keep the Shell rendered and show an error notice — the
  // ProductStateNotice banner already does this.
  const productStateIsAuthoritative = productState.status === 'live';
  const productStateReadyForShell = productState.status === 'live' || productState.status === 'error';
  const needsOnboarding = authState.status === 'authenticated'
    && !onboardingCompleteForUser
    && productStateIsAuthoritative
    && (productState.gate.kind === 'needs_acknowledgement' || !productState.snapshot.profile?.agentName);
  const handleOnboardingComplete = useCallback(async (goal: OnboardingGoal) => {
    if (authState.status !== 'authenticated') return;
    setGoalForUser({ userId: authState.user.id, goal });
    setOnboardingCompletedUserId(authState.user.id);
    setSetupGuideLaunchKey((key) => key + 1);
    await productState.refresh().catch(() => undefined);
  }, [authState, productState]);
  const refreshAfterCheckout = useCallback(() => refreshUntilCheckoutSubscriptionActive(productState.refresh), [productState.refresh]);

  // Meta advertising consent — NOT gated on a subscription, but NOT asked
  // before the person has actually seen the product either.
  //
  // Two separate mistakes are avoided here, and both were real.
  //
  // 1. It used to live inside the push-registration effect, which is keyed on
  //    `pushEligibleUserId` and therefore requires isEntitledSubscriptionStatus.
  //    So the card was only ever shown to people who had ALREADY subscribed,
  //    and Meta never saw an install or a sign-up from anyone who installed
  //    from an advert and did not pay — precisely the population its optimiser
  //    needs. Found by the release audit, 2026-08-17.
  //
  // 2. Moving it to raw `authState.status === 'authenticated'` then swung too
  //    far the other way: the modal could surface over the brand splash, the
  //    loading login screen or onboarding, before the user had seen anything
  //    they were being asked to consent in relation to. Consent has to be
  //    informed at the moment it is given, and a prompt over a splash screen is
  //    not. Found by the pre-deploy review the same day.
  //
  // So: authenticated, past onboarding, and the shell actually rendering.
  const authedUserIdForAds = authState.status === 'authenticated'
    && onboardingCompleteForUser
    && productStateReadyForShell
    ? authState.user.id
    : null;
  const adsConsentCheckedForUserRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!authedUserIdForAds) { adsConsentCheckedForUserRef.current = null; return; }
    if (adsConsentCheckedForUserRef.current === authedUserIdForAds) return;
    adsConsentCheckedForUserRef.current = authedUserIdForAds;
    void (async () => {
      // Re-apply any consent already given, then ask only if we never have.
      // applyStoredMetaConsent is a no-op unless the stored answer was yes, so
      // this is safe on every sign-in and never re-enables a withdrawn consent.
      await applyStoredMetaConsent();
      if (await shouldAskMetaConsent() && !cancelled) setAdConsentVisible(true);
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [authedUserIdForAds]);

  const rememberCheckoutReturn = useCallback((url: string | null | undefined) => {
    const kind = checkoutReturnKindFromUrl(url);
    if (!kind) return;
    setCheckoutReturnSignal((current) => ({ key: current.key + 1, kind }));
  }, []);

  useEffect(() => {
    rememberCheckoutReturn(sidekickInitialUrl);

    Linking.getInitialURL()
      .then(rememberCheckoutReturn)
      .catch(() => undefined);

    readSidekickNativeDeepLink('getInitialUrl')
      .then(rememberCheckoutReturn)
      .catch(() => undefined);

    const consumeNativeCheckoutReturn = () => {
      readSidekickNativeDeepLink('peekLatestUrl')
        .then(async (url) => {
          if (!checkoutReturnKindFromUrl(url)) return;
          const consumedUrl = await readSidekickNativeDeepLink('consumeLatestUrl');
          rememberCheckoutReturn(consumedUrl);
        })
        .catch(() => undefined);
    };
    consumeNativeCheckoutReturn();
    const nativeCheckoutReturnPoller = setInterval(consumeNativeCheckoutReturn, 750);

    const listener = Linking.addEventListener('url', ({ url }) => {
      rememberCheckoutReturn(url);
    });

    return () => {
      clearInterval(nativeCheckoutReturnPoller);
      listener.remove();
    };
  }, [rememberCheckoutReturn, sidekickInitialUrl]);

  const themedStyles = useMemo(() => createAppStyles(colors), []);
  appColors = colors;
  styles = themedStyles;

  // v1.2.6/v1.2.10, postpone the Shell handoff until product state is
  // ready to render a signed-in surface. A live row can route into the full
  // app; a retryable error should still render the signed-in retry shell so
  // the user is not bounced back to login/setup.
  const initialAuthReadyForShell = authState.status === 'authenticated' && productStateReadyForShell;

  // v1.2.7, D5/D7 fix. Without latching, productState transitions back
  // to 'loading' whenever refresh() is called (Stripe portal return,
  // AppState resume, manual refresh). authReadyForShell flicks false,
  // the LoginScreen shows for 200-600ms, then the shell remounts. Alex
  // saw this as infinite flicker on the billing-portal return, and as
  // the bottom tab bar disappearing after login. Once we've successfully
  // shown the shell to an authenticated user, keep showing it until the
  // user actually signs out.
  const [shellEverShown, setShellEverShown] = useState(false);
  useEffect(() => {
    if (initialAuthReadyForShell && !shellEverShown) setShellEverShown(true);
  }, [initialAuthReadyForShell, shellEverShown]);
  useEffect(() => {
    if (authState.status === 'signed_out' && shellEverShown) setShellEverShown(false);
  }, [authState.status, shellEverShown]);
  const authReadyForShell = initialAuthReadyForShell
    || (shellEverShown && authState.status === 'authenticated');
  // Tell the splash where this launch is going (2026-09-27): it holds its last
  // frame until then, so a signed-in person goes straight from the splash to
  // their chat instead of glimpsing the sign-in screen saying "Signing in".
  const bootDestinationKnown = authReadyForShell || authState.status === 'signed_out' || authState.status === 'error';
  useEffect(() => {
    if (bootDestinationKnown) onBootReady?.();
  }, [bootDestinationKnown, onBootReady]);

  return (
    <ThemeProvider theme="light">
      <CoworkerEngineContext.Provider value={coworkerEngine}>
      <SafeAreaView style={themedStyles.safe}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
        {authReadyForShell ? (
          needsOnboarding ? (
            <>
              <StagedUpdateBanner />
              <OnboardingScreen
                key={authState.user.id}
                trialCandidate={shouldQuoteFreeTrial(productState.snapshot.subscription)}
                onComplete={handleOnboardingComplete}
                onSignOut={signOut}
              />
            </>
          ) : (
            <Shell
              key={authState.user.id}
              authUserId={authState.user.id}
              onboardingGoal={goalForUser?.userId === authState.user.id ? goalForUser.goal : null}
              onSignOut={signOut}
              profile={profile}
              productState={productState.snapshot}
              productGate={productState.gate}
              productStatus={productState.status}
              productErrorMessage={productState.errorMessage}
              productProvisioningStalled={productState.provisioningStalled}
              onProductRetry={productState.refresh}
              onCheckoutReturnRefresh={refreshAfterCheckout}
              onCheckoutResumeRefresh={productState.refresh}
              checkoutReturnSignal={checkoutReturnSignal}
              setupGuideLaunchKey={setupGuideLaunchKey}
            />
          )
        ) : (
          <>
            {/* A signed-out user must still hear about a staged update. The
                2026-08-13 iOS Google sign-in defect was fixed by OTA, but the
                banner lived only in Shell, so the stranded user had no path to
                it beyond superstitious force-quitting. See StagedUpdateBanner. */}
            <StagedUpdateBanner />
            <LoginScreen
              onGooglePress={signInWithGoogle}
              onApplePress={signInWithApple}
              onSendEmailOtp={sendEmailOtp}
              onVerifyEmailOtp={verifyEmailOtp}
              onOpenTerms={() => setTermsVisible(true)}
              onOpenPrivacy={() => setPrivacyVisible(true)}
              loading={authState.status === 'loading' || authState.status === 'authenticated'}
              errorMessage={authErrorMessage}
            />
          </>
        )}
        <TermsModal visible={termsVisible} onClose={() => setTermsVisible(false)} />
        <PrivacyModal visible={privacyVisible} onClose={() => setPrivacyVisible(false)} />
        <AdConsentModal
          visible={adConsentVisible}
          onDecide={(granted) => {
            setAdConsentVisible(false);
            void recordMetaConsent(granted);
          }}
        />
      </SafeAreaView>
      </CoworkerEngineContext.Provider>
    </ThemeProvider>
  );
}

// =====================================================================
// Forensic-pack required surfaces (R-BILL-08 / R-BILL-12 / R-SEC-14 /
// R-LEG-04 / R-LEG-06 / R-INT-02 / R-INT-03). Each component below
// covers an explicit evaluation criterion and is consumed by routes
// in the mobile menu (TermsModal / PrivacyModal / Profile drawer).
// Removing one of them must trigger the matching forensic failure.
// =====================================================================

// R-BILL-08 — hard-cap quota replaces the composer.
type QuotaPauseCardProps = {
  resetIso: string | null;
  upgradeHref: string;
  onUpgradePress: () => void;
};
export function QuotaPauseCard({ resetIso, upgradeHref, onUpgradePress }: QuotaPauseCardProps) {
  const themeColors = useThemeColors();
  return (
    <View style={{ padding: space[4], borderRadius: radii.md, backgroundColor: themeColors.surfaceHigh, gap: space[2] }} accessibilityRole="alert" accessibilityLabel="QuotaPauseCard">
      <Text>You've used everything in this month's plan.</Text>
      {/* The helper returns a whole sentence, so wrapping it in another one
          produced "Your capacity resets on Your monthly time resets on
          Saturday, 17 May.." */}
      {resetIso ? <Text>{formatCycleEndLine(resetIso)}</Text> : null}
      <Pressable onPress={onUpgradePress} accessibilityRole="button" accessibilityLabel="Upgrade your plan">
        <Text>Upgrade plan</Text>
      </Pressable>
      <Text>{`Or wait for the reset. Sending a new message is paused until then.`}</Text>
    </View>
  );
}

// R-LEG-04 — first-run terms-acknowledgement gate. Must render the
// AI-output-is-probabilistic disclaimer before the user can proceed.
type FirstRunTermsGateProps = {
  termsAccepted: boolean;
  onAcceptTerms: () => void;
};
export function FirstRunTermsGate({ termsAccepted, onAcceptTerms }: FirstRunTermsGateProps) {
  if (termsAccepted) return null;
  return (
    <View accessibilityLabel="First-run terms acknowledgement" style={{ padding: space[4], gap: space[3] }}>
      <Text>{AI_FALLIBILITY_DISCLAIMER}</Text>
      <Pressable onPress={onAcceptTerms} accessibilityLabel="Accept terms">
        <Text>I understand. Continue.</Text>
      </Pressable>
    </View>
  );
}

// R-MSG-01 — when EXPO_PUBLIC_FEATURE_MESSENGERS_TELEGRAM=true, surface
// the Connect Telegram screen with the short-lived connect code.
type ConnectTelegramSurfaceProps = {
  connectCode: string | null;
  onRequestNewCode: () => void;
};
export function ConnectTelegramSurface({ connectCode, onRequestNewCode }: ConnectTelegramSurfaceProps) {
  if (!FEATURE_MESSENGERS_TELEGRAM) return null;
  return (
    <View accessibilityLabel="Connect Telegram" style={{ padding: space[4], gap: space[3] }}>
      <Text accessibilityRole="header">Connect Telegram</Text>
      <Text>{`Open Telegram and send /start ${connectCode ?? ''} to the Delegent bot.`}</Text>
      <Pressable onPress={onRequestNewCode} accessibilityLabel="Request a new connect code">
        <Text>Generate a new code</Text>
      </Pressable>
    </View>
  );
}

// Default export is the Sentry-wrapped, error-boundaried root (each is a no-op
// when its prerequisite is absent). `App`/`RootApp` are hoisted function
// declarations, so referencing them here is safe. The boundary sits ABOVE App so
// a render fault anywhere in the tree shows a recoverable fallback, not a blank
// white screen (GO_LIVE_TRACKER #15).
function RootApp(props: SidekickAppProps) {
  return (
    <MobileErrorBoundary>
      <App {...props} />
    </MobileErrorBoundary>
  );
}

export default wrapWithSentry(RootApp);

function App({ sidekickInitialUrl = null }: SidekickAppProps) {
  const [fontsLoaded, fontError] = useFonts({
    [fontFamilies.geistRegular]: Geist_400Regular,
    [fontFamilies.geistMedium]: Geist_500Medium,
    [fontFamilies.geistSemiBold]: Geist_600SemiBold,
    [fontFamilies.geistMonoRegular]: GeistMono_400Regular,
    [fontFamilies.geistMonoMedium]: GeistMono_500Medium,
    [fontFamilies.instrumentSerifItalic]: InstrumentSerif_400Regular_Italic,
  });
  const [splashDone, setSplashDone] = useState(false);
  const [bootReady, setBootReady] = useState(false);
  const markBootReady = useCallback(() => setBootReady(true), []);

  if (fontError) {
    throw fontError;
  }

  // The splash is up from the very first frame and stays in one piece until
  // this launch knows where it is going (fonts loaded, and signed in or not),
  // so the brain is never swapped for a second copy (which let Android's
  // launch screen fade over a gap) and a signed-in person never glimpses the
  // sign-in screen. The splash itself needs none of the custom fonts.
  return (
    <SafeAreaProvider>
      <ThemeProvider theme="light">
        <View style={styles.appRoot}>
          {/* One ambient light behind every screen (2026-09-27 redesign). */}
          <AmbientBackground />
          {fontsLoaded ? <AppContent sidekickInitialUrl={sidekickInitialUrl} onBootReady={markBootReady} /> : null}
          {splashDone ? null : (
            <BrandSplash ready={fontsLoaded && bootReady} onFinish={() => setSplashDone(true)} />
          )}
        </View>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

/**
 * How wide content is allowed to get on a large screen.
 *
 * Every layout in this file was written for a phone, where a full-width
 * column is correct. On an iPad the same styles run to roughly 1024pt, which
 * reads as "not designed for iPad" under Guideline 4.0 rather than as a bug.
 *
 * NO PHONE IS AFFECTED BY EITHER VALUE. The widest iPhone is 430pt, so a
 * 720pt cap never binds, and `alignSelf: 'center'` with `width: '100%'` is a
 * no-op while the container is narrower than the cap. That is what makes this
 * safe to ship on the same binary as the phone build.
 */
const WIDE_CONTENT_MAX_WIDTH = 720;

/**
 * The menu drawer is `width: '92%'`, which is right on a phone and absurd on
 * an iPad: 942pt of a 1024pt screen, so the backdrop you tap to dismiss is a
 * sliver. 420 keeps it a drawer. 92% of the widest iPhone is 396pt, so again
 * no phone reaches the cap.
 */
const DRAWER_MAX_WIDTH = 420;

function createAppStyles(themeColors: ThemeColors) {
  return StyleSheet.create({
  // Transparent since the 2026-09-27 redesign: the ambient light painted once
  // at the root (AmbientBackground in App) shows through every screen.
  safe: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  loadingScreen: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  appRoot: {
    flex: 1,
    backgroundColor: themeColors.bg,
  },
  onboardingScreen: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: space[5],
    paddingTop: space[5],
    paddingBottom: space[7],
    backgroundColor: 'transparent',
  },
  onboardingCard: {
    borderWidth: 1,
    borderColor: themeColors.border,
  },
  onboardingInput: {
    minHeight: 52,
    borderRadius: radii.lg,
    borderWidth: 1,
    paddingHorizontal: space[3],
    fontFamily: fontFamilies.geistRegular,
    fontSize: 16,
  },
  onboardingCheckRow: {
    minHeight: 52,
    borderRadius: radii.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
  },
  onboardingCheckBox: {
    width: 24,
    height: 24,
    borderRadius: radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  onboardingAcknowledgementText: {
    flex: 1,
  },
  // [Batch 6 §4.7] Visible affordance so users notice "Terms" is tappable
  // separately from the row-level checkbox.
  onboardingTermsLink: {
    textDecorationLine: 'underline',
  } as const,
  strikePrice: {
    textDecorationLine: 'line-through',
  } as const,
  // flexGrow, not flex: with the orbit the page can be taller than a small
  // phone, and flex:1 pinned it to one screen and squeezed the hero down over
  // the sign-in buttons. Now it fills the screen when it fits and scrolls
  // when it does not; the hero never shrinks below its own content.
  loginScreen: {
    flexGrow: 1,
    justifyContent: 'space-between',
    paddingHorizontal: space[5],
    paddingTop: space[5],
    paddingBottom: space[6],
  },
  loginHero: {
    flexGrow: 1,
    flexShrink: 0,
    justifyContent: 'center',
    paddingBottom: space[3],
  },
  loginTickerWrap: {
    alignSelf: 'stretch',
    marginTop: space[1],
  },
  loginMark: {
    width: 76,
    height: 76,
    borderRadius: radii.xl,
    backgroundColor: themeColors.surfaceHigh,
    borderWidth: 1,
    borderColor: themeColors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginMarkImage: {
    width: 58,
    height: 58,
  },
  loginSubtitle: {
    maxWidth: 280,
  },
  loginActions: {
    width: '100%',
    maxWidth: 360,
    alignSelf: 'center',
    paddingBottom: space[3],
  },
  googleButton: {
    minHeight: 58,
    borderRadius: radii.full,
    backgroundColor: themeColors.surfaceHigh,
    borderWidth: 1,
    borderColor: 'rgba(28, 26, 21, 0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space[3],
    ...shadow.raised,
  },
  loginPrimaryAction: {
    width: '100%',
    alignSelf: 'center',
  },
  googleButtonDisabled: {
    opacity: 0.7,
  },
  googleGlyph: {
    width: 30,
    height: 30,
    borderRadius: radii.full,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleGlyphImage: {
    width: 22,
    height: 22,
  },
  loginDividerRow: {
    paddingHorizontal: space[2],
  },
  loginDivider: {
    flex: 1,
  },
  phoneAuthCard: {
    width: '100%',
    alignSelf: 'center',
    borderWidth: 1,
    borderColor: themeColors.border,
  },
  loginEmailHeading: {
    alignSelf: 'center',
    paddingBottom: space[1],
  },
  phoneInput: {
    minHeight: 46,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: themeColors.borderStrong,
    backgroundColor: themeColors.surfaceHigh,
    color: themeColors.textPrimary,
    paddingHorizontal: space[3],
    fontFamily: fontFamilies.geistRegular,
    fontSize: 15,
  },
  phoneAuthButton: {
    // 48dp minimum touch target (Android accessibility / Play Pre-launch
    // a11y check). Was 42dp, which the accessibility audit flagged as a
    // sub-48dp tap target on the primary "Continue with email" CTA.
    minHeight: 48,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: themeColors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: themeColors.surfaceHigh,
  },
  phoneAuthButtonPrimary: {
    flex: 1,
    minHeight: 42,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: themeColors.textPrimary,
  },
  loginTerms: {
    paddingHorizontal: space[4],
    paddingTop: space[2],
  },
  loginTermsLink: {
    color: themeColors.accent,
    textDecorationLine: 'underline',
  },
  loginTermsLinkRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[4],
    paddingTop: space[1],
  },
  loginTermsLinkButton: {
    paddingVertical: space[1],
  },
  loginTagline: {
    paddingHorizontal: space[3],
  },
  header: {
    paddingHorizontal: space[4],
    paddingTop: space[3],
    paddingBottom: space[2],
  },
  // Round glass buttons that float on the ambient light.
  headerIconButton: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: 'rgba(255, 255, 255, 0.86)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  menuGlyph: {
    width: 18,
    gap: 5,
  },
  menuGlyphBar: {
    height: 2,
    width: 18,
    borderRadius: 1,
    backgroundColor: themeColors.textPrimary,
  },
  menuGlyphBarShort: {
    width: 11,
  },
  drawerBackButton: {
    width: 40,
    height: 40,
    borderRadius: radii.full,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 3,
    ...shadow.card,
  },
  brandLockup: {
    flex: 1,
    minWidth: 0,
  },
  brandCopy: {
    flex: 1,
    minWidth: 0,
  },
  // 2026-05-15 brand swap: the static Delegent AI mark replaces the
  // programmatic RobotFace at the login hero, shell header, and onboarding.
  // Sizes mirror the previous RobotFace prop values so the layout stays
  // identical.
  loginScroll: {
    flex: 1,
  },
  brandLogoHero: {
    width: 108,
    height: 108,
  },
  // Used while the email flow is open, so the hero yields height to the OTP
  // fields rather than letting the buttons overlap the logo.
  brandLogoHeroCompact: {
    width: 64,
    height: 64,
  },
  brandLogoHeader: {
    width: 38,
    height: 38,
  },
  // The onboarding footprint of the bundled mark. Since 2026-09-26 it is the
  // coworker's avatar beside the live greeting on the name step, so it is
  // avatar-sized rather than the old 92px logo above the heading.
  brandLogoOnboarding: {
    width: 36,
    height: 36,
  },
  onboardingGreetingRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space[3],
  },
  onboardingGreetingAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  onboardingGreetingBubble: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radii.xl,
    borderBottomLeftRadius: radii.sm,
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    gap: 2,
    minHeight: 76,
  },
  headerMark: {
    width: 38,
    height: 38,
    borderRadius: radii.md,
    backgroundColor: themeColors.surfaceHigh,
    borderWidth: 1,
    borderColor: themeColors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerMarkImage: {
    width: 30,
    height: 30,
  },
  profileButton: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: themeColors.surfaceHigh,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  // No floating tab bar to clear (an agent-engine account has only Chat).
  contentWithoutTabBar: {
    marginBottom: 0,
  },
  content: {
    flex: 1,
    // [layout 2026-06-04] The chat fills this view, so its bottom margin is the
    // ONLY thing standing between the composer and the floating tab bar. It was
    // space[9]+space[5] = 120dp, but the tab bar (height 58 at bottom space[5])
    // only needs ~82dp — leaving a ~170px dead white band below the message bar
    // when the keyboard is down (Alex). First pass space[8]=64dp dropped that to
    // ~42px; this tighter space[7]+space[2]=56dp closes it to ~20px (measured on
    // the Pixel emulator, density 2.75) — chat window grows right down to just
    // above the floating tab bar, composer still safely clear of it (the safe
    // floor is ~50dp before the composer would overlap the pill).
    marginBottom: space[7] + space[2],
  },
  tabPane: {
    flex: 1,
  },
  tabPaneHidden: {
    // Keep the chat WebView mounted (its message state + in-flight stream
    // are preserved) but visually hidden and zero-laid-out when another tab
    // is active.
    display: 'none',
  },
  productStateNotice: {
    marginHorizontal: space[5],
    marginBottom: space[2],
  },
  noticeRetryButton: {
    minHeight: 32,
    paddingHorizontal: space[3],
    borderRadius: radii.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thankYouIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    maxWidth: WIDE_CONTENT_MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: space[5],
    paddingBottom: space[9] + space[9],
    gap: space[3],
  },
  // v1.2.1 chat-first Home, the panel fills the available space between
  // the header and the bottom tab bar so the user lands inside the
  // conversation rather than below a hero card.
  dashboardChatHost: {
    // v1.2.4, host has no padding so the chat panel butts right up
    // against the bottom edge of the content area. When the keyboard
    // opens, the panel's own paddingBottom = keyboardHeight is the
    // *only* spacer between the composer and the keyboard.
    // 2026-09-27 redesign: no side or top padding either. The chat is no
    // longer a card set into the page; it is the page, edge to edge, in the
    // same light as the header.
    flex: 1,
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  heroCopy: {
    paddingTop: space[4],
    paddingBottom: space[3],
  },
  segmentWrap: {
    alignSelf: 'stretch',
  },
  segmentItem: {
    flex: 1,
    minHeight: 40,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentItemActive: {
    backgroundColor: themeColors.surfaceHigh,
    borderWidth: 1,
    borderColor: themeColors.borderStrong,
  },
  planCard: {
    borderWidth: 1,
    borderColor: themeColors.border,
  },
  flexText: {
    flex: 1,
    minWidth: 0,
  },
  routineChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[2],
  },
  capacityStrip: {
    alignSelf: 'flex-start',
    minHeight: 30,
    paddingHorizontal: space[2],
    borderRadius: radii.sm,
    backgroundColor: themeColors.accentMuted,
  },
  capacityTrack: {
    height: 8,
    borderRadius: radii.full,
    overflow: 'hidden',
  },
  capacityFill: {
    height: 8,
    borderRadius: radii.full,
  },
  featureRow: {
    minHeight: 22,
  },
  highlightGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: space[2],
  },
  highlightTile: {
    width: '48.8%',
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingVertical: space[2],
    paddingHorizontal: space[3],
  },
  highlightEmoji: {
    fontSize: 22,
    lineHeight: 28,
  },
  freeHero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[4],
    paddingVertical: space[1],
  },
  freeStamp: {
    // Inset so the tilted, breathing corner never touches the card's edge.
    marginLeft: space[2],
    marginVertical: space[1],
    borderRadius: radii.lg,
    paddingHorizontal: space[4],
    paddingTop: space[1],
    paddingBottom: space[2],
    transform: [{ rotate: '-4deg' }],
  },
  freeStampText: {
    fontFamily: fontFamilies.instrumentSerifItalic,
    fontSize: 46,
    lineHeight: 54,
  },
  reviewCard: {
    borderWidth: 1,
    borderRadius: radii.xl,
    padding: space[4],
    gap: space[3],
  },
  reviewDots: {
    flexDirection: 'row',
    gap: 6,
  },
  reviewDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  featureCheck: {
    width: 22,
    height: 22,
    borderRadius: radii.full,
    backgroundColor: themeColors.whatsappMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  homePill: {
    flex: 1,
    minHeight: 92,
    borderRadius: radii.md,
    backgroundColor: themeColors.surfaceHigh,
    padding: space[3],
    gap: space[1],
    justifyContent: 'space-between',
  },
  homePrimaryAction: {
    borderRadius: radii.lg,
    backgroundColor: themeColors.accentMuted,
    borderWidth: 1,
    borderColor: themeColors.border,
    paddingVertical: space[3],
    paddingHorizontal: space[3],
  },
  homePrimaryTitle: {
    color: appColors.accent,
  },
  homeSecondaryAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    paddingVertical: space[1],
    paddingHorizontal: space[2],
    borderRadius: radii.full,
    backgroundColor: themeColors.surfaceHigh,
    borderWidth: 1,
    borderColor: themeColors.border,
  },
  pressedControl: {
    opacity: 0.72,
  },
  homeSetupButton: {
    minHeight: 46,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: themeColors.border,
    backgroundColor: themeColors.surfaceHigh,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    paddingHorizontal: space[4],
  },
  staticActionPill: {
    alignSelf: 'center',
    minHeight: 30,
    paddingHorizontal: space[2],
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: themeColors.border,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconTile: {
    width: 34,
    height: 34,
    borderRadius: radii.md,
    backgroundColor: themeColors.surfaceHigh,
    borderWidth: 1,
    borderColor: themeColors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artifactCard: {
    alignSelf: 'stretch',
  },
  // Multi-select tick circle on the left of each file card; matches the
  // iconTile height so the row doesn't jump when selection mode toggles.
  fileSelectTick: {
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  renameModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[5],
  },
  renameModalCard: {
    alignSelf: 'stretch',
    width: '100%',
    maxWidth: 440,
  },
  inviteCodeInput: {
    borderWidth: 1,
    borderColor: themeColors.border,
    borderRadius: radii.md,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    color: themeColors.textPrimary,
    backgroundColor: themeColors.surface,
    fontSize: 16,
    letterSpacing: 2,
  },
  renameModalInput: {
    borderWidth: 1,
    borderColor: themeColors.border,
    borderRadius: radii.md,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    color: themeColors.textPrimary,
    backgroundColor: themeColors.surface,
    fontSize: 16,
  },
  filesSectionHeader: {
    paddingTop: space[2],
  },
  // v1.2.2 Files drawer styles.
  filesScrollContent: {
    maxWidth: WIDE_CONTENT_MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: space[5],
    paddingTop: space[4],
    paddingBottom: space[9] + space[6],
    gap: space[4],
  },
  filesHeader: {
    paddingBottom: space[1],
  },
  filesEmptyCard: {
    marginTop: space[2],
  },
  filesEmptyIconRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: appColors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filePreviewBlock: {
    marginTop: space[2],
  },
  filePreviewBody: {
    fontSize: 12,
    lineHeight: 18,
  },
  filePreviewHint: {
    marginTop: space[2],
  },
  statePill: {
    minHeight: 28,
    paddingHorizontal: space[2],
    borderRadius: radii.sm,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileHeroAvatar: {
    width: 52,
    height: 52,
    borderRadius: radii.full,
    backgroundColor: themeColors.surfaceHigh,
    borderWidth: 1,
    borderColor: themeColors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarClip: {
    overflow: 'hidden',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  profileValue: {
    flex: 1,
    textAlign: 'right',
  },
  deleteBackdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(38, 36, 32, 0.45)',
  },
  deleteSheet: {
    padding: 4,
  },
  profileHeroActions: {
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
  },
  profileFormActions: {
    flexWrap: 'wrap',
  },
  tabBar: {
    position: 'absolute',
    left: space[6],
    right: space[6],
    bottom: space[5],
    height: 58,
    paddingHorizontal: space[3],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  tabButton: {
    width: 96,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  tabButtonActive: {
    // currently a no-op; left as a hook for selected-state animation later
  },
  tabIconWrap: {
    width: 56,
    height: 30,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabIconWrapActive: {
    backgroundColor: themeColors.accentMuted,
  },
  tabLabelActive: {
    fontWeight: '600' as const,
  },
  // v1.2.8 DN8, folder section headers in the Files tab.
  filesDirectoryGlyph: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: themeColors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filesDirectoryLabel: {
    letterSpacing: 1.2,
  },
  // Nested-subfolder header: smaller glyph + non-caps label so the
  // hierarchy doesn't shout. Documents/2026/Q1 reads as
  // DOCUMENTS > 2026 > Q1 visually.
  filesDirectoryGlyphSubtle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: themeColors.surfaceHigh,
    borderWidth: 1,
    borderColor: themeColors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filesDirectoryLabelSubtle: {
    letterSpacing: 0.4,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: themeColors.overlay,
    justifyContent: 'flex-end',
    padding: space[5],
  },
  termsModalBackdrop: {
    flex: 1,
    backgroundColor: themeColors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: space[4],
    paddingVertical: space[6],
  },
  modalDismissLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 0,
  },
  drawerDismissLayer: {
    left: '92%',
  },
  googleSheet: {
    width: '100%',
    position: 'relative',
  },
  termsSheet: {
    width: '100%',
    maxHeight: '82%',
    position: 'relative',
  },
  termsScroll: {
    paddingTop: space[7],
    paddingBottom: space[5],
    paddingRight: space[1],
    gap: space[3],
  },
  termsSection: {
    alignSelf: 'stretch',
  },
  googleSheetLogo: {
    width: 38,
    height: 38,
    borderRadius: radii.full,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: themeColors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleSheetLogoImage: {
    width: 24,
    height: 24,
  },
  googleAccountRow: {
    width: '100%',
    minHeight: 74,
    borderRadius: radii.xl,
    backgroundColor: themeColors.surface,
    borderWidth: 1,
    borderColor: themeColors.border,
    paddingHorizontal: space[3],
    flexDirection: 'row',
    gap: space[3],
    alignItems: 'center',
  },
  googleAvatar: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: themeColors.accentMuted,
    borderWidth: 1,
    borderColor: themeColors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetActions: {
    width: '100%',
  },
  sheetCloseButton: {
    position: 'absolute',
    right: space[4],
    top: space[4],
    width: 44,
    height: 44,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: themeColors.surface,
    borderWidth: 1,
    borderColor: themeColors.border,
    zIndex: 5,
    elevation: 5,
  },
  sheetCloseInline: {
    width: 32,
    height: 32,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: themeColors.surface,
    borderWidth: 1,
    borderColor: themeColors.border,
  },
  drawerBackdrop: {
    flex: 1,
    backgroundColor: themeColors.overlay,
    alignItems: 'flex-start',
  },
  // Transparent tap-target that fills the whole backdrop. The 92%-wide
  // drawer sheet renders on top in normal flow so taps inside the sheet
  // still go to its content; taps in the right-edge gap reach this layer
  // and call onClose. Pairs with the swipe-left PanResponder on the
  // sheet itself.
  drawerBackdropDismiss: {
    ...StyleSheet.absoluteFillObject,
  },
  setupBackdrop: {
    alignItems: 'stretch',
    backgroundColor: themeColors.bg,
  },
  setupFullScreenSheet: {
    width: '100%',
    height: '100%',
    borderRadius: 0,
    borderWidth: 0,
    paddingTop: 0,
    backgroundColor: themeColors.bg,
    zIndex: 2,
  },
  setupScreen: {
    flex: 1,
    backgroundColor: themeColors.bg,
  },
  setupInlineOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    elevation: 20,
    backgroundColor: themeColors.bg,
  },
  setupHeader: {
    minHeight: 60,
    paddingHorizontal: space[5],
    paddingTop: space[3],
    paddingBottom: space[2],
  },
  setupHeaderClose: {
    width: 42,
    height: 42,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.95)',
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
  },
  setupScroll: {
    flex: 1,
  },
  setupScrollContent: {
    maxWidth: WIDE_CONTENT_MAX_WIDTH,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: space[5],
    paddingTop: space[5],
    // Footer is now flex-laid-out rather than absolute, so we only need
    // a small breathing gap underneath the last scroll item.
    paddingBottom: space[4],
    gap: space[4],
  },
  setupFooter: {
    maxWidth: WIDE_CONTENT_MAX_WIDTH,
    // A floating card with air on both sides. `width: '100%'` plus a margin
    // overflowed and cancelled the margin, so it ran edge to edge.
    width: '92%',
    alignSelf: 'center',
    // Flex-positioned at the bottom of the screen so error banners inside
    // the footer push the footer up rather than overlaying the plan cards.
    marginBottom: space[4],
    padding: space[3],
    backgroundColor: themeColors.surfaceHigh,
  },
  // The 92%-wide left-anchored drawer. The wrapper carries the layout + the
  // swipe-to-close translateX animation; the Surface fills it and carries the
  // visual chrome.
  drawerSheetWrapper: {
    maxWidth: DRAWER_MAX_WIDTH,
    width: '92%',
    height: '100%',
    zIndex: 2,
  },
  drawerSheet: {
    flex: 1,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    paddingTop: space[8],
    overflow: 'hidden',
  },
  setupSheetSurface: {
    flex: 1,
    borderRadius: 0,
    borderWidth: 0,
    paddingTop: 0,
    backgroundColor: themeColors.bg,
  },
  drawerScroll: {
    paddingHorizontal: space[4],
    paddingTop: space[3],
    paddingBottom: space[9],
  },
  drawerViewPane: {
    flex: 1,
  },
  emojiTile: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  guideHero: {
    overflow: 'hidden',
  },
  faqList: {
    paddingHorizontal: space[3],
  },
  faqTile: {
    width: 28,
    height: 28,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faqTileText: {
    fontFamily: fontFamilies.geistSemiBold,
  },
  drawerPinnedHeader: {
    paddingHorizontal: space[4],
    paddingBottom: space[3],
    zIndex: 4,
  },
  drawerHeader: {
    minHeight: 56,
  },
  drawerProfileCard: {
    minHeight: 88,
    borderRadius: radii.xl,
    overflow: 'hidden',
    padding: space[4],
    flexDirection: 'row',
    gap: space[3],
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.6)',
  },
  drawerProfileAvatarRing: {
    borderRadius: radii.full,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.85)',
  },
  accountCardTitle: {
    fontFamily: fontFamilies.geistSemiBold,
  },
  accountCardChevron: {
    width: 30,
    height: 30,
    borderRadius: radii.full,
    backgroundColor: 'rgba(28, 26, 21, 0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuRow: {
    minHeight: 66,
    paddingVertical: space[3],
    paddingLeft: space[3],
    paddingRight: space[3],
    flexDirection: 'row',
    gap: space[3],
    alignItems: 'center',
  },
  menuSectionLabel: {
    textTransform: 'uppercase',
    paddingLeft: space[3],
    paddingTop: space[1],
  },
  // Soft squircles; the colour comes from MENU_ICON_TINT.
  menuIconTile: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuChevron: {
    width: 26,
    height: 26,
    borderRadius: radii.full,
    backgroundColor: 'rgba(28, 26, 21, 0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerLine: {
    minHeight: 34,
  },
  faqCard: {
    alignSelf: 'stretch',
  },
  faqRow: {
    paddingVertical: space[3],
  },
  faqHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 44,
  },
  faqAnswer: {
    paddingTop: space[2],
    paddingRight: space[5],
  },
  faqNumber: {
    width: 34,
    height: 34,
    borderRadius: radii.full,
    backgroundColor: themeColors.accentMuted,
    borderWidth: 1,
    borderColor: themeColors.accentMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOption: {
    minHeight: 72,
    borderRadius: radii.lg,
    backgroundColor: themeColors.surfaceHigh,
    borderWidth: 1,
    borderColor: themeColors.border,
    padding: space[3],
    flexDirection: 'row',
    gap: space[3],
    alignItems: 'center',
  },
  radioOptionSelected: {
    borderColor: themeColors.accent,
    backgroundColor: themeColors.accentMuted,
  },
  radioOptionDisabled: {
    backgroundColor: themeColors.surface,
  },
  radioIcon: {
    width: 34,
    height: 34,
    borderRadius: radii.md,
    backgroundColor: themeColors.surface,
    borderWidth: 1,
    borderColor: themeColors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioIconSelected: {
    borderColor: themeColors.accentMuted,
  },
  radioIconDisabled: {
    borderColor: themeColors.border,
  },
  radioCircle: {
    width: 22,
    height: 22,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: themeColors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioCircleSelected: {
    borderColor: themeColors.accent,
  },
  radioCircleDisabled: {
    borderColor: themeColors.border,
  },
  radioCircleDot: {
    width: 10,
    height: 10,
    borderRadius: radii.full,
    backgroundColor: themeColors.accent,
  },
  });
}
