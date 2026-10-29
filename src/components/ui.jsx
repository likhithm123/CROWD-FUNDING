import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { STATUS, percent, money } from '../lib/format';

export function Field({ label, hint, error, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <span className="error" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

export function PasswordInput({ value, onChange, invalid, autoComplete = 'current-password', ...rest }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="input-wrap">
      <input
        className="input" type={shown ? 'text' : 'password'} value={value} onChange={onChange}
        autoComplete={autoComplete} aria-invalid={invalid || undefined} {...rest}
      />
      <button type="button" className="reveal" onClick={() => setShown((s) => !s)} aria-label={shown ? 'Hide password' : 'Show password'}>
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

export function Notice({ kind = 'info', title, children }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : undefined}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

export function StatusPill({ status, map = STATUS }) {
  const s = map[status] || { label: status, cls: 'status-closed' };
  return <span className={`status ${s.cls}`}>{s.label}</span>;
}

export function Bar({ value, total, thin, done }) {
  const pct = percent(value, total);
  return (
    <div className={`bar${thin ? ' thin' : ''}${done ? ' done' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% funded`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Tally({ project }) {
  const { currentFunding, targetFunding, backers, status } = project;
  const done = status === 'FUNDED' || status === 'CLOSED';
  return (
    <div>
      <div className="tally-number">{money(currentFunding)}</div>
      <div className="tally-sub">raised of {money(targetFunding)} goal</div>
      <Bar value={currentFunding} total={targetFunding} done={done} />
      <div className="tally-facts">
        <div><b>{percent(currentFunding, targetFunding)}%</b><span>funded</span></div>
        <div><b>{backers}</b><span>{backers === 1 ? 'backer' : 'backers'}</span></div>
        <div><b>{project.tenureMonths} mo</b><span>to deliver</span></div>
      </div>
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div className="loading"><span className="spinner" /> &nbsp;{label}</div>;
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="panel empty">
      <h3>This page didn’t load</h3>
      <p>{error?.message || 'Something went wrong.'}</p>
      {onRetry && <button className="btn" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="panel empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Modal({ title, description, onClose, children, footer }) {
  const titleId = useId();
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector('input, select, textarea, button:not(.close-x)');
    first?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="close-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Submit({ busy, children, className = 'btn btn-primary', ...rest }) {
  return (
    <button type="submit" className={className} disabled={busy || rest.disabled} {...rest}>
      {busy && <span className="spinner" />}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ toasts
const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, kind = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.message}</span>
            <button onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} aria-label="Dismiss">✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function Mark() {
  return (
    <svg className="wordmark-mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="13" width="5" height="9" rx="1.5" fill="#1f7a63" />
      <rect x="9.5" y="8" width="5" height="14" rx="1.5" fill="#1f7a63" opacity=".75" />
      <rect x="17" y="2" width="5" height="20" rx="1.5" fill="#e2a93b" />
    </svg>
  );
}
