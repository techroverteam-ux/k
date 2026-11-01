import { LedgerList } from '@/screens';
import { Screen } from '@/ui';

export default function Ledger() {
  return <Screen back title="Ledger history" scroll={false}><LedgerList virtual /></Screen>;
}
