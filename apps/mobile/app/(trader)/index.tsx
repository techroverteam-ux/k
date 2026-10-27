import { router } from 'expo-router';
import { useAuth } from '@/auth';
import { BellButton, HelplineButton, Ticker, Movers, SummaryBlock, WatchlistBlock } from '@/screens';
import { Button, Screen, Section, T } from '@/ui';

export default function Home() {
  const { me } = useAuth();
  return (
    <Screen title={`Hi, ${me?.displayName.split(' ')[0] ?? ''}`} right={<><HelplineButton /><BellButton /></>}>
      <Ticker />
      <SummaryBlock actions />
      <Movers />
      <Section title="Watchlist" action={<Button size="sm" kind="ghost" title="See all" onPress={() => router.push('/(trader)/watchlist')} />}>
        <WatchlistBlock limit={5} />
      </Section>
      <T v="xs" style={{ textAlign: 'center' }}>Simulated prices for practice. Nothing is sent to an exchange.</T>
    </Screen>
  );
}
