import { useLocalSearchParams } from 'expo-router';
import { SearchView } from '@/screens';

/** Instrument search. `?mode=add` opens the simple contract picker; additions save immediately. */
export default function Search() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  return <SearchView addMode={mode === 'add'} />;
}
