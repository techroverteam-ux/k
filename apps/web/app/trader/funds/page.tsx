'use client';
import { useMemo, useState } from 'react';
import { LedgerTable, PAYMENT_FIELDS, PortfolioSummary, type Payment } from '@/components/trading';
import { Chips, Empty, ErrorState, Metrics, SectionHead, SkeletonRows, Status, Tabs, useToast } from '@/components/ui';
import { gql } from '@/lib/api';
import { Statement } from '@/components/statement';
import { inr, tone, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

const PERIODS = { today: 'Today', week: 'This week', month: 'This month', custom: 'Custom' } as const;
type P = keyof typeof PERIODS;
/** Local calendar date as YYYY-MM-DD. */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function range(p: P, cf: string, ct: string) {
  if (p === 'custom') return { f: new Date(`${cf}T00:00:00`).toISOString(), t: new Date(new Date(`${ct}T00:00:00`).getTime() + 86_400_000).toISOString() };
  const from = new Date(); from.setHours(0, 0, 0, 0);
  if (p === 'week') from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
  if (p === 'month') from.setDate(1);
  return { f: from.toISOString(), t: new Date(Date.now() + 60_000).toISOString() };
}

export default function Funds() {
  const [p, setP] = useState<P>('today');
  const [tab, setTab] = useState<'ledger' | 'requests'>('ledger');
  const today = ymd(new Date());
  const [cf, setCf] = useState(() => ymd(new Date(Date.now() - 6 * 86_400_000)));
  const [ct, setCt] = useState(today);
  const badRange = p === 'custom' && (!cf || !ct || cf > ct);
  const r = useMemo(() => range(p, cf, ct), [p, cf, ct]);
  const sum = useQuery<{ periodSummary: { realizedPnl: string; brokerage: string; trades: number; volume: string } }>(`query($f:DateTime!,$t:DateTime!){ periodSummary(from:$f,to:$t){ realizedPnl brokerage trades volume } }`, r, { skip: badRange });
  const s = sum.data?.periodSummary;
  return (
    <div className="stack" style={{ gap: 40 }}>
      <PortfolioSummary actions title="Available balance" />
      <section className="section">
        <SectionHead title="Profit & loss"><Chips label="Period" value={p} onChange={setP} items={(Object.keys(PERIODS) as P[]).map((k) => ({ v: k, label: PERIODS[k] }))} /></SectionHead>
        {p === 'custom' && (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field"><label htmlFor="cf">From</label><input id="cf" type="date" className="input" max={ct || today} value={cf} onChange={(e) => setCf(e.target.value)} /></div>
            <div className="field"><label htmlFor="ct">To</label><input id="ct" type="date" className="input" min={cf} max={today} value={ct} onChange={(e) => setCt(e.target.value)} /></div>
            {badRange && <span className="err">The start date must be on or before the end date.</span>}
          </div>
        )}
        {sum.error && !s ? <ErrorState error={sum.error} retry={sum.refetch} /> : (
          <Metrics items={[
            { k: 'Realised P&L', v: s ? inr(s.realizedPnl, { sign: true }) : '…', tone: tone(s?.realizedPnl) },
            { k: 'Brokerage', v: s ? `₹${inr(s.brokerage)}` : '…' },
            { k: 'Trades', v: s?.trades ?? '…' },
            { k: 'Turnover', v: s ? `₹${inr(s.volume, { decimals: false })}` : '…' },
          ]} />
        )}
      </section>
      <Statement />
      <section className="section">
        <Tabs label="History" value={tab} onChange={setTab} items={[{ v: 'ledger', label: 'Transactions' }, { v: 'requests', label: 'Fund requests' }]} />
        {tab === 'ledger' ? <LedgerTable /> : <Requests />}
      </section>
    </div>
  );
}

function Requests() {
  const { data, loading, error, refetch } = useQuery<{ paymentRequests: Payment[] }>(`{ paymentRequests(limit:50){ ${PAYMENT_FIELDS} } }`, undefined, { pollMs: 10_000 });
  const toast = useToast();
  if (loading && !data) return <SkeletonRows />;
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  if (!data!.paymentRequests.length) return <Empty icon="wallet" title="No fund requests">Use “Add funds” or “Withdraw” above.</Empty>;
  return (
    <div className="list list-pad">
      {data!.paymentRequests.map((x) => (
        <div key={x.id} className="list-row">
          <div className="grow">
            <div className="w5">{x.type === 'DEPOSIT' ? 'Add funds' : 'Withdraw'} <span className="badge info" style={{ marginLeft: 4 }}>Virtual</span></div>
            <div className="t3">{when(x.createdAt)}{x.reviewNote ? ` · ${x.reviewNote}` : ''}</div>
          </div>
          <div className="quote-cell" style={{ gap: 4 }}>
            <span className="num w6">₹{inr(x.amount)}</span>
            <Status value={x.status} />
          </div>
          {x.status === 'REQUESTED' && <button className="btn btn-sm" onClick={async () => { try { await gql(`mutation($id:ID!){ cancelPayment(id:$id){ id } }`, { id: x.id }); toast('Request cancelled'); void refetch(); } catch (e) { toast((e as Error).message, true); } }}>Cancel</button>}
        </div>
      ))}
    </div>
  );
}

