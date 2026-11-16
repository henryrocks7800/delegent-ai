import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { Notice, Screen, Spinner } from './components/ui';
import { configReady } from './lib/env';
import { SignIn } from './features/auth/SignIn';
import { useAuth, type WebAuthUser } from './features/auth/useAuth';
import { ChatScreen } from './features/chat/ChatScreen';
import { FilesScreen } from './features/files/FilesScreen';
import { RoutinesScreen } from './features/routines/RoutinesScreen';
import { ConnectionsScreen } from './features/connections/ConnectionsScreen';
import { SkillsScreen } from './features/skills/SkillsScreen';
import { CommandsScreen } from './features/commands/CommandsScreen';
import { HelpScreen } from './features/help/HelpScreen';
import { FaqScreen } from './features/help/FaqScreen';
import { PlanScreen } from './features/billing/PlanScreen';
import { CapacityScreen } from './features/billing/CapacityScreen';
import { SupportScreen } from './features/support/SupportScreen';
import { ProfileScreen } from './features/profile/ProfileScreen';
import { LegalScreen } from './features/legal/LegalScreen';
import { AdminScreen } from './features/admin/AdminScreen';
import { OnboardingScreen } from './features/onboarding/OnboardingScreen';
import { ProductStateProvider, useProductStateContext } from './features/state/productStateContext';

export function App() {
  const auth = useAuth();

  if (auth.status === 'unconfigured') return <NotConfigured />;
  if (auth.status === 'loading') return <FullScreenSpinner label="Signing you in…" />;
  if (auth.status === 'signed_out') return <SignIn message={auth.message} />;

  return (
    <ProductStateProvider user={auth.user}>
      <SignedInApp user={auth.user} />
    </ProductStateProvider>
  );
}

function SignedInApp({ user }: { user: WebAuthUser }) {
  const { status, gate, errorMessage, refresh } = useProductStateContext();

  if (status === 'loading') return <FullScreenSpinner label="Loading your workspace…" />;

  if (status === 'error') {
    return (
      <Shell user={user}>
        <Screen title="Something went wrong">
          <Notice tone="danger">{errorMessage ?? 'We could not load your workspace.'}</Notice>
          <button className="btn-primary mt-4" type="button" onClick={refresh}>
            Try again
          </button>
        </Screen>
      </Shell>
    );
  }

  // The one gate that blocks the whole app: without an accepted acknowledgement
  // there is no profile row for anything else to read.
  if (gate?.kind === 'needs_acknowledgement') return <OnboardingScreen onDone={refresh} />;

  return (
    <Shell user={user}>
      <ChatSurface user={user} />
      <Routes>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        {/* Rendered above instead, so it is not torn down by every tab change. */}
        <Route path="/chat" element={null} />
        <Route path="/files" element={<FilesScreen />} />
        <Route path="/routines" element={<RoutinesScreen />} />
        <Route path="/connections" element={<ConnectionsScreen key={user.id} userId={user.id} />} />
        <Route path="/skills" element={<SkillsScreen />} />
        <Route path="/commands" element={<CommandsScreen />} />
        <Route path="/help" element={<HelpScreen />} />
        <Route path="/faq" element={<FaqScreen />} />
        <Route path="/plan" element={<PlanScreen />} />
        <Route path="/capacity" element={<CapacityScreen />} />
        <Route path="/support" element={<SupportScreen />} />
        <Route path="/profile" element={<ProfileScreen />} />
        <Route path="/legal" element={<LegalScreen />} />
        {/* Owner dashboard. Deliberately unlinked from all navigation: the
            Worker enforces the admin allowlist server-side, and everyone else
            gets a polite refusal if they ever type the URL. */}
        <Route path="/admin" element={<AdminScreen />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Shell>
  );
}

// The chat surface is an iframe holding a live conversation: the rendered
// history, a reply that may still be arriving, and whatever is half-typed in
// the composer. A route swap unmounts it and throws all three away, so someone
// who looks something up in Files loses the answer they were waiting for. The
// phone keeps its chat tab mounted; this is how the browser matches it. Hidden
// with display:none, which also takes it out of the tab order and the
// accessibility tree, so nothing offscreen is reachable.
function ChatSurface({ user }: { user: WebAuthUser }) {
  const location = useLocation();
  const showing = location.pathname === '/chat';
  return (
    <div className={showing ? 'h-full' : 'hidden'}>
      <ChatScreen user={user} />
    </div>
  );
}

function NotFound() {
  const location = useLocation();
  return (
    <Screen title="Page not found" subtitle={`Nothing lives at ${location.pathname}.`}>
      {/* Link, not an anchor. An href reloads the document, which on a static
          host is a second request for a path the router owns: it needs a
          rewrite rule to survive at all, and even where it does the reader
          pays a white flash and a fresh sign-in check to move one screen. */}
      <Link className="btn-primary inline-flex" to="/chat">
        Go to chat
      </Link>
    </Screen>
  );
}

function FullScreenSpinner({ label }: { label: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner label={label} />
    </div>
  );
}

function NotConfigured() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5">
      <p className="font-brand text-display-lg italic text-textPrimary">Delegent AI</p>
      <div className="mt-4">
        <Notice tone="warning">
          {configReady
            ? 'Sign-in is unavailable right now. Please try again shortly.'
            : 'This build is missing its configuration, so it cannot reach your account. Please try again later.'}
        </Notice>
      </div>
    </main>
  );
}
