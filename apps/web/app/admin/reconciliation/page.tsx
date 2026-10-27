'use client';
import { useState } from 'react';
import { Icon } from '@/components/icons';
import { Empty, ErrorState, PageHead, SectionHead, SkeletonRows, useToast } from '@/components/ui';
import { gql } from '@/lib/api';
import { when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

interface Run { id: string; ok: boolean; summaryJson: string; createdAt: string }
const LABEL: Record<string, string> = {
  journals_balanced: 'Every journal balances to zero',
  trial_balance_zero: 'Trial balance is zero',
  payments_match_ledger: 'Completed payments match ledger entries',
  positions_pnl_match_ledger: 'Position P&L matches ledger P&L',
  filled_orders_have_fees: 'Executed orders have brokerage entries',
  no_negative_cash: 'No trader balance below zero',
  audit_chain_intact: 'Audit chain is intact',
};

export default function Recon() {
  const { data, loading, error, refetch } = useQuery<{ reconciliationRuns: Run[] }>(`{ reconciliationRuns { id ok summaryJson createdAt } }`);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const runs = data?.reconciliationRuns ?? [];
  const latest = runs[0];
  const checks: { name: string; ok: boolean; detail: string }[] = latest ? JSON.parse(latest.summaryJson).checks : [];
  return (
    <div className="stack" style={{ gap: 32 }}>
      <PageHead title="Reconciliation" sub="Independent checks over the books. If anything fails, investigate before approving withdrawals.">
        <button className="btn btn-primary" disabled={busy} onClick={async () => {
          setBusy(true);
          try { const d = await gql(`mutation { runReconciliation { ok } }`); toast(d.runReconciliation.ok ? 'All checks passed' : 'Some checks failed', !d.runReconciliation.ok); void refetch(); }
          catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
        }}><Icon name="refresh" size={18} />{busy ? 'Running checks…' : 'Run checks'}</button>
      </PageHead>
      {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !latest ? (
        <Empty icon="scale" title="No checks run yet" action={<span className="t3">Use “Run checks” to verify the books.</span>} />
      ) : (
        <section className="section">
          <SectionHead title={`Latest run · ${when(latest.createdAt)}`}>{latest.ok ? <span className="badge ok">All passed</span> : <span className="badge bad">Problems found</span>}</SectionHead>
          <div className="panel list list-pad">
            {checks.map((c) => (
              <div key={c.name} className="list-row">
                <span className="mark" style={{ background: c.ok ? 'var(--pos-soft)' : 'var(--neg-soft)', color: c.ok ? 'var(--pos)' : 'var(--neg)' }}><Icon name={c.ok ? 'check' : 'x'} size={18} /></span>
                <div className="grow"><div className="w5">{LABEL[c.name] ?? c.name}</div><div className="t3">{c.detail}</div></div>
                <span className={`badge ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? 'Pass' : 'Fail'}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      {runs.length > 1 && (
        <section className="section">
          <h2>Earlier runs</h2>
          <div className="list">{runs.slice(1).map((r) => <div key={r.id} className="list-row"><span className="grow t2 num">{when(r.createdAt)}</span>{r.ok ? <span className="badge ok">All passed</span> : <span className="badge bad">Problems found</span>}</div>)}</div>
        </section>
      )}
    </div>
  );
}
