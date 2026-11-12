import 'reflect-metadata';
import { MarketDataService } from '../src/market/market-data.service';
import { CandleStore, DAY, MIN } from '../src/market/candles';

let feed = 'dhan';
jest.mock('../src/config/env', () => ({ env: () => ({ MARKET_FEED: feed }) }));

const row = { id: 'instrument', symbol: 'TEST', tickMinor: 5, refPriceMinor: 10000n, dhanSecurityId: '1', dhanSegment: 'NSE_EQ' };

describe('transient candle history', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  it('serves live Dhan candles without synthetic history or candle database access', async () => {
    jest.useFakeTimers();
    feed = 'dhan';
    const query = jest.fn(() => { throw new Error('Candle database access is forbidden'); });
    const where = jest.fn().mockResolvedValue([row]);
    const select = jest.fn(() => ({ from: () => ({ where }) }));
    let incoming: (tick: any) => void = () => {};
    const domestic = { onTick: (cb: typeof incoming) => { incoming = cb; }, setSubscriptions: jest.fn(), connect: jest.fn() };
    const global = { setSubscriptions: jest.fn() };
    const service = new MarketDataService({ db: { select }, pool: { query } } as any, domestic as any, global as any);
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await service.onModuleInit();
      expect(await service.candles(row.id, '1m', 50)).toEqual([]);
      const timestamp = new Date();
      incoming({ segmentCode: 0, securityId: '1', ltp: 999, timestamp });
      expect(await service.candles(row.id, '1m', 50)).toEqual([]); // ID collision in another segment

      incoming({ segmentCode: 1, securityId: '1', ltp: 101, timestamp });
      expect(await service.candles(row.id, '1m', 50)).toEqual([{ t: Math.floor(timestamp.getTime() / MIN) * MIN, o: 10100, h: 10100, l: 10100, c: 10100 }]);
      incoming({ segmentCode: 1, securityId: '1', ltp: 0, prevClose: 95, timestamp });
      incoming({ segmentCode: 1, securityId: '1', ltp: 0, open: 98, close: 99, high: 104, low: 94, timestamp });
      expect(service.quote(row.id)).toMatchObject({ltpMinor:10100n,prevCloseMinor:9500n,highMinor:10400n,lowMinor:9400n});
      await jest.advanceTimersByTimeAsync(61_000);
      service.onModuleDestroy();
      expect(query).not.toHaveBeenCalled();
      expect(select).toHaveBeenCalledTimes(1); // instrument metadata only
      expect(await service.candles(row.id, '1m', 50)).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      service.onModuleDestroy();
      if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original;
    }
  });

  it('bounds live history and keeps interval aggregation and pagination working', () => {
    const store = new CandleStore();
    const start = Date.UTC(2026, 0, 1);
    for (let day = 0; day < 400; day++) {
      for (let minute = 0; minute < 1440; minute++) store.record('instrument', 100 + minute, start + day * DAY + minute * MIN);
    }
    const minutes = store.candles('instrument', '1m', 10000);
    expect(minutes.length).toBeLessThanOrEqual(3 * 1440);
    expect(store.allDaily('instrument').length).toBeLessThanOrEqual(369);
    const bars = store.candles('instrument', '5m', 10);
    expect(bars).toHaveLength(10);
    const earlier = store.candles('instrument', '5m', 10, bars[0].t);
    expect(earlier.at(-1)!.t).toBeLessThan(bars[0].t);
    store.clear();
    expect(store.candles('instrument', '1D', 1000)).toEqual([]);
  });
});
