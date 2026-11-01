import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { act, createGame, gameInput, hexToken, startGame, startTestApp } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const GAME_KEYS = [
  'id', 'sport', 'sportName', 'symbol', 'status', 'scheduledAt', 'location', 'home', 'away', 'period', 'periodLabel',
  'periodShort', 'isOvertime', 'line', 'outs', 'note', 'clock', 'options', 'rules', 'scorekeeper', 'canStartAt',
  'startedAt', 'endedAt', 'updatedAt', 'version',
];

describe('games', () => {
  let t;
  let admin;
  let keeper;
  let keeper2;
  before(async () => {
    t = await startTestApp();
    admin = await t.signedIn('admin', 'admin');
    keeper = await t.signedIn('keeper1');
    keeper2 = await t.signedIn('keeper2');
  });
  after(() => t.close());

  it('creates a game with validation and defaults', async () => {
    const scheduledAt = Date.now() + 3 * HOUR;
    const res = await admin.post('/api/games', gameInput({ scheduledAt }));
    assert.equal(res.status, 200);
    const game = res.json.game;
    assert.match(game.id, /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/);
    assert.deepEqual(Object.keys(game), GAME_KEYS);
    assert.equal(game.status, 'scheduled');
    assert.deepEqual(game.home, { name: 'Marquette', code: 'MAR', color: '#12214D', score: 0, setScore: null });
    assert.deepEqual(game.options, { clockEnabled: true, periodMinutes: 8, overtimeMinutes: 4, bestOf: null });
    assert.equal(game.rules.id, 'basketball');
    assert.equal(game.canStartAt, scheduledAt - 120 * 60 * 1000);
    assert.equal(game.scorekeeper, null);
    assert.equal(game.clock, null);
    assert.equal(game.outs, null);
    assert.equal(game.version, 1);

    const withDefaultHome = await admin.post('/api/games', { sport: 'volleyball', away: { name: 'Lincoln', code: 'LIN', color: '#B22234' }, scheduledAt, options: { bestOf: 5, clockEnabled: true } });
    assert.equal(withDefaultHome.status, 200);
    assert.deepEqual(withDefaultHome.json.game.home, { name: 'Marquette', code: 'MAR', color: '#12214D', score: 0, setScore: 0 });
    assert.deepEqual(withDefaultHome.json.game.options, { clockEnabled: false, periodMinutes: null, overtimeMinutes: null, bestOf: 5 });
    assert.equal(withDefaultHome.json.game.rules.periods.length, 5);

    const custom = await admin.post('/api/games', gameInput({ sport: 'football', options: { periodMinutes: 10, overtimeMinutes: 5 } }));
    assert.deepEqual(custom.json.game.options, { clockEnabled: true, periodMinutes: 10, overtimeMinutes: 5, bestOf: null });

    const invalid = [
      { sport: 'curling' },
      { home: { name: '', code: 'MAR', color: '#000000' } },
      { away: { name: 'Lincoln', code: 'L', color: '#000000' } },
      { away: { name: 'Lincoln', code: 'LINCO', color: '#000000' } },
      { away: { name: 'Lincoln', code: 'L-N', color: '#000000' } },
      { away: { name: 'Lincoln', code: 'LIN', color: 'red' } },
      { away: { name: 'x'.repeat(41), code: 'LIN', color: '#000000' } },
      { scheduledAt: 'tomorrow' },
      { scheduledAt: null },
      { options: { periodMinutes: 61 } },
      { options: { periodMinutes: 0 } },
      { options: { overtimeMinutes: 31 } },
      { options: { clockEnabled: 'yes' } },
      { sport: 'volleyball', options: { bestOf: 4 } },
    ];
    for (const overrides of invalid) {
      const bad = await admin.post('/api/games', gameInput(overrides));
      assert.equal(bad.status, 400, JSON.stringify(overrides));
      assert.equal(bad.json.error.code, 'bad_request');
    }
    const noAway = gameInput();
    delete noAway.away;
    assert.equal((await admin.post('/api/games', noAway)).status, 400);
    assert.equal((await keeper.post('/api/games', gameInput())).status, 403);
  });

  it('hides the scorekeeper from anonymous viewers', async () => {
    const game = await createGame(admin);
    await keeper.post(`/api/games/${game.id}/claim`, {});
    const anonymous = await t.client().get(`/api/games/${game.id}`);
    assert.equal(anonymous.status, 200);
    assert.equal('scorekeeper' in anonymous.json.game, false);
    const signedIn = await keeper2.get(`/api/games/${game.id}`);
    assert.deepEqual(signedIn.json.game.scorekeeper, { id: t.app.users.getByUsername('keeper1').id, name: 'keeper1 name' });
    assert.equal((await t.client().get('/api/games/doesnotexist')).status, 404);
  });

  it('patches games and locks team identity once started', async () => {
    const game = await createGame(admin);
    const patched = await admin.patch(`/api/games/${game.id}`, { location: 'Away Gym', home: { name: 'MCHS' }, options: { periodMinutes: 7 } });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.game.location, 'Away Gym');
    assert.deepEqual([patched.json.game.home.name, patched.json.game.home.code], ['MCHS', 'MAR']);
    assert.equal(patched.json.game.options.periodMinutes, 7);
    assert.equal(patched.json.game.version, game.version + 1);
    const sportChange = await admin.patch(`/api/games/${game.id}`, { sport: 'soccer' });
    assert.equal(sportChange.json.game.sport, 'soccer');
    assert.deepEqual(sportChange.json.game.options, { clockEnabled: true, periodMinutes: 40, overtimeMinutes: 10, bestOf: null });

    await startGame(admin, game.id);
    const locked = await admin.patch(`/api/games/${game.id}`, { away: { name: 'Someone Else' } });
    assert.equal(locked.status, 409);
    assert.equal((await admin.patch(`/api/games/${game.id}`, { sport: 'basketball' })).status, 409);
    const same = await admin.patch(`/api/games/${game.id}`, { home: { name: 'MCHS', code: 'MAR', color: '#12214D' }, location: 'Main Field' });
    assert.equal(same.status, 200, 'unchanged team values are fine');
    assert.equal(same.json.game.location, 'Main Field');
    assert.equal((await admin.patch(`/api/games/${game.id}`, { scheduledAt: 'soon' })).status, 400);
    assert.equal((await keeper.patch(`/api/games/${game.id}`, { location: 'x' })).status, 403);
  });

  it('applies clock option changes to a live game', async () => {
    const game = await createGame(admin, { sport: 'basketball' });
    await startGame(admin, game.id);
    const off = await admin.patch(`/api/games/${game.id}`, { options: { clockEnabled: false } });
    assert.equal(off.json.game.clock, null);
    const on = await admin.patch(`/api/games/${game.id}`, { options: { clockEnabled: true, periodMinutes: 6 } });
    assert.deepEqual([on.json.game.clock.running, on.json.game.clock.remainingMs, on.json.game.clock.periodMs], [false, 360000, 360000]);
    const volleyball = await createGame(admin, { sport: 'volleyball', options: { bestOf: 5 } });
    await startGame(admin, volleyball.id);
    for (let i = 0; i < 4; i += 1) await act(admin, volleyball.id, { type: 'period', delta: 1 });
    assert.equal((await admin.patch(`/api/games/${volleyball.id}`, { options: { bestOf: 3 } })).status, 409);
  });

  it('deletes games, but not live ones', async () => {
    const game = await createGame(admin);
    await startGame(admin, game.id);
    assert.equal((await admin.post(`/api/games/${game.id}/end`, {})).status, 200);
    const deleted = await admin.delete(`/api/games/${game.id}`);
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json.ok, true);
    assert.equal((await admin.get(`/api/games/${game.id}`)).status, 404);
    assert.equal((await admin.delete(`/api/games/${game.id}`)).status, 404);

    const live = await createGame(admin);
    await startGame(admin, live.id);
    assert.equal((await keeper.delete(`/api/games/${live.id}`)).status, 403);
    assert.equal((await admin.delete(`/api/games/${live.id}`)).status, 409);
    assert.equal((await admin.post(`/api/games/${live.id}/cancel`, {})).status, 200);
    assert.equal((await admin.delete(`/api/games/${live.id}`)).status, 200);
    assert.equal((await admin.get(`/api/games/${live.id}`)).status, 404);
    const events = t.app.db.all('SELECT type FROM game_events WHERE game_id = ?', live.id);
    assert.equal(events.length, 0, 'events go with the game');
  });

  it('clears the note when a game ends', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(admin, game.id);
    await act(admin, game.id, { type: 'note', text: 'Halftime' });
    const ended = await admin.post(`/api/games/${game.id}/end`, {});
    assert.equal(ended.json.game.note, '');
    assert.equal(t.app.games.getGame(game.id).note, '');

    const canceled = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(admin, canceled.id);
    await act(admin, canceled.id, { type: 'note', text: 'Weather Delay' });
    assert.equal((await admin.post(`/api/games/${canceled.id}/cancel`, {})).json.game.note, 'Weather Delay', 'cancel keeps the stored note');
  });

  it('keeps the games nearest to now when scope=all is over its limit, with paging back', async () => {
    const local = await startTestApp();
    try {
      const localAdmin = await local.signedIn('admin', 'admin');
      const now = Date.now();
      const insert = local.app.db.transaction.bind(local.app.db);
      insert(() => {
        for (let i = 0; i < 520; i += 1) {
          const at = now + (i + 1) * 24 * HOUR;
          local.app.db.run(
            `INSERT INTO games (id, sport, home_name, home_code, home_color, away_name, away_code, away_color, scheduled_at, status, created_at, updated_at)
             VALUES (?, 'soccer', 'Marquette', 'MAR', '#12214D', 'Future', 'FUT', '#000000', ?, 'scheduled', ?, ?)`,
            `future${String(i).padStart(4, '0')}`, at, now, now,
          );
        }
      });
      const tonight = await createGame(localAdmin, { scheduledAt: now + 2 * HOUR });
      const lastWeek = await createGame(localAdmin, { scheduledAt: now - 7 * 24 * HOUR });
      const all = (await localAdmin.get('/api/games?scope=all')).json.games;
      assert.equal(all.length, 500);
      const ids = all.map((g) => g.id);
      assert.ok(ids.includes(tonight.id), "tonight's game is kept");
      assert.ok(ids.includes(lastWeek.id), 'recent past games are kept');
      assert.ok(!ids.includes('future0519'), 'the furthest games are cut');
      const times = all.map((g) => g.scheduledAt);
      assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');

      const older = (await localAdmin.get(`/api/games?scope=all&before=${now}`)).json.games;
      assert.deepEqual(older.map((g) => g.id), [lastWeek.id]);
      assert.equal((await localAdmin.get('/api/games?scope=all&before=soon')).status, 400);
      assert.equal((await localAdmin.get(`/api/games?before=${now}`)).status, 400, 'board has no paging');
    } finally {
      await local.close();
    }
  });

  it('lists the board and all games', async () => {
    const now = Date.now();
    const soon = await createGame(admin, { scheduledAt: now + 2 * HOUR });
    const later = await createGame(admin, { scheduledAt: now + HOUR });
    const farFuture = await createGame(admin, { scheduledAt: now + 20 * 24 * HOUR });
    const old = await createGame(admin, { scheduledAt: now - 24 * HOUR });
    const live = await createGame(admin, { scheduledAt: now });
    await startGame(admin, live.id);

    const board = await t.client().get('/api/games');
    assert.equal(board.status, 200);
    const ids = board.json.games.map((g) => g.id);
    assert.ok(!ids.includes(farFuture.id), 'too far ahead');
    assert.ok(!ids.includes(old.id), 'scheduled more than 12 h ago');
    const statuses = board.json.games.map((g) => g.status);
    assert.equal(statuses[0], 'live');
    const order = { live: 0, scheduled: 1, final: 2, canceled: 2 };
    assert.deepEqual(statuses, [...statuses].sort((a, b) => order[a] - order[b]));
    assert.ok(ids.indexOf(later.id) < ids.indexOf(soon.id), 'scheduled ascending');

    assert.equal((await t.client().get('/api/games?scope=all')).status, 401);
    assert.equal((await t.client().get('/api/games?scope=bogus')).status, 400);
    const all = await keeper.get('/api/games?scope=all');
    assert.ok(all.json.games.some((g) => g.id === farFuture.id));
    assert.ok(all.json.games.some((g) => g.id === old.id));
    const times = all.json.games.map((g) => g.scheduledAt);
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  it('handles claim, release and admin force', async () => {
    const game = await createGame(admin);
    const claimed = await keeper.post(`/api/games/${game.id}/claim`, {});
    assert.equal(claimed.status, 200);
    assert.equal(claimed.json.game.scorekeeper.name, 'keeper1 name');
    assert.equal((await keeper.post(`/api/games/${game.id}/claim`, {})).status, 200, 'claiming again is a no-op');

    const taken = await keeper2.post(`/api/games/${game.id}/claim`, {});
    assert.equal(taken.status, 409);
    assert.equal(taken.json.error.code, 'conflict');
    assert.equal((await keeper2.post(`/api/games/${game.id}/claim`, { force: true })).status, 409, 'only admins may force');
    assert.equal((await admin.post(`/api/games/${game.id}/claim`, {})).status, 409);
    const forced = await admin.post(`/api/games/${game.id}/claim`, { force: true });
    assert.equal(forced.status, 200);
    assert.equal(forced.json.game.scorekeeper.name, 'admin name');

    assert.equal((await keeper.post(`/api/games/${game.id}/release`, {})).status, 403);
    assert.equal((await admin.post(`/api/games/${game.id}/release`, {})).json.game.scorekeeper, null);
    assert.equal((await keeper.post(`/api/games/${game.id}/claim`, {})).status, 200);
    assert.equal((await keeper.post(`/api/games/${game.id}/release`, {})).json.game.scorekeeper, null);

    await keeper.post(`/api/games/${game.id}/claim`, {});
    await startGame(admin, game.id);
    assert.equal((await keeper.post(`/api/games/${game.id}/release`, {})).status, 409, 'live games are released by admins only');
    assert.equal((await admin.post(`/api/games/${game.id}/release`, {})).status, 200);
    assert.equal((await t.client().post(`/api/games/${game.id}/claim`, {})).status, 401);
  });

  it('enforces the start window for scorekeepers but not admins', async () => {
    const future = await createGame(admin, { scheduledAt: Date.now() + 3 * HOUR });
    const early = await keeper.post(`/api/games/${future.id}/start`, {});
    assert.equal(early.status, 409);
    assert.equal(early.json.error.code, 'too_early');

    t.clock.advance(61 * 60 * 1000);
    const started = await keeper.post(`/api/games/${future.id}/start`, {});
    assert.equal(started.status, 200);
    t.clock.advance(-61 * 60 * 1000);
    const game = started.json.game;
    assert.equal(game.status, 'live');
    assert.equal(game.scorekeeper.name, 'keeper1 name', 'unclaimed game is auto-claimed');
    assert.deepEqual(game.line, [{ home: 0, away: 0 }]);
    assert.equal(game.period, 0);
    assert.equal(game.periodLabel, '1st Quarter');
    assert.deepEqual(game.clock, { running: false, remainingMs: 480000, anchorAt: game.clock.anchorAt, periodMs: 480000 });
    assert.equal(typeof game.startedAt, 'number');
    assert.deepEqual(Object.keys(game.channels).sort(), ['production', 'sandbox']);
    assert.equal(typeof started.json.push.queued, 'number');
    assert.equal((await keeper.post(`/api/games/${future.id}/start`, {})).status, 409);

    const adminGame = await createGame(admin, { scheduledAt: Date.now() + 48 * HOUR });
    assert.equal((await admin.post(`/api/games/${adminGame.id}/start`, {})).status, 200, 'admins may start any time');

    const held = await createGame(admin, { scheduledAt: Date.now() });
    await keeper2.post(`/api/games/${held.id}/claim`, {});
    const notMine = await keeper.post(`/api/games/${held.id}/start`, {});
    assert.equal(notMine.status, 409);
    assert.equal(notMine.json.error.code, 'conflict');
  });

  it('reports queued push-to-start devices', async () => {
    for (const [i, environment] of ['production', 'production', 'sandbox'].entries()) {
      await t.client().post('/api/devices', { token: hexToken(`queued-${i}`), environment, enabled: true, activitiesEnabled: true, appVersion: '5.0' });
    }
    await t.client().post('/api/devices', { token: hexToken('queued-off'), environment: 'production', enabled: false });
    const game = await createGame(admin, { scheduledAt: Date.now() });
    const res = await admin.post(`/api/games/${game.id}/start`, {});
    assert.equal(res.json.push.queued, 3);
  });

  it('ends and cancels games', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(keeper, game.id);
    await act(keeper, game.id, { type: 'clock', op: 'start' });
    assert.equal((await keeper2.post(`/api/games/${game.id}/end`, {})).status, 409, 'only the holder or an admin');
    const ended = await keeper.post(`/api/games/${game.id}/end`, {});
    assert.equal(ended.status, 200);
    assert.equal(ended.json.game.status, 'final');
    assert.equal(ended.json.game.clock.running, false);
    assert.equal(typeof ended.json.game.endedAt, 'number');
    assert.equal('channels' in ended.json.game, false, 'channels only while live');
    assert.equal((await keeper.post(`/api/games/${game.id}/end`, {})).status, 409);
    assert.equal((await act(keeper, game.id, { type: 'score', team: 'home', points: 2 })).status, 409);
    assert.equal((await admin.post(`/api/games/${game.id}/cancel`, {})).status, 409);

    const scheduled = await createGame(admin);
    assert.equal((await keeper.post(`/api/games/${scheduled.id}/cancel`, {})).status, 403);
    const canceled = await admin.post(`/api/games/${scheduled.id}/cancel`, {});
    assert.equal(canceled.json.game.status, 'canceled');
    assert.equal((await admin.post(`/api/games/${scheduled.id}/start`, {})).status, 409);

    const live = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(admin, live.id);
    const liveCanceled = await admin.post(`/api/games/${live.id}/cancel`, {});
    assert.equal(liveCanceled.json.game.status, 'canceled');
    assert.equal(typeof liveCanceled.json.game.endedAt, 'number');
  });
});
