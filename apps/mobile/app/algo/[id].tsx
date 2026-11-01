import { useLocalSearchParams } from 'expo-router';
import { AlgoDetailScreen } from '@/algo-screens';

export default function Strategy() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AlgoDetailScreen id={id} />;
}
