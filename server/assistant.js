// The CrowdFunding assistant.
//
// If an AI API key is set (GEMINI_API_KEY, GOOGLE_API_KEY, ANTHROPIC_API_KEY, or
// OPENAI_API_KEY), replies come from the LLM with the user's live account data as
// context. Otherwise (or if the API call fails) a rich built-in engine answers
// from the same live data and platform rules using comprehensive conversational
// intent matching. Either way the customer is asked after every reply whether their
// query is resolved.
import { recommend, loadPreferences } from './recommend.js';
import { suggestInventories } from './inventoryModel.js';
import { CATEGORIES } from '../shared/validation.js';

const ANTHROPIC_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';

const inr = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: process.env.CURRENCY || 'INR', maximumFractionDigits: 0 }).format(Number(n) || 0);

export const aiEnabled = () => Boolean(
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.OPENAI_API_KEY
);

const STATUS_WORDS = {
  PENDING: 'waiting for review',
  VERIFIED: 'approved and raising funds',
  REJECTED: 'sent back with changes requested',
  FUNDED: 'fully funded, ready for you to release the funds',
  CLOSED: 'closed, funds released',
};

// ---------------------------------------------------------------- context
export async function loadContext(db, user) {
  const ctx = { name: user.name, role: user.role, balance: Number(user.balance) };
  if (user.role === 'INVESTOR') {
    const { rows } = await db.query(
      `SELECT p.id, p.title, p.status, p.target_funding, p.current_funding,
         SUM(CASE WHEN t.type = 'INVESTMENT' THEN t.amount ELSE -t.amount END) AS mine
       FROM transactions t JOIN projects p ON p.id = t.project_id
       WHERE t.user_id = $1 AND t.type IN ('INVESTMENT', 'REFUND')
       GROUP BY p.id HAVING SUM(CASE WHEN t.type = 'INVESTMENT' THEN t.amount ELSE -t.amount END) > 0`, [user.id]);
    ctx.holdings = rows.map((r) => ({ id: r.id, title: r.title, status: r.status, mine: Number(r.mine), raised: Number(r.current_funding), goal: Number(r.target_funding) }));
  }
  if (user.role === 'MANAGER') {
    const { rows } = await db.query(
      `SELECT id, title, status, target_funding, current_funding, review_note,
         (SELECT COUNT(*) FROM project_documents d WHERE d.project_id = p.id) AS docs
       FROM projects p WHERE manager_id = $1 ORDER BY created_at DESC`, [user.id]);
    ctx.projects = rows.map((r) => ({ id: r.id, title: r.title, status: r.status, raised: Number(r.current_funding), goal: Number(r.target_funding), reviewNote: r.review_note, docs: r.docs }));
  }
  const { rows: live } = await db.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(target_funding - current_funding), 0) AS open FROM projects WHERE status = 'VERIFIED'`);
  ctx.liveProjects = live[0]?.n ? Number(live[0].n) : 0;
  return ctx;
}

const RULES = `CrowdFunding rules:
- Roles: backers add funds and contribute; project leads submit projects; administrators review projects; the support team answers escalated questions.
- Wallet deposits: minimum ₹100, maximum ₹10,00,000 per deposit, from the Wallet page ("Add funds"). There is no payment gateway yet; deposits are recorded on the ledger.
- Contributions: minimum ₹100 and no more than what's left to reach the goal. Only approved projects ("raising funds") accept contributions.
- Withdrawing a contribution: allowed up to what you put in, only while the project is still raising. Use "Withdraw" on the project page. Money returns to the wallet instantly.
- When a project reaches its goal it stops taking contributions; the project lead clicks "Release funds" and the money moves to their wallet. This can't be undone.
- Project leads submit from "Start a project": title, category, summary, description (80+ characters), goal (₹1,000 to ₹5,00,00,000), 1–60 months, optional budget items that can't exceed the goal. Up to 5 projects can wait for review at once. Documents (PDF, PNG, JPG, Word, Excel, text; up to 10 MB, 15 per project) can be uploaded from the project page. Approved projects can't be edited.
- Rejected projects show the reviewer's note; the lead edits and resubmits.
- Ledger: every action is a block containing the previous block's fingerprint. "Check integrity" on the Ledger page verifies the chain and confirms every wallet and project total matches. If it fails, payments pause.
- Accounts: passwords need 8–64 characters with upper, lower, number and symbol. 5 wrong passwords lock the account for 15 minutes. There is no email reset; an administrator can set a temporary password. Name can be changed in Account settings; email can't.
- There are no platform fees. Contributions don't pay interest or returns; they fund the project.
- The Suggestions page ranks projects for backers based on budget, risk preference, interests and time horizon.`;

function buildSystemPrompt(ctx) {
  return `You are the CrowdFunding assistant inside a crowdfunding web app. Answer the customer's question in 1–4 short sentences of plain, friendly English. Use only the rules and the customer's account data below; never invent numbers, projects or features. Amounts are in Indian rupees. If you can't answer or the customer needs a person (refunds outside the rules, bugs, disputes, account changes), say so and tell them to choose "No, I still need help" so the support team gets the conversation. Never reveal other customers' details. Don't use markdown headings.

${RULES}

Customer account data (JSON): ${JSON.stringify(ctx)}`;
}

// ---------------------------------------------------------------- Gemini
async function askGemini(ctx, history) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const system = buildSystemPrompt(ctx);

  const contents = [];
  for (const m of history.slice(-14)) {
    if (m.sender === 'SYSTEM') continue;
    const role = m.sender === 'USER' ? 'user' : 'model';
    const text = m.sender === 'SUPPORT' ? `(Support team reply) ${m.body}` : m.body;
    if (contents.length && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += `\n\n${text}`;
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }
  while (contents.length && contents[0].role !== 'user') contents.shift();
  if (!contents.length) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { maxOutputTokens: 500, temperature: 0.3 }
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`Assistant: Gemini API returned ${res.status}: ${errText}; falling back to built-in answers.`);
      return null;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('\n').trim();
    return text || null;
  } catch (err) {
    console.warn(`Assistant: Gemini API unavailable (${err.name || err.message}); falling back to built-in answers.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- Claude
async function askClaude(ctx, history) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const system = buildSystemPrompt(ctx);

  const messages = [];
  for (const m of history.slice(-14)) {
    const role = m.sender === 'USER' ? 'user' : 'assistant';
    const text = m.sender === 'SUPPORT' ? `(Support team reply) ${m.body}` : m.body;
    if (m.sender === 'SYSTEM') continue;
    if (messages.length && messages[messages.length - 1].role === role) messages[messages.length - 1].content += `\n\n${text}`;
    else messages.push({ role, content: text });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 500, system, messages }),
    });
    if (!res.ok) {
      console.warn(`Assistant: Claude API returned ${res.status}; using built-in answers.`);
      return null;
    }
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text || null;
  } catch (err) {
    console.warn(`Assistant: Claude API unavailable (${err.name}); using built-in answers.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- OpenAI
async function askOpenAI(ctx, history) {
  if (!process.env.OPENAI_API_KEY) return null;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const url = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/chat/completions';
  const system = buildSystemPrompt(ctx);

  const messages = [{ role: 'system', content: system }];
  for (const m of history.slice(-14)) {
    if (m.sender === 'SYSTEM') continue;
    const role = m.sender === 'USER' ? 'user' : 'assistant';
    const content = m.sender === 'SUPPORT' ? `(Support team reply) ${m.body}` : m.body;
    messages.push({ role, content });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: 500 }),
    });
    if (!res.ok) {
      console.warn(`Assistant: OpenAI API returned ${res.status}; using built-in answers.`);
      return null;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.warn(`Assistant: OpenAI API unavailable (${err.name}); using built-in answers.`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function askAI(ctx, history) {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    const text = await askGemini(ctx, history);
    if (text) return text;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const text = await askClaude(ctx, history);
    if (text) return text;
  }
  if (process.env.OPENAI_API_KEY) {
    const text = await askOpenAI(ctx, history);
    if (text) return text;
  }
  return null;
}

// ---------------------------------------------------------------- built-in
const INTENTS = [
  ['human', /\b(talk|speak|chat|connect)\b.*\b(human|person|agent|someone|support|staff)\b|customer care|real person|support team|human agent/i],
  ['problem', /\b(charged twice|double (charge|deduct|payment)|deducted twice|wrong (amount|balance)|missing (money|funds|amount)|not (received|credited|showing|reflected)|didn'?t (get|receive|show)|money (is )?gone|lost (my )?money|error|bug|broken|not working|doesn'?t work|stuck|failed|dispute|complain(t)?|issue|problem)\b/i],
  ['identity', /\b(what('?s| is) your name|can i (get to )?know your name|tell me your name|who are you|who am i talking to|what are you called|what should i call you|who made you|are you (an? )?(ai|bot|human|person|robot|assistant|real)|who created you)\b/i],
  ['wellbeing', /\b(how are you|how('?s| is) it going|how do you do|how are things|hope you('re| are) well|what('?s| is) up|wassup)\b/i],
  ['about_assistant', /\b(tell me about (yourself|you)|describe yourself|what do you do)\b/i],
  ['platform_info', /\b(what is (this|crowdledger)|about crowdledger|how does (this|crowdledger) work|tell me about (this|crowdledger)|what does this (app|website|platform) do|what can this (app|platform) do)\b/i],
  ['capabilities_help', /\b(what can you do|how can you help( me)?|help me|what are my options|features|commands|what do you know|what can i ask)\b/i],
  ['get_started', /\b(how (do|can) i (get started|start)|where do i begin|guide me|first steps?|getting started)\b/i],
  ['farewell', /\b(goodbye|bye|see you|have a (good|great) (day|night)|talk to you later|cya|take care)\b/i],
  ['thanks', /^(ok(ay)?[, ]*)?(thank|thanks|thx|ty|great|cool|perfect|awesome|appreciated)\b/i],
  ['suggest', /\b(suggest|recommend|which project|best project|where (should|can) i (invest|put)|good project|grow|potential|easy gain|profit)\b/i],
  ['withdraw', /\b(withdraw|refund|money back|take (it|my money) back|cancel (my )?(contribution|investment))\b/i],
  ['deposit', /\b(add (money|funds?)|deposit|top ?up|recharge|load (money|wallet)|put money)\b/i],
  ['balance', /\b(balance|how much (money )?(do i have|is in)|my wallet)\b/i],
  ['holdings', /\b(my (contributions?|investments?|portfolio)|what (have|did) i (back|invest|contribut))\b/i],
  ['payout', /\b(payout|release (the )?funds?|get (the |my )?money|goal (is )?reached|funded)\b/i],
  ['status', /\b(status|approved|approval|review(ed|ing)?|rejected|pending|my projects?)\b/i],
  ['submit', /\b(create|submit|start|launch|post|list|new)\b.*\b(project|campaign|fundraiser)\b/i],
  ['contribute', /\b(invest|contribut|back (a |this )?project|fund (a |this )?project|donate|support a project)\w*/i],
  ['docs', /\b(document|upload|file|pdf|proof|attachment|permit|quote)s?\b/i],
  ['ledger', /\b(ledger|block(chain)?|hash|tamper|integrity|verify|fingerprint)\b/i],
  ['account', /\b(password|locked?|sign ?in|log ?in|forgot|reset|deactivat|change (my )?(name|email)|account)\b/i],
  ['fees', /\b(fees?|charges?|commission|cost to use|interest|returns?|dividend)\b/i],
  ['safety', /\b(safe|scam|fraud|trust|genuine|legit|verified|real)\b/i],
  ['inventory', /\b(inventory|inventories|bill of materials|bom|equipment|supplies|hardware|materials|tools)\b/i],
  ['greet', /\b(hi+|hello+|hey+|hii+|namaste|good (morning|afternoon|evening|day)|greetings)\b/i],
];

export function detect(text) {
  const t = text.toLowerCase().trim();
  for (const [name, re] of INTENTS) {
    if (re.test(t)) return name;
  }
  // Try stripping common conversational preambles (e.g. "hey I have a question can I know your name")
  const stripped = t
    .replace(/^(hi+|hello+|hey+|hii+|namaste|good (morning|afternoon|evening|day))[, !.]*/gi, '')
    .replace(/^(i have a question|quick question|can i ask( a question)?|question|excuse me)[, !.:]*/gi, '')
    .replace(/^(can you (please )?tell me|could you tell me|please tell me|tell me|i want to know|can i know|do you know|can you help me with|help me with)[, !.:]*/gi, '')
    .trim();

  if (stripped && stripped !== t) {
    for (const [name, re] of INTENTS) {
      if (re.test(stripped)) return name;
    }
  }
  return null;
}

async function builtIn(db, user, ctx, text) {
  const intent = detect(text);
  const first = ctx.name ? ctx.name.split(' ')[0] : 'there';
  const backer = user.role === 'INVESTOR';
  const lead = user.role === 'MANAGER';

  switch (intent) {
    case 'identity':
      return `I am the CrowdFunding Assistant! I'm here to help you navigate the platform—managing your wallet, exploring and backing projects, checking verified ledger records, or connecting you with our human support team. What can I do for you today, ${first}?`;
    case 'wellbeing':
      return `I'm doing well, thank you for asking, ${first}! How can I help you with CrowdFunding today?`;
    case 'about_assistant':
      return `I'm the built-in CrowdFunding assistant. I'm connected to your live account to help you manage your wallet (${inr(ctx.balance)} balance), check contributions, view project status, and verify the platform's transparent ledger.`;
    case 'platform_info':
      return 'CrowdFunding is a transparent crowdfunding platform for community projects. Project leads submit verified plans with itemised budgets, backers contribute directly from their wallets, and every transaction is recorded on a tamper-evident, verifiable hash-chained ledger.';
    case 'capabilities_help':
      return `I can help you with:\n• Checking your wallet balance (${inr(ctx.balance)}) and recent ledger transactions\n• Finding and contributing to active projects\n• Withdrawing contributions while campaigns are raising\n• Submitting projects and tracking reviews\n• Verifying the hash-chained ledger\n• Escalating questions to our human support team.`;
    case 'get_started':
      if (backer) return `Welcome, ${first}! As a backer, you can add funds under the Wallet page, explore community initiatives on the Projects page, or check the Suggestions page for projects tailored to your budget and interests.`;
      if (lead) return `Welcome, ${first}! As a project lead, you can start by clicking "Start a project" under My Projects to submit your proposal and budget. Once approved by an admin, your project can begin raising funds!`;
      return 'To get started, explore active community projects on the Projects page, or head to your Wallet to manage your balance.';
    case 'farewell':
      return `Goodbye, ${first}! Have a great day and feel free to reach out whenever you need help with CrowdFunding.`;
    case 'greet':
      return `Hi ${first}! I can help with your wallet, contributions, projects, documents, the ledger and your account. What do you need?`;
    case 'thanks':
      return `You're welcome, ${first}. Anything else I can help with?`;
    case 'human':
      return 'I can pass this to the support team with our whole conversation. Choose "No, I still need help" below and a person will reply here.';
    case 'problem': {
      const { rows } = await db.query(
        `SELECT t.type, t.amount, t.created_at, t.block_index, p.title FROM transactions t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.user_id = $1 ORDER BY t.created_at DESC LIMIT 3`, [user.id]);
      const label = { DEPOSIT: 'added to wallet', INVESTMENT: 'contributed', REFUND: 'withdrawn', PAYOUT: 'funds released' };
      const recent = rows.length
        ? ` Your latest transactions on the ledger are: ${rows.map((r) => `${inr(r.amount)} ${label[r.type]}${r.title ? ` (${r.title})` : ''} in block #${r.block_index}`).join('; ')}. Your balance is ${inr(ctx.balance)}.`
        : ' I don\'t see any transactions on your account yet.';
      return `Sorry about that. I can't change transactions myself, but here's what the ledger shows.${recent} If something looks wrong, choose "No, I still need help" and the support team will look into it with this conversation.`;
    }
    case 'balance':
      return `Your wallet balance is ${inr(ctx.balance)}.${backer ? ' Add money from the Wallet page with "Add funds".' : lead ? ' Funds you release from fully funded projects land here.' : ''}`;
    case 'deposit':
      if (!backer) return 'Only backer accounts can add money to a wallet. Project leads receive money when they release funds from a fully funded project.';
      return `Open Wallet and choose "Add funds". Each deposit can be between ₹100 and ₹10,00,000, and it's credited straight away and written to the ledger. Your balance right now is ${inr(ctx.balance)}.`;
    case 'contribute':
      if (!backer) return 'Contributing is for backer accounts. If you want to raise money instead, use "Start a project".';
      return `Open Projects, pick one that's raising funds, enter an amount in "Back this project" and press Contribute. The minimum is ₹100, you can't go over what's left to reach the goal, and it comes from your wallet (${inr(ctx.balance)} available).${ctx.liveProjects ? ` ${ctx.liveProjects} ${ctx.liveProjects === 1 ? 'project is' : 'projects are'} raising right now.` : ' No projects are raising right now.'}`;
    case 'withdraw': {
      if (!backer) return 'Withdrawing contributions applies to backers. Project leads can release funds once their goal is reached.';
      const open = (ctx.holdings || []).filter((h) => h.status === 'VERIFIED');
      const closed = (ctx.holdings || []).filter((h) => h.status !== 'VERIFIED');
      if (!ctx.holdings?.length) return "You haven't contributed to any project yet, so there's nothing to withdraw.";
      let msg = 'You can take back up to what you put in, but only while a project is still raising. Open the project and press "Withdraw"; the money returns to your wallet instantly.';
      if (open.length) msg += ` You can still withdraw from: ${open.map((h) => `${h.title} (${inr(h.mine)})`).join(', ')}.`;
      if (closed.length) msg += ` ${closed.map((h) => h.title).join(', ')} ${closed.length === 1 ? 'has' : 'have'} reached the goal, so ${closed.length === 1 ? 'that contribution is' : 'those contributions are'} final.`;
      return msg;
    }
    case 'holdings':
      if (!backer) break;
      if (!ctx.holdings?.length) return "You haven't backed any projects yet. The Suggestions page can rank projects for your budget.";
      return `You're backing ${ctx.holdings.length} ${ctx.holdings.length === 1 ? 'project' : 'projects'}: ${ctx.holdings.map((h) => `${h.title}, ${inr(h.mine)} from you (${Math.floor((h.raised / h.goal) * 100)}% funded)`).join('; ')}.`;
    case 'suggest': {
      if (!backer) return 'Suggestions are for backer accounts.';
      const prefs = (await loadPreferences(db, user.id)) || { budget: Math.max(100, Math.min(ctx.balance || 5000, 50000)), risk: 'balanced', categories: [], horizonMonths: 12 };
      const r = await recommend(db, prefs);
      if (!r.picks.length) return 'There are no projects raising funds right now that fit, so I have nothing to suggest yet. Check back once new projects are approved.';
      const lines = r.picks.slice(0, 3).map((p, i) => `${i + 1}. ${p.title}: ${p.reasons[0].toLowerCase()}${p.suggestedAmount ? `, suggested ${inr(p.suggestedAmount)}` : ''}`);
      return `Based on a ${inr(prefs.budget)} budget and a ${prefs.risk} approach, these look strongest:\n${lines.join('\n')}\nOpen Suggestions to change your budget, interests or risk level and see what each share could buy. These rank funding progress and momentum, not financial returns.`;
    }
    case 'status': {
      if (!lead) {
        if (backer && ctx.holdings?.length) return `Here's where the projects you back stand: ${ctx.holdings.map((h) => `${h.title} is ${STATUS_WORDS[h.status]}`).join('; ')}.`;
        return 'New projects are reviewed by an administrator before they can raise money. Only approved projects appear on the Projects page.';
      }
      if (!ctx.projects?.length) return "You haven't submitted a project yet. Use \"Start a project\" to send one for review.";
      return ctx.projects.map((p) => {
        let s = `"${p.title}" is ${STATUS_WORDS[p.status]}`;
        if (p.status === 'VERIFIED') s += ` (${inr(p.raised)} of ${inr(p.goal)})`;
        if (p.status === 'REJECTED' && p.reviewNote) s += `. Reviewer's note: ${p.reviewNote}`;
        if (p.status === 'PENDING' && Number(p.docs) === 0) s += '. Tip: uploading quotes or permits helps the reviewer';
        return `${s}.`;
      }).join(' ');
    }
    case 'submit':
      if (!lead) return 'Projects are submitted by project-lead accounts. If you want to run one, create an account and choose "Run a project".';
      return 'Go to My projects and press "Start a project". You need a title, category, a one-line summary, a description of at least 80 characters, a goal between ₹1,000 and ₹5 crore and how many months it takes. Budget items are optional but reviewers look for them. After submitting, upload quotes or permits from the project page.';
    case 'payout': {
      if (!lead) return 'When a project reaches its goal it stops taking contributions and the project lead releases the funds to start work.';
      const funded = (ctx.projects || []).filter((p) => p.status === 'FUNDED');
      if (funded.length) return `${funded.map((p) => `"${p.title}"`).join(' and ')} reached the goal. Open it and press "Release funds" to move ${inr(funded.reduce((s, p) => s + p.raised, 0))} to your wallet. This closes the project and can't be undone.`;
      return 'You can release funds once a project reaches 100% of its goal. Right now none of your projects has.';
    }
    case 'docs':
      return 'Open the project page and use "Upload a document" in the Documents section. PDF, PNG, JPG, Word, Excel and text files up to 10 MB are accepted, 15 per project. Each file\'s fingerprint is written to the ledger. Documents can be removed only while the project is waiting for review or has changes requested.';
    case 'ledger':
      return 'Every contribution, withdrawal, approval and document is a block on the ledger, and each block includes the fingerprint of the one before it. On the Ledger page, "Check integrity" verifies the chain and confirms every wallet and project total matches. If anything was altered, payments pause until it is fixed.';
    case 'account':
      return 'Passwords need 8–64 characters with an uppercase letter, lowercase letter, number and symbol. After 5 wrong passwords an account locks for 15 minutes. You can change your name and password in Account settings. There is no email reset yet; if you are locked out or forgot your password, choose "No, I still need help" and an administrator can set a temporary password.';
    case 'fees':
      return 'CrowdFunding charges no fees. Contributions fund the project directly; they don\'t pay interest, dividends or returns.';
    case 'safety':
      return 'Every project is checked by an administrator before it can raise money, its budget and documents are public to signed-in users, and every rupee is recorded on a ledger you can verify yourself on the Ledger page. You can also withdraw your contribution while the project is still raising.';
    case 'inventory': {
      const matchedCat = CATEGORIES.find((c) => new RegExp(`\\b${c.replace('&', '(&|and)')}\\b`, 'i').test(text));
      const targetCategory = matchedCat || (backer && ctx.holdings?.[0]?.category) || (lead && ctx.projects?.[0]?.category) || 'Agriculture';
      const inv = await suggestInventories({ category: targetCategory, budget: ctx.balance || 50000 });
      const topItems = inv.items.slice(0, 3).map((it) => `• ${it.quantity}x ${it.itemName} (${inr(it.unitPrice)} each)`).join('\n');
      return `For ${targetCategory}, our AI inventory model recommends ${inv.items.length} key items (estimated ${inr(inv.totalEstimatedCost)} total):\n${topItems}\nExplore the Inventories page to customize quantities, view verified suppliers, or pre-fill your project's budget!`;
    }
    default:
      break;
  }
  return `Hello ${first}! I am the CrowdFunding Assistant. I'm here to help you navigate CrowdFunding—checking your wallet balance (${inr(ctx.balance)}), exploring active projects, managing contributions, and verifying ledger transactions. If you have a question or need help with a transaction, let me know, or choose "No, I still need help" below to speak with our support team!`;
}

/** Generate the assistant's reply to the latest message in `history`. */
export async function generateReply(db, user, history) {
  const ctx = await loadContext(db, user);
  const last = [...history].reverse().find((m) => m.sender === 'USER');
  if (aiEnabled()) {
    const text = await askAI(ctx, history);
    if (text) return { text, source: 'ai' };
  }
  return { text: await builtIn(db, user, ctx, last?.body || ''), source: 'builtin' };
}
