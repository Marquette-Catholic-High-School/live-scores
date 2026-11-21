// Android Live Update pushes over Firebase Cloud Messaging (ARCHITECTURE.md
// §8.6): the message the Android app reads, the topics it goes to, coalescing,
// the update when a clock reaches 0:00, the end that must always arrive, and
// the switch that keeps all of it off by default.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { AndroidPushService } from '../server/android-push.js';
import { ConfigError, loadConfig } from '../server/config.js';
import { FcmClient } from '../server/fcm.js';
import { activityAttributes, activityContentState } from '../server/games.js';
import { act, createGame, sleep, startGame, startTestApp, waitFor } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60_000;
const TOKEN_URI = 'https://oauth2.test/token';
const FCM_SEND = 'https://fcm.googleapis.com/v1/projects/mchs-test/messages:send';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'mchs-test',
  client_email: 'push@mchs-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: TOKEN_URI,
};
const UNAVAILABLE = { status: 503, body: {} };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Google's token endpoint and FCM in one fake fetch. `sent` holds every
// message FCM was asked to send, with its two JSON strings already parsed.
// `answer(entry)` may return { status, body } (or an Error to throw) instead
// of the default 200.
class FakeFirebase {
  sent = [];
  tokens = 0;
  tokenAnswer = null;
  answer = null;
  fetch = async (url, init = {}) => {
    if (String(url) === TOKEN_URI) {
      this.tokens += 1;
      return this.tokenAnswer ? json(this.tokenAnswer.body, this.tokenAnswer.status) : json({ access_token: `token-${this.tokens}`, expires_in: 3600, token_type: 'Bearer' });
    }
    if (String(url) === FCM_SEND) {
      const { message } = JSON.parse(init.body);
      const data = message.data ?? {};
      const entry = {
        message,
        headers: init.headers,
        at: Date.now(),
        event: data.event,
        attributes: data.attributes ? JSON.parse(data.attributes) : null,
        state: data.state ? JSON.parse(data.state) : null,
      };
      this.sent.push(entry);
      const response = await this.answer?.(entry);
      if (response instanceof Error) throw response;
      return json(response?.body ?? { name: `projects/mchs-test/messages/${this.sent.length}` }, response?.status ?? 200);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  // The game messages for one game, in the order they were sent.
  game(gameId) {
    return this.sent.filter((entry) => entry.message.data?.kind === 'game' && entry.attributes.gameId === gameId);
  }

  events(gameId) {
    return this.game(gameId).map((entry) => entry.event);
  }
}

// Android alone unless `apns`: the game pushes must not depend on APNs.
async function startAndroidApp(firebase, { env = {}, gamePush = true, serviceAccount = true, apns = false, ...options } = {}) {
  return startTestApp({
    apns,
    ...options,
    env: { ...(gamePush ? { FCM_GAME_PUSH: '1' } : {}), ...env },
    appOptions: {
      fcmOptions: serviceAccount ? { fetch: firebase.fetch, serviceAccount: SERVICE_ACCOUNT, retryDelaysMs: [5, 10] } : { fetch: firebase.fetch },
      androidPushOptions: { retryDelaysMs: [20, 40] },
    },
  });
}

function pushLog(t, gameId, kind) {
  return t.app.db.all("SELECT * FROM push_log WHERE game_id = ? AND kind = ? AND environment = 'android' ORDER BY id", gameId, kind);
}

function pendingEnds(t, environment = 'android') {
  return t.app.db.all('SELECT * FROM pending_ends WHERE environment = ? ORDER BY game_id', environment);
}

async function liveGame(admin, overrides = {}) {
  const game = await createGame(admin, { scheduledAt: Date.now(), ...overrides });
  await startGame(admin, game.id);
  return game;
}

describe('Android game pushes: off by default', () => {
  it('reads FCM_GAME_PUSH and FCM_GAME_COLLAPSE, both off unless set', () => {
    assert.deepEqual({ ...loadConfig({}, { dotenv: false }).android }, { gamePush: false, collapse: false });
    assert.deepEqual({ ...loadConfig({ FCM_GAME_PUSH: '1', FCM_GAME_COLLAPSE: 'yes' }, { dotenv: false }).android }, { gamePush: true, collapse: true });
    assert.deepEqual({ ...loadConfig({ FCM_GAME_PUSH: 'off', FCM_GAME_COLLAPSE: '0' }, { dotenv: false }).android }, { gamePush: false, collapse: false });
    assert.throws(
      () => loadConfig({ FCM_GAME_PUSH: 'maybe', FCM_GAME_COLLAPSE: '2' }, { dotenv: false }),
      (err) => err instanceof ConfigError && ['FCM_GAME_PUSH', 'FCM_GAME_COLLAPSE'].every((key) => err.problems.some((problem) => problem.startsWith(key))),
    );
  });

  it('sends nothing while the switch is off, even with Firebase set up for the radio', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase, { gamePush: false });
    try {
      const admin = await t.signedIn('admin', 'admin');
      assert.equal((await t.client().get('/api/config')).json.androidLiveUpdates, false);
      assert.equal(t.app.fcm.configured, true, 'Firebase itself is set up');
      const game = await liveGame(admin);
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      await admin.post(`/api/games/${game.id}/end`, {});
      await t.app.scheduler.tick();
      await sleep(30);
      assert.equal(firebase.sent.length, 0);
      assert.equal(pendingEnds(t).length, 0);
      assert.deepEqual((await admin.get('/api/admin/status')).json.android, { enabled: false, projectId: null });
    } finally {
      await t.close();
    }
  });

  it('sends nothing without a service account, whatever the switch says', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase, { serviceAccount: false });
    try {
      const admin = await t.signedIn('admin', 'admin');
      assert.equal(t.config.android.gamePush, true);
      assert.equal((await t.client().get('/api/config')).json.androidLiveUpdates, false);
      const game = await liveGame(admin);
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      await admin.post(`/api/games/${game.id}/end`, {});
      await t.app.scheduler.tick();
      await sleep(30);
      assert.equal(firebase.sent.length, 0);
      assert.equal(pendingEnds(t).length, 0);
      assert.equal(t.app.db.get("SELECT COUNT(*) AS n FROM push_log WHERE environment = 'android'").n, 0);
      assert.deepEqual((await admin.get('/api/admin/status')).json.android, { enabled: false, projectId: null, error: 'FCM_SERVICE_ACCOUNT_PATH is not set.' });
    } finally {
      await t.close();
    }
  });

  it('reports androidLiveUpdates once it is switched on and Firebase is set up', async () => {
    const t = await startAndroidApp(new FakeFirebase());
    try {
      const admin = await t.signedIn('admin', 'admin');
      const config = (await t.client().get('/api/config')).json;
      assert.equal(config.androidLiveUpdates, true);
      assert.equal(config.apnsEnabled, false, 'it does not need APNs');
      assert.deepEqual((await admin.get('/api/admin/status')).json.android, { enabled: true, projectId: 'mchs-test' });
    } finally {
      await t.close();
    }
  });
});

describe('Android game pushes (fake Firebase)', () => {
  let firebase;
  let t;
  let admin;

  before(async () => {
    firebase = new FakeFirebase();
    t = await startAndroidApp(firebase);
    admin = await t.signedIn('admin', 'admin');
  });
  after(() => t.close());
  beforeEach(() => {
    firebase.answer = null;
  });

  it('sends the start as one data message to the two topics, with the objects of §8.5 as JSON text', async () => {
    const game = await liveGame(admin, { gender: 'girls', level: 'jv' });
    await waitFor(() => firebase.game(game.id).length === 1, { message: 'start message' });
    await sleep(30);
    const [start] = firebase.game(game.id);
    assert.equal(firebase.game(game.id).length, 1, 'one message, whoever follows the game');
    assert.equal(start.headers.authorization, 'Bearer token-1');

    const stored = t.app.games.getGame(game.id);
    const attributes = {
      gameId: game.id, sport: 'basketball', sportName: 'Girls JV Basketball', symbol: 'basketball.fill',
      homeName: 'Marquette', homeCode: 'MAR', homeColor: '#12214D', awayName: 'Lincoln', awayCode: 'LIN', awayColor: '#B22234',
    };
    assert.deepEqual(start.message, {
      condition: `'live-games' in topics || 'game-${game.id}' in topics`,
      android: { priority: 'HIGH', ttl: '120s' },
      data: { kind: 'game', event: 'start', attributes: JSON.stringify(attributes), state: JSON.stringify(activityContentState(stored)) },
    });
    for (const value of Object.values(start.message.data)) assert.equal(typeof value, 'string', 'FCM data values are strings');
    assert.ok(Buffer.byteLength(JSON.stringify(start.message.data)) < 2048, 'well under the 4 KB FCM allows');

    // The same two objects the Live Activity pushes carry.
    assert.deepEqual(start.attributes, activityAttributes(stored));
    assert.deepEqual(
      { ...start.state, updatedAt: 0 },
      {
        status: 'live', homeScore: 0, awayScore: 0, periodLabel: '1st Quarter', periodShort: 'Q1', note: '', clockRemaining: 480,
        homeFouls: 0, awayFouls: 0, homeBonus: false, awayBonus: false, updatedAt: 0,
      },
    );
    assert.ok(Math.abs(start.state.updatedAt - Date.now() / 1000) <= 2, 'updatedAt is unix seconds');

    const [row] = pushLog(t, game.id, 'start');
    assert.deepEqual([row.sent, row.failed], [1, 0]);
    await admin.post(`/api/games/${game.id}/end`, {});
  });

  // The Android app reads these leniently but by type (LiveUpdateContent.fromJson):
  // a string where it expects a number, or 54.5 for a score, is dropped there.
  it('sends every field with the JSON type the Android app reads', async () => {
    const whole = (value) => Number.isInteger(value);
    const seconds = (value) => typeof value === 'number' && Number.isFinite(value);
    const TYPES = {
      status: (value) => ['scheduled', 'live', 'final', 'canceled'].includes(value),
      homeScore: whole, awayScore: whole, homeSetScore: whole, awaySetScore: whole,
      periodLabel: (value) => typeof value === 'string', periodShort: (value) => typeof value === 'string', note: (value) => typeof value === 'string',
      clockRemaining: seconds, clockEndsAt: seconds, updatedAt: seconds,
      outs: whole, homeFouls: whole, awayFouls: whole,
      homeBonus: (value) => typeof value === 'boolean', awayBonus: (value) => typeof value === 'boolean',
    };
    const games = [];
    for (const sport of ['basketball', 'volleyball', 'baseball', 'football', 'soccer']) {
      const game = await liveGame(admin, { sport });
      await act(admin, game.id, { type: 'score', team: 'home', points: 1 });
      if (t.app.games.getGame(game.id).clock.ms !== null) await act(admin, game.id, { type: 'clock', op: 'start' });
      await admin.post(`/api/games/${game.id}/end`, {});
      games.push(game);
    }
    await waitFor(() => games.every((game) => firebase.events(game.id).includes('end')), { message: 'end messages' });
    let checked = 0;
    for (const game of games) {
      for (const entry of firebase.game(game.id)) {
        assert.match(entry.attributes.gameId, /^[A-Za-z0-9_-]{1,64}$/, 'a game id the app accepts, and a valid topic name');
        for (const [key, value] of Object.entries(entry.attributes)) assert.equal(typeof value, 'string', `attributes.${key}`);
        for (const key of ['status', 'homeScore', 'awayScore', 'periodLabel', 'periodShort', 'updatedAt']) assert.ok(key in entry.state, `state.${key} is always sent`);
        for (const [key, value] of Object.entries(entry.state)) {
          assert.ok(TYPES[key], `state.${key} is a field of §8.5`);
          assert.ok(TYPES[key](value), `state.${key} = ${JSON.stringify(value)} (${game.sport})`);
          checked += 1;
        }
      }
    }
    assert.ok(checked > 100);
  });

  it('sends an update for each change the Lock Screen shows, and none for other changes', async () => {
    const game = await liveGame(admin);
    await waitFor(() => firebase.game(game.id).length === 1, { message: 'start message' });

    await act(admin, game.id, { type: 'score', team: 'home', points: 3 });
    await waitFor(() => firebase.game(game.id).length === 2, { message: 'score update' });
    const score = firebase.game(game.id)[1];
    assert.equal(score.message.condition, `'live-games' in topics || 'game-${game.id}' in topics`);
    assert.deepEqual(score.message.android, { priority: 'HIGH', ttl: '120s' });
    assert.deepEqual(Object.keys(score.message.data), ['kind', 'event', 'attributes', 'state']);
    assert.deepEqual([score.message.data.kind, score.event], ['game', 'update']);
    assert.equal(score.state.homeScore, 3);
    assert.deepEqual(score.state, activityContentState(t.app.games.getGame(game.id)));
    assert.ok(score.state.updatedAt >= firebase.game(game.id)[0].state.updatedAt, 'later always wins on the phone');

    await act(admin, game.id, { type: 'note', text: 'Timeout' });
    await waitFor(() => firebase.game(game.id).length === 3, { message: 'note update' });
    assert.equal(firebase.game(game.id)[2].state.note, 'Timeout');

    await act(admin, game.id, { type: 'clock', op: 'start' });
    await waitFor(() => firebase.game(game.id).length === 4, { message: 'clock update' });
    const clock = firebase.game(game.id)[3].state;
    assert.equal(clock.clockRemaining, 480);
    assert.ok(Math.abs(clock.clockEndsAt - (Date.now() / 1000 + 480)) < 3, 'clockEndsAt is unix seconds');

    // A claim change and a new label are not something the Live Update's state shows.
    await admin.post(`/api/games/${game.id}/release`, {});
    await admin.patch(`/api/games/${game.id}`, { gender: 'boys', level: 'varsity' });
    await sleep(50);
    assert.equal(firebase.game(game.id).length, 4);
    // The label travels with the next message: every one has the attributes.
    await act(admin, game.id, { type: 'score', team: 'away', points: 2 });
    await waitFor(() => firebase.game(game.id).length === 5, { message: 'next update' });
    assert.equal(firebase.game(game.id)[4].attributes.sportName, 'Boys Varsity Basketball');

    assert.deepEqual(pushLog(t, game.id, 'update').map((row) => [row.sent, row.failed]), [[1, 0], [1, 0], [1, 0], [1, 0]]);
    await admin.post(`/api/games/${game.id}/end`, {});
  });

  it('sends baseball outs and volleyball set points as the Live Activity pushes do', async () => {
    const baseball = await liveGame(admin, { sport: 'baseball' });
    const start = await waitFor(() => firebase.game(baseball.id)[0], { message: 'baseball start' });
    assert.deepEqual([start.state.outs, start.state.periodShort, 'clockRemaining' in start.state], [0, '▲1', false]);

    const volleyball = await liveGame(admin, { sport: 'volleyball' });
    await act(admin, volleyball.id, { type: 'score', team: 'home', points: 1 });
    const update = await waitFor(() => firebase.game(volleyball.id)[1], { message: 'volleyball update' });
    assert.deepEqual([update.state.homeScore, update.state.awayScore, update.state.homeSetScore, update.state.awaySetScore], [0, 0, 1, 0]);
    assert.deepEqual(update.state, activityContentState(t.app.games.getGame(volleyball.id)));
    await admin.post(`/api/games/${baseball.id}/end`, {});
    await admin.post(`/api/games/${volleyball.id}/end`, {});
  });

  it('ends with the final state and a two-hour lifetime; a canceled game says so', async () => {
    const game = await liveGame(admin);
    await act(admin, game.id, { type: 'score', team: 'away', points: 7 });
    await act(admin, game.id, { type: 'note', text: 'Timeout' });
    await admin.post(`/api/games/${game.id}/end`, {});
    await waitFor(() => firebase.events(game.id).includes('end'), { message: 'end message' });
    assert.deepEqual(firebase.events(game.id), ['start', 'update', 'update', 'end'], 'the end is the last message');
    const end = firebase.game(game.id).at(-1);
    assert.equal(end.message.condition, `'live-games' in topics || 'game-${game.id}' in topics`);
    assert.deepEqual(end.message.android, { priority: 'HIGH', ttl: '7200s' });
    assert.deepEqual([end.state.status, end.state.awayScore, end.state.note], ['final', 7, '']);
    assert.deepEqual(end.state, activityContentState(t.app.games.getGame(game.id)));
    await waitFor(() => pushLog(t, game.id, 'end').length === 1, { message: 'end logged' });
    assert.deepEqual([pushLog(t, game.id, 'end')[0].sent, pushLog(t, game.id, 'end')[0].detail], [1, 'final']);
    assert.equal(pendingEnds(t).length, 0, 'nothing left to deliver');

    // A correction of a final game is not pushed (as for iPhones).
    await act(admin, game.id, { type: 'set_score', home: 1, away: 7 });
    await sleep(40);
    assert.equal(firebase.game(game.id).length, 4);

    const second = await liveGame(admin);
    await admin.post(`/api/games/${second.id}/cancel`, {});
    const cancel = await waitFor(() => firebase.game(second.id).find((entry) => entry.event === 'end'), { message: 'cancel message' });
    assert.deepEqual([cancel.state.status, cancel.state.note], ['canceled', 'Canceled']);
    assert.equal(cancel.message.android.ttl, '7200s');
    await waitFor(() => pushLog(t, second.id, 'end').length === 1);
    assert.equal(pushLog(t, second.id, 'end')[0].detail, 'canceled');
  });

  it('sends an update when the scoreboard feed changes the game', async () => {
    const game = await liveGame(admin);
    await waitFor(() => firebase.game(game.id).length === 1);
    t.app.games.applyScoreboard(game.id, { home: 12, away: 9, period: 2, clockMs: 95_000, clockRunning: false });
    const update = await waitFor(() => firebase.game(game.id)[1], { message: 'scoreboard update' });
    assert.deepEqual([update.event, update.state.homeScore, update.state.awayScore, update.state.periodShort, update.state.clockRemaining], ['update', 12, 9, 'Q2', 95]);
    await admin.post(`/api/games/${game.id}/end`, {});
  });

  it('never fails an HTTP request because Firebase is down', async () => {
    firebase.answer = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const game = await createGame(admin, { scheduledAt: Date.now() });
    assert.equal((await admin.post(`/api/games/${game.id}/start`, {})).status, 200);
    assert.equal((await act(admin, game.id, { type: 'score', team: 'home', points: 2 })).status, 200);
    assert.equal((await admin.post(`/api/games/${game.id}/end`, {})).status, 200);
    await waitFor(() => pushLog(t, game.id, 'end').length === 1, { message: 'end handed to the scheduler' });
    assert.match(pushLog(t, game.id, 'end')[0].detail, /fetch failed \(retrying every minute\)/);
    assert.ok(pushLog(t, game.id, 'start').length >= 1, 'the failed start is logged');
    assert.ok(pushLog(t, game.id, 'start').every((row) => row.failed === 1 && /fetch failed/.test(row.detail)));
    t.app.db.run("DELETE FROM pending_ends WHERE environment = 'android'");
  });
});

describe('Android game pushes: collapse key', () => {
  it('adds it to every message of the game only when FCM_GAME_COLLAPSE is on', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase, { env: { FCM_GAME_COLLAPSE: '1' } });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      await admin.post(`/api/games/${game.id}/end`, {});
      await waitFor(() => firebase.events(game.id).includes('end'), { message: 'end message' });
      assert.deepEqual(firebase.events(game.id), ['start', 'update', 'end']);
      assert.deepEqual(firebase.game(game.id).map((entry) => entry.message.android), [
        { priority: 'HIGH', collapse_key: `game-${game.id}`, ttl: '120s' },
        { priority: 'HIGH', collapse_key: `game-${game.id}`, ttl: '120s' },
        { priority: 'HIGH', collapse_key: `game-${game.id}`, ttl: '7200s' },
      ]);
    } finally {
      await t.close();
    }
  });
});

describe('Android game pushes: coalescing', () => {
  it('coalesces rapid updates (leading + trailing) per game, on the APNs interval', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase, { env: { APNS_MIN_UPDATE_INTERVAL_MS: '300' } });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      const other = await liveGame(admin);
      await waitFor(() => firebase.game(game.id).length === 1 && firebase.game(other.id).length === 1, { message: 'start messages' });
      for (let i = 0; i < 5; i += 1) await act(admin, game.id, { type: 'score', team: 'away', points: 1 });
      await waitFor(() => firebase.game(game.id).length >= 2, { message: 'leading update' });
      await sleep(30);
      assert.equal(firebase.game(game.id).length, 2, 'leading edge only so far: the first update is not held back by the start');
      // Each game has its own interval.
      await act(admin, other.id, { type: 'score', team: 'home', points: 1 });
      await waitFor(() => firebase.game(other.id).length === 2, { timeout: 200, message: "the other game's update" });
      await waitFor(() => firebase.game(game.id).length === 3, { message: 'trailing update' });
      await sleep(400);
      const [, leading, trailing] = firebase.game(game.id);
      assert.equal(firebase.game(game.id).length, 3, 'five changes → two updates');
      assert.equal(leading.state.awayScore, 1);
      assert.equal(trailing.state.awayScore, 5, 'the trailing update carries the latest state');
      assert.ok(trailing.at - leading.at >= 250);
    } finally {
      await t.close();
    }
  });

  it('still sends the start as a start when an update was on its way before it', async () => {
    // The hooks can run in this order when the scoreboard feed changes a game
    // in the moment it starts it. Driven by hand here, on a service of its own.
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase, { gamePush: false });
    const service = new AndroidPushService({
      db: t.app.db, fcm: t.app.fcm, config: { ...t.config, android: { gamePush: true, collapse: false } }, store: t.app.games,
    });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      const before = t.app.games.getGame(game.id);
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      const after = t.app.games.getGame(game.id);
      firebase.answer = async () => {
        await sleep(50);
        return undefined;
      };
      service.changed(before, after);
      service.start(after);
      await waitFor(() => firebase.game(game.id).length === 2, { message: 'both messages' });
      await service.flush(500);
      assert.deepEqual(firebase.events(game.id), ['update', 'start']);
      assert.equal(firebase.sent.length, 2, "and the app's own service, switched off, sent nothing");
    } finally {
      service.close();
      await t.close();
    }
  });

  it('sends an update Firebase could not take again, with the latest state, at a slower pace', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase, { env: { APNS_MIN_UPDATE_INTERVAL_MS: '100' } });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      await waitFor(() => firebase.game(game.id).length === 1, { message: 'start message' });
      const failOnce = () => {
        let failures = 0;
        firebase.answer = () => {
          if (failures >= 1) return undefined;
          failures += 1;
          return UNAVAILABLE;
        };
      };
      // Nothing else happens in the game: the update is sent again by itself.
      failOnce();
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      await waitFor(() => t.app.androidPush.updateIntervalMs(game.id) === 1000, { message: 'interval doubled' });
      await waitFor(() => firebase.game(game.id).length === 3, { timeout: 4000, message: 'retry' });
      const [, first, second] = firebase.game(game.id);
      assert.deepEqual([first.state.homeScore, second.state.homeScore], [2, 2]);
      assert.ok(second.at - first.at >= 900, 'retried after the backed-off interval');
      await waitFor(() => t.app.androidPush.updateIntervalMs(game.id) === 100, { message: 'back to the base interval' });
      const failed = t.app.db.all("SELECT * FROM push_log WHERE game_id = ? AND kind = 'update' AND environment = 'android' AND failed = 1", game.id);
      assert.deepEqual(failed.map((row) => row.detail), ['HTTP 503']);

      // The game moved on meanwhile: the retry carries the latest state, not the one that failed.
      await sleep(120);
      failOnce();
      await act(admin, game.id, { type: 'score', team: 'home', points: 1 });
      await waitFor(() => t.app.androidPush.updateIntervalMs(game.id) === 1000, { message: 'interval doubled again' });
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      await waitFor(() => firebase.game(game.id).length === 5, { timeout: 4000, message: 'second retry' });
      assert.deepEqual(firebase.game(game.id).slice(3).map((entry) => entry.state.homeScore), [3, 5]);
      await waitFor(() => t.app.androidPush.updateIntervalMs(game.id) === 100, { message: 'back to the base interval' });

      // A message Firebase rejects is not sent again; the next change goes out as usual.
      firebase.answer = (entry) => (entry.state.homeScore === 6 ? { status: 400, body: { error: { message: 'Invalid condition' } } } : undefined);
      await sleep(120);
      await act(admin, game.id, { type: 'score', team: 'home', points: 1 });
      await waitFor(() => pushLog(t, game.id, 'update').some((row) => row.detail === 'HTTP 400: Invalid condition'), { message: 'rejection logged' });
      await sleep(250);
      assert.equal(firebase.sent.filter((entry) => entry.state?.homeScore === 6).length, 1);
      assert.equal(t.app.androidPush.updateIntervalMs(game.id), 100, 'and it does not slow the game down');
      await act(admin, game.id, { type: 'score', team: 'home', points: 1 });
      await waitFor(() => firebase.game(game.id).at(-1).state.homeScore === 7, { message: 'next update' });
    } finally {
      await t.close();
    }
  });

  it('sends the latest state on a graceful shutdown', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase, { env: { APNS_MIN_UPDATE_INTERVAL_MS: '5000' } });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      await waitFor(() => firebase.game(game.id).length === 1, { message: 'start message' });
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      await waitFor(() => firebase.game(game.id).length === 2, { message: 'leading update' });
      await act(admin, game.id, { type: 'score', team: 'home', points: 3 });
      await t.close({ pushFlushTimeoutMs: 3000 });
      assert.deepEqual(firebase.game(game.id).map((entry) => entry.state.homeScore), [0, 2, 5]);
    } finally {
      await t.close();
    }
  });
});

describe('Android game pushes: a clock reaching 0:00', () => {
  // Phones count a running clock down by themselves, and a notification's
  // timer would count on below zero.
  async function runningClock(t, firebase, admin, remainingMs) {
    const game = await liveGame(admin);
    await act(admin, game.id, { type: 'clock', op: 'set', remainingMs });
    await waitFor(() => firebase.game(game.id).length === 2, { message: 'clock set' });
    await sleep(t.config.apns.minUpdateIntervalMs + 50);
    await act(admin, game.id, { type: 'clock', op: 'start' });
    const running = await waitFor(() => firebase.game(game.id)[2], { message: 'running clock' });
    assert.ok(running.state.clockEndsAt > Date.now() / 1000, 'phones are told when it reaches 0:00');
    return { game, running, endsAt: Math.round(running.state.clockEndsAt * 1000) };
  }

  it('sends an update at that moment, without waiting for the interval: the clock stopped at 0:00', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase, { env: { APNS_MIN_UPDATE_INTERVAL_MS: '800' } });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const { game, running, endsAt } = await runningClock(t, firebase, admin, 400);
      const zero = await waitFor(() => firebase.game(game.id)[3], { message: 'the 0:00 update' });
      assert.ok(zero.at >= endsAt - 5, `not before 0:00 (${zero.at - endsAt} ms)`);
      assert.ok(zero.at - endsAt < 350, `right at 0:00 (${zero.at - endsAt} ms)`);
      assert.ok(zero.at - running.at < 750, 'the 800 ms update interval is not waited out');
      assert.equal(zero.event, 'update');
      assert.deepEqual(zero.message.android, { priority: 'HIGH', ttl: '120s' });
      // Nothing about the game changed, so neither did updatedAt; only the clock is described as stopped.
      const { clockEndsAt, ...rest } = running.state;
      assert.equal(clockEndsAt * 1000, endsAt);
      assert.deepEqual(zero.state, { ...rest, clockRemaining: 0 });
      assert.equal(t.app.games.getGame(game.id).clock.running, true, 'the game itself is unchanged');

      await sleep(900);
      assert.equal(firebase.game(game.id).length, 4, 'once');
      // Whatever is sent from now on describes the run-out clock the same way.
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      const later = await waitFor(() => firebase.game(game.id)[4], { message: 'later update' });
      assert.deepEqual([later.state.homeScore, later.state.clockRemaining, 'clockEndsAt' in later.state], [2, 0, false]);
    } finally {
      await t.close();
    }
  });

  it('sends a change still waiting for the interval along at that moment', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase, { env: { APNS_MIN_UPDATE_INTERVAL_MS: '800' } });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const { game, running, endsAt } = await runningClock(t, firebase, admin, 400);
      // Stopped with time left, just after an update went out: the phone
      // would hear of it only after the interval, its own timer below zero by then.
      const stopped = await act(admin, game.id, { type: 'clock', op: 'stop' });
      const leftMs = stopped.json.game.clock.remainingMs;
      assert.ok(leftMs > 0, 'stopped before 0:00');
      const update = await waitFor(() => firebase.game(game.id)[3], { message: 'the update at 0:00' });
      assert.ok(update.at >= endsAt - 5 && update.at - running.at < 750, `at 0:00, not after the interval (${update.at - endsAt} ms)`);
      assert.equal(update.state.clockRemaining, leftMs / 1000, 'the time it really stopped at');
      assert.equal('clockEndsAt' in update.state, false);
      await sleep(900);
      assert.equal(firebase.game(game.id).length, 4, 'and not a second time after the interval');
    } finally {
      await t.close();
    }
  });

  it('sends one update, not two, when a change lands just as the clock runs out', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase);
    try {
      const admin = await t.signedIn('admin', 'admin');
      const { game, endsAt } = await runningClock(t, firebase, admin, 300);
      firebase.answer = async () => {
        await sleep(100);
        return undefined;
      };
      // Keep the server busy across 0:00, then change the game before its own
      // watch on the clock gets to run: that update already says 0:00.
      while (Date.now() < endsAt + 30) { /* busy */ }
      t.app.games.applyScoreboard(game.id, { home: 2 });
      const update = await waitFor(() => firebase.game(game.id)[3], { message: 'the update' });
      assert.deepEqual([update.state.homeScore, update.state.clockRemaining, 'clockEndsAt' in update.state], [2, 0, false]);
      await sleep(400);
      assert.equal(firebase.game(game.id).length, 4, 'the watch on the clock adds nothing to it');
    } finally {
      await t.close();
    }
  });

  it('sends nothing more when the phones already know the clock stopped', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase);
    try {
      const admin = await t.signedIn('admin', 'admin');
      const { game, endsAt } = await runningClock(t, firebase, admin, 300);
      await act(admin, game.id, { type: 'clock', op: 'stop' });
      await waitFor(() => firebase.game(game.id).length === 4, { message: 'clock stop' });
      await sleep(endsAt - Date.now() + 200);
      assert.equal(firebase.game(game.id).length, 4);
      // The same when the game ends first.
      const second = await runningClock(t, firebase, admin, 300);
      await admin.post(`/api/games/${second.game.id}/end`, {});
      await sleep(second.endsAt - Date.now() + 200);
      assert.deepEqual(firebase.events(second.game.id), ['start', 'update', 'update', 'end']);
    } finally {
      await t.close();
    }
  });
});

describe('Android game pushes: the end always arrives', () => {
  it('retries the end on transient failures', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase);
    try {
      const admin = await t.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      await waitFor(() => firebase.game(game.id).length === 1, { message: 'start message' });
      let failures = 0;
      firebase.answer = (entry) => {
        if (entry.event !== 'end' || failures >= 2) return undefined;
        failures += 1;
        return failures === 1 ? UNAVAILABLE : { status: 429, body: { error: { message: 'Quota exceeded' } } };
      };
      await admin.post(`/api/games/${game.id}/end`, {});
      await waitFor(() => pushLog(t, game.id, 'end').length === 1, { message: 'end logged' });
      assert.deepEqual(firebase.events(game.id), ['start', 'end', 'end', 'end']);
      assert.deepEqual([pushLog(t, game.id, 'end')[0].sent, pushLog(t, game.id, 'end')[0].failed], [1, 0]);
      assert.equal(pendingEnds(t).length, 0);
    } finally {
      await t.close();
    }
  });

  it('sends the end after an update still on its way', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase);
    try {
      const admin = await t.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      await waitFor(() => firebase.game(game.id).length === 1, { message: 'start message' });
      const answered = [];
      firebase.answer = async (entry) => {
        if (entry.event === 'update') await sleep(150);
        answered.push(entry.event);
        return undefined;
      };
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      await admin.post(`/api/games/${game.id}/end`, {});
      // Even when the scheduler runs in between.
      await t.app.scheduler.tick();
      await waitFor(() => pushLog(t, game.id, 'end').length === 1, { message: 'end logged' });
      assert.deepEqual(answered, ['update', 'end']);
      assert.deepEqual(firebase.events(game.id), ['start', 'update', 'end'], 'and only once');
    } finally {
      await t.close();
    }
  });

  it('keeps the end until Firebase takes it, across a restart and a deleted game', async () => {
    const firebase = new FakeFirebase();
    const first = await startAndroidApp(firebase);
    let second = null;
    try {
      const admin = await first.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      await act(admin, game.id, { type: 'score', team: 'home', points: 4 });
      await waitFor(() => firebase.game(game.id).length === 2, { message: 'update' });
      firebase.answer = (entry) => (entry.event === 'end' ? UNAVAILABLE : undefined);
      await admin.post(`/api/games/${game.id}/end`, {});
      await waitFor(() => pushLog(first, game.id, 'end').length === 1, { message: 'handed to the scheduler' });
      assert.equal(pushLog(first, game.id, 'end')[0].detail, 'HTTP 503 (retrying every minute)');
      const attempts = firebase.game(game.id).filter((entry) => entry.event === 'end');
      assert.equal(attempts.length, 3, 'tried three times right away');
      const [row] = pendingEnds(first);
      assert.deepEqual([row.game_id, row.channel_id, row.detail], [game.id, '', 'final']);
      assert.deepEqual(JSON.parse(row.payload), attempts[0].message);

      // Not before its next attempt is due.
      await first.app.scheduler.tick();
      assert.equal(firebase.game(game.id).filter((entry) => entry.event === 'end').length, 3);
      assert.equal((await admin.delete(`/api/games/${game.id}`)).status, 200);
      await first.close({ keepData: true });

      second = await startAndroidApp(firebase, { dir: first.dir, clock: first.clock });
      second.clock.advance(2 * MINUTE);
      await second.app.scheduler.tick();
      assert.equal(firebase.game(game.id).filter((entry) => entry.event === 'end').length, 4, 'retried after the restart');
      assert.equal(pendingEnds(second).length, 1, 'and kept: Firebase is still down');

      firebase.answer = null;
      second.clock.advance(2 * MINUTE);
      assert.deepEqual(await second.app.androidPush.resume(), { resynced: 0, ends: 1 });
      const delivered = firebase.game(game.id).at(-1);
      assert.deepEqual(delivered.message, attempts[0].message, 'the same end');
      assert.deepEqual([delivered.state.status, delivered.state.homeScore, delivered.message.android.ttl], ['final', 4, '7200s']);
      assert.equal(pendingEnds(second).length, 0);
      assert.deepEqual([pushLog(second, game.id, 'end').at(-1).sent, pushLog(second, game.id, 'end').at(-1).detail], [1, 'final']);
      await second.app.scheduler.tick();
      assert.equal(firebase.game(game.id).filter((entry) => entry.event === 'end').length, 5, 'once');
    } finally {
      if (second) await second.close();
      else await first.close();
    }
  });

  it('keeps retrying while Firebase refuses the service account, and gives up after 8 hours', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase);
    try {
      const admin = await t.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      await waitFor(() => firebase.game(game.id).length === 1, { message: 'start message' });
      firebase.answer = (entry) => (entry.event === 'end' ? { status: 403, body: { error: { message: 'Permission denied' } } } : undefined);
      await admin.post(`/api/games/${game.id}/end`, {});
      await waitFor(() => pushLog(t, game.id, 'end').length === 1, { message: 'handed to the scheduler' });
      assert.equal(pushLog(t, game.id, 'end')[0].detail, 'HTTP 403: Permission denied (retrying every minute)');
      assert.equal(pendingEnds(t).length, 1, 'someone can still fix the key');

      t.clock.advance(4 * HOUR);
      await t.app.scheduler.tick();
      assert.equal(pendingEnds(t).length, 1);
      assert.equal(pushLog(t, game.id, 'end').length, 1, 'retried quietly');

      t.clock.advance(4 * HOUR + MINUTE);
      await t.app.scheduler.tick();
      assert.equal(pendingEnds(t).length, 0, 'dropped');
      const last = pushLog(t, game.id, 'end').at(-1);
      assert.deepEqual([last.sent, last.failed, last.detail], [0, 1, 'HTTP 403: Permission denied']);
    } finally {
      await t.close();
    }
  });

  it('drops an end Firebase rejects', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase);
    try {
      const admin = await t.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      await waitFor(() => firebase.game(game.id).length === 1, { message: 'start message' });
      firebase.answer = (entry) => (entry.event === 'end' ? { status: 400, body: { error: { message: 'Invalid condition' } } } : undefined);
      await admin.post(`/api/games/${game.id}/end`, {});
      await waitFor(() => pushLog(t, game.id, 'end').length === 1, { message: 'end logged' });
      assert.deepEqual([pushLog(t, game.id, 'end')[0].failed, pushLog(t, game.id, 'end')[0].detail], [1, 'HTTP 400: Invalid condition']);
      assert.equal(firebase.game(game.id).filter((entry) => entry.event === 'end').length, 1);
      assert.equal(pendingEnds(t).length, 0);
    } finally {
      await t.close();
    }
  });

  it('forgets ends left over once game pushes are switched off', async () => {
    const firebase = new FakeFirebase();
    const first = await startAndroidApp(firebase);
    let second = null;
    try {
      const admin = await first.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      firebase.answer = (entry) => (entry.event === 'end' ? UNAVAILABLE : undefined);
      await admin.post(`/api/games/${game.id}/end`, {});
      await waitFor(() => pushLog(first, game.id, 'end').length === 1, { message: 'handed to the scheduler' });
      await first.close({ keepData: true });

      firebase.answer = null;
      const sent = firebase.sent.length;
      second = await startAndroidApp(firebase, { dir: first.dir, clock: first.clock, gamePush: false });
      second.clock.advance(HOUR);
      await second.app.scheduler.tick();
      assert.equal(pendingEnds(second).length, 1, 'kept for a while, in case the switch comes back on');
      second.clock.advance(8 * HOUR);
      await second.app.scheduler.tick();
      assert.equal(pendingEnds(second).length, 0);
      assert.equal(firebase.sent.length, sent, 'nothing is sent while it is off');
    } finally {
      if (second) await second.close();
      else await first.close();
    }
  });
});

describe('Android game pushes: restarts and APNs', () => {
  it('sends each live game one fresh update after a restart', async () => {
    const firebase = new FakeFirebase();
    const first = await startAndroidApp(firebase);
    let second = null;
    try {
      const admin = await first.signedIn('admin', 'admin');
      const game = await liveGame(admin);
      await act(admin, game.id, { type: 'score', team: 'home', points: 5 });
      await waitFor(() => firebase.game(game.id).length === 2, { message: 'update' });
      await first.close({ keepData: true });

      second = await startAndroidApp(firebase, { dir: first.dir, clock: first.clock });
      const summary = await second.app.scheduler.tick();
      assert.deepEqual(summary.androidPush, { resynced: 1, ends: 0 });
      const resync = await waitFor(() => firebase.game(game.id)[2], { message: 'state re-sent after the restart' });
      assert.deepEqual([resync.event, resync.state.homeScore], ['update', 5]);
      await second.app.scheduler.tick();
      await sleep(30);
      assert.equal(firebase.game(game.id).length, 3, 'once per restart');
    } finally {
      if (second) await second.close();
      else await first.close();
    }
  });

  it('runs beside the APNs flows: each delivers its own end', async () => {
    const firebase = new FakeFirebase();
    const t = await startAndroidApp(firebase, { apns: true, env: { APNS_ENVIRONMENTS: 'production' } });
    try {
      const admin = await t.signedIn('admin', 'admin');
      const apnsEnds = () => t.transport.byKind('broadcast').filter((call) => call.json.aps.event === 'end');
      const fcmEnds = (id) => firebase.game(id).filter((entry) => entry.event === 'end');
      const apnsLog = (id) => t.app.db.all("SELECT * FROM push_log WHERE game_id = ? AND kind = 'end' AND environment = 'production' ORDER BY id", id);

      // APNs is down for the end; Firebase takes its own.
      const game = await liveGame(admin);
      await waitFor(() => t.app.games.getGame(game.id).channels.production, { message: 'channel' });
      await act(admin, game.id, { type: 'score', team: 'home', points: 2 });
      await waitFor(() => firebase.game(game.id).length === 2 && t.transport.byKind('broadcast').length === 1, { message: 'update on both' });
      // The same content state on both, built by the same function.
      assert.deepEqual(firebase.game(game.id)[1].state, t.transport.byKind('broadcast')[0].json.aps['content-state']);
      t.transport.respond((call) => (call.json?.aps?.event === 'end' ? { status: 503, body: '{"reason":"ServiceUnavailable"}' } : undefined));
      await admin.post(`/api/games/${game.id}/end`, {});
      await waitFor(() => pushLog(t, game.id, 'end').length === 1 && apnsLog(game.id).length === 1, { message: 'both ends attempted' });
      assert.equal(pushLog(t, game.id, 'end')[0].sent, 1);
      assert.match(apnsLog(game.id)[0].detail, /retrying every minute/);
      assert.deepEqual([pendingEnds(t).length, pendingEnds(t, 'production').length], [0, 1]);
      t.transport.clearHandlers();
      t.clock.advance(2 * MINUTE);
      await t.app.scheduler.tick();
      assert.equal(pendingEnds(t, 'production').length, 0, 'the scheduler delivers the APNs end');
      assert.equal(fcmEnds(game.id).length, 1, 'and leaves Firebase alone');

      // Firebase is down for the end; APNs takes its own, and its scheduler
      // run doesn't touch (or drop) the Android one.
      const second = await liveGame(admin);
      await waitFor(() => t.app.games.getGame(second.id).channels.production, { message: 'channel' });
      const channel = t.app.games.getGame(second.id).channels.production;
      firebase.answer = (entry) => (entry.event === 'end' ? UNAVAILABLE : undefined);
      const mark = apnsEnds().length;
      await admin.post(`/api/games/${second.id}/end`, {});
      await waitFor(() => pushLog(t, second.id, 'end').length === 1 && apnsLog(second.id).length === 1, { message: 'both ends attempted' });
      assert.equal(apnsLog(second.id)[0].sent, 1);
      assert.deepEqual([pendingEnds(t).length, pendingEnds(t, 'production').length], [1, 0]);
      t.clock.advance(2 * MINUTE);
      await t.app.scheduler.tick();
      assert.equal(apnsEnds().length, mark + 1, 'no second APNs end');
      assert.equal(pendingEnds(t).length, 1, 'still waiting for Firebase');

      // The game's APNs channel is deleted on time all the same.
      t.clock.advance(6 * HOUR);
      await t.app.scheduler.tick();
      assert.ok(t.transport.byKind('channel-delete').some((call) => call.headers['apns-channel-id'] === channel));
      assert.equal(pendingEnds(t).length, 1);
      firebase.answer = null;
      t.clock.advance(2 * MINUTE);
      await t.app.scheduler.tick();
      assert.equal(pendingEnds(t).length, 0);
      assert.equal(pushLog(t, second.id, 'end').at(-1).sent, 1);

      // The same with an APNs update still on its way when the game ends: the
      // APNs end waits for it, and by then the Android end is saved beside its own.
      const third = await liveGame(admin);
      await waitFor(() => t.app.games.getGame(third.id).channels.production, { message: 'channel' });
      t.transport.respond(async (call) => {
        if (call.kind === 'broadcast' && call.json.aps.event === 'update') await sleep(120);
        return undefined;
      });
      firebase.answer = (entry) => (entry.event === 'end' ? UNAVAILABLE : undefined);
      await act(admin, third.id, { type: 'score', team: 'home', points: 2 });
      await admin.post(`/api/games/${third.id}/end`, {});
      await waitFor(() => pushLog(t, third.id, 'end').length === 1 && apnsLog(third.id).length === 1, { message: 'both ends attempted' });
      assert.equal(apnsLog(third.id)[0].sent, 1);
      assert.equal(t.app.db.get("SELECT COUNT(*) AS n FROM push_log WHERE game_id = ? AND detail LIKE '%UnknownEnvironment%'", third.id).n, 0);
      assert.deepEqual(pendingEnds(t).map((row) => row.game_id), [third.id], 'still there for the scheduler');
      t.transport.clearHandlers();
      firebase.answer = null;
      t.clock.advance(2 * MINUTE);
      await t.app.scheduler.tick();
      assert.equal(pendingEnds(t).length, 0);
    } finally {
      await t.close();
    }
  });
});

describe('FcmClient: a message Google did not take', () => {
  const MESSAGE = { topic: 'radio', notification: { title: 't', body: 'b' } };

  it('says whether it is worth sending again', async () => {
    const firebase = new FakeFirebase();
    const client = new FcmClient({ serviceAccount: SERVICE_ACCOUNT, fetch: firebase.fetch, retryDelaysMs: [5, 5] });

    firebase.answer = () => UNAVAILABLE;
    assert.deepEqual(await client.send(MESSAGE), { ok: false, error: 'HTTP 503', status: 503, transient: true, setup: false });
    assert.equal(firebase.sent.length, 3, "the client's own retries");
    await client.send(MESSAGE, { retryDelaysMs: [] });
    assert.equal(firebase.sent.length, 4, 'a call can do without them');

    firebase.answer = () => new TypeError('fetch failed');
    assert.deepEqual(await client.send(MESSAGE, { retryDelaysMs: [] }), { ok: false, error: 'fetch failed', status: null, transient: true, setup: false });

    firebase.answer = () => ({ status: 400, body: { error: { message: 'Invalid topic' } } });
    assert.deepEqual(await client.send(MESSAGE), { ok: false, error: 'HTTP 400: Invalid topic', status: 400, transient: false, setup: false });

    firebase.answer = () => ({ status: 403, body: { error: { message: 'Permission denied' } } });
    assert.deepEqual(await client.send(MESSAGE), { ok: false, error: 'HTTP 403: Permission denied', status: 403, transient: false, setup: true });
  });

  it('counts a rejected sign-in as a setup problem, but not one Google could not answer', async () => {
    const firebase = new FakeFirebase();
    firebase.tokenAnswer = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
    const client = new FcmClient({ serviceAccount: SERVICE_ACCOUNT, fetch: firebase.fetch, retryDelaysMs: [] });
    assert.deepEqual(await client.send(MESSAGE), {
      ok: false, error: 'Google sign-in failed: HTTP 400: Invalid JWT Signature.', status: 400, transient: false, setup: true,
    });
    firebase.tokenAnswer = { status: 503, body: {} };
    assert.deepEqual(await client.send(MESSAGE), { ok: false, error: 'Google sign-in failed: HTTP 503', status: 503, transient: true, setup: false });
    assert.equal(firebase.sent.length, 0);
  });

  it('refuses a key file whose token address is not a URL', () => {
    const client = new FcmClient({ serviceAccount: { ...SERVICE_ACCOUNT, token_uri: 'not a url' } });
    assert.equal(client.configured, false);
    assert.match(client.error, /"token_uri" is not a URL/);
  });
});
