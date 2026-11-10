'use client';
import { useSoleAdmin } from '@/lib/sole-admin';
import { useState } from 'react';
import { Icon } from '@/components/icons';
import { PAYMENT_FIELDS, type Payment } from '@/components/trading';
import { Confirm, Dialog, Empty, ErrorState, PageHead, SkeletonRows, Status, Tabs, useToast } from '@/components/ui';
import { gql } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { inr, when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

type T = 'review' | 'all';
export default function Transactions() {
  const { me } = useAuth();
  const sole = useSoleAdmin();
  const [tab, setTab] = useState<T>('review');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Payment | null>(null);
  const invalidDates = !!from && !!to && from > to;
  const filtersChanged = () => setPage(0);
  const { data, loading, error, refetch } = useQuery<{ paymentRequests: Payment[] }>(
    `query($s:[PaymentStatus!],$ty:PaymentType,$q:String,$f:DateTime,$t:DateTime,$o:Int){ paymentRequests(status:$s,type:$ty,search:$q,from:$f,to:$t,offset:$o,limit:50){ ${PAYMENT_FIELDS} } }`,
    { s: tab === 'review' ? ['REQUESTED'] : status ? [status] : undefined, ty: type || undefined, q: search || undefined, f: from ? new Date(`${from}T00:00:00+05:30`).toISOString() : undefined, t: to ? new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000).toISOString() : undefined, o: page * 50 }, { skip: invalidDates, pollMs: 10_000 });
  const [approve, setApprove] = useState<Payment | null>(null);
  const [reject, setReject] = useState<Payment | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const act = async (q: string, v: Record<string, unknown>, ok: string) => {
    setBusy(true); setErr(null);
    try { await gql(q, v); toast(ok); setApprove(null); setReject(null); setNote(''); void refetch(); }
    catch (e) { if ((e as { code?: string }).code !== 'CANCELLED') setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  const rows = data?.paymentRequests ?? [];
  return (
    <>
      <PageHead title="Transactions" sub="Deposit and withdrawal requests. Approving posts to the ledger straight away, and you can’t approve a request you raised." />
      <Tabs label="Filter" value={tab} onChange={(v) => { setTab(v); setPage(0); }} items={[{ v: 'review', label: `In review${tab === 'review' && data ? ` (${rows.length})` : ''}` }, { v: 'all', label: 'All requests' }]} />
      <div className="transaction-filters">
        <div className="field"><label htmlFor="tx-search">Account or transaction ID</label><input id="tx-search" className="input" type="search" value={search} onChange={(e) => { setSearch(e.target.value); filtersChanged(); }} /></div>
        <div className="field"><label htmlFor="tx-type">Type</label><select id="tx-type" className="input" value={type} onChange={(e) => { setType(e.target.value); filtersChanged(); }}><option value="">All types</option><option value="DEPOSIT">Deposit</option><option value="WITHDRAWAL">Withdrawal</option></select></div>
        {tab === 'all' && <div className="field"><label htmlFor="tx-status">Status</label><select id="tx-status" className="input" value={status} onChange={(e) => { setStatus(e.target.value); filtersChanged(); }}><option value="">All statuses</option>{['REQUESTED', 'APPROVED', 'POSTED', 'REJECTED', 'CANCELLED', 'FAILED'].map((v) => <option key={v}>{v}</option>)}</select></div>}
        <div className="field"><label htmlFor="tx-from">From (IST)</label><input id="tx-from" className="input" type="date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); filtersChanged(); }} /></div>
        <div className="field"><label htmlFor="tx-to">To (IST)</label><input id="tx-to" className="input" type="date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); filtersChanged(); }} /></div>
        <button className="btn" onClick={() => { setSearch(''); setType(''); setStatus(''); setFrom(''); setTo(''); setPage(0); }}>Clear filters</button>
      </div>
      {invalidDates && <p className="err" role="alert">The start date must be on or before the end date.</p>}
      <section style={{ marginTop: 8 }}>
        {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !rows.length ? (
          <Empty icon="check" title={tab === 'review' ? 'Nothing waiting for review' : 'No requests yet'}>New deposit and withdrawal requests appear here.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t resp">
              <thead><tr><th>Account</th><th>Type</th><th className="r">Amount</th><th>Status</th><th className="hide-sm">Requested</th><th className="r">Actions</th></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.id} className="transaction-row" tabIndex={0} aria-label={`View ${p.type.toLowerCase()} for ${p.username}`} onClick={() => setSelected(p)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSelected(p); } }}>
                  <td className="lead w6">{p.username}</td>
                  <td data-label="Type">{p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}</td>
                  <td className="r num w6" data-label="Amount">₹{inr(p.amount)}</td>
                  <td data-label="Status"><Status value={p.status} />{p.reviewNote && <span className="sub" style={{ display: 'block' }}>{p.reviewNote}</span>}</td>
                  <td className="t2 sm num hide-sm">{when(p.createdAt)}</td>
                  <td className="r acts" onClick={(e) => e.stopPropagation()}>
                    {p.status === 'REQUESTED' && ((p.requestedById === me?.id && !sole) || p.userId === me?.id ? <span className="t3">Needs another admin</span> : (
                      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
                        <button className="btn btn-sm btn-danger" onClick={() => { setErr(null); setNote(''); setReject(p); }}>Reject</button>
                        <button className="btn btn-sm btn-primary" onClick={() => { setErr(null); setApprove(p); }}>Approve</button>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      <div className="spread" style={{ marginTop: 12 }}><button className="btn btn-sm" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><span className="t3">Page {page + 1}</span><button className="btn btn-sm" disabled={rows.length < 50} onClick={() => setPage(page + 1)}>Next</button></div>
      {selected && <Dialog title="Transaction details" onClose={() => setSelected(null)} size="lg">
        <ul className="confirm-lines transaction-details">
          {([['Transaction ID', selected.id], ['Account', selected.username ?? selected.userId], ['Type', selected.type], ['Amount', `₹${inr(selected.amount)}`], ['Status', selected.status], ['Mode', selected.mode], ['Requested', when(selected.createdAt)], ['Requested by', selected.requestedByName ?? selected.requestedById], ['Reviewed', selected.reviewedAt ? when(selected.reviewedAt) : 'Awaiting review'], ['Reviewed by', selected.reviewedByName ?? selected.reviewedById ?? '—'], ['Review note', selected.reviewNote ?? '—'], ['Reference', selected.externalRef ?? '—'], ['Ledger entry', selected.journalId ?? '—']] as [string, string][]).map(([k, v]) => <li key={k}><span className="t2">{k}</span><span className="w6">{v}</span></li>)}
        </ul>
        <div className="actions"><button className="btn" onClick={() => setSelected(null)}>Close</button></div>
      </Dialog>}
      {approve && (
        <Confirm title={`Approve ${approve.type === 'DEPOSIT' ? 'deposit' : 'withdrawal'}?`} sub="This posts the amount to the ledger."
          lines={[['Account', approve.username ?? ''], ['Type', approve.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'], ['Amount', `₹${inr(approve.amount)}`], ['Requested', when(approve.createdAt)]]}
          warning={undefined}
          confirmLabel="Approve and post" pending={busy} error={err} onClose={() => setApprove(null)}
          onConfirm={() => act(`mutation($id:ID!){ approvePayment(id:$id){ id status } }`, { id: approve.id }, 'Approved and posted to the ledger')} />
      )}
      {reject && (
        <Dialog title="Reject this request?" sub={`${reject.username} · ₹${inr(reject.amount)}`} onClose={() => setReject(null)}>
          <div className="field"><label htmlFor="rn">Reason shown to the requester</label><textarea id="rn" className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          {err && <div className="notice err" role="alert" style={{ marginTop: 12 }}><Icon name="alert" size={18} />{err}</div>}
          <div className="actions"><button className="btn" onClick={() => setReject(null)}>Cancel</button><button className="btn btn-sell" disabled={busy || note.trim().length < 3} onClick={() => act(`mutation($id:ID!,$n:String!){ rejectPayment(id:$id, note:$n){ id } }`, { id: reject.id, n: note }, 'Request rejected')}>{busy ? 'Rejecting…' : 'Reject request'}</button></div>
        </Dialog>
      )}
    </>
  );
}
