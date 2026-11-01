import { BellButton, HelplineButton, SearchButton, Ticker, WatchlistBlock } from '@/screens';
import { Screen } from '@/ui';

export default function Watchlist() {
  return (
    <Screen title="Watchlist" scroll={false} right={<><SearchButton /><HelplineButton /><BellButton /></>}>
      <WatchlistBlock header={<Ticker />} />
    </Screen>
  );
}
