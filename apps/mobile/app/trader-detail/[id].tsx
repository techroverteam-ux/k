import { useLocalSearchParams } from 'expo-router';
import { AccountDetailView } from '@/screens';

export default function TraderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AccountDetailView id={id} />;
}
