'use client';
import { useState } from 'react';
import { API_URL, gql } from '@/lib/api';
import { Icon } from './icons';
import { Chips, SectionHead, useToast } from './ui';

/** Local calendar date as YYYY-MM-DD. */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const STMT = { week: 'This week', lastWeek: 'Last week', month: 'This month', lastMonth: 'Last month', custom: 'Custom dates' } as const;
type SP = keyof typeof STMT;
function stmtRange(p: SP, cf: string, ct: string): [string, string] {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (p === 'week') return [ymd(monday), ymd(d)];
  if (p === 'lastWeek') { const s = new Date(monday); s.setDate(s.getDate() - 7); const e = new Date(monday); e.setDate(e.getDate() - 1); return [ymd(s), ymd(e)]; }
  if (p === 'month') return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), ymd(d)];
  if (p === 'lastMonth') return [ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), ymd(new Date(d.getFullYear(), d.getMonth(), 0))];
  return [cf, ct];
}

/** Bill download: a PDF statement for a week or custom dates (opening/closing balance, ledger, fills). */
export function Statement({ userId }: { userId?: string }) {
  const [p, setP] = useState<SP>('week');
  const today = ymd(new Date());
  const [cf, setCf] = useState(() => ymd(new Date(Date.now() - 29 * 86_400_000)));
  const [ct, setCt] = useState(today);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [from, to] = stmtRange(p, cf, ct);
  const bad = !from || !to || from > to;
  const download = async () => {
    setBusy(true);
    try {
      const d = await gql<{ statementLink: { path: string; fileName: string } }>(`mutation($f:String!,$t:String!,$u:ID){ statementLink(from:$f, to:$t, userId:$u){ path fileName } }`, { f: from, t: to, u: userId });
      const a = document.createElement('a');
      a.href = API_URL + d.statementLink.path;
      a.download = d.statementLink.fileName;
      a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      toast('Statement downloading');
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <section className="section" id="statements">
      <SectionHead title="Bill download"><span className="t3 sm">PDF statement</span></SectionHead>
      <Chips label="Statement period" value={p} onChange={setP} items={(Object.keys(STMT) as SP[]).map((k) => ({ v: k, label: STMT[k] }))} />
      {p === 'custom' && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field"><label htmlFor="sf">From</label><input id="sf" type="date" className="input" max={ct || today} value={cf} onChange={(e) => setCf(e.target.value)} /></div>
          <div className="field"><label htmlFor="st">To</label><input id="st" type="date" className="input" min={cf} max={today} value={ct} onChange={(e) => setCt(e.target.value)} /></div>
        </div>
      )}
      <div className="spread">
        <span className="t2 sm">{bad ? 'Choose a start date on or before the end date.' : `${new Date(from).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} – ${new Date(to).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} · opening & closing balance, every transaction and trade`}</span>
        <button className="btn btn-primary" disabled={bad || busy} onClick={() => void download()}><Icon name="download" size={18} />{busy ? 'Preparing…' : 'Download PDF'}</button>
      </div>
    </section>
  );
}
