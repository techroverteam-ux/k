import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { CandleChart } from '@/candle-chart';
import { Alert, Pressable, View } from 'react-native';
import { tradeFeedback, usePrefs, usePrivate } from '@/prefs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { gql, newKey } from '@/api';
import { useLiveQuotes, useSummary } from '@/screens';
import { inr, ohlcTone, R, S, shortSymbol, useTheme } from '@/theme';
import { Badge, Button, Change, Chips, Divider, Field, Lines, LotStepper, Mark, Notice, Row, Screen, Section, Sheet, Spread, T, toast, useQuery } from '@/ui';

type Side = 'BUY' | 'SELL';
interface Preview { price: string; value: string; intradayMargin: string; carryForwardMargin: string; brokerage: string }
interface I { id: string; symbol: string; name: string; exchange: string; segment: string; expiry?: string; lotSize: number; tickSize: string; lotClass?: string; lotLabel?: string; category?: string }

/** Groww-style stock screen: price, live chart, performance, details, sticky Buy/Sell bar. */
export default function StockScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { id, side: s0, qty: q0, view } = useLocalSearchParams<{ id: string; side?: string; qty?: string; view?: string }>();
  const inst = useQuery<{ instrument: I }>(`query($id:ID!){ instrument(id:$id){ id symbol name exchange segment expiry lotSize tickSize lotClass lotLabel category } }`, { id });
  const q = useLiveQuotes([id])[id];
  const { prefs } = usePrefs();
  const [tab, setTab] = useState<'Chart' | 'Market Depth' | 'Market Details'>(view === 'chart' ? 'Chart' : view === 'details' ? 'Market Details' : 'Market Depth'); // the chart loads only when the Chart tab is tapped
  const [order, setOrder] = useState<Side | null>(s0 === 'BUY' || s0 === 'SELL' ? s0 : null);
  const i = inst.data?.instrument;
  const lo = Number(q?.low ?? 0), hi = Number(q?.high ?? 0), ltp = Number(q?.ltp ?? 0);
  const pos = hi > lo ? Math.min(100, Math.max(0, ((ltp - lo) / (hi - lo)) * 100)) : 50;

  // Only real data: when the feed has no order book / volume / circuits for this instrument, show "—".
  const qx = q as (typeof q & { depth?: { levels: { bidQty: number; bidPrice: string; askPrice: string; askQty: number }[]; totalBidQty?: number; totalAskQty?: number }; open?: string; close?: string; volume?: string; avgPrice?: string; lowerCircuit?: string; upperCircuit?: string }) | undefined;
  const extra = useQuery<{ quotes: { open?: string; close?: string; volume?: string; avgPrice?: string; lowerCircuit?: string; upperCircuit?: string; depth?: { levels: { bidQty: number; bidPrice: string; askPrice: string; askQty: number }[]; totalBidQty?: number; totalAskQty?: number } }[] }>(
    `query($i:[ID!]!){ quotes(instrumentIds:$i){ open close volume avgPrice lowerCircuit upperCircuit depth { levels { bidQty bidPrice askPrice askQty } totalBidQty totalAskQty } } }`, { i: [id] }, 3000);
  const xq = { ...(qx ?? {}), ...(extra.data?.quotes[0] ?? {}) };
  const depthLevels = xq.depth?.levels ?? [];
  const totalBidQty = xq.depth?.totalBidQty ?? depthLevels.reduce((acc, l) => acc + l.bidQty, 0);
  const totalAskQty = xq.depth?.totalAskQty ?? depthLevels.reduce((acc, l) => acc + l.askQty, 0);
  const openVal = xq.open;
  const closeVal = xq.close;
  const highVal = q?.high;
  const lowVal = q?.low;
  const rules = useQuery<{ tradingRules: { minQty: number; maxQtyPerOrder: number; maxQtyPerInstrument: number; sessions: { exchange: string; open: string; close: string; isOpen: boolean; message?: string }[] } }>(`{ tradingRules { minQty maxQtyPerOrder maxQtyPerInstrument sessions { exchange open close isOpen message } } }`);
  const rl = rules.data?.tradingRules;
  const margin = useQuery<{ orderPreview: { intradayMargin: string } }>(`query($i:ID!){ orderPreview(instrumentId:$i, side:BUY, quantity:1){ intradayMargin } }`, { i: id }, 15000);
  const allowTrade = i && rl ? (rl.sessions.find((x) => x.exchange === i.exchange)?.isOpen ?? true) : undefined;
  const dash = (v?: string | number | null) => (v === undefined || v === null || v === '' ? '—' : String(v));

  const onTradePress = (s: Side) => {
    if (allowTrade === false) {
      const sess = rl?.sessions.find((x: any) => x.exchange === i?.exchange);
      Alert.alert('Market Closed', sess ? `${i?.exchange} market is currently closed. Trading hours are ${sess.open}–${sess.close} IST.` : 'Market is currently closed for trading.');
      return;
    }
    setOrder(s);
  };

  const footer = (
    <View style={{ flexDirection: 'row', gap: S[3], paddingHorizontal: S[4], paddingTop: S[3], paddingBottom: S[3] + insets.bottom, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.bg }}>
      <Button block size="lg" kind="sell" title="Sell" disabled={!q} onPress={() => onTradePress('SELL')} />
      <Button block size="lg" kind="buy" title="Buy" disabled={!q} onPress={() => onTradePress('BUY')} />
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
      <Chips
        items={[{ k: 'Chart', label: 'Chart' }, { k: 'Market Depth', label: 'Market Depth' }, { k: 'Market Details', label: 'Market Details' }]}
        value={tab}
        onChange={(v) => setTab(v as any)}
      />

      {tab === 'Chart' && (
        <View style={{ gap: S[4] }}>
          {prefs.charts ? (i ? <CandleChart instrumentId={i.id} quote={q} tickSize={Number(i.tickSize)} /> : null) : <T v="xs">Charts are turned off in Profile → Preferences.</T>}
          {/* 4-Box OHLC Strip */}
          <View style={{ flexDirection: 'row', gap: S[2], marginVertical: S[2] }}>
            {[['Open', openVal], ['High', highVal], ['Low', lowVal], ['Close', closeVal]].map(([label, val]) => (
              <View key={label} style={{ flex: 1, backgroundColor: t.bg2, borderRadius: R.md, padding: S[2], alignItems: 'center' }}>
                <T v="xs" c="text2" style={{ textTransform: 'uppercase' }}>{label}</T>
                <T v="sm" w="600" c={ohlcTone(String(label), val, q?.ltp, closeVal)}>{inr(val)}</T>
              </View>
            ))}
          </View>

          <Section title="Performance">
            <Spread><T v="sm" c="text2">Today’s low</T><T v="sm" c="text2">Today’s high</T></Spread>
            <View style={{ height: 4, backgroundColor: t.bg3, borderRadius: 2, marginVertical: S[2] }} accessibilityLabel={`Day range ${q?.low} to ${q?.high}`}>
              <View style={{ width: `${pos}%`, height: 4, backgroundColor: t.brand, opacity: 0.35, borderRadius: 2 }} />
              <View style={{ position: 'absolute', left: `${pos}%`, top: -3, width: 10, height: 10, borderRadius: 5, marginLeft: -5, backgroundColor: t.text }} />
            </View>
            <Spread><T v="num">₹{inr(q?.low)}</T><T v="num">₹{inr(q?.high)}</T></Spread>
          </Section>

          <Section title="Key Statistics">
            <Lines lines={[
              ['Best bid', `₹${inr(q?.bid)}`],
              ['Best ask', `₹${inr(q?.ask)}`],
              ['Spread', q ? `₹${(Number(q.ask) - Number(q.bid)).toFixed(2)}` : '—'],
              ['Volume', dash(xq.volume)],
              ['Avg. Price', xq.avgPrice ? `₹${inr(xq.avgPrice)}` : '—'],
            ]} />
          </Section>
        </View>
      )}

      {tab === 'Market Depth' && (
        <View style={{ gap: S[4] }}>
          {/* 5-Level Market Depth Table (Screenshot 2) */}
          <View style={{ borderWidth: 1, borderColor: t.line, borderRadius: R.md, overflow: 'hidden', backgroundColor: t.bg }}>
            <View style={{ flexDirection: 'row', paddingVertical: S[2], paddingHorizontal: S[3], backgroundColor: t.bg2, borderBottomWidth: 1, borderBottomColor: t.line }}>
              <T v="xs" c="text2" w="600" style={{ flex: 1 }}>Qty</T>
              <T v="xs" c="text2" w="600" style={{ flex: 2, textAlign: 'right' }}>Bid</T>
              <T v="xs" c="text2" w="600" style={{ flex: 2, textAlign: 'left', paddingLeft: S[3] }}>Offer</T>
              <T v="xs" c="text2" w="600" style={{ flex: 1, textAlign: 'right' }}>Qty</T>
            </View>
            {!depthLevels.length ? <View style={{ padding: S[3] }}><T v="sm" c="text2">Market depth isn’t available for this instrument right now.</T></View> : null}
            {depthLevels.map((lvl, idx) => (
              <View key={idx} style={{ flexDirection: 'row', paddingVertical: S[2], paddingHorizontal: S[3], borderBottomWidth: 1, borderBottomColor: t.line2 }}>
                <T v="xs" style={{ flex: 1 }}>{lvl.bidQty}</T>
                <T v="xs" c="pos" w="600" style={{ flex: 2, textAlign: 'right' }}>{inr(lvl.bidPrice)}</T>
                <T v="xs" c="neg" w="600" style={{ flex: 2, textAlign: 'left', paddingLeft: S[3] }}>{inr(lvl.askPrice)}</T>
                <T v="xs" style={{ flex: 1, textAlign: 'right' }}>{lvl.askQty}</T>
              </View>
            ))}
            <View style={{ flexDirection: 'row', paddingVertical: S[2], paddingHorizontal: S[3], backgroundColor: t.bg2 }}>
              <T v="xs" w="600" style={{ flex: 1 }}>Total</T>
              <T v="xs" c="pos" w="700" style={{ flex: 2, textAlign: 'right' }}>{totalBidQty}</T>
              <T v="xs" c="neg" w="700" style={{ flex: 2, textAlign: 'left', paddingLeft: S[3] }}>{totalAskQty}</T>
              <T v="xs" w="600" style={{ flex: 1, textAlign: 'right' }}>Total</T>
            </View>
          </View>

          {/* 4-Box OHLC Strip */}
          <View style={{ flexDirection: 'row', gap: S[2], marginVertical: S[1] }}>
            {[['Open', openVal], ['High', highVal], ['Low', lowVal], ['Close', closeVal]].map(([label, val]) => (
              <View key={label} style={{ flex: 1, backgroundColor: t.bg2, borderRadius: R.md, padding: S[2], alignItems: 'center' }}>
                <T v="xs" c="text2" style={{ textTransform: 'uppercase' }}>{label}</T>
                <T v="sm" w="600" c={ohlcTone(String(label), val, q?.ltp, closeVal)}>{inr(val)}</T>
              </View>
            ))}
          </View>

          {/* Extended Market Stats (Screenshot 2) */}
          <Section title="Market Statistics">
            <Lines lines={[
              ['LTP', `₹${inr(q?.ltp)}`],
              ['Volume', dash(xq.volume)],
              ['Avg. Price', xq.avgPrice ? `₹${inr(xq.avgPrice)}` : '—'],
              ['Time', q?.ts ? new Date(q.ts).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' }) : '—'],
              ['Lower Circuit', xq.lowerCircuit ? `₹${inr(xq.lowerCircuit)}` : '—'],
              ['Upper Circuit', xq.upperCircuit ? `₹${inr(xq.upperCircuit)}` : '—'],
            ]} />
          </Section>

          <Button block size="lg" kind="buy" title="Trade" onPress={() => onTradePress('BUY')} />
        </View>
      )}

      {tab === 'Market Details' && (
        <Section title="Market Details">
          <Lines lines={[
            ['Script', i?.name.replace(/ — .*/, '') ?? '—'],
            ['Expiry', i?.expiry ? new Date(i.expiry).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '—'],
            ['Lot size', i ? (i.lotLabel ?? String(i.lotSize)) : '—'],
            ['Trade margin (1 lot)', margin.data ? `₹${inr(margin.data.orderPreview.intradayMargin)}` : '—'],
            ['Allow trade', allowTrade === undefined ? '—' : allowTrade ? 'Yes' : 'No (market closed)'],
            ['Max lots (open)', dash(rl?.maxQtyPerInstrument)],
            ['Max lots per order', dash(rl?.maxQtyPerOrder)],
            ['Min lots', dash(rl?.minQty)],
            ['Lot step', '1'],
            ['Tick size', i ? `₹${i.tickSize}` : '—'],
            ['Exchange', `${i?.exchange} · ${i?.segment}`],
            ['Lot type', i?.lotClass === 'MEGA' ? 'Mega lot' : 'Mini lot'],
            ['Price source', q?.source === 'SIMULATED' ? 'Simulated feed' : q?.source ?? '—'],
          ]} />
        </Section>
      )}
      {i && order && <OrderSheet i={i} q={q} side={order} setSide={setOrder} initialQty={q0 ?? '1'} onClose={() => setOrder(null)} />}
    </Screen>
  );
}

type OType = 'MARKET' | 'LIMIT' | 'STOP_LOSS';
interface Rules { minQty: number; maxQtyPerOrder: number; maxQtyPerInstrument: number; brokeragePerLot?: string; brokeragePerMegaLot?: string; sessions: { exchange: string; open: string; close: string; isOpen: boolean; message?: string }[] }
const TYPE_LABEL: Record<OType, string> = { MARKET: 'Market', LIMIT: 'Limit', STOP_LOSS: 'Stop-loss' };
const isTrig = (t: OType) => t === 'STOP_LOSS';
const firesOnFall = (t: OType, s: Side) => t === 'STOP_LOSS' && s === 'SELL';
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
  const rules = useQuery<{ tradingRules: Rules }>(`{ tradingRules { minQty maxQtyPerOrder maxQtyPerInstrument brokeragePerLot brokeragePerMegaLot sessions { exchange open close isOpen message } } }`);
  const pos = useQuery<{ positions: { instrumentId: string; netQty: number }[] }>(`{ positions { instrumentId netQty } }`);
  const [type, setType] = useState<OType>('MARKET');
  const [qty, setQty] = useState(initialQty);
  const [price, setPrice] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState(newKey);
  // Same order retried after a network error → same key (no duplicate). Changed order → new key.
  useEffect(() => { setKey(newKey()); }, [i.id, side, type, qty, price]);
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
    if (session && !session.isOpen) {
      Alert.alert('Market Closed', session.message || `Trading is closed for ${i.exchange}.`);
      return;
    }
    if (side === 'SELL' && held <= 0) {
      Alert.alert('Cannot Sell', 'You cannot sell without holding an open buy position. Please buy first.');
      return;
    }
    if (side === 'SELL' && n > held) {
      Alert.alert('Insufficient Holdings', `Cannot sell ${n} lots. You only hold ${held} lots in this instrument.`);
      return;
    }
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
          <Chips fill value={type} onChange={(k) => { setType(k); setPrice(''); }} items={[{ k: 'MARKET', label: 'Market' }, { k: 'LIMIT', label: 'Limit' }, { k: 'STOP_LOSS', label: 'SL' }]} />
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={{ flex: 1.2, gap: 6 }}>
              <T v="sm" c="text2" w="500">Quantity (lots)</T>
              <LotStepper value={qty} onChange={setQty} />
              {qtyErr ? <T v="sm" c="neg">{qtyErr}</T> : null}
              {i.lotLabel ? <T v="xs" c="text3">{`1 lot = ${i.lotLabel}`}</T> : null}
            </View>
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
          <Button size="lg" kind={side === 'BUY' ? 'buy' : 'sell'} title={valid && preview ? `${side === 'BUY' ? 'Buy' : 'Sell'} ${n} @ ${type === 'MARKET' ? inr(side === 'BUY' ? q?.ask : q?.bid) : inr(price)}` : `Review ${side === 'BUY' ? 'buy' : 'sell'}`} disabled={!valid || !preview} onPress={() => {
            if (session && !session.isOpen) {
              Alert.alert('Market Closed', session.message || `Trading is closed for ${i.exchange}. Market hours are ${session.open}–${session.close} IST.`, [{ text: 'OK' }]);
              return;
            }
            if (side === 'SELL' && held <= 0) {
              Alert.alert('Cannot Sell Without Holdings', 'You cannot sell without holding an open buy position. Please buy first.', [
                { text: 'Switch to Buy', onPress: () => setSide('BUY') },
                { text: 'Cancel', style: 'cancel' },
              ]);
              return;
            }
            if (side === 'SELL' && n > held) {
              Alert.alert('Insufficient Holdings', `Cannot sell ${n} lots. You only hold ${held} lots in this instrument.`);
              return;
            }
            setErr(null);
            setReview(true);
          }} />
          <T v="xs" style={{ textAlign: 'center' }}>Simulated order. Never sent to an exchange.</T>
        </>
      ) : preview && (
        <>
          <Row gap={S[2]}><Badge text={side === 'BUY' ? 'Buy' : 'Sell'} tone={side === 'BUY' ? 'ok' : 'bad'} /><T w="600">{shortSymbol(i.symbol)}</T></Row>
          <Lines lines={[['Order type', TYPE_LABEL[type]], ['Quantity', n], [type === 'MARKET' ? 'Estimated price' : type === 'LIMIT' ? 'Limit price' : 'Trigger (LTP)', `₹${inr(preview.price)}`], ['Order value', `₹${inr(preview.value)}`], ['Margin required', `₹${inr(preview.intradayMargin)}`], ['Carry-forward margin', `₹${inr(preview.carryForwardMargin)}`]]} />
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

