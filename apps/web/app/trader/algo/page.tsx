'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '@/components/icons';
import { Confirm, ErrorState, PageHead, SkeletonRows, useToast } from '@/components/ui';
import { gql } from '@/lib/api';
import { describe, INTERVALS, STRATEGY_FIELDS, TEMPLATES, type Rules, type Strategy } from '@/lib/algo';
import { inr, shortSymbol } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

const STATUS: Record<Strategy['status'], [string, string]> = { RUNNING: ['ok', 'Running'], STOPPED: ['', 'Stopped'], DRAFT: ['info', 'Draft'] };

/** Automated trading home: your strategies, their status today, templates, and the stop-all kill switch. */
export default function AlgoHome() {
  const q = useQuery<{ strategies: Strategy[] }>(`{ strategies { ${STRATEGY_FIELDS} } }`, undefined, { pollMs: 5000 });
  const toast = useToast();
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = q.data?.strategies ?? [];
  const running = list.filter((s) => s.status === 'RUNNING');

  const stopAll = async () => {
    setBusy(true);
    try {
      const d = await gql<{ stopAllStrategies: number }>(`mutation{ stopAllStrategies }`);
      toast(`Stopped ${d.stopAllStrategies} ${d.stopAllStrategies === 1 ? 'strategy' : 'strategies'} and closed their positions.`);
      setConfirmAll(false);
      void q.refetch();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Automated trading" sub="Build rules, test them on past candles, then let them trade the simulated feed for you.">
        {running.length > 0 && <button className="btn btn-sell" onClick={() => setConfirmAll(true)}><Icon name="alert" size={16} />Stop all ({running.length})</button>}
        <Link className="btn btn-primary" href="/trader/algo/new"><Icon name="plus" size={16} />New strategy</Link>
      </PageHead>

      {q.error && !q.data ? <ErrorState error={q.error} retry={q.refetch} /> : !q.data ? <SkeletonRows rows={4} /> : (
        <div className="stack" style={{ gap: 28 }}>
          {list.length > 0 && (
            <div className="table-wrap panel">
              <table className="t">
                <thead><tr><th>Strategy</th><th>Instrument</th><th>Timeframe</th><th>Status</th><th className="r">Position</th><th className="r">P&L today</th><th className="r">Orders today</th></tr></thead>
                <tbody>
                  {list.map((s) => {
                    const [cls, label] = STATUS[s.status];
                    const pnl = s.today?.pnl ?? '0.00';
                    return (
                      <tr key={s.id} className="clickable" onClick={() => { window.location.href = `/trader/algo/${s.id}`; }}>
                        <td><Link href={`/trader/algo/${s.id}`} className="w6" onClick={(e) => e.stopPropagation()}>{s.name}</Link><div className="t3 sm">v{s.version}{s.stopReason && s.status === 'STOPPED' ? ` · ${s.stopReason}` : ''}</div></td>
                        <td>{s.instrument ? shortSymbol(s.instrument.symbol) : '—'}</td>
                        <td>{INTERVALS.find((i) => i.v === s.interval)?.label}</td>
                        <td><span className={`badge ${cls}`}>{s.status === 'RUNNING' && <span className="live-dot" aria-hidden />}{label}</span></td>
                        <td className="r num">{s.position === 0 ? 'Flat' : `${s.position > 0 ? '+' : ''}${s.position}${s.entryPrice ? ` @ ₹${inr(s.entryPrice)}` : ''}`}</td>
                        <td className={`r num ${pnl.startsWith('-') ? 'neg' : pnl === '0.00' ? '' : 'pos'}`}>₹{inr(pnl)}</td>
                        <td className="r num">{s.today?.orders ?? 0} / {s.maxOrdersPerDay}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <section className="section">
            <h2>{list.length ? 'Start from a template' : 'Start with a ready-made strategy'}</h2>
            <div className="algo-templates">
              {TEMPLATES.map((t) => (
                <Link key={t.key} href={`/trader/algo/new?t=${t.key}`} className="panel algo-template">
                  <div className="w6">{t.name}</div>
                  <p className="t2 sm">{t.blurb}</p>
                  <p className="t3 sm">{describe(t.rules as Rules, 1, 'NIFTY')}</p>
                  <span className="t-brand sm w6">Use this template →</span>
                </Link>
              ))}
            </div>
          </section>

          <p className="t3 sm">Paper trading only: strategies place simulated orders on your virtual balance, with the same limits, margin and market-hours checks as your manual orders. Past results don’t predict future ones.</p>
        </div>
      )}

      {confirmAll && (
        <Confirm
          title="Stop all strategies?"
          sub="Kill switch"
          lines={[['Running strategies', String(running.length)], ['Open positions', 'Closed at market']]}
          warning="Every running strategy stops now and any position it holds is closed with a market order."
          confirmLabel="Stop all"
          tone="danger"
          pending={busy}
          onConfirm={stopAll}
          onClose={() => setConfirmAll(false)}
        />
      )}
    </>
  );
}
