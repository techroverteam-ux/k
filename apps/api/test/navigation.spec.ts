import 'reflect-metadata';
import { PgDialect } from 'drizzle-orm/pg-core';
import { mergeNavigationCounts, notificationDestination } from '../src/notifications/navigation';
import { NotificationsService } from '../src/notifications/notifications.service';
import type { Actor } from '../src/common/context';

const actor = (role: Actor['role']): Actor => ({ userId: 'viewer-id', role, sessionId: 'session', mfaVerified: true });
const dialect = new PgDialect();

describe('navigation badge semantics', () => {
  it.each(['TRADER', 'BROKER', 'SUPER_ADMIN'] as const)('counts all five unread notifications for %s', (role) => {
    expect(mergeNavigationCounts(role, {}, [{ kind: 'security.new_device', count: 3 }, { kind: 'unknown.event', count: 2 }])).toEqual(expect.arrayContaining([{ href: '/notifications', count: 5 }, { href: '/account', count: 3 }]));
  });
  it('does not count an approval event twice or resurrect an already resolved queue', () => {
    const updates = [{ kind: 'payment.review', count: 10 }, { kind: 'account.pending', count: 3 }];
    const counts = mergeNavigationCounts('SUPER_ADMIN', { '/admin/payments': 2, '/admin/users': 1 }, updates);
    expect(counts).toContainEqual({ href: '/admin/payments', count: 2 });
    expect(counts).toContainEqual({ href: '/admin/users', count: 1 });
    expect(mergeNavigationCounts('SUPER_ADMIN', { '/admin/payments': 0 }, updates).find((b) => b.href === '/admin/payments')).toBeUndefined();
  });
  it('combines independent pending requests and unread completed updates', () => {
    expect(mergeNavigationCounts('TRADER', { '/trader/funds': 2 }, [{ kind: 'payment.posted', count: 3 }])).toContainEqual({ href: '/trader/funds', count: 5 });
  });
  it('routes updates only to pages accessible to the role', () => {
    expect(notificationDestination('TRADER', 'payment.posted')).toBe('/trader/funds');
    expect(notificationDestination('BROKER', 'payment.posted')).toBe('/broker/requests');
    expect(notificationDestination('SUPER_ADMIN', 'payment.review')).toBe('/admin/payments');
    expect(notificationDestination('BROKER', 'risk.autocut')).toBe('/broker/traders');
    expect(notificationDestination('TRADER', 'risk.warning')).toBe('/trader/positions');
  });
});

describe('navigation count scope', () => {
  const fixture = () => {
    const chain: any = { from: () => chain, where: jest.fn(() => chain), groupBy: jest.fn().mockResolvedValue([]) };
    const db = { select: jest.fn(() => chain), execute: jest.fn().mockResolvedValue({ rows: [{ orders: 2, positions: 3, funds: 4, traders: 2, requests: 4, accounts: 5, payments: 2, fees: 1, configuration: 1, resets: 1 }] }) };
    return { db, chain, service: new NotificationsService({ db } as any) };
  };
  it('limits trader counts to the current user, current trading mode and visible history', async () => {
    const { db, chain, service } = fixture();
    const badges = await service.navigationCounts(actor('TRADER'));
    expect(badges).toContainEqual({ href: '/trader/orders', count: 2 });
    const query = dialect.sqlToQuery(db.execute.mock.calls[0][0]);
    expect(query.params).toEqual(['viewer-id', 'viewer-id', 'viewer-id']);
    expect(query.sql).toMatch(/o.mode = u.mode/); expect(query.sql).toMatch(/data_since/);
    expect(dialect.sqlToQuery(chain.where.mock.calls[0][0]).params).toContain('viewer-id');
  });
  it('limits broker queues to traders assigned to that broker', async () => {
    const { db, service } = fixture();
    expect(await service.navigationCounts(actor('BROKER'))).toContainEqual({ href: '/broker/traders', count: 2 });
    const query = dialect.sqlToQuery(db.execute.mock.calls[0][0]);
    expect(query.params).toEqual(['viewer-id', 'viewer-id', 'viewer-id', 'viewer-id']);
    expect(query.sql.match(/broker_id/g)).toHaveLength(3);
  });
  it('includes pending account deletions and excludes expired platform wipes', async () => {
    const { db, service } = fixture(); await service.navigationCounts(actor('SUPER_ADMIN'));
    const query = dialect.sqlToQuery(db.execute.mock.calls[0][0]);
    expect(query.sql).toContain('target_user_id IS NOT NULL');
    expect(query.sql).toContain('expires_at > now()');
  });
  it("acknowledges only this user's matching section updates, preserving notifications arriving later", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const db = { selectDistinct: jest.fn(() => ({ from: () => ({ where: () => Promise.resolve([{ kind: 'payment.posted' }, { kind: 'security.new_device' }]) }) })), update: jest.fn(() => ({ set: () => ({ where }) })) };
    const service = new NotificationsService({ db } as any);
    await service.markNavigationRead(actor('TRADER'), '/admin/payments');
    expect(db.update).not.toHaveBeenCalled();
    await service.markNavigationRead(actor('TRADER'), '/trader/funds');
    expect(db.update).toHaveBeenCalledTimes(1);
    const query = dialect.sqlToQuery(where.mock.calls[0][0]);
    expect(query.params).toContain('viewer-id'); expect(query.params).toContain('payment.posted');
    expect(query.params).not.toContain('security.new_device');
    expect(query.sql).toMatch(/created_at.*<=/);
    expect(query.params.some((p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p))).toBe(true);
  });
});
