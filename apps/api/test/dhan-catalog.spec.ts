import 'reflect-metadata';
import { parseCatalog, readCatalog, supportedTick, sameContract } from '../src/market/dhan-catalog';
import { dhanExpiry } from '../src/market/dhan-credentials.service';
const header =
  'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_TICK_SIZE';
describe('official catalog validation', () => {
  it('streams split UTF-8 rows, retaining supported contracts while counting the entire valid catalog', async () => {
    const bytes = new TextEncoder().encode(
      '\uFEFF' + header + '\r\nNSE,E,1,EQUITY,ABC,1,"Name, café",,5\r\nNSE,E,2,EQUITY,DEF,1,Other,,5',
    );
    let offset = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + 3));
          offset += 3;
        },
      }),
    );
    const result = await readCatalog(response, false, (r) => r.symbol === 'ABC');
    expect(result.count).toBe(2);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ symbol: 'ABC', name: 'Name, café', tickMinor: 5 });
  });
  it('still rejects conflicting or incomplete rows excluded from the supported selection', async () => {
    await expect(
      readCatalog(
        new Response(header + '\nNSE,E,1,EQUITY,ABC,1,ABC,,5\nNSE,E,1,EQUITY,DEF,1,DEF,,5'),
        false,
        () => false,
      ),
    ).rejects.toThrow(/identity/);
    await expect(readCatalog(new Response(header + '\nNSE,E,1,EQUITY,ABC'), false, () => true)).rejects.toThrow(
      /Incomplete/,
    );
    await expect(readCatalog(new Response('upstream unavailable', { status: 503 }), false, () => true)).rejects.toThrow(
      /HTTP 503/,
    );
  });
  it('yields to other requests while processing a large catalog chunk', async () => {
    let otherRequestRan = false;
    const immediate = setImmediate(() => {
      otherRequestRan = true;
    });
    try {
      const result = await readCatalog(
        new Response(
          header + '\n' + Array.from({ length: 1100 }, (_, i) => `NSE,E,${i},EQUITY,STOCK${i},1,Name,,5`).join('\n'),
        ),
        false,
        () => false,
      );
      expect(result.count).toBe(1100);
      expect(result.rows).toEqual([]);
      expect(otherRequestRan).toBe(true);
    } finally {
      clearImmediate(immediate);
    }
  });
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
