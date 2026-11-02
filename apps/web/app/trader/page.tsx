'use client';
import { PortfolioSummary, Watchlist } from '@/components/trading';
import { useAuth } from '@/lib/auth';

/** Trader home: a slim balance card, then the watchlist. Nothing else. */
export default function TraderHome() {
  const { me } = useAuth();
  const first = me?.displayName.split(' ')[0];
  return (
    <div className="stack home" style={{ gap: 20 }}>
      <h1 className="home-hi">Hi{first ? `, ${first}` : ''}</h1>
      <PortfolioSummary actions compact />
      <Watchlist />
    </div>
  );
}
