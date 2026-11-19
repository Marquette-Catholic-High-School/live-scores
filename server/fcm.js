// Firebase Cloud Messaging (HTTP v1 API) for the one notification this server
// sends outside APNs: "the radio is live" (ARCHITECTURE.md §12), to a topic the
// iOS app subscribes to from its Notification Settings. Everything else the app
// gets from Firebase is sent elsewhere; Live Activities stay on APNs (§8).
//
// Auth: a Google service account key (the JSON file Firebase console →
// Project settings → Service accounts → Generate new private key). The server
// signs an RS256 JWT with it and trades that for an OAuth access token, cached
// until shortly before it expires. No dependencies: node:crypto and fetch.

import { createPrivateKey, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isPlainObject } from './validate.js';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const FCM_ORIGIN = 'https://fcm.googleapis.com';
const TOKEN_LIFETIME_S = 3600;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const base64url = (value) => Buffer.from(value).toString('base64url');

class FcmError extends Error {
  constructor(message, { status = null, retry = false } = {}) {
    super(message);
    this.name = 'FcmError';
    this.status = status;
    this.retry = retry;
  }
}

// Reads Google's error body: { error: { code, message, status } } (FCM) or
// { error, error_description } (the token endpoint).
function errorMessage(status, text) {
  try {
    const body = JSON.parse(text);
    const detail = isPlainObject(body.error) ? body.error.message ?? body.error.status : body.error_description ?? body.error;
    if (detail) return `HTTP ${status}: ${detail}`;
  } catch {
    // not JSON
  }
  return `HTTP ${status}`;
}

export class FcmClient {
  #account = null;
  #key = null;
  #token = null;
  #fetch;
  #now;
  #log;
  #retryDelaysMs;
  configured = false;
  error = null;

  // `serviceAccount` (an already-parsed key) is for tests.
  constructor({ serviceAccountPath, serviceAccount, fetch = globalThis.fetch, now = Date.now, log, retryDelaysMs = [2000, 10_000] } = {}) {
    this.#fetch = fetch;
    this.#now = now;
    this.#log = log;
    this.#retryDelaysMs = retryDelaysMs;
    if (!serviceAccountPath && !serviceAccount) {
      this.error = 'FCM_SERVICE_ACCOUNT_PATH is not set.';
      return;
    }
    try {
      const account = serviceAccount ?? JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
      for (const field of ['project_id', 'client_email', 'private_key']) {
        if (typeof account?.[field] !== 'string' || account[field] === '') throw new Error(`it has no "${field}" (is it a service account key?)`);
      }
      this.#key = createPrivateKey(account.private_key);
      this.#account = { projectId: account.project_id, clientEmail: account.client_email, tokenUri: account.token_uri || DEFAULT_TOKEN_URI };
      this.configured = true;
    } catch (err) {
      this.error = `Couldn't load the Firebase service account key: ${err.message}`;
    }
  }

  get projectId() {
    return this.#account?.projectId ?? null;
  }

  status() {
    return this.configured ? { configured: true, projectId: this.projectId } : { configured: false, projectId: null, error: this.error };
  }

  // Sends one message ({ topic, notification, data, apns }). Retries network
  // errors, 429 and 5xx; a rejected access token is renewed once. Resolves to
  // { ok: true, name } or { ok: false, error } — never throws.
  async send(message) {
    if (!this.configured) return { ok: false, error: `Firebase isn't set up: ${this.error}` };
    let renewed = false;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const name = await this.#post(message);
        return { ok: true, name };
      } catch (err) {
        if ((err.status === 401 || err.status === 403) && !renewed) {
          renewed = true;
          this.#token = null;
          attempt -= 1;
          continue;
        }
        const retry = err.retry || !(err instanceof FcmError);
        if (!retry || attempt >= this.#retryDelaysMs.length) return { ok: false, error: err.message };
        this.#log?.warn('FCM send failed; retrying', { error: err.message, attempt: attempt + 1 });
        await new Promise((resolve) => setTimeout(resolve, this.#retryDelaysMs[attempt]));
      }
    }
  }

  async #post(message) {
    const token = await this.#accessToken();
    const res = await this.#fetch(`${FCM_ORIGIN}/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new FcmError(errorMessage(res.status, text), { status: res.status, retry: res.status === 429 || res.status >= 500 });
    try {
      return JSON.parse(text).name ?? null;
    } catch {
      return null;
    }
  }

  async #accessToken() {
    const now = this.#now();
    if (this.#token && this.#token.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return this.#token.value;

    const iat = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({ iss: this.#account.clientEmail, scope: SCOPE, aud: this.#account.tokenUri, iat, exp: iat + TOKEN_LIFETIME_S }));
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(this.#key).toString('base64url');

    const res = await this.#fetch(this.#account.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new FcmError(`Google sign-in failed: ${errorMessage(res.status, text)}`, { status: res.status === 401 ? 400 : res.status, retry: res.status === 429 || res.status >= 500 });
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new FcmError('Google sign-in failed: the response was not JSON.', { retry: true });
    }
    if (typeof body.access_token !== 'string') throw new FcmError('Google sign-in failed: no access token in the response.', { retry: true });
    const lifetimeMs = (Number.isFinite(body.expires_in) ? body.expires_in : TOKEN_LIFETIME_S) * 1000;
    this.#token = { value: body.access_token, expiresAt: now + lifetimeMs };
    return this.#token.value;
  }
}
