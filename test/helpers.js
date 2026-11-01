// Shared test fixtures: a real server on an ephemeral port with a temp data
// directory, an adjustable clock and a fake APNs transport.

import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createLogger } from '../server/log.js';

export const TEAM_ID = 'TEAM123456';
export const KEY_ID = 'KEY1234567';
export const BUNDLE_ID = 'org.marquettecatholic.app';
export const PASSWORD = 'correct horse battery';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(check, { timeout = 3000, interval = 10, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await sleep(interval);
  }
}

export function createClock() {
  const clock = {
    offset: 0,
    now: () => Date.now() + clock.offset,
    advance(ms) {
      clock.offset += ms;
    },
  };
  return clock;
}

function classify(req) {
  if (req.path.startsWith('/3/device/')) return 'device';
  if (req.path.startsWith('/4/broadcasts/')) return 'broadcast';
  if (req.path.endsWith('/all-channels')) return 'channel-list';
  if (req.path.endsWith('/channels')) {
    if (req.method === 'POST') return 'channel-create';
    if (req.method === 'DELETE') return 'channel-delete';
    return 'channel-read';
  }
  return 'unknown';
}

// Records every request and answers like APNs. `respond(fn)` installs a
// handler that may return a response to override the default.
export class FakeApnsTransport {
  calls = [];
  handlers = [];
  channelCounter = 0;
  closed = false;

  respond(handler) {
    this.handlers.push(handler);
    return this;
  }

  clearHandlers() {
    this.handlers = [];
  }

  byKind(kind) {
    return this.calls.filter((call) => call.kind === kind);
  }

  async request(req) {
    const call = { ...req, kind: classify(req), json: req.body ? JSON.parse(req.body) : undefined, at: Date.now() };
    this.calls.push(call);
    for (const handler of this.handlers) {
      const response = await handler(call);
      if (response instanceof Error) throw response;
      if (response) return { headers: {}, body: '', ...response };
    }
    switch (call.kind) {
      case 'device':
        return { status: 200, headers: { 'apns-id': 'A1B2' }, body: '' };
      case 'broadcast':
        return { status: 200, headers: { 'apns-unique-id': 'U1' }, body: '' };
      case 'channel-create':
        this.channelCounter += 1;
        return { status: 201, headers: { 'apns-channel-id': Buffer.from(`channel-${this.channelCounter}`).toString('base64') }, body: '' };
      case 'channel-delete':
        return { status: 204, headers: {}, body: '' };
      case 'channel-read':
        return { status: 200, headers: {}, body: '{"message-storage-policy":0,"push-type":"LiveActivity"}' };
      case 'channel-list':
        return { status: 200, headers: {}, body: '{"channels":[]}' };
      default:
        return { status: 404, headers: {}, body: '{"reason":"NotFound"}' };
    }
  }

  close() {
    this.closed = true;
  }
}

export function verifyJwt(authorization, publicKey) {
  const token = authorization.replace(/^bearer /, '');
  const [header, claims, signature] = token.split('.');
  const valid = verify(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
  return {
    valid,
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()),
    signatureLength: Buffer.from(signature, 'base64url').length,
  };
}

export class TestClient {
  cookie = null;
  token = null;

  constructor(baseUrl, { forwardedFor } = {}) {
    this.baseUrl = baseUrl;
    this.forwardedFor = forwardedFor;
  }

  async request(method, url, { body, headers = {}, csrf = true, rawBody, contentType } = {}) {
    const requestHeaders = { ...headers };
    if (this.forwardedFor) requestHeaders['x-forwarded-for'] = this.forwardedFor;
    if (this.token) requestHeaders.authorization = `Bearer ${this.token}`;
    if (this.cookie) requestHeaders.cookie = this.cookie;
    if (this.cookie && csrf && method !== 'GET') requestHeaders['x-mchs-client'] = 'web';
    let payload;
    if (rawBody !== undefined) {
      payload = rawBody;
      if (contentType) requestHeaders['content-type'] = contentType;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      requestHeaders['content-type'] = contentType ?? 'application/json';
    }
    const res = await fetch(this.baseUrl + url, { method, headers: requestHeaders, body: payload, redirect: 'manual' });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const setCookie = res.headers.getSetCookie();
    for (const cookie of setCookie) {
      if (!cookie.startsWith('mchs_session=')) continue;
      const pair = cookie.split(';')[0];
      this.cookie = pair === 'mchs_session=' ? null : pair;
    }
    return { status: res.status, json, text, headers: res.headers, setCookie };
  }

  get(url, options) {
    return this.request('GET', url, options);
  }

  post(url, body, options = {}) {
    return this.request('POST', url, { ...options, body });
  }

  patch(url, body, options = {}) {
    return this.request('PATCH', url, { ...options, body });
  }

  delete(url, options) {
    return this.request('DELETE', url, options);
  }

  async loginWeb(username, password = PASSWORD) {
    const res = await this.post('/api/auth/login', { username, password, client: 'web' });
    if (res.status !== 200) throw new Error(`web login failed: ${res.status} ${res.text}`);
    return res;
  }

  async loginIos(username, password = PASSWORD) {
    const res = await this.post('/api/auth/login', { username, password, client: 'ios' });
    if (res.status !== 200) throw new Error(`ios login failed: ${res.status} ${res.text}`);
    this.token = res.json.token;
    return res;
  }
}

let actionCounter = 0;
export function actionId() {
  actionCounter += 1;
  return `test-action-${process.pid}-${actionCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// `dir` reuses an earlier app's data directory (a restart); close({ keepData })
// leaves it in place for that.
export async function startTestApp({ env = {}, apns = true, publicFiles = null, publicDir: explicitPublicDir, appOptions = {}, dir: existingDir = null, clock: existingClock = null } = {}) {
  const dir = existingDir ?? (await mkdtemp(path.join(tmpdir(), 'mchs-live-test-')));
  const clock = existingClock ?? createClock();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPath = path.join(dir, 'AuthKey_TEST.p8');
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const publicDir = explicitPublicDir ?? path.join(dir, 'public');
  if (publicFiles) {
    for (const [name, content] of Object.entries(publicFiles)) {
      const file = path.join(publicDir, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
  }

  const config = loadConfig(
    {
      DATA_DIR: path.join(dir, 'data'),
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'silent',
      APNS_MIN_UPDATE_INTERVAL_MS: '0',
      ...(apns ? { APNS_TEAM_ID: TEAM_ID, APNS_KEY_ID: KEY_ID, APNS_KEY_PATH: keyPath } : {}),
      ...env,
    },
    { dotenv: false, publicDir },
  );
  const transport = new FakeApnsTransport();
  const app = createApp({
    config,
    log: createLogger({ level: 'silent' }),
    now: clock.now,
    apnsTransport: transport,
    globalRateLimitPerMinute: 100_000,
    pushOptions: { retryDelaysMs: [20, 40], startRetryDelayMs: 10, channelRetryDelaysMs: [10, 20], startSettleMs: 10 },
    ...appOptions,
  });
  const address = await app.listen({ startScheduler: false });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const ctx = {
    app,
    config,
    clock,
    transport,
    baseUrl,
    dir,
    publicKey,
    port: address.port,
    client: (options) => new TestClient(baseUrl, options),
    async createUser(username, role = 'scorekeeper', displayName = username) {
      return app.users.create({ username, displayName, password: PASSWORD, role });
    },
    // Creates a user and returns a web (cookie) client signed in as them.
    async signedIn(username, role = 'scorekeeper', { ios = false } = {}) {
      await ctx.createUser(username, role, `${username} name`);
      const client = ctx.client();
      if (ios) await client.loginIos(username);
      else await client.loginWeb(username);
      return client;
    },
    async close({ keepData = false, pushFlushTimeoutMs = 500 } = {}) {
      await app.close({ pushFlushTimeoutMs });
      if (!keepData) await rm(dir, { recursive: true, force: true });
    },
  };
  return ctx;
}

export function gameInput(overrides = {}) {
  return {
    sport: 'basketball',
    home: { name: 'Marquette', code: 'mar', color: '#12214d' },
    away: { name: 'Lincoln', code: 'LIN', color: '#B22234' },
    location: 'MCHS Gym',
    scheduledAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

export async function createGame(admin, overrides) {
  const res = await admin.post('/api/games', gameInput(overrides));
  if (res.status !== 200) throw new Error(`create game failed: ${res.status} ${res.text}`);
  return res.json.game;
}

export async function startGame(client, id) {
  const res = await client.post(`/api/games/${id}/start`, {});
  if (res.status !== 200) throw new Error(`start failed: ${res.status} ${res.text}`);
  return res.json;
}

export async function act(client, id, action) {
  return client.post(`/api/games/${id}/actions`, { actionId: actionId(), ...action });
}

export function hexToken(seed) {
  return Buffer.from(String(seed).padEnd(32, 'x')).toString('hex').slice(0, 64);
}

// Minimal SSE reader on top of fetch.
export async function openStream(baseUrl, url = '/api/stream', headers = {}) {
  const controller = new AbortController();
  const res = await fetch(baseUrl + url, { headers, signal: controller.signal });
  const stream = { res, events: [], comments: [], raw: '', closed: false };
  if (res.status !== 200) {
    stream.body = await res.text();
    return stream;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stream.raw += text;
        buffer += text;
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) stream.comments.push(line);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (data.length) stream.events.push({ event, dataLines: data.length, data: JSON.parse(data.join('\n')) });
        }
      }
    } catch {
      // aborted
    } finally {
      stream.closed = true;
    }
  })();
  stream.close = () => controller.abort();
  stream.next = (predicate, options) => waitFor(() => stream.events.find(predicate), { message: 'SSE event', ...options });
  return stream;
}
