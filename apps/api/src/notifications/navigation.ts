import type { Actor } from '../common/context';

/** One destination per update; unknown kinds remain available in Notifications. */
export function notificationDestination(role: Actor['role'], kind: string): string | undefined {
  if (kind.startsWith('security.')) return '/account';
  if (role === 'SUPER_ADMIN') {
    if (kind.startsWith('payment.')) return '/admin/payments';
    if (kind.startsWith('fees.')) return '/admin/fees';
    if (kind.startsWith('config.')) return '/admin/config';
    if (kind.startsWith('platform.')) return '/admin/reset';
    if (kind.startsWith('user.') || kind === 'account.pending' || kind.startsWith('risk.')) return '/admin/users';
    if (kind.startsWith('reconciliation.')) return '/admin/reconciliation';
    if (kind.startsWith('audit.')) return '/admin/audit';
    if (kind.startsWith('login.') || kind.startsWith('consent.')) return '/admin/logins';
    if (kind.startsWith('activity.')) return '/admin/activity';
    if (kind.startsWith('instrument.') || kind.startsWith('lot.')) return '/admin/lots';
  } else if (role === 'BROKER') {
    if (kind.startsWith('payment.')) return '/broker/requests';
    if (kind.startsWith('commission.')) return '/broker/commissions';
    if (kind.startsWith('user.') || kind.startsWith('risk.') || kind.startsWith('account.')) return '/broker/traders';
    if (kind.startsWith('fees.')) return '/broker/traders';
  } else {
    if (kind.startsWith('payment.') || kind.startsWith('fees.') || kind === 'account.wiped') return '/trader/funds';
    if (kind.startsWith('order.')) return '/trader/orders';
    if (kind.startsWith('position.') || kind.startsWith('risk.')) return '/trader/positions';
    if (kind.startsWith('watchlist.') || kind.startsWith('instrument.')) return '/trader/watchlist';
  }
  return undefined;
}

/** These events are represented by current queue records, so never count them twice. */
export function isQueueNotification(role: Actor['role'], kind: string): boolean {
  return role === 'SUPER_ADMIN' && ['payment.review', 'fees.review', 'fees.payee_pending', 'user.review', 'account.pending', 'user.delete_requested', 'platform.wipe_requested'].includes(kind);
}

export function mergeNavigationCounts(role: Actor['role'], pending: Record<string, number>, updates: { kind: string; count: number }[]) {
  const counts: Record<string, number> = { ...pending, '/notifications': updates.reduce((n, row) => n + row.count, 0) };
  for (const row of updates) {
    const href = notificationDestination(role, row.kind);
    if (href && !isQueueNotification(role, row.kind)) counts[href] = (counts[href] ?? 0) + row.count;
  }
  return Object.entries(counts).filter(([, count]) => count > 0).map(([href, count]) => ({ href, count }));
}
