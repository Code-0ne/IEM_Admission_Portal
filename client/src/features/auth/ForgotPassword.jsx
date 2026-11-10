import { useEffect, useState } from 'react';
import { ArrowLeft, Check, CheckCircle, EnvelopeSimple, LockKey, Warning } from '@phosphor-icons/react';
import { useAuth } from './AuthContext.jsx';

function PasswordRules({ password }) {
  const rules = [
    { key: 'length', label: 'At least 8 characters', ok: password.length >= 8 },
    { key: 'upper', label: 'One uppercase letter', ok: /[A-Z]/.test(password) },
    { key: 'number', label: 'One number', ok: /[0-9]/.test(password) },
    { key: 'special', label: 'One special character', ok: /[^A-Za-z0-9]/.test(password) },
  ];

  return (
    <ul className="pw-rules">
      {rules.map((rule) => (
        <li className={rule.ok ? 'is-ok' : ''} key={rule.key}>
          <Check size={13} weight="bold" /> {rule.label}
        </li>
      ))}
    </ul>
  );
}

export function ForgotPassword({ onNavigate }) {
  const { forgotPassword, resetPassword } = useAuth();
  const [stage, setStage] = useState('request');
  const [email, setEmail] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get('access_token');

    if (token && fragment.get('type') === 'recovery') {
      setAccessToken(token);
      setStage('reset');
      window.history.replaceState(null, '', '/');
      return;
    }

    const query = new URLSearchParams(window.location.search);
    const linkError = fragment.get('error_description') || query.get('error_description') || query.get('error');
    if (linkError) {
      setError('This password reset link is invalid or has expired. Request a new link.');
      window.history.replaceState(null, '', '/');
    } else if (window.location.pathname.replace(/\/+$/, '') === '/reset-password') {
      setError('Open the reset link from your email, or request a new one below.');
    }
  }, []);

  const passwordReady =
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password);

  const handleRequest = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      await forgotPassword({ email: email.trim().toLowerCase() });
      setStage('sent');
    } catch (requestError) {
      setError(requestError.message || 'Could not request a password reset. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (event) => {
    event.preventDefault();
    setError('');

    if (!passwordReady) {
      setError('New password does not satisfy all complexity requirements.');
      return;
    }

    setLoading(true);
    try {
      await resetPassword({ accessToken, newPassword: password });
      setStage('done');
    } catch (resetError) {
      setError(resetError.message || 'Could not reset your password. Request a new link and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="otp-stage">
      <section className="otp-card">
        <button className="back-link" onClick={() => onNavigate('login')} type="button">
          <ArrowLeft size={16} /> Back to sign in
        </button>
        <span className="otp-icon"><LockKey size={22} /></span>

        {stage === 'request' && (
          <>
            <h1>Forgot your password?</h1>
            <p className="otp-copy">Enter your registered email and Supabase will send a secure password reset link.</p>
            <form onSubmit={handleRequest}>
              <label className="field">
                <span className="field__label">Email Address *</span>
                <span className="field__control">
                  <EnvelopeSimple size={17} weight="regular" />
                  <input
                    type="email"
                    placeholder="you@example.com"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </span>
              </label>
              {error && <p className="form-error" role="alert"><Warning size={14} /> {error}</p>}
              <button className="button button--charcoal button--full" style={{ marginTop: '18px' }} disabled={loading} type="submit">
                {loading ? 'Sending link...' : 'Send reset link'}
              </button>
            </form>
          </>
        )}

        {stage === 'sent' && (
          <div className="otp-success">
            <EnvelopeSimple size={42} weight="duotone" style={{ color: 'var(--brand-gold, #c89d53)' }} />
            <h1>Check your email</h1>
            <p className="otp-copy">
              If an account exists for <strong>{email}</strong>, Supabase has sent a password reset link.
              The link may take a few minutes to arrive.
            </p>
            <button className="button button--charcoal button--full" style={{ marginTop: '14px' }} onClick={() => onNavigate('login')} type="button">
              Back to sign in
            </button>
          </div>
        )}

        {stage === 'reset' && (
          <>
            <h1>Choose a new password</h1>
            <p className="otp-copy">Set a new password for your account.</p>
            <form onSubmit={handleReset}>
              <label className="field">
                <span className="field__label">New Password *</span>
                <span className="field__control">
                  <LockKey size={17} weight="regular" />
                  <input
                    type="password"
                    placeholder="Create a new password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </span>
              </label>
              <PasswordRules password={password} />
              {error && <p className="form-error" role="alert"><Warning size={14} /> {error}</p>}
              <button className="button button--charcoal button--full" style={{ marginTop: '14px' }} disabled={!passwordReady || loading} type="submit">
                {loading ? 'Updating password...' : 'Reset password'}
              </button>
            </form>
          </>
        )}

        {stage === 'done' && (
          <div className="otp-success">
            <CheckCircle size={44} weight="duotone" style={{ color: 'var(--brand-gold, #c89d53)' }} />
            <h1>Password updated</h1>
            <p className="otp-copy">Your password has been changed and previous sessions have been revoked.</p>
            <button
              className="button button--charcoal button--full"
              style={{ marginTop: '14px' }}
              onClick={() => {
                window.history.replaceState(null, '', '/');
                onNavigate('login');
              }}
              type="button"
            >
              Back to sign in
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

export default ForgotPassword;
