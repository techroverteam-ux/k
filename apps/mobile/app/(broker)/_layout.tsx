import { Redirect, Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { homeFor, useAuth } from '@/auth';
import { Icon, type IconName } from '@/icons';
import { useTabScreenOptions } from '@/tabs';
import { useTheme } from '@/theme';

const ico = (n: IconName) => ({ color }: { color: ColorValue }) => <Icon name={n} color={color} size={24} />;
export default function BrokerTabs() {
  const { me, ready } = useAuth();
  const t = useTheme();
  const opts = useTabScreenOptions(t);
  if (!ready) return null;
  if (!me) return <Redirect href="/login" />;
  if (me.role !== 'BROKER') return <Redirect href={homeFor(me.role)} />;
  return (
    <Tabs screenOptions={opts}>
      <Tabs.Screen name="index" options={{ title: 'Dashboard', tabBarIcon: ico('grid') }} />
      <Tabs.Screen name="traders" options={{ title: 'Traders', tabBarIcon: ico('users') }} />
      <Tabs.Screen name="requests" options={{ title: 'Requests', tabBarIcon: ico('rupee') }} />
      <Tabs.Screen name="settings" options={{ title: 'Profile', tabBarIcon: ico('user') }} />
    </Tabs>
  );
}
