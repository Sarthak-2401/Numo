import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authAPI } from '../services/api';
import { useAuth } from '../context/AuthContext';

export function EnrollRecoveryEmail({ enrollmentToken, restart }: { enrollmentToken: string; restart: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const { signIn } = useAuth();
  const navigate = useNavigate();

  async function sendCode() {
    setBusy(true); setError(''); setNotice('');
    try {
      await authAPI.sendEmailCode(enrollmentToken, email.trim());
      setSent(true); setCode(''); setNotice('A verification code was sent to ' + email.trim() + '.');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Could not send the verification email.');
    } finally { setBusy(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!sent) { await sendCode(); return; }
    setBusy(true); setError('');
    try {
      const { data } = await authAPI.confirmEmail(enrollmentToken, code);
      signIn(data);
      navigate('/', { replace: true });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Could not confirm your recovery email.');
    } finally { setBusy(false); }
  }

  return <section className="onboarding-step">
    <h2>{sent ? 'Verify your recovery email' : 'Add your recovery email'}</h2>
    <p className="phone-intro">{sent ? 'Confirming the code permanently sets this address for your account.'
      : 'Enter an external inbox you control. This address is required and can only be set once.'}</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error-message">{error}</p>}
    <form className="auth-form" onSubmit={submit}>
      <div className="input-group">{sent ? <>
        <label htmlFor="email-code">Eight-digit email code</label>
        <input id="email-code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{8}" maxLength={8}
          value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} required />
      </> : <>
        <label htmlFor="recovery-email">Recovery email</label>
        <input id="recovery-email" type="email" autoComplete="email" maxLength={254} value={email}
          onChange={e => setEmail(e.target.value)} required />
      </>}</div>
      <button className="btn-primary" disabled={busy}>{sent ? 'Confirm email and sign in' : 'Send verification code'}</button>
      {sent && <>
        <button type="button" className="btn-secondary" disabled={busy} onClick={sendCode}>Resend email code</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => {
          setSent(false); setCode(''); setError(''); setNotice('');
        }}>Correct email before confirming</button>
      </>}
      <button type="button" className="btn-secondary" disabled={busy} onClick={restart}>Back to phone sign-in</button>
    </form>
  </section>;
}

export function RecoveryLink() {
  const [token] = useState(() => window.location.hash.slice(1));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();

  useEffect(() => { window.history.replaceState(null, '', window.location.pathname); }, []);

  async function confirm() {
    setBusy(true); setError('');
    try {
      const { data } = await authAPI.confirmRecovery(token);
      signIn(data);
      navigate('/', { replace: true });
    } catch (err: any) {
      setError(err.response?.data?.error || 'Could not sign in. Reopen the link or request a new one.');
    } finally { setBusy(false); }
  }

  return <main className="auth-container"><section className="recovery-panel">
    <h1>Email sign-in</h1>
    {token ? <>
      <p>Use this one-time link to sign in to the mailbox that requested it.</p>
      <button className="btn-primary" disabled={busy} onClick={confirm}>Sign in to Numo</button>
    </> : <p>Open the full link from your recovery email or request a new one.</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    <Link to="/login">Back to phone sign-in</Link>
  </section></main>;
}
