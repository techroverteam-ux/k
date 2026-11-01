import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppState, View } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useState } from 'react';
import { Logo } from '@/icons';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/auth';
import { PrefsProvider, usePrefs } from '@/prefs';
import { useTheme } from '@/theme';
import { StepUpHost, ToastHost } from '@/ui';
import { KSplash } from '@/splash';
import { LockScreen } from '@/lock';

function Inner() {
  const { me, settings, locked, ready } = useAuth();
  const t = useTheme();
  const { prefs } = usePrefs();
  // Root window colour follows the theme, so screen transitions and the keyboard never flash white in dark mode.
  useEffect(() => { void SystemUI.setBackgroundColorAsync(t.bg).catch(() => undefined); }, [t.bg]);
  // Privacy cover: the app switcher shows the logo, not balances (iOS snapshots on "inactive").
  const [away, setAway] = useState(false);
  useEffect(() => { const s = AppState.addEventListener('change', (st) => setAway(st !== 'active')); return () => s.remove(); }, []);
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar style={prefs.theme === 'system' ? 'auto' : prefs.theme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />
      {ready && locked && <LockScreen />}
      {away && me && !locked && <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', zIndex: 60 }}><Logo size={64} brand={t.brand} /></View>}
      <KSplash name={settings?.appName ?? 'The K'} />
      <StepUpHost mfa={!!me?.mfaEnabled} />
      <ToastHost />
    </View>
  );
}

export default function Root() {
  return (
    <SafeAreaProvider>
      <PrefsProvider>
        <AuthProvider>
          <Inner />
        </AuthProvider>
      </PrefsProvider>
    </SafeAreaProvider>
  );
}
