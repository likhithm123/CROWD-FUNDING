import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL, date } from '../lib/format';
import { passwordChecks, validateName } from '../../shared/validation.js';
import { Field, Notice, PasswordInput, Submit, useToast } from '../components/ui';

export default function Account() {
  const { user, setUser } = useAuth();
  const toast = useToast();

  const [name, setName] = useState(user.name);
  const [nameError, setNameError] = useState(null);
  const [savingName, setSavingName] = useState(false);

  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [pwErrors, setPwErrors] = useState({});
  const [pwBusy, setPwBusy] = useState(false);
  const checks = passwordChecks(pw.newPassword, user);

  async function saveName(e) {
    e.preventDefault();
    const err = validateName(name);
    setNameError(err);
    if (err) return;
    setSavingName(true);
    try {
      const d = await api.patch('/api/auth/profile', { name });
      setUser(d.user);
      toast('Name updated.');
    } catch (ex) {
      setNameError(ex.message);
    } finally {
      setSavingName(false);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    const errs = {};
    if (!pw.currentPassword) errs.currentPassword = 'Enter your current password.';
    if (checks.some((c) => !c.ok)) errs.newPassword = 'Meet every requirement below.';
    if (pw.confirm !== pw.newPassword) errs.confirm = 'Passwords don’t match.';
    setPwErrors(errs);
    if (Object.keys(errs).length) return;
    setPwBusy(true);
    try {
      await api.post('/api/auth/password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
      setPw({ currentPassword: '', newPassword: '', confirm: '' });
      toast('Password changed. Other devices have been signed out.');
    } catch (ex) {
      setPwErrors({ ...(ex.fields?.currentPassword ? { currentPassword: ex.message } : { form: ex.message }) });
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <div>
          <h1>Account settings</h1>
          <p>{ROLE_LABEL[user.role]} account, created {date(user.createdAt)}.</p>
        </div>
      </div>

      {user.role === 'INVESTOR' && (
        <div className="panel panel-pad row-between" style={{ marginBottom: 16 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Project suggestions</h2>
            <p className="faint">Set a budget, approach and interests, and we’ll rank the projects raising funds for you.</p>
          </div>
          <a className="btn" href="#/suggestions">Open suggestions</a>
        </div>
      )}

      <form className="panel panel-pad" onSubmit={saveName} noValidate>
        <h2 style={{ marginBottom: 16 }}>Profile</h2>
        <Field label="Full name" error={nameError}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <Field label="Email" hint="Email can’t be changed. Ask the help desk if you need a different one.">
          <input className="input" value={user.email} disabled />
        </Field>
        <Submit busy={savingName} disabled={name.trim() === user.name}>Save name</Submit>
      </form>

      <form className="panel panel-pad" onSubmit={changePassword} noValidate>
        <h2 style={{ marginBottom: 6 }}>Password</h2>
        <p className="faint" style={{ marginBottom: 16 }}>Changing it signs you out everywhere except here.</p>
        {pwErrors.form && <div style={{ marginBottom: 14 }}><Notice kind="error">{pwErrors.form}</Notice></div>}
        <Field label="Current password" error={pwErrors.currentPassword}>
          <PasswordInput value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
        </Field>
        <Field label="New password" error={pwErrors.newPassword}>
          <PasswordInput value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} autoComplete="new-password" maxLength={64} />
          <ul className="rules">{checks.map((c) => <li key={c.id} className={c.ok ? 'ok' : ''}>{c.label}</li>)}</ul>
        </Field>
        <Field label="Confirm new password" error={pwErrors.confirm}>
          <PasswordInput value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} autoComplete="new-password" />
        </Field>
        <Submit busy={pwBusy}>Change password</Submit>
      </form>
    </div>
  );
}
