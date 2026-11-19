import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../server/config.js';
import { FcmClient } from '../server/fcm.js';
import { createGame, openStream, startGame, startTestApp } from './helpers.js';

const MINUTE = 60_000;
const STATION_URL = 'https://radio.test';
const TOKEN_URI = 'https://oauth2.test/token';
const FCM_SEND = 'https://fcm.googleapis.com/v1/projects/mchs-test/messages:send';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'mchs-test',
  client_email: 'push@mchs-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: TOKEN_URI,
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The AzuraCast station, Google's token endpoint and FCM, in one fake fetch.
class FakeNet {
  calls = [];
  np = { station: { name: 'Marquette Nation Sports' }, is_online: true, live: { is_live: false, streamer_name: '', broadcast_start: null } };
  stationStatus = 200;
  stationError = null;
  fcmResponses = [];
  tokens = 0;
  fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
    this.calls.push(call);
    if (call.url.startsWith(`${STATION_URL}/api/nowplaying/`)) {
      if (this.stationError) throw this.stationError;
      return this.stationStatus === 200 ? json(this.np) : json({ code: this.stationStatus, message: 'Record not found' }, this.stationStatus);
    }
    if (call.url === TOKEN_URI) {
      this.tokens += 1;
      return json({ access_token: `token-${this.tokens}`, expires_in: 3600, token_type: 'Bearer' });
    }
    if (call.url.startsWith('https://fcm.googleapis.com/')) {
      const next = this.fcmResponses.shift() ?? { status: 200, body: { name: 'projects/mchs-test/messages/1' } };
      return json(next.body, next.status);
    }
    throw new Error(`unexpected fetch ${call.url}`);
  };

  goLive(streamer = 'Jon', broadcastStart = 1_795_000_000) {
    this.np = { ...this.np, live: { is_live: true, streamer_name: streamer, broadcast_start: broadcastStart } };
  }

  goOffAir() {
    this.np = { ...this.np, live: { is_live: false, streamer_name: '', broadcast_start: null } };
  }

  sent() {
    return this.calls.filter((call) => call.url === FCM_SEND).map((call) => ({ ...call, message: JSON.parse(call.body).message }));
  }
}

async function startRadioApp(net, { env = {}, fcm = true, ...options } = {}) {
  return startTestApp({
    ...options,
    env: { RADIO_URL: STATION_URL, RADIO_STATION: 'sports', ...env },
    appOptions: {
      radioOptions: { fetch: net.fetch },
      fcmOptions: fcm ? { fetch: net.fetch, serviceAccount: SERVICE_ACCOUNT, retryDelaysMs: [5, 10] } : { fetch: net.fetch },
    },
  });
}

describe('radio config', () => {
  it('defaults to the school station and can be turned off', () => {
    const config = loadConfig({}, { dotenv: false });
    assert.deepEqual({ ...config.radio }, {
      enabled: true,
      url: 'https://radio.marquettenation.com',
      station: 'marquette_nation_sports',
      name: 'Marquette Nation Sports',
      streamUrl: 'https://radio.marquettenation.com/listen/marquette_nation_sports/radio.mp3',
      playerUrl: 'https://radio.marquettenation.com/public/marquette_nation_sports',
      pollSeconds: 10,
      notifyGapMinutes: 10,
    });
    assert.deepEqual({ ...config.fcm }, { serviceAccountPath: undefined, topic: 'radio' });

    const off = loadConfig({ RADIO_URL: 'off' }, { dotenv: false });
    assert.equal(off.radio.enabled, false);
    assert.equal(off.radio.streamUrl, null);

    const custom = loadConfig({ RADIO_URL: 'https://example.org/', RADIO_STATION: 'jv', RADIO_STREAM_URL: 'https://cdn.example.org/jv.aac' }, { dotenv: false });
    assert.equal(custom.radio.url, 'https://example.org');
    assert.equal(custom.radio.streamUrl, 'https://cdn.example.org/jv.aac');
    assert.equal(custom.radio.playerUrl, 'https://example.org/public/jv');
  });

  it('rejects invalid radio settings', () => {
    assert.throws(
      () => loadConfig({ RADIO_URL: 'ftp://radio', RADIO_STATION: 'has space', RADIO_POLL_SECONDS: '1', RADIO_NOTIFY_GAP_MINUTES: 'soon', FCM_RADIO_TOPIC: 'no/slash' }, { dotenv: false }),
      (err) => err instanceof ConfigError
        && ['RADIO_URL', 'RADIO_STATION', 'RADIO_POLL_SECONDS', 'RADIO_NOTIFY_GAP_MINUTES', 'FCM_RADIO_TOPIC'].every((key) => err.problems.some((p) => p.startsWith(key))),
    );
  });
});

describe('the "on the radio" switch', () => {
  let t;
  let admin;
  before(async () => {
    t = await startTestApp();
    admin = await t.signedIn('admin', 'admin');
  });
  after(() => t.close());

  it('is off by default and can be switched in any status', async () => {
    const game = await createGame(admin);
    assert.equal(game.radio, false);
    const on = await createGame(admin, { radio: true });
    assert.equal(on.radio, true);

    assert.equal((await admin.patch(`/api/games/${game.id}`, { radio: 'yes' })).status, 400);
    const switched = await admin.patch(`/api/games/${game.id}`, { radio: true });
    assert.equal(switched.status, 200);
    assert.equal(switched.json.game.radio, true);
    assert.equal(switched.json.game.version, game.version + 1);

    await startGame(admin, game.id);
    const live = await admin.patch(`/api/games/${game.id}`, { radio: false });
    assert.equal(live.status, 200, 'a live game can be switched off the radio');
    assert.equal(live.json.game.radio, false);
    assert.equal((await t.client().get(`/api/games/${game.id}`)).json.game.radio, false, 'public JSON has it too');
  });

  it('reports no radio while it is turned off', async () => {
    const anonymous = t.client();
    assert.equal((await anonymous.get('/api/radio')).json.radio, null);
    assert.equal((await anonymous.get('/api/games')).json.radio, null);
    assert.equal((await anonymous.get('/api/config')).json.radio, null);
    const status = await admin.get('/api/admin/status');
    assert.equal(status.json.radio.configured, false);
    assert.equal(status.json.radio.notifications.configured, false);
  });
});

describe('radio station status and the "we\'re live" notification', () => {
  let t;
  let net;
  let admin;
  const streams = [];

  beforeEach(async () => {
    net = new FakeNet();
    t = await startRadioApp(net);
    admin = await t.signedIn('admin', 'admin');
  });
  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.close();
    await t.close();
  });

  const poll = async () => {
    const status = await t.app.radio.poll();
    await t.app.radio.flush();
    return status;
  };

  it('reads the station and shares its status everywhere', async () => {
    const off = await poll();
    assert.deepEqual(off, {
      live: false,
      name: 'Marquette Nation Sports',
      streamUrl: `${STATION_URL}/listen/sports/radio.mp3`,
      playerUrl: `${STATION_URL}/public/sports`,
      since: null,
      gameId: null,
    });
    const check = net.calls.find((call) => call.url.startsWith(STATION_URL));
    assert.equal(check.url, `${STATION_URL}/api/nowplaying/sports`);
    assert.match(check.headers['user-agent'], /^mchs-live\//);

    const stream = await openStream(t.baseUrl);
    streams.push(stream);
    const hello = await stream.next((e) => e.event === 'hello');
    assert.deepEqual(hello.data.radio, off);

    net.goLive('Jon', 1_795_000_000);
    const live = await poll();
    assert.equal(live.live, true);
    assert.equal(live.since, 1_795_000_000_000);
    const event = await stream.next((e) => e.event === 'radio' && e.data.radio.live);
    assert.equal(typeof event.data.serverTime, 'number');
    assert.deepEqual(event.data.radio, live);
    assert.deepEqual((await t.client().get('/api/radio')).json.radio, live);
    assert.deepEqual((await t.client().get('/api/games')).json.radio, live);
    assert.deepEqual((await t.client().get('/api/config')).json.radio, { name: 'Marquette Nation Sports', playerUrl: `${STATION_URL}/public/sports` });

    const status = (await admin.get('/api/admin/status')).json.radio;
    assert.equal(status.configured, true);
    assert.equal(status.live, true);
    assert.equal(status.streamer, 'Jon');
    assert.equal(status.station, 'sports');
    assert.equal(status.error, null);
    assert.equal(typeof status.checkedAt, 'number');
    assert.deepEqual({ ...status.notifications, last: undefined, lastSentAt: undefined }, {
      configured: true, projectId: 'mchs-test', topic: 'radio', gapMinutes: 10, last: undefined, lastSentAt: undefined,
    });

    // Nothing changed: no new event.
    const count = stream.events.filter((e) => e.event === 'radio').length;
    await poll();
    assert.equal(stream.events.filter((e) => e.event === 'radio').length, count);
  });

  it('notifies once when the station goes live, naming the game on the radio', async () => {
    const game = await createGame(admin, { radio: true });
    await createGame(admin);   // not on the radio
    await startGame(admin, game.id);
    await poll();
    assert.equal(net.sent().length, 0, 'off the air: nothing sent');
    assert.equal(t.app.radio.status().gameId, game.id, 'the live game switched on the radio');

    net.goLive();
    await poll();
    const [sent] = net.sent();
    assert.equal(net.sent().length, 1);
    assert.equal(sent.headers.authorization, 'Bearer token-1');
    assert.deepEqual(sent.message, {
      topic: 'radio',
      notification: { title: 'Marquette Nation Sports is live', body: 'Basketball: Marquette vs Lincoln. Tap to listen.' },
      data: { kind: 'radio', url: `mchs://game/${game.id}` },
      apns: { headers: { 'apns-priority': '10', 'apns-collapse-id': 'radio-live' }, payload: { aps: { sound: 'default' } } },
    });

    // The token request is a JWT signed with the service account's key.
    const tokenCall = net.calls.find((call) => call.url === TOKEN_URI);
    const form = new URLSearchParams(tokenCall.body);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims, signature] = form.get('assertion').split('.');
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')));
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const jwt = JSON.parse(Buffer.from(claims, 'base64url'));
    assert.equal(jwt.iss, SERVICE_ACCOUNT.client_email);
    assert.equal(jwt.aud, TOKEN_URI);
    assert.equal(jwt.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(jwt.exp - jwt.iat, 3600);

    await poll();
    assert.equal(net.sent().length, 1, 'still live: no second notification');

    const pushes = (await admin.get('/api/admin/status')).json.recentPushes.filter((row) => row.kind === 'radio');
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].gameId, game.id);
    assert.equal(pushes[0].sent, 1);
    assert.equal(pushes[0].failed, 0);
  });

  it('notifies without a game, linking to the radio', async () => {
    net.goLive();
    await poll();
    const [sent] = net.sent();
    assert.equal(sent.message.notification.body, 'Tap to listen live.');
    assert.equal(sent.message.data.url, 'mchs://radio');
  });

  it('does not notify again when a broadcast drops and comes back within the gap', async () => {
    net.goLive();
    await poll();
    assert.equal(net.sent().length, 1);

    net.goOffAir();
    await poll();
    t.clock.advance(4 * MINUTE);
    net.goLive();
    await poll();
    assert.equal(net.sent().length, 1, 'back after 4 minutes: same broadcast');

    net.goOffAir();
    await poll();
    t.clock.advance(11 * MINUTE);
    net.goLive();
    await poll();
    assert.equal(net.sent().length, 2, 'back after 11 minutes: a new broadcast');
    assert.equal(net.tokens, 1, 'the access token is reused');
  });

  it('does not notify again after a restart mid-broadcast', async () => {
    net.goLive();
    await poll();
    assert.equal(net.sent().length, 1);
    await t.close({ keepData: true });

    t = await startRadioApp(net, { dir: t.dir, clock: t.clock });
    t.clock.advance(2 * MINUTE);
    await poll();
    assert.equal(t.app.radio.live, true);
    assert.equal(net.sent().length, 1);
  });

  it('counts the station as off the air after three failed checks, with the reason', async () => {
    net.goLive();
    await poll();
    net.stationStatus = 404;
    await poll();
    await poll();
    assert.equal(t.app.radio.live, true, 'one or two failed checks keep the last status');
    await poll();
    assert.equal(t.app.radio.live, false);
    const status = (await admin.get('/api/admin/status')).json.radio;
    assert.match(status.error, /^HTTP 404: Record not found\. .*Restart Broadcasting/);

    net.stationStatus = 200;
    net.stationError = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    await poll();
    assert.equal((await admin.get('/api/admin/status')).json.radio.error, 'The station didn’t answer in time.');
    net.stationError = null;
    const checked = await admin.post('/api/admin/radio/check', {});
    assert.equal(checked.status, 200);
    assert.equal(checked.json.radio.error, null);
    assert.equal(checked.json.radio.live, true);
    assert.equal((await t.client().post('/api/admin/radio/check', {})).status, 401);
  });

  it('records a notification Firebase rejected', async () => {
    net.fcmResponses.push({ status: 500, body: {} }, { status: 400, body: { error: { code: 400, message: 'Invalid topic', status: 'INVALID_ARGUMENT' } } });
    net.goLive();
    await poll();
    assert.equal(net.sent().length, 2, 'a 500 is retried, a 400 is not');
    const status = (await admin.get('/api/admin/status')).json;
    const row = status.recentPushes.find((r) => r.kind === 'radio');
    assert.equal(row.failed, 1);
    assert.equal(row.detail, 'Not sent: HTTP 400: Invalid topic');
    assert.equal(status.radio.notifications.last.ok, false);
  });

  it('picks the game the radio carries: live, then about to start, then just ended', async () => {
    const now = t.clock.now();
    const later = await createGame(admin, { radio: true, scheduledAt: now + 5 * 60 * MINUTE });
    const soon = await createGame(admin, { radio: true, scheduledAt: now + 30 * MINUTE });
    const notOnRadio = await createGame(admin, { scheduledAt: now + 10 * MINUTE });
    const radio = t.app.radio;
    assert.equal(radio.status().gameId, soon.id, 'its start window is open; the later one’s isn’t');

    await startGame(admin, notOnRadio.id);
    assert.equal(radio.status().gameId, soon.id, 'a live game not on the radio doesn’t count');

    await startGame(admin, later.id);
    assert.equal(radio.status().gameId, later.id, 'a live game comes first');

    await admin.post(`/api/games/${later.id}/end`, {});
    assert.equal(radio.status().gameId, soon.id);
    await admin.post(`/api/games/${soon.id}/cancel`, {});
    assert.equal(radio.status().gameId, later.id, 'the postgame show');
    t.clock.advance(61 * MINUTE);
    assert.equal(radio.status().gameId, null, 'an hour after the end');
  });

  it('publishes a new status when a game is switched on the radio', async () => {
    await poll();
    const stream = await openStream(t.baseUrl);
    streams.push(stream);
    await stream.next((e) => e.event === 'hello');
    const game = await createGame(admin, { scheduledAt: t.clock.now() + 10 * MINUTE });
    await admin.patch(`/api/games/${game.id}`, { radio: true });
    const event = await stream.next((e) => e.event === 'radio' && e.data.radio.gameId === game.id);
    assert.equal(event.data.radio.live, false);
    await admin.delete(`/api/games/${game.id}`);
    await stream.next((e) => e.event === 'radio' && e.data.radio.gameId === null);
  });
});

describe('radio without Firebase', () => {
  it('logs that the notification could not be sent', async () => {
    const net = new FakeNet();
    const t = await startRadioApp(net, { fcm: false });
    try {
      net.goLive();
      await t.app.radio.poll();
      await t.app.radio.flush();
      assert.equal(net.sent().length, 0);
      const admin = await t.signedIn('admin', 'admin');
      const status = (await admin.get('/api/admin/status')).json;
      assert.equal(status.radio.notifications.configured, false);
      assert.equal(status.radio.notifications.error, 'FCM_SERVICE_ACCOUNT_PATH is not set.');
      const row = status.recentPushes.find((r) => r.kind === 'radio');
      assert.equal(row.detail, 'Not sent: Firebase isn\'t set up: FCM_SERVICE_ACCOUNT_PATH is not set.');
    } finally {
      await t.close();
    }
  });
});

describe('FcmClient', () => {
  it('renews a rejected access token once and reports a bad key file', async () => {
    const net = new FakeNet();
    net.fcmResponses.push({ status: 401, body: { error: { message: 'Request had invalid authentication credentials.' } } });
    const client = new FcmClient({ serviceAccount: SERVICE_ACCOUNT, fetch: net.fetch, retryDelaysMs: [] });
    const result = await client.send({ topic: 'radio', notification: { title: 't', body: 'b' } });
    assert.deepEqual(result, { ok: true, name: 'projects/mchs-test/messages/1' });
    assert.equal(net.tokens, 2);
    assert.deepEqual(net.sent().map((call) => call.headers.authorization), ['Bearer token-1', 'Bearer token-2']);

    const broken = new FcmClient({ serviceAccount: { project_id: 'p', client_email: 'e@p' } });
    assert.equal(broken.configured, false);
    assert.match(broken.error, /has no "private_key"/);
    assert.deepEqual(await broken.send({}), { ok: false, error: `Firebase isn't set up: ${broken.error}` });
  });
});
