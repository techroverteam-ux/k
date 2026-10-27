import { router } from 'expo-router';
import { View } from 'react-native';
import { useAuth } from '@/auth';
import { Icon } from '@/icons';
import { BellButton } from '@/screens';
import { inr, useTheme } from '@/theme';
import { ErrorState, IconMark, ListRow, Metrics, Notice, Screen, Section, Skeleton, T, useQuery } from '@/ui';

interface O { brokers: number; traders: number; activeTraders: number; pendingAccounts: number; pendingPayments: number; pendingPaymentsAmount: string; openOrders: number; securityEvents24h: number; lastReconciliation?: { ok: boolean } }
export default function Overview() {
  const t = useTheme();
  const { me } = useAuth();
  const { data, error, refetch } = useQuery<{ adminOverview: O }>(`{ adminOverview { brokers traders activeTraders pendingAccounts pendingPayments pendingPaymentsAmount openOrders securityEvents24h lastReconciliation { ok } } }`, undefined, 15000);
  const o = data?.adminOverview;
  if (!me?.mfaEnabled) return <Screen title="Overview"><Notice tone="warn">Set up two-step verification on the web portal to use admin features on mobile.</Notice></Screen>;
  return (
    <Screen title="Overview" right={<BellButton />} onRefresh={refetch}>
      {error && !o ? <ErrorState error={error} retry={refetch} /> : !o ? <Skeleton /> : (
        <>
          <Metrics items={[{ k: 'Brokers', v: o.brokers }, { k: 'Traders · active', v: `${o.traders} · ${o.activeTraders}` }, { k: 'Open orders', v: o.openOrders }, { k: 'Security events 24h', v: o.securityEvents24h }]} />
          <Section title="Needs attention">
            {o.pendingPayments > 0 && <ListRow onPress={() => router.push('/(admin)/payments')} left={<IconMark icon="rupee" tone="warn" />} title={`${o.pendingPayments} fund request${o.pendingPayments > 1 ? 's' : ''} to review`} sub={`₹${inr(o.pendingPaymentsAmount)} in total`} right={<Icon name="chevronRight" size={18} color={t.text3} />} />}
            {o.pendingAccounts > 0 && <ListRow left={<IconMark icon="users" tone="warn" />} title={`${o.pendingAccounts} account${o.pendingAccounts > 1 ? 's' : ''} awaiting approval`} sub="Approve on the web portal" />}
            {o.securityEvents24h > 0 && <ListRow left={<IconMark icon="shield" tone="neg" />} title={`${o.securityEvents24h} denied or failed actions`} sub="Last 24 hours · see the audit log on the web" />}
            {o.lastReconciliation && !o.lastReconciliation.ok && <ListRow left={<IconMark icon="alert" tone="neg" />} title="Reconciliation found problems" sub="Investigate on the web portal" />}
            {!o.pendingPayments && !o.pendingAccounts && !o.securityEvents24h && (o.lastReconciliation?.ok ?? true) && <Notice tone="ok">All clear. Nothing needs your attention.</Notice>}
          </Section>
          <View><T v="xs" style={{ textAlign: 'center' }}>Accounts, configuration, audit and reconciliation are on the web portal.</T></View>
        </>
      )}
    </Screen>
  );
}
