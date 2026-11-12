import 'reflect-metadata';
import { parseCatalog, supportedTick, sameContract } from '../src/market/dhan-catalog';
import { dhanExpiry } from '../src/market/dhan-credentials.service';
const header =
  'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_TICK_SIZE';
describe('official catalog validation', () => {
  it('uses domestic paise ticks without multiplying equities by 100', () => {
    const rows = parseCatalog(
      header +
        '\nNSE,E,1333,EQUITY,HDFCBANK,1,HDFC Bank,,5.0000\nNSE,C,9,FUTCUR,USDINR-Dec2026-FUT,1000,USD INR,2026-12-31 15:30:00,0.2500',
    );
    expect(rows[0].tickMinor).toBe(5);
    expect(rows[1].tickMinor).toBe(0.25);
    expect(supportedTick(rows[1].tickMinor)).toBe(false);
    expect(rows[1].expiry?.toISOString()).toBe('2026-12-31T10:00:00.000Z');
  });
  it('does not reuse an expired instrument identity for a later contract', () => {
    const old = { symbol: 'ABC26NOVFUT', expiry: new Date('2026-11-24T10:00:00Z'), segment: 'FUT' };
    const source = parseCatalog(header + '\nNSE,D,8,FUTSTK,ABC-Dec2026-FUT,1,ABC,2026-12-31 15:30:00,5')[0];
    expect(sameContract(old, source)).toBe(false);
    expect(sameContract({ ...old, expiry: new Date('2026-12-30T10:00:00Z') }, source)).toBe(true);
  });
  it('rejects unexpected schemas, malformed expiry dates and conflicting IDs', () => {
    expect(() => parseCatalog('<html>upstream error</html>')).toThrow(/headers/);
    expect(() => parseCatalog(header + '\nNSE,D,1,FUTSTK,ABC,1,ABC,not-a-date,5')).toThrow(/expiry/);
    expect(() => parseCatalog(header + '\nNSE,E,1,EQUITY,ABC,1,ABC,,5\nNSE,E,1,EQUITY,DEF,1,DEF,,5')).toThrow(
      /identity/,
    );
  });
  it('interprets Dhan authorization expiry in IST when no offset is returned', () => {
    expect(dhanExpiry('2099-01-01T12:00:00').toISOString()).toBe('2099-01-01T06:30:00.000Z');
    expect(() => dhanExpiry('2020-01-01T12:00:00')).toThrow(/expiry/);
  });
});
