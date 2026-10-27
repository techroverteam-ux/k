import { BellButton, RequestsList } from '@/screens';
import { Screen, T } from '@/ui';

export default function Requests() {
  return (
    <Screen title="Fund requests" right={<BellButton />}>
      <T v="sm" c="text2">Requests for your traders. A Super Admin approves each one. Open a trader to raise a new request.</T>
      <RequestsList showName />
    </Screen>
  );
}
