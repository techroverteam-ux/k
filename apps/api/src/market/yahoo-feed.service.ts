import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as https from 'https';
import { env } from '../config/env';

export interface YahooQuote {
  symbol: string;       // DB symbol key e.g. AAPL, BTCUSD
  yahooSymbol: string;  // Yahoo symbol e.g. AAPL, BTC-USD
  ltp: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  timestamp: Date;
}

export type YahooTickListener = (quote: YahooQuote) => void;

/**
 * Yahoo Finance polling feed for instruments that Dhan doesn't cover:
 * US Stocks (AAPL, MSFT...), Crypto (BTC-USD, ETH-USD...), 
 * COMEX (GC=F, SI=F...), US Indices (^GSPC, ^IXIC...), Forex (EURUSD=X...)
 */
@Injectable()
export class YahooFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('YahooFeed');
  private readonly listeners: YahooTickListener[] = [];
  private pollTimer?: NodeJS.Timeout;
  private isDestroyed = false;

  // Map: dbSymbol -> yahooSymbol
  private readonly symbolMap: Map<string, string> = new Map([
    // US Stocks
    ['AAPL',   'AAPL'],
    ['MSFT',   'MSFT'],
    ['NVDA',   'NVDA'],
    ['TSLA',   'TSLA'],
    ['AMZN',   'AMZN'],
    ['GOOGL',  'GOOGL'],
    ['META',   'META'],
    // Crypto (Yahoo uses BTC-USD etc)
    ['BTCUSD', 'BTC-USD'],
    ['ETHUSD', 'ETH-USD'],
    ['SOLUSD', 'SOL-USD'],
    ['XRPUSD', 'XRP-USD'],
    ['BNBUSD',  'BNB-USD'],
    ['DOGEUSD', 'DOGE-USD'],
    // COMEX Futures (Yahoo uses GC=F etc)
    ['GC-COMEX', 'GC=F'],
    ['SI-COMEX', 'SI=F'],
    ['CL-COMEX', 'CL=F'],
    ['HG-COMEX', 'HG=F'],
    ['NG-COMEX', 'NG=F'],
    // US Indices
    ['SPX', '^GSPC'],
    ['NDX', '^IXIC'],
    ['DJI', '^DJI'],
    ['RUT', '^RUT'],
    // Forex cross-rates (non-INR)
    ['EURUSD', 'EURUSD=X'],
    ['GBPUSD', 'GBPUSD=X'],
    ['USDJPY', 'JPY=X'],
  ]);

  // Reverse map: yahooSymbol -> dbSymbol
  private readonly reverseMap: Map<string, string> = new Map();

  onModuleInit() {
    if (env().MARKET_FEED === 'dhan') {
      this.log.log('Dhan market feed active; Yahoo polling disabled.');
      return;
    }
    for (const [db, yahoo] of this.symbolMap) this.reverseMap.set(yahoo, db);
    // Poll every 30 seconds
    this.pollTimer = setInterval(() => void this.poll(), 30_000);
    // Initial poll
    void this.poll();
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  onQuote(listener: YahooTickListener) {
    this.listeners.push(listener);
  }

  private emit(quote: YahooQuote) {
    for (const l of this.listeners) {
      try { l(quote); } catch {}
    }
  }

  private async poll() {
    if (this.isDestroyed) return;
    const yahooSymbols = [...this.symbolMap.values()];
    // Yahoo Finance v7 batch quote: ?symbols=AAPL,MSFT,...
    const symbolsStr = yahooSymbols.join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolsStr)}&fields=regularMarketPrice,regularMarketOpen,regularMarketDayHigh,regularMarketDayLow,regularMarketPreviousClose,regularMarketVolume`;

    try {
      const data = await this.fetchJson(url);
      const result = data?.quoteResponse?.result ?? [];
      for (const q of result) {
        const dbSym = this.reverseMap.get(q.symbol);
        if (!dbSym) continue;
        const quote: YahooQuote = {
          symbol: dbSym,
          yahooSymbol: q.symbol,
          ltp: q.regularMarketPrice ?? 0,
          open: q.regularMarketOpen ?? 0,
          high: q.regularMarketDayHigh ?? 0,
          low: q.regularMarketDayLow ?? 0,
          prevClose: q.regularMarketPreviousClose ?? 0,
          volume: q.regularMarketVolume ?? 0,
          timestamp: new Date(),
        };
        if (quote.ltp > 0) this.emit(quote);
      }
    } catch (err) {
      this.log.warn(`Yahoo Finance poll failed: ${(err as Error).message}`);
    }
  }

  private fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  }
}

