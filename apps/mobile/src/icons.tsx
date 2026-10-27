/** Same original line-icon set as the web app (apps/web/components/icons.tsx). */
import Svg, { G, Path, Rect } from 'react-native-svg';
import type { ColorValue } from 'react-native';

export const ICON_PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  briefcase: 'M3 8h18v12H3z M8 8V5h8v3 M3 13h18',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 0 13-3v3 M16.5 13.5h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M2 21c1-3.6 3.6-5.5 7-5.5s6 1.9 7 5.5 M16 3.5a4 4 0 0 1 0 7.5 M18 15.5c2 .6 3.4 2.4 4 5.5',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z M9 12l2 2 4-4',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Z M10 21h4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z M20 20l-4-4',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  rupee: 'M6 4h12M6 9h12M9 4c6 0 6 10 0 10H6l8 7',
  percent: 'M19 5 5 19M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z M12 16v-5M12 8h.01',
  wifiOff: 'M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8a15 15 0 0 0-11-3.7M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.3-1.7M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M3 3l18 18',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6l2-8Z',
  lock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4',
  device: 'M7 2h10v20H7z M11 18h2',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  file: 'M14 3H6v18h12V7l-4-4Z M14 3v4h4 M9 13h6M9 17h6',
  key: 'M15 7a4 4 0 1 1-3.5 6L4 20.5V17h3v-3h3l1.5-1.5A4 4 0 0 1 15 7Z',
  book: 'M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2V5Z M4 19a2 2 0 0 1 2-2h14',
  chat: 'M4 5h16v11H8l-4 4V5Z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  sound: 'M4 9h4l5-4v14l-5-4H4z M16.5 8.5a5 5 0 0 1 0 7 M19 6a8.5 8.5 0 0 1 0 12',
  type: 'M5 6V4h14v2M12 4v16M9 20h6',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7z M7 12h7a4 4 0 0 1 0 8H7z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  calendar: 'M4 6h16v14H4z M4 10h16 M8 3v4M16 3v4',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
} as const;
export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 22, color, strokeWidth = 1.75 }: { name: IconName; size?: number; color: ColorValue; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color as string} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <Path d={ICON_PATHS[name]} />
    </Svg>
  );
}

/** The K brand mark (same paths as the web logo and the app icon). */
export const K_STEM = 'M9 8.6C9 7.7 9.7 7 10.6 7h1.3c.9 0 1.6.7 1.6 1.6v14.8c0 .9-.7 1.6-1.6 1.6h-1.3c-.9 0-1.6-.7-1.6-1.6Z';
export const K_ARMS = 'M13.5 15.1 20.2 7.6c.4-.4.9-.6 1.4-.6h3.2c.5 0 .7.6.4 1l-7 7.8 7.2 8.2c.3.4.1 1-.4 1h-3.2c-.5 0-1.1-.2-1.4-.6l-6.9-7.6Z';
export function Logo({ size = 32, brand }: { size?: number; brand: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Rect width="32" height="32" rx="9" fill={brand} />
      <G transform="translate(-0.9 0)" fill="#fff"><Path d={K_STEM} /><Path d={K_ARMS} /></G>
    </Svg>
  );
}
