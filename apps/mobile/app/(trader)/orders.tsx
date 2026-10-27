import { BellButton, OrdersList } from '@/screens';
import { Screen } from '@/ui';

/** Kept for deep links; the Portfolio tab is the primary entry point. */
export default function Orders() {
  return (
    <Screen title="Orders" right={<BellButton />}>
      <OrdersList canCancel statuses={['OPEN', 'FILLED', 'REJECTED', 'CANCELLED']} />
    </Screen>
  );
}
