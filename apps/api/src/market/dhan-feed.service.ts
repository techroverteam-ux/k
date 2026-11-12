import { DhanCredentialsService } from './dhan-credentials.service';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import WebSocket from 'ws';
import { env } from '../config/env';

export interface DhanTick {
  securityId: string;
  segmentCode: number;
  ltp: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  prevClose?: number;
  volume?: number;
  bid?: number;
  ask?: number;
  timestamp: Date;
  lastTradeAt?: Date;
}

export const DHAN_SEGMENT_MAP: Record<number, string> = {
  0: 'IDX_I',
  1: 'NSE_EQ',
  2: 'NSE_FNO',
  3: 'NSE_CURRENCY',
  4: 'BSE_EQ',
  5: 'MCX_COMM',
  7: 'BSE_CURRENCY',
  8: 'BSE_FNO',
};

export const REVERSE_DHAN_SEGMENT_MAP: Record<string, number> = {
  IDX_I: 0,
  NSE_EQ: 1,
  NSE_FNO: 2,
  NSE_CURRENCY: 3,
  BSE_EQ: 4,
  MCX_COMM: 5,
  BSE_CURRENCY: 7,
  BSE_FNO: 8,
};

@Injectable()
export class DhanFeedService implements OnModuleDestroy {
  private readonly log = new Logger('DhanFeed');
  private ws?: WebSocket;
  private connecting=false;
  private reconnectTimer?: NodeJS.Timeout;
  private isDestroyed = false;
  private tickListener?: (tick: DhanTick) => void;
  private subscribedInstruments: Array<{ exchangeSegment: string; securityId: string }> = [];

  constructor(@Optional() private readonly credentials?:DhanCredentialsService) {
    this.credentials?.onChange(()=>this.reconnect());
  }

  reconnect() {
    if(this.isDestroyed)return;
    if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=undefined;}
    if(this.ws){this.ws.removeAllListeners();this.ws.terminate();this.ws=undefined;}
    if(this.subscribedInstruments.length)void this.connect();
  }

  onTick(listener: (tick: DhanTick) => void) {
    this.tickListener = listener;
  }

  setSubscriptions(instruments: Array<{ exchangeSegment: string; securityId: string }>) {
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
      this.log.warn('Dhan authorization unavailable. Use Connect Dhan in the Super Admin market-data panel.');
      return;
    }

    if (this.isDestroyed) return;

    const wsUrl = `wss://api-feed.dhan.co?version=2&token=${token}&clientId=${clientId}&authType=2`;
    this.log.log(`Connecting to Dhan Live Market Feed (client: ${clientId})...`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.log.log('Connected to Dhan Live Market Feed WebSocket.');
        this.sendSubscriptionRequest();
      });

      this.ws.on('message', (data: Buffer) => {
        this.parseBinaryMessage(data);
      });

      this.ws.on('error', (err) => {
        this.log.error(`Dhan WebSocket error: ${err.message}`);
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = reason?.toString() || '';
        this.log.warn(`Dhan WebSocket closed (code ${code}: ${reasonStr}). Reconnecting in 5s...`);
        this.scheduleReconnect();
      });
    } catch (err) {
      this.log.error(`Failed to initiate Dhan WebSocket: ${(err as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private sendSubscriptionRequest() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.subscribedInstruments.length) {
      return;
    }

    // Chunk subscriptions into batches of 100 instruments
    const CHUNK_SIZE = 100;
    for (let i = 0; i < this.subscribedInstruments.length; i += CHUNK_SIZE) {
      const chunk = this.subscribedInstruments.slice(i, i + CHUNK_SIZE);
      const req = {
        RequestCode: 21, // Full data: includes exchange bid/ask depth.
        InstrumentCount: chunk.length,
        InstrumentList: chunk.map((item) => ({
          ExchangeSegment: item.exchangeSegment,
          SecurityId: item.securityId,
        })),
      };

      try {
        this.ws.send(JSON.stringify(req));
        this.log.log(`Subscribed to batch of ${chunk.length} instruments on Dhan Feed.`);
      } catch (err) {
        this.log.error(`Failed to send subscription: ${(err as Error).message}`);
      }
    }
  }

  private parseBinaryMessage(buf: Buffer) {
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const length = buf.readUInt16LE(offset + 1);
      if (length < 8 || offset + length > buf.length) return;
      this.parsePacket(buf.subarray(offset, offset + length));
      offset += length;
    }
  }

  private parsePacket(buf: Buffer) {
    if (buf.length < 8) return;

    try {
      const responseCode = buf.readUInt8(0);
      const messageLength = buf.readUInt16LE(1);
      const segmentCode = buf.readUInt8(3);
      const securityId = buf.readUInt32LE(4).toString();

      // Response code 50 = Disconnect / error
      if (responseCode === 50) {
        this.log.warn(`Dhan Feed Server sent disconnect packet (Code 50)`);
        return;
      }

      // Response Code 2 = Ticker Packet (8 bytes header + 8 bytes payload = 16 bytes)
      if (responseCode === 2 && buf.length >= 16) {
        const ltp = buf.readFloatLE(8);
        const tick: DhanTick = {
          securityId,
          segmentCode,
          ltp,
          timestamp: new Date(),
          lastTradeAt: new Date(buf.readUInt32LE(12) * 1000),
        };
        this.tickListener?.(tick);
        return;
      }

      // Response Code 6 = Prev Close Packet (8 bytes header + 8 bytes payload = 16 bytes)
      if (responseCode === 6 && buf.length >= 12) {
        const close = buf.readFloatLE(8);
        const tick: DhanTick = {
          securityId,
          segmentCode,
          ltp: 0,
          prevClose: close,
          timestamp: new Date(),
        };
        this.tickListener?.(tick);
        return;
      }

      // Response Code 4 = Quote Packet (8 bytes header + 42 bytes payload = 50 bytes)
      // Response Code 8 = Full Packet (Quote + Depth, starts with same 50 bytes header + quote)
      if ((responseCode === 4 && buf.length >= 50) || (responseCode === 8 && buf.length >= 162)) {
        const ltp = buf.readFloatLE(8);
        const volume = buf.readUInt32LE(22);
        const base = responseCode === 8 ? 46 : 34;
        const open = buf.readFloatLE(base);
        const close = buf.readFloatLE(base + 4);
        const high = buf.readFloatLE(base + 8);
        const low = buf.readFloatLE(base + 12);

        const tick: DhanTick = {
          securityId,
          segmentCode,
          ltp,
          open,
          high,
          low,
          close,
          volume,
          bid: responseCode === 8 ? buf.readFloatLE(74) : undefined,
          ask: responseCode === 8 ? buf.readFloatLE(78) : undefined,
          timestamp: new Date(),
          lastTradeAt: new Date(buf.readUInt32LE(14) * 1000),
        };
        this.tickListener?.(tick);
        return;
      }
    } catch (err) {
      this.log.error(`Error parsing Dhan binary packet: ${(err as Error).message}`);
    }
  }

  private scheduleReconnect() {
    if (this.isDestroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, 5000);
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

