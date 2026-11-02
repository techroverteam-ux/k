/**
 * Animated K splash, played after every sign-in (and when the app opens with a saved session):
 * the tile pops in, the K's stem rises, the price line and leg open, the last-price dot pops, a ring pulses, the name fades in, then it lifts away.
 */
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { K } from './icons';
import { useTheme } from './theme';

let pending = false;
let active = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function requestSplash() { pending = true; emit(); }
/** True while the splash is on screen (so sheets like the consent gate wait for it). */
export function useSplashActive() {
  const [, force] = useState(0);
  useEffect(() => { const l = () => force((x) => x + 1); listeners.add(l); return () => void listeners.delete(l); }, []);
  return pending || active;
}

const SIZE = 112;
export function KSplash({ name }: { name: string }) {
  const t = useTheme();
  const [show, setShow] = useState(pending);
  const v = useRef({ tile: new Animated.Value(0), stem: new Animated.Value(0), arms: new Animated.Value(0), ring: new Animated.Value(0), name: new Animated.Value(0), bar: new Animated.Value(0), out: new Animated.Value(1) }).current;
  useEffect(() => { const l = () => pending && setShow(true); listeners.add(l); return () => void listeners.delete(l); }, []);
  useEffect(() => {
    if (!show) return;
    pending = false; active = true; emit();
    Object.values(v).forEach((a) => a.setValue(0)); v.out.setValue(1);
    let stop = false;
    AccessibilityInfo.isReduceMotionEnabled().catch(() => false).then((reduced) => {
      if (stop) return;
      const finish = () => { active = false; setShow(false); emit(); };
      if (reduced) {
        [v.tile, v.stem, v.arms, v.name, v.bar].forEach((a) => a.setValue(1));
        Animated.timing(v.out, { toValue: 0, delay: 500, duration: 250, useNativeDriver: true }).start(finish);
        return;
      }
      const ease = Easing.out(Easing.cubic);
      Animated.sequence([
        Animated.spring(v.tile, { toValue: 1, friction: 6, tension: 80, useNativeDriver: true }),
        Animated.timing(v.stem, { toValue: 1, duration: 320, easing: ease, useNativeDriver: true }),
        Animated.parallel([
          Animated.spring(v.arms, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }),
          Animated.timing(v.ring, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(v.name, { toValue: 1, duration: 380, delay: 120, easing: ease, useNativeDriver: true }),
          Animated.timing(v.bar, { toValue: 1, duration: 750, delay: 160, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
        Animated.timing(v.out, { toValue: 0, duration: 320, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]).start(finish);
    });
    return () => { stop = true; };
  }, [show, v]);
  if (!show) return null;
  const layer = (paths: [string, number][]) => (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
      <G stroke="#fff" strokeLinecap="round" strokeLinejoin="round" fill="none">{paths.map(([d, w]) => <Path key={d} d={d} strokeWidth={w} />)}</G>
    </Svg>
  );
  return (
    <Animated.View accessibilityLabel={`Opening ${name}`} accessibilityRole="progressbar" style={[StyleSheet.absoluteFill, { zIndex: 100, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', opacity: v.out, transform: [{ scale: v.out.interpolate({ inputRange: [0, 1], outputRange: [1.05, 1] }) }] }]}>
      <View style={{ width: SIZE, height: SIZE }}>
        <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: 30, borderWidth: 2, borderColor: t.brand, opacity: v.ring.interpolate({ inputRange: [0, 0.05, 1], outputRange: [0, 0.55, 0] }), transform: [{ scale: v.ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.9] }) }] }]} />
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: v.tile, transform: [{ scale: v.tile.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }, { rotate: v.tile.interpolate({ inputRange: [0, 1], outputRange: ['-12deg', '0deg'] }) }] }]}>
          <Svg width={SIZE} height={SIZE} viewBox="0 0 100 100"><Rect width="100" height="100" rx="28" fill={t.brand} /></Svg>
          <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: '50% 78%', transform: [{ scaleY: v.stem }] }]}>{layer([[K.stem, K.w.stem]])}</Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: '26% 56%', opacity: v.arms, transform: [{ scale: v.arms }, { rotate: v.arms.interpolate({ inputRange: [0, 1], outputRange: ['-20deg', '0deg'] }) }] }]}>{layer([[K.line, K.w.line], [K.leg, K.w.leg]])}</Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: '72% 20%', opacity: v.name, transform: [{ scale: v.name.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1.35, 1] }) }] }]}>
            <Svg width={SIZE} height={SIZE} viewBox="0 0 100 100"><Circle cx={K.dot.cx} cy={K.dot.cy} r={K.dot.r} fill="#fff" /></Svg>
          </Animated.View>
        </Animated.View>
      </View>
      <Animated.Text style={{ marginTop: 20, fontSize: 22, fontWeight: '700', letterSpacing: 0.4, color: t.text, opacity: v.name, transform: [{ translateY: v.name.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }}>{name}</Animated.Text>
      <View style={{ marginTop: 16, width: 120, height: 3, borderRadius: 2, backgroundColor: t.bg3, overflow: 'hidden' }}>
        <Animated.View style={{ height: 3, width: 120, backgroundColor: t.brand, transform: [{ translateX: v.bar.interpolate({ inputRange: [0, 1], outputRange: [-120, 0] }) }] }} />
      </View>
    </Animated.View>
  );
}
