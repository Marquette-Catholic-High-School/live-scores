import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { activityChange, activityContentState } from '../server/games.js';
import { act, createGame, startGame, startTestApp, waitFor } from './helpers.js';

// The box score (ARCHITECTURE.md §13): rosters, player points and fouls, team
// fouls and bonus, timeouts. The scoreboard's part is in scoreboard.test.js.
describe('box score', () => {
  let t;
  let admin;
  let keeper;
  let other;

  async function ok(client, id, action) {
    const res = await act(client, id, action);
    assert.equal(res.status, 200, `${JSON.stringify(action)} → ${res.text}`);
    return res.json.game;
  }

  async function refused(client, id, action, status, pattern) {
    const res = await act(client, id, action);
    assert.equal(res.status, status, `${JSON.stringify(action)} → ${res.text}`);
    if (pattern) assert.match(res.json.error.message, pattern);
    return res;
  }

  // A claimed basketball game, not started, with `players` on each roster.
  async function rosteredGame({ home = [['23', 'Jordan Smith'], ['5', 'Alex Reed']], away = [['10', 'Sam Cole']], ...overrides } = {}) {
    const game = await createGame(admin, { scheduledAt: Date.now(), ...overrides });
    await keeper.post(`/api/games/${game.id}/claim`, {});
    let g = game;
    for (const [team, players] of [['home', home], ['away', away]]) {
      for (const [number, name] of players) g = await ok(keeper, game.id, { type: 'roster', op: 'add', team, number, name });
    }
    return g;
  }

  async function liveGame(options) {
    const game = await rosteredGame(options);
    await startGame(keeper, game.id);
    await waitFor(() => {
      const stored = t.app.games.getGame(game.id);
      return stored.channels.production && stored.channels.sandbox;
    });
    return (await keeper.get(`/api/games/${game.id}`)).json.game;
  }

  const player = (game, team, number) => game.box.players[team].find((p) => p.number === number);

  before(async () => {
    t = await startTestApp();
    admin = await t.signedIn('admin', 'admin');
    keeper = await t.signedIn('keeper');
    other = await t.signedIn('other');
  });
  after(() => t.close());

  it('keeps a roster typed in before and during the game', async () => {
    const game = await rosteredGame();
    assert.deepEqual(
      game.box.players.home.map((p) => [p.number, p.name, p.points, p.fouls, p.fouledOut]),
      [['23', 'Jordan Smith', 0, 0, false], ['5', 'Alex Reed', 0, 0, false]],
    );
    assert.equal(game.box.players.away.length, 1);
    assert.match(player(game, 'home', '23').id, /^[a-z0-9]{6}$/);
    assert.deepEqual(game.box.fouls, { home: 0, away: 0 });
    assert.deepEqual(game.box.bonus, { home: false, away: false });
    assert.deepEqual(game.box.timeoutsLeft, { home: 5, away: 5 });
    assert.equal(game.box.timeout, null);

    // Validation and uniqueness.
    await refused(keeper, game.id, { type: 'roster', op: 'add', team: 'home', number: '23', name: 'Dup' }, 409, /#23 is already/);
    await refused(keeper, game.id, { type: 'roster', op: 'add', team: 'away', number: '100', name: 'X' }, 400, /0–99/);
    await refused(keeper, game.id, { type: 'roster', op: 'add', team: 'away', number: 4, name: 'X' }, 400, /string/);
    await refused(keeper, game.id, { type: 'roster', op: 'add', team: 'away', number: '4', name: '  ' }, 400, /required/);
    await refused(keeper, game.id, { type: 'roster', op: 'add', team: 'away', number: '4', name: 'x'.repeat(41) }, 400);
    await refused(other, game.id, { type: 'roster', op: 'add', team: 'away', number: '4', name: 'X' }, 409, /keeping score/);
    let g = await ok(keeper, game.id, { type: 'roster', op: 'add', team: 'away', number: '00', name: 'Pat Lee' });
    assert.ok(player(g, 'away', '00'), '"00" is a number of its own');

    // Edit and remove.
    const reed = player(g, 'home', '5');
    g = await ok(keeper, game.id, { type: 'roster', op: 'edit', team: 'home', player: reed.id, number: '15', name: 'Alex Reid' });
    assert.deepEqual([player(g, 'home', '15').id, player(g, 'home', '15').name], [reed.id, 'Alex Reid']);
    await refused(keeper, game.id, { type: 'roster', op: 'edit', team: 'away', player: reed.id, name: 'Wrong team' }, 409, /isn't on/);
    g = await ok(keeper, game.id, { type: 'roster', op: 'remove', team: 'home', player: reed.id });
    assert.deepEqual(g.box.players.home.map((p) => p.number), ['23']);

    // During the game too; never undone.
    await startGame(keeper, game.id);
    g = await ok(keeper, game.id, { type: 'roster', op: 'add', team: 'home', number: '3', name: 'Late Arrival' });
    g = await ok(keeper, game.id, { type: 'score', team: 'home', points: 2, player: player(g, 'home', '3').id });
    g = await ok(keeper, game.id, { type: 'roster', op: 'add', team: 'home', number: '4', name: 'Later Still' });
    g = await ok(keeper, game.id, { type: 'undo' });
    assert.equal(g.home.score, 0);
    assert.deepEqual(g.box.players.home.map((p) => [p.number, p.points]), [['23', 0], ['3', 0], ['4', 0]], 'undo restores stats, keeps players');
    await refused(keeper, game.id, { type: 'roster', op: 'remove', team: 'home', player: 'nosuchplayer' }, 409);
  });

  it('is basketball only', async () => {
    const soccer = await createGame(admin, { sport: 'soccer', scheduledAt: Date.now() });
    assert.equal(soccer.box, null);
    assert.equal(soccer.options.timeouts, null);
    await keeper.post(`/api/games/${soccer.id}/claim`, {});
    await refused(keeper, soccer.id, { type: 'roster', op: 'add', team: 'home', number: '9', name: 'Striker' }, 400, /box score/);
    await startGame(keeper, soccer.id);
    await refused(keeper, soccer.id, { type: 'foul', team: 'home' }, 400, /box score/);
    await refused(keeper, soccer.id, { type: 'timeout', team: 'home' }, 400, /box score/);
    await refused(keeper, soccer.id, { type: 'score', team: 'home', points: 1, player: 'abcdef' }, 400, /box score/);
  });

  it('credits points to players, with or without the team', async () => {
    const game = await liveGame();
    const smith = player(game, 'home', '23').id;
    const cole = player(game, 'away', '10').id;
    let g = await ok(keeper, game.id, { type: 'score', team: 'home', points: 3, player: smith });
    g = await ok(keeper, game.id, { type: 'score', team: 'home', points: 2 });
    g = await ok(keeper, game.id, { type: 'player_points', team: 'home', player: smith, points: 2 });
    assert.equal(g.home.score, 5, 'player_points leaves the team score alone');
    assert.equal(player(g, 'home', '23').points, 5);
    g = await ok(keeper, game.id, { type: 'score', team: 'home', points: -1, player: smith });
    assert.deepEqual([g.home.score, player(g, 'home', '23').points], [4, 4]);
    await refused(keeper, game.id, { type: 'score', team: 'home', points: 2, player: cole }, 409, /isn't on Marquette/);
    await refused(keeper, game.id, { type: 'player_points', team: 'away', player: cole, points: -1 }, 409, /that many points/);
    await refused(keeper, game.id, { type: 'player_points', team: 'away', player: cole, points: 0 }, 400);
    const unchanged = (await keeper.get(`/api/games/${game.id}`)).json.game;
    assert.equal(unchanged.home.score, 4, 'a refused tag changes nothing');
  });

  it('counts fouls per quarter, with the bonus at the 5th and overtime continuing the 4th', async () => {
    const game = await liveGame();
    const cole = player(game, 'away', '10').id;
    let g = game;
    for (let i = 0; i < 4; i += 1) g = await ok(keeper, game.id, { type: 'foul', team: 'away', player: cole });
    assert.deepEqual(g.box.fouls, { home: 0, away: 4 });
    assert.deepEqual(g.box.bonus, { home: false, away: false });
    assert.equal(player(g, 'away', '10').fouls, 4);
    g = await ok(keeper, game.id, { type: 'foul', team: 'away' });
    assert.deepEqual(g.box.bonus, { home: true, away: false }, "the away team's 5th foul puts the home team in the bonus");
    assert.equal(player(g, 'away', '10').fouls, 4, 'a team foul without a player');
    g = await ok(keeper, game.id, { type: 'foul', team: 'away', player: cole });
    assert.equal(player(g, 'away', '10').fouledOut, true, 'out at 5 fouls');
    g = await ok(keeper, game.id, { type: 'foul', team: 'away', player: cole, delta: -1 });
    assert.deepEqual([player(g, 'away', '10').fouls, g.box.fouls.away], [4, 5]);
    await refused(keeper, game.id, { type: 'foul', team: 'home', delta: -1 }, 409, /no team fouls/);
    await refused(keeper, game.id, { type: 'foul', team: 'home', delta: 2 }, 400);

    // A new quarter resets the team fouls, not the players'.
    g = await ok(keeper, game.id, { type: 'period', delta: 1 });
    assert.deepEqual(g.box.fouls, { home: 0, away: 0 });
    assert.deepEqual(g.box.bonus, { home: false, away: false });
    assert.equal(player(g, 'away', '10').fouls, 4);
    g = await ok(keeper, game.id, { type: 'period', delta: 1 });
    g = await ok(keeper, game.id, { type: 'period', delta: 1 });
    for (let i = 0; i < 3; i += 1) g = await ok(keeper, game.id, { type: 'foul', team: 'home' });
    assert.equal(g.periodShort, 'Q4');
    g = await ok(keeper, game.id, { type: 'period', delta: 1 });
    assert.equal(g.periodShort, 'OT');
    assert.deepEqual(g.box.fouls, { home: 3, away: 0 }, "overtime continues the 4th quarter's fouls");
    g = await ok(keeper, game.id, { type: 'foul', team: 'home' });
    g = await ok(keeper, game.id, { type: 'foul', team: 'home' });
    assert.deepEqual(g.box.bonus, { home: false, away: true });
  });

  it('calls timeouts: one less left, the clock stops, and it ends when the clock starts', async () => {
    const game = await liveGame();
    let g = await ok(keeper, game.id, { type: 'clock', op: 'start' });
    g = await ok(keeper, game.id, { type: 'timeout', team: 'home', remainingMs: 470_000 });
    assert.equal(g.box.timeout, 'home');
    assert.deepEqual(g.box.timeoutsLeft, { home: 4, away: 5 });
    assert.equal(g.clock.running, false, 'a timeout stops the clock');
    assert.ok(g.clock.remainingMs >= 470_000 && g.clock.remainingMs <= 480_000);
    await refused(keeper, game.id, { type: 'timeout', team: 'home' }, 409, /already on/);

    const stored = t.app.games.getGame(game.id);
    const state = activityContentState(stored);
    assert.equal(state.note, 'Timeout · MAR', 'the Lock Screen shows the timeout as the note');
    assert.deepEqual([state.homeFouls, state.awayFouls, state.homeBonus, state.awayBonus], [0, 0, false, false]);

    g = await ok(keeper, game.id, { type: 'clock', op: 'start' });
    assert.equal(g.box.timeout, null, 'the clock starting ends the timeout');
    g = await ok(keeper, game.id, { type: 'timeout', team: 'away' });
    assert.equal(g.box.timeout, 'away');
    g = await ok(keeper, game.id, { type: 'timeout', op: 'end' });
    assert.equal(g.box.timeout, null);
    await refused(keeper, game.id, { type: 'timeout', op: 'end' }, 409, /No timeout/);
    g = await ok(keeper, game.id, { type: 'undo' });
    assert.equal(g.box.timeout, 'away', 'undo brings the timeout back');

    // Running out; overtime adds one each; the admin may change the number.
    for (let i = 0; i < 4; i += 1) {
      await ok(keeper, game.id, { type: 'timeout', team: 'home' });
      await ok(keeper, game.id, { type: 'timeout', op: 'end' });
    }
    await refused(keeper, game.id, { type: 'timeout', team: 'home' }, 409, /no timeouts left/);
    g = await ok(keeper, game.id, { type: 'period', delta: 1 });
    assert.equal(g.box.timeout, null, 'a new period ends a timeout');
    await ok(keeper, game.id, { type: 'period', delta: 1 });
    await ok(keeper, game.id, { type: 'period', delta: 1 });
    g = await ok(keeper, game.id, { type: 'period', delta: 1 });
    assert.deepEqual(g.box.timeoutsLeft, { home: 1, away: 5 }, 'one more each in overtime');
    g = await ok(keeper, game.id, { type: 'period', delta: -1 });
    assert.deepEqual(g.box.timeoutsLeft, { home: 0, away: 4 }, 'taken back when stepping out of it');
    const patched = await admin.patch(`/api/games/${game.id}`, { options: { timeouts: 6 } });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.json.game.box.timeoutsLeft, { home: 1, away: 5 });
    assert.equal(patched.json.game.options.timeouts, 6);
    assert.equal((await admin.patch(`/api/games/${game.id}`, { options: { timeouts: 11 } })).status, 400);
  });

  it('marks what the Lock Screen shows, and how urgently', async () => {
    const game = await liveGame();
    const before = t.app.games.getGame(game.id);
    await ok(keeper, game.id, { type: 'foul', team: 'home' });
    const fouled = t.app.games.getGame(game.id);
    assert.deepEqual(activityChange(before, fouled), { changed: true, high: false }, 'a team foul alone is low priority');
    await ok(keeper, game.id, { type: 'timeout', team: 'away' });
    const timeout = t.app.games.getGame(game.id);
    assert.deepEqual(activityChange(fouled, timeout), { changed: true, high: true }, 'a timeout is high priority');
    for (let i = 0; i < 3; i += 1) await ok(keeper, game.id, { type: 'foul', team: 'home' });
    const fourth = t.app.games.getGame(game.id);
    const smith = player(game, 'home', '23').id;
    await ok(keeper, game.id, { type: 'foul', team: 'home', player: smith });
    const bonus = t.app.games.getGame(game.id);
    assert.deepEqual(activityContentState(fourth).awayBonus, false);
    assert.deepEqual(activityContentState(bonus).awayBonus, true);
    assert.equal(activityChange(fourth, bonus).high, true, 'the bonus is high priority');
    await ok(keeper, game.id, { type: 'player_points', team: 'home', player: smith, points: 2 });
    assert.equal(activityChange(bonus, t.app.games.getGame(game.id)).changed, false, "a player's points alone don't show there");
  });
});
