import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { currencySymbol, dateTime, money, moneyPrecise, percent } from '../lib/format';
import { Bar, ErrorState, Field, Loading, Modal, StatusPill, Submit, useToast } from '../components/ui';

const TYPE_LABEL = { DEPOSIT: 'Added to wallet', INVESTMENT: 'Contributed', REFUND: 'Withdrawn from project', PAYOUT: 'Funds released' };
const INCOMING = new Set(['DEPOSIT', 'REFUND', 'PAYOUT']);

export default function Wallet() {
  const { user, refresh } = useAuth();
  const { data, error, loading, reload } = useApi('/api/wallet');
  const [adding, setAdding] = useState(false);
  const isBacker = user.role === 'INVESTOR';

  if (loading && !data) return <Loading />;
  if (error) return <div className="page"><ErrorState error={error} onRetry={reload} /></div>;

  const contributed = data.holdings.reduce((s, h) => s + h.invested, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{isBacker ? 'Wallet' : 'Payouts'}</h1>
          <p>{isBacker ? 'Add money here, then contribute to projects. Every movement is recorded on the ledger.' : 'Money released from your funded projects lands here.'}</p>
        </div>
      </div>

      <div className="stats" style={{ gridTemplateColumns: isBacker ? undefined : 'repeat(2, minmax(0, 1fr))' }}>
        <div><b>{moneyPrecise(data.balance)}</b><span>Available balance</span></div>
        {isBacker && <div><b>{money(contributed)}</b><span>Currently in projects</span></div>}
        {isBacker && <div><b>{data.holdings.length}</b><span>Projects backed</span></div>}
        <div><b>{data.transactions.length}</b><span>Transactions</span></div>
      </div>

      {isBacker && (
        <div className="row" style={{ marginBottom: 28 }}>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>Add funds</button>
          <a className="btn" href="#/explore">Find a project</a>
        </div>
      )}

      {isBacker && data.holdings.length > 0 && (
        <section className="panel" style={{ marginBottom: 20 }}>
          <div className="panel-pad" style={{ paddingBottom: 6 }}><h2>Projects you back</h2></div>
          {data.holdings.map((h) => (
            <a key={h.projectId} href={`#/projects/${h.projectId}`} className="list-link">
              <div className="row-between">
                <strong>{h.title}</strong>
                <StatusPill status={h.status} />
              </div>
              <Bar value={h.currentFunding} total={h.targetFunding} thin done={h.status !== 'VERIFIED'} />
              <div className="row-between faint">
                <span>Your share: {money(h.invested)}</span>
                <span>{percent(h.currentFunding, h.targetFunding)}% of {money(h.targetFunding)}</span>
              </div>
            </a>
          ))}
        </section>
      )}

      <section className="panel">
        <div className="panel-pad" style={{ paddingBottom: 6 }}><h2>History</h2></div>
        {data.transactions.length === 0 ? (
          <p className="panel-pad muted" style={{ paddingTop: 4 }}>
            {isBacker ? 'Nothing yet. Add funds to get started.' : 'Nothing yet. Funds appear here when you release money from a funded project.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>What</th><th>Project</th><th>Ledger block</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {data.transactions.map((t) => (
                  <tr key={t.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{dateTime(t.createdAt)}</td>
                    <td>{TYPE_LABEL[t.type]}</td>
                    <td>{t.projectId ? <a href={`#/projects/${t.projectId}`}>{t.projectTitle}</a> : <span className="faint">—</span>}</td>
                    <td><span className="hash" title={t.blockHash}>#{t.blockIndex} {t.blockHash.slice(0, 10)}</span></td>
                    <td className={`num ${INCOMING.has(t.type) ? 'amount-in' : 'amount-out'}`}>{INCOMING.has(t.type) ? '+' : '−'}{moneyPrecise(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {adding && <AddFunds onClose={() => setAdding(false)} onDone={async () => { setAdding(false); await Promise.all([reload(), refresh()]); }} />}
    </div>
  );
}

function AddFunds({ onClose, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const n = Number(amount);
    if (!n || n < 100) return setError(`The minimum is ${money(100)}.`);
    if (n > 1000000) return setError(`The maximum per deposit is ${money(1000000)}.`);
    setBusy(true);
    try {
      const r = await api.post('/api/wallet/deposit', { amount: n });
      toast(`${money(n)} added. New balance ${money(r.balance)}.`);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal title="Add funds" description="The amount is credited to your wallet and written to the ledger." onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label="Amount" error={error} hint={`Between ${money(100)} and ${money(1000000)} per deposit.`}>
          <div className="input-prefix"><b>{currencySymbol}</b><input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></div>
        </Field>
        <div className="row" style={{ marginTop: -6, marginBottom: 18 }}>
          {[1000, 5000, 10000, 50000].map((v) => <button type="button" key={v} className="btn btn-sm" onClick={() => setAmount(String(v))}>{money(v)}</button>)}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <Submit busy={busy}>Add funds</Submit>
        </div>
      </form>
    </Modal>
  );
}
