import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { FIELDS, encodeField, encodeFrame } from '../server/rtd.js';
import { parseScoreboardAddress } from '../server/scoreboard.js';
import { act, createGame, startGame, startTestApp, waitFor } from './helpers.js';

const FAST = {
  connectTimeoutMs: 500,
  retryDelaysMs: [50, 100],
  applyDebounceMs: 5,
  applyMaxWaitMs: 20,
  tickMs: 40,
  quietAfterMs: 15_000,
  reconnectAfterQuietMs: 90_000,
  testListenMs: 400,
  testSettleMs: 120,
  volleyballResetHoldMs: 200,
};

// A stand-in for the Lantronix box: a TCP server that sends what the test
// tells it to, and records anything a client writes (nothing must arrive).
async function fakeScoreboard() {
  const sockets = new Set();
  let connections = 0;
  let received = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('data', (chunk) => {
      received += chunk.length;
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    address: `127.0.0.1:${port}`,
    port,
    get connections() {
      return connections;
    },
    get open() {
      return sockets.size;
    },
    get received() {
      return received;
    },
    send(...frames) {
      for (const socket of sockets) socket.write(Buffer.concat(frames));
    },
    dropClients() {
      for (const socket of sockets) socket.destroy();
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// The clock block the console sends every second (items 1-31).
function clockFrame(text, { running }) {
  const block = Buffer.alloc(31, 0x20);
  Buffer.from(text.padStart(5, ' '), 'latin1').copy(block, 0);
  block[27] = running ? 0x20 : 0x73;
  return encodeFrame(0, block.toString('latin1'));
}
const score = (home, away) => [encodeField(...FIELDS.homeScore, home, { right: true }), encodeField(...FIELDS.guestScore, away, { right: true })];
const period = (n) => encodeField(...FIELDS.period, n, { right: true });
const volleyballGame = (n, home, away) => [
  encodeField(FIELDS.volleyballGameHome[0] + 2 * (n - 1), 2, home, { right: true }),
  encodeField(FIELDS.volleyballGameGuest[0] + 2 * (n - 1), 2, away, { right: true }),
];

async function waitForGame(client, id, check, message) {
  let last;
  await waitFor(
    async () => {
      last = (await client.get(`/api/games/${id}`)).json.game;
      return check(last);
    },
    { timeout: 4000, interval: 20, message },
  );
  return last;
}

describe('Daktronics scoreboard feed', () => {
  let t;
  let admin;
  let keeper;
  let board;

  before(async () => {
    t = await startTestApp({ appOptions: { scoreboardOptions: { timing: FAST } } });
    t.app.scoreboard.start();
    admin = await t.signedIn('boss', 'admin');
    keeper = await t.signedIn('keeper', 'scorekeeper');
  });
  after(async () => {
    await board?.close();
    await t.close();
  });

  it('validates scoreboard addresses', () => {
    assert.equal(parseScoreboardAddress('10.20.1.50'), '10.20.1.50:10001');
    assert.equal(parseScoreboardAddress(' 10.20.1.50:3001 '), '10.20.1.50:3001');
    assert.equal(parseScoreboardAddress('FE80::5'), '[fe80::5]:10001');
    assert.equal(parseScoreboardAddress('[fe80::5]:10002'), '[fe80::5]:10002');
    for (const bad of ['scoreboard.local', '10.20.1.50:0', '10.20.1.50:70000', '10.20.1', '', 'http://10.1.1.1']) {
      assert.throws(() => parseScoreboardAddress(bad), /IP address|port/, bad);
    }
  });

  it('stores the default address for admins only', async () => {
    board = await fakeScoreboard();
    assert.equal((await keeper.patch('/api/admin/scoreboard', { defaultAddress: board.address })).status, 403);
    assert.equal((await admin.patch('/api/admin/scoreboard', { defaultAddress: 'gym-box' })).status, 400);
    const res = await admin.patch('/api/admin/scoreboard', { defaultAddress: board.address });
    assert.equal(res.status, 200);
    assert.equal(res.json.defaultAddress, board.address);
    assert.equal((await admin.get('/api/admin/scoreboard')).json.defaultAddress, board.address);
  });

  it('drives a live basketball game: score, period and clock; scorekeeper buttons are locked', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now() });
    assert.equal(game.scoreboard.setting, 'default');
    assert.equal(game.scoreboard.state, 'idle');
    assert.equal(board.open, 0, 'no connection before the game starts');

    await keeper.post(`/api/games/${game.id}/claim`, {});
    await startGame(keeper, game.id);
    await waitFor(() => board.open === 1, { message: 'feed connects when the game starts' });

    // Only the clock arrives at first: the score must not be read as 0-0 changes.
    board.send(clockFrame('8:00', { running: false }));
    let live = await waitForGame(keeper, game.id, (g) => g.scoreboard.state === 'receiving', 'receiving');
    assert.equal(live.scoreboard.controlling, true);
    assert.equal(live.home.score, 0);

    board.send(...score(2, 0), period(1), clockFrame('7:41', { running: true }));
    live = await waitForGame(keeper, game.id, (g) => g.home.score === 2 && g.clock.running, 'score and running clock');
    assert.equal(live.clock.remainingMs, 461_000);

    const manual = await act(keeper, game.id, { type: 'score', team: 'away', points: 2 });
    assert.equal(manual.status, 409);
    assert.equal(manual.json.error.code, 'scoreboard_active');
    assert.equal((await act(keeper, game.id, { type: 'undo' })).status, 409);
    assert.equal((await act(keeper, game.id, { type: 'note', text: 'Timeout' })).status, 200, 'notes stay manual');

    // Quarter 2 with a stopped clock; the score jumps (several baskets while offline).
    board.send(...score(15, 12), period(2), clockFrame('6:30', { running: false }));
    live = await waitForGame(keeper, game.id, (g) => g.period === 1 && g.away.score === 12 && !g.clock.running, 'period 2');
    assert.equal(live.home.score, 15);
    assert.equal(live.clock.remainingMs, 390_000);
    assert.equal(live.note, '', 'a new period clears the note, as by hand');
    assert.deepEqual(live.line[1], { home: 13, away: 12 }, 'new points land in the period they were scored in');

    // A correction downwards comes off earlier periods when needed.
    board.send(...score(1, 12));
    live = await waitForGame(keeper, game.id, (g) => g.home.score === 1, 'correction');
    assert.deepEqual(live.line, [{ home: 1, away: 0 }, { home: 0, away: 12 }]);

    assert.equal(board.received, 0, 'nothing is ever sent to the scoreboard box');
    const events = t.app.db.all("SELECT type, user_id, prev_state FROM game_events WHERE game_id = ? AND type = 'scoreboard'", game.id);
    assert.ok(events.length >= 3);
    assert.ok(events.every((e) => e.user_id === null && e.prev_state === null), 'scoreboard updates are not undoable');

    // Scoring by hand: the feed stops, buttons work again.
    const switched = await keeper.post(`/api/games/${game.id}/scoreboard`, { manual: true });
    assert.equal(switched.status, 200);
    assert.equal(switched.json.game.scoreboard.state, 'manual');
    assert.equal(switched.json.game.scoreboard.controlling, false);
    await waitFor(() => board.open === 0, { message: 'connection closed while scoring by hand' });
    assert.equal((await act(keeper, game.id, { type: 'score', team: 'home', points: 3 })).status, 200);
    assert.equal((await act(keeper, game.id, { type: 'undo' })).status, 200, 'manual actions can be undone');
    const nothing = await act(keeper, game.id, { type: 'undo' });
    assert.equal(nothing.status, 409, 'undo never goes back past a scoreboard update');
    assert.match(nothing.json.error.message, /Nothing to undo/);

    // Back to the scoreboard: a fresh connection knows nothing until the console sends it.
    await act(keeper, game.id, { type: 'score', team: 'home', points: 3 });
    assert.equal((await keeper.post(`/api/games/${game.id}/scoreboard`, { manual: false })).status, 200);
    await waitFor(() => board.open === 1, { message: 'reconnects' });
    board.send(clockFrame('6:30', { running: false }));
    await waitForGame(keeper, game.id, (g) => g.scoreboard.state === 'receiving', 'receiving again');
    assert.equal((await keeper.get(`/api/games/${game.id}`)).json.game.home.score, 4, 'unknown score fields are not applied');
    board.send(...score(20, 18));
    await waitForGame(keeper, game.id, (g) => g.home.score === 20 && g.away.score === 18, 'scoreboard wins again');

    // Ending the game closes the connection.
    assert.equal((await keeper.post(`/api/games/${game.id}/end`, {})).status, 200);
    await waitFor(() => board.open === 0, { message: 'disconnects after the game' });
  });

  it('only drives basketball and volleyball games with the school at home', async () => {
    const away = await createGame(admin, { scheduledAt: Date.now(), home: { name: 'Lincoln', code: 'LIN', color: '#B22234' }, away: { name: 'Marquette', code: 'MAR', color: '#12214D' } });
    const football = await createGame(admin, { scheduledAt: Date.now(), sport: 'football' });
    for (const game of [away, football]) {
      await startGame(admin, game.id);
      const live = (await admin.get(`/api/games/${game.id}`)).json.game;
      assert.equal(live.scoreboard.state, 'unavailable');
      assert.equal(live.scoreboard.eligible, false);
      assert.equal((await act(admin, game.id, { type: 'score', team: 'home', points: 1 })).status, 200);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(board.open, 0);
    for (const game of [away, football]) await admin.post(`/api/games/${game.id}/end`, {});
  });

  it('gives the scoreboard to the game started last; per-game address and off', async () => {
    const first = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(admin, first.id);
    await waitFor(() => board.open === 1);
    t.clock.advance(60_000);
    const second = await createGame(admin, { scheduledAt: Date.now(), sport: 'volleyball' });
    await startGame(admin, second.id);
    let older = await waitForGame(admin, first.id, (g) => g.scoreboard.state === 'standby', 'older game stands by');
    assert.match(older.scoreboard.message, /started later/);
    assert.equal((await act(admin, first.id, { type: 'score', team: 'home', points: 1 })).status, 200, 'a standby game is scored by hand');
    board.send(...score(5, 3), period(1));
    await waitForGame(admin, second.id, (g) => g.line[0].home === 5, 'the newer game gets the readings');
    assert.equal((await admin.get(`/api/games/${first.id}`)).json.game.home.score, 1);

    // The displaced game was switched to scoring by hand: it doesn't get the
    // scoreboard (and the newer game's scores) back when the newer game lets go.
    const off = await admin.patch(`/api/games/${second.id}`, { scoreboard: 'off' });
    assert.equal(off.status, 200);
    assert.equal(off.json.game.scoreboard.state, 'off');
    older = await waitForGame(admin, first.id, (g) => g.scoreboard.state === 'manual', 'older game stays scored by hand');
    assert.equal(older.scoreboard.controlling, false);
    assert.equal(older.home.score, 1);
    const reason = t.app.db.get("SELECT user_id, data FROM game_events WHERE game_id = ? AND type = 'scoreboard_mode' ORDER BY id DESC LIMIT 1", first.id);
    assert.equal(reason.user_id, null);
    assert.match(JSON.parse(reason.data).reason, /newer game/);
    // Only a deliberate switch gives it the scoreboard again.
    assert.equal((await admin.post(`/api/games/${first.id}/scoreboard`, { manual: false })).status, 200);
    older = await waitForGame(admin, first.id, (g) => g.scoreboard.controlling, 'older game takes over when asked');

    // A per-game address that nobody answers on.
    const closed = net.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = closed.address().port;
    await new Promise((resolve) => closed.close(resolve));
    const custom = await admin.patch(`/api/games/${first.id}`, { scoreboard: `127.0.0.1:${deadPort}` });
    assert.equal(custom.json.game.scoreboard.setting, 'custom');
    assert.equal(custom.json.game.scoreboard.custom, `127.0.0.1:${deadPort}`);
    const unreachable = await waitForGame(admin, first.id, (g) => g.scoreboard.state === 'unreachable', 'unreachable');
    assert.match(unreachable.scoreboard.message, /Can't reach the scoreboard/);
    assert.equal(unreachable.scoreboard.controlling, true, 'still locked: the scorekeeper switches to by hand explicitly');
    assert.equal((await admin.patch(`/api/games/${first.id}`, { scoreboard: 'nonsense' })).status, 400);

    for (const game of [first, second]) await admin.post(`/api/games/${game.id}/end`, {});
  });

  it('drives volleyball: game number, points, finished games, and a held 0-0 reset', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now(), sport: 'volleyball', options: { bestOf: 3 } });
    await startGame(admin, game.id);
    await waitFor(() => board.open === 1);
    board.send(...score(24, 20), period(1));
    await waitForGame(admin, game.id, (g) => g.home.setScore === 24, 'points');

    // The operator clears the points, then moves on to game 2 a few seconds later.
    board.send(...score(0, 0));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal((await admin.get(`/api/games/${game.id}`)).json.game.home.setScore, 24, '0-0 is held for a moment');
    board.send(period(2), ...volleyballGame(1, 25, 22), ...score(3, 1));
    let live = await waitForGame(admin, game.id, (g) => g.period === 1 && g.home.setScore === 3, 'game 2');
    assert.deepEqual(live.line[0], { home: 25, away: 22 }, 'the finished game comes from the console');
    assert.equal(live.home.score, 1, 'one game won');

    // A real 0-0 correction in the same game lands once the hold is over.
    board.send(...score(0, 0));
    t.clock.advance(1000);
    live = await waitForGame(admin, game.id, (g) => g.home.setScore === 0 && g.away.setScore === 0, 'held reset applied');
    await admin.post(`/api/games/${game.id}/end`, {});
  });

  it('reconnects when the box drops the connection', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(admin, game.id);
    await waitFor(() => board.open === 1);
    const before = board.connections;
    board.dropClients();
    await waitFor(() => board.connections > before && board.open === 1, { message: 'reconnected' });
    board.send(...score(7, 7));
    await waitForGame(admin, game.id, (g) => g.home.score === 7, 'data after the reconnect');
    await admin.post(`/api/games/${game.id}/end`, {});
  });

  it('tests a connection, sharing the live feed when there is one', async () => {
    assert.equal((await keeper.post('/api/admin/scoreboard/test', { address: board.address })).status, 403);
    await waitFor(() => board.open === 0);
    const sending = setInterval(() => board.send(clockFrame('5:00', { running: false }), ...score(1, 2)), 30);
    try {
      const idle = await admin.post('/api/admin/scoreboard/test', { address: board.address });
      assert.equal(idle.status, 200);
      assert.equal(idle.json.result.inUse, false);
      assert.equal(idle.json.result.connected, true);
      assert.equal(idle.json.result.receiving, true);
      assert.equal(idle.json.result.reading.clockMs, 300_000);
      assert.equal(idle.json.result.reading.home, 1);
      await waitFor(() => board.open === 0, { message: 'the test closes its connection' });

      const game = await createGame(admin, { scheduledAt: Date.now() });
      await startGame(admin, game.id);
      await waitFor(() => board.open === 1);
      const before = board.connections;
      const shared = await admin.post('/api/admin/scoreboard/test', { address: board.address });
      assert.equal(shared.json.result.inUse, true);
      assert.equal(shared.json.result.gameId, game.id);
      assert.equal(board.connections, before, 'no second connection to the box');
      await admin.post(`/api/games/${game.id}/end`, {});
    } finally {
      clearInterval(sending);
    }
    const dead = await admin.post('/api/admin/scoreboard/test', { address: '127.0.0.1:1' });
    assert.equal(dead.json.result.connected, false);
    assert.match(dead.json.result.error, /refused|no answer/);
  });
});

describe('Daktronics scoreboard feed: review cases', () => {
  let t;
  let admin;
  let board;

  before(async () => {
    t = await startTestApp({ appOptions: { scoreboardOptions: { timing: { ...FAST, consoleResetHoldMs: 200 } } } });
    t.app.scoreboard.start();
    admin = await t.signedIn('boss', 'admin');
    board = await fakeScoreboard();
    await admin.patch('/api/admin/scoreboard', { defaultAddress: board.address });
  });
  after(async () => {
    await board.close();
    await t.close();
  });

  const scoreboardEvents = (id) => t.app.db.get("SELECT COUNT(*) AS n FROM game_events WHERE game_id = ? AND type = 'scoreboard'", id).n;

  it('is controlling as soon as the game starts', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now() });
    const started = await startGame(admin, game.id);
    assert.equal(started.game.scoreboard.controlling, true);
    assert.equal(started.game.scoreboard.state, 'connecting');
    assert.equal((await act(admin, game.id, { type: 'score', team: 'home', points: 2 })).status, 409, 'locked right away');
    await admin.post(`/api/games/${game.id}/end`, {});
  });

  it('reaches any total the console shows, and writes only real changes', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(admin, game.id);
    await waitFor(() => board.open === 1);
    board.send(...score(10, 8), period(2));
    await waitForGame(admin, game.id, (g) => g.period === 1 && g.home.score === 10, 'Q2 10-8');
    // The operator steps the period back, then corrects the home score down.
    board.send(period(1));
    let live = await waitForGame(admin, game.id, (g) => g.period === 0, 'back to Q1');
    assert.deepEqual(live.line, [{ home: 0, away: 0 }, { home: 10, away: 8 }]);
    board.send(...score(4, 8));
    live = await waitForGame(admin, game.id, (g) => g.home.score === 4, 'lower total reached');
    assert.deepEqual(live.line, [{ home: 0, away: 0 }, { home: 4, away: 8 }]);
    const events = scoreboardEvents(game.id);
    for (let i = 0; i < 5; i += 1) board.send(clockFrame('6:00', { running: false }), ...score(4, 8), period(1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(scoreboardEvents(game.id) <= events + 1, 'repeated identical readings write nothing more');
    await admin.post(`/api/games/${game.id}/end`, {});
  });

  it('keeps a finished game when the console is reset for the next one', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(admin, game.id);
    await waitFor(() => board.open === 1);
    board.send(...score(52, 47), period(4), clockFrame('0:00', { running: false }));
    await waitForGame(admin, game.id, (g) => g.period === 3 && g.home.score === 52, 'Q4 52-47');
    board.send(...score(0, 0), period(1), clockFrame('8:00', { running: false }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    let live = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(live.home.score, 52, 'held, not applied');
    assert.equal(live.period, 3);
    t.clock.advance(1000);
    live = await waitForGame(admin, game.id, (g) => g.scoreboard.state === 'manual', 'handed to scoring by hand');
    assert.equal(live.home.score, 52);
    assert.equal(live.away.score, 47);
    // The scorekeeper says the scoreboard is right after all: it wins, no more holding.
    await admin.post(`/api/games/${game.id}/scoreboard`, { manual: false });
    await waitFor(() => board.open === 1);
    board.send(...score(0, 0), period(1), clockFrame('8:00', { running: false }));
    live = await waitForGame(admin, game.id, (g) => g.home.score === 0 && g.period === 0, 'override applies the reset');
    await admin.post(`/api/games/${game.id}/end`, {});
  });

  it('volleyball: never clears the deciding set, uses the console record, ignores games past the match', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now(), sport: 'volleyball', options: { bestOf: 3 } });
    await startGame(admin, game.id);
    await waitFor(() => board.open === 1);
    board.send(...score(25, 20), period(1));
    await waitForGame(admin, game.id, (g) => g.line[0]?.home === 25, 'set 1');
    board.send(period(2), ...score(22, 25));
    await waitForGame(admin, game.id, (g) => g.period === 1 && g.line[1].away === 25, 'set 2');
    board.send(period(3), ...score(15, 11));
    await waitForGame(admin, game.id, (g) => g.period === 2 && g.line[2].home === 15, 'set 3');
    // Cleared after the match: held for good on the last set.
    board.send(...score(0, 0));
    t.clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    let live = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.deepEqual(live.line[2], { home: 15, away: 11 }, 'the deciding set keeps its score');
    // The console moves on to a game 4 this match doesn't have.
    board.send(period(4), ...score(3, 0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    live = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(live.period, 2);
    assert.deepEqual(live.line[2], { home: 15, away: 11 });
    const ended = await admin.post(`/api/games/${game.id}/end`, {});
    assert.equal(ended.json.game.home.score, 2, 'won 2-1');
    assert.equal(ended.json.game.away.score, 1);
  });

  it('volleyball: a clear in the same game uses the console record of that game', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now(), sport: 'volleyball', options: { bestOf: 5 } });
    await startGame(admin, game.id);
    await waitFor(() => board.open === 1);
    board.send(...score(24, 22), period(1));
    await waitForGame(admin, game.id, (g) => g.line[0]?.home === 24, 'set 1');
    board.send(...volleyballGame(1, 26, 24), ...score(0, 0));
    const live = await waitForGame(admin, game.id, (g) => g.line[0].home === 26, 'record applied instead of 0-0');
    assert.deepEqual(live.line[0], { home: 26, away: 24 });
    await admin.post(`/api/games/${game.id}/end`, {});
  });

  it('backs off when a box accepts and drops connections at once', async () => {
    const flapping = net.createServer((socket) => socket.destroy());
    let accepted = 0;
    flapping.on('connection', () => {
      accepted += 1;
    });
    await new Promise((resolve) => flapping.listen(0, '127.0.0.1', resolve));
    const fast = await startTestApp({ appOptions: { scoreboardOptions: { timing: { ...FAST, retryDelaysMs: [30, 60, 120, 240, 480] } } } });
    try {
      fast.app.scoreboard.start();
      const boss = await fast.signedIn('boss2', 'admin');
      const game = await createGame(boss, { scheduledAt: Date.now(), scoreboard: `127.0.0.1:${flapping.address().port}` });
      await startGame(boss, game.id);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.ok(accepted <= 6, `backed off (${accepted} connections in 1 s)`);
      await boss.post(`/api/games/${game.id}/end`, {});
    } finally {
      await fast.close();
      await new Promise((resolve) => flapping.close(resolve));
    }
  });

  it('republishes games on the default when the default address changes', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now() + 3_600_000 });
    const before = (await admin.get(`/api/games/${game.id}`)).json.game;
    await admin.patch('/api/admin/scoreboard', { defaultAddress: '10.99.0.1' });
    const after = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.ok(after.version > before.version, 'a new version for the changed scoreboard view');
    assert.equal(after.scoreboard.address, '10.99.0.1:10001');
    await admin.patch('/api/admin/scoreboard', { defaultAddress: board.address });
  });

  it('canonicalizes addresses and rejects odd ones', () => {
    assert.equal(parseScoreboardAddress('0:0:0:0:0:0:0:1'), '[::1]:10001');
    assert.equal(parseScoreboardAddress('[FE80:0:0::5]:3001'), '[fe80::5]:3001');
    assert.equal(parseScoreboardAddress('::ffff:10.20.1.50'), '10.20.1.50:10001');
    assert.equal(parseScoreboardAddress('::FFFF:0a14:0132'), '10.20.1.50:10001');
    for (const bad of ['fe80::1%eth0', `fe80::1%${'x'.repeat(100)}`, '1.2.3.4:', '[::1]x', '010.1.1.1', 'x'.repeat(100)]) {
      assert.throws(() => parseScoreboardAddress(bad), /IP address|port/, bad);
    }
  });
});
