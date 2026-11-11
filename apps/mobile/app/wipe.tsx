import { AccountResetPanel } from '@/resets';
import { Screen } from '@/ui';

export default function Wipe() {
  return <Screen back title="Account reset"><AccountResetPanel allowRequest /></Screen>;
}
