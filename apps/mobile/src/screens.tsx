/** Domain building blocks shared by trader / broker / admin screens. */
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { API_URL, gql, newKey, subscribe } from './api';
import { NUM_SCALE, usePrefs, usePrivate } from './prefs';
import { useSplashActive } from './splash';
import { CONSENT_FIELDS, deviceLabel, LOGIN_FIELDS, LOGIN_LABEL, stamp, type ConsentRecord, type LoginEvent } from './activity';
import { useAuth } from './auth';
import { Icon } from './icons';
import { CTL, inr, initials, R, S, shortSymbol, toneOfValue, useTheme, when } from './theme';
import {
  Badge, Button, Change, Chips, Divider, Empty, ErrorState, Field, IconButton, IconMark, ListRow, Mark, Metrics, Notice, Row, Screen, SearchBox,
  Section, Sheet, Skeleton, Spread, StatusBadge, T, Tabs, toast, useQuery,
} from './ui';

export interface Quote { instrumentId: string; ltp: string; bid: string; ask: string; high: string; low: string; change: string; changePct: string; ts: string; source: string }
export const QF = 'instrumentId ltp bid ask high low change changePct ts source';
interface Inst { id: string; symbol: string; name: string; exchange: string; segment: string; expiry?: string }

export function useLiveQuotes(ids: string[]) {
  const [q, setQ] = useState<Record<string, Quote>>({});
  const key = ids.slice().sort().join(',');
  useEffect(() => {
    if (!key) return;
    const list = key.split(',');
    gql<{ quotes: Quote[] }>(`query($i:[ID!]!){ quotes(instrumentIds:$i){ ${QF} } }`, { i: list }).then((d) => setQ((s) => ({ ...s, ...Object.fromEntries(d.quotes.map((x) => [x.instrumentId, x])) }))).catch(() => undefined);
    return subscribe<{ quotesUpdated: Quote[] }>(`subscription($i:[ID!]!){ quotesUpdated(instrumentIds:$i){ ${QF} } }`, { i: list }, (d) => setQ((s) => ({ ...s, ...Object.fromEntries(d.quotesUpdated.map((x) => [x.instrumentId, x])) })));
  }, [key]);
  return q;
}

/** Bell with unread count, used in headers. */
export function BellButton() {
  const { data } = useQuery<{ unreadNotificationCount: number }>(`{ unreadNotificationCount }`, undefined, 30_000);
  const n = data?.unreadNotificationCount ?? 0;
  return <IconButton icon="bell" label={`Notifications${n ? `, ${n} unread` : ''}`} badge={n} onPress={() => router.push('/notifications')} />;
}

/* ====================================================================== summary */
interface Summary { balance: string; available: string; marginUsed: string; realizedPnl: string; unrealizedPnl: string; openPositions: number; openOrders: number; deposits: string; withdrawals: string; fees: string }
export const SUMMARY = `query($u:ID){ accountSummary(userId:$u){ balance available marginUsed realizedPnl unrealizedPnl openPositions openOrders deposits withdrawals fees } }`;
export const useSummary = (userId?: string) => useQuery<{ accountSummary: Summary }>(SUMMARY, { u: userId }, 5000);

export function SummaryBlock({ userId, actions, title = 'Available to trade' }: { userId?: string; actions?: boolean; title?: string }) {
  const { data, error, loading, refetch } = useSummary(userId);
  const [pay, setPay] = useState<'DEPOSIT' | 'WITHDRAWAL' | null>(null);
  const priv = usePrivate();
  const s = data?.accountSummary;
  if (loading && !s) return <Skeleton rows={2} />;
  if (error && !s) return <ErrorState error={error} retry={refetch} />;
  return (
    <View style={{ gap: S[4] }}>
      <View style={{ gap: 2 }}>
        <Row gap={S[2]}><T c="text2">{title}</T><Badge text="Virtual ₹" tone="info" /></Row>
        <T v="hero" accessibilityRole="text">{priv(`₹${inr(s?.available)}`, 8)}</T>
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
        { k: 'Brokerage paid', v: `₹${inr(s?.fees)}` },
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
  const key = useMemo(newKey, []);
  const fmt = /^\d{1,12}(\.\d{1,2})?$/.test(amount) && Number(amount) > 0;
  const over = type === 'WITHDRAWAL' && !!available && fmt && Number(amount) > Number(available);
  const fieldErr = touched && (!fmt ? 'Enter an amount with up to 2 decimals' : over ? `You can withdraw up to ₹${inr(available)}` : null);
  return (
    <Sheet visible title={type === 'DEPOSIT' ? 'Add virtual funds' : 'Withdraw virtual funds'} sub="A Super Admin reviews every request. Virtual balances have no cash value." onClose={onClose}>
      <Field label="Amount" prefix="₹" keyboardType="decimal-pad" value={amount} autoFocus onBlur={() => setTouched(true)} onChangeText={(v) => setAmount(v.replace(/[^\d.]/g, ''))} placeholder="0.00" error={fieldErr || null} hint={type === 'WITHDRAWAL' && available ? `Withdrawable now: ₹${inr(available)}` : undefined} />
      {type === 'DEPOSIT' && <Chips value={amount} onChange={setAmount} items={['10000', '25000', '50000', '100000'].map((v) => ({ k: v, label: `+₹${inr(v).replace('.00', '')}` }))} />}
      {err && <Notice tone="err">{err}</Notice>}
      <Button kind="primary" size="lg" title="Send request" busy={busy} onPress={async () => {
        setTouched(true);
        if (!fmt || over) return;
        setBusy(true); setErr(null);
        try { await gql(`mutation($i:PaymentRequestInput!){ requestPayment(input:$i){ id } }`, { i: { type, amount, idempotencyKey: key, userId } }); toast('Request sent for review'); onClose(); }
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
export function WatchlistBlock({ limit }: { limit?: number }) {
  const t = useTheme();
  const { settings } = useAuth();
  const { prefs } = usePrefs();
  const [list, setList] = useState('0');
  const counts = useQuery<{ watchlistCounts: { listIndex: number; count: number }[] }>(`{ watchlistCounts { listIndex count } }`);
  const [extra, setExtra] = useState(0);
  const used = counts.data?.watchlistCounts ?? [];
  const max = settings?.maxWatchlists ?? 10;
  const shown = Math.min(max, Math.max(3, ...used.map((c) => c.listIndex + 1), Number(list) + 1) + extra);
  const detailed = !limit && prefs.watchlistView === 'detailed';
  const { data, error, loading, refetch } = useQuery<{ watchlist: WEntry[] }>(`query($l:Int!){ watchlist(listIndex:$l){ id instrument{ id symbol name exchange segment expiry } } }`, { l: Number(list) });
  const entries = (data?.watchlist ?? []).slice(0, limit ?? 100);
  const q = useLiveQuotes(entries.map((e) => e.instrument.id));
  const [search, setSearch] = useState(false);
  const [manage, setManage] = useState<WEntry | null>(null);
  return (
    <View style={{ gap: S[2] }}>
      <Tabs scroll value={list} onChange={setList} items={Array.from({ length: shown }, (_, k) => ({ k: String(k), label: `Watchlist ${k + 1}` }))}
        right={<Row gap={0}>{!limit && shown < max && <IconButton icon="plus" label="New watchlist" onPress={() => { setExtra((x) => x + 1); setList(String(shown)); }} />}<IconButton icon="search" label="Add script" onPress={() => setSearch(true)} /></Row>} />
      {!limit && <T v="xs" c="text2">{entries.length} script{entries.length === 1 ? '' : 's'} · Watchlist {Number(list) + 1}</T>}
      {loading && !data ? <Skeleton /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !entries.length ? (
        <Empty icon="eye" title="Nothing in this list" action={<Button size="sm" title="Add instruments" onPress={() => setSearch(true)} />}>Track prices by adding instruments.</Empty>
      ) : entries.map((e) => {
        const qq = q[e.instrument.id];
        if (detailed) return (
          <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', gap: S[2], paddingVertical: S[3], borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line }}>
            <Pressable onPress={() => router.push(`/instrument/${e.instrument.id}`)} onLongPress={() => setManage(e)} accessibilityRole="button" accessibilityLabel={`${shortSymbol(e.instrument.symbol)}, ${qq?.ltp ?? ''}`} accessibilityHint="Long press to remove" style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Row gap={6}><T w="700" numberOfLines={1}>{shortSymbol(e.instrument.symbol)}</T><Badge text={e.instrument.segment} /></Row>
              <Row gap={6}><T v="num" c={toneOfValue(qq?.change) === 'neg' ? 'neg' : 'pos'}>{inr(qq?.ltp)}</T><Change value={qq?.change} pct={qq?.changePct} pctOnly /></Row>
            </Pressable>
            {(['SELL', 'BUY'] as const).map((sd) => (
              <Pressable key={sd} onPress={() => router.push(`/instrument/${e.instrument.id}?side=${sd}`)} accessibilityRole="button" accessibilityLabel={`${sd === 'BUY' ? 'Buy' : 'Sell'} at ${sd === 'BUY' ? qq?.ask : qq?.bid}`} style={{ alignItems: 'center', gap: 2 }}>
                <View style={{ minWidth: 76, paddingVertical: 6, paddingHorizontal: 8, borderRadius: R.md, backgroundColor: sd === 'BUY' ? t.posSoft : t.negSoft, alignItems: 'center' }}>
                  <T v="num" c={sd === 'BUY' ? 'pos' : 'neg'}>{inr(sd === 'BUY' ? qq?.ask : qq?.bid)}</T>
                </View>
                <T v="xs">{sd === 'BUY' ? `H: ${inr(qq?.high)}` : `L: ${inr(qq?.low)}`}</T>
              </Pressable>
            ))}
          </View>
        );
        return (
          <ListRow key={e.id} onPress={() => router.push(`/instrument/${e.instrument.id}`)} label={`${shortSymbol(e.instrument.symbol)}, ₹${qq?.ltp ?? ''}`}
            title={shortSymbol(e.instrument.symbol)} sub={`${e.instrument.exchange} · ${e.instrument.segment}`}
            right={
              <Pressable onLongPress={() => setManage(e)} accessibilityHint="Long press to remove" style={{ alignItems: 'flex-end', gap: 2 }}>
                <T v="num">₹{inr(qq?.ltp)}</T>
                <Change value={qq?.change} pct={qq?.changePct} />
              </Pressable>
            } />
        );
      })}
      {!!entries.length && <T v="xs" style={{ textAlign: 'center' }}>{detailed ? 'Tap a sell or buy price to trade. Long-press a name to remove it.' : 'Long-press a price to remove it from the list.'}</T>}
      {search && <AddSheet list={Number(list)} onClose={() => { setSearch(false); void refetch(); void counts.refetch(); }} />}
      <Sheet visible={!!manage} title={manage ? shortSymbol(manage.instrument.symbol) : ''} sub={manage?.instrument.name} onClose={() => setManage(null)}>
        <Button kind="danger" icon="x" title={`Remove from list ${Number(list) + 1}`} onPress={async () => {
          if (!manage) return;
          try { await gql(`mutation($l:Int!,$i:ID!){ removeFromWatchlist(listIndex:$l, instrumentId:$i) }`, { l: Number(list), i: manage.instrument.id }); toast('Removed'); } catch (e) { toast((e as Error).message, true); }
          setManage(null); void refetch();
        }} />
      </Sheet>
    </View>
  );
}

function AddSheet({ list, onClose }: { list: number; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Inst[] | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  useEffect(() => {
    const h = setTimeout(() => gql<{ searchInstruments: Inst[] }>(`query($q:String!){ searchInstruments(query:$q, limit:20){ id symbol name exchange segment } }`, { q }).then((d) => setRes(d.searchInstruments)).catch(() => setRes([])), 180);
    return () => clearTimeout(h);
  }, [q]);
  return (
    <Sheet visible title={`Add to list ${list + 1}`} onClose={onClose}>
      <SearchBox value={q} onChangeText={setQ} placeholder="Search symbol or company" autoFocus />
      {res === null ? <Skeleton rows={3} /> : !res.length ? <Empty icon="search" title={`No results for “${q}”`} /> : res.slice(0, 10).map((r) => (
        <ListRow key={r.id} left={<Mark text={shortSymbol(r.symbol)} />} title={shortSymbol(r.symbol)} sub={r.name}
          right={<Button size="sm" title={added.includes(r.id) ? 'Added' : 'Add'} icon={added.includes(r.id) ? 'check' : undefined} disabled={added.includes(r.id)} onPress={async () => {
            try { await gql(`mutation($l:Int!,$i:ID!){ addToWatchlist(listIndex:$l, instrumentId:$i) }`, { l: list, i: r.id }); setAdded((a) => [...a, r.id]); } catch (e) { toast((e as Error).message, true); }
          }} />} />
      ))}
    </Sheet>
  );
}

/* ====================================================================== orders / positions / ledger */
const OTYPE: Record<string, string> = { MARKET: 'Market', LIMIT: 'Limit', STOP_LOSS: 'Stop-loss', TAKE_PROFIT: 'Take-profit' };
interface Order { id: string; side: string; type: string; quantity: number; limitPrice?: string; triggerPrice?: string; triggeredAt?: string; fillPrice?: string; status: string; venue: string; rejectReason?: string; createdAt: string; instrument?: { symbol: string } }
export function OrdersList({ userId, statuses, canCancel, emptyTitle = 'No orders', emptyText }: { userId?: string; statuses: string[]; canCancel?: boolean; emptyTitle?: string; emptyText?: string }) {
  const { data, error, loading, refetch } = useQuery<{ orders: Order[] }>(`query($u:ID,$s:[OrderStatus!]){ orders(userId:$u, status:$s, limit:100){ id side type quantity limitPrice triggerPrice triggeredAt fillPrice status venue rejectReason createdAt instrument{ symbol } } }`, { u: userId, s: statuses }, 4000);
  const [cancel, setCancel] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  if (loading && !data) return <Skeleton />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.orders.length) return <Empty icon="list" title={emptyTitle}>{emptyText}</Empty>;
  return (
    <View>
      {data!.orders.map((o) => (
        <ListRow key={o.id} onPress={canCancel && o.status === 'OPEN' ? () => setCancel(o) : undefined}
          title={o.instrument ? shortSymbol(o.instrument.symbol) : '—'}
          sub={<View style={{ gap: 2 }}><Row gap={6}><T v="xs" c={o.side === 'BUY' ? 'pos' : 'neg'} w="600">{o.side === 'BUY' ? 'Buy' : 'Sell'}</T><T v="xs">{o.quantity} qty · {OTYPE[o.type] ?? o.type}{o.triggerPrice ? ` @ ₹${inr(o.triggerPrice)}` : ''} · {when(o.createdAt)}</T></Row>{o.rejectReason ? <T v="xs" c="neg">{o.rejectReason}</T> : null}</View>}
          right={<View style={{ alignItems: 'flex-end', gap: 4 }}><T v="num">₹{inr(o.fillPrice ?? o.limitPrice ?? o.triggerPrice)}</T><StatusBadge v={o.status} /></View>} />
      ))}
      <Sheet visible={!!cancel} title="Cancel this order?" sub={cancel ? `${cancel.side === 'BUY' ? 'Buy' : 'Sell'} ${cancel.quantity} ${shortSymbol(cancel.instrument?.symbol ?? '')} ${cancel.triggerPrice ? ' trigger' : ''} at ₹${inr(cancel.limitPrice ?? cancel.triggerPrice)}` : ''} onClose={() => setCancel(null)}>
        <Row>
          <Button block title="Keep order" onPress={() => setCancel(null)} />
          <Button block kind="sell" title="Cancel order" busy={busy} onPress={async () => {
            if (!cancel) return; setBusy(true);
            try { await gql(`mutation($id:ID!){ cancelOrder(orderId:$id){ id } }`, { id: cancel.id }); toast('Order cancelled'); } catch (e) { toast((e as Error).message, true); }
            setBusy(false); setCancel(null); void refetch();
          }} />
        </Row>
      </Sheet>
    </View>
  );
}

interface Pos { id: string; instrumentId: string; netQty: number; avgPrice: string; realizedPnl: string; unrealizedPnl?: string; ltp?: string; instrument?: { symbol: string } }
export function PositionsList({ userId, canTrade }: { userId?: string; canTrade?: boolean }) {
  const { data, error, loading, refetch } = useQuery<{ positions: Pos[] }>(`query($u:ID){ positions(userId:$u){ id instrumentId netQty avgPrice realizedPnl unrealizedPnl ltp instrument{ symbol } } }`, { u: userId }, 3000);
  if (loading && !data) return <Skeleton />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.positions.length) return <Empty icon="briefcase" title="No positions" action={canTrade ? <Button size="sm" kind="primary" title="Explore instruments" onPress={() => router.push('/(trader)')} /> : undefined}>A position opens when a buy or sell order executes.</Empty>;
  const total = data!.positions.reduce((a, p) => a + Number(p.unrealizedPnl ?? 0), 0).toFixed(2);
  return (
    <View>
      <Spread style={{ paddingVertical: S[3] }}><T c="text2">Total open P&L</T><T v="numLg" c={toneOfValue(total) === 'flat' ? 'text2' : (toneOfValue(total) as 'pos')}>{inr(total, true)}</T></Spread>
      <Divider />
      {data!.positions.map((p) => (
        <ListRow key={p.id}
          onPress={canTrade && p.netQty !== 0 ? () => router.push(`/instrument/${p.instrumentId}?side=${p.netQty > 0 ? 'SELL' : 'BUY'}&qty=${Math.abs(p.netQty)}`) : undefined}
          label={canTrade ? 'Open exit order' : undefined}
          title={p.instrument ? shortSymbol(p.instrument.symbol) : '—'}
          sub={`${p.netQty > 0 ? 'Long' : p.netQty < 0 ? 'Short' : 'Closed'} ${Math.abs(p.netQty)} · avg ₹${inr(p.avgPrice)} · LTP ₹${inr(p.ltp)}`}
          right={<View style={{ alignItems: 'flex-end', gap: 2 }}><T v="num" c={toneOfValue(p.unrealizedPnl) === 'flat' ? 'text2' : (toneOfValue(p.unrealizedPnl) as 'pos')}>{inr(p.unrealizedPnl, true)}</T><T v="xs">Booked {inr(p.realizedPnl, true)}</T></View>} />
      ))}
    </View>
  );
}

const KIND: Record<string, string> = { OPENING_BALANCE: 'Opening balance', DEPOSIT: 'Funds added', WITHDRAWAL: 'Withdrawal', TRADE_PNL: 'Trade P&L', FEE: 'Brokerage', ADJUSTMENT: 'Adjustment', REVERSAL: 'Reversal' };
export function LedgerList({ userId }: { userId?: string }) {
  const { data, error, loading, refetch } = useQuery<{ ledgerHistory: { postingId: string; kind: string; memo: string; amount: string; createdAt: string }[] }>(`query($u:ID){ ledgerHistory(userId:$u, limit:60){ postingId kind memo amount createdAt } }`, { u: userId });
  if (loading && !data) return <Skeleton />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.ledgerHistory.length) return <Empty icon="file" title="No transactions yet">Trades, charges and fund movements appear here.</Empty>;
  return (
    <View>
      {data!.ledgerHistory.map((x) => {
        const tn = toneOfValue(x.amount);
        return <ListRow key={x.postingId} left={<IconMark icon={tn === 'pos' ? 'down' : 'up'} tone={tn === 'pos' ? 'pos' : undefined} />} title={KIND[x.kind] ?? x.kind} sub={`${x.memo} · ${when(x.createdAt)}`}
          right={<T v="num" c={tn === 'flat' ? 'text2' : (tn as 'pos')}>{inr(x.amount, true)}</T>} />;
      })}
    </View>
  );
}

interface Pay { id: string; username?: string; type: string; amount: string; status: string; reviewNote?: string; createdAt: string }
export function RequestsList({ userId, showName }: { userId?: string; showName?: boolean }) {
  const { data, error, loading, refetch } = useQuery<{ paymentRequests: Pay[] }>(`query($u:ID){ paymentRequests(userId:$u, limit:50){ id username type amount status reviewNote createdAt } }`, { u: userId }, 10000);
  if (loading && !data) return <Skeleton />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.paymentRequests.length) return <Empty icon="wallet" title="No fund requests" />;
  return (
    <View>
      {data!.paymentRequests.map((p) => (
        <ListRow key={p.id} title={`${showName && p.username ? `${p.username} · ` : ''}${p.type === 'DEPOSIT' ? 'Add funds' : 'Withdraw'}`} sub={`${when(p.createdAt)}${p.reviewNote ? ` · ${p.reviewNote}` : ''}`}
          right={<View style={{ alignItems: 'flex-end', gap: 4 }}><T v="num">₹{inr(p.amount)}</T><StatusBadge v={p.status} /></View>} />
      ))}
    </View>
  );
}

/* ====================================================================== profile / notifications */
interface Sess { id: string; deviceName?: string; ip?: string; lastUsedAt: string; current: boolean }
export function ProfileView() {
  const t = useTheme();
  const { me, signOut, settings } = useAuth();
  const sessions = useQuery<{ mySessions: Sess[] }>(`{ mySessions { id deviceName ip lastUsedAt current } }`);
  const [pw, setPw] = useState(false);
  const [terms, setTerms] = useState(false);
  const role = me?.role === 'SUPER_ADMIN' ? 'Super Admin' : me?.role === 'BROKER' ? 'Broker' : 'Trader';
  const Item = ({ icon, label, sub, onPress }: { icon: 'key' | 'book' | 'chat' | 'shield' | 'file' | 'alert' | 'download' | 'activity' | 'device' | 'lock'; label: string; sub?: string; onPress?: () => void }) => (
    <ListRow onPress={onPress} label={label} left={<IconMark icon={icon} />} title={label} sub={sub} right={onPress ? <Icon name="chevronRight" size={18} color={t.text3} /> : undefined} />
  );
  return (
    <Screen title="Profile" right={<BellButton />} onRefresh={sessions.refetch}>
      <Row>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}><T v="h3" c="brand">{initials(me?.displayName ?? '')}</T></View>
        <View style={{ flex: 1 }}><T v="h2">{me?.displayName}</T><T v="sm" c="text2">{me?.username} · {role}{me?.isDemo ? ' · demo' : ''}</T></View>
      </Row>
      <View>
        <Item icon="shield" label="Two-step verification" sub={me?.mfaEnabled ? 'On' : 'Off. Set it up on the web portal'} />
        {!me?.isDemo && <Item icon="key" label="Change password" onPress={() => setPw(true)} />}
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
      <Section title="Signed-in devices">
        {sessions.error && !sessions.data ? <ErrorState error={sessions.error} retry={sessions.refetch} /> : !sessions.data ? <Skeleton rows={2} /> : sessions.data.mySessions.map((s) => (
          <ListRow key={s.id} left={<IconMark icon="device" />} title={s.deviceName ?? 'Unknown device'} sub={`${s.ip ?? ''} · last active ${when(s.lastUsedAt)}`}
            right={s.current ? <Badge text="This device" tone="ok" /> : <Button size="sm" kind="danger" title="Sign out" onPress={async () => { try { await gql(`mutation($id:ID!){ revokeSession(sessionId:$id) }`, { id: s.id }); toast('Device signed out'); } catch (e) { toast((e as Error).message, true); } void sessions.refetch(); }} />} />
        ))}
      </Section>
      <Button kind="danger" icon="logout" title="Sign out" size="lg" onPress={() => void signOut()} />
      <T v="xs" style={{ textAlign: 'center' }}>{settings?.appName ?? 'The K'} app {APP_VERSION} · API {settings?.apiVersion ?? '—'}</T>
      {pw && <ChangePassword onClose={() => setPw(false)} />}
      <Sheet visible={terms} title="Rules" onClose={() => setTerms(false)}>
        {settings?.termsRules.map((r, i) => <Row key={i} style={{ alignItems: 'flex-start' }}><T c="brand" w="700">{i + 1}</T><T style={{ flex: 1 }}>{r}</T></Row>)}
      </Sheet>
    </Screen>
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

export function NotificationsView() {
  const { data, error, loading, refetch } = useQuery<{ notifications: { id: string; kind: string; title: string; body: string; readAt?: string; createdAt: string }[] }>(`{ notifications(limit:100){ id kind title body readAt createdAt } }`);
  const unread = data?.notifications.filter((n) => !n.readAt).length ?? 0;
  return (
    <Screen title="Notifications" back onRefresh={refetch} right={unread ? <Button size="sm" kind="ghost" title="Mark read" onPress={async () => { await gql(`mutation { markNotificationsRead }`).catch(() => undefined); void refetch(); }} /> : undefined}>
      {loading && !data ? <Skeleton /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !data!.notifications.length ? <Empty icon="bell" title="You’re all caught up">Order fills, fund requests and security alerts appear here.</Empty> : (
        <View>{data!.notifications.map((n) => (
          <ListRow key={n.id} left={<IconMark icon={n.kind.startsWith('security') ? 'shield' : n.kind.startsWith('payment') ? 'wallet' : n.kind.startsWith('order') ? 'list' : 'bell'} tone={n.readAt ? undefined : 'brand'} />}
            title={<Spread><T w={n.readAt ? '500' : '700'} style={{ flex: 1 }} numberOfLines={1}>{n.title}</T><T v="xs">{when(n.createdAt)}</T></Spread>}
            sub={<T v="sm" c="text2">{n.body}</T>} />
        ))}</View>
      )}
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
    { icon: 'sun', t: 'Theme', s: 'Auto follows your phone.', c: <Seg value={prefs.theme} onChange={(v) => set('theme', v)} items={[['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']]} /> },
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
export function Ticker() {
  const t = useTheme();
  const { settings } = useAuth();
  const [now, setNow] = useState(new Date());
  useEffect(() => { const h = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(h); }, []);
  const msgs = (settings?.tickerMessages ?? []).filter(Boolean);
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
          <View style={{ flex: 1 }}><Field label="From (YYYY-MM-DD)" value={cf} onChangeText={setCf} maxLength={10} keyboardType="numbers-and-punctuation" /></View>
          <View style={{ flex: 1 }}><Field label="To (YYYY-MM-DD)" value={ct} onChangeText={setCt} maxLength={10} keyboardType="numbers-and-punctuation" /></View>
        </Row>
      )}
      <T v="xs" c={bad ? 'neg' : 'text2'}>{bad ? 'Enter dates as YYYY-MM-DD, with the start on or before the end.' : `${from} to ${to}: opening & closing balance, every transaction and trade.`}</T>
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
