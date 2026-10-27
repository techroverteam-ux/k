import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import type { Actor } from '../common/context';
import { AppError, badInput, unauthenticated } from '../common/errors';
import { formatMoney } from '../common/money';
import { AuditService } from '../audit/audit.service';
import { env } from '../config/env';
import { DbService } from '../db/db';
import { instruments, journalEntries, ledgerPostings, orders, users } from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';
import { UsersService } from '../users/users.service';

const LINK_TTL_SEC = 120;
const MAX_DAYS = 400;
const MAX_ROWS = 5000;
const IST = 5.5 * 3600_000;

interface StatementClaims {
  sub: string; // who asked
  role: string;
  uid: string; // whose statement
  from: string;
  to: string;
  purpose: 'statement';
}

/** IST calendar day "YYYY-MM-DD" → the UTC instant of its midnight. */
export function istDayStart(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badInput('Dates must be YYYY-MM-DD.');
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw badInput('Invalid date.');
  return new Date(d.getTime() - IST);
}

const fmtIst = (d: Date, withTime = true) => {
  const t = new Date(d.getTime() + IST);
  const date = `${String(t.getUTCDate()).padStart(2, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${t.getUTCFullYear()}`;
  return withTime ? `${date} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}` : date;
};
const amt = (v: bigint) => {
  const s = formatMoney(v < 0n ? -v : v);
  const [i, f] = s.split('.');
  const grouped = i.length > 3 ? i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + i.slice(-3) : i;
  return `${v < 0n ? '-' : ''}${grouped}.${f}`;
};

/**
 * Account statements (the "bill"): opening/closing balance, every ledger line with a running
 * balance, and every fill in the period. Downloaded through a short-lived signed link so the
 * browser/phone can open the PDF directly without exposing the access token in a URL.
 */
@Injectable()
export class StatementService {
  private readonly jwt = new JwtService({});

  constructor(
    private readonly dbs: DbService,
    private readonly usersSvc: UsersService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  async createLink(actor: Actor, userId: string, fromDay: string, toDay: string, ip: string) {
    const from = istDayStart(fromDay);
    const to = new Date(istDayStart(toDay).getTime() + 86_400_000);
    if (to <= from) throw badInput('The end date must be on or after the start date.');
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_DAYS) throw badInput(`Choose a period of up to ${MAX_DAYS} days.`);
    if (from > new Date()) throw badInput('The period starts in the future.');
    const u = await this.usersSvc.get(actor, userId, ip); // ownership / broker-scope check
    if (u.role !== 'TRADER') throw badInput('Statements are available for trader accounts.');
    const claims: StatementClaims = { sub: actor.userId, role: actor.role, uid: userId, from: fromDay, to: toDay, purpose: 'statement' };
    const token = this.jwt.sign(claims, { secret: env().JWT_STEPUP_SECRET, expiresIn: LINK_TTL_SEC, algorithm: 'HS256', issuer: 'tradedesk', audience: 'statement' });
    await this.audit.recordStandalone({ actor, action: 'statement.link_created', entityType: 'user', entityId: userId, outcome: 'SUCCESS', ip, metadata: { from: fromDay, to: toDay } });
    return { path: `/statement.pdf?token=${encodeURIComponent(token)}`, expiresIn: LINK_TTL_SEC, fileName: `statement-${u.username}-${fromDay}-to-${toDay}.pdf` };
  }

  verify(token: string): StatementClaims {
    try {
      const c = this.jwt.verify(token, { secret: env().JWT_STEPUP_SECRET, algorithms: ['HS256'], issuer: 'tradedesk', audience: 'statement' }) as StatementClaims;
      if (c.purpose !== 'statement') throw new Error('purpose');
      return c;
    } catch {
      throw unauthenticated();
    }
  }

  async render(c: StatementClaims, ip: string): Promise<{ pdf: Buffer; fileName: string }> {
    const [u] = await this.dbs.db.select().from(users).where(eq(users.id, c.uid));
    if (!u) throw new AppError('NOT_FOUND', 'Account not found.');
    const from = istDayStart(c.from);
    const to = new Date(istDayStart(c.to).getTime() + 86_400_000);
    const cash = await this.ledger.cashAccount(this.dbs.db, u.id, u.mode);
    const [open] = await this.dbs.db
      .select({ s: sql<string>`COALESCE(SUM(${ledgerPostings.amountMinor}),0)::text` })
      .from(ledgerPostings)
      .where(and(eq(ledgerPostings.accountId, cash), lt(ledgerPostings.createdAt, from)));
    const lines = await this.dbs.db
      .select({ at: ledgerPostings.createdAt, kind: journalEntries.kind, memo: journalEntries.memo, amount: ledgerPostings.amountMinor })
      .from(ledgerPostings)
      .innerJoin(journalEntries, eq(journalEntries.id, ledgerPostings.journalId))
      .where(and(eq(ledgerPostings.accountId, cash), gte(ledgerPostings.createdAt, from), lt(ledgerPostings.createdAt, to)))
      .orderBy(asc(ledgerPostings.createdAt), asc(ledgerPostings.id))
      .limit(MAX_ROWS);
    const fills = await this.dbs.db
      .select({ at: orders.filledAt, symbol: instruments.symbol, side: orders.side, type: orders.type, qty: orders.quantity, price: orders.fillPriceMinor })
      .from(orders)
      .innerJoin(instruments, eq(instruments.id, orders.instrumentId))
      .where(and(eq(orders.userId, u.id), eq(orders.status, 'FILLED'), gte(orders.filledAt, from), lt(orders.filledAt, to)))
      .orderBy(asc(orders.filledAt))
      .limit(MAX_ROWS);

    const opening = BigInt(open.s);
    const sum = (k: string[]) => lines.filter((l) => k.includes(l.kind)).reduce((a, l) => a + l.amount, 0n);
    const totals = {
      deposits: sum(['DEPOSIT', 'OPENING_BALANCE']),
      withdrawals: -sum(['WITHDRAWAL']),
      pnl: sum(['TRADE_PNL']),
      fees: -sum(['FEE']),
      other: sum(['ADJUSTMENT', 'REVERSAL']),
    };
    const closing = lines.reduce((a, l) => a + l.amount, opening);

    const pdf = await this.draw(u, c, { opening, closing, totals, lines, fills });
    await this.audit.recordStandalone({
      actor: { userId: c.sub, role: c.role as Actor['role'] },
      action: 'statement.downloaded',
      entityType: 'user',
      entityId: u.id,
      outcome: 'SUCCESS',
      ip,
      metadata: { from: c.from, to: c.to, lines: lines.length, fills: fills.length },
    });
    return { pdf, fileName: `statement-${u.username}-${c.from}-to-${c.to}.pdf` };
  }

  private draw(
    u: typeof users.$inferSelect,
    c: StatementClaims,
    d: {
      opening: bigint;
      closing: bigint;
      totals: Record<'deposits' | 'withdrawals' | 'pnl' | 'fees' | 'other', bigint>;
      lines: { at: Date; kind: string; memo: string; amount: bigint }[];
      fills: { at: Date | null; symbol: string; side: string; type: string; qty: number; price: bigint | null }[];
    },
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Account statement ${c.from} to ${c.to}`, Author: env().APP_NAME } });
      const chunks: Buffer[] = [];
      doc.on('data', (b: Buffer) => chunks.push(b));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - 80;
      const green = '#08a77b';
      const grey = '#5f6b7a';
      // The K mark (same paths as the app icon), then the name
      doc.save().translate(40, 38).scale(26 / 32);
      doc.roundedRect(0, 0, 32, 32, 9).fill(green);
      doc.translate(-0.9, 0).path('M9 8.6C9 7.7 9.7 7 10.6 7h1.3c.9 0 1.6.7 1.6 1.6v14.8c0 .9-.7 1.6-1.6 1.6h-1.3c-.9 0-1.6-.7-1.6-1.6Z').fill('#ffffff');
      doc.path('M13.5 15.1 20.2 7.6c.4-.4.9-.6 1.4-.6h3.2c.5 0 .7.6.4 1l-7 7.8 7.2 8.2c.3.4.1 1-.4 1h-3.2c-.5 0-1.1-.2-1.4-.6l-6.9-7.6Z').fill('#ffffff');
      doc.restore();
      doc.fillColor(green).font('Helvetica-Bold').fontSize(18).text(env().APP_NAME, 74, 42);
      doc.fillColor('#111').fontSize(14).text('Account statement', 40, 64);
      doc.font('Helvetica').fontSize(9).fillColor(grey).text(`Generated ${fmtIst(new Date())} IST`, 40, 44, { width: W, align: 'right' });
      doc.moveDown(0.6);
      doc.rect(40, doc.y, W, 30).fill('#fff4e5');
      doc.fillColor('#8a5300').fontSize(8.5).text(
        'SIMULATED TRADING. Balances are virtual and every fill is simulated - no order was sent to an exchange and no real money moved. This is not a contract note, ledger of a registered broker or tax document.',
        46,
        doc.y + 6,
        { width: W - 12 },
      );
      doc.moveDown(1.4);

      const kv = (k: string, v: string, x: number, y: number) => {
        doc.font('Helvetica').fontSize(8.5).fillColor(grey).text(k, x, y);
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text(v, x, y + 11);
      };
      let y = doc.y;
      kv('Account holder', u.displayName, 40, y);
      kv('Username', u.username, 220, y);
      kv('Period (IST)', `${fmtIst(istDayStart(c.from), false)} to ${fmtIst(istDayStart(c.to), false)}`, 360, y);
      y += 34;
      kv('Opening balance (INR)', amt(d.opening), 40, y);
      kv('Closing balance (INR)', amt(d.closing), 220, y);
      kv('Trades', String(d.fills.length), 360, y);
      y += 40;

      // summary
      const sumRows: [string, bigint][] = [
        ['Funds added', d.totals.deposits],
        ['Funds withdrawn', -d.totals.withdrawals],
        ['Booked P&L', d.totals.pnl],
        ['Brokerage', -d.totals.fees],
        ['Adjustments', d.totals.other],
      ];
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Summary', 40, y);
      y += 16;
      for (const [k, v] of sumRows) {
        doc.font('Helvetica').fontSize(9).fillColor('#111').text(k, 40, y).text(amt(v), 40, y, { width: 220, align: 'right' });
        y += 13;
      }
      y += 10;

      const table = (title: string, cols: { h: string; w: number; r?: boolean }[], rows: string[][], empty: string) => {
        const header = () => {
          let x = 40;
          doc.rect(40, y, W, 16).fill('#f2f4f6');
          doc.font('Helvetica-Bold').fontSize(8).fillColor(grey);
          for (const col of cols) {
            doc.text(col.h, x + 4, y + 4, { width: col.w - 8, align: col.r ? 'right' : 'left' });
            x += col.w;
          }
          y += 18;
        };
        if (y > doc.page.height - 120) {
          doc.addPage();
          y = 40;
        }
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(title, 40, y);
        y += 16;
        header();
        if (!rows.length) {
          doc.font('Helvetica').fontSize(9).fillColor(grey).text(empty, 44, y);
          y += 16;
        }
        for (const r of rows) {
          if (y > doc.page.height - 60) {
            doc.addPage();
            y = 40;
            header();
          }
          let x = 40;
          doc.font('Helvetica').fontSize(8.5).fillColor('#111');
          const h = Math.max(...r.map((cell, i) => doc.heightOfString(cell, { width: cols[i].w - 8 })));
          r.forEach((cell, i) => {
            doc.text(cell, x + 4, y, { width: cols[i].w - 8, align: cols[i].r ? 'right' : 'left' });
            x += cols[i].w;
          });
          y += h + 5;
          doc.moveTo(40, y - 2).lineTo(40 + W, y - 2).lineWidth(0.3).strokeColor('#e3e6ea').stroke();
        }
        y += 12;
      };

      let bal = d.opening;
      const ledgerRows = d.lines.map((l) => {
        bal += l.amount;
        return [fmtIst(l.at), l.memo, l.amount < 0n ? amt(-l.amount) : '', l.amount > 0n ? amt(l.amount) : '', amt(bal)];
      });
      table(
        'Ledger',
        [{ h: 'Date & time', w: 80 }, { h: 'Description', w: 195 }, { h: 'Debit', w: 80, r: true }, { h: 'Credit', w: 80, r: true }, { h: 'Balance', w: W - 435, r: true }],
        ledgerRows,
        'No ledger entries in this period.',
      );
      table(
        'Trades (simulated fills)',
        [{ h: 'Date & time', w: 80 }, { h: 'Instrument', w: 135 }, { h: 'Side', w: 45 }, { h: 'Type', w: 70 }, { h: 'Qty', w: 45, r: true }, { h: 'Price', w: 70, r: true }, { h: 'Value', w: W - 445, r: true }],
        d.fills.map((f) => [f.at ? fmtIst(f.at) : '', f.symbol, f.side, f.type.replace('_', ' '), String(f.qty), f.price ? amt(f.price) : '', f.price ? amt(f.price * BigInt(f.qty)) : '']),
        'No trades in this period.',
      );

      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0; // footer sits in the margin; don't let it spill onto a new page
        doc.font('Helvetica').fontSize(7.5).fillColor(grey).text(`${u.username} - ${c.from} to ${c.to} - Page ${i + 1} of ${range.count} - Simulated account`, 40, doc.page.height - 30, { width: W, align: 'center', lineBreak: false });
      }
      doc.end();
    });
  }
}
