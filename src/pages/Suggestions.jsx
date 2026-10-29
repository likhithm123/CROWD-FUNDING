import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { currencySymbol, money, CATEGORY_COLOR } from '../lib/format';
import { CATEGORIES } from '../../shared/validation.js';
import { Loading, Notice, Submit, useToast } from '../components/ui';

const QUICK_PROMPTS = [
  'solar pump based',
  'Clean energy',
  'Solar PV modules',
  'power generation',
  'Battery storage'
];

export default function Suggestions() {
  const { user } = useAuth();
  const toast = useToast();

  const [queryInput, setQueryInput] = useState('');
  const [category, setCategory] = useState('');
  const [budget, setBudget] = useState('300000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [expandedEquipment, setExpandedEquipment] = useState({});

  // Auto-run initial query on mount to load verified database projects
  useEffect(() => {
    runSearch('', '', '300000');
  }, []);

  async function runSearch(qText, catVal, budgetVal) {
    const q = (qText !== undefined ? qText : queryInput).trim();
    setError(null);
    setBusy(true);

    try {
      const res = await api.post('/api/suggestions/query', {
        query: q,
        category: catVal !== undefined ? catVal : (category || null),
        budget: Number(budgetVal !== undefined ? budgetVal : budget) || 300000
      });
      setData(res);
      setExpandedEquipment({});
    } catch (err) {
      setError(err.message || 'Failed to search projects.');
    } finally {
      setBusy(false);
    }
  }

  function handleFormSubmit(e) {
    e.preventDefault();
    runSearch();
  }

  function selectQuickPrompt(promptText) {
    setQueryInput(promptText);
    runSearch(promptText);
  }

  function clearFilters() {
    setQueryInput('');
    setCategory('');
    setBudget('300000');
    runSearch('', '', '300000');
  }

  function toggleEquipment(idx) {
    setExpandedEquipment((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }

  function copyProjectDetails(project) {
    const lines = [
      `CROWDFUND VERIFIED PROJECT RECORD`,
      `Title: ${project.title}`,
      `Category: ${project.category} | Location: ${project.location}`,
      `Target Funding: ${money(project.targetFunding)} | Duration: ${project.tenureMonths} months`,
      `Summary: ${project.summary}`,
      `--------------------------------------------------`,
      `QUERY RELEVANCE EXPLANATION:`,
      project.whyItMatches,
      `--------------------------------------------------`,
      `PROJECT EXPLAINABILITY:`,
      `Core Purpose: ${project.explainability?.corePurpose || project.summary}`,
      `Budget Plan: ${project.explainability?.budgetExplainability || 'Line-item equipment verified on ledger'}`,
      `Delivery: ${project.explainability?.deliveryExplainability || 'Supervised project delivery'}`,
      `--------------------------------------------------`,
      `EQUIPMENT BILL OF MATERIALS:`,
      ...(project.items || []).map((it, i) => `${i + 1}. ${it.quantity}x ${it.name} at ${money(it.unitPrice)} = ${money(it.totalCost)} (Supplier: ${it.supplier || 'Verified'})`)
    ];
    navigator.clipboard.writeText(lines.join('\n'));
    toast('Project details copied to clipboard.');
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>AI Project Suggestions & Filter</h1>
          <p>
            Filter active projects directly from the platform database using natural language.
            Our AI evaluates your query against actual project records, explaining why each project matches
            and providing complete operational and budget explainability.
          </p>
        </div>
      </div>

      {/* Query Filter Section */}
      <div className="panel panel-pad" style={{ marginBottom: 24, borderTop: '4px solid var(--pine)' }}>
        <form onSubmit={handleFormSubmit} noValidate>
          <div className="field">
            <label htmlFor="ai-query-input" style={{ fontWeight: 600, fontSize: '1rem', display: 'block', marginBottom: 8 }}>
              Search and filter projects by topic, technology, or keywords
            </label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <input
                id="ai-query-input"
                className="input"
                style={{ flex: 1, minWidth: 260, fontSize: '1rem' }}
                placeholder="e.g. solar pump based, clean energy, storage, irrigation"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
              />
              <Submit busy={busy} className="btn btn-primary">
                {busy ? 'Filtering...' : 'Search Projects'}
              </Submit>
              {(queryInput || category) && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={clearFilters}
                  disabled={busy}
                >
                  Clear Filters
                </button>
              )}
            </div>
          </div>

          {/* Suggested Keyword Chips */}
          <div style={{ margin: '14px 0 16px' }}>
            <span className="faint small" style={{ display: 'block', marginBottom: 6 }}>
              Quick filters:
            </span>
            <div className="chips" style={{ marginBottom: 0, gap: 8 }}>
              {QUICK_PROMPTS.map((qp) => (
                <button
                  key={qp}
                  type="button"
                  className="chip"
                  style={{ fontSize: '0.82rem', padding: '5px 12px' }}
                  onClick={() => selectQuickPrompt(qp)}
                >
                  {qp}
                </button>
              ))}
            </div>
          </div>

          {/* Category & Budget Controls */}
          <div className="row" style={{ gap: 16, flexWrap: 'wrap', paddingTop: 8, borderTop: '1px solid var(--line)' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label htmlFor="filter-cat" className="faint small" style={{ display: 'block', marginBottom: 4 }}>
                Category Filter
              </label>
              <select
                id="filter-cat"
                className="select"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  runSearch(undefined, e.target.value);
                }}
              >
                <option value="">All Categories</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>

            <div style={{ flex: 1, minWidth: 180 }}>
              <label htmlFor="filter-budget" className="faint small" style={{ display: 'block', marginBottom: 4 }}>
                Target Budget Context
              </label>
              <select
                id="filter-budget"
                className="select"
                value={budget}
                onChange={(e) => {
                  setBudget(e.target.value);
                  runSearch(undefined, undefined, e.target.value);
                }}
              >
                <option value="100000">Up to {money(100000)} (Community Standard)</option>
                <option value="300000">Up to {money(300000)} (Regional Scale)</option>
                <option value="500000">Up to {money(500000)} (District Enterprise)</option>
                <option value="1000000">Up to {money(1000000)} (Large Infrastructure)</option>
              </select>
            </div>
          </div>
        </form>

        {error && (
          <div style={{ marginTop: 16 }}>
            <Notice kind="error">{error}</Notice>
          </div>
        )}
      </div>

      {/* Loading Indicator */}
      {busy && (
        <div className="panel panel-pad" style={{ textAlign: 'center', padding: '40px 20px' }}>
          <Loading label="Filtering project records and analyzing query relevance with AI..." />
        </div>
      )}

      {/* Empty State */}
      {!busy && data && data.projects.length === 0 && (
        <div className="panel panel-pad empty" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <h3>No projects found in database</h3>
          <p className="muted" style={{ maxWidth: 520, margin: '8px auto 20px' }}>
            {data.analysis || 'No projects match your current query or category filter.'}
          </p>
          <button type="button" className="btn btn-primary" onClick={clearFilters}>
            Clear Filter and View All Projects
          </button>
        </div>
      )}

      {/* Results Section */}
      {!busy && data && data.projects.length > 0 && (
        <div className="stack" style={{ gap: 24 }}>
          {/* Query Analysis Banner */}
          {data.analysis && (
            <div
              className="panel panel-pad"
              style={{
                background: 'var(--sunk)',
                borderLeft: '4px solid var(--pine-dark)',
                padding: '16px 20px'
              }}
            >
              <div className="small faint" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, marginBottom: 4 }}>
                Query Filter Assessment
              </div>
              <p style={{ margin: '0 0 8px', fontSize: '0.96rem', lineHeight: 1.5, color: 'var(--ink)' }}>
                {data.analysis}
              </p>
              {data.bestMatchSummary && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)', fontSize: '0.92rem', color: 'var(--ink-2)' }}>
                  <strong>Match Highlight: </strong>{data.bestMatchSummary}
                </div>
              )}
            </div>
          )}

          {/* Project Cards Header */}
          <div className="row-between" style={{ alignItems: 'baseline' }}>
            <h2 style={{ fontSize: '1.25rem' }}>
              Matching Projects ({data.projects.length})
            </h2>
            <span className="faint small">
              Filtered from verified platform database records
            </span>
          </div>

          {/* Projects List */}
          <div className="stack" style={{ gap: 20 }}>
            {data.projects.map((project, idx) => {
              const isEqExpanded = expandedEquipment[idx];
              const itemsTotal = (project.items || []).reduce((s, it) => s + (it.totalCost || (it.quantity * it.unitPrice)), 0);

              return (
                <article
                  key={project.id || idx}
                  className="panel"
                  style={{
                    overflow: 'hidden',
                    border: '1px solid var(--line)',
                    background: 'var(--surface)'
                  }}
                >
                  {/* Category Color Strip */}
                  <div
                    style={{
                      height: 5,
                      background: CATEGORY_COLOR[project.category] || 'var(--pine)'
                    }}
                  />

                  <div className="panel-pad">
                    {/* Header Row: Category, Location, and Funding */}
                    <div className="row-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
                      <div>
                        <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                          <span
                            className="status small"
                            style={{
                              fontWeight: 700,
                              background: idx === 0 ? 'var(--pine-tint)' : 'var(--sunk)',
                              color: idx === 0 ? 'var(--pine-dark)' : 'var(--ink)',
                              borderColor: idx === 0 ? 'var(--pine)' : 'var(--line)'
                            }}
                          >
                            {project.matchRank || 'Top Match'} ({project.matchScore}% Relevance)
                          </span>
                          <span className="status small" style={{ fontWeight: 600 }}>
                            {project.category}
                          </span>
                          <span className="faint small">
                            Location: {project.location}
                          </span>
                          <span className="status status-live small">
                            Active On Ledger
                          </span>
                        </div>
                        <h3 style={{ fontSize: '1.35rem', margin: '0 0 6px' }}>
                          <a href={`#/projects/${project.id}`} style={{ color: 'inherit' }}>
                            {project.title}
                          </a>
                        </h3>
                        <p className="muted" style={{ fontSize: '0.95rem', margin: 0 }}>
                          {project.summary}
                        </p>
                      </div>

                      <div style={{ textAlign: 'right', minWidth: 160 }}>
                        <div className="faint small">TARGET FUNDING</div>
                        <div style={{ fontSize: '1.35rem', fontWeight: 800, color: 'var(--pine-dark)' }}>
                          {money(project.targetFunding)}
                        </div>
                        <div className="faint small">
                          Delivery: {project.tenureMonths} months
                        </div>
                      </div>
                    </div>

                    {/* RELEVANCE TO USER QUERY */}
                    {project.whyItMatches && (
                      <div
                        style={{
                          margin: '16px 0 14px',
                          padding: '14px 16px',
                          background: 'var(--sunk)',
                          borderRadius: 'var(--r-input)',
                          border: '1px solid var(--line)'
                        }}
                      >
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: '0.85rem',
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                            color: 'var(--ink)',
                            marginBottom: 6
                          }}
                        >
                          Relevance to Your Query (AI Match Explanation)
                        </div>
                        <p style={{ margin: '0 0 10px', fontSize: '0.94rem', lineHeight: 1.55, color: 'var(--ink)' }}>
                          {project.whyItMatches}
                        </p>
                        {project.requirementAlignments && project.requirementAlignments.length > 0 && (
                          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.88rem', color: 'var(--ink-2)', lineHeight: 1.5 }}>
                            {project.requirementAlignments.map((ra, rIdx) => (
                              <li key={rIdx}>{ra}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    {/* PROJECT EXPLAINABILITY & OPERATIONAL SCOPE */}
                    <div
                      style={{
                        margin: '12px 0 14px',
                        padding: '14px 16px',
                        background: 'var(--pine-tint)',
                        borderRadius: 'var(--r-input)',
                        borderLeft: '4px solid var(--pine)'
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 700,
                          fontSize: '0.85rem',
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          color: 'var(--pine-dark)',
                          marginBottom: 8
                        }}
                      >
                        Project Explainability & Operational Scope
                      </div>

                      <div className="stack" style={{ gap: 8, fontSize: '0.92rem', lineHeight: 1.5 }}>
                        <div>
                          <strong style={{ color: 'var(--ink)' }}>Core Purpose: </strong>
                          <span style={{ color: 'var(--ink-2)' }}>{project.explainability?.corePurpose}</span>
                        </div>
                        <div>
                          <strong style={{ color: 'var(--ink)' }}>Budget & Equipment Allocation: </strong>
                          <span style={{ color: 'var(--ink-2)' }}>{project.explainability?.budgetExplainability}</span>
                        </div>
                        <div>
                          <strong style={{ color: 'var(--ink)' }}>Delivery Plan: </strong>
                          <span style={{ color: 'var(--ink-2)' }}>{project.explainability?.deliveryExplainability}</span>
                        </div>
                      </div>
                    </div>

                    {/* Bill of Materials / Equipment Accordion */}
                    {project.items && project.items.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => toggleEquipment(idx)}
                          style={{ fontSize: '0.85rem', padding: '4px 10px' }}
                        >
                          {isEqExpanded ? 'Hide Equipment & Budget Details' : `Show Verified Bill of Materials (${project.items.length} items)`}
                        </button>

                        {isEqExpanded && (
                          <div style={{ marginTop: 10, border: '1px solid var(--line)', borderRadius: 'var(--r-input)', overflow: 'hidden' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.88rem' }}>
                              <thead>
                                <tr style={{ background: 'var(--sunk)', textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                                  <th style={{ padding: '8px 12px' }}>Equipment / Item</th>
                                  <th style={{ padding: '8px 12px', textAlign: 'center' }}>Qty</th>
                                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Unit Price</th>
                                  <th style={{ padding: '8px 12px', textAlign: 'left' }}>Supplier</th>
                                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                {project.items.map((it, itemIdx) => (
                                  <tr key={itemIdx} style={{ borderBottom: '1px solid var(--line)' }}>
                                    <td style={{ padding: '8px 12px' }}>{it.name}</td>
                                    <td style={{ padding: '8px 12px', textAlign: 'center' }}>{it.quantity}</td>
                                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>{money(it.unitPrice)}</td>
                                    <td style={{ padding: '8px 12px', color: 'var(--ink-2)' }}>{it.supplier || 'Verified'}</td>
                                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>{money(it.totalCost || (it.quantity * it.unitPrice))}</td>
                                  </tr>
                                ))}
                              </tbody>
                              {itemsTotal > 0 && (
                                <tfoot>
                                  <tr style={{ background: 'var(--sunk)', fontWeight: 700 }}>
                                    <td colSpan={4} style={{ padding: '8px 12px' }}>Estimated Equipment Total</td>
                                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--pine-dark)' }}>{money(itemsTotal)}</td>
                                  </tr>
                                </tfoot>
                              )}
                            </table>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Card Action Buttons */}
                    <div className="row-between" style={{ borderTop: '1px solid var(--line)', paddingTop: 14, flexWrap: 'wrap', gap: 10 }}>
                      <div className="row" style={{ gap: 10 }}>
                        <a className="btn btn-primary btn-sm" href={`#/projects/${project.id}`}>
                          View Project & Back ({money(project.targetFunding)})
                        </a>

                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => copyProjectDetails(project)}
                        >
                          Copy Project Details
                        </button>
                      </div>

                      <div className="faint small" style={{ alignSelf: 'center' }}>
                        ID: {project.id}
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
