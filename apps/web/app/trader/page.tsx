'use client';
import { Movers, PortfolioSummary, Watchlist } from '@/components/trading';
import { useAuth } from '@/lib/auth';

export default function TraderHome() {
  const { me } = useAuth();
  const first = me?.displayName.split(' ')[0];
  return (
    <div className="cols">
      <div className="stack" style={{ gap: 40 }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1>Hi{first ? `, ${first}` : ''}</h1>
          <p className="t2">Here’s your trading account.</p>
        </div>
        <PortfolioSummary actions />
        <Movers />
      </div>
      <aside className="rail"><Watchlist compact /></aside>
    </div>
  );
}
