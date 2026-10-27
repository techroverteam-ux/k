/**
 * Market session checks (IST). Pure functions so they can be unit-tested with any clock.
 * A session whose close is earlier than its open runs past midnight (e.g. 03:32–02:30).
 */
export type Sessions = Record<string, { open: string; close: string }>;

export interface SessionStatus {
  exchange: string;
  open: string;
  close: string;
  isOpen: boolean;
  /** Human message for closed markets, e.g. "Market closed. NSE opens at 09:17 IST." */
  message: string | null;
}

const IST_OFFSET_MS = 5.5 * 3600_000;

function istParts(now: Date) {
  const t = new Date(now.getTime() + IST_OFFSET_MS);
  const hhmm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const date = t.toISOString().slice(0, 10);
  const prev = new Date(t.getTime() - 86_400_000);
  return { hhmm, day: t.getUTCDay(), date, prevDay: prev.getUTCDay(), prevDate: prev.toISOString().slice(0, 10) };
}

const tradingDay = (day: number, date: string, holidays: string[]) => day !== 0 && day !== 6 && !holidays.includes(date);

export function sessionStatus(exchange: string, sessions: Sessions, holidays: string[], now = new Date()): SessionStatus {
  const h = sessions[exchange];
  if (!h) return { exchange, open: '', close: '', isOpen: true, message: null }; // no session configured → not restricted
  const p = istParts(now);
  let isOpen: boolean;
  if (h.open <= h.close) {
    isOpen = tradingDay(p.day, p.date, holidays) && p.hhmm >= h.open && p.hhmm <= h.close;
  } else {
    // Overnight: the part after midnight belongs to the previous trading day's session.
    isOpen = (tradingDay(p.day, p.date, holidays) && p.hhmm >= h.open) || (tradingDay(p.prevDay, p.prevDate, holidays) && p.hhmm <= h.close);
  }
  let message: string | null = null;
  if (!isOpen) {
    if (!tradingDay(p.day, p.date, holidays) && !(h.open > h.close && tradingDay(p.prevDay, p.prevDate, holidays) && p.hhmm <= h.close))
      message = `Market closed today (${p.day === 0 || p.day === 6 ? 'weekend' : 'holiday'}). ${exchange} trades ${h.open}–${h.close} IST on trading days.`;
    else message = `Market closed. ${exchange} trades ${h.open}–${h.close} IST.`;
  }
  return { exchange, open: h.open, close: h.close, isOpen, message };
}
