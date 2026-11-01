import { useLocalSearchParams } from 'expo-router';
import { AdminUserScreen } from '@/admin-screens';

export default function AdminUser() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AdminUserScreen id={id} />;
}
