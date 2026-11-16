import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { captureInstallReferrerWith, type CaptureResult } from './installReferrer';
import type { AdvertisingLease } from './advertisingConsent';
import { advertisingAccessToken } from './advertisingConsentApi';

// No raw referrer cache survives withdrawal or an account switch.
export async function readAndroidInstallReferrer(lease: AdvertisingLease): Promise<string> {
  if (Platform.OS !== 'android' || !lease.valid()) return '';
  const mod = (await import('expo-application')) as { getInstallReferrerAsync?: () => Promise<string> };
  if (!lease.valid()) return '';
  const raw = typeof mod.getInstallReferrerAsync === 'function' ? await mod.getInstallReferrerAsync() : '';
  return lease.valid() ? raw : '';
}

export async function captureInstallReferrer(apiBaseUrl: string, lease: AdvertisingLease): Promise<CaptureResult> {
  if (Platform.OS !== 'android') return { status: 'skipped', reason: 'not_android' };
  if (!apiBaseUrl || !lease.valid()) return { status: 'skipped', reason: 'no_consent' };
  return captureInstallReferrerWith({
    allowed: lease.valid,
    storage: {
      getItem: (key) => AsyncStorage.getItem(`${key}.v2.${lease.userId}`),
      setItem: (key, value) => AsyncStorage.setItem(`${key}.v2.${lease.userId}`, value),
    },
    getInstallReferrer: () => readAndroidInstallReferrer(lease),
    post: async (body) => {
      const accessToken = await advertisingAccessToken(lease.userId);
      if (!accessToken || !lease.valid()) return false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/install/referrer`, {
          method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(body),
        });
        return res.ok;
      } finally { clearTimeout(timer); }
    },
  });
}
