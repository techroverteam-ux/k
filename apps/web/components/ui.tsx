'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { gql, setStepUpHandler } from '@/lib/api';
import { inr, tone } from '@/lib/format';
import { Icon, type IconName } from './icons';

/* ======================================================================= toasts */
type Toast = { id: number; text: string; err?: boolean };
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, err?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-2), { id, text, err }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}>
            <Icon name={t.err ? 'alert' : 'check'} size={18} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ======================================================================= dialog / confirm */
export function Dialog({ title, sub, children, size = 'md', className = '', onClose }: { title: string; sub?: string; children: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the latest onClose without re-running the effect: callers often pass a new function on every render, and
  // re-running it would move the cursor back to the first field after every keystroke.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href]');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    };
    window.addEventListener('keydown', onKey);
    // Phones: size the overlay to the part of the screen the keyboard leaves visible, so the dialog sits above it.
    const vv = window.visualViewport;
    const fit = () => {
      const o = ref.current?.parentElement;
      if (!o || !vv) return;
      o.style.setProperty('--vv-h', `${vv.height}px`);
      o.style.setProperty('--vv-top', `${vv.offsetTop}px`);
      const a = document.activeElement as HTMLElement | null;
      if (a && ref.current?.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) a.scrollIntoView({ block: 'nearest' });
    };
    fit();
    vv?.addEventListener('resize', fit); vv?.addEventListener('scroll', fit);
    return () => { window.removeEventListener('keydown', onKey); vv?.removeEventListener('resize', fit); vv?.removeEventListener('scroll', fit); prev?.focus(); };
  }, []);
  // Rendered at the end of <body>, so no sticky panel, chart or other stacking context can cover it.
  const node = (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${size ? `dialog-${size}` : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby="dlg-t" ref={ref}>
        <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
          <div>
            <h2 id="dlg-t">{title}</h2>
            {sub && <p className="t2 sm" style={{ marginTop: 4 }}>{sub}</p>}
          </div>
          <button className="icon-btn" data-close aria-label="Close" onClick={onClose} style={{ marginTop: -8, marginRight: -8 }}><Icon name="x" /></button>
        </div>
        <div style={{ marginTop: 16 }}>{children}</div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? node : createPortal(node, document.body);
}

/** Confirmation step for consequential actions: shows exactly what will happen. */
export function Confirm(p: { title: string; sub?: string; lines: [string, ReactNode][]; children?: ReactNode; confirmDisabled?: boolean; warning?: string; confirmLabel: string; tone?: 'primary' | 'buy' | 'sell' | 'danger'; pending?: boolean; error?: string | null; onConfirm: () => void; onClose: () => void }) {
  const cls = p.tone === 'buy' ? 'btn-buy' : p.tone === 'sell' || p.tone === 'danger' ? 'btn-sell' : 'btn-primary';
  return (
    <Dialog title={p.title} sub={p.sub} onClose={p.onClose}>
      <ul className="confirm-lines" style={{ marginTop: 0 }}>
        {p.lines.map(([k, v]) => (
          <li key={k}><span className="t2">{k}</span><span className="num w6">{v}</span></li>
        ))}
      </ul>
      {p.children}
      {p.warning && <div className="notice warn" style={{ marginTop: 12 }}><Icon name="info" size={18} /><span>{p.warning}</span></div>}
      {p.error && <div className="notice err" role="alert" style={{ marginTop: 12 }}><Icon name="alert" size={18} /><span>{p.error}</span></div>}
      <div className="actions">
        <button className="btn" onClick={p.onClose}>Cancel</button>
        <button className={`btn ${cls}`} disabled={p.pending || p.confirmDisabled} onClick={p.onConfirm} aria-busy={p.pending}>{p.pending ? 'Please wait…' : p.confirmLabel}</button>
      </div>
    </Dialog>
  );
}

/* ======================================================================= step-up */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((t: string | null) => void) | null>(null);
  useEffect(() => {
    setStepUpHandler(() => new Promise<string | null>((resolve) => { resolver.current = resolve; setValue(''); setErr(null); setOpen(true); }));
    return () => setStepUpHandler(null);
  }, []);
  const finish = (t: string | null) => { resolver.current?.(t); resolver.current = null; setOpen(false); };
  return (
    <>
      {children}
      {open && (
        <Dialog title="Confirm it's you" sub="This action changes money or access, so we re-check your identity." onClose={() => finish(null)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault(); setBusy(true); setErr(null);
            try {
              const d = await gql<{ stepUp: { token: string } }>(`mutation($password:String!){ stepUp(password:$password){ token } }`, { password: value });
              finish(d.stepUp.token);
            } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
          }}>
            <div className="field">
              <label htmlFor="stepup">Your password</label>
              <input id="stepup" className="input" type="password" autoComplete="current-password" maxLength={128} value={value} aria-invalid={!!err} onChange={(e) => setValue(e.target.value)} />
              {err && <span className="err" role="alert">{err}</span>}
            </div>
            <div className="actions" style={{ marginTop: 0 }}>
              <button type="button" className="btn" onClick={() => finish(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!value || busy}>{busy ? 'Verifying…' : 'Verify'}</button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

/* ======================================================================= states */
export function SkeletonRows({ rows = 5, pad = true }: { rows?: number; pad?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading" style={{ padding: pad ? '8px 16px' : 0 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="list-row" style={{ gap: 12 }}>
          <div className="skeleton" style={{ width: 36, height: 36, borderRadius: 8 }} />
          <div className="grow stack" style={{ gap: 6 }}>
            <div className="skeleton" style={{ width: `${45 - (i % 3) * 8}%` }} />
            <div className="skeleton" style={{ width: '25%', height: 10 }} />
          </div>
          <div className="skeleton" style={{ width: 72 }} />
        </div>
      ))}
    </div>
  );
}
export const Skeleton = SkeletonRows;

export function State({ icon = 'inbox', title, children, action, kind }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode; kind?: 'error' }) {
  return (
    <div className={`state ${kind ?? ''}`} role={kind === 'error' ? 'alert' : undefined}>
      <div className="ico"><Icon name={icon} size={22} /></div>
      <h3>{title}</h3>
      {children && <div className="sm" style={{ maxWidth: 360 }}>{children}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}
export const Empty = ({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: IconName }) => <State icon={icon} title={title} action={action}>{children}</State>;

/** API error → readable state with retry. Permission errors get their own wording. */
export function ErrorState({ error, retry }: { error: { message: string; code?: string } | null; retry?: () => void }) {
  if (!error) return null;
  if (error.code === 'FORBIDDEN') return <State icon="lock" title="You don't have access to this">Ask a Super Admin if you think you should.</State>;
  if (error.code === 'NETWORK') return <State kind="error" icon="wifiOff" title="You're offline" action={retry && <button className="btn btn-sm" onClick={retry}>Try again</button>}>Check your connection. We'll keep the last data on screen.</State>;
  return <State kind="error" icon="alert" title="Couldn't load this" action={retry && <button className="btn btn-sm" onClick={retry}>Try again</button>}>{error.message}</State>;
}
export const ErrorNote = ErrorState;

/* ======================================================================= small pieces */
const STATUS: Record<string, [string, string]> = {
  ACTIVE: ['ok', 'Active'], FILLED: ['ok', 'Executed'], POSTED: ['ok', 'Completed'], APPROVED: ['ok', 'Approved'], SUCCESS: ['ok', 'Success'],
  PENDING: ['warn', 'Pending'], REQUESTED: ['warn', 'In review'], OPEN: ['warn', 'Open'],
  SUSPENDED: ['bad', 'Suspended'], REJECTED: ['bad', 'Rejected'], FAILED: ['bad', 'Failed'], DENIED: ['bad', 'Denied'], FAILURE: ['bad', 'Failed'], CLOSED: ['', 'Closed'], CANCELLED: ['', 'Cancelled'], SUPERSEDED: ['', 'Superseded'],
  SIMULATED: ['info', 'Simulated'],
};
export function Status({ value }: { value: string }) {
  const [c, label] = STATUS[value] ?? ['', value.charAt(0) + value.slice(1).toLowerCase()];
  return <span className={`badge ${c}`}>{label}</span>;
}

/** Price change with arrow + sign so it never relies on colour alone. */
export function Change({ value, pct, size }: { value?: string | null; pct?: string | null; size?: 'sm' }) {
  const t = tone(value);
  if (!value) return <span className="t3">—</span>;
  return (
    <span className={`chg ${t} ${size === 'sm' ? 'sm' : ''}`}>
      {t !== 'flat' && <Icon name={t === 'pos' ? 'up' : 'down'} size={size === 'sm' ? 12 : 14} />}
      {inr(value, { sign: true })}{pct !== undefined && pct !== null ? ` (${inr(pct, { sign: true })}%)` : ''}
    </span>
  );
}

export function Metrics({ items }: { items: { k: string; v: ReactNode; tone?: string; alert?: boolean }[] }) {
  return (
    <div className="metrics">
      {items.map((m) => (
        <div key={m.k} className={`metric ${m.alert ? 'alert' : ''}`}>
          <div className="k">{m.k}</div>
          <div className={`v num ${m.tone ?? ''}`}>{m.v}</div>
        </div>
      ))}
    </div>
  );
}
/** Back-compat single stat. */
export const Stat = ({ label, value, tone: t, alert }: { label: string; value: ReactNode; tone?: string; alert?: boolean }) => <Metrics items={[{ k: label, v: value, tone: t, alert }]} />;

export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { v: T; label: ReactNode }[]; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((i) => (
        <button key={i.v} role="tab" aria-selected={value === i.v} onClick={() => onChange(i.v)}>{i.label}</button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { v: T; label: ReactNode; disabled?: boolean; title?: string }[]; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {items.map((i) => (
        <button key={i.v} className="chip" aria-pressed={value === i.v} disabled={i.disabled} title={i.title} onClick={() => onChange(i.v)}>{i.label}</button>
      ))}
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

/** Initials mark for instruments / people (no third-party logos). */
export function Mark({ text }: { text: string }) {
  return <span className="mark" aria-hidden>{text.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()}</span>;
}

export function Pager({ page, total, size, onPage }: { page: number; total: number; size: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="pager">
      <span>{total ? `${page * size + 1}–${Math.min(total, (page + 1) * size)} of ${total}` : '0 results'}</span>
      <div className="row" style={{ gap: 4 }}>
        <button className="icon-btn" aria-label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)}><Icon name="chevronLeft" /></button>
        <span className="num">{page + 1} / {pages}</span>
        <button className="icon-btn" aria-label="Next page" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}><Icon name="chevronRight" /></button>
      </div>
    </div>
  );
}

/**
 * Overflow menu for secondary row actions. The menu is drawn on top of the page (a portal, fixed position), so a table
 * or card that scrolls or clips can't hide it; it opens upward when there isn't room below.
 */
export type RowMenuItem = { label: string; onClick: () => void; danger?: boolean; icon?: IconName };
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right?: number; left?: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const open = !!pos;
  const toggle = () => {
    if (pos) return setPos(null);
    const r = btn.current!.getBoundingClientRect();
    const h = items.length * 44 + 16; // rows + padding
    // Line up with the button's right edge; if that would run off the left side (button near the left), line up from its left.
    const side = r.right - 228 < 8 ? { left: Math.max(8, r.left) } : { right: Math.max(8, window.innerWidth - r.right) };
    setPos(r.bottom + 6 + h > window.innerHeight && r.top - 6 - h > 0 ? { bottom: window.innerHeight - r.top + 6, ...side } : { top: r.bottom + 6, ...side });
  };
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setPos(null);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPos(null); btn.current?.focus(); } };
    // Close when the page scrolls the button away (not on the small scrolls a tap or focus can cause).
    const start = btn.current!.getBoundingClientRect().top;
    const away = () => { const t = btn.current?.getBoundingClientRect().top; if (t === undefined || Math.abs(t - start) > 24) setPos(null); };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', esc);
    window.addEventListener('scroll', away, true); window.addEventListener('resize', away);
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', away, true); window.removeEventListener('resize', away);
    };
  }, [open]);
  return (
    <>
      <button ref={btn} className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={toggle} style={{ width: 32, height: 32 }}><Icon name="more" size={20} strokeWidth={3} /></button>
      {pos && createPortal(
        <div ref={menu} className="menu menu-float" role="menu" aria-label={label} style={{ top: pos.top, bottom: pos.bottom, right: pos.right, left: pos.left }}>
          {items.map((i) => (
            <button key={i.label} role="menuitem" className={i.danger ? 'neg' : ''} onClick={() => { setPos(null); i.onClick(); }}>
              {i.icon && <Icon name={i.icon} size={18} />}<span>{i.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
