'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { gql, newKey, subscribe } from '@/lib/api';
import { inr, shortSymbol, tone, when } from '@/lib/format';
import { useMutation, useQuery } from '@/lib/hooks';
import { Icon } from './icons';
import { Private, usePrefs } from '@/lib/prefs';
import { useAuth } from '@/lib/auth';
import { Change, Confirm, Dialog, Empty, ErrorState, Mark, Metrics, SkeletonRows, Status, Tabs, useToast } from './ui';

export interface Quote { instrumentId: string; ltp: string; bid: string; ask: string; high: string; low: string; change: string; changePct: string; ts: string; source: string }
export interface Instrument { id: string; symbol: string; name: string; exchange: string; segment: string; expiry?: string; lotSize: number; tickSize: string }
export const QUOTE_FIELDS = 'instrumentId ltp bid ask high low change changePct ts source';

/** Live quotes over WebSocket; seeds with a one-off fetch so the first paint has prices. */
export function useLiveQuotes(ids: string[]) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const key = ids.slice().sort().join(',');
  useEffect(() => {
    if (!key) return;
    const list = key.split(',');
    gql<{ quotes: Quote[] }>(`query($i:[ID!]!){ quotes(instrumentIds:$i){ ${QUOTE_FIELDS} } }`, { i: list })
      .then((d) => setQuotes((q) => ({ ...q, ...Object.fromEntries(d.quotes.map((x) => [x.instrumentId, x])) })))
      .catch(() => undefined);
    return subscribe<{ quotesUpdated: Quote[] }>(`subscription($i:[ID!]!){ quotesUpdated(instrumentIds:$i){ ${QUOTE_FIELDS} } }`, { i: list }, (d) =>
      setQuotes((q) => ({ ...q, ...Object.fromEntries(d.quotesUpdated.map((x) => [x.instrumentId, x])) })),
    );
  }, [key]);
  return quotes;
}

/** Briefly tints a row when its price ticks up or down. */
function useTick(v?: string) {
  const prev = useRef(v);
  const [cls, setCls] = useState('');
  useEffect(() => {
    if (v && prev.current && v !== prev.current) {
      setCls(Number(v) > Number(prev.current) ? 'tick-up' : 'tick-down');
      const h = setTimeout(() => setCls(''), 700);
      prev.current = v;
      return () => clearTimeout(h);
    }
    prev.current = v;
  }, [v]);
  return cls;
}

/* ======================================================================= account summary */
export interface Summary { balance: string; available: string; marginUsed: string; realizedPnl: string; unrealizedPnl: string; fees: string; deposits: string; withdrawals: string; openPositions: number; openOrders: number }
export const SUMMARY_Q = `query($u:ID){ accountSummary(userId:$u){ balance available marginUsed realizedPnl unrealizedPnl fees deposits withdrawals openPositions openOrders } }`;

export function useSummary(userId?: string) {
  return useQuery<{ accountSummary: Summary }>(SUMMARY_Q, { u: userId }, { pollMs: 5000 });
}

/** Portfolio header: one big number, supporting metrics in a divided strip. */
export function PortfolioSummary({ userId, actions, title = 'Available to trade' }: { userId?: string; actions?: boolean; title?: string }) {
  const { data, loading, error, refetch } = useSummary(userId);
  const [pay, setPay] = useState<'DEPOSIT' | 'WITHDRAWAL' | null>(null);
  if (loading && !data) return <div className="stack"><div className="skeleton" style={{ width: 180, height: 14 }} /><div className="skeleton" style={{ width: 260, height: 36 }} /><div className="skeleton" style={{ height: 76, borderRadius: 12 }} /></div>;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  const s = data!.accountSummary;
  const today = tone(s.unrealizedPnl);
  return (
    <section className="stack" style={{ gap: 20 }} aria-label="Account summary">
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <div className="hero-value">
          <div className="k">{title} <span className="badge info" style={{ marginLeft: 6 }}>Virtual ₹</span></div>
          <div className="v num"><Private width={8}>₹{inr(s.available)}</Private></div>
          <div className="sub t2">
            Open P&L <span className={`num w6 ${today}`}>{inr(s.unrealizedPnl, { sign: true })}</span>
            <span className="t3"> · Margin used <Private>₹{inr(s.marginUsed)}</Private></span>
          </div>
          {actions && <div className="sub t3">Deposits <span className="num pos"><Private>₹{inr(s.deposits)}</Private></span> · Withdrawals <span className="num neg"><Private>₹{inr(s.withdrawals)}</Private></span></div>}
        </div>
        {actions && (
          <div className="row">
            <button className="btn" onClick={() => setPay('WITHDRAWAL')}>Withdraw</button>
            <button className="btn btn-primary" onClick={() => setPay('DEPOSIT')}><Icon name="plus" size={18} />Add funds</button>
          </div>
        )}
      </div>
      <Metrics
        items={[
          { k: 'Ledger balance', v: <Private>₹{inr(s.balance)}</Private> },
          { k: 'Booked P&L', v: inr(s.realizedPnl, { sign: true }), tone: tone(s.realizedPnl) },
          { k: 'Positions · open orders', v: `${s.openPositions} · ${s.openOrders}` },
          { k: 'Brokerage paid', v: `₹${inr(s.fees)}` },
        ]}
      />
      {pay && <PaymentDialog type={pay} userId={userId} onClose={() => setPay(null)} onDone={refetch} available={s.available} />}
    </section>
  );
}

/* ======================================================================= payment request */
export function PaymentDialog({ type, userId, onClose, onDone, available }: { type: 'DEPOSIT' | 'WITHDRAWAL'; userId?: string; onClose: () => void; onDone?: () => void; available?: string }) {
  const [amount, setAmount] = useState('');
  const [touched, setTouched] = useState(false);
  const key = useMemo(newKey, []);
  const toast = useToast();
  const m = useMutation(`mutation($i:PaymentRequestInput!){ requestPayment(input:$i){ id status } }`);
  const fmtOk = /^\d{1,12}(\.\d{1,2})?$/.test(amount) && Number(amount) > 0;
  const over = type === 'WITHDRAWAL' && available !== undefined && fmtOk && Number(amount) > Number(available);
  const invalid = touched && (!fmtOk || over);
  return (
    <Dialog
      title={type === 'DEPOSIT' ? 'Add virtual funds' : 'Withdraw virtual funds'}
      sub="A Super Admin reviews every request. Virtual balances have no cash value."
      onClose={onClose}
    >
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); setTouched(true);
        if (!fmtOk || over) return;
        const r = await m.run({ i: { type, amount, idempotencyKey: key, userId } });
        if (r) { toast('Request sent for review'); onDone?.(); onClose(); }
      }}>
        <div className="field">
          <label htmlFor="amt">Amount</label>
          <div className="input-icon">
            <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-2)' }}>₹</span>
            <input id="amt" className="input num" style={{ background: 'var(--bg)', borderColor: 'var(--line-2)', paddingLeft: 30, fontSize: 18, height: 48 }} inputMode="decimal" autoFocus value={amount} aria-invalid={invalid} aria-describedby="amt-h" onBlur={() => setTouched(true)} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" />
          </div>
          <span id="amt-h" className={invalid ? 'err' : 'hint'}>
            {invalid ? (over ? `You can withdraw up to ₹${inr(available)}` : 'Enter an amount with up to 2 decimals') : type === 'WITHDRAWAL' && available ? `Withdrawable now: ₹${inr(available)}` : 'Up to 2 decimal places'}
          </span>
        </div>
        {type === 'DEPOSIT' && (
          <div className="chips" aria-label="Quick amounts">
            {['10000', '25000', '50000', '100000'].map((v) => <button type="button" key={v} className="chip" aria-pressed={amount === v} onClick={() => setAmount(v)}>+₹{inr(v, { decimals: false })}</button>)}
          </div>
        )}
        {m.error && <div className="notice err" role="alert"><Icon name="alert" size={18} />{m.error}</div>}
        <div className="actions" style={{ marginTop: 4 }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={m.pending}>{m.pending ? 'Sending…' : 'Send request'}</button>
        </div>
      </form>
    </Dialog>
  );
}

/* ======================================================================= watchlist */
interface WEntry { id: string; instrument: Instrument; quote?: Quote }
const WL_Q = `query($l:Int!){ watchlist(listIndex:$l){ id instrument{ id symbol name exchange segment expiry lotSize tickSize } quote{ ${QUOTE_FIELDS} } } }`;

/** Watchlist with tabs. `compact` = right-rail variant on Home. */
export function Watchlist({ compact }: { compact?: boolean }) {
  const { settings } = useAuth();
  const { prefs, set } = usePrefs();
  const [list, setList] = useState('0');
  const counts = useQuery<{ watchlistCounts: { listIndex: number; count: number }[] }>(`{ watchlistCounts { listIndex count } }`);
  const [extra, setExtra] = useState(0);
  const used = counts.data?.watchlistCounts ?? [];
  const max = settings?.maxWatchlists ?? 10;
  const shown = Math.min(max, Math.max(3, ...used.map((c) => c.listIndex + 1), Number(list) + 1) + extra);
  const countOf = (k: number) => used.find((c) => c.listIndex === k)?.count ?? 0;
  const { data, loading, error, refetch } = useQuery<{ watchlist: WEntry[] }>(WL_Q, { l: Number(list) });
  const entries = data?.watchlist ?? [];
  const live = useLiveQuotes(entries.map((e) => e.instrument.id));
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const remove = async (e: WEntry) => {
    try { await gql(`mutation($l:Int!,$i:ID!){ removeFromWatchlist(listIndex:$l, instrumentId:$i) }`, { l: Number(list), i: e.instrument.id }); toast(`${shortSymbol(e.instrument.symbol)} removed`); void refetch(); }
    catch (x) { toast((x as Error).message, true); }
  };

  return (
    <section className={compact ? 'panel' : ''} aria-label="Watchlist">
      {compact && <div style={{ padding: '16px 16px 0' }}><h2>Watchlist</h2></div>}
      <div className="spread" style={{ padding: compact ? '0 16px' : 0, flexWrap: 'nowrap', borderBottom: '1px solid var(--line)' }}>
        <div className="grow" style={{ marginBottom: -1 }}>
          <Tabs label="Watchlists" value={list} onChange={setList} items={Array.from({ length: shown }, (_, k) => ({ v: String(k), label: <>List {k + 1}{!compact && countOf(k) > 0 && <span className="t3 xs"> ({countOf(k)})</span>}</> }))} />
        </div>
        {!compact && shown < max && <button className="icon-btn" aria-label="New watchlist" title="New watchlist" onClick={() => { setExtra((x) => x + 1); setList(String(shown)); }}><Icon name="plus" size={18} /></button>}
        <button className="btn btn-sm btn-ghost" onClick={() => setAdding(true)} aria-label="Add script"><Icon name="search" size={16} /><span className="hide-sm">Add script</span></button>
      </div>
      {loading && !data ? <SkeletonRows rows={compact ? 5 : 6} pad={!!compact} /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !entries.length ? (
        <Empty icon="eye" title="Nothing in this list" action={<button className="btn btn-sm" onClick={() => setAdding(true)}>Add instruments</button>}>Track prices by adding instruments you care about.</Empty>
      ) : compact ? (
        <div className="list list-pad">
          {entries.map((e) => <CompactRow key={e.id} e={e} q={live[e.instrument.id] ?? e.quote} />)}
        </div>
      ) : (
        <>
        <div className="list only-mob">
          {entries.map((e) => <CompactRow key={e.id} e={e} q={live[e.instrument.id] ?? e.quote} withBidAsk={prefs.watchlistView === 'detailed'} />)}
        </div>
        <div className="table-wrap only-desk">
          <table className="t">
            <thead><tr><th>Instrument</th><th className="r">Price</th><th className="r hide-sm">Day range</th><th className="r">Sell · Buy</th><th><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>{entries.map((e) => <FullRow key={e.id} e={e} q={live[e.instrument.id] ?? e.quote} onRemove={() => void remove(e)} />)}</tbody>
          </table>
        </div>
        </>
      )}
      {!compact && entries.length > 0 && <p className="t3 xs" style={{ padding: '8px 0' }}>{entries.length} script{entries.length === 1 ? '' : 's'} · List {Number(list) + 1}</p>}
      {adding && <AddInstrument list={Number(list)} onClose={() => setAdding(false)} onAdded={() => { void refetch(); void counts.refetch(); }} />}
    </section>
  );
}

function CompactRow({ e, q, withBidAsk }: { e: WEntry; q?: Quote; withBidAsk?: boolean }) {
  const tick = useTick(q?.ltp);
  const href = `/trader/instrument/${e.instrument.id}`;
  return (
    <div className={`list-row ${tick}`} style={{ position: 'relative' }}>
      {withBidAsk ? (
        <Link href={href} className="grow" style={{ minWidth: 0 }}>
          <div><span className="w6">{shortSymbol(e.instrument.symbol)}</span> <span className="t3 xs">{e.instrument.segment}</span></div>
          <div className="row" style={{ gap: 6 }}><span className="num w6">{inr(q?.ltp)}</span><Change value={q?.change} pct={q?.changePct} size="sm" /></div>
        </Link>
      ) : (
      <Link href={href} className="grow" style={{ minWidth: 0 }}>
        <div className="w6">{shortSymbol(e.instrument.symbol)}</div>
        <div className="t3">{e.instrument.exchange} · {e.instrument.segment}</div>
      </Link>
      )}
      {!withBidAsk && <div className="quote-cell">
        <Link href={href} className="num w6">₹{inr(q?.ltp)}</Link>
        <Change value={q?.change} pct={q?.changePct} size="sm" />
      </div>}
      {withBidAsk && (
        <div className="ba-boxes">
          <span className="ba-box b"><Link href={`${href}?side=SELL`} aria-label={`Sell at ${q?.bid}`}>{inr(q?.bid)}</Link><small>L {inr(q?.low)}</small></span>
          <span className="ba-box a"><Link href={`${href}?side=BUY`} aria-label={`Buy at ${q?.ask}`}>{inr(q?.ask)}</Link><small>H {inr(q?.high)}</small></span>
        </div>
      )}
    </div>
  );
}

function FullRow({ e, q, onRemove }: { e: WEntry; q?: Quote; onRemove: () => void }) {
  const tick = useTick(q?.ltp);
  const href = `/trader/instrument/${e.instrument.id}`;
  return (
    <tr className={tick}>
      <td>
        <Link href={href} className="row" style={{ flexWrap: 'nowrap' }}>
          <Mark text={shortSymbol(e.instrument.symbol)} />
          <span><span className="w6">{shortSymbol(e.instrument.symbol)}</span><span className="sub" style={{ display: 'block' }}>{e.instrument.exchange} · {e.instrument.segment}{e.instrument.expiry ? ` · ${new Date(e.instrument.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` : ''}</span></span>
        </Link>
      </td>
      <td className="r"><div className="quote-cell"><span className="num w6">₹{inr(q?.ltp)}</span><Change value={q?.change} pct={q?.changePct} size="sm" /></div></td>
      <td className="r num t2 sm hide-sm">{inr(q?.low)} – {inr(q?.high)}</td>
      <td className="r">
        <span className="bidask">
          <Link className="b" href={`${href}?side=SELL`} aria-label={`Sell ${e.instrument.symbol} at ${q?.bid}`}>{inr(q?.bid)}</Link>
          <Link className="a" href={`${href}?side=BUY`} aria-label={`Buy ${e.instrument.symbol} at ${q?.ask}`}>{inr(q?.ask)}</Link>
        </span>
      </td>
      <td className="r"><button className="icon-btn" aria-label={`Remove ${e.instrument.symbol}`} onClick={onRemove}><Icon name="x" size={18} /></button></td>
    </tr>
  );
}

function AddInstrument({ list, onClose, onAdded }: { list: number; onClose: () => void; onAdded: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Instrument[] | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const toast = useToast();
  useEffect(() => {
    const t = setTimeout(() => gql<{ searchInstruments: Instrument[] }>(`query($q:String!){ searchInstruments(query:$q, limit:20){ id symbol name exchange segment } }`, { q }).then((d) => setResults(d.searchInstruments)).catch(() => setResults([])), 180);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Dialog title={`Add to list ${list + 1}`} onClose={onClose}>
      <div className="input-icon"><Icon name="search" size={18} /><input className="input" placeholder="Search symbol or company" aria-label="Search instruments" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
      <div className="list" style={{ marginTop: 8, maxHeight: 340, overflow: 'auto' }}>
        {results === null ? <SkeletonRows rows={4} pad={false} /> : !results.length ? <Empty icon="search" title={`No results for “${q}”`}>Try a different symbol.</Empty> : results.map((r) => (
          <div key={r.id} className="list-row">
            <Mark text={shortSymbol(r.symbol)} />
            <div className="grow"><div className="w6">{shortSymbol(r.symbol)}</div><div className="t3">{r.name}</div></div>
            <button className="btn btn-sm" disabled={added.includes(r.id)} onClick={async () => {
              try { await gql(`mutation($l:Int!,$i:ID!){ addToWatchlist(listIndex:$l, instrumentId:$i) }`, { l: list, i: r.id }); setAdded((a) => [...a, r.id]); onAdded(); }
              catch (e) { toast((e as Error).message, true); }
            }}>{added.includes(r.id) ? <><Icon name="check" size={16} />Added</> : 'Add'}</button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

/* ======================================================================= market movers (explore) */
export function Movers() {
  const { data, loading, error, refetch } = useQuery<{ searchInstruments: Instrument[] }>(`{ searchInstruments(query:"", limit:50){ id symbol name exchange segment } }`);
  const list = data?.searchInstruments ?? [];
  const quotes = useLiveQuotes(list.map((i) => i.id));
  const [tab, setTab] = useState<'gainers' | 'losers'>('gainers');
  const sorted = list
    .filter((i) => quotes[i.id])
    .sort((a, b) => (Number(quotes[b.id].changePct) - Number(quotes[a.id].changePct)) * (tab === 'gainers' ? 1 : -1))
    .filter((i) => (tab === 'gainers' ? Number(quotes[i.id].changePct) >= 0 : Number(quotes[i.id].changePct) < 0))
    .slice(0, 8);
  return (
    <section className="section" aria-label="Top movers">
      <div className="section-head">
        <h2>Top movers today</h2>
        <div className="chips" role="group" aria-label="Movers">
          <button className="chip" aria-pressed={tab === 'gainers'} onClick={() => setTab('gainers')}>Gainers</button>
          <button className="chip" aria-pressed={tab === 'losers'} onClick={() => setTab('losers')}>Losers</button>
        </div>
      </div>
      {loading && !data ? (
        <div className="tiles">{Array.from({ length: 4 }, (_, i) => <div key={i} className="tile"><div className="skeleton" style={{ width: 36, height: 36 }} /><div className="skeleton" style={{ width: '60%' }} /><div className="skeleton" style={{ width: '40%' }} /></div>)}</div>
      ) : error && !data ? <ErrorState error={error} retry={refetch} /> : !sorted.length ? (
        <Empty icon="trend" title={tab === 'gainers' ? 'No gainers right now' : 'No losers right now'} />
      ) : (
        <div className="tiles">
          {sorted.map((i) => {
            const q = quotes[i.id];
            return (
              <Link key={i.id} href={`/trader/instrument/${i.id}`} className="tile">
                <Mark text={shortSymbol(i.symbol)} />
                <div className="w6" style={{ marginTop: 'auto' }}>{shortSymbol(i.symbol)}</div>
                <div>
                  <div className="num w6">₹{inr(q.ltp)}</div>
                  <Change value={q.change} pct={q.changePct} size="sm" />
                </div>
              </Link>
            );
          })}
        </div>
      )}
      <p className="t3">Simulated prices for practice. Change is measured against the previous simulated close.</p>
    </section>
  );
}

/* ======================================================================= orders */
export const ORDER_TYPE: Record<string, string> = { MARKET: 'Market', LIMIT: 'Limit', STOP_LOSS: 'Stop-loss', TAKE_PROFIT: 'Take-profit' };
export interface Order { id: string; side: 'BUY' | 'SELL'; type: string; quantity: number; limitPrice?: string; triggerPrice?: string; triggeredAt?: string; fillPrice?: string; status: string; venue: string; rejectReason?: string; createdAt: string; filledAt?: string; instrument?: { symbol: string } }
export const ORDER_FIELDS = 'id side type quantity limitPrice triggerPrice triggeredAt fillPrice status venue rejectReason createdAt filledAt instrument{ symbol }';

export function OrdersTable({ userId, statuses, canCancel, emptyTitle = 'No orders yet', emptyText = 'Orders you place show up here with their status.' }: { userId?: string; statuses?: string[]; canCancel?: boolean; emptyTitle?: string; emptyText?: string }) {
  const { data, loading, error, refetch } = useQuery<{ orders: Order[] }>(`query($u:ID,$s:[OrderStatus!]){ orders(userId:$u, status:$s, limit:100){ ${ORDER_FIELDS} } }`, { u: userId, s: statuses }, { pollMs: 4000 });
  const [cancel, setCancel] = useState<Order | null>(null);
  const m = useMutation(`mutation($id:ID!){ cancelOrder(orderId:$id){ id status } }`);
  const toast = useToast();
  if (loading && !data) return <SkeletonRows />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.orders.length) return <Empty icon="list" title={emptyTitle}>{emptyText}</Empty>;
  return (
    <>
    <div className="list only-mob">
      {data!.orders.map((o) => (
        <div key={o.id} className="list-row" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <div className="w6">{o.instrument ? shortSymbol(o.instrument.symbol) : '—'}</div>
            <div className="t3"><span className={o.side === 'BUY' ? 'pos' : 'neg'} style={{ fontWeight: 600 }}>{o.side === 'BUY' ? 'Buy' : 'Sell'}</span> · {o.quantity} qty · {ORDER_TYPE[o.type] ?? o.type}{o.triggerPrice ? ` @ ₹${inr(o.triggerPrice)}` : ''} · {when(o.createdAt)}</div>
            {o.rejectReason && <div className="xs neg">{o.rejectReason}</div>}
          </div>
          <div className="quote-cell" style={{ gap: 4 }}>
            <span className="num w6">₹{inr(o.fillPrice ?? o.limitPrice ?? o.triggerPrice)}</span>
            <Status value={o.status} />
            {canCancel && o.status === 'OPEN' && <button className="btn btn-sm btn-danger" onClick={() => { m.setError(null); setCancel(o); }}>Cancel</button>}
          </div>
        </div>
      ))}
    </div>
    <div className="table-wrap only-desk">
      <table className="t">
        <thead><tr><th>Instrument</th><th>Type</th><th className="r">Qty</th><th className="r">Price</th><th>Status</th><th className="hide-sm">Time</th>{canCancel && <th />}</tr></thead>
        <tbody>
          {data!.orders.map((o) => (
            <tr key={o.id}>
              <td>
                <span className="w6">{o.instrument ? shortSymbol(o.instrument.symbol) : '—'}</span>
                <span className={`sub ${o.side === 'BUY' ? 'pos' : 'neg'}`} style={{ display: 'block', fontWeight: 600 }}>{o.side === 'BUY' ? 'Buy' : 'Sell'}</span>
              </td>
              <td className="t2">{ORDER_TYPE[o.type] ?? o.type}{o.triggerPrice && <span className="sub num" style={{ display: 'block' }}>Trigger ₹{inr(o.triggerPrice)}{o.triggeredAt ? ' · triggered' : ''}</span>}</td>
              <td className="r num">{o.quantity}</td>
              <td className="r num">₹{inr(o.fillPrice ?? o.limitPrice ?? o.triggerPrice)}</td>
              <td>
                <Status value={o.status} />
                {o.status === 'FILLED' && o.venue === 'SIMULATED' && <span className="sub" style={{ display: 'block' }}>Simulated fill</span>}
                {o.rejectReason && <span className="sub neg" style={{ display: 'block' }}>{o.rejectReason}</span>}
              </td>
              <td className="num t2 sm hide-sm">{when(o.createdAt)}</td>
              {canCancel && <td className="r">{o.status === 'OPEN' && <button className="btn btn-sm btn-danger" onClick={() => { m.setError(null); setCancel(o); }}>Cancel</button>}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {cancel && (
        <Confirm title="Cancel this order?" lines={[['Instrument', shortSymbol(cancel.instrument?.symbol ?? '')], ['Side', cancel.side === 'BUY' ? 'Buy' : 'Sell'], ['Quantity', cancel.quantity], [cancel.triggerPrice ? 'Trigger' : 'Limit price', `₹${inr(cancel.limitPrice ?? cancel.triggerPrice)}`]]}
          confirmLabel="Cancel order" tone="danger" pending={m.pending} error={m.error} onClose={() => setCancel(null)}
          onConfirm={async () => { if (await m.run({ id: cancel.id })) { toast('Order cancelled'); setCancel(null); void refetch(); } }} />
      )}
    </div>
    </>
  );
}

/* ======================================================================= positions */
interface Position { id: string; instrumentId: string; netQty: number; avgPrice: string; realizedPnl: string; unrealizedPnl?: string; ltp?: string; instrument?: { symbol: string } }
export function PositionsTable({ userId, canTrade }: { userId?: string; canTrade?: boolean }) {
  const { data, loading, error, refetch } = useQuery<{ positions: Position[] }>(`query($u:ID){ positions(userId:$u){ id instrumentId netQty avgPrice realizedPnl unrealizedPnl ltp instrument{ symbol } } }`, { u: userId }, { pollMs: 3000 });
  if (loading && !data) return <SkeletonRows />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.positions.length) return <Empty icon="briefcase" title="No positions" action={canTrade ? <Link className="btn btn-sm btn-primary" href="/trader">Explore instruments</Link> : undefined}>A position opens when a buy or sell order is executed.</Empty>;
  const total = data!.positions.reduce((a, p) => a + Number(p.unrealizedPnl ?? 0), 0).toFixed(2);
  return (
    <>
      <div className="spread" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <span className="t2">Total open P&L</span>
        <span className={`num w6 ${tone(total)}`} style={{ fontSize: 18 }}>{inr(total, { sign: true })}</span>
      </div>
      <div className="list list-pad only-mob">
        {data!.positions.map((p) => (
          <div key={p.id} className="list-row">
            <div className="grow">
              <div className="w6">{p.instrument ? shortSymbol(p.instrument.symbol) : '—'}</div>
              <div className="t3 num">{p.netQty} qty · avg ₹{inr(p.avgPrice)} · LTP ₹{inr(p.ltp)}</div>
            </div>
            <div className="quote-cell" style={{ gap: 4 }}>
              <span className={`num w6 ${tone(p.unrealizedPnl)}`}>{inr(p.unrealizedPnl, { sign: true })}</span>
              {canTrade && p.netQty !== 0 && <Link className="btn btn-sm" href={`/trader/instrument/${p.instrumentId}?side=${p.netQty > 0 ? 'SELL' : 'BUY'}&qty=${Math.abs(p.netQty)}`}>Exit</Link>}
            </div>
          </div>
        ))}
      </div>
      <div className="table-wrap only-desk">
        <table className="t">
          <thead><tr><th>Instrument</th><th className="r">Qty</th><th className="r">Avg · LTP</th><th className="r">Open P&L</th><th className="r hide-sm">Booked</th>{canTrade && <th />}</tr></thead>
          <tbody>
            {data!.positions.map((p) => (
              <tr key={p.id}>
                <td><span className="w6">{p.instrument ? shortSymbol(p.instrument.symbol) : '—'}</span><span className="sub" style={{ display: 'block' }}>{p.netQty > 0 ? 'Long' : p.netQty < 0 ? 'Short' : 'Closed'}</span></td>
                <td className={`r num w6 ${p.netQty > 0 ? 'pos' : p.netQty < 0 ? 'neg' : 'flat'}`}>{p.netQty}</td>
                <td className="r"><div className="quote-cell"><span className="num">₹{inr(p.avgPrice)}</span><span className="sub num">LTP ₹{inr(p.ltp)}</span></div></td>
                <td className={`r num w6 ${tone(p.unrealizedPnl)}`}>{inr(p.unrealizedPnl, { sign: true })}</td>
                <td className={`r num hide-sm ${tone(p.realizedPnl)}`}>{inr(p.realizedPnl, { sign: true })}</td>
                {canTrade && <td className="r">{p.netQty !== 0 && <Link className="btn btn-sm" href={`/trader/instrument/${p.instrumentId}?side=${p.netQty > 0 ? 'SELL' : 'BUY'}&qty=${Math.abs(p.netQty)}`}>Exit</Link>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ======================================================================= ledger */
interface LedgerLine { postingId: string; kind: string; memo: string; amount: string; createdAt: string }
const KIND: Record<string, string> = { OPENING_BALANCE: 'Opening balance', DEPOSIT: 'Funds added', WITHDRAWAL: 'Withdrawal', TRADE_PNL: 'Trade P&L', FEE: 'Brokerage', ADJUSTMENT: 'Adjustment', REVERSAL: 'Reversal' };
export function LedgerTable({ userId }: { userId?: string }) {
  const { data, loading, error, refetch } = useQuery<{ ledgerHistory: LedgerLine[] }>(`query($u:ID){ ledgerHistory(userId:$u, limit:100){ postingId kind memo amount createdAt } }`, { u: userId });
  if (loading && !data) return <SkeletonRows />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.ledgerHistory.length) return <Empty icon="file" title="No transactions yet">Trades, charges and fund movements appear here.</Empty>;
  return (
    <div className="list list-pad">
      {data!.ledgerHistory.map((l) => (
        <div key={l.postingId} className="list-row">
          <span className="mark" aria-hidden style={{ background: tone(l.amount) === 'pos' ? 'var(--pos-soft)' : 'var(--bg-3)', color: tone(l.amount) === 'pos' ? 'var(--pos)' : 'var(--text-2)' }}>
            <Icon name={tone(l.amount) === 'pos' ? 'down' : 'up'} size={16} />
          </span>
          <div className="grow"><div className="w5">{KIND[l.kind] ?? l.kind}</div><div className="t3">{l.memo} · {when(l.createdAt)}</div></div>
          <span className={`num w6 ${tone(l.amount)}`}>{inr(l.amount, { sign: true })}</span>
        </div>
      ))}
    </div>
  );
}

export interface Payment { id: string; userId: string; username?: string; type: string; mode: string; amount: string; status: string; reviewNote?: string; createdAt: string; requestedById: string }
export const PAYMENT_FIELDS = 'id userId username type mode amount status reviewNote createdAt requestedById';
