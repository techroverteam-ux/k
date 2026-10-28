'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { gql, setStepUpHandler } from '@/lib/api';
import { useAuth } from '@/lib/auth';
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
export function Dialog({ title, sub, children, onClose }: { title: string; sub?: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href]');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  // Rendered at the end of <body>, so no sticky panel, chart or other stacking context can cover it.
  const node = (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t" ref={ref}>
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
export function Confirm(p: { title: string; sub?: string; lines: [string, ReactNode][]; warning?: string; confirmLabel: string; tone?: 'primary' | 'buy' | 'sell' | 'danger'; pending?: boolean; error?: string | null; onConfirm: () => void; onClose: () => void }) {
  const cls = p.tone === 'buy' ? 'btn-buy' : p.tone === 'sell' || p.tone === 'danger' ? 'btn-sell' : 'btn-primary';
  return (
    <Dialog title={p.title} sub={p.sub} onClose={p.onClose}>
      <ul className="confirm-lines" style={{ marginTop: 0 }}>
        {p.lines.map(([k, v]) => (
          <li key={k}><span className="t2">{k}</span><span className="num w6">{v}</span></li>
        ))}
      </ul>
      {p.warning && <div className="notice warn" style={{ marginTop: 12 }}><Icon name="info" size={18} /><span>{p.warning}</span></div>}
      {p.error && <div className="notice err" role="alert" style={{ marginTop: 12 }}><Icon name="alert" size={18} /><span>{p.error}</span></div>}
      <div className="actions">
        <button className="btn" onClick={p.onClose}>Cancel</button>
        <button className={`btn ${cls}`} disabled={p.pending} onClick={p.onConfirm} aria-busy={p.pending}>{p.pending ? 'Please wait…' : p.confirmLabel}</button>
      </div>
    </Dialog>
  );
}

/* ======================================================================= step-up */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
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
  const mfa = !!me?.mfaEnabled;
  return (
    <>
      {children}
      {open && (
        <Dialog title="Confirm it's you" sub="This action changes money or access, so we re-check your identity." onClose={() => finish(null)}>
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault(); setBusy(true); setErr(null);
            try {
              const d = await gql<{ stepUp: { token: string } }>(`mutation($password:String,$totp:String){ stepUp(password:$password, totp:$totp){ token } }`, mfa ? { totp: value } : { password: value });
              finish(d.stepUp.token);
            } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
          }}>
            <div className="field">
              <label htmlFor="stepup">{mfa ? '6-digit code from your authenticator app' : 'Your password'}</label>
              <input id="stepup" className="input" type={mfa ? 'text' : 'password'} inputMode={mfa ? 'numeric' : undefined} autoComplete={mfa ? 'one-time-code' : 'current-password'} maxLength={mfa ? 6 : 128} value={value} aria-invalid={!!err} onChange={(e) => setValue(mfa ? e.target.value.replace(/\D/g, '') : e.target.value)} />
              {err && <span className="err" role="alert">{err}</span>}
            </div>
            <div className="actions" style={{ marginTop: 0 }}>
              <button type="button" className="btn" onClick={() => finish(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!value || busy || (mfa && value.length !== 6)}>{busy ? 'Verifying…' : 'Verify'}</button>
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

/** Overflow menu for secondary row actions. */
export function RowMenu({ label, items }: { label: string; items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ width: 32, height: 32 }}><Icon name="more" size={20} strokeWidth={3} /></button>
      {open && (
        <div className="menu" role="menu">
          {items.map((i) => <button key={i.label} role="menuitem" className={i.danger ? 'neg' : ''} onClick={() => { setOpen(false); i.onClick(); }}>{i.label}</button>)}
        </div>
      )}
    </div>
  );
}
