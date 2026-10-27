'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { gql } from '@/lib/api';
import { homeFor, useAuth } from '@/lib/auth';
import { Icon, Logo } from '@/components/icons';
import { useToast } from '@/components/ui';

const STRONG = 'At least 10 characters, using three of: lowercase, uppercase, digits, symbols.';

type Step = 'signin' | 'mfa' | 'phone' | 'otp' | 'forgot' | 'reset' | 'signup' | 'signupDetails' | 'signupDone';
const DEVICE = typeof navigator !== 'undefined' ? `Web · ${navigator.platform || 'browser'}` : 'Web';

export default function Login() {
  const { me, signIn, settings, loading } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState<Step>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [mfaToken, setMfaToken] = useState('');
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPw, setNewPw] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [su, setSu] = useState({ displayName: '', username: '', email: '', password: '' });
  const toast = useToast();

  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get('mode');
    if (m === 'signup') setStep('signup');
    if (m === 'forgot') setStep('forgot');
  }, []);

  useEffect(() => {
    if (!loading && me) router.replace(me.role === 'SUPER_ADMIN' && !me.mfaEnabled ? '/mfa-setup' : homeFor(me.role));
  }, [me, loading, router]);
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (accessToken: string) => {
    const u = await signIn(accessToken);
    if (u) toast(`Signed in. Welcome${u.isDemo ? ' to your demo account' : `, ${u.displayName.split(' ')[0]}`}!`);
    if (u) router.replace(u.role === 'SUPER_ADMIN' && !u.mfaEnabled ? '/mfa-setup' : homeFor(u.role));
  };

  const onSignIn = (e: FormEvent) => {
    e.preventDefault();
    void go(async () => {
      const d = await gql(`mutation($u:String!,$p:String!,$d:String){ login(username:$u,password:$p,deviceName:$d){ accessToken mfaRequired mfaToken } }`, { u: username, p: password, d: DEVICE });
      if (d.login.mfaRequired) {
        setMfaToken(d.login.mfaToken);
        setCode('');
        setStep('mfa');
      } else await finish(d.login.accessToken);
    });
  };
  const onMfa = (e: FormEvent) => {
    e.preventDefault();
    void go(async () => {
      const d = await gql(`mutation($t:String!,$c:String!,$d:String){ completeMfaLogin(mfaToken:$t, code:$c, deviceName:$d){ accessToken } }`, { t: mfaToken, c: code, d: DEVICE });
      await finish(d.completeMfaLogin.accessToken);
    });
  };
  const sendOtp = (e?: FormEvent) => {
    e?.preventDefault();
    void go(async () => {
      const d = await gql(`mutation($p:String!){ requestDemoOtp(phone:$p){ sentTo resendAfterSec devCode } }`, { p: phone });
      setSentTo(d.requestDemoOtp.sentTo);
      setDevCode(d.requestDemoOtp.devCode);
      setResendIn(d.requestDemoOtp.resendAfterSec);
      setCode('');
      setStep('otp');
    });
  };
  const verifyOtp = (e: FormEvent) => {
    e.preventDefault();
    void go(async () => {
      const d = await gql(`mutation($p:String!,$c:String!,$d:String){ verifyDemoOtp(phone:$p, code:$c, deviceName:$d){ accessToken } }`, { p: phone, c: code, d: DEVICE });
      await finish(d.verifyDemoOtp.accessToken);
    });
  };

  // ---- forgot password
  const sendReset = (e?: FormEvent) => {
    e?.preventDefault();
    void go(async () => {
      const d = await gql(`mutation($u:String!){ requestPasswordReset(username:$u){ message resendAfterSec devCode } }`, { u: username });
      setInfo(d.requestPasswordReset.message);
      setDevCode(d.requestPasswordReset.devCode);
      setResendIn(d.requestPasswordReset.resendAfterSec);
      setCode('');
      setNewPw('');
      setStep('reset');
    });
  };
  const doReset = (e: FormEvent) => {
    e.preventDefault();
    void go(async () => {
      await gql(`mutation($u:String!,$c:String!,$p:String!){ resetPassword(username:$u, code:$c, newPassword:$p) }`, { u: username, c: code, p: newPw });
      toast('Password changed. Sign in with your new password.');
      setPassword('');
      setStep('signin');
    });
  };
  // ---- sign-up
  const sendSignupOtp = (e?: FormEvent) => {
    e?.preventDefault();
    void go(async () => {
      const d = await gql(`mutation($p:String!){ requestSignupOtp(phone:$p){ sentTo resendAfterSec devCode } }`, { p: phone });
      setSentTo(d.requestSignupOtp.sentTo);
      setDevCode(d.requestSignupOtp.devCode);
      setResendIn(d.requestSignupOtp.resendAfterSec);
      setCode('');
      setStep('signupDetails');
    });
  };
  const register = (e: FormEvent) => {
    e.preventDefault();
    void go(async () => {
      await gql(`mutation($i:RegisterInput!){ registerTrader(input:$i){ username status } }`, { i: { ...su, email: su.email || undefined, phone, code } });
      setUsername(su.username.trim().toLowerCase());
      setStep('signupDone');
    });
  };

  const title = { signin: 'Welcome back', mfa: 'Two-step verification', phone: 'Get a demo account', otp: 'Verify your number', forgot: 'Reset your password', reset: 'Enter the code', signup: 'Create an account', signupDetails: 'Your details', signupDone: 'Request received' }[step];
  const sub = {
    signin: 'Use the username your administrator or broker gave you.',
    mfa: 'Enter the 6-digit code from your authenticator app.',
    phone: 'We’ll text a one-time code. Demo accounts use virtual money only.',
    otp: `Enter the code sent to ${sentTo}.`,
    forgot: 'We’ll text a code to the mobile number on your account.',
    reset: info ?? '',
    signup: 'Start with your mobile number. We’ll text a code to verify it.',
    signupDetails: `Enter the code sent to ${sentTo} and choose your sign-in details.`,
    signupDone: 'An administrator will review your account. You can sign in once it’s approved.',
  }[step];
  const back: Partial<Record<Step, Step>> = { mfa: 'signin', phone: 'signin', otp: 'phone', forgot: 'signin', reset: 'forgot', signup: 'signin', signupDetails: 'signup' };
  const otpInput = (id: string) => (
    <div className="field">
      <label htmlFor={id}>6-digit code</label>
      <input id={id} className="input num" style={{ fontSize: 20, letterSpacing: '0.3em', textAlign: 'center', height: 52 }} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus aria-invalid={!!err} />
    </div>
  );
  const devNote = devCode && <div className="notice info"><Icon name="info" size={18} /><span>Development mode code: <strong className="num">{devCode}</strong>. Never shown in production.</span></div>;
  const errNote = err && <div className="notice err" role="alert"><Icon name="alert" size={18} />{err}</div>;
  const phoneInput = (
    <div className="field">
      <label htmlFor="ph">Mobile number</label>
      <div style={{ position: 'relative' }}>
        <span className="t2" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}>+91</span>
        <input id="ph" className="input num" style={{ paddingLeft: 48 }} inputMode="tel" autoComplete="tel-national" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} required autoFocus aria-invalid={!!err} />
      </div>
      <span className="hint">We’ll text a 6-digit code to verify it’s you.</span>
    </div>
  );

  return (
    <div className="auth">
      <section className="auth-side" aria-hidden>
        <div className="logo" style={{ width: 'auto' }}><Logo size={32} /><span className="wordmark">{settings?.appName ?? 'The K'}</span></div>
        <div className="stack" style={{ gap: 24 }}>
          <div className="lead">Practise the markets with zero risk.</div>
          <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 14 }}>
            {[['trend', 'Live simulated prices for NSE and MCX futures'], ['shield', 'Virtual balance. No real money is ever at risk'], ['file', 'Every order and fund movement is recorded']].map(([ic, t]) => (
              <li key={t} className="row" style={{ flexWrap: 'nowrap' }}><span className="mark" style={{ background: 'var(--brand-soft)', color: 'var(--brand)' }}><Icon name={ic as 'trend'} size={18} /></span><span className="t2">{t}</span></li>
            ))}
          </ul>
        </div>
        <p className="t3">Paper trading only. Orders are never sent to an exchange.</p>
      </section>
      <section className="auth-main">
        <div className="auth-card">
          <div className="logo only-mob" style={{ width: 'auto' }}><Logo size={36} /></div>
          <div>
            {back[step] && (
              <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: -12, marginBottom: 8 }} onClick={() => { setErr(null); setDevCode(null); setStep(back[step]!); }}>
                <Icon name="chevronLeft" size={16} />Back
              </button>
            )}
            <h1>{title}</h1>
            <p className="t2" style={{ marginTop: 6 }}>{sub}</p>
          </div>

          {step === 'signin' && (
            <form className="stack" onSubmit={onSignIn} noValidate>
              <div className="field">
                <label htmlFor="u">Username</label>
                <input id="u" className="input" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={40} aria-invalid={!!err} />
              </div>
              <div className="field">
                <label htmlFor="p">Password</label>
                <div style={{ position: 'relative' }}>
                  <input id="p" className="input" style={{ paddingRight: 64 }} type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={128} aria-invalid={!!err} />
                  <button type="button" className="btn btn-sm btn-ghost" style={{ position: 'absolute', right: 4, top: 4 }} onClick={() => setShow((s) => !s)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
                </div>
              </div>
              {err && <div className="notice err" role="alert"><Icon name="alert" size={18} />{err}</div>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
              <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-end', marginTop: -8 }} onClick={() => { setErr(null); setStep('forgot'); }}>Forgot password?</button>
              <div className="row" style={{ flexWrap: 'nowrap', gap: 12 }}><hr className="divider grow" /><span className="t3">or</span><hr className="divider grow" /></div>
              <div className="row" style={{ flexWrap: 'nowrap', gap: 12 }}>
                {settings?.demoEnabled !== false && <button type="button" className="btn btn-lg grow" onClick={() => { setErr(null); setStep('phone'); }}>Try a demo</button>}
                {settings?.signupEnabled !== false && <button type="button" className="btn btn-lg grow" onClick={() => { setErr(null); setStep('signup'); }}>Create account</button>}
              </div>
            </form>
          )}

          {step === 'mfa' && (
            <form className="stack" onSubmit={onMfa}>
              <div className="field">
                <label htmlFor="c">6-digit code</label>
                <input id="c" className="input num" style={{ fontSize: 20, letterSpacing: '0.3em', textAlign: 'center', height: 52 }} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus aria-invalid={!!err} />
              </div>
              {err && <div className="notice err" role="alert"><Icon name="alert" size={18} />{err}</div>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify and sign in'}</button>
            </form>
          )}

          {step === 'phone' && (
            <form className="stack" onSubmit={sendOtp}>
              <div className="field">
                <label htmlFor="ph">Mobile number</label>
                <div style={{ position: 'relative' }}>
                  <span className="t2" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}>+91</span>
                  <input id="ph" className="input num" style={{ paddingLeft: 48 }} inputMode="tel" autoComplete="tel-national" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} required autoFocus aria-invalid={!!err} />
                </div>
                <span className="hint">We’ll text a 6-digit code to verify it’s you.</span>
              </div>
              {err && <div className="notice err" role="alert"><Icon name="alert" size={18} />{err}</div>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || phone.length !== 10}>{busy ? 'Sending…' : 'Send code'}</button>
              <p className="t3" style={{ textAlign: 'center' }}>Demo accounts use virtual money for practice only.</p>
            </form>
          )}

          {step === 'otp' && (
            <form className="stack" onSubmit={verifyOtp}>
              <div className="field">
                <label htmlFor="otp">6-digit code</label>
                <input id="otp" className="input num" style={{ fontSize: 20, letterSpacing: '0.3em', textAlign: 'center', height: 52 }} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus aria-invalid={!!err} />
              </div>
              {devCode && <div className="notice info"><Icon name="info" size={18} /><span>Development mode code: <strong className="num">{devCode}</strong>. Never shown in production.</span></div>}
              {err && <div className="notice err" role="alert"><Icon name="alert" size={18} />{err}</div>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify and continue'}</button>
              <button type="button" className="btn btn-ghost btn-block" disabled={resendIn > 0 || busy} onClick={() => sendOtp()}>{resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}</button>
            </form>
          )}

          {step === 'forgot' && (
            <form className="stack" onSubmit={sendReset}>
              <div className="field">
                <label htmlFor="fu">Username</label>
                <input id="fu" className="input" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={40} autoFocus />
              </div>
              {errNote}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username}>{busy ? 'Sending…' : 'Send code'}</button>
              <p className="t3" style={{ textAlign: 'center' }}>No mobile number on your account, or an administrator account? Ask your broker or administrator to reset it.</p>
            </form>
          )}

          {step === 'reset' && (
            <form className="stack" onSubmit={doReset}>
              {otpInput('rc')}
              <div className="field">
                <label htmlFor="np">New password</label>
                <input id="np" className="input" type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required maxLength={128} />
                <span className="hint">{STRONG}</span>
              </div>
              {devNote}
              {errNote}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length !== 6 || newPw.length < 10}>{busy ? 'Saving…' : 'Set new password'}</button>
              <button type="button" className="btn btn-ghost btn-block" disabled={resendIn > 0 || busy} onClick={() => sendReset()}>{resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}</button>
              <p className="t3" style={{ textAlign: 'center' }}>Changing your password signs you out on every device.</p>
            </form>
          )}

          {step === 'signup' && (
            <form className="stack" onSubmit={sendSignupOtp}>
              {phoneInput}
              {errNote}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || phone.length !== 10}>{busy ? 'Sending…' : 'Send code'}</button>
              <p className="t3" style={{ textAlign: 'center' }}>New accounts are reviewed by an administrator before first sign-in. Paper trading only.</p>
            </form>
          )}

          {step === 'signupDetails' && (
            <form className="stack" onSubmit={register}>
              {otpInput('sc')}
              <div className="field"><label htmlFor="sn">Full name</label><input id="sn" className="input" autoComplete="name" value={su.displayName} onChange={(e) => setSu({ ...su, displayName: e.target.value })} required maxLength={120} /></div>
              <div className="field">
                <label htmlFor="sun">Username</label>
                <input id="sun" className="input" autoComplete="username" autoCapitalize="none" value={su.username} onChange={(e) => setSu({ ...su, username: e.target.value.toLowerCase() })} required maxLength={40} />
                <span className="hint">4–40 characters, starting with a letter. Letters, digits, “.” and “_”.</span>
              </div>
              <div className="field"><label htmlFor="se">Email <span className="t3">(optional)</span></label><input id="se" className="input" type="email" autoComplete="email" value={su.email} onChange={(e) => setSu({ ...su, email: e.target.value })} maxLength={254} /></div>
              <div className="field">
                <label htmlFor="sp">Password</label>
                <input id="sp" className="input" type="password" autoComplete="new-password" value={su.password} onChange={(e) => setSu({ ...su, password: e.target.value })} required maxLength={128} />
                <span className="hint">{STRONG}</span>
              </div>
              {devNote}
              {errNote}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length !== 6 || !su.displayName || !su.username || su.password.length < 10}>{busy ? 'Creating…' : 'Create account'}</button>
              <button type="button" className="btn btn-ghost btn-block" disabled={resendIn > 0 || busy} onClick={() => sendSignupOtp()}>{resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}</button>
            </form>
          )}

          {step === 'signupDone' && (
            <div className="stack">
              <div className="notice info"><Icon name="check" size={18} /><span>Your username is <strong>{username}</strong>. We’ll show your account as pending until it’s approved.</span></div>
              <button className="btn btn-primary btn-lg btn-block" onClick={() => { setPassword(''); setStep('signin'); }}>Back to sign in</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
