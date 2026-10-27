import { Redirect, Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { homeFor, useAuth } from '@/auth';
import { Icon, type IconName } from '@/icons';
import { useTabScreenOptions } from '@/tabs';
import { useTheme } from '@/theme';

const ico = (n: IconName) => ({ color }: { color: ColorValue }) => <Icon name={n} color={color} size={24} />;
export default function AdminTabs() {
  const { me, ready } = useAuth();
  const t = useTheme();
  const opts = useTabScreenOptions(t);
  if (!ready) return null;
  if (!me) return <Redirect href="/login" />;
  if (me.role !== 'SUPER_ADMIN') return <Redirect href={homeFor(me.role)} />;
  return (
    <Tabs screenOptions={opts}>
      <Tabs.Screen name="index" options={{ title: 'Overview', tabBarIcon: ico('grid') }} />
      <Tabs.Screen name="payments" options={{ title: 'Approvals', tabBarIcon: ico('rupee') }} />
      <Tabs.Screen name="settings" options={{ title: 'Profile', tabBarIcon: ico('user') }} />
    </Tabs>
  );
}
