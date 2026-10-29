import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { pool, query, withTransaction, applySchema, testConnection } from './db.js';
import {
  HttpError, hashPassword, verifyPassword, getDummyHash, createSession, destroySession,
  destroyOtherSessions, publicUser, requireAuth, requireRole, rateLimit,
  MAX_FAILED_LOGINS, LOCK_MINUTES,
} from './auth.js';
import { appendBlock, ensureGenesis, verifyLedger } from './ledger.js';
import { chat } from './chat.js';
import {
  validateSignup, validateName, validatePassword, normalizeEmail, ALL_ROLES, CATEGORIES,
} from '../shared/validation.js';
import { suggestInventories, INVENTORY_CATALOG, SCALE_TIERS } from './inventoryModel.js';
import { getAiSuggestions } from './aiSuggestions.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5001;

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || true }));
app.use(express.json({ limit: '1mb' }));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

function text(value, { field, min = 1, max, required = true }) {
  const v = String(value ?? '').trim();
  if (!v && !required) return null;
  if (v.length < min) throw new HttpError(400, `${field} must be at least ${min} characters.`, { [field]: true });
  if (max && v.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`, { [field]: true });
  return v;
}

function amountOf(value, { field = 'Amount', min = 1, max = 10_000_000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number.`);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new HttpError(400, `${field} can have at most two decimal places.`);
  }
  if (n < min) throw new HttpError(400, `${field} must be at least ${min.toLocaleString('en-IN')}.`);
  if (n > max) throw new HttpError(400, `${field} can’t be more than ${max.toLocaleString('en-IN')}.`);
  return Math.round(n * 100) / 100;
}

async function assertLedgerHealthy(client) {
  const check = await verifyLedger(client);
  if (!check.valid) {
    throw new HttpError(423, 'Payments are paused because the ledger failed its integrity check. An administrator needs to look into it.');
  }
}

const PUBLIC_STATUSES = ['VERIFIED', 'FUNDED', 'CLOSED'];

function canSeeProject(user, project) {
  if (PUBLIC_STATUSES.includes(project.status)) return true;
  return user.role === 'ADMIN' || user.role === 'SUPPORT' || project.manager_id === user.id;
}

function shapeProject(p) {
  return {
    id: p.id,
    title: p.title,
    category: p.category,
    summary: p.summary,
    description: p.description,
    location: p.location,
    managerId: p.manager_id,
    managerName: p.manager_name,
    targetFunding: Number(p.target_funding),
    currentFunding: Number(p.current_funding),
    tenureMonths: p.tenure_months,
    status: p.status,
    reviewNote: p.review_note,
    reviewedAt: p.reviewed_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    backers: p.backers ?? 0,
    documentCount: p.document_count ?? 0,
  };
}

const PROJECT_SELECT = `
  SELECT p.*, u.name AS manager_name,
    (SELECT COUNT(DISTINCT t.user_id) FROM transactions t WHERE t.project_id = p.id AND t.type = 'INVESTMENT') AS backers,
    (SELECT COUNT(*) FROM project_documents d WHERE d.project_id = p.id) AS document_count
  FROM projects p JOIN users u ON u.id = p.manager_id`;

function parseProjectInput(body) {
  const title = text(body.title, { field: 'Title', min: 5, max: 120 });
  const summary = text(body.summary, { field: 'Summary', min: 20, max: 200 });
  const description = text(body.description, { field: 'Description', min: 80, max: 5000 });
  const location = text(body.location, { field: 'Location', min: 2, max: 120, required: false });
  if (!CATEGORIES.includes(body.category)) throw new HttpError(400, 'Choose a category from the list.');
  const targetFunding = amountOf(body.targetFunding, { field: 'Funding goal', min: 1000, max: 50_000_000 });
  const tenureMonths = Number(body.tenureMonths);
  if (!Number.isInteger(tenureMonths) || tenureMonths < 1 || tenureMonths > 60) {
    throw new HttpError(400, 'Project length must be a whole number of months between 1 and 60.');
  }
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length > 30) throw new HttpError(400, 'A project can list up to 30 budget items.');
  const items = rawItems.map((it, i) => {
    const n = i + 1;
    const itemName = text(it.itemName, { field: `Item ${n} name`, min: 2, max: 120 });
    const quantity = Number(it.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
      throw new HttpError(400, `Item ${n} quantity must be a whole number between 1 and 100,000.`);
    }
    const unitPrice = amountOf(it.unitPrice, { field: `Item ${n} unit price`, min: 0, max: 50_000_000 });
    const supplier = text(it.supplier, { field: `Item ${n} supplier`, min: 2, max: 120, required: false });
    return { itemName, quantity, unitPrice, supplier };
  });
  const itemsTotal = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
  if (itemsTotal > targetFunding) {
    throw new HttpError(400, 'The budget items add up to more than the funding goal. Raise the goal or trim the list.');
  }
  return { title, summary, description, location, category: body.category, targetFunding, tenureMonths, items };
}

// -----------------------------------------------------------------------------
// Health
// -----------------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  const db = await testConnection();
  res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'database unavailable', uptimeSeconds: Math.floor(process.uptime()) });
});

app.get('/api/meta', (req, res) => {
  res.json({ categories: CATEGORIES, currency: process.env.CURRENCY || 'INR' });
});

// -----------------------------------------------------------------------------
// AI Inventory Suggestions Model
// -----------------------------------------------------------------------------
app.get('/api/inventory/categories', (req, res) => {
  const summary = CATEGORIES.map((cat) => {
    const items = INVENTORY_CATALOG[cat] || [];
    const avgCost = items.length ? Math.round(items.reduce((s, i) => s + i.unitPrice, 0) / items.length) : 0;
    return {
      category: cat,
      itemCount: items.length,
      averageUnitPrice: avgCost,
      topItem: items[0]?.itemName || null,
      topSupplier: items[0]?.supplier || null
    };
  });
  res.json({ categories: summary, tiers: SCALE_TIERS });
});

app.get('/api/inventory/suggestions', async (req, res) => {
  const category = req.query.category || 'Agriculture';
  const budget = Number(req.query.budget) || 100000;
  const tier = req.query.tier || 'community';
  const customPrompt = req.query.q || null;
  const sortBy = req.query.sortBy || 'profit';

  const result = await suggestInventories({ category, budget, tier, customPrompt, sortBy });
  res.json(result);
});

app.post('/api/inventory/suggest', async (req, res) => {
  const { category, budget, tier, customPrompt, sortBy } = req.body || {};
  const result = await suggestInventories({
    category: category || 'Agriculture',
    budget: Number(budget) || 100000,
    tier: tier || 'community',
    customPrompt,
    sortBy: sortBy || 'profit'
  });
  res.json(result);
});

// -----------------------------------------------------------------------------
// AI Project Suggestions Query Engine (Strictly Zero Emojis)
// -----------------------------------------------------------------------------
app.post('/api/suggestions/query', async (req, res) => {
  const { query: userQuery, budget, category } = req.body || {};
  const result = await getAiSuggestions({
    db: { query },
    userQuery: userQuery || '',
    targetBudget: budget,
    categoryFilter: category
  });
  res.json(result);
});

app.get('/api/suggestions/query', async (req, res) => {
  const userQuery = req.query.q || '';
  const budget = req.query.budget;
  const category = req.query.category;
  const result = await getAiSuggestions({
    db: { query },
    userQuery,
    targetBudget: budget,
    categoryFilter: category
  });
  res.json(result);
});

app.post('/api/inventory/receipt', requireAuth, async (req, res) => {
  const {
    itemName,
    quantity = 1,
    unitPrice = 0,
    category = 'General',
    supplier = 'Certified Vendor',
    specs = '',
    isRenewable = false,
    resourceType = 'General Infrastructure',
    profitPotential = 'High Potential',
    paybackMonths = 6,
    explainableGrowth = ''
  } = req.body || {};

  const qty = Math.max(1, Number(quantity) || 1);
  const price = Math.max(0, Number(unitPrice) || 0);
  const total = qty * price;
  const receiptId = `RCP-INV-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const timestamp = new Date().toISOString();

  const receiptPayload = `${receiptId}:${req.user.id}:${itemName}:${qty}:${total}:${timestamp}`;
  const verificationHash = crypto.createHash('sha256').update(receiptPayload).digest('hex');

  let aiImpactNote = explainableGrowth || `This official receipt certifies customer sponsorship for ${qty}x ${itemName} under the ${category} category, procured through ${supplier}.`;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Generate a 2-sentence formal non-profit community impact statement for a receipt where customer "${req.user.name}" sponsored ${qty} units of "${itemName}" (total ₹${total}) in category "${category}" from supplier "${supplier}". Highlight its profitability/growth and sustainability.` }] }],
          generationConfig: { maxOutputTokens: 150, temperature: 0.3 }
        })
      });
      if (gRes.ok) {
        const gData = await gRes.json();
        const generated = gData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (generated) aiImpactNote = generated;
      }
    } catch {} finally {
      clearTimeout(timer);
    }
  }

  res.json({
    receiptId,
    customerName: req.user.name,
    customerEmail: req.user.email,
    customerRole: req.user.role,
    itemName,
    category,
    quantity: qty,
    unitPrice: price,
    totalAmount: total,
    supplier,
    specs,
    isRenewable,
    resourceType,
    profitPotential,
    paybackMonths,
    explainableGrowth,
    timestamp,
    verificationHash,
    aiImpactNote
  });
});

// -----------------------------------------------------------------------------
// Auth
// -----------------------------------------------------------------------------
const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many accounts created from this network. Try again in an hour.' });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: 'Too many sign-in attempts from this network. Try again in 15 minutes.' });

app.post('/api/auth/signup', signupLimiter, async (req, res) => {
  const { errors, value } = validateSignup(req.body);
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0], errors);

  const existing = await query('SELECT 1 FROM users WHERE LOWER(email) = $1', [value.email]);
  if (existing.rows.length) {
    throw new HttpError(409, 'An account with this email already exists. Sign in instead.', { email: 'An account with this email already exists.' });
  }

  const id = newId('usr');
  const passwordHash = await hashPassword(value.password);
  try {
    await query(
      'INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
      [id, value.name, value.email, passwordHash, value.role]
    );
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists. Sign in instead.', { email: 'An account with this email already exists.' });
    throw err;
  }
  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [id]);
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  const token = await createSession(id, req.get('user-agent'));
  res.status(201).json({ token, user: publicUser(rows[0]) });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!email || !password) throw new HttpError(400, 'Enter your email and password.');

  const { rows } = await query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);
  const user = rows[0];

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
    throw new HttpError(423, `Too many wrong passwords. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`);
  }

  const ok = await verifyPassword(password, user ? user.password_hash : await getDummyHash());
  if (!user || !ok) {
    if (user) {
      const failed = user.failed_logins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await query(
        `UPDATE users SET failed_logins = $1, locked_until = ${lock ? `NOW() + interval '${LOCK_MINUTES} minutes'` : 'NULL'} WHERE id = $2`,
        [lock ? 0 : failed, user.id]
      );
      if (lock) throw new HttpError(423, `Too many wrong passwords. This account is locked for ${LOCK_MINUTES} minutes.`);
      const left = MAX_FAILED_LOGINS - failed;
      if (left <= 2) throw new HttpError(401, `Email or password is incorrect. ${left} attempt${left === 1 ? '' : 's'} left before the account is locked.`);
    }
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  if (!user.is_active) throw new HttpError(403, 'This account has been deactivated. Contact support.');

  // The sign-in page asks which portal you're using; the account's role must match.
  const PORTALS = { customer: ['INVESTOR', 'MANAGER'], support: ['SUPPORT'], admin: ['ADMIN'] };
  const portal = req.body.portal;
  if (portal && PORTALS[portal] && !PORTALS[portal].includes(user.role)) {
    const where = PORTALS.customer.includes(user.role) ? 'Customer' : user.role === 'SUPPORT' ? 'Support team' : 'Administrator';
    throw new HttpError(403, `This isn’t a ${portal === 'customer' ? 'customer' : portal === 'support' ? 'support team' : 'administrator'} account. Choose “${where}” and sign in again.`);
  }

  await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1', [user.id]);
  const token = await createSession(user.id, req.get('user-agent'));
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await destroySession(req.token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/auth/profile', requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const err = validateName(name);
  if (err) throw new HttpError(400, err, { name: err });
  const { rows } = await query('UPDATE users SET name = $1 WHERE id = $2 RETURNING *', [name, req.user.id]);
  res.json({ user: publicUser(rows[0]) });
});

app.post('/api/auth/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await verifyPassword(String(currentPassword || ''), req.user.password_hash))) {
    throw new HttpError(400, 'Your current password is incorrect.', { currentPassword: 'Incorrect password.' });
  }
  const err = validatePassword(newPassword, { name: req.user.name, email: req.user.email });
  if (err) throw new HttpError(400, err, { newPassword: err });
  if (currentPassword === newPassword) throw new HttpError(400, 'Choose a password you haven’t been using.', { newPassword: true });
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), req.user.id]);
  await destroyOtherSessions(req.user.id, req.token);
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// People (admin)
// -----------------------------------------------------------------------------
app.get('/api/users', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { rows } = await query('SELECT * FROM users ORDER BY created_at DESC');
  res.json(rows.map(publicUser));
});

app.post('/api/users', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const { errors, value } = validateSignup(req.body, { allowedRoles: ALL_ROLES });
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0], errors);
  const id = newId('usr');
  try {
    await query('INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
      [id, value.name, value.email, await hashPassword(value.password), value.role]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists.', { email: 'Already in use.' });
    throw err;
  }
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  res.status(201).json(publicUser(rows[0]));
});

app.patch('/api/users/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
  if (req.params.id === req.user.id) throw new HttpError(400, 'You can’t change your own role or deactivate yourself.');
  const sets = [];
  const params = [];
  if (typeof req.body.isActive === 'boolean') { params.push(req.body.isActive); sets.push(`is_active = $${params.length}`); }
  if (req.body.role !== undefined) {
    if (!ALL_ROLES.includes(req.body.role)) throw new HttpError(400, 'Unknown role.');
    params.push(req.body.role); sets.push(`role = $${params.length}`);
  }
  if (req.body.unlock === true) sets.push('failed_logins = 0', 'locked_until = NULL');
  if (req.body.temporaryPassword !== undefined) {
    const { rows: target } = await query('SELECT name, email FROM users WHERE id = $1', [req.params.id]);
    if (!target[0]) throw new HttpError(404, 'That account no longer exists.');
    const err = validatePassword(req.body.temporaryPassword, target[0]);
    if (err) throw new HttpError(400, err, { temporaryPassword: err });
    params.push(await hashPassword(req.body.temporaryPassword));
    sets.push(`password_hash = $${params.length}`, 'failed_logins = 0', 'locked_until = NULL');
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update.');
  params.push(req.params.id);
  const { rows } = await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) throw new HttpError(404, 'That account no longer exists.');
  if (req.body.isActive === false || req.body.temporaryPassword !== undefined) await query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
  res.json(publicUser(rows[0]));
});

// -----------------------------------------------------------------------------
// Wallet
// -----------------------------------------------------------------------------
app.get('/api/wallet', requireAuth, async (req, res) => {
  const { rows: txs } = await query(
    `SELECT t.*, p.title AS project_title, b.block_hash FROM transactions t
     LEFT JOIN projects p ON p.id = t.project_id
     JOIN ledger_blocks b ON b.block_index = t.block_index
     WHERE t.user_id = $1 ORDER BY t.created_at DESC`,
    [req.user.id]
  );
  const { rows: holdings } = await query(
    `SELECT p.id, p.title, p.status, p.target_funding, p.current_funding,
       SUM(CASE WHEN t.type = 'INVESTMENT' THEN t.amount ELSE -t.amount END) AS invested
     FROM transactions t JOIN projects p ON p.id = t.project_id
     WHERE t.user_id = $1 AND t.type IN ('INVESTMENT', 'REFUND')
     GROUP BY p.id HAVING SUM(CASE WHEN t.type = 'INVESTMENT' THEN t.amount ELSE -t.amount END) > 0
     ORDER BY invested DESC`,
    [req.user.id]
  );
  const { rows } = await query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
  res.json({
    balance: Number(rows[0].balance),
    transactions: txs.map((t) => ({
      id: t.id, type: t.type, amount: Number(t.amount), projectId: t.project_id, projectTitle: t.project_title,
      blockIndex: t.block_index, blockHash: t.block_hash, createdAt: t.created_at,
    })),
    holdings: holdings.map((h) => ({
      projectId: h.id, title: h.title, status: h.status, invested: Number(h.invested),
      targetFunding: Number(h.target_funding), currentFunding: Number(h.current_funding),
    })),
  });
});

app.post('/api/wallet/deposit', requireAuth, requireRole('INVESTOR'), async (req, res) => {
  const amount = amountOf(req.body.amount, { field: 'Deposit', min: 100, max: 1_000_000 });
  const result = await withTransaction(async (client) => {
    await assertLedgerHealthy(client);
    const txId = newId('txn');
    const block = await appendBlock(client, { event: 'WALLET_DEPOSIT', txId, type: 'DEPOSIT', userId: req.user.id, amount });
    await client.query('INSERT INTO transactions (id, type, user_id, amount, block_index) VALUES ($1, $2, $3, $4, $5)',
      [txId, 'DEPOSIT', req.user.id, amount, block.index]);
    const { rows } = await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance', [amount, req.user.id]);
    return { balance: Number(rows[0].balance), blockIndex: block.index };
  });
  res.status(201).json(result);
});

// -----------------------------------------------------------------------------
// Projects
// -----------------------------------------------------------------------------
app.get('/api/projects', requireAuth, async (req, res) => {
  const { scope, category, q, sort } = req.query;
  const where = [];
  const params = [];
  if (scope === 'mine') {
    params.push(req.user.id); where.push(`p.manager_id = $${params.length}`);
  } else if (scope === 'review') {
    if (!['ADMIN', 'SUPPORT'].includes(req.user.role)) throw new HttpError(403, 'Your account doesn’t have access to this.');
    where.push(`p.status = 'PENDING'`);
  } else {
    where.push(`p.status IN ('VERIFIED', 'FUNDED', 'CLOSED')`);
  }
  if (category && CATEGORIES.includes(category)) { params.push(category); where.push(`p.category = $${params.length}`); }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim().slice(0, 80)}%`);
    where.push(`(p.title ILIKE $${params.length} OR p.summary ILIKE $${params.length} OR p.location ILIKE $${params.length})`);
  }
  const order = {
    newest: 'p.created_at DESC',
    closest: `CASE WHEN p.status = 'VERIFIED' THEN 0 ELSE 1 END, p.current_funding / p.target_funding DESC`,
    raised: 'p.current_funding DESC',
    goal: 'p.target_funding ASC',
  }[sort] || (scope === 'review' ? 'p.created_at ASC' : `CASE WHEN p.status = 'VERIFIED' THEN 0 ELSE 1 END, p.created_at DESC`);

  const { rows } = await query(`${PROJECT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`, params);
  res.json(rows.map(shapeProject));
});

app.get('/api/projects/:id', requireAuth, async (req, res) => {
  const { rows } = await query(`${PROJECT_SELECT} WHERE p.id = $1`, [req.params.id]);
  const p = rows[0];
  if (!p || !canSeeProject(req.user, p)) throw new HttpError(404, 'This project doesn’t exist or isn’t public yet.');

  const [items, docs, recent, mine, reviewer] = await Promise.all([
    query('SELECT * FROM project_items WHERE project_id = $1 ORDER BY id', [p.id]),
    query(`SELECT d.*, u.name AS uploader FROM project_documents d JOIN users u ON u.id = d.uploaded_by WHERE project_id = $1 ORDER BY uploaded_at`, [p.id]),
    query(`SELECT t.type, t.amount, t.created_at, t.block_index, u.name FROM transactions t JOIN users u ON u.id = t.user_id
           WHERE t.project_id = $1 AND t.type IN ('INVESTMENT', 'REFUND') ORDER BY t.created_at DESC LIMIT 12`, [p.id]),
    query(`SELECT COALESCE(SUM(CASE WHEN type = 'INVESTMENT' THEN amount ELSE -amount END), 0) AS net
           FROM transactions WHERE project_id = $1 AND user_id = $2 AND type IN ('INVESTMENT', 'REFUND')`, [p.id, req.user.id]),
    p.reviewed_by ? query('SELECT name FROM users WHERE id = $1', [p.reviewed_by]) : Promise.resolve({ rows: [] }),
  ]);

  // Show backers by first name and last initial only.
  const shortName = (n) => { const [first, ...rest] = n.split(' '); return rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first; };

  res.json({
    ...shapeProject(p),
    reviewedBy: reviewer.rows[0]?.name || null,
    items: items.rows.map((i) => ({ id: i.id, itemName: i.item_name, quantity: i.quantity, unitPrice: Number(i.unit_price), supplier: i.supplier })),
    documents: docs.rows.map((d) => ({ id: d.id, name: d.original_name, mimeType: d.mime_type, size: Number(d.size_bytes), sha256: d.sha256, uploadedBy: d.uploader, uploadedAt: d.uploaded_at })),
    activity: recent.rows.map((r) => ({ type: r.type, amount: Number(r.amount), createdAt: r.created_at, blockIndex: r.block_index, who: shortName(r.name) })),
    myContribution: Number(mine.rows[0].net),
  });
});

app.post('/api/projects', requireAuth, requireRole('MANAGER'), async (req, res) => {
  const input = parseProjectInput(req.body);
  const { rows: pendingCount } = await query(`SELECT COUNT(*) FROM projects WHERE manager_id = $1 AND status = 'PENDING'`, [req.user.id]);
  if (pendingCount[0].count >= 5) throw new HttpError(400, 'You already have 5 projects waiting for review. Wait for a decision before submitting more.');

  const id = newId('prj');
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO projects (id, title, category, summary, description, location, manager_id, target_funding, tenure_months)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, input.title, input.category, input.summary, input.description, input.location, req.user.id, input.targetFunding, input.tenureMonths]
    );
    for (const it of input.items) {
      await client.query('INSERT INTO project_items (project_id, item_name, quantity, unit_price, supplier) VALUES ($1, $2, $3, $4, $5)',
        [id, it.itemName, it.quantity, it.unitPrice, it.supplier]);
    }
    await appendBlock(client, {
      event: 'PROJECT_SUBMITTED', projectId: id, userId: req.user.id, title: input.title,
      targetFunding: input.targetFunding, items: input.items.length,
    });
  });
  res.status(201).json({ id });
});

app.patch('/api/projects/:id', requireAuth, requireRole('MANAGER'), async (req, res) => {
  const { rows } = await query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  const p = rows[0];
  if (!p || p.manager_id !== req.user.id) throw new HttpError(404, 'Project not found.');
  if (!['PENDING', 'REJECTED'].includes(p.status)) throw new HttpError(400, 'Approved projects can’t be edited. Contact support if something needs correcting.');
  const input = parseProjectInput(req.body);
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE projects SET title = $1, category = $2, summary = $3, description = $4, location = $5, target_funding = $6,
       tenure_months = $7, status = 'PENDING', review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = NOW() WHERE id = $8`,
      [input.title, input.category, input.summary, input.description, input.location, input.targetFunding, input.tenureMonths, p.id]
    );
    await client.query('DELETE FROM project_items WHERE project_id = $1', [p.id]);
    for (const it of input.items) {
      await client.query('INSERT INTO project_items (project_id, item_name, quantity, unit_price, supplier) VALUES ($1, $2, $3, $4, $5)',
        [p.id, it.itemName, it.quantity, it.unitPrice, it.supplier]);
    }
    await appendBlock(client, { event: p.status === 'REJECTED' ? 'PROJECT_RESUBMITTED' : 'PROJECT_EDITED', projectId: p.id, userId: req.user.id, title: input.title, targetFunding: input.targetFunding });
  });
  res.json({ id: p.id, status: 'PENDING' });
});

// Documents ------------------------------------------------------------------
const docDir = path.join(__dirname, '..', 'uploads', 'documents');
fs.mkdirSync(docDir, { recursive: true });

const ALLOWED_DOC_TYPES = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: docDir,
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}${ALLOWED_DOC_TYPES[file.mimetype] || ''}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_DOC_TYPES[file.mimetype]) cb(null, true);
    else cb(new HttpError(400, 'Upload a PDF, PNG, JPG, Word, Excel or plain-text file.'));
  },
});

app.post('/api/projects/:id/documents', requireAuth, requireRole('MANAGER', 'ADMIN'), upload.single('file'), async (req, res) => {
  const cleanup = () => req.file && fs.promises.unlink(req.file.path).catch(() => {});
  try {
    if (!req.file) throw new HttpError(400, 'Choose a file to upload.');
    const { rows } = await query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    const p = rows[0];
    if (!p || (req.user.role === 'MANAGER' && p.manager_id !== req.user.id)) throw new HttpError(404, 'Project not found.');
    if (p.status === 'CLOSED') throw new HttpError(400, 'This project is closed. Documents can no longer be added.');
    const { rows: count } = await query('SELECT COUNT(*) FROM project_documents WHERE project_id = $1', [p.id]);
    if (count[0].count >= 15) throw new HttpError(400, 'A project can have up to 15 documents.');

    const sha256 = crypto.createHash('sha256').update(await fs.promises.readFile(req.file.path)).digest('hex');
    const originalName = path.basename(req.file.originalname).slice(0, 255);
    const doc = await withTransaction(async (client) => {
      const { rows: inserted } = await client.query(
        `INSERT INTO project_documents (project_id, original_name, stored_name, mime_type, size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [p.id, originalName, req.file.filename, req.file.mimetype, req.file.size, sha256, req.user.id]
      );
      await appendBlock(client, { event: 'DOCUMENT_ADDED', projectId: p.id, userId: req.user.id, documentId: inserted[0].id, name: originalName, sha256 });
      return inserted[0];
    });
    res.status(201).json({ id: doc.id, sha256 });
  } catch (err) {
    cleanup();
    throw err;
  }
});

app.get('/api/projects/:id/documents/:docId', requireAuth, async (req, res) => {
  const { rows } = await query(
    'SELECT d.*, p.status, p.manager_id FROM project_documents d JOIN projects p ON p.id = d.project_id WHERE d.id = $1 AND d.project_id = $2',
    [req.params.docId, req.params.id]
  );
  const d = rows[0];
  if (!d || !canSeeProject(req.user, d)) throw new HttpError(404, 'Document not found.');
  const filePath = path.join(docDir, path.basename(d.stored_name));
  if (!fs.existsSync(filePath)) throw new HttpError(410, 'The file for this document is missing from storage.');
  res.setHeader('Content-Type', d.mime_type);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.original_name)}`);
  res.sendFile(filePath);
});

app.delete('/api/projects/:id/documents/:docId', requireAuth, requireRole('MANAGER'), async (req, res) => {
  const { rows } = await query(
    'SELECT d.*, p.status, p.manager_id FROM project_documents d JOIN projects p ON p.id = d.project_id WHERE d.id = $1 AND d.project_id = $2',
    [req.params.docId, req.params.id]
  );
  const d = rows[0];
  if (!d || d.manager_id !== req.user.id) throw new HttpError(404, 'Document not found.');
  if (!['PENDING', 'REJECTED'].includes(d.status)) throw new HttpError(400, 'Documents on an approved project are part of its record and can’t be removed.');
  await withTransaction(async (client) => {
    await client.query('DELETE FROM project_documents WHERE id = $1', [d.id]);
    await appendBlock(client, { event: 'DOCUMENT_REMOVED', projectId: d.project_id, userId: req.user.id, documentId: d.id, name: d.original_name, sha256: d.sha256 });
  });
  await fs.promises.unlink(path.join(docDir, path.basename(d.stored_name))).catch(() => {});
  res.json({ ok: true });
});

// Review ---------------------------------------------------------------------
app.post('/api/projects/:id/review', requireAuth, requireRole('ADMIN'), async (req, res) => {
  const decision = req.body.decision;
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'Choose approve or reject.');
  const note = decision === 'reject'
    ? text(req.body.note, { field: 'Reason', min: 10, max: 1000 })
    : text(req.body.note, { field: 'Note', min: 2, max: 1000, required: false });

  const status = await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [req.params.id]);
    const p = rows[0];
    if (!p) throw new HttpError(404, 'Project not found.');
    if (p.status !== 'PENDING') throw new HttpError(409, 'This project has already been reviewed.');
    if (p.manager_id === req.user.id) throw new HttpError(403, 'You can’t review your own project.');
    const next = decision === 'approve' ? 'VERIFIED' : 'REJECTED';
    await client.query(
      'UPDATE projects SET status = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW() WHERE id = $4',
      [next, note, req.user.id, p.id]
    );
    await appendBlock(client, { event: decision === 'approve' ? 'PROJECT_APPROVED' : 'PROJECT_REJECTED', projectId: p.id, userId: req.user.id, note });
    return next;
  });
  res.json({ status });
});

// Money ----------------------------------------------------------------------
app.post('/api/projects/:id/invest', requireAuth, requireRole('INVESTOR'), async (req, res) => {
  const amount = amountOf(req.body.amount, { field: 'Contribution', min: 100 });
  const result = await withTransaction(async (client) => {
    await assertLedgerHealthy(client);
    const { rows: pr } = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [req.params.id]);
    const p = pr[0];
    if (!p || !canSeeProject(req.user, p)) throw new HttpError(404, 'Project not found.');
    if (p.status !== 'VERIFIED') throw new HttpError(409, 'This project isn’t accepting contributions right now.');
    const remaining = Math.round((Number(p.target_funding) - Number(p.current_funding)) * 100) / 100;
    if (amount > remaining) throw new HttpError(400, `Only ${remaining.toLocaleString('en-IN')} is left to reach the goal. Contribute that amount or less.`);
    const { rows: ur } = await client.query('SELECT balance FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (Number(ur[0].balance) < amount) throw new HttpError(400, 'Your wallet doesn’t have enough money. Add funds first.');

    const txId = newId('txn');
    const block = await appendBlock(client, { event: 'CONTRIBUTION', txId, type: 'INVESTMENT', userId: req.user.id, projectId: p.id, amount });
    await client.query('INSERT INTO transactions (id, type, user_id, project_id, amount, block_index) VALUES ($1, $2, $3, $4, $5, $6)',
      [txId, 'INVESTMENT', req.user.id, p.id, amount, block.index]);
    await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, req.user.id]);
    const reached = amount === remaining;
    await client.query(`UPDATE projects SET current_funding = current_funding + $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [amount, reached ? 'FUNDED' : 'VERIFIED', p.id]);
    if (reached) await appendBlock(client, { event: 'GOAL_REACHED', projectId: p.id, targetFunding: Number(p.target_funding) });
    return { blockIndex: block.index, goalReached: reached };
  });
  res.status(201).json(result);
});

app.post('/api/projects/:id/refund', requireAuth, requireRole('INVESTOR'), async (req, res) => {
  const amount = amountOf(req.body.amount, { field: 'Withdrawal', min: 1 });
  const result = await withTransaction(async (client) => {
    await assertLedgerHealthy(client);
    const { rows: pr } = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [req.params.id]);
    const p = pr[0];
    if (!p) throw new HttpError(404, 'Project not found.');
    if (p.status !== 'VERIFIED') throw new HttpError(409, 'Contributions can only be withdrawn while a project is still raising money.');
    const { rows: mine } = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN type = 'INVESTMENT' THEN amount ELSE -amount END), 0) AS net
       FROM transactions WHERE project_id = $1 AND user_id = $2 AND type IN ('INVESTMENT', 'REFUND')`, [p.id, req.user.id]);
    const net = Number(mine[0].net);
    if (net <= 0) throw new HttpError(400, 'You haven’t contributed to this project.');
    if (amount > net) throw new HttpError(400, `You can withdraw up to ${net.toLocaleString('en-IN')}, the amount you’ve contributed.`);

    const txId = newId('txn');
    const block = await appendBlock(client, { event: 'CONTRIBUTION_WITHDRAWN', txId, type: 'REFUND', userId: req.user.id, projectId: p.id, amount });
    await client.query('INSERT INTO transactions (id, type, user_id, project_id, amount, block_index) VALUES ($1, $2, $3, $4, $5, $6)',
      [txId, 'REFUND', req.user.id, p.id, amount, block.index]);
    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, req.user.id]);
    await client.query('UPDATE projects SET current_funding = current_funding - $1, updated_at = NOW() WHERE id = $2', [amount, p.id]);
    return { blockIndex: block.index };
  });
  res.status(201).json(result);
});

app.post('/api/projects/:id/payout', requireAuth, requireRole('MANAGER'), async (req, res) => {
  const result = await withTransaction(async (client) => {
    await assertLedgerHealthy(client);
    const { rows: pr } = await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [req.params.id]);
    const p = pr[0];
    if (!p || p.manager_id !== req.user.id) throw new HttpError(404, 'Project not found.');
    if (p.status !== 'FUNDED') throw new HttpError(409, 'Funds can be released once the project reaches its goal.');
    const amount = Number(p.current_funding);
    const txId = newId('txn');
    const block = await appendBlock(client, { event: 'FUNDS_RELEASED', txId, type: 'PAYOUT', userId: req.user.id, projectId: p.id, amount });
    await client.query('INSERT INTO transactions (id, type, user_id, project_id, amount, block_index) VALUES ($1, $2, $3, $4, $5, $6)',
      [txId, 'PAYOUT', req.user.id, p.id, amount, block.index]);
    await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, req.user.id]);
    await client.query(`UPDATE projects SET status = 'CLOSED', updated_at = NOW() WHERE id = $1`, [p.id]);
    return { amount, blockIndex: block.index };
  });
  res.status(201).json(result);
});

// -----------------------------------------------------------------------------
// Ledger
// -----------------------------------------------------------------------------
app.get('/api/ledger', requireAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const before = parseInt(req.query.before, 10);
  const params = [limit];
  let where = '';
  if (Number.isInteger(before)) { params.push(before); where = 'WHERE block_index < $2'; }
  const { rows } = await query(`SELECT * FROM ledger_blocks ${where} ORDER BY block_index DESC LIMIT $1`, params);

  // Resolve names for user and project IDs in this page.
  const userIds = [...new Set(rows.map((b) => b.payload.userId).filter(Boolean))];
  const projectIds = [...new Set(rows.map((b) => b.payload.projectId).filter(Boolean))];
  const [u, p] = await Promise.all([
    userIds.length ? query('SELECT id, name FROM users WHERE id = ANY($1)', [userIds]) : { rows: [] },
    projectIds.length ? query('SELECT id, title FROM projects WHERE id = ANY($1)', [projectIds]) : { rows: [] },
  ]);
  const names = Object.fromEntries(u.rows.map((r) => [r.id, r.name]));
  const titles = Object.fromEntries(p.rows.map((r) => [r.id, r.title]));
  const { rows: total } = await query('SELECT COUNT(*) FROM ledger_blocks');

  res.json({
    total: total[0].count,
    blocks: rows.map((b) => ({
      index: b.block_index, timestamp: b.timestamp_iso, previousHash: b.previous_hash, hash: b.block_hash, payload: b.payload,
      userName: names[b.payload.userId] || null, projectTitle: titles[b.payload.projectId] || null,
    })),
  });
});

app.get('/api/ledger/verify', requireAuth, async (req, res) => {
  res.json(await verifyLedger(pool));
});

// -----------------------------------------------------------------------------
// Insights — every number here is computed from the database.
// -----------------------------------------------------------------------------
app.get('/api/insights', requireAuth, async (req, res) => {
  const [totals, byStatus, byCategory, daily, live] = await Promise.all([
    query(`SELECT
        COALESCE(SUM(CASE WHEN type = 'INVESTMENT' THEN amount WHEN type = 'REFUND' THEN -amount END), 0) AS raised,
        COUNT(DISTINCT CASE WHEN type = 'INVESTMENT' THEN user_id END) AS backers,
        COUNT(*) FILTER (WHERE type = 'INVESTMENT') AS contributions,
        COALESCE(AVG(amount) FILTER (WHERE type = 'INVESTMENT'), 0) AS avg_contribution
      FROM transactions`),
    query('SELECT status, COUNT(*) FROM projects GROUP BY status'),
    query(`SELECT category, COUNT(*) AS projects, SUM(current_funding) AS raised, SUM(target_funding) AS goal
           FROM projects WHERE status IN ('VERIFIED', 'FUNDED', 'CLOSED') GROUP BY category ORDER BY raised DESC`),
    query(`SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
             COALESCE(SUM(CASE WHEN t.type = 'INVESTMENT' THEN t.amount WHEN t.type = 'REFUND' THEN -t.amount END), 0) AS net
           FROM generate_series(CURRENT_DATE - 29, CURRENT_DATE, interval '1 day') d
           LEFT JOIN transactions t ON t.created_at::date = d::date AND t.type IN ('INVESTMENT', 'REFUND')
           GROUP BY d ORDER BY d`),
    query(`SELECT p.id, p.title, p.target_funding, p.current_funding, p.reviewed_at,
             COALESCE((SELECT SUM(CASE WHEN t.type = 'INVESTMENT' THEN t.amount ELSE -t.amount END)
                       FROM transactions t WHERE t.project_id = p.id AND t.type IN ('INVESTMENT', 'REFUND')
                       AND t.created_at > NOW() - interval '14 days'), 0) AS last14
           FROM projects p WHERE p.status = 'VERIFIED' ORDER BY p.current_funding / p.target_funding DESC`),
  ]);

  const counts = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.count]));
  const decided = (counts.VERIFIED || 0) + (counts.FUNDED || 0) + (counts.CLOSED || 0) + (counts.REJECTED || 0);
  const t = totals.rows[0];

  res.json({
    raised: Number(t.raised),
    backers: t.backers,
    contributions: t.contributions,
    averageContribution: Math.round(Number(t.avg_contribution)),
    projectsByStatus: counts,
    approvalRate: decided ? (decided - (counts.REJECTED || 0)) / decided : null,
    byCategory: byCategory.rows.map((r) => ({ category: r.category, projects: r.projects, raised: Number(r.raised), goal: Number(r.goal) })),
    daily: daily.rows.map((r) => ({ day: r.day, net: Number(r.net) })),
    // Pace = net raised over the last 14 days; projection assumes that pace continues.
    pace: live.rows.map((r) => {
      const remaining = Number(r.target_funding) - Number(r.current_funding);
      const perDay = Number(r.last14) / 14;
      return {
        projectId: r.id, title: r.title, targetFunding: Number(r.target_funding), currentFunding: Number(r.current_funding),
        perDay: Math.round(perDay), daysToGoal: perDay > 0 ? Math.ceil(remaining / perDay) : null,
      };
    }),
  });
});

// -----------------------------------------------------------------------------
// Errors & static frontend
// -----------------------------------------------------------------------------
app.use(chat);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Files must be 10 MB or smaller.' : 'That upload couldn’t be processed.';
    return res.status(400).json({ error: message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body isn’t valid JSON.' });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, fields: err.fields });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again in a moment.' });
});

// -----------------------------------------------------------------------------
// Startup
// -----------------------------------------------------------------------------
async function bootstrapAccount(role, prefix, defaultName) {
  const { rows } = await query('SELECT COUNT(*) FROM users WHERE role = $1', [role]);
  if (rows[0].count > 0) return;
  const email = normalizeEmail(process.env[`${prefix}_EMAIL`]);
  const password = process.env[`${prefix}_PASSWORD`];
  const name = process.env[`${prefix}_NAME`] || defaultName;
  if (!email || !password) {
    console.warn(`No ${role.toLowerCase()} account exists yet. Set ${prefix}_EMAIL and ${prefix}_PASSWORD in .env${role === 'ADMIN' ? ', or run `npm run create-admin`' : ', or create one from People as an administrator'}.`);
    return;
  }
  const { errors } = validateSignup({ name, email, password, role }, { allowedRoles: [role] });
  if (Object.keys(errors).length) {
    console.warn(`${role} account not created: ${Object.values(errors).join(' ')}`);
    return;
  }
  await query('INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
    [newId('usr'), name, email, await hashPassword(password), role]);
  console.log(`Created ${role.toLowerCase()} account for ${email}.`);
}

async function start() {
  await applySchema();
  await withTransaction(ensureGenesis);
  await bootstrapAccount('ADMIN', 'ADMIN', 'Platform Admin');
  await bootstrapAccount('SUPPORT', 'SUPPORT', 'Support Team');
  await query('DELETE FROM sessions WHERE expires_at < NOW()');
  app.listen(PORT, () => console.log(`CrowdFund API listening on port ${PORT}`));
}

start().catch((err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});
