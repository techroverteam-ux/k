'use client';
import { useState } from 'react';
import { gql } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useQuery } from '@/lib/hooks';
import { Icon } from './icons';
import { useToast } from './ui';

interface Status { required: boolean; termsVersion: string; rules: string[] }

/**
 * Trading consent, once per signed-in session: the trader must accept the current rules before
 * they can trade. The API stores each acceptance with time, IP, device, session and the exact
 * rules text (and refuses orders until it exists).
 */
export function TermsGate() {
  const { me } = useAuth();
  const toast = useToast();
  const st = useQuery<{ tradingConsentStatus: Status }>(`{ tradingConsentStatus { required termsVersion rules } }`, undefined, { skip: me?.role !== 'TRADER' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = st.data?.tradingConsentStatus;
  if (!me || me.role !== 'TRADER' || !s?.required) return null;
  const accept = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await gql<{ acceptTradingConsent: { acceptedAt: string; ip: string } }>(`mutation($v:String!){ acceptTradingConsent(termsVersion:$v){ acceptedAt ip } }`, { v: s.termsVersion });
      toast(`Rules accepted · recorded ${new Date(d.acceptTradingConsent.acceptedAt).toLocaleTimeString('en-IN')} from IP ${d.acceptTradingConsent.ip}`);
      await st.refetch();
    } catch (e) {
      setErr((e as Error).message);
      await st.refetch(); // rules may have changed
    } finally { setBusy(false); }
  };
  return (
    <div className="consent" role="dialog" aria-modal="true" aria-labelledby="consent-t">
      <div className="consent-card">
        <div className="consent-head">
          <span className="mark" style={{ background: 'var(--brand-soft)', color: 'var(--brand)', borderRadius: '50%' }}><Icon name="shield" size={20} /></span>
          <div><h2 id="consent-t">Terms & Rules</h2><p className="t2 sm">Please read before you start trading</p></div>
        </div>
        <div className="consent-body">
          <ol>{s.rules.map((r) => <li key={r}><span>{r}</span></li>)}</ol>
        </div>
        <div className="consent-foot">
          {err && <div className="notice err" role="alert"><Icon name="alert" size={18} />{err}</div>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={() => void accept()}>{busy ? 'Recording…' : 'I understand & accept'}</button>
          <p className="t3 xs" style={{ textAlign: 'center' }}>Asked every time you sign in. Your acceptance is recorded with the time, your IP address and device.</p>
        </div>
      </div>
    </div>
  );
}
