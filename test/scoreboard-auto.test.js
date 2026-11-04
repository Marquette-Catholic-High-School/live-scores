import assert from 'node:assert/strict';
import net from 'node:net';
import { after, afterEach, before, describe, it } from 'node:test';
import { FIELDS, encodeField, encodeFrame } from '../server/rtd.js';
import { AUTO_START_WINDOW_MS, FINAL_HORN_HOLD_MS } from '../server/scoreboard.js';
import { createGame, hexToken, openStream, sleep, startGame, startTestApp, waitFor } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
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
  consoleResetHoldMs: 200,
};
const TICKS = 5 * FAST.tickMs;

// A stand-in for the Lantronix box: a TCP server that sends what the test
// tells it to.
async function fakeScoreboard() {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    address: `127.0.0.1:${server.address().port}`,
    get connections() {
      return connections;
    },
    get open() {
      return sockets.size;
    },
    send(...frames) {
      for (const socket of sockets) socket.write(Buffer.concat(frames));
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

// The final horn: the clock runs out in period n and stops at 0:00.
async function finalHorn(client, board, gameId, home, away, n = 4) {
  board.send(...score(home, away), period(n), clockFrame('0:03', { running: true }));
  await waitForGame(client, gameId, (g) => g.period === n - 1 && g.clock.running && g.home.score === home && g.away.score === away, `the clock running in period ${n}`);
  board.send(clockFrame('0:00', { running: false }));
}

describe('scoreboard: starting and ending games by itself', () => {
  let t;
  let admin;
  let keeper;
  let board;
  const now = () => t.clock.now();
  const events = (id, type) => t.app.db.all('SELECT user_id, data FROM game_events WHERE game_id = ? AND type = ? ORDER BY id', id, type);
  // "5:00 PM" in the school's time zone, as the messages give times.
  const clockTime = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: t.config.timeZone, hour: 'numeric', minute: '2-digit' }).format(ms).replace(/\s/g, ' ');
  // The final-horn message for a hold that started at `since`: the end,
  // rounded up to the minute. The test clock runs, so the hold started
  // between `from` and `to`.
  const hornMessage = (since, sets = false) => {
    const by = clockTime(Math.ceil((since + FINAL_HORN_HOLD_MS) / MIN) * MIN);
    return sets
      ? `Match won: the game ends by itself by ${by}, 2 minutes after the last point.`
      : `Final horn: the game ends by itself by ${by}, 2 minutes after the last score change. Time put back on the clock keeps it going.`;
  };
  const assertHorn = (message, from, to, sets = false) => assert.ok([hornMessage(from, sets), hornMessage(to, sets)].includes(message), message);
  const BY_HAND = 'Start it by hand if it is played, or cancel it.';
  // Time passes with the console on: it sends its clock every second (here
  // every 10 s of test time), so the feed never looks silent.
  const pass = async (ms, clock = '0:00') => {
    for (let left = ms; left > 0; left -= 10_000) {
      t.clock.advance(Math.min(left, 10_000));
      board.send(clockFrame(clock, { running: false }));
      await sleep(15);
    }
  };
  const register = async (seed) => {
    const token = hexToken(seed);
    const res = await t.client().post('/api/devices', { token, environment: 'production', enabled: true, activitiesEnabled: true, appVersion: '5.2' });
    assert.equal(res.status, 200);
    return token;
  };
  const pushToStart = (token, gameId) =>
    waitFor(() => t.transport.byKind('device').find((call) => call.path.endsWith(token) && call.json.aps.attributes.gameId === gameId), {
      message: 'push-to-start',
    });
  // A game an admin starts by hand: scheduled long enough ago that it doesn't
  // start by itself (nor pass over the games due after it).
  const liveGame = async (overrides = {}) => {
    const game = await createGame(admin, { scheduledAt: now() - 4 * HOUR, ...overrides });
    await startGame(admin, game.id);
    await waitFor(() => board.open === 1, { message: 'feed connected' });
    return game;
  };

  before(async () => {
    t = await startTestApp({ appOptions: { scoreboardOptions: { timing: FAST } } });
    t.app.scoreboard.start();
    admin = await t.signedIn('boss', 'admin');
    keeper = await t.signedIn('keeper', 'scorekeeper');
    board = await fakeScoreboard();
    await admin.patch('/api/admin/scoreboard', { defaultAddress: board.address });
  });
  // Every test starts without games: earlier ones would hold the scoreboard,
  // or pass over games due later.
  afterEach(async () => {
    for (const { id } of t.app.db.all("SELECT id FROM games WHERE status IN ('scheduled', 'live')")) await admin.post(`/api/games/${id}/cancel`, {});
    for (const { id } of t.app.db.all('SELECT id FROM games')) await admin.delete(`/api/games/${id}`);
    await waitFor(() => board.open === 0, { message: 'no feed left open' });
  });
  after(async () => {
    await board.close();
    await t.close();
  });

  it('starts a game whose time has come as soon as its scoreboard sends data', async () => {
    const device = await register('auto-start');
    const game = await createGame(admin, { scheduledAt: now() - MIN, gender: 'girls', level: 'varsity' });
    const stream = await openStream(t.baseUrl, `/api/stream?game=${game.id}`);
    try {
      await waitFor(() => board.open === 1, { message: 'the scoreboard is watched from the game time' });
      const watching = await waitForGame(admin, game.id, (g) => g.scoreboard.message.includes('waiting for data'), 'watching');
      assert.equal(watching.status, 'scheduled');
      assert.equal(watching.scoreboard.state, 'idle');
      assert.equal(watching.scoreboard.controlling, false);
      assert.equal(
        watching.scoreboard.message,
        `Starts automatically once the scoreboard is on. Connected to ${board.address}, waiting for data from the scoreboard console.`,
      );
      const feeds = (await admin.get('/api/admin/scoreboard')).json.feeds;
      assert.deepEqual(feeds.map((feed) => [feed.address, feed.gameId, feed.watching]), [[board.address, game.id, true]]);
      await sleep(TICKS);
      assert.equal((await admin.get(`/api/games/${game.id}`)).json.game.status, 'scheduled', 'a silent scoreboard starts nothing');

      board.send(clockFrame('7:12', { running: false }));
      const live = await waitForGame(admin, game.id, (g) => g.status === 'live', 'started by the scoreboard');
      assert.equal(live.sportName, 'Girls Varsity Basketball');
      assert.equal(live.scorekeeper, null, 'nobody holds the claim');
      assert.equal(live.scoreboard.controlling, true);
      assert.equal(live.scoreboard.state, 'receiving');
      assert.equal(live.clock.remainingMs, 432_000, 'what the console showed applies right away');
      assert.ok(live.startedAt >= game.scheduledAt);
      assert.equal(board.connections, 1, 'the watching connection is kept');
      await stream.next((event) => event.event === 'game' && event.data.game.status === 'live');

      const [start] = events(game.id, 'start');
      assert.equal(start.user_id, null);
      assert.deepEqual(JSON.parse(start.data), { auto: true, reason: 'scoreboard' });
      // The same push-to-start fan-out as a scorekeeper's start.
      const call = await pushToStart(device, game.id);
      assert.equal(call.json.aps.attributes.sportName, 'Girls Varsity Basketball');
      assert.equal(call.json.aps.alert.body, 'Girls Varsity Basketball · Follow the score on your Lock Screen');
      assert.equal(call.json.aps['content-state'].status, 'live');

      assert.equal((await admin.post(`/api/games/${game.id}/start`, {})).status, 409, 'already live');
      assert.equal((await keeper.post(`/api/games/${game.id}/claim`, {})).status, 200, 'any scorekeeper can claim it');
      board.send(...score(2, 0), period(1));
      await waitForGame(admin, game.id, (g) => g.home.score === 2, 'driven like any game');
    } finally {
      stream.close();
    }
  });

  it("waits for the game's time, then starts it once the scoreboard sends data", async () => {
    const scheduledAt = now() + 10 * MIN;
    const game = await createGame(admin, { scheduledAt, gender: 'boys' });
    assert.equal(game.scoreboard.state, 'idle');
    assert.equal(game.scoreboard.message, `Starts automatically at ${clockTime(scheduledAt)} once the scoreboard at ${board.address} is on.`);
    await sleep(TICKS);
    assert.equal(board.open, 0, 'not watched before its time');

    t.clock.advance(10 * MIN);
    await waitFor(() => board.open === 1, { message: 'watched from its time (on the tick)' });
    board.send(clockFrame('8:00', { running: false }), ...score(0, 0), period(1));
    const live = await waitForGame(admin, game.id, (g) => g.status === 'live', 'started');
    assert.equal(live.sportName, 'Boys Basketball');
  });

  it('never starts a game more than 3 hours past its time, and lets go of the scoreboard then', async () => {
    const late = await createGame(admin, { scheduledAt: now() - AUTO_START_WINDOW_MS - MIN });
    await sleep(TICKS);
    assert.equal(board.open, 0);
    assert.equal(late.scoreboard.message, `Won't start by itself any more: its time was more than 3 hours ago. ${BY_HAND}`);

    const due = await createGame(admin, { scheduledAt: now() - AUTO_START_WINDOW_MS + MIN });
    await waitFor(() => board.open === 1, { message: 'watched near the end of its window' });
    t.clock.advance(2 * MIN);
    await waitFor(() => board.open === 0, { message: 'closed once the window has passed' });
    // Nothing listens any more; and a reading now would be too late anyway.
    const game = await waitForGame(admin, due.id, (g) => g.scoreboard.message.startsWith("Won't start by itself any more"), 'past the window');
    assert.equal(game.status, 'scheduled');
    assert.equal((await admin.get(`/api/games/${late.id}`)).json.game.status, 'scheduled');
  });

  it('waits while another live game holds the scoreboard, and needs fresh data once it is free', async () => {
    const other = await liveGame({ gender: 'girls', level: 'jv' });
    board.send(...score(10, 8), period(2), clockFrame('3:00', { running: false }));
    await waitForGame(admin, other.id, (g) => g.home.score === 10, 'the live game reads the scoreboard');
    const due = await createGame(admin, { scheduledAt: now() - MIN, gender: 'girls', level: 'varsity' });
    assert.equal(due.scoreboard.message, 'Starts automatically once Girls JV Basketball (Marquette vs Lincoln) has ended: that game is still live on this scoreboard.');
    board.send(clockFrame('2:59', { running: false }));
    await waitForGame(admin, other.id, (g) => g.clock.remainingMs === 179_000, 'the live game keeps the readings');
    await sleep(TICKS);
    assert.equal((await admin.get(`/api/games/${due.id}`)).json.game.status, 'scheduled', 'never starts while another game is driven');

    // The live game ends; the console has been quiet for a while: nothing starts on old data.
    t.clock.advance(6000);
    const connections = board.connections;
    await admin.post(`/api/games/${other.id}/end`, {});
    let game = await waitForGame(admin, due.id, (g) => g.scoreboard.message.startsWith('Starts automatically once the scoreboard is on.'), 'watched now');
    assert.equal(game.scoreboard.message, `Starts automatically once the scoreboard is on. Connected to ${board.address}, waiting for data from the scoreboard console.`);
    await sleep(TICKS);
    assert.equal((await admin.get(`/api/games/${due.id}`)).json.game.status, 'scheduled');
    assert.equal(board.open, 1);
    assert.equal(board.connections, connections, 'the same connection watches for the next game');

    // What the console sent for the game before never lands in this one.
    board.send(clockFrame('8:00', { running: false }));
    game = await waitForGame(admin, due.id, (g) => g.status === 'live', 'started on fresh data');
    assert.deepEqual([game.home.score, game.away.score, game.period, game.clock.remainingMs], [0, 0, 0, 480_000]);
  });

  it('waits while a live game on the scoreboard is scored by hand, unless the feed itself handed it over', async () => {
    const byHand = await liveGame();
    await keeper.post(`/api/games/${byHand.id}/claim`, { force: false });
    assert.equal((await admin.post(`/api/games/${byHand.id}/scoreboard`, { manual: true })).status, 200);
    await waitFor(() => board.open === 0, { message: 'by hand: no feed' });
    const due = await createGame(admin, { scheduledAt: now() - MIN });
    await sleep(TICKS);
    assert.equal(board.open, 0, 'the gym is in use: not watched');
    assert.match((await admin.get(`/api/games/${due.id}`)).json.game.scoreboard.message, /^Starts automatically once Basketball \(Marquette vs Lincoln\) has ended/);
    await admin.post(`/api/games/${byHand.id}/end`, {});
    await waitFor(() => board.open === 1, { message: 'watched once that game ended' });
    board.send(clockFrame('8:00', { running: false }));
    await waitForGame(admin, due.id, (g) => g.status === 'live', 'started');
    await admin.post(`/api/games/${due.id}/cancel`, {});
    await waitFor(() => board.open === 0);

    // A game the console was reset away from (no clock: it can't end at the
    // horn) is handed over to scoring by hand by the feed: it holds nothing.
    const forgotten = await liveGame({ options: { clockEnabled: false } });
    board.send(...score(40, 38), period(4));
    await waitForGame(admin, forgotten.id, (g) => g.period === 3, 'Q4');
    board.send(...score(0, 0), period(1));
    t.clock.advance(1000);
    await waitForGame(admin, forgotten.id, (g) => g.scoreboard.manual, 'handed over by the feed');
    const next = await createGame(admin, { scheduledAt: now() - MIN });
    await waitFor(() => board.open === 1, { message: 'watched' });
    board.send(clockFrame('8:00', { running: false }));
    await waitForGame(admin, next.id, (g) => g.status === 'live', 'started past the forgotten game');
    assert.equal((await admin.get(`/api/games/${forgotten.id}`)).json.game.status, 'live', 'the forgotten game is left for a person to end');
  });

  it('starts the latest of several due games (tie: lower id); the others are passed over', async () => {
    const early = await createGame(admin, { scheduledAt: now() - 30 * MIN, level: 'jv' });
    const late = await createGame(admin, { scheduledAt: now() - 10 * MIN, level: 'varsity' });
    await waitFor(() => board.open === 1);
    assert.equal(
      (await admin.get(`/api/games/${early.id}`)).json.game.scoreboard.message,
      'Not started automatically: Varsity Basketball (Marquette vs Lincoln), scheduled later on this scoreboard, starts instead.',
    );
    board.send(clockFrame('8:00', { running: false }));
    await waitForGame(admin, late.id, (g) => g.status === 'live', 'the later game starts');
    await sleep(TICKS);
    const passed = (await admin.get(`/api/games/${early.id}`)).json.game;
    assert.equal(passed.status, 'scheduled');
    const passedOver = `Won't start by itself: Varsity Basketball (Marquette vs Lincoln) started on this scoreboard after this game's time. ${BY_HAND}`;
    assert.equal(passed.scoreboard.message, passedOver, 'it will not start after the later game');
    await admin.post(`/api/games/${late.id}/end`, {});
    await waitFor(() => board.open === 0, { message: 'the earlier game is passed over for good' });
    assert.equal((await admin.get(`/api/games/${early.id}`)).json.game.scoreboard.message, passedOver);
    await admin.post(`/api/games/${early.id}/cancel`, {});

    const at = now() - 5 * MIN;
    const one = await createGame(admin, { scheduledAt: at });
    const two = await createGame(admin, { scheduledAt: at });
    const [first, second] = [one, two].sort((a, b) => (a.id < b.id ? -1 : 1));
    await waitFor(() => board.open === 1);
    board.send(clockFrame('8:00', { running: false }));
    await waitForGame(admin, first.id, (g) => g.status === 'live', 'the lower id starts');
    assert.equal((await admin.get(`/api/games/${second.id}`)).json.game.status, 'scheduled');
  });

  it('lets go of the scoreboard when a due game is set to Off, Score by hand, another time, or canceled', async () => {
    const game = await createGame(admin, { scheduledAt: now() - MIN });
    await waitFor(() => board.open === 1);
    const opted = async (change, message) => {
      await change();
      await waitFor(() => board.open === 0, { message });
      await sleep(TICKS);
      assert.equal(board.open, 0, `${message}: stays closed`);
    };
    const watchedAgain = async (change) => {
      await change();
      await waitFor(() => board.open === 1, { message: 'watched again' });
    };
    await opted(() => admin.patch(`/api/games/${game.id}`, { scoreboard: 'off' }), 'Off');
    assert.equal((await admin.get(`/api/games/${game.id}`)).json.game.scoreboard.state, 'off');
    await watchedAgain(() => admin.patch(`/api/games/${game.id}`, { scoreboard: 'default' }));
    await opted(() => admin.post(`/api/games/${game.id}/scoreboard`, { manual: true }), 'Score by hand');
    assert.equal((await admin.get(`/api/games/${game.id}`)).json.game.scoreboard.state, 'manual');
    await watchedAgain(() => admin.post(`/api/games/${game.id}/scoreboard`, { manual: false }));
    await opted(() => admin.patch(`/api/games/${game.id}`, { scheduledAt: now() + HOUR }), 'moved later');
    await watchedAgain(() => admin.patch(`/api/games/${game.id}`, { scheduledAt: now() - MIN }));
    await opted(() => admin.post(`/api/games/${game.id}/cancel`, {}), 'canceled');
    assert.equal((await admin.get(`/api/games/${game.id}`)).json.game.status, 'canceled');
  });

  it('never starts other sports or away games', async () => {
    const football = await createGame(admin, { scheduledAt: now() - MIN, sport: 'football' });
    const away = await createGame(admin, {
      scheduledAt: now() - MIN,
      home: { name: 'Lincoln', code: 'LIN', color: '#B22234' },
      away: { name: 'Marquette', code: 'MAR', color: '#12214D' },
    });
    await sleep(TICKS);
    assert.equal(board.open, 0);
    for (const game of [football, away]) {
      const current = (await admin.get(`/api/games/${game.id}`)).json.game;
      assert.equal(current.status, 'scheduled');
      assert.equal(current.scoreboard.state, 'unavailable');
    }
  });

  it('basketball: ends the game 2 minutes after the final horn', async () => {
    const game = await liveGame();
    const from = now();
    await finalHorn(admin, board, game.id, 52, 47);
    let live = await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Final horn'), 'final horn hold');
    assertHorn(live.scoreboard.message, from, now());
    const message = live.scoreboard.message;
    assert.equal(live.scoreboard.state, 'receiving');
    assert.equal(live.status, 'live');
    t.clock.advance(FINAL_HORN_HOLD_MS - 1000);
    await sleep(TICKS);
    live = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(live.status, 'live', 'not before the 2 minutes are up');
    assert.equal(live.scoreboard.message, message, 'the end time, no countdown: an open page stays right');
    t.clock.advance(1000);
    const ended = await waitForGame(admin, game.id, (g) => g.status === 'final', 'ended at the horn');
    assert.deepEqual([ended.home.score, ended.away.score, ended.period], [52, 47, 3]);
    const [end] = events(game.id, 'end');
    assert.equal(end.user_id, null);
    assert.deepEqual(JSON.parse(end.data), { auto: true, reason: 'final horn' });
    await waitFor(() => board.open === 0, { message: 'the feed closes with the game' });
  });

  it('basketball: the 4th quarter reached before the clock is set is not the horn', async () => {
    const game = await liveGame();
    board.send(...score(40, 31), period(3), clockFrame('0:04', { running: true }));
    await waitForGame(admin, game.id, (g) => g.period === 2 && g.clock.running, 'Q3 running out');
    board.send(clockFrame('0:00', { running: false }));
    await waitForGame(admin, game.id, (g) => g.clock.remainingMs === 0, 'end of Q3');
    // The operator moves the console on to the 4th quarter; the clock still reads 0:00.
    board.send(period(4));
    let live = await waitForGame(admin, game.id, (g) => g.period === 3, 'Q4');
    assert.equal(live.clock.remainingMs, 0);
    await pass(FINAL_HORN_HOLD_MS + MIN);
    await sleep(TICKS);
    live = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(live.status, 'live');
    assert.doesNotMatch(live.scoreboard.message, /Final horn/);
    // Once the 4th quarter has been played, 0:00 is the horn.
    await finalHorn(admin, board, game.id, 55, 49);
    await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Final horn'), 'the real horn');
  });

  it('basketball: a tie at the horn goes on; an overtime horn ends it', async () => {
    const game = await liveGame();
    await finalHorn(admin, board, game.id, 50, 50);
    await waitForGame(admin, game.id, (g) => g.period === 3 && g.home.score === 50 && g.clock.remainingMs === 0, 'Q4 tied at 0:00');
    await pass(5 * MIN);
    await sleep(TICKS);
    let live = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(live.status, 'live');
    assert.doesNotMatch(live.scoreboard.message, /Final horn/);

    board.send(period(5), clockFrame('4:00', { running: false }));
    await waitForGame(admin, game.id, (g) => g.periodShort === 'OT' && g.clock.remainingMs === 240_000, 'overtime');
    await finalHorn(admin, board, game.id, 58, 54, 5);
    live = await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Final horn'), 'overtime horn');
    assert.equal(live.periodShort, 'OT');
    t.clock.advance(FINAL_HORN_HOLD_MS);
    const ended = await waitForGame(admin, game.id, (g) => g.status === 'final', 'ended after overtime');
    assert.deepEqual([ended.home.score, ended.away.score, ended.periodShort], [58, 54, 'OT']);
  });

  it('basketball: a score change restarts the hold; the game going on cancels it', async () => {
    const game = await liveGame();
    await finalHorn(admin, board, game.id, 51, 50);
    await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Final horn'), 'hold');
    // Free throws after the horn.
    await pass(100_000);
    const from = now();
    board.send(...score(52, 50));
    let live = await waitForGame(admin, game.id, (g) => g.home.score === 52, 'free throw');
    assertHorn(live.scoreboard.message, from, now());
    await pass(100_000);
    await sleep(TICKS);
    assert.equal((await admin.get(`/api/games/${game.id}`)).json.game.status, 'live');

    // The officials put time back on the clock: the game goes on.
    board.send(clockFrame('1.2', { running: false }));
    live = await waitForGame(admin, game.id, (g) => g.clock.remainingMs === 1200, 'time back on the clock');
    assert.equal(live.scoreboard.message, 'Score, clock and period come from the scoreboard.');
    await pass(5 * MIN, '1.2');
    await sleep(TICKS);
    assert.equal((await admin.get(`/api/games/${game.id}`)).json.game.status, 'live', 'cancelled');

    // A tie at the next horn (a basket at the buzzer) means overtime, not the end.
    await finalHorn(admin, board, game.id, 52, 50);
    await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Final horn'), 'horn again');
    board.send(...score(52, 52));
    live = await waitForGame(admin, game.id, (g) => g.away.score === 52, 'tied');
    assert.equal(live.scoreboard.message, 'Score, clock and period come from the scoreboard.');
    await pass(5 * MIN);
    await sleep(TICKS);
    assert.equal((await admin.get(`/api/games/${game.id}`)).json.game.status, 'live');

    // Scored by hand: never ends at the horn.
    board.send(...score(54, 52));
    await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Final horn'), 'horn once more');
    await admin.post(`/api/games/${game.id}/scoreboard`, { manual: true });
    t.clock.advance(5 * MIN);
    await sleep(TICKS);
    live = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(live.status, 'live');
    assert.equal(live.scoreboard.state, 'manual');
  });

  it('basketball: a console reset during the hold ends the game at once, with the score at the horn', async () => {
    const game = await liveGame({ gender: 'boys', level: 'varsity' });
    await finalHorn(admin, board, game.id, 52, 47);
    await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Final horn'), 'hold');
    board.send(...score(0, 0), period(1), clockFrame('8:00', { running: false }));
    const ended = await waitForGame(admin, game.id, (g) => g.status === 'final', 'ended by the reset');
    assert.deepEqual([ended.home.score, ended.away.score, ended.period, ended.clock.remainingMs], [52, 47, 3, 0]);
    assert.equal(events(game.id, 'scoreboard_mode').length, 0, 'never handed over to scoring by hand');
    assert.deepEqual(JSON.parse(events(game.id, 'end')[0].data), { auto: true, reason: 'final horn' });
  });

  it('volleyball: ends the game 2 minutes after a team has won the match', async () => {
    const game = await liveGame({ sport: 'volleyball', options: { bestOf: 3 }, gender: 'girls' });
    board.send(...score(25, 20), period(1));
    await waitForGame(admin, game.id, (g) => g.home.setScore === 25, 'set 1');
    // The console moves on to game 2 before the points are cleared: 25-20 in
    // set 2 for a moment is not a won match.
    board.send(period(2));
    let live = await waitForGame(admin, game.id, (g) => g.period === 1 && g.home.setScore === 25, 'set 1 points still showing');
    assert.equal(live.scoreboard.message, 'Points and set come from the scoreboard.');
    board.send(...score(0, 0));
    t.clock.advance(1000);
    live = await waitForGame(admin, game.id, (g) => g.home.setScore === 0, 'cleared');
    assert.equal(live.status, 'live');
    board.send(...score(24, 18));
    live = await waitForGame(admin, game.id, (g) => g.period === 1 && g.home.setScore === 24, 'set 2');
    assert.equal(live.scoreboard.message, 'Points and set come from the scoreboard.', 'one set to go');
    const from = now();
    board.send(...score(25, 18));
    live = await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Match won'), 'match won');
    assertHorn(live.scoreboard.message, from, now(), true);
    // The operator clears the board: the winning set keeps its score.
    board.send(...score(0, 0));
    t.clock.advance(FINAL_HORN_HOLD_MS - 1000);
    await sleep(TICKS);
    live = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(live.status, 'live');
    assert.deepEqual(live.line[1], { home: 25, away: 18 });
    t.clock.advance(1000);
    const ended = await waitForGame(admin, game.id, (g) => g.status === 'final', 'ended');
    assert.deepEqual([ended.home.score, ended.away.score], [2, 0]);
    assert.deepEqual(JSON.parse(events(game.id, 'end')[0].data), { auto: true, reason: 'final horn' });
  });

  it('takes only the clock while the console still shows the game before, until it is reset', async () => {
    const girls = await liveGame({ gender: 'girls', level: 'varsity' });
    const boys = await createGame(admin, { scheduledAt: now() - MIN, gender: 'boys', level: 'varsity' });
    await finalHorn(admin, board, girls.id, 52, 47);
    await waitForGame(admin, girls.id, (g) => g.scoreboard.message.startsWith('Final horn'), 'girls final horn');
    await pass(FINAL_HORN_HOLD_MS);
    await waitForGame(admin, girls.id, (g) => g.status === 'final', 'girls end');
    // The girls' game ran past the boys' time: the boys' game starts at once,
    // with the girls' final still on the console.
    board.send(clockFrame('0:00', { running: false }));
    let live = await waitForGame(admin, boys.id, (g) => g.status === 'live', 'boys start');
    const held = "The scoreboard still shows the game before: this game's score and period are read once the console is reset for it. Only the clock is read until then.";
    live = await waitForGame(admin, boys.id, (g) => g.scoreboard.message === held, 'the game before is held back');
    assert.deepEqual([live.home.score, live.away.score, live.period], [0, 0, 0]);

    // A warm-up clock: each time it stops the console sends the whole block.
    board.send(clockFrame('10:00', { running: true }));
    await waitForGame(admin, boys.id, (g) => g.clock.running, 'warm-up clock');
    board.send(clockFrame('9:30', { running: false }), ...score(52, 47), period(4));
    live = await waitForGame(admin, boys.id, (g) => g.clock.remainingMs === 570_000 && !g.clock.running, 'warm-up paused');
    assert.deepEqual([live.home.score, live.away.score, live.period], [0, 0, 0], 'only the clock');
    board.send(clockFrame('9:30', { running: true }));
    await waitForGame(admin, boys.id, (g) => g.clock.running, 'warm-up again');
    board.send(clockFrame('0:00', { running: false }), ...score(52, 47), period(4));
    await waitForGame(admin, boys.id, (g) => g.clock.remainingMs === 0 && !g.clock.running, 'warm-up over');
    // The table corrects the girls' final on the console: no game takes it.
    board.send(encodeField(...FIELDS.homeScore, 53, { right: true }));
    await sleep(TICKS);
    await pass(FINAL_HORN_HOLD_MS + MIN);
    await sleep(TICKS);
    live = (await admin.get(`/api/games/${boys.id}`)).json.game;
    assert.equal(live.status, 'live', 'a warm-up clock at 0:00 is no final horn');
    assert.deepEqual([live.home.score, live.away.score, live.period], [0, 0, 0]);
    assert.equal(live.scoreboard.message, held);
    assert.equal((await admin.get(`/api/games/${girls.id}`)).json.game.home.score, 52);

    // The operator resets the console for the boys: taken at once, nothing held or handed over.
    board.send(...score(0, 0), period(1), clockFrame('8:00', { running: false }));
    live = await waitForGame(admin, boys.id, (g) => g.clock.remainingMs === 480_000, 'the reset');
    assert.equal(live.scoreboard.message, 'Score, clock and period come from the scoreboard.');
    t.clock.advance(MIN);
    board.send(clockFrame('7:40', { running: true }), ...score(2, 0));
    live = await waitForGame(admin, boys.id, (g) => g.home.score === 2, 'the first basket');
    assert.equal(live.scoreboard.manual, false);
    assert.equal(events(boys.id, 'scoreboard_mode').length, 0);
  });

  it('a game the scoreboard started takes no later period before the console is reset, the game before unknown', async () => {
    const game = await createGame(admin, { scheduledAt: now() - MIN });
    await waitFor(() => board.open === 1);
    board.send(clockFrame('0:00', { running: false }));
    await waitForGame(admin, game.id, (g) => g.status === 'live', 'started');
    // Last night's game (not in the app) is still up, sent when a warm-up clock stops.
    board.send(clockFrame('5:00', { running: false }), ...score(61, 58), period(5));
    let live = await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('The scoreboard still shows the game before'), 'held');
    assert.deepEqual([live.home.score, live.away.score, live.period, live.clock.remainingMs], [0, 0, 0, 300_000]);
    // Set up in steps, the period first: 61-58 is still that game.
    board.send(period(1));
    await sleep(TICKS);
    live = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.deepEqual([live.home.score, live.away.score, live.period], [0, 0, 0]);
    assert.match(live.scoreboard.message, /^The scoreboard still shows the game before/);
    board.send(...score(0, 0));
    await waitForGame(admin, game.id, (g) => g.scoreboard.message === 'Score, clock and period come from the scoreboard.', 'reset');
    board.send(...score(3, 0));
    await waitForGame(admin, game.id, (g) => g.home.score === 3, 'this game');
  });

  it("a game started by hand also waits while the game before is up; Use the scoreboard takes what it shows", async () => {
    const first = await liveGame({ level: 'jv' });
    board.send(...score(30, 28), period(4), clockFrame('0:00', { running: false }));
    await waitForGame(admin, first.id, (g) => g.home.score === 30 && g.period === 3, 'the JV game');
    await admin.post(`/api/games/${first.id}/end`, {});
    await waitFor(() => board.open === 0);
    const next = await liveGame({ level: 'varsity' });
    board.send(...score(30, 28), period(4), clockFrame('0:00', { running: false }));
    let live = await waitForGame(admin, next.id, (g) => g.scoreboard.message.startsWith('The scoreboard still shows the game before'), 'held');
    assert.deepEqual([live.home.score, live.period], [0, 0]);
    // The scorekeeper says it is this game after all.
    await admin.post(`/api/games/${next.id}/scoreboard`, { manual: true });
    await admin.post(`/api/games/${next.id}/scoreboard`, { manual: false });
    await waitFor(() => board.open === 1);
    board.send(...score(30, 28), period(4), clockFrame('0:00', { running: false }));
    live = await waitForGame(admin, next.id, (g) => g.home.score === 30 && g.period === 3, 'taken as it is');
    assert.equal(live.scoreboard.message, 'Score, clock and period come from the scoreboard.');
  });

  it('basketball: a console reset done in steps during the hold ends the game at once', async () => {
    const steps = [
      ['the period first', [period(1)]],
      ['a score first', [encodeField(...FIELDS.homeScore, 0, { right: true })]],
    ];
    for (const [name, first] of steps) {
      const game = await liveGame();
      board.send(...score(2, 0), period(1));
      await waitForGame(admin, game.id, (g) => g.home.score === 2, `${name}: Q1`);
      await finalHorn(admin, board, game.id, 52, 47);
      await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Final horn'), `${name}: hold`);
      board.send(...first);
      const ended = await waitForGame(admin, game.id, (g) => g.status === 'final', `${name}: ended`);
      assert.deepEqual([ended.home.score, ended.away.score, ended.period], [52, 47, 3], name);
      assert.equal(events(game.id, 'scoreboard_mode').length, 0, name);
      assert.deepEqual(JSON.parse(events(game.id, 'end')[0].data), { auto: true, reason: 'final horn' });
      await waitFor(() => board.open === 0);
      board.send(...score(0, 0), period(1), clockFrame('8:00', { running: false }));
    }
  });

  it('volleyball: the deciding set is won at 25 too, and a won match never gains a set', async () => {
    // Best of 3 at 1-1: 16-14 in set 3 is not the end (IHSA plays it to 25).
    const game = await liveGame({ sport: 'volleyball', options: { bestOf: 3 } });
    board.send(...score(25, 20), period(1));
    await waitForGame(admin, game.id, (g) => g.home.setScore === 25, 'set 1');
    board.send(...score(0, 0), period(2));
    await waitForGame(admin, game.id, (g) => g.period === 1 && g.home.setScore === 0, 'set 2');
    board.send(...score(20, 25));
    await waitForGame(admin, game.id, (g) => g.away.setScore === 25, 'set 2 won by the guests');
    board.send(...score(0, 0), period(3));
    await waitForGame(admin, game.id, (g) => g.period === 2 && g.away.setScore === 0, 'set 3');
    board.send(...score(16, 14));
    await waitForGame(admin, game.id, (g) => g.home.setScore === 16, 'set 3 16-14');
    // Time-outs, an injury: minutes without a point.
    await pass(FINAL_HORN_HOLD_MS + MIN);
    await sleep(TICKS);
    let live = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(live.status, 'live');
    assert.doesNotMatch(live.scoreboard.message, /Match won/);
    const from = now();
    board.send(...score(25, 23));
    live = await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Match won'), 'set 3 won');
    assertHorn(live.scoreboard.message, from, now(), true);
    t.clock.advance(FINAL_HORN_HOLD_MS);
    let ended = await waitForGame(admin, game.id, (g) => g.status === 'final', 'ended');
    assert.deepEqual([ended.home.score, ended.away.score], [2, 1]);
    await waitFor(() => board.open === 0);
    await admin.delete(`/api/games/${game.id}`);

    // 2-0, then the console moves on to game 3 before the points are cleared.
    const second = await liveGame({ sport: 'volleyball', options: { bestOf: 3 } });
    board.send(...score(25, 20), period(1));
    await waitForGame(admin, second.id, (g) => g.home.setScore === 25, 'set 1');
    board.send(...score(0, 0), period(2));
    await waitForGame(admin, second.id, (g) => g.period === 1 && g.home.setScore === 0, 'set 2');
    board.send(...score(25, 18));
    await waitForGame(admin, second.id, (g) => g.scoreboard.message.startsWith('Match won'), 'match won');
    board.send(period(3));
    await sleep(TICKS);
    board.send(...score(0, 0));
    await sleep(TICKS);
    live = (await admin.get(`/api/games/${second.id}`)).json.game;
    assert.equal(live.period, 1, 'no set 3');
    t.clock.advance(FINAL_HORN_HOLD_MS);
    ended = await waitForGame(admin, second.id, (g) => g.status === 'final', 'ended');
    assert.deepEqual([ended.home.score, ended.away.score], [2, 0]);
    assert.deepEqual(ended.line, [{ home: 25, away: 20 }, { home: 25, away: 18 }]);
  });

  it('a live game whose scoreboard is set to Off still holds it', async () => {
    const girls = await liveGame({ gender: 'girls' });
    board.send(...score(30, 28), period(3), clockFrame('4:00', { running: true }));
    await waitForGame(admin, girls.id, (g) => g.home.score === 30, 'girls Q3');
    const boys = await createGame(admin, { scheduledAt: now() - MIN, gender: 'boys' });
    assert.equal((await admin.patch(`/api/games/${girls.id}`, { scoreboard: 'off' })).status, 200);
    await waitFor(() => board.open === 0, { message: 'the girls are no longer read' });
    await sleep(TICKS);
    assert.equal(board.open, 0, 'the gym is in use: not watched');
    assert.equal(
      (await admin.get(`/api/games/${boys.id}`)).json.game.scoreboard.message,
      'Starts automatically once Girls Basketball (Marquette vs Lincoln) has ended: that game is still live on this scoreboard.',
    );
    await admin.post(`/api/games/${girls.id}/end`, {});
    await waitFor(() => board.open === 1, { message: 'watched once the girls ended' });
    board.send(...score(0, 0), period(1), clockFrame('8:00', { running: false }));
    await waitForGame(admin, boys.id, (g) => g.status === 'live', 'boys start');
  });

  it('renews a watching connection while the console is off, without calling the box unreachable', async () => {
    const game = await createGame(admin, { scheduledAt: now() - MIN });
    await waitFor(() => board.open === 1);
    const watching = `Starts automatically once the scoreboard is on. Connected to ${board.address}, waiting for data from the scoreboard console.`;
    const before = await waitForGame(admin, game.id, (g) => g.scoreboard.message === watching, 'watching');
    const connections = board.connections;
    for (let renewed = 1; renewed <= 3; renewed += 1) {
      t.clock.advance(FAST.reconnectAfterQuietMs + 1000);
      await waitFor(() => board.connections === connections + renewed && board.open === 1, { message: `renewed ${renewed}` });
    }
    await sleep(TICKS);
    const after = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(after.scoreboard.message, watching);
    assert.equal(after.version, before.version, 'no status change was published');
    const [feed] = (await admin.get('/api/admin/scoreboard')).json.feeds;
    assert.deepEqual([feed.state, feed.error], ['waiting', null]);
    board.send(clockFrame('8:00', { running: false }));
    await waitForGame(admin, game.id, (g) => g.status === 'live', 'started once the console is on');
  });

  it("game night: the girls' game ends at the horn, then the boys' game starts by itself", async () => {
    const device = await register('game-night');
    const girls = await createGame(admin, { scheduledAt: now() - MIN, gender: 'girls', level: 'varsity' });
    const boys = await createGame(admin, { scheduledAt: now() + MIN, gender: 'boys', level: 'varsity' });
    await waitFor(() => board.open === 1);
    board.send(clockFrame('8:00', { running: false }), ...score(0, 0), period(1));
    await waitForGame(admin, girls.id, (g) => g.status === 'live', 'girls start');
    assert.equal((await pushToStart(device, girls.id)).json.aps.attributes.sportName, 'Girls Varsity Basketball');

    // The boys' time comes while the girls are still playing.
    await pass(90_000, '8:00');
    await waitForGame(
      admin,
      boys.id,
      (g) => g.scoreboard.message === 'Starts automatically once Girls Varsity Basketball (Marquette vs Lincoln) has ended: that game is still live on this scoreboard.',
      'boys wait for the girls',
    );
    await finalHorn(admin, board, girls.id, 52, 47);
    await waitForGame(admin, girls.id, (g) => g.scoreboard.message.startsWith('Final horn'), 'girls final horn');
    assert.equal((await admin.get(`/api/games/${boys.id}`)).json.game.status, 'scheduled');

    // Two minutes after the horn the girls' game ends, and the boys' game
    // starts on the same connection - with nothing of the girls' game the
    // console sent before, only what it sends from then on.
    const connections = board.connections;
    await pass(FINAL_HORN_HOLD_MS, '0:00');
    const ended = await waitForGame(admin, girls.id, (g) => g.status === 'final', 'girls end');
    assert.deepEqual([ended.home.score, ended.away.score], [52, 47]);
    let live = await waitForGame(admin, boys.id, (g) => g.status === 'live', 'boys start');
    board.send(clockFrame('0:00', { running: false }));
    live = await waitForGame(admin, boys.id, (g) => g.clock.remainingMs === 0, "the console's clock");
    assert.deepEqual([live.home.score, live.away.score, live.period], [0, 0, 0]);
    assert.equal(live.sportName, 'Boys Varsity Basketball');
    assert.equal(board.connections, connections);
    assert.equal((await pushToStart(device, boys.id)).json.aps.attributes.sportName, 'Boys Varsity Basketball');
    // The operator sets the console up for the boys' game.
    board.send(...score(0, 0), period(1), clockFrame('8:00', { running: false }));
    live = await waitForGame(admin, boys.id, (g) => g.clock.remainingMs === 480_000, 'console set for the boys');
    assert.equal(live.scoreboard.controlling, true);
    assert.equal(live.status, 'live');
  });
});

describe('scoreboard: final-horn holds and stop()', () => {
  it('stop() clears a pending hold: nothing ends afterwards', async () => {
    const t = await startTestApp({ appOptions: { scoreboardOptions: { timing: FAST } } });
    const board = await fakeScoreboard();
    try {
      t.app.scoreboard.start();
      const admin = await t.signedIn('boss', 'admin');
      await admin.patch('/api/admin/scoreboard', { defaultAddress: board.address });
      const game = await createGame(admin, { scheduledAt: t.clock.now() - 4 * HOUR });
      await startGame(admin, game.id);
      await waitFor(() => board.open === 1);
      await finalHorn(admin, board, game.id, 60, 40);
      await waitForGame(admin, game.id, (g) => g.scoreboard.message.startsWith('Final horn'), 'hold');
      t.app.scoreboard.stop();
      await waitFor(() => board.open === 0, { message: 'disconnected' });
      t.clock.advance(5 * MIN);
      await sleep(TICKS);
      assert.equal(t.app.games.getGame(game.id).status, 'live');
    } finally {
      await board.close();
      await t.close();
    }
  });
});
