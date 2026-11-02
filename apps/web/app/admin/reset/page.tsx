'use client';
import { PageHead } from '@/components/ui';
import { PlatformWipePanel } from '@/components/wipe';
import { useAuth } from '@/lib/auth';

export default function DataReset() {
  const { me } = useAuth();
  if (!me) return null;
  return (
    <div className="stack" style={{ gap: 24, maxWidth: 820 }}>
      <PageHead title="Data reset" sub="Permanently delete all trader and broker data, for example at the end of a training batch." />
      <PlatformWipePanel meId={me.id} />
    </div>
  );
}
