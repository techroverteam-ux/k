'use client';
import { useEffect, useState } from 'react';
import { takeSplash } from '@/lib/splash';
import { K } from './icons';

/**
 * Animated K splash: the tile pops in, the K's stem rises, the price line draws up to its dot, the leg opens, the name fades in,
 * then the whole thing lifts away. ~2.2 s; a short fade only when the user prefers reduced motion.
 */
export function Splash({ name }: { name: string }) {
  const [show, setShow] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (takeSplash()) setShow(true);
  }, []);
  // Timers live in their own effect so React's dev double-invoke can't strand the splash on screen.
  useEffect(() => {
    if (!show) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const a = setTimeout(() => setLeaving(true), reduced ? 500 : 1900);
    const b = setTimeout(() => { setShow(false); setLeaving(false); }, reduced ? 800 : 2300);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [show]);
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setShow(false), 450);
    return () => clearTimeout(t);
  }, [leaving]);
  if (!show) return null;
  return (
    <div className={`k-splash ${leaving ? 'leave' : ''}`} role="status" aria-label={`Opening ${name}`} onClick={() => setLeaving(true)}>
      <div className="k-stage">
        <svg className="k-tile" viewBox="0 0 100 100" width="112" height="112" aria-hidden="true">
          <rect className="k-bg" width="100" height="100" rx="28" />
          <g stroke="#fff" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path className="k-stem" d={K.stem} strokeWidth={K.w.stem} />
            <path className="k-arms" d={K.leg} strokeWidth={K.w.leg} />
            <path className="k-line" d={K.line} strokeWidth={K.w.line} pathLength={1} />
          </g>
          <circle className="k-dot" {...K.dot} fill="#fff" />
        </svg>
        <div className="k-ring" aria-hidden="true" />
        <div className="k-name">{name}</div>
        <div className="k-bar" aria-hidden="true"><span /></div>
      </div>
    </div>
  );
}
