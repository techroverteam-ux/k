import { Redirect, Tabs } from 'expo-router';
import { useEffect } from 'react';
import { subscribe } from '@/api';
import { tradeFeedback } from '@/prefs';
import { inr, shortSymbol } from '@/theme';
import { toast } from '@/ui';
import { View, type ColorValue } from 'react-native';
import { homeFor, useAuth } from '@/auth';
import { Icon, type IconName } from '@/icons';
import { TermsGate } from '@/screens';
import { useTheme } from '@/theme';
import { useTabScreenOptions } from '@/tabs';

function TabIcon({ name, color, focused }: { name: IconName; color: ColorValue; focused: boolean }) {
  const t = useTheme();
  return <View style={{ width: 40, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: focused ? t.brandSoft : 'transparent' }}><Icon name={name} color={color} size={24} /></View>;
}
const ico = (name: IconName) => ({ color, focused }: { color: ColorValue; focused: boolean }) => <TabIcon name={name} color={color} focused={focused} />;

export default function TraderTabs() {
  const { me, ready } = useAuth();
  const t = useTheme();
  const opts = useTabScreenOptions(t);
  // Resting orders (limit / stop-loss / take-profit) fill later: tell the trader wherever they are.
  useEffect(() => {
    if (me?.role !== 'TRADER') return;
    return subscribe<{ orderUpdated: { status: string; type: string; side: string; quantity: number; fillPrice?: string; createdAt: string; filledAt?: string; instrument?: { symbol: string } } }>(
      `subscription { orderUpdated { status type side quantity fillPrice createdAt filledAt instrument { symbol } } }`, {},
      ({ orderUpdated: o }) => {
        if (o.status !== 'FILLED' || o.type === 'MARKET') return;
        if (o.filledAt && new Date(o.filledAt).getTime() - new Date(o.createdAt).getTime() < 1500) return;
        tradeFeedback('fill');
        const what = o.type === 'STOP_LOSS' ? 'Stop-loss triggered' : o.type === 'TAKE_PROFIT' ? 'Take-profit triggered' : 'Limit order filled';
        toast(`${what}: ${o.side === 'BUY' ? 'bought' : 'sold'} ${o.quantity} ${shortSymbol(o.instrument?.symbol ?? '')} at ₹${inr(o.fillPrice)}`);
      },
    );
  }, [me?.role]);
  if (!ready) return null;
  if (!me) return <Redirect href="/login" />;
  if (me.role !== 'TRADER') return <Redirect href={homeFor(me.role)} />;
  return (
    <>
      <Tabs initialRouteName="watchlist" screenOptions={{ ...opts, tabBarShowLabel: true, tabBarLabelPosition: 'below-icon', tabBarLabelStyle: { ...opts.tabBarLabelStyle, fontSize: 10, fontWeight: '600', textTransform: 'uppercase' } }}>
        <Tabs.Screen name="index" options={{ href: null }} />
        <Tabs.Screen name="watchlist" options={{ title: 'Watchlist', tabBarIcon: ico('eye') }} />
        <Tabs.Screen name="trade" options={{ title: 'Trade', tabBarIcon: ico('trend') }} />
        <Tabs.Screen name="positions" options={{ title: 'Positions', tabBarIcon: ico('briefcase') }} />
        <Tabs.Screen name="orders" options={{ title: 'Orders', tabBarIcon: ico('clipboard') }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: ico('settings') }} />
      </Tabs>
      <TermsGate />
    </>
  );
}
