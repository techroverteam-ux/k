'use client';
import { useEffect, useState } from 'react';
import { OrdersTable } from '@/components/trading';
import { PageHead, Tabs } from '@/components/ui';

const TABS = {
  open: { label: 'Open', s: ['OPEN'], title: 'No open orders', text: 'Limit orders waiting for their price appear here.' },
  done: { label: 'Executed', s: ['FILLED'], title: 'No executed orders', text: 'Filled orders appear here.' },
  rej: { label: 'Rejection log', s: ['REJECTED', 'CANCELLED'], title: 'Nothing rejected or cancelled', text: 'If an order fails a check, you’ll see the reason here.' },
} as const;

export default function Orders() {
  const [tab, setTab] = useState<keyof typeof TABS>('open');
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && t in TABS) setTab(t as keyof typeof TABS);
  }, []);
  const t = TABS[tab];
  return (
    <>
      <PageHead title="Orders" />
      <Tabs label="Order status" value={tab} onChange={setTab} items={(Object.keys(TABS) as (keyof typeof TABS)[]).map((k) => ({ v: k, label: TABS[k].label }))} />
      <section style={{ marginTop: 8 }}><OrdersTable key={tab} statuses={[...t.s]} canCancel={tab === 'open'} emptyTitle={t.title} emptyText={t.text} /></section>
    </>
  );
}
