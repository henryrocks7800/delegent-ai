import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readAndroidInstallReferrer } from '../analytics/installReferrerClient';
import { advertisingLease } from '../analytics/metaSdkClient';
import { track } from '../analytics/analyticsClient';
import { advertSeenKey, readFirstPaywallAdvert, type PaywallAdvert } from './advertContinuity';

const shownThisLaunch = new Set<string>();

export function usePaywallAdvert(userId: string, visible: boolean, eligible: boolean): PaywallAdvert | null {
  const [choice, setChoice] = useState<{ userId: string; advert: PaywallAdvert } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!visible || !eligible) { setChoice(null); return; }
    if (shownThisLaunch.has(userId)) return;
    const lease = advertisingLease();
    if (!lease || lease.userId !== userId) return;
    void readFirstPaywallAdvert({ userId, platform: Platform.OS,
      getItem: (key) => AsyncStorage.getItem(key), getReferrer: () => readAndroidInstallReferrer(lease),
    }).then((advert) => {
      if (cancelled || !lease.valid() || !advert || shownThisLaunch.has(userId)) return;
      shownThisLaunch.add(userId);
      setChoice({ userId, advert });
      track('paywall_personalized', { advert });
      return AsyncStorage.setItem(advertSeenKey(userId), '1');
    }).catch(() => undefined); // Attribution cannot block viewing or buying.
    return () => { cancelled = true; };
  }, [userId, visible, eligible]);
  return visible && eligible && choice?.userId === userId ? choice.advert : null;
}
