import { LedgerList } from '@/screens';
import { Screen } from '@/ui';

export default function Ledger() {
  return <Screen back title="Ledger history"><LedgerList /></Screen>;
}
