'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '@/components/icons';
import { ConsentDialog } from '@/components/logins';
import { Chips, Empty, ErrorState, PageHead, SkeletonRows, Tabs, useToast } from '@/components/ui';
import { gql } from '@/lib/api';
import { CONSENT_FIELDS, deviceLabel, LOGIN_FIELDS, LOGIN_LABEL, stamp, type ConsentRecord, type LoginEvent } from '@/lib/activity';
import { useQuery } from '@/lib/hooks';

const SIZE = 50;
const csv = (cols: string[], rows: Record<string, unknown>[]) => {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : Array.isArray(v) ? v.join(' | ') : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
};
const save = (name: string, text: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
};

/** Super Admin: platform-wide sign-in audit and the trading-consent log. */
export default function Logins() {
  const [tab, setTab] = useState<'logins' | 'consents'>('logins');
  return (
    <div className="stack" style={{ gap: 24 }}>
      <PageHead title="Login & consent" sub="Every sign-in attempt and every trading-rules acceptance, with time, IP address and device. Both come from append-only records." />
      <Tabs label="Log" value={tab} onChange={setTab} items={[{ v: 'logins', label: 'Login audit' }, { v: 'consents', label: 'Trading consents' }]} />
      {tab === 'logins' ? <LoginAudit /> : <Consents />}
    </div>
  );
}

function LoginAudit() {
  const [outcome, setOutcome] = useState<'' | 'SUCCESS' | 'FAILURE' | 'DENIED'>('');
  const [ip, setIp] = useState('');
  const [applied, setApplied] = useState('');
  const [stack, setStack] = useState<string[]>([]);
  const toast = useToast();
  const vars = { o: outcome || undefined, ip: applied || undefined, b: stack[stack.length - 1], n: SIZE };
  const { data, loading, error, refetch } = useQuery<{ loginAudit: LoginEvent[] }>(`query($o:String,$ip:String,$b:String,$n:Int){ loginAudit(outcome:$o, ip:$ip, beforeSeq:$b, limit:$n){ ${LOGIN_FIELDS} } }`, vars);
  const rows = data?.loginAudit ?? [];
  return (
    <>
      <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); setStack([]); setApplied(ip.trim()); }}>
        <div className="field filter-f" style={{ width: 200 }}><label htmlFor="lip">IP address</label><input id="lip" className="input num" placeholder="e.g. 49.36.12.4" value={ip} onChange={(e) => setIp(e.target.value)} /></div>
        <button className="btn btn-primary">Apply</button>
        <Chips label="Result" value={outcome} onChange={(v) => { setOutcome(v); setStack([]); }} items={[{ v: '', label: 'All' }, { v: 'SUCCESS', label: 'Successful' }, { v: 'FAILURE', label: 'Failed' }, { v: 'DENIED', label: 'Blocked' }]} />
        <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} disabled={!rows.length} onClick={async () => {
          try {
            const d = await gql<{ loginAudit: LoginEvent[] }>(`query($o:String,$ip:String){ loginAudit(outcome:$o, ip:$ip, limit:500){ ${LOGIN_FIELDS} } }`, { o: outcome || undefined, ip: applied || undefined });
            save('login-audit.csv', csv(['at', 'username', 'role', 'action', 'outcome', 'detail', 'ip', 'userAgent', 'sessionId', 'requestId'], d.loginAudit as unknown as Record<string, unknown>[]));
          } catch (e) { toast((e as Error).message, true); }
        }}><Icon name="download" size={16} />Export CSV</button>
      </form>
      {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !rows.length ? <Empty icon="lock" title="No sign-in events match" /> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Time (IST)</th><th>Account</th><th>Event</th><th>IP address</th><th className="hide-md">Device</th><th>Result</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.seq}>
                <td className="num sm lead">{stamp(r.at)}</td>
                <td data-label="Account">{r.username ? <Link className="w5" href={`/admin/users/${r.userId}`}>{r.username}</Link> : <span className="t3">Unknown username</span>}{r.role && <span className="sub" style={{ display: 'block' }}>{r.role.replace('_', ' ').toLowerCase()}</span>}</td>
                <td data-label="Event"><span className="w5">{LOGIN_LABEL[r.action] ?? r.action}</span>{r.detail && <span className="sub" style={{ display: 'block' }}>{r.detail}</span>}</td>
                <td data-label="IP"><Link className="num" href={`/admin/activity?ip=${encodeURIComponent(r.ip ?? '')}`}>{r.ip ?? '—'}</Link></td>
                <td className="hide-md t2 sm">{deviceLabel(r.userAgent)}</td>
                <td data-label="Result"><span className={`badge ${r.outcome === 'SUCCESS' ? 'ok' : r.outcome === 'DENIED' ? 'warn' : 'bad'}`}>{r.outcome === 'SUCCESS' ? 'OK' : r.outcome === 'DENIED' ? 'Blocked' : 'Failed'}</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="row">
        <button className="btn btn-sm" disabled={!stack.length} onClick={() => setStack((s) => s.slice(0, -1))}><Icon name="chevronLeft" size={16} />Newer</button>
        <button className="btn btn-sm" disabled={rows.length < SIZE} onClick={() => setStack((s) => [...s, rows[rows.length - 1].seq])}>Older<Icon name="chevronRight" size={16} /></button>
      </div>
    </>
  );
}

function Consents() {
  const [stack, setStack] = useState<string[]>([]);
  const [open, setOpen] = useState<ConsentRecord | null>(null);
  const toast = useToast();
  const { data, loading, error, refetch } = useQuery<{ consentLog: ConsentRecord[] }>(`query($b:String,$n:Int){ consentLog(before:$b, limit:$n){ ${CONSENT_FIELDS} } }`, { b: stack[stack.length - 1], n: SIZE });
  const rows = data?.consentLog ?? [];
  return (
    <>
      <div className="spread">
        <p className="t2 sm" style={{ maxWidth: 680 }}>Traders accept the rules at the start of every session before they can place orders. The exact rules text and its SHA-256 are stored with each acceptance, so you can prove what was shown.</p>
        <button className="btn btn-sm" disabled={!rows.length} onClick={async () => {
          try {
            const d = await gql<{ consentLog: ConsentRecord[] }>(`{ consentLog(limit:500){ ${CONSENT_FIELDS} } }`);
            save('trading-consents.csv', csv(['acceptedAt', 'username', 'displayName', 'ip', 'userAgent', 'client', 'sessionId', 'termsVersion', 'requestId', 'rules'], d.consentLog as unknown as Record<string, unknown>[]));
          } catch (e) { toast((e as Error).message, true); }
        }}><Icon name="download" size={16} />Export CSV</button>
      </div>
      {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !rows.length ? <Empty icon="shield" title="No consents recorded yet" /> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Accepted (IST)</th><th>Trader</th><th>IP address</th><th className="hide-md">Device</th><th className="hide-sm">Rules version</th><th /></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id}>
                <td className="num sm lead">{stamp(c.acceptedAt)}</td>
                <td data-label="Trader"><Link className="w5" href={`/admin/users/${c.userId}`}>{c.displayName ?? c.username}</Link><span className="sub" style={{ display: 'block' }}>{c.username}</span></td>
                <td data-label="IP" className="num">{c.ip}</td>
                <td className="hide-md t2 sm">{deviceLabel(c.userAgent)}</td>
                <td className="hide-sm num t3 sm">{c.termsVersion.slice(0, 12)}…</td>
                <td className="r"><button className="btn btn-sm" onClick={() => setOpen(c)}>View</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="row">
        <button className="btn btn-sm" disabled={!stack.length} onClick={() => setStack((s) => s.slice(0, -1))}><Icon name="chevronLeft" size={16} />Newer</button>
        <button className="btn btn-sm" disabled={rows.length < SIZE} onClick={() => setStack((s) => [...s, rows[rows.length - 1].acceptedAt])}>Older<Icon name="chevronRight" size={16} /></button>
      </div>
      {open && <ConsentDialog c={open} onClose={() => setOpen(null)} />}
    </>
  );
}
