'use client';
import Link from 'next/link';
import { useState } from 'react';
import { CreateUserDialog, Person, USER_FIELDS, type UserRow } from '@/components/accounts';
import { Icon } from '@/components/icons';
import { Chips, Empty, ErrorState, PageHead, Pager, SkeletonRows, Status } from '@/components/ui';
import { when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

const SIZE = 20;
export default function BrokerTraders() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'PENDING' | 'SUSPENDED'>('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const { data, loading, error, refetch } = useQuery<{ users: { total: number; items: UserRow[] } }>(
    `query($s:String,$st:UserStatus,$o:Int){ users(role:TRADER, search:$s, status:$st, limit:${SIZE}, offset:$o){ total items{ ${USER_FIELDS} } } }`,
    { s: search || undefined, st: status || undefined, o: page * SIZE },
  );
  const items = data?.users.items ?? [];
  return (
    <>
      <PageHead title="Traders" sub="Only traders assigned to you are listed.">
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={18} />Add trader</button>
      </PageHead>
      <div className="spread" style={{ marginBottom: 12 }}>
        <div className="input-icon" style={{ width: 'min(320px, 100%)' }}><Icon name="search" size={18} /><input className="input" placeholder="Search name or username" aria-label="Search traders" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} /></div>
        <Chips label="Status" value={status} onChange={(v) => { setStatus(v); setPage(0); }} items={[{ v: '', label: 'All' }, { v: 'ACTIVE', label: 'Active' }, { v: 'PENDING', label: 'Pending' }, { v: 'SUSPENDED', label: 'Suspended' }]} />
      </div>
      <section className="panel">
        {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !items.length ? (
          search || status ? <Empty icon="search" title="No traders match">Try a different search or filter.</Empty> : <Empty icon="users" title="No traders yet" action={<button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>Add trader</button>}>New traders need a Super Admin’s approval before they can sign in.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="t resp">
                <thead><tr><th>Trader</th><th>Status</th><th className="hide-sm">Mobile</th><th className="hide-sm">Joined</th><th /></tr></thead>
                <tbody>{items.map((u) => (
                  <tr key={u.id}>
                    <td className="lead"><Person u={u} href={`/broker/traders/${u.id}`} /></td>
                    <td data-label="Status"><Status value={u.status} /></td>
                    <td className="t2 num hide-sm">{u.phone ?? '—'}</td>
                    <td className="t2 sm num hide-sm">{when(u.createdAt)}</td>
                    <td className="r acts"><Link className="btn btn-sm" href={`/broker/traders/${u.id}`}>View</Link></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Pager page={page} total={data!.users.total} size={SIZE} onPage={setPage} />
          </>
        )}
      </section>
      {creating && <CreateUserDialog roles={['TRADER']} onClose={() => setCreating(false)} onDone={refetch} />}
    </>
  );
}
