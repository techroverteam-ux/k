import { z } from 'zod';

/**
 * Rule-builder strategy definition (no code). Stored as JSON on strategies.rules and validated here on
 * every save, so the engine only ever sees well-formed rules.
 *
 *   side: LONG (buy to enter) or SHORT (sell to enter); one position at a time.
 *   entry: ALL conditions must be true on a closed candle to open the position.
 *   exit:  ANY condition true on a closed candle closes it. Stop-loss / take-profit (percent from the
 *          entry price) are also checked on every price tick while running, and intrabar in backtests.
 */

export const priceOperand = z.object({ type: z.literal('price'), field: z.enum(['open', 'high', 'low', 'close']) });
export const maOperand = z.object({ type: z.enum(['sma', 'ema']), period: z.number().int().min(2).max(200) });
export const rsiOperand = z.object({ type: z.literal('rsi'), period: z.number().int().min(2).max(100) });
export const bbOperand = z.object({ type: z.literal('bb'), band: z.enum(['upper', 'middle', 'lower']), period: z.number().int().min(5).max(100), mult: z.number().min(1).max(4) });
export const numberOperand = z.object({ type: z.literal('number'), value: z.number().finite().min(-1e9).max(1e9) });
export const operand = z.discriminatedUnion('type', [priceOperand, maOperand, rsiOperand, bbOperand, numberOperand]);
export type Operand = z.infer<typeof operand>;

export const condition = z.object({
  left: operand,
  op: z.enum(['crossesAbove', 'crossesBelow', 'above', 'below']),
  right: operand,
});
export type Condition = z.infer<typeof condition>;

export const rulesSchema = z
  .object({
    side: z.enum(['LONG', 'SHORT']),
    entry: z.array(condition).min(1, 'Add at least one entry condition.').max(5, 'Up to 5 entry conditions.'),
    exit: z.array(condition).max(5, 'Up to 5 exit conditions.'),
    stopLossPct: z.number().min(0.05).max(25).optional(),
    takeProfitPct: z.number().min(0.05).max(50).optional(),
  })
  .refine((r) => r.exit.length > 0 || r.stopLossPct !== undefined || r.takeProfitPct !== undefined, {
    message: 'Add an exit condition, a stop-loss or a take-profit, so every trade can close.',
  })
  .refine((r) => [...r.entry, ...r.exit].every((c) => !(c.left.type === 'number' && c.right.type === 'number')), {
    message: 'A condition needs at least one price or indicator.',
  });
export type Rules = z.infer<typeof rulesSchema>;

export function parseRules(json: unknown): Rules {
  const r = rulesSchema.safeParse(json);
  if (!r.success) throw new Error(r.error.issues.map((i) => i.message).join(' '));
  return r.data;
}

/** Candles needed before the first signal can be trusted (EMA/RSI need time to settle). */
export function warmup(rules: Rules): number {
  let p = 2;
  for (const c of [...rules.entry, ...rules.exit])
    for (const o of [c.left, c.right]) if ('period' in o) p = Math.max(p, o.type === 'ema' || o.type === 'rsi' ? o.period * 3 : o.period);
  return p + 2;
}

/** Plain-language label for an operand, e.g. "EMA(9)". */
export function operandLabel(o: Operand): string {
  switch (o.type) {
    case 'price': return o.field[0].toUpperCase() + o.field.slice(1);
    case 'sma': return `SMA(${o.period})`;
    case 'ema': return `EMA(${o.period})`;
    case 'rsi': return `RSI(${o.period})`;
    case 'bb': return `BB ${o.band}(${o.period}, ${o.mult})`;
    case 'number': return String(o.value);
  }
}
const OP_LABEL = { crossesAbove: 'crosses above', crossesBelow: 'crosses below', above: 'is above', below: 'is below' } as const;
export const conditionLabel = (c: Condition) => `${operandLabel(c.left)} ${OP_LABEL[c.op]} ${operandLabel(c.right)}`;
