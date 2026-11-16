import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { isAppleSignInAvailable } from './appleSignIn';

// The official Sign in with Apple button, rendered iOS-only and lazily.
//
// Why lazy: expo-apple-authentication is a NATIVE module, and the house rule
// (learned the hard way with ExponentImagePicker, 2026-07-19) is that no
// native module is touched at import time. A static import at the top of
// App.tsx would evaluate on Android too and on any binary built before the
// module existed. So the module is dynamic-imported after mount, and until it
// resolves (or on Android, or below iOS 13, or if Apple sign-in is disabled
// in Settings) this renders nothing at all: the login screen simply shows
// Google + email, exactly as it does today on Android.
//
// Why the OFFICIAL button rather than a Pressable styled like the Google one:
// Apple's review guidance on Sign in with Apple button styling is strict, and
// the native ASAuthorizationAppleIDButton is the one rendering they can never
// argue with. It handles its own label, logo and corner radius.

type ButtonComponent = React.ComponentType<{
  buttonType: number;
  buttonStyle: number;
  cornerRadius: number;
  style: object;
  onPress: () => void;
}>;

interface LoadedButton {
  Button: ButtonComponent;
  type: number;
  style: number;
}

export function AppleSignInButton({ onPress, testID }: { onPress: () => void; testID?: string }) {
  const [loaded, setLoaded] = useState<LoadedButton | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let mounted = true;
    (async () => {
      try {
        if (!(await isAppleSignInAvailable())) return;
        const AppleAuthentication = await import('expo-apple-authentication');
        if (!mounted) return;
        setLoaded({
          Button: AppleAuthentication.AppleAuthenticationButton as unknown as ButtonComponent,
          type: AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN,
          // Black reads correctly on the app's warm off-white login screen in
          // both themes; the login background does not switch to near-black.
          style: AppleAuthentication.AppleAuthenticationButtonStyle.BLACK,
        });
      } catch {
        // No module, no button; the login screen stays Google + email.
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (!loaded) return null;
  const { Button, type, style } = loaded;
  return (
    <View testID={testID} style={styles.wrap}>
      <Button buttonType={type} buttonStyle={style} cornerRadius={28} style={styles.button} onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    alignSelf: 'center',
  },
  // Same footprint as the Google button above it (minHeight 56, full-round
  // corners via cornerRadius=28), so the two read as peers.
  button: {
    width: '100%',
    minHeight: 56,
  },
});
