'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { CreateUserDialog, Person, ROLE_LABEL, USER_FIELDS, type UserRow } from '@/components/accounts';
import { UserActionButtons, useUserActions } from '@/components/admin';
import { Icon } from '@/components/icons';
import { Chips, Empty, ErrorState, PageHead, Pager, SkeletonRows, Status, Tabs } from '@/components/ui';
import { when } from '@/lib/format';
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
      <PageHead title="Accounts" sub="Brokers and traders. New accounts need a second Super Admin to approve them.">
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={18} />Create account</button>
      </PageHead>
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
                <thead><tr><th>Account</th><th>Type</th><th className="hide-sm">Broker</th><th>Status</th><th className="hide-sm">2-step</th><th className="hide-md">Created</th><th className="r">Actions</th></tr></thead>
                <tbody>{data!.users.items.map((u) => (
                  <tr key={u.id}>
                    <td className="lead"><Person u={u} href={`/admin/users/${u.id}`} />{u.isDemo && <span className="badge info" style={{ marginTop: 4 }}>Demo</span>}</td>
                    <td data-label="Type">{ROLE_LABEL[u.role]}</td>
                    <td className="t2 hide-sm">{u.role === 'TRADER' ? brokerName(u.brokerId) ?? '—' : ''}</td>
                    <td data-label="Status"><Status value={u.status} /></td>
                    <td className="hide-sm">{u.mfaEnabled ? <span className="badge ok">On</span> : <span className="badge">Off</span>}</td>
                    <td className="t2 sm num hide-md">{when(u.createdAt)}</td>
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
