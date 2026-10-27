import { z } from 'zod';

/**
 * Every editable business setting lives here with a schema and a safe default.
 * Values are stored in Postgres (config_versions) and changed through maker-checker.
 * NEVER put secrets (keys, passwords, payment credentials) in here.
 */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
const minor = z
  .string()
  .regex(/^\d{1,15}$/, 'Amount in paise as an integer string')
  .describe('paise');

export const CONFIG_REGISTRY = {
  'demo.enabled': { schema: z.boolean(), default: true, description: 'Allow self-service demo (paper) accounts via OTP.' },
  'demo.initialBalanceMinor': {
    schema: minor,
    default: '50000000',
    description: 'Virtual opening balance for demo accounts, in paise (50000000 = ₹5,00,000).',
  },
  'trading.intradayMarginBps': { schema: z.number().int().min(1).max(10000), default: 20, description: 'Intraday margin as basis points of order value.' },
  'trading.carryForwardMarginBps': { schema: z.number().int().min(1).max(10000), default: 167, description: 'Carry-forward margin in basis points of order value.' },
  'trading.maxQtyPerOrder': { schema: z.number().int().min(1).max(100000), default: 50, description: 'Max quantity in a single order ("punch qty").' },
  'trading.maxQtyPerInstrument': { schema: z.number().int().min(1).max(1000000), default: 150, description: 'Max absolute open position per instrument.' },
  'trading.minQty': { schema: z.number().int().min(1), default: 1, description: 'Minimum order quantity.' },
  'trading.brokerageBps': { schema: z.number().int().min(0).max(500), default: 3, description: 'Brokerage per side, basis points of turnover.' },
  'trading.enforceMarketHours': { schema: z.boolean(), default: true, description: 'Reject orders outside market sessions (and on weekends and listed holidays).' },
  'trading.marketHolidays': {
    schema: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100),
    default: [],
    description: 'Exchange holidays (YYYY-MM-DD, IST) when no orders are accepted.',
  },
  'trading.marketHours': {
    schema: z.record(z.string(), z.object({ open: hhmm, close: hhmm })),
    default: { NSE: { open: '09:17', close: '15:30' }, MCX: { open: '09:02', close: '23:30' }, INTL: { open: '03:32', close: '02:30' } },
    description: 'Market sessions per exchange (IST, HH:MM). A close earlier than the open means the session runs past midnight.',
  },
  'payments.maxDepositMinor': { schema: minor, default: '1000000000', description: 'Max single deposit request (paise).' },
  'payments.maxWithdrawalMinor': { schema: minor, default: '500000000', description: 'Max single withdrawal request (paise).' },
  'payments.brokerMaySubmit': { schema: z.boolean(), default: true, description: 'Brokers may submit payment requests for their own traders.' },
  'broker.commissionShareBps': { schema: z.number().int().min(0).max(10000), default: 5000, description: "Broker's share of brokerage from assigned traders." },
  'security.adminMfaRequired': { schema: z.boolean(), default: true, description: 'Super Admins must use TOTP MFA.' },
  'security.maxFailedLogins': { schema: z.number().int().min(3).max(20), default: 5, description: 'Failed logins before temporary lockout.' },
  'security.lockoutMinutes': { schema: z.number().int().min(1).max(1440), default: 15, description: 'Lockout duration.' },
  'logs.activityRetentionDays': { schema: z.number().int().min(30).max(3650), default: 365, description: 'Keep per-request activity logs (time, IP, device, action) in the database for this many days. Older days are kept in the archive.' },
  'logs.requireArchiveBeforePurge': { schema: z.boolean(), default: true, description: 'Only delete activity logs for days that have been archived with a checksum.' },
  'logs.quietOperations': { schema: z.array(z.string().regex(/^[A-Za-z]{1,60}$/)).max(30), default: [], description: 'Read-only operations NOT written to the activity log (e.g. high-frequency polling such as "quotes"). Mutations are always logged.' },
  'ui.tickerMessages': {
    schema: z.array(z.string().max(200)).max(20),
    default: ['Paper trading: all orders are simulated and are not sent to any exchange.'],
    description: 'Scrolling announcements shown to traders.',
  },
  'ui.termsRules': {
    schema: z.array(z.string().max(500)).max(20),
    default: [
      'This workspace uses SIMULATED (paper) trading. Orders are never sent to an exchange and no real money is at risk.',
      'Prices come from a simulated feed for practice; they may differ from live market prices.',
      'Virtual balances have no cash value and cannot be withdrawn as money.',
      'Stop-loss (SL) and take-profit (TP) orders trigger on the last traded price (LTP) and are filled at the LTP.',
      'Orders are accepted only during market hours: NSE from 9:17 AM, MCX from 9:02 AM and international markets from 3:32 AM (IST). Exact sessions are shown on the order screen.',
      'For security and audit, we record the time, IP address and device of every sign-in and action on your account.',
    ],
    description: 'Rules shown on first login; acceptance is recorded.',
  },
  'signup.enabled': { schema: z.boolean(), default: true, description: 'Allow people to apply for a trader account from the login screen (verified by mobile OTP; a Super Admin must approve it).' },
  'ui.helplineUrl': { schema: z.string().url().or(z.literal('')), default: '', description: 'Support link (e.g. WhatsApp business link).' },
} as const;

export type ConfigKey = keyof typeof CONFIG_REGISTRY;
export type ConfigValue<K extends ConfigKey> = z.infer<(typeof CONFIG_REGISTRY)[K]['schema']>;

export function isConfigKey(k: string): k is ConfigKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_REGISTRY, k);
}
