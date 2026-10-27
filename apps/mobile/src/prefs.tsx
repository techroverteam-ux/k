/**
 * Per-device display preferences (theme, hide balances, charts, trade sounds, number size, bold numbers,
 * watchlist rows). Stored on this device only; nothing here affects money or permissions.
 */
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  hideBalances: boolean;
  charts: boolean;
  sounds: boolean;
  numberSize: 'S' | 'M' | 'L' | 'XL';
  boldNumbers: boolean;
  watchlistView: 'simple' | 'detailed';
}
export const DEFAULT_PREFS: Prefs = { theme: 'system', hideBalances: false, charts: true, sounds: true, numberSize: 'M', boldNumbers: false, watchlistView: 'detailed' };
export const NUM_SCALE: Record<Prefs['numberSize'], number> = { S: 0.92, M: 1, L: 1.1, XL: 1.22 };
const KEY = 'td_prefs_v1';

const store = {
  get: async () => (Platform.OS === 'web' ? globalThis.localStorage?.getItem(KEY) ?? null : SecureStore.getItemAsync(KEY)),
  set: async (v: string) => (Platform.OS === 'web' ? globalThis.localStorage?.setItem(KEY, v) : SecureStore.setItemAsync(KEY, v)),
};

const Ctx = createContext<{ prefs: Prefs; set: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void }>({ prefs: DEFAULT_PREFS, set: () => undefined });
let current = DEFAULT_PREFS;

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  useEffect(() => {
    store.get().then((raw) => {
      if (!raw) return;
      try { current = { ...DEFAULT_PREFS, ...JSON.parse(raw) }; setPrefs(current); } catch { /* ignore corrupt prefs */ }
    }).catch(() => undefined);
  }, []);
  const set = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    setPrefs((cur) => {
      const next = { ...cur, [k]: v };
      current = next;
      store.set(JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);
  return <Ctx.Provider value={{ prefs, set }}>{children}</Ctx.Provider>;
}
export const usePrefs = () => useContext(Ctx);

/** Money figure, or dots when "Hide balances" is on. */
export function usePrivate() {
  const { prefs } = usePrefs();
  return (s: string, dots = 6) => (prefs.hideBalances ? '•'.repeat(dots) : s);
}

const SOUNDS = { fill: require('../assets/sounds/fill.wav'), placed: require('../assets/sounds/placed.wav'), reject: require('../assets/sounds/reject.wav') } as const;
const players: Partial<Record<keyof typeof SOUNDS, AudioPlayer>> = {};
/** Trade tone + haptic, if "Trade sounds" is on. */
export function tradeFeedback(kind: keyof typeof SOUNDS) {
  if (!current.sounds) return;
  try {
    const p = (players[kind] ??= createAudioPlayer(SOUNDS[kind]));
    p.seekTo(0);
    p.play();
  } catch { /* audio unavailable */ }
  if (Platform.OS !== 'web') {
    void Haptics.notificationAsync(kind === 'reject' ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  }
}
