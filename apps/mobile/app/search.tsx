import { useLocalSearchParams } from 'expo-router';
import { SearchView } from '@/screens';

/** Instrument search. `?mode=add` (from the Add script button) shows it as "Add script" with a Done button. */
export default function Search() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  return <SearchView addMode={mode === 'add'} />;
}
