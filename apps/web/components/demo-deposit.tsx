'use client';
/**
 * DEMO ONLY: what a broker's "add funds" screen will look like (bank, QR, UTR, screenshot).
 * The details below are fixed sample values, not a real account, and the QR is a placeholder that can't be scanned.
 * Nothing typed or attached here is sent anywhere: practice funds are still only added by a Super Admin's approval.
 * Replace this with a licensed payment gateway once the company is a SEBI-registered broker.
 */
import { useState } from 'react';
import { toProofDataUrl } from '@/lib/image';
import { Icon } from './icons';

const DEMO_BANK: [string, string][] = [
  ['Account name', 'The K Securities (DEMO)'],
  ['Bank', 'DEMO BANK'],
  ['Account no.', '0000 0000 0000'],
  ['IFSC', 'DEMO0000000'],
  ['UPI ID', 'not-a-real-upi (demo)'],
];

export function DemoDepositDetails() {
  const [utr, setUtr] = useState('');
  const [shot, setShot] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="demo-pay">
      <div className="notice warn"><Icon name="info" size={16} />Demo preview: sample details, not a real account. Don’t send money. Funds are added when an administrator approves.</div>
      <div className="demo-pay-row">
        <div className="demo-qr" role="img" aria-label="Demo QR placeholder, not scannable"><b>DEMO QR</b><small>not scannable</small></div>
        <dl className="demo-bank">
          {DEMO_BANK.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </div>
      <div className="field">
        <label htmlFor="demo-utr">UTR / transaction no. <span className="t3">(demo)</span></label>
        <input id="demo-utr" className="input" autoComplete="off" placeholder="e.g. 431298765012" value={utr} onChange={(e) => setUtr(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 22))} />
      </div>
      <div className="field">
        <span className="demo-label">Payment screenshot <span className="t3">(demo)</span></span>
        {shot ? (
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <img src={shot} alt="Attached screenshot" className="demo-shot" />
            <button type="button" className="btn btn-sm" onClick={() => setShot(null)}>Remove</button>
          </div>
        ) : (
          <label className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>
            <Icon name="plus" size={16} />Attach screenshot
            <input type="file" accept="image/*" hidden onChange={async (e) => {
              const f = e.target.files?.[0]; e.target.value = '';
              if (!f) return;
              setErr(null);
              try { setShot(await toProofDataUrl(f)); } catch (x) { setErr((x as Error).message); }
            }} />
          </label>
        )}
        {err && <span className="err">{err}</span>}
        <span className="hint">Demo only: the UTR and screenshot stay on this screen and aren’t sent.</span>
      </div>
    </div>
  );
}
