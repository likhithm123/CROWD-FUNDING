import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL, date, money } from '../lib/format';
import { ALL_ROLES, passwordChecks, validateSignup } from '../../shared/validation.js';
import { ErrorState, Field, Loading, Modal, Notice, PasswordInput, Submit, useToast } from '../components/ui';

export default function People() {
  const { user: me } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi('/api/users');
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState(null);

  const shown = useMemo(() => (data || []).filter((u) =>
    (!role || u.role === role) && (!q || `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()))), [data, q, role]);

  if (loading && !data) return <Loading />;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;

  async function update(u, body, msg) {
    try {
      await api.patch(`/api/users/${u.id}`, body);
      toast(msg);
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>People</h1>
          <p>Everyone with an account. Backers and project leads sign themselves up; you create support and administrator accounts here.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>Add a person</button>
      </div>

      <div className="filters">
        <input className="input" type="search" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by role">
          <option value="">Every role</option>
          {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
      </div>

      <div className="panel table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Role</th><th className="num">Balance</th><th>Joined</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.id} style={u.isActive ? undefined : { opacity: 0.6 }}>
                <td><strong>{u.name}</strong>{u.id === me.id && <span className="faint"> (you)</span>}<div className="faint">{u.email}</div></td>
                <td>
                  {u.id === me.id ? ROLE_LABEL[u.role] : (
                    <select className="select" style={{ width: 'auto', padding: '4px 8px', fontSize: '0.88rem' }} value={u.role}
                      onChange={(e) => update(u, { role: e.target.value }, `${u.name} is now ${ROLE_LABEL[e.target.value].toLowerCase()}.`)} aria-label={`Role for ${u.name}`}>
                      {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  )}
                </td>
                <td className="num">{money(u.balance)}</td>
                <td className="muted">{date(u.createdAt)}</td>
                <td className="muted">{u.lastLoginAt ? date(u.lastLoginAt) : 'Never'}</td>
                <td className="num">
                  {u.id !== me.id && (
                    <span className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => update(u, { unlock: true }, `Cleared failed sign-ins for ${u.name}.`)}>Unlock</button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setResetting(u)}>Set password</button>
                      {u.isActive
                        ? <button className="btn btn-sm btn-danger" onClick={() => window.confirm(`Deactivate ${u.name}? They’ll be signed out and can’t sign back in.`) && update(u, { isActive: false }, `${u.name} deactivated.`)}>Deactivate</button>
                        : <button className="btn btn-sm" onClick={() => update(u, { isActive: true }, `${u.name} reactivated.`)}>Reactivate</button>}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={6} className="muted">No one matches.</td></tr>}
          </tbody>
        </table>
      </div>
      {adding && <AddPerson onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {resetting && <ResetPassword person={resetting} onClose={() => setResetting(null)} />}
    </div>
  );
}

function AddPerson({ onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'SUPPORT' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const checks = passwordChecks(form.password, form);

  async function submit(e) {
    e.preventDefault();
    const { errors: errs } = validateSignup(form, { allowedRoles: ALL_ROLES });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.post('/api/users', form);
      toast(`Account created for ${form.name}. Share the temporary password with them privately.`);
      onDone();
    } catch (err) {
      setErrors(err.fields || {});
      setFormError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Add a person" description="Give them a temporary password. They can change it from Account settings after signing in." onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {formError && <div style={{ marginBottom: 14 }}><Notice kind="error">{formError}</Notice></div>}
        <Field label="Role">
          <select className="select" value={form.role} onChange={set('role')}>
            {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </Field>
        <Field label="Full name" error={errors.name}><input className="input" value={form.name} onChange={set('name')} maxLength={60} /></Field>
        <Field label="Email" error={errors.email}><input className="input" type="email" value={form.email} onChange={set('email')} maxLength={120} /></Field>
        <Field label="Temporary password" error={errors.password ? 'Meet every requirement below.' : undefined}>
          <PasswordInput value={form.password} onChange={set('password')} autoComplete="new-password" />
          <ul className="rules">{checks.map((c) => <li key={c.id} className={c.ok ? 'ok' : ''}>{c.label}</li>)}</ul>
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <Submit busy={busy}>Create account</Submit>
        </div>
      </form>
    </Modal>
  );
}

function ResetPassword({ person, onClose }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const checks = passwordChecks(password, person);

  async function submit(e) {
    e.preventDefault();
    if (checks.some((c) => !c.ok)) return setError('Meet every requirement below.');
    setBusy(true);
    try {
      await api.patch(`/api/users/${person.id}`, { temporaryPassword: password });
      toast(`Temporary password set for ${person.name}. Their other sessions were signed out.`);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Set a password for ${person.name}`} description="Use this when someone is locked out or forgot their password. Share it with them privately and ask them to change it from Account settings." onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Temporary password" error={error}>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          <ul className="rules">{checks.map((c) => <li key={c.id} className={c.ok ? 'ok' : ''}>{c.label}</li>)}</ul>
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <Submit busy={busy}>Set password</Submit>
        </div>
      </form>
    </Modal>
  );
}
