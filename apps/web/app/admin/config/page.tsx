'use client';
import { useState } from 'react';
import { Icon } from '@/components/icons';
import { Dialog, ErrorState, PageHead, SkeletonRows, Status, useToast } from '@/components/ui';
import { gql } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { when } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

interface Version { id: string; key: string; version: number; valueJson: string; status: string; reason: string; makerId?: string; checkerId?: string; createdAt: string }
interface Item { key: string; description: string; valueJson: string; version: number; isDefault: boolean; pending?: Version }
const V = 'id key version valueJson status reason makerId checkerId createdAt';
const GROUP: Record<string, string> = { demo: 'Demo accounts', trading: 'Trading limits', payments: 'Payments', broker: 'Brokers', security: 'Security', ui: 'Trader app content' };
const short = (j: string) => (j.length > 80 ? j.slice(0, 80) + '…' : j);

export default function ConfigPage() {
  const { me } = useAuth();
  const { data, loading, error, refetch } = useQuery<{ configItems: Item[] }>(`{ configItems { key description valueJson version isDefault pending { ${V} } } }`);
  const [edit, setEdit] = useState<Item | null>(null);
  const [hist, setHist] = useState<string | null>(null);
  const toast = useToast();
  const decide = async (id: string, approve: boolean) => {
    try { await gql(`mutation($id:ID!,$a:Boolean!){ decideConfigChange(id:$id, approve:$a){ id } }`, { id, a: approve }); toast(approve ? 'Change approved and live' : 'Change rejected'); void refetch(); }
    catch (e) { if ((e as { code?: string }).code !== 'CANCELLED') toast((e as Error).message, true); }
  };
  const items = data?.configItems ?? [];
  const groups = Object.entries(items.reduce<Record<string, Item[]>>((a, i) => { (a[i.key.split('.')[0]] ??= []).push(i); return a; }, {}));
  const pending = items.filter((i) => i.pending).length;
  return (
    <div className="stack" style={{ gap: 32 }}>
      <PageHead title="Configuration" sub="Business rules stored in the database. Every change is validated and versioned, and needs a second Super Admin to approve it. Secrets never live here." />
      {pending > 0 && <div className="notice warn"><Icon name="info" size={18} />{pending} change{pending > 1 ? 's are' : ' is'} waiting for approval.</div>}
      {loading && !data ? <SkeletonRows rows={8} /> : error && !data ? <ErrorState error={error} retry={refetch} /> : groups.map(([g, list]) => (
        <section key={g} className="section">
          <h2>{GROUP[g] ?? g}</h2>
          <div className="panel list list-pad">
            {list.map((i) => (
              <div key={i.key} className="list-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div className="grow" style={{ minWidth: 240 }}>
                  <div className="w6">{i.description}</div>
                  <div className="t3"><code>{i.key}</code> · {i.isDefault ? 'default value' : `version ${i.version}`}</div>
                  <div style={{ marginTop: 6 }}><code className="badge" style={{ height: 'auto', padding: '4px 8px', whiteSpace: 'normal', wordBreak: 'break-word' }}>{short(i.valueJson)}</code></div>
                  {i.pending && (
                    <div className="notice warn" style={{ marginTop: 10 }}>
                      <Icon name="info" size={16} />
                      <span>Proposed <code>{short(i.pending.valueJson)}</code>: “{i.pending.reason}” · {when(i.pending.createdAt)}</span>
                    </div>
                  )}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {i.pending ? (i.pending.makerId === me?.id ? <span className="badge warn">Waiting for another admin</span> : <>
                    <button className="btn btn-sm btn-danger" onClick={() => decide(i.pending!.id, false)}>Reject</button>
                    <button className="btn btn-sm btn-primary" onClick={() => decide(i.pending!.id, true)}>Approve</button>
                  </>) : <button className="btn btn-sm" onClick={() => setEdit(i)}>Propose change</button>}
                  <button className="btn btn-sm btn-ghost" onClick={() => setHist(i.key)}>History</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {edit && <Propose item={edit} onClose={() => setEdit(null)} onDone={refetch} />}
      {hist && <History k={hist} onClose={() => setHist(null)} onDone={refetch} />}
    </div>
  );
}

function Propose({ item, onClose, onDone }: { item: Item; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState(JSON.stringify(JSON.parse(item.valueJson), null, 2));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  let ok = true; try { JSON.parse(value); } catch { ok = false; }
  return (
    <Dialog title="Propose a change" sub={item.description} onClose={onClose}>
      <div className="stack">
        <div className="field"><label htmlFor="v">New value</label><textarea id="v" className="input num" rows={Math.min(12, value.split('\n').length + 1)} value={value} aria-invalid={!ok} onChange={(e) => setValue(e.target.value)} />{ok ? <span className="hint">JSON. Checked against the rule’s schema when you submit.</span> : <span className="err">This isn’t valid JSON yet</span>}</div>
        <div className="field"><label htmlFor="r">Reason</label><input id="r" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this changing?" /><span className="hint">Shown to the approver and kept in the history</span></div>
        {err && <div className="notice err" role="alert"><Icon name="alert" size={18} />{err}</div>}
        <div className="actions" style={{ marginTop: 0 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !ok || reason.trim().length < 5} onClick={async () => {
            setBusy(true); setErr(null);
            try { await gql(`mutation($k:String!,$v:String!,$r:String!){ proposeConfigChange(key:$k, valueJson:$v, reason:$r){ id } }`, { k: item.key, v: JSON.stringify(JSON.parse(value)), r: reason }); toast('Change sent for approval'); onDone(); onClose(); }
            catch (e) { if ((e as { code?: string }).code !== 'CANCELLED') setErr((e as Error).message); } finally { setBusy(false); }
          }}>{busy ? 'Sending…' : 'Send for approval'}</button>
        </div>
      </div>
    </Dialog>
  );
}

function History({ k, onClose, onDone }: { k: string; onClose: () => void; onDone: () => void }) {
  const { data, error, refetch } = useQuery<{ configHistory: Version[] }>(`query($k:String!){ configHistory(key:$k){ ${V} } }`, { k });
  const toast = useToast();
  return (
    <Dialog title="Change history" sub={k} onClose={onClose}>
      {error ? <ErrorState error={error} retry={refetch} /> : !data ? <SkeletonRows rows={3} pad={false} /> : !data.configHistory.length ? <p className="t2">Still on the default value.</p> : (
        <div className="list">{data.configHistory.map((v) => (
          <div key={v.id} className="list-row" style={{ alignItems: 'flex-start' }}>
            <div className="grow stack" style={{ gap: 4 }}>
              <div className="row" style={{ gap: 8 }}><span className="w6">Version {v.version}</span><Status value={v.status} /></div>
              <code style={{ wordBreak: 'break-word' }}>{v.valueJson}</code>
              <span className="t3">{v.reason} · {when(v.createdAt)}</span>
            </div>
            {v.status === 'SUPERSEDED' && <button className="btn btn-sm" onClick={async () => {
              try { await gql(`mutation($k:String!,$v:Int!){ proposeConfigRollback(key:$k, toVersion:$v){ id } }`, { k, v: v.version }); toast('Rollback sent for approval'); onDone(); onClose(); }
              catch (e) { if ((e as { code?: string }).code !== 'CANCELLED') toast((e as Error).message, true); }
            }}>Restore</button>}
          </div>
        ))}</div>
      )}
    </Dialog>
  );
}
