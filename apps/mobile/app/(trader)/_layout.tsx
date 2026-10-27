import { Redirect, Tabs } from 'expo-router';
import { useEffect } from 'react';
import { subscribe } from '@/api';
import { tradeFeedback } from '@/prefs';
import { inr, shortSymbol } from '@/theme';
import { toast } from '@/ui';
import type { ColorValue } from 'react-native';
import { homeFor, useAuth } from '@/auth';
import { Icon, type IconName } from '@/icons';
import { TermsGate } from '@/screens';
import { useTheme } from '@/theme';
import { useTabScreenOptions } from '@/tabs';

const ico = (n: IconName) => ({ color }: { color: ColorValue }) => <Icon name={n} color={color} size={24} />;

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
      <Tabs screenOptions={opts}>
        <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: ico('home') }} />
        <Tabs.Screen name="watchlist" options={{ title: 'Watchlist', tabBarIcon: ico('eye') }} />
        <Tabs.Screen name="positions" options={{ title: 'Portfolio', tabBarIcon: ico('briefcase') }} />
        <Tabs.Screen name="trade" options={{ title: 'Funds', tabBarIcon: ico('wallet') }} />
        <Tabs.Screen name="settings" options={{ title: 'Profile', tabBarIcon: ico('user') }} />
        <Tabs.Screen name="orders" options={{ href: null }} />
      </Tabs>
      <TermsGate />
    </>
  );
}
