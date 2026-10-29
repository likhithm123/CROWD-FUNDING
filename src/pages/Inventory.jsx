import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { currencySymbol, money, moneyPrecise, date } from '../lib/format';
import { CATEGORIES } from '../../shared/validation.js';
import { Field, Loading, Notice, useToast } from '../components/ui';
import { navigate } from '../lib/router';

const PRESETS = [25000, 50000, 100000, 250000, 500000];

const IMPORTANCE_CLASSES = {
  Essential: 'status-live',
  'High Impact': 'status-funded',
  Operational: 'status-pending'
};

const CATEGORY_ICONS = {
  Agriculture: '🌾',
  'Clean energy': '⚡',
  Education: '📚',
  Health: '🩺',
  Technology: '💻',
  'Water & sanitation': '💧',
  'Community infrastructure': '🏗️',
  'Arts & culture': '🎨'
};

export default function Inventory() {
  const { user } = useAuth();
  const toast = useToast();

  const [category, setCategory] = useState('Agriculture');
  const [budget, setBudget] = useState('100000');
  const [tier, setTier] = useState('community');
  const [customPrompt, setCustomPrompt] = useState('');
  const [sortBy, setSortBy] = useState('profit'); // 'profit' | 'renewable' | 'payback' | 'impact'
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Expanded items for explainable growth breakdown
  const [expandedItems, setExpandedItems] = useState({});

  // Receipt Modal State
  const [receiptModal, setReceiptModal] = useState(null);
  const [receiptLoading, setReceiptLoading] = useState(false);

  // Load suggestion data
  async function fetchSuggestions(overrideCategory, overrideTier, overrideSort, overridePrompt) {
    setBusy(true);
    setError(null);
    try {
      const cat = overrideCategory || category;
      const t = overrideTier || tier;
      const s = overrideSort || sortBy;
      const b = Number(budget) || 100000;
      const q = overridePrompt !== undefined ? overridePrompt : customPrompt;

      const res = await api.post('/api/inventory/suggest', {
        category: cat,
        budget: b,
        tier: t,
        sortBy: s,
        customPrompt: q || undefined
      });
      setData(res);
      // Auto-expand the top growth item for clear visibility
      setExpandedItems({ 0: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    fetchSuggestions(category, tier, sortBy);
  }, [category, tier, sortBy]);

  // Adjust item quantity interactively
  function changeQuantity(index, newQty) {
    if (!data) return;
    const qty = Math.max(1, Math.min(10000, Number(newQty) || 1));
    const nextItems = data.items.map((it, i) => {
      if (i !== index) return it;
      const totalCost = qty * it.unitPrice;
      return { ...it, quantity: qty, totalCost };
    });
    const finalTotal = nextItems.reduce((s, it) => s + it.totalCost, 0);
    const updatedItems = nextItems.map((it) => ({
      ...it,
      budgetSharePercent: finalTotal > 0 ? Math.round((it.totalCost / finalTotal) * 100) : 0
    }));

    setData({
      ...data,
      totalEstimatedCost: finalTotal,
      unallocated: Math.max(0, (Number(budget) || 0) - finalTotal),
      allocatedPercent: Number(budget) > 0 ? Math.min(100, Math.round((finalTotal / Number(budget)) * 100)) : 100,
      items: updatedItems,
      metrics: {
        ...data.metrics,
        totalUnits: updatedItems.reduce((s, it) => s + it.quantity, 0),
        averageUnitCost: updatedItems.length ? Math.round(finalTotal / updatedItems.reduce((s, it) => s + it.quantity, 0)) : 0
      }
    });
  }

  // Remove item
  function removeItem(index) {
    if (!data || data.items.length <= 1) return;
    const nextItems = data.items.filter((_, i) => i !== index);
    const finalTotal = nextItems.reduce((s, it) => s + it.totalCost, 0);
    setData({
      ...data,
      totalEstimatedCost: finalTotal,
      unallocated: Math.max(0, (Number(budget) || 0) - finalTotal),
      allocatedPercent: Number(budget) > 0 ? Math.min(100, Math.round((finalTotal / Number(budget)) * 100)) : 100,
      items: nextItems,
      metrics: {
        ...data.metrics,
        itemCount: nextItems.length,
        totalUnits: nextItems.reduce((s, it) => s + it.quantity, 0)
      }
    });
  }

  // Toggle item explanation
  function toggleExpand(index) {
    setExpandedItems((prev) => ({ ...prev, [index]: !prev[index] }));
  }

  // Generate Receipt for a Single Item
  async function generateItemReceipt(item) {
    setReceiptLoading(true);
    try {
      const res = await api.post('/api/inventory/receipt', {
        itemName: item.itemName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        category: item.category,
        supplier: item.supplier,
        specs: item.specs || item.description,
        isRenewable: item.isRenewable,
        resourceType: item.resourceType,
        profitPotential: item.profitPotential,
        paybackMonths: item.paybackMonths,
        explainableGrowth: item.explainableGrowth
      });
      setReceiptModal(res);
      toast('Receipt generated successfully!');
    } catch (err) {
      toast(err.message || 'Failed to generate receipt');
    } finally {
      setReceiptLoading(false);
    }
  }

  // Generate Master BOM Receipt for all items
  async function generateFullBOMReceipt() {
    if (!data || !data.items.length) return;
    setReceiptLoading(true);
    try {
      const res = await api.post('/api/inventory/receipt', {
        itemName: `Complete Bill of Materials (${data.items.length} Category Items)`,
        quantity: 1,
        unitPrice: data.totalEstimatedCost,
        category: data.category,
        supplier: `${data.items[0]?.supplier || 'Verified Vendors'} (+${data.items.length - 1} suppliers)`,
        specs: data.items.map((i) => `${i.quantity}x ${i.itemName}`).join('; '),
        isRenewable: data.metrics.renewablePercent >= 50,
        resourceType: `${data.metrics.renewablePercent}% Sustainable / Renewable Portfolio`,
        profitPotential: `High Composite ROI (Top item: ${data.metrics.topGrowthMultiplier}x)`,
        paybackMonths: data.metrics.averagePaybackMonths,
        explainableGrowth: data.aiInsights?.strategicAdvice || 'Comprehensive community infrastructure and renewable resource package.'
      });
      setReceiptModal(res);
      toast('Complete BOM Receipt generated!');
    } catch (err) {
      toast(err.message || 'Failed to generate receipt');
    } finally {
      setReceiptLoading(false);
    }
  }

  // Transfer inventory to Project Creation Form
  function useInProject() {
    if (!data) return;
    const draft = {
      category: data.category,
      targetFunding: data.totalEstimatedCost,
      items: data.items.map((it) => ({
        itemName: it.itemName,
        quantity: String(it.quantity),
        unitPrice: String(it.unitPrice),
        supplier: it.supplier
      }))
    };
    sessionStorage.setItem('crowdledger_draft_inventory', JSON.stringify(draft));
    toast('Inventories copied to your new project draft!');
    navigate('/new');
  }

  // Export Bill of Materials as formatted text
  function exportBOM() {
    if (!data) return;
    const lines = [
      `CROWDFUNDING INVENTORY BILL OF MATERIALS (ROI & RENEWABLE ANALYSIS)`,
      `Customer: ${user.name} (${user.email}) | Role: ${user.role}`,
      `Category: ${data.category} | Scale: ${data.tierLabel}`,
      `Total Estimated Cost: ${money(data.totalEstimatedCost)} (Target: ${money(data.targetBudget)})`,
      `Renewable Resource Ratio: ${data.metrics.renewablePercent}% | Avg Payback: ${data.metrics.averagePaybackMonths} months`,
      `--------------------------------------------------------------------------------`,
      ...data.items.map((it, i) => `${i + 1}. [${it.importance}] ${it.quantity}x ${it.itemName} @ ${money(it.unitPrice)} = ${money(it.totalCost)}\n   Resource: ${it.resourceType} | Potential: ${it.profitPotential}\n   Payback: ${it.paybackMonths} months | Est. Yield: ${it.projectedAnnualYield}\n   Why it grows: ${it.explainableGrowth}`),
      `--------------------------------------------------------------------------------`,
      `Strategic Procurement Advice: ${data.aiInsights?.strategicAdvice || 'N/A'}`
    ];
    navigator.clipboard.writeText(lines.join('\n'));
    toast('Bill of Materials with ROI analysis copied!');
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>AI Inventory & Bill of Materials</h1>
          <p>
            Explore high-profit potential, renewable resource equipment, and explainable growth drivers for community projects.
            Every inventory item is analyzed for sustainability, break-even payback speed, and economic yield.
          </p>
        </div>
      </div>

      {/* Category selector chips */}
      <div className="field" style={{ marginBottom: 20 }}>
        <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>Select Project Category</span>
        <div className="chips" style={{ marginTop: 8 }}>
          {CATEGORIES.map((cat) => (
            <button
              type="button"
              key={cat}
              className="chip"
              aria-pressed={category === cat}
              onClick={() => {
                setCategory(cat);
              }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <span>{CATEGORY_ICONS[cat] || '📦'}</span>
              <span>{cat}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="split" style={{ alignItems: 'flex-start' }}>
        {/* Left Column: Controls & AI Prompt */}
        <div className="panel panel-pad" style={{ position: 'sticky', top: 72 }}>
          <h2 style={{ fontSize: '1.2rem', marginBottom: 14 }}>Inventory Controls</h2>

          {/* Sorting / Economic Goal Selector */}
          <Field label="Suggestion Focus & Growth Strategy">
            <select
              className="select"
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value);
              }}
              style={{ fontWeight: 600, color: 'var(--pine-dark)' }}
            >
              <option value="profit">🚀 Highest Profit & Value Multiplier</option>
              <option value="renewable">🌱 100% Renewable & Sustainable First</option>
              <option value="payback">⚡ Fastest Capital Payback (Lowest Months)</option>
              <option value="impact">🌟 Maximum Verified Community Impact</option>
            </select>
          </Field>

          <Field label="Target Budget" hint={`Preset benchmarks or enter custom amount`} style={{ marginTop: 14 }}>
            <div className="input-prefix">
              <b>{currencySymbol}</b>
              <input
                className="input"
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ''))}
                onBlur={() => fetchSuggestions()}
              />
            </div>
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {PRESETS.map((p) => (
                <button
                  type="button"
                  key={p}
                  className={`btn btn-sm ${budget === String(p) ? 'btn-primary' : 'btn-ghost'}`}
                  style={{ padding: '3px 8px', fontSize: '0.8rem' }}
                  onClick={() => {
                    setBudget(String(p));
                    fetchSuggestions(category, tier, sortBy, customPrompt);
                  }}
                >
                  {money(p)}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Scale Tier" style={{ marginTop: 14 }}>
            <select
              className="select"
              value={tier}
              onChange={(e) => {
                setTier(e.target.value);
              }}
            >
              <option value="starter">Starter / Micro Project (₹10k - ₹50k)</option>
              <option value="community">Community Standard (₹50k - ₹2.5L)</option>
              <option value="regional">Regional / Scale-Up (₹2.5L - ₹10L+)</option>
            </select>
          </Field>

          <Field
            label="✨ AI Custom Requirements"
            hint="Describe specific context, terrain, or special constraints"
            style={{ marginTop: 14 }}
          >
            <textarea
              className="textarea"
              style={{ minHeight: 85, fontSize: '0.9rem' }}
              placeholder="e.g., Solar pump for 5 acres in dry climate, STEM robotics lab for 80 high-school students, or flood emergency clinic kit..."
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
            />
          </Field>

          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={busy}
            onClick={() => fetchSuggestions()}
            style={{ marginTop: 12 }}
          >
            {busy ? 'Computing Inventory…' : '✨ Generate AI Inventory'}
          </button>

          {data && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--ink-2)', marginBottom: 8 }}>
                CUSTOMER ACTIONS
              </div>
              <div className="stack" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-block"
                  disabled={receiptLoading}
                  onClick={generateFullBOMReceipt}
                  style={{ background: 'var(--pine-tint)', color: 'var(--pine-dark)', borderColor: 'var(--pine)', fontWeight: 600 }}
                >
                  🧾 {receiptLoading ? 'Generating…' : 'Generate Full BOM Receipt'}
                </button>

                {user.role === 'MANAGER' && (
                  <button type="button" className="btn btn-block" onClick={useInProject}>
                    📋 Use in New Project
                  </button>
                )}
                {user.role === 'INVESTOR' && (
                  <button
                    type="button"
                    className="btn btn-block"
                    onClick={() => navigate('/explore')}
                  >
                    🔍 Find Projects in {category}
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-block" onClick={exportBOM}>
                  📥 Copy Bill of Materials (BOM)
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Inventory List & AI Intelligence */}
        <div className="stack" style={{ minWidth: 0 }}>
          {error && <Notice kind="error">{error}</Notice>}

          {!data && busy && <Loading label="Calculating optimal high-yield bill-of-materials…" />}

          {data && (
            <>
              {/* Summary Metrics Bar with High-Growth & Renewable Analytics */}
              <div className="panel panel-pad" style={{ background: 'var(--surface)' }}>
                <div className="row-between" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
                  <div>
                    <div className="faint small">TOTAL ESTIMATED COST</div>
                    <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--pine-dark)', marginTop: 2 }}>
                      {money(data.totalEstimatedCost)}
                    </div>
                    <div className="small faint" style={{ marginTop: 2 }}>
                      Target Budget: <b>{money(data.targetBudget)}</b>
                      {data.unallocated > 0 ? ` (${money(data.unallocated)} reserve remaining)` : ''}
                    </div>
                  </div>

                  <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
                    <div style={{ textAlign: 'center' }}>
                      <div className="faint small">🌱 RENEWABLE</div>
                      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--pine-dark)' }}>
                        {data.metrics.renewablePercent}%
                      </div>
                      <div className="faint small">{data.metrics.renewableCount} eco assets</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div className="faint small">🚀 TOP GROWTH</div>
                      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--marigold-ink)' }}>
                        {data.metrics.topGrowthMultiplier}x
                      </div>
                      <div className="faint small">multiplier</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div className="faint small">⏱️ PAYBACK</div>
                      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--ink)' }}>
                        ~{data.metrics.averagePaybackMonths} mo
                      </div>
                      <div className="faint small">break-even</div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div className="faint small">IMPACT</div>
                      <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--pine)' }}>
                        {data.metrics.communityImpactScore}/100
                      </div>
                      <div className="faint small">verified</div>
                    </div>
                  </div>
                </div>

                {/* Allocation Progress Bar */}
                <div style={{ marginTop: 14 }}>
                  <div className="row-between small faint" style={{ marginBottom: 4 }}>
                    <span>Budget Allocation</span>
                    <span>{data.allocatedPercent}% of {money(data.targetBudget)}</span>
                  </div>
                  <div className="bar">
                    <span style={{ width: `${Math.min(100, data.allocatedPercent)}%` }} />
                  </div>
                </div>
              </div>

              {/* AI Procurement Insights Card */}
              {data.aiInsights && (
                <div className="panel panel-pad" style={{ borderLeft: '4px solid var(--pine)' }}>
                  <div className="row-between" style={{ marginBottom: 8 }}>
                    <h3 style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '1.05rem' }}>
                      <span>✨</span>
                      <span>AI Profitability, Sourcing & Renewable Analysis</span>
                    </h3>
                    <span className="status status-live small">
                      {data.aiInsights.source === 'ai' ? 'Live Gemini AI Analysis' : 'Benchmark Model'}
                    </span>
                  </div>

                  <div className="stack" style={{ gap: 10, fontSize: '0.92rem' }}>
                    <div>
                      <strong style={{ color: 'var(--ink)' }}>Strategic ROI & Renewable Yield: </strong>
                      <span className="muted">{data.aiInsights.strategicAdvice}</span>
                    </div>
                    <div>
                      <strong style={{ color: 'var(--ink)' }}>Operational Lifespan & Payback: </strong>
                      <span className="muted">{data.aiInsights.riskAssessment}</span>
                    </div>
                    <div>
                      <strong style={{ color: 'var(--ink)' }}>Community Outcome Multiplier: </strong>
                      <span className="muted">{data.aiInsights.communityImpact}</span>
                    </div>
                    {data.aiInsights.savingsTip && (
                      <div style={{ background: 'var(--pine-tint)', padding: '6px 12px', borderRadius: 'var(--r-input)', color: 'var(--pine-dark)' }}>
                        <strong>💡 Profit & Cost-Saving Strategy: </strong>{data.aiInsights.savingsTip}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Bill of Materials Items List with Explainable Growth & Renewable Analytics */}
              <div className="panel" style={{ overflow: 'hidden' }}>
                <div className="panel-pad" style={{ borderBottom: '1px solid var(--line)', background: 'var(--sunk)' }}>
                  <div className="row-between">
                    <div>
                      <h3 style={{ fontSize: '1.1rem' }}>Ranked Equipment & Inventory Breakdown</h3>
                      <p className="faint small">Evaluated for financial profitability, renewable efficiency, and community returns</p>
                    </div>
                    <span className="small faint">{data.items.length} items evaluated</span>
                  </div>
                </div>

                <div className="stack" style={{ gap: 0 }}>
                  {data.items.map((item, idx) => {
                    const isExpanded = expandedItems[idx];
                    return (
                      <div
                        key={idx}
                        style={{
                          padding: '18px 20px',
                          borderBottom: idx < data.items.length - 1 ? '1px solid var(--line)' : 'none',
                          background: 'var(--surface)'
                        }}
                      >
                        <div className="row-between" style={{ alignItems: 'flex-start', gap: 16 }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            {/* Badges: Renewable, ROI, and Importance */}
                            <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                              <span className={`status ${IMPORTANCE_CLASSES[item.importance] || 'status-closed'} small`}>
                                {item.importance}
                              </span>

                              {item.isRenewable && (
                                <span className="status status-live small" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <span>🌱</span>
                                  <span>100% Renewable / Sustainable</span>
                                </span>
                              )}

                              <span
                                className="status small"
                                style={{
                                  background: 'var(--marigold-tint)',
                                  color: 'var(--marigold-ink)',
                                  borderColor: 'var(--marigold)',
                                  fontWeight: 700
                                }}
                              >
                                🚀 {item.profitPotential}
                              </span>

                              <span className="faint small">
                                ⏱️ Payback: ~{item.paybackMonths} mo
                              </span>
                            </div>

                            <h4 style={{ margin: '2px 0 4px', fontSize: '1.1rem', fontWeight: 600 }}>
                              {item.itemName}
                            </h4>

                            <p className="small muted" style={{ marginBottom: 6 }}>
                              {item.description}
                            </p>

                            <div className="row" style={{ gap: 12, fontSize: '0.82rem', color: 'var(--ink-2)', marginBottom: 8, flexWrap: 'wrap' }}>
                              <div><strong>Resource:</strong> {item.resourceType}</div>
                              <div><strong>Est. Annual Yield:</strong> <span style={{ color: 'var(--pine-dark)', fontWeight: 600 }}>{item.projectedAnnualYield}</span></div>
                              <div><strong>Supplier:</strong> {item.supplier}</div>
                            </div>

                            {/* Explainable AI Growth & Value Box */}
                            <div
                              style={{
                                background: isExpanded ? 'var(--sunk)' : 'transparent',
                                border: '1px solid var(--line)',
                                borderRadius: 'var(--r-input)',
                                padding: isExpanded ? '12px 14px' : '6px 12px',
                                marginTop: 8,
                                transition: 'all 0.2s ease'
                              }}
                            >
                              <div
                                className="row-between"
                                style={{ cursor: 'pointer', userSelect: 'none' }}
                                onClick={() => toggleExpand(idx)}
                              >
                                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--pine-dark)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                  <span>💡</span>
                                  <span>Why This Inventory Generates Profit & Grows:</span>
                                </span>
                                <span style={{ fontSize: '0.8rem', color: 'var(--ink-3)' }}>
                                  {isExpanded ? '▲ Hide Analysis' : '▼ View AI Reason & Growth Drivers'}
                                </span>
                              </div>

                              {isExpanded && (
                                <div style={{ marginTop: 8, fontSize: '0.88rem', color: 'var(--ink)' }}>
                                  <p style={{ lineHeight: 1.5, marginBottom: 8 }}>
                                    {item.explainableGrowth}
                                  </p>

                                  {item.growthDrivers?.length > 0 && (
                                    <div style={{ marginTop: 6 }}>
                                      <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--ink-2)', marginBottom: 4 }}>
                                        KEY ECONOMIC GROWTH DRIVERS:
                                      </div>
                                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.83rem', color: 'var(--ink-2)' }}>
                                        {item.growthDrivers.map((drv, dIdx) => (
                                          <li key={dIdx} style={{ marginBottom: 2 }}>{drv}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Customer Receipt Trigger Button */}
                            <div style={{ marginTop: 12 }}>
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={receiptLoading}
                                onClick={() => generateItemReceipt(item)}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  fontSize: '0.82rem',
                                  borderColor: 'var(--pine)',
                                  color: 'var(--pine-dark)'
                                }}
                              >
                                <span>🧾</span>
                                <span>Generate Customer Receipt (With ROI & Impact)</span>
                              </button>
                            </div>
                          </div>

                          {/* Quantity & Pricing Controls */}
                          <div style={{ textAlign: 'right', minWidth: 160 }}>
                            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--ink)' }}>
                              {money(item.totalCost)}
                            </div>
                            <div className="faint small" style={{ marginBottom: 8 }}>
                              {moneyPrecise(item.unitPrice)} each
                            </div>

                            <div className="row" style={{ justifyContent: 'flex-end', gap: 4, alignItems: 'center' }}>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                style={{ width: 28, height: 28, padding: 0, textAlign: 'center' }}
                                onClick={() => changeQuantity(idx, item.quantity - 1)}
                                aria-label="Decrease quantity"
                              >
                                -
                              </button>
                              <input
                                className="input"
                                type="number"
                                min={1}
                                style={{ width: 54, height: 28, textAlign: 'center', padding: '2px 4px', fontSize: '0.85rem' }}
                                value={item.quantity}
                                onChange={(e) => changeQuantity(idx, e.target.value)}
                                aria-label={`Quantity of ${item.itemName}`}
                              />
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                style={{ width: 28, height: 28, padding: 0, textAlign: 'center' }}
                                onClick={() => changeQuantity(idx, item.quantity + 1)}
                                aria-label="Increase quantity"
                              >
                                +
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                style={{ color: 'var(--brick)', padding: '2px 6px', fontSize: '0.75rem', marginLeft: 4 }}
                                onClick={() => removeItem(idx)}
                                title="Remove item"
                              >
                                ✕
                              </button>
                            </div>

                            <div className="small faint" style={{ marginTop: 6 }}>
                              {item.budgetSharePercent}% of budget
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Official Inventory Customer Receipt Modal with ROI & Sustainability */}
      {receiptModal && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: 16
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setReceiptModal(null);
          }}
        >
          <div
            className="panel panel-pad"
            style={{
              maxWidth: 640,
              width: '100%',
              maxHeight: '90vh',
              overflowY: 'auto',
              background: '#ffffff',
              boxShadow: '0 20px 40px rgba(0,0,0,0.25)',
              border: '2px solid var(--pine)'
            }}
          >
            {/* Printable Receipt Container */}
            <div id="printable-receipt">
              <div className="row-between" style={{ borderBottom: '2px solid var(--line)', paddingBottom: 12, marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--pine-dark)' }}>
                    CrowdFunding
                  </div>
                  <div className="faint small">OFFICIAL INVENTORY & RENEWABLE ASSET RECEIPT</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="small faint">RECEIPT NUMBER</div>
                  <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{receiptModal.receiptId}</div>
                  <div className="faint small">{date(receiptModal.timestamp)}</div>
                </div>
              </div>

              {/* Customer and Verification Info */}
              <div className="grid-2" style={{ gap: 12, marginBottom: 16, background: 'var(--sunk)', padding: 12, borderRadius: 'var(--r-input)' }}>
                <div>
                  <div className="faint small">SPONSOR / CUSTOMER</div>
                  <div style={{ fontWeight: 600 }}>{receiptModal.customerName}</div>
                  <div className="small faint">{receiptModal.customerEmail}</div>
                  <div className="small faint">Role: {receiptModal.customerRole}</div>
                </div>
                <div>
                  <div className="faint small">CATEGORY & SUPPLIER</div>
                  <div style={{ fontWeight: 600 }}>{receiptModal.category}</div>
                  <div className="small faint">Vendor: {receiptModal.supplier}</div>
                  <div className="small status status-live" style={{ marginTop: 2, display: 'inline-block' }}>Verified on Ledger</div>
                </div>
              </div>

              {/* High Potential & Sustainability Highlights */}
              <div className="row" style={{ gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                <span className="status small" style={{ background: 'var(--marigold-tint)', color: 'var(--marigold-ink)', borderColor: 'var(--marigold)', fontWeight: 700 }}>
                  🚀 {receiptModal.profitPotential}
                </span>
                <span className="status status-live small">
                  🌱 {receiptModal.resourceType}
                </span>
                <span className="status small">
                  ⏱️ Payback: ~{receiptModal.paybackMonths} months
                </span>
              </div>

              {/* Item Particulars Table */}
              <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-input)', overflow: 'hidden', marginBottom: 16 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.92rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--sunk)', textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                      <th style={{ padding: '8px 12px' }}>Inventory Item</th>
                      <th style={{ padding: '8px 12px', textAlign: 'center' }}>Qty</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Unit Price</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ padding: '12px' }}>
                        <strong>{receiptModal.itemName}</strong>
                        {receiptModal.specs && <div className="faint small" style={{ marginTop: 2 }}>{receiptModal.specs}</div>}
                      </td>
                      <td style={{ padding: '12px', textAlign: 'center' }}>{receiptModal.quantity}</td>
                      <td style={{ padding: '12px', textAlign: 'right' }}>{money(receiptModal.unitPrice)}</td>
                      <td style={{ padding: '12px', textAlign: 'right', fontWeight: 700 }}>{money(receiptModal.totalAmount)}</td>
                    </tr>
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--line)', background: 'var(--sunk)' }}>
                      <td colSpan={3} style={{ padding: '10px 12px', fontWeight: 700 }}>Total Sponsored Amount</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: '1.1rem', color: 'var(--pine-dark)' }}>
                        {money(receiptModal.totalAmount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Explainable Value & Growth Impact Statement */}
              <div style={{ background: 'var(--pine-tint)', padding: '10px 14px', borderRadius: 'var(--r-input)', marginBottom: 16 }}>
                <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--pine-dark)', marginBottom: 4 }}>
                  ✨ EXPLAINABLE AI COMMUNITY YIELD & GROWTH ANALYSIS
                </div>
                <div style={{ fontSize: '0.88rem', color: 'var(--ink)' }}>
                  {receiptModal.aiImpactNote}
                </div>
              </div>

              {/* Cryptographic Ledger Hash */}
              <div style={{ borderTop: '1px dashed var(--line)', paddingTop: 10, marginBottom: 16 }}>
                <div className="faint small">CRYPTOGRAPHIC LEDGER VERIFICATION STAMP</div>
                <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', wordBreak: 'break-all', color: 'var(--ink-2)' }}>
                  SHA-256: {receiptModal.verificationHash}
                </div>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="row-between" style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => window.print()}
                >
                  🖨️ Print / Save as PDF
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const text = `CrowdFunding Official Inventory Receipt\nReceipt ID: ${receiptModal.receiptId}\nCustomer: ${receiptModal.customerName} (${receiptModal.customerEmail})\nItem: ${receiptModal.quantity}x ${receiptModal.itemName}\nTotal: ${money(receiptModal.totalAmount)}\nResource: ${receiptModal.resourceType}\nPotential: ${receiptModal.profitPotential}\nPayback: ${receiptModal.paybackMonths} months\nSHA-256: ${receiptModal.verificationHash}\nImpact: ${receiptModal.aiImpactNote}`;
                    navigator.clipboard.writeText(text);
                    toast('Receipt copied to clipboard!');
                  }}
                >
                  📋 Copy Text
                </button>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setReceiptModal(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
