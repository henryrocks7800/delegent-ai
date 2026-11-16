// Root error boundary (GO_LIVE_TRACKER #15). Without this, ANY render/lifecycle
// exception in the tree unmounts to a blank white screen with no recovery but a
// force-kill — churn-grade for a paid app. This catches it, reports to Sentry,
// and shows a minimal "reload" fallback. It renders ABOVE the ThemeProvider, so
// the fallback is intentionally self-contained (no theme/provider dependencies)
// using the "Quiet" palette inline.
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Sentry, sentryEnabled } from './sentry';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class MobileErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (!sentryEnabled) return;
    try {
      Sentry.captureException(error, {
        extra: { componentStack: info?.componentStack ?? null },
        tags: { boundary: 'root' },
      });
    } catch {
      // Error reporting must never throw inside the boundary.
    }
  }

  private handleReload = (): void => {
    // Re-render the children. If the fault was transient (a bad snapshot, a
    // momentary null) the app recovers; if not, the fallback shows again.
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <View
        testID="app.errorBoundary"
        accessibilityLabel="app.errorBoundary"
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          gap: 12,
          backgroundColor: '#F7F4EE',
        }}
      >
        <Text style={{ fontSize: 18, fontWeight: '600', color: '#1F1D1A', textAlign: 'center' }}>
          Something went wrong
        </Text>
        <Text style={{ fontSize: 14, lineHeight: 20, color: '#5B564E', textAlign: 'center' }}>
          The app hit an unexpected error. Your data is safe. Try reloading.
        </Text>
        <Pressable
          onPress={this.handleReload}
          accessibilityRole="button"
          accessibilityLabel="app.errorBoundary.reload"
          testID="app.errorBoundary.reload"
          style={{ marginTop: 8, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 12, backgroundColor: '#5A6B4F' }}
        >
          <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>Reload</Text>
        </Pressable>
      </View>
    );
  }
}
