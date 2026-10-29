import express from 'express';
import { query, withTransaction } from './db.js';
import { HttpError, requireAuth, requireRole } from './auth.js';
import { generateReply, aiEnabled } from './assistant.js';
import { recommend, savePreferences, loadPreferences, validatePreferences, summarize } from './recommend.js';

export const chat = express.Router();

const isStaff = (u) => u.role === 'SUPPORT' || u.role === 'ADMIN';
const isCustomer = (u) => u.role === 'INVESTOR' || u.role === 'MANAGER';

// Per-user limit on messages so the assistant can't be flooded.
const recent = new Map();
function throttle(userId) {
  const now = Date.now();
  const list = (recent.get(userId) || []).filter((t) => now - t < 5 * 60 * 1000);
  if (list.length >= 40) throw new HttpError(429, 'You’re sending messages very quickly. Wait a few minutes and try again.');
  list.push(now);
  recent.set(userId, list);
}

function cleanBody(raw, field = 'Message') {
  const body = String(raw ?? '').trim();
  if (!body) throw new HttpError(400, `${field} can’t be empty.`);
  if (body.length > 2000) throw new HttpError(400, `${field} must be 2,000 characters or fewer.`);
  return body;
}

const SUMMARY = `
  SELECT c.*, u.name AS user_name, u.email AS user_email, u.role AS user_role, a.name AS assigned_name,
    (SELECT COUNT(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count,
    (SELECT body FROM conversation_messages m WHERE m.conversation_id = c.id AND m.sender <> 'SYSTEM' ORDER BY m.id DESC LIMIT 1) AS last_message
  FROM conversations c JOIN users u ON u.id = c.user_id LEFT JOIN users a ON a.id = c.assigned_to`;

function shapeSummary(c) {
  return {
    id: c.id, subject: c.subject, status: c.status, userName: c.user_name, userEmail: c.user_email, userRole: c.user_role,
    assignedName: c.assigned_name, messageCount: c.message_count, lastMessage: c.last_message,
    escalatedAt: c.escalated_at, resolvedAt: c.resolved_at, createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

async function loadConversation(id, user) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) throw new HttpError(404, 'Conversation not found.');
  const { rows } = await query(`${SUMMARY} WHERE c.id = $1`, [n]);
  const c = rows[0];
  if (!c || (!isStaff(user) && c.user_id !== user.id)) throw new HttpError(404, 'Conversation not found.');
  return c;
}

async function fullConversation(c, user) {
  const { rows } = await query(
    `SELECT m.*, u.name AS author_name FROM conversation_messages m LEFT JOIN users u ON u.id = m.author_id
     WHERE conversation_id = $1 ORDER BY m.id`, [c.id]);
  const pending = [...rows].reverse().find((m) => m.asks_feedback && !m.feedback);
  return {
    ...shapeSummary(c),
    isOwner: c.user_id === user.id,
    awaitingFeedbackOn: pending && pending.id === rows[rows.length - 1].id ? pending.id : null,
    messages: rows.map((m) => ({
      id: m.id, sender: m.sender, body: m.body, source: m.source, authorName: m.sender === 'SUPPORT' ? m.author_name : null,
      asksFeedback: m.asks_feedback, feedback: m.feedback, createdAt: m.created_at,
    })),
  };
}

async function history(convId) {
  const { rows } = await query('SELECT sender, body FROM conversation_messages WHERE conversation_id = $1 ORDER BY id', [convId]);
  return rows;
}

async function addBotReply(convId, user) {
  const reply = await generateReply({ query }, user, await history(convId));
  await query(
    `INSERT INTO conversation_messages (conversation_id, sender, body, source, asks_feedback) VALUES ($1, 'BOT', $2, $3, TRUE)`,
    [convId, reply.text, reply.source]);
}

// ---------------------------------------------------------------- routes
chat.get('/api/assistant/status', requireAuth, (req, res) => res.json({ ai: aiEnabled() }));

chat.get('/api/conversations', requireAuth, async (req, res) => {
  const scope = req.query.scope;
  let where = 'WHERE c.user_id = $1';
  const params = [req.user.id];
  if (isStaff(req.user) && scope !== 'mine') {
    params.length = 0;
    where = {
      queue: `WHERE c.status IN ('ESCALATED', 'WITH_SUPPORT')`,
      waiting: `WHERE c.status = 'ESCALATED'`,
      closed: `WHERE c.status IN ('CLOSED', 'RESOLVED')`,
      bot: `WHERE c.status = 'BOT'`,
    }[scope] || '';
  }
  const { rows } = await query(
    `${SUMMARY} ${where} ORDER BY CASE c.status WHEN 'ESCALATED' THEN 0 WHEN 'WITH_SUPPORT' THEN 1 WHEN 'BOT' THEN 2 ELSE 3 END,
     c.updated_at DESC LIMIT 300`, params);
  const { rows: counts } = await query(`SELECT status, COUNT(*) FROM conversations GROUP BY status`);
  res.json({
    conversations: rows.map(shapeSummary),
    counts: isStaff(req.user) ? Object.fromEntries(counts.map((r) => [r.status, r.count])) : undefined,
  });
});

chat.post('/api/conversations', requireAuth, async (req, res) => {
  if (!isCustomer(req.user)) throw new HttpError(403, 'Staff accounts answer conversations rather than start them.');
  throttle(req.user.id);
  const body = cleanBody(req.body.message);
  const { rows: open } = await query(`SELECT COUNT(*) FROM conversations WHERE user_id = $1 AND status IN ('BOT', 'ESCALATED', 'WITH_SUPPORT')`, [req.user.id]);
  if (open[0].count >= 15) throw new HttpError(400, 'You have 15 open conversations. Mark some as resolved before starting another.');

  const subject = body.length > 80 ? `${body.slice(0, 77).trimEnd()}…` : body;
  const id = await withTransaction(async (client) => {
    const { rows } = await client.query('INSERT INTO conversations (user_id, subject) VALUES ($1, $2) RETURNING id', [req.user.id, subject]);
    await client.query(`INSERT INTO conversation_messages (conversation_id, sender, author_id, body) VALUES ($1, 'USER', $2, $3)`, [rows[0].id, req.user.id, body]);
    return rows[0].id;
  });
  await addBotReply(id, req.user);
  await query('UPDATE conversations SET updated_at = NOW() WHERE id = $1', [id]);
  res.status(201).json(await fullConversation(await loadConversation(id, req.user), req.user));
});

chat.get('/api/conversations/:id', requireAuth, async (req, res) => {
  const c = await loadConversation(req.params.id, req.user);
  res.json(await fullConversation(c, req.user));
});

chat.post('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const c = await loadConversation(req.params.id, req.user);
  throttle(req.user.id);
  const body = cleanBody(req.body.body, 'Reply');

  if (c.user_id === req.user.id) {
    // Customer writing. With support involved, a person answers; otherwise the assistant does.
    const withSupport = c.status === 'ESCALATED' || c.status === 'WITH_SUPPORT';
    await query(`INSERT INTO conversation_messages (conversation_id, sender, author_id, body) VALUES ($1, 'USER', $2, $3)`, [c.id, req.user.id, body]);
    // Any unanswered feedback prompt is superseded by the new message.
    if (withSupport) {
      await query(`UPDATE conversations SET status = 'ESCALATED', updated_at = NOW() WHERE id = $1`, [c.id]);
    } else {
      await query(`UPDATE conversations SET status = 'BOT', resolved_at = NULL, updated_at = NOW() WHERE id = $1`, [c.id]);
      await addBotReply(c.id, req.user);
    }
  } else if (isStaff(req.user)) {
    if (c.status === 'BOT' || c.status === 'RESOLVED') {
      throw new HttpError(409, 'This conversation hasn’t been escalated to support.');
    }
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO conversation_messages (conversation_id, sender, author_id, body, asks_feedback) VALUES ($1, 'SUPPORT', $2, $3, TRUE)`,
        [c.id, req.user.id, body]);
      await client.query(
        `UPDATE conversations SET status = 'WITH_SUPPORT', assigned_to = COALESCE(assigned_to, $2), resolved_at = NULL, updated_at = NOW() WHERE id = $1`,
        [c.id, req.user.id]);
    });
  } else {
    throw new HttpError(404, 'Conversation not found.');
  }
  res.status(201).json(await fullConversation(await loadConversation(c.id, req.user), req.user));
});

chat.post('/api/conversations/:id/feedback', requireAuth, async (req, res) => {
  const c = await loadConversation(req.params.id, req.user);
  if (c.user_id !== req.user.id) throw new HttpError(403, 'Only the person who asked can say whether it’s resolved.');
  const resolved = req.body.resolved === true;
  const { rows } = await query(
    `SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`, [c.id]);
  const last = rows[0];
  if (!last || !last.asks_feedback || last.feedback) throw new HttpError(409, 'There’s no reply waiting for your answer.');

  await withTransaction(async (client) => {
    await client.query('UPDATE conversation_messages SET feedback = $1 WHERE id = $2', [resolved ? 'RESOLVED' : 'NOT_RESOLVED', last.id]);
    if (resolved) {
      await client.query(`UPDATE conversations SET status = $1, resolved_at = NOW(), updated_at = NOW() WHERE id = $2`,
        [last.sender === 'SUPPORT' ? 'CLOSED' : 'RESOLVED', c.id]);
      await client.query(`INSERT INTO conversation_messages (conversation_id, sender, body) VALUES ($1, 'SYSTEM', $2)`,
        [c.id, 'Marked as resolved. Write again any time if you need more help.']);
    } else if (last.sender === 'BOT') {
      await client.query(`UPDATE conversations SET status = 'ESCALATED', escalated_at = NOW(), updated_at = NOW() WHERE id = $1`, [c.id]);
      await client.query(`INSERT INTO conversation_messages (conversation_id, sender, body) VALUES ($1, 'SYSTEM', $2)`,
        [c.id, 'Passed to the support team with this whole conversation. A person will reply here. You can add more details below.']);
    } else {
      await client.query(`UPDATE conversations SET status = 'ESCALATED', updated_at = NOW() WHERE id = $1`, [c.id]);
      await client.query(`INSERT INTO conversation_messages (conversation_id, sender, body) VALUES ($1, 'SYSTEM', $2)`,
        [c.id, 'Marked as not resolved. The support team has been asked to follow up.']);
    }
  });
  res.json(await fullConversation(await loadConversation(c.id, req.user), req.user));
});

chat.post('/api/conversations/:id/escalate', requireAuth, async (req, res) => {
  const c = await loadConversation(req.params.id, req.user);
  if (c.user_id !== req.user.id) throw new HttpError(403, 'Only the person who asked can escalate.');
  if (c.status === 'ESCALATED' || c.status === 'WITH_SUPPORT') throw new HttpError(409, 'The support team already has this conversation.');
  await withTransaction(async (client) => {
    await client.query(`UPDATE conversation_messages SET feedback = 'NOT_RESOLVED' WHERE conversation_id = $1 AND asks_feedback AND feedback IS NULL`, [c.id]);
    await client.query(`UPDATE conversations SET status = 'ESCALATED', escalated_at = NOW(), resolved_at = NULL, updated_at = NOW() WHERE id = $1`, [c.id]);
    await client.query(`INSERT INTO conversation_messages (conversation_id, sender, body) VALUES ($1, 'SYSTEM', $2)`,
      [c.id, 'Passed to the support team with this whole conversation. A person will reply here.']);
  });
  res.json(await fullConversation(await loadConversation(c.id, req.user), req.user));
});

chat.post('/api/conversations/:id/close', requireAuth, requireRole('SUPPORT', 'ADMIN'), async (req, res) => {
  const c = await loadConversation(req.params.id, req.user);
  if (c.status === 'CLOSED' || c.status === 'RESOLVED') throw new HttpError(409, 'This conversation is already resolved.');
  await withTransaction(async (client) => {
    await client.query(`UPDATE conversations SET status = 'CLOSED', resolved_at = NOW(), assigned_to = COALESCE(assigned_to, $2), updated_at = NOW() WHERE id = $1`, [c.id, req.user.id]);
    await client.query(`INSERT INTO conversation_messages (conversation_id, sender, body) VALUES ($1, 'SYSTEM', $2)`,
      [c.id, `${req.user.name} from the support team marked this as resolved.`]);
  });
  res.json(await fullConversation(await loadConversation(c.id, req.user), req.user));
});

// ---------------------------------------------------------------- suggestions
chat.get('/api/recommendations', requireAuth, requireRole('INVESTOR'), async (req, res) => {
  const prefs = await loadPreferences({ query }, req.user.id);
  if (!prefs) return res.json({ preferences: null, ai: aiEnabled() });
  const result = await recommend({ query }, prefs);
  res.json({ preferences: prefs, ...result, summary: await summarize(prefs, result), ai: aiEnabled() });
});

chat.post('/api/recommendations', requireAuth, requireRole('INVESTOR'), async (req, res) => {
  const { errors, value } = validatePreferences(req.body);
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0], errors);
  await savePreferences({ query }, req.user.id, value);
  const result = await recommend({ query }, value);
  res.json({ preferences: value, ...result, summary: await summarize(value, result), ai: aiEnabled() });
});
