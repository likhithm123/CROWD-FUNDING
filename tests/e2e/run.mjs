// End-to-end UI tests for four modules, driven through a real browser with Puppeteer.
//
//   1. Account creation (sign-up constraints)
//   2. Login and session
//   3. Wallet and contributions
//   4. AI assistant and support escalation
//
// Usage (against a server running on a THROWAWAY database, started with
// DISABLE_RATE_LIMIT=true so the run can create many accounts):
//   APP_URL=http://localhost:5001 ADMIN_EMAIL=… ADMIN_PASSWORD=… SUPPORT_EMAIL=… SUPPORT_PASSWORD=… npm run test:ui
//
// Every test case saves a screenshot to tests/e2e/output/<ID>.png and the run
// writes tests/e2e/output/results.json with expected and actual results.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const APP = process.env.APP_URL || 'http://localhost:5001';
const OUT = process.env.E2E_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
fs.mkdirSync(OUT, { recursive: true });

const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };
const SUPPORT = { email: process.env.SUPPORT_EMAIL, password: process.env.SUPPORT_PASSWORD };
const stamp = Date.now().toString(36);
const PW = 'Tidal#River42';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', ...(process.env.E2E_CHROME_ARGS ? process.env.E2E_CHROME_ARGS.split(' ') : [])],
});
const results = [];

// ------------------------------------------------------------------ helpers
async function api(method, p, token, body) {
  const res = await fetch(APP + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function freshPage(width = 1280) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 860 });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return page;
}

async function clickText(page, selector, text) {
  await page.waitForSelector(selector);
  const ok = await page.$$eval(selector, (els, t) => {
    const el = els.find((e) => e.textContent.trim() === t);
    if (el) el.click();
    return Boolean(el);
  }, text);
  if (!ok) throw new Error(`Could not find "${text}"`);
}

const textOf = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());
const lastToast = (page) => page.$$eval('.toast span', (els) => els.at(-1).textContent.trim());
async function waitForNewToast(page, before) {
  await page.waitForFunction((n) => document.querySelectorAll('.toast').length > 0 && [...document.querySelectorAll('.toast span')].at(-1).textContent !== n, { timeout: 10000 }, before);
  return lastToast(page);
}
const currentToast = (page) => page.$$eval('.toast span', (els) => (els.length ? els.at(-1).textContent : null));
const allText = (page, sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));

async function typeInto(page, selector, value) {
  await page.waitForSelector(selector);
  // Clear a React-controlled input reliably, then type like a user.
  await page.$eval(selector, (el) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  });
  if (value) await page.type(selector, value);
}

async function openSignIn(page) {
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(APP, { waitUntil: 'networkidle0' });
}

async function signIn(page, email, password, portal = 'Customer') {
  await openSignIn(page);
  await clickText(page, '.segmented button', portal);
  await typeInto(page, 'input[type="email"]', email);
  await typeInto(page, 'input[type="password"]', password);
  await page.click('button[type="submit"]');
}

async function openSignUp(page) {
  await openSignIn(page);
  await clickText(page, '.auth-switch .linkish', 'Create an account');
  await page.waitForSelector('input[autocomplete="name"]');
}

async function fillSignUp(page, { role, name, email, password, confirm, terms }) {
  if (role) await page.click(`input[value="${role}"]`);
  if (name !== undefined) await typeInto(page, 'input[autocomplete="name"]', name);
  if (email !== undefined) await typeInto(page, 'input[type="email"]', email);
  const pw = await page.$$('input[autocomplete="new-password"]');
  if (password !== undefined) { await pw[0].click({ clickCount: 3 }); await page.keyboard.press('Backspace'); await pw[0].type(password); }
  if (confirm !== undefined) { await pw[1].click({ clickCount: 3 }); await page.keyboard.press('Backspace'); await pw[1].type(confirm); }
  if (terms) await page.click('input[type="checkbox"]');
}

const fieldErrors = (page) => allText(page, '.field .error');

/** Define and run one test case. `fn` returns the actual result text. */
async function tc(meta, fn) {
  if (ONLY && !ONLY.test(meta.id)) return;
  const r = { ...meta, status: 'PASS', actual: '', screenshot: `${meta.id}.png` };
  const ctx = { page: null, shotTaken: false };
  ctx.snap = async (page = ctx.page) => {
    await wait(350);
    await page.screenshot({ path: path.join(OUT, r.screenshot) });
    ctx.shotTaken = true;
  };
  const started = Date.now();
  try {
    r.actual = (await fn(ctx)) || 'As expected';
    if (ctx.page?.errors?.length) throw new Error(`Browser error: ${ctx.page.errors[0]}`);
  } catch (err) {
    r.status = 'FAIL';
    r.actual = err.message.split('\n')[0];
  }
  if (!ctx.shotTaken && ctx.page) await ctx.snap().catch(() => {});
  if (!ctx.shotTaken && !ctx.page) r.screenshot = null;
  r.durationMs = Date.now() - started;
  results.push(r);
  console.log(`${r.status === 'PASS' ? '  ok  ' : '  FAIL'} ${r.id} ${r.title}${r.status === 'FAIL' ? `\n        → ${r.actual}` : ''}`);
}

function expect(cond, message) { if (!cond) throw new Error(message); }

// ------------------------------------------------------------- shared setup
const admin = (await api('POST', '/api/auth/login', null, ADMIN)).data;
if (!admin.token) throw new Error('Admin sign-in failed. Check ADMIN_EMAIL and ADMIN_PASSWORD.');
const mgr = (await api('POST', '/api/auth/signup', null, { name: 'Vikram Nair', email: `vikram.${stamp}@example.com`, password: PW, role: 'MANAGER' })).data;

async function liveProject(title, goal, items = []) {
  const r = await api('POST', '/api/projects', mgr.token, {
    title, category: 'Agriculture', location: 'Kolar, Karnataka',
    summary: 'Replace diesel irrigation pumps with solar kits on small farms.',
    description: 'Twelve families near Kolar spend a third of their income on diesel for irrigation pumps. This project buys and installs solar pump kits and trains one person per farm to maintain them.',
    targetFunding: goal, tenureMonths: 6, items,
  });
  await api('POST', `/api/projects/${r.data.id}/review`, admin.token, { decision: 'approve', note: 'Quotes checked.' });
  return r.data.id;
}
const projectA = await liveProject(`Solar pumps for Kolar farms ${stamp}`, 10000, [{ itemName: 'Solar pump kit', quantity: 2, unitPrice: 4500 }]);
const projectB = await liveProject(`Drip lines for Mulbagal ${stamp}`, 2000);

// =================================================================== MODULE 1
const M1 = 'Account creation';
console.log(`\n${M1}`);

await tc({ id: 'TC-SU-01', module: M1, title: 'Create a backer account with valid details', type: 'Positive',
  input: 'Role: Back projects; Name: Asha Rao; Email: asha.<run>@example.com; Password: Tidal#River42 (twice); terms ticked',
  expected: 'Account is created, user lands on the Projects page signed in, wallet shows ₹0' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await fillSignUp(c.page, { role: 'INVESTOR', name: 'Asha Rao', email: `asha.${stamp}@example.com`, password: PW, confirm: PW, terms: true });
  await c.page.click('button[type="submit"]');
  await c.page.waitForSelector('.topbar', { timeout: 8000 });
  await c.page.waitForSelector('.page h1');
  const who = await textOf(c.page, '.user-button .who');
  const h1 = await textOf(c.page, '.page h1');
  await c.snap();
  expect(h1 === 'Projects', `Landed on "${h1}"`);
  expect(who.includes('Asha Rao') && who.includes('₹0'), `Top bar shows "${who}"`);
  return `Signed in on "${h1}"; top bar shows "${who.replace('Asha Rao', 'Asha Rao, ')}"`;
});

await tc({ id: 'TC-SU-02', module: M1, title: 'Submit an empty sign-up form', type: 'Negative',
  input: 'All fields empty, no role, terms not ticked', expected: 'Form is not submitted; errors shown for role, name, email, password and terms' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await c.page.click('button[type="submit"]');
  const errs = await fieldErrors(c.page);
  await c.snap();
  const joined = errs.join(' | ');
  for (const needle of ['how you’ll use', 'Name must be', 'Enter your email', 'Meet every requirement', 'accept the terms']) {
    expect(joined.includes(needle), `Missing error containing "${needle}". Shown: ${joined}`);
  }
  expect(await c.page.$('.topbar') === null, 'Form was submitted');
  return `${errs.length} errors shown: ${joined}`;
});

await tc({ id: 'TC-SU-03', module: M1, title: 'Reject an invalid email address', type: 'Negative',
  input: 'Email: priya@mail', expected: '“Enter a valid email address, like name@example.com.”' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await fillSignUp(c.page, { email: 'priya@mail' });
  await c.page.click('input[autocomplete="name"]');
  const errs = await fieldErrors(c.page);
  await c.snap();
  expect(errs.some((e) => e.includes('valid email address')), `Errors: ${errs.join(' | ')}`);
  return errs.find((e) => e.includes('email'));
});

await tc({ id: 'TC-SU-04', module: M1, title: 'Reject a weak password', type: 'Negative',
  input: 'Password: password', expected: 'Checklist marks uppercase, number, symbol and “not common” as unmet; error “Meet every requirement below.”' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await fillSignUp(c.page, { name: 'Priya Das', email: `priya.${stamp}@example.com`, password: 'password' });
  await c.page.click('input[autocomplete="name"]');
  const unmet = await allText(c.page, '.rules li:not(.ok)');
  const errs = await fieldErrors(c.page);
  await c.snap();
  for (const rule of ['An uppercase letter', 'A number', 'A symbol, like ! @ # or %', 'Not a commonly used password']) expect(unmet.includes(rule), `"${rule}" not flagged. Unmet: ${unmet.join(', ')}`);
  expect(errs.some((e) => e.includes('Meet every requirement')), 'No password error');
  return `Unmet rules: ${unmet.join(', ')}`;
});

await tc({ id: 'TC-SU-05', module: M1, title: 'Reject a password that contains the user’s name', type: 'Negative',
  input: 'Name: Priya Das; Password: Priya#2026x', expected: '“Doesn’t contain your name or email” stays unmet' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await fillSignUp(c.page, { name: 'Priya Das', email: `pd.${stamp}@example.com`, password: 'Priya#2026x' });
  const unmet = await allText(c.page, '.rules li:not(.ok)');
  await c.snap();
  expect(unmet.length === 1 && unmet[0].startsWith('Doesn’t contain'), `Unmet: ${unmet.join(', ')}`);
  return `Only unmet rule: ${unmet[0]}`;
});

await tc({ id: 'TC-SU-06', module: M1, title: 'Passwords that don’t match', type: 'Negative',
  input: 'Password: Tidal#River42; Confirm: Tidal#River43', expected: '“Passwords don’t match.”' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await fillSignUp(c.page, { role: 'INVESTOR', name: 'Priya Das', email: `pm.${stamp}@example.com`, password: PW, confirm: 'Tidal#River43', terms: true });
  await c.page.click('button[type="submit"]');
  const errs = await fieldErrors(c.page);
  await c.snap();
  expect(errs.includes('Passwords don’t match.'), `Errors: ${errs.join(' | ')}`);
  return errs.join(' | ');
});

await tc({ id: 'TC-SU-07', module: M1, title: 'Reject an email that is already registered (different letter case)', type: 'Negative',
  input: 'Email: ASHA.<run>@EXAMPLE.COM (registered in TC-SU-01 in lower case)', expected: 'Server refuses: “An account with this email already exists. Sign in instead.”' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await fillSignUp(c.page, { role: 'INVESTOR', name: 'Asha Rao', email: `ASHA.${stamp}@EXAMPLE.COM`, password: PW, confirm: PW, terms: true });
  await c.page.click('button[type="submit"]');
  await c.page.waitForSelector('.notice-error', { timeout: 6000 });
  const msg = await textOf(c.page, '.notice-error');
  await c.snap();
  expect(msg.includes('already exists'), `Message: ${msg}`);
  return msg;
});

await tc({ id: 'TC-SU-08', module: M1, title: 'Reject a name containing digits', type: 'Negative',
  input: 'Name: R2D2', expected: '“Name can only contain letters, spaces, apostrophes, hyphens and dots.”' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await fillSignUp(c.page, { name: 'R2D2' });
  await c.page.click('input[type="email"]');
  const errs = await fieldErrors(c.page);
  await c.snap();
  expect(errs.some((e) => e.startsWith('Name can only contain')), `Errors: ${errs.join(' | ')}`);
  return errs[0];
});

await tc({ id: 'TC-SU-09', module: M1, title: 'Terms not accepted', type: 'Negative',
  input: 'All fields valid, terms checkbox not ticked', expected: '“You need to accept the terms to create an account.”; no account created' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await fillSignUp(c.page, { role: 'INVESTOR', name: 'Kiran Bose', email: `kiran.${stamp}@example.com`, password: PW, confirm: PW });
  await c.page.click('button[type="submit"]');
  const errs = await fieldErrors(c.page);
  await c.snap();
  expect(errs.some((e) => e.includes('accept the terms')), `Errors: ${errs.join(' | ')}`);
  const check = await api('POST', '/api/auth/login', null, { email: `kiran.${stamp}@example.com`, password: PW });
  expect(check.status === 401, 'Account was created anyway');
  return `${errs.join(' | ')}; sign-in for that email returns ${check.status} (no account)`;
});

await tc({ id: 'TC-SU-10', module: M1, title: 'Block creating an administrator through the public API', type: 'Security',
  input: 'POST /api/auth/signup with role: "ADMIN"', expected: 'HTTP 400, role rejected' }, async () => {
  const r = await api('POST', '/api/auth/signup', null, { name: 'Mallory Grey', email: `mallory.${stamp}@example.com`, password: PW, role: 'ADMIN' });
  expect(r.status === 400 && r.data.fields?.role, `Got ${r.status}: ${JSON.stringify(r.data)}`);
  return `HTTP ${r.status}: ${r.data.error}`;
});

await tc({ id: 'TC-SU-12', module: M1, title: 'Tick the terms box straight after typing a mismatched confirmation', type: 'Usability',
  input: 'Password: Tidal#River42; Confirm: Tidal#River4 (cursor still in Confirm); click the terms checkbox once', expected: 'The checkbox is ticked on the first click (the mismatch message must not move it away from the pointer)' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await fillSignUp(c.page, { role: 'INVESTOR', name: 'Priya Das', email: `tick.${stamp}@example.com`, password: PW, confirm: 'Tidal#River4' });
  await c.page.click('input[type="checkbox"]');
  const ticked = await c.page.$eval('input[type="checkbox"]', (e) => e.checked);
  await c.snap();
  expect(ticked, 'Checkbox is still unticked after one click: the mismatch message appeared on blur and pushed it down');
  return 'Checkbox ticked on the first click';
});

await tc({ id: 'TC-SU-11', module: M1, title: 'Create a project-lead account', type: 'Positive',
  input: 'Role: Run a project; Name: Lakshmi Menon; valid email and password; terms ticked', expected: 'Lands on “My projects” with a “Start a project” button' }, async (c) => {
  c.page = await freshPage();
  await openSignUp(c.page);
  await fillSignUp(c.page, { role: 'MANAGER', name: 'Lakshmi Menon', email: `lakshmi.${stamp}@example.com`, password: PW, confirm: PW, terms: true });
  await c.page.click('button[type="submit"]');
  await c.page.waitForSelector('.page h1', { timeout: 8000 });
  const h1 = await textOf(c.page, '.page h1');
  await c.snap();
  expect(h1 === 'My projects', `Landed on "${h1}"`);
  return `Landed on "${h1}"`;
});

// =================================================================== MODULE 2
const M2 = 'Login and session';
console.log(`\n${M2}`);
const lockEmail = `lock.${stamp}@example.com`;
await api('POST', '/api/auth/signup', null, { name: 'Rahul Sharma', email: lockEmail, password: PW, role: 'INVESTOR' });

await tc({ id: 'TC-LG-01', module: M2, title: 'Sign in with a valid customer account', type: 'Positive',
  input: 'Tab: Customer; asha.<run>@example.com / Tidal#River42', expected: 'Projects page opens with the user’s name in the top bar' }, async (c) => {
  c.page = await freshPage();
  await signIn(c.page, `asha.${stamp}@example.com`, PW);
  await c.page.waitForSelector('.page h1', { timeout: 8000 });
  const h1 = await textOf(c.page, '.page h1');
  await c.snap();
  expect(h1 === 'Projects', `Landed on "${h1}"`);
  return `Signed in, "${h1}" page shown`;
});

await tc({ id: 'TC-LG-02', module: M2, title: 'Wrong password', type: 'Negative',
  input: 'asha.<run>@example.com / Wrong#Pass1', expected: '“Email or password is incorrect.”' }, async (c) => {
  c.page = await freshPage();
  await signIn(c.page, `asha.${stamp}@example.com`, 'Wrong#Pass1');
  await c.page.waitForSelector('.notice-error');
  const msg = await textOf(c.page, '.notice-error');
  await c.snap();
  expect(msg.startsWith('Email or password is incorrect'), msg);
  return msg;
});

await tc({ id: 'TC-LG-03', module: M2, title: 'Unknown email gets the same message (no account discovery)', type: 'Security',
  input: 'nobody.<run>@example.com / Tidal#River42', expected: 'Same “Email or password is incorrect.” message as a wrong password' }, async (c) => {
  c.page = await freshPage();
  await signIn(c.page, `nobody.${stamp}@example.com`, PW);
  await c.page.waitForSelector('.notice-error');
  const msg = await textOf(c.page, '.notice-error');
  await c.snap();
  expect(msg === 'Email or password is incorrect.', msg);
  return msg;
});

await tc({ id: 'TC-LG-04', module: M2, title: 'Submit with empty fields', type: 'Negative',
  input: 'Email and password empty', expected: '“Enter your email address.”; no request sent' }, async (c) => {
  c.page = await freshPage();
  await openSignIn(c.page);
  await c.page.click('button[type="submit"]');
  await c.page.waitForSelector('.notice-error');
  const msg = await textOf(c.page, '.notice-error');
  await c.snap();
  expect(msg === 'Enter your email address.', msg);
  return msg;
});

await tc({ id: 'TC-LG-05', module: M2, title: 'Support team signs in through the Support tab', type: 'Positive',
  input: 'Tab: Support team; support account credentials', expected: 'Support queue opens' }, async (c) => {
  c.page = await freshPage();
  await signIn(c.page, SUPPORT.email, SUPPORT.password, 'Support team');
  await c.page.waitForSelector('.page h1', { timeout: 8000 });
  const h1 = await textOf(c.page, '.page h1');
  await c.snap();
  expect(h1 === 'Support queue', `Landed on "${h1}"`);
  return `"${h1}" opened`;
});

await tc({ id: 'TC-LG-06', module: M2, title: 'Customer account used on the Support tab', type: 'Negative',
  input: 'Tab: Support team; asha.<run>@example.com / Tidal#River42', expected: '“This isn’t a support team account. Choose “Customer” and sign in again.”' }, async (c) => {
  c.page = await freshPage();
  await signIn(c.page, `asha.${stamp}@example.com`, PW, 'Support team');
  await c.page.waitForSelector('.notice-error');
  const msg = await textOf(c.page, '.notice-error');
  await c.snap();
  expect(msg.includes('isn’t a support team account'), msg);
  return msg;
});

await tc({ id: 'TC-LG-07', module: M2, title: 'Administrator signs in through the Administrator tab', type: 'Positive',
  input: 'Tab: Administrator; admin credentials', expected: 'Review page opens' }, async (c) => {
  c.page = await freshPage();
  await signIn(c.page, ADMIN.email, ADMIN.password, 'Administrator');
  await c.page.waitForSelector('.page h1', { timeout: 8000 });
  const h1 = await textOf(c.page, '.page h1');
  await c.snap();
  expect(h1 === 'Review', `Landed on "${h1}"`);
  return `"${h1}" page opened`;
});

await tc({ id: 'TC-LG-08', module: M2, title: 'Five wrong passwords lock the account', type: 'Security',
  input: 'lock.<run>@example.com with Wrong#Pass1, five times', expected: 'Attempts 3–4 warn how many are left; attempt 5 says the account is locked for 15 minutes' }, async (c) => {
  c.page = await freshPage();
  const messages = [];
  for (let i = 1; i <= 5; i++) {
    await signIn(c.page, lockEmail, 'Wrong#Pass1');
    await c.page.waitForSelector('.notice-error');
    messages.push(await textOf(c.page, '.notice-error'));
  }
  await c.snap();
  expect(messages[3].includes('1 attempt left'), `Attempt 4: ${messages[3]}`);
  expect(messages[4].includes('locked for 15 minutes'), `Attempt 5: ${messages[4]}`);
  return messages.map((m, i) => `#${i + 1}: ${m}`).join(' / ');
});

await tc({ id: 'TC-LG-09', module: M2, title: 'Correct password while locked is still refused', type: 'Security',
  input: 'lock.<run>@example.com / Tidal#River42 (correct) right after TC-LG-08', expected: '“Too many wrong passwords. This account is locked for 15 more minutes.”' }, async (c) => {
  c.page = await freshPage();
  await signIn(c.page, lockEmail, PW);
  await c.page.waitForSelector('.notice-error');
  const msg = await textOf(c.page, '.notice-error');
  await c.snap();
  expect(msg.includes('locked'), msg);
  return msg;
});

await tc({ id: 'TC-LG-10', module: M2, title: 'Session survives a page reload', type: 'Positive',
  input: 'Sign in, then reload the browser tab', expected: 'Still signed in on the same page' }, async (c) => {
  c.page = await freshPage();
  await signIn(c.page, `asha.${stamp}@example.com`, PW);
  await c.page.waitForSelector('.topbar');
  await c.page.goto(`${APP}/#/wallet`, { waitUntil: 'networkidle0' });
  await c.page.reload({ waitUntil: 'networkidle0' });
  await c.page.waitForSelector('.page h1');
  const h1 = await textOf(c.page, '.page h1');
  await c.snap();
  expect(h1 === 'Wallet', `After reload: "${h1}"`);
  return `After reload: still signed in on "${h1}"`;
});

await tc({ id: 'TC-LG-11', module: M2, title: 'Sign out ends the session', type: 'Positive',
  input: 'Account menu → Sign out, then reload', expected: 'Sign-in page shows; reloading does not restore the session; old token rejected (401)' }, async (c) => {
  c.page = await freshPage();
  await signIn(c.page, `asha.${stamp}@example.com`, PW);
  await c.page.waitForSelector('.topbar');
  const token = await c.page.evaluate(() => localStorage.getItem('crowdledger.session'));
  await c.page.click('.user-button');
  await clickText(c.page, '.menu button', 'Sign out');
  await c.page.waitForSelector('.auth');
  await c.page.reload({ waitUntil: 'networkidle0' });
  await c.page.waitForSelector('.auth');
  const me = await api('GET', '/api/auth/me', token);
  await c.snap();
  expect(me.status === 401, `Old token returned ${me.status}`);
  return `Sign-in page shown after reload; old session token now returns HTTP ${me.status}`;
});

await tc({ id: 'TC-LG-12', module: M2, title: 'Changing the password signs out other devices', type: 'Security',
  input: 'Two sessions for the same account; change password in Account settings from one', expected: 'Toast confirms; the other session is rejected' }, async (c) => {
  const email = `swap.${stamp}@example.com`;
  await api('POST', '/api/auth/signup', null, { name: 'Neha Kapoor', email, password: PW, role: 'INVESTOR' });
  const other = (await api('POST', '/api/auth/login', null, { email, password: PW })).data.token;
  c.page = await freshPage();
  await signIn(c.page, email, PW);
  await c.page.waitForSelector('.topbar');
  await c.page.goto(`${APP}/#/account`, { waitUntil: 'networkidle0' });
  const pws = await c.page.$$('form:nth-of-type(2) input[type="password"]');
  await pws[0].type(PW);
  await pws[1].type('Lantern&Moss77');
  await pws[2].type('Lantern&Moss77');
  await clickText(c.page, 'button[type="submit"]', 'Change password');
  await c.page.waitForSelector('.toast');
  const toast = await textOf(c.page, '.toast span');
  await c.snap();
  const me = await api('GET', '/api/auth/me', other);
  expect(me.status === 401, `Other session returned ${me.status}`);
  return `${toast} Other session now returns HTTP ${me.status}.`;
});

// =================================================================== MODULE 3
const M3 = 'Wallet and contributions';
console.log(`\n${M3}`);
const backerEmail = `meera.${stamp}@example.com`;
await api('POST', '/api/auth/signup', null, { name: 'Meera Pillai', email: backerEmail, password: PW, role: 'INVESTOR' });
const backer = await freshPage();
await signIn(backer, backerEmail, PW);
await backer.waitForSelector('.topbar');

async function deposit(page, amount) {
  await page.goto(`${APP}/#/wallet`, { waitUntil: 'networkidle0' });
  await clickText(page, '.btn', 'Add funds');
  await typeInto(page, '.modal .input-prefix input', String(amount));
  await page.click('.modal button[type="submit"]');
}
async function contribute(page, projectId, amount) {
  await page.goto(`${APP}/#/projects/${projectId}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('aside .input-prefix input');
  await typeInto(page, 'aside .input-prefix input', String(amount));
  await clickText(page, 'aside button[type="submit"]', 'Contribute');
}

await tc({ id: 'TC-WC-01', module: M3, title: 'Add ₹5,000 to the wallet', type: 'Positive',
  input: 'Wallet → Add funds → 5000', expected: 'Balance becomes ₹5,000; history shows “Added to wallet +₹5,000” with a ledger block' }, async (c) => {
  c.page = backer;
  await deposit(backer, 5000);
  await waitForNewToast(backer, null);
  await backer.waitForFunction(() => document.querySelector('.stats b')?.textContent.includes('5,000'));
  const bal = await textOf(backer, '.stats b');
  const row = await textOf(backer, 'tbody tr');
  await c.snap();
  expect(row.includes('Added to wallet') && row.includes('+₹5,000'), row);
  return `Balance ${bal}; history row: ${row.replace(/\s+/g, ' ')}`;
});

await tc({ id: 'TC-WC-02', module: M3, title: 'Deposit below the minimum', type: 'Negative (boundary)',
  input: 'Add funds → 50', expected: '“The minimum is ₹100.”; balance unchanged' }, async (c) => {
  c.page = backer;
  await deposit(backer, 50);
  const errs = await fieldErrors(backer);
  await c.snap();
  expect(errs.includes('The minimum is ₹100.'), errs.join(' | '));
  await backer.keyboard.press('Escape');
  return errs[0];
});

await tc({ id: 'TC-WC-03', module: M3, title: 'Deposit above the maximum', type: 'Negative (boundary)',
  input: 'Add funds → 2000000', expected: '“The maximum per deposit is ₹10,00,000.”' }, async (c) => {
  c.page = backer;
  await deposit(backer, 2000000);
  const errs = await fieldErrors(backer);
  await c.snap();
  expect(errs.includes('The maximum per deposit is ₹10,00,000.'), errs.join(' | '));
  await backer.keyboard.press('Escape');
  return errs[0];
});

await tc({ id: 'TC-WC-04', module: M3, title: 'Contribute ₹1,000 to a live project', type: 'Positive',
  input: 'Project A (goal ₹10,000) → amount 1000 → Contribute', expected: 'Toast confirms with a block number; raised total shows ₹1,000; “You’ve put in ₹1,000”' }, async (c) => {
  c.page = backer;
  const before = await currentToast(backer);
  await contribute(backer, projectA, 1000);
  const toast = await waitForNewToast(backer, before);
  await backer.waitForFunction(() => document.querySelector('.tally-number')?.textContent.includes('1,000'));
  const tally = await textOf(backer, '.tally-number');
  await c.snap();
  expect(/block #\d+/.test(toast), toast);
  return `${toast} Raised now ${tally}.`;
});

await tc({ id: 'TC-WC-05', module: M3, title: 'Contribute more than the wallet balance', type: 'Negative',
  input: 'Project A → 5000 (balance is ₹4,000)', expected: '“Your wallet doesn’t have enough money for that.”' }, async (c) => {
  c.page = backer;
  await contribute(backer, projectA, 5000);
  const errs = await fieldErrors(backer);
  await c.snap();
  expect(errs.some((e) => e.includes('doesn’t have enough money')), errs.join(' | '));
  return errs[0];
});

await tc({ id: 'TC-WC-06', module: M3, title: 'Contribute more than is left to reach the goal', type: 'Negative',
  input: 'Project B (goal ₹2,000) → 3000', expected: '“Only ₹2,000 is left to reach the goal.”' }, async (c) => {
  c.page = backer;
  await contribute(backer, projectB, 3000);
  const errs = await fieldErrors(backer);
  await c.snap();
  expect(errs.some((e) => e.includes('Only ₹2,000 is left')), errs.join(' | '));
  return errs[0];
});

await tc({ id: 'TC-WC-07', module: M3, title: 'Contribute below the minimum', type: 'Negative (boundary)',
  input: 'Project A → 50', expected: '“Contributions start at ₹100.”' }, async (c) => {
  c.page = backer;
  await contribute(backer, projectA, 50);
  const errs = await fieldErrors(backer);
  await c.snap();
  expect(errs.includes('Contributions start at ₹100.'), errs.join(' | '));
  return errs[0];
});

await tc({ id: 'TC-WC-13', module: M3, title: 'An amount typed on one project is not carried to another project', type: 'Negative',
  input: 'Type 3000 on Project A (do not submit), then open Project B', expected: 'Project B’s amount field is empty and shows no error' }, async (c) => {
  c.page = backer;
  await backer.goto(`${APP}/#/projects/${projectA}`, { waitUntil: 'networkidle0' });
  await backer.waitForSelector('aside .input-prefix input');
  await typeInto(backer, 'aside .input-prefix input', '3000');
  await backer.goto(`${APP}/#/projects/${projectB}`, { waitUntil: 'networkidle0' });
  await backer.waitForFunction((t) => document.querySelector('h1')?.textContent.startsWith(t), {}, 'Drip lines');
  await wait(300);
  const value = await backer.$eval('aside .input-prefix input', (e) => e.value).catch(() => '(no field)');
  await c.snap();
  expect(value === '', `Project B’s amount field already contains “${value}”`);
  return 'Project B opened with an empty amount field';
});

await tc({ id: 'TC-WC-08', module: M3, title: 'Withdraw more than was contributed', type: 'Negative',
  input: 'Project A → Withdraw → 1500 (contributed ₹1,000)', expected: '“You can withdraw up to ₹1,000.”' }, async (c) => {
  c.page = backer;
  await backer.goto(`${APP}/#/projects/${projectA}`, { waitUntil: 'networkidle0' });
  await clickText(backer, 'aside .btn-ghost', 'Withdraw');
  await typeInto(backer, '.modal .input-prefix input', '1500');
  await backer.click('.modal button[type="submit"]');
  const errs = await fieldErrors(backer);
  await c.snap();
  expect(errs.includes('You can withdraw up to ₹1,000.'), errs.join(' | '));
  await backer.keyboard.press('Escape');
  return errs[0];
});

await tc({ id: 'TC-WC-09', module: M3, title: 'Withdraw ₹500 while the project is raising', type: 'Positive',
  input: 'Project A → Withdraw → 500', expected: 'Toast “₹500 returned to your wallet.”; contribution shows ₹500; balance ₹4,500' }, async (c) => {
  c.page = backer;
  await backer.goto(`${APP}/#/projects/${projectA}`, { waitUntil: 'networkidle0' });
  await clickText(backer, 'aside .btn-ghost', 'Withdraw');
  await typeInto(backer, '.modal .input-prefix input', '500');
  const before = await currentToast(backer);
  await backer.click('.modal button[type="submit"]');
  const toast = await waitForNewToast(backer, before);
  await backer.waitForFunction(() => document.querySelector('aside')?.textContent.includes('₹4,500'));
  await c.snap();
  expect(toast === '₹500 returned to your wallet.', toast);
  return `${toast} Wallet balance now ₹4,500.`;
});

await tc({ id: 'TC-WC-10', module: M3, title: 'A contribution that completes the goal closes the project', type: 'Positive',
  input: 'Project B (goal ₹2,000) → Max (2000) → Contribute', expected: 'Status “Goal reached”; 100% funded; contribution form replaced by a message' }, async (c) => {
  c.page = backer;
  const before = await currentToast(backer);
  await contribute(backer, projectB, 2000);
  const toast = await waitForNewToast(backer, before);
  await backer.waitForFunction(() => document.body.textContent.includes('Goal reached'));
  const formGone = (await backer.$('aside .input-prefix input')) === null;
  await c.snap();
  expect(toast.includes('reached its goal') && formGone, `${toast}; form still shown: ${!formGone}`);
  return `${toast} Status shows “Goal reached”; contribution form removed.`;
});

await tc({ id: 'TC-WC-11', module: M3, title: 'Ledger integrity check passes after the transactions', type: 'Positive',
  input: 'Ledger → Check integrity', expected: '“The ledger checks out” with every wallet and project total matching' }, async (c) => {
  c.page = backer;
  await backer.goto(`${APP}/#/ledger`, { waitUntil: 'networkidle0' });
  await backer.waitForSelector('.notice-ok');
  const msg = await textOf(backer, '.notice-ok');
  await c.snap();
  return msg.replace('The ledger checks out', 'The ledger checks out. ');
});

await tc({ id: 'TC-WC-12', module: M3, title: 'Contribution page on a phone (390 px wide)', type: 'Usability',
  input: 'Open Project A at 390 px width', expected: 'No horizontal scrolling; funding total and contribute form appear before the description' }, async (c) => {
  c.page = await freshPage(390);
  await signIn(c.page, backerEmail, PW);
  await c.page.waitForSelector('.topbar');
  await c.page.goto(`${APP}/#/projects/${projectA}`, { waitUntil: 'networkidle0' });
  await c.page.waitForSelector('.tally-number');
  const { scrollW, tallyTop, aboutTop } = await c.page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    tallyTop: document.querySelector('.tally-number').getBoundingClientRect().top,
    aboutTop: [...document.querySelectorAll('h2')].find((h) => h.textContent === 'About this project').getBoundingClientRect().top,
  }));
  await c.snap();
  expect(scrollW <= 390, `Page is ${scrollW}px wide`);
  expect(tallyTop < aboutTop, 'Funding total is below the description');
  return `Page width ${scrollW}px (no sideways scroll); funding total at ${Math.round(tallyTop)}px, description at ${Math.round(aboutTop)}px`;
});

// =================================================================== MODULE 4
const M4 = 'AI assistant and escalation';
console.log(`\n${M4}`);
const cust = await freshPage();
await signIn(cust, backerEmail, PW);
await cust.waitForSelector('.topbar');
const supportPage = await freshPage();
await signIn(supportPage, SUPPORT.email, SUPPORT.password, 'Support team');
await supportPage.waitForSelector('.topbar');
let convId = null;

async function askInLauncher(page, text) {
  await page.waitForSelector('.launcher-panel textarea:not([disabled])');
  await page.type('.launcher-panel textarea', text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((t) => {
    const user = [...document.querySelectorAll('.launcher-panel .bubble.user p')].map((p) => p.textContent);
    return user.includes(t) && document.querySelector('.launcher-panel .feedback');
  }, { timeout: 15000 }, text);
  return page.$$eval('.launcher-panel .bubble.bot p', (els) => els.at(-1).textContent);
}

await tc({ id: 'TC-AI-01', module: M4, title: 'Open the assistant from any page', type: 'Positive',
  input: 'Projects page → “Ask a question”', expected: 'Panel opens with a greeting and four starter questions' }, async (c) => {
  c.page = cust;
  await cust.goto(`${APP}/#/explore`, { waitUntil: 'networkidle0' });
  await cust.click('.launcher');
  await cust.waitForSelector('.launcher-panel .starters .chip');
  const starters = await allText(cust, '.launcher-panel .starters .chip');
  await c.snap();
  expect(starters.length === 4, `${starters.length} starters`);
  return `Panel open with starters: ${starters.join(' / ')}`;
});

await tc({ id: 'TC-AI-02', module: M4, title: 'Ask for the wallet balance', type: 'Positive',
  input: 'Starter: “What’s my wallet balance?”', expected: 'Reply states the real balance (₹2,500) and asks “Did this solve your question?”' }, async (c) => {
  c.page = cust;
  await clickText(cust, '.launcher-panel .starters .chip', 'What’s my wallet balance?');
  await cust.waitForSelector('.launcher-panel .feedback', { timeout: 15000 });
  const reply = await cust.$$eval('.launcher-panel .bubble.bot p', (els) => els.at(-1).textContent);
  await c.snap();
  expect(reply.includes('₹2,500'), reply);
  return `Assistant: “${reply}” — feedback prompt shown`;
});

await tc({ id: 'TC-AI-03', module: M4, title: 'Mark the answer as resolved', type: 'Positive',
  input: 'Click “Yes, resolved”', expected: 'Reply tagged “Marked resolved”; note “Marked as resolved…”; status Resolved' }, async (c) => {
  c.page = cust;
  await clickText(cust, '.launcher-panel .feedback button', 'Yes, resolved');
  await cust.waitForFunction(() => document.querySelector('.launcher-panel')?.textContent.includes('Marked as resolved'));
  const status = await textOf(cust, '.launcher-panel .chat-head .faint');
  await c.snap();
  expect(status === 'Resolved', status);
  return `Status: ${status}; note “Marked as resolved. Write again any time if you need more help.”`;
});

await tc({ id: 'TC-AI-04', module: M4, title: 'Report a problem: the assistant shows ledger facts and offers a person', type: 'Positive',
  input: 'New question: “I was charged twice for my contribution to the solar pumps project”', expected: 'Reply lists the customer’s latest ledger transactions and suggests “No, I still need help”' }, async (c) => {
  c.page = cust;
  await clickText(cust, '.launcher-panel .btn', 'New question');
  const reply = await askInLauncher(cust, 'I was charged twice for my contribution to the solar pumps project');
  await c.snap();
  expect(reply.includes('ledger') && reply.includes('block #') && reply.includes('No, I still need help'), reply);
  return `Assistant: “${reply.slice(0, 160)}…”`;
});

await tc({ id: 'TC-AI-05', module: M4, title: 'Say the answer didn’t help: escalate to support', type: 'Positive',
  input: 'Click “No, I still need help”', expected: 'Note “Passed to the support team with this whole conversation”; status “Waiting for support”' }, async (c) => {
  c.page = cust;
  await clickText(cust, '.launcher-panel .feedback button', 'No, I still need help');
  await cust.waitForFunction(() => document.querySelector('.launcher-panel')?.textContent.includes('Passed to the support team'));
  const status = await textOf(cust, '.launcher-panel .chat-head .faint');
  const placeholder = await cust.$eval('.launcher-panel textarea', (t) => t.placeholder);
  await c.snap();
  expect(status === 'Waiting for support', status);
  const list = await api('GET', '/api/conversations', (await api('POST', '/api/auth/login', null, { email: backerEmail, password: PW })).data.token);
  convId = list.data.conversations.find((x) => x.status === 'ESCALATED')?.id;
  return `Status: ${status}; input now says “${placeholder}”`;
});

await tc({ id: 'TC-AI-06', module: M4, title: 'Support sees the escalated conversation with full history', type: 'Positive',
  input: 'Support queue → open the conversation', expected: 'Customer message, assistant reply (marked not resolved) and escalation note are all visible' }, async (c) => {
  c.page = supportPage;
  await supportPage.goto(`${APP}/#/support/${convId}`, { waitUntil: 'networkidle0' });
  await supportPage.waitForSelector('.bubble.bot');
  const bubbles = await allText(supportPage, '.inbox-thread .bubble header');
  const notMarked = await supportPage.$eval('.inbox-thread', (e) => e.textContent.includes('Marked not resolved'));
  await c.snap();
  expect(bubbles.length >= 2 && notMarked, `Bubbles: ${bubbles.join(' | ')}`);
  return `${bubbles.length} messages visible (${bubbles.map((b) => b.split(/\d/)[0].trim()).join(', ')}); assistant reply tagged “Marked not resolved”`;
});

await tc({ id: 'TC-AI-07', module: M4, title: 'Support replies; the customer gets the reply and the resolved prompt', type: 'Positive',
  input: 'Support types a reply and presses Send; customer opens Assistant', expected: 'Customer sees the support reply with their name and “Did this solve your question?”' }, async (c) => {
  await supportPage.type('.chat-input textarea', 'I checked the ledger: there is one contribution of ₹1,000 and one withdrawal of ₹500, so you were charged once.');
  await supportPage.click('.chat-input button[type="submit"]');
  await supportPage.waitForSelector('.inbox-thread .bubble.support');
  c.page = cust;
  await cust.goto(`${APP}/#/assistant/${convId}`, { waitUntil: 'networkidle0' });
  await cust.waitForSelector('.bubble.support', { timeout: 15000 });
  await cust.waitForSelector('.feedback');
  const who = await textOf(cust, '.bubble.support header');
  await c.snap();
  return `Customer sees reply from “${who.split(/\d/)[0].trim()}” with the resolved prompt`;
});

await tc({ id: 'TC-AI-08', module: M4, title: 'Customer says the support reply didn’t help: back in the queue', type: 'Positive',
  input: 'Click “No, I still need help” on the support reply', expected: 'Conversation status returns to “Waiting for support” and appears under “Needs a reply”' }, async (c) => {
  await clickText(cust, '.feedback button', 'No, I still need help');
  await cust.waitForFunction(() => document.body.textContent.includes('Marked as not resolved'));
  c.page = supportPage;
  await supportPage.goto(`${APP}/#/support`, { waitUntil: 'networkidle0' });
  await clickText(supportPage, '.chip', `Needs a reply ${1}`).catch(async () => { await supportPage.$$eval('.chip', (els) => els[0].click()); });
  await wait(600);
  const items = await allText(supportPage, '.inbox-item');
  await c.snap();
  expect(items.some((t) => t.includes('Meera Pillai') && t.includes('Waiting for support')), items.join(' | '));
  return 'Listed under “Needs a reply” with status “Waiting for support”';
});

await tc({ id: 'TC-AI-09', module: M4, title: 'Support resolves; customer confirms', type: 'Positive',
  input: 'Support replies again; customer clicks “Yes, resolved”', expected: 'Status “Resolved by support”' }, async (c) => {
  await supportPage.goto(`${APP}/#/support/${convId}`, { waitUntil: 'networkidle0' });
  await supportPage.waitForSelector('.chat-input textarea:not([disabled])');
  await supportPage.type('.chat-input textarea', 'I have attached the ledger blocks to your wallet history so you can verify both entries.');
  await supportPage.click('.chat-input button[type="submit"]');
  await wait(500);
  c.page = cust;
  await cust.goto(`${APP}/#/assistant/${convId}`, { waitUntil: 'networkidle0' });
  await cust.waitForSelector('.feedback', { timeout: 15000 });
  await clickText(cust, '.feedback button', 'Yes, resolved');
  await cust.waitForFunction(() => document.querySelector('.chat-head .faint')?.textContent === 'Resolved by support');
  await c.snap();
  return 'Status: Resolved by support';
});

await tc({ id: 'TC-AI-10', module: M4, title: 'Ask for a project suggestion', type: 'Positive',
  input: 'Assistant page → “Which project should I back?”', expected: 'Reply names a live project and a suggested amount, and points to the Suggestions page' }, async (c) => {
  c.page = cust;
  await cust.goto(`${APP}/#/assistant/new`, { waitUntil: 'networkidle0' });
  await clickText(cust, '.starters .chip', 'Which project should I back?');
  await cust.waitForSelector('.feedback', { timeout: 15000 });
  const reply = await cust.$$eval('.bubble.bot p', (els) => els.at(-1).textContent);
  await c.snap();
  expect(reply.includes('Solar pumps for Kolar farms') && reply.includes('suggested ₹') && reply.includes('Suggestions'), reply);
  return `Assistant: “${reply.slice(0, 170)}…”`;
});

await tc({ id: 'TC-AI-11', module: M4, title: 'Unrelated question gets an honest fallback', type: 'Negative',
  input: '“What is the weather in Chennai today?”', expected: 'Assistant says it’s not sure and offers to pass the conversation to support' }, async (c) => {
  c.page = cust;
  await cust.waitForSelector('.chat-input textarea:not([disabled])');
  await cust.type('.chat-input textarea', 'What is the weather in Chennai today?');
  await cust.keyboard.press('Enter');
  // The typing indicator also has the bubble class, so wait for a second real reply.
  await cust.waitForFunction(() => document.querySelectorAll('.bubble.bot:not(.typing)').length >= 2 && document.querySelector('.feedback'), { timeout: 15000 });
  const reply = await cust.$$eval('.bubble.bot:not(.typing) p', (els) => els.at(-1).textContent);
  await c.snap();
  expect(reply.startsWith('I’m not sure') || reply.startsWith("I'm not sure"), reply);
  return `Assistant: “${reply.slice(0, 150)}…”`;
});

await tc({ id: 'TC-AI-12', module: M4, title: '“Talk to a person” escalates without waiting for an answer', type: 'Positive',
  input: 'Click “Talk to a person” in the conversation header', expected: 'Status “Waiting for support”; header button disappears' }, async (c) => {
  c.page = cust;
  await clickText(cust, '.chat-head .btn', 'Talk to a person');
  await cust.waitForFunction(() => document.querySelector('.chat-head .faint')?.textContent === 'Waiting for support');
  const buttonGone = !(await cust.$$eval('.chat-head .btn', (els) => els.some((e) => e.textContent === 'Talk to a person')));
  await c.snap();
  expect(buttonGone, 'Button still shown');
  return 'Status: Waiting for support; “Talk to a person” button removed';
});

await tc({ id: 'TC-AI-13', module: M4, title: 'Another customer cannot open someone else’s conversation', type: 'Security',
  input: 'Project lead account requests GET /api/conversations/<Meera’s id>', expected: 'HTTP 404' }, async () => {
  const r = await api('GET', `/api/conversations/${convId}`, mgr.token);
  expect(r.status === 404, `Got ${r.status}`);
  return `HTTP ${r.status}: ${r.data.error}`;
});

await tc({ id: 'TC-AI-14', module: M4, title: 'Administrator can read the full history', type: 'Positive',
  input: 'Administrator → Conversations → open Meera’s conversation', expected: 'All messages from customer, assistant and support are visible' }, async (c) => {
  c.page = await freshPage();
  await signIn(c.page, ADMIN.email, ADMIN.password, 'Administrator');
  await c.page.waitForSelector('.topbar');
  await c.page.goto(`${APP}/#/support/${convId}`, { waitUntil: 'networkidle0' });
  await c.page.waitForSelector('.bubble.support');
  const counts = await c.page.evaluate(() => ({
    user: document.querySelectorAll('.inbox-thread .bubble.user').length,
    bot: document.querySelectorAll('.inbox-thread .bubble.bot').length,
    support: document.querySelectorAll('.inbox-thread .bubble.support').length,
  }));
  await c.snap();
  expect(counts.user && counts.bot && counts.support, JSON.stringify(counts));
  return `Visible: ${counts.user} customer, ${counts.bot} assistant, ${counts.support} support messages`;
});

// ------------------------------------------------------------------ report
await browser.close();
const passed = results.filter((r) => r.status === 'PASS').length;
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), app: APP, passed, failed: results.length - passed, results }, null, 2));
console.log(`\n${passed}/${results.length} passed. Screenshots and results.json in ${OUT}`);
process.exitCode = passed === results.length ? 0 : 1;
