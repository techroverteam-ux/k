'use client';
import { FeesAdmin } from '@/components/fees';
import { PageHead } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function Fees() {
  const { me } = useAuth();
  if (!me) return null;
  return (
    <div className="stack" style={{ gap: 24 }}>
      <PageHead title="Fees" sub="Company bank accounts and UPI IDs where traders pay course and subscription fees, and the payments they report." />
      <FeesAdmin meId={me.id} />
    </div>
  );
}
