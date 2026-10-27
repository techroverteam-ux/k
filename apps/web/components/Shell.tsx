'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { gql, onLiveState, subscribe } from '@/lib/api';
import { playTone, usePrefs } from '@/lib/prefs';
import { useToast } from './ui';
import { Splash } from './Splash';
import { homeFor, useAuth, type Role } from '@/lib/auth';
import { inr, initials, shortSymbol } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { Icon, Logo, type IconName } from './icons';
import { SkeletonRows } from './ui';

type Item = { href: string; label: string; icon: IconName; exact?: boolean };
const NAV: Record<Role, Item[]> = {
  TRADER: [
    { href: '/trader', label: 'Home', icon: 'home', exact: true },
    { href: '/trader/watchlist', label: 'Watchlist', icon: 'eye' },
    { href: '/trader/positions', label: 'Positions', icon: 'briefcase' },
    { href: '/trader/orders', label: 'Orders', icon: 'list' },
    { href: '/trader/funds', label: 'Funds', icon: 'wallet' },
  ],
  BROKER: [
    { href: '/broker', label: 'Dashboard', icon: 'grid', exact: true },
    { href: '/broker/traders', label: 'Traders', icon: 'users' },
    { href: '/broker/requests', label: 'Requests', icon: 'rupee' },
    { href: '/broker/commissions', label: 'Commissions', icon: 'percent' },
  ],
  SUPER_ADMIN: [
    { href: '/admin', label: 'Overview', icon: 'grid', exact: true },
    { href: '/admin/users', label: 'Accounts', icon: 'users' },
    { href: '/admin/payments', label: 'Transactions', icon: 'rupee' },
    { href: '/admin/config', label: 'Configuration', icon: 'sliders' },
    { href: '/admin/activity', label: 'Activity log', icon: 'activity' },
    { href: '/admin/logins', label: 'Login & consent', icon: 'lock' },
    { href: '/admin/audit', label: 'Audit trail', icon: 'file' },
    { href: '/admin/reconciliation', label: 'Reconciliation', icon: 'scale' },
  ],
};
const ROLE: Record<Role, string> = { SUPER_ADMIN: 'Super Admin', BROKER: 'Broker', TRADER: 'Trader' };

export function Shell({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { me, loading, signOut, settings } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const unread = useQuery<{ unreadNotificationCount: number }>(`{ unreadNotificationCount }`, undefined, { skip: !me, pollMs: 30_000 });
  const [menu, setMenu] = useState(false);
  const [live, setLive] = useState<'idle' | 'live' | 'reconnecting'>('idle');
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!me) router.replace('/login');
    else if (me.role === 'SUPER_ADMIN' && !me.mfaEnabled) router.replace('/mfa-setup');
    else if (!roles.includes(me.role)) router.replace(homeFor(me.role));
  }, [loading, me, roles, router]);
  useEffect(() => onLiveState(setLive), []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => setMenu(false), [path]);
  const { prefs } = usePrefs();
  const toast = useToast();
  const sounds = useRef(prefs.sounds);
  sounds.current = prefs.sounds;
  // Resting orders (limit / stop-loss / take-profit) fill later: tell the trader wherever they are.
  useEffect(() => {
    if (me?.role !== 'TRADER') return;
    return subscribe<{ orderUpdated: { status: string; type: string; side: string; quantity: number; fillPrice?: string; createdAt: string; filledAt?: string; instrument?: { symbol: string } } }>(
      `subscription { orderUpdated { status type side quantity fillPrice createdAt filledAt instrument { symbol } } }`, {},
      ({ orderUpdated: o }) => {
        if (o.status !== 'FILLED' || o.type === 'MARKET') return;
        if (o.filledAt && new Date(o.filledAt).getTime() - new Date(o.createdAt).getTime() < 1500) return; // filled on placement: the order screen already said so
        playTone('fill', sounds.current);
        const what = o.type === 'STOP_LOSS' ? 'Stop-loss triggered' : o.type === 'TAKE_PROFIT' ? 'Take-profit triggered' : 'Limit order filled';
        toast(`${what}: ${o.side === 'BUY' ? 'bought' : 'sold'} ${o.quantity} ${shortSymbol(o.instrument?.symbol ?? '')} at ₹${inr(o.fillPrice)} (paper)`);
      },
    );
  }, [me?.role, toast]);

  if (loading || !me || !roles.includes(me.role)) return <div style={{ padding: 24 }}><SkeletonRows rows={6} /></div>;
  const nav = NAV[me.role];
  const active = (i: Item) => (i.exact ? path === i.href : path === i.href || path.startsWith(i.href + '/'));
  const count = unread.data?.unreadNotificationCount ?? 0;

  return (
    <div className="app">
      <Splash name={settings?.appName ?? 'The K'} />
      <header className="topbar">
        <Link href={homeFor(me.role)} className="logo" aria-label={`${settings?.appName ?? 'The K'} home`}>
          <Logo size={30} />
          <span className="wordmark">{settings?.appName ?? 'The K'}</span>
        </Link>
        {me.role === 'TRADER' && <GlobalSearch />}
        <div className="top-actions">
          <span className="paper-pill" title="All orders are simulated and balances are virtual. Nothing is sent to an exchange."><span>Paper<span className="long"> trading</span></span></span>
          {settings?.helplineUrl && (
            <a href={settings.helplineUrl} target="_blank" rel="noopener noreferrer" className="icon-btn" aria-label="Helpline (opens in a new tab)" title="Helpline">
              <Icon name="chat" />
            </a>
          )}
          <Link href="/notifications" className="icon-btn" aria-label={`Notifications${count ? `, ${count} unread` : ''}`}>
            <Icon name="bell" />
            {count > 0 && <span className="dot-count">{count > 9 ? '9+' : count}</span>}
          </Link>
          <div style={{ position: 'relative' }}>
            <button className="icon-btn" aria-haspopup="menu" aria-expanded={menu} aria-label="Account menu" onClick={() => setMenu((m) => !m)}>
              <span className="avatar">{initials(me.displayName)}</span>
            </button>
            {menu && (
              <div className="menu" role="menu">
                <div style={{ padding: '8px 12px 12px' }}>
                  <div className="w6">{me.displayName}</div>
                  <div className="t3">{me.username} · {ROLE[me.role]}</div>
                </div>
                <div className="divider" />
                <Link role="menuitem" href="/account"><Icon name="shield" size={18} />Profile & security</Link>
                <Link role="menuitem" href="/notifications"><Icon name="bell" size={18} />Notifications</Link>
                {settings?.helplineUrl && <a role="menuitem" href={settings.helplineUrl} target="_blank" rel="noopener noreferrer"><Icon name="info" size={18} />Contact support</a>}
                <div className="divider" style={{ margin: '4px 0' }} />
                <button role="menuitem" className="neg" onClick={() => void signOut()}><Icon name="logout" size={18} />Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="side" aria-label="Main">
        {nav.map((n) => (
          <Link key={n.href} href={n.href} aria-current={active(n) ? 'page' : undefined} title={n.label}>
            <Icon name={n.icon} /><span className="lbl">{n.label}</span>
          </Link>
        ))}
        <div className="side-label">Account</div>
        <Link href="/notifications" aria-current={path === '/notifications' ? 'page' : undefined} title="Notifications"><Icon name="bell" /><span className="lbl">Notifications</span></Link>
        <Link href="/account" aria-current={path === '/account' ? 'page' : undefined} title="Profile & security"><Icon name="shield" /><span className="lbl">Profile & security</span></Link>
        <p className="foot">Paper trading. Prices are simulated and balances are virtual, with no cash value.</p>
      </nav>

      <div className="main">
        {(!online || live === 'reconnecting') && (
          <div className="banner offline" role="status"><Icon name="wifiOff" size={16} />{!online ? "You're offline. Showing the last data we received." : 'Live prices reconnecting…'}</div>
        )}
        <Ticker messages={settings?.tickerMessages ?? []} />
        <main className="content" id="main">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="Main">
        {nav.slice(0, 5).map((n) => (
          <Link key={n.href} href={n.href} aria-current={active(n) ? 'page' : undefined}>
            <Icon name={n.icon} size={22} />{n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Scrolling announcements (Configuration → ui.tickerMessages) with a live IST clock. */
function Ticker({ messages }: { messages: string[] }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const text = messages.filter(Boolean);
  return (
    <div className="ticker" role="region" aria-label="Announcements">
      <div className="tape">
        {text.length > 0 && (
          <span style={{ ['--tape-s' as string]: `${Math.max(20, text.join(' ').length / 6)}s` }}>
            {text.map((m, i) => <span key={i}>{i > 0 && <i aria-hidden>•</i>}{m}</span>)}
          </span>
        )}
      </div>
      <time className="clock" dateTime={now?.toISOString()} aria-label="Current time, India">
        {now ? now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }) + ' IST' : ''}
      </time>
    </div>
  );
}

interface Hit { id: string; symbol: string; name: string; exchange: string; segment: string }
/** Header instrument search with keyboard navigation (Groww-style). */
function GlobalSearch() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    const h = setTimeout(() => gql<{ searchInstruments: Hit[] }>(`query($q:String!){ searchInstruments(query:$q, limit:8){ id symbol name exchange segment } }`, { q }).then((d) => { setHits(d.searchInstruments); setIdx(0); }).catch(() => setHits([])), 180);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const go = (h: Hit) => { setOpen(false); setQ(''); router.push(`/trader/instrument/${h.id}`); };
  return (
    <div className="top-search" ref={box}>
      <div className="input-icon">
        <Icon name="search" size={18} />
        <input
          className="input" placeholder="Search instruments, e.g. RELIANCE" aria-label="Search instruments" role="combobox" aria-expanded={open && !!hits} aria-controls="search-list"
          value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (!hits?.length) return;
            if (e.key === 'ArrowDown') { setIdx((i) => Math.min(i + 1, hits.length - 1)); e.preventDefault(); }
            if (e.key === 'ArrowUp') { setIdx((i) => Math.max(i - 1, 0)); e.preventDefault(); }
            if (e.key === 'Enter') go(hits[idx]);
            if (e.key === 'Escape') setOpen(false);
          }}
        />
      </div>
      {open && hits && (
        <ul className="suggest" id="search-list" role="listbox" style={{ listStyle: 'none', margin: 0 }}>
          {hits.length === 0 ? <li className="t2 sm" style={{ padding: '12px 16px' }}>No instruments match “{q}”.</li> : hits.map((h, i) => (
            <li key={h.id} role="option" aria-selected={i === idx} onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); go(h); }}>
              <span className="mark" aria-hidden>{shortSymbol(h.symbol).slice(0, 2)}</span>
              <span className="grow"><span className="w6">{shortSymbol(h.symbol)}</span><span className="t3" style={{ display: 'block' }}>{h.name}</span></span>
              <span className="badge">{h.exchange} {h.segment}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
