'use client';
import { useMemo, useState } from 'react';
import { Empty, ErrorState, Metrics, PageHead, SkeletonRows } from '@/components/ui';
import { inr } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

export default function Commissions() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const range = useMemo(() => { const [y, m] = month.split('-').map(Number); return { f: new Date(y, m - 1, 1).toISOString(), t: new Date(y, m, 1).toISOString() }; }, [month]);
  const { data, loading, error, refetch } = useQuery<{ commissionReport: { shareBps: number; total: string; lines: { userId: string; username: string; brokerage: string; commission: string }[] } }>(
    `query($f:DateTime!,$t:DateTime!){ commissionReport(from:$f,to:$t){ shareBps total lines{ userId username brokerage commission } } }`, range);
  const r = data?.commissionReport;
  const brokerage = r?.lines.reduce((a, l) => a + Number(l.brokerage), 0).toFixed(2);
  return (
    <div className="stack" style={{ gap: 32 }}>
      <PageHead title="Commissions" sub="Your share of brokerage from assigned traders. These figures are simulated.">
        <input type="month" className="input" style={{ width: 180 }} aria-label="Month" value={month} max={new Date().toISOString().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
      </PageHead>
      {error && !data ? <ErrorState error={error} retry={refetch} /> : <>
        <Metrics items={[{ k: 'Your commission', v: r ? `₹${inr(r.total)}` : '…' }, { k: 'Brokerage from traders', v: r ? `₹${inr(brokerage)}` : '…' }, { k: 'Your share', v: r ? `${r.shareBps / 100}%` : '…' }]} />
        <section className="panel">
          {loading && !data ? <SkeletonRows /> : !r?.lines.length ? <Empty icon="percent" title="No brokerage this month">Commission appears once your traders’ orders are executed.</Empty> : (
            <table className="t resp">
              <thead><tr><th>Trader</th><th className="r">Brokerage</th><th className="r">Your commission</th></tr></thead>
              <tbody>{r.lines.map((l) => <tr key={l.userId}><td className="lead w6">{l.username}</td><td className="r num" data-label="Brokerage">₹{inr(l.brokerage)}</td><td className="r num w6" data-label="Your commission">₹{inr(l.commission)}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      </>}
    </div>
  );
}
