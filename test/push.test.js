import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { BUNDLE_ID, KEY_ID, TEAM_ID, act, createGame, hexToken, sleep, startGame, startTestApp, verifyJwt, waitFor } from './helpers.js';

const ATTRIBUTE_KEYS = ['awayCode', 'awayColor', 'awayName', 'gameId', 'homeCode', 'homeColor', 'homeName', 'sport', 'sportName', 'symbol'];
const PROD_PUSH = 'https://api.push.apple.com:443';
const SANDBOX_PUSH = 'https://api.sandbox.push.apple.com:443';
const PROD_MANAGE = 'https://api-manage-broadcast.push.apple.com:2196';
const SANDBOX_MANAGE = 'https://api-manage-broadcast.sandbox.push.apple.com:2195';

async function register(t, seed, environment = 'production', extra = {}) {
  const token = hexToken(seed);
  const res = await t.client().post('/api/devices', { token, environment, enabled: true, activitiesEnabled: true, appVersion: '5.1', ...extra });
  assert.equal(res.status, 200);
  return token;
}

function pushLog(t, gameId, kind) {
  return t.app.db.all('SELECT * FROM push_log WHERE game_id = ? AND kind = ? ORDER BY id', gameId, kind);
}

describe('push flows (fake APNs)', () => {
  let t;
  let admin;

  before(async () => {
    t = await startTestApp();
    admin = await t.signedIn('admin', 'admin');
  });
  after(() => t.close());
  afterEach(() => t.transport.clearHandlers());

  async function startedGame(overrides = {}) {
    const game = await createGame(admin, { scheduledAt: Date.now(), ...overrides });
    const started = await startGame(admin, game.id);
    await waitFor(() => pushLog(t, game.id, 'start').length === 2, { message: 'start flow' });
    return started;
  }

  it('creates channels and sends push-to-start with the exact APNs request shape', async () => {
    const prodA = await register(t, 'start-prod-a');
    const prodB = await register(t, 'start-prod-b');
    const sandbox = await register(t, 'start-sandbox', 'sandbox');
    await register(t, 'start-off', 'production', { enabled: false });
    await register(t, 'start-no-activities', 'production', { activitiesEnabled: false });
    const before = t.transport.calls.length;

    const { game, push } = await startedGame({ home: { name: 'Marquette', code: 'MAR', color: '#12214D' }, away: { name: 'Lincoln', code: 'LIN', color: '#B22234' } });
    assert.equal(push.queued, 3);
    const calls = t.transport.calls.slice(before);

    const creates = calls.filter((c) => c.kind === 'channel-create');
    assert.equal(creates.length, 2);
    for (const create of creates) {
      assert.equal(create.method, 'POST');
      assert.equal(create.path, `/1/apps/${BUNDLE_ID}/channels`);
      assert.deepEqual(create.json, { 'message-storage-policy': 0, 'push-type': 'LiveActivity' });
      assert.ok([PROD_MANAGE, SANDBOX_MANAGE].includes(create.origin));
      assert.equal(create.headers['apns-topic'], undefined);
    }
    assert.deepEqual(creates.map((c) => c.origin).sort(), [PROD_MANAGE, SANDBOX_MANAGE].sort());

    const stored = t.app.games.getGame(game.id);
    assert.ok(stored.channels.production && stored.channels.sandbox);
    const live = (await t.client().get(`/api/games/${game.id}`)).json.game;
    assert.deepEqual(live.channels, stored.channels);

    const starts = calls.filter((c) => c.kind === 'device');
    assert.deepEqual(starts.map((c) => c.path.slice('/3/device/'.length)).sort(), [prodA, prodB, sandbox].sort());
    const nowSec = Math.floor(Date.now() / 1000);
    for (const call of starts) {
      const env = call.path.endsWith(sandbox) ? 'sandbox' : 'production';
      assert.equal(call.origin, env === 'sandbox' ? SANDBOX_PUSH : PROD_PUSH);
      assert.equal(call.method, 'POST');
      assert.equal(call.headers['apns-push-type'], 'liveactivity');
      assert.equal(call.headers['apns-topic'], `${BUNDLE_ID}.push-type.liveactivity`);
      assert.equal(call.headers['apns-priority'], '10');
      assert.ok(Math.abs(Number(call.headers['apns-expiration']) - (nowSec + 300)) <= 2);
      assert.match(call.headers['apns-request-id'], /^[0-9a-f-]{36}$/);
      const jwt = verifyJwt(call.headers.authorization, t.publicKey);
      assert.equal(jwt.valid, true);
      assert.deepEqual(jwt.header, { alg: 'ES256', kid: KEY_ID });
      assert.deepEqual(Object.keys(jwt.claims).sort(), ['iat', 'iss']);
      assert.equal(jwt.claims.iss, TEAM_ID);
      assert.equal(jwt.signatureLength, 64, 'IEEE-P1363 signature');

      const { aps } = call.json;
      assert.deepEqual(Object.keys(call.json), ['aps']);
      assert.equal(aps.event, 'start');
      assert.ok(Number.isInteger(aps.timestamp) && Math.abs(aps.timestamp - nowSec) <= 2);
      assert.equal(aps['attributes-type'], 'GameActivityAttributes');
      assert.equal(aps['input-push-channel'], stored.channels[env]);
      assert.deepEqual(aps.alert, { title: 'MAR vs LIN is live', body: 'Basketball · Follow the score on your Lock Screen' });
      assert.ok(aps['stale-date'] >= nowSec + 30 * 60 - 2);
      assert.deepEqual(Object.keys(aps.attributes).sort(), ATTRIBUTE_KEYS);
      assert.deepEqual(aps.attributes, {
        gameId: game.id, sport: 'basketball', sportName: 'Basketball', symbol: 'basketball.fill',
        homeName: 'Marquette', homeCode: 'MAR', homeColor: '#12214D', awayName: 'Lincoln', awayCode: 'LIN', awayColor: '#B22234',
      });
      const state = aps['content-state'];
      assert.deepEqual(
        { ...state, updatedAt: 0 },
        { status: 'live', homeScore: 0, awayScore: 0, periodLabel: '1st Quarter', periodShort: 'Q1', note: '', clockRemaining: 480, updatedAt: 0 },
      );
      assert.ok(Math.abs(state.updatedAt - nowSec) <= 2);
      assert.ok(Buffer.byteLength(JSON.stringify({ a: aps.attributes, c: state })) < 1024);
    }

    const logs = pushLog(t, game.id, 'start');
    const byEnv = Object.fromEntries(logs.map((row) => [row.environment, row]));
    assert.deepEqual([byEnv.production.sent, byEnv.production.failed, byEnv.sandbox.sent], [2, 0, 1]);
    assert.equal(pushLog(t, game.id, 'channel').filter((row) => row.sent === 1).length, 2);
  });

  it('marks invalid tokens and records failures', async () => {
    const gone = await register(t, 'invalid-gone');
    const bad = await register(t, 'invalid-bad');
    const good = await register(t, 'invalid-good');
    t.transport.respond((call) => {
      if (call.kind !== 'device') return undefined;
      if (call.path.endsWith(gone)) return { status: 410, body: '{"reason":"Unregistered","timestamp":1}' };
      if (call.path.endsWith(bad)) return { status: 400, body: '{"reason":"BadDeviceToken"}' };
      if (!call.path.endsWith(good)) return { status: 400, body: '{"reason":"DeviceTokenNotForTopic"}' };
      return undefined;
    });
    const { game } = await startedGame();
    const device = (token) => t.app.db.get('SELECT * FROM devices WHERE token = ?', token);
    assert.ok(device(gone).invalid_at);
    assert.equal(device(gone).last_error, 'Unregistered');
    assert.equal(device(bad).last_error, 'BadDeviceToken');
    assert.equal(device(good).invalid_at, null);
    const prod = pushLog(t, game.id, 'start').find((row) => row.environment === 'production');
    assert.equal(prod.sent, 1);
    assert.ok(prod.failed >= 2);
    assert.match(prod.detail, /410 Unregistered×1/);

    // Re-registering a token makes it valid again.
    await register(t, 'invalid-gone');
    assert.equal(device(gone).invalid_at, null);
  });

  it('broadcasts updates to the channel with priority by kind of change', async () => {
    const { game } = await startedGame();
    const stored = t.app.games.getGame(game.id);
    const startTimestamp = t.transport.byKind('device').at(-1)?.json.aps.timestamp ?? 0;
    const before = t.transport.calls.length;

    await act(admin, game.id, { type: 'score', team: 'home', points: 3 });
    await waitFor(() => t.transport.calls.slice(before).filter((c) => c.kind === 'broadcast').length === 2, { message: 'score broadcasts' });
    const broadcasts = t.transport.calls.slice(before).filter((c) => c.kind === 'broadcast');
    for (const call of broadcasts) {
      const env = call.origin === SANDBOX_PUSH ? 'sandbox' : 'production';
      assert.ok([PROD_PUSH, SANDBOX_PUSH].includes(call.origin));
      assert.equal(call.method, 'POST');
      assert.equal(call.path, `/4/broadcasts/apps/${BUNDLE_ID}`);
      assert.equal(call.headers['apns-channel-id'], stored.channels[env]);
      assert.equal(call.headers['apns-push-type'], 'liveactivity');
      assert.equal(call.headers['apns-priority'], '10');
      assert.equal(call.headers['apns-expiration'], '0');
      assert.equal(call.headers['apns-topic'], undefined);
      assert.equal(verifyJwt(call.headers.authorization, t.publicKey).valid, true);
      const { aps } = call.json;
      assert.deepEqual(Object.keys(aps).sort(), ['content-state', 'event', 'stale-date', 'timestamp']);
      assert.equal(aps.event, 'update');
      assert.ok(aps.timestamp > startTimestamp || aps.timestamp >= Math.floor(Date.now() / 1000));
      assert.equal(aps['content-state'].homeScore, 3);
      assert.ok(aps['stale-date'] >= Math.floor(Date.now() / 1000) + 30 * 60 - 2);
    }
    const timestamps = broadcasts.map((c) => c.json.aps.timestamp);

    const mark = t.transport.calls.length;
    await act(admin, game.id, { type: 'note', text: 'Timeout' });
    await waitFor(() => t.transport.calls.slice(mark).filter((c) => c.kind === 'broadcast').length === 2, { message: 'note broadcasts' });
    const noteCalls = t.transport.calls.slice(mark).filter((c) => c.kind === 'broadcast');
    assert.deepEqual(noteCalls.map((c) => c.headers['apns-priority']), ['5', '5']);
    assert.equal(noteCalls[0].json.aps['content-state'].note, 'Timeout');
    for (const call of noteCalls) assert.ok(call.json.aps.timestamp > Math.min(...timestamps), 'timestamps strictly increase');

    const clockMark = t.transport.calls.length;
    await act(admin, game.id, { type: 'clock', op: 'start' });
    await waitFor(() => t.transport.calls.slice(clockMark).filter((c) => c.kind === 'broadcast').length === 2, { message: 'clock broadcasts' });
    const clockCall = t.transport.calls.slice(clockMark).find((c) => c.kind === 'broadcast');
    assert.equal(clockCall.headers['apns-priority'], '10');
    const state = clockCall.json.aps['content-state'];
    assert.equal(state.clockRemaining, 480);
    assert.ok(Math.abs(state.clockEndsAt - (Date.now() / 1000 + 480)) < 3, 'clockEndsAt is unix seconds');
    assert.ok(clockCall.json.aps['stale-date'] >= Math.floor(state.clockEndsAt) + 600, 'stale date outlasts a running clock');

    // A claim change is not something the Lock Screen shows.
    const claimMark = t.transport.calls.length;
    await admin.post(`/api/games/${game.id}/release`, {});
    await sleep(50);
    assert.equal(t.transport.calls.slice(claimMark).filter((c) => c.kind === 'broadcast').length, 0);
  });

  it('coalesces rapid updates (leading + trailing) per game', async () => {
    const local = await startTestApp({ env: { APNS_MIN_UPDATE_INTERVAL_MS: '300', APNS_ENVIRONMENTS: 'production' } });
    try {
      const localAdmin = await local.signedIn('admin', 'admin');
      const game = await createGame(localAdmin, { scheduledAt: Date.now() });
      await startGame(localAdmin, game.id);
      await waitFor(() => local.app.games.getGame(game.id).channels.production);
      const mark = local.transport.calls.length;
      for (let i = 0; i < 5; i += 1) await act(localAdmin, game.id, { type: 'score', team: 'away', points: 1 });
      await waitFor(() => local.transport.calls.slice(mark).filter((c) => c.kind === 'broadcast').length >= 1);
      await sleep(30);
      assert.equal(local.transport.calls.slice(mark).filter((c) => c.kind === 'broadcast').length, 1, 'leading edge only so far');
      await waitFor(() => local.transport.calls.slice(mark).filter((c) => c.kind === 'broadcast').length === 2, { message: 'trailing update' });
      await sleep(400);
      const broadcasts = local.transport.calls.slice(mark).filter((c) => c.kind === 'broadcast');
      assert.equal(broadcasts.length, 2, 'five changes → two broadcasts');
      assert.equal(broadcasts[1].json.aps['content-state'].awayScore, 5, 'the trailing broadcast carries the latest state');
      assert.ok(broadcasts[1].at - broadcasts[0].at >= 250);
    } finally {
      await local.close();
    }
  });

  it('backs off on 429 and still delivers the latest state', async () => {
    const local = await startTestApp({ env: { APNS_MIN_UPDATE_INTERVAL_MS: '100', APNS_ENVIRONMENTS: 'production' } });
    try {
      const localAdmin = await local.signedIn('admin', 'admin');
      const game = await createGame(localAdmin, { scheduledAt: Date.now() });
      await startGame(localAdmin, game.id);
      await waitFor(() => local.app.games.getGame(game.id).channels.production);
      let throttled = 0;
      local.transport.respond((call) => {
        if (call.kind === 'broadcast' && throttled < 1) {
          throttled += 1;
          return { status: 429, body: '{"reason":"TooManyRequests"}' };
        }
        return undefined;
      });
      const mark = local.transport.calls.length;
      await act(localAdmin, game.id, { type: 'score', team: 'home', points: 2 });
      await waitFor(() => local.app.push.updateIntervalMs(game.id) === 1000, { message: 'interval doubled' });
      await waitFor(() => local.transport.calls.slice(mark).filter((c) => c.kind === 'broadcast').length === 2, { timeout: 4000, message: 'retry' });
      const [first, second] = local.transport.calls.slice(mark).filter((c) => c.kind === 'broadcast');
      assert.equal(second.json.aps['content-state'].homeScore, 2);
      assert.ok(second.at - first.at >= 900, 'retried after the backed-off interval');
      assert.ok(second.json.aps.timestamp > first.json.aps.timestamp);
      await waitFor(() => local.app.push.updateIntervalMs(game.id) === 100 || local.app.push.updateIntervalMs(game.id) === 0);
      const failedRow = local.app.db.get("SELECT * FROM push_log WHERE game_id = ? AND kind = 'update' AND failed = 1", game.id);
      assert.match(failedRow.detail, /429 TooManyRequests/);
    } finally {
      await local.close();
    }
  });

  it('recreates a channel that APNs no longer knows', async () => {
    const { game } = await startedGame();
    const oldChannel = t.app.games.getGame(game.id).channels.production;
    t.transport.respond((call) =>
      call.kind === 'broadcast' && call.headers['apns-channel-id'] === oldChannel ? { status: 400, body: '{"reason":"ChannelNotRegistered"}' } : undefined,
    );
    await act(admin, game.id, { type: 'score', team: 'home', points: 1 });
    await waitFor(() => t.app.games.getGame(game.id).channels.production === null, { message: 'channel cleared' });
    const mark = t.transport.calls.length;
    await act(admin, game.id, { type: 'score', team: 'home', points: 1 });
    await waitFor(() => t.app.games.getGame(game.id).channels.production, { message: 'channel recreated' });
    const recreated = t.app.games.getGame(game.id).channels.production;
    assert.notEqual(recreated, oldChannel);
    assert.ok(t.transport.calls.slice(mark).some((c) => c.kind === 'channel-create' && c.origin === PROD_MANAGE));
    await waitFor(() => t.transport.calls.slice(mark).some((c) => c.kind === 'broadcast' && c.headers['apns-channel-id'] === recreated));
  });

  it('broadcasts the end with a dismissal date, and cancels with a note', async () => {
    const { game } = await startedGame();
    await act(admin, game.id, { type: 'score', team: 'away', points: 7 });
    const mark = t.transport.calls.length;
    await admin.post(`/api/games/${game.id}/end`, {});
    await waitFor(() => t.transport.calls.slice(mark).filter((c) => c.kind === 'broadcast' && c.json.aps.event === 'end').length === 2, { message: 'end broadcasts' });
    const ends = t.transport.calls.slice(mark).filter((c) => c.json?.aps?.event === 'end');
    const nowSec = Math.floor(Date.now() / 1000);
    for (const call of ends) {
      assert.equal(call.path, `/4/broadcasts/apps/${BUNDLE_ID}`);
      assert.equal(call.headers['apns-priority'], '10');
      assert.equal(call.headers['apns-expiration'], '0');
      const { aps } = call.json;
      assert.deepEqual(Object.keys(aps).sort(), ['content-state', 'dismissal-date', 'event', 'timestamp']);
      assert.ok(Math.abs(aps['dismissal-date'] - (nowSec + 7200)) <= 2);
      assert.equal(aps['content-state'].status, 'final');
      assert.equal(aps['content-state'].awayScore, 7);
    }
    assert.equal(pushLog(t, game.id, 'end').filter((row) => row.sent === 1).length, 2);

    const second = (await startedGame()).game;
    const cancelMark = t.transport.calls.length;
    await admin.post(`/api/games/${second.id}/cancel`, {});
    await waitFor(() => t.transport.calls.slice(cancelMark).filter((c) => c.json?.aps?.event === 'end').length === 2);
    const cancel = t.transport.calls.slice(cancelMark).find((c) => c.json?.aps?.event === 'end');
    assert.equal(cancel.json.aps['content-state'].status, 'canceled');
    assert.equal(cancel.json.aps['content-state'].note, 'Canceled');
  });

  it('retries the end broadcast on transient failures', async () => {
    const { game } = await startedGame();
    let failures = 0;
    t.transport.respond((call) => {
      if (call.json?.aps?.event === 'end' && failures < 2) {
        failures += 1;
        return { status: 503, body: '{"reason":"ServiceUnavailable"}' };
      }
      return undefined;
    });
    await admin.post(`/api/games/${game.id}/end`, {});
    await waitFor(() => pushLog(t, game.id, 'end').length === 2, { message: 'end logged' });
    assert.equal(pushLog(t, game.id, 'end').reduce((sum, row) => sum + row.sent, 0), 2);
  });

  it('includes baseball outs and volleyball set points in the content state', async () => {
    const baseball = (await startedGame({ sport: 'baseball' })).game;
    const lastStart = t.transport.byKind('device').filter((c) => c.json.aps.attributes.gameId === baseball.id).at(-1);
    if (lastStart) {
      const state = lastStart.json.aps['content-state'];
      assert.equal(state.outs, 0);
      assert.equal(state.periodShort, '▲1');
      assert.equal('clockRemaining' in state, false);
    }
    const mark = t.transport.calls.length;
    await act(admin, baseball.id, { type: 'outs', delta: 1 });
    const outsCall = await waitFor(() => t.transport.calls.slice(mark).find((c) => c.kind === 'broadcast'));
    assert.equal(outsCall.json.aps['content-state'].outs, 1);

    const volleyball = (await startedGame({ sport: 'volleyball' })).game;
    const vMark = t.transport.calls.length;
    await act(admin, volleyball.id, { type: 'score', team: 'home', points: 1 });
    const vCall = await waitFor(() => t.transport.calls.slice(vMark).find((c) => c.kind === 'broadcast'));
    const state = vCall.json.aps['content-state'];
    assert.deepEqual([state.homeScore, state.awayScore, state.homeSetScore, state.awaySetScore], [0, 0, 1, 0]);
  });

  it('never fails an HTTP request because APNs is down', async () => {
    await register(t, 'network-down');
    t.transport.respond(() => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const game = await createGame(admin, { scheduledAt: Date.now() });
    const started = await admin.post(`/api/games/${game.id}/start`, {});
    assert.equal(started.status, 200);
    const scored = await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
    assert.equal(scored.status, 200);
    assert.equal((await admin.post(`/api/games/${game.id}/end`, {})).status, 200);
    await waitFor(() => pushLog(t, game.id, 'channel').length >= 2, { message: 'channel failures logged' });
    assert.ok(pushLog(t, game.id, 'channel').every((row) => row.failed === 1 && /ECONNREFUSED/.test(row.detail)));
    await waitFor(() => pushLog(t, game.id, 'start').length === 2);
    assert.match(pushLog(t, game.id, 'start')[0].detail, /skipped/);
  });

  it('checks APNs credentials by creating, reading and deleting a channel', async () => {
    const keeper = await t.signedIn('nonadmin');
    assert.equal((await keeper.post('/api/admin/apns-check', {})).status, 403);
    const mark = t.transport.calls.length;
    const res = await admin.post('/api/admin/apns-check', {});
    assert.equal(res.status, 200);
    assert.equal(res.json.results.production.ok, true);
    assert.equal(res.json.results.sandbox.ok, true);
    const calls = t.transport.calls.slice(mark);
    const deletes = calls.filter((c) => c.kind === 'channel-delete');
    assert.equal(deletes.length, 2);
    for (const call of deletes) {
      assert.equal(call.method, 'DELETE');
      assert.equal(call.path, `/1/apps/${BUNDLE_ID}/channels`);
      assert.ok(call.headers['apns-channel-id']);
      assert.ok([PROD_MANAGE, SANDBOX_MANAGE].includes(call.origin));
    }
    const reads = calls.filter((c) => c.kind === 'channel-read');
    assert.equal(reads.length, 2);
    assert.ok(reads.every((c) => c.method === 'GET' && c.headers['apns-channel-id']));

    t.transport.respond((call) => (call.kind === 'channel-create' && call.origin === PROD_MANAGE ? { status: 400, body: '{"reason":"FeatureNotEnabled"}' } : undefined));
    const failing = await admin.post('/api/admin/apns-check', {});
    assert.deepEqual(failing.json.results.production, { ok: false, error: '400 FeatureNotEnabled' });
    assert.equal(failing.json.results.sandbox.ok, true);
  });

  it('lists channels and reports admin status', async () => {
    const list = await t.app.apns.listChannels('production');
    assert.equal(list.ok, true);
    assert.deepEqual(list.channels, []);
    assert.equal(t.transport.calls.at(-1).path, `/1/apps/${BUNDLE_ID}/all-channels`);
    const status = await admin.get('/api/admin/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.json.apns, { configured: true, environments: ['production', 'sandbox'], teamId: TEAM_ID, keyId: KEY_ID, bundleId: BUNDLE_ID });
    assert.deepEqual(Object.keys(status.json.devices.production).sort(), ['enabled', 'invalid', 'total']);
    assert.ok(status.json.devices.production.invalid >= 1);
    assert.ok(status.json.recentPushes.length > 0 && status.json.recentPushes.length <= 50);
    assert.deepEqual(Object.keys(status.json.recentPushes[0]).sort(), ['createdAt', 'detail', 'environment', 'failed', 'gameId', 'id', 'kind', 'sent']);
    assert.equal(typeof status.json.sseClients, 'number');
  });
});

describe('push disabled', () => {
  it('runs without APNs credentials', async () => {
    const t = await startTestApp({ apns: false });
    try {
      const admin = await t.signedIn('admin', 'admin');
      await t.client().post('/api/devices', { token: hexToken('nopush'), environment: 'production', enabled: true });
      const health = await t.client().get('/api/health');
      assert.deepEqual(health.json.apns, { configured: false, environments: [] });
      assert.equal((await t.client().get('/api/config')).json.apnsEnabled, false);
      const game = await createGame(admin, { scheduledAt: Date.now() });
      const started = await admin.post(`/api/games/${game.id}/start`, {});
      assert.equal(started.json.push.queued, 0);
      assert.deepEqual(started.json.game.channels, { production: null, sandbox: null });
      await act(admin, game.id, { type: 'score', team: 'home', points: 1 });
      await admin.post(`/api/games/${game.id}/end`, {});
      await sleep(30);
      assert.equal(t.transport.calls.length, 0);
      const status = await admin.get('/api/admin/status');
      assert.equal(status.json.apns.configured, false);
      assert.match(status.json.apns.error, /not all set/);
      const check = await admin.post('/api/admin/apns-check', {});
      assert.equal(check.json.results.production.ok, false);
    } finally {
      await t.close();
    }
  });

  it('disables APNs when the key file is unreadable', async () => {
    const t = await startTestApp({ env: { APNS_KEY_PATH: '/nonexistent/AuthKey.p8' } });
    try {
      assert.equal(t.app.apns.configured, false);
      assert.match(t.app.apns.error, /Could not load the APNs key/);
    } finally {
      await t.close();
    }
  });
});
