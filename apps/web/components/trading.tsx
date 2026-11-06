'use client';
import { useSoleAdmin } from '@/lib/sole-admin';
import { useAuth } from '@/lib/auth';
import Link from 'next/link';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { gql, newKey, subscribe } from '@/lib/api';
import { fullName, inr, shortSymbol, tone, when, curSign } from '@/lib/format';
import { useMutation, useQuery } from '@/lib/hooks';
import { Icon } from './icons';
import { DemoDepositDetails } from './demo-deposit';
import { Private, usePrefs } from '@/lib/prefs';
import { Change, Confirm, Dialog, Empty, ErrorState, Mark, Metrics, SkeletonRows, Status, useToast } from './ui';

export interface DepthLevel {
  bidQty: number;
  bidPrice: string;
  askPrice: string;
  askQty: number;
}

export interface MarketDepth {
  levels: DepthLevel[];
  totalBidQty: number;
  totalAskQty: number;
}

export interface Quote {
  instrumentId: string;
  ltp: string;
  bid: string;
  ask: string;
  high: string;
  low: string;
  change: string;
  changePct: string;
  ts: string;
  source: string;
  open?: string;
  close?: string;
  volume?: string;
  avgPrice?: string;
  lowerCircuit?: string;
  upperCircuit?: string;
  depth?: MarketDepth;
}
export interface Instrument { id: string; symbol: string; name: string; exchange: string; segment: string; expiry?: string; lotSize: number; tickSize: string; lotClass?: 'MINI' | 'MEGA'; lotLabel?: string; category?: string; quote?: Quote }

export const CATEGORIES = [
  { v: '', label: 'All' },
  { v: 'FUTURES', label: 'Futures' },
  { v: 'MCX', label: 'MCX' },
  { v: 'OPTIONS', label: 'Options' },
  { v: 'FOREX', label: 'Forex' },
  { v: 'CRYPTO', label: 'Crypto' },
  { v: 'US_STOCK', label: 'US Stock' },
  { v: 'COMEX', label: 'COMEX' },
  { v: 'US_INDEX', label: 'US Index' },
] as const;
export type CategoryV = (typeof CATEGORIES)[number]['v'];
const expiryShort = (d?: string) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '');

/** "Mini · 100 g" badge for MCX instruments (and the lot size of others). */
export function LotTag({ i }: { i: Pick<Instrument, 'lotClass' | 'lotLabel' | 'category'> }) {
  if (i.category !== 'MCX' && !i.lotLabel) return null;
  return (
    <span className={`badge ${i.lotClass === 'MEGA' ? 'info' : ''}`} title="What one lot is">
      {i.category === 'MCX' ? (i.lotClass === 'MEGA' ? 'Mega' : 'Mini') : 'Lot'}{i.lotLabel ? ` · ${i.lotLabel}` : ''}
    </span>
  );
}
export const QUOTE_FIELDS = 'instrumentId ltp bid ask high low change changePct ts source open close volume avgPrice lowerCircuit upperCircuit depth { levels { bidQty bidPrice askPrice askQty } totalBidQty totalAskQty }';

/** Live quotes over WebSocket with polling heartbeat; seeds with one-off fetch and keeps active. */
export function useLiveQuotes(ids: string[]) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const key = ids.slice().sort().join(',');
  useEffect(() => {
    if (!key) return;
    const list = key.split(',');
    const chunkSize = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < list.length; i += chunkSize) {
      chunks.push(list.slice(i, i + chunkSize));
    }

    const fetchAll = () => {
      for (const chunk of chunks) {
        gql<{ quotes: Quote[] }>(`query($i:[ID!]!){ quotes(instrumentIds:$i){ ${QUOTE_FIELDS} } }`, { i: chunk })
          .then((d) => {
            if (d?.quotes) {
              setQuotes((q) => ({ ...q, ...Object.fromEntries(d.quotes.map((x) => [x.instrumentId, x])) }));
            }
          })
          .catch(() => undefined);
      }
    };

    fetchAll();
    const interval = setInterval(fetchAll, 1500);

    const unsubs = chunks.map((chunk) =>
      subscribe<{ quotesUpdated: Quote[] }>(
        `subscription($i:[ID!]!){ quotesUpdated(instrumentIds:$i){ ${QUOTE_FIELDS} } }`,
        { i: chunk },
        (d) => {
          if (d?.quotesUpdated?.length) {
            setQuotes((q) => ({ ...q, ...Object.fromEntries(d.quotesUpdated.map((x) => [x.instrumentId, x])) }));
          }
        }
      )
    );

    return () => {
      clearInterval(interval);
      for (const unsub of unsubs) {
        try { unsub(); } catch {}
      }
    };
  }, [key]);
  return quotes;
}

/** Briefly tints a row when its price ticks up or down. */
/** Last update time of a quote, e.g. 18:54:12 (IST). */
const quoteTime = (ts?: string) => (ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) : '—');
const expiryText = (d?: string) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

/** Bid (red) and ask (green) boxes that blink green when the price rises and red when it falls; day low and high below. */
function BidAskBoxes({ href, q, label }: { href: string; q?: Quote; label: string }) {
  const tb = useTick(q?.bid);
  const ta = useTick(q?.ask);
  return (
    <div className="ba-boxes">
      <span className="ba-box b"><Link className={tb} href={`${href}?side=SELL`} aria-label={`Sell ${label} at ${q?.bid ?? ''}`}>{inr(q?.bid)}</Link><small>L {inr(q?.low)}</small></span>
      <span className="ba-box a"><Link className={ta} href={`${href}?side=BUY`} aria-label={`Buy ${label} at ${q?.ask ?? ''}`}>{inr(q?.ask)}</Link><small>H {inr(q?.high)}</small></span>
    </div>
  );
}

/** Change % only, coloured up/down. */
function ChgPct({ q }: { q?: Quote }) {
  if (!q?.changePct) return <span className="t3">—</span>;
  const t = tone(q.change);
  return <span className={`chg sm ${t}`}>{inr(q.changePct, { sign: true })}%</span>;
}

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
export function PortfolioSummary({ userId, actions, title = 'Available to trade', compact, detail }: { userId?: string; actions?: boolean; title?: string; compact?: boolean; detail?: boolean }) {
  const { data, loading, error, refetch } = useSummary(userId);
  const [pay, setPay] = useState<'DEPOSIT' | 'WITHDRAWAL' | null>(null);
  const showFees = useAuth().me?.role !== 'TRADER'; // brokerage is not shown to traders (staff still see it)
  if (compact) {
    if (loading && !data) return <div className="panel bal-card"><div className="skeleton" style={{ width: 120, height: 12 }} /><div className="skeleton" style={{ width: 180, height: 26, marginTop: 8 }} /></div>;
    if (error && !data) return <ErrorState error={error} retry={refetch} />;
    const c = data!.accountSummary;
    return (
      <section className="panel bal-card" aria-label="Account summary">
        <div className="bal-main">
          <div className="t2 sm">{title}</div>
          <div className="bal-v num"><Private width={8}>₹{inr(c.available)}</Private></div>
          <div className="bal-meta t3 sm">
            <span>Open P&L <span className={`num w6 ${tone(c.unrealizedPnl)}`}>{inr(c.unrealizedPnl, { sign: true })}</span></span>
            <span>Booked <span className={`num w6 ${tone(c.realizedPnl)}`}>{inr(c.realizedPnl, { sign: true })}</span></span>
            <span>Margin <span className="num"><Private>₹{inr(c.marginUsed)}</Private></span></span>
          </div>
          {detail && (
            <div className="bal-meta t3 sm">
              <span>Ledger balance <span className="num w6"><Private>₹{inr(c.balance)}</Private></span></span>
              {showFees && <span>Brokerage paid <span className="num">₹{inr(c.fees)}</span></span>}
              <span>Positions <span className="num w6">{c.openPositions}</span></span>
              <span>Open orders <span className="num w6">{c.openOrders}</span></span>
            </div>
          )}
        </div>
        {actions && (
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={() => setPay('WITHDRAWAL')}>Withdraw</button>
            <button className="btn btn-sm btn-primary" onClick={() => setPay('DEPOSIT')}><Icon name="plus" size={16} />Add funds</button>
          </div>
        )}
        {pay && <PaymentDialog type={pay} userId={userId} onClose={() => setPay(null)} onDone={refetch} available={c.available} />}
      </section>
    );
  }
  if (loading && !data) return <div className="stack"><div className="skeleton" style={{ width: 180, height: 14 }} /><div className="skeleton" style={{ width: 260, height: 36 }} /><div className="skeleton" style={{ height: 76, borderRadius: 12 }} /></div>;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  const s = data!.accountSummary;
  const today = tone(s.unrealizedPnl);
  return (
    <section className="stack" style={{ gap: 20 }} aria-label="Account summary">
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <div className="hero-value">
          <div className="k">{title}</div>
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
          ...(showFees ? [{ k: 'Brokerage paid', v: `₹${inr(s.fees)}` }] : []),
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
  const { settings, me } = useAuth();
  const sole = useSoleAdmin() && me?.role === 'SUPER_ADMIN';
  const min = type === 'DEPOSIT' ? Number(settings?.minDeposit ?? 50000) : 0;
  const minLabel = `₹${inr(String(min), { decimals: false })}`;
  const fmtOk = /^\d{1,12}(\.\d{1,2})?$/.test(amount) && Number(amount) > 0;
  const under = type === 'DEPOSIT' && fmtOk && Number(amount) < min;
  const over = type === 'WITHDRAWAL' && available !== undefined && fmtOk && Number(amount) > Number(available);
  const invalid = touched && (!fmtOk || over || under);
  return (
    <Dialog
      title={type === 'DEPOSIT' ? 'Add funds' : 'Withdraw funds'}
      sub={sole ? (type === 'DEPOSIT' ? `Added straight away. Minimum ${minLabel}.` : 'Withdrawn straight away.') : type === 'DEPOSIT' ? `A Super Admin reviews every request. Minimum ${minLabel}.` : 'A Super Admin reviews every request.'}
      onClose={onClose}
    >
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); setTouched(true);
        if (!fmtOk || over || under) return;
        const r = await m.run({ i: { type, amount, idempotencyKey: key, userId } }) as { requestPayment: { id: string } } | null;
        if (!r) return;
        // Only one Super Admin: post it now (asks for the authenticator code), no separate approval step.
        if (sole) {
          try { await gql(`mutation($id:ID!){ approvePayment(id:$id){ id } }`, { id: r.requestPayment.id }); toast(type === 'DEPOSIT' ? 'Funds added' : 'Withdrawal done'); }
          catch { toast('Request saved. Approve it on Transactions.'); }
        } else toast('Request sent for review');
        onDone?.(); onClose();
      }}>
        <div className="field">
          <label htmlFor="amt">Amount</label>
          <div className="input-icon">
            <span style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-2)' }}>₹</span>
            <input id="amt" className="input num" style={{ background: 'var(--bg)', borderColor: 'var(--line-2)', paddingLeft: 30, fontSize: 18, height: 48 }} inputMode="decimal" autoFocus value={amount} aria-invalid={invalid} aria-describedby="amt-h" onBlur={() => setTouched(true)} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" />
          </div>
          <span id="amt-h" className={invalid ? 'err' : 'hint'}>
            {invalid ? (over ? `You can withdraw up to ₹${inr(available)}` : under ? `Minimum to add is ${minLabel}` : 'Enter an amount with up to 2 decimals') : type === 'WITHDRAWAL' && available ? `Withdrawable now: ₹${inr(available)}` : type === 'DEPOSIT' ? `Minimum ${minLabel}` : 'Up to 2 decimal places'}
          </span>
        </div>
        {type === 'DEPOSIT' && (
          <div className="chips" aria-label="Quick amounts">
            {[min, min * 2, min * 4, min * 10].map(String).map((v) => <button type="button" key={v} className="chip" aria-pressed={amount === v} onClick={() => setAmount(v)}>+₹{inr(v, { decimals: false })}</button>)}
          </div>
        )}
        {type === 'DEPOSIT' && !sole && <DemoDepositDetails />}
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
const WL_Q = `query($l:Int!){ watchlist(listIndex:$l){ id instrument{ id symbol name exchange segment expiry lotSize tickSize lotClass lotLabel category } quote{ ${QUOTE_FIELDS} } } }`;
const CAT_COUNTS_Q = `query { instrumentCategoryCounts { category count } }`;

const CAT_LABELS: Record<string, string> = {
  FUTURES: 'Futures',
  MCX: 'MCX',
  OPTIONS: 'Options',
  FOREX: 'Forex',
  CRYPTO: 'Crypto',
  US_STOCK: 'US Stock',
  COMEX: 'COMEX',
  US_INDEX: 'US Index',
};

function groupByCategory<T extends { instrument: Instrument }>(items: T[]) {
  const order: CategoryV[] = ['FUTURES', 'MCX', 'OPTIONS', 'FOREX', 'CRYPTO', 'US_STOCK', 'COMEX', 'US_INDEX'];
  const groups: { category: string; label: string; items: T[] }[] = [];
  const map = new Map<string, T[]>();
  for (const item of items) {
    const cat = item.instrument.category || 'FUTURES';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(item);
  }
  for (const c of order) {
    if (map.has(c)) {
      groups.push({ category: c, label: CAT_LABELS[c] || c, items: map.get(c)! });
      map.delete(c);
    }
  }
  for (const [c, rem] of map.entries()) {
    groups.push({ category: c, label: CAT_LABELS[c] || c, items: rem });
  }
  return groups;
}

/** The watchlist: one list, with a search bar on top that finds instruments and adds them in place. */
/**
 * mode "list" (dashboard / Watchlist page): the trader's scripts with an "Add script" button.
 * mode "add" (/trader/add-script): full-page search with market filters; add or remove scripts.
 */
export function Watchlist({ compact, mode = 'list' }: { compact?: boolean; mode?: 'list' | 'add' }) {
  const { prefs } = usePrefs();
  const { data, loading, error, refetch } = useQuery<{ watchlist: WEntry[] }>(WL_Q, { l: 0 });
  const { data: countsData } = useQuery<{ instrumentCategoryCounts: { category: string; count: number }[] }>(CAT_COUNTS_Q);
  const entries = data?.watchlist ?? [];
  const live = useLiveQuotes(entries.map((e) => e.instrument.id));
  const toast = useToast();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<CategoryV>('');
  const [lot, setLot] = useState<'' | 'MINI' | 'MEGA'>('');
  const [hits, setHits] = useState<Instrument[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const adding = mode === 'add';
  const searching = adding || q.trim().length > 0 || !!cat;

  const categoryCounts = useMemo(() => {
    const map: Record<string, number> = {};
    let total = 0;
    for (const c of countsData?.instrumentCategoryCounts ?? []) {
      map[c.category] = c.count;
      total += c.count;
    }
    map[''] = total;
    return map;
  }, [countsData]);

  useEffect(() => {
    if (!searching) { setHits(null); return; }
    setHits(null);
    const t = setTimeout(() => gql<{ searchInstruments: Instrument[] }>(
      `query($q:String!,$c:String,$l:String){ searchInstruments(query:$q, category:$c, lotClass:$l, limit:500){ id symbol name exchange segment expiry lotClass lotLabel category lotSize tickSize quote{ ${QUOTE_FIELDS} } } }`,
      { q: q.trim(), c: cat || undefined, l: cat === 'MCX' && lot ? lot : undefined }
    )
      .then((d) => setHits(d.searchInstruments)).catch(() => setHits([])), 200);
    return () => clearTimeout(t);
  }, [q, cat, lot, searching]);

  const hitQuotes = useLiveQuotes(hits?.map((h) => h.id) ?? []);
  const inList = new Set(entries.map((e) => e.instrument.id));

  const add = async (i: Instrument) => {
    setBusy(i.id);
    try {
      await gql(`mutation($l:Int!,$i:ID!){ addToWatchlist(listIndex:$l, instrumentId:$i) }`, { l: 0, i: i.id });
      toast(`${fullName(i)} added`);
      await refetch();
    } catch (x) {
      toast((x as Error).message, true);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (instId: string, sym: string) => {
    try {
      await gql(`mutation($l:Int!,$i:ID!){ removeFromWatchlist(listIndex:$l, instrumentId:$i) }`, { l: 0, i: instId });
      toast(`${fullName({ symbol: sym })} removed`);
      void refetch();
    } catch (x) {
      toast((x as Error).message, true);
    }
  };

  const hitEntries: WEntry[] = useMemo(() => {
    return (hits ?? []).map((h) => ({ id: h.id, instrument: h, quote: h.quote }));
  }, [hits]);

  const displayedGroups = useMemo(() => {
    if (searching) {
      return groupByCategory(hitEntries);
    }
    return groupByCategory(entries);
  }, [searching, hitEntries, entries]);

  const totalDisplayed = searching ? (hits?.length ?? 0) : entries.length;

  return (
    <section className="panel wl" aria-label={adding ? 'Add script' : 'Watchlist'}>
      {!adding && (
        <div className="wl-head">
          <span className="w6">Watchlist <span className="t3 sm num">{entries.length}/50</span></span>
          <Link className={`btn btn-sm btn-primary${entries.length >= 50 ? ' disabled' : ''}`} aria-disabled={entries.length >= 50} href="/trader/add-script"><Icon name="plus" size={16} />Add script</Link>
        </div>
      )}
      {adding && <>
      <div className="wl-search">
        <div className="input-icon grow">
          <Icon name="search" size={18} />
          <input
            className="input"
            type="search"
            placeholder="Search and add, e.g. NIFTY, RELIANCE, BTCUSD"
            aria-label="Search instruments to add to your watchlist"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}
          />
        </div>
        {(q || cat) && <button className="btn btn-sm btn-ghost" onClick={() => { setQ(''); setCat(''); setLot(''); }}>Clear</button>}
        <span className="t3 sm num" style={{ whiteSpace: 'nowrap' }}>{entries.length}/50 added</span>
      </div>
      {!compact && (
        <div className="wl-cats">
          <div className="chips" role="group" aria-label="Market">
            {CATEGORIES.map((c) => {
              const count = categoryCounts[c.v];
              const countStr = count !== undefined ? ` (${count})` : '';
              return (
                <button
                  key={c.v}
                  className="chip"
                  aria-pressed={cat === c.v}
                  onClick={() => { setCat(c.v); setLot(''); }}
                >
                  {c.label}{countStr}
                </button>
              );
            })}
          </div>
          {cat === 'MCX' && (
            <div className="chips" role="group" aria-label="Lot type">
              {([['', 'All lots'], ['MINI', 'Mini'], ['MEGA', 'Mega']] as const).map(([v, l]) => (
                <button key={v} className="chip" aria-pressed={lot === v} onClick={() => setLot(v)}>{l}</button>
              ))}
            </div>
          )}
        </div>
      )}
      </>}
      {searching ? (
        hits === null ? <SkeletonRows rows={4} pad /> : !hits.length ? (
          <Empty icon="search" title={q.trim() ? `Nothing matches “${q.trim()}”` : 'Nothing listed here yet'}>
            {q.trim() ? 'Try another symbol or clear search filters.' : 'Instruments appear here once they are loaded.'}
          </Empty>
        ) : compact ? (
          <div className="list list-pad">
            {hits.map((i) => (
              <CompactRow
                key={i.id}
                e={{ id: i.id, instrument: i }}
                q={hitQuotes[i.id] ?? i.quote}
                inList={inList.has(i.id)}
                isBusy={busy === i.id}
                onToggle={() => (inList.has(i.id) ? void remove(i.id, i.symbol) : void add(i))}
              />
            ))}
          </div>
        ) : (
          <>
            <div className="list list-pad only-mob">
              {displayedGroups.map((g) => (
                <div key={g.category}>
                  <div className="spread" style={{ padding: '8px 12px', background: 'var(--bg-2)', fontWeight: 600, fontSize: 13, textTransform: 'uppercase' }}>
                    <span>{g.label}</span>
                    <span className="badge">{g.items.length}</span>
                  </div>
                  {g.items.map((it) => (
                    <CompactRow
                      key={it.instrument.id}
                      e={it}
                      q={hitQuotes[it.instrument.id] ?? it.quote ?? it.instrument.quote}
                      withBidAsk={prefs.watchlistView === 'detailed'}
                      inList={inList.has(it.instrument.id)}
                      isBusy={busy === it.instrument.id}
                      onToggle={() => (inList.has(it.instrument.id) ? void remove(it.instrument.id, it.instrument.symbol) : void add(it.instrument))}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div className="table-wrap only-desk">
              <table className="t">
                <thead>
                  <tr>
                    <th>Instrument ({totalDisplayed})</th>
                    <th className="r">LTP</th>
                    <th className="r">Chg %</th>
                    <th className="hide-sm">Expiry</th>
                    <th className="r hide-sm">Time</th>
                    <th className="r">Bid · Ask <span className="t3 xs">(Low · High)</span></th>
                    <th className="r">Watchlist</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedGroups.map((g) => (
                    <Fragment key={g.category}>
                      <tr className="cat-group-row">
                        <th colSpan={7}>
                          <div className="cat-group-head">
                            <span>{g.label}</span>
                            <span className="badge">{g.items.length}</span>
                          </div>
                        </th>
                      </tr>
                      {g.items.map((it) => (
                        <FullRow
                          key={it.instrument.id}
                          e={it}
                          q={hitQuotes[it.instrument.id] ?? it.quote ?? it.instrument.quote}
                          inList={inList.has(it.instrument.id)}
                          isBusy={busy === it.instrument.id}
                          onToggle={() => (inList.has(it.instrument.id) ? void remove(it.instrument.id, it.instrument.symbol) : void add(it.instrument))}
                        />
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : loading && !data ? <SkeletonRows rows={6} pad /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !entries.length ? (
        <Empty icon="eye" title="Your watchlist is empty" action={<Link className="btn btn-sm btn-primary" href="/trader/add-script"><Icon name="plus" size={16} />Add script</Link>}>Add the scripts you follow and they show up here.</Empty>
      ) : compact ? (
        <div className="list list-pad">
          {entries.map((e) => (
            <CompactRow
              key={e.id}
              e={e}
              q={live[e.instrument.id] ?? e.quote ?? e.instrument.quote}
              inList
              onToggle={() => void remove(e.instrument.id, e.instrument.symbol)}
            />
          ))}
        </div>
      ) : (
        <>
          <div className="list list-pad only-mob">
            {displayedGroups.map((g) => (
              <div key={g.category}>
                <div className="spread" style={{ padding: '8px 12px', background: 'var(--bg-2)', fontWeight: 600, fontSize: 13, textTransform: 'uppercase' }}>
                  <span>{g.label}</span>
                  <span className="badge">{g.items.length}</span>
                </div>
                {g.items.map((e) => (
                  <CompactRow
                    key={e.id}
                    e={e}
                    q={live[e.instrument.id] ?? e.quote ?? e.instrument.quote}
                    withBidAsk={prefs.watchlistView === 'detailed'}
                    inList
                    onToggle={() => void remove(e.instrument.id, e.instrument.symbol)}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="table-wrap only-desk">
            <table className="t">
              <thead>
                <tr>
                  <th>Instrument ({totalDisplayed})</th>
                  <th className="r">LTP</th>
                  <th className="r">Chg %</th>
                  <th className="hide-sm">Expiry</th>
                  <th className="r hide-sm">Time</th>
                  <th className="r">Bid · Ask <span className="t3 xs">(Low · High)</span></th>
                  <th className="r"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {displayedGroups.map((g) => (
                  <Fragment key={g.category}>
                    <tr className="cat-group-row">
                      <th colSpan={7}>
                        <div className="cat-group-head">
                          <span>{g.label}</span>
                          <span className="badge">{g.items.length}</span>
                        </div>
                      </th>
                    </tr>
                    {g.items.map((e) => (
                      <FullRow
                        key={e.id}
                        e={e}
                        q={live[e.instrument.id] ?? e.quote ?? e.instrument.quote}
                        inList
                        onRemove={() => void remove(e.instrument.id, e.instrument.symbol)}
                      />
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function CompactRow({
  e,
  q,
  withBidAsk,
  inList = true,
  isBusy,
  onToggle,
}: {
  e: { id: string; instrument: Instrument };
  q?: Quote;
  withBidAsk?: boolean;
  inList?: boolean;
  isBusy?: boolean;
  onToggle?: () => void;
}) {
  const tick = useTick(q?.ltp);
  const href = `/trader/instrument/${e.instrument.id}`;
  const name = fullName(e.instrument);
  return (
    <div className={`list-row ${tick}`} style={{ position: 'relative' }}>
      {withBidAsk ? (
        <Link href={href} className="grow wl-left" style={{ minWidth: 0 }}>
          <div className="one-line w6">{name}</div>
          <div className="one-line t3 xs">{shortSymbol(e.instrument.symbol)} · {e.instrument.category === 'FOREX' ? 'Forex' : e.instrument.exchange}</div>
          <div className="row" style={{ gap: 6 }}>
            <span className="num w6">{curSign(e.instrument)}{inr(q?.ltp)}</span>
            <ChgPct q={q} />
          </div>
          <div className="one-line t3 xs">{e.instrument.expiry ? `${new Date(e.instrument.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} · ` : ''}{quoteTime(q?.ts)}</div>
        </Link>
      ) : (
        <Link href={href} className="grow" style={{ minWidth: 0 }}>
          <div className="w6">{name}</div>
          <div className="t3">{shortSymbol(e.instrument.symbol)} · {e.instrument.category === 'FOREX' ? 'Forex' : e.instrument.exchange} · {e.instrument.segment}</div>
        </Link>
      )}
      {!withBidAsk && (
        <div className="quote-cell">
          <Link href={href} className="num w6">{curSign(e.instrument)}{inr(q?.ltp)}</Link>
          <Change value={q?.change} pct={q?.changePct} size="sm" />
        </div>
      )}
      {withBidAsk && (
        <BidAskBoxes href={href} q={q} label={name} />
      )}
      {!inList && onToggle && (
        <button className="icon-btn wl-add" disabled={isBusy} onClick={onToggle} aria-label={`Add ${name} to watchlist`} title="Add to watchlist">
          <Icon name="plus" size={18} />
        </button>
      )}
    </div>
  );
}

function FullRow({
  e,
  q,
  inList = true,
  isBusy,
  onToggle,
  onRemove,
}: {
  e: { id: string; instrument: Instrument };
  q?: Quote;
  inList?: boolean;
  isBusy?: boolean;
  onToggle?: () => void;
  onRemove?: () => void;
}) {
  const tick = useTick(q?.ltp);
  const href = `/trader/instrument/${e.instrument.id}`;
  const action = onToggle ?? onRemove;
  const name = fullName(e.instrument);
  return (
    <tr className={tick}>
      <td>
        <Link href={href} className="row" style={{ flexWrap: 'nowrap' }}>
          <Mark text={name} />
          <span>
            <div className="w6 row" style={{ gap: 6, alignItems: 'center' }}>
              <span>{name}</span>
              <LotTag i={e.instrument} />
            </div>
            <span className="sub" style={{ display: 'block', marginTop: 2 }}>
              <span style={{ fontWeight: 500, color: 'var(--text-2)' }}>{shortSymbol(e.instrument.symbol)}</span>
              {' · '}
              {e.instrument.category === 'FOREX' ? 'Forex' : e.instrument.exchange} · {e.instrument.segment}
            </span>
          </span>
        </Link>
      </td>
      <td className="r"><span className="num w6">{curSign(e.instrument)}{inr(q?.ltp)}</span></td>
      <td className="r"><ChgPct q={q} /></td>
      <td className="t2 sm hide-sm" style={{ whiteSpace: 'nowrap' }}>{expiryText(e.instrument.expiry)}</td>
      <td className="r num t2 sm hide-sm">{quoteTime(q?.ts)}</td>
      <td className="r"><BidAskBoxes href={href} q={q} label={e.instrument.symbol} /></td>
      <td className="r">
        {inList ? (
          <button className="icon-btn" aria-label={`Remove ${e.instrument.symbol}`} onClick={action} title="Remove from watchlist">
            <Icon name="x" size={18} />
          </button>
        ) : (
          <button className="btn btn-sm" disabled={isBusy} onClick={action} aria-label={`Add ${name} to watchlist`}>
            <Icon name="plus" size={16} />Add
          </button>
        )}
      </td>
    </tr>
  );
}

/* ======================================================================= market movers (explore) */
export function Movers() {
  const { data, loading, error, refetch } = useQuery<{ searchInstruments: Instrument[] }>(`{ searchInstruments(query:"", limit:50){ id symbol name exchange segment quote{ ${QUOTE_FIELDS} } } }`);
  const list = data?.searchInstruments ?? [];
  const liveQuotes = useLiveQuotes(list.map((i) => i.id));
  const [tab, setTab] = useState<'gainers' | 'losers'>('gainers');
  const getQ = (i: Instrument) => liveQuotes[i.id] ?? i.quote;
  const sorted = list
    .filter((i) => getQ(i))
    .sort((a, b) => (Number(getQ(b)?.changePct ?? 0) - Number(getQ(a)?.changePct ?? 0)) * (tab === 'gainers' ? 1 : -1))
    .filter((i) => (tab === 'gainers' ? Number(getQ(i)?.changePct ?? 0) >= 0 : Number(getQ(i)?.changePct ?? 0) < 0))
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
            const q = getQ(i)!;
            const name = fullName(i);
            return (
              <Link key={i.id} href={`/trader/instrument/${i.id}`} className="tile">
                <Mark text={name} />
                <div className="w6" style={{ marginTop: 'auto' }}>{name}</div>
                <div className="t3 xs">{shortSymbol(i.symbol)}</div>
                <div>
                  <div className="num w6">{curSign(i)}{inr(q.ltp)}</div>
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
export interface Order { id: string; side: 'BUY' | 'SELL'; type: string; quantity: number; limitPrice?: string; triggerPrice?: string; triggeredAt?: string; fillPrice?: string; status: string; venue: string; rejectReason?: string; createdAt: string; filledAt?: string; instrument?: { symbol: string; name?: string } }
export const ORDER_FIELDS = 'id side type quantity limitPrice triggerPrice triggeredAt fillPrice status venue rejectReason createdAt filledAt instrument{ symbol name }';

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
            <div className="w6">{o.instrument ? fullName(o.instrument) : '—'}</div>
            <div className="t3 xs">{o.instrument ? shortSymbol(o.instrument.symbol) : ''}</div>
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
                <span className="w6">{o.instrument ? fullName(o.instrument) : '—'}</span>
                <span className="sub" style={{ display: 'block' }}>{o.instrument ? shortSymbol(o.instrument.symbol) : ''} · <span className={o.side === 'BUY' ? 'pos' : 'neg'} style={{ fontWeight: 600 }}>{o.side === 'BUY' ? 'Buy' : 'Sell'}</span></span>
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
        <Confirm title="Cancel this order?" lines={[['Instrument', fullName(cancel.instrument)], ['Side', cancel.side === 'BUY' ? 'Buy' : 'Sell'], ['Quantity', cancel.quantity], [cancel.triggerPrice ? 'Trigger' : 'Limit price', `₹${inr(cancel.limitPrice ?? cancel.triggerPrice)}`]]}
          confirmLabel="Cancel order" tone="danger" pending={m.pending} error={m.error} onClose={() => setCancel(null)}
          onConfirm={async () => { if (await m.run({ id: cancel.id })) { toast('Order cancelled'); setCancel(null); void refetch(); } }} />
      )}
    </div>
    </>
  );
}

/* ======================================================================= positions */
interface Position { id: string; instrumentId: string; netQty: number; avgPrice: string; realizedPnl: string; unrealizedPnl?: string; ltp?: string; instrument?: { symbol: string; name?: string } }
export function PositionsTable({ userId, canTrade }: { userId?: string; canTrade?: boolean }) {
  const { data, loading, error, refetch } = useQuery<{ positions: Position[] }>(`query($u:ID){ positions(userId:$u){ id instrumentId netQty avgPrice realizedPnl unrealizedPnl ltp instrument{ symbol name } } }`, { u: userId }, { pollMs: 3000 });
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
              <div className="w6">{p.instrument ? fullName(p.instrument) : '—'}</div>
              <div className="t3 xs">{p.instrument ? shortSymbol(p.instrument.symbol) : ''}</div>
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
                <td>
                  <span className="w6">{p.instrument ? fullName(p.instrument) : '—'}</span>
                  <span className="sub" style={{ display: 'block' }}>{p.instrument ? shortSymbol(p.instrument.symbol) : ''} · {p.netQty > 0 ? 'Long' : p.netQty < 0 ? 'Short' : 'Closed'}</span>
                </td>
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
  const hideFees = useAuth().me?.role === 'TRADER'; // brokerage lines are not shown to traders
  if (loading && !data) return <SkeletonRows />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  const lines = hideFees ? data!.ledgerHistory.filter((l) => l.kind !== 'FEE') : data!.ledgerHistory;
  if (!lines.length) return <Empty icon="file" title="No transactions yet">Trades, charges and fund movements appear here.</Empty>;
  return (
    <div className="list list-pad">
      {lines.map((l) => (
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
