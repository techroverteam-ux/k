'use client';
import { PageHead } from '@/components/ui';
import { PositionsTable } from '@/components/trading';

export default function Positions() {
  return (
    <>
      <PageHead title="Positions" sub="Open P&L is marked to the simulated bid for longs and ask for shorts." />
      <section className="panel"><PositionsTable canTrade /></section>
    </>
  );
}
