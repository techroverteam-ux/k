'use client';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { inr } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { playTone } from '@/lib/prefs';
import { Icon } from './icons';

interface Risk { funds: string; loss: string; lossPct: number; state: 'OK' | 'WARN' | 'CUT'; warnPct: number; cutPct: number; openPositions: number }

/** Plays the alert even when "Trade sounds" is off: this is a risk warning, not trade feedback. */
function alarm() {
  playTone('reject', true);
  setTimeout(() => playTone('reject', true), 350);
  setTimeout(() => playTone('reject', true), 700);
}

/**
 * Trader loss watch: a red bar when the loss passes the warning level (80% of funds by default) or after trades
 * were cut automatically (95%), with a short alarm when that first happens on this screen.
 */
export function RiskBanner() {
  const { data } = useQuery<{ riskStatus: Risk }>(`{ riskStatus { funds loss lossPct state warnPct cutPct openPositions } }`, undefined, { pollMs: 10_000 });
  const r = data?.riskStatus;
  const level = !r ? 'OK' : r.state === 'CUT' || r.lossPct >= r.cutPct ? 'CUT' : r.state === 'WARN' || r.lossPct >= r.warnPct ? 'WARN' : 'OK';
  const prev = useRef<string>('OK');
  useEffect(() => {
    if (level !== 'OK' && level !== prev.current) alarm();
    prev.current = level;
  }, [level]);
  if (!r || level === 'OK') return null;
  const pct = Math.floor(r.lossPct);
  return (
    <div className="risk-bar" role="alert">
      <Icon name="alert" size={20} />
      <div style={{ minWidth: 0 }}>
        {level === 'CUT' ? (
          <><b>Your trades were cut automatically.</b> Loss reached {pct}% of your funds (₹{inr(r.loss)} of ₹{inr(r.funds)}). New trades are paused. <Link href="/trader/funds">Add funds</Link> to trade again.</>
        ) : (
          <><b>Loss alert: {pct}% of your funds.</b> You have lost ₹{inr(r.loss)} of ₹{inr(r.funds)}. At {r.cutPct}% all your open trades are cut automatically.</>
        )}
      </div>
    </div>
  );
}
