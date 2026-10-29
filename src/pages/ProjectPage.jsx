import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { ago, currencySymbol, date, fileSize, money, moneyPrecise } from '../lib/format';
import { ErrorState, Field, Loading, Modal, Notice, StatusPill, Submit, Tally, useToast } from '../components/ui';

export default function ProjectPage({ id, presetAmount }) {
  const { user } = useAuth();
  const { data: p, error, loading, reload } = useApi(id ? `/api/projects/${id}` : null);

  if (loading && !p) return <Loading />;
  if (error) return <div className="page"><a className="back" href="#/explore">← All projects</a><ErrorState error={error} onRetry={reload} /></div>;

  const isOwner = p.managerId === user.id;
  const backHref = isOwner ? '#/mine' : user.role === 'ADMIN' && p.status === 'PENDING' ? '#/review' : '#/explore';
  const itemsTotal = p.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);

  return (
    <div className="page">
      <a className="back" href={backHref}>← {isOwner ? 'My projects' : backHref === '#/review' ? 'Review queue' : 'All projects'}</a>
      <div style={{ marginBottom: 28 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="tag">{p.category}</span>
          <StatusPill status={p.status} />
        </div>
        <h1 style={{ maxWidth: '22ch' }}>{p.title}</h1>
        <p className="muted" style={{ marginTop: 8, fontSize: '1.08rem', maxWidth: '60ch' }}>{p.summary}</p>
        <p className="faint" style={{ marginTop: 10 }}>
          Led by {p.managerName}{p.location ? ` in ${p.location}` : ''}. Submitted {date(p.createdAt)}.
        </p>
      </div>

      <div className="split">
        <div className="stack">
          {p.reviewNote && (isOwner || user.role === 'ADMIN' || user.role === 'SUPPORT') && (
            <Notice kind={p.status === 'REJECTED' ? 'warn' : 'ok'} title={p.status === 'REJECTED' ? 'The reviewer asked for changes' : 'Reviewer’s note'}>
              {p.reviewNote}{p.reviewedBy ? ` — ${p.reviewedBy}, ${date(p.reviewedAt)}` : ''}
            </Notice>
          )}
          {isOwner && p.status === 'PENDING' && (
            <Notice kind="info" title="Waiting for review">Only you and the review team can see this page. It becomes public once it’s approved.</Notice>
          )}

          <section className="panel panel-pad">
            <h2 style={{ marginBottom: 12 }}>About this project</h2>
            <div className="prose">{p.description}</div>
          </section>

          <section className="panel">
            <div className="panel-pad" style={{ paddingBottom: 8 }}>
              <div className="section-title">
                <h2>Budget</h2>
                <p>{p.items.length ? `${money(itemsTotal)} itemised of ${money(p.targetFunding)}` : 'No itemised budget'}</p>
              </div>
            </div>
            {p.items.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Item</th><th>Supplier</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Total</th></tr></thead>
                  <tbody>
                    {p.items.map((i) => (
                      <tr key={i.id}>
                        <td>{i.itemName}</td>
                        <td className="muted">{i.supplier || '—'}</td>
                        <td className="num">{i.quantity}</td>
                        <td className="num">{moneyPrecise(i.unitPrice)}</td>
                        <td className="num">{moneyPrecise(i.quantity * i.unitPrice)}</td>
                      </tr>
                    ))}
                    {itemsTotal < p.targetFunding && (
                      <tr><td colSpan={4} className="muted">Unallocated (contingency, labour, transport)</td><td className="num">{moneyPrecise(p.targetFunding - itemsTotal)}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : <p className="panel-pad muted" style={{ paddingTop: 0 }}>The project lead didn’t list individual items.</p>}
          </section>

          <Documents project={p} canUpload={(isOwner && p.status !== 'CLOSED') || user.role === 'ADMIN'} canDelete={isOwner && ['PENDING', 'REJECTED'].includes(p.status)} onChange={reload} />

          <section className="panel panel-pad">
            <div className="section-title"><h2>Recent contributions</h2></div>
            {p.activity.length === 0 ? <p className="muted">No one has contributed yet.</p> : (
              <ul className="list">
                {p.activity.map((a, i) => (
                  <li key={i} className="row-between">
                    <span>{a.who} {a.type === 'REFUND' ? 'withdrew' : 'contributed'} <b className={a.type === 'REFUND' ? '' : 'amount-in'}>{money(a.amount)}</b></span>
                    <span className="faint">{ago(a.createdAt)}, block #{a.blockIndex}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside style={{ position: 'sticky', top: 84 }} className="stack">
          <div className="panel panel-pad"><Tally project={p} /></div>
          <Actions project={p} isOwner={isOwner} onChange={reload} presetAmount={presetAmount} />
        </aside>
      </div>
    </div>
  );
}

function Actions({ project: p, isOwner, onChange, presetAmount }) {
  const { user } = useAuth();
  if (user.role === 'INVESTOR') return <BackerActions project={p} onChange={onChange} presetAmount={presetAmount} />;
  if (isOwner) return <OwnerActions project={p} onChange={onChange} />;
  if (user.role === 'ADMIN' && p.status === 'PENDING') return <ReviewBox project={p} onDone={onChange} />;
  return null;
}

function BackerActions({ project: p, onChange, presetAmount }) {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [amount, setAmount] = useState(presetAmount && /^\d+$/.test(presetAmount) ? presetAmount : '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const remaining = p.targetFunding - p.currentFunding;

  if (p.status !== 'VERIFIED') {
    return (
      <div className="panel panel-pad">
        <p className="muted">{p.status === 'FUNDED' || p.status === 'CLOSED' ? 'This project has reached its goal and isn’t taking more contributions.' : 'This project isn’t taking contributions.'}</p>
        {p.myContribution > 0 && <p style={{ marginTop: 10 }}>You contributed <b>{money(p.myContribution)}</b>.</p>}
      </div>
    );
  }

  async function contribute(e) {
    e.preventDefault();
    setError(null);
    const n = Number(amount);
    if (!n || n < 100) return setError(`Contributions start at ${money(100)}.`);
    if (n > remaining) return setError(`Only ${money(remaining)} is left to reach the goal.`);
    if (n > user.balance) return setError('Your wallet doesn’t have enough money for that.');
    setBusy(true);
    try {
      const r = await api.post(`/api/projects/${p.id}/invest`, { amount: n });
      toast(r.goalReached ? `You contributed ${money(n)} and the project reached its goal.` : `You contributed ${money(n)}. Recorded in block #${r.blockIndex}.`);
      setAmount('');
      await Promise.all([refresh(), onChange()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const quick = [500, 1000, 5000].filter((q) => q <= remaining);

  return (
    <div className="panel panel-pad">
      <h3 style={{ marginBottom: 4 }}>Back this project</h3>
      <p className="faint" style={{ marginBottom: 14 }}>Wallet balance: {money(user.balance)}</p>
      {user.balance < 100 ? (
        <>
          <p className="muted" style={{ marginBottom: 12 }}>Add money to your wallet to contribute.</p>
          <a className="btn btn-primary btn-block" href="#/wallet">Add funds</a>
        </>
      ) : (
        <form onSubmit={contribute} noValidate>
          <Field label="Amount" error={error}>
            <div className="input-prefix">
              <b>{currencySymbol}</b>
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} aria-invalid={!!error || undefined} />
            </div>
          </Field>
          {quick.length > 0 && (
            <div className="row" style={{ marginTop: -6, marginBottom: 14 }}>
              {quick.map((q) => <button type="button" key={q} className="btn btn-sm" onClick={() => setAmount(String(Math.min(q, user.balance)))}>{money(q)}</button>)}
              <button type="button" className="btn btn-sm" onClick={() => setAmount(String(Math.min(remaining, user.balance)))}>Max</button>
            </div>
          )}
          <Submit busy={busy} className="btn btn-primary btn-block">Contribute</Submit>
        </form>
      )}
      {p.myContribution > 0 && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line)' }} className="row-between">
          <span className="small">You’ve put in <b>{money(p.myContribution)}</b></span>
          <button className="btn btn-sm btn-ghost" onClick={() => setWithdrawing(true)}>Withdraw</button>
        </div>
      )}
      {withdrawing && <WithdrawModal project={p} onClose={() => setWithdrawing(false)} onDone={async () => { setWithdrawing(false); await Promise.all([refresh(), onChange()]); }} />}
    </div>
  );
}

function WithdrawModal({ project: p, onClose, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState(String(p.myContribution));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const n = Number(amount);
    if (!n || n <= 0) return setError('Enter an amount to withdraw.');
    if (n > p.myContribution) return setError(`You can withdraw up to ${money(p.myContribution)}.`);
    setBusy(true);
    try {
      await api.post(`/api/projects/${p.id}/refund`, { amount: n });
      toast(`${money(n)} returned to your wallet.`);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Withdraw your contribution" description="While a project is still raising, you can take back some or all of what you put in. It goes straight back to your wallet." onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Amount" error={error} hint={`You’ve contributed ${money(p.myContribution)}.`}>
          <div className="input-prefix"><b>{currencySymbol}</b><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></div>
        </Field>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <Submit busy={busy}>Withdraw</Submit>
        </div>
      </form>
    </Modal>
  );
}

function OwnerActions({ project: p, onChange }) {
  const { refresh } = useAuth();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function release() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/api/projects/${p.id}/payout`);
      toast(`${money(r.amount)} released to your wallet.`);
      setConfirming(false);
      await Promise.all([refresh(), onChange()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel panel-pad">
      {(p.status === 'PENDING' || p.status === 'REJECTED') && (
        <>
          <p className="muted" style={{ marginBottom: 12 }}>
            {p.status === 'REJECTED' ? 'Update the plan to address the reviewer’s note, then resubmit.' : 'You can still edit this project while it waits for review.'}
          </p>
          <a className="btn btn-block" href={`#/edit/${p.id}`}>{p.status === 'REJECTED' ? 'Edit and resubmit' : 'Edit project'}</a>
        </>
      )}
      {p.status === 'VERIFIED' && <p className="muted">Your project is live. Share the page with people who might back it.</p>}
      {p.status === 'FUNDED' && (
        <>
          <p style={{ marginBottom: 12 }}>You reached your goal. Release the {money(p.currentFunding)} to your wallet to start work.</p>
          <button className="btn btn-primary btn-block" onClick={() => setConfirming(true)}>Release funds</button>
        </>
      )}
      {p.status === 'CLOSED' && <p className="muted">Funds were released to your wallet. This project is closed.</p>}
      {confirming && (
        <Modal
          title="Release funds?"
          description={`${money(p.currentFunding)} moves to your wallet and the project closes. Backers can no longer withdraw. This can’t be undone.`}
          onClose={() => setConfirming(false)}
          footer={<><button className="btn btn-ghost" onClick={() => setConfirming(false)}>Cancel</button><button className="btn btn-primary" onClick={release} disabled={busy}>{busy && <span className="spinner" />}Release funds</button></>}
        >
          {error ? <Notice kind="error">{error}</Notice> : <p className="muted small">The release is written to the ledger like every other transaction.</p>}
        </Modal>
      )}
    </div>
  );
}

export function ReviewBox({ project: p, onDone }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function decide(decision) {
    setError(null);
    if (decision === 'reject' && note.trim().length < 10) return setError('Tell the project lead what to change (at least 10 characters).');
    setBusy(decision);
    try {
      await api.post(`/api/projects/${p.id}/review`, { decision, note: note.trim() || undefined });
      toast(decision === 'approve' ? `Approved “${p.title}”. It’s now raising funds.` : `Sent “${p.title}” back with your note.`);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  return (
    <div className="panel panel-pad">
      <h3 style={{ marginBottom: 4 }}>Your decision</h3>
      <p className="faint" style={{ marginBottom: 14 }}>Check the budget and documents before approving. {p.documentCount === 0 && 'No documents were uploaded.'}</p>
      <Field label="Note to the project lead" error={error} hint="Required when asking for changes.">
        <textarea className="textarea" style={{ minHeight: 90 }} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      </Field>
      <div className="row">
        <button className="btn btn-primary" onClick={() => decide('approve')} disabled={!!busy}>{busy === 'approve' && <span className="spinner" />}Approve</button>
        <button className="btn btn-danger" onClick={() => decide('reject')} disabled={!!busy}>{busy === 'reject' && <span className="spinner" />}Ask for changes</button>
      </div>
    </div>
  );
}

function Documents({ project: p, canUpload, canDelete, onChange }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function upload(file) {
    if (!file) return;
    setError(null);
    if (file.size > 10 * 1024 * 1024) return setError('Files must be 10 MB or smaller.');
    const form = new FormData();
    form.append('file', file);
    setBusy(true);
    try {
      await api.post(`/api/projects/${p.id}/documents`, form);
      toast(`Uploaded ${file.name}.`);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(d) {
    if (!window.confirm(`Remove ${d.name}?`)) return;
    try {
      await api.del(`/api/projects/${p.id}/documents/${d.id}`);
      onChange();
    } catch (err) {
      setError(err.message);
    }
  }

  async function download(d) {
    try { await api.download(`/api/projects/${p.id}/documents/${d.id}`, d.name); } catch (err) { setError(err.message); }
  }

  return (
    <section className="panel panel-pad">
      <div className="section-title">
        <h2>Documents</h2>
        <p>Fingerprints are recorded on the ledger when uploaded</p>
      </div>
      {error && <div style={{ marginBottom: 12 }}><Notice kind="error">{error}</Notice></div>}
      {p.documents.length === 0 && <p className="muted">No documents yet.</p>}
      {p.documents.map((d) => (
        <div className="doc" key={d.id}>
          <div style={{ minWidth: 0 }}>
            <button className="linkish" onClick={() => download(d)}>{d.name}</button>
            <div className="faint">{fileSize(d.size)}, uploaded by {d.uploadedBy} on {date(d.uploadedAt)}</div>
            <div className="hash" title="SHA-256 of the file">{d.sha256}</div>
          </div>
          {canDelete && <button className="btn btn-sm btn-ghost" onClick={() => remove(d)}>Remove</button>}
        </div>
      ))}
      {canUpload && (
        <div className="dropzone" style={{ marginTop: 14 }}>
          <input ref={fileRef} type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.txt" onChange={(e) => upload(e.target.files[0])} />
          <button className="btn btn-sm" onClick={() => fileRef.current.click()} disabled={busy}>{busy && <span className="spinner" />}Upload a document</button>
          <div className="faint" style={{ marginTop: 6 }}>Quotes, permits, registrations. PDF, image, Word, Excel or text, up to 10 MB.</div>
        </div>
      )}
    </section>
  );
}
