import { router } from 'expo-router';
import { useMemo } from 'react';
import { useAuth } from '@/auth';
import { BellButton, RequestsList } from '@/screens';
import { inr, initials, useTheme } from '@/theme';
import { Button, Empty, ErrorState, ListRow, Metrics, Screen, Section, Skeleton, StatusBadge, T, useQuery } from '@/ui';
import { View } from 'react-native';

interface U { id: string; username: string; displayName: string; status: string }
export default function BrokerHome() {
  const { me } = useAuth();
  const t = useTheme();
  const range = useMemo(() => { const d = new Date(); return { f: new Date(d.getFullYear(), d.getMonth(), 1).toISOString(), t: new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString() }; }, []);
  const tr = useQuery<{ users: { total: number; items: U[] } }>(`{ users(role:TRADER, limit:100){ total items{ id username displayName status } } }`);
  const com = useQuery<{ commissionReport: { total: string } }>(`query($f:DateTime!,$t:DateTime!){ commissionReport(from:$f,to:$t){ total } }`, range);
  const items = tr.data?.users.items ?? [];
  return (
    <Screen title={`Hi, ${me?.displayName.split(' ')[0] ?? ''}`} right={<BellButton />} onRefresh={tr.refetch}>
      <Metrics items={[
        { k: 'Assigned traders', v: tr.data?.users.total ?? '…' },
        { k: 'Active', v: tr.data ? items.filter((u) => u.status === 'ACTIVE').length : '…' },
        { k: 'Awaiting approval', v: tr.data ? items.filter((u) => u.status === 'PENDING').length : '…' },
        { k: 'Commission (month)', v: com.data ? `₹${inr(com.data.commissionReport.total)}` : '…' },
      ]} />
      <Section title="Traders" action={<Button size="sm" kind="ghost" title="See all" onPress={() => router.push('/(broker)/traders')} />}>
        {tr.error && !tr.data ? <ErrorState error={tr.error} retry={tr.refetch} /> : !tr.data ? <Skeleton rows={3} /> : !items.length ? <Empty icon="users" title="No traders yet">Traders assigned to you appear here.</Empty> : items.slice(0, 4).map((u) => (
          <ListRow key={u.id} onPress={() => router.push(`/trader-detail/${u.id}`)} left={<View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}><T c="brand" w="600">{initials(u.displayName)}</T></View>} title={u.displayName} sub={u.username} right={<StatusBadge v={u.status} />} />
        ))}
      </Section>
      <Section title="Recent fund requests"><RequestsList showName /></Section>
    </Screen>
  );
}
