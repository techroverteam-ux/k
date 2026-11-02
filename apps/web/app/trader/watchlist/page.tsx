'use client';
import { Watchlist } from '@/components/trading';

/** One watchlist with search on top. Prices update live; tap a sell or buy price to trade. */
export default function WatchlistPage() {
  return <div className="home"><Watchlist /></div>;
}
