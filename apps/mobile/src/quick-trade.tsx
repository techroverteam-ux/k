/**
 * Marketwatch-style trading on mobile (as in the client's reference app):
 *  - QuickTradeSheet: tap an instrument row → bid/ask with low/high, Market/Limit/SL, lots, SELL/BUY,
 *    Chart / Market Depth / Info, OHLC and the contract numbers.
 *  - TradeBook: the "Trade" list with Success / Pending / Rejected, search, deal P&L and how long it was held;
 *    tap a trade for its details and "Repeat order".
 * Every figure shown comes from the server; nothing is filled in with sample numbers.
 */
import { router } from 'expo-router';
import { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { gql, newKey } from './api';
import { tradeFeedback } from './prefs';
import { useLiveQuotes, type Quote } from './screens';
import { inr, R, S, shortSymbol, toneOfValue, useTheme } from './theme';
import { Badge, Button, Chips, Empty, ErrorState, Field, Flash, Notice, Row, SearchBox, Sheet, Skeleton, Spread, T, Tabs, tap, toast, useQuery, VList } from './ui';

type Side = 'BUY' | 'SELL';
type OType = 'MARKET' | 'LIMIT' | 'STOP_LOSS';
interface Inst { id: string; symbol: string; name: string; exchange: string; segment: string; expiry?: string; lotSize: number; tickSize: string; lotClass?: string; lotLabel?: string; category?: string }
interface Rules { minQty: number; maxQtyPerOrder: number; maxQtyPerInstrument: number; brokeragePerLot?: string; brokeragePerMegaLot?: string; sessions: { exchange: string; isOpen: boolean; message?: string }[] }
interface Extra { open?: string; close?: string; volume?: string; avgPrice?: string }

/** "Gold Mini Dec 04": the instrument name with its expiry, like the reference app. */
export const titleOf = (i: { name: string; symbol: string; expiry?: string }) =>
  `${i.name.replace(/ — .*/, '').replace(/\s*\(.*\)\s*$/, '') || shortSymbol(i.symbol)}${i.expiry ? ` ${new Date(i.expiry).toLocaleDateString('en-IN', { month: 'short', day: '2-digit' })}` : ''}`;
const clock = (d?: string | Date) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '—');
const val = (v?: string | number | null) => (v === undefined || v === null || v === '' ? '—' : String(v));

/* ============================================================== quick trade sheet */
export function QuickTradeSheet({ instrumentId, initialSide, initialQty, onClose }: { instrumentId: string; initialSide?: Side; initialQty?: number; onClose: () => void }) {
  const t = useTheme();
  const inst = useQuery<{ instrument: Inst }>(`query($id:ID!){ instrument(id:$id){ id symbol name exchange segment expiry lotSize tickSize lotClass lotLabel category } }`, { id: instrumentId });
  const rules = useQuery<{ tradingRules: Rules }>(`{ tradingRules { minQty maxQtyPerOrder maxQtyPerInstrument brokeragePerLot brokeragePerMegaLot sessions { exchange isOpen message } } }`);
  const extra = useQuery<{ quotes: Extra[] }>(`query($i:[ID!]!){ quotes(instrumentIds:$i){ open close volume avgPrice } }`, { i: [instrumentId] }, 5000);
  const q = useLiveQuotes([instrumentId])[instrumentId];
  const x = extra.data?.quotes[0];
  const i = inst.data?.instrument;
  const r = rules.data?.tradingRules;
  const [type, setType] = useState<OType>('MARKET');
  const [qty, setQty] = useState(String(initialQty ?? 1));
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState<Side | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  useEffect(() => { setKey(newKey()); }, [type, qty, price]);
  const n = Number(qty);
  const session = i && r ? r.sessions.find((s) => s.exchange === i.exchange) : undefined;
  const qtyErr = !qty ? 'Enter lots' : !Number.isInteger(n) || n <= 0 ? 'Whole lots only' : r && n > r.maxQtyPerOrder ? `Max ${r.maxQtyPerOrder} lots per order` : null;
  const priceErr = type === 'MARKET' ? null : !/^\d+(\.\d{1,2})?$/.test(price) ? 'Enter a price' : null;

  const place = async (side: Side) => {
    if (!i || qtyErr || priceErr) return;
    setBusy(side); setErr(null); tap();
    try {
      const d = await gql<{ placeOrder: { status: string; fillPrice?: string; rejectReason?: string } }>(
        `mutation($i:PlaceOrderInput!){ placeOrder(input:$i){ status fillPrice rejectReason } }`,
        { i: { instrumentId: i.id, side, type, quantity: n, limitPrice: type === 'LIMIT' ? price : undefined, triggerPrice: type === 'STOP_LOSS' ? price : undefined, idempotencyKey: key } },
      );
      const o = d.placeOrder;
      setKey(newKey());
      if (o.status === 'REJECTED') { tradeFeedback('reject'); setErr(o.rejectReason ?? 'Rejected'); return; }
      tradeFeedback(o.status === 'FILLED' ? 'fill' : 'placed');
      toast(o.status === 'FILLED' ? `${side === 'BUY' ? 'Bought' : 'Sold'} ${n} lot${n > 1 ? 's' : ''} at ₹${inr(o.fillPrice)}` : `${side === 'BUY' ? 'Buy' : 'Sell'} order placed`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const box = (side: Side) => {
    const v = side === 'BUY' ? q?.ask : q?.bid;
    return (
      <Pressable onPress={() => void place(side)} disabled={!!busy || !i} accessibilityRole="button" accessibilityLabel={`${side === 'BUY' ? 'Buy' : 'Sell'} at ${v ?? ''}`} style={{ alignItems: 'center', gap: 2 }}>
        <Flash value={v} style={{ borderRadius: R.md, overflow: 'hidden' }}>
          <View style={{ minWidth: 92, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: side === 'BUY' ? t.posSoft : t.negSoft, alignItems: 'center' }}>
            <T v="num" c={side === 'BUY' ? 'pos' : 'neg'}>{inr(v)}</T>
          </View>
        </Flash>
        <T v="xs">{side === 'BUY' ? `H: ${inr(q?.high)}` : `L: ${inr(q?.low)}`}</T>
      </Pressable>
    );
  };
  const go = (path: string) => { onClose(); router.push(path as never); };

  return (
    <Sheet visible title={i ? titleOf(i) : '…'} sub={i ? `${shortSymbol(i.symbol)} · ${i.category === 'FOREX' ? 'Forex' : i.exchange}${i.lotLabel ? ` · 1 lot = ${i.lotLabel}` : ''}` : undefined} onClose={onClose}>
      {inst.error ? <Notice tone="err">{inst.error}</Notice> : null}
      <Spread style={{ alignItems: 'center' }}>
        <View style={{ gap: 2 }}>
          <T v="numLg" c={toneOfValue(q?.change) === 'neg' ? 'neg' : 'pos'}>{inr(q?.ltp)}</T>
          <T v="sm" c={toneOfValue(q?.change) === 'neg' ? 'neg' : 'pos'}>{inr(q?.change, true)} ({inr(q?.changePct, true)}%)</T>
        </View>
        <Row gap={S[2]}>{box('SELL')}{box('BUY')}</Row>
      </Spread>

      <Chips value={type} onChange={(v) => { setType(v); setPrice(''); }} items={[{ k: 'MARKET', label: 'Market' }, { k: 'LIMIT', label: 'Limit' }, { k: 'STOP_LOSS', label: 'SL' }]} />
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 4 }}>
          <T v="sm" c="text2" w="500">Lots</T>
          <Row gap={4} style={{ alignItems: 'center' }}>
            <Button size="sm" title="−" onPress={() => setQty(String(Math.max(1, (n || 1) - 1)))} />
            <View style={{ flex: 1 }}><Field label="" accessibilityLabel="Lots" keyboardType="number-pad" value={qty} onChangeText={(v) => setQty(v.replace(/\D/g, ''))} style={{ textAlign: 'center' }} /></View>
            <Button size="sm" title="+" onPress={() => setQty(String((n || 0) + 1))} />
          </Row>
          {qtyErr ? <T v="xs" c="neg">{qtyErr}</T> : null}
        </View>
        {type !== 'MARKET' && (
          <View style={{ flex: 1 }}>
            <Field label={type === 'LIMIT' ? 'Limit price' : 'Trigger (LTP)'} prefix="₹" keyboardType="decimal-pad" value={price} placeholder={q?.ltp} onChangeText={(v) => setPrice(v.replace(/[^\d.]/g, ''))} error={price ? priceErr : null} />
          </View>
        )}
      </Row>
      {session && !session.isOpen && session.message ? <Notice tone="warn">{session.message}</Notice> : null}
      {err ? <Notice tone="err">{err}</Notice> : null}
      <Row>
        <View style={{ flex: 1 }}><Button block size="lg" kind="sell" title="SELL" busy={busy === 'SELL'} disabled={!i || !q || !!qtyErr || !!priceErr || !!busy} onPress={() => void place('SELL')} /></View>
        <View style={{ flex: 1 }}><Button block size="lg" kind="buy" title="BUY" busy={busy === 'BUY'} disabled={!i || !q || !!qtyErr || !!priceErr || !!busy} onPress={() => void place('BUY')} /></View>
      </Row>
      <T v="xs" c="text3">Simulated order. Brokerage ₹{inr((i?.lotClass === 'MEGA' ? r?.brokeragePerMegaLot : r?.brokeragePerLot) ?? '0')} per lot to open and again to cut.</T>

      <Row gap={S[2]}>
        <View style={{ flex: 1 }}><Button block size="sm" icon="trend" title="Chart" onPress={() => go(`/instrument/${instrumentId}?view=chart`)} /></View>
        <View style={{ flex: 1.3 }}><Button block size="sm" title="Market Depth" onPress={() => go(`/instrument/${instrumentId}?view=depth`)} /></View>
        <View style={{ flex: 1 }}><Button block size="sm" icon="info" title="Info" onPress={() => go(`/instrument/${instrumentId}?view=details`)} /></View>
      </Row>

      <View style={{ flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: t.line, paddingVertical: S[2] }}>
        {([['Open', x?.open], ['High', q?.high], ['Low', q?.low], ['Close', x?.close]] as const).map(([k, v], idx) => (
          <View key={k} style={{ flex: 1, alignItems: 'center', borderLeftWidth: idx ? StyleSheet.hairlineWidth : 0, borderColor: t.line2 }}>
            <T v="sm" c="text2">{k}</T><T v="num">{inr(v)}</T>
          </View>
        ))}
      </View>
      <Grid rows={[
        ['LTP', inr(q?.ltp), 'Time', clock(q?.ts)],
        ['Volume', val(x?.volume), 'Avg. price', x?.avgPrice ? inr(x.avgPrice) : '—'],
        ['Max lots (open)', val(r?.maxQtyPerInstrument), 'Max lots / order', val(r?.maxQtyPerOrder)],
        ['Min lots', val(r?.minQty), 'Lot step', '1'],
        ['Lot size', i ? (i.lotLabel ?? String(i.lotSize)) : '—', 'Lot type', i?.category === 'MCX' ? (i.lotClass === 'MEGA' ? 'Mega' : 'Mini') : '—'],
      ]} />
    </Sheet>
  );
}

/** Two label/value pairs per row, like the reference app's details table. */
function Grid({ rows }: { rows: [string, string, string, string][] }) {
  const t = useTheme();
  return (
    <View>
      {rows.map((r, idx) => (
        <View key={idx} style={{ flexDirection: 'row', gap: S[3], paddingVertical: S[2], backgroundColor: idx % 2 ? 'transparent' : t.bg2, paddingHorizontal: S[2], borderRadius: R.sm }}>
          <Spread style={{ flex: 1 }}><T v="sm" c="text2">{r[0]}</T><T v="sm" w="600">{r[1]}</T></Spread>
          <Spread style={{ flex: 1 }}><T v="sm" c="text2">{r[2]}</T><T v="sm" w="600">{r[3]}</T></Spread>
        </View>
      ))}
    </View>
  );
}

/* ============================================================== trade book */
interface Trade {
  id: string; side: Side; type: string; quantity: number; status: string; limitPrice?: string; triggerPrice?: string; fillPrice?: string;
  rejectReason?: string; createdAt: string; filledAt?: string; realizedPnl?: string; brokerage?: string; heldSeconds?: number; username?: string;
  instrumentId: string; instrument?: { id: string; symbol: string; name: string; expiry?: string };
}
const TRADE_FIELDS = 'id side type quantity status limitPrice triggerPrice fillPrice rejectReason createdAt filledAt realizedPnl brokerage heldSeconds username instrumentId instrument{ id symbol name expiry }';
const TYPE_LABEL: Record<string, string> = { MARKET: 'Market', LIMIT: 'Limit', STOP_LOSS: 'Stop-loss', TAKE_PROFIT: 'Take-profit' };
type BookTab = 'success' | 'pending' | 'rejected';
const BOOK: Record<BookTab, { label: string; s: string[] }> = { success: { label: 'Success', s: ['FILLED'] }, pending: { label: 'Pending', s: ['OPEN'] }, rejected: { label: 'Rejected', s: ['REJECTED', 'CANCELLED'] } };

/** "2 hours 12 minutes", "45 seconds". */
export function heldText(sec?: number) {
  if (sec === undefined || sec === null) return '';
  if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'}`;
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return [d ? `${d} day${d > 1 ? 's' : ''}` : '', h ? `${h} hour${h > 1 ? 's' : ''}` : '', !d && m ? `${m} minute${m > 1 ? 's' : ''}` : ''].filter(Boolean).join(' ') || '1 minute';
}
const stamp = (d: string) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

const TradeRow = memo(function TradeRow({ o, onPress }: { o: Trade; onPress: (o: Trade) => void }) {
  const t = useTheme();
  const px = o.fillPrice ?? o.limitPrice ?? o.triggerPrice;
  return (
    <Pressable onPress={() => onPress(o)} accessibilityRole="button" accessibilityLabel={`${o.side} ${o.quantity} ${o.instrument?.symbol ?? ''}`} style={({ pressed }) => ({ paddingVertical: S[3], gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line, backgroundColor: pressed ? t.bg2 : 'transparent' })}>
      <Spread><T w="700" numberOfLines={1} style={{ flex: 1 }}>{o.instrument ? titleOf(o.instrument) : '—'}</T><T v="num" c={o.side === 'BUY' ? 'pos' : 'neg'}>{inr(px)}</T></Spread>
      <Spread>
        <Row gap={6}><Badge text={o.side} tone={o.side === 'BUY' ? 'ok' : 'bad'} /><T v="sm" c="text2">{o.quantity} lot{o.quantity > 1 ? 's' : ''}</T>{o.type !== 'MARKET' ? <T v="xs">{TYPE_LABEL[o.type]}</T> : null}</Row>
        <T v="xs">{stamp(o.filledAt ?? o.createdAt)}</T>
      </Spread>
      {o.username ? <T v="xs">{o.username}</T> : null}
      {o.realizedPnl ? (
        <Spread>
          <Row gap={4}><T v="sm" c="text2">Deals:</T><T v="num" c={toneOfValue(o.realizedPnl) === 'neg' ? 'neg' : 'pos'}>{inr(o.realizedPnl, true)}</T></Row>
          {o.heldSeconds !== undefined ? <T v="xs" style={{ textDecorationLine: 'underline' }}>{heldText(o.heldSeconds)}</T> : null}
        </Spread>
      ) : null}
      {o.status === 'REJECTED' && o.rejectReason ? <T v="xs" c="neg">{o.rejectReason}</T> : null}
    </Pressable>
  );
});

export function TradeBook({ header }: { header?: React.ReactNode }) {
  const [tab, setTab] = useState<BookTab>('success');
  const [q, setQ] = useState('');
  const [side, setSide] = useState<'' | Side>('');
  const { data, error, loading, refetch } = useQuery<{ orders: Trade[] }>(`query($s:[OrderStatus!]){ orders(status:$s, limit:200){ ${TRADE_FIELDS} } }`, { s: BOOK[tab].s }, tab === 'pending' ? 3000 : 8000);
  const [open, setOpen] = useState<Trade | null>(null);
  const [repeat, setRepeat] = useState<Trade | null>(null);
  const list = useMemo(() => (data?.orders ?? []).filter((o) => (!side || o.side === side) && (!q.trim() || `${o.instrument?.symbol ?? ''} ${o.instrument?.name ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))), [data, q, side]);
  const top = (
    <View style={{ gap: S[3] }}>
      {header}
      <Tabs value={tab} onChange={setTab} items={(Object.keys(BOOK) as BookTab[]).map((k) => ({ k, label: BOOK[k].label }))} />
      <SearchBox value={q} onChangeText={setQ} placeholder="Search" />
      <Chips value={side} onChange={setSide} items={[{ k: '', label: 'All' }, { k: 'BUY', label: 'Buy' }, { k: 'SELL', label: 'Sell' }]} />
    </View>
  );
  const empty = loading && !data ? <Skeleton /> : error && !data ? <ErrorState error={error} retry={refetch} />
    : <Empty icon="list" title={tab === 'success' ? 'No trades yet' : tab === 'pending' ? 'No pending orders' : 'Nothing rejected'}>{tab === 'pending' ? 'Limit and stop-loss orders wait here until the price reaches them.' : 'Your executed trades show up here.'}</Empty>;
  return (
    <>
      <VList data={list} keyOf={(o) => o.id} header={top} empty={empty} render={(o) => <TradeRow o={o} onPress={setOpen} />} />
      {open && <TradeDetail o={open} onClose={() => setOpen(null)} onRepeat={() => { setRepeat(open); setOpen(null); }} onCancelled={() => { setOpen(null); void refetch(); }} />}
      {repeat && <QuickTradeSheet instrumentId={repeat.instrumentId} initialSide={repeat.side} initialQty={repeat.quantity} onClose={() => { setRepeat(null); void refetch(); }} />}
    </>
  );
}

function TradeDetail({ o, onClose, onRepeat, onCancelled }: { o: Trade; onClose: () => void; onRepeat: () => void; onCancelled: () => void }) {
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setBusy(true);
    try { await gql(`mutation($id:ID!){ cancelOrder(orderId:$id){ id } }`, { id: o.id }); toast('Order cancelled'); onCancelled(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const rows: [string, string][] = [
    ['UserName', o.username ?? '—'],
    ['Order time', stamp(o.createdAt)],
    ...(o.filledAt ? [['Executed', stamp(o.filledAt)] as [string, string]] : []),
    ['Symbol', o.instrument ? shortSymbol(o.instrument.symbol) : '—'],
    ['Order type', TYPE_LABEL[o.type] ?? o.type],
    ['Side', o.side === 'BUY' ? 'Buy' : 'Sell'],
    ['Deals (P&L)', o.realizedPnl ? `₹${inr(o.realizedPnl, true)}` : '—'],
    ['Quantity', `${o.quantity} lot${o.quantity > 1 ? 's' : ''}`],
    ['Price', o.fillPrice ? `₹${inr(o.fillPrice)}` : '—'],
    ['Brokerage', o.brokerage ? `₹${inr(o.brokerage)}` : '—'],
    ['Ref price', `₹${inr(o.limitPrice ?? o.triggerPrice ?? o.fillPrice)}`],
    ...(o.heldSeconds !== undefined ? [['Held for', heldText(o.heldSeconds)] as [string, string]] : []),
    ['Status', o.status === 'FILLED' ? 'Executed' : o.status.charAt(0) + o.status.slice(1).toLowerCase()],
  ];
  const t = useTheme();
  return (
    <Sheet visible title={o.instrument ? titleOf(o.instrument) : 'Order'} sub={`${o.side} ${o.quantity} · ${stamp(o.filledAt ?? o.createdAt)}`} onClose={onClose}>
      <Button block size="lg" kind="buy" title="Repeat order" onPress={onRepeat} />
      {o.status === 'OPEN' ? <Button block kind="sell" title="Cancel order" busy={busy} onPress={() => void cancel()} /> : null}
      <View>
        {rows.map(([k, v], idx) => (
          <Spread key={k} style={{ paddingVertical: S[2], paddingHorizontal: S[2], backgroundColor: idx % 2 ? 'transparent' : t.bg2, borderRadius: R.sm }}>
            <T v="sm" c="text2">{k}</T><T v="sm" w="600">{v}</T>
          </Spread>
        ))}
      </View>
      {o.rejectReason ? <Notice tone="err">{o.rejectReason}</Notice> : null}
    </Sheet>
  );
}

export type { Quote };
