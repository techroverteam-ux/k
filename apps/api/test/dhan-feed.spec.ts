import 'reflect-metadata';
import { DhanGlobalFeedService } from '../src/market/dhan-global-feed.service';
import { csvFields, masterSegment } from '../scripts/audit-dhan-instruments';
import { DhanFeedService } from '../src/market/dhan-feed.service';
import WebSocket from 'ws';

describe('Dhan binary packet decoding', () => {
  it.each([DhanFeedService, DhanGlobalFeedService])('safely cancels a connecting %p socket during reconnect', async (Feed) => {
    const feed = new Feed();
    const socket = new WebSocket('ws://127.0.0.1:1');
    const listener = jest.fn();socket.on('error', listener);
    (feed as any).ws = socket;
    try {
      expect(socket.readyState).toBe(WebSocket.CONNECTING);
      feed.reconnect();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(socket.readyState).toBe(WebSocket.CLOSED);
      expect(listener).not.toHaveBeenCalled();
    } finally {feed.onModuleDestroy();}
  });
  it('reports Data APIs subscription and expired-authorization rejections without treating them as prices', () => {
    const feed = new DhanFeedService();const received = jest.fn();feed.onTick(received);
    const b = Buffer.alloc(10);b[0]=50;b.writeUInt16LE(10,1);b.writeUInt16LE(806,8);
    (feed as any).parseBinaryMessage(b);
    expect(feed.status().error).toContain('Data APIs subscription');
    b.writeUInt16LE(807,8);(feed as any).parseBinaryMessage(b);
    expect(feed.status().error).toContain('authorization expired');
    expect(received).not.toHaveBeenCalled();
  });
  it('reads Full packet OHLC, depth and exchange time at their documented offsets', () => {
    const feed = new DhanFeedService(); const received = jest.fn(); feed.onTick(received);
    const b = Buffer.alloc(162); b[0]=8; b.writeUInt16LE(162,1); b[3]=1; b.writeUInt32LE(1333,4);
    b.writeFloatLE(100.5,8); b.writeUInt32LE(1794476000,14); b.writeUInt32LE(777,22);
    b.writeUInt32LE(999999,34); // OI, not the open price
    for(const [offset,value] of [[46,98],[50,97],[54,102],[58,96],[74,100.4],[78,100.6]]) b.writeFloatLE(value,offset);
    (feed as any).parseBinaryMessage(b);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ ltp:100.5,open:98,close:97,high:102,low:96,volume:777,lastTradeAt:new Date(1794476000000) }));
    expect(received.mock.calls[0][0].bid).toBeCloseTo(100.4,3);
    expect(received.mock.calls[0][0].ask).toBeCloseTo(100.6,3);
    expect(feed.status().lastTickAt).toBeDefined();
  });
  it('ignores truncated tick packets', () => {
    const feed = new DhanFeedService(); const received=jest.fn(); feed.onTick(received);
    const b=Buffer.alloc(12);b[0]=2;(feed as any).parseBinaryMessage(b);expect(received).not.toHaveBeenCalled();
  });
});

describe('Global packets and instrument identity', () => {
  it('decodes concatenated global trade/previous-close packets when message lengths are omitted', () => {
    const feed = new DhanGlobalFeedService(); const received=jest.fn();feed.onTick(received);
    const trade=Buffer.alloc(27);trade[10]=1;trade.writeInt32LE(10000025,1);trade.writeFloatLE(201,11);trade.writeInt32LE(50,15);
    const close=Buffer.alloc(15);close[10]=32;close.writeInt32LE(10000025,1);close.writeFloatLE(199,11);
    (feed as any).parseBinaryMessage(Buffer.concat([trade,close]));
    expect(received).toHaveBeenCalledTimes(2);
    expect(received.mock.calls[0][0]).toMatchObject({securityId:'10000025',ltp:201,volume:50});
    expect(received.mock.calls[1][0]).toMatchObject({securityId:'10000025',ltp:0,prevClose:199});
  });
  it('keeps exchange segments distinct and handles quoted CSV names', () => {
    expect(masterSegment('NSE','I')).toBe('IDX_I');expect(masterSegment('NSE','E')).toBe('NSE_EQ');
    expect(csvFields('25,"Name, with ""quotes""",NSE')).toEqual(['25','Name, with "quotes"','NSE']);
  });
});
