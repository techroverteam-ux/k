'use client';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { gql } from '@/lib/api';
import { useToast } from '@/components/ui';
import { homeFor, useAuth, type Role } from '@/lib/auth';

const destinationFor = (role: Role) => role !== 'SUPER_ADMIN' || new URLSearchParams(window.location.search).get('from') === 'account' ? '/account' : homeFor(role);

/** Mandatory TOTP enrolment for Super Admins (optional for others via Security settings). */
export default function MfaSetup() {
  const { me, loading, reload, signOut } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const enrollment = useRef<Promise<{ beginMfaEnrollment: { secret: string; otpauthUrl: string } }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!me) return router.replace('/login');
    if (me.mfaEnabled) return router.replace(destinationFor(me.role));
    (enrollment.current ??= gql(`mutation { beginMfaEnrollment { secret otpauthUrl } }`))
      .then(async (d) => {
        setSecret(d.beginMfaEnrollment.secret);
        setQr(await QRCode.toDataURL(d.beginMfaEnrollment.otpauthUrl, { margin: 1, width: 220 }));
      })
      .catch((e) => setErr(e.message));
  }, [me, loading, router]);

  const confirm = async () => {
    setErr(null); setBusy(true);
    try {
      await gql(`mutation($c:String!){ confirmMfaEnrollment(code:$c) }`, { c: code });
      toast('Authenticator enabled. You can use it to recover your password.');
      const u = await reload();
      if (u) router.replace(destinationFor(u.role));
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="auth-main" style={{ minHeight: '100vh' }}>
      <div className="auth-card">
        <div>
          <h1>Set up two-step verification</h1>
          <p className="t2" style={{ marginTop: 6 }}>Use an authenticator app for sign-in and forgotten-password recovery. Keep access to this app: password recovery requires its current code.</p>
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
              <button className="btn btn-primary" disabled={busy || code.length !== 6} onClick={() => void confirm()}>
                {busy ? 'Enabling...' : 'Turn on'}
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
