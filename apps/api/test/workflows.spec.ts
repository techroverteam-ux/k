import 'reflect-metadata';
import { authenticator } from 'otplib';
import ExcelJS from 'exceljs';
import { AuthService } from '../src/auth/auth.service';
import { FeesService } from '../src/fees/fees.service';
import { renderCommission } from '../src/users/commission-export';

jest.mock('../src/config/env', () => ({ env: () => ({ HASH_PEPPER: 'test-pepper'.repeat(5), JWT_STEPUP_SECRET: 'test-secret'.repeat(5) }) }));
jest.mock('../src/common/crypto', () => ({ ...jest.requireActual('../src/common/crypto'), decryptSecret: (s: string) => s }));

function fixture(role = 'SUPER_ADMIN') {
  const secret = authenticator.generateSecret();
  const user = { id: 'test-user', username: 'test.user', status: 'ACTIVE', role, mfaEnabled: true, mfaSecretEnc: secret };
  const challenge = { id: 'challenge', attempts: 0 };
  const results: unknown[][] = [];
  const db: any = {
    select: jest.fn(() => {
      const value = results.shift() ?? [];
      const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain, for: () => Promise.resolve(value), then: (resolve: any) => Promise.resolve(value).then(resolve) };
      return chain;
    }),
    update: jest.fn(() => ({ set: jest.fn((value) => { updates.push(value); return { where: jest.fn().mockResolvedValue([]), returning: jest.fn().mockResolvedValue([]) }; }) })),
    insert: jest.fn(() => ({ values: jest.fn().mockResolvedValue([]) })), execute: jest.fn().mockResolvedValue([]),
  };
  const updates: any[] = [];
  const passwords = { assertStrong: jest.fn(), hash: jest.fn().mockResolvedValue('new-hash') };
  const sms = { sendOtp: jest.fn(), isDev: true };
  const audit = { record: jest.fn(), recordStandalone: jest.fn() };
  const notifications = { notify: jest.fn() };
  const service = new AuthService({ db, serializable: (fn: any) => fn(db) } as any, passwords as any, audit as any, {} as any, {} as any, notifications as any, sms as any);
  jest.spyOn(service, 'revokeTrustedDevices').mockResolvedValue([]);
  return { service, results, user, secret, challenge, updates, sms, passwords, audit, notifications };
}

describe('authenticator password recovery', () => {
  it.each(['SUPER_ADMIN', 'BROKER', 'TRADER'])('resets %s with an authenticator and revokes all sessions and trusted devices', async (role) => {
    const f = fixture(role); f.results.push([f.user], [f.challenge], []);
    expect(await f.service.resetPassword('test.user', authenticator.generate(f.secret), 'Strong-New-Pass-9', '127.0.0.1')).toBe(true);
    expect(f.updates).toEqual(expect.arrayContaining([expect.objectContaining({ passwordHash: 'new-hash' }), expect.objectContaining({ revokedReason: 'password_reset' }), expect.objectContaining({ consumedAt: expect.any(Date) })]));
    expect(f.service.revokeTrustedDevices).toHaveBeenCalled();
    expect(f.sms.sendOtp).not.toHaveBeenCalled();
  });
  it('rejects a reused authenticator code even in a new reset request', async () => {
    const f = fixture(); f.results.push([f.user], [f.challenge], [{ id: 'consumed-reset' }]);
    await expect(f.service.resetPassword('test.user', authenticator.generate(f.secret), 'Strong-New-Pass-9', '127.0.0.1')).rejects.toThrow(/Invalid authentication/);
    expect(f.passwords.hash).not.toHaveBeenCalled();
    expect(f.updates).toContainEqual({ attempts: 1 });
  });
  it.each(['missing user', 'not enrolled', 'inactive', 'expired', 'too many attempts', 'wrong code'])('rejects %s without changing the password', async (reason) => {
    const f = fixture();
    if (reason === 'not enrolled') f.user.mfaEnabled = false;
    if (reason === 'inactive') f.user.status = 'SUSPENDED';
    if (reason === 'too many attempts') f.challenge.attempts = 5;
    f.results.push(reason === 'missing user' ? [] : [f.user], reason === 'expired' ? [] : [f.challenge], []);
    const wrong = authenticator.generate(authenticator.generateSecret());
    await expect(f.service.resetPassword('test.user', reason === 'wrong code' ? wrong : authenticator.generate(f.secret), 'Strong-New-Pass-9', '127.0.0.1')).rejects.toThrow(/Invalid authentication/);
    expect(f.passwords.hash).not.toHaveBeenCalled();
  });
  it('starts recovery with no SMS, email or development code', async () => {
    const f = fixture(); f.results.push([{ c: 0 }]);
    const r = await f.service.requestPasswordReset('test.user', '127.0.0.1');
    expect(r.devCode).toBeNull(); expect(r.message).toMatch(/authenticator/); expect(f.sms.sendOtp).not.toHaveBeenCalled();
  });
});

describe('broker exports', () => {
  const report = { perMiniLotMinor: 100n, perMegaLotMinor: 500n, totalMinor: 700n, lines: [{ username: '=unsafe-formula', miniLots: 2, megaLots: 1, commissionMinor: 700n }] };
  it('produces a real Excel workbook with numeric commission amounts and no trader brokerage', async () => {
    const file = await renderCommission(report, '2026-11', 'XLSX');
    const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(file.base64, 'base64') as any);
    const sheet = book.worksheets[0];
    expect(sheet.getCell('A6').value).toBe('=unsafe-formula');
    expect(sheet.getCell('D6').value).toBe(7);
    expect(sheet.getCell('D7').value).toBe(7);
    expect(JSON.stringify(sheet.model)).not.toMatch(/brokerage/i);
  });
  it('produces a multipage PDF for a long report', async () => {
    const file = await renderCommission({ ...report, lines: Array.from({ length: 100 }, () => report.lines[0]) }, '2026-11', 'PDF');
    const data = Buffer.from(file.base64, 'base64').toString('latin1');
    expect(data.startsWith('%PDF')).toBe(true);
    expect((data.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });
});

describe('payment destination validation', () => {
  const service = new FeesService({} as any, {} as any, {} as any);
  const valid = { kind: 'BANK' as const, label: 'Company bank', accountName: 'Account Holder', bankName: 'Bank Name', branch: 'Main branch', accountNumber: '123456789', ifsc: 'HDFC0001234' };
  it.each(['label', 'accountName', 'bankName', 'branch'])('rejects digits in %s at the API boundary', async (key) => {
    await expect(service.addPayee({ userId: 'admin' } as any, { ...valid, [key]: 'Name 123' }, '127.0.0.1')).rejects.toThrow(/letters|no numbers/);
  });
  it('rejects branches longer than 60 characters', async () => {
    await expect(service.addPayee({ userId: 'admin' } as any, { ...valid, branch: 'a'.repeat(61) }, '127.0.0.1')).rejects.toThrow(/60/);
  });
});
