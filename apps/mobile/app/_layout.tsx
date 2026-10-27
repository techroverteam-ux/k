import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '@/auth';
import { PrefsProvider, usePrefs } from '@/prefs';
import { useTheme } from '@/theme';
import { StepUpHost, ToastHost } from '@/ui';
import { KSplash } from '@/splash';

function Inner() {
  const { me, settings } = useAuth();
  const t = useTheme();
  const { prefs } = usePrefs();
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar style={prefs.theme === 'system' ? 'auto' : prefs.theme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />
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
