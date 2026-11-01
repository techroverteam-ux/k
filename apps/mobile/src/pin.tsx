/** MPIN entry: dots plus a big number pad, with an optional fingerprint key. Shakes on a wrong MPIN. */
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { Animated, Pressable, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Icon } from './icons';
import { S, useTheme } from './theme';
import { T, tap } from './ui';

export const MPIN_LEN = 4;

export interface PinHandle { shake: () => void }

export const PinDots = forwardRef<PinHandle, { value: string; length?: number; error?: boolean }>(function PinDots({ value, length = MPIN_LEN, error }, ref) {
  const t = useTheme();
  const x = useRef(new Animated.Value(0)).current;
  useImperativeHandle(ref, () => ({
    shake: () => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      Animated.sequence([10, -10, 8, -8, 4, 0].map((v) => Animated.timing(x, { toValue: v, duration: 45, useNativeDriver: true }))).start();
    },
  }), [x]);
  return (
    <Animated.View accessible accessibilityLabel={`${value.length} of ${length} digits entered`} style={{ flexDirection: 'row', gap: S[5], justifyContent: 'center', paddingVertical: S[4], transform: [{ translateX: x }] }}>
      {Array.from({ length }, (_, i) => {
        const on = i < value.length;
        return <View key={i} style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: error ? t.neg : on ? t.brand : t.line2, backgroundColor: on ? (error ? t.neg : t.brand) : 'transparent' }} />;
      })}
    </Animated.View>
  );
});

/** 1–9, then [fingerprint] 0 [delete]. */
export function Keypad({ value, onChange, length = MPIN_LEN, onBiometric, biometricLabel, disabled }: { value: string; onChange: (v: string) => void; length?: number; onBiometric?: () => void; biometricLabel?: string; disabled?: boolean }) {
  const t = useTheme();
  const press = (d: string) => { if (disabled || value.length >= length) return; tap('select'); onChange(value + d); };
  const Key = ({ children, onPress, label }: { children: React.ReactNode; onPress?: () => void; label: string }) => (
    <Pressable onPress={onPress} disabled={disabled || !onPress} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => ({ flex: 1, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? t.bg2 : 'transparent', opacity: disabled ? 0.5 : 1 })}>
      {children}
    </Pressable>
  );
  const rows = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']];
  return (
    <View style={{ gap: S[2], maxWidth: 320, width: '100%', alignSelf: 'center' }}>
      {rows.map((r) => (
        <View key={r[0]} style={{ flexDirection: 'row', gap: S[4] }}>
          {r.map((d) => <Key key={d} label={d} onPress={() => press(d)}><T style={{ fontSize: 28, fontWeight: '500' }}>{d}</T></Key>)}
        </View>
      ))}
      <View style={{ flexDirection: 'row', gap: S[4] }}>
        {onBiometric ? <Key label={`Unlock with ${biometricLabel ?? 'fingerprint'}`} onPress={onBiometric}><Icon name="fingerprint" size={30} color={t.brand} /></Key> : <View style={{ flex: 1 }} />}
        <Key label="0" onPress={() => press('0')}><T style={{ fontSize: 28, fontWeight: '500' }}>0</T></Key>
        <Key label="Delete" onPress={value ? () => { tap(); onChange(value.slice(0, -1)); } : undefined}><Icon name="backspace" size={26} color={value ? t.text : t.text3} /></Key>
      </View>
    </View>
  );
}
