import crypto from 'node:crypto';
import { db } from './db.js';

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(secret), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function verifySecret(secret, stored) {
  if (!stored) return false;
  const [, saltHex, keyHex] = stored.split('$');
  const key = crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(keyHex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(key, want);
}

const COOKIE = { admin: 'lend_adm', borrower: 'lend_bor' };
const TTL = { admin: 12 * 3600e3, borrower: 30 * 24 * 3600e3 };

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(res, req, kind, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,kind,user_id,expires_at) VALUES(?,?,?,?)').run(token, kind, userId, Date.now() + TTL[kind]);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE[kind]}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL[kind] / 1000}${secure}`);
}
export function destroySession(req, res, kind) {
  const t = parseCookies(req)[COOKIE[kind]];
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  res.setHeader('Set-Cookie', `${COOKIE[kind]}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
function sessionUser(req, kind) {
  const t = parseCookies(req)[COOKIE[kind]];
  if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=? AND kind=?').get(t, kind);
  if (!s || s.expires_at < Date.now()) return null;
  return s.user_id;
}
export const requireAdmin = (req, res, next) => {
  const id = sessionUser(req, 'admin');
  if (!id) return res.status(401).json({ error: 'Please log in' });
  req.adminId = id; next();
};
export const requireBorrower = (req, res, next) => {
  const id = sessionUser(req, 'borrower');
  if (!id) return res.status(401).json({ error: 'Please log in' });
  req.borrowerId = id; next();
};
export const optionalBorrower = req => sessionUser(req, 'borrower');

// Simple in-memory limiter for login attempts: max N per window per key
const hits = new Map();
export function rateLimit(key, max = 8, windowMs = 15 * 60e3) {
  const now = Date.now();
  const h = (hits.get(key) || []).filter(t => now - t < windowMs);
  h.push(now); hits.set(key, h);
  return h.length <= max;
}
setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some(t => now - t < 15 * 60e3)) hits.delete(k);
}, 3600e3).unref();

export function ensureAdmin() {
  const n = db.prepare('SELECT COUNT(*) c FROM admins').get().c;
  if (n) return;
  const user = process.env.ADMIN_USER || 'admin';
  let pass = process.env.ADMIN_PASSWORD;
  if (!pass) {
    pass = crypto.randomBytes(9).toString('base64url');
    console.log(`\n  First admin account created\n  username: ${user}\n  password: ${pass}\n  (set ADMIN_PASSWORD in .env to choose your own)\n`);
  }
  db.prepare('INSERT INTO admins(username,pass_hash) VALUES(?,?)').run(user, hashSecret(pass));
}
