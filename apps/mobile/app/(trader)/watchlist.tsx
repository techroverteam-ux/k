import { BellButton, HelplineButton, Ticker, WatchlistBlock } from '@/screens';
import { Screen } from '@/ui';

/** One watchlist with search on top. */
export default function Watchlist() {
  return (
    <Screen title="Watchlist" scroll={false} right={<><HelplineButton /><BellButton /></>}>
      <WatchlistBlock header={<Ticker />} />
    </Screen>
  );
}
