import { BellButton, OrdersTabs } from '@/screens';
import { Screen } from '@/ui';

/** Kept for deep links; the Portfolio tab is the primary entry point. */
export default function Orders() {
  return (
    <Screen title="Orders" scroll={false} right={<BellButton />}>
      <OrdersTabs virtual />
    </Screen>
  );
}
