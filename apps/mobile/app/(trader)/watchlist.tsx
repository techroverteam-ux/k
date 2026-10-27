import { BellButton, HelplineButton, Ticker, WatchlistBlock } from '@/screens';
import { Screen } from '@/ui';

export default function Watchlist() {
  return (
    <Screen title="Watchlist" right={<><HelplineButton /><BellButton /></>}>
      <Ticker />
      <WatchlistBlock />
    </Screen>
  );
}
