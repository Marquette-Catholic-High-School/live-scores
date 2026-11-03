import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { after, before, describe, it } from 'node:test';
import { FIELDS, encodeField, encodeFrame } from '../server/rtd.js';
import { parseScoreboardAddress } from '../server/scoreboard.js';
import { createGame, sleep, startGame, startTestApp, waitFor } from './helpers.js';

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

// A UDP port nothing listens on right now.
async function freeUdpPort() {
  const socket = dgram.createSocket({ type: 'udp4' });
  await new Promise((resolve) => socket.bind(0, resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

// Binds `port` on every interface, as the server does; resolves to the socket
// or null when the port is taken.
async function bindUdp(port) {
  const socket = dgram.createSocket({ type: 'udp4' });
  return new Promise((resolve) => {
    socket.once('error', () => {
      socket.close();
      resolve(null);
    });
    socket.bind(port, () => resolve(socket));
  });
}

// The server's UDP sockets, made with dgram and counted.
function countingUdp() {
  const sockets = [];
  return {
    sockets,
    create: () => {
      const socket = dgram.createSocket({ type: 'udp4' });
      const entry = { socket, closed: false };
      socket.on('close', () => {
        entry.closed = true;
      });
      sockets.push(entry);
      return socket;
    },
  };
}

// A stand-in for the server's UDP socket: the test delivers datagrams from any
// source address. Anything that would send to the box fails the test.
class FakeUdpSocket extends EventEmitter {
  port = null;
  closed = false;
  writes = 0;

  constructor(failWith) {
    super();
    this.failWith = failWith;
  }

  bind(port) {
    this.port = port;
    setImmediate(() => {
      if (this.closed) return;
      if (this.failWith) this.emit('error', this.failWith);
      else this.emit('listening');
    });
  }

  close() {
    if (this.closed) throw new Error('Not running');
    this.closed = true;
    setImmediate(() => this.emit('close'));
  }

  deliver(data, source) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(data);
    this.emit('message', buffer, { address: source, family: 'IPv4', port: 10001, size: buffer.length });
  }

  send() {
    this.writes += 1;
    throw new Error('nothing may be sent to the scoreboard box');
  }

  connect() {
    this.writes += 1;
    throw new Error('a scoreboard socket must not connect');
  }

  setBroadcast() {
    this.writes += 1;
    throw new Error('a scoreboard socket must not broadcast');
  }
}

function fakeUdp() {
  const failures = [];
  const sockets = [];
  return {
    sockets,
    // The next bind fails with this error code.
    failNext(code) {
      const err = new Error(`bind ${code}`);
      err.code = code;
      failures.push(err);
    },
    create: () => {
      const socket = new FakeUdpSocket(failures.shift() ?? null);
      sockets.push(socket);
      return socket;
    },
    bound: (port) => sockets.filter((socket) => socket.port === port),
    open: (port) => sockets.filter((socket) => socket.port === port && !socket.closed),
    get writes() {
      return sockets.reduce((sum, socket) => sum + socket.writes, 0);
    },
  };
}

describe('Daktronics scoreboard addresses', () => {
  let t;
  let admin;

  before(async () => {
    t = await startTestApp({ appOptions: { scoreboardOptions: { timing: FAST, createUdpSocket: fakeUdp().create } } });
    admin = await t.signedIn('boss', 'admin');
  });
  after(() => t.close());

  const RESERVED = [
    [30718, /^Port 30718 is the Lantronix box's setup port and never sends scoreboard data\. Use the box's data port \(Channel 1 "Local Port", 10001 unless it was changed\), or udp:\/\/<ip>:<port> if the box sends over UDP\.$/],
    [30704, /^Port 30704 is the box's GPIO control port and never sends scoreboard data\./],
    [9999, /^Port 9999 is the box's Telnet setup port and never sends scoreboard data\./],
    [14000, /^Port 14000 is reserved for the Lantronix Com Port Redirector and never sends scoreboard data\./],
    [14009, /^Port 14009 is reserved for the Lantronix Com Port Redirector/],
    [80, /^Port 80 is the box's web page and never sends scoreboard data\./],
  ];

  it('parses udp:// and tcp:// addresses into one canonical form', () => {
    assert.equal(parseScoreboardAddress('udp://10.20.1.50'), 'udp://10.20.1.50:21000');
    assert.equal(parseScoreboardAddress(' UDP://10.20.1.50:21001 '), 'udp://10.20.1.50:21001');
    assert.equal(parseScoreboardAddress('Udp://[::ffff:10.20.1.50]:1024'), 'udp://10.20.1.50:1024');
    assert.equal(parseScoreboardAddress('udp://::FFFF:0a14:0132'), 'udp://10.20.1.50:21000');
    assert.equal(parseScoreboardAddress('udp://10.20.1.50:65535'), 'udp://10.20.1.50:65535');
    assert.equal(parseScoreboardAddress('tcp://10.20.1.50'), '10.20.1.50:10001');
    assert.equal(parseScoreboardAddress('TCP://10.20.1.50:3001'), '10.20.1.50:3001');
    assert.equal(parseScoreboardAddress('tcp://[FE80:0::5]:3001'), '[fe80::5]:3001');
    // The reserved ports are the box's; over UDP the port is the server's.
    assert.equal(parseScoreboardAddress('udp://10.10.10.122:30718'), 'udp://10.10.10.122:30718');
    assert.equal(parseScoreboardAddress('10.10.10.122:13999'), '10.10.10.122:13999');
    assert.equal(parseScoreboardAddress('10.10.10.122:14010'), '10.10.10.122:14010');
    assert.equal(parseScoreboardAddress('tcp://[ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255]:65535'), '[ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]:65535');

    for (const bad of ['udp://fe80::5', 'udp://[fe80::5]:21000', 'UDP://[::1]']) {
      assert.throws(() => parseScoreboardAddress(bad), { status: 400, message: 'A scoreboard that sends over UDP needs an IPv4 address.' }, bad);
    }
    for (const bad of ['udp://10.20.1.50:1023', 'udp://10.20.1.50:80', 'udp://10.20.1.50:0', 'udp://10.20.1.50:70000']) {
      assert.throws(() => parseScoreboardAddress(bad), /invalid UDP port: use one from 1024 to 65535 \(the server can't listen on lower ports\)/, bad);
    }
    for (const [port, message] of RESERVED) {
      assert.throws(() => parseScoreboardAddress(`10.10.10.122:${port}`), (err) => err.status === 400 && message.test(err.message), String(port));
      assert.throws(() => parseScoreboardAddress(`tcp://10.10.10.122:${port}`), (err) => message.test(err.message), `tcp ${port}`);
    }
    assert.throws(() => parseScoreboardAddress('[fe80::5]:9999'), /Telnet setup port/);
    for (const bad of ['udp://', 'udp://gym-box', 'udp:/10.1.1.1', 'udp:10.1.1.1', 'ftp://10.1.1.1', 'udp://10.1.1.1:', 'udp:// 10.1.1.1', `udp://${'1'.repeat(70)}`]) {
      assert.throws(() => parseScoreboardAddress(bad), /must be an IP address/, bad);
    }
  });

  it('applies the same rules to the default address, a game and a test', async () => {
    let res = await admin.patch('/api/admin/scoreboard', { defaultAddress: ' UDP://10.20.1.50 ' });
    assert.equal(res.status, 200);
    assert.equal(res.json.defaultAddress, 'udp://10.20.1.50:21000');
    res = await admin.patch('/api/admin/scoreboard', { defaultAddress: 'tcp://10.20.1.50' });
    assert.equal(res.json.defaultAddress, '10.20.1.50:10001');
    for (const [port, message] of RESERVED) {
      res = await admin.patch('/api/admin/scoreboard', { defaultAddress: `10.10.10.122:${port}` });
      assert.equal(res.status, 400, String(port));
      assert.equal(res.json.error.code, 'bad_request');
      assert.match(res.json.error.message, message);
    }
    res = await admin.patch('/api/admin/scoreboard', { defaultAddress: 'udp://[fe80::5]' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.message, 'A scoreboard that sends over UDP needs an IPv4 address.');
    res = await admin.patch('/api/admin/scoreboard', { defaultAddress: 'udp://10.20.1.50:514' });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /^defaultAddress has an invalid UDP port/);
    assert.equal((await admin.get('/api/admin/scoreboard')).json.defaultAddress, '10.20.1.50:10001', 'a refused address changes nothing');

    // A game's own scoreboard, on create and update.
    const created = await admin.post('/api/games', {
      sport: 'basketball',
      away: { name: 'Lincoln', code: 'LIN', color: '#B22234' },
      scheduledAt: Date.now() + 3_600_000,
      scoreboard: 'udp://10.20.1.51:21001',
    });
    assert.equal(created.status, 200);
    const game = created.json.game;
    assert.equal(game.scoreboard.setting, 'custom');
    assert.equal(game.scoreboard.custom, 'udp://10.20.1.51:21001');
    assert.equal(game.scoreboard.address, 'udp://10.20.1.51:21001');
    assert.match(game.scoreboard.message, /udp:\/\/10\.20\.1\.51:21001 once the game starts/);
    res = await admin.post('/api/games', { sport: 'basketball', away: { name: 'Lincoln', code: 'LIN', color: '#B22234' }, scheduledAt: Date.now(), scoreboard: '10.20.1.51:30718' });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /setup port/);
    res = await admin.patch(`/api/games/${game.id}`, { scoreboard: 'TCP://10.20.1.51' });
    assert.equal(res.json.game.scoreboard.custom, '10.20.1.51:10001');
    res = await admin.patch(`/api/games/${game.id}`, { scoreboard: 'udp://10.20.1.51:1000' });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /^scoreboard has an invalid UDP port/);
    res = await admin.patch(`/api/games/${game.id}`, { scoreboard: 'udp://fe80::9' });
    assert.equal(res.status, 400);
    res = await admin.patch(`/api/games/${game.id}`, { scoreboard: '10.20.1.51:14003' });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /Com Port Redirector/);
    assert.equal((await admin.get(`/api/games/${game.id}`)).json.game.scoreboard.custom, '10.20.1.51:10001');

    // Test connection.
    res = await admin.post('/api/admin/scoreboard/test', { address: '10.10.10.122:30718' });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, RESERVED[0][1]);
    res = await admin.post('/api/admin/scoreboard/test', { address: 'udp://[2001:db8::1]:21000' });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.message, 'A scoreboard that sends over UDP needs an IPv4 address.');
    res = await admin.post('/api/admin/scoreboard/test', { address: 'udp://10.20.1.50:443' });
    assert.equal(res.status, 400);
  });
});

describe('Daktronics scoreboard over UDP', () => {
  let t;
  let admin;
  const udp = countingUdp();

  before(async () => {
    t = await startTestApp({ appOptions: { scoreboardOptions: { timing: FAST, createUdpSocket: udp.create } } });
    t.app.scoreboard.start();
    admin = await t.signedIn('boss', 'admin');
  });
  after(() => t.close());

  it('drives a live basketball game from datagrams, never sends, and lets the port go when the game ends', async () => {
    const port = await freeUdpPort();
    const set = await admin.patch('/api/admin/scoreboard', { defaultAddress: `UDP://127.0.0.1:${port}` });
    assert.equal(set.json.defaultAddress, `udp://127.0.0.1:${port}`);
    const game = await createGame(admin, { scheduledAt: Date.now() });
    assert.equal(udp.sockets.length, 0, 'nothing listens before the game starts');
    const started = await startGame(admin, game.id);
    assert.equal(started.game.scoreboard.state, 'connecting');
    assert.equal(started.game.scoreboard.message, `Starting to listen for the scoreboard on UDP port ${port}…`);
    let live = await waitForGame(admin, game.id, (g) => g.scoreboard.state === 'waiting', 'listening');
    assert.equal(live.scoreboard.message, `Listening on UDP port ${port}, waiting for data from the scoreboard at 127.0.0.1.`);
    assert.equal(live.scoreboard.controlling, true);

    // The box: datagrams that cut frames anywhere. It must never get anything back.
    const box = dgram.createSocket({ type: 'udp4' });
    let answered = 0;
    box.on('message', () => {
      answered += 1;
    });
    const send = async (data, size) => {
      for (let i = 0; i < data.length; i += size) {
        await new Promise((resolve, reject) => box.send(data.subarray(i, i + size), port, '127.0.0.1', (err) => (err ? reject(err) : resolve())));
      }
    };
    try {
      await send(Buffer.concat([clockFrame('8:00', { running: false }), ...score(2, 0), period(1)]), 13);
      live = await waitForGame(admin, game.id, (g) => g.home.score === 2 && g.scoreboard.state === 'receiving', 'first reading');
      assert.equal(live.clock.remainingMs, 480_000);
      assert.equal(live.scoreboard.message, 'Score, clock and period come from the scoreboard.');
      await send(Buffer.concat([...score(15, 12), period(2), clockFrame('6:30', { running: true })]), 37);
      live = await waitForGame(admin, game.id, (g) => g.period === 1 && g.away.score === 12 && g.clock.running, 'second reading');
      assert.equal(live.home.score, 15);

      // "Test connection" reports the live feed.
      const shared = (await admin.post('/api/admin/scoreboard/test', { address: `udp://127.0.0.1:${port}` })).json.result;
      assert.equal(shared.transport, 'udp');
      assert.equal(shared.inUse, true);
      assert.equal(shared.gameId, game.id);
      assert.equal(shared.connected, true);
      assert.equal(shared.receiving, true);
      assert.ok(shared.datagrams > 6, `${shared.datagrams} datagrams`);
      assert.ok(shared.frames >= 6);
      assert.deepEqual(shared.otherSources, []);
      assert.equal(shared.firewallHint, `sudo ufw allow proto udp from 127.0.0.1 to any port ${port}`);
      assert.ok(shared.listenedMs > 0);
      assert.equal(shared.reading.home, 15);

      // Quiet for longer than a TCP feed would wait before reconnecting: the
      // state goes back to waiting, and the socket and what was read stay.
      t.clock.advance(20_000);
      await waitForGame(admin, game.id, (g) => g.scoreboard.state === 'waiting', 'waiting after a quiet spell');
      t.clock.advance(120_000);
      await sleep(5 * FAST.tickMs);
      assert.equal(udp.sockets.length, 1, 'no socket churn');
      await send(Buffer.concat(score(18, 12)), 1000);
      live = await waitForGame(admin, game.id, (g) => g.home.score === 18 && g.scoreboard.state === 'receiving', 'data again');
      assert.equal(live.period, 1);
      const kept = (await admin.post('/api/admin/scoreboard/test', { address: `udp://127.0.0.1:${port}` })).json.result;
      assert.equal(kept.reading.period, 2, 'what was read before the quiet spell is still known');
      assert.equal(kept.reading.clockMs, 390_000);
      assert.equal(answered, 0, 'nothing is ever sent to the scoreboard box');
    } finally {
      box.close();
    }

    assert.equal((await admin.post(`/api/games/${game.id}/end`, {})).status, 200);
    const reuse = await waitFor(() => bindUdp(port), { message: 'the port is free again after the game' });
    reuse.close();
    await waitFor(() => udp.sockets.every((entry) => entry.closed), { message: 'every socket closed' });
  });

  it('reports a UDP port another program holds, and retries until it is free', async () => {
    const port = await freeUdpPort();
    const holder = await bindUdp(port);
    assert.ok(holder);
    const before = udp.sockets.length;
    const game = await createGame(admin, { scheduledAt: Date.now(), scoreboard: `udp://127.0.0.1:${port}` });
    await startGame(admin, game.id);
    const live = await waitForGame(admin, game.id, (g) => g.scoreboard.state === 'unreachable', 'unreachable');
    assert.equal(live.scoreboard.message, `Can't listen for the scoreboard on UDP port ${port}: another program on this server is using that UDP port. Retrying.`);
    assert.equal(live.scoreboard.controlling, true);
    await waitFor(() => udp.sockets.length >= before + 2, { message: 'retried' });

    const feed = await waitFor(
      async () => (await admin.get('/api/admin/scoreboard')).json.feeds.find((entry) => entry.gameId === game.id && entry.state === 'unreachable'),
      { message: 'the feed listed as unreachable' },
    );
    assert.equal(feed.address, `udp://127.0.0.1:${port}`);
    assert.equal(feed.error, 'another program on this server is using that UDP port');

    const inUse = (await admin.post('/api/admin/scoreboard/test', { address: `udp://127.0.0.1:${port}` })).json.result;
    assert.equal(inUse.inUse, true);
    assert.equal(inUse.connected, false);
    assert.equal(inUse.listenedMs, 0);
    const other = (await admin.post('/api/admin/scoreboard/test', { address: `udp://127.0.0.9:${port}` })).json.result;
    assert.equal(other.inUse, false);
    assert.equal(other.connected, false);
    assert.equal(other.error, 'another program on this server is using that UDP port');
    assert.equal(other.listenedMs, 0);
    assert.equal(other.firewallHint, `sudo ufw allow proto udp from 127.0.0.9 to any port ${port}`);

    await new Promise((resolve) => holder.close(resolve));
    await waitForGame(admin, game.id, (g) => g.scoreboard.state === 'waiting', 'listening once the port is free');
    await admin.post(`/api/games/${game.id}/end`, {});
    await waitFor(() => udp.sockets.every((entry) => entry.closed), { message: 'every socket closed' });
  });

  it('stop() closes every socket and timer', async () => {
    const counting = countingUdp();
    const other = await startTestApp({ appOptions: { scoreboardOptions: { timing: FAST, createUdpSocket: counting.create } } });
    const udpHandles = () => process.getActiveResourcesInfo().filter((name) => name === 'UDPWrap').length;
    const baseline = udpHandles();
    const listening = await freeUdpPort();
    const blocked = await freeUdpPort();
    const holder = await bindUdp(blocked);
    try {
      other.app.scoreboard.start();
      const boss = await other.signedIn('boss', 'admin');
      const one = await createGame(boss, { scheduledAt: Date.now(), scoreboard: `udp://127.0.0.1:${listening}` });
      const two = await createGame(boss, { scheduledAt: Date.now(), scoreboard: `udp://127.0.0.1:${blocked}`, sport: 'volleyball' });
      await startGame(boss, one.id);
      await startGame(boss, two.id);
      await waitForGame(boss, one.id, (g) => g.scoreboard.state === 'waiting', 'listening');
      await waitForGame(boss, two.id, (g) => g.scoreboard.state === 'unreachable', 'port taken');
      // A test sharing the listening feed's socket is still running.
      const test = other.app.scoreboard.test(`udp://127.0.0.3:${listening}`);
      await sleep(30);

      other.app.scoreboard.stop();
      const result = await test;
      assert.equal(result.connected, true, 'the test ends with what it had');
      assert.ok(result.listenedMs < FAST.testListenMs, `ended with the service (${result.listenedMs} ms)`);
      await waitFor(() => counting.sockets.every((entry) => entry.closed), { message: 'every socket closed' });
      holder.close();
      await waitFor(() => udpHandles() === baseline, { message: `no UDP handles left (${udpHandles()} vs ${baseline})` });
      const created = counting.sockets.length;
      await sleep(4 * FAST.retryDelaysMs.at(-1));
      assert.equal(counting.sockets.length, created, 'no retry after stop');
    } finally {
      await other.close();
    }
  });
});

describe('Daktronics scoreboard over UDP: sources and sharing', () => {
  let t;
  let admin;
  const fake = fakeUdp();

  before(async () => {
    t = await startTestApp({ appOptions: { scoreboardOptions: { timing: FAST, createUdpSocket: fake.create } } });
    t.app.scoreboard.start();
    admin = await t.signedIn('boss', 'admin');
  });
  after(() => t.close());

  it("keeps only the box's datagrams; a test for another box shares the socket and lists who else sent", async () => {
    await admin.patch('/api/admin/scoreboard', { defaultAddress: 'udp://10.20.1.50' });
    const game = await createGame(admin, { scheduledAt: Date.now() });
    await startGame(admin, game.id);
    await waitForGame(admin, game.id, (g) => g.scoreboard.state === 'waiting', 'listening');
    assert.equal(fake.open(21000).length, 1);
    const socket = fake.open(21000)[0];

    // Another device on the network sends to the same port: ignored.
    socket.deliver(score(9, 9), '10.10.10.50');
    socket.deliver([...score(2, 0), period(1)], '10.20.1.50');
    let live = await waitForGame(admin, game.id, (g) => g.home.score === 2, 'the box');
    assert.equal(live.away.score, 0, "another sender's datagrams are not read");

    // A test for a second box on the same port, while the first one keeps sending.
    let ticks = 0;
    const sending = setInterval(() => {
      ticks += 1;
      for (let i = 0; i < 3; i += 1) socket.deliver(Buffer.from('noise'), '10.10.10.50');
      socket.deliver(score(4, 4), '10.20.1.50');
      socket.deliver(score(4, 4), '10.20.1.50');
      socket.deliver([clockFrame('5:00', { running: false }), ...score(1, 2)], '10.20.1.77');
    }, 15);
    let result;
    try {
      result = (await admin.post('/api/admin/scoreboard/test', { address: 'udp://10.20.1.77:21000' })).json.result;
    } finally {
      clearInterval(sending);
    }
    assert.equal(result.transport, 'udp');
    assert.equal(result.inUse, false);
    assert.equal(result.connected, true);
    assert.equal(result.receiving, true);
    assert.equal(result.error, null);
    assert.ok(result.datagrams > 0 && result.datagrams <= ticks);
    assert.equal(result.reading.clockMs, 300_000);
    assert.equal(result.reading.home, 1);
    assert.equal(result.otherSources.length, 2);
    assert.equal(result.otherSources[0].address, '10.10.10.50');
    assert.equal(result.otherSources[1].address, '10.20.1.50');
    assert.equal(result.otherSources[0].datagrams, 3 * result.otherSources[1].datagrams / 2);
    assert.ok(result.otherSources[1].datagrams >= 2 * result.datagrams);
    assert.equal(result.firewallHint, 'sudo ufw allow proto udp from 10.20.1.77 to any port 21000');
    assert.ok(result.listenedMs > 0 && result.listenedMs < 2000, `${result.listenedMs} ms`);
    assert.equal(fake.bound(21000).length, 1, 'the port is bound once');
    assert.equal(socket.closed, false, "the test leaves the feed's socket open");
    live = await waitForGame(admin, game.id, (g) => g.home.score === 4, 'the feed kept reading during the test');
    assert.equal(live.scoreboard.state, 'receiving');

    // At most five other senders, the busiest first.
    const crowd = setInterval(() => {
      for (let n = 1; n <= 7; n += 1) for (let i = 0; i < n; i += 1) socket.deliver(Buffer.from('?'), `10.0.0.${n}`);
    }, 15);
    try {
      result = (await admin.post('/api/admin/scoreboard/test', { address: 'udp://10.20.1.78:21000' })).json.result;
    } finally {
      clearInterval(crowd);
    }
    assert.equal(result.receiving, false);
    assert.equal(result.datagrams, 0);
    assert.deepEqual(result.otherSources.map((entry) => entry.address), ['10.0.0.7', '10.0.0.6', '10.0.0.5', '10.0.0.4', '10.0.0.3']);
    assert.ok(result.otherSources.every((entry, i) => i === 0 || entry.datagrams < result.otherSources[i - 1].datagrams));

    // The feed's own box.
    const shared = (await admin.post('/api/admin/scoreboard/test', { address: 'UDP://10.20.1.50' })).json.result;
    assert.equal(shared.inUse, true);
    assert.equal(shared.gameId, game.id);
    assert.equal(shared.address, 'udp://10.20.1.50:21000');
    assert.ok(shared.datagrams >= 3);
    assert.deepEqual(shared.otherSources, []);

    assert.equal((await admin.post(`/api/games/${game.id}/end`, {})).status, 200);
    assert.equal(socket.closed, true, 'the socket closes when the game ends');
    assert.equal(fake.open(21000).length, 0);
    // Late events on a closed socket are dropped.
    socket.emit('listening');
    socket.deliver(score(50, 50), '10.20.1.50');
    socket.emit('error', Object.assign(new Error('late'), { code: 'EADDRINUSE' }));
    await sleep(50);
    const ended = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(ended.status, 'final');
    assert.equal(ended.home.score, 4);
    assert.equal(fake.writes, 0, 'nothing is ever sent');
  });

  it('a test on a port no feed uses binds it for the test only', async () => {
    const result = (await admin.post('/api/admin/scoreboard/test', { address: 'udp://10.20.1.90:22000' })).json.result;
    assert.equal(result.connected, true);
    assert.equal(result.receiving, false);
    assert.equal(result.error, null);
    assert.equal(result.datagrams, 0);
    assert.deepEqual(result.otherSources, []);
    assert.ok(result.listenedMs >= FAST.testListenMs - 50, `${result.listenedMs} ms`);
    assert.equal(fake.bound(22000).length, 1);
    assert.equal(fake.open(22000).length, 0, 'closed after the test');
  });

  it('two boxes on one port share a socket until both games end', async () => {
    const one = await createGame(admin, { scheduledAt: Date.now(), scoreboard: 'udp://10.20.1.61:23000' });
    const two = await createGame(admin, { scheduledAt: Date.now(), scoreboard: 'udp://10.20.1.62:23000', sport: 'volleyball' });
    await startGame(admin, one.id);
    await startGame(admin, two.id);
    await waitForGame(admin, two.id, (g) => g.scoreboard.state === 'waiting', 'second feed listening');
    assert.equal(fake.bound(23000).length, 1);
    const socket = fake.open(23000)[0];
    socket.deliver(score(11, 7), '10.20.1.61');
    socket.deliver([...score(5, 3), period(1)], '10.20.1.62');
    await waitForGame(admin, one.id, (g) => g.home.score === 11 && g.away.score === 7, 'first game');
    await waitForGame(admin, two.id, (g) => g.home.setScore === 5 && g.away.setScore === 3, 'second game');
    await admin.post(`/api/games/${one.id}/end`, {});
    assert.equal(socket.closed, false, 'still needed by the other game');
    await admin.post(`/api/games/${two.id}/end`, {});
    assert.equal(socket.closed, true);
  });

  it("reports a port the server isn't allowed to use, then listens once it can", async () => {
    fake.failNext('EACCES');
    const game = await createGame(admin, { scheduledAt: Date.now(), scoreboard: 'udp://10.20.1.60:21500' });
    await startGame(admin, game.id);
    const live = await waitForGame(admin, game.id, (g) => g.scoreboard.state === 'unreachable', 'unreachable');
    assert.equal(live.scoreboard.message, "Can't listen for the scoreboard on UDP port 21500: the server isn't allowed to use that port. Retrying.");
    await waitForGame(admin, game.id, (g) => g.scoreboard.state === 'waiting', 'listening after the retry');
    assert.equal(fake.bound(21500).length, 2);

    // A socket that fails later is replaced; the feed keeps what it read.
    fake.open(21500)[0].deliver([...score(6, 4), period(2)], '10.20.1.60');
    await waitForGame(admin, game.id, (g) => g.home.score === 6, 'reading');
    fake.open(21500)[0].emit('error', Object.assign(new Error('receive failed'), { code: 'ENOBUFS' }));
    const failed = (await admin.get(`/api/games/${game.id}`)).json.game;
    assert.equal(failed.scoreboard.state, 'unreachable');
    assert.equal(failed.scoreboard.message, "Can't listen for the scoreboard on UDP port 21500: receive failed. Retrying.");
    await waitForGame(admin, game.id, (g) => g.scoreboard.state === 'waiting', 'listening again');
    assert.equal(fake.bound(21500).length, 3);
    const result = (await admin.post('/api/admin/scoreboard/test', { address: 'udp://10.20.1.60:21500' })).json.result;
    assert.equal(result.inUse, true);
    assert.equal(result.reading.home, 6);
    assert.equal(result.reading.period, 2);
    await admin.post(`/api/games/${game.id}/end`, {});
    assert.equal(fake.open(21500).length, 0);
  });

  it('stop() closes the sockets of feeds and running tests', async () => {
    const game = await createGame(admin, { scheduledAt: Date.now(), scoreboard: 'udp://10.20.1.70:24000' });
    await startGame(admin, game.id);
    await waitForGame(admin, game.id, (g) => g.scoreboard.state === 'waiting', 'listening');
    const test = t.app.scoreboard.test('udp://10.20.1.71:24001');
    await sleep(20);
    assert.equal(fake.open(24000).length + fake.open(24001).length, 2);
    t.app.scoreboard.stop();
    assert.ok(fake.sockets.every((socket) => socket.closed), 'every socket closed at once');
    const result = await test;
    assert.equal(result.connected, true);
    assert.ok(result.listenedMs < FAST.testListenMs, 'the running test ended with the service');
    assert.equal(fake.writes, 0);
  });
});
