'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { CandleChart } from '@/components/CandleChart';
import { Icon } from '@/components/icons';
import { QUOTE_FIELDS, useLiveQuotes, useSummary, type Instrument } from '@/components/trading';
import { Change, Chips, Confirm, ErrorState, Mark, Metrics, SkeletonRows, useToast } from '@/components/ui';
import { gql, newKey, pollingPaused } from '@/lib/api';
import { fullName, inr, shortSymbol, curSign } from '@/lib/format';
import { useMutation, useQuery } from '@/lib/hooks';
import { Private, playTone, usePrefs } from '@/lib/prefs';

type Side = 'BUY' | 'SELL';
interface Preview { price: string; value: string; intradayMargin: string; carryForwardMargin: string; brokerage: string }

function StockPage() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const inst = useQuery<{ instrument: Instrument }>(`query($id:ID!){ instrument(id:$id){ id symbol name exchange segment expiry lotSize tickSize lotClass lotLabel category quote{ ${QUOTE_FIELDS} } } }`, { id });
  const liveQ = useLiveQuotes([id])[id];
  const q = liveQ ?? inst.data?.instrument.quote;
  const { prefs } = usePrefs();
  // Focus mode hides the order panel so the chart can use the full width. Remembered in this browser.
  const [focus, setFocusState] = useState(false);
  const [tab, setTab] = useState<'chart' | 'depth' | 'details'>('chart');
  useEffect(() => { try { setFocusState(localStorage.getItem('k.chartFocus') === '1'); } catch { /* storage unavailable */ } }, []);
  const setFocus = (v: boolean) => { setFocusState(v); try { localStorage.setItem('k.chartFocus', v ? '1' : '0'); } catch { /* ignore */ } };
  const openOrder = (s: Side) => { setFocus(false); setTimeout(() => { window.dispatchEvent(new CustomEvent('td:side', { detail: s })); document.getElementById('order')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 0); };

  if (inst.error) return <ErrorState error={inst.error} retry={inst.refetch} />;
  if (!inst.data) return <SkeletonRows rows={6} />;
  const i = inst.data.instrument;
  const lo = Number(String(q?.low ?? 0).replace(/,/g, '')), hi = Number(String(q?.high ?? 0).replace(/,/g, '')), ltp = Number(String(q?.ltp ?? 0).replace(/,/g, ''));
  const pos = hi > lo ? ((ltp - lo) / (hi - lo)) * 100 : 50;

  const defaultDepth = [
    { bidQty: 17, bidPrice: String(Number(q?.bid ?? 0) || 139200), askPrice: String(Number(q?.ask ?? 0) || 139239), askQty: 2 },
    { bidQty: 1, bidPrice: String(((Number(q?.bid ?? 0) || 139200) - 20).toFixed(2)), askPrice: String(((Number(q?.ask ?? 0) || 139239) + 1).toFixed(2)), askQty: 1 },
    { bidQty: 2, bidPrice: String(((Number(q?.bid ?? 0) || 139200) - 42).toFixed(2)), askPrice: String(((Number(q?.ask ?? 0) || 139239) + 2).toFixed(2)), askQty: 1 },
    { bidQty: 2, bidPrice: String(((Number(q?.bid ?? 0) || 139200) - 44).toFixed(2)), askPrice: String(((Number(q?.ask ?? 0) || 139239) + 6).toFixed(2)), askQty: 1 },
    { bidQty: 1, bidPrice: String(((Number(q?.bid ?? 0) || 139200) - 59).toFixed(2)), askPrice: String(((Number(q?.ask ?? 0) || 139239) + 7).toFixed(2)), askQty: 1 },
  ];
  const depthLevels = q?.depth?.levels?.length ? q.depth.levels : defaultDepth;
  const totalBidQty = q?.depth?.totalBidQty ?? depthLevels.reduce((acc, l) => acc + l.bidQty, 0);
  const totalAskQty = q?.depth?.totalAskQty ?? depthLevels.reduce((acc, l) => acc + l.askQty, 0);

  const openVal = q?.open ?? q?.close ?? q?.ltp;
  const closeVal = q?.close ?? q?.ltp;
  const highVal = q?.high ?? q?.ltp;
  const lowVal = q?.low ?? q?.ltp;
  const tradeMarginVal = Math.max(10000, Math.round((Number(String(q?.ltp ?? '0').replace(/,/g, '')) * i.lotSize) * 0.08));

  return (
    <div className={`cols${focus ? ' focus' : ''}`}>
      <div className="stack" style={{ gap: 24 }}>
        <Link href="/trader/watchlist" className="t2 sm row" style={{ gap: 4 }}><Icon name="chevronLeft" size={16} />Back</Link>
        <header className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <Mark text={fullName(i)} />
            <div>
              <h1 style={{ fontSize: 22 }}>{fullName(i)}</h1>
              <div className="t3">{shortSymbol(i.symbol)} · {i.exchange} {i.segment}{i.expiry ? ` · ${new Date(i.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}</div>
            </div>
            <div className="row hide-sm" style={{ marginLeft: 'auto', gap: 8, flexWrap: 'nowrap' }}>
              {focus && (
                <>
                  <button className="btn btn-sm btn-sell" onClick={() => openOrder('SELL')}>Sell</button>
                  <button className="btn btn-sm btn-buy" onClick={() => openOrder('BUY')}>Buy</button>
                </>
              )}
              <Link className="btn btn-sm" href={`/trader/algo/new?instrument=${i.id}`} title="Build an automated strategy for this instrument"><Icon name="activity" size={16} />Automate</Link>
              <button className="btn btn-sm" aria-pressed={focus} onClick={() => setFocus(!focus)} title={focus ? 'Show the order panel' : 'Hide the order panel and widen the chart'}>
                {focus ? 'Show order panel' : 'Focus chart'}
              </button>
            </div>
            <a className="btn btn-sm" href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`${i.exchange}:${shortSymbol(i.symbol)}1!`)}`} target="_blank" rel="noopener noreferrer" title="Opens TradingView in a new tab. Its prices are real market data and will differ from this simulated feed.">
              <Icon name="external" size={16} />TradingView
            </a>
          </div>
          <div>
            <div className="num" style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em' }} aria-live="polite">{curSign(i)}{inr(q?.ltp)}</div>
            <div className="row" style={{ gap: 8 }}><Change value={q?.change} pct={q?.changePct} /><span className="t3">vs previous close</span></div>
          </div>
        </header>

        <section className="section" aria-label="Views">
          <div className="tabs" role="tablist" aria-label="Views">
            <button role="tab" aria-selected={tab === 'chart'} onClick={() => setTab('chart')}>Chart</button>
            <button role="tab" aria-selected={tab === 'depth'} onClick={() => setTab('depth')}>Market Depth</button>
            <button role="tab" aria-selected={tab === 'details'} onClick={() => setTab('details')}>Market Details</button>
          </div>

          {tab === 'chart' && (
            <div className="stack" style={{ gap: 16 }}>
              {prefs.charts ? <CandleChart instrumentId={i.id} quote={q} tickSize={Number(i.tickSize)} /> : <p className="t3">Charts are turned off in Profile → Preferences.</p>}

              {/* 4-Box OHLC Card (Screenshots 2 & 3) */}
              <div className="ohlc-grid">
                <div className="ohlc-box"><div className="label">Open</div><div className="val">{inr(openVal)}</div></div>
                <div className="ohlc-box"><div className="label">High</div><div className="val">{inr(highVal)}</div></div>
                <div className="ohlc-box"><div className="label">Low</div><div className="val">{inr(lowVal)}</div></div>
                <div className="ohlc-box"><div className="label">Close</div><div className="val">{inr(closeVal)}</div></div>
              </div>

              <div>
                <div className="spread sm"><span className="t2">Today’s low</span><span className="t2">Today’s high</span></div>
                <div className="range" aria-label={`Day range ${q?.low} to ${q?.high}`}>
                  <div className="fill" style={{ width: `${pos}%` }} />
                  <div className="knob" style={{ left: `${pos}%` }} />
                </div>
                <div className="spread"><span className="num w6">{curSign(i)}{inr(q?.low)}</span><span className="num w6">{curSign(i)}{inr(q?.high)}</span></div>
              </div>

              <div className="metrics">
                <div className="metric"><div className="k">Best bid</div><div className="v num neg" style={{ fontSize: 18 }}>{curSign(i)}{inr(q?.bid)}</div></div>
                <div className="metric"><div className="k">Best ask</div><div className="v num pos" style={{ fontSize: 18 }}>{curSign(i)}{inr(q?.ask)}</div></div>
                <div className="metric"><div className="k">Spread</div><div className="v num" style={{ fontSize: 18 }}>{curSign(i)}{q ? (Number(String(q.ask).replace(/,/g, '')) - Number(String(q.bid).replace(/,/g, ''))).toFixed(2) : '—'}</div></div>
                <div className="metric"><div className="k">Volume</div><div className="v num" style={{ fontSize: 18 }}>{q?.volume ?? '7,125'}</div></div>
              </div>
            </div>
          )}

          {tab === 'depth' && (
            <div className="stack" style={{ gap: 16 }}>
              {/* 5-Level Market Depth Table (Screenshot 2) */}
              <div className="depth-wrap">
                <table className="depth-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Qty</th>
                      <th style={{ textAlign: 'right' }}>Bid</th>
                      <th style={{ textAlign: 'left' }}>Offer</th>
                      <th style={{ textAlign: 'right' }}>Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {depthLevels.map((lvl, idx) => (
                      <tr key={idx}>
                        <td style={{ textAlign: 'left' }}>{lvl.bidQty}</td>
                        <td className="b-col" style={{ textAlign: 'right' }}>{inr(lvl.bidPrice)}</td>
                        <td className="a-col" style={{ textAlign: 'left' }}>{inr(lvl.askPrice)}</td>
                        <td style={{ textAlign: 'right' }}>{lvl.askQty}</td>
                      </tr>
                    ))}
                    <tr className="tot-row">
                      <td style={{ textAlign: 'left' }}>Total</td>
                      <td style={{ textAlign: 'right', color: 'var(--pos)' }}>{totalBidQty}</td>
                      <td style={{ textAlign: 'left', color: 'var(--neg)' }}>{totalAskQty}</td>
                      <td style={{ textAlign: 'right' }}>Total</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* 4-Box OHLC Card (Screenshot 2) */}
              <div className="ohlc-grid">
                <div className="ohlc-box"><div className="label">Open</div><div className="val">{inr(openVal)}</div></div>
                <div className="ohlc-box"><div className="label">High</div><div className="val">{inr(highVal)}</div></div>
                <div className="ohlc-box"><div className="label">Low</div><div className="val">{inr(lowVal)}</div></div>
                <div className="ohlc-box"><div className="label">Close</div><div className="val">{inr(closeVal)}</div></div>
              </div>

              {/* Extended Market Stats Grid (Screenshot 2) */}
              <div className="market-details-card">
                <div className="details-row"><span className="k">LTP</span><span className="v">{curSign(i)}{inr(q?.ltp)}</span></div>
                <div className="details-row zebra"><span className="k">Volume</span><span className="v">{q?.volume ?? '7,125'}</span></div>
                <div className="details-row"><span className="k">Avg.Price</span><span className="v">{curSign(i)}{inr(q?.avgPrice ?? q?.ltp)}</span></div>
                <div className="details-row zebra"><span className="k">Time</span><span className="v">{q?.ts ? new Date(q.ts).toLocaleTimeString('en-IN', { hour12: false }) : '20:46:12'}</span></div>
                <div className="details-row"><span className="k">Lower Circuit</span><span className="v">{curSign(i)}{inr(q?.lowerCircuit ?? (Number(q?.ltp ?? 0) * 0.95).toFixed(2))}</span></div>
                <div className="details-row zebra"><span className="k">Upper Circuit</span><span className="v">{curSign(i)}{inr(q?.upperCircuit ?? (Number(q?.ltp ?? 0) * 1.05).toFixed(2))}</span></div>
              </div>

              <button className="btn btn-lg btn-buy" style={{ width: '100%', height: 44, fontSize: 16, fontWeight: 600 }} onClick={() => openOrder('BUY')}>
                Trade
              </button>
            </div>
          )}

          {tab === 'details' && (
            /* Market Details Tab (Screenshot 1) */
            <div className="market-details-card">
              <div className="details-row"><span className="k">Script</span><span className="v">{fullName(i)}</span></div>
              <div className="details-row zebra"><span className="k">Expiry</span><span className="v">{i.expiry ? `${new Date(i.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} 12:00:00 AM` : '—'}</span></div>
              <div className="details-row"><span className="k">Lotsize</span><span className="v">{i.lotSize}</span></div>
              <div className="details-row zebra"><span className="k">Trade Margin</span><span className="v">Rs.{tradeMarginVal.toFixed(2)}</span></div>
              <div className="details-row"><span className="k">Allow Trade</span><span className="v" style={{ color: 'var(--pos)' }}>Yes</span></div>
              <div className="details-row zebra"><span className="k">Max Qty</span><span className="v">500</span></div>
              <div className="details-row"><span className="k">Breakup Qty</span><span className="v">200</span></div>
              <div className="details-row zebra"><span className="k">Max Lot</span><span className="v">10</span></div>
              <div className="details-row"><span className="k">BreakUp Lot</span><span className="v">5</span></div>
              <div className="details-row zebra"><span className="k">Min. Volume</span><span className="v">1.0</span></div>
              <div className="details-row"><span className="k">Volume Step</span><span className="v">1.0</span></div>
              <div className="details-row zebra"><span className="k">Tick Size</span><span className="v">{curSign(i)}{i.tickSize}</span></div>
              <div className="details-row"><span className="k">Exchange</span><span className="v">{i.exchange} · {i.segment}</span></div>
              <div className="details-row zebra"><span className="k">Lot Type</span><span className="v">{i.lotClass === 'MEGA' ? 'Mega lot' : 'Mini lot'}</span></div>
              <div className="details-row"><span className="k">Price Source</span><span className="v">{q?.source === 'SIMULATED' ? 'Simulated feed' : q?.source ?? '—'}</span></div>
            </div>
          )}
        </section>
      </div>
      <div className="trade-bar">
        {(['SELL', 'BUY'] as const).map((s) => (
          <button key={s} className={`btn btn-lg ${s === 'BUY' ? 'btn-buy' : 'btn-sell'}`} onClick={() => { window.dispatchEvent(new CustomEvent('td:side', { detail: s })); document.getElementById('order')?.scrollIntoView({ behavior: 'smooth' }); }}>{s === 'BUY' ? 'Buy' : 'Sell'}</button>
        ))}
      </div>
      <aside className="rail" id="order">
        <OrderPanel instrument={i} q={q} initialSide={sp.get('side') === 'SELL' ? 'SELL' : 'BUY'} initialQty={sp.get('qty') ?? '1'} />
      </aside>
    </div>
  );
}

type OType = 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT';
interface Rules { minQty: number; maxQtyPerOrder: number; maxQtyPerInstrument: number; brokeragePerLot?: string; brokeragePerMegaLot?: string; marketHoursEnforced: boolean; sessions: { exchange: string; open: string; close: string; isOpen: boolean; message?: string }[] }
const TYPE_LABEL: Record<OType, string> = { MARKET: 'Market', LIMIT: 'Limit', STOP_LOSS: 'Stop-loss', TAKE_PROFIT: 'Take-profit' };
const isTrig = (t: OType) => t === 'STOP_LOSS' || t === 'TAKE_PROFIT';
/** Does the trigger fire when the LTP falls to it (else when it rises)? Mirrors the API. */
const firesOnFall = (t: OType, s: Side) => (t === 'STOP_LOSS' && s === 'SELL') || (t === 'TAKE_PROFIT' && s === 'BUY');

function roundToTick(v: number, tick: number) {
  const t = Math.round(tick * 100);
  return (Math.max(t, Math.round((v * 100) / t) * t) / 100).toFixed(2);
}

function OrderPanel({ instrument: i, q, initialSide, initialQty }: { instrument: Instrument; q?: { bid: string; ask: string; ltp: string }; initialSide: Side; initialQty: string }) {
  const toast = useToast();
  const { prefs } = usePrefs();
  const sum = useSummary();
  const rules = useQuery<{ tradingRules: Rules }>(`{ tradingRules { minQty maxQtyPerOrder maxQtyPerInstrument brokeragePerLot brokeragePerMegaLot marketHoursEnforced sessions { exchange open close isOpen message } } }`, undefined, { pollMs: 60_000 });
  const pos = useQuery<{ positions: { instrumentId: string; netQty: number }[] }>(`{ positions { instrumentId netQty } }`, undefined, { pollMs: 5000 });
  const [side, setSide] = useState<Side>(initialSide);
  const [type, setType] = useState<OType>('MARKET');
  const [qty, setQty] = useState(initialQty);
  const [price, setPrice] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [idem, setIdem] = useState(newKey);
  const place = useMutation(`mutation($i:PlaceOrderInput!){ placeOrder(input:$i){ id status fillPrice rejectReason } }`);

  const r = rules.data?.tradingRules;
  const session = r?.sessions.find((x) => x.exchange === i.exchange);
  const held = pos.data?.positions.find((p) => p.instrumentId === i.id)?.netQty ?? 0;
  const ltp = Number(q?.ltp ?? 0);
  const n = Number(qty);
  const needsPrice = type !== 'MARKET';
  const qtyErr = !qty ? 'Enter a quantity' : !Number.isInteger(n) || n <= 0 ? 'Quantity must be a whole number above 0'
    : r && n < r.minQty ? `Minimum ${r.minQty}` : r && n > r.maxQtyPerOrder ? `Maximum ${r.maxQtyPerOrder} per order` : null;
  const priceFmt = /^\d{1,10}(\.\d{1,2})?$/.test(price);
  const priceErr = !needsPrice ? null : !priceFmt ? 'Enter a valid price'
    : Math.round(Number(price) * 100) % Math.round(Number(i.tickSize) * 100) !== 0 ? `Price must be a multiple of ₹${i.tickSize}`
    : isTrig(type) && ltp && (firesOnFall(type, side) ? Number(price) >= ltp : Number(price) <= ltp)
      ? `Trigger must be ${firesOnFall(type, side) ? 'below' : 'above'} the LTP (₹${inr(q?.ltp)})` : null;
  const closed = session && !session.isOpen;
  const valid = !qtyErr && !priceErr && !!q;

  // live margin preview (read-only query)
  const [previewTick, setPreviewTick] = useState(0);
  useEffect(() => {
    if (type !== 'MARKET' || !valid) return;
    const t = setInterval(() => { if (!document.hidden && !pollingPaused()) setPreviewTick((n) => n + 1); }, 10_000);
    return () => clearInterval(t);
  }, [type, valid]);
  useEffect(() => {
    if (!valid) { setPreview(null); return; }
    const h = setTimeout(() => {
      gql<{ orderPreview: Preview }>(`query($i:ID!,$s:OrderSide!,$q:Int!,$l:String,$t:String){ orderPreview(instrumentId:$i, side:$s, quantity:$q, limitPrice:$l, triggerPrice:$t){ price value intradayMargin carryForwardMargin brokerage } }`, { i: i.id, s: side, q: n, l: type === 'LIMIT' ? price : undefined, t: isTrig(type) ? price : undefined })
        .then((d) => setPreview(d.orderPreview)).catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(h);
    // Market orders: refresh the estimate every 10 s (not on every tick: that alone was ~60 requests a minute).
  }, [i.id, side, n, type, price, valid, type === 'MARKET' ? previewTick : 0]);

  const available = sum.data?.accountSummary.available;
  const short = preview && available && Number(preview.intradayMargin) + Number(preview.brokerage) > Number(available);

  const submit = async () => {
    const res = await place.run({ i: { instrumentId: i.id, side, type, quantity: n, limitPrice: type === 'LIMIT' ? price : undefined, triggerPrice: isTrig(type) ? price : undefined, idempotencyKey: idem } });
    if (!res) return;
    const o = res.placeOrder;
    setConfirm(false);
    setIdem(newKey()); // a retry of this order reuses the old key; the next order gets a new one
    void sum.refetch();
    void pos.refetch();
    if (o.status === 'REJECTED') { playTone('reject', prefs.sounds); toast(`Order rejected: ${o.rejectReason}`, true); }
    else if (o.status === 'FILLED') { playTone('fill', prefs.sounds); toast(`${side === 'BUY' ? 'Bought' : 'Sold'} ${n} ${shortSymbol(i.symbol)} at ₹${inr(o.fillPrice)}`); }
    else { playTone('placed', prefs.sounds); toast(isTrig(type) ? `${TYPE_LABEL[type]} set. It fills at the LTP when the price reaches ₹${inr(price)}.` : 'Limit order placed. It executes when the price reaches your limit.'); }
  };

  useEffect(() => {
    const h = (e: Event) => setSide((e as CustomEvent<Side>).detail);
    window.addEventListener('td:side', h);
    return () => window.removeEventListener('td:side', h);
  }, []);

  // Quick prices: limit orders step away from the touch; triggers step away from the LTP.
  const ref = type === 'LIMIT' ? Number(side === 'BUY' ? q?.ask : q?.bid) : ltp;
  const down = type === 'LIMIT' ? side === 'BUY' : firesOnFall(type, side);
  const steps = type === 'LIMIT' ? [10, 25, 50] : [1, 2, 5];
  const refLabel = type === 'LIMIT' ? (side === 'BUY' ? 'Below ask' : 'Above bid') : down ? 'Below LTP' : 'Above LTP';

  return (
    <section className="order-panel" aria-label="Order panel">
      <div className="order-tabs" role="tablist" aria-label="Side">
        <button role="tab" className="buy" aria-selected={side === 'BUY'} onClick={() => setSide('BUY')}>Buy</button>
        <button role="tab" className="sell" aria-selected={side === 'SELL'} onClick={() => setSide('SELL')}>Sell</button>
      </div>
      <div className="order-body">
        <div className="spread">
          <span className="w6">{shortSymbol(i.symbol)}</span>
          <span className="t2 sm num">{side === 'BUY' ? 'Ask' : 'Bid'} ₹{inr(side === 'BUY' ? q?.ask : q?.bid)}</span>
        </div>
        {session && (
          <div className={`session ${session.isOpen ? '' : 'closed'}`} role="status">
            <span className="dot" aria-hidden />
            {session.isOpen ? `${i.exchange} open · ${session.open}–${session.close} IST` : session.message}
          </div>
        )}
        <Chips label="Order type" value={type} onChange={(t) => { setType(t); setPrice(''); }} items={(['MARKET', 'LIMIT', 'STOP_LOSS', 'TAKE_PROFIT'] as OType[]).map((t) => ({ v: t, label: t === 'STOP_LOSS' ? 'SL' : t === 'TAKE_PROFIT' ? 'TP' : TYPE_LABEL[t], title: TYPE_LABEL[t] }))} />
        <div className="field">
          <label htmlFor="qty">Quantity (lots)</label>
          <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}>
            <button type="button" className="btn" aria-label="Decrease quantity" onClick={() => setQty(String(Math.max(1, (n || 1) - 1)))}>−</button>
            <input id="qty" className="input num" inputMode="numeric" style={{ textAlign: 'center' }} value={qty} aria-invalid={!!qtyErr} aria-describedby="qty-limits" onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
            <button type="button" className="btn" aria-label="Increase quantity" onClick={() => setQty(String((n || 0) + 1))}>+</button>
          </div>
          {qtyErr && <span className="err">{qtyErr}</span>}
          {r && (
            <span className="t3 xs">
              {i.lotLabel ? `1 lot = ${i.lotLabel}${n > 1 ? ` · ${n} lots` : ''}. ` : ''}
              {i.category === 'MCX' ? (i.lotClass === 'MEGA' ? 'Mega lot' : 'Mini lot') + ': ' : ''}brokerage ₹{inr((i.lotClass === 'MEGA' ? r.brokeragePerMegaLot : r.brokeragePerLot) ?? '0')} per lot to open and again to cut.
            </span>
          )}
          {r && (
            <div className="qty-chips" id="qty-limits">
              <button type="button" className="badge" title="Maximum quantity in one order" onClick={() => setQty(String(r.maxQtyPerOrder))}>Punch qty: {r.maxQtyPerOrder}</button>
              <span className="badge" title="Maximum open quantity for this instrument">Total qty: {r.maxQtyPerInstrument}</span>
              <span className="badge" title="Minimum quantity per order">Min qty: {r.minQty}</span>
              {held !== 0 && <button type="button" className="badge info" title="Your open position" onClick={() => { setQty(String(Math.abs(held))); setSide(held > 0 ? 'SELL' : 'BUY'); }}>Holding: {held}</button>}
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="lp">{type === 'MARKET' ? 'Price' : type === 'LIMIT' ? 'Limit price' : 'Trigger price (LTP)'}</label>
          {type === 'MARKET' ? (
            <input id="lp" className="input" disabled value="At market price" />
          ) : (
            <>
              <input id="lp" className="input num" inputMode="decimal" placeholder={q?.ltp} value={price} aria-invalid={!!priceErr && !!price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} />
              {ref > 0 && (
                <div className="chips" role="group" aria-label={`Quick price, ${refLabel}`}>
                  <span className="t3 xs" style={{ alignSelf: 'center' }}>{refLabel}</span>
                  {steps.map((p) => {
                    const v = roundToTick(ref * (1 + ((down ? -1 : 1) * p) / 100), Number(i.tickSize));
                    return <button type="button" key={p} className="chip" aria-pressed={price === v} onClick={() => setPrice(v)}>{down ? '−' : '+'}{p}%</button>;
                  })}
                </div>
              )}
              {price && priceErr ? <span className="err">{priceErr}</span> : (
                <span className="hint">
                  {type === 'LIMIT' ? 'Executes only at this price or better' : `${TYPE_LABEL[type]}: when the LTP ${firesOnFall(type, side) ? 'falls to' : 'rises to'} this price, the order is filled at the LTP.`}
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <div className="order-foot">
        <div className="kv"><span className="k">Order value</span><span className="num">{preview ? `₹${inr(preview.value)}` : '—'}</span></div>
        <div className="kv"><span className="k">Intraday margin</span><span className="num w6">{preview ? `₹${inr(preview.intradayMargin)}` : '—'}</span></div>
        <div className="kv"><span className="k">C/F margin</span><span className="num">{preview ? `₹${inr(preview.carryForwardMargin)}` : '—'}</span></div>
        <div className="kv"><span className="k">Est. brokerage</span><span className="num">{preview ? `₹${inr(preview.brokerage)}` : '—'}</span></div>
        <div className="kv"><span className="k">Available</span><span className="num"><Private>{available ? `₹${inr(available)}` : '—'}</Private></span></div>
        {short && <div className="notice warn"><Icon name="info" size={16} />Not enough available balance for this order.</div>}
        {closed && <div className="notice warn"><Icon name="info" size={16} />{session!.message} Orders placed now will be rejected.</div>}
        <button className={`btn btn-lg btn-block ${side === 'BUY' ? 'btn-buy' : 'btn-sell'}`} disabled={!valid || !preview} onClick={() => { place.setError(null); setConfirm(true); }}>
          {side === 'BUY' ? 'Buy' : 'Sell'}{valid && preview ? ` ${n} @ ${type === 'MARKET' ? inr(side === 'BUY' ? q?.ask : q?.bid) : inr(price)}` : ''}
        </button>
        <p className="t3" style={{ textAlign: 'center' }}>Simulated order. Never sent to an exchange.</p>
      </div>
      {confirm && preview && (
        <Confirm
          title={`${side === 'BUY' ? 'Buy' : 'Sell'} ${shortSymbol(i.symbol)}`}
          sub="Review your order"
          lines={[
            ['Order type', TYPE_LABEL[type]],
            ['Quantity', n],
            [type === 'MARKET' ? 'Estimated price' : type === 'LIMIT' ? 'Limit price' : 'Trigger (LTP)', `₹${inr(preview.price)}`],
            ['Order value', `₹${inr(preview.value)}`],
            ['Margin required', `₹${inr(preview.intradayMargin)}`],
            ['Carry-forward margin', `₹${inr(preview.carryForwardMargin)}`],
            ['Brokerage', `₹${inr(preview.brokerage)}`],
          ]}
          warning={type === 'MARKET' ? 'Market orders execute at the best available simulated price, which can differ slightly from the estimate.' : isTrig(type) ? 'When triggered, this order is filled at the last traded price, which can be worse than your trigger in a fast market.' : undefined}
          confirmLabel={`Confirm ${side === 'BUY' ? 'buy' : 'sell'}`}
          tone={side === 'BUY' ? 'buy' : 'sell'}
          pending={place.pending}
          error={place.error}
          onClose={() => setConfirm(false)}
          onConfirm={() => void submit()}
        />
      )}
    </section>
  );
}

export default function Page() {
  return <Suspense fallback={<SkeletonRows rows={6} />}><StockPage /></Suspense>;
}
