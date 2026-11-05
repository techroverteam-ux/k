import { TradeBook } from '@/quick-trade';
import { BellButton } from '@/screens';
import { Screen } from '@/ui';

/** Trade book (Success / Pending / Rejected). Kept for deep links; Portfolio → Trades is the main entry. */
export default function Orders() {
  return (
    <Screen title="Trade" scroll={false} right={<BellButton />}>
      <TradeBook />
    </Screen>
  );
}
