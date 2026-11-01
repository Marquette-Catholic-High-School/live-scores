// Passwords (scrypt), sessions (opaque tokens, only their SHA-256 stored),
// cookie/bearer resolution, CSRF header rule and login throttling
// (ARCHITECTURE.md §7 Authentication, §10).

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { badRequest, forbidden, rateLimited, unauthorized } from './errors.js';
import { RateLimiter } from './ratelimit.js';

const scryptAsync = promisify(scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 1024;

export const SESSION_COOKIE = 'mchs_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
export const CSRF_HEADER = 'x-mchs-client';
export const CSRF_HEADER_VALUE = 'web';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
// Higher per address: a whole school shares one public IP, and a few people
// mistyping their passwords must not lock the scorekeepers out.
const LOGIN_MAX_FAILURES_PER_IP = 50;
// scrypt runs on libuv's small thread pool, which static file serving also
// uses; a flood of sign-in attempts must not starve it.
const MAX_CONCURRENT_VERIFICATIONS = 2;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

class Semaphore {
  #free;
  #queue = [];

  constructor(size) {
    this.#free = size;
  }

  async run(fn) {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise((resolve) => this.#queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const hash = await scryptAsync(password.normalize('NFC'), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  // Bound the parameters so a corrupted row cannot make verification hang.
  if (!Number.isInteger(N) || N < 2 || N > 2 ** 20 || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length < 16) return false;
  const actual = await scryptAsync(password.normalize('NFC'), salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM * 4 });
  return timingSafeEqual(expected, actual);
}

export function validatePassword(password, field = 'password') {
  if (typeof password !== 'string') throw badRequest(`${field} must be a string.`);
  if ([...password].length < PASSWORD_MIN_LENGTH) throw badRequest(`${field} must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (password.length > PASSWORD_MAX_LENGTH) throw badRequest(`${field} must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  return password;
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!cookies.has(name)) {
      try {
        cookies.set(name, decodeURIComponent(value));
      } catch {
        cookies.set(name, value);
      }
    }
  }
  return cookies;
}

export function sessionCookie(token, { secure }) {
  return `${SESSION_COOKIE}=${token}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearedSessionCookie({ secure }) {
  return `${SESSION_COOKIE}=; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=0`;
}

export function isSafeMethod(method) {
  return SAFE_METHODS.has(method);
}

// Cookie-authenticated writes must carry `X-MCHS-Client: web`: a cross-site
// form cannot set custom headers, and a cross-site fetch that does would need
// a CORS preflight this server never grants.
export function passesCsrfCheck(req, via) {
  if (via !== 'cookie' || isSafeMethod(req.method)) return true;
  return req.headers[CSRF_HEADER] === CSRF_HEADER_VALUE;
}

export function userView(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

export class AuthService {
  #db;
  #now;
  #log;
  #ipFailures;
  #userFailures;
  #sourceFailures;
  #passwordFailures;
  #verifications = new Semaphore(MAX_CONCURRENT_VERIFICATIONS);
  #dummyHash = null;

  constructor({ db, now = Date.now, log }) {
    this.#db = db;
    this.#now = now;
    this.#log = log;
    const limiter = (limit = LOGIN_MAX_FAILURES) => new RateLimiter({ limit, windowMs: LOGIN_WINDOW_MS, now });
    this.#ipFailures = limiter(LOGIN_MAX_FAILURES_PER_IP);
    this.#userFailures = limiter();
    this.#sourceFailures = limiter();
    this.#passwordFailures = limiter();
  }

  // Equalizes response time for unknown usernames.
  async #dummyVerify(password) {
    this.#dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(password, this.#dummyHash);
  }

  // `ipKey` is the client's rate-limit key (an IPv6 /64), `ip` is for logs.
  async login({ username, password, client, ip, ipKey = ip }) {
    if (typeof username !== 'string' || username.trim() === '' || username.length > 64) {
      throw badRequest('username is required.');
    }
    if (typeof password !== 'string' || password === '' || password.length > PASSWORD_MAX_LENGTH) {
      throw badRequest('password is required.');
    }
    if (client !== 'web' && client !== 'ios') throw badRequest('client must be "web" or "ios".');

    const userKey = username.trim().toLowerCase();
    const sourceKey = JSON.stringify([userKey, ipKey]);
    const ipState = this.#ipFailures.exhausted(ipKey);
    const userState = this.#userFailures.exhausted(userKey);
    // A username with too many failures is locked only for the sources that
    // failed on it, so guesses from elsewhere can't lock the real user out.
    const userLocked = userState.exhausted && this.#sourceFailures.count(sourceKey) > 0;
    if (ipState.exhausted || userLocked) {
      throw rateLimited('Too many failed sign-in attempts. Try again later.', Math.max(ipState.retryAfterSec, userLocked ? userState.retryAfterSec : 0));
    }

    // Count the attempt before the slow scrypt, so concurrent guesses can't
    // all pass the check above; a successful sign-in takes it back.
    this.#ipFailures.hit(ipKey);
    this.#userFailures.hit(userKey);
    this.#sourceFailures.hit(sourceKey);

    const row = this.#db.get('SELECT * FROM users WHERE username = ?', userKey);
    let valid = false;
    if (row) valid = await this.#verifications.run(() => verifyPassword(password, row.password_hash));
    else await this.#verifications.run(() => this.#dummyVerify(password));

    if (!valid) {
      this.#log?.info('login failed', { username: userKey, ip });
      throw unauthorized('Incorrect username or password.');
    }
    this.#ipFailures.refund(ipKey);
    this.#userFailures.refund(userKey);
    this.#sourceFailures.reset(sourceKey);
    if (row.disabled) throw forbidden('This account is disabled.');

    const session = this.createSession(row.id, client);
    this.#log?.info('login', { userId: row.id, username: row.username, client, ip });
    return { user: userView(row), token: session.token, sessionId: session.id };
  }

  createSession(userId, client) {
    const token = randomBytes(32).toString('base64url');
    const id = hashToken(token);
    const now = this.#now();
    this.#db.run(
      'INSERT INTO sessions (id, user_id, client, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, userId, client, now, now, now + SESSION_TTL_MS,
    );
    return { token, id };
  }

  // Finds the credentials on a request. Bearer wins over the cookie.
  // Returns { status: 'none' | 'invalid' | 'ok', via, user, sessionId, refreshed }.
  // `touch: false` checks the session without sliding its expiry.
  resolve(req, { touch = true } = {}) {
    let token;
    let via;
    const authorization = req.headers.authorization;
    if (typeof authorization === 'string') {
      const match = /^Bearer\s+([A-Za-z0-9_-]{16,128})\s*$/i.exec(authorization);
      if (match) {
        token = match[1];
        via = 'bearer';
      } else if (/^Bearer\s/i.test(authorization)) {
        return { status: 'invalid', via: 'bearer' };
      }
    }
    if (!token) {
      const cookie = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (cookie) {
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(cookie)) return { status: 'invalid', via: 'cookie' };
        token = cookie;
        via = 'cookie';
      }
    }
    if (!token) return { status: 'none' };

    const now = this.#now();
    const row = this.#db.get(
      `SELECT s.id AS session_id, s.last_used_at, s.expires_at,
              u.id, u.username, u.display_name, u.role, u.disabled
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
      hashToken(token),
    );
    if (!row) return { status: 'invalid', via };
    if (row.expires_at <= now || row.disabled) {
      this.#db.run('DELETE FROM sessions WHERE id = ?', row.session_id);
      return { status: 'invalid', via };
    }

    let refreshed = false;
    if (touch && now - row.last_used_at >= SESSION_TOUCH_INTERVAL_MS) {
      this.#db.run('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?', now, now + SESSION_TTL_MS, row.session_id);
      refreshed = true;
    }
    return { status: 'ok', via, token, user: userView(row), sessionId: row.session_id, refreshed };
  }

  revokeSession(sessionId) {
    this.#db.run('DELETE FROM sessions WHERE id = ?', sessionId);
  }

  // Whether a session still exists, is unexpired and its user enabled (used
  // to re-check long-lived SSE streams after sign-out, disable or reset).
  isSessionValid(sessionId) {
    const row = this.#db.get(
      'SELECT s.expires_at, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?',
      sessionId,
    );
    return Boolean(row) && row.expires_at > this.#now() && !row.disabled;
  }

  async changePassword(userId, sessionId, currentPassword, newPassword) {
    if (typeof currentPassword !== 'string' || currentPassword === '' || currentPassword.length > PASSWORD_MAX_LENGTH) {
      throw badRequest('currentPassword is required.');
    }
    validatePassword(newPassword, 'newPassword');
    const row = this.#db.get('SELECT password_hash FROM users WHERE id = ?', userId);
    if (!row) throw unauthorized();
    // A stolen session must not be able to guess the current password.
    const state = this.#passwordFailures.exhausted(userId);
    if (state.exhausted) throw rateLimited('Too many incorrect passwords. Try again later.', state.retryAfterSec);
    this.#passwordFailures.hit(userId);
    if (!(await this.#verifications.run(() => verifyPassword(currentPassword, row.password_hash)))) {
      throw forbidden('Current password is incorrect.');
    }
    this.#passwordFailures.reset(userId);
    const hash = await hashPassword(newPassword);
    const now = this.#now();
    this.#db.transaction(() => {
      this.#db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, now, userId);
      this.#db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, sessionId);
    });
    this.#log?.info('password changed', { userId });
  }
}
