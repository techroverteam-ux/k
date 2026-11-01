import { useLocalSearchParams } from 'expo-router';
import { AlgoEditScreen } from '@/algo-screens';

export default function EditStrategy() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AlgoEditScreen id={id} />;
}
