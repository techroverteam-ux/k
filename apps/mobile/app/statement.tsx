import { StatementBlock } from '@/screens';
import { Screen, T } from '@/ui';

export default function Statement() {
  return (
    <Screen back title="Bill download">
      <StatementBlock />
      <T v="xs">The PDF opens in your browser. The download link works for 2 minutes. Balances are virtual and fills are simulated.</T>
    </Screen>
  );
}
