'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { gql } from '@/lib/api';
import { shortSymbol } from '@/lib/format';

interface Pulse { instrumentId: string; symbol: string; name: string; exchange: string; ltp: string; change: string; changePct: string; source: string }

const POLL_MS = 3000;
/** Shown while the feed is waking up: names only, never made-up prices. */
const WAITING: { sym: string; name: string }[] = [
  { sym: 'BANKNIFTY', name: 'Nifty Bank Index' }, { sym: 'GOLD', name: 'Gold (1 kg)' }, { sym: 'SILVER', name: 'Silver (30 kg)' },
  { sym: 'CRUDEOIL', name: 'Crude Oil' }, { sym: 'RELIANCE', name: 'Reliance Industries' }, { sym: 'HDFCBANK', name: 'HDFC Bank' },
];
const POINTS = 90;

const plainName = (n: string) => n.split(' — ')[0];
const inr = (v: string) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v: string) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
const signed = (v: string) => `${Number(v) >= 0 ? '+' : '−'}${inr(String(Math.abs(Number(v))))}`;

function useIstClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now?.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** Live board for the sign-in screen, fed by the server's public price snapshot. */
export function MarketBoard({ variant = 'full' }: { variant?: 'full' | 'strip' | 'art' }) {
  const [rows, setRows] = useState<Pulse[]>([]);
  const [failed, setFailed] = useState(false);
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});
  const prev = useRef<Record<string, number>>({});
  const [series, setSeries] = useState<number[]>([]);
  const clock = useIstClock();

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await gql<{ marketPulse: Pulse[] }>('{ marketPulse { instrumentId symbol name exchange ltp change changePct source } }');
        if (!alive) return;
        const next: Record<string, 'up' | 'down'> = {};
        for (const r of d.marketPulse) {
          const p = prev.current[r.instrumentId];
          const v = Number(r.ltp);
          if (p !== undefined && v !== p) next[r.instrumentId] = v > p ? 'up' : 'down';
          prev.current[r.instrumentId] = v;
        }
        setRows(d.marketPulse);
        setFlash(next);
        setFailed(false);
        const lead = d.marketPulse[0];
        if (lead) setSeries((s) => [...s, Number(lead.ltp)].slice(-POINTS));
      } catch {
        if (alive) setFailed(true);
      }
    };
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const lead = rows[0];
  const rest = rows.slice(1, 7);
  const up = lead ? Number(lead.change) >= 0 : true;

  const path = useMemo(() => {
    if (series.length < 2) return null;
    const w = 600, h = 160, pad = 8;
    const min = Math.min(...series), max = Math.max(...series);
    const span = max - min || Math.max(1, max * 0.0005);
    // Fill the width with whatever history we have; once full, it scrolls left as new ticks arrive.
    const n = series.length;
    const x = (i: number) => (i / (n - 1)) * w;
    const y = (v: number) => pad + (1 - (v - min) / span) * (h - pad * 2);
    const start = n - series.length;
    const pts = series.map((v, i) => `${x(start + i).toFixed(1)},${y(v).toFixed(1)}`);
    return { line: `M${pts.join(' L')}`, area: `M${x(start).toFixed(1)},${h} L${pts.join(' L')} L${w},${h} Z`, last: pts[pts.length - 1].split(',').map(Number) };
  }, [series]);

  if (variant === 'art') {
    const chip = (sym: string, i: number) => {
      const r = rows.find((x) => shortSymbol(x.symbol) === sym);
      const u = r ? Number(r.change) >= 0 : true;
      return (
        <div className={`art-chip art-chip-${i} ${r && flash[r.instrumentId] ? `fl-${flash[r.instrumentId]}` : ''}`}>
          <span className="art-chip-sym">{sym}</span>
          {r ? <span className="num">{inr(r.ltp)}</span> : <span className="sk sk-light" style={{ width: 70 }} />}
          {r ? <span className={`num ${u ? 'mb-up' : 'mb-down'}`}>{pct(r.changePct)}</span> : <span className="sk sk-light" style={{ width: 40 }} />}
        </div>
      );
    };
    return (
      <div className="art" aria-hidden>
        <div className="art-card">
          <div className="art-card-head">
            <div><div className="art-card-name">NIFTY 50</div><div className="art-card-sub">NSE futures</div></div>
            <div className="art-card-px">
              {lead ? <div className={`num art-ltp ${flash[lead.instrumentId] ? `fl-${flash[lead.instrumentId]}` : ''}`}>{inr(lead.ltp)}</div> : <span className="sk sk-light" style={{ width: 110, height: 22 }} />}
              {lead ? <div className={`num ${up ? 'mb-up' : 'mb-down'}`}>{pct(lead.changePct)}</div> : <span className="sk sk-light" style={{ width: 50, marginTop: 6 }} />}
            </div>
          </div>
          <svg className="art-chart" viewBox="0 0 600 160" preserveAspectRatio="none">
            <defs>
              <linearGradient id="artfill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="var(--brand)" stopOpacity="0.22" />
                <stop offset="1" stopColor="var(--brand)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {path ? (
              <>
                <path d={path.area} fill="url(#artfill)" />
                <path d={path.line} fill="none" stroke="var(--brand)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={path.last[0]} cy={path.last[1]} r="5" fill="var(--brand)" className="mb-head" />
              </>
            ) : (
              <path d="M0,118 C60,110 90,124 140,104 S230,70 280,86 S380,112 430,74 S530,46 600,58" fill="none" stroke="var(--line-2)" strokeWidth="2.5" strokeDasharray="5 7" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
        </div>
        {chip('GOLD', 1)}
        {chip('BANKNIFTY', 2)}
        {chip('CRUDEOIL', 3)}
      </div>
    );
  }

  if (variant === 'strip') {
    return (
      <div className="mb-strip" aria-label="Market prices">
        {!rows.length && ['NIFTY', 'BANKNIFTY', 'GOLD', 'SILVER'].map((sym) => (
          <div key={sym} className="mb-chip"><span className="mb-chip-sym">{sym}</span><span className="sk sk-light" style={{ width: 72 }} /><span className="sk sk-light" style={{ width: 44 }} /></div>
        ))}
        {rows.slice(0, 4).map((r) => {
          const u = Number(r.change) >= 0;
          return (
            <div key={r.instrumentId} className={`mb-chip ${flash[r.instrumentId] ? `fl-${flash[r.instrumentId]}` : ''}`}>
              <span className="mb-chip-sym">{shortSymbol(r.symbol)}</span>
              <span className="num">{inr(r.ltp)}</span>
              <span className={`num ${u ? 'mb-up' : 'mb-down'}`}>{pct(r.changePct)}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="mb">
      <div className="mb-top">
        <span className="mb-live"><span className={`mb-dot ${lead ? '' : 'idle'}`} aria-hidden />{lead ? 'Markets' : 'Connecting to markets'}</span>
        <span className="num mb-clock" aria-label="Time in India">{clock ? `${clock} IST` : ''}</span>
      </div>

      {lead ? (
        <div className="mb-hero">
          <div className="mb-hero-head">
            <div>
              <div className="mb-hero-name">{plainName(lead.name)}</div>
              <div className="mb-hero-sub">{lead.exchange} futures</div>
            </div>
            <div className="mb-hero-px">
              <div className={`num mb-hero-ltp ${flash[lead.instrumentId] ? `fl-${flash[lead.instrumentId]}` : ''}`}>{inr(lead.ltp)}</div>
              <div className={`num ${up ? 'mb-up' : 'mb-down'}`}>{signed(lead.change)} ({pct(lead.changePct)})</div>
            </div>
          </div>
          <svg className="mb-chart" viewBox="0 0 600 160" preserveAspectRatio="none" role="img" aria-label={`${plainName(lead.name)} price over the last few minutes`}>
            <defs>
              <linearGradient id="mbfill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor={up ? 'var(--mb-up)' : 'var(--mb-down)'} stopOpacity="0.28" />
                <stop offset="1" stopColor={up ? 'var(--mb-up)' : 'var(--mb-down)'} stopOpacity="0" />
              </linearGradient>
            </defs>
            {[40, 80, 120].map((g) => <line key={g} x1="0" x2="600" y1={g} y2={g} className="mb-grid" />)}
            {path && <path d={path.area} fill="url(#mbfill)" />}
            {path && <path d={path.line} fill="none" stroke={up ? 'var(--mb-up)' : 'var(--mb-down)'} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
            {path && <circle cx={path.last[0]} cy={path.last[1]} r="4" fill={up ? 'var(--mb-up)' : 'var(--mb-down)'} className="mb-head" />}
          </svg>
        </div>
      ) : (
        <div className="mb-hero" aria-busy="true">
          <div className="mb-hero-head">
            <div>
              <div className="mb-hero-name">Nifty 50 Index</div>
              <div className="mb-hero-sub">NSE futures</div>
            </div>
            <div className="mb-hero-px">
              <span className="sk" style={{ width: 220, height: 44 }} />
              <span className="sk" style={{ width: 130, height: 14, marginTop: 10 }} />
            </div>
          </div>
          <svg className="mb-chart" viewBox="0 0 600 160" preserveAspectRatio="none" aria-hidden>
            {[40, 80, 120].map((g) => <line key={g} x1="0" x2="600" y1={g} y2={g} className="mb-grid" />)}
            <path d="M0,118 C60,110 90,124 140,104 S230,70 280,86 S380,112 430,74 S530,46 600,58" fill="none" className="mb-ghost" vectorEffect="non-scaling-stroke" />
          </svg>
          <p className="mb-wait" role="status">{failed ? 'Waking up the price feed. This can take up to a minute.' : 'Loading prices…'}</p>
        </div>
      )}

      <table className="mb-table">
        <caption className="sr-only">Latest prices</caption>
        <thead><tr><th scope="col">Instrument</th><th scope="col">Last price</th><th scope="col">Change</th></tr></thead>
        <tbody>
          {!rows.length && WAITING.map((w) => (
            <tr key={w.sym}>
              <th scope="row"><span className="mb-sym">{w.sym}</span><span className="mb-name">{w.name}</span></th>
              <td><span className="sk" style={{ width: 88 }} /></td>
              <td><span className="sk" style={{ width: 52 }} /></td>
            </tr>
          ))}
          {rest.map((r) => {
            const u = Number(r.change) >= 0;
            return (
              <tr key={r.instrumentId} className={flash[r.instrumentId] ? `fl-${flash[r.instrumentId]}` : ''}>
                <th scope="row"><span className="mb-sym">{shortSymbol(r.symbol)}</span><span className="mb-name">{plainName(r.name)}</span></th>
                <td className="num">{inr(r.ltp)}</td>
                <td className={`num ${u ? 'mb-up' : 'mb-down'}`}>{pct(r.changePct)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="mb-foot">Prices from the platform’s simulated feed, for practice.</p>
    </div>
  );
}
