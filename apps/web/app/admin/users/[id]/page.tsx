'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AccountDetail } from '@/components/accounts';
import { UserActionButtons, useUserActions } from '@/components/admin';
import { UserLogs } from '@/components/activity';
import { ConsentHistory, LoginHistory, UserSessions } from '@/components/logins';

export default function AdminUserDetail() {
  const { id } = useParams<{ id: string }>();
  const [v, setV] = useState(0);
  const { open, node } = useUserActions(() => setV((x) => x + 1));
  return (
    <>
      <AccountDetail key={v} id={id} back={{ href: '/admin/users', label: 'Accounts' }} actions={(u) => <UserActionButtons u={u} open={open} />} />
      <div style={{ marginTop: 40 }}><UserLogs key={v} userId={id} /></div>
      <div style={{ marginTop: 40 }}><UserSessions key={`s${v}`} userId={id} /></div>
      <div className="two" style={{ marginTop: 40 }}><LoginHistory userId={id} title="Login audit" /><ConsentHistory userId={id} /></div>
      {node}
    </>
  );
}
