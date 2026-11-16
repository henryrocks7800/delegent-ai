// Ask for notification permission and hand our device token to the Worker.
//
// The phone holds ONLY its own FCM registration token, which is useless to
// anyone else. The signing credential that actually sends notifications lives
// in the Worker and never comes near the app — same boundary as the OpenRouter
// key.
//
// We deliberately send the NATIVE device token (getDevicePushTokenAsync), not
// an Expo push token, because the Worker talks to Google directly rather than
// routing through Expo's push service. See apps/worker/src/push.ts for why.
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Stay quiet while the user is actually in the app.
//
// This handler runs ONLY for a notification that arrives while the app is
// foregrounded; when the app is backgrounded or closed, Android shows the
// notification and this never runs. Returning false everywhere is therefore
// exactly "don't interrupt someone who is already looking at the screen".
//
// WHY THIS, AND NOT SERVER-SIDE PRESENCE TRACKING (2026-08-03). The first plan
// was for the app to report foreground/background to the Worker, which would
// then decide whom to skip. Alex pushed back on the amount of machinery and he
// was right. That design needed an endpoint, a stored per-device presence
// column and staleness handling, and its failure mode was the bad one: presence
// gets stuck on "foreground", the user is silently never notified again, and
// nothing looks broken. This version has no server state, no extra endpoint and
// no staleness, and when it fails it fails harmlessly — a notification you did
// not need. It is also what Slack, WhatsApp and Discord do: the device you are
// actively using stays quiet.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export type PushRegistrationResult =
  | { status: 'registered' }
  | { status: 'denied' }
  | { status: 'unsupported' }
  | { status: 'failed'; reason: string };

/**
 * Android 13+ requires a runtime permission for notifications. Asking on first
 * launch, before the user has any idea what the app does, is the reliable way
 * to get a permanent "no" — the caller decides WHEN to invoke this, and should
 * pick a moment where the value is obvious.
 */
export async function registerForPushNotifications(
  apiBaseUrl: string,
  accessToken: string,
): Promise<PushRegistrationResult> {
  // An emulator without Play Services cannot receive push at all. Treat that as
  // unsupported rather than as a failure worth reporting to the user.
  if (!Device.isDevice) return { status: 'unsupported' };

  try {
    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      const requested = await Notifications.requestPermissionsAsync();
      granted = requested.granted;
    }
    if (!granted) return { status: 'denied' };

    if (Platform.OS === 'android') {
      // Android needs a channel before anything will show. The id must match
      // the channel_id the Worker sets on every send.
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Your coworker',
        importance: Notifications.AndroidImportance.DEFAULT,
        lightColor: '#2C4A38',
      });
    }

    const devicePushToken = await Notifications.getDevicePushTokenAsync();
    const token = typeof devicePushToken?.data === 'string' ? devicePushToken.data : '';
    if (!token) return { status: 'failed', reason: 'no_token' };

    const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/push/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ token, platform: Platform.OS === 'ios' ? 'ios' : 'android' }),
    });
    if (!response.ok) return { status: 'failed', reason: `http_${response.status}` };
    return { status: 'registered' };
  } catch (error) {
    // Never surfaced to the user and never rethrown: failing to register for a
    // courtesy notification must not interrupt anything they were doing. The
    // app retries on the next launch.
    return { status: 'failed', reason: error instanceof Error ? error.name : 'unknown' };
  }
}
