// User administration shared by the admin API and the CLI. Enforces the
// "can't remove yourself" and "keep at least one enabled admin" rules.

import { hashPassword, userView, validatePassword } from './auth.js';
import { badRequest, conflict, notFound } from './errors.js';
import { boolean, oneOf, string } from './validate.js';

export const ROLES = Object.freeze(['admin', 'scorekeeper']);
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

export function adminUserView(row) {
  return { ...userView(row), disabled: row.disabled === 1, createdAt: row.created_at };
}

export function validateUsername(value) {
  if (typeof value !== 'string') throw badRequest('username must be a string.');
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw badRequest('username must be 3–32 characters: letters, digits, ".", "_" or "-".');
  }
  return username;
}

export function validateDisplayName(value) {
  return string(value, 'displayName', { min: 1, max: 60 });
}

export class UserService {
  #db;
  #now;
  #log;

  constructor({ db, now = Date.now, log }) {
    this.#db = db;
    this.#now = now;
    this.#log = log;
  }

  list() {
    return this.#db.all('SELECT * FROM users ORDER BY username COLLATE NOCASE');
  }

  get(id) {
    return this.#db.get('SELECT * FROM users WHERE id = ?', id) ?? null;
  }

  getByUsername(username) {
    return this.#db.get('SELECT * FROM users WHERE username = ?', String(username).trim()) ?? null;
  }

  #require(id) {
    const row = Number.isSafeInteger(id) ? this.get(id) : null;
    if (!row) throw notFound('User not found.');
    return row;
  }

  #otherEnabledAdmins(excludeId) {
    return this.#db.get(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?",
      excludeId,
    ).n;
  }

  async create(input) {
    const username = validateUsername(input.username);
    const displayName = validateDisplayName(input.displayName);
    validatePassword(input.password);
    const role = oneOf(input.role, 'role', ROLES);
    const passwordHash = await hashPassword(input.password);
    const now = this.#now();
    return this.#db.transaction(() => {
      if (this.getByUsername(username)) throw conflict('That username is already taken.');
      const { lastInsertRowid } = this.#db.run(
        'INSERT INTO users (username, display_name, password_hash, role, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
        username, displayName, passwordHash, role, now, now,
      );
      this.#log?.info('user created', { userId: Number(lastInsertRowid), username, role });
      return this.get(Number(lastInsertRowid));
    });
  }

  // `actor` is the admin making the change (null from the CLI);
  // `currentSessionId` survives a self password change.
  async update(id, patch, { actor = null, currentSessionId = null } = {}) {
    const changes = {};
    if (patch.displayName !== undefined) changes.display_name = validateDisplayName(patch.displayName);
    if (patch.role !== undefined) changes.role = oneOf(patch.role, 'role', ROLES);
    if (patch.disabled !== undefined) changes.disabled = boolean(patch.disabled, 'disabled') ? 1 : 0;
    if (patch.password !== undefined) {
      validatePassword(patch.password);
      changes.password_hash = await hashPassword(patch.password);
    }

    return this.#db.transaction(() => {
      const target = this.#require(id);
      const demotes = changes.role !== undefined && changes.role !== 'admin' && target.role === 'admin';
      const disables = changes.disabled === 1 && target.disabled === 0;
      if (actor && actor.id === target.id && (demotes || disables)) {
        throw conflict("You can't demote or disable your own account.");
      }
      if (target.role === 'admin' && target.disabled === 0 && (demotes || disables) && this.#otherEnabledAdmins(target.id) === 0) {
        throw conflict('At least one enabled admin account is required.');
      }

      const columns = Object.keys(changes);
      if (columns.length) {
        const assignments = columns.map((column) => `${column} = ?`).join(', ');
        this.#db.run(`UPDATE users SET ${assignments}, updated_at = ? WHERE id = ?`, ...columns.map((c) => changes[c]), this.#now(), id);
      }
      if (changes.password_hash !== undefined || disables) {
        const keep = actor && actor.id === target.id ? currentSessionId : null;
        this.revokeSessions(id, keep);
      }
      if (columns.length) {
        const fields = Object.keys(patch).filter((key) => patch[key] !== undefined);
        this.#log?.info('user updated', { userId: id, fields, by: actor?.id ?? 'cli' });
      }
      return this.get(id);
    });
  }

  async setPassword(id, password) {
    return this.update(id, { password });
  }

  delete(id, { actor = null } = {}) {
    this.#db.transaction(() => {
      const target = this.#require(id);
      if (actor && actor.id === target.id) throw conflict("You can't delete your own account.");
      if (target.role === 'admin' && target.disabled === 0 && this.#otherEnabledAdmins(target.id) === 0) {
        throw conflict('At least one enabled admin account is required.');
      }
      this.#db.run('DELETE FROM users WHERE id = ?', id);
      this.#log?.info('user deleted', { userId: id, username: target.username, by: actor?.id ?? 'cli' });
    });
  }

  revokeSessions(userId, exceptSessionId = null) {
    if (exceptSessionId) this.#db.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, exceptSessionId);
    else this.#db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }
}
