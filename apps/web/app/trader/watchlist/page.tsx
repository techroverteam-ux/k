'use client';
import { PageHead } from '@/components/ui';
import { Watchlist } from '@/components/trading';

export default function WatchlistPage() {
  return (
    <>
      <PageHead title="Watchlist" sub="Prices update live from the simulated feed. Tap a sell or buy price to open the order panel." />
      <Watchlist />
    </>
  );
}
