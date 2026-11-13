/**
 * Native component kit. Every screen composes these; no screen styles its own buttons, inputs or rows.
 */
import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import * as Haptics from 'expo-haptics';
import { useActive } from './active';
import {
  ActivityIndicator, Animated, Easing, FlatList, Keyboard, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput,
  View, type RefreshControlProps, type TextInputProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError, gql, onLiveState, setStepUpHandler } from './api';
import { Icon, Logo, type IconName } from './icons';
import { CTL, FS, inr, R, S, toneOfValue, useTheme } from './theme';
import { NUM_SCALE, usePrefs } from './prefs';

/* ============================================================== text */
type TV = 'h1' | 'h2' | 'h3' | 'body' | 'sm' | 'xs' | 'num' | 'numLg' | 'hero';
export function T({ v = 'body', c, w, style, children, ...p }: { v?: TV; c?: 'text' | 'text2' | 'text3' | 'pos' | 'neg' | 'brand' | 'warn'; w?: '400' | '500' | '600' | '700'; style?: TextStyle; children: ReactNode; adjustsFontSizeToFit?: boolean; minimumFontScale?: number; numberOfLines?: number; selectable?: boolean; accessibilityRole?: 'header' | 'text' | 'alert' }) {
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
/* Pull-to-refresh: every useQuery inside a Screen registers its refetch, so pulling down refreshes the whole screen. */
type Refresher = () => Promise<unknown>;
const RegisterCtx = createContext<((f: Refresher) => () => void) | null>(null);
const ControlCtx = createContext<ReactElement<RefreshControlProps> | undefined>(undefined);
/** The screen's RefreshControl, for a FlatList that replaces the screen's own scroll view. */
export const useRefreshControl = () => useContext(ControlCtx);

/** Screen = safe area + app header + pull-to-refresh (always on). With scroll={false}, a child list scrolls instead. */
export function Screen({ children, onRefresh, title, back, right, header, scroll = true, footer, pad = true }: { children: ReactNode; onRefresh?: () => Promise<unknown>; title?: string; back?: boolean; right?: ReactNode; header?: ReactNode; scroll?: boolean; footer?: ReactNode; pad?: boolean }) {
  const t = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const fns = useRef(new Set<Refresher>());
  const extra = useRef(onRefresh);
  extra.current = onRefresh;
  const register = useCallback((f: Refresher) => { fns.current.add(f); return () => void fns.current.delete(f); }, []);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await Promise.all([extra.current?.(), ...[...fns.current].map((f) => f())]); } catch { /* each query shows its own error */ } finally { setRefreshing(false); }
  }, []);
  const control = useMemo(() => <RefreshControl tintColor={t.brand} colors={[t.brand]} refreshing={refreshing} onRefresh={refresh} />, [refreshing, refresh, t.brand]);
  const body = <View style={{ paddingHorizontal: pad ? S[4] : 0, paddingTop: S[4], paddingBottom: S[8], gap: S[5] }}>{children}</View>;
  return (
    <RegisterCtx.Provider value={register}>
      <ControlCtx.Provider value={control}>
        <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top']}>
          {header ?? <Header title={title} back={back} right={right} />}
          <LiveBanner />
          {scroll ? (
            <ScrollView keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" refreshControl={control}>
              {body}
            </ScrollView>
          ) : <View style={{ flex: 1 }}>{children}</View>}
          {footer}
        </SafeAreaView>
      </ControlCtx.Provider>
    </RegisterCtx.Provider>
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

/* ============================================================== feedback */
/** Light tap feedback for buttons and selections (no-op where the device has no haptics). */
export const tap = (kind: 'light' | 'select' | 'heavy' = 'light') => {
  if (Platform.OS === 'web') return;
  if (kind === 'select') void Haptics.selectionAsync().catch(() => undefined);
  else void Haptics.impactAsync(kind === 'heavy' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
};

/* ============================================================== lists */
/**
 * Virtualised list that scrolls the whole screen (use inside <Screen scroll={false}>): only rows near the
 * viewport are mounted. `header` sits above the rows; pull-to-refresh comes from the screen.
 */
export function VList<T>({ data, render, keyOf, header, empty, footer }: { data: T[]; render: (item: T, index: number) => ReactElement; keyOf: (item: T) => string; header?: ReactNode; empty?: ReactElement | null; footer?: ReactElement | null }) {
  const control = useRefreshControl();
  return (
    <FlatList
      data={data}
      renderItem={({ item, index }) => render(item, index)}
      keyExtractor={keyOf}
      ListHeaderComponent={header ? <View style={{ gap: S[4], paddingBottom: S[2] }}>{header}</View> : null}
      ListEmptyComponent={empty ?? null}
      ListFooterComponent={footer ?? null}
      contentContainerStyle={{ paddingHorizontal: S[4], paddingTop: S[4], paddingBottom: S[8] }}
      refreshControl={control}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={12}
      maxToRenderPerBatch={10}
      windowSize={7}
      removeClippedSubviews={Platform.OS === 'android'}
    />
  );
}

/** Swipe a row left to reveal an action (e.g. Remove). A tap anywhere closes it again. */
export function SwipeRow({ children, action, actionLabel }: { children: ReactNode; action: () => void; actionLabel: string }) {
  const t = useTheme();
  const W = 96;
  const x = useRef(new Animated.Value(0)).current;
  const open = useRef(false);
  const settle = (to: number) => { open.current = to !== 0; Animated.spring(x, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 18 }).start(); };
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
    onPanResponderMove: (_e, g) => x.setValue(Math.max(-W * 1.3, Math.min(0, (open.current ? -W : 0) + g.dx))),
    onPanResponderRelease: (_e, g) => { const cur = (open.current ? -W : 0) + g.dx; if (cur < -W / 2 || g.vx < -0.5) { settle(-W); tap('select'); } else settle(0); },
    onPanResponderTerminate: () => settle(open.current ? -W : 0),
  }), [x]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={{ overflow: 'hidden' }}>
      <Pressable onPress={() => { settle(0); action(); }} accessibilityRole="button" accessibilityLabel={actionLabel}
        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: W, backgroundColor: t.neg, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#fff', fontWeight: '600' }}>{actionLabel}</Text>
      </Pressable>
      <Animated.View style={{ transform: [{ translateX: x }], backgroundColor: t.bg }} {...pan.panHandlers} onTouchEnd={() => { if (open.current) settle(0); }}>
        {children}
      </Animated.View>
    </View>
  );
}

/** Brief green / red wash behind a row when its price moves (animated on the native thread). */
export function Flash({ value, children, style }: { value?: string; children: ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  const o = useRef(new Animated.Value(0)).current;
  const prev = useRef(value);
  const [up, setUp] = useState(true);
  useEffect(() => {
    if (value && prev.current && value !== prev.current) {
      setUp(Number(value) > Number(prev.current));
      o.setValue(1);
      Animated.timing(o, { toValue: 0, duration: 700, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    }
    prev.current = value;
  }, [value, o]);
  return (
    <View style={style}>
      <Animated.View style={[StyleSheet.absoluteFill, { pointerEvents: 'none', backgroundColor: up ? t.posSoft : t.negSoft, opacity: o }]} />
      {children}
    </View>
  );
}

/* ============================================================== controls */
type BK = 'primary' | 'secondary' | 'buy' | 'sell' | 'danger' | 'ghost';
export function Button({ title, onPress, kind = 'secondary', disabled, busy, size = 'md', icon, block, fitLabel }: { title: string; onPress: () => void; kind?: BK; disabled?: boolean; busy?: boolean; size?: 'sm' | 'md' | 'lg'; icon?: IconName; block?: boolean; fitLabel?: boolean }) {
  const t = useTheme();
  const bg = { primary: t.brand, buy: t.pos, sell: t.neg, secondary: t.bg, danger: t.bg, ghost: 'transparent' }[kind];
  const fg = { primary: t.brandInk, buy: '#fff', sell: '#fff', secondary: t.text, danger: t.neg, ghost: t.brand }[kind];
  const border = kind === 'secondary' || kind === 'danger' ? t.line2 : 'transparent';
  const h = { sm: CTL.hSm, md: CTL.h, lg: CTL.hLg }[size];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }} onPress={() => { if (kind === 'primary' || kind === 'buy' || kind === 'sell') tap(); onPress(); }} disabled={disabled || busy}
      style={({ pressed }) => ({ height: h, minHeight: h, minWidth: CTL.tap, paddingHorizontal: fitLabel ? 6 : size === 'sm' ? S[3] : S[4], borderRadius: R.md, borderWidth: 1, borderColor: border, backgroundColor: pressed ? (kind === 'secondary' || kind === 'danger' || kind === 'ghost' ? t.bg3 : t.brandPressed) : bg, opacity: disabled ? 0.45 : 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S[2], alignSelf: block ? 'stretch' : undefined, flex: block ? 1 : undefined })}>
      {busy ? <ActivityIndicator color={fg} /> : <>{icon && <Icon name={icon} size={18} color={fg} />}<Text numberOfLines={fitLabel ? 1 : undefined} adjustsFontSizeToFit={fitLabel} minimumFontScale={0.8} style={{ color: fg, fontWeight: '600', flexShrink: fitLabel ? 1 : undefined, fontSize: size === 'sm' ? FS.sm : size === 'lg' ? FS.lg : FS.md }}>{title}</Text></>}
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
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={t.text3} autoFocus={autoFocus} autoCapitalize="characters" autoCorrect={false} accessibilityLabel={placeholder} style={{ flex: 1, minWidth: 0, color: t.text, fontSize: FS.md, height: '100%' }} />
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
      <Pressable key={i.k} onPress={() => { if (!on) tap('select'); onChange(i.k); }} accessibilityRole="tab" accessibilityState={{ selected: on }} style={{ paddingVertical: S[3], marginRight: S[5], borderBottomWidth: 2, borderBottomColor: on ? t.brand : 'transparent', minHeight: CTL.tap, justifyContent: 'center' }}>
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
export function Chips<K extends string>({ value, onChange, items, fill }: { fill?: boolean; value: K; onChange: (k: K) => void; items: { k: K; label: string; disabled?: boolean }[] }) {
  const t = useTheme();
  return (
    <Row gap={S[2]} style={{ flexWrap: fill ? 'nowrap' : 'wrap' }}>
      {items.map((i) => {
        const on = value === i.k;
        return (
          <Pressable key={i.k} disabled={i.disabled} onPress={() => { if (!on) tap('select'); onChange(i.k); }} accessibilityRole="button" accessibilityState={{ selected: on, disabled: !!i.disabled }}
            style={({ pressed }) => ({ height: fill ? CTL.h : CTL.hSm, flex: fill ? 1 : undefined, alignItems: fill ? 'center' : undefined, paddingHorizontal: fill ? S[2] : S[3], borderRadius: fill ? R.md : R.pill, borderWidth: 1, borderColor: on ? t.brand : t.line2, backgroundColor: on ? t.brandSoft : pressed ? t.bg3 : t.bg, justifyContent: 'center', opacity: i.disabled ? 0.4 : 1 })}>
            <T v="sm" c={on ? 'brand' : 'text2'} w="500">{i.label}</T>
          </Pressable>
        );
      })}
    </Row>
  );
}

/** Divider-separated pressable row (Groww-style list item). */
/** A list row. `action` (a button) sits beside the tappable area, never inside it, so taps don't collide. */
export function ListRow({ left, title, sub, right, onPress, label, action }: { left?: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onPress?: () => void; label?: string; action?: ReactNode }) {
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
  if (!onPress) return <View style={style}>{body}{action}</View>;
  if (action) return (
    <View style={[style, { paddingVertical: 0, marginHorizontal: -S[4], paddingRight: S[4] }]}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', gap: S[3], minHeight: CTL.row, paddingVertical: S[3], paddingLeft: S[4], backgroundColor: pressed ? t.bg2 : 'transparent' })}>{body}</Pressable>
      {action}
    </View>
  );
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
  const [mounted, setMounted] = useState(visible);
  const fade = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(600)).current;
  const height = useRef(600);
  const closing = useRef(false);
  const cb = useRef(onClose);
  cb.current = onClose;
  const animateIn = useCallback(() => {
    closing.current = false;
    y.setValue(height.current);
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.spring(y, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 16 }),
    ]).start();
  }, [fade, y]);
  const animateOut = useCallback((then?: () => void) => {
    if (closing.current) return;
    closing.current = true;
    Animated.parallel([
      Animated.timing(fade, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(y, { toValue: height.current, duration: 200, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start(({ finished }) => { if (!finished) return; setMounted(false); then?.(); });
  }, [fade, y]);
  useEffect(() => {
    if (visible) { setMounted(true); requestAnimationFrame(animateIn); }
    else if (mounted) animateOut();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Close with the exit animation, then tell the parent. */
  const close = useCallback(() => { if (dismissable) animateOut(() => cb.current()); }, [animateOut, dismissable]);
  // Drag the handle or title down to close.
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => dismissable && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => y.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_e, g) => {
      if (g.dy > Math.min(140, height.current * 0.3) || g.vy > 0.9) close();
      else Animated.spring(y, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 18 }).start();
    },
    onPanResponderTerminate: () => Animated.spring(y, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(),
  }), [dismissable, close, y]);
  // Android draws the app edge to edge, so a modal is not resized when the keyboard opens: lift the sheet by the
  // part of the keyboard the window did not already make room for. iOS is handled by KeyboardAvoidingView.
  const [kb, setKb] = useState(0);
  const boxH = useRef({ base: 0, now: 0 });
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKb(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKb(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const lift = kb ? Math.max(0, kb - Math.max(0, boxH.current.base - boxH.current.now)) : 0;
  if (!mounted) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end' }}
        onLayout={(e) => { const h = e.nativeEvent.layout.height; boxH.current.now = h; if (!kb || !boxH.current.base) boxH.current.base = Math.max(boxH.current.base, h); }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.overlay, opacity: fade }]}>
          <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel="Close" accessibilityRole="button" />
        </Animated.View>
        <Animated.View onLayout={(e) => { height.current = e.nativeEvent.layout.height; }}
          style={{ backgroundColor: t.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: S[5], paddingBottom: kb ? S[4] : S[5] + insets.bottom, gap: S[4], maxHeight: lift && boxH.current.now ? (boxH.current.now - lift) * 0.92 : '90%', marginBottom: lift, transform: [{ translateY: y }] }}>
          <View {...pan.panHandlers} style={{ paddingTop: S[3], gap: S[3] }}>
            <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: t.line2 }} />
            <Spread>
              <View style={{ flex: 1 }}><T v="h2">{title}</T>{sub ? <T v="sm" c="text2" style={{ marginTop: 2 }}>{sub}</T> : null}</View>
              {dismissable && <IconButton icon="x" label="Close" onPress={close} />}
            </Spread>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: S[4] }}>{children}</ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ============================================================== date picker */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');
export const toYmd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = (v: string) => { const [y, m, d] = v.split('-').map(Number); return new Date(y, (m ?? 1) - 1, d ?? 1); };
export const ymdLabel = (v: string) => { const d = parseYmd(v); return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`; };

/** Tappable date field (YYYY-MM-DD value) that opens a month calendar. */
export function DateField({ label, value, onChange, min, max }: { label: string; value: string; onChange: (v: string) => void; min?: string; max?: string }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6, flex: 1 }}>
      <T v="sm" c="text2" w="500">{label}</T>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${label}: ${ymdLabel(value)}. Change date`}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: S[2], height: CTL.h + 4, borderWidth: 1, borderRadius: R.md, borderColor: t.line2, backgroundColor: pressed ? t.bg2 : t.bg, paddingHorizontal: S[3] })}>
        <Icon name="calendar" size={18} color={t.text3} />
        <T style={{ flex: 1 }}>{ymdLabel(value)}</T>
      </Pressable>
      <DatePickerSheet visible={open} title={label} value={value} min={min} max={max} onClose={() => setOpen(false)} onPick={(v) => { setOpen(false); onChange(v); }} />
    </View>
  );
}

export function DatePickerSheet({ visible, title, value, min, max, onPick, onClose }: { visible: boolean; title: string; value: string; min?: string; max?: string; onPick: (v: string) => void; onClose: () => void }) {
  const t = useTheme();
  const init = parseYmd(value);
  const [month, setMonth] = useState({ y: init.getFullYear(), m: init.getMonth() });
  useEffect(() => { if (visible) { const d = parseYmd(value); setMonth({ y: d.getFullYear(), m: d.getMonth() }); } }, [visible, value]);
  const first = new Date(month.y, month.m, 1).getDay();
  const days = new Date(month.y, month.m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, k) => k + 1)];
  while (cells.length % 7) cells.push(null);
  const ymdOf = (d: number) => `${month.y}-${pad2(month.m + 1)}-${pad2(d)}`;
  const canPrev = !min || `${month.y}-${pad2(month.m + 1)}-01` > min;
  const canNext = !max || ymdOf(days) < max;
  const shift = (n: number) => { tap('select'); setMonth((c) => { const d = new Date(c.y, c.m + n, 1); return { y: d.getFullYear(), m: d.getMonth() }; }); };
  const today = toYmd(new Date());
  const W = `${100 / 7}%` as const;
  return (
    <Sheet visible={visible} title={title} onClose={onClose}>
      <Spread>
        <Pressable disabled={!canPrev} onPress={() => shift(-1)} accessibilityRole="button" accessibilityLabel="Previous month" hitSlop={8} style={{ padding: S[2], opacity: canPrev ? 1 : 0.3 }}><Icon name="chevronLeft" size={20} color={t.text} /></Pressable>
        <T v="h3">{MONTHS_SHORT[month.m]} {month.y}</T>
        <Pressable disabled={!canNext} onPress={() => shift(1)} accessibilityRole="button" accessibilityLabel="Next month" hitSlop={8} style={{ padding: S[2], opacity: canNext ? 1 : 0.3 }}><Icon name="chevronRight" size={20} color={t.text} /></Pressable>
      </Spread>
      <View>
        <View style={{ flexDirection: 'row' }}>{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, k) => <View key={k} style={{ width: W, alignItems: 'center', paddingVertical: 4 }}><T v="xs" c="text3">{d}</T></View>)}</View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {cells.map((d, k) => {
            if (d === null) return <View key={k} style={{ width: W, height: 42 }} />;
            const v = ymdOf(d);
            const off = (!!min && v < min) || (!!max && v > max);
            const on = v === value;
            return (
              <Pressable key={k} disabled={off} onPress={() => { tap('select'); onPick(v); }} accessibilityRole="button" accessibilityLabel={ymdLabel(v)} accessibilityState={{ selected: on, disabled: off }} style={{ width: W, height: 42, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.brand : 'transparent', borderWidth: v === today && !on ? 1 : 0, borderColor: t.brand, opacity: off ? 0.3 : 1 }}>
                  <Text style={{ color: on ? t.brandInk : t.text, fontWeight: on || v === today ? '600' : '400', fontSize: FS.md }}>{d}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>
    </Sheet>
  );
}

/* ============================================================== data hook */
/**
 * Loading / error / data with optional polling.
 * - Polls only while the screen is focused and the app is in the foreground; refetches as soon as either comes back.
 * - Skips the re-render when a poll returns exactly the same data.
 * - Registers with the screen's pull-to-refresh.
 */
export function useQuery<T>(query: string, variables?: Record<string, unknown>, pollMs?: number, skip?: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const vars = JSON.stringify(variables ?? {});
  const alive = useRef(true);
  const last = useRef<string | null>(null);
  const active = useActive();
  const register = useContext(RegisterCtx);
  const refetch = useCallback(async () => {
    try {
      const d = await gql<T>(query, JSON.parse(vars));
      if (!alive.current) return;
      const j = JSON.stringify(d);
      if (j !== last.current) { last.current = j; setData(d); }
      setError(null);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally { if (alive.current) setLoading(false); }
  }, [query, vars]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { last.current = null; }, [query, vars]);
  useEffect(() => (register && !skip ? register(refetch) : undefined), [register, refetch, skip]);
  useEffect(() => {
    if (!active || skip) { if (skip) setLoading(false); return; }
    void refetch();
    const h = pollMs ? setInterval(refetch, pollMs) : undefined;
    return () => { if (h) clearInterval(h); };
  }, [refetch, pollMs, active, skip]);
  return { data, error, loading, refetch };
}

/* ============================================================== step-up */
export function StepUpHost(_props: { mfa: boolean }) {
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
      <Field label="Your password" value={value} onChangeText={(v) => setValue(v)} secureTextEntry maxLength={128} autoFocus textContentType="password" error={err} />
      <Button title="Verify" kind="primary" size="lg" busy={busy} disabled={!value} onPress={async () => {
        setBusy(true); setErr(null);
        try { const d = await gql(`mutation($p:String!){ stepUp(password:$p){ token } }`, { p: value }); done(d.stepUp.token); }
        catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
      }} />
    </Sheet>
  );
}

/* ============================================================== toast */
let toastFn: ((m: string, err?: boolean) => void) | null = null;
export const toast = (m: string, err?: boolean) => toastFn?.(m, err);
/** One toast at a time; a new one replaces the old and restarts its timer. Slides and fades on the native thread. */
export function ToastHost() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [msg, setMsg] = useState<{ m: string; err?: boolean } | null>(null);
  const a = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    toastFn = (m, err) => {
      if (timer.current) clearTimeout(timer.current);
      setMsg({ m, err });
      if (err) tap('heavy');
      Animated.spring(a, { toValue: 1, useNativeDriver: true, bounciness: 4, speed: 16 }).start();
      timer.current = setTimeout(() => {
        Animated.timing(a, { toValue: 0, duration: 200, useNativeDriver: true }).start(({ finished }) => finished && setMsg(null));
      }, err ? 4500 : 3000);
    };
    return () => { toastFn = null; if (timer.current) clearTimeout(timer.current); };
  }, [a]);
  if (!msg) return null;
  return (
    <Animated.View accessibilityLiveRegion="polite"
      style={{ pointerEvents: 'none', position: 'absolute', left: S[4], right: S[4], bottom: insets.bottom + 72, backgroundColor: msg.err ? t.neg : t.text, borderRadius: R.md, padding: S[3], flexDirection: 'row', gap: S[2], alignItems: 'center',
        opacity: a, transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }], shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>
      <Icon name={msg.err ? 'alert' : 'check'} size={18} color={msg.err ? '#fff' : t.bg} />
      <Text style={{ color: msg.err ? '#fff' : t.bg, fontWeight: '500', flex: 1 }}>{msg.m}</Text>
    </Animated.View>
  );
}

/** Lots input with − and + joined into one control, all three the same height. */
export function LotStepper({ value, onChange, label = 'Lots', min = 1 }: { value: string; onChange: (v: string) => void; label?: string; min?: number }) {
  const t = useTheme();
  const n = Number(value) || 0;
  const side = (sign: string, a11y: string, next: number) => (
    <Pressable onPress={() => { tap('select'); onChange(String(next)); }} accessibilityRole="button" accessibilityLabel={a11y} hitSlop={4}
      style={({ pressed }) => ({ width: 52, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? t.bg3 : t.bg2 })}>
      <Text style={{ fontSize: 22, fontWeight: '600', color: t.text, lineHeight: 26 }}>{sign}</Text>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', height: CTL.h, borderWidth: 1, borderColor: t.line2, borderRadius: R.md, overflow: 'hidden', backgroundColor: t.bg }}>
      {side('\u2212', `Decrease ${label.toLowerCase()}`, Math.max(min, (n || min) - 1))}
      <TextInput accessibilityLabel={label} keyboardType="number-pad" value={value} selectTextOnFocus
        onChangeText={(v) => onChange(v.replace(/\D/g, ''))}
        style={{ flex: 1, textAlign: 'center', fontSize: FS.lg, fontWeight: '600', color: t.text, paddingVertical: 0, borderLeftWidth: 1, borderRightWidth: 1, borderColor: t.line2 }} />
      {side('+', `Increase ${label.toLowerCase()}`, n + 1)}
    </View>
  );
}
