'use client';
import { PortfolioSummary, Watchlist } from '@/components/trading';

/** Trader home: account funds and live watchlist prices. */
export default function WatchlistPage() {
  return (
    <div className="home stack" style={{ gap: 20 }}>
      <PortfolioSummary compact detail actions title="Available balance" />
      <Watchlist />
    </div>
  );
}
