import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { homeFor, useAuth } from '@/auth';
import { S } from '@/theme';
import { T } from '@/ui';

export default function Index() {
  const { me, ready } = useAuth();
  // Opening takes more than a moment only when the server is waking up: say so.
  const [slow, setSlow] = useState(false);
  useEffect(() => { const h = setTimeout(() => setSlow(true), 3_000); return () => clearTimeout(h); }, []);
  if (!ready) return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: S[3], padding: S[6] }}>
      <ActivityIndicator />
      {slow && <T c="text2" style={{ textAlign: 'center' }}>Connecting to the server… It can take up to a minute if it was asleep. You’ll stay signed in.</T>}
    </View>
  );
  return <Redirect href={me ? homeFor(me.role) : '/login'} />;
}
