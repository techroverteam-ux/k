import { View } from 'react-native';
import { useAuth } from '@/auth';
import { BellButton, HelplineButton, SummaryBlock, Ticker, WatchlistBlock } from '@/screens';
import { S } from '@/theme';
import { Screen } from '@/ui';

/** Home: the ticker, a slim balance card, then the watchlist (with search-and-add on top). Nothing else. */
export default function Home() {
  const { me } = useAuth();
  return (
    <Screen title={`Hi, ${me?.displayName.split(' ')[0] ?? ''}`} scroll={false} right={<><HelplineButton /><BellButton /></>}>
      <WatchlistBlock header={<View style={{ gap: S[3], marginBottom: S[1] }}><Ticker /><SummaryBlock compact actions /></View>} />
    </Screen>
  );
}
