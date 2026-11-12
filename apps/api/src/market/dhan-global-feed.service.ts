import { DhanCredentialsService } from './dhan-credentials.service';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import WebSocket from 'ws';
import { env } from '../config/env';
import type { DhanTick } from './dhan-feed.service';

export interface GlobalStockSubscription {
  exchangeSegment: string;
  securityId: string;
}

@Injectable()
export class DhanGlobalFeedService implements OnModuleDestroy {
  private readonly log = new Logger('DhanGlobalFeed');
  private ws?: WebSocket;
  private connecting=false;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs = 5000;
  private isDestroyed = false;
  private tickListener?: (tick: DhanTick) => void;
  private subscribedInstruments: GlobalStockSubscription[] = [];

  private cachedMarketStatus?: {
    isOpen: boolean;
    open: string;
    close: string;
    fetchedAt: number;
  };

  constructor(@Optional() private readonly credentials?:DhanCredentialsService) {
    this.credentials?.onChange(()=>this.reconnect());
  }

  reconnect() {
    if(this.isDestroyed)return;
    if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=undefined;}
    if(this.ws){this.ws.removeAllListeners();this.ws.terminate();this.ws=undefined;}
    if(this.subscribedInstruments.length)void this.connect();
  }

  async getMarketStatus(): Promise<{ isOpen: boolean; open: string; close: string } | null> {
    const now = Date.now();
    if (this.cachedMarketStatus && now - this.cachedMarketStatus.fetchedAt < 60_000) {
      return this.cachedMarketStatus;
    }

    const clientId = env().DHAN_CLIENT_ID;
    const token = this.credentials ? await this.credentials.token().catch(()=>undefined) : env().DHAN_ACCESS_TOKEN;
    if (!clientId || !token) return null;

    try {
      const res = await fetch('https://api.dhan.co/v2/globalstocks/marketstatus', {
        headers: {
          'access-token': token,
          'client-id': clientId,
        },
      });

      if (!res.ok) return null;
      const data = (await res.json()) as { marketOpenTime?: string; marketCloseTime?: string; status?: string; holidayFlag?: boolean };
      const openTime = data.marketOpenTime?.split(' ')[1]?.slice(0, 5) || '20:00';
      const closeTime = data.marketCloseTime?.split(' ')[1]?.slice(0, 5) || '02:30';
      const isOpen = data.status === 'open' && !data.holidayFlag;

      this.cachedMarketStatus = {
        isOpen,
        open: openTime,
        close: closeTime,
        fetchedAt: now,
      };
      return this.cachedMarketStatus;
    } catch (err) {
      this.log.error(`Failed to fetch Dhan global market status: ${(err as Error).message}`);
      return null;
    }
  }

  onTick(listener: (tick: DhanTick) => void) {
    this.tickListener = listener;
  }

  setSubscriptions(instruments: GlobalStockSubscription[]) {
    this.subscribedInstruments = instruments;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.reconnect();
    }
  }

  async connect() {
    if(this.connecting||!this.subscribedInstruments.length)return;
    this.connecting=true;
    try{await this.openConnection();}finally{this.connecting=false;}
  }

  private async openConnection() {
    if(this.ws && (this.ws.readyState===WebSocket.OPEN || this.ws.readyState===WebSocket.CONNECTING))return;
    const clientId = env().DHAN_CLIENT_ID;
    const token = this.credentials ? await this.credentials.token().catch(()=>undefined) : env().DHAN_ACCESS_TOKEN;

    if (!clientId || !token) {
      this.log.warn('Dhan authorization unavailable. Global feed is waiting for Connect Dhan.');
      return;
    }

    if (this.isDestroyed) return;

    const wsUrl = `wss://global-stocks-api-feed.dhan.co/?clientId=${clientId}&token=${token}&authType=2&version=2`;
    this.log.log(`Connecting to Dhan Global Stocks Feed (client: ${clientId})...`);

    try {
      this.ws = new WebSocket(wsUrl);

      let is429 = false;
      this.ws.on('open', () => {
        this.reconnectDelayMs = 5000;
        this.log.log('Connected to Dhan Global Stocks Feed WebSocket.');
        this.sendSubscriptionRequest();
      });

      this.ws.on('message', (data: Buffer) => {
        this.parseBinaryMessage(data);
      });

      this.ws.on('error', (err) => {
        if (err.message && err.message.includes('429')) is429 = true;
        this.log.error(`Dhan Global Stocks WebSocket error: ${err.message}`);
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = reason?.toString() || '';
        this.log.warn(`Dhan Global Stocks WebSocket closed (code ${code}: ${reasonStr}).`);
        this.scheduleReconnect(is429);
      });
    } catch (err) {
      this.log.error(`Failed to initiate Dhan Global Stocks WebSocket: ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private sendSubscriptionRequest() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.subscribedInstruments.length) {
      return;
    }

    const CHUNK_SIZE = 100;
    for (let i = 0; i < this.subscribedInstruments.length; i += CHUNK_SIZE) {
      const chunk = this.subscribedInstruments.slice(i, i + CHUNK_SIZE);

      // Request 15 = Subscribe Trade (LTP, Volume)
      const tradeReq = {
        requestCode: 15,
        instrumentCount: chunk.length,
        instrumentList: chunk.map((item) => ({
          exchangeSegment: item.exchangeSegment,
          securityId: String(item.securityId),
        })),
      };

      // Request 17 = Subscribe OHLC (Open, High, Low, Close)
      const ohlcReq = {
        requestCode: 17,
        instrumentCount: chunk.length,
        instrumentList: chunk.map((item) => ({
          exchangeSegment: item.exchangeSegment,
          securityId: String(item.securityId),
        })),
      };

      try {
        this.ws.send(JSON.stringify(tradeReq));
        this.ws.send(JSON.stringify(ohlcReq));
        this.log.log(`Subscribed to batch of ${chunk.length} Global Stock instruments on Dhan Feed.`);
      } catch (err) {
        this.log.error(`Failed to send Global Stocks subscription: ${(err as Error).message}`);
      }
    }
  }

  private parseBinaryMessage(buf: Buffer) {
    let offset = 0;
    const total = buf.length;

    while (offset + 11 <= total) {
      const msgCode = buf.readUInt8(offset + 10);
      const expected = ({ 1:27, 3:27, 29:18, 32:15, 33:19, 36:19, 50:13 } as Record<number,number>)[msgCode] ?? 11;
      const msgLen = buf.readUInt8(offset + 9) || expected;
      if (msgLen < expected || offset + msgLen > total) break;

      const packet = buf.subarray(offset, offset + msgLen);
      const exchSeg = packet.readUInt8(0);
      const scripId = packet.readInt32LE(1).toString();

      try {
        if (msgCode === 1 && packet.length >= 27) {
          // Trade Packet
          const ltp = packet.readFloatLE(11);
          const volume = packet.readInt32LE(15);
          const tick: DhanTick = {
            securityId: scripId,
            segmentCode: exchSeg,
            ltp,
            volume,
            lastTradeAt: new Date(packet.readUInt32LE(19) * 1000),
            timestamp: new Date(),
          };
          this.tickListener?.(tick);
        } else if (msgCode === 3 && packet.length >= 27) {
          // OHLC Packet
          const open = packet.readFloatLE(11);
          const close = packet.readFloatLE(15);
          const high = packet.readFloatLE(19);
          const low = packet.readFloatLE(23);
          const tick: DhanTick = {
            securityId: scripId,
            segmentCode: exchSeg,
            ltp: 0,
            open,
            high,
            low,
            close,
            timestamp: new Date(),
          };
          this.tickListener?.(tick);
        } else if (msgCode === 32 && packet.length >= 15) {
          // Previous Close Packet
          const close = packet.readFloatLE(11);
          const tick: DhanTick = {
            securityId: scripId,
            segmentCode: exchSeg,
            ltp: 0,
            prevClose: close,
            timestamp: new Date(),
          };
          this.tickListener?.(tick);
        } else if (msgCode === 50 && packet.length >= 13) {
          const errCode = packet.readInt16LE(11);
          this.log.warn(`Dhan Global Stocks Feed returned error code ${errCode} for scripId ${scripId}`);
        }
      } catch (err) {
        this.log.error(`Error processing Global Stocks packet (code ${msgCode}): ${(err as Error).message}`);
      }

      offset += msgLen;
    }
  }

  private scheduleReconnect(is429 = false) {
    if (this.isDestroyed || this.reconnectTimer) return;
    if (is429) {
      // Exponential backoff up to 60s when rate limited or concurrent connection limit reached
      this.reconnectDelayMs = Math.min(60000, Math.max(15000, this.reconnectDelayMs * 2));
    } else {
      this.reconnectDelayMs = 5000;
    }
    this.log.log(`Scheduling Dhan Global Stocks reconnect in ${this.reconnectDelayMs / 1000}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.reconnectDelayMs);
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }
}

