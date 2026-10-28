'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ROLE_LABEL } from '@/components/accounts';
import { MyActivity } from '@/components/activity';
import { ConsentHistory, LoginHistory } from '@/components/logins';
import { Icon } from '@/components/icons';
import { Confirm, Empty, ErrorState, PageHead, SectionHead, SkeletonRows, useToast } from '@/components/ui';
import { gql } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { initials, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { usePrefs, type Prefs } from '@/lib/prefs';
import { Dialog } from '@/components/ui';

interface S { id: string; deviceName?: string; userAgent?: string; ip?: string; createdAt: string; lastUsedAt: string; current: boolean }

export default function Security() {
  const { me, signOut, settings } = useAuth();
  const [terms, setTerms] = useState(false);
  const sessions = useQuery<{ mySessions: S[] }>(`{ mySessions { id deviceName userAgent ip createdAt lastUsedAt current } }`);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [revokeAll, setRevokeAll] = useState(false);
  const toast = useToast();
  const strong = next.length >= 10 && [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(next)).length >= 3;
  if (!me) return null;
  return (
    <div className="stack" style={{ gap: 40, maxWidth: 760 }}>
      <PageHead title="Profile & security" />
      <section className="row" style={{ flexWrap: 'nowrap' }}>
        <span className="avatar" style={{ width: 56, height: 56, fontSize: 18 }}>{initials(me.displayName)}</span>
        <div><h2>{me.displayName}</h2><div className="t2">{me.username} · {ROLE_LABEL[me.role]}{me.isDemo ? ' · demo account' : ''}</div></div>
      </section>

      <section className="section">
        <SectionHead title="Two-step verification" />
        <div className="panel panel-pad spread">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span className="mark" style={{ background: me.mfaEnabled ? 'var(--pos-soft)' : 'var(--bg-3)', color: me.mfaEnabled ? 'var(--pos)' : 'var(--text-2)' }}><Icon name="shield" size={18} /></span>
            <div><div className="w6">{me.mfaEnabled ? 'On' : 'Off'}</div><div className="t3">{me.mfaEnabled ? 'You’ll enter a code from your authenticator app when you sign in and before sensitive actions.' : 'Protect your account with an authenticator app.'}</div></div>
          </div>
          {!me.mfaEnabled && <Link className="btn btn-primary" href="/mfa-setup">Turn on</Link>}
        </div>
      </section>

      {!me.isDemo && (
        <section className="section">
          <SectionHead title="Change password" />
          <form className="panel panel-pad stack" onSubmit={async (e) => {
            e.preventDefault(); setMsg(null); setBusy(true);
            try { await gql(`mutation($c:String!,$n:String!){ changePassword(currentPassword:$c, newPassword:$n) }`, { c: cur, n: next }); setCur(''); setNext(''); setMsg({ ok: true, t: 'Password changed. Your other devices were signed out.' }); void sessions.refetch(); }
            catch (x) { setMsg({ ok: false, t: (x as Error).message }); } finally { setBusy(false); }
          }}>
            <div className="field"><label htmlFor="cp">Current password</label><input id="cp" type="password" className="input" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
            <div className="field"><label htmlFor="np">New password</label><input id="np" type="password" className="input" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="np-h" />
              <span id="np-h" className={next && !strong ? 'err' : 'hint'}>{next && strong ? '✓ Strong enough' : 'At least 10 characters, using three of: lowercase, uppercase, digits, symbols'}</span></div>
            {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} role="status"><Icon name={msg.ok ? 'check' : 'alert'} size={18} />{msg.t}</div>}
            <div><button className="btn btn-primary" disabled={busy || !cur || !strong}>{busy ? 'Saving…' : 'Change password'}</button></div>
          </form>
        </section>
      )}

      <section className="section">
        <SectionHead title="Signed-in devices">{(sessions.data?.mySessions.length ?? 0) > 1 && <button className="btn btn-sm btn-danger" onClick={() => setRevokeAll(true)}>Sign out other devices</button>}</SectionHead>
        {sessions.loading && !sessions.data ? <SkeletonRows rows={2} pad={false} /> : sessions.error && !sessions.data ? <ErrorState error={sessions.error} retry={sessions.refetch} /> : !sessions.data!.mySessions.length ? <Empty icon="device" title="No active sessions" /> : (
          <div className="list">{sessions.data!.mySessions.map((s) => (
            <div key={s.id} className="list-row">
              <span className="mark"><Icon name="device" size={18} /></span>
              <div className="grow"><div className="w5">{s.deviceName ?? 'Unknown device'} {s.current && <span className="badge ok" style={{ marginLeft: 6 }}>This device</span>}</div><div className="t3">{s.ip} · last active {when(s.lastUsedAt)}</div></div>
              {s.current ? <button className="btn btn-sm" onClick={() => void signOut()}>Sign out</button> : <button className="btn btn-sm btn-danger" onClick={async () => { try { await gql(`mutation($id:ID!){ revokeSession(sessionId:$id) }`, { id: s.id }); toast('Device signed out'); void sessions.refetch(); } catch (e) { toast((e as Error).message, true); } }}>Sign out</button>}
            </div>
          ))}</div>
        )}
      </section>
      {me.role === 'TRADER' && (
        <section className="section">
          <SectionHead title="Statements & records" />
          <div className="list">
            {[
              { href: '/trader/funds', icon: 'file', t: 'Ledger history', s: 'Every credit and debit on your account' },
              { href: '/trader/orders?tab=rej', icon: 'alert', t: 'Rejection log', s: 'Rejected and cancelled orders, with the reason' },
              { href: '/trader/funds#statements', icon: 'download', t: 'Bill download', s: 'PDF statement by week or custom dates' },
            ].map((x) => (
              <Link key={x.t} href={x.href} className="list-row">
                <span className="mark"><Icon name={x.icon as 'file'} size={18} /></span>
                <div className="grow"><div className="w5">{x.t}</div><div className="t3">{x.s}</div></div>
                <Icon name="chevronRight" size={18} />
              </Link>
            ))}
          </div>
        </section>
      )}

      <Preferences />

      <section className="section">
        <SectionHead title="Help" />
        <div className="list">
          <button className="list-row" style={{ background: 'none', border: 0, width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => setTerms(true)}>
            <span className="mark"><Icon name="book" size={18} /></span>
            <div className="grow"><div className="w5">App terms & rules</div><div className="t3">The trading rules you accept each time you sign in</div></div>
            <Icon name="chevronRight" size={18} />
          </button>
          {settings?.helplineUrl && (
            <a className="list-row" href={settings.helplineUrl} target="_blank" rel="noopener noreferrer">
              <span className="mark"><Icon name="chat" size={18} /></span>
              <div className="grow"><div className="w5">Contact support</div><div className="t3">Opens the helpline in a new tab</div></div>
              <Icon name="external" size={18} />
            </a>
          )}
        </div>
        <p className="t3 xs">{settings?.appName ?? 'The K'} web {process.env.NEXT_PUBLIC_APP_VERSION ?? ''} · API {settings?.apiVersion ?? '—'}</p>
      </section>
      {terms && settings && (
        <Dialog title="App terms & rules" onClose={() => setTerms(false)}>
          <ol className="stack" style={{ paddingLeft: 20, gap: 10, margin: '12px 0' }}>{settings.termsRules.map((r) => <li key={r}>{r}</li>)}</ol>
          <div className="actions"><button className="btn btn-primary" onClick={() => setTerms(false)}>Close</button></div>
        </Dialog>
      )}

      <LoginHistory />
      {me.role === 'TRADER' && <ConsentHistory title="Trading rules you accepted" />}
      <MyActivity />
      {revokeAll && <Confirm title="Sign out other devices?" sub="Everyone signed in as you, except on this device, will need to sign in again." lines={[['Devices', String((sessions.data?.mySessions.length ?? 1) - 1)]]} confirmLabel="Sign them out" tone="danger" onClose={() => setRevokeAll(false)}
        onConfirm={async () => { try { const d = await gql(`mutation { revokeOtherSessions }`); toast(`${d.revokeOtherSessions} device(s) signed out`); } catch (e) { toast((e as Error).message, true); } setRevokeAll(false); void sessions.refetch(); }} />}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}
function Seg<T extends string>({ value, items, onChange, label }: { value: T; items: [T, string][]; onChange: (v: T) => void; label: string }) {
  return <div className="seg" role="group" aria-label={label}>{items.map(([v, l]) => <button type="button" key={v} aria-pressed={value === v} onClick={() => onChange(v)}>{l}</button>)}</div>;
}

/** Display preferences, saved on this device. */
function Preferences() {
  const { prefs, set } = usePrefs();
  const rows: { icon: string; t: string; s: string; c: React.ReactNode }[] = [
    { icon: 'sun', t: 'Theme', s: 'System follows your device. Also in the top bar.', c: <Seg label="Theme" value={prefs.theme} onChange={(v) => set('theme', v)} items={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} /> },
    { icon: 'eye', t: 'Hide balances', s: 'Mask balance amounts on screen.', c: <Switch label="Hide balances" on={prefs.hideBalances} onChange={(v) => set('hideBalances', v)} /> },
    { icon: 'trend', t: 'Charts', s: 'Show price charts where available.', c: <Switch label="Charts" on={prefs.charts} onChange={(v) => set('charts', v)} /> },
    { icon: 'sound', t: 'Trade sounds', s: 'Play a tone when an order is placed, filled or rejected.', c: <Switch label="Trade sounds" on={prefs.sounds} onChange={(v) => set('sounds', v)} /> },
    { icon: 'type', t: 'Number size', s: 'Size of prices, P&L and other figures.', c: <Seg label="Number size" value={prefs.numberSize} onChange={(v) => set('numberSize', v)} items={[['S', 'S'], ['M', 'M'], ['L', 'L'], ['XL', 'XL']]} /> },
    { icon: 'bold', t: 'Bold numbers', s: 'Make all figures heavier and easier to read.', c: <Switch label="Bold numbers" on={prefs.boldNumbers} onChange={(v) => set('boldNumbers', v)} /> },
    { icon: 'list', t: 'Watchlist rows', s: 'Simple price, or bid/ask boxes with the day’s low and high.', c: <Seg label="Watchlist rows" value={prefs.watchlistView} onChange={(v) => set('watchlistView', v as Prefs['watchlistView'])} items={[['simple', 'Simple'], ['detailed', 'Bid/Ask']]} /> },
  ];
  return (
    <section className="section">
      <SectionHead title="Preferences"><span className="t3 sm">Saved on this device</span></SectionHead>
      <div>
        {rows.map((r) => (
          <div key={r.t} className="pref-row">
            <span className="mark"><Icon name={r.icon as 'sun'} size={18} /></span>
            <div className="grow"><div>{r.t}</div><div className="t3">{r.s}</div></div>
            {r.c}
          </div>
        ))}
      </div>
    </section>
  );
}
