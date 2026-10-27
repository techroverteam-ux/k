'use client';
import { useState } from 'react';
import { PAYMENT_FIELDS, type Payment } from '@/components/trading';
import { Chips, Empty, ErrorState, PageHead, SkeletonRows, Status } from '@/components/ui';
import { inr, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

type F = 'ALL' | 'REQUESTED' | 'POSTED' | 'REJECTED';
export default function BrokerRequests() {
  const [f, setF] = useState<F>('ALL');
  const { data, loading, error, refetch } = useQuery<{ paymentRequests: Payment[] }>(`query($s:[PaymentStatus!]){ paymentRequests(status:$s, limit:100){ ${PAYMENT_FIELDS} } }`, { s: f === 'ALL' ? undefined : f === 'REJECTED' ? ['REJECTED', 'FAILED', 'CANCELLED'] : [f] }, { pollMs: 10_000 });
  return (
    <>
      <PageHead title="Fund requests" sub="Deposit and withdrawal requests for your traders. A Super Admin approves each one. To raise a new request, open a trader." />
      <div style={{ marginBottom: 12 }}><Chips label="Status" value={f} onChange={setF} items={[{ v: 'ALL', label: 'All' }, { v: 'REQUESTED', label: 'In review' }, { v: 'POSTED', label: 'Completed' }, { v: 'REJECTED', label: 'Not completed' }]} /></div>
      <section className="panel">
        {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !data!.paymentRequests.length ? <Empty icon="wallet" title="No requests here" /> : (
          <div className="table-wrap">
            <table className="t resp">
              <thead><tr><th>Trader</th><th>Type</th><th className="r">Amount</th><th>Status</th><th className="hide-sm">Requested</th></tr></thead>
              <tbody>{data!.paymentRequests.map((p) => (
                <tr key={p.id}>
                  <td className="lead w6">{p.username}</td>
                  <td data-label="Type">{p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}</td>
                  <td className="r num w6" data-label="Amount">₹{inr(p.amount)}</td>
                  <td data-label="Status"><Status value={p.status} />{p.reviewNote && <span className="sub" style={{ display: 'block' }}>{p.reviewNote}</span>}</td>
                  <td className="t2 sm num hide-sm">{when(p.createdAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
