'use client';
import { useMemo, useState } from 'react';
import { gql } from '@/lib/api';
import { useToast } from '@/components/ui';
import { Empty, ErrorState, Metrics, PageHead, SkeletonRows } from '@/components/ui';
import { inr } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

export default function Commissions() {
  const [month, setMonth] = useState(() => new Date(Date.now() + 19_800_000).toISOString().slice(0, 7));
  const range = useMemo(() => { const [y, m] = month.split('-').map(Number); return { f: new Date(Date.UTC(y, m - 1, 1) - 19_800_000).toISOString(), t: new Date(Date.UTC(y, m, 1) - 19_800_000).toISOString() }; }, [month]);
  const { data, loading, error, refetch } = useQuery<{ commissionReport: { perMiniLot: string; perMegaLot: string; total: string; lines: { userId: string; username: string; miniLots: number; megaLots: number; commission: string }[] } }>(
    `query($f:DateTime!,$t:DateTime!){ commissionReport(from:$f,to:$t){ perMiniLot perMegaLot total lines{ userId username miniLots megaLots commission } } }`, range);
  const r = data?.commissionReport;
  const [downloading, setDownloading] = useState(false);
  const toast = useToast();
  const download = async (format: 'PDF' | 'XLSX') => {
    setDownloading(true);
    try {
      const { commissionDownload: file } = await gql<{ commissionDownload: { fileName: string; mimeType: string; base64: string } }>(`query($m:String!,$f:String!){ commissionDownload(month:$m,format:$f){ fileName mimeType base64 } }`, { m: month, f: format });
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0))], { type: file.mimeType }));
      const a = document.createElement('a'); a.href = url; a.download = file.fileName; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) { toast((e as Error).message, true); } finally { setDownloading(false); }
  };
  return (
    <div className="stack" style={{ gap: 32 }}>
      <PageHead title="Commissions" sub="You earn a fixed amount for every lot your traders open or cut.">
        <input type="month" className="input" style={{ width: 180 }} aria-label="Month" value={month} max={new Date(Date.now() + 19_800_000).toISOString().slice(0, 7)} onChange={(e) => { if (e.target.value) setMonth(e.target.value); }} />
        <button className="btn" disabled={downloading || !r} onClick={() => void download('PDF')}>Download PDF</button>
        <button className="btn" disabled={downloading || !r} onClick={() => void download('XLSX')}>Download Excel</button>
      </PageHead>
      {error && !data ? <ErrorState error={error} retry={refetch} /> : <>
        <Metrics items={[{ k: 'Your commission', v: r ? `₹${inr(r.total)}` : '…' }, { k: 'You earn per lot', v: r ? `₹${inr(r.perMiniLot)} mini · ₹${inr(r.perMegaLot)} mega` : '…' }]} />
        <section className="panel">
          {loading && !data ? <SkeletonRows /> : !r?.lines.length ? <Empty icon="percent" title="No commission this month">Commission appears once your traders’ orders are executed.</Empty> : (
            <table className="t resp">
              <thead><tr><th>Trader</th><th className="r">Mini lots</th><th className="r">Mega lots</th><th className="r">Your commission</th></tr></thead>
              <tbody>{r.lines.map((l) => <tr key={l.userId}><td className="lead w6">{l.username}</td><td className="r num" data-label="Mini lots">{l.miniLots}</td><td className="r num" data-label="Mega lots">{l.megaLots}</td><td className="r num w6" data-label="Your commission">₹{inr(l.commission)}</td></tr>)}</tbody>
            </table>
          )}
        </section>
      </>}
    </div>
  );
}
