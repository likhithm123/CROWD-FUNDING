import { useMemo, useState } from 'react';
import { useAuth } from '../lib/auth';
import { Field, Mark, Notice, PasswordInput, Submit } from '../components/ui';
import { passwordChecks, validateEmail, validateName, validateSignup } from '../../shared/validation.js';

export default function AuthPage({ mode, onSwitch }) {
  return (
    <div className="auth">
      <aside className="auth-side">
        <div>
          <div className="wordmark"><Mark /> CrowdFund</div>
          <h1>Fund local projects you can follow line by line.</h1>
          <p>Every project is checked by a reviewer before it can raise money, and every rupee in or out is written to a tamper-evident ledger anyone signed in can verify.</p>
          <ol className="auth-steps">
            <li>A project lead submits a plan with a budget and supporting documents.</li>
            <li>An administrator reviews it and approves it or asks for changes.</li>
            <li>Backers contribute from their wallet. They can withdraw while it’s still raising.</li>
            <li>When the goal is met, the lead releases the funds and the project closes.</li>
          </ol>
        </div>
        <p className="auth-foot">Your password is stored as a salted scrypt hash. We never see it.</p>
      </aside>
      <main className="auth-main">
        <div className="auth-card">
          {mode === 'signup' ? <SignUp onSwitch={onSwitch} /> : <SignIn onSwitch={onSwitch} />}
        </div>
      </main>
    </div>
  );
}

const PORTALS = [
  ['customer', 'Customer', 'Welcome back. Use the email you registered with.'],
  ['support', 'Support team', 'For support staff answering customer conversations.'],
  ['admin', 'Administrator', 'For administrators reviewing projects and managing people.'],
];

function SignIn({ onSwitch }) {
  const { signIn } = useAuth();
  const [portal, setPortal] = useState('customer');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (validateEmail(email)) return setError(validateEmail(email));
    if (!password) return setError('Enter your password.');
    setBusy(true);
    try {
      await signIn(email, password, portal);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <h2>Sign in</h2>
      <div className="segmented" role="tablist" aria-label="Sign in as">
        {PORTALS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={portal === key} onClick={() => { setPortal(key); setError(null); }}>{label}</button>
        ))}
      </div>
      <p className="lead">{PORTALS.find((x) => x[0] === portal)[2]}</p>
      {error && <div style={{ marginBottom: 16 }}><Notice kind="error">{error}</Notice></div>}
      <Field label="Email">
        <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field label="Password">
        <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Submit busy={busy} className="btn btn-primary btn-block">Sign in</Submit>
      {portal === 'customer' ? (
        <p className="auth-switch">
          New here? <button type="button" className="linkish" onClick={() => onSwitch('signup')}>Create an account</button>
        </p>
      ) : (
        <p className="auth-switch">{portal === 'support' ? 'Support' : 'Administrator'} accounts are created by an administrator.</p>
      )}
      <p className="faint" style={{ textAlign: 'center', marginTop: 10 }}>
        After 5 wrong passwords an account is locked for 15 minutes.
      </p>
    </form>
  );
}

function strengthLevel(checks) {
  const passed = checks.filter((c) => c.ok).length;
  if (passed === checks.length) return 4;
  if (passed >= 6) return 3;
  if (passed >= 4) return 2;
  return passed > 0 ? 1 : 0;
}

function SignUp({ onSwitch }) {
  const { signUp } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '', role: '', acceptTerms: false });
  const [touched, setTouched] = useState({});
  const [serverErrors, setServerErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
    setServerErrors((s) => ({ ...s, [k]: undefined }));
  };
  const touch = (k) => () => setTouched((t) => ({ ...t, [k]: true }));

  const checks = useMemo(() => passwordChecks(form.password, form), [form]);
  const level = strengthLevel(checks);
  const { errors } = validateSignup(form);
  const show = (k) => serverErrors[k] || (touched[k] ? errors[k] : undefined);
  const confirmReady = form.confirmPassword.length > 0 && form.confirmPassword.length >= form.password.length;
  const confirmError = serverErrors.confirmPassword || (touched.confirmPassword || confirmReady ? errors.confirmPassword : undefined);

  async function submit(e) {
    e.preventDefault();
    setTouched({ name: true, email: true, password: true, confirmPassword: true, role: true, acceptTerms: true });
    setFormError(null);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      await signUp(form);
    } catch (err) {
      setServerErrors(err.fields || {});
      setFormError(err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <h2>Create your account</h2>
      <p className="lead">It takes a minute. You can add money to your wallet afterwards.</p>
      {formError && <div style={{ marginBottom: 16 }}><Notice kind="error">{formError}</Notice></div>}

      <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px' }}>
        <legend className="field" style={{ fontWeight: 600, fontSize: '0.92rem', marginBottom: 6, padding: 0 }}>I want to</legend>
        <div className="choice-group">
          <label className="choice">
            <input type="radio" name="role" value="INVESTOR" checked={form.role === 'INVESTOR'} onChange={set('role')} onBlur={touch('role')} />
            <strong>Back projects</strong>
            <small>Add funds and contribute to approved projects.</small>
          </label>
          <label className="choice">
            <input type="radio" name="role" value="MANAGER" checked={form.role === 'MANAGER'} onChange={set('role')} onBlur={touch('role')} />
            <strong>Run a project</strong>
            <small>Submit a plan for review and raise money for it.</small>
          </label>
        </div>
        {show('role') && <span className="field"><span className="error">{show('role')}</span></span>}
      </fieldset>

      <Field label="Full name" error={show('name')} hint="As you’d like backers or reviewers to see it.">
        <input className="input" autoComplete="name" value={form.name} onChange={set('name')} onBlur={touch('name')} aria-invalid={!!show('name') || undefined} maxLength={60} />
      </Field>
      <Field label="Email" error={show('email')}>
        <input className="input" type="email" autoComplete="email" value={form.email} onChange={set('email')} onBlur={touch('email')} aria-invalid={!!show('email') || undefined} maxLength={120} />
      </Field>
      <Field label="Password" error={touched.password && level < 4 ? 'Meet every requirement below.' : serverErrors.password}>
        <PasswordInput value={form.password} onChange={set('password')} onBlur={touch('password')} autoComplete="new-password" invalid={touched.password && level < 4} maxLength={64} />
        <div className={`strength s${level}`} aria-hidden="true"><i /><i /><i /><i /></div>
        <ul className="rules" aria-label="Password requirements">
          {checks.map((c) => <li key={c.id} className={c.ok ? 'ok' : ''}>{c.label}</li>)}
        </ul>
      </Field>
      {/* Checked while typing (once it's as long as the password) rather than on blur:
          a message appearing on blur pushed the terms checkbox down mid-click (TC-SU-12). */}
      <Field label="Confirm password" error={confirmError}>
        <PasswordInput value={form.confirmPassword} onChange={set('confirmPassword')} autoComplete="new-password" invalid={!!confirmError} />
      </Field>
      <label className="check" style={{ marginBottom: 6 }}>
        <input type="checkbox" checked={form.acceptTerms} onChange={set('acceptTerms')} />
        <span>I agree to the terms of use and understand contributions are only refundable while a project is still raising.</span>
      </label>
      {show('acceptTerms') && <span className="field"><span className="error">{show('acceptTerms')}</span></span>}

      <div style={{ marginTop: 18 }}>
        <Submit busy={busy} className="btn btn-primary btn-block">Create account</Submit>
      </div>
      <p className="auth-switch">
        Already have an account? <button type="button" className="linkish" onClick={() => onSwitch('signin')}>Sign in</button>
      </p>
      <p className="faint" style={{ textAlign: 'center', marginTop: 10 }}>
        Support team and administrators: sign in and choose your role at the top.
      </p>
    </form>
  );
}

// Re-exported for the account page, which uses the same name rule.
export { validateName };
