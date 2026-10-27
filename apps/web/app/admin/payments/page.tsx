'use client';
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
  const [tab, setTab] = useState<T>('review');
  const { data, loading, error, refetch } = useQuery<{ paymentRequests: Payment[] }>(`query($s:[PaymentStatus!]){ paymentRequests(status:$s, limit:100){ ${PAYMENT_FIELDS} } }`, { s: tab === 'review' ? ['REQUESTED'] : undefined }, { pollMs: 10_000 });
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
      <Tabs label="Filter" value={tab} onChange={setTab} items={[{ v: 'review', label: `In review${tab === 'review' && data ? ` (${rows.length})` : ''}` }, { v: 'all', label: 'All requests' }]} />
      <section style={{ marginTop: 8 }}>
        {loading && !data ? <SkeletonRows /> : error && !data ? <ErrorState error={error} retry={refetch} /> : !rows.length ? (
          <Empty icon="check" title={tab === 'review' ? 'Nothing waiting for review' : 'No requests yet'}>New deposit and withdrawal requests appear here.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t resp">
              <thead><tr><th>Account</th><th>Type</th><th className="r">Amount</th><th>Status</th><th className="hide-sm">Requested</th><th className="r">Actions</th></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.id}>
                  <td className="lead w6">{p.username}</td>
                  <td data-label="Type">{p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}{p.mode === 'SIMULATED' && <span className="sub" style={{ display: 'block' }}>Virtual funds</span>}</td>
                  <td className="r num w6" data-label="Amount">₹{inr(p.amount)}</td>
                  <td data-label="Status"><Status value={p.status} />{p.reviewNote && <span className="sub" style={{ display: 'block' }}>{p.reviewNote}</span>}</td>
                  <td className="t2 sm num hide-sm">{when(p.createdAt)}</td>
                  <td className="r acts">
                    {p.status === 'REQUESTED' && (p.requestedById === me?.id || p.userId === me?.id ? <span className="t3">Needs another admin</span> : (
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
      {approve && (
        <Confirm title={`Approve ${approve.type === 'DEPOSIT' ? 'deposit' : 'withdrawal'}?`} sub="You’ll be asked to confirm with your authenticator code."
          lines={[['Account', approve.username ?? ''], ['Type', approve.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'], ['Amount', `₹${inr(approve.amount)}`], ['Requested', when(approve.createdAt)]]}
          warning={approve.mode === 'SIMULATED' ? 'This changes a virtual balance only. No money moves.' : undefined}
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
