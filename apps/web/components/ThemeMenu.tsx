'use client';
import { useEffect, useRef, useState } from 'react';
import { usePrefs, type Prefs } from '@/lib/prefs';

/** Top-bar switch between System, Light and Dark. Same setting as Profile → Preferences → Theme. */
const MODES: { v: Prefs['theme']; label: string; hint: string; d: string }[] = [
  { v: 'system', label: 'System', hint: 'Match your device', d: 'M3 5h18v11H3zM8 20h8M12 16v4' },
  { v: 'light', label: 'Light', hint: 'Always light', d: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4' },
  { v: 'dark', label: 'Dark', hint: 'Always dark', d: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z' },
];

function Glyph({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function ThemeMenu() {
  const { prefs, set } = usePrefs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const cur = MODES.find((m) => m.v === prefs.theme) ?? MODES[0];
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Theme: ${cur.label}`} title={`Theme: ${cur.label}`} onClick={() => setOpen((o) => !o)}>
        <Glyph d={cur.d} />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Theme" style={{ minWidth: 240 }}>
          {MODES.map((m) => (
            <button key={m.v} role="menuitemradio" aria-checked={prefs.theme === m.v} style={{ height: "auto", padding: "8px 12px", color: "var(--text)" }} onClick={() => { set('theme', m.v); setOpen(false); }}>
              <Glyph d={m.d} size={18} />
              <span style={{ flex: 1 }}>{m.label}<span className="t3 sm" style={{ display: 'block', lineHeight: 1.2 }}>{m.hint}</span></span>
              {prefs.theme === m.v && <Glyph d="M5 12l5 5 9-10" size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
