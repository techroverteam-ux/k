'use client';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { gql } from '@/lib/api';
import { homeFor, useAuth } from '@/lib/auth';

/** Mandatory TOTP enrolment for Super Admins (optional for others via Security settings). */
export default function MfaSetup() {
  const { me, loading, reload, signOut } = useAuth();
  const router = useRouter();
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!me) return router.replace('/login');
    if (me.mfaEnabled) return router.replace(homeFor(me.role));
    gql(`mutation { beginMfaEnrollment { secret otpauthUrl } }`)
      .then(async (d) => {
        setSecret(d.beginMfaEnrollment.secret);
        setQr(await QRCode.toDataURL(d.beginMfaEnrollment.otpauthUrl, { margin: 1, width: 220 }));
      })
      .catch((e) => setErr(e.message));
  }, [me, loading, router]);

  const confirm = async () => {
    setErr(null);
    try {
      await gql(`mutation($c:String!){ confirmMfaEnrollment(code:$c) }`, { c: code });
      const u = await reload();
      if (u) router.replace(homeFor(u.role));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="auth-main" style={{ minHeight: '100vh' }}>
      <div className="auth-card">
        <div>
          <h1>Set up two-step verification</h1>
          <p className="t2" style={{ marginTop: 6 }}>Administrator accounts must use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).</p>
        </div>
        <ol className="stack" style={{ paddingLeft: 20, gap: 12, margin: 0 }}>
          <li>
            Scan this code with your app.
            <div style={{ marginTop: 10 }}>{qr ? <img src={qr} alt="QR code for authenticator app" width={180} height={180} style={{ borderRadius: 12, background: '#fff', padding: 6 }} /> : <div className="skeleton" style={{ width: 180, height: 180 }} />}</div>
            <p className="t3" style={{ marginTop: 8 }}>
              Can’t scan? Enter this key: <code style={{ wordBreak: 'break-all' }}>{secret}</code>
            </p>
          </li>
          <li>
            Enter the 6-digit code it shows.
            <div className="row" style={{ marginTop: 8, flexWrap: 'nowrap' }}>
              <input className="input" aria-label="Authenticator code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <button className="btn btn-primary" disabled={code.length !== 6} onClick={() => void confirm()}>
                Turn on
              </button>
            </div>
          </li>
        </ol>
        {err && <div className="notice err" role="alert">{err}</div>}
        <button className="btn btn-ghost" onClick={() => void signOut()}>Sign out</button>
      </div>
    </div>
  );
}
