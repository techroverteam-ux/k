import { useSoleAdmin } from '@/sole-admin';
import { router } from 'expo-router';
import { View } from 'react-native';
import { useAuth } from '@/auth';
import { Icon } from '@/icons';
import { AdminMfaGate } from '@/admin-screens';
import { BellButton } from '@/screens';
import { inr, useTheme } from '@/theme';
import { ErrorState, IconMark, ListRow, Metrics, Notice, Screen, Section, Skeleton, T, useQuery } from '@/ui';

interface O { brokers: number; traders: number; activeTraders: number; pendingAccounts: number; pendingPayments: number; pendingPaymentsAmount: string; openOrders: number; securityEvents24h: number; lastReconciliation?: { ok: boolean } }
export default function Overview() {
  const t = useTheme();
  const sole = useSoleAdmin();
  const { me } = useAuth();
  const { data, error, refetch } = useQuery<{ adminOverview: O }>(`{ adminOverview { brokers traders activeTraders pendingAccounts pendingPayments pendingPaymentsAmount openOrders securityEvents24h lastReconciliation { ok } } }`, undefined, 15000, !me?.mfaEnabled);
  const o = data?.adminOverview;
  if (!me?.mfaEnabled) return <AdminMfaGate title="Overview" />;
  return (
    <Screen title="Overview" right={<BellButton />} onRefresh={refetch}>
      {error && !o ? <ErrorState error={error} retry={refetch} /> : !o ? <Skeleton /> : (
        <>
          <Metrics items={[{ k: 'Brokers', v: o.brokers }, { k: 'Traders · active', v: `${o.traders} · ${o.activeTraders}` }, { k: 'Open orders', v: o.openOrders }, { k: 'Security events 24h', v: o.securityEvents24h }]} />
          <Section title="Needs attention">
            {o.pendingPayments > 0 && <ListRow onPress={() => router.push('/(admin)/payments')} left={<IconMark icon="rupee" tone="warn" />} title={`${o.pendingPayments} fund request${o.pendingPayments > 1 ? 's' : ''} to review`} sub={`₹${inr(o.pendingPaymentsAmount)} in total`} right={<Icon name="chevronRight" size={18} color={t.text3} />} />}
            {o.pendingAccounts > 0 && <ListRow onPress={() => router.push('/(admin)/users')} left={<IconMark icon="users" tone="warn" />} title={`${o.pendingAccounts} account${o.pendingAccounts > 1 ? 's' : ''} awaiting approval`} sub="Review in Accounts" right={<Icon name="chevronRight" size={18} color={t.text3} />} />}
            {o.securityEvents24h > 0 && <ListRow onPress={() => router.push('/(admin)/security')} left={<IconMark icon="shield" tone="neg" />} title={`${o.securityEvents24h} denied or failed actions`} sub="Last 24 hours · open Security" right={<Icon name="chevronRight" size={18} color={t.text3} />} />}
            {o.lastReconciliation && !o.lastReconciliation.ok && <ListRow onPress={() => router.push('/(admin)/security')} left={<IconMark icon="alert" tone="neg" />} title="Reconciliation found problems" sub="Open Security to re-run and review" right={<Icon name="chevronRight" size={18} color={t.text3} />} />}
            {!o.pendingPayments && !o.pendingAccounts && !o.securityEvents24h && (o.lastReconciliation?.ok ?? true) && <Notice tone="ok">All clear. Nothing needs your attention.</Notice>}
          </Section>
          <Section title="Tools">
            <ListRow onPress={() => router.push('/admin-fees')} left={<IconMark icon="wallet" tone="brand" />} title="Fees · bank & UPI" sub="Payment details traders pay fees to, and payments to check" right={<Icon name="chevronRight" size={18} color={t.text3} />} />
            <ListRow onPress={() => router.push('/admin-reset')} left={<IconMark icon="alert" tone="neg" />} title="Data reset" sub={sole ? 'Wipe all trader and broker data (runs immediately)' : 'Wipe all trader and broker data (needs a second Super Admin)'} right={<Icon name="chevronRight" size={18} color={t.text3} />} />
          </Section>
          <View><T v="xs" style={{ textAlign: 'center' }}>Configuration changes and log archives are on the web portal.</T></View>
        </>
      )}
    </Screen>
  );
}
