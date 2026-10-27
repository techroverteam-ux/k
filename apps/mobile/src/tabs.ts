import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from './theme';
import { FS } from './theme';

/** Shared bottom-tab styling for every role (explicit height so labels never clip). */
export function useTabScreenOptions(t: Theme) {
  const insets = useSafeAreaInsets();
  return {
    headerShown: false,
    tabBarActiveTintColor: t.brand,
    tabBarInactiveTintColor: t.text3,
    tabBarStyle: { backgroundColor: t.bg, borderTopColor: t.line, height: 64 + insets.bottom, paddingBottom: insets.bottom },
    tabBarItemStyle: { height: 64, paddingTop: 6, paddingBottom: 6 },
    tabBarIconStyle: { height: 26 },
    tabBarLabelStyle: { fontSize: FS.xs - 1, lineHeight: 14, fontWeight: '500' as const },
  };
}
