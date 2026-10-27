import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, View, useWindowDimensions } from 'react-native';
import { tradeFeedback, usePrefs, usePrivate } from '@/prefs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, Line, LinearGradient, Path, Stop } from 'react-native-svg';
import { gql, newKey } from '@/api';
import { useLiveQuotes, useSummary } from '@/screens';
import { inr, R, S, shortSymbol, useTheme } from '@/theme';
import { Badge, Button, Change, Chips, Divider, Field, Lines, Mark, Notice, Row, Screen, Section, Sheet, Spread, T, toast, useQuery } from '@/ui';

type Side = 'BUY' | 'SELL';
interface Preview { price: string; value: string; intradayMargin: string; carryForwardMargin: string; brokerage: string }
interface I { id: string; symbol: string; name: string; exchange: string; segment: string; expiry?: string; lotSize: number; tickSize: string }

/** Groww-style stock screen: price, live chart, performance, details, sticky Buy/Sell bar. */
export default function StockScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { id, side: s0, qty: q0 } = useLocalSearchParams<{ id: string; side?: string; qty?: string }>();
  const inst = useQuery<{ instrument: I }>(`query($id:ID!){ instrument(id:$id){ id symbol name exchange segment expiry lotSize tickSize } }`, { id });
  const q = useLiveQuotes([id])[id];
  const { prefs } = usePrefs();
  const [pts, setPts] = useState<number[]>([]);
  const [order, setOrder] = useState<Side | null>(s0 === 'BUY' || s0 === 'SELL' ? s0 : null);
  useEffect(() => { if (q?.ltp) setPts((h) => [...h.slice(-199), Number(q.ltp)]); }, [q?.ltp, q?.ts]);
  const i = inst.data?.instrument;
  const lo = Number(q?.low ?? 0), hi = Number(q?.high ?? 0), ltp = Number(q?.ltp ?? 0);
  const pos = hi > lo ? Math.min(100, Math.max(0, ((ltp - lo) / (hi - lo)) * 100)) : 50;

  const footer = (
    <View style={{ flexDirection: 'row', gap: S[3], paddingHorizontal: S[4], paddingTop: S[3], paddingBottom: S[3] + insets.bottom, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.bg }}>
      <Button block size="lg" kind="sell" title="Sell" disabled={!q} onPress={() => setOrder('SELL')} />
      <Button block size="lg" kind="buy" title="Buy" disabled={!q} onPress={() => setOrder('BUY')} />
    </View>
  );

  return (
    <Screen back title={i ? shortSymbol(i.symbol) : ''} footer={footer}>
      {inst.error ? <Notice tone="err">{inst.error}</Notice> : null}
      <Row>
        <Mark text={i ? shortSymbol(i.symbol) : ''} />
        <View style={{ flex: 1 }}><T v="h3" numberOfLines={1}>{i?.name.replace(/ — .*/, '') ?? '…'}</T><T v="xs">{i?.symbol} · {i?.exchange} {i?.segment}</T></View>
      </Row>
      <View style={{ gap: 2 }}>
        <T v="hero">₹{inr(q?.ltp)}</T>
        <Row gap={6}><Change value={q?.change} pct={q?.changePct} size="md" /><T v="xs">vs previous close</T></Row>
      </View>
      {prefs.charts ? <Chart pts={pts} /> : <T v="xs">Charts are turned off in Profile → Preferences.</T>}
      {i && <Button size="sm" icon="external" title="Open in TradingView" onPress={() => void Linking.openURL(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${i.exchange}:${shortSymbol(i.symbol)}1!`)}`)} />}
      {i && <T v="xs">TradingView shows real market data, which differs from this simulated feed.</T>}
      <Section title="Performance">
        <Spread><T v="sm" c="text2">Today’s low</T><T v="sm" c="text2">Today’s high</T></Spread>
        <View style={{ height: 4, backgroundColor: t.bg3, borderRadius: 2, marginVertical: S[2] }} accessibilityLabel={`Day range ${q?.low} to ${q?.high}`}>
          <View style={{ width: `${pos}%`, height: 4, backgroundColor: t.brand, opacity: 0.35, borderRadius: 2 }} />
          <View style={{ position: 'absolute', left: `${pos}%`, top: -3, width: 10, height: 10, borderRadius: 5, marginLeft: -5, backgroundColor: t.text }} />
        </View>
        <Spread><T v="num">₹{inr(q?.low)}</T><T v="num">₹{inr(q?.high)}</T></Spread>
      </Section>
      <Section title="Market depth">
        <Lines lines={[['Best bid', `₹${inr(q?.bid)}`], ['Best ask', `₹${inr(q?.ask)}`], ['Spread', q ? `₹${(Number(q.ask) - Number(q.bid)).toFixed(2)}` : '—']]} />
      </Section>
      <Section title="Contract details">
        <Lines lines={[
          ['Expiry', i?.expiry ? new Date(i.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'],
          ['Lot size', i?.lotSize ?? '—'], ['Tick size', i ? `₹${i.tickSize}` : '—'], ['Price source', q?.source === 'SIMULATED' ? 'Simulated feed' : q?.source ?? '—'],
        ]} />
      </Section>
      {i && order && <OrderSheet i={i} q={q} side={order} setSide={setOrder} initialQty={q0 ?? '1'} onClose={() => setOrder(null)} />}
    </Screen>
  );
}

function Chart({ pts }: { pts: number[] }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const W = width - S[4] * 2, H = 180;
  const d = useMemo(() => {
    if (pts.length < 2) return null;
    const mn = Math.min(...pts), mx = Math.max(...pts), span = mx - mn || mx * 0.001 || 1;
    const xy = pts.map((v, k) => [(k / (pts.length - 1)) * W, 6 + (1 - (v - mn) / span) * (H - 12)]);
    const line = xy.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    return { line, area: `${line} L${W},${H} L0,${H} Z`, mn, mx, up: pts[pts.length - 1] >= pts[0] };
  }, [pts, W]);
  const color = d?.up === false ? t.neg : t.pos;
  return (
    <View style={{ gap: S[3] }}>
      {!d ? (
        <View style={{ height: H, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg2, borderRadius: R.lg }}><T v="sm" c="text2">Waiting for live prices…</T></View>
      ) : (
        <Svg width={W} height={H} accessibilityLabel={`Price moved from ${pts[0]} to ${pts[pts.length - 1]} since you opened this screen`}>
          <Defs><LinearGradient id="g" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={color} stopOpacity={0.15} /><Stop offset="1" stopColor={color} stopOpacity={0} /></LinearGradient></Defs>
          {[0.25, 0.5, 0.75].map((f) => <Line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke={t.line} strokeDasharray="3 4" />)}
          <Path d={d.area} fill="url(#g)" />
          <Path d={d.line} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" />
        </Svg>
      )}
      {d && <Spread><T v="xs">Range ₹{d.mn.toFixed(2)} – ₹{d.mx.toFixed(2)}</T><T v="xs">Live since opened</T></Spread>}
      <Chips value="live" onChange={() => undefined} items={[{ k: 'live', label: 'Live' }, { k: '1w', label: '1W', disabled: true }, { k: '1m', label: '1M', disabled: true }, { k: '1y', label: '1Y', disabled: true }]} />
      <T v="xs">Longer ranges need a market-data provider. The simulated feed has no history.</T>
    </View>
  );
}

type OType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT';
interface Rules { minQty: number; maxQtyPerOrder: number; maxQtyPerInstrument: number; sessions: { exchange: string; open: string; close: string; isOpen: boolean; message?: string }[] }
const TYPE_LABEL: Record<OType, string> = { MARKET: 'Market', LIMIT: 'Limit', STOP_LOSS: 'Stop-loss', TAKE_PROFIT: 'Take-profit' };
const isTrig = (t: OType) => t === 'STOP_LOSS' || t === 'TAKE_PROFIT';
const firesOnFall = (t: OType, s: Side) => (t === 'STOP_LOSS' && s === 'SELL') || (t === 'TAKE_PROFIT' && s === 'BUY');
const roundToTick = (v: number, tick: number) => { const t = Math.round(tick * 100); return (Math.max(t, Math.round((v * 100) / t) * t) / 100).toFixed(2); };

function QtyChip({ text, onPress, tone }: { text: string; onPress?: () => void; tone?: 'info' }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : 'text'} style={{ backgroundColor: tone === 'info' ? t.infoSoft : t.bg3, borderRadius: R.sm, paddingHorizontal: 8, height: 26, justifyContent: 'center' }}>
      <T v="xs" c={tone === 'info' ? 'text' : 'text2'} w="500">{text}</T>
    </Pressable>
  );
}

function OrderSheet({ i, q, side, setSide, initialQty, onClose }: { i: I; q?: { bid: string; ask: string; ltp: string }; side: Side; setSide: (s: Side) => void; initialQty: string; onClose: () => void }) {
  const t = useTheme();
  const priv = usePrivate();
  const sum = useSummary();
  const rules = useQuery<{ tradingRules: Rules }>(`{ tradingRules { minQty maxQtyPerOrder maxQtyPerInstrument sessions { exchange open close isOpen message } } }`);
  const pos = useQuery<{ positions: { instrumentId: string; netQty: number }[] }>(`{ positions { instrumentId netQty } }`);
  const [type, setType] = useState<OType>('MARKET');
  const [qty, setQty] = useState(initialQty);
  const [price, setPrice] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  const r = rules.data?.tradingRules;
  const session = r?.sessions.find((x) => x.exchange === i.exchange);
  const held = pos.data?.positions.find((p) => p.instrumentId === i.id)?.netQty ?? 0;
  const ltp = Number(q?.ltp ?? 0);
  const n = Number(qty);
  const qtyErr = !qty ? 'Enter a quantity' : !Number.isInteger(n) || n <= 0 ? 'Whole number above 0' : r && n < r.minQty ? `Minimum ${r.minQty}` : r && n > r.maxQtyPerOrder ? `Max ${r.maxQtyPerOrder} per order` : null;
  const priceErr = type === 'MARKET' ? null : !/^\d{1,10}(\.\d{1,2})?$/.test(price) ? (price ? 'Enter a valid price' : null)
    : Math.round(Number(price) * 100) % Math.round(Number(i.tickSize) * 100) !== 0 ? `Multiple of ₹${i.tickSize}`
    : isTrig(type) && ltp && (firesOnFall(type, side) ? Number(price) >= ltp : Number(price) <= ltp) ? `Must be ${firesOnFall(type, side) ? 'below' : 'above'} LTP` : null;
  const valid = !qtyErr && !priceErr && (type === 'MARKET' || !!price) && !!q;
  useEffect(() => {
    if (!valid) { setPreview(null); return; }
    const h = setTimeout(() => gql<{ orderPreview: Preview }>(`query($i:ID!,$s:OrderSide!,$q:Int!,$l:String,$t:String){ orderPreview(instrumentId:$i, side:$s, quantity:$q, limitPrice:$l, triggerPrice:$t){ price value intradayMargin carryForwardMargin brokerage } }`, { i: i.id, s: side, q: n, l: type === 'LIMIT' ? price : undefined, t: isTrig(type) ? price : undefined }).then((d) => setPreview(d.orderPreview)).catch(() => setPreview(null)), 250);
    return () => clearTimeout(h);
  }, [i.id, side, n, type, price, valid]);
  const avail = sum.data?.accountSummary.available;
  const short = preview && avail && Number(preview.intradayMargin) + Number(preview.brokerage) > Number(avail);
  const place = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await gql(`mutation($i:PlaceOrderInput!){ placeOrder(input:$i){ status fillPrice rejectReason } }`, { i: { instrumentId: i.id, side, type, quantity: n, limitPrice: type === 'LIMIT' ? price : undefined, triggerPrice: isTrig(type) ? price : undefined, idempotencyKey: key } });
      const o = d.placeOrder;
      setKey(newKey());
      if (o.status === 'REJECTED') { tradeFeedback('reject'); setErr(`Rejected: ${o.rejectReason}`); setReview(false); return; }
      tradeFeedback(o.status === 'FILLED' ? 'fill' : 'placed');
      toast(o.status === 'FILLED' ? `${side === 'BUY' ? 'Bought' : 'Sold'} ${n} at ₹${inr(o.fillPrice)}` : isTrig(type) ? `${TYPE_LABEL[type]} set at ₹${inr(price)}` : 'Limit order placed');
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const ref = type === 'LIMIT' ? Number(side === 'BUY' ? q?.ask : q?.bid) : ltp;
  const down = type === 'LIMIT' ? side === 'BUY' : firesOnFall(type, side);
  const steps = type === 'LIMIT' ? [10, 25, 50] : [1, 2, 5];
  return (
    <Sheet visible title={review ? `Confirm ${side === 'BUY' ? 'buy' : 'sell'}` : shortSymbol(i.symbol)} sub={review ? 'Review your order' : `${side === 'BUY' ? 'Ask' : 'Bid'} ₹${inr(side === 'BUY' ? q?.ask : q?.bid)} · LTP ₹${inr(q?.ltp)}`} onClose={onClose}>
      {!review ? (
        <>
          <View style={{ flexDirection: 'row', backgroundColor: t.bg2, borderRadius: R.md, padding: 4 }} accessibilityRole="tablist">
            {(['BUY', 'SELL'] as const).map((s) => (
              <Button key={s} block size="sm" kind={side === s ? (s === 'BUY' ? 'buy' : 'sell') : 'ghost'} title={s === 'BUY' ? 'Buy' : 'Sell'} onPress={() => setSide(s)} />
            ))}
          </View>
          {session && (
            <Row gap={6}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: session.isOpen ? t.pos : t.neg }} /><T v="xs" c="text2">{session.isOpen ? `${i.exchange} open · ${session.open}–${session.close} IST` : session.message}</T></Row>
          )}
          <Chips value={type} onChange={(k) => { setType(k); setPrice(''); }} items={[{ k: 'MARKET', label: 'Market' }, { k: 'LIMIT', label: 'Limit' }, { k: 'STOP_LOSS', label: 'SL' }, { k: 'TAKE_PROFIT', label: 'TP' }]} />
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}><Field label="Quantity" keyboardType="number-pad" value={qty} onChangeText={(v) => setQty(v.replace(/\D/g, ''))} error={qtyErr} /></View>
            <View style={{ flex: 1 }}>
              {type === 'MARKET' ? <Field label="Price" editable={false} value="At market" /> : <Field label={type === 'LIMIT' ? 'Limit price' : 'Trigger (LTP)'} prefix="₹" keyboardType="decimal-pad" value={price} onChangeText={(v) => setPrice(v.replace(/[^\d.]/g, ''))} placeholder={q?.ltp} error={priceErr} />}
            </View>
          </Row>
          {r && (
            <Row gap={6} style={{ flexWrap: 'wrap' }}>
              <QtyChip text={`Punch qty: ${r.maxQtyPerOrder}`} onPress={() => setQty(String(r.maxQtyPerOrder))} />
              <QtyChip text={`Total qty: ${r.maxQtyPerInstrument}`} />
              <QtyChip text={`Min qty: ${r.minQty}`} />
              {held !== 0 && <QtyChip tone="info" text={`Holding: ${held}`} onPress={() => { setQty(String(Math.abs(held))); setSide(held > 0 ? 'SELL' : 'BUY'); }} />}
            </Row>
          )}
          {type !== 'MARKET' && ref > 0 && (
            <Row gap={S[2]} style={{ flexWrap: 'wrap' }}>
              <T v="xs" c="text2">{type === 'LIMIT' ? (side === 'BUY' ? 'BELOW ASK' : 'ABOVE BID') : down ? 'BELOW LTP' : 'ABOVE LTP'}</T>
              {steps.map((p) => {
                const v = roundToTick(ref * (1 + ((down ? -1 : 1) * p) / 100), Number(i.tickSize));
                return <Button key={p} size="sm" kind={price === v ? 'primary' : 'secondary'} title={`${down ? '−' : '+'}${p}%`} onPress={() => setPrice(v)} />;
              })}
            </Row>
          )}
          {isTrig(type) && <T v="xs">{TYPE_LABEL[type]}: when the LTP {firesOnFall(type, side) ? 'falls to' : 'rises to'} your trigger, the order is filled at the LTP.</T>}
          <Divider />
          <Lines lines={[['Order value', preview ? `₹${inr(preview.value)}` : '—'], ['Intraday margin', preview ? `₹${inr(preview.intradayMargin)}` : '—'], ['C/F margin', preview ? `₹${inr(preview.carryForwardMargin)}` : '—'], ['Available', avail ? priv(`₹${inr(avail)}`) : '—']]} />
          {short && <Notice tone="warn">Not enough available balance for this order.</Notice>}
          {session && !session.isOpen && <Notice tone="warn">{session.message} Orders placed now will be rejected.</Notice>}
          {err && <Notice tone="err">{err}</Notice>}
          <Button size="lg" kind={side === 'BUY' ? 'buy' : 'sell'} title={valid && preview ? `${side === 'BUY' ? 'Buy' : 'Sell'} ${n} @ ${type === 'MARKET' ? inr(side === 'BUY' ? q?.ask : q?.bid) : inr(price)}` : `Review ${side === 'BUY' ? 'buy' : 'sell'}`} disabled={!valid || !preview} onPress={() => { setErr(null); setReview(true); }} />
          <T v="xs" style={{ textAlign: 'center' }}>Simulated order. Never sent to an exchange.</T>
        </>
      ) : preview && (
        <>
          <Row gap={S[2]}><Badge text={side === 'BUY' ? 'Buy' : 'Sell'} tone={side === 'BUY' ? 'ok' : 'bad'} /><T w="600">{shortSymbol(i.symbol)}</T></Row>
          <Lines lines={[['Order type', TYPE_LABEL[type]], ['Quantity', n], [type === 'MARKET' ? 'Estimated price' : type === 'LIMIT' ? 'Limit price' : 'Trigger (LTP)', `₹${inr(preview.price)}`], ['Order value', `₹${inr(preview.value)}`], ['Margin required', `₹${inr(preview.intradayMargin)}`], ['Carry-forward margin', `₹${inr(preview.carryForwardMargin)}`], ['Brokerage', `₹${inr(preview.brokerage)}`]]} />
          {type === 'MARKET' && <Notice>Market orders execute at the best simulated price, which can differ slightly from the estimate.</Notice>}
          {isTrig(type) && <Notice>When triggered, this order is filled at the last traded price, which can be worse than your trigger in a fast market.</Notice>}
          {err && <Notice tone="err">{err}</Notice>}
          <Row>
            <Button block size="lg" title="Edit" onPress={() => setReview(false)} />
            <Button block size="lg" kind={side === 'BUY' ? 'buy' : 'sell'} title={`Confirm ${side === 'BUY' ? 'buy' : 'sell'}`} busy={busy} onPress={place} />
          </Row>
        </>
      )}
    </Sheet>
  );
}
