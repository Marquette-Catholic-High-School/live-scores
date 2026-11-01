// APNs client: token auth (ES256 JWT), long-lived HTTP/2 sessions, Live
// Activity device pushes, broadcast pushes and broadcast-channel management.
// Hosts, ports, paths and headers follow RESEARCH.md / ARCHITECTURE.md §8.4.
// Every method resolves to a result object; none throws on APNs or network
// failure, so callers can never crash on a push.

import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';

export const APNS_ORIGINS = Object.freeze({
  production: Object.freeze({
    push: 'https://api.push.apple.com:443',
    manage: 'https://api-manage-broadcast.push.apple.com:2196',
  }),
  sandbox: Object.freeze({
    push: 'https://api.sandbox.push.apple.com:443',
    manage: 'https://api-manage-broadcast.sandbox.push.apple.com:2195',
  }),
});

export const DEVICE_PAYLOAD_LIMIT = 4096;
export const BROADCAST_PAYLOAD_LIMIT = 5120;

const TOKEN_REFRESH_SEC = 50 * 60;
const TOKEN_MIN_AGE_FOR_FORCED_REFRESH_SEC = 20 * 60;

// The device token is dead: stop sending to it.
export const INVALID_TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered', 'ExpiredToken']);

// Configuration problems (key, team, topic, capability). Logged loudly; a
// push-to-start fan-out stops at the first one instead of failing N times.
export const SETUP_ERROR_REASONS = new Set([
  'FeatureNotEnabled',
  'TopicDisallowed',
  'BadTopic',
  'MissingTopic',
  'BadEnvironmentKeyIdInToken',
  'InvalidProviderToken',
  'MissingProviderToken',
  'ExpiredProviderToken',
  'TooManyProviderTokenUpdates',
  'BadCertificate',
  'BadCertificateEnvironment',
  'Forbidden',
]);

export const CHANNEL_GONE_REASONS = new Set(['ChannelNotRegistered', 'BadChannelId']);

const RETRYABLE_STREAM_CODES = new Set([
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_INVALID_SESSION',
  'ERR_HTTP2_STREAM_CANCEL',
  'NGHTTP2_REFUSED_STREAM',
  'ECONNRESET',
]);

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Deliberately not unref'd: a request waiting out a reconnect backoff must keep
// a short-lived process (the CLI's apns-check) alive until it has a result.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- provider token ---------------------------------------------------------

export class ProviderToken {
  #key;
  #teamId;
  #keyId;
  #now;
  #token = null;
  #issuedAt = 0;

  constructor({ key, teamId, keyId, now = Date.now }) {
    this.#key = key;
    this.#teamId = teamId;
    this.#keyId = keyId;
    this.#now = now;
  }

  get issuedAt() {
    return this.#issuedAt;
  }

  // Cached for 50 minutes (Apple: refresh no more than every 20, no less
  // than every 60). `force` re-mints early only if the token is ≥ 20 min old.
  get({ force = false } = {}) {
    const nowSec = Math.floor(this.#now() / 1000);
    const age = nowSec - this.#issuedAt;
    if (!this.#token || age >= TOKEN_REFRESH_SEC || age < 0 || (force && age >= TOKEN_MIN_AGE_FOR_FORCED_REFRESH_SEC)) {
      const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.#keyId }));
      const claims = base64url(JSON.stringify({ iss: this.#teamId, iat: nowSec }));
      const input = `${header}.${claims}`;
      const signature = sign('sha256', Buffer.from(input), { key: this.#key, dsaEncoding: 'ieee-p1363' });
      this.#token = `${input}.${signature.toString('base64url')}`;
      this.#issuedAt = nowSec;
    }
    return this.#token;
  }
}

export function loadSigningKey(pem) {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('APNs key must be an EC P-256 (.p8) private key');
  }
  return key;
}

// ---- HTTP/2 transport ---------------------------------------------------------

// One session per origin, reused for every request. Dead sessions (goaway,
// error, close, frame error, failed ping) are dropped and lazily reconnected
// with exponential backoff. Until the first request on a new session has
// completed APNs allows a single stream, so others wait for it.
export class Http2Transport {
  #sessions = new Map();
  #backoff = new Map();
  #log;
  #requestTimeoutMs;
  #idlePingMs;
  #pingTimer;
  #closed = false;

  constructor({ log, requestTimeoutMs = 15_000, idlePingMs = 10 * 60_000, pingCheckMs = 60_000 } = {}) {
    this.#log = log;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#idlePingMs = idlePingMs;
    this.#pingTimer = setInterval(() => this.#pingIdle(), pingCheckMs);
    this.#pingTimer.unref();
  }

  get sessionCount() {
    return this.#sessions.size;
  }

  async #entry(origin) {
    const existing = this.#sessions.get(origin);
    if (existing && !existing.session.closed && !existing.session.destroyed) return existing;
    if (existing) this.#sessions.delete(origin);

    const backoff = this.#backoff.get(origin);
    if (backoff && backoff.nextAttemptAt > Date.now()) await sleep(backoff.nextAttemptAt - Date.now());
    if (this.#closed) throw Object.assign(new Error('APNs transport is closed'), { code: 'ERR_TRANSPORT_CLOSED' });
    const raced = this.#sessions.get(origin);
    if (raced && !raced.session.closed && !raced.session.destroyed) return raced;

    const session = http2.connect(origin);
    const entry = { session, warm: false, warmup: null, lastActivity: Date.now(), connected: false };
    const drop = () => {
      if (this.#sessions.get(origin) === entry) this.#sessions.delete(origin);
    };
    session.on('connect', () => {
      entry.connected = true;
      this.#backoff.delete(origin);
    });
    session.on('goaway', (errorCode, lastStreamId) => {
      this.#log?.info('APNs session received GOAWAY', { origin, errorCode, lastStreamId });
      // Streams above lastStreamId were not processed by APNs (safe to retry).
      entry.goawayLastStreamId = lastStreamId;
      drop();
    });
    session.on('frameError', (type, code) => {
      this.#log?.warn('APNs session frame error', { origin, type, code });
      drop();
      session.destroy();
    });
    session.on('error', (err) => {
      this.#log?.warn('APNs session error', { origin, err: err.message, code: err.code });
      drop();
      if (!entry.connected) {
        const failures = (this.#backoff.get(origin)?.failures ?? 0) + 1;
        this.#backoff.set(origin, { failures, nextAttemptAt: Date.now() + Math.min(30_000, 500 * 2 ** (failures - 1)) });
      }
    });
    session.on('close', drop);
    this.#sessions.set(origin, entry);
    return entry;
  }

  #pingIdle() {
    const now = Date.now();
    for (const [origin, entry] of this.#sessions) {
      if (now - entry.lastActivity < this.#idlePingMs || entry.pinging) continue;
      entry.pinging = true;
      const timer = setTimeout(() => {
        this.#log?.warn('APNs ping timed out; reconnecting lazily', { origin });
        if (this.#sessions.get(origin) === entry) this.#sessions.delete(origin);
        entry.session.destroy();
      }, 10_000);
      timer.unref();
      try {
        entry.session.ping((err) => {
          clearTimeout(timer);
          entry.pinging = false;
          entry.lastActivity = Date.now();
          if (err) {
            if (this.#sessions.get(origin) === entry) this.#sessions.delete(origin);
            entry.session.destroy();
          }
        });
      } catch {
        clearTimeout(timer);
        if (this.#sessions.get(origin) === entry) this.#sessions.delete(origin);
        entry.session.destroy();
      }
    }
  }

  async request(req) {
    try {
      return await this.#requestOnce(req);
    } catch (err) {
      if (!RETRYABLE_STREAM_CODES.has(err.code)) throw err;
      this.#log?.debug('retrying APNs request', { path: req.path, code: err.code });
      return this.#requestOnce(req);
    }
  }

  async #requestOnce({ origin, method, path, headers = {}, body }) {
    const entry = await this.#entry(origin);
    let isWarmup = false;
    if (!entry.warm) {
      if (entry.warmup) await entry.warmup;
      else {
        isWarmup = true;
        entry.warmup = new Promise((resolve) => {
          entry.finishWarmup = resolve;
        });
      }
    }
    entry.lastActivity = Date.now();
    try {
      return await this.#stream(entry, { method, path, headers, body });
    } finally {
      if (isWarmup) {
        entry.warm = true;
        entry.finishWarmup();
      }
    }
  }

  #stream(entry, { method, path, headers, body }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let status = 0;
      let responseHeaders = {};
      let data = '';
      let timer = null;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.lastActivity = Date.now();
        if (err) reject(err);
        else resolve(value);
      };

      let stream;
      try {
        stream = entry.session.request({ ':method': method, ':path': path, ...headers }, { endStream: body === undefined });
      } catch (err) {
        finish(err);
        return;
      }
      timer = setTimeout(() => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        finish(Object.assign(new Error('APNs request timed out'), { code: 'ETIMEDOUT' }));
      }, this.#requestTimeoutMs);

      stream.setEncoding('utf8');
      stream.on('response', (h) => {
        status = Number(h[':status']);
        responseHeaders = h;
      });
      stream.on('data', (chunk) => {
        data += chunk;
      });
      stream.on('end', () => {
        if (status) finish(null, { status, headers: responseHeaders, body: data });
        // The connection went away mid-request: a network failure, not a reply.
        else finish(Object.assign(new Error('APNs stream ended without a response'), { code: 'ERR_HTTP2_STREAM_CANCEL' }));
      });
      stream.on('error', (err) => {
        // A stream refused by a GOAWAY errors (ERR_HTTP2_STREAM_ERROR, or
        // ERR_HTTP2_SESSION_ERROR when the GOAWAY carries an error code)
        // before it closes; APNs never processed it, so it may be retried.
        const unprocessed = typeof stream.id === 'number' && entry.goawayLastStreamId !== undefined && stream.id > entry.goawayLastStreamId;
        if (!status && (stream.rstCode === http2.constants.NGHTTP2_REFUSED_STREAM || unprocessed)) {
          finish(Object.assign(new Error(`APNs refused the stream (${err.message})`), { code: 'NGHTTP2_REFUSED_STREAM' }));
        } else finish(err);
      });
      stream.on('close', () => {
        if (settled) return;
        if (status) finish(null, { status, headers: responseHeaders, body: data });
        else {
          const refused = stream.rstCode === http2.constants.NGHTTP2_REFUSED_STREAM;
          finish(Object.assign(new Error(`APNs stream closed (rst ${stream.rstCode})`), {
            code: refused ? 'NGHTTP2_REFUSED_STREAM' : 'ERR_HTTP2_STREAM_CANCEL',
          }));
        }
      });
      if (body !== undefined) stream.end(body);
    });
  }

  close() {
    this.#closed = true;
    clearInterval(this.#pingTimer);
    for (const entry of this.#sessions.values()) {
      entry.session.close();
      setTimeout(() => entry.session.destroy(), 2000).unref();
    }
    this.#sessions.clear();
  }
}

// ---- client -----------------------------------------------------------------

function parseReason(body) {
  if (!body) return undefined;
  try {
    return JSON.parse(body).reason;
  } catch {
    return undefined;
  }
}

function headerValue(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

export class ApnsClient {
  #transport;
  #token = null;
  #log;
  #now;
  #origins;

  // `transport` defaults to a real HTTP/2 transport; tests inject a fake.
  constructor({ teamId, keyId, keyPem, keyPath, bundleId, environments, log, now = Date.now, transport, origins = APNS_ORIGINS }) {
    this.teamId = teamId ?? null;
    this.keyId = keyId ?? null;
    this.bundleId = bundleId;
    this.environments = [...(environments ?? [])];
    this.error = null;
    this.#log = log;
    this.#now = now;
    this.#origins = origins;

    if (!teamId || !keyId || (!keyPem && !keyPath)) {
      this.error = 'APNS_TEAM_ID, APNS_KEY_ID and APNS_KEY_PATH are not all set';
    } else {
      try {
        const key = loadSigningKey(keyPem ?? readFileSync(keyPath, 'utf8'));
        this.#token = new ProviderToken({ key, teamId, keyId, now });
      } catch (err) {
        this.error = `Could not load the APNs key${keyPath ? ` at ${keyPath}` : ''}: ${err.message}`;
        log?.error('APNs disabled: key could not be loaded', { keyPath, err: err.message });
      }
    }
    if (this.configured) this.#transport = transport ?? new Http2Transport({ log });
  }

  get configured() {
    return this.#token !== null;
  }

  status() {
    return { configured: this.configured, environments: this.configured ? this.environments : [] };
  }

  async #send(environment, kind, { method, path, headers = {}, body }) {
    if (!this.configured) return { ok: false, status: 0, reason: 'NotConfigured', error: this.error };
    const origins = this.#origins[environment];
    if (!origins) return { ok: false, status: 0, reason: 'UnknownEnvironment' };
    const origin = origins[kind];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requestHeaders = {
        authorization: `bearer ${this.#token.get({ force: attempt > 0 })}`,
        'apns-request-id': randomUUID(),
        ...headers,
      };
      let response;
      try {
        response = await this.#transport.request({ origin, method, path, headers: requestHeaders, body });
      } catch (err) {
        // A failed connect surfaces on the stream as ERR_HTTP2_STREAM_CANCEL;
        // the underlying code (ECONNREFUSED, ENOTFOUND, …) is in `cause`.
        const reason = err.cause?.code ?? err.code ?? 'NetworkError';
        return { ok: false, status: 0, reason, error: err.message, network: true };
      }
      const reason = response.status >= 300 ? parseReason(response.body) : undefined;
      if (response.status === 403 && reason === 'ExpiredProviderToken' && attempt === 0) continue;
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        reason,
        headers: response.headers,
        body: response.body,
        apnsId: headerValue(response.headers, 'apns-id'),
        uniqueId: headerValue(response.headers, 'apns-unique-id'),
      };
    }
    return { ok: false, status: 403, reason: 'ExpiredProviderToken' };
  }

  // Push-to-start / device push to one token: POST /3/device/<token>.
  async pushToStart(environment, deviceToken, payload, { expirationSec } = {}) {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > DEVICE_PAYLOAD_LIMIT) return { ok: false, status: 0, reason: 'PayloadTooLarge' };
    const nowSec = Math.floor(this.#now() / 1000);
    return this.#send(environment, 'push', {
      method: 'POST',
      path: `/3/device/${deviceToken}`,
      headers: {
        'apns-push-type': 'liveactivity',
        'apns-topic': `${this.bundleId}.push-type.liveactivity`,
        'apns-priority': '10',
        'apns-expiration': String(expirationSec ?? nowSec + 300),
      },
      body,
    });
  }

  // Broadcast to a channel: POST /4/broadcasts/apps/<bundle> (no apns-topic).
  async broadcast(environment, channelId, payload, { priority = 10, expirationSec = 0 } = {}) {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > BROADCAST_PAYLOAD_LIMIT) return { ok: false, status: 0, reason: 'PayloadTooLarge' };
    return this.#send(environment, 'push', {
      method: 'POST',
      path: `/4/broadcasts/apps/${this.bundleId}`,
      headers: {
        'apns-channel-id': channelId,
        'apns-push-type': 'liveactivity',
        'apns-priority': String(priority),
        'apns-expiration': String(expirationSec),
      },
      body,
    });
  }

  async createChannel(environment, storagePolicy = 0) {
    const result = await this.#send(environment, 'manage', {
      method: 'POST',
      path: `/1/apps/${this.bundleId}/channels`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'message-storage-policy': storagePolicy, 'push-type': 'LiveActivity' }),
    });
    if (result.ok) {
      result.channelId = headerValue(result.headers, 'apns-channel-id') ?? null;
      if (!result.channelId) return { ...result, ok: false, reason: 'MissingChannelId' };
    }
    return result;
  }

  async readChannel(environment, channelId) {
    const result = await this.#send(environment, 'manage', {
      method: 'GET',
      path: `/1/apps/${this.bundleId}/channels`,
      headers: { 'apns-channel-id': channelId },
    });
    if (result.ok && result.body) {
      try {
        result.channel = JSON.parse(result.body);
      } catch {
        result.channel = null;
      }
    }
    return result;
  }

  async deleteChannel(environment, channelId) {
    return this.#send(environment, 'manage', {
      method: 'DELETE',
      path: `/1/apps/${this.bundleId}/channels`,
      headers: { 'apns-channel-id': channelId },
    });
  }

  async listChannels(environment) {
    const result = await this.#send(environment, 'manage', {
      method: 'GET',
      path: `/1/apps/${this.bundleId}/all-channels`,
    });
    if (result.ok) {
      try {
        result.channels = JSON.parse(result.body || '{}').channels ?? [];
      } catch {
        return { ...result, ok: false, reason: 'BadResponse' };
      }
    }
    return result;
  }

  // End-to-end credential check: create, read and delete a channel in every
  // configured environment.
  async check(storagePolicy = 0) {
    const results = {};
    if (!this.configured) {
      for (const environment of this.environments) results[environment] = { ok: false, error: this.error };
      return results;
    }
    await Promise.all(
      this.environments.map(async (environment) => {
        const created = await this.createChannel(environment, storagePolicy);
        if (!created.ok) {
          results[environment] = { ok: false, error: describeFailure(created) };
          return;
        }
        const read = await this.readChannel(environment, created.channelId);
        const deleted = await this.deleteChannel(environment, created.channelId);
        if (!read.ok) results[environment] = { ok: false, channelId: created.channelId, error: `read: ${describeFailure(read)}` };
        else if (!deleted.ok) results[environment] = { ok: false, channelId: created.channelId, error: `delete: ${describeFailure(deleted)}` };
        else results[environment] = { ok: true, channelId: created.channelId };
      }),
    );
    return results;
  }

  close() {
    this.#transport?.close();
  }
}

export function describeFailure(result) {
  if (result.ok) return 'ok';
  if (result.status === 0) return result.error ? `${result.reason}: ${result.error}` : result.reason;
  return `${result.status} ${result.reason ?? 'error'}`;
}

export function setupHint(reason) {
  switch (reason) {
    case 'FeatureNotEnabled':
      return 'Enable "Broadcast Capability" for the App ID (Identifiers → Push Notifications) in the developer portal.';
    case 'TopicDisallowed':
    case 'BadTopic':
    case 'MissingTopic':
      return 'Check APNS_BUNDLE_ID matches the app and that the key may send to it.';
    case 'BadEnvironmentKeyIdInToken':
      return 'The APNs key is restricted to the other environment; use a key valid for this one or change APNS_ENVIRONMENTS.';
    case 'InvalidProviderToken':
    case 'MissingProviderToken':
    case 'ExpiredProviderToken':
      return 'Check APNS_TEAM_ID, APNS_KEY_ID, the .p8 file and the server clock (NTP).';
    case 'ChannelNotRegistered':
    case 'BadChannelId':
      return 'The broadcast channel no longer exists (or belongs to the other environment); it will be recreated.';
    default:
      return undefined;
  }
}
