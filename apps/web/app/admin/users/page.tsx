'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CreateUserDialog, Person, pctLabel, ROLE_LABEL, USER_FIELDS, type UserRow } from '@/components/accounts';
import { PendingDeletions, UserActionButtons, useUserActions } from '@/components/admin';
import { Icon } from '@/components/icons';
import { Chips, Empty, ErrorState, PageHead, Pager, SkeletonRows, Status, Tabs } from '@/components/ui';
import { inr, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

const SIZE = 25;
type R = '' | 'BROKER' | 'TRADER' | 'SUPER_ADMIN';
type S = '' | 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

function Users() {
  const sp = useSearchParams();
  const [role, setRole] = useState<R>('');
  const [status, setStatus] = useState<S>((sp.get('status') as S) ?? '');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const { data, loading, error, refetch } = useQuery<{ users: { total: number; items: UserRow[] } }>(
    `query($r:Role,$s:UserStatus,$q:String,$o:Int){ users(role:$r, status:$s, search:$q, limit:${SIZE}, offset:$o){ total items{ ${USER_FIELDS} } } }`,
    { r: role || undefined, s: status || undefined, q: search || undefined, o: page * SIZE },
  );
  const { open, node, brokers } = useUserActions(refetch);
  const brokerName = (id?: string) => brokers.find((b) => b.id === id)?.username;
  const reset = () => setPage(0);
  return (
    <>
      <PageHead title="Accounts" sub="Brokers and traders. Traders added by a broker wait here for your approval, with their opening amount.">
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={18} />Create account</button>
      </PageHead>
      <PendingDeletions onDone={refetch} />
      <Tabs label="Account type" value={role} onChange={(v) => { setRole(v); reset(); }} items={[{ v: '', label: 'All' }, { v: 'BROKER', label: 'Brokers' }, { v: 'TRADER', label: 'Traders' }, { v: 'SUPER_ADMIN', label: 'Admins' }]} />
      <div className="spread" style={{ margin: '16px 0 12px' }}>
        <div className="input-icon" style={{ width: 'min(320px, 100%)' }}><Icon name="search" size={18} /><input className="input" placeholder="Search name or username" aria-label="Search accounts" value={search} onChange={(e) => { setSearch(e.target.value); reset(); }} /></div>
        <Chips label="Status" value={status} onChange={(v) => { setStatus(v); reset(); }} items={[{ v: '', label: 'Any status' }, { v: 'PENDING', label: 'Pending' }, { v: 'ACTIVE', label: 'Active' }, { v: 'SUSPENDED', label: 'Suspended' }]} />
      </div>
      <section className="panel">
        {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !data!.users.items.length ? (
          <Empty icon="search" title="No accounts match">Try another search or clear the filters.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="t resp">
                <thead><tr><th>Account</th><th>Type</th><th>Broker</th><th>Status</th><th>{status === 'PENDING' ? 'Requested' : 'Created'}</th><th className="hide-sm">2-step</th><th className="r">Actions</th></tr></thead>
                <tbody>{data!.users.items.map((u) => (
                  <tr key={u.id}>
                    <td className="lead"><Person u={u} href={`/admin/users/${u.id}`} />{u.isDemo && <span className="badge info" style={{ marginTop: 4 }}>Demo</span>}</td>
                    <td data-label="Type"><span className="cell-v">{ROLE_LABEL[u.role]}{u.role === 'BROKER' && <span className="sub">{pctLabel(u)}</span>}</span></td>
                    <td data-label="Broker" className={u.role === 'TRADER' ? 't2' : 't2 empty-sm'}>{u.role === 'TRADER' ? (u.brokerName ?? brokerName(u.brokerId) ?? 'No broker') : '—'}</td>
                    <td data-label="Status"><span className="cell-v"><Status value={u.status} />{u.status === 'PENDING' && u.openingAmount && <span className="sub num">Opening ₹{inr(u.openingAmount)}</span>}</span></td>
                    <td data-label={u.status === 'PENDING' ? 'Requested' : 'Created'} className="t2 sm num"><span className="cell-v">{when(u.createdAt)}{u.createdByName && <span className="sub">by {u.createdByName}</span>}</span></td>
                    <td className="hide-sm">{u.mfaEnabled ? <span className="badge ok">On</span> : <span className="badge">Off</span>}</td>
                    <td className="r acts"><UserActionButtons u={u} open={open} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Pager page={page} total={data!.users.total} size={SIZE} onPage={setPage} />
          </>
        )}
      </section>
      {creating && <CreateUserDialog roles={['BROKER', 'TRADER']} brokers={brokers} onClose={() => setCreating(false)} onDone={refetch} />}
      {node}
    </>
  );
}

export default function Page() {
  return <Suspense fallback={<SkeletonRows />}><Users /></Suspense>;
}
