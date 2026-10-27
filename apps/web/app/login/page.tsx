'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { gql, takeSignedOutReason } from '@/lib/api';
import { deviceLabel, stamp } from '@/lib/activity';

const AUTH_FIELDS = 'accessToken sessionConflict conflictToken conflictLimit activeSessions { id deviceName userAgent ip lastUsedAt }';
interface Conflict { token: string; limit: number; sessions: { id: string; deviceName?: string; userAgent?: string; ip?: string; lastUsedAt: string }[] }
import { homeFor, useAuth } from '@/lib/auth';
import { Icon, Logo } from '@/components/icons';
import { useToast } from '@/components/ui';
import { MarketBoard } from '@/components/MarketBoard';

const LAST_USER = 'k.lastUsername';

const STRONG = 'At least 10 characters, using three of: lowercase, uppercase, digits, symbols.';

type Step = 'conflict' | 'signin' | 'mfa' | 'phone' | 'otp' | 'forgot' | 'reset' | 'signup' | 'signupDetails' | 'signupDone';
const DEVICE = typeof navigator !== 'undefined' ? `Web · ${navigator.platform || 'browser'}` : 'Web';

export default function Login() {
  const { me, signIn, settings, loading } = useAuth();
  const router = useRouter();
  const [step, setStep] = useState<Step>('signin');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
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
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [signedOut, setSignedOut] = useState<string | null>(null);
  useEffect(() => { const m = takeSignedOutReason(); if (m) setSignedOut(m); }, []); // guarded: React dev runs effects twice
  useEffect(() => { try { const u = localStorage.getItem(LAST_USER); if (u) setUsername(u); } catch { /* storage unavailable */ } }, []);

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

  /** Either signed in, or the account is already signed in elsewhere: ask before signing that device out. */
  const done = async (p: { accessToken?: string; sessionConflict?: boolean; conflictToken?: string; conflictLimit?: number; activeSessions?: Conflict['sessions'] }) => {
    if (p.sessionConflict && p.conflictToken) {
      setConflict({ token: p.conflictToken, limit: p.conflictLimit ?? 1, sessions: p.activeSessions ?? [] });
      setStep('conflict');
      return;
    }
    if (p.accessToken) await finish(p.accessToken);
  };
  const forceLogin = () => {
    void go(async () => {
      const d = await gql(`mutation($t:String!,$d:String){ forceLogin(conflictToken:$t, deviceName:$d){ ${AUTH_FIELDS} } }`, { t: conflict!.token, d: DEVICE });
      await done(d.forceLogin);
    });
  };
  const finish = async (accessToken: string) => {
    const u = await signIn(accessToken);
    if (u) toast(`Signed in. Welcome${u.isDemo ? ' to your demo account' : `, ${u.displayName.split(' ')[0]}`}!`);
    if (u) router.replace(u.role === 'SUPER_ADMIN' && !u.mfaEnabled ? '/mfa-setup' : homeFor(u.role));
  };

  const onSignIn = (e: FormEvent) => {
    e.preventDefault();
    void go(async () => {
      const d = await gql(`mutation($u:String!,$p:String!,$d:String){ login(username:$u,password:$p,deviceName:$d){ mfaRequired mfaToken ${AUTH_FIELDS} } }`, { u: username, p: password, d: DEVICE });
      try { localStorage.setItem(LAST_USER, username.trim()); } catch { /* storage unavailable */ }
      if (d.login.mfaRequired) {
        setMfaToken(d.login.mfaToken);
        setCode('');
        setStep('mfa');
      } else await done(d.login);
    });
  };
  const onMfa = (e: FormEvent) => {
    e.preventDefault();
    void go(async () => {
      const d = await gql(`mutation($t:String!,$c:String!,$d:String){ completeMfaLogin(mfaToken:$t, code:$c, deviceName:$d){ ${AUTH_FIELDS} } }`, { t: mfaToken, c: code, d: DEVICE });
      await done(d.completeMfaLogin);
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
      const d = await gql(`mutation($p:String!,$c:String!,$d:String){ verifyDemoOtp(phone:$p, code:$c, deviceName:$d){ ${AUTH_FIELDS} } }`, { p: phone, c: code, d: DEVICE });
      await done(d.verifyDemoOtp);
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

  const title = { conflict: 'Already signed in', signin: 'Sign in', mfa: 'Two-step verification', phone: 'Sign in with mobile', otp: 'Verify your number', forgot: 'Reset your password', reset: 'Enter the code', signup: 'Create an account', signupDetails: 'Your details', signupDone: 'Request received' }[step];
  const sub = {
    conflict: conflict && conflict.limit > 1 ? `Your account can be signed in on ${conflict.limit} devices at once, and it already is.` : 'Your account is signed in on another device. You can sign that device out and continue here.',
    signin: `Welcome back to ${settings?.appName ?? 'The K'}.`,
    mfa: 'Enter the 6-digit code from your authenticator app.',
    phone: 'We’ll text you a one-time code. New numbers get a demo account with a virtual balance.',
    otp: `Enter the code sent to ${sentTo}.`,
    forgot: 'We’ll text a code to the mobile number on your account.',
    reset: info ?? '',
    signup: 'Start with your mobile number. We’ll text a code to verify it.',
    signupDetails: `Enter the code sent to ${sentTo} and choose your sign-in details.`,
    signupDone: 'An administrator will review your account. You can sign in once it’s approved.',
  }[step];
  const back: Partial<Record<Step, Step>> = { conflict: 'signin', mfa: 'signin', phone: 'signin', otp: 'phone', forgot: 'signin', reset: 'forgot', signup: 'signin', signupDetails: 'signup' };
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
      <section className="auth-side">
        <div className="auth-brand"><Logo size={30} /><span className="wordmark">{settings?.appName ?? 'The K'}</span></div>
        <MarketBoard />
      </section>
      <section className="auth-main">
        <div className="auth-card">
          <div className="auth-mob-head"><div className="auth-brand"><Logo size={30} /><span className="wordmark">{settings?.appName ?? 'The K'}</span></div><MarketBoard variant="strip" /></div>
          <div>
            {back[step] && (
              <button type="button" className="btn btn-sm btn-ghost" style={{ marginLeft: -12, marginBottom: 8 }} onClick={() => { setErr(null); setDevCode(null); setStep(back[step]!); }}>
                <Icon name="chevronLeft" size={16} />Back
              </button>
            )}
            <h1 className="auth-title">{title}</h1>
            <p className="t2" style={{ marginTop: 6 }}>{sub}</p>
          </div>

          {(step === 'signin' || (step === 'phone' && settings?.demoEnabled !== false)) && settings?.demoEnabled !== false && (
            <div className="seg" role="tablist" aria-label="Sign-in method">
              <button type="button" role="tab" aria-selected={step === 'signin'} className={step === 'signin' ? 'on' : ''} onClick={() => { setErr(null); setStep('signin'); }}><Icon name="user" size={16} />Username</button>
              <button type="button" role="tab" aria-selected={step === 'phone'} className={step === 'phone' ? 'on' : ''} onClick={() => { setErr(null); setStep('phone'); }}><Icon name="device" size={16} />Mobile number</button>
            </div>
          )}

          {step === 'conflict' && conflict && (
            <div className="stack">
              <div className="list">
                {conflict.sessions.map((x) => (
                  <div key={x.id} className="list-row">
                    <span className="mark"><Icon name="device" size={18} /></span>
                    <div className="grow"><div className="w5">{x.deviceName || deviceLabel(x.userAgent)}</div><div className="t3">IP {x.ip ?? '—'} · last active {stamp(x.lastUsedAt)}</div></div>
                  </div>
                ))}
              </div>
              <div className="notice warn"><Icon name="info" size={18} /><span>Continuing here signs {conflict.sessions.length === 1 ? 'that device' : 'those devices'} out straight away. If you don’t recognise {conflict.sessions.length === 1 ? 'it' : 'them'}, continue and then change your password.</span></div>
              {errNote}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={forceLogin}>{busy ? 'Signing in…' : 'Sign out other device & continue here'}</button>
              <button className="btn btn-lg btn-block" disabled={busy} onClick={() => { setConflict(null); setPassword(''); setStep('signin'); }}>Cancel</button>
            </div>
          )}

          {step === 'signin' && (
            <form className="stack" onSubmit={onSignIn} noValidate>
              {signedOut && <div className="notice warn" role="status"><Icon name="info" size={18} />{signedOut}</div>}
              <div className="field">
                <label htmlFor="u">Username</label>
                <div className="input-ic">
                  <Icon name="user" size={18} />
                  <input id="u" className="input" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={40} aria-invalid={!!err} autoFocus={!username} placeholder="e.g. trader.one" />
                </div>
              </div>
              <div className="field">
                <div className="label-row">
                  <label htmlFor="p">Password</label>
                  <button type="button" className="link-btn" onClick={() => { setErr(null); setStep('forgot'); }}>Forgot password?</button>
                </div>
                <div className="input-ic">
                  <Icon name="lock" size={18} />
                  <input id="p" className="input" style={{ paddingRight: 48 }} type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyUp={(e) => setCaps(e.getModifierState?.('CapsLock') ?? false)} onBlur={() => setCaps(false)} required maxLength={128} aria-invalid={!!err} autoFocus={!!username} aria-describedby={caps ? 'caps' : undefined} />
                  <button type="button" className="eye" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}><Icon name="eye" size={18} /></button>
                </div>
                {caps && <span id="caps" className="hint warn-t">Caps Lock is on.</span>}
              </div>
              {err && <div className="notice err" role="alert"><Icon name="alert" size={18} />{err}</div>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username || !password}>{busy ? <><span className="spin" aria-hidden />Signing in…</> : 'Sign in'}</button>
              {settings?.signupEnabled !== false && (
                <p className="t2 auth-alt">New to {settings?.appName ?? 'The K'}? <button type="button" className="link-btn" onClick={() => { setErr(null); setStep('signup'); }}>Create an account</button></p>
              )}
            </form>
          )}

          {step === 'mfa' && (
            <form className="stack" onSubmit={onMfa}>
              <div className="field">
                <label htmlFor="c">6-digit code</label>
                <input id="c" className="input num" style={{ fontSize: 20, letterSpacing: '0.3em', textAlign: 'center', height: 52 }} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus aria-invalid={!!err} />
              </div>
              {err && <div className="notice err" role="alert"><Icon name="alert" size={18} />{err}</div>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length !== 6}>{busy ? <><span className="spin" aria-hidden />Verifying…</> : 'Verify and sign in'}</button>
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
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || phone.length !== 10}>{busy ? <><span className="spin" aria-hidden />Sending…</> : 'Send code'}</button>
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
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length !== 6}>{busy ? <><span className="spin" aria-hidden />Verifying…</> : 'Verify and continue'}</button>
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
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username}>{busy ? <><span className="spin" aria-hidden />Sending…</> : 'Send code'}</button>
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
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || phone.length !== 10}>{busy ? <><span className="spin" aria-hidden />Sending…</> : 'Send code'}</button>
              <p className="t3" style={{ textAlign: 'center' }}>New accounts are reviewed by an administrator before first sign-in.</p>
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
