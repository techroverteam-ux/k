/**
 * "Is this screen actually in use?" Polling and live prices pause when the screen isn't focused
 * (other tab, pushed under another screen) or the app is in the background, and resume on return.
 */
import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

let appState: AppStateStatus = AppState.currentState ?? 'active';
const listeners = new Set<(s: AppStateStatus) => void>();
AppState.addEventListener('change', (s) => {
  appState = s;
  listeners.forEach((l) => l(s));
});

/** True while the app is in the foreground. */
export function useAppActive(): boolean {
  const [s, setS] = useState(appState);
  useEffect(() => {
    listeners.add(setS);
    setS(appState);
    return () => void listeners.delete(setS);
  }, []);
  return s === 'active';
}

/** True while this screen is focused and the app is in the foreground. */
export function useActive(): boolean {
  const focused = useIsFocused();
  const app = useAppActive();
  return focused && app;
}
