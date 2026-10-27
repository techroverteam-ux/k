import { OrdersList } from '@/screens';
import { Screen, T } from '@/ui';

export default function Rejections() {
  return (
    <Screen back title="Rejection logs">
      <T v="sm" c="text2">Orders that failed a check or were cancelled, with the reason.</T>
      <OrdersList statuses={['REJECTED', 'CANCELLED']} emptyTitle="Nothing rejected" emptyText="If an order fails a check, you’ll see the reason here." />
    </Screen>
  );
}
