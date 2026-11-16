// Keeps the money check (moneyIntent.ts) on the device, so the rest of the
// journey can carry the thread: the email apps open first, the summary and the
// plan screen name the job, and the greeting offers to find the money.
//
// AsyncStorage is already used by the shipped binaries (src/analytics,
// src/auth), so this is safe over the air.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { parseMoneyIntent, type MoneyIntent } from './moneyIntent';

const KEY = 'delegent.moneyCheck.v1';

export async function saveMoneyIntent(intent: Omit<MoneyIntent, 'savedAt'>): Promise<MoneyIntent> {
  const value: MoneyIntent = { ...intent, savedAt: new Date().toISOString() };
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // A device that cannot store this simply gets the ordinary journey.
  }
  return value;
}

export async function loadMoneyIntent(): Promise<MoneyIntent | null> {
  try {
    return parseMoneyIntent(await AsyncStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** The stored check, read once. `loaded` is false until the read has finished. */
export function useMoneyIntent(): { intent: MoneyIntent | null; loaded: boolean; setIntent: (intent: MoneyIntent | null) => void } {
  const [intent, setIntent] = useState<MoneyIntent | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void loadMoneyIntent().then((value) => {
      if (!live) return;
      setIntent(value);
      setLoaded(true);
    });
    return () => { live = false; };
  }, []);
  return { intent, loaded, setIntent };
}
