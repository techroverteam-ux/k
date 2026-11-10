import { BellButton, HelplineButton, Ticker, WatchlistBlock } from '@/screens';
import { Screen } from '@/ui';
import { RiskBanner } from '@/risk';

/** One watchlist with search on top. */
export default function Watchlist() {
  return (
    <Screen title="Watchlist" scroll={false} right={<><HelplineButton /><BellButton /></>}>
      <WatchlistBlock header={<><RiskBanner /><Ticker /></>} />
    </Screen>
  );
}
