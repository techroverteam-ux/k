import { useState } from 'react';
import { BellButton, OrdersTabs, PositionsList, SearchButton, SummaryBlock } from '@/screens';
import { RiskBanner } from '@/risk';
import { Screen, Tabs } from '@/ui';

/** Portfolio: positions, and orders split into Open / Executed / Rejected. */
export default function Portfolio() {
  const [tab, setTab] = useState<'pos' | 'ord'>('pos');
  const tabs = <Tabs value={tab} onChange={setTab} items={[{ k: 'pos', label: 'Positions' }, { k: 'ord', label: 'Orders' }]} />;
  if (tab === 'ord') {
    return (
      <Screen title="Portfolio" scroll={false} right={<><SearchButton /><BellButton /></>}>
        <OrdersTabs virtual header={tabs} />
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
