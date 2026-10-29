// End-to-end API check. Run against a server with a THROWAWAY database:
//   API_URL=http://localhost:5001 ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run test:api
// It creates accounts and projects, so never point it at real data.
import assert from 'assert/strict';
import { pool } from './db.js';

const BASE = process.env.API_URL || 'http://localhost:5001';
const stamp = Date.now().toString(36);
let passed = 0;

async function call(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: form || (body && JSON.stringify(body)) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function step(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const strong = 'Tidal#River42';

await step('rejects weak password, bad email, admin self-signup', async () => {
  let r = await call('POST', '/api/auth/signup', { body: { name: 'Asha Rao', email: `asha${stamp}@example.com`, password: 'password', role: 'INVESTOR' } });
  assert.equal(r.status, 400); assert.ok(r.data.fields.password);
  r = await call('POST', '/api/auth/signup', { body: { name: 'Asha Rao', email: 'not-an-email', password: strong, role: 'INVESTOR' } });
  assert.equal(r.status, 400); assert.ok(r.data.fields.email);
  r = await call('POST', '/api/auth/signup', { body: { name: 'Asha Rao', email: `x${stamp}@example.com`, password: strong, role: 'ADMIN' } });
  assert.equal(r.status, 400); assert.ok(r.data.fields.role);
  r = await call('POST', '/api/auth/signup', { body: { name: 'Asha Rao', email: `asha${stamp}@example.com`, password: 'Asha#Secure99', role: 'INVESTOR' } });
  assert.equal(r.status, 400, 'password containing name should fail');
});

let investor, manager, admin, support;
await step('signs up an investor and a campaign manager', async () => {
  let r = await call('POST', '/api/auth/signup', { body: { name: 'Asha Rao', email: `Asha${stamp}@Example.com`, password: strong, confirmPassword: strong, role: 'INVESTOR', acceptTerms: true } });
  assert.equal(r.status, 201); investor = r.data;
  assert.equal(investor.user.email, `asha${stamp}@example.com`, 'email is lower-cased');
  assert.equal(investor.user.balance, 0, 'new wallets start empty');
  r = await call('POST', '/api/auth/signup', { body: { name: 'Vikram Nair', email: `vikram${stamp}@example.com`, password: strong, role: 'MANAGER' } });
  assert.equal(r.status, 201); manager = r.data;
});

await step('blocks duplicate email (any case)', async () => {
  const r = await call('POST', '/api/auth/signup', { body: { name: 'Someone Else', email: `ASHA${stamp}@example.com`, password: strong, role: 'INVESTOR' } });
  assert.equal(r.status, 409);
});

await step('admin signs in; wrong passwords lock the account', async () => {
  const r = await call('POST', '/api/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } });
  assert.equal(r.status, 200); admin = r.data;
  const email = `vikram${stamp}@example.com`;
  let last;
  for (let i = 0; i < 5; i++) last = await call('POST', '/api/auth/login', { body: { email, password: 'Wrong#Pass1' } });
  assert.equal(last.status, 423);
  const blocked = await call('POST', '/api/auth/login', { body: { email, password: strong } });
  assert.equal(blocked.status, 423, 'correct password still blocked while locked');
  const unlock = await call('PATCH', `/api/users/${manager.user.id}`, { token: admin.token, body: { unlock: true } });
  assert.equal(unlock.status, 200);
  const again = await call('POST', '/api/auth/login', { body: { email, password: strong } });
  assert.equal(again.status, 200);
});

await step('admin creates a support account; roles are enforced', async () => {
  const r = await call('POST', '/api/users', { token: admin.token, body: { name: 'Meera Iyer', email: `meera${stamp}@example.com`, password: strong, role: 'SUPPORT' } });
  assert.equal(r.status, 201);
  support = (await call('POST', '/api/auth/login', { body: { email: `meera${stamp}@example.com`, password: strong } })).data;
  assert.equal((await call('GET', '/api/users', { token: investor.token })).status, 403);
  assert.equal((await call('POST', '/api/wallet/deposit', { token: manager.token, body: { amount: 500 } })).status, 403);
  assert.equal((await call('GET', '/api/wallet')).status, 401);
});

let projectId;
await step('manager submits a project; validation applies', async () => {
  const bad = await call('POST', '/api/projects', { token: manager.token, body: { title: 'x' } });
  assert.equal(bad.status, 400);
  const over = await call('POST', '/api/projects', { token: manager.token, body: {
    title: 'Solar pumps for Kolar farms', category: 'Agriculture', summary: 'Replace diesel pumps with solar pumps on twelve small farms.',
    description: 'A'.repeat(100), targetFunding: 10000, tenureMonths: 6, items: [{ itemName: 'Solar pump', quantity: 12, unitPrice: 5000 }] } });
  assert.equal(over.status, 400, 'items cannot exceed goal');
  const r = await call('POST', '/api/projects', { token: manager.token, body: {
    title: 'Solar pumps for Kolar farms', category: 'Agriculture', summary: 'Replace diesel pumps with solar pumps on twelve small farms.',
    description: 'Twelve farms near Kolar run diesel pumps for irrigation. This project buys and installs solar pumps, cutting fuel costs for every family involved.',
    location: 'Kolar, Karnataka', targetFunding: 60000, tenureMonths: 6, items: [{ itemName: 'Solar pump kit', quantity: 12, unitPrice: 4500, supplier: 'Sunfield' }] } });
  assert.equal(r.status, 201); projectId = r.data.id;
  const pub = await call('GET', '/api/projects', { token: investor.token });
  assert.ok(!pub.data.some((p) => p.id === projectId), 'pending projects are hidden from investors');
  assert.equal((await call('GET', `/api/projects/${projectId}`, { token: investor.token })).status, 404);
});

await step('manager uploads a document; type is checked', async () => {
  const form = new FormData();
  form.append('file', new Blob(['Quotation from Sunfield for 12 pump kits.'], { type: 'text/plain' }), 'quote.txt');
  const r = await call('POST', `/api/projects/${projectId}/documents`, { token: manager.token, form });
  assert.equal(r.status, 201); assert.equal(r.data.sha256.length, 64);
  const badForm = new FormData();
  badForm.append('file', new Blob(['<html>'], { type: 'text/html' }), 'x.html');
  assert.equal((await call('POST', `/api/projects/${projectId}/documents`, { token: manager.token, form: badForm })).status, 400);
});

await step('reject needs a reason; admin approves', async () => {
  assert.equal((await call('POST', `/api/projects/${projectId}/review`, { token: admin.token, body: { decision: 'reject', note: 'no' } })).status, 400);
  assert.equal((await call('POST', `/api/projects/${projectId}/review`, { token: support.token, body: { decision: 'approve' } })).status, 403);
  const r = await call('POST', `/api/projects/${projectId}/review`, { token: admin.token, body: { decision: 'approve', note: 'Quotation checked.' } });
  assert.equal(r.data.status, 'VERIFIED');
});

await step('wallet deposit, contribution limits, withdrawal', async () => {
  assert.equal((await call('POST', `/api/projects/${projectId}/invest`, { token: investor.token, body: { amount: 1000 } })).status, 400, 'empty wallet');
  let r = await call('POST', '/api/wallet/deposit', { token: investor.token, body: { amount: 75000 } });
  assert.equal(r.status, 201); assert.equal(r.data.balance, 75000);
  assert.equal((await call('POST', '/api/wallet/deposit', { token: investor.token, body: { amount: 10.555 } })).status, 400);
  assert.equal((await call('POST', `/api/projects/${projectId}/invest`, { token: investor.token, body: { amount: 70000 } })).status, 400, 'over remaining goal');
  r = await call('POST', `/api/projects/${projectId}/invest`, { token: investor.token, body: { amount: 20000 } });
  assert.equal(r.status, 201);
  assert.equal((await call('POST', `/api/projects/${projectId}/refund`, { token: investor.token, body: { amount: 25000 } })).status, 400, 'cannot withdraw more than contributed');
  r = await call('POST', `/api/projects/${projectId}/refund`, { token: investor.token, body: { amount: 5000 } });
  assert.equal(r.status, 201);
  const w = await call('GET', '/api/wallet', { token: investor.token });
  assert.equal(w.data.balance, 60000);
  assert.equal(w.data.holdings[0].invested, 15000);
});

await step('reaching the goal marks it funded; manager releases funds', async () => {
  const r = await call('POST', `/api/projects/${projectId}/invest`, { token: investor.token, body: { amount: 45000 } });
  assert.equal(r.data.goalReached, true);
  const p = await call('GET', `/api/projects/${projectId}`, { token: investor.token });
  assert.equal(p.data.status, 'FUNDED'); assert.equal(p.data.currentFunding, 60000);
  const pay = await call('POST', `/api/projects/${projectId}/payout`, { token: manager.token });
  assert.equal(pay.status, 201); assert.equal(pay.data.amount, 60000);
  const me = await call('GET', '/api/auth/me', { token: manager.token });
  assert.equal(me.data.user.balance, 60000);
});

await step('portal check: customer can’t use the support sign-in', async () => {
  const r = await call('POST', '/api/auth/login', { body: { email: `asha${stamp}@example.com`, password: strong, portal: 'support' } });
  assert.equal(r.status, 403);
  const ok = await call('POST', '/api/auth/login', { body: { email: `meera${stamp}@example.com`, password: strong, portal: 'support' } });
  assert.equal(ok.status, 200);
});

let convId;
await step('assistant answers from live data and asks if resolved', async () => {
  assert.equal((await call('POST', '/api/conversations', { token: support.token, body: { message: 'hello' } })).status, 403, 'staff do not start chats');
  const r = await call('POST', '/api/conversations', { token: investor.token, body: { message: 'What is my wallet balance?' } });
  assert.equal(r.status, 201);
  convId = r.data.id;
  const bot = r.data.messages.at(-1);
  assert.equal(bot.sender, 'BOT');
  assert.match(bot.body, /15,000|₹/, 'mentions the real balance');
  assert.equal(r.data.awaitingFeedbackOn, bot.id);
  assert.equal((await call('GET', `/api/conversations/${convId}`, { token: manager.token })).status, 404, 'other customers cannot read it');
});

await step('“resolved” closes it; a new message reopens it with the assistant', async () => {
  let r = await call('POST', `/api/conversations/${convId}/feedback`, { token: investor.token, body: { resolved: true } });
  assert.equal(r.data.status, 'RESOLVED');
  assert.equal((await call('POST', `/api/conversations/${convId}/feedback`, { token: investor.token, body: { resolved: true } })).status, 409, 'no double answers');
  r = await call('POST', `/api/conversations/${convId}/messages`, { token: investor.token, body: { body: 'How do I withdraw my contribution?' } });
  assert.equal(r.data.status, 'BOT');
  assert.equal(r.data.messages.at(-1).sender, 'BOT');
});

await step('“not resolved” escalates to support with the full history', async () => {
  assert.equal((await call('POST', `/api/conversations/${convId}/messages`, { token: support.token, body: { body: 'Hi' } })).status, 409, 'support waits for escalation');
  let r = await call('POST', `/api/conversations/${convId}/feedback`, { token: investor.token, body: { resolved: false } });
  assert.equal(r.data.status, 'ESCALATED');
  const queue = await call('GET', '/api/conversations?scope=queue', { token: support.token });
  assert.ok(queue.data.conversations.some((c) => c.id === convId));
  const full = await call('GET', `/api/conversations/${convId}`, { token: support.token });
  assert.ok(full.data.messages.length >= 5, 'support sees the whole conversation');
  r = await call('POST', `/api/conversations/${convId}/messages`, { token: support.token, body: { body: 'Open the project and press Withdraw while it is still raising.' } });
  assert.equal(r.data.status, 'WITH_SUPPORT');
  assert.ok(r.data.awaitingFeedbackOn, 'support replies also ask if resolved');
  r = await call('POST', `/api/conversations/${convId}/feedback`, { token: investor.token, body: { resolved: false } });
  assert.equal(r.data.status, 'ESCALATED', 'back in the queue');
  r = await call('POST', `/api/conversations/${convId}/messages`, { token: support.token, body: { body: 'I have checked your account and refunded the amount.' } });
  r = await call('POST', `/api/conversations/${convId}/feedback`, { token: investor.token, body: { resolved: true } });
  assert.equal(r.data.status, 'CLOSED');
  const adminView = await call('GET', `/api/conversations/${convId}`, { token: admin.token });
  assert.equal(adminView.status, 200, 'admin can read the history');
  const mine = await call('GET', '/api/conversations', { token: investor.token });
  assert.equal(mine.data.conversations.length, 1, 'customer history is kept');
});

await step('suggestions rank live projects from the backer’s input', async () => {
  const r1 = await call('POST', '/api/projects', { token: manager.token, body: {
    title: 'LED grow lights for Vellore school garden', category: 'Education', summary: 'Grow lights and planters so students can grow vegetables year round.',
    description: 'The school garden only works in winter. Grow lights and raised planters let forty students grow and sell vegetables all year, funding their science club.',
    targetFunding: 40000, tenureMonths: 4, items: [{ itemName: 'LED grow light', quantity: 20, unitPrice: 1200 }, { itemName: 'Raised planter', quantity: 10, unitPrice: 900 }] } });
  await call('POST', `/api/projects/${r1.data.id}/review`, { token: admin.token, body: { decision: 'approve' } });
  assert.equal((await call('POST', '/api/recommendations', { token: investor.token, body: { budget: 50, risk: 'steady', horizonMonths: 6 } })).status, 400);
  assert.equal((await call('GET', '/api/recommendations', { token: manager.token })).status, 403);
  const r = await call('POST', '/api/recommendations', { token: investor.token, body: { budget: 5000, risk: 'balanced', horizonMonths: 6, categories: ['Education'] } });
  assert.equal(r.status, 200);
  const pick = r.data.picks.find((p) => p.projectId === r1.data.id);
  assert.ok(pick, 'live project is suggested');
  assert.equal(pick.suggestedAmount, 5000);
  assert.ok(pick.couldBuy.some((c) => c.name === 'LED grow light' && c.units === 4), 'shows what the share buys');
  assert.ok(pick.reasons.some((x) => /Education/.test(x)));
  const saved = await call('GET', '/api/recommendations', { token: investor.token });
  assert.equal(saved.data.preferences.budget, 5000, 'preferences are remembered');
  const chatSuggest = await call('POST', '/api/conversations', { token: investor.token, body: { message: 'Which project should I invest in?' } });
  assert.match(chatSuggest.data.messages.at(-1).body, /LED grow lights/, 'assistant uses the same suggestions');
});

await step('admin can set a temporary password', async () => {
  assert.equal((await call('PATCH', `/api/users/${manager.user.id}`, { token: admin.token, body: { temporaryPassword: 'weak' } })).status, 400);
  assert.equal((await call('PATCH', `/api/users/${manager.user.id}`, { token: admin.token, body: { temporaryPassword: 'Granite#Path31' } })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token: manager.token })).status, 401, 'old sessions end');
  const r = await call('POST', '/api/auth/login', { body: { email: `vikram${stamp}@example.com`, password: 'Granite#Path31' } });
  assert.equal(r.status, 200);
});

await step('ledger verifies, then detects tampering and pauses payments', async () => {
  let v = await call('GET', '/api/ledger/verify', { token: investor.token });
  assert.equal(v.data.valid, true, JSON.stringify(v.data.problems));
  await pool.query(`UPDATE users SET balance = balance + 99999 WHERE id = $1`, [investor.user.id]);
  v = await call('GET', '/api/ledger/verify', { token: investor.token });
  assert.equal(v.data.valid, false);
  assert.ok(v.data.problems.some((p) => p.kind === 'balance'));
  assert.equal((await call('POST', '/api/wallet/deposit', { token: investor.token, body: { amount: 100 } })).status, 423);
  await pool.query(`UPDATE users SET balance = balance - 99999 WHERE id = $1`, [investor.user.id]);
  const { rows } = await pool.query('SELECT block_index, payload FROM ledger_blocks WHERE block_index = 1');
  const original = rows[0].payload;
  await pool.query(`UPDATE ledger_blocks SET payload = payload || '{"title":"Edited"}' WHERE block_index = 1`);
  v = await call('GET', '/api/ledger/verify', { token: investor.token });
  assert.ok(v.data.problems.some((p) => p.kind === 'hash' && p.blockIndex === 1));
  await pool.query('UPDATE ledger_blocks SET payload = $1 WHERE block_index = 1', [original]);
  v = await call('GET', '/api/ledger/verify', { token: investor.token });
  assert.equal(v.data.valid, true);
});

await step('insights come from real data', async () => {
  const r = await call('GET', '/api/insights', { token: investor.token });
  assert.equal(r.status, 200);
  assert.equal(r.data.daily.length, 30);
  assert.ok(r.data.raised >= 60000);
});

await step('password change signs out other sessions; logout works', async () => {
  const second = (await call('POST', '/api/auth/login', { body: { email: `asha${stamp}@example.com`, password: strong } })).data;
  const next = 'Lantern&Moss77';
  assert.equal((await call('POST', '/api/auth/password', { token: investor.token, body: { currentPassword: 'nope', newPassword: next } })).status, 400);
  assert.equal((await call('POST', '/api/auth/password', { token: investor.token, body: { currentPassword: strong, newPassword: next } })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token: second.token })).status, 401);
  assert.equal((await call('POST', '/api/auth/logout', { token: investor.token })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token: investor.token })).status, 401);
});

await step('deactivated accounts cannot sign in', async () => {
  await call('PATCH', `/api/users/${support.user.id}`, { token: admin.token, body: { isActive: false } });
  assert.equal((await call('POST', '/api/auth/login', { body: { email: `meera${stamp}@example.com`, password: strong } })).status, 403);
});

console.log(`\n${passed} checks passed.`);
await pool.end();
