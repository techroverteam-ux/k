'use client';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/icons';
import { PAYMENT_FIELDS, type Payment } from '@/components/trading';
import { Empty, ErrorState, Metrics, PageHead, SectionHead, SkeletonRows, Status } from '@/components/ui';
import { inr, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

interface Overview { brokers: number; traders: number; activeTraders: number; suspended: number; pendingAccounts: number; pendingPayments: number; pendingPaymentsAmount: string; openOrders: number; securityEvents24h: number; lastReconciliation?: { ok: boolean; createdAt: string } }
interface Ev { id: string; action: string; outcome: string; createdAt: string; actorRole?: string; entityType?: string }

export default function AdminHome() {
  const { data, error, refetch } = useQuery<{ adminOverview: Overview }>(`{ adminOverview { brokers traders activeTraders suspended pendingAccounts pendingPayments pendingPaymentsAmount openOrders securityEvents24h lastReconciliation { ok createdAt } } }`, undefined, { pollMs: 15_000 });
  const pays = useQuery<{ paymentRequests: Payment[] }>(`{ paymentRequests(status:[REQUESTED], limit:5){ ${PAYMENT_FIELDS} } }`, undefined, { pollMs: 15_000 });
  const audit = useQuery<{ auditEvents: Ev[] }>(`{ auditEvents(limit: 6) { id action outcome createdAt actorRole entityType } }`, undefined, { pollMs: 15_000 });
  if (error && !data) return <ErrorState error={error} retry={refetch} />;
  const o = data?.adminOverview;
  const alerts: { icon: IconName; text: string; href: string; tone: 'warn' | 'err' }[] = o ? [
    ...(o.pendingPayments ? [{ icon: 'rupee' as const, text: `${o.pendingPayments} fund request${o.pendingPayments > 1 ? 's' : ''} (₹${inr(o.pendingPaymentsAmount)}) waiting for review`, href: '/admin/payments', tone: 'warn' as const }] : []),
    ...(o.pendingAccounts ? [{ icon: 'users' as const, text: `${o.pendingAccounts} new account${o.pendingAccounts > 1 ? 's' : ''} waiting for approval`, href: '/admin/users?status=PENDING', tone: 'warn' as const }] : []),
    ...(o.securityEvents24h ? [{ icon: 'shield' as const, text: `${o.securityEvents24h} denied or failed action${o.securityEvents24h > 1 ? 's' : ''} in the last 24 hours`, href: '/admin/audit', tone: 'err' as const }] : []),
    ...(!o.lastReconciliation ? [{ icon: 'scale' as const, text: 'Books haven’t been reconciled yet', href: '/admin/reconciliation', tone: 'warn' as const }] : !o.lastReconciliation.ok ? [{ icon: 'scale' as const, text: 'The last reconciliation found problems', href: '/admin/reconciliation', tone: 'err' as const }] : []),
  ] : [];

  return (
    <div className="stack" style={{ gap: 40 }}>
      <PageHead title="Overview" sub="Platform health, risk alerts and work waiting for you." />
      {!o ? <div className="skeleton" style={{ height: 84, borderRadius: 12 }} /> : (
        <Metrics items={[
          { k: 'Brokers', v: o.brokers },
          { k: 'Traders · active', v: `${o.traders} · ${o.activeTraders}` },
          { k: 'Open orders', v: o.openOrders },
          { k: 'Suspended accounts', v: o.suspended },
          { k: 'Security events · 24h', v: o.securityEvents24h, alert: o.securityEvents24h > 0 },
        ]} />
      )}
      <section className="section">
        <SectionHead title="Risk alerts" />
        {!o ? <SkeletonRows rows={2} pad={false} /> : !alerts.length ? (
          <div className="notice ok"><Icon name="check" size={18} />All clear. {o.lastReconciliation && `Books last reconciled ${when(o.lastReconciliation.createdAt)}.`}</div>
        ) : (
          <div className="list panel list-pad">{alerts.map((a) => (
            <Link key={a.text} href={a.href} className="list-row">
              <span className="mark" style={{ background: a.tone === 'err' ? 'var(--neg-soft)' : 'var(--warn-soft)', color: a.tone === 'err' ? 'var(--neg)' : 'var(--warn)' }}><Icon name={a.icon} size={18} /></span>
              <span className="grow w5">{a.text}</span><Icon name="chevronRight" size={18} />
            </Link>
          ))}</div>
        )}
      </section>
      <div className="two">
        <section className="section">
          <SectionHead title="Waiting for review"><Link className="btn btn-sm btn-ghost" href="/admin/payments">Review all<Icon name="chevronRight" size={16} /></Link></SectionHead>
          {pays.loading && !pays.data ? <SkeletonRows rows={3} pad={false} /> : !pays.data?.paymentRequests.length ? <Empty icon="check" title="Nothing to review" /> : (
            <div className="list">{pays.data.paymentRequests.map((p) => (
              <Link key={p.id} href="/admin/payments" className="list-row">
                <div className="grow"><div className="w5">{p.username} · {p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}</div><div className="t3">{when(p.createdAt)}</div></div>
                <span className="num w6">₹{inr(p.amount)}</span>
              </Link>
            ))}</div>
          )}
        </section>
        <section className="section">
          <SectionHead title="Recent activity"><Link className="btn btn-sm btn-ghost" href="/admin/audit">Audit log<Icon name="chevronRight" size={16} /></Link></SectionHead>
          {audit.loading && !audit.data ? <SkeletonRows rows={3} pad={false} /> : !audit.data?.auditEvents.length ? <Empty icon="file" title="No activity yet" /> : (
            <div className="list">{audit.data.auditEvents.map((e) => (
              <div key={e.id} className="list-row">
                <div className="grow"><div className="w5">{e.action}</div><div className="t3">{e.actorRole ? e.actorRole.replace('_', ' ').toLowerCase() : 'system'} · {when(e.createdAt)}</div></div>
                <Status value={e.outcome} />
              </div>
            ))}</div>
          )}
        </section>
      </div>
    </div>
  );
}
