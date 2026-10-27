'use client';
import { useState } from 'react';
import { CONSENT_FIELDS, deviceLabel, LOGIN_FIELDS, LOGIN_LABEL, stamp, type ConsentRecord, type LoginEvent } from '@/lib/activity';
import { useQuery } from '@/lib/hooks';
import { Icon } from './icons';
import { Dialog, Empty, ErrorState, SectionHead, SkeletonRows } from './ui';

const tone = (o: string) => (o === 'SUCCESS' ? 'ok' : o === 'DENIED' ? 'warn' : 'bad');

/** Sign-in history for one account (yours by default): successful and failed, with time, IP and device. */
export function LoginHistory({ userId, title = 'Login history' }: { userId?: string; title?: string }) {
  const [before, setBefore] = useState<string[]>([]);
  const { data, loading, error, refetch } = useQuery<{ loginHistory: LoginEvent[] }>(`query($u:ID,$b:String){ loginHistory(userId:$u, beforeSeq:$b, limit:20){ ${LOGIN_FIELDS} } }`, { u: userId, b: before[before.length - 1] });
  const rows = data?.loginHistory ?? [];
  return (
    <section className="section">
      <SectionHead title={title} />
      {loading && !data ? <SkeletonRows rows={3} pad={false} /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !rows.length ? <Empty icon="lock" title="No sign-ins recorded yet" /> : (
        <div className="list">
          {rows.map((r) => (
            <div key={r.seq} className="list-row" style={{ alignItems: 'flex-start' }}>
              <span className="mark" style={r.outcome !== 'SUCCESS' ? { background: 'var(--neg-soft)', color: 'var(--neg)' } : { background: 'var(--pos-soft)', color: 'var(--pos)' }}><Icon name={r.outcome === 'SUCCESS' ? 'lock' : 'alert'} size={18} /></span>
              <div className="grow">
                <div className="w5">{LOGIN_LABEL[r.action] ?? r.action}{r.outcome !== 'SUCCESS' && <span className={`badge ${tone(r.outcome)}`} style={{ marginLeft: 8 }}>{r.outcome === 'DENIED' ? 'Blocked' : 'Failed'}</span>}</div>
                <div className="t3">{stamp(r.at)}{r.detail ? ` · ${r.detail}` : ''}</div>
                <div className="t3">IP {r.ip ?? '—'} · {deviceLabel(r.userAgent)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {(rows.length === 20 || before.length > 0) && (
        <div className="row">
          <button className="btn btn-sm" disabled={!before.length} onClick={() => setBefore((b) => b.slice(0, -1))}>Newer</button>
          <button className="btn btn-sm" disabled={rows.length < 20} onClick={() => setBefore((b) => [...b, rows[rows.length - 1].seq])}>Older</button>
        </div>
      )}
    </section>
  );
}

/** Trading-rules acceptances (one per signed-in session) with the exact rules shown. */
export function ConsentHistory({ userId, title = 'Trading consents' }: { userId?: string; title?: string }) {
  const { data, loading, error, refetch } = useQuery<{ consentLog: ConsentRecord[] }>(`query($u:ID){ consentLog(userId:$u, limit:20){ ${CONSENT_FIELDS} } }`, { u: userId });
  const [open, setOpen] = useState<ConsentRecord | null>(null);
  const rows = data?.consentLog ?? [];
  return (
    <section className="section">
      <SectionHead title={title} />
      <p className="t2 sm">The trading rules are accepted at the start of every session. Each acceptance is kept with the time, IP address, device and the exact rules shown.</p>
      {loading && !data ? <SkeletonRows rows={2} pad={false} /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !rows.length ? <Empty icon="shield" title="No consents yet" /> : (
        <div className="list">
          {rows.map((c) => <ConsentRow key={c.id} c={c} onOpen={() => setOpen(c)} />)}
        </div>
      )}
      {open && <ConsentDialog c={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

export function ConsentRow({ c, onOpen, showUser }: { c: ConsentRecord; onOpen: () => void; showUser?: boolean }) {
  return (
    <button className="list-row" style={{ background: 'none', border: 0, width: '100%', textAlign: 'left', cursor: 'pointer', alignItems: 'flex-start' }} onClick={onOpen}>
      <span className="mark" style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}><Icon name="shield" size={18} /></span>
      <div className="grow">
        <div className="w5">{showUser ? `${c.displayName ?? c.username} accepted the trading rules` : 'Accepted the trading rules'}</div>
        <div className="t3">{stamp(c.acceptedAt)} · IP {c.ip} · {deviceLabel(c.userAgent)}</div>
        <div className="t3 xs num">Rules version {c.termsVersion.slice(0, 12)}… · {c.rules.length} rules</div>
      </div>
      <Icon name="chevronRight" size={18} />
    </button>
  );
}

export function ConsentDialog({ c, onClose }: { c: ConsentRecord; onClose: () => void }) {
  return (
    <Dialog title="Trading consent" sub={`${c.username ?? ''} · ${stamp(c.acceptedAt)}`} onClose={onClose}>
      <dl className="facts" style={{ gridTemplateColumns: '1fr' }}>
        {[['IP address', c.ip], ['Device', deviceLabel(c.userAgent)], ['App', c.client ?? '—'], ['Session', c.sessionId], ['Request ID', c.requestId ?? '—'], ['Rules version (SHA-256)', c.termsVersion]].map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd className="num" style={{ wordBreak: 'break-all', whiteSpace: 'normal' }}>{v}</dd></div>
        ))}
      </dl>
      <h3 style={{ margin: '16px 0 8px' }}>Rules shown</h3>
      <ol className="stack" style={{ paddingLeft: 20, gap: 8, margin: 0 }}>{c.rules.map((r) => <li key={r} className="sm">{r}</li>)}</ol>
      <div className="actions" style={{ marginTop: 16 }}><button className="btn btn-primary" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}
