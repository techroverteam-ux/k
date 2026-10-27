import { useState } from 'react';
import { BellButton, OrdersList, PositionsList } from '@/screens';
import { Chips, Screen, Tabs } from '@/ui';

/** Portfolio: positions and orders under one tab (Groww-style). */
export default function Portfolio() {
  const [tab, setTab] = useState<'pos' | 'ord'>('pos');
  const [st, setSt] = useState<'OPEN' | 'FILLED' | 'REJECTED'>('OPEN');
  return (
    <Screen title="Portfolio" right={<BellButton />}>
      <Tabs value={tab} onChange={setTab} items={[{ k: 'pos', label: 'Positions' }, { k: 'ord', label: 'Orders' }]} />
      {tab === 'pos' ? <PositionsList canTrade /> : (
        <>
          <Chips value={st} onChange={setSt} items={[{ k: 'OPEN', label: 'Open' }, { k: 'FILLED', label: 'Executed' }, { k: 'REJECTED', label: 'Rejected' }]} />
          <OrdersList key={st} canCancel statuses={st === 'REJECTED' ? ['REJECTED', 'CANCELLED'] : [st]}
            emptyTitle={st === 'OPEN' ? 'No open orders' : st === 'FILLED' ? 'No executed orders' : 'Nothing rejected'}
            emptyText={st === 'OPEN' ? 'Limit orders waiting for their price show here. Tap one to cancel it.' : undefined} />
        </>
      )}
    </Screen>
  );
}
