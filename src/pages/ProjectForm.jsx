import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { currencySymbol, money } from '../lib/format';
import { CATEGORIES } from '../../shared/validation.js';
import { ErrorState, Field, Loading, Notice, Submit, useToast } from '../components/ui';

const blankItem = () => ({ itemName: '', quantity: '1', unitPrice: '', supplier: '' });
const EMPTY = { title: '', category: '', summary: '', description: '', location: '', targetFunding: '', tenureMonths: '6', items: [] };

function validate(f) {
  const e = {};
  if (f.title.trim().length < 5) e.title = 'Give it a title of at least 5 characters.';
  if (!f.category) e.category = 'Choose a category.';
  if (f.summary.trim().length < 20) e.summary = 'Write at least 20 characters.';
  if (f.description.trim().length < 80) e.description = `Write at least 80 characters (${f.description.trim().length} so far).`;
  const goal = Number(f.targetFunding);
  if (!goal || goal < 1000) e.targetFunding = `The goal must be at least ${money(1000)}.`;
  else if (goal > 50000000) e.targetFunding = `The goal can’t be more than ${money(50000000)}.`;
  const months = Number(f.tenureMonths);
  if (!Number.isInteger(months) || months < 1 || months > 60) e.tenureMonths = 'Between 1 and 60 months.';
  f.items.forEach((it, i) => {
    if (it.itemName.trim().length < 2 || !(Number(it.quantity) >= 1) || it.unitPrice === '' || Number(it.unitPrice) < 0) {
      e.items = `Item ${i + 1} needs a name, a quantity of at least 1 and a unit price.`;
    }
  });
  const total = f.items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), 0);
  if (!e.items && goal && total > goal) e.items = `Items add up to ${money(total)}, more than the ${money(goal)} goal.`;
  return e;
}

export default function ProjectForm({ id }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [loadState, setLoadState] = useState(id ? 'loading' : 'ready');
  const [loadError, setLoadError] = useState(null);
  const [status, setStatus] = useState(null);
  const [reviewNote, setReviewNote] = useState(null);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    if (id) {
      api.get(`/api/projects/${id}`).then((p) => {
        setForm({
          title: p.title, category: p.category, summary: p.summary, description: p.description, location: p.location || '',
          targetFunding: String(p.targetFunding), tenureMonths: String(p.tenureMonths),
          items: p.items.map((i) => ({ itemName: i.itemName, quantity: String(i.quantity), unitPrice: String(i.unitPrice), supplier: i.supplier || '' })),
        });
        setStatus(p.status);
        setReviewNote(p.reviewNote);
        setLoadState('ready');
      }).catch((err) => { setLoadError(err); setLoadState('error'); });
    } else {
      const aiDraft = sessionStorage.getItem('crowdfund_ai_project');
      if (aiDraft) {
        try {
          const parsed = JSON.parse(aiDraft);
          sessionStorage.removeItem('crowdfund_ai_project');
          setForm((f) => ({
            ...f,
            title: parsed.title || f.title,
            category: parsed.category || f.category,
            location: parsed.location || f.location,
            summary: parsed.summary || f.summary,
            description: parsed.description || (parsed.whyItMatters ? `Why this matters:\n${parsed.whyItMatters}\n\nGrowth and sustainability:\n${parsed.growthAndSustainability || ''}` : f.description),
            targetFunding: parsed.targetFunding ? String(parsed.targetFunding) : f.targetFunding,
            tenureMonths: parsed.tenureMonths ? String(parsed.tenureMonths) : f.tenureMonths,
            items: parsed.items && parsed.items.length > 0
              ? parsed.items.map((i) => ({ itemName: i.name || i.itemName, quantity: String(i.quantity || 1), unitPrice: String(i.unitPrice || 0), supplier: i.supplier || '' }))
              : f.items,
          }));
          toast('Loaded project proposal from AI suggestions.');
        } catch {}
      } else {
        const draft = sessionStorage.getItem('crowdledger_draft_inventory');
        if (draft) {
          try {
            const parsed = JSON.parse(draft);
            sessionStorage.removeItem('crowdledger_draft_inventory');
            setForm((f) => ({
              ...f,
              category: parsed.category || f.category,
              targetFunding: parsed.targetFunding ? String(parsed.targetFunding) : f.targetFunding,
              items: parsed.items || f.items,
            }));
            toast('Loaded budget items from suggestions.');
          } catch {}
        }
      }
    }
  }, [id]);

  async function suggestItems() {
    const cat = form.category || 'Agriculture';
    const b = Number(form.targetFunding) || 100000;
    setSuggesting(true);
    try {
      const res = await api.get(`/api/inventory/suggestions?category=${encodeURIComponent(cat)}&budget=${b}`);
      if (res?.items?.length) {
        setForm((f) => ({
          ...f,
          category: cat,
          items: res.items.map((i) => ({
            itemName: i.itemName,
            quantity: String(i.quantity),
            unitPrice: String(i.unitPrice),
            supplier: i.supplier || ''
          }))
        }));
        toast(`Added ${res.items.length} AI-suggested budget items for ${cat}.`);
      }
    } catch (err) {
      toast(err.message);
    } finally {
      setSuggesting(false);
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setItem = (i, k) => (e) => setForm((f) => ({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, [k]: e.target.value } : it)) }));
  const itemsTotal = form.items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), 0);

  async function submit(e) {
    e.preventDefault();
    setFormError(null);
    const errs = validate(form);
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Some fields need attention.');
      return;
    }
    const payload = {
      ...form,
      targetFunding: Number(form.targetFunding),
      tenureMonths: Number(form.tenureMonths),
      items: form.items.map((it) => ({ ...it, quantity: Number(it.quantity), unitPrice: Number(it.unitPrice) })),
    };
    setBusy(true);
    try {
      if (id) {
        await api.patch(`/api/projects/${id}`, payload);
        toast('Changes saved. Your project is back in the review queue.');
        navigate(`/projects/${id}`);
      } else {
        const r = await api.post('/api/projects', payload);
        toast('Project submitted for review. Add supporting documents next.');
        navigate(`/projects/${r.id}`);
      }
    } catch (err) {
      setFormError(err.message);
      setBusy(false);
    }
  }

  if (loadState === 'loading') return <Loading />;
  if (loadState === 'error') return <div className="page"><ErrorState error={loadError} /></div>;
  if (status && !['PENDING', 'REJECTED'].includes(status)) {
    return <div className="page page-narrow"><Notice kind="info" title="This project can’t be edited">Approved projects are locked so backers know what they funded. Contact the help desk if something needs correcting.</Notice></div>;
  }

  return (
    <div className="page page-narrow">
      <a className="back" href={id ? `#/projects/${id}` : '#/mine'}>← {id ? 'Back to project' : 'My projects'}</a>
      <div className="page-head">
        <div>
          <h1>{id ? 'Edit project' : 'Start a project'}</h1>
          <p>Be specific. Reviewers approve plans that say exactly what the money buys and who benefits.</p>
        </div>
      </div>
      {reviewNote && status === 'REJECTED' && <div style={{ marginBottom: 20 }}><Notice kind="warn" title="Reviewer’s note">{reviewNote}</Notice></div>}

      <form onSubmit={submit} noValidate className="stack">
        <section className="panel panel-pad">
          <h2 style={{ marginBottom: 16 }}>The basics</h2>
          <Field label="Title" error={errors.title}>
            <input className="input" value={form.title} onChange={set('title')} maxLength={120} placeholder="Solar pumps for twelve farms in Kolar" />
          </Field>
          <div className="grid-2">
            <Field label="Category" error={errors.category}>
              <select className="select" value={form.category} onChange={set('category')}>
                <option value="">Choose one</option>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Location" hint="Optional. Town or district.">
              <input className="input" value={form.location} onChange={set('location')} maxLength={120} />
            </Field>
          </div>
          <Field label="One-line summary" error={errors.summary} hint={`${form.summary.length}/200. Shown on the project list.`}>
            <input className="input" value={form.summary} onChange={set('summary')} maxLength={200} />
          </Field>
          <Field label="Full description" error={errors.description} hint="What’s the problem, what will you do, who benefits, and how will backers know it worked?">
            <textarea className="textarea" style={{ minHeight: 180 }} value={form.description} onChange={set('description')} maxLength={5000} />
          </Field>
        </section>

        <section className="panel panel-pad">
          <h2 style={{ marginBottom: 16 }}>Money and time</h2>
          <div className="grid-2">
            <Field label="Funding goal" error={errors.targetFunding}>
              <div className="input-prefix"><b>{currencySymbol}</b><input className="input" inputMode="decimal" value={form.targetFunding} onChange={(e) => setForm((f) => ({ ...f, targetFunding: e.target.value.replace(/[^\d.]/g, '') }))} /></div>
            </Field>
            <Field label="Months to deliver" error={errors.tenureMonths}>
              <input className="input" type="number" min={1} max={60} value={form.tenureMonths} onChange={set('tenureMonths')} />
            </Field>
          </div>

          <div className="row-between" style={{ margin: '6px 0 10px', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <h3>Budget items</h3>
              <p className="faint">Optional, but reviewers look for it. Up to 30 lines.</p>
            </div>
            <div className="row" style={{ gap: 12, alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={suggesting}
                onClick={suggestItems}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderColor: 'var(--pine)', color: 'var(--pine-dark)' }}
              >
                <span>{suggesting ? 'Fetching…' : `AI Suggest for ${form.category || 'Category'}`}</span>
              </button>
              {form.items.length > 0 && <span className="small">Total <b>{money(itemsTotal)}</b>{Number(form.targetFunding) > 0 && ` of ${money(Number(form.targetFunding))}`}</span>}
            </div>
          </div>
          {form.items.length > 0 && (
            <div className="item-row faint small" aria-hidden="true" style={{ marginBottom: 4 }}>
              <span>Item</span><span>Qty</span><span>Unit price</span><span>Supplier</span><span />
            </div>
          )}
          {form.items.map((it, i) => (
            <div className="item-row" key={i}>
              <input className="input" placeholder="Item" aria-label={`Item ${i + 1} name`} value={it.itemName} onChange={setItem(i, 'itemName')} maxLength={120} />
              <input className="input" type="number" min={1} aria-label={`Item ${i + 1} quantity`} value={it.quantity} onChange={setItem(i, 'quantity')} />
              <input className="input" inputMode="decimal" placeholder="0" aria-label={`Item ${i + 1} unit price`} value={it.unitPrice} onChange={setItem(i, 'unitPrice')} />
              <input className="input" placeholder="Supplier (optional)" aria-label={`Item ${i + 1} supplier`} value={it.supplier} onChange={setItem(i, 'supplier')} maxLength={120} />
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove item ${i + 1}`} onClick={() => setForm((f) => ({ ...f, items: f.items.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
          ))}
          {errors.items && <p className="field"><span className="error">{errors.items}</span></p>}
          {form.items.length < 30 && (
            <button type="button" className="btn btn-sm" onClick={() => setForm((f) => ({ ...f, items: [...f.items, blankItem()] }))}>Add an item</button>
          )}
        </section>

        {formError && <Notice kind="error">{formError}</Notice>}
        <div className="row-between">
          <p className="faint" style={{ maxWidth: '48ch' }}>{id ? 'Saving sends the project back to the review queue.' : 'You can attach documents right after submitting.'}</p>
          <Submit busy={busy}>{id ? 'Save and resubmit' : 'Submit for review'}</Submit>
        </div>
      </form>
    </div>
  );
}
