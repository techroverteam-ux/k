import { useState } from 'react';
import { BellButton, PositionsList, SearchButton, SummaryBlock } from '@/screens';
import { TradeBook } from '@/quick-trade';
import { RiskBanner } from '@/risk';
import { Screen, Tabs } from '@/ui';

/** Portfolio: positions, and the trade book (Success / Pending / Rejected). */
export default function Portfolio() {
  const [tab, setTab] = useState<'pos' | 'ord'>('pos');
  const tabs = <Tabs value={tab} onChange={setTab} items={[{ k: 'pos', label: 'Positions' }, { k: 'ord', label: 'Trades' }]} />;
  if (tab === 'ord') {
    return (
      <Screen title="Portfolio" scroll={false} right={<><SearchButton /><BellButton /></>}>
        <TradeBook header={tabs} />
      </Screen>
    );
  }
  return (
    <Screen title="Portfolio" right={<><SearchButton /><BellButton /></>}>
      {tabs}
      <RiskBanner />
      <SummaryBlock compact detail />
      <PositionsList canTrade />
    </Screen>
  );
}
