import { useState } from 'react';
import { useAuth } from '@/auth';
import { ConsentList, LoginHistoryList } from '@/screens';
import { Screen, T, Tabs } from '@/ui';

export default function Logins() {
  const { me } = useAuth();
  const [tab, setTab] = useState<'in' | 'consent'>('in');
  return (
    <Screen back title="Login history">
      {me?.role === 'TRADER' && <Tabs value={tab} onChange={setTab} items={[{ k: 'in', label: 'Sign-ins' }, { k: 'consent', label: 'Rules accepted' }]} />}
      <T v="sm" c="text2">{tab === 'in' ? 'Every sign-in and failed attempt on your account, with time, IP address and device. If you don’t recognise one, change your password.' : 'You accept the trading rules each time you sign in. Each acceptance is kept with the time, IP address and device.'}</T>
      {tab === 'in' ? <LoginHistoryList /> : <ConsentList />}
    </Screen>
  );
}
