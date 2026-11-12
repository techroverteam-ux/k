import 'reflect-metadata';
import { eq } from 'drizzle-orm';
import { DbService } from '../src/db/db';
import { DhanCatalogService } from '../src/market/dhan-catalog.service';
import { DhanCredentialsService } from '../src/market/dhan-credentials.service';
import { instruments, users, integrationState } from '../src/db/schema';
import { resetEnvCache } from '../src/config/env';
import { resetKeyRing } from '../src/common/crypto';
jest.setTimeout(120000);
const suite = process.env.RUN_DHAN_INTEGRATION === 'true' ? describe : describe.skip;
suite('isolated Dhan maintenance and authorization', () => {
  let db: DbService,
    catalog: DhanCatalogService,
    credentials: DhanCredentialsService,
    admin: any,
    saved: NodeJS.ProcessEnv;
  const domesticHeader =
    'SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_SMST_SECURITY_ID,SEM_INSTRUMENT_NAME,SEM_TRADING_SYMBOL,SEM_LOT_UNITS,SEM_CUSTOM_SYMBOL,SEM_EXPIRY_DATE,SEM_TICK_SIZE';
  const names =
    'ABB ABCAPITAL ADANIENT ADANIGREEN ADANIPORTS AMBUJACEM RELIANCE TCS INFY HDFCBANK SBIN KAYNES SAIL ICICIBANK BHARTIARTL ITC KOTAKBANK LT AXISBANK MARUTI SUNPHARMA BAJFINANCE TITAN ASIANPAINT HCLTECH WIPRO NTPC ONGC POWERGRID JSWSTEEL'.split(
      ' ',
    );
  const domestic =
    domesticHeader +
    '\n' +
    Array.from({ length: 1001 }, (_, i) => `NSE,E,${100 + i},EQUITY,${names[i] ?? 'OTHER' + i},1,Name,,5.0000`).join(
      '\n',
    );
  const globalHeader = 'SYMBOL,SCRIP_CODE,LOT_SIZE,TICK_SIZE,CUSTOM_SYMBOL,CUSTOM_EXCH';
  const globals =
    globalHeader +
    '\n' +
    Array.from(
      { length: 101 },
      (_, i) => `${['AAPL', 'MSFT', 'SPY'][i] ?? 'OTHER' + i},${10000 + i},1,0.05,Stock,NASDAQ`,
    ).join('\n');
  beforeAll(async () => {
    const u = new URL(process.env.DATABASE_URL!);
    if (!['localhost', '127.0.0.1'].includes(u.hostname) || !/^\/tradedesk_reset_test_\d+$/.test(u.pathname))
      throw Error('Isolated database required');
    saved = { ...process.env };
    Object.assign(process.env, {
      DHAN_CLIENT_ID: 'test-client',
      DHAN_API_KEY: 'test-key',
      DHAN_API_SECRET: 'test-secret',
      DHAN_REDIRECT_URL: 'https://api.example.test/integrations/dhan/callback',
    });
    resetEnvCache();
    resetKeyRing();
    db = new DbService();
    catalog = new DhanCatalogService(db);
    credentials = new DhanCredentialsService(db);
    const [row] = await db.db
      .insert(users)
      .values({
        username: 'single.admin',
        displayName: 'Admin',
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        passwordHash: 'unused',
      })
      .returning();
    admin = { userId: row.id, sessionId: row.id, role: 'SUPER_ADMIN', mfaVerified: true };
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await catalog?.onModuleDestroy();
    await credentials?.onModuleDestroy();
    await db?.onApplicationShutdown();
    process.env = saved;
    resetEnvCache();
    resetKeyRing();
  });
  it('stages both catalogs, preserves accounts and stable instrument identity, retires placeholders', async () => {
    const [old] = await db.db
      .insert(instruments)
      .values({
        symbol: 'HDFCBANK',
        name: 'Old',
        exchange: 'NSE',
        segment: 'EQ',
        lotSize: 1,
        tickMinor: 500,
        refPriceMinor: 100n,
        dhanSegment: 'NSE_EQ',
        dhanSecurityId: '109',
      })
      .returning();
    const [fake] = await db.db
      .insert(instruments)
      .values({
        symbol: 'FAKE',
        name: 'Demo',
        exchange: 'NSE',
        segment: 'EQ',
        lotSize: 1,
        tickMinor: 5,
        refPriceMinor: 100n,
      })
      .returning();
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (url) => new Response(String(url).includes('us-stock') ? globals : domestic));
    expect((await catalog.sync()).status).toBe('HEALTHY');
    expect((await db.db.select().from(instruments).where(eq(instruments.id, old.id)))[0]).toMatchObject({
      active: true,
      tickMinor: 5,
    });
    expect((await db.db.select().from(instruments).where(eq(instruments.id, fake.id)))[0].active).toBe(false);
    expect(await db.db.$count(users)).toBe(1);
  });
  it('keeps the last verified catalog unchanged after a malformed download', async () => {
    const before = await db.db.select().from(instruments);
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('<html>upstream failure</html>'));
    expect((await catalog.sync()).status).toBe('ERROR');
    expect(await db.db.select().from(instruments)).toEqual(before);
    expect(await catalog.usable()).toBe(true);
  });
  it('returns immediately, deduplicates background sync and keeps status queries available during download', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      await waiting;
      return new Response(String(url).includes('us-stock') ? globals : domestic);
    });
    const first = catalog.startSync();
    try {
      expect(first.status).toBe('SYNCING');
      expect(catalog.startSync()).toEqual(first);
      expect((await catalog.status()).status).toBe('SYNCING');
      expect(await db.db.$count(users)).toBe(1);
      expect(provider).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect((await catalog.sync()).status).toBe('HEALTHY');
    expect((await catalog.status()).status).toBe('HEALTHY');
    expect(provider).toHaveBeenCalledTimes(2);
    const restarted = new DhanCatalogService(db);
    await restarted.onModuleInit();
    expect(restarted.isFresh()).toBe(true);
    await restarted.onModuleDestroy();
  });
  it('requires admin/MFA, binds callback to its browser, encrypts issued tokens and rejects replay', async () => {
    await expect(credentials.begin({ ...admin, role: 'BROKER' })).rejects.toThrow();
    await expect(credentials.begin({ ...admin, mfaVerified: false })).rejects.toThrow();
    const url = await credentials.begin(admin);
    const ticket = new URL(url).searchParams.get('ticket')!;
    const provider = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ consentAppId: 'consent-fixture' })));
    const start = await credentials.start(ticket);
    expect(start.url).toContain('consent-fixture');
    await expect(credentials.complete(ticket + '.' + 'x'.repeat(43), 'token-id')).rejects.toThrow();
    provider.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          dhanClientId: 'test-client',
          accessToken: 'issued-private-token',
          expiryTime: '2099-01-01T12:00:00',
        }),
      ),
    );
    await credentials.complete(start.cookie, 'token-id');
    expect(await credentials.token()).toBe('issued-private-token');
    const state = (await db.db.select().from(integrationState).where(eq(integrationState.name, 'dhan.token')))[0];
    expect(JSON.stringify(state)).not.toContain('issued-private-token');
    expect((await credentials.status()).connected).toBe(true);
    await expect(credentials.complete(start.cookie, 'token-id')).rejects.toThrow();
  });
  (process.env.RUN_DHAN_LIVE_CATALOG === 'true' ? it : it.skip)(
    'validates and imports actual public catalogs in the isolated database',
    async () => {
      const before = await db.db.$count(users);
      const r = await catalog.sync();
      console.log(JSON.stringify({ catalog: r }));
      expect(r.status).toBe('HEALTHY');
      expect(r.supported).toBeGreaterThan(100);
      expect(await db.db.$count(users)).toBe(before);
    },
  );
});
