'use client';
import { useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useState } from 'react';
import { deviceLabel, stamp } from '@/lib/activity';
import { Icon } from '@/components/icons';
import { Empty, ErrorState, PageHead, SkeletonRows, Status } from '@/components/ui';
import { gql } from '@/lib/api';
import { when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

interface Ev { seq: string; id: string; actorId?: string; actorRole?: string; action: string; entityType?: string; entityId?: string; outcome: string; ip?: string; userAgent?: string; sessionId?: string; requestId?: string; metadataJson?: string; hash: string; createdAt: string }
const F = 'seq id actorId actorRole action entityType entityId outcome ip userAgent sessionId requestId metadataJson hash createdAt';
const SIZE = 50;

export default function Page() {
  return <Suspense fallback={<SkeletonRows />}><Audit /></Suspense>;
}

function Audit() {
  const sp = useSearchParams();
  const [requestId, setRequestId] = useState(sp.get('requestId') ?? '');
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [stack, setStack] = useState<string[]>([]);
  const cursor = stack[stack.length - 1];
  const { data, loading, error, refetch } = useQuery<{ auditEvents: Ev[] }>(`query($a:String,$b:String,$r:String){ auditEvents(limit:${SIZE}, action:$a, beforeSeq:$b, requestId:$r){ ${F} } }`, { a: applied || undefined, b: cursor, r: requestId || undefined });
  const [verify, setVerify] = useState<{ tone: string; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const rows = data?.auditEvents ?? [];
  return (
    <>
      <PageHead title="Audit trail" sub="Money and security events, written in the same transaction as the change, hash-chained so any edit is detectable. Every entry carries time, IP, device, session and request ID.">
        <button className="btn" onClick={async () => {
          setVerify({ tone: 'info', text: 'Checking the chain…' });
          try { const d = await gql(`{ verifyAuditChain { ok checked brokenAtSeq } }`); setVerify(d.verifyAuditChain.ok ? { tone: 'ok', text: `Chain intact: ${d.verifyAuditChain.checked} entries verified.` } : { tone: 'err', text: `Chain broken at entry #${d.verifyAuditChain.brokenAtSeq}. Escalate immediately.` }); }
          catch (e) { setVerify({ tone: 'err', text: (e as Error).message }); }
        }}><Icon name="shield" size={18} />Verify chain</button>
      </PageHead>
      {verify && <div className={`notice ${verify.tone}`} role="status" style={{ marginBottom: 16 }}><Icon name={verify.tone === 'ok' ? 'check' : verify.tone === 'err' ? 'alert' : 'info'} size={18} />{verify.text}</div>}
      <form className="row" style={{ marginBottom: 12 }} onSubmit={(e) => { e.preventDefault(); setApplied(action.trim()); setStack([]); }}>
        <div className="input-icon" style={{ width: 'min(340px, 100%)' }}><Icon name="search" size={18} /><input className="input" placeholder="Exact action, e.g. payment.approved" aria-label="Filter by action" value={action} onChange={(e) => setAction(e.target.value)} /></div>
        <button className="btn">Filter</button>
        {(applied || requestId) && <button type="button" className="btn btn-ghost" onClick={() => { setAction(''); setApplied(''); setRequestId(''); setStack([]); }}>Clear</button>}
        {requestId && <span className="badge info">Request {requestId.slice(0, 13)}…</span>}
      </form>
      <section className="panel">
        {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !rows.length ? <Empty icon="file" title={applied ? `No “${applied}” events` : 'No events'} /> : (
          <div className="table-wrap">
            <table className="t resp">
              <thead><tr><th>#</th><th>Action</th><th>Outcome</th><th className="hide-sm">Actor</th><th className="hide-sm">Target</th><th>Time</th><th><span className="sr-only">Details</span></th></tr></thead>
              <tbody>{rows.map((e) => (
                <Fragment key={e.id}>
                  <tr>
                    <td className="num t3" data-label="#">{e.seq}</td>
                    <td className="w5" data-label="Action">{e.action}</td>
                    <td data-label="Outcome"><Status value={e.outcome} /></td>
                    <td className="t2 hide-sm">{e.actorRole ? e.actorRole.replace('_', ' ').toLowerCase() : 'system'}<span className="sub" style={{ display: 'block' }}>{e.ip}</span></td>
                    <td className="t2 sm hide-sm">{e.entityType}<span className="sub" style={{ display: 'block' }}>{e.entityId?.slice(0, 13)}</span></td>
                    <td className="t2 sm num" data-label="Time">{when(e.createdAt)}</td>
                    <td className="r" data-label="Details"><button className="icon-btn" aria-expanded={open === e.id} aria-label="Show details" onClick={() => setOpen(open === e.id ? null : e.id)}><Icon name={open === e.id ? 'chevronDown' : 'chevronRight'} size={18} /></button></td>
                  </tr>
                  {open === e.id && <tr><td colSpan={7} style={{ height: 'auto', padding: 16, background: 'var(--bg-2)' }}>
                    <dl className="facts" style={{ marginBottom: 12 }}>
                      <div><dt>Time</dt><dd className="num sm">{stamp(e.createdAt)}</dd></div>
                      <div><dt>IP address</dt><dd className="num">{e.ip ?? '—'}</dd></div>
                      <div><dt>Device</dt><dd className="sm">{deviceLabel(e.userAgent)}</dd></div>
                      <div><dt>Session</dt><dd className="num sm">{e.sessionId ?? '—'}</dd></div>
                      <div><dt>Request ID</dt><dd className="num sm">{e.requestId ?? '—'}</dd></div>
                      <div><dt>Actor</dt><dd className="num sm">{e.actorId ?? 'system'}</dd></div>
                    </dl>
                    <pre className="sm" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(JSON.parse(e.metadataJson ?? '{}'), null, 2)}</pre>
                    <div className="t3" style={{ marginTop: 8, wordBreak: 'break-all' }}>hash {e.hash}</div>
                  </td></tr>}
                </Fragment>
              ))}</tbody>
            </table>
          </div>
        )}
        <div className="pager">
          <span>Newest first</span>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm" disabled={!stack.length} onClick={() => setStack((s) => s.slice(0, -1))}><Icon name="chevronLeft" size={16} />Newer</button>
            <button className="btn btn-sm" disabled={rows.length < SIZE} onClick={() => setStack((s) => [...s, rows[rows.length - 1].seq])}>Older<Icon name="chevronRight" size={16} /></button>
          </div>
        </div>
      </section>
    </>
  );
}
