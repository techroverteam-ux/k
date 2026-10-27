import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { homeFor, useAuth } from '@/auth';

export default function Index() {
  const { me, ready } = useAuth();
  if (!ready) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;
  return <Redirect href={me ? homeFor(me.role) : '/login'} />;
}
