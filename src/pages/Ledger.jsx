import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { dateTime, moneyPrecise } from '../lib/format';
import { ErrorState, Loading, Notice } from '../components/ui';

const EVENT = {
  GENESIS: 'Ledger opened',
  WALLET_DEPOSIT: 'Funds added to a wallet',
  CONTRIBUTION: 'Contribution',
  CONTRIBUTION_WITHDRAWN: 'Contribution withdrawn',
  FUNDS_RELEASED: 'Funds released to project lead',
  GOAL_REACHED: 'Funding goal reached',
  PROJECT_SUBMITTED: 'Project submitted',
  PROJECT_EDITED: 'Project edited',
  PROJECT_RESUBMITTED: 'Project resubmitted',
  PROJECT_APPROVED: 'Project approved',
  PROJECT_REJECTED: 'Changes requested',
  DOCUMENT_ADDED: 'Document added',
  DOCUMENT_REMOVED: 'Document removed',
};

function describe(b) {
  const p = b.payload;
  const bits = [];
  if (b.userName) bits.push(b.userName);
  if (b.projectTitle) bits.push(`“${b.projectTitle}”`);
  if (p.name) bits.push(p.name);
  return bits.join(', ');
}

export default function Ledger() {
  const [blocks, setBlocks] = useState([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(null);

  async function loadPage(before) {
    setLoading(true);
    try {
      const d = await api.get(`/api/ledger?limit=25${before !== undefined ? `&before=${before}` : ''}`);
      setBlocks((prev) => (before !== undefined ? [...prev, ...d.blocks] : d.blocks));
      setTotal(d.total);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    setChecking(true);
    try { setCheck(await api.get('/api/ledger/verify')); } catch (err) { setCheck({ error: err.message }); } finally { setChecking(false); }
  }

  useEffect(() => { loadPage(); verify(); }, []);

  const flagged = new Set((check?.problems || []).map((p) => p.blockIndex).filter((i) => i !== undefined));

  if (error) return <div className="page"><ErrorState error={error} onRetry={() => { setError(null); loadPage(); }} /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Ledger</h1>
          <p>Every contribution, withdrawal, approval and document is written here as a block. Each block includes the fingerprint of the one before it, so changing an old entry breaks every block after it.</p>
        </div>
        <button className="btn" onClick={verify} disabled={checking}>{checking && <span className="spinner" />}Check integrity</button>
      </div>

      <div style={{ marginBottom: 20 }}>
        {!check ? <Notice kind="info">Checking the ledger…</Notice> : check.error ? <Notice kind="error">{check.error}</Notice> : check.valid ? (
          <Notice kind="ok" title="The ledger checks out">
            All {check.blocks} blocks link correctly, every transaction matches its block, and every wallet and project total matches the ledger. Checked {dateTime(check.checkedAt)}.
          </Notice>
        ) : (
          <Notice kind="error" title={`The ledger failed its check (${check.problems.length} ${check.problems.length === 1 ? 'problem' : 'problems'})`}>
            <p style={{ margin: '4px 0 8px' }}>Payments are paused until an administrator fixes the data.</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {check.problems.slice(0, 8).map((p, i) => <li key={i}>{p.message}</li>)}
              {check.problems.length > 8 && <li>…and {check.problems.length - 8} more.</li>}
            </ul>
          </Notice>
        )}
      </div>

      <div className="panel">
        <div className="panel-pad row-between" style={{ paddingBottom: 10 }}>
          <h2>Blocks</h2>
          <span className="faint">{total} in total, newest first</span>
        </div>
        {blocks.map((b) => (
          <div key={b.index} className={`block${flagged.has(b.index) ? ' block-flag' : ''}`}>
            <div className="block-index">#{b.index}</div>
            <div style={{ minWidth: 0 }}>
              <div className="row-between">
                <span>
                  <strong>{EVENT[b.payload.event] || b.payload.event}</strong>
                  {b.payload.amount !== undefined && <> <span className="amount-in">{moneyPrecise(b.payload.amount)}</span></>}
                </span>
                <span className="faint">{dateTime(b.timestamp)}</span>
              </div>
              <div className="muted small">{describe(b)}</div>
              <button className="linkish small" style={{ marginTop: 4 }} onClick={() => setOpen(open === b.index ? null : b.index)}>
                {open === b.index ? 'Hide details' : 'Show details'}
              </button>
              {open === b.index && (
                <div style={{ marginTop: 8 }} className="small">
                  <div><span className="faint">Fingerprint</span> <span className="hash">{b.hash}</span></div>
                  <div><span className="faint">Previous</span> <span className="hash">{b.previousHash}</span></div>
                  <pre className="hash" style={{ background: 'var(--sunk)', padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap', marginTop: 8 }}>{JSON.stringify(b.payload, null, 2)}</pre>
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && <Loading />}
        {!loading && blocks.length < total && (
          <div className="panel-pad" style={{ textAlign: 'center' }}>
            <button className="btn" onClick={() => loadPage(blocks[blocks.length - 1].index)}>Show older blocks</button>
          </div>
        )}
      </div>
    </div>
  );
}
