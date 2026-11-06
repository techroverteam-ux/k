/** Domain building blocks shared by trader / broker / admin screens. */
import { useSoleAdmin } from './sole-admin';
import { DemoDepositDetails } from './demo-deposit';
import { router, useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { API_URL, gql, newKey, subscribe } from './api';
import { useActive } from './active';
import { NUM_SCALE, usePrefs, usePrivate } from './prefs';
import { useSplashActive } from './splash';
import { CONSENT_FIELDS, deviceLabel, LOGIN_FIELDS, LOGIN_LABEL, stamp, type ConsentRecord, type LoginEvent } from './activity';
import { useAuth } from './auth';
import { QuickTradeSheet } from './quick-trade';
import { Icon } from './icons';
import { CTL, inr, initials, R, S, shortSymbol, toneOfValue, useTheme, when } from './theme';
import {
  Badge, Button, Change, Chips, DateField, Divider, Empty, ErrorState, Field, IconButton, IconMark, ListRow, Mark, Metrics, Notice, Row, Screen, SearchBox,
  Flash, Section, Sheet, Skeleton, Spread, StatusBadge, SwipeRow, T, Tabs, tap, toast, useQuery, VList, ymdLabel,
} from './ui';

export interface Quote { instrumentId: string; ltp: string; bid: string; ask: string; high: string; low: string; change: string; changePct: string; ts: string; source: string }
export const QF = 'instrumentId ltp bid ask high low change changePct ts source';
interface Inst { id: string; symbol: string; name: string; exchange: string; segment: string; expiry?: string; lotClass?: 'MINI' | 'MEGA'; lotLabel?: string; category?: string }
const INST_FIELDS = 'id symbol name exchange segment expiry lotClass lotLabel category';
type Cat = '' | 'FUTURES' | 'MCX' | 'OPTIONS' | 'FOREX' | 'CRYPTO' | 'US_STOCK' | 'COMEX' | 'US_INDEX';
type Lot = '' | 'MINI' | 'MEGA';

/** Market tabs (same as the web portal) and, for MCX, Mini / Mega. */
function MarketFilter({ cat, lot, onCat, onLot }: { cat: Cat; lot: Lot; onCat: (c: Cat) => void; onLot: (l: Lot) => void }) {
  return (
    <View style={{ gap: S[2] }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingRight: S[4] }}>
        <Chips value={cat} onChange={(c) => { onCat(c); onLot(''); }} items={[{ k: '', label: 'All' }, { k: 'FUTURES', label: 'Futures' }, { k: 'MCX', label: 'MCX' }, { k: 'OPTIONS', label: 'Options' }, { k: 'FOREX', label: 'Forex' }, { k: 'CRYPTO', label: 'Crypto' }, { k: 'US_STOCK', label: 'US Stock' }, { k: 'COMEX', label: 'COMEX' }, { k: 'US_INDEX', label: 'US Index' }]} />
      </ScrollView>
      {cat === 'MCX' && <Chips value={lot} onChange={onLot} items={[{ k: '', label: 'All lots' }, { k: 'MINI', label: 'Mini' }, { k: 'MEGA', label: 'Mega' }]} />}
    </View>
  );
}

/** "Mini · 100 g" for MCX instruments; "Lot · 1,000 USD" for others with a lot label. */
/** "24 Nov · 19:04:27": contract expiry and when the price last changed (IST). */
const expiryTime = (expiry?: string, ts?: string) =>
  `${expiry ? `${new Date(expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} · ` : ''}${ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '—'}`;

/** Bid (red) and ask (green) boxes; each blinks green when its price rises and red when it falls. Low / High below. */
function BidAsk({ id, qq, onPick }: { id: string; qq?: Quote; onPick?: (side: 'BUY' | 'SELL') => void }) {
  const t = useTheme();
  return (
    <>
      {(['SELL', 'BUY'] as const).map((sd) => {
        const v = sd === 'BUY' ? qq?.ask : qq?.bid;
        return (
          <Pressable key={sd} onPress={() => { tap(); if (onPick) onPick(sd); else router.push(`/instrument/${id}?side=${sd}`); }} accessibilityRole="button" accessibilityLabel={`${sd === 'BUY' ? 'Buy' : 'Sell'} at ${v ?? ''}`} style={{ alignItems: 'center', gap: 2 }}>
            <Flash value={v} style={{ borderRadius: R.md, overflow: 'hidden' }}>
              <View style={{ minWidth: 72, paddingVertical: 6, paddingHorizontal: 6, backgroundColor: sd === 'BUY' ? t.posSoft : t.negSoft, alignItems: 'center' }}>
                <T v="num" c={sd === 'BUY' ? 'pos' : 'neg'}>{inr(v)}</T>
              </View>
            </Flash>
            <T v="xs">{sd === 'BUY' ? `H ${inr(qq?.high)}` : `L ${inr(qq?.low)}`}</T>
          </Pressable>
        );
      })}
    </>
  );
}

const lotText = (i: Inst) => (i.category === 'MCX' ? `${i.lotClass === 'MEGA' ? 'Mega' : 'Mini'}${i.lotLabel ? ` · ${i.lotLabel}` : ''}` : i.lotLabel ? `Lot · ${i.lotLabel}` : '');
const marketText = (i: Inst) => (i.category === 'FOREX' ? 'Forex' : i.exchange) + (i.expiry ? ` · ${new Date(i.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` : '');

/**
 * Live quotes by instrument id. Streams only while the screen is in use; on return it re-reads a snapshot.
 * Quotes that didn't change keep their object identity, so memoised rows skip re-rendering.
 */
export function useLiveQuotes(ids: string[]) {
  const [q, setQ] = useState<Record<string, Quote>>({});
  const key = ids.slice().sort().join(',');
  const active = useActive();
  useEffect(() => {
    if (!key || !active) return;
    const list = key.split(',');
    const merge = (rows: Quote[]) => setQ((s) => {
      let changed = false;
      const next = { ...s };
      for (const x of rows) { const cur = s[x.instrumentId]; if (!cur || cur.ltp !== x.ltp || cur.bid !== x.bid || cur.ask !== x.ask || cur.high !== x.high || cur.low !== x.low) { next[x.instrumentId] = x; changed = true; } }
      return changed ? next : s;
    });
    gql<{ quotes: Quote[] }>(`query($i:[ID!]!){ quotes(instrumentIds:$i){ ${QF} } }`, { i: list }).then((d) => merge(d.quotes)).catch(() => undefined);
    return subscribe<{ quotesUpdated: Quote[] }>(`subscription($i:[ID!]!){ quotesUpdated(instrumentIds:$i){ ${QF} } }`, { i: list }, (d) => merge(d.quotesUpdated));
  }, [key, active]);
  return q;
}

/** Header search button: opens the instrument search. */
export function SearchButton() {
  return <IconButton icon="search" label="Search instruments" onPress={() => router.push('/search')} />;
}

const SearchRow = memo(function SearchRow({ i, qq, inList, onAdd }: { i: Inst; qq?: Quote; inList: boolean; onAdd: (i: Inst) => void }) {
  const t = useTheme();
  const sym = shortSymbol(i.symbol);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: S[2], paddingVertical: S[3], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }}>
      <Pressable onPress={() => router.push(`/instrument/${i.id}`)} accessibilityRole="button" accessibilityLabel={`${sym}, ${qq?.ltp ?? ''}, open chart`} style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T w="700" numberOfLines={1}>{sym}</T>
        <Row gap={6} style={{ flexWrap: 'wrap' }}><T v="num" c={toneOfValue(qq?.change) === 'neg' ? 'neg' : 'pos'}>{inr(qq?.ltp)}</T><Change value={qq?.change} pct={qq?.changePct} pctOnly /></Row>
        <Row gap={6}>{lotText(i) ? <Badge text={lotText(i)} tone={i.lotClass === 'MEGA' ? 'info' : undefined} /> : null}<T v="xs" numberOfLines={1} style={{ flexShrink: 1 }}>{expiryTime(i.expiry, qq?.ts)}</T></Row>
      </Pressable>
      <BidAsk id={i.id} qq={qq} />
      <IconButton icon={inList ? 'check' : 'plus'} label={inList ? 'In watchlist 1' : 'Add to watchlist 1'} onPress={() => !inList && onAdd(i)} />
    </View>
  );
});

/** Search every instrument; tap to open its chart, + to add it to Watchlist 1. */
export function SearchView({ addMode }: { addMode?: boolean } = {}) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<Cat>('');
  const [lot, setLot] = useState<Lot>('');
  const [res, setRes] = useState<Inst[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [added, setAdded] = useState<string[]>([]);
  useEffect(() => {
    setRes(null);
    const h = setTimeout(() => gql<{ searchInstruments: Inst[] }>(`query($q:String!,$c:String,$l:String){ searchInstruments(query:$q, category:$c, lotClass:$l, limit:100){ ${INST_FIELDS} } }`, { q: q.trim(), c: cat || undefined, l: cat === 'MCX' && lot ? lot : undefined }).then((d) => { setErr(null); setRes(d.searchInstruments); }).catch((e) => { setErr((e as Error).message); setRes([]); }), q ? 180 : 0);
    return () => clearTimeout(h);
  }, [q, cat, lot, nonce]);
  const wl = useQuery<{ watchlist: { instrument: { id: string } }[] }>(`{ watchlist(listIndex:0){ instrument{ id } } }`);
  const inList = useMemo(() => new Set([...(wl.data?.watchlist ?? []).map((w) => w.instrument.id), ...added]), [wl.data, added]);
  const quotes = useLiveQuotes((res ?? []).map((i) => i.id));
  const onAdd = useCallback(async (i: Inst) => {
    try { await gql(`mutation($i:ID!){ addToWatchlist(listIndex:0, instrumentId:$i) }`, { i: i.id }); setAdded((a) => [...a, i.id]); tap(); toast(`${shortSymbol(i.symbol)} added to Watchlist 1`); }
    catch (e) { toast((e as Error).message, true); }
  }, []);
  return (
    <Screen back title={addMode ? 'Add script' : 'Search'} scroll={false}
      right={addMode ? <Button size="sm" kind="primary" title="Done" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} /> : undefined}>
      <VList data={res ?? []} keyOf={(i) => i.id}
        header={<View style={{ gap: S[3] }}><SearchBox value={q} onChangeText={setQ} placeholder="Symbol or company, e.g. GOLDM, RELIANCE" autoFocus /><MarketFilter cat={cat} lot={lot} onCat={setCat} onLot={setLot} /></View>}
        empty={res === null ? <Skeleton rows={5} /> : err ? <ErrorState error={err} retry={() => setNonce((n) => n + 1)} /> : <Empty icon="search" title={q ? `No instruments match “${q}”` : 'Nothing listed here yet'}>{q ? 'Try the symbol, like NIFTY or GOLDM.' : 'Instruments appear here once they are loaded.'}</Empty>}
        render={(i) => <SearchRow i={i} qq={quotes[i.id]} inList={inList.has(i.id)} onAdd={onAdd} />} />
    </Screen>
  );
}

/** Bell with unread count, used in headers; the theme switch sits beside it. */
export function BellButton() {
  const { data } = useQuery<{ unreadNotificationCount: number }>(`{ unreadNotificationCount }`, undefined, 30_000);
  const n = data?.unreadNotificationCount ?? 0;
  return (
    <>
      <ThemeButton />
      <IconButton icon="bell" label={`Notifications${n ? `, ${n} unread` : ''}`} badge={n} onPress={() => router.push('/notifications')} />
    </>
  );
}

const THEME_ORDER = ['system', 'light', 'dark'] as const;
const THEME_INFO = {
  system: { label: 'System', d: 'M3 5h18v11H3zM8 20h8M12 16v4' },
  light: { label: 'Light', d: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4' },
  dark: { label: 'Dark', d: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z' },
} as const;

/** Header switch: System → Light → Dark. Same setting as Profile → Preferences → Theme. */
export function ThemeButton() {
  const t = useTheme();
  const { prefs, set } = usePrefs();
  const cur = THEME_INFO[prefs.theme];
  const next = THEME_ORDER[(THEME_ORDER.indexOf(prefs.theme) + 1) % THEME_ORDER.length];
  return (
    <Pressable onPress={() => { set('theme', next); toast(`Theme: ${THEME_INFO[next].label}`); }} accessibilityRole="button"
      accessibilityLabel={`Theme: ${cur.label}. Double-tap for ${THEME_INFO[next].label}.`} hitSlop={6}
      style={({ pressed }) => ({ width: CTL.tap, height: CTL.tap, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? t.bg3 : 'transparent' })}>
      <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={t.text2} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><Path d={cur.d} /></Svg>
    </Pressable>
  );
}

/* ====================================================================== summary */
interface Summary { balance: string; available: string; marginUsed: string; realizedPnl: string; unrealizedPnl: string; openPositions: number; openOrders: number; deposits: string; withdrawals: string; fees: string }
export const SUMMARY = `query($u:ID){ accountSummary(userId:$u){ balance available marginUsed realizedPnl unrealizedPnl openPositions openOrders deposits withdrawals fees } }`;
export const useSummary = (userId?: string) => useQuery<{ accountSummary: Summary }>(SUMMARY, { u: userId }, 5000);

export function SummaryBlock({ userId, actions, title = 'Available to trade', compact, detail }: { userId?: string; actions?: boolean; title?: string; compact?: boolean; detail?: boolean }) {
  const t = useTheme();
  const { data, error, loading, refetch } = useSummary(userId);
  const [pay, setPay] = useState<'DEPOSIT' | 'WITHDRAWAL' | null>(null);
  const priv = usePrivate();
  const showFees = useAuth().me?.role !== 'TRADER'; // brokerage is not shown to traders (staff still see it)
  const s = data?.accountSummary;
  if (loading && !s) return <Skeleton rows={2} />;
  if (error && !s) return <ErrorState error={error} retry={refetch} />;
  if (compact) {
    const toneC = (v?: string) => (toneOfValue(v) === 'flat' ? 'text2' : (toneOfValue(v) as 'pos'));
    return (
      <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: t.line2, borderRadius: 16, padding: S[4], gap: S[3] }}>
        <View style={{ gap: 2 }}>
          <T v="sm" c="text2">{title}</T>
          <T style={{ fontSize: 20, fontWeight: '700' }} accessibilityRole="text">{priv(`₹${inr(s?.available)}`, 8)}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: S[3], rowGap: 2 }}>
            <T v="xs" c="text2">Open P&L <T v="xs" w="600" c={toneC(s?.unrealizedPnl)}>{inr(s?.unrealizedPnl, true)}</T></T>
            <T v="xs" c="text2">Booked <T v="xs" w="600" c={toneC(s?.realizedPnl)}>{inr(s?.realizedPnl, true)}</T></T>
            <T v="xs" c="text2">Margin <T v="xs" w="600">{priv(`₹${inr(s?.marginUsed)}`)}</T></T>
          </View>
          {detail && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: S[3], rowGap: 2 }}>
              <T v="xs" c="text2">Ledger <T v="xs" w="600">{priv(`₹${inr(s?.balance)}`)}</T></T>
              {showFees && <T v="xs" c="text2">Brokerage paid <T v="xs" w="600">₹{inr(s?.fees)}</T></T>}
              <T v="xs" c="text2">Positions <T v="xs" w="600">{s?.openPositions ?? 0}</T></T>
              <T v="xs" c="text2">Open orders <T v="xs" w="600">{s?.openOrders ?? 0}</T></T>
            </View>
          )}
        </View>
        {actions && (
          <Row gap={S[2]}>
            <View style={{ flex: 1 }}><Button block size="sm" title="Withdraw" onPress={() => setPay('WITHDRAWAL')} /></View>
            <View style={{ flex: 1 }}><Button block size="sm" kind="primary" icon="plus" title="Add funds" onPress={() => setPay('DEPOSIT')} /></View>
          </Row>
        )}
        {pay && <PaymentSheet type={pay} userId={userId} available={s?.available} onClose={() => { setPay(null); void refetch(); }} />}
      </View>
    );
  }
  return (
    <View style={{ gap: S[4] }}>
      <View style={{ gap: 2 }}>
        <T c="text2">{title}</T>
        <T style={{ fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] }} accessibilityRole="text">{priv(`₹${inr(s?.available)}`, 8)}</T>
        <Row gap={6}><T v="sm" c="text2">Open P&L</T><T v="sm" w="600" c={toneOfValue(s?.unrealizedPnl) === 'flat' ? 'text2' : (toneOfValue(s?.unrealizedPnl) as 'pos')}>{inr(s?.unrealizedPnl, true)}</T><T v="sm" c="text3">· Margin {priv(`₹${inr(s?.marginUsed)}`)}</T></Row>
        {actions && <Row gap={6}><T v="xs" c="text2">Deposits</T><T v="xs" c="pos" w="600">{priv(`₹${inr(s?.deposits)}`)}</T><T v="xs" c="text2">· Withdrawals</T><T v="xs" c="neg" w="600">{priv(`₹${inr(s?.withdrawals)}`)}</T></Row>}
      </View>
      {actions && (
        <Row>
          <Button block title="Withdraw" onPress={() => setPay('WITHDRAWAL')} />
          <Button block kind="primary" icon="plus" title="Add funds" onPress={() => setPay('DEPOSIT')} />
        </Row>
      )}
      <Metrics items={[
        { k: 'Ledger balance', v: priv(`₹${inr(s?.balance)}`) },
        { k: 'Booked P&L', v: inr(s?.realizedPnl, true), tone: toneOfValue(s?.realizedPnl) },
        { k: 'Positions · orders', v: `${s?.openPositions ?? 0} · ${s?.openOrders ?? 0}` },
        ...(showFees ? [{ k: 'Brokerage paid', v: `₹${inr(s?.fees)}` }] : []),
      ]} />
      {pay && <PaymentSheet type={pay} userId={userId} available={s?.available} onClose={() => { setPay(null); void refetch(); }} />}
    </View>
  );
}

export function PaymentSheet({ type, userId, available, onClose }: { type: 'DEPOSIT' | 'WITHDRAWAL'; userId?: string; available?: string; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A new key whenever the amount changes: a retry of the same request is safe, a different amount is a new request.
  const key = useMemo(newKey, [amount]);
  const { settings, me } = useAuth();
  const sole = useSoleAdmin() && me?.role === 'SUPER_ADMIN';
  const min = type === 'DEPOSIT' ? Number(settings?.minDeposit ?? 50000) : 0;
  const minLabel = `₹${inr(String(min)).replace('.00', '')}`;
  const fmt = /^\d{1,12}(\.\d{1,2})?$/.test(amount) && Number(amount) > 0;
  const under = type === 'DEPOSIT' && fmt && Number(amount) < min;
  const over = type === 'WITHDRAWAL' && !!available && fmt && Number(amount) > Number(available);
  const fieldErr = touched && (!fmt ? 'Enter an amount with up to 2 decimals' : under ? `Minimum to add is ${minLabel}` : over ? `You can withdraw up to ₹${inr(available)}` : null);
  return (
    <Sheet visible title={type === 'DEPOSIT' ? 'Add funds' : 'Withdraw funds'} sub={sole ? (type === 'DEPOSIT' ? `Added straight away. Minimum ${minLabel}.` : 'Withdrawn straight away.') : type === 'DEPOSIT' ? `A Super Admin reviews every request. Minimum ${minLabel}.` : 'A Super Admin reviews every request.'} onClose={onClose}>
      <Field label="Amount" prefix="₹" keyboardType="decimal-pad" value={amount} autoFocus onBlur={() => setTouched(true)} onChangeText={(v) => setAmount(v.replace(/[^\d.]/g, ''))} placeholder="0.00" error={fieldErr || null} hint={type === 'WITHDRAWAL' && available ? `Withdrawable now: ₹${inr(available)}` : type === 'DEPOSIT' ? `Minimum ${minLabel}` : undefined} />
      {type === 'DEPOSIT' && <Chips value={amount} onChange={setAmount} items={[min, min * 2, min * 4, min * 10].map(String).map((v) => ({ k: v, label: `+₹${inr(v).replace('.00', '')}` }))} />}
      {type === 'DEPOSIT' && !sole && <DemoDepositDetails />}
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind="primary" size="lg" title="Send request" busy={busy} onPress={async () => {
        setTouched(true);
        if (!fmt || over || under) return;
        setBusy(true); setErr(null);
        try {
          const d = await gql<{ requestPayment: { id: string } }>(`mutation($i:PaymentRequestInput!){ requestPayment(input:$i){ id } }`, { i: { type, amount, idempotencyKey: key, userId } });
          // Only one Super Admin: post it now (asks for the authenticator code), no separate approval step.
          if (sole) {
            try { await gql(`mutation($id:ID!){ approvePayment(id:$id){ id } }`, { id: d.requestPayment.id }); toast(type === 'DEPOSIT' ? 'Funds added' : 'Withdrawal done'); }
            catch { toast('Request saved. Approve it under Approvals.'); }
          } else toast('Request sent for review');
          onClose();
        }
        catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }} />
    </Sheet>
  );
}

/* ====================================================================== movers */
export function Movers() {
  const t = useTheme();
  const { data, error, refetch } = useQuery<{ searchInstruments: Inst[] }>(`{ searchInstruments(query:"", limit:50){ id symbol name exchange segment } }`);
  const list = data?.searchInstruments ?? [];
  const q = useLiveQuotes(list.map((i) => i.id));
  const [tab, setTab] = useState<'up' | 'down'>('up');
  const sorted = list.filter((i) => q[i.id]).filter((i) => (tab === 'up' ? Number(q[i.id].changePct) >= 0 : Number(q[i.id].changePct) < 0))
    .sort((a, b) => (Number(q[b.id].changePct) - Number(q[a.id].changePct)) * (tab === 'up' ? 1 : -1)).slice(0, 8);
  return (
    <Section title="Top movers" action={<Chips value={tab} onChange={setTab} items={[{ k: 'up', label: 'Gainers' }, { k: 'down', label: 'Losers' }]} />}>
      {error && !data ? <ErrorState error={error} retry={refetch} /> : !data ? <Skeleton rows={1} /> : !sorted.length ? <Empty icon="trend" title={tab === 'up' ? 'No gainers right now' : 'No losers right now'} /> : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S[3], paddingRight: S[4] }} style={{ marginRight: -S[4] }}>
          {sorted.map((i) => (
            <Pressable key={i.id} onPress={() => router.push(`/instrument/${i.id}`)} accessibilityRole="button" accessibilityLabel={`${shortSymbol(i.symbol)} ${q[i.id].ltp}`}
              style={({ pressed }) => ({ width: 148, padding: S[3], gap: S[2], borderWidth: 1, borderColor: t.line, borderRadius: R.lg, backgroundColor: pressed ? t.bg2 : t.bg })}>
              <Mark text={shortSymbol(i.symbol)} />
              <T w="600" numberOfLines={1}>{shortSymbol(i.symbol)}</T>
              <View><T v="num">₹{inr(q[i.id].ltp)}</T><Change value={q[i.id].change} pct={q[i.id].changePct} pctOnly /></View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </Section>
  );
}

/* ====================================================================== watchlist */
interface WEntry { id: string; instrument: Inst }

/** One watchlist row. Memoised: re-renders only when its own quote changes. */
const WatchRow = memo(function WatchRow({ e, qq, detailed, onRemove, onOpen }: { e: WEntry; qq?: Quote; detailed: boolean; onRemove: (e: WEntry) => void; onOpen: (id: string, side?: 'BUY' | 'SELL') => void }) {
  const t = useTheme();
  const sym = shortSymbol(e.instrument.symbol);
  const row = detailed ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: S[2], paddingVertical: S[3], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }}>
      <Pressable onPress={() => onOpen(e.instrument.id)} onLongPress={() => onRemove(e)} accessibilityRole="button" accessibilityLabel={`${sym}, ${qq?.ltp ?? ''}`} accessibilityHint="Opens quick trade. Swipe left to remove." style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Row gap={6}><T w="700" numberOfLines={1}>{sym}</T><Badge text={e.instrument.segment} /></Row>
        <Row gap={6}><T v="num" c={toneOfValue(qq?.change) === 'neg' ? 'neg' : 'pos'}>{inr(qq?.ltp)}</T><Change value={qq?.change} pct={qq?.changePct} pctOnly /></Row>
        <T v="xs" numberOfLines={1}>{expiryTime(e.instrument.expiry, qq?.ts)}</T>
      </Pressable>
      <BidAsk id={e.instrument.id} qq={qq} onPick={(sd) => onOpen(e.instrument.id, sd)} />
    </View>
  ) : (
    <ListRow onPress={() => onOpen(e.instrument.id)} label={`${sym}, ₹${qq?.ltp ?? ''}`} title={sym} sub={`${e.instrument.exchange} · ${e.instrument.segment}`}
      right={<View style={{ alignItems: 'flex-end', gap: 2 }}><T v="num">₹{inr(qq?.ltp)}</T><Change value={qq?.change} pct={qq?.changePct} /></View>} />
  );
  return (
    <SwipeRow action={() => onRemove(e)} actionLabel="Remove">
      <Flash value={qq?.ltp}>{row}</Flash>
    </SwipeRow>
  );
});

/** Watchlists. `limit` = compact preview (Home); otherwise the full, virtualised list for the Watchlist tab. */
/** The watchlist: one list, with a search bar on top that finds instruments and adds them in place. */
export function WatchlistBlock({ limit, header }: { limit?: number; header?: ReactNode }) {
  const { prefs } = usePrefs();
  const detailed = !limit && prefs.watchlistView === 'detailed';
  const { data, error, loading, refetch } = useQuery<{ watchlist: WEntry[] }>(`query($l:Int!){ watchlist(listIndex:$l){ id instrument{ id symbol name exchange segment expiry } } }`, { l: 0 });
  // Coming back from "Add script": reload so the scripts just added show up.
  const seen = useRef(false);
  useFocusEffect(useCallback(() => { if (seen.current) void refetch(); seen.current = true; }, [refetch]));
  const entries = useMemo(() => (data?.watchlist ?? []).slice(0, limit ?? 100), [data, limit]);
  const count = (data?.watchlist ?? []).length;
  const q = useLiveQuotes(entries.map((e) => e.instrument.id));
  const [removing, setRemoving] = useState<WEntry | null>(null);
  const [quick, setQuick] = useState<{ id: string; side?: 'BUY' | 'SELL' } | null>(null);
  const onOpen = useCallback((id: string, side?: 'BUY' | 'SELL') => setQuick({ id, side }), []);
  const onRemove = useCallback((e: WEntry) => setRemoving(e), []);
  const remove = async (e: WEntry) => {
    setRemoving(null);
    try { await gql(`mutation($l:Int!,$i:ID!){ removeFromWatchlist(listIndex:$l, instrumentId:$i) }`, { l: 0, i: e.instrument.id }); toast(`${shortSymbol(e.instrument.symbol)} removed`); } catch (err) { toast((err as Error).message, true); }
    void refetch();
  };
  const addScript = () => router.push('/search?mode=add' as never);
  const top = (
    <>
      {header}
      <Spread style={{ alignItems: 'center', marginBottom: S[1] }}>
        <T w="600">Watchlist <T v="sm" c="text2">{count}/50</T></T>
        <Button size="sm" kind="primary" icon="plus" title="Add script" disabled={count >= 50} onPress={addScript} />
      </Spread>
    </>
  );
  const state = loading && !data ? <Skeleton /> : error && !data ? <ErrorState error={error} retry={refetch} />
    : <Empty icon="eye" title="Your watchlist is empty" action={<Button size="sm" kind="primary" icon="plus" title="Add script" onPress={addScript} />}>Tap Add script to pick the instruments you follow.</Empty>;
  const hint = entries.length ? <T v="xs" style={{ textAlign: 'center', marginTop: S[3] }}>{detailed ? 'Tap a row or a price to trade. Swipe a row left to remove it.' : 'Tap a row to trade. Swipe a row left to remove it.'}</T> : null;
  const sheet = (
    <Sheet visible={!!removing} title={removing ? `Remove ${shortSymbol(removing.instrument.symbol)}?` : ''} sub={removing?.instrument.name} onClose={() => setRemoving(null)}>
      <Row>
        <Button block title="Keep" onPress={() => setRemoving(null)} />
        <Button block kind="sell" icon="x" title="Remove" onPress={() => removing && void remove(removing)} />
      </Row>
    </Sheet>
  );
  return (
    <>
      <VList data={entries} keyOf={(e) => e.id} header={top} empty={state} footer={hint}
        render={(e) => <WatchRow e={e} qq={q[e.instrument.id]} detailed={detailed} onRemove={onRemove} onOpen={onOpen} />} />
      {sheet}
      {quick && <QuickTradeSheet instrumentId={quick.id} initialSide={quick.side} onClose={() => setQuick(null)} />}
    </>
  );
}


/* ====================================================================== orders / positions / ledger */
const OTYPE: Record<string, string> = { MARKET: 'Market', LIMIT: 'Limit', STOP_LOSS: 'Stop-loss', TAKE_PROFIT: 'Take-profit' };
interface Order { id: string; side: string; type: string; quantity: number; limitPrice?: string; triggerPrice?: string; triggeredAt?: string; fillPrice?: string; status: string; venue: string; rejectReason?: string; createdAt: string; instrument?: { symbol: string } }

const OrderRow = memo(function OrderRow({ o, onCancel }: { o: Order; onCancel?: (o: Order) => void }) {
  return (
    <ListRow onPress={onCancel && o.status === 'OPEN' ? () => onCancel(o) : undefined} label={onCancel && o.status === 'OPEN' ? 'Cancel this order' : undefined}
      title={o.instrument ? shortSymbol(o.instrument.symbol) : '—'}
      sub={<View style={{ gap: 2 }}><Row gap={6}><T v="xs" c={o.side === 'BUY' ? 'pos' : 'neg'} w="600">{o.side === 'BUY' ? 'Buy' : 'Sell'}</T><T v="xs">{o.quantity} qty · {OTYPE[o.type] ?? o.type}{o.triggerPrice ? ` @ ₹${inr(o.triggerPrice)}` : ''} · {when(o.createdAt)}</T></Row>{o.rejectReason ? <T v="xs" c="neg">{o.rejectReason}</T> : null}</View>}
      right={<View style={{ alignItems: 'flex-end', gap: 4 }}><T v="num">₹{inr(o.fillPrice ?? o.limitPrice ?? o.triggerPrice)}</T><StatusBadge v={o.status} />{onCancel && o.status === 'OPEN' ? <T v="xs" c="neg" w="600">Tap to cancel</T> : null}</View>} />
  );
});

/** Orders. With `virtual`, the list scrolls the whole screen (Screen scroll={false}) and `header` sits above it. */
export function OrdersList({ userId, statuses, canCancel, emptyTitle = 'No orders', emptyText, virtual, header }: { userId?: string; statuses: string[]; canCancel?: boolean; emptyTitle?: string; emptyText?: string; virtual?: boolean; header?: ReactNode }) {
  const { data, error, loading, refetch } = useQuery<{ orders: Order[] }>(`query($u:ID,$s:[OrderStatus!]){ orders(userId:$u, status:$s, limit:100){ id side type quantity limitPrice triggerPrice triggeredAt fillPrice status venue rejectReason createdAt instrument{ symbol } } }`, { u: userId, s: statuses }, 4000);
  const [cancel, setCancel] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const onCancel = useCallback((o: Order) => setCancel(o), []);
  const list = data?.orders ?? [];
  const state = loading && !data ? <Skeleton /> : error && !data ? <ErrorState error={error} retry={refetch} /> : <Empty icon="list" title={emptyTitle}>{emptyText}</Empty>;
  const sheet = (
    <Sheet visible={!!cancel} title="Cancel this order?" sub={cancel ? `${cancel.side === 'BUY' ? 'Buy' : 'Sell'} ${cancel.quantity} ${shortSymbol(cancel.instrument?.symbol ?? '')}${cancel.triggerPrice ? ' trigger' : ''} at ₹${inr(cancel.limitPrice ?? cancel.triggerPrice)}` : ''} onClose={() => setCancel(null)}>
      <Row>
        <Button block title="Keep order" onPress={() => setCancel(null)} />
        <Button block kind="sell" title="Cancel order" busy={busy} onPress={async () => {
          if (!cancel) return; setBusy(true);
          try { await gql(`mutation($id:ID!){ cancelOrder(orderId:$id){ id } }`, { id: cancel.id }); toast('Order cancelled'); } catch (e) { toast((e as Error).message, true); }
          setBusy(false); setCancel(null); void refetch();
        }} />
      </Row>
    </Sheet>
  );
  const render = (o: Order) => <OrderRow o={o} onCancel={canCancel ? onCancel : undefined} />;
  if (virtual) return <><VList data={list} keyOf={(o) => o.id} header={header} empty={state} render={render} />{sheet}</>;
  return <View>{header}{!list.length ? state : list.map((o) => <OrderRow key={o.id} o={o} onCancel={canCancel ? onCancel : undefined} />)}{sheet}</View>;
}

const ORDER_TABS = {
  open: { label: 'Open', s: ['OPEN'], title: 'No open orders', text: 'Limit, stop-loss and take-profit orders waiting for their price appear here.' },
  done: { label: 'Executed', s: ['FILLED'], title: 'No executed orders', text: 'Filled orders appear here.' },
  rej: { label: 'Rejected', s: ['REJECTED', 'CANCELLED'], title: 'Nothing rejected or cancelled', text: 'If an order fails a check, you’ll see the reason here.' },
} as const;
type OrderTab = keyof typeof ORDER_TABS;
/** Orders split into Open / Executed / Rejected, like the web. */
export function OrdersTabs({ virtual, header, initial = 'open' }: { virtual?: boolean; header?: ReactNode; initial?: OrderTab }) {
  const [tab, setTab] = useState<OrderTab>(initial);
  const tb = ORDER_TABS[tab];
  const tabs = <Tabs value={tab} onChange={setTab} items={(Object.keys(ORDER_TABS) as OrderTab[]).map((k) => ({ k, label: ORDER_TABS[k].label }))} />;
  return <OrdersList key={tab} virtual={virtual} header={<>{header}{tabs}</>} statuses={[...tb.s]} canCancel={tab === 'open'} emptyTitle={tb.title} emptyText={tb.text} />;
}

interface Pos { id: string; instrumentId: string; netQty: number; avgPrice: string; realizedPnl: string; unrealizedPnl?: string; ltp?: string; instrument?: { symbol: string } }
export function PositionsList({ userId, canTrade }: { userId?: string; canTrade?: boolean }) {
  const [quick, setQuick] = useState<{ id: string; side: 'BUY' | 'SELL'; qty: number } | null>(null);
  const { data, error, loading, refetch } = useQuery<{ positions: Pos[] }>(`query($u:ID){ positions(userId:$u){ id instrumentId netQty avgPrice realizedPnl unrealizedPnl ltp instrument{ symbol } } }`, { u: userId }, 3000);
  if (loading && !data) return <Skeleton />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.positions.length) return <Empty icon="briefcase" title="No positions" action={canTrade ? <Button size="sm" kind="primary" title="Find instruments" onPress={() => router.push('/search')} /> : undefined}>A position opens when a buy or sell order executes.</Empty>;
  const total = data!.positions.reduce((a, p) => a + Number(p.unrealizedPnl ?? 0), 0).toFixed(2);
  const exit = (p: Pos) => setQuick({ id: p.instrumentId, side: p.netQty > 0 ? 'SELL' : 'BUY', qty: Math.abs(p.netQty) });
  return (
    <View>
      <Spread style={{ paddingVertical: S[3] }}><T c="text2">Total open P&L</T><T v="numLg" c={toneOfValue(total) === 'flat' ? 'text2' : (toneOfValue(total) as 'pos')}>{inr(total, true)}</T></Spread>
      <Divider />
      {[...data!.positions].sort((a, b) => Number(b.netQty !== 0) - Number(a.netQty !== 0)).map((p) => (
        <ListRow key={p.id}
          onPress={() => router.push(`/instrument/${p.instrumentId}`)}
          label={`${p.instrument ? shortSymbol(p.instrument.symbol) : ''} chart`}
          title={p.instrument ? shortSymbol(p.instrument.symbol) : '—'}
          sub={p.netQty === 0 ? `Closed · LTP ₹${inr(p.ltp)}` : `${p.netQty > 0 ? 'Long' : 'Short'} ${Math.abs(p.netQty)} · avg ₹${inr(p.avgPrice)} · LTP ₹${inr(p.ltp)}`}
          right={p.netQty === 0
            ? <View style={{ alignItems: 'flex-end', gap: 2 }}><T v="num" c={toneOfValue(p.realizedPnl) === 'flat' ? 'text2' : (toneOfValue(p.realizedPnl) as 'pos')}>{inr(p.realizedPnl, true)}</T><T v="xs">Booked</T></View>
            : <View style={{ alignItems: 'flex-end', gap: 2 }}><T v="num" c={toneOfValue(p.unrealizedPnl) === 'flat' ? 'text2' : (toneOfValue(p.unrealizedPnl) as 'pos')}>{inr(p.unrealizedPnl, true)}</T><T v="xs">Booked {inr(p.realizedPnl, true)}</T></View>}
          action={canTrade && p.netQty !== 0 ? <Button size="sm" kind={p.netQty > 0 ? 'sell' : 'buy'} title="Exit" onPress={() => exit(p)} /> : undefined} />
      ))}
      {quick && <QuickTradeSheet instrumentId={quick.id} initialSide={quick.side} initialQty={quick.qty} onClose={() => { setQuick(null); void refetch(); }} />}
    </View>
  );
}

const KIND: Record<string, string> = { OPENING_BALANCE: 'Opening balance', DEPOSIT: 'Funds added', WITHDRAWAL: 'Withdrawal', TRADE_PNL: 'Trade P&L', FEE: 'Brokerage', ADJUSTMENT: 'Adjustment', REVERSAL: 'Reversal' };
interface Led { postingId: string; kind: string; memo: string; amount: string; createdAt: string }
const LedgerRow = memo(function LedgerRow({ x }: { x: Led }) {
  const tn = toneOfValue(x.amount);
  return <ListRow left={<IconMark icon={tn === 'pos' ? 'down' : 'up'} tone={tn === 'pos' ? 'pos' : undefined} />} title={KIND[x.kind] ?? x.kind} sub={`${x.memo} · ${when(x.createdAt)}`}
    right={<T v="num" c={tn === 'flat' ? 'text2' : (tn as 'pos')}>{inr(x.amount, true)}</T>} />;
});
export function LedgerList({ userId, virtual }: { userId?: string; virtual?: boolean }) {
  const { data, error, loading, refetch } = useQuery<{ ledgerHistory: Led[] }>(`query($u:ID){ ledgerHistory(userId:$u, limit:200){ postingId kind memo amount createdAt } }`, { u: userId });
  const hideFees = useAuth().me?.role === 'TRADER'; // brokerage lines are not shown to traders
  const list = (data?.ledgerHistory ?? []).filter((x) => !hideFees || x.kind !== 'FEE');
  const state = loading && !data ? <Skeleton /> : error && !data ? <ErrorState error={error} retry={refetch} /> : <Empty icon="file" title="No transactions yet">Trades, charges and fund movements appear here.</Empty>;
  if (virtual) return <VList data={list} keyOf={(x) => x.postingId} empty={state} render={(x) => <LedgerRow x={x} />} />;
  if (!list.length) return state;
  return <View>{list.slice(0, 60).map((x) => <LedgerRow key={x.postingId} x={x} />)}</View>;
}

interface Pay { id: string; username?: string; type: string; amount: string; status: string; reviewNote?: string; createdAt: string }
export function RequestsList({ userId, showName, canCancel }: { userId?: string; showName?: boolean; canCancel?: boolean }) {
  const { data, error, loading, refetch } = useQuery<{ paymentRequests: Pay[] }>(`query($u:ID){ paymentRequests(userId:$u, limit:50){ id username type amount status reviewNote createdAt } }`, { u: userId }, 10000);
  const [cancel, setCancel] = useState<Pay | null>(null);
  const [busy, setBusy] = useState(false);
  if (loading && !data) return <Skeleton />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.paymentRequests.length) return <Empty icon="wallet" title="No fund requests" />;
  return (
    <View>
      {data!.paymentRequests.map((p) => (
        <ListRow key={p.id} title={`${showName && p.username ? `${p.username} · ` : ''}${p.type === 'DEPOSIT' ? 'Add funds' : 'Withdraw'}`} sub={`${when(p.createdAt)}${p.reviewNote ? ` · ${p.reviewNote}` : ''}`}
          right={<Row gap={S[2]}><View style={{ alignItems: 'flex-end', gap: 4 }}><T v="num">₹{inr(p.amount)}</T><StatusBadge v={p.status} /></View>{canCancel && p.status === 'REQUESTED' && <Button size="sm" title="Cancel" onPress={() => setCancel(p)} />}</Row>} />
      ))}
      <Sheet visible={!!cancel} title="Cancel this request?" sub={cancel ? `${cancel.type === 'DEPOSIT' ? 'Add funds' : 'Withdraw'} ₹${inr(cancel.amount)}` : ''} onClose={() => setCancel(null)}>
        <Row>
          <Button block title="Keep request" onPress={() => setCancel(null)} />
          <Button block kind="sell" title="Cancel request" busy={busy} onPress={async () => {
            if (!cancel) return; setBusy(true);
            try { await gql(`mutation($id:ID!){ cancelPayment(id:$id){ id } }`, { id: cancel.id }); toast('Request cancelled'); } catch (e) { toast((e as Error).message, true); }
            setBusy(false); setCancel(null); void refetch();
          }} />
        </Row>
      </Sheet>
    </View>
  );
}

/* ====================================================================== profile / notifications */
interface Sess { id: string; deviceName?: string; ip?: string; lastUsedAt: string; current: boolean }
export function ProfileView() {
  const t = useTheme();
  const { me, signOut, settings, quick } = useAuth();
  const sessions = useQuery<{ mySessions: Sess[] }>(`{ mySessions { id deviceName ip lastUsedAt current } }`);
  const [pw, setPw] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [others, setOthers] = useState(false);
  const [terms, setTerms] = useState(false);
  const role = me?.role === 'SUPER_ADMIN' ? 'Super Admin' : me?.role === 'BROKER' ? 'Broker' : 'Trader';
  const Item = ({ icon, label, sub, onPress }: { icon: 'key' | 'book' | 'chat' | 'shield' | 'file' | 'alert' | 'download' | 'activity' | 'device' | 'lock' | 'fingerprint'; label: string; sub?: string; onPress?: () => void }) => (
    <ListRow onPress={onPress} label={label} left={<IconMark icon={icon} />} title={label} sub={sub} right={onPress ? <Icon name="chevronRight" size={18} color={t.text3} /> : undefined} />
  );
  return (
    <Screen title="Profile" right={<BellButton />} onRefresh={sessions.refetch}>
      <Row>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}><T v="h3" c="brand">{initials(me?.displayName ?? '')}</T></View>
        <View style={{ flex: 1 }}><T v="h2">{me?.displayName}</T><T v="sm" c="text2">{me?.username} · {role}{me?.isDemo ? ' · demo' : ''}</T></View>
      </Row>
      <View>
        <Item icon="shield" label="Two-step verification" sub={me?.mfaEnabled ? 'On. Sign-ins ask for a code from your authenticator app' : 'Off. Tap to set it up'} onPress={me?.mfaEnabled || me?.isDemo ? undefined : () => setMfa(true)} />
        {!me?.isDemo && <Item icon="key" label="Change password" onPress={() => setPw(true)} />}
        {!me?.isDemo && me?.role !== 'SUPER_ADMIN' && <Item icon="fingerprint" label="MPIN & fingerprint" sub={quick?.owner.userId === me?.id ? (quick?.owner.biometric ? 'On: MPIN and fingerprint' : 'On: MPIN') : 'Off. Unlock without your password'} onPress={() => router.push('/quick-settings')} />}
        {me?.role !== 'SUPER_ADMIN' && <Item icon="alert" label="Wipe out account" sub="Fresh start: clear your history and reset the balance" onPress={() => router.push('/wipe')} />}
        <Item icon="lock" label="Login history" sub="Sign-ins and failed attempts, and the rules you accepted" onPress={() => router.push('/logins')} />
        <Item icon="activity" label="Account activity" sub="Every action with time, IP and device" onPress={() => router.push('/activity')} />
        {me?.role === 'TRADER' && <>
          <Item icon="file" label="Ledger history" sub="Every credit and debit on your account" onPress={() => router.push('/ledger')} />
          <Item icon="alert" label="Rejection logs" sub="Rejected and cancelled orders, with the reason" onPress={() => router.push('/rejections')} />
          <Item icon="download" label="Bill download" sub="Statement PDF by week or custom dates" onPress={() => router.push('/statement')} />
        </>}
        <Item icon="book" label="View app T&C" sub="Terms and rules" onPress={() => setTerms(true)} />
        {!!settings?.helplineUrl && <Item icon="chat" label="Contact support" sub="Chat with us" onPress={() => void Linking.openURL(settings.helplineUrl)} />}
      </View>
      <Preferences />
      <Section title="Signed-in devices" action={(sessions.data?.mySessions.length ?? 0) > 1 ? <Button size="sm" kind="ghost" title="Sign out others" onPress={() => setOthers(true)} /> : undefined}>
        {sessions.error && !sessions.data ? <ErrorState error={sessions.error} retry={sessions.refetch} /> : !sessions.data ? <Skeleton rows={2} /> : sessions.data.mySessions.map((s) => (
          <ListRow key={s.id} left={<IconMark icon="device" />} title={s.deviceName ?? 'Unknown device'} sub={`${s.ip ?? ''} · last active ${when(s.lastUsedAt)}`}
            right={s.current ? <Badge text="This device" tone="ok" /> : <Button size="sm" kind="danger" title="Sign out" onPress={async () => { try { await gql(`mutation($id:ID!){ revokeSession(sessionId:$id) }`, { id: s.id }); toast('Device signed out'); } catch (e) { toast((e as Error).message, true); } void sessions.refetch(); }} />} />
        ))}
      </Section>
      <Button kind="danger" icon="logout" title="Sign out" size="lg" onPress={() => void signOut()} />
      <T v="xs" style={{ textAlign: 'center' }}>{settings?.appName ?? 'The K'} app {APP_VERSION} · API {settings?.apiVersion ?? '—'}</T>
      {pw && <ChangePassword onClose={() => setPw(false)} />}
      {mfa && <MfaSetupSheet onClose={() => setMfa(false)} />}
      <Sheet visible={others} title="Sign out other devices?" sub="Everyone signed in as you, except on this phone, will need to sign in again." onClose={() => setOthers(false)}>
        <Row>
          <Button block title="Cancel" onPress={() => setOthers(false)} />
          <Button block kind="sell" title="Sign them out" onPress={async () => {
            try { const d = await gql<{ revokeOtherSessions: number }>(`mutation { revokeOtherSessions }`); toast(`${d.revokeOtherSessions} device${d.revokeOtherSessions === 1 ? '' : 's'} signed out`); } catch (e) { toast((e as Error).message, true); }
            setOthers(false); void sessions.refetch();
          }} />
        </Row>
      </Sheet>
      <Sheet visible={terms} title="Rules" onClose={() => setTerms(false)}>
        {settings?.termsRules.map((r, i) => <Row key={i} style={{ alignItems: 'flex-start' }}><T c="brand" w="700">{i + 1}</T><T style={{ flex: 1 }}>{r}</T></Row>)}
      </Sheet>
    </Screen>
  );
}

/** Turn on two-step verification: open the authenticator app (or type the key), then enter its 6-digit code. */
export function MfaSetupSheet({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const { reload } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    gql<{ beginMfaEnrollment: { secret: string; otpauthUrl: string } }>(`mutation { beginMfaEnrollment { secret otpauthUrl } }`).then((d) => setSetup(d.beginMfaEnrollment)).catch((e) => setErr((e as Error).message));
  }, []);
  const key = setup?.secret.replace(/(.{4})/g, '$1 ').trim();
  return (
    <Sheet visible title="Two-step verification" sub="Sign-ins and sensitive actions will ask for a code from an authenticator app." onClose={onClose}>
      <T w="600">1. Add this account to your authenticator app</T>
      <Button kind="primary" icon="external" title="Open authenticator app" disabled={!setup} onPress={() => setup && void Linking.openURL(setup.otpauthUrl).catch(() => toast('No authenticator app found. Enter the key by hand.', true))} />
      <View style={{ gap: 4, padding: S[3], borderRadius: R.md, backgroundColor: t.bg2 }}>
        <T v="xs" c="text2">Or enter this key in the app (time-based):</T>
        {setup ? <T v="num" style={{ letterSpacing: 1 }} selectable>{key}</T> : <Skeleton rows={1} />}
      </View>
      <T w="600">2. Enter the 6-digit code it shows</T>
      <Field label="Code" keyboardType="number-pad" textContentType="oneTimeCode" maxLength={6} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} />
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind="primary" size="lg" title="Turn on" busy={busy} disabled={code.length !== 6 || !setup} onPress={async () => {
        setBusy(true); setErr(null);
        try { await gql(`mutation($c:String!){ confirmMfaEnrollment(code:$c) }`, { c: code }); await reload(); toast('Two-step verification is on'); onClose(); }
        catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }} />
    </Sheet>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strong = next.length >= 10 && [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(next)).length >= 3;
  return (
    <Sheet visible title="Change password" sub="Your other devices will be signed out." onClose={onClose}>
      <Field label="Current password" secureTextEntry value={cur} onChangeText={setCur} textContentType="password" />
      <Field label="New password" secureTextEntry value={next} onChangeText={setNext} textContentType="newPassword" hint={next && strong ? '✓ Strong enough' : 'At least 10 characters with three of: lowercase, uppercase, digits, symbols'} error={next && !strong ? 'Not strong enough yet' : null} />
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind="primary" size="lg" title="Change password" busy={busy} disabled={!cur || !strong} onPress={async () => {
        setBusy(true); setErr(null);
        try { await gql(`mutation($c:String!,$n:String!){ changePassword(currentPassword:$c, newPassword:$n) }`, { c: cur, n: next }); toast('Password changed'); onClose(); }
        catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
      }} />
    </Sheet>
  );
}

interface Note { id: string; kind: string; title: string; body: string; readAt?: string; createdAt: string }
const NoteRow = memo(function NoteRow({ n }: { n: Note }) {
  return (
    <ListRow left={<IconMark icon={n.kind.startsWith('security') ? 'shield' : n.kind.startsWith('payment') ? 'wallet' : n.kind.startsWith('order') ? 'list' : n.kind.startsWith('algo') ? 'activity' : 'bell'} tone={n.readAt ? undefined : 'brand'} />}
      title={<Spread><T w={n.readAt ? '500' : '700'} style={{ flex: 1 }} numberOfLines={1}>{n.title}</T><T v="xs">{when(n.createdAt)}</T></Spread>}
      sub={<T v="sm" c="text2">{n.body}</T>} />
  );
});
export function NotificationsView() {
  const { data, error, loading, refetch } = useQuery<{ notifications: Note[] }>(`{ notifications(limit:100){ id kind title body readAt createdAt } }`);
  const unread = data?.notifications.filter((n) => !n.readAt).length ?? 0;
  const state = loading && !data ? <Skeleton /> : error && !data ? <ErrorState error={error} retry={refetch} /> : <Empty icon="bell" title="You’re all caught up">Order fills, fund requests and security alerts appear here.</Empty>;
  return (
    <Screen title="Notifications" back scroll={false} right={unread ? <Button size="sm" kind="ghost" title="Mark read" onPress={async () => { await gql(`mutation { markNotificationsRead }`).catch(() => undefined); void refetch(); }} /> : undefined}>
      <VList data={data?.notifications ?? []} keyOf={(n) => n.id} empty={state} render={(n) => <NoteRow n={n} />} />
    </Screen>
  );
}

/**
 * Trading consent, once per signed-in session: traders accept the current rules before trading.
 * The API records each acceptance with time, IP, device, session and the exact rules text.
 */
export function TermsGate() {
  const t = useTheme();
  const { me } = useAuth();
  const splash = useSplashActive();
  const st = useQuery<{ tradingConsentStatus: { required: boolean; termsVersion: string; rules: string[] } }>(`{ tradingConsentStatus { required termsVersion rules } }`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = st.data?.tradingConsentStatus;
  if (!me || me.role !== 'TRADER' || !s?.required || splash) return null;
  return (
    <Sheet visible dismissable={false} title="Terms & Rules" sub="Please read before continuing" onClose={() => undefined}>
      {s.rules.map((r, i) => (
        <Row key={i} style={{ alignItems: 'flex-start' }} gap={S[3]}>
          <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}><T v="xs" c="brand" w="700">{i + 1}</T></View>
          <T style={{ flex: 1, lineHeight: 21 }}>{r}</T>
        </Row>
      ))}
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind="primary" size="lg" title="I UNDERSTAND & ACCEPT" busy={busy} onPress={async () => {
        setBusy(true); setErr(null);
        try {
          const d = await gql<{ acceptTradingConsent: { acceptedAt: string; ip: string } }>(`mutation($v:String!){ acceptTradingConsent(termsVersion:$v){ acceptedAt ip } }`, { v: s.termsVersion });
          toast(`Rules accepted · recorded from IP ${d.acceptTradingConsent.ip}`);
        } catch (e) { setErr((e as Error).message); }
        await st.refetch(); setBusy(false);
      }} />
    </Sheet>
  );
}

/* ====================================================================== login audit */
const LOGIN_LABEL_M: Record<string, string> = LOGIN_LABEL;
export function LoginHistoryList({ userId }: { userId?: string }) {
  const { data, error, loading, refetch } = useQuery<{ loginHistory: LoginEvent[] }>(`query($u:ID){ loginHistory(userId:$u, limit:50){ ${LOGIN_FIELDS} } }`, { u: userId });
  if (loading && !data) return <Skeleton />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.loginHistory.length) return <Empty icon="lock" title="No sign-ins recorded yet" />;
  return (
    <View>
      {data!.loginHistory.map((e) => (
        <ListRow key={e.seq} left={<IconMark icon={e.outcome === 'SUCCESS' ? 'lock' : 'alert'} tone={e.outcome === 'SUCCESS' ? 'pos' : 'neg'} />}
          title={<Row gap={6}><T w="600">{LOGIN_LABEL_M[e.action] ?? e.action}</T>{e.outcome !== 'SUCCESS' && <Badge text={e.outcome === 'DENIED' ? 'Blocked' : 'Failed'} tone={e.outcome === 'DENIED' ? 'warn' : 'bad'} />}</Row>}
          sub={<View><T v="xs">{stamp(e.at)}{e.detail ? ` · ${e.detail}` : ''}</T><T v="xs">IP {e.ip ?? '—'} · {deviceLabel(e.userAgent)}</T></View>} />
      ))}
    </View>
  );
}
export function ConsentList({ userId }: { userId?: string }) {
  const { data, error, loading, refetch } = useQuery<{ consentLog: ConsentRecord[] }>(`query($u:ID){ consentLog(userId:$u, limit:30){ ${CONSENT_FIELDS} } }`, { u: userId });
  if (loading && !data) return <Skeleton rows={2} />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.consentLog.length) return <Empty icon="shield" title="No consents yet" />;
  return (
    <View>
      {data!.consentLog.map((c) => (
        <ListRow key={c.id} left={<IconMark icon="shield" tone="brand" />} title="Accepted the trading rules"
          sub={<View><T v="xs">{stamp(c.acceptedAt)}</T><T v="xs">IP {c.ip} · {deviceLabel(c.userAgent)} · version {c.termsVersion.slice(0, 10)}…</T></View>} />
      ))}
    </View>
  );
}

/* ====================================================================== account detail (broker / admin) */
export function AccountDetailView({ id }: { id: string }) {
  const u = useQuery<{ user: { displayName: string; username: string; status: string; role: string } }>(`query($id:ID!){ user(id:$id){ displayName username status role } }`, { id });
  const [tab, setTab] = useState<'pos' | 'ord' | 'led' | 'req' | 'log'>('pos');
  const [pay, setPay] = useState<'DEPOSIT' | 'WITHDRAWAL' | null>(null);
  const t = useTheme();
  if (u.error && !u.data) return <Screen back title="Trader"><ErrorState error={u.error} retry={u.refetch} /></Screen>;
  const x = u.data?.user;
  return (
    <Screen back title={x?.displayName ?? 'Trader'} onRefresh={u.refetch}>
      {!x ? <Skeleton /> : (
        <>
          <Row>
            <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}><T v="h3" c="brand">{initials(x.displayName)}</T></View>
            <View style={{ flex: 1, gap: 4 }}><T v="h2">{x.displayName}</T><Row gap={S[2]}><T v="sm" c="text2">{x.username}</T><StatusBadge v={x.status} /></Row></View>
          </Row>
          <SummaryBlock userId={id} title="Available balance" />
          <Row>
            <Button block title="Request withdrawal" onPress={() => setPay('WITHDRAWAL')} />
            <Button block kind="primary" title="Request deposit" onPress={() => setPay('DEPOSIT')} />
          </Row>
          <Tabs scroll value={tab} onChange={setTab} items={[{ k: 'pos', label: 'Positions' }, { k: 'ord', label: 'Orders' }, { k: 'led', label: 'Ledger' }, { k: 'req', label: 'Fund requests' }, { k: 'log', label: 'Logins' }]} />
          {tab === 'log' && <LoginHistoryList userId={id} />}
          {tab === 'pos' && <PositionsList userId={id} />}
          {tab === 'ord' && <OrdersList userId={id} statuses={['OPEN', 'FILLED', 'REJECTED', 'CANCELLED']} emptyText="This trader hasn't placed any orders." />}
          {tab === 'led' && <LedgerList userId={id} />}
          {tab === 'req' && <RequestsList userId={id} />}
          <T v="xs" style={{ textAlign: 'center' }}>Read-only view. Traders place their own orders.</T>
          {pay && <PaymentSheet type={pay} userId={id} onClose={() => setPay(null)} />}
        </>
      )}
    </Screen>
  );
}

/* ====================================================================== preferences */
function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  const t = useTheme();
  return (
    <Pressable onPress={() => onChange(!on)} accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: on }} hitSlop={8}
      style={{ width: 46, height: 28, borderRadius: 14, backgroundColor: on ? t.brand : t.line2, padding: 3, justifyContent: 'center' }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff', transform: [{ translateX: on ? 18 : 0 }] }} />
    </Pressable>
  );
}
function Seg<K extends string>({ value, items, onChange }: { value: K; items: [K, string][]; onChange: (k: K) => void }) {
  const t = useTheme();
  return (
    <Row gap={0} style={{ borderWidth: 1, borderColor: t.line2, borderRadius: R.pill, padding: 2 }}>
      {items.map(([k, l]) => (
        <Pressable key={k} onPress={() => onChange(k)} accessibilityRole="button" accessibilityState={{ selected: value === k }} style={{ paddingHorizontal: 10, height: 28, justifyContent: 'center', borderRadius: R.pill, backgroundColor: value === k ? t.bg3 : 'transparent' }}>
          <T v="sm" c={value === k ? 'text' : 'text2'} w="600">{l}</T>
        </Pressable>
      ))}
    </Row>
  );
}
function Preferences() {
  const { prefs, set } = usePrefs();
  const rows: { icon: 'sun' | 'eye' | 'activity' | 'sound' | 'type' | 'bold' | 'list'; t: string; s: string; c: React.ReactNode }[] = [
    { icon: 'sun', t: 'Theme', s: 'System follows your phone. Also the button next to the bell.', c: <Seg value={prefs.theme} onChange={(v) => set('theme', v)} items={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} /> },
    { icon: 'eye', t: 'Hide balances', s: 'Mask all balance amounts.', c: <Switch label="Hide balances" on={prefs.hideBalances} onChange={(v) => set('hideBalances', v)} /> },
    { icon: 'activity', t: 'Charts', s: 'Show app charts where available.', c: <Switch label="Charts" on={prefs.charts} onChange={(v) => set('charts', v)} /> },
    { icon: 'sound', t: 'Trade sounds', s: 'Play tones (and vibrate) for trade events.', c: <Switch label="Trade sounds" on={prefs.sounds} onChange={(v) => set('sounds', v)} /> },
    { icon: 'type', t: 'Number size', s: 'Size of prices, P&L and other figures.', c: <Seg value={prefs.numberSize} onChange={(v) => set('numberSize', v)} items={[['S', 'S'], ['M', 'M'], ['L', 'L'], ['XL', 'XL']]} /> },
    { icon: 'bold', t: 'Bold numbers', s: 'Make all figures heavier and easier to read.', c: <Switch label="Bold numbers" on={prefs.boldNumbers} onChange={(v) => set('boldNumbers', v)} /> },
    { icon: 'list', t: 'Watchlist rows', s: 'Bid/ask boxes with day low/high, or simple.', c: <Seg value={prefs.watchlistView} onChange={(v) => set('watchlistView', v)} items={[['detailed', 'Bid/Ask'], ['simple', 'Simple']]} /> },
  ];
  return (
    <Section title="Preferences">
      {rows.map((r) => (
        <ListRow key={r.t} left={<IconMark icon={r.icon} />} title={r.t} sub={r.s} right={r.c} />
      ))}
    </Section>
  );
}

/* ====================================================================== announcement ticker */
/** Same fallback as the web ticker (apps/web/components/Shell.tsx). */
const DEFAULT_MARKET_MESSAGES = [
  'NSE (Indian Equities): 09:15 – 15:30 IST (Mon–Fri)',
  'MCX (Commodities): 09:00 – 23:30 IST (Mon–Fri)',
  'US Markets (NASDAQ / NYSE): 20:00 – 02:30 IST (09:30 – 16:00 EST)',
  'Crypto: 24/7 Live Trading',
];
export function Ticker() {
  const t = useTheme();
  const { settings } = useAuth();
  const [now, setNow] = useState(new Date());
  const active = useActive();
  useEffect(() => { if (!active) return; setNow(new Date()); const h = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(h); }, [active]);
  const clean = (settings?.tickerMessages ?? []).filter((m) => m && !m.includes('simulated and never sent'));
  const msgs = clean.length > 0 ? clean : DEFAULT_MARKET_MESSAGES;
  const text = msgs.join('   •   ');
  return (
    <Row gap={S[2]} style={{ backgroundColor: t.bg2, borderRadius: R.md, paddingHorizontal: S[3], height: 34, overflow: 'hidden' }}>
      <View style={{ flex: 1, overflow: 'hidden' }}>{!!text && <Marquee text={text} />}</View>
      <T v="xs" c="text" w="600" style={{ fontVariant: ['tabular-nums'] }}>{new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(11, 19)} IST</T>
    </Row>
  );
}
function Marquee({ text }: { text: string }) {
  const x = useRef(new Animated.Value(0)).current;
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!w) return;
    x.setValue(0);
    const a = Animated.loop(Animated.timing(x, { toValue: -w - 40, duration: Math.max(8000, w * 25), easing: Easing.linear, useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [w, x]);
  return (
    <Animated.View style={{ flexDirection: 'row', width: 10000, transform: [{ translateX: x }] }}>
      <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ flexShrink: 0 }}><T v="xs" c="text2">{text}</T></View>
      <View style={{ width: 40 }} />
      <View style={{ flexShrink: 0 }}><T v="xs" c="text2">{text}</T></View>
    </Animated.View>
  );
}

/** Helpline button for headers (when a support link is configured). */
export function HelplineButton() {
  const { settings } = useAuth();
  if (!settings?.helplineUrl) return null;
  return <IconButton icon="chat" label="Helpline" onPress={() => void Linking.openURL(settings.helplineUrl)} />;
}

/* ====================================================================== bill download */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function StatementBlock() {
  const [p, setP] = useState<'week' | 'lastWeek' | 'month' | 'custom'>('week');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const [cf, setCf] = useState(ymd(new Date(Date.now() - 29 * 86_400_000)));
  const [ct, setCt] = useState(ymd(today));
  const [busy, setBusy] = useState(false);
  const [from, to] = p === 'week' ? [ymd(monday), ymd(today)] : p === 'lastWeek' ? [ymd(new Date(monday.getTime() - 7 * 86_400_000)), ymd(new Date(monday.getTime() - 86_400_000))] : p === 'month' ? [ymd(new Date(today.getFullYear(), today.getMonth(), 1)), ymd(today)] : [cf, ct];
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const bad = !re.test(from) || !re.test(to) || from > to;
  return (
    <Section title="Bill download">
      <Chips value={p} onChange={setP} items={[{ k: 'week', label: 'This week' }, { k: 'lastWeek', label: 'Last week' }, { k: 'month', label: 'This month' }, { k: 'custom', label: 'Custom' }]} />
      {p === 'custom' && (
        <Row style={{ alignItems: 'flex-start' }}>
          <DateField label="From" value={cf} max={ct} onChange={setCf} />
          <DateField label="To" value={ct} min={cf} max={ymd(today)} onChange={setCt} />
        </Row>
      )}
      <T v="xs" c={bad ? 'neg' : 'text2'}>{bad ? 'Pick a start date on or before the end date.' : `${ymdLabel(from)} to ${ymdLabel(to)}: opening & closing balance, every transaction and trade.`}</T>
      <Button kind="primary" icon="download" title="Download statement (PDF)" busy={busy} disabled={bad} onPress={async () => {
        setBusy(true);
        try {
          const d = await gql<{ statementLink: { path: string } }>(`mutation($f:String!,$t:String!){ statementLink(from:$f, to:$t){ path } }`, { f: from, t: to });
          await Linking.openURL(API_URL + d.statementLink.path);
        } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
      }} />
    </Section>
  );
}

const APP_VERSION: string = (require('../package.json') as { version: string }).version;

export { CTL, StyleSheet };
