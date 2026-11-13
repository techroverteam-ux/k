import { useState } from 'react';
import { BellButton, PositionsList, SearchButton, SummaryBlock } from '@/screens';
import { TradeBook } from '@/quick-trade';
import { RiskBanner } from '@/risk';
import { Screen, Tabs } from '@/ui';

/** Positions, with a shortcut to the trade book. */
export default function Portfolio() {
  const [tab, setTab] = useState<'pos' | 'ord'>('pos');
  const tabs = <Tabs value={tab} onChange={setTab} items={[{ k: 'pos', label: 'Positions' }, { k: 'ord', label: 'Trades' }]} />;
  if (tab === 'ord') {
    return (
      <Screen title="Positions" scroll={false} right={<><SearchButton /><BellButton /></>}>
        <TradeBook header={tabs} />
      </Screen>
    );
  }
  return (
    <Screen title="Positions" right={<><SearchButton /><BellButton /></>}>
      {tabs}
      <RiskBanner />
      <SummaryBlock compact detail />
      <PositionsList canTrade />
    </Screen>
  );
}
