import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { CreateUserSheet } from '@/admin-screens';
import { BellButton } from '@/screens';
import { initials, inr, useTheme, when } from '@/theme';
import { Button, Chips, Empty, ErrorState, ListRow, Screen, SearchBox, Skeleton, Spread, StatusBadge, T, useQuery } from '@/ui';

interface U { id: string; username: string; displayName: string; status: string; createdAt: string; openingAmount?: string }
export default function Traders() {
  const t = useTheme();
  const [s, setS] = useState('');
  const [st, setSt] = useState<'' | 'ACTIVE' | 'PENDING' | 'SUSPENDED'>('');
  const [adding, setAdding] = useState(false);
  const { data, error, loading, refetch } = useQuery<{ users: { items: U[] } }>(`query($s:String,$st:UserStatus){ users(role:TRADER, search:$s, status:$st, limit:100){ items{ id username displayName status createdAt openingAmount } } }`, { s: s || undefined, st: st || undefined });
  return (
    <Screen title="Traders" right={<BellButton />} onRefresh={refetch}>
      <SearchBox value={s} onChangeText={setS} placeholder="Search name or username" />
      <Chips value={st} onChange={setSt} items={[{ k: '', label: 'All' }, { k: 'ACTIVE', label: 'Active' }, { k: 'PENDING', label: 'Pending' }, { k: 'SUSPENDED', label: 'Suspended' }]} />
      <Spread><T v="xs">New traders need a Super Admin’s approval.</T><Button size="sm" kind="primary" icon="plus" title="Add trader" onPress={() => setAdding(true)} /></Spread>
      {loading && !data ? <Skeleton /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !data!.users.items.length ? (
        s || st ? <Empty icon="search" title="No traders match">Try a different search or filter.</Empty> : <Empty icon="users" title="No traders yet">Tap Add trader. A Super Admin approves the account and the opening amount.</Empty>
      ) : data!.users.items.map((u) => (
        <ListRow key={u.id} onPress={() => router.push(`/trader-detail/${u.id}`)} label={u.displayName}
          left={<View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: t.brandSoft, alignItems: 'center', justifyContent: 'center' }}><T c="brand" w="600">{initials(u.displayName)}</T></View>}
          title={u.displayName} sub={u.status === 'PENDING' ? `${u.username}\nRequested ${when(u.createdAt)}${u.openingAmount ? ` · ₹${inr(u.openingAmount)}` : ''}` : u.username} right={<StatusBadge v={u.status} />} />
      ))}
      {adding && <CreateUserSheet brokers={[]} onClose={() => setAdding(false)} onDone={() => void refetch()} />}
    </Screen>
  );
}
