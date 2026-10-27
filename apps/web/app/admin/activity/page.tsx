'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useState } from 'react';
import { Icon } from '@/components/icons';
import { Chips, Dialog, Empty, ErrorState, PageHead, SkeletonRows, Tabs, useToast } from '@/components/ui';
import { ACTIVITY_FIELDS, actionLabel, deviceLabel, stamp, toCsv, type ActivityEntry } from '@/lib/activity';
import { gql } from '@/lib/api';
import { when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

const SIZE = 100;
type Outcome = '' | 'OK' | 'ERROR';
interface Filter { ip?: string; opName?: string; outcome?: string; actionsOnly?: boolean; from?: string; to?: string; userId?: string }

function ActivityPage() {
  const sp = useSearchParams();
  const [tab, setTab] = useState<'log' | 'archives'>('log');
  return (
    <>
      <PageHead title="Activity log" sub="Every request to the platform, with time, IP address, device, user and result. Money and security events are also sealed in the audit trail." />
      <Tabs label="View" value={tab} onChange={setTab} items={[{ v: 'log', label: 'Requests' }, { v: 'archives', label: 'Archives & retention' }]} />
      <div style={{ marginTop: 16 }}>{tab === 'log' ? <Log initialIp={sp.get('ip') ?? ''} initialUser={sp.get('userId') ?? ''} /> : <Archives />}</div>
    </>
  );
}

function Log({ initialIp, initialUser }: { initialIp: string; initialUser: string }) {
  const [ip, setIp] = useState(initialIp);
  const [op, setOp] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('');
  const [actionsOnly, setActionsOnly] = useState<'all' | 'actions'>('actions');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState<Filter>({ ip: initialIp || undefined, userId: initialUser || undefined, actionsOnly: true });
  const [stack, setStack] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [ipInfo, setIpInfo] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();
  const Q = `query($f:ActivityFilter,$l:Int,$b:String){ activityLog(filter:$f, limit:$l, beforeId:$b){ ${ACTIVITY_FIELDS} } }`;
  const { data, loading, error, refetch } = useQuery<{ activityLog: ActivityEntry[] }>(Q, { f: applied, l: SIZE, b: stack[stack.length - 1] });
  const rows = data?.activityLog ?? [];

  const apply = (patch: Partial<Filter> = {}) => {
    setStack([]);
    setApplied({
      ip: ip.trim() || undefined, opName: op.trim() || undefined, outcome: outcome || undefined, actionsOnly: actionsOnly === 'actions',
      from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(to).toISOString() : undefined, userId: applied.userId, ...patch,
    });
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: ActivityEntry[] = [];
      let before: string | undefined;
      while (all.length < 10_000) {
        const d = await gql<{ activityLog: ActivityEntry[] }>(Q, { f: applied, l: 500, b: before });
        all.push(...d.activityLog);
        if (d.activityLog.length < 500) break;
        before = d.activityLog[d.activityLog.length - 1].id;
      }
      const blob = new Blob([toCsv(all)], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `activity-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast(`Exported ${all.length} rows${all.length >= 10_000 ? ' (first 10,000, narrow the filter for more)' : ''}`);
    } catch (e) { toast((e as Error).message, true); } finally { setExporting(false); }
  };

  return (
    <>
      <form className="stack" style={{ gap: 12, marginBottom: 16 }} onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field filter-f" style={{ width: 180 }}><label htmlFor="f-ip">IP address</label><input id="f-ip" className="input num" placeholder="e.g. 49.36.12.4" value={ip} onChange={(e) => setIp(e.target.value)} /></div>
          <div className="field filter-f" style={{ width: 180 }}><label htmlFor="f-op">Operation</label><input id="f-op" className="input" placeholder="e.g. placeOrder" value={op} onChange={(e) => setOp(e.target.value)} /></div>
          <div className="field filter-f" style={{ width: 200 }}><label htmlFor="f-from">From</label><input id="f-from" type="datetime-local" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field filter-f" style={{ width: 200 }}><label htmlFor="f-to">To</label><input id="f-to" type="datetime-local" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <button className="btn btn-primary">Apply</button>
          <button type="button" className="btn btn-ghost" onClick={() => { setIp(''); setOp(''); setOutcome(''); setFrom(''); setTo(''); setActionsOnly('actions'); setStack([]); setApplied({ actionsOnly: true }); }}>Clear</button>
        </div>
        <div className="spread">
          <div className="row">
            <Chips label="Requests" value={actionsOnly} onChange={(v) => { setActionsOnly(v); apply({ actionsOnly: v === 'actions' }); }} items={[{ v: 'actions', label: 'Actions & sign-ins' }, { v: 'all', label: 'Everything incl. reads' }]} />
            <Chips label="Outcome" value={outcome} onChange={(v) => { setOutcome(v); apply({ outcome: v || undefined }); }} items={[{ v: '', label: 'Any result' }, { v: 'OK', label: 'Succeeded' }, { v: 'ERROR', label: 'Failed' }]} />
          </div>
          <button type="button" className="btn btn-sm" disabled={exporting || !rows.length} onClick={() => void exportCsv()}><Icon name="download" size={16} />{exporting ? 'Exporting…' : 'Export CSV'}</button>
        </div>
        {applied.userId && <div className="notice info"><Icon name="info" size={18} />Showing one account only. <button type="button" className="btn btn-sm btn-ghost" onClick={() => apply({ userId: undefined })}>Show everyone</button></div>}
      </form>

      <section className="panel">
        {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !rows.length ? <Empty icon="activity" title="No requests match">Widen the dates or clear the filters.</Empty> : (
          <div className="table-wrap">
            <table className="t resp">
              <thead><tr><th>Time (IST)</th><th>Account</th><th>Action</th><th>IP address</th><th className="hide-md">Device</th><th>Result</th><th className="r hide-sm">ms</th><th><span className="sr-only">Details</span></th></tr></thead>
              <tbody>{rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className="clickable" onClick={(e) => { if (!(e.target as HTMLElement).closest('a,button')) setOpen(open === r.id ? null : r.id); }}>
                    <td className="num sm lead">{stamp(r.at)}</td>
                    <td data-label="Account">{r.username ? <Link href={`/admin/users/${r.userId}`} className="w5">{r.username}</Link> : <span className="t3">Not signed in</span>}{r.role && <span className="sub" style={{ display: 'block' }}>{r.role.replace('_', ' ').toLowerCase()}</span>}</td>
                    <td data-label="Action"><span className="w5">{actionLabel(r.opName, r.fields)}</span><span className="sub" style={{ display: 'block' }}>{r.opType}{r.fields && r.fields !== r.opName ? ` · ${r.fields}` : ''}</span></td>
                    <td data-label="IP"><button className="btn btn-sm btn-ghost num" style={{ padding: '0 6px' }} onClick={() => setIpInfo(r.ip)} title="Who else used this IP?">{r.ip}</button></td>
                    <td className="t2 sm hide-md">{deviceLabel(r.userAgent)}{r.client && r.client !== 'other' && <span className="sub" style={{ display: 'block' }}>{r.client}</span>}</td>
                    <td data-label="Result">{r.outcome === 'OK' ? <span className="badge ok">OK</span> : <span className="badge bad">{r.errorCode ?? 'Error'}</span>}</td>
                    <td className="r num t3 sm hide-sm">{r.durationMs ?? ''}</td>
                    <td className="r" data-label="Details"><button className="icon-btn" aria-expanded={open === r.id} aria-label="Show details" onClick={() => setOpen(open === r.id ? null : r.id)}><Icon name={open === r.id ? 'chevronDown' : 'chevronRight'} size={18} /></button></td>
                  </tr>
                  {open === r.id && (
                    <tr><td colSpan={8} style={{ height: 'auto', padding: 16, background: 'var(--bg-2)' }}>
                      <dl className="facts" style={{ marginBottom: 12 }}>
                        <div><dt>Request ID</dt><dd className="num sm">{r.requestId}</dd></div>
                        <div><dt>Session</dt><dd className="num sm">{r.sessionId ?? '—'}</dd></div>
                        <div><dt>Client</dt><dd>{r.client ?? '—'}</dd></div>
                        <div><dt>User agent</dt><dd className="sm" style={{ wordBreak: 'break-all' }}>{r.userAgent ?? '—'}</dd></div>
                      </dl>
                      {r.variablesJson && <pre className="sm" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(JSON.parse(r.variablesJson), null, 2)}</pre>}
                      <div className="row" style={{ marginTop: 12 }}>
                        <Link className="btn btn-sm" href={`/admin/audit?requestId=${encodeURIComponent(r.requestId)}`}>Audit events for this request</Link>
                        {r.userId && <button className="btn btn-sm" onClick={() => apply({ userId: r.userId })}>All activity of {r.username}</button>}
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              ))}</tbody>
            </table>
          </div>
        )}
        <div className="pager">
          <span>Newest first · {rows.length} shown</span>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm" disabled={!stack.length} onClick={() => setStack((s) => s.slice(0, -1))}><Icon name="chevronLeft" size={16} />Newer</button>
            <button className="btn btn-sm" disabled={rows.length < SIZE} onClick={() => setStack((s) => [...s, rows[rows.length - 1].id])}>Older<Icon name="chevronRight" size={16} /></button>
          </div>
        </div>
      </section>
      {ipInfo && <IpDialog ip={ipInfo} onClose={() => setIpInfo(null)} onFilter={() => { setIp(ipInfo); setIpInfo(null); apply({ ip: ipInfo }); }} />}
    </>
  );
}

function IpDialog({ ip, onClose, onFilter }: { ip: string; onClose: () => void; onFilter: () => void }) {
  const { data, error } = useQuery<{ accountsOnIp: { userId: string; username: string; role: string; requests: number; firstSeen: string; lastSeen: string }[] }>(`query($ip:String!){ accountsOnIp(ip:$ip, days:90){ userId username role requests firstSeen lastSeen } }`, { ip });
  const n = data?.accountsOnIp.length ?? 0;
  return (
    <Dialog title={`IP ${ip}`} sub="Accounts that used this address in the last 90 days." onClose={onClose}>
      {error ? <ErrorState error={error} /> : !data ? <SkeletonRows rows={2} pad={false} /> : (
        <>
          {n > 1 && <div className="notice warn" style={{ marginBottom: 8 }}><Icon name="alert" size={18} />{n} different accounts used this IP. This can mean a shared office or Wi-Fi, but also shared or duplicate accounts.</div>}
          <div className="list">{data.accountsOnIp.map((a) => (
            <Link key={a.userId} href={`/admin/users/${a.userId}`} className="list-row">
              <div className="grow"><div className="w5">{a.username}</div><div className="t3">{a.role.replace('_', ' ').toLowerCase()} · {a.requests} requests · last {when(a.lastSeen)}</div></div>
              <Icon name="chevronRight" size={18} />
            </Link>
          ))}</div>
          {!n && <p className="t2">No signed-in activity from this IP.</p>}
        </>
      )}
      <div className="actions"><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={onFilter}>Show all requests from this IP</button></div>
    </Dialog>
  );
}

function Archives() {
  const { data, loading, error, refetch } = useQuery<{ logArchives: { day: string; kind: string; rows: number; sha256: string; location: string; createdAt: string }[]; configItems: { key: string; valueJson: string }[] }>(`{ logArchives(limit:120){ day kind rows sha256 location createdAt } configItems { key valueJson } }`);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const cfg = (k: string) => data?.configItems.find((c) => c.key === k)?.valueJson;
  const verify = async (day: string, kind: string) => {
    setChecks((c) => ({ ...c, [day + kind]: 'Checking…' }));
    try { const d = await gql(`query($d:String!,$k:String!){ verifyLogArchive(day:$d, kind:$k){ ok reason } }`, { d: day, k: kind }); setChecks((c) => ({ ...c, [day + kind]: d.verifyLogArchive.ok ? 'Intact' : `Problem: ${d.verifyLogArchive.reason}` })); }
    catch (e) { setChecks((c) => ({ ...c, [day + kind]: (e as Error).message })); }
  };
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="metrics">
        <div className="metric"><div className="k">Activity kept in database</div><div className="v">{cfg('logs.activityRetentionDays') ?? '…'} days</div></div>
        <div className="metric"><div className="k">Purge only archived days</div><div className="v">{cfg('logs.requireArchiveBeforePurge') === 'true' ? 'Yes' : cfg('logs.requireArchiveBeforePurge') ? 'No' : '…'}</div></div>
        <div className="metric"><div className="k">Audit trail</div><div className="v" style={{ fontSize: 16 }}>Never deleted</div></div>
      </div>
      <div className="spread">
        <p className="t2 sm" style={{ maxWidth: 640 }}>Each complete day is written to a compressed archive file with a SHA-256 checksum, automatically every 15 minutes. Change retention in Configuration (needs a second admin’s approval).</p>
        <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { const d = await gql(`mutation { runLogMaintenance }`); toast('Maintenance finished'); console.info(d.runLogMaintenance); void refetch(); } catch (e) { if ((e as { code?: string }).code !== 'CANCELLED') toast((e as Error).message, true); } finally { setBusy(false); } }}>
          <Icon name="refresh" size={18} />{busy ? 'Running…' : 'Archive & apply retention now'}
        </button>
      </div>
      <section className="panel">
        {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !data!.logArchives.length ? <Empty icon="file" title="No archives yet">The first archive is written after the first full day of activity.</Empty> : (
          <div className="table-wrap">
            <table className="t resp">
              <thead><tr><th>Day (UTC)</th><th>Log</th><th className="r">Rows</th><th className="hide-md">SHA-256</th><th>Integrity</th></tr></thead>
              <tbody>{data!.logArchives.map((a) => (
                <tr key={a.day + a.kind}>
                  <td className="num w5 lead">{a.day}</td>
                  <td data-label="Log">{a.kind === 'audit' ? 'Audit trail' : 'Activity log'}</td>
                  <td className="r num" data-label="Rows">{a.rows.toLocaleString('en-IN')}</td>
                  <td className="num t3 sm hide-md" title={a.location}>{a.sha256.slice(0, 16)}…</td>
                  <td data-label="Integrity">{checks[a.day + a.kind] ? <span className={`badge ${checks[a.day + a.kind] === 'Intact' ? 'ok' : checks[a.day + a.kind] === 'Checking…' ? '' : 'bad'}`}>{checks[a.day + a.kind]}</span> : <button className="btn btn-sm" onClick={() => void verify(a.day, a.kind)}>Verify</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<SkeletonRows />}><ActivityPage /></Suspense>;
}

