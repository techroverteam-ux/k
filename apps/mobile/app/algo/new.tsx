import { useLocalSearchParams } from 'expo-router';
import { AlgoEditScreen } from '@/algo-screens';

export default function NewStrategy() {
  const { t, instrument } = useLocalSearchParams<{ t?: string; instrument?: string }>();
  return <AlgoEditScreen templateKey={t} instrumentId={instrument} />;
}
