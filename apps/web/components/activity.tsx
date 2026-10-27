'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ACTIVITY_FIELDS, actionLabel, deviceLabel, stamp, type ActivityEntry } from '@/lib/activity';
import { when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';
import { Icon } from './icons';
import { Empty, ErrorState, SectionHead, SkeletonRows } from './ui';

/** The signed-in user's own sign-ins and actions with time, IP and device. */
export function MyActivity() {
  const [before, setBefore] = useState<string[]>([]);
  const { data, loading, error, refetch } = useQuery<{ myActivity: ActivityEntry[] }>(`query($b:String){ myActivity(limit:25, beforeId:$b){ ${ACTIVITY_FIELDS} } }`, { b: before[before.length - 1] });
  const rows = data?.myActivity ?? [];
  return (
    <section className="section">
      <SectionHead title="Account activity" />
      <p className="t2 sm">Every sign-in and action on your account, with the time, IP address and device. If you don’t recognise something, change your password and sign out other devices.</p>
      {loading && !data ? <SkeletonRows rows={3} pad={false} /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !rows.length ? <Empty icon="activity" title="No activity yet" /> : (
        <div className="list">
          {rows.map((r) => (
            <div key={r.id} className="list-row" style={{ alignItems: 'flex-start' }}>
              <span className="mark" style={r.outcome === 'ERROR' ? { background: 'var(--neg-soft)', color: 'var(--neg)' } : undefined}><Icon name={r.outcome === 'ERROR' ? 'alert' : 'activity'} size={18} /></span>
              <div className="grow">
                <div className="w5">{actionLabel(r.opName, r.fields)}{r.outcome === 'ERROR' && <span className="badge bad" style={{ marginLeft: 8 }}>Failed</span>}</div>
                <div className="t3">{stamp(r.at)}</div>
                <div className="t3">IP {r.ip} · {deviceLabel(r.userAgent)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {(rows.length === 25 || before.length > 0) && (
        <div className="row">
          <button className="btn btn-sm" disabled={!before.length} onClick={() => setBefore((b) => b.slice(0, -1))}>Newer</button>
          <button className="btn btn-sm" disabled={rows.length < 25} onClick={() => setBefore((b) => [...b, rows[rows.length - 1].id])}>Older</button>
        </div>
      )}
    </section>
  );
}

interface UserIp { ip: string; requests: number; firstSeen: string; lastSeen: string; otherAccounts: number }
/** Super Admin view of one account: IP addresses used and recent actions. */
export function UserLogs({ userId }: { userId: string }) {
  const ips = useQuery<{ userIps: UserIp[] }>(`query($u:ID!){ userIps(userId:$u, days:90){ ip requests firstSeen lastSeen otherAccounts } }`, { u: userId });
  const acts = useQuery<{ activityLog: ActivityEntry[] }>(`query($f:ActivityFilter){ activityLog(filter:$f, limit:15){ ${ACTIVITY_FIELDS} } }`, { f: { userId, actionsOnly: true } });
  return (
    <div className="two">
      <section className="section">
        <SectionHead title="IP addresses · 90 days" />
        {ips.loading && !ips.data ? <SkeletonRows rows={2} pad={false} /> : ips.error && !ips.data ? <ErrorState error={ips.error} retry={ips.refetch} /> : !ips.data!.userIps.length ? <Empty icon="globe" title="No activity recorded" /> : (
          <div className="list">{ips.data!.userIps.map((i) => (
            <Link key={i.ip} href={`/admin/activity?ip=${encodeURIComponent(i.ip)}`} className="list-row">
              <span className="mark"><Icon name="globe" size={18} /></span>
              <div className="grow"><div className="w5 num">{i.ip}</div><div className="t3">{i.requests} requests · {when(i.firstSeen)} – {when(i.lastSeen)}</div></div>
              {i.otherAccounts > 0 ? <span className="badge warn" title="Other accounts used this IP">+{i.otherAccounts} other account{i.otherAccounts > 1 ? 's' : ''}</span> : <span className="badge">Only this account</span>}
            </Link>
          ))}</div>
        )}
      </section>
      <section className="section">
        <SectionHead title="Recent actions"><Link className="btn btn-sm btn-ghost" href={`/admin/activity?userId=${userId}`}>Full log<Icon name="chevronRight" size={16} /></Link></SectionHead>
        {acts.loading && !acts.data ? <SkeletonRows rows={3} pad={false} /> : acts.error && !acts.data ? <ErrorState error={acts.error} retry={acts.refetch} /> : !acts.data!.activityLog.length ? <Empty icon="activity" title="No actions yet" /> : (
          <div className="list">{acts.data!.activityLog.map((r) => (
            <div key={r.id} className="list-row">
              <div className="grow"><div className="w5">{actionLabel(r.opName, r.fields)}</div><div className="t3">{stamp(r.at)} · {r.ip} · {deviceLabel(r.userAgent)}</div></div>
              {r.outcome === 'OK' ? <span className="badge ok">OK</span> : <span className="badge bad">{r.errorCode ?? 'Error'}</span>}
            </div>
          ))}</div>
        )}
      </section>
    </div>
  );
}
