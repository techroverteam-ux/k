import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from './icons';
import { riskAlarm } from './prefs';
import { FS, inr, R, S, useTheme } from './theme';
import { toast, useQuery } from './ui';

interface Risk { funds: string; loss: string; lossPct: number; state: 'OK' | 'WARN' | 'CUT'; warnPct: number; cutPct: number }
let lastLevel = 'OK'; // shared by every banner on screen, so the alarm sounds once

/**
 * Trader loss watch: a red bar when the loss passes the warning level (80% of funds by default) or after the
 * trades were cut automatically (95%). Beeps and vibrates when that first happens.
 */
export function RiskBanner() {
  const t = useTheme();
  const { data } = useQuery<{ riskStatus: Risk }>(`{ riskStatus { funds loss lossPct state warnPct cutPct } }`, undefined, 10_000);
  const r = data?.riskStatus;
  const level = !r ? 'OK' : r.state === 'CUT' || r.lossPct >= r.cutPct ? 'CUT' : r.state === 'WARN' || r.lossPct >= r.warnPct ? 'WARN' : 'OK';
  useEffect(() => {
    if (level !== 'OK' && level !== lastLevel) {
      riskAlarm();
      toast(level === 'CUT' ? 'Your trades were cut automatically' : `Loss alert: ${Math.floor(r?.lossPct ?? 0)}% of your funds`);
    }
    lastLevel = level;
  }, [level, r?.lossPct]);
  if (!r || level === 'OK') return null;
  const pct = Math.floor(r.lossPct);
  return (
    <Pressable accessibilityRole="alert" onPress={() => router.push('/trade')} style={{ flexDirection: 'row', gap: S[2], backgroundColor: t.neg, borderRadius: R.md, padding: S[3], alignItems: 'flex-start' }}>
      <Icon name="alert" size={20} color="#fff" />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: FS.md }}>{level === 'CUT' ? 'Trades cut automatically' : `Loss alert: ${pct}% of your funds`}</Text>
        <Text style={{ color: '#fff', fontSize: FS.sm, lineHeight: 18 }}>
          {level === 'CUT'
            ? `Loss reached ${pct}% (₹${inr(r.loss)} of ₹${inr(r.funds)}). New trades are paused. Tap to add funds.`
            : `You have lost ₹${inr(r.loss)} of ₹${inr(r.funds)}. At ${r.cutPct}% all your open trades are cut automatically.`}
        </Text>
      </View>
    </Pressable>
  );
}
