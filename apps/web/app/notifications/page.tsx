'use client';
import { Icon } from '@/components/icons';
import { Empty, ErrorState, PageHead, SkeletonRows } from '@/components/ui';
import { gql } from '@/lib/api';
import { when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

interface N { id: string; kind: string; title: string; body: string; readAt?: string; createdAt: string }
const ico = (k: string) => (k.startsWith('security') ? 'shield' : k.startsWith('payment') ? 'wallet' : k.startsWith('order') ? 'list' : 'bell') as 'bell';

export default function Notifications() {
  const { data, loading, error, refetch } = useQuery<{ notifications: N[] }>(`{ notifications(limit:100){ id kind title body readAt createdAt } }`);
  const unread = data?.notifications.filter((n) => !n.readAt).length ?? 0;
  return (
    <div style={{ maxWidth: 760 }}>
      <PageHead title="Notifications" sub={unread ? `${unread} unread` : undefined}>
        {unread > 0 && <button className="btn btn-sm" onClick={async () => { await gql(`mutation { markNotificationsRead }`).catch(() => undefined); void refetch(); }}><Icon name="check" size={16} />Mark all as read</button>}
      </PageHead>
      {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !data!.notifications.length ? <Empty icon="bell" title="You’re all caught up">Order fills, fund requests and security alerts appear here.</Empty> : (
        <div className="list">{data!.notifications.map((n) => (
          <div key={n.id} className="list-row" style={{ alignItems: 'flex-start' }}>
            <span className="mark" style={n.readAt ? undefined : { background: 'var(--brand-soft)', color: 'var(--brand)' }}><Icon name={ico(n.kind)} size={18} /></span>
            <div className="grow"><div className="spread"><span className={n.readAt ? 'w5' : 'w6'}>{n.title}</span><span className="t3 num">{when(n.createdAt)}</span></div><div className="t2 sm">{n.body}</div></div>
            {!n.readAt && <span aria-label="Unread" style={{ width: 8, height: 8, borderRadius: 4, background: 'var(--brand)', marginTop: 8 }} />}
          </div>
        ))}</div>
      )}
    </div>
  );
}
