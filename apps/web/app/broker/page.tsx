'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { Person, USER_FIELDS, type UserRow } from '@/components/accounts';
import { Icon } from '@/components/icons';
import { PAYMENT_FIELDS, type Payment } from '@/components/trading';
import { Empty, ErrorState, Metrics, PageHead, SectionHead, SkeletonRows, Status } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { inr, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

export default function BrokerDashboard() {
  const { me } = useAuth();
  const range = useMemo(() => { const d = new Date(); return { f: new Date(d.getFullYear(), d.getMonth(), 1).toISOString(), t: new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString() }; }, []);
  const traders = useQuery<{ users: { total: number; items: UserRow[] } }>(`{ users(role:TRADER, limit:100){ total items{ ${USER_FIELDS} } } }`);
  const reqs = useQuery<{ paymentRequests: Payment[] }>(`{ paymentRequests(limit:5){ ${PAYMENT_FIELDS} } }`, undefined, { pollMs: 15_000 });
  const com = useQuery<{ commissionReport: { total: string } }>(`query($f:DateTime!,$t:DateTime!){ commissionReport(from:$f,to:$t){ total } }`, range);
  const items = traders.data?.users.items ?? [];
  const pending = items.filter((u) => u.status === 'PENDING').length;
  const inReview = reqs.data?.paymentRequests.filter((p) => p.status === 'REQUESTED').length ?? 0;
  return (
    <div className="stack" style={{ gap: 40 }}>
      <PageHead title={`Hi, ${me?.displayName.split(' ')[0] ?? ''}`} sub="Your assigned traders at a glance. You can only see traders assigned to you." />
      <Metrics items={[
        { k: 'Assigned traders', v: traders.data?.users.total ?? '…' },
        { k: 'Active', v: traders.data ? items.filter((u) => u.status === 'ACTIVE').length : '…' },
        { k: 'Awaiting approval', v: traders.data ? pending : '…', alert: pending > 0 },
        { k: 'Commission this month', v: com.data ? `₹${inr(com.data.commissionReport.total)}` : '…' },
      ]} />
      <div className="two">
        <section className="section">
          <SectionHead title="Traders"><Link className="btn btn-sm btn-ghost" href="/broker/traders">View all<Icon name="chevronRight" size={16} /></Link></SectionHead>
          {traders.loading && !traders.data ? <SkeletonRows rows={4} pad={false} /> : traders.error && !traders.data ? <ErrorState error={traders.error} retry={traders.refetch} /> : !items.length ? (
            <Empty icon="users" title="No traders yet" action={<Link className="btn btn-sm btn-primary" href="/broker/traders">Add a trader</Link>}>Traders assigned to you appear here.</Empty>
          ) : (
            <div className="list">{items.slice(0, 5).map((u) => (
              <Link key={u.id} href={`/broker/traders/${u.id}`} className="list-row"><span className="grow"><Person u={u} /></span><Status value={u.status} /><Icon name="chevronRight" size={18} className="t3" /></Link>
            ))}</div>
          )}
        </section>
        <section className="section">
          <SectionHead title="Recent fund requests"><Link className="btn btn-sm btn-ghost" href="/broker/requests">View all<Icon name="chevronRight" size={16} /></Link></SectionHead>
          {inReview > 0 && <div className="notice warn"><Icon name="info" size={18} />{inReview} request{inReview > 1 ? 's are' : ' is'} waiting for a Super Admin.</div>}
          {reqs.loading && !reqs.data ? <SkeletonRows rows={4} pad={false} /> : !reqs.data?.paymentRequests.length ? <Empty icon="wallet" title="No requests yet">Open a trader to request a deposit or withdrawal.</Empty> : (
            <div className="list">{reqs.data.paymentRequests.map((p) => (
              <div key={p.id} className="list-row">
                <div className="grow"><div className="w5">{p.username} · {p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}</div><div className="t3">{when(p.createdAt)}</div></div>
                <div className="quote-cell" style={{ gap: 4 }}><span className="num w6">₹{inr(p.amount)}</span><Status value={p.status} /></div>
              </div>
            ))}</div>
          )}
        </section>
      </div>
    </div>
  );
}
