import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { act, actionId, createGame, startGame, startTestApp, waitFor } from './helpers.js';

describe('scoring actions', () => {
  let t;
  let admin;
  let keeper;
  let other;

  async function liveGame(overrides = {}, client = keeper) {
    const game = await createGame(admin, { scheduledAt: Date.now(), ...overrides });
    await startGame(client, game.id);
    // Wait for the asynchronous channel creation so versions are stable.
    await waitFor(() => {
      const stored = t.app.games.getGame(game.id);
      return stored.channels.production && stored.channels.sandbox;
    });
    return (await client.get(`/api/games/${game.id}`)).json.game;
  }

  async function ok(client, id, action) {
    const res = await act(client, id, action);
    assert.equal(res.status, 200, `${JSON.stringify(action)} → ${res.text}`);
    return res.json.game;
  }

  before(async () => {
    t = await startTestApp();
    admin = await t.signedIn('admin', 'admin');
    keeper = await t.signedIn('keeper');
    other = await t.signedIn('other');
  });
  after(() => t.close());

  it('validates the action envelope and the claim', async () => {
    const game = await liveGame();
    assert.equal((await keeper.post(`/api/games/${game.id}/actions`, { type: 'score', team: 'home', points: 1 })).status, 400, 'actionId required');
    assert.equal((await keeper.post(`/api/games/${game.id}/actions`, { actionId: 'short', type: 'score', team: 'home', points: 1 })).status, 400);
    assert.equal((await act(keeper, game.id, { type: 'dance' })).status, 400);
    const notHolder = await act(other, game.id, { type: 'score', team: 'home', points: 1 });
    assert.equal(notHolder.status, 409);
    assert.equal((await act(admin, game.id, { type: 'score', team: 'home', points: 1 })).status, 200, 'admins may always score');
    assert.equal((await act(t.client(), game.id, { type: 'score', team: 'home', points: 1 })).status, 401);
    const scheduled = await createGame(admin);
    await keeper.post(`/api/games/${scheduled.id}/claim`, {});
    assert.equal((await act(keeper, scheduled.id, { type: 'score', team: 'home', points: 1 })).status, 409, 'not live');
    assert.equal((await act(keeper, 'missinggame', { type: 'score', team: 'home', points: 1 })).status, 404);
  });

  it('scores points within bounds', async () => {
    const game = await liveGame();
    let g = await ok(keeper, game.id, { type: 'score', team: 'home', points: 3 });
    g = await ok(keeper, game.id, { type: 'score', team: 'away', points: 2 });
    g = await ok(keeper, game.id, { type: 'score', team: 'home', points: -1 });
    assert.deepEqual([g.home.score, g.away.score], [2, 2]);
    assert.deepEqual(g.line, [{ home: 2, away: 2 }]);
    assert.equal(g.version, game.version + 3);
    assert.equal((await act(keeper, game.id, { type: 'score', team: 'away', points: -3 })).status, 409, "a period total can't go below 0");
    assert.equal((await act(keeper, game.id, { type: 'score', team: 'home', points: 0 })).status, 400);
    assert.equal((await act(keeper, game.id, { type: 'score', team: 'home', points: 11 })).status, 400);
    assert.equal((await act(keeper, game.id, { type: 'score', team: 'home', points: 1.5 })).status, 400);
    assert.equal((await act(keeper, game.id, { type: 'score', team: 'both', points: 1 })).status, 400);
  });

  it('replays an actionId idempotently', async () => {
    const game = await liveGame();
    const id = actionId();
    const first = await keeper.post(`/api/games/${game.id}/actions`, { actionId: id, type: 'score', team: 'home', points: 2 });
    assert.equal(first.status, 200);
    assert.equal(first.json.duplicate, undefined);
    const replay = await keeper.post(`/api/games/${game.id}/actions`, { actionId: id, type: 'score', team: 'home', points: 2 });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.duplicate, true);
    assert.equal(replay.json.game.home.score, 2);
    assert.equal(replay.json.game.version, first.json.game.version);
    const events = t.app.db.all('SELECT * FROM game_events WHERE game_id = ? AND action_id = ?', game.id, id);
    assert.equal(events.length, 1);
  });

  it('corrects totals with set_score', async () => {
    const game = await liveGame();
    await ok(keeper, game.id, { type: 'score', team: 'home', points: 10 });
    await ok(keeper, game.id, { type: 'period', delta: 1 });
    await ok(keeper, game.id, { type: 'score', team: 'away', points: 4 });
    let g = await ok(keeper, game.id, { type: 'set_score', home: 15, away: 6 });
    assert.deepEqual([g.home.score, g.away.score], [15, 6]);
    assert.deepEqual(g.line, [{ home: 10, away: 0 }, { home: 5, away: 6 }]);
    // A decrease the current period can't absorb comes off earlier periods.
    g = await ok(keeper, game.id, { type: 'set_score', home: 9, away: 6 });
    assert.deepEqual(g.line, [{ home: 9, away: 0 }, { home: 0, away: 6 }]);
    // With an explicit period the difference goes into that period only.
    g = await ok(keeper, game.id, { type: 'set_score', home: 9, away: 8, period: 0 });
    assert.deepEqual(g.line, [{ home: 9, away: 2 }, { home: 0, away: 6 }]);
    const tooLow = await act(keeper, game.id, { type: 'set_score', home: 9, away: 1, period: 0 });
    assert.equal(tooLow.status, 409, 'the other periods already have more');
    assert.equal((await act(keeper, game.id, { type: 'set_score', home: 9, away: 8, period: 2 })).status, 400, 'not a period reached yet');
    assert.equal((await act(keeper, game.id, { type: 'set_score', home: 9, away: 8, period: -1 })).status, 400);
    assert.equal((await act(keeper, game.id, { type: 'set_score', home: -1, away: 6 })).status, 400);
    g = await ok(keeper, game.id, { type: 'undo' });
    assert.deepEqual(g.line, [{ home: 9, away: 0 }, { home: 0, away: 6 }]);
  });

  it('takes a minus correction off earlier periods once the period has moved on', async () => {
    const game = await liveGame();
    await ok(keeper, game.id, { type: 'score', team: 'home', points: 2 });
    await ok(keeper, game.id, { type: 'period', delta: 1 });
    await ok(keeper, game.id, { type: 'score', team: 'home', points: 1 });
    let g = await ok(keeper, game.id, { type: 'score', team: 'home', points: -2 });
    assert.deepEqual(g.line, [{ home: 1, away: 0 }, { home: 0, away: 0 }]);
    assert.equal(g.home.score, 1);
    assert.equal((await act(keeper, game.id, { type: 'score', team: 'home', points: -2 })).status, 409, 'never below 0 in total');
    g = await ok(keeper, game.id, { type: 'score', team: 'home', points: -1 });
    assert.equal(g.home.score, 0);

    const volleyball = await liveGame({ sport: 'volleyball' });
    await ok(keeper, volleyball.id, { type: 'score', team: 'home', points: 3 });
    await ok(keeper, volleyball.id, { type: 'period', delta: 1 });
    assert.equal((await act(keeper, volleyball.id, { type: 'score', team: 'home', points: -1 })).status, 409, "a set's points stay in that set");
  });

  it('lets an admin correct any period of a final game', async () => {
    const football = await liveGame({ sport: 'football' });
    await ok(keeper, football.id, { type: 'score', team: 'home', points: 7 });
    await ok(keeper, football.id, { type: 'period', delta: 1 });
    await ok(keeper, football.id, { type: 'score', team: 'home', points: 7 });
    await ok(keeper, football.id, { type: 'score', team: 'away', points: 7 });
    await ok(keeper, football.id, { type: 'score', team: 'away', points: 7 });
    await ok(keeper, football.id, { type: 'period', delta: 1 });
    await ok(keeper, football.id, { type: 'period', delta: 1 });
    await keeper.post(`/api/games/${football.id}/end`, {});
    // The Q2 touchdown was the visitors': 14-14 should be 7-21.
    let g = await ok(admin, football.id, { type: 'set_score', home: 7, away: 21 });
    assert.deepEqual([g.status, g.home.score, g.away.score], ['final', 7, 21]);
    g = await ok(admin, football.id, { type: 'set_score', home: 7, away: 21, period: 1 });
    assert.deepEqual([g.home.score, g.away.score], [7, 21]);

    const volleyball = await liveGame({ sport: 'volleyball' });
    await ok(keeper, volleyball.id, { type: 'set_score', home: 25, away: 23 });
    await ok(keeper, volleyball.id, { type: 'period', delta: 1 });
    await ok(keeper, volleyball.id, { type: 'set_score', home: 20, away: 25 });
    await ok(keeper, volleyball.id, { type: 'period', delta: 1 });
    await ok(keeper, volleyball.id, { type: 'set_score', home: 10, away: 15 });
    g = (await keeper.post(`/api/games/${volleyball.id}/end`, {})).json.game;
    assert.deepEqual([g.home.score, g.away.score], [1, 2]);
    assert.equal((await act(keeper, volleyball.id, { type: 'set_score', home: 23, away: 25, period: 0 })).status, 409, 'scorekeepers cannot touch a final game');
    g = await ok(admin, volleyball.id, { type: 'set_score', home: 25, away: 27, period: 0 });
    assert.deepEqual(g.line.map((set) => [set.home, set.away]), [[25, 27], [20, 25], [10, 15]]);
    assert.deepEqual([g.home.score, g.away.score], [0, 3]);
  });

  it('stops the clock at the time the scorekeeper saw', async () => {
    const game = await liveGame();
    await ok(keeper, game.id, { type: 'clock', op: 'start' });
    t.clock.advance(20_000);
    // Tapped at 7:50 (10 s after the start), arrived 10 s later.
    let g = await ok(keeper, game.id, { type: 'clock', op: 'stop', remainingMs: 470_000 });
    assert.deepEqual([g.clock.running, g.clock.remainingMs], [false, 470_000]);
    await ok(keeper, game.id, { type: 'clock', op: 'start' });
    t.clock.advance(5_000);
    g = await ok(keeper, game.id, { type: 'clock', op: 'stop', remainingMs: 479_000 });
    assert.equal(g.clock.remainingMs, 470_000, 'never more than when the clock last started');
    await ok(keeper, game.id, { type: 'clock', op: 'start' });
    t.clock.advance(5_000);
    g = await ok(keeper, game.id, { type: 'clock', op: 'stop', remainingMs: 1_000 });
    assert.ok(g.clock.remainingMs >= 464_000 && g.clock.remainingMs <= 465_000, 'never less than what is left now');
    await ok(keeper, game.id, { type: 'clock', op: 'start' });
    assert.equal((await act(keeper, game.id, { type: 'clock', op: 'stop', remainingMs: 'soon' })).status, 400);
    t.clock.advance(-30_000);
  });

  it('moves between periods, resetting clock, outs and note', async () => {
    const game = await liveGame();
    await ok(keeper, game.id, { type: 'note', text: 'Timeout' });
    await ok(keeper, game.id, { type: 'clock', op: 'start' });
    let g = await ok(keeper, game.id, { type: 'period', delta: 1 });
    assert.equal(g.period, 1);
    assert.equal(g.periodLabel, '2nd Quarter');
    assert.equal(g.periodShort, 'Q2');
    assert.equal(g.note, '');
    assert.deepEqual([g.clock.running, g.clock.remainingMs], [false, 480000]);
    assert.equal(g.line.length, 2);
    g = await ok(keeper, game.id, { type: 'period', delta: -1 });
    assert.equal(g.period, 0);
    assert.equal(g.line.length, 1, 'an empty period reached by mistake is dropped');
    assert.equal((await act(keeper, game.id, { type: 'period', delta: -1 })).status, 409);
    assert.equal((await act(keeper, game.id, { type: 'period', delta: 2 })).status, 400);
    for (let i = 0; i < 4; i += 1) g = await ok(keeper, game.id, { type: 'period', delta: 1 });
    assert.deepEqual([g.period, g.periodLabel, g.periodShort, g.isOvertime], [4, 'Overtime', 'OT', true]);
    assert.equal(g.clock.remainingMs, 4 * 60_000, 'basketball overtime clock');
    g = await ok(keeper, game.id, { type: 'period', delta: 1 });
    assert.equal(g.periodShort, '2OT');

    const soccer = await liveGame({ sport: 'soccer' });
    for (let i = 0; i < 3; i += 1) g = await ok(keeper, soccer.id, { type: 'period', delta: 1 });
    assert.deepEqual([g.periodShort, g.clock.remainingMs], ['OT2', 10 * 60_000]);
    assert.equal((await act(keeper, soccer.id, { type: 'period', delta: 1 })).status, 409, 'soccer has two overtimes');
  });

  it('runs the game clock', async () => {
    const game = await liveGame();
    let g = await ok(keeper, game.id, { type: 'clock', op: 'start' });
    assert.equal(g.clock.running, true);
    assert.equal(g.clock.remainingMs, 480000);
    assert.equal((await act(keeper, game.id, { type: 'clock', op: 'start' })).status, 409);
    t.clock.advance(30_000);
    g = await ok(keeper, game.id, { type: 'clock', op: 'stop' });
    assert.equal(g.clock.running, false);
    assert.ok(g.clock.remainingMs <= 450_000 && g.clock.remainingMs > 449_000, `remaining ${g.clock.remainingMs}`);
    assert.equal((await act(keeper, game.id, { type: 'clock', op: 'stop' })).status, 409);
    g = await ok(keeper, game.id, { type: 'clock', op: 'set', remainingMs: 120_000 });
    assert.deepEqual([g.clock.running, g.clock.remainingMs], [false, 120_000]);
    await ok(keeper, game.id, { type: 'clock', op: 'start' });
    g = await ok(keeper, game.id, { type: 'clock', op: 'set', remainingMs: 60_000 });
    assert.deepEqual([g.clock.running, g.clock.remainingMs], [true, 60_000], 'set keeps the running state and re-anchors');
    assert.ok(Math.abs(g.clock.anchorAt - t.clock.now()) < 1000);
    g = await ok(keeper, game.id, { type: 'clock', op: 'set', remainingMs: 59_999.6 });
    assert.equal(g.clock.remainingMs, 60_000, 'fractional milliseconds are rounded');
    assert.equal((await act(keeper, game.id, { type: 'clock', op: 'set', remainingMs: 3_600_001 })).status, 400);
    assert.equal((await act(keeper, game.id, { type: 'clock', op: 'set', remainingMs: '60000' })).status, 400);
    assert.equal((await act(keeper, game.id, { type: 'clock', op: 'set' })).status, 400);
    assert.equal((await act(keeper, game.id, { type: 'clock', op: 'pause' })).status, 400);
    t.clock.advance(-30_000);
  });

  it('has no clock in football overtime or with the clock disabled', async () => {
    const game = await liveGame({ sport: 'football' });
    assert.equal(game.clock.remainingMs, 12 * 60_000);
    let g;
    for (let i = 0; i < 4; i += 1) g = await ok(keeper, game.id, { type: 'period', delta: 1 });
    assert.equal(g.periodLabel, 'Overtime');
    assert.equal(g.clock, null);
    const res = await act(keeper, game.id, { type: 'clock', op: 'start' });
    assert.equal(res.status, 409);

    const noClock = await liveGame({ sport: 'basketball', options: { clockEnabled: false } });
    assert.equal(noClock.clock, null);
    assert.equal((await act(keeper, noClock.id, { type: 'clock', op: 'start' })).status, 409);
  });

  it('tracks baseball outs and auto-advances the half-inning', async () => {
    const game = await liveGame({ sport: 'baseball' });
    assert.equal(game.outs, 0);
    assert.equal(game.periodLabel, 'Top 1st');
    assert.equal(game.clock, null);
    await ok(keeper, game.id, { type: 'note', text: 'Pitching Change' });
    let g = await ok(keeper, game.id, { type: 'outs', delta: 1 });
    g = await ok(keeper, game.id, { type: 'outs', delta: 1 });
    assert.equal(g.outs, 2);
    g = await ok(keeper, game.id, { type: 'outs', delta: 1 });
    assert.deepEqual([g.outs, g.period, g.periodLabel, g.periodShort, g.note], [0, 1, 'Bottom 1st', '▼1', '']);
    assert.equal(g.line.length, 2);
    assert.equal((await act(keeper, game.id, { type: 'outs', delta: -1 })).status, 409, 'never below 0');
    await ok(keeper, game.id, { type: 'outs', delta: 1 });
    g = await ok(keeper, game.id, { type: 'outs', delta: -1 });
    assert.equal(g.outs, 0);
    g = await ok(keeper, game.id, { type: 'undo' });
    assert.equal(g.outs, 1);
    const basketball = await liveGame();
    assert.equal(basketball.outs, null);
    assert.equal((await act(keeper, basketball.id, { type: 'outs', delta: 1 })).status, 400);
  });

  it('sets and clears the note', async () => {
    const game = await liveGame();
    let g = await ok(keeper, game.id, { type: 'note', text: '  Halftime  ' });
    assert.equal(g.note, 'Halftime');
    assert.equal((await act(keeper, game.id, { type: 'note', text: 'x'.repeat(41) })).status, 400);
    assert.equal((await act(keeper, game.id, { type: 'note', text: 'line\nbreak' })).status, 400);
    assert.equal((await act(keeper, game.id, { type: 'note' })).status, 400);
    g = await ok(keeper, game.id, { type: 'note', text: '' });
    assert.equal(g.note, '');
  });

  it('undoes the most recent scoring actions in order', async () => {
    const game = await liveGame();
    assert.equal((await act(keeper, game.id, { type: 'undo' })).status, 409, 'nothing to undo');
    await ok(keeper, game.id, { type: 'score', team: 'home', points: 3 });
    await ok(keeper, game.id, { type: 'period', delta: 1 });
    await ok(keeper, game.id, { type: 'score', team: 'away', points: 2 });
    await ok(keeper, game.id, { type: 'note', text: 'Timeout' });
    await ok(keeper, game.id, { type: 'clock', op: 'set', remainingMs: 1000 });

    let g = await ok(keeper, game.id, { type: 'undo' });
    assert.equal(g.clock.remainingMs, 480000);
    g = await ok(keeper, game.id, { type: 'undo' });
    assert.equal(g.note, '');
    g = await ok(keeper, game.id, { type: 'undo' });
    assert.deepEqual([g.home.score, g.away.score, g.period], [3, 0, 1]);
    g = await ok(keeper, game.id, { type: 'undo' });
    assert.deepEqual([g.period, g.line.length, g.periodLabel], [0, 1, '1st Quarter']);
    g = await ok(keeper, game.id, { type: 'undo' });
    assert.deepEqual([g.home.score, g.away.score], [0, 0]);
    assert.equal((await act(keeper, game.id, { type: 'undo' })).status, 409);
    const undone = t.app.db.get("SELECT COUNT(*) AS n FROM game_events WHERE game_id = ? AND undone = 1", game.id).n;
    assert.equal(undone, 5);
  });

  it('keeps undo consistent with options edited mid-game', async () => {
    const game = await liveGame();
    await ok(keeper, game.id, { type: 'score', team: 'home', points: 2 });
    assert.equal((await admin.patch(`/api/games/${game.id}`, { options: { clockEnabled: false } })).status, 200);
    let g = await ok(keeper, game.id, { type: 'undo' });
    assert.equal(g.home.score, 0);
    assert.equal(g.clock, null, 'the undone action does not bring back a disabled clock');
    assert.equal((await act(keeper, game.id, { type: 'clock', op: 'start' })).status, 409);

    await ok(keeper, game.id, { type: 'score', team: 'away', points: 1 });
    assert.equal((await admin.patch(`/api/games/${game.id}`, { options: { clockEnabled: true, periodMinutes: 5 } })).status, 200);
    g = await ok(keeper, game.id, { type: 'undo' });
    assert.deepEqual([g.away.score, g.clock.running, g.clock.remainingMs], [0, false, 300000], 'a newly enabled clock stays');

    const volleyball = await liveGame({ sport: 'volleyball', options: { bestOf: 5 } });
    for (let i = 0; i < 3; i += 1) await ok(keeper, volleyball.id, { type: 'period', delta: 1 });
    await ok(keeper, volleyball.id, { type: 'period', delta: -1 });
    assert.equal((await admin.patch(`/api/games/${volleyball.id}`, { options: { bestOf: 3 } })).status, 200);
    const refused = await act(keeper, volleyball.id, { type: 'undo' });
    assert.equal(refused.status, 409, 'cannot undo back into a fourth set of a best-of-3');
    assert.equal((await keeper.get(`/api/games/${volleyball.id}`)).json.game.period, 2);
  });

  it('computes volleyball sets (best of 5)', async () => {
    const game = await liveGame({ sport: 'volleyball', options: { bestOf: 5 } });
    assert.deepEqual([game.home.setScore, game.away.setScore, game.periodLabel, game.periodShort], [0, 0, 'Set 1', 'S1']);
    const playSet = async (home, away, advance = true) => {
      await ok(keeper, game.id, { type: 'set_score', home, away });
      if (advance) await ok(keeper, game.id, { type: 'period', delta: 1 });
    };
    await playSet(25, 20);
    await playSet(22, 25);
    await playSet(25, 18);
    let g = await ok(keeper, game.id, { type: 'score', team: 'away', points: 1 });
    assert.deepEqual([g.home.score, g.away.score], [2, 1], 'sets won');
    assert.deepEqual([g.home.setScore, g.away.setScore], [0, 1], 'current set points');
    assert.equal(g.periodLabel, 'Set 4');
    await playSet(23, 25);
    g = await ok(keeper, game.id, { type: 'set_score', home: 15, away: 10 });
    assert.deepEqual([g.home.score, g.away.score, g.period, g.periodShort], [2, 2, 4, 'S5']);
    assert.equal((await act(keeper, game.id, { type: 'period', delta: 1 })).status, 409, 'no sixth set');
    const ended = await keeper.post(`/api/games/${game.id}/end`, {});
    assert.deepEqual([ended.json.game.home.score, ended.json.game.away.score], [3, 2], 'final counts the deciding set');
    assert.deepEqual(ended.json.game.line.map((s) => [s.home, s.away]), [[25, 20], [22, 25], [25, 18], [23, 25], [15, 10]]);

    const best3 = await liveGame({ sport: 'volleyball' });
    assert.equal(best3.rules.periods.length, 3);
  });

  it('lets an admin correct a final score without a push', async () => {
    const game = await liveGame();
    await ok(keeper, game.id, { type: 'score', team: 'home', points: 2 });
    await keeper.post(`/api/games/${game.id}/end`, {});
    const broadcastsBefore = t.transport.byKind('broadcast').length;
    assert.equal((await act(keeper, game.id, { type: 'set_score', home: 4, away: 0 })).status, 409, 'scorekeepers cannot');
    assert.equal((await act(admin, game.id, { type: 'score', team: 'home', points: 1 })).status, 409, 'only set_score');
    const fixed = await ok(admin, game.id, { type: 'set_score', home: 4, away: 1 });
    assert.equal(fixed.status, 'final');
    assert.deepEqual([fixed.home.score, fixed.away.score], [4, 1]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const updates = t.transport.byKind('broadcast').slice(broadcastsBefore).filter((c) => c.json.aps.event === 'update');
    assert.equal(updates.length, 0);
  });
});
