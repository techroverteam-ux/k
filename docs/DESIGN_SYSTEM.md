# Design system and UI inventory

The design takes Groww as its reference for usability: calm white surfaces, one green accent, lists separated by dividers instead of everything in cards, big clear numbers, and a stock page with a docked order panel. The palette, logo mark, icons and copy are **original**. No Groww assets, logo or branding are used.

## Brand: The K

- One character only: a geometric **K** (stem + two arms) in a rounded tile, brand green `#08a77b`, white glyph. Paths live in `apps/web/components/icons.tsx` (`K_STEM`, `K_ARMS`) and `apps/mobile/src/icons.tsx`; the same paths render the statement PDF header.
- Assets: `apps/web/app/icon.svg` (favicon), `apps/web/app/apple-icon.png`, `apps/mobile/assets/images/{icon,adaptive-icon,splash-icon,favicon}.png` (app.json wires them up; the Android adaptive icon background is the brand green).
- **Animated splash** after every sign-in (and when the app opens with a saved session): tile pops in → stem rises → arms open with a ring pulse → name and progress bar → lifts away (~2.2 s). With *reduce motion* it is a short fade. Web: `components/Splash.tsx`; mobile: `src/splash.tsx`. The native launch screen (expo-splash-screen) shows the static K first.

## Tokens

The web tokens live in `apps/web/app/globals.css` (CSS variables, with light and dark themes). The native tokens live in `apps/mobile/src/theme.ts` (`useTheme()`, `S`, `R`, `FS`, `CTL`). Both use the same values.

| Token | Light | Dark | Use |
|---|---|---|---|
| bg / bg-2 / bg-3 | `#ffffff` / `#f7f8fa` / `#eff1f4` | `#121418` / `#181b20` / `#20242b` | surfaces, hover, skeleton |
| line / line-2 | `#ebedf0` / `#dcdfe5` | `#262a32` / `#343944` | dividers, control borders |
| text / text-2 / text-3 | `#262a35` / `#697080` / `#9a9fac` | `#e9ebef` / `#a3a9b6` / `#767c89` | primary, secondary, metadata |
| brand (= positive) | `#08a77b` | `#22b98b` | primary actions, gains, selected states |
| negative | `#e14f3b` | `#ff6b57` | sell, losses, destructive actions |
| warn / info | `#b97300` / `#3a66d1` | `#f0b545` / `#7c9df0` | pending, paper-trading pill / informational notes |

- **Type:** Inter on web, the system font on native. Scale is 12 · 13 · 14 · 16 · 18 · 20 · 24 · 32 with weights 400/500/600. Every price, quantity and percentage uses **tabular numerals**.
- **Spacing:** a 4/8 grid: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40.
- **Radii:** 4 (badges) · 6 · 8 (buttons and inputs) · 12 (panels) · 16–20 (mobile sheets) · pill (chips).
- **Sizes:** controls 40 px on web and 44 px on native (32/34 small, 48/52 large), list rows 56/64 px, icons 20/24 px, touch targets at least 44 px.
- **Elevation:** `e1` for the order panel and tile hover, `e2` for menus, dialogs and toasts only.
- **Breakpoints (web):** at 1180 px the right rail drops below the content; at 1024 px the sidebar collapses to icons and "Created" columns hide; at 720 px phone layout applies (bottom navigation, tables become stacked rows, movers scroll sideways, sticky Buy/Sell bar, dialogs become bottom sheets).
- **Gains and losses** always show an arrow and a sign (`↑ +12.40`), so they never rely on colour alone.
- **Motion:** price ticks get a brief tint; dialogs and sheets fade in or slide up. Everything respects `prefers-reduced-motion`.

## Components

**Web** (`apps/web/components`):
- `ui.tsx`: Toast, Dialog (with focus trap), Confirm, StepUp, SkeletonRows, State/Empty/ErrorState (error, offline and permission variants), Status, Change, Metrics, Tabs, Chips, PageHead, SectionHead, Mark, Pager, RowMenu
- `icons.tsx`: the line-icon set and the logo
- `Shell.tsx`: top bar, instrument search, sidebar, bottom navigation, offline banner, paper-trading pill
- `trading.tsx`: portfolio summary, payment dialog, watchlist, movers, orders, positions, ledger
- `accounts.tsx`: person cell, create-user dialog, account detail
- `admin.tsx`: the account action dialogs

**Native** (`apps/mobile/src`):
- `ui.tsx`: T, Screen, Header, PaperPill, LiveBanner, IconButton, Button, Field, SearchBox, Tabs, Chips, ListRow, Mark, IconMark, Badge, StatusBadge, Change, Metrics, Lines, Skeleton, Empty, ErrorState, Notice, Sheet, StepUpHost, ToastHost
- `screens.tsx`: summary, payment sheet, movers, watchlist, orders, positions, ledger, requests, profile, notifications, terms gate, account detail
- `icons.tsx`: the same icon paths as web
- `tabs.ts`: shared bottom-tab styling

## Screen inventory

| Role | Web route | Mobile screen | Priority |
|---|---|---|---|
| All | `/login` (sign in, MFA code, demo OTP) | `login`, `demo` | P0 |
| All | `/account` (profile, 2-step, password, devices) | Profile tab | P1 |
| All | `/notifications` | `notifications` | P2 |
| Super Admin | `/mfa-setup` | (web only) | P0 |
| Trader | `/trader` Home: balance, movers, watchlist rail | Home tab | P0 |
| Trader | `/trader/watchlist` | Watchlist tab | P0 |
| Trader | `/trader/instrument/[id]` stock page + order panel | `instrument/[id]` + order sheet | P0 |
| Trader | `/trader/positions`, `/trader/orders` | Portfolio tab (positions and orders); `orders` route kept for deep links | P0 |
| Trader | `/trader/funds` balance, P&L by period, transactions, fund requests | Funds tab | P1 |
| Broker | `/broker` dashboard | Dashboard tab | P1 |
| Broker | `/broker/traders`, `/broker/traders/[id]` | Traders tab, `trader-detail/[id]` | P1 |
| Broker | `/broker/requests`, `/broker/commissions` | Requests tab (commissions on web) | P2 |
| Super Admin | `/admin` overview + risk alerts | Overview tab | P1 |
| Super Admin | `/admin/users`, `/admin/users/[id]` (account and ledger view) | (web only) | P1 |
| Super Admin | `/admin/payments` | Approvals tab | P0 |
| Super Admin | `/admin/config`, `/admin/audit`, `/admin/reconciliation` | (web only) | P1 |

All routes from the previous version still exist. New routes: `/trader/watchlist`, `/broker/traders`, `/admin/users/[id]`, and mobile `watchlist`, `(broker)/traders` and `notifications`. No GraphQL operation or backend contract was changed for styling.

## Screen states covered

- **Loading:** skeleton rows everywhere.
- **Empty:** a specific message, plus a next action where there is one.
- **Search with no results.**
- **Validation:** inline, field by field.
- **API error:** "Couldn't load this" with a retry button.
- **Offline:** detected through the browser's offline event or a dropped WebSocket, shown as a banner.
- **Permission denied:** a `FORBIDDEN` response shows "You don't have access to this".
- **Disabled controls:** shown while a form is invalid or a request is in flight.
- **Pending:** "In review" and "Open" badges.
- **Success and failure:** toasts appear only after the server confirms.
- **Confirmation step:** used for orders, approvals, cancellations, suspensions and password resets.

## Visual validation (actually executed)

Screenshots were taken with Playwright against the running API:

- **Web** at 1440×900, 1024×768 and 390×844: login, trader (home, watchlist, stock page, order confirmation, positions, orders, funds), broker (dashboard, traders, trader detail, requests, commissions), admin (overview, accounts, account detail, transactions, configuration, audit, reconciliation), profile and notifications.
- **Mobile:** rendered with Expo's web target and react-native-web at 390×844 and 360×740 (trader: login, home, watchlist, stock, order sheet, review, portfolio, funds, profile; broker: dashboard, traders, requests, trader detail; admin: overview, approvals, profile). The Android and iOS bundles also export successfully.

Fixes made after each pass:
- watchlist table overflowing on phones → replaced by list rows there
- stacked cards for tables on phones
- crowded admin row actions → overflow menu
- chart labels overlapping the line → moved below the chart
- tab-bar labels clipped on mobile → explicit item and icon heights
- double space in the paper-trading pill

**Not done:** checks on a real iOS simulator or Android emulator (not available in the build sandbox), and dark-mode screenshots. Dark tokens are defined but haven't been visually reviewed.

## Known gaps

- Chart ranges 1W/1M/1Y are disabled because the simulated feed keeps no price history; they're labelled as unavailable rather than faked.
- On mobile, Super Admin account management, configuration, audit and reconciliation are web-only, and the app says so.
- Brokers can't create traders from mobile (web only).
- The mobile watchlist removes items with a long-press, which is hinted on screen; a swipe action would be a nice addition.
