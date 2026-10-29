// Project suggestions for backers.
//
// Every score is computed from live data: how far a project is from its goal,
// how fast money has come in over the last 14 days, how transparent its budget
// is, how many people back it, and what a backer's money buys at the listed
// unit costs. Nothing is random and nothing is a promise of financial return.
import { CATEGORIES } from '../shared/validation.js';

export const RISK_LEVELS = ['steady', 'balanced', 'growth'];

const WEIGHTS = {
  // Projects close to the goal with clear budgets: most likely to finish.
  steady: { progress: 0.32, momentum: 0.15, transparency: 0.25, traction: 0.13, cost: 0.15, early: 0 },
  balanced: { progress: 0.2, momentum: 0.25, transparency: 0.2, traction: 0.15, cost: 0.2, early: 0 },
  // Earlier-stage projects that are picking up speed: most room to grow.
  growth: { progress: 0, momentum: 0.35, transparency: 0.15, traction: 0.1, cost: 0.2, early: 0.2 },
};

const inr = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: process.env.CURRENCY || 'INR', maximumFractionDigits: 0 }).format(Number(n) || 0);
const clamp = (n) => Math.max(0, Math.min(1, n));

export function validatePreferences(input) {
  const errors = {};
  const budget = Number(input.budget);
  if (!Number.isFinite(budget) || budget < 100) errors.budget = 'Enter a budget of at least ₹100.';
  else if (budget > 10_000_000) errors.budget = 'Budget can’t be more than ₹1,00,00,000.';
  const risk = RISK_LEVELS.includes(input.risk) ? input.risk : null;
  if (!risk) errors.risk = 'Choose how you’d like to back projects.';
  const horizonMonths = Number(input.horizonMonths);
  if (!Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > 60) errors.horizonMonths = 'Choose between 1 and 60 months.';
  const categories = Array.isArray(input.categories) ? input.categories.filter((c) => CATEGORIES.includes(c)) : [];
  return { errors, value: { budget: Math.floor(budget), risk, horizonMonths, categories } };
}

export async function loadPreferences(db, userId) {
  const { rows } = await db.query('SELECT * FROM investor_preferences WHERE user_id = $1', [userId]);
  if (!rows[0]) return null;
  const r = rows[0];
  return { budget: Number(r.budget), risk: r.risk, horizonMonths: r.horizon_months, categories: r.categories || [], updatedAt: r.updated_at };
}

export async function savePreferences(db, userId, p) {
  await db.query(
    `INSERT INTO investor_preferences (user_id, budget, risk, horizon_months, categories, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET budget = $2, risk = $3, horizon_months = $4, categories = $5, updated_at = NOW()`,
    [userId, p.budget, p.risk, p.horizonMonths, JSON.stringify(p.categories)]);
}

export async function recommend(db, prefs, { excludeManagerId } = {}) {
  const { rows } = await db.query(`
    SELECT p.id, p.title, p.category, p.summary, p.location, p.target_funding, p.current_funding, p.tenure_months, p.manager_id,
      (SELECT COUNT(DISTINCT t.user_id) FROM transactions t WHERE t.project_id = p.id AND t.type = 'INVESTMENT') AS backers,
      (SELECT COUNT(*) FROM project_documents d WHERE d.project_id = p.id) AS docs,
      COALESCE((SELECT SUM(CASE WHEN t.type = 'INVESTMENT' THEN t.amount ELSE -t.amount END) FROM transactions t
                WHERE t.project_id = p.id AND t.type IN ('INVESTMENT', 'REFUND') AND t.created_at > NOW() - interval '14 days'), 0) AS last14,
      COALESCE((SELECT json_agg(json_build_object('name', i.item_name, 'quantity', i.quantity, 'unitPrice', i.unit_price) ORDER BY i.unit_price)
                FROM project_items i WHERE i.project_id = p.id), '[]') AS items
    FROM projects p WHERE p.status = 'VERIFIED'`);

  const w = WEIGHTS[prefs.risk] || WEIGHTS.balanced;
  const wanted = new Set(prefs.categories || []);

  const scored = rows
    .filter((r) => r.manager_id !== excludeManagerId)
    .map((r) => {
      const goal = Number(r.target_funding);
      const raised = Number(r.current_funding);
      const remaining = Math.round((goal - raised) * 100) / 100;
      const last14 = Number(r.last14);
      const perDay = last14 / 14;
      const daysToGoal = perDay > 0 ? Math.ceil(remaining / perDay) : null;
      const items = (r.items || []).map((i) => ({ name: i.name, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) }));
      const itemised = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
      const cheapest = items.find((i) => i.unitPrice > 0) || null;
      const docs = Number(r.docs);
      const backers = Number(r.backers);

      const m = {
        progress: clamp(raised / goal),
        momentum: daysToGoal === null ? 0 : clamp(1 / (1 + daysToGoal / 30)),
        transparency: clamp(0.5 * (itemised / goal) + 0.5 * Math.min(docs / 3, 1)),
        traction: clamp(backers / 10),
        // Can this budget pay for whole units of what the project is buying?
        cost: cheapest ? clamp(prefs.budget / cheapest.unitPrice) : 0.4,
      };
      m.early = clamp(1 - m.progress) * (m.momentum > 0 ? 1 : 0.3);

      const base = Object.entries(w).reduce((s, [k, weight]) => s + weight * m[k], 0);
      const categoryFit = wanted.size === 0 || wanted.has(r.category) ? 1 : 0.35;
      const horizonFit = r.tenure_months <= prefs.horizonMonths ? 1 : 0.6;
      const score = base * categoryFit * horizonFit;

      // Plain-language reasons, strongest first.
      const reasons = [];
      if (m.progress >= 0.6) reasons.push(`Already ${Math.floor(m.progress * 100)}% funded, so it’s close to finishing`);
      if (daysToGoal !== null) reasons.push(`Raised ${inr(last14)} in the last 14 days, about ${daysToGoal} ${daysToGoal === 1 ? 'day' : 'days'} to goal at that pace`);
      else reasons.push('No contributions in the last 14 days, so your support would make a visible difference');
      if (m.progress < 0.6) reasons.push(`${Math.floor(m.progress * 100)}% funded, with ${inr(remaining)} still to raise`);
      if (itemised > 0) reasons.push(`${Math.round((itemised / goal) * 100)}% of the budget is itemised${docs ? ` and ${docs} ${docs === 1 ? 'document is' : 'documents are'} attached` : ''}`);
      else if (docs) reasons.push(`${docs} supporting ${docs === 1 ? 'document' : 'documents'} attached`);
      else reasons.push('No itemised budget or documents yet, so check the description carefully');
      if (backers) reasons.push(`${backers} ${backers === 1 ? 'person backs' : 'people back'} it`);
      if (wanted.size && wanted.has(r.category)) reasons.push(`Matches your interest in ${r.category}`);
      if (r.tenure_months <= prefs.horizonMonths) reasons.push(`Delivers in ${r.tenure_months} months, within your ${prefs.horizonMonths}-month window`);
      else reasons.push(`Takes ${r.tenure_months} months, longer than your ${prefs.horizonMonths}-month window`);

      return {
        projectId: r.id, title: r.title, category: r.category, summary: r.summary, location: r.location,
        targetFunding: goal, currentFunding: raised, remaining, backers, documents: docs, tenureMonths: r.tenure_months,
        perDay: Math.round(perDay), daysToGoal, items,
        score: Math.round(score * 100),
        signals: {
          finishLikelihood: Math.round(((m.progress + m.momentum) / 2) * 100),
          growth: Math.round(m.momentum * 100),
          transparency: Math.round(m.transparency * 100),
          unitCost: Math.round(m.cost * 100),
        },
        reasons,
      };
    })
    .filter((p) => p.remaining >= 100)
    .sort((a, b) => b.score - a.score);

  // Split the budget across the top picks in proportion to score.
  // Only strong matches get a share: at least 40% of the best score.
  const cutoff = scored.length ? Math.max(10, scored[0].score * 0.4) : 0;
  const top = scored.slice(0, prefs.budget >= 300 ? 3 : 1).filter((p) => p.score >= cutoff);
  const totalScore = top.reduce((s, p) => s + p.score, 0);
  let left = prefs.budget;
  for (const p of top) {
    const share = Math.floor(((prefs.budget * p.score) / totalScore) / 100) * 100;
    p.suggestedAmount = Math.max(100, Math.min(share, p.remaining, left));
    left -= p.suggestedAmount;
  }
  for (const p of top) {
    if (left < 100) break;
    const extra = Math.min(Math.floor(left / 100) * 100, Math.floor((p.remaining - p.suggestedAmount) / 100) * 100);
    if (extra > 0) { p.suggestedAmount += extra; left -= extra; }
  }

  // What each suggested share could buy at the project's listed unit costs.
  for (const p of scored) {
    const amount = p.suggestedAmount || Math.min(prefs.budget, p.remaining);
    p.couldBuy = p.items
      .filter((i) => i.unitPrice > 0 && i.unitPrice <= amount)
      .slice(0, 3)
      .map((i) => ({ name: i.name, unitPrice: i.unitPrice, units: Math.min(Math.floor(amount / i.unitPrice), i.quantity), needed: i.quantity }));
    p.cheapestItem = p.items.find((i) => i.unitPrice > 0) || null;
  }

  const allocated = top.reduce((s, p) => s + p.suggestedAmount, 0);
  return { picks: scored.slice(0, 8).map((p, i) => ({ ...p, rank: i + 1 })), allocated, unallocated: prefs.budget - allocated, considered: rows.length };
}

/** Optional short summary from Claude; falls back to a plain template. */
export async function summarize(prefs, result) {
  const top = result.picks.filter((p) => p.suggestedAmount);
  if (!top.length) return 'No projects that are raising funds fit right now. Try widening your interests or time window, or check back when new projects are approved.';
  const template = `With ${inr(prefs.budget)}, a ${prefs.risk} approach suggests putting ${top.map((p) => `${inr(p.suggestedAmount)} into ${p.title}`).join(', ')}. ${
    prefs.risk === 'growth' ? 'These are earlier-stage projects that are picking up speed.' : prefs.risk === 'steady' ? 'These are closest to their goals with the clearest budgets.' : 'This balances projects near their goal with ones gaining momentum.'}`;
  if (!process.env.ANTHROPIC_API_KEY) return template;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
        max_tokens: 250,
        system: 'You explain crowdfunding project suggestions to a backer in 2–3 plain sentences. Use only the numbers given. Amounts are Indian rupees. Say these rank funding progress and momentum, not financial returns. No markdown.',
        messages: [{ role: 'user', content: JSON.stringify({ preferences: prefs, picks: top.map(({ title, suggestedAmount, reasons, signals }) => ({ title, suggestedAmount, reasons, signals })) }) }],
      }),
    });
    if (!res.ok) return template;
    const data = await res.json();
    return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim() || template;
  } catch {
    return template;
  } finally {
    clearTimeout(timer);
  }
}
