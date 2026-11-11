'use client';
import { PageHead } from '@/components/ui';
import { AccountResetPanel } from '@/components/account-resets';
import { PlatformWipePanel } from '@/components/wipe';
import { useAuth } from '@/lib/auth';

export default function DataReset() {
  const { me } = useAuth();
  if (!me) return null;
  return (
    <div className="stack" style={{ gap: 24, maxWidth: 820 }}>
      <PageHead title="Data reset" sub="Permanently delete everything except the Super Admin accounts, for example at the end of a training batch." />
      <AccountResetPanel />
      <PlatformWipePanel meId={me.id} />
    </div>
  );
}
