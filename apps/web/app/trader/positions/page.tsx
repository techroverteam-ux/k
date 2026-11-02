'use client';
import { PortfolioSummary, PositionsTable } from '@/components/trading';

/** Positions with the whole account on top: balance, margin, P&L, brokerage. */
export default function Positions() {
  return (
    <div className="stack home" style={{ gap: 20 }}>
      <PortfolioSummary compact detail actions={false} title="Available to trade" />
      <section className="panel"><PositionsTable canTrade /></section>
    </div>
  );
}
