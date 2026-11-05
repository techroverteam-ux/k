import WebSocket from 'ws';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const clientId = process.env.DHAN_CLIENT_ID || '';
const token = process.env.DHAN_ACCESS_TOKEN || '';

console.log('Testing Dhan Global Stocks WebSocket Feed for Client ID:', clientId);

const wsUrl = `wss://global-stocks-api-feed.dhan.co/?clientId=${clientId}&token=${token}&authType=2&version=2`;

function parsePacket(buf: Buffer) {
  let offset = 0;
  const total = buf.length;
  while (offset + 11 <= total) {
    const msgCode = buf.readUInt8(offset + 10);
    const msgLen = buf.readUInt8(offset + 9) || 11;
    if (offset + msgLen > total) break;

    const packet = buf.subarray(offset, offset + msgLen);
    const exchSeg = packet.readUInt8(0);
    const scripId = packet.readInt32LE(1);

    if (msgCode === 1 && packet.length >= 27) {
      const ltp = packet.readFloatLE(11);
      const volume = packet.readInt32LE(15);
      console.log(`[TRADE] scripId=${scripId} LTP=${ltp.toFixed(2)} Vol=${volume}`);
    } else if (msgCode === 3 && packet.length >= 27) {
      const o = packet.readFloatLE(11);
      const c = packet.readFloatLE(15);
      const h = packet.readFloatLE(19);
      const l = packet.readFloatLE(23);
      console.log(`[OHLC] scripId=${scripId} O=${o.toFixed(2)} H=${h.toFixed(2)} L=${l.toFixed(2)} C=${c.toFixed(2)}`);
    } else if (msgCode === 32 && packet.length >= 15) {
      const prevClose = packet.readFloatLE(11);
      console.log(`[PREV CLOSE] scripId=${scripId} close=${prevClose.toFixed(2)}`);
    } else if (msgCode === 50 && packet.length >= 13) {
      const errCode = packet.readInt16LE(11);
      console.error(`[ERROR] scripId=${scripId} errCode=${errCode}`);
    } else {
      console.log(`[PACKET msgCode=${msgCode}] scripId=${scripId} len=${packet.length}`);
    }

    offset += msgLen;
  }
}

const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  console.log('WS OPENED successfully on Global Stocks Feed!');

  // Subscribe to AAPL (10000025), TSLA (10010311), MSFT (10006754), NVDA (10007290)
  const scrips = ['10000025', '10010311', '10006754', '10007290'];

  const tradeSub = {
    requestCode: 15,
    instrumentCount: scrips.length,
    instrumentList: scrips.map(id => ({ exchangeSegment: 'INX_EQ', securityId: id }))
  };
  console.log('Sending trade sub:', JSON.stringify(tradeSub));
  ws.send(JSON.stringify(tradeSub));

  const ohlcSub = {
    requestCode: 17,
    instrumentCount: scrips.length,
    instrumentList: scrips.map(id => ({ exchangeSegment: 'INX_EQ', securityId: id }))
  };
  console.log('Sending ohlc sub:', JSON.stringify(ohlcSub));
  ws.send(JSON.stringify(ohlcSub));
});

ws.on('message', (data: Buffer) => {
  parsePacket(data);
});

ws.on('error', (err) => {
  console.error('WS Error:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`WS CLOSED: code=${code}, reason=${reason.toString()}`);
  process.exit(0);
});

setTimeout(() => {
  console.log('Test completed after 10 seconds.');
  ws.close();
  process.exit(0);
}, 10000);
