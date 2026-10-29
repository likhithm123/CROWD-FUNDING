import crypto from 'crypto';
import { promisify } from 'util';
import { query } from './db.js';

const scrypt = promisify(crypto.scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export const SESSION_DAYS = 7;
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(key, expected);
}

// A real hash to compare against when the email doesn't exist, so a login
// attempt for an unknown account takes the same time as a wrong password.
let dummyHash = null;
export async function getDummyHash() {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(12).toString('hex'));
  return dummyHash;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export async function createSession(userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token_hash, user_id, user_agent, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval)`,
    [sha256(token), userId, String(userAgent || '').slice(0, 255), String(SESSION_DAYS)]
  );
  return token;
}

export async function destroySession(token) {
  await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export async function destroyOtherSessions(userId, keepToken) {
  await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, sha256(keepToken)]);
}

export function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    balance: Number(u.balance),
    isActive: u.is_active,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

function readToken(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** Attaches req.user and req.token, or responds 401. */
export async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return next(new HttpError(401, 'Sign in to continue.'));
  const { rows } = await query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [sha256(token)]
  );
  const user = rows[0];
  if (!user) return next(new HttpError(401, 'Your session has ended. Sign in again.'));
  if (!user.is_active) {
    await destroySession(token);
    return next(new HttpError(403, 'This account has been deactivated. Contact support.'));
  }
  req.user = user;
  req.token = token;
  next();
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return next(new HttpError(403, 'Your account doesn’t have access to this.'));
  }
  next();
};

/**
 * Simple fixed-window limiter kept in memory. Good enough for a single server;
 * swap for Redis if you run several instances.
 */
export function rateLimit({ windowMs, max, message }) {
  // Automated test runs create many accounts from one machine. Never set this in production.
  if (process.env.DISABLE_RATE_LIMIT === 'true') return (req, res, next) => next();
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset < now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', Math.ceil((entry.reset - now) / 1000));
      return next(new HttpError(429, message));
    }
    next();
  };
}
