'use client';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/icons';
import { Chips, Empty, ErrorState, PageHead, SkeletonRows, useToast } from '@/components/ui';
import { gql } from '@/lib/api';
import { inr } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

interface Inst { id: string; symbol: string; name: string; exchange: string; lotSize: number; lotClass: 'MINI' | 'MEGA' }
type F = '' | 'MINI' | 'MEGA';

/** Super Admin: which instruments are mini lots and which are mega lots (brokerage and broker earning follow). */
export default function Lots() {
  const list = useQuery<{ allInstruments: Inst[] }>(`{ allInstruments { id symbol name exchange lotSize lotClass } }`);
  const rules = useQuery<{ tradingRules: { brokeragePerLot: string; brokeragePerMegaLot: string } }>(`{ tradingRules { brokeragePerLot brokeragePerMegaLot } }`);
  const [f, setF] = useState<F>('');
  const [ex, setEx] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const all = list.data?.allInstruments ?? [];
  const rows = useMemo(() => all.filter((i) => (!f || i.lotClass === f) && (!ex || i.exchange === ex) && (!q || `${i.symbol} ${i.name}`.toLowerCase().includes(q.toLowerCase()))), [all, f, ex, q]);
  const exchanges = [...new Set(all.map((i) => i.exchange))];
  const r = rules.data?.tradingRules;
  const set = async (ids: string[], c: 'MINI' | 'MEGA') => {
    if (!ids.length) return;
    setBusy(true);
    try {
      await gql(`mutation($ids:[ID!]!,$c:String!){ setInstrumentLotClass(instrumentIds:$ids, lotClass:$c){ id } }`, { ids, c });
      toast(`${ids.length} instrument${ids.length === 1 ? '' : 's'} set to ${c === 'MINI' ? 'mini' : 'mega'}`);
      setSel(new Set());
      await list.refetch();
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const allSel = rows.length > 0 && rows.every((i) => sel.has(i.id));
  return (
    <>
      <PageHead title="Mini & mega lots" sub={r ? `Brokerage per lot, charged when a trade is opened and again when it is cut: mini ₹${inr(r.brokeragePerLot)}, mega ₹${inr(r.brokeragePerMegaLot)}. Brokers earn their per-lot amount on each.` : 'Choose which instruments are mini and which are mega lots.'} />
      <div className="spread" style={{ marginBottom: 12 }}>
        <div className="input-icon" style={{ width: 'min(280px, 100%)' }}><Icon name="search" size={18} /><input className="input" placeholder="Search symbol" aria-label="Search instruments" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="row" style={{ gap: 8 }}>
          <Chips label="Lot type" value={f} onChange={setF} items={[{ v: '', label: `All (${all.length})` }, { v: 'MINI', label: `Mini (${all.filter((i) => i.lotClass === 'MINI').length})` }, { v: 'MEGA', label: `Mega (${all.filter((i) => i.lotClass === 'MEGA').length})` }]} />
          <Chips label="Exchange" value={ex} onChange={setEx} items={[{ v: '', label: 'Any exchange' }, ...exchanges.map((e) => ({ v: e, label: e }))]} />
        </div>
      </div>
      {sel.size > 0 && (
        <div className="notice info" style={{ marginBottom: 12, alignItems: 'center' }}>
          <span className="grow">{sel.size} selected</span>
          <button className="btn btn-sm" disabled={busy} onClick={() => void set([...sel], 'MINI')}>Make mini</button>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void set([...sel], 'MEGA')}>Make mega</button>
        </div>
      )}
      <section className="panel">
        {list.loading && !list.data ? <SkeletonRows /> : list.error && !list.data ? <ErrorState error={list.error} retry={list.refetch} /> : !rows.length ? <Empty icon="search" title="No instruments match">Try another search or filter.</Empty> : (
          <div className="table-wrap">
            <table className="t resp">
              <thead><tr>
                <th style={{ width: 36 }}><input type="checkbox" aria-label="Select all shown" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(rows.map((i) => i.id)))} /></th>
                <th>Instrument</th><th>Exchange</th><th className="r">Lot size</th><th className="r">Lot type</th>
              </tr></thead>
              <tbody>{rows.map((i) => (
                <tr key={i.id}>
                  <td className="hide-sm"><input type="checkbox" aria-label={`Select ${i.symbol}`} checked={sel.has(i.id)} onChange={() => { const n = new Set(sel); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); setSel(n); }} /></td>
                  <td className="lead"><span className="w6" style={{ display: 'block' }}>{i.symbol}</span><span className="t3 sm">{i.name}</span></td>
                  <td data-label="Exchange" className="t2">{i.exchange}</td>
                  <td data-label="Lot size" className="r num">{i.lotSize}</td>
                  <td data-label="Lot type" className="r">
                    <div className="seg sm" role="group" aria-label={`Lot type for ${i.symbol}`}>
                      <button className={i.lotClass === 'MINI' ? 'on' : ''} aria-pressed={i.lotClass === 'MINI'} disabled={busy} onClick={() => i.lotClass !== 'MINI' && void set([i.id], 'MINI')}>Mini</button>
                      <button className={i.lotClass === 'MEGA' ? 'on' : ''} aria-pressed={i.lotClass === 'MEGA'} disabled={busy} onClick={() => i.lotClass !== 'MEGA' && void set([i.id], 'MEGA')}>Mega</button>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
