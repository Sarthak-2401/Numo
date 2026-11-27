import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ArrowRight, Shield, Check } from 'lucide-react';
import { authAPI } from '../services/api';

import { EnrollRecoveryEmail } from './Recovery';

type AuthStep = 'language' | 'terms' | 'phone' | 'otp' | 'enroll' | 'recoverySent';

const Auth: React.FC = () => {
  const [step, setStep] = useState<AuthStep>('language');
  const [countryCode, setCountryCode] = useState('+91');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [onboardLang, setOnboardLang] = useState('en');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isNewUser, setIsNewUser] = useState(false);
  const [devHint, setDevHint] = useState('');
  
  const [registrationId, setRegistrationId] = useState('');
  const [enrollmentToken, setEnrollmentToken] = useState('');
  const verifying = useRef(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const handleSendOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!phone.trim()) {
      setError('Phone number is required');
      return;
    }

    const fullPhone = `${countryCode}${phone.replace(/\s/g, '')}`;

    setIsLoading(true);
    try {
      const response = await authAPI.sendOTP(fullPhone);
      setIsNewUser(response.data.isNewUser);
      setRegistrationId(response.data.registrationId || '');
      setDevHint(response.data.devHint || '');
      setStep('otp');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to send OTP');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!otp || otp.length !== 6) {
      setError('Please enter the 6-digit OTP');
      return;
    }

    const fullPhone = `${countryCode}${phone.replace(/\s/g, '')}`;

    if (verifying.current) return;
    verifying.current = true;
    setIsLoading(true);
    try {
      const { data } = await authAPI.verifyOTP(fullPhone, otp, registrationId);
      if (data.requiresRecoveryEmail) {
        setEnrollmentToken(data.enrollmentToken);
        setStep('enroll');
      } else {
        signIn(data);
        navigate('/', { replace: true });
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Invalid OTP. Try again.');
    } finally {
      verifying.current = false;
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (otp.length === 6) {
      handleVerifyOTP({ preventDefault: () => {} } as React.FormEvent);
    }
  }, [otp]);

  useEffect(() => {
    let abortController: AbortController;
    let isSubscribed = true;

    if (step === 'otp') {
      abortController = new AbortController();
      if ('OTPCredential' in window) {
        navigator.credentials.get({
          otp: { transport: ['sms'] },
          signal: abortController.signal
        } as any).then((otpObj: any) => {
          if (isSubscribed && otpObj && otpObj.code) {
             setOtp(otpObj.code);
          }
        }).catch(err => console.log('WebOTP error:', err));
      }
    }

    return () => {
      isSubscribed = false;
      if (abortController) abortController.abort();
    };
  }, [step]);

  const requestRecovery = async () => {
    setError('');
    if (!phone.trim()) { setError('Enter your phone number first.'); return; }
    setIsLoading(true);
    try {
      await authAPI.requestRecovery(countryCode + phone.replace(/\s/g, ''));
      setStep('recoverySent');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Could not request a link. Please try again.');
    } finally { setIsLoading(false); }
  };

  const handleBack = () => {
    setStep('phone');
    setOtp('');
    setError('');
    setDevHint('');
  };

  return (
    <div className="auth-container">
      <div className="auth-card fade-in" style={{ position: 'relative' }}>

        <aside className="numo-cover">
          <div className="wordmark"><img src="/favicon.svg" alt="" width="40" height="40" />Numo</div>
          <h1>Email by<br />phone number<span>.</span></h1>
          <div className="mail-art" aria-hidden="true">
            <div className="envelope"><div className="envelope-flap" /><span className="postage">N</span><i /><i /></div>
          </div>
        </aside>

        {step === 'language' ? (
          <div className="onboarding-step fade-in" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <header className="step-heading"><h2>Choose your language</h2></header>
            <div className="language-grid" role="group" aria-label="Language">
              {[
                { id: 'en', label: 'English', sub: 'English' },
                { id: 'hi', label: 'हिन्दी', sub: 'Hindi' },
                { id: 'es', label: 'Español', sub: 'Spanish' },
                { id: 'fr', label: 'Français', sub: 'French' },
                { id: 'de', label: 'Deutsch', sub: 'German' },
                { id: 'ja', label: '日本語', sub: 'Japanese' }
              ].map(l => (
                <button type="button" key={l.id} className="language-option"
                  aria-pressed={onboardLang === l.id} onClick={() => setOnboardLang(l.id)}>
                  <span lang={l.id}>{l.label}</span>
                  {l.sub !== l.label && <small>{l.sub}</small>}
                  {onboardLang === l.id && <Check size={16} aria-hidden="true" />}
                </button>
              ))}
            </div>
            <button className="btn-primary step-next" onClick={() => setStep('terms')}>
              Continue <ArrowRight size={17} />
            </button>
          </div>
        ) : step === 'terms' ? (
          <div className="onboarding-step fade-in" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <h2 style={{ fontSize: '24px', color: 'var(--text-primary)' }}>Terms & Conditions</h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.5', marginTop: '16px' }}>
                Please read our Terms of Service and Privacy Policy before using Numo. By tapping "Agree & Continue", you accept our terms.
              </p>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '24px', textAlign: 'left', marginBottom: '24px', paddingRight: '8px', minHeight: 0 }}>
              <div>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)', fontSize: '16px' }}>Your mailbox</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.5', marginTop: '8px' }}>Your mailbox uses your phone number. Incoming and outgoing emails appear together in each conversation.</p>
              </div>
              <div>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)', fontSize: '16px' }}>Device permissions</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '8px' }}>On supported browsers, you can choose a contact or allow the browser to fill in an SMS sign-in code.</p>
              </div>
              <div>
                <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)', fontSize: '16px' }}>Account access</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.5', marginTop: '8px' }}>At signup, verify your phone and choose a permanent recovery email. You can use that inbox to sign in when SMS is unavailable.</p>
              </div>
            </div>

            <div style={{ marginTop: 'auto', paddingTop: '16px' }}>
              <button 
                className="btn-primary" 
                onClick={() => { setAcceptedTerms(true); setStep('phone'); }}
                style={{ width: '100%', padding: '16px', borderRadius: '10px', fontWeight: 'bold', fontSize: '16px' }}
              >
                Agree & Continue
              </button>
            </div>
          </div>
        ) : step === 'enroll' ? (
          <EnrollRecoveryEmail enrollmentToken={enrollmentToken} restart={handleBack} />
        ) : step === 'recoverySent' ? (
          <section className="onboarding-step">
            <h2>Check your recovery inbox</h2>
            <p className="phone-intro" role="status">If this number has a verified recovery email, we’ve sent a link. Open it within 15 minutes to sign in.</p>
            <button type="button" className="btn-secondary" onClick={handleBack}>Back to sign-in</button>
          </section>
        ) : step === 'phone' ? (
          <div className="onboarding-step fade-in" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ textAlign: 'center', marginBottom: '32px' }}>
              <h2 style={{ fontSize: '24px', color: 'var(--text-primary)' }}>Enter your phone number</h2>
              <p className="phone-intro">We’ll text a sign-in code to this number.</p>
            </div>

            {error && <div className="error-message" role="alert">{error}</div>}

            <form className="auth-form" onSubmit={handleSendOTP} style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', gap: '12px', marginBottom: '16px' }}>
                <div style={{
                  display: 'flex', alignItems: 'center',
                  backgroundColor: 'var(--bg-tertiary)',
                  borderRadius: '12px', padding: '0 16px', width: '110px',
                  border: '1px solid var(--border)'
                }}>
                  <span style={{ fontSize: '18px', marginRight: '8px' }}>🇮🇳</span>
                  <select 
                    aria-label="Country calling code"
                    value={countryCode} 
                    onChange={(e) => setCountryCode(e.target.value)}
                    style={{ backgroundColor: 'transparent', color: 'var(--text-primary)', border: 'none', padding: '16px 0', outline: 'none', cursor: 'pointer', fontSize: '16px', flex: 1, appearance: 'none' }}
                  >
                    <option value="+91">+91</option>
                    <option value="+1">+1</option>
                    <option value="+44">+44</option>
                  </select>
                </div>
                
                <div style={{
                  display: 'flex', alignItems: 'center', flex: 1,
                  backgroundColor: 'var(--bg-tertiary)',
                  borderRadius: '12px',
                  border: '1px solid var(--border)'
                }}>
                  <input
                    type="tel"
                    placeholder="Phone number"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                    style={{ width: '100%', padding: '16px', background: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '16px', outline: 'none' }}
                  />
                </div>
              </div>
              

              <div style={{ marginTop: 'auto', paddingTop: '24px' }}>
                <button 
                  type="submit" 
                  className="btn-primary" 
                  disabled={isLoading}
                  style={{ width: '100%', padding: '16px', borderRadius: '10px', fontWeight: 'bold', fontSize: '16px', opacity: isLoading ? 0.7 : 1 }}
                >
                  {isLoading ? 'Processing...' : 'Get OTP'}
                </button>
              </div>
              <button type="button" className="btn-secondary" disabled={isLoading} onClick={requestRecovery}>Sign in with recovery email</button>
            </form>
          </div>
        ) : (
          <div className="onboarding-step fade-in" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <p className="auth-subtitle" style={{ marginBottom: '4px' }}>
              <Shield size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
              Enter the 6-digit code sent to
            </p>
            <p style={{ color: 'var(--accent)', fontWeight: '600', fontSize: '15px', textAlign: 'center', marginBottom: '16px' }}>
              {countryCode} {phone}
            </p>

            {isNewUser && (
              <div style={{ 
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border)',
                borderRadius: '8px', 
                padding: '10px 14px', 
                marginBottom: '16px', 
                textAlign: 'center',
                fontSize: '13px',
                color: 'var(--accent)' 
              }}>
                After you confirm your number, you’ll verify a permanent recovery email.
              </div>
            )}

            {error && <div className="error-message">{error}</div>}

            <form className="auth-form" onSubmit={handleVerifyOTP}>
              <div className="input-group">
                <label htmlFor="auth-otp">Sign-in code</label>
                <input
                  type="text" inputMode="numeric" autoComplete="one-time-code"
                  placeholder="Enter 6-digit OTP"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                  autoFocus
                  maxLength={6}
                  id="auth-otp"
                  style={{ textAlign: 'center', fontSize: '20px', letterSpacing: '8px', fontWeight: '700' }}
                />
              </div>



              <button
                type="submit"
                className="btn-primary"
                disabled={isLoading}
                id="auth-verify"
              >
                {isLoading ? (
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    <span className="loading-spinner" style={{ width: '18px', height: '18px', borderWidth: '2px' }} />
                    Verifying...
                  </span>
                ) : (
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    Verify & Continue <ArrowRight size={18} />
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={handleBack}
                style={{ 
                  marginTop: '12px', width: '100%', padding: '10px', 
                  background: 'transparent', border: '1px solid var(--border)', 
                  borderRadius: '8px', color: 'var(--text-secondary)', 
                  cursor: 'pointer', fontSize: '14px' 
                }}
              >
                ← Change number
              </button>

              <button
                type="button"
                onClick={() => alert(devHint || 'Check your text messages or choose Change number to request a new code.')}
                style={{ 
                  marginTop: '16px', width: '100%', padding: '4px', 
                  background: 'transparent', border: 'none', 
                  color: 'var(--text-tertiary)', 
                  cursor: 'pointer', fontSize: '12px', textDecoration: 'underline'
                }}
              >
                Get sign-in help
              </button>
              <button type="button" className="btn-secondary" disabled={isLoading} onClick={requestRecovery}>Can’t get a code? Use recovery email</button>
            </form>
          </div>
        )}
      </div>


    </div>
  );
};

export default Auth;
