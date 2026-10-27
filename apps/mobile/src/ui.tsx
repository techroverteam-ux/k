/**
 * Native component kit. Every screen composes these; no screen styles its own buttons, inputs or rows.
 */
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Animated, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput,
  View, type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError, gql, onLiveState, setStepUpHandler } from './api';
import { Icon, Logo, type IconName } from './icons';
import { CTL, FS, inr, R, S, toneOfValue, useTheme } from './theme';
import { NUM_SCALE, usePrefs } from './prefs';

/* ============================================================== text */
type TV = 'h1' | 'h2' | 'h3' | 'body' | 'sm' | 'xs' | 'num' | 'numLg' | 'hero';
export function T({ v = 'body', c, w, style, children, ...p }: { v?: TV; c?: 'text' | 'text2' | 'text3' | 'pos' | 'neg' | 'brand' | 'warn'; w?: '400' | '500' | '600' | '700'; style?: TextStyle; children: ReactNode; numberOfLines?: number; accessibilityRole?: 'header' | 'text' | 'alert' }) {
  const t = useTheme();
  const { prefs } = usePrefs();
  const k = NUM_SCALE[prefs.numberSize];
  const numeric = v === 'num' || v === 'numLg' || v === 'hero';
  const base: Record<TV, TextStyle> = {
    hero: { fontSize: FS.x4, fontWeight: '600', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
    h1: { fontSize: FS.x3, fontWeight: '600', letterSpacing: -0.3 },
    h2: { fontSize: FS.xl, fontWeight: '600' },
    h3: { fontSize: FS.lg, fontWeight: '600' },
    body: { fontSize: FS.md, lineHeight: 20 },
    sm: { fontSize: FS.sm, lineHeight: 18 },
    xs: { fontSize: FS.xs, lineHeight: 16 },
    num: { fontSize: FS.md, fontVariant: ['tabular-nums'], fontWeight: '600' },
    numLg: { fontSize: FS.x2, fontVariant: ['tabular-nums'], fontWeight: '600' },
  };
  const color = t[c ?? (v === 'xs' ? 'text3' : 'text')];
  const numStyle: TextStyle | null = numeric ? { fontSize: ((style?.fontSize as number | undefined) ?? (base[v].fontSize as number)) * k, ...(prefs.boldNumbers ? { fontWeight: '700' } : null) } : null;
  return <Text {...p} style={[base[v], { color }, w ? { fontWeight: w } : null, style, numStyle]} accessibilityRole={p.accessibilityRole ?? (v === 'h1' || v === 'h2' ? 'header' : undefined)}>{children}</Text>;
}

/* ============================================================== layout */
/** Screen = safe area + app header + optional pull-to-refresh. */
export function Screen({ children, onRefresh, title, back, right, scroll = true, footer, pad = true }: { children: ReactNode; onRefresh?: () => Promise<unknown>; title?: string; back?: boolean; right?: ReactNode; scroll?: boolean; footer?: ReactNode; pad?: boolean }) {
  const t = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const body = <View style={{ paddingHorizontal: pad ? S[4] : 0, paddingTop: S[4], paddingBottom: S[8], gap: S[5] }}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
      <Header title={title} back={back} right={right} />
      <LiveBanner />
      {scroll ? (
        <ScrollView keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic"
          refreshControl={onRefresh ? <RefreshControl tintColor={t.brand} colors={[t.brand]} refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await onRefresh(); setRefreshing(false); }} /> : undefined}>
          {body}
        </ScrollView>
      ) : <View style={{ flex: 1 }}>{body}</View>}
      {footer}
    </SafeAreaView>
  );
}

function Header({ title, back, right }: { title?: string; back?: boolean; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: S[2], gap: S[2], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }}>
      {back ? (
        <IconButton icon="chevronLeft" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      ) : (
        <View style={{ paddingLeft: S[2] }}><Logo size={28} brand={t.brand} /></View>
      )}
      <T v="h3" style={{ flex: 1 }} numberOfLines={1} accessibilityRole="header">{title ?? 'The K'}</T>
      {right}
    </View>
  );
}

function LiveBanner() {
  const t = useTheme();
  const [s, setS] = useState<'idle' | 'live' | 'reconnecting'>('idle');
  useEffect(() => onLiveState(setS), []);
  if (s !== 'reconnecting') return null;
  return (
    <View accessibilityRole="alert" style={{ flexDirection: 'row', gap: S[2], alignItems: 'center', backgroundColor: t.warnSoft, paddingHorizontal: S[4], paddingVertical: S[2] }}>
      <Icon name="wifiOff" size={16} color={t.warn} /><T v="sm" c="warn">Live prices reconnecting… showing the last prices received.</T>
    </View>
  );
}

export function IconButton({ icon, label, onPress, badge }: { icon: IconName; label: string; onPress: () => void; badge?: number }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
      style={({ pressed }) => ({ width: CTL.tap, height: CTL.tap, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? t.bg3 : 'transparent' })}>
      <Icon name={icon} color={t.text2} />
      {!!badge && <View style={{ position: 'absolute', top: 6, right: 6, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: t.neg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 }}><Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{badge > 9 ? '9+' : badge}</Text></View>}
    </Pressable>
  );
}

export function Row({ children, style, gap = S[3] }: { children: ReactNode; style?: ViewStyle; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}
export function Spread({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: S[3] }, style]}>{children}</View>;
}
export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line }} />;
}
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: S[2] }}>
      <Spread><T v="h2">{title}</T>{action}</Spread>
      {children}
    </View>
  );
}

/* ============================================================== controls */
type BK = 'primary' | 'secondary' | 'buy' | 'sell' | 'danger' | 'ghost';
export function Button({ title, onPress, kind = 'secondary', disabled, busy, size = 'md', icon, block }: { title: string; onPress: () => void; kind?: BK; disabled?: boolean; busy?: boolean; size?: 'sm' | 'md' | 'lg'; icon?: IconName; block?: boolean }) {
  const t = useTheme();
  const bg = { primary: t.brand, buy: t.pos, sell: t.neg, secondary: t.bg, danger: t.bg, ghost: 'transparent' }[kind];
  const fg = { primary: t.brandInk, buy: '#fff', sell: '#fff', secondary: t.text, danger: t.neg, ghost: t.brand }[kind];
  const border = kind === 'secondary' || kind === 'danger' ? t.line2 : 'transparent';
  const h = { sm: CTL.hSm, md: CTL.h, lg: CTL.hLg }[size];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }} onPress={onPress} disabled={disabled || busy}
      style={({ pressed }) => ({ height: h, minWidth: CTL.tap, paddingHorizontal: size === 'sm' ? S[3] : S[4], borderRadius: R.md, borderWidth: 1, borderColor: border, backgroundColor: pressed ? (kind === 'secondary' || kind === 'danger' || kind === 'ghost' ? t.bg3 : t.brandPressed) : bg, opacity: disabled ? 0.45 : 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S[2], alignSelf: block ? 'stretch' : undefined, flex: block ? 1 : undefined })}>
      {busy ? <ActivityIndicator color={fg} /> : <>{icon && <Icon name={icon} size={18} color={fg} />}<Text style={{ color: fg, fontWeight: '600', fontSize: size === 'sm' ? FS.sm : size === 'lg' ? FS.lg : FS.md }}>{title}</Text></>}
    </Pressable>
  );
}

export function Field({ label, error, hint, prefix, ...p }: TextInputProps & { label: string; error?: string | null; hint?: string; prefix?: string }) {
  const t = useTheme();
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <T v="sm" c="text2" w="500">{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', height: CTL.h + 4, borderWidth: 1, borderRadius: R.md, borderColor: error ? t.neg : focus ? t.brand : t.line2, backgroundColor: p.editable === false ? t.bg2 : t.bg, paddingHorizontal: S[3], gap: S[2] }}>
        {prefix && <T c="text2">{prefix}</T>}
        <TextInput accessibilityLabel={label} placeholderTextColor={t.text3} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} style={{ flex: 1, fontSize: FS.lg, color: t.text, height: '100%' }} {...p} />
      </View>
      {error ? <T v="sm" c="neg" accessibilityRole="alert">{error}</T> : hint ? <T v="xs">{hint}</T> : null}
    </View>
  );
}

export function SearchBox({ value, onChangeText, placeholder, autoFocus }: { value: string; onChangeText: (v: string) => void; placeholder: string; autoFocus?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: S[2], height: CTL.h, backgroundColor: t.bg2, borderRadius: R.md, paddingHorizontal: S[3] }}>
      <Icon name="search" size={18} color={t.text3} />
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={t.text3} autoFocus={autoFocus} autoCapitalize="characters" autoCorrect={false} accessibilityLabel={placeholder} style={{ flex: 1, color: t.text, fontSize: FS.md, height: '100%' }} />
      {!!value && <Pressable accessibilityLabel="Clear search" onPress={() => onChangeText('')} hitSlop={8}><Icon name="x" size={18} color={t.text3} /></Pressable>}
    </View>
  );
}

/** Underline tabs. */
export function Tabs<K extends string>({ value, onChange, items, scroll, right }: { value: K; onChange: (k: K) => void; items: { k: K; label: string }[]; scroll?: boolean; right?: ReactNode }) {
  const t = useTheme();
  const inner = items.map((i) => {
    const on = value === i.k;
    return (
      <Pressable key={i.k} onPress={() => onChange(i.k)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={{ paddingVertical: S[3], marginRight: S[5], borderBottomWidth: 2, borderBottomColor: on ? t.brand : 'transparent', minHeight: CTL.tap, justifyContent: 'center' }}>
        <T c={on ? 'brand' : 'text2'} w={on ? '600' : '500'}>{i.label}</T>
      </Pressable>
    );
  });
  return (
    <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line, flexDirection: 'row', alignItems: 'center' }} accessibilityRole="tablist">
      {scroll ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>{inner}</ScrollView> : <View style={{ flexDirection: 'row', flex: 1 }}>{inner}</View>}
      {right}
    </View>
  );
}

/** Pill chips (filters, order type, period). */
export function Chips<K extends string>({ value, onChange, items }: { value: K; onChange: (k: K) => void; items: { k: K; label: string; disabled?: boolean }[] }) {
  const t = useTheme();
  return (
    <Row gap={S[2]} style={{ flexWrap: 'wrap' }}>
      {items.map((i) => {
        const on = value === i.k;
        return (
          <Pressable key={i.k} disabled={i.disabled} onPress={() => onChange(i.k)} accessibilityRole="button" accessibilityState={{ selected: on, disabled: !!i.disabled }}
            style={({ pressed }) => ({ height: CTL.hSm, paddingHorizontal: S[3], borderRadius: R.pill, borderWidth: 1, borderColor: on ? t.brand : t.line2, backgroundColor: on ? t.brandSoft : pressed ? t.bg3 : t.bg, justifyContent: 'center', opacity: i.disabled ? 0.4 : 1 })}>
            <T v="sm" c={on ? 'brand' : 'text2'} w="500">{i.label}</T>
          </Pressable>
        );
      })}
    </Row>
  );
}

/** Divider-separated pressable row (Groww-style list item). */
export function ListRow({ left, title, sub, right, onPress, label }: { left?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onPress?: () => void; label?: string }) {
  const t = useTheme();
  const body = (
    <>
      {left}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {typeof title === 'string' ? <T w="600" numberOfLines={1}>{title}</T> : title}
        {sub ? (typeof sub === 'string' ? <T v="xs" numberOfLines={2}>{sub}</T> : sub) : null}
      </View>
      {right}
    </>
  );
  const style = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: S[3], minHeight: CTL.row, paddingVertical: S[3], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line };
  if (!onPress) return <View style={style}>{body}</View>;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [style, { backgroundColor: pressed ? t.bg2 : 'transparent', marginHorizontal: -S[4], paddingHorizontal: S[4] }]}>{body}</Pressable>;
}

export function Mark({ text, tone }: { text: string; tone?: 'brand' | 'pos' | 'neg' }) {
  const t = useTheme();
  const bg = tone === 'brand' ? t.brandSoft : tone === 'pos' ? t.posSoft : tone === 'neg' ? t.negSoft : t.bg3;
  const fg = tone === 'brand' ? t.brand : tone === 'pos' ? t.pos : tone === 'neg' ? t.neg : t.text2;
  return <View style={{ width: 40, height: 40, borderRadius: R.md, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }} importantForAccessibility="no"><Text style={{ color: fg, fontWeight: '700', fontSize: FS.xs }}>{text.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()}</Text></View>;
}
export function IconMark({ icon, tone }: { icon: IconName; tone?: 'brand' | 'pos' | 'neg' | 'warn' }) {
  const t = useTheme();
  const bg = tone === 'brand' ? t.brandSoft : tone === 'pos' ? t.posSoft : tone === 'neg' ? t.negSoft : tone === 'warn' ? t.warnSoft : t.bg3;
  const fg = tone === 'brand' ? t.brand : tone === 'pos' ? t.pos : tone === 'neg' ? t.neg : tone === 'warn' ? t.warn : t.text2;
  return <View style={{ width: 40, height: 40, borderRadius: R.md, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={20} color={fg} /></View>;
}

/* ============================================================== data display */
export function Badge({ text, tone }: { text: string; tone?: 'ok' | 'bad' | 'warn' | 'info' }) {
  const t = useTheme();
  const map = { ok: [t.posSoft, t.pos], bad: [t.negSoft, t.neg], warn: [t.warnSoft, t.warn], info: [t.infoSoft, t.info] } as const;
  const [bg, fg] = tone ? map[tone] : [t.bg3, t.text2];
  return <View style={{ backgroundColor: bg, borderRadius: R.xs, paddingHorizontal: 8, height: 22, justifyContent: 'center', alignSelf: 'flex-start' }}><Text style={{ color: fg, fontWeight: '600', fontSize: FS.xs }}>{text}</Text></View>;
}
const STATUS: Record<string, [string, 'ok' | 'bad' | 'warn' | 'info' | undefined]> = {
  ACTIVE: ['Active', 'ok'], FILLED: ['Executed', 'ok'], POSTED: ['Completed', 'ok'], PENDING: ['Pending', 'warn'], REQUESTED: ['In review', 'warn'], OPEN: ['Open', 'warn'],
  REJECTED: ['Rejected', 'bad'], FAILED: ['Failed', 'bad'], SUSPENDED: ['Suspended', 'bad'], CANCELLED: ['Cancelled', undefined], CLOSED: ['Closed', undefined],
};
export const StatusBadge = ({ v }: { v: string }) => { const [l, tn] = STATUS[v] ?? [v, undefined]; return <Badge text={l} tone={tn} />; };

/** Change with arrow + sign (never colour alone). */
export function Change({ value, pct, size = 'sm', pctOnly }: { value?: string | null; pct?: string | null; size?: 'sm' | 'md'; pctOnly?: boolean }) {
  const t = useTheme();
  const { prefs } = usePrefs();
  if (!value) return <T v="sm" c="text3">—</T>;
  const tone = toneOfValue(value);
  const color = tone === 'pos' ? t.pos : tone === 'neg' ? t.neg : t.text2;
  return (
    <Row gap={2}>
      {tone !== 'flat' && <Icon name={tone === 'pos' ? 'up' : 'down'} size={size === 'sm' ? 12 : 14} color={color} strokeWidth={2} />}
      <Text style={{ color, fontSize: (size === 'sm' ? FS.xs : FS.md) * NUM_SCALE[prefs.numberSize], fontWeight: prefs.boldNumbers ? '700' : '500', fontVariant: ['tabular-nums'] }}>{pctOnly && pct ? `${inr(pct, true)}%` : `${inr(value, true)}${pct ? ` (${inr(pct, true)}%)` : ''}`}</Text>
    </Row>
  );
}

/** Divided metric strip (2 per row). */
export function Metrics({ items }: { items: { k: string; v: string | number; tone?: 'pos' | 'neg' | 'flat' }[] }) {
  const t = useTheme();
  return (
    <View style={{ borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.line, borderRadius: R.lg, flexDirection: 'row', flexWrap: 'wrap' }}>
      {items.map((m, i) => (
        <View key={m.k} style={{ width: '50%', padding: S[4], borderRightWidth: i % 2 === 0 ? StyleSheet.hairlineWidth * 2 : 0, borderBottomWidth: i < items.length - 2 ? StyleSheet.hairlineWidth * 2 : 0, borderColor: t.line, gap: 2 }}>
          <T v="xs" c="text2">{m.k}</T>
          <T v="num" c={m.tone && m.tone !== 'flat' ? m.tone : 'text'} style={{ fontSize: FS.lg }}>{String(m.v)}</T>
        </View>
      ))}
    </View>
  );
}

export function Lines({ lines }: { lines: [string, string | number][] }) {
  return (
    <View>
      {lines.map(([k, v], i) => (
        <View key={k}>
          {i > 0 && <Divider />}
          <Spread style={{ paddingVertical: S[3] }}><T c="text2">{k}</T><T v="num">{String(v)}</T></Spread>
        </View>
      ))}
    </View>
  );
}

/* ============================================================== states */
export function Skeleton({ rows = 4 }: { rows?: number }) {
  const t = useTheme();
  const o = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([Animated.timing(o, { toValue: 1, duration: 650, useNativeDriver: true }), Animated.timing(o, { toValue: 0.5, duration: 650, useNativeDriver: true })]));
    a.start();
    return () => a.stop();
  }, [o]);
  return (
    <Animated.View style={{ opacity: o, gap: S[4], paddingVertical: S[3] }} accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, i) => (
        <Row key={i}>
          <View style={{ width: 40, height: 40, borderRadius: R.md, backgroundColor: t.bg3 }} />
          <View style={{ flex: 1, gap: 6 }}><View style={{ height: 12, width: `${60 - (i % 3) * 10}%`, borderRadius: 4, backgroundColor: t.bg3 }} /><View style={{ height: 10, width: '30%', borderRadius: 4, backgroundColor: t.bg3 }} /></View>
          <View style={{ height: 12, width: 64, borderRadius: 4, backgroundColor: t.bg3 }} />
        </Row>
      ))}
    </Animated.View>
  );
}

export function Empty({ icon = 'inbox', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: S[10], paddingHorizontal: S[5], gap: S[2] }}>
      <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: t.bg3, alignItems: 'center', justifyContent: 'center', marginBottom: S[2] }}><Icon name={icon} color={t.text3} /></View>
      <T v="h3" style={{ textAlign: 'center' }}>{title}</T>
      {children ? <T v="sm" c="text2" style={{ textAlign: 'center' }}>{children}</T> : null}
      {action ? <View style={{ marginTop: S[3] }}>{action}</View> : null}
    </View>
  );
}

export function ErrorState({ error, retry }: { error: string | null; retry?: () => void }) {
  const t = useTheme();
  if (!error) return null;
  const offline = /network|connection/i.test(error);
  return (
    <View style={{ alignItems: 'center', paddingVertical: S[10], gap: S[2] }} accessibilityRole="alert">
      <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: t.negSoft, alignItems: 'center', justifyContent: 'center', marginBottom: S[2] }}><Icon name={offline ? 'wifiOff' : 'alert'} color={t.neg} /></View>
      <T v="h3">{offline ? "You're offline" : "Couldn't load this"}</T>
      <T v="sm" c="text2" style={{ textAlign: 'center' }}>{offline ? 'Check your connection and try again.' : error}</T>
      {retry && <View style={{ marginTop: S[3] }}><Button size="sm" title="Try again" onPress={retry} /></View>}
    </View>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'err' | 'ok'; children: ReactNode }) {
  const t = useTheme();
  const [bg, fg, icon] = { info: [t.infoSoft, t.info, 'info'], warn: [t.warnSoft, t.warn, 'info'], err: [t.negSoft, t.neg, 'alert'], ok: [t.posSoft, t.pos, 'check'] }[tone] as [string, string, IconName];
  return (
    <View accessibilityRole={tone === 'err' ? 'alert' : undefined} style={{ flexDirection: 'row', gap: S[2], backgroundColor: bg, borderRadius: R.md, padding: S[3], alignItems: 'flex-start' }}>
      <Icon name={icon} size={18} color={fg} />
      <Text style={{ color: fg, flex: 1, fontSize: FS.sm, lineHeight: 18 }}>{children}</Text>
    </View>
  );
}

/* ============================================================== sheets */
export function Sheet({ visible, title, sub, onClose, children, dismissable = true }: { visible: boolean; title: string; sub?: string; onClose: () => void; children: ReactNode; dismissable?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={dismissable ? onClose : () => undefined} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable style={StyleSheet.absoluteFill} onPress={dismissable ? onClose : undefined} accessibilityLabel="Close" accessibilityRole="button">
          <View style={{ flex: 1, backgroundColor: t.overlay }} />
        </Pressable>
        <View style={{ backgroundColor: t.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: S[5], paddingTop: S[3], paddingBottom: S[5] + insets.bottom, gap: S[4], maxHeight: '90%' }}>
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: t.line2 }} />
          <Spread>
            <View style={{ flex: 1 }}><T v="h2">{title}</T>{sub ? <T v="sm" c="text2" style={{ marginTop: 2 }}>{sub}</T> : null}</View>
            {dismissable && <IconButton icon="x" label="Close" onPress={onClose} />}
          </Spread>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: S[4] }}>{children}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ============================================================== data hook */
export function useQuery<T>(query: string, variables?: Record<string, unknown>, pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const vars = JSON.stringify(variables ?? {});
  const alive = useRef(true);
  const refetch = useCallback(async () => {
    try {
      const d = await gql<T>(query, JSON.parse(vars));
      if (alive.current) { setData(d); setError(null); }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally { if (alive.current) setLoading(false); }
  }, [query, vars]);
  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void refetch();
    const h = pollMs ? setInterval(refetch, pollMs) : undefined;
    return () => { alive.current = false; if (h) clearInterval(h); };
  }, [refetch, pollMs]);
  return { data, error, loading, refetch };
}

/* ============================================================== step-up */
export function StepUpHost({ mfa }: { mfa: boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const res = useRef<((v: string | null) => void) | null>(null);
  useEffect(() => {
    setStepUpHandler(() => new Promise((r) => { res.current = r; setValue(''); setErr(null); setOpen(true); }));
    return () => { setStepUpHandler(null); };
  }, []);
  const done = (v: string | null) => { res.current?.(v); res.current = null; setOpen(false); };
  return (
    <Sheet visible={open} title="Confirm it's you" sub="This action changes money or access, so we re-check your identity." onClose={() => done(null)}>
      <Field label={mfa ? '6-digit authenticator code' : 'Your password'} value={value} onChangeText={(v) => setValue(mfa ? v.replace(/\D/g, '') : v)} secureTextEntry={!mfa} keyboardType={mfa ? 'number-pad' : 'default'} maxLength={mfa ? 6 : 128} autoFocus textContentType={mfa ? 'oneTimeCode' : 'password'} error={err} />
      <Button title="Verify" kind="primary" size="lg" busy={busy} disabled={!value || (mfa && value.length !== 6)} onPress={async () => {
        setBusy(true); setErr(null);
        try { const d = await gql(`mutation($p:String,$t:String){ stepUp(password:$p, totp:$t){ token } }`, mfa ? { t: value } : { p: value }); done(d.stepUp.token); }
        catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
      }} />
    </Sheet>
  );
}

/* ============================================================== toast */
let toastFn: ((m: string, err?: boolean) => void) | null = null;
export const toast = (m: string, err?: boolean) => toastFn?.(m, err);
export function ToastHost() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [msg, setMsg] = useState<{ m: string; err?: boolean } | null>(null);
  useEffect(() => {
    toastFn = (m, err) => { setMsg({ m, err }); setTimeout(() => setMsg(null), 3500); };
    return () => { toastFn = null; };
  }, []);
  if (!msg) return null;
  return (
    <View pointerEvents="none" accessibilityLiveRegion="polite" style={{ position: 'absolute', left: S[4], right: S[4], bottom: insets.bottom + 72, backgroundColor: msg.err ? t.neg : t.text, borderRadius: R.md, padding: S[3], flexDirection: 'row', gap: S[2], alignItems: 'center' }}>
      <Icon name={msg.err ? 'alert' : 'check'} size={18} color={msg.err ? '#fff' : t.bg} />
      <Text style={{ color: msg.err ? '#fff' : t.bg, fontWeight: '500', flex: 1 }}>{msg.m}</Text>
    </View>
  );
}
