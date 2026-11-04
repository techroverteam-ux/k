'use client';
import { useMemo, useState } from 'react';
import { Icon } from '@/components/icons';
import { Chips, Empty, ErrorState, PageHead, SkeletonRows, useToast } from '@/components/ui';
import { gql } from '@/lib/api';
import { inr } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

interface Inst { id: string; symbol: string; name: string; exchange: string; lotSize: number; lotClass: 'MINI' | 'MEGA'; lotLabel?: string; category: string; expiry?: string }
type F = '' | 'MINI' | 'MEGA';

/** Super Admin: which instruments are mini lots and which are mega lots (brokerage and broker earning follow). */
export default function Lots() {
  const list = useQuery<{ allInstruments: Inst[] }>(`{ allInstruments { id symbol name exchange lotSize lotClass lotLabel category expiry } }`);
  const rules = useQuery<{ tradingRules: { brokeragePerLot: string; brokeragePerMegaLot: string } }>(`{ tradingRules { brokeragePerLot brokeragePerMegaLot } }`);
  const [f, setF] = useState<F>('');
  const [ex, setEx] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const all = list.data?.allInstruments ?? [];
  const rows = useMemo(() => all.filter((i) => (!f || i.lotClass === f) && (!ex || i.category === ex) && (!q || `${i.symbol} ${i.name}`.toLowerCase().includes(q.toLowerCase()))), [all, f, ex, q]);
  const exchanges = ['MCX', 'FOREX', 'NSE', 'INDICES'].filter((c) => all.some((i) => i.category === c));
  const CAT: Record<string, string> = { MCX: 'MCX', FOREX: 'Forex', NSE: 'NSE', INDICES: 'Indices' };
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
      <PageHead title="Mini & mega lots" sub={r ? `Set what one lot is (shown to traders) and whether it is a mini or mega lot. Brokerage per lot, charged when a trade is opened and again when it is cut: mini ₹${inr(r.brokeragePerLot)}, mega ₹${inr(r.brokeragePerMegaLot)}. Brokers earn their per-lot amount on each.` : 'Choose which instruments are mini and which are mega lots.'} />
      <div className="spread" style={{ marginBottom: 12 }}>
        <div className="input-icon" style={{ width: 'min(280px, 100%)' }}><Icon name="search" size={18} /><input className="input" placeholder="Search symbol" aria-label="Search instruments" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="row" style={{ gap: 8 }}>
          <Chips label="Lot type" value={f} onChange={setF} items={[{ v: '', label: `All (${all.length})` }, { v: 'MINI', label: `Mini (${all.filter((i) => i.lotClass === 'MINI').length})` }, { v: 'MEGA', label: `Mega (${all.filter((i) => i.lotClass === 'MEGA').length})` }]} />
          <Chips label="Market" value={ex} onChange={setEx} items={[{ v: '', label: 'Any market' }, ...exchanges.map((e) => ({ v: e, label: CAT[e] }))]} />
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
                <th>Instrument</th><th>Market</th><th>One lot is</th><th className="r">Lot type</th>
              </tr></thead>
              <tbody>{rows.map((i) => (
                <tr key={i.id}>
                  <td className="hide-sm"><input type="checkbox" aria-label={`Select ${i.symbol}`} checked={sel.has(i.id)} onChange={() => { const n = new Set(sel); if (n.has(i.id)) n.delete(i.id); else n.add(i.id); setSel(n); }} /></td>
                  <td className="lead"><span className="w6" style={{ display: 'block' }}>{i.symbol}</span><span className="t3 sm">{i.name}</span></td>
                  <td data-label="Market" className="t2">{CAT[i.category] ?? i.exchange}{i.expiry ? <span className="sub" style={{ display: 'block' }}>{new Date(i.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })}</span> : null}</td>
                  <td data-label="One lot is"><LabelEdit i={i} onSaved={() => void list.refetch()} /></td>
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

/** Inline edit of "what one lot is" (e.g. 100 g). Saves when you leave the field or press Enter. */
function LabelEdit({ i, onSaved }: { i: Inst; onSaved: () => void }) {
  const [v, setV] = useState(i.lotLabel ?? '');
  const [state, setState] = useState<'' | 'saving' | 'saved' | 'error'>('');
  const save = async () => {
    if (v.trim() === (i.lotLabel ?? '')) return;
    setState('saving');
    try { await gql(`mutation($i:ID!,$l:String!){ setInstrumentLotLabel(instrumentId:$i, lotLabel:$l){ id } }`, { i: i.id, l: v.trim() }); setState('saved'); onSaved(); }
    catch { setState('error'); }
  };
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <input className="input input-sm" style={{ width: 130 }} maxLength={40} placeholder={`e.g. 100 g`} aria-label={`What one lot of ${i.symbol} is`} value={v}
        onChange={(e) => { setV(e.target.value); setState(''); }} onBlur={() => void save()} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      {state === 'saved' && <Icon name="check" size={16} />}
      {state === 'error' && <span className="err xs">Not saved</span>}
    </span>
  );
}
