// Daktronics scoreboard feeds (ARCHITECTURE.md §11). While a basketball or
// volleyball game with the school's team at home is live, the server reads the
// scoreboard's RTD stream from its Lantronix box and keeps the game's score,
// clock and period in step with it. The box is either a TCP server (by
// default on port 10001) or sends UDP datagrams to the server
// (scoreboard-udp.js).
//
// Such a game also starts by itself: from its scheduled time the scoreboard
// is watched, and the game starts as soon as the console sends data. It ends
// by itself two minutes after the final horn.
//
// Read-only: nothing is ever written to the box - the Lantronix passes every
// byte straight into the console. The box accepts one TCP connection at a
// time, so the server connects only while a game needs the feed, shares that
// connection with "Test connection", and reconnects with backoff.

import dgram from 'node:dgram';
import net from 'node:net';
import { badRequest } from './errors.js';
import { CONSOLE_RESET_REASON, FINAL_HORN_REASON, computeScores, gameLabel, lastPeriodIndex, overOnScoreboard } from './games.js';
import { getSport } from './sports.js';
import { RtdReader } from './rtd.js';
import { UdpListeners } from './scoreboard-udp.js';

export const SCOREBOARD_SPORTS = Object.freeze(['basketball', 'volleyball']);
export const DEFAULT_SCOREBOARD_PORT = 10001;
export const DEFAULT_UDP_PORT = 21000;
// A scheduled game starts by itself from its time until this long after it.
export const AUTO_START_WINDOW_MS = 3 * 60 * 60 * 1000;
// A game over on the scoreboard ends this long after the final horn.
export const FINAL_HORN_HOLD_MS = 120_000;
const DEFAULT_ADDRESS_KEY = 'scoreboard.defaultAddress';
// The Lantronix box's own ports: some accept a TCP connection, none carries
// the console's data. [first, last, what it is]
const RESERVED_TCP_PORTS = Object.freeze([
  [30718, 30718, "the Lantronix box's setup port"],
  [30704, 30704, "the box's GPIO control port"],
  [9999, 9999, "the box's Telnet setup port"],
  [14000, 14009, 'reserved for the Lantronix Com Port Redirector'],
  [80, 80, "the box's web page"],
]);
// "Test connection" over UDP reports at most this many other senders, and
// counts at most TRACKED_SOURCES of them.
const OTHER_SOURCES = 5;
const TRACKED_SOURCES = 64;

const TIMING = Object.freeze({
  connectTimeoutMs: 5000,
  retryDelaysMs: [2000, 5000, 10_000, 20_000, 30_000],
  // Fields set by one operator action can arrive in several frames: apply
  // them together.
  applyDebounceMs: 150,
  applyMaxWaitMs: 500,
  // The console sends the clock every second, running or not.
  quietAfterMs: 15_000,
  reconnectAfterQuietMs: 90_000,
  tickMs: 5000,
  testListenMs: 5000,
  testSettleMs: 2500,
  // Volleyball: points cleared to 0-0 in the same game are usually the
  // operator getting ready for the next game; give the game number time to
  // follow before the finished game's points are overwritten.
  volleyballResetHoldMs: 20_000,
  // The console back at period 1 with lower scores while the game is further
  // on: it was reset for the next game before this one was ended.
  consoleResetHoldMs: 30_000,
  // A scheduled game starts by itself only while its scoreboard sends: a
  // data frame within this long.
  autoStartDataMs: 5000,
  finalHornHoldMs: FINAL_HORN_HOLD_MS,
});
// Longest valid input: a scheme and a bracketed full IPv6 address with a port.
const MAX_ADDRESS_LENGTH = 70;

// TCP (the box is a server): "10.20.1.50", "10.20.1.50:10001", "fe80::5",
// "[fe80::5]:10001", each also with "tcp://" -> "10.20.1.50:10001" /
// "[fe80::5]:10001". UDP (the box sends to the server): "udp://10.20.1.50" or
// "udp://10.20.1.50:21000" -> "udp://10.20.1.50:21000", meaning: listen on
// UDP port 21000 and keep the datagrams from 10.20.1.50. IP addresses only:
// the box is on the school network and has no DNS name.
export function parseScoreboardAddress(value, field = 'address') {
  const invalid = () =>
    badRequest(`${field} must be an IP address such as 10.20.1.50 or 10.20.1.50:10001, or udp://10.20.1.50 for a box that sends over UDP (not a name).`);
  if (typeof value !== 'string' || value.trim().length > MAX_ADDRESS_LENGTH) throw invalid();
  const scheme = /^(tcp|udp):\/\//i.exec(value.trim());
  const udp = scheme?.[1].toLowerCase() === 'udp';
  const text = value.trim().slice(scheme ? scheme[0].length : 0);
  let host = text;
  let port = udp ? DEFAULT_UDP_PORT : DEFAULT_SCOREBOARD_PORT;
  let match = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (match) {
    host = match[1];
    if (match[2] !== undefined) port = Number(match[2]);
  } else if ((match = /^([^:]+):(\d{1,5})$/.exec(text))) {
    host = match[1];
    port = Number(match[2]);
  }
  let family = net.isIP(host);
  // No IPv6 zone ids ("%eth0"): one spelling per box, so it gets one feed.
  if (family === 0 || host.includes('%')) throw invalid();
  if (!udp && (!Number.isInteger(port) || port < 1 || port > 65535)) throw badRequest(`${field} has an invalid port (1-65535).`);
  if (family === 6) {
    // Canonical form: "0:0:0:0:0:0:0:1" -> "::1"; an IPv4-mapped address is the IPv4 one.
    host = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      host = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
      family = 4;
    }
  } else {
    host = host.split('.').map(Number).join('.');
  }
  if (udp) {
    // The server listens on IPv4 only, and as an unprivileged service it can't
    // bind ports below 1024.
    if (family === 6) throw badRequest('A scoreboard that sends over UDP needs an IPv4 address.');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw badRequest(`${field} has an invalid UDP port: use one from 1024 to 65535 (the server can't listen on lower ports).`);
    }
    return `udp://${host}:${port}`;
  }
  const reserved = RESERVED_TCP_PORTS.find(([first, last]) => port >= first && port <= last);
  if (reserved) {
    throw badRequest(
      `Port ${port} is ${reserved[2]} and never sends scoreboard data. Use the box's data port (Channel 1 "Local Port", 10001 unless it was changed), or udp://<ip>:<port> if the box sends over UDP.`,
    );
  }
  return family === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

// A normalized address's parts: { transport: 'tcp' | 'udp', host, port }.
export function splitScoreboardAddress(address) {
  const udp = address.startsWith('udp://');
  const rest = udp ? address.slice('udp://'.length) : address;
  const match = /^\[(.+)\]:(\d+)$/.exec(rest) ?? /^([^:]+):(\d+)$/.exec(rest);
  return { transport: udp ? 'udp' : 'tcp', host: match[1], port: Number(match[2]) };
}

const firewallHint = (host, port) => `sudo ufw allow proto udp from ${host} to any port ${port}`;

// A game's per-game setting as stored: 'default', 'off', or a normalized address.
export function parseScoreboardSetting(value) {
  if (value === null || value === 'default') return 'default';
  if (value === 'off') return 'off';
  return parseScoreboardAddress(value, 'scoreboard');
}

// "Girls Varsity Basketball (Marquette vs Lincoln)", for messages.
function describeGame(game) {
  return `${gameLabel(game)} (${game.home.name} vs ${game.away.name})`;
}

// a starts before b when both are due on one scoreboard: the later
// scheduled time, then the lower id.
function startsFirst(a, b) {
  return a.scheduledAt > b.scheduledAt || (a.scheduledAt === b.scheduledAt && a.id < b.id);
}

// A due game is passed over for good once `other`, scheduled no earlier on
// the same scoreboard, has started since its time came.
function passesOver(other, game) {
  return other.id !== game.id && other.scheduledAt >= game.scheduledAt && other.startedAt >= game.scheduledAt;
}

// Of two live games on one scoreboard, a was started later (it wins the feed).
function startedLater(a, b) {
  const at = (game) => game.startedAt ?? 0;
  return at(a) > at(b) || (at(a) === at(b) && a.id > b.id);
}

function sameTeam(team, ours) {
  const name = (value) => String(value ?? '').trim().toLowerCase();
  return team.code.toUpperCase() === ours.code.toUpperCase() || name(team.name) === name(ours.name);
}

// The feed only ever drives basketball and volleyball games where the school's
// team (HOME_TEAM_NAME / HOME_TEAM_CODE) is the home team.
export function scoreboardEligible(game, homeTeam) {
  return SCOREBOARD_SPORTS.includes(game.sport) && sameTeam(game.home, homeTeam);
}

// What the feed sets for this game, for messages.
function fieldsRead(game) {
  if (getSport(game.sport).scoreMode === 'sets') return 'Points and set';
  return game.options.clockEnabled ? 'Score, clock and period' : 'Score and period';
}

// Whether a reading still shows the game before on this scoreboard, for a
// game at its start (#holdPreviousGame): at or beyond that game's last period,
// or either team at or beyond its score there (`check.previous`, when known).
// A game the scoreboard started also takes any period after the first for the
// game before, and learns its display from it.
function showsPreviousGame(check, reading) {
  const known = (value) => value !== null && value !== undefined;
  if (check.auto && known(reading.period) && reading.period > 1) {
    check.previous = { period: reading.period, home: reading.home ?? check.previous?.home ?? 0, away: reading.away ?? check.previous?.away ?? 0 };
    return true;
  }
  const previous = check.previous;
  if (previous === null) return false;
  return (
    (known(reading.period) && reading.period >= previous.period) ||
    (known(reading.home) && previous.home > 0 && reading.home >= previous.home) ||
    (known(reading.away) && previous.away > 0 && reading.away >= previous.away)
  );
}

// During a final-horn hold: the console set up for the next game, in
// whatever order the operator does it - the period (game number) moved back,
// or (points mode) a team's score cleared to 0. A volleyball game's points
// cleared to 0-0 are held instead (#holdVolleyballClear).
function settingUpNext(game, reading) {
  if (reading.period !== null && reading.period - 1 < game.period) return true;
  if (getSport(game.sport).scoreMode === 'sets') return false;
  const scores = computeScores(game);
  return (reading.home === 0 && scores.home > 0) || (reading.away === 0 && scores.away > 0);
}

function previousGameMessage(game) {
  const sets = getSport(game.sport).scoreMode === 'sets';
  const clock = !sets && game.options.clockEnabled ? ' Only the clock is read until then.' : '';
  return `The scoreboard still shows the game before: this game's ${sets ? 'points and set' : 'score and period'} are read once the console is reset for it.${clock}`;
}

// The scorekeeper's status line for a feed's state (all but 'receiving').
function feedMessage(state, address, error) {
  const { transport, host, port } = splitScoreboardAddress(address);
  if (transport === 'udp') {
    return {
      connecting: `Starting to listen for the scoreboard on UDP port ${port}…`,
      unreachable: `Can't listen for the scoreboard on UDP port ${port}: ${error ?? 'the port could not be opened'}. Retrying.`,
      waiting: `Listening on UDP port ${port}, waiting for data from the scoreboard at ${host}.`,
    }[state];
  }
  return {
    connecting: `Connecting to the scoreboard at ${address}…`,
    unreachable: `Can't reach the scoreboard at ${address}: ${error ?? 'connection failed'}. Retrying.`,
    waiting: `Connected to ${address}, waiting for data from the scoreboard console.`,
  }[state];
}

function describeError(err) {
  switch (err?.code) {
    case 'ECONNREFUSED':
      return "connection refused: the box isn't accepting connections on this port. It may use another port, send over UDP instead, or already be connected to another system (it accepts one connection at a time)";
    case 'EADDRINUSE':
      return 'another program on this server is using that UDP port';
    case 'EACCES':
      return "the server isn't allowed to use that port";
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return 'no answer (wrong IP address, the box is off, or the network blocks it)';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'no route to that address from the server';
    case 'ECONNRESET':
      return 'the box closed the connection';
    default:
      return err?.message ?? 'connection failed';
  }
}

// One open (or retrying) connection to a scoreboard box; over UDP, the
// datagrams from it on a port the server listens on.
class Feed {
  constructor(service, address) {
    this.service = service;
    this.address = address;
    ({ transport: this.transport, host: this.host, port: this.port } = splitScoreboardAddress(address));
    this.state = 'connecting';
    this.error = null;
    this.socket = null;
    this.subscription = null;
    this.datagrams = 0;
    this.reader = new RtdReader();
    this.attempt = 0;
    this.retryTimer = null;
    this.applyTimer = null;
    this.firstPendingAt = null;
    this.lastDataAt = null;
    this.lastReadingAt = null;
    this.connectedAt = null;
    this.gameId = null;
    this.closed = false;
    this.volleyballReset = null;
    this.consoleReset = null;
    // While the game is over on the scoreboard and about to end: { key, since }.
    this.finalHorn = null;
    this.timers = new Map(); // hold -> timer that reads the scoreboard again when it is over
    // For the game at its start: what the console may still show from the
    // game before (ScoreboardService #holdPreviousGame), worked out once.
    this.startCheck = null;
    this.previousGame = false; // the last reading still showed the game before
    // Watching with the console off: the connection is being renewed, which
    // is no failure.
    this.renewing = false;
  }

  // `quiet`: renewing a watching feed's connection, shown as no change.
  open({ quiet = false } = {}) {
    if (this.closed || this.socket || this.subscription) return;
    if (this.transport === 'udp') {
      this.listen();
      return;
    }
    const timing = this.service.timing;
    const socket = this.service.connect({ host: this.host, port: this.port });
    this.socket = socket;
    if (!quiet) this.setState('connecting');
    socket.setTimeout(timing.connectTimeoutMs);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.setKeepAlive(true, 15_000);
      this.connectedAt = this.service.now();
      this.lastDataAt = null;
      this.error = null;
      this.setState('waiting');
      this.service.log?.[quiet ? 'debug' : 'info']('scoreboard connected', { address: this.address });
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('timeout', () => {
      const err = new Error('timed out');
      err.code = 'ETIMEDOUT';
      socket.destroy(err);
    });
    socket.on('error', (err) => {
      this.error = describeError(err);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connectedAt = null;
      if (this.closed) return;
      if (this.renewing) {
        // Like every reconnect, from an empty block.
        this.renewing = false;
        this.reader = new RtdReader();
        this.open({ quiet: true });
        return;
      }
      this.service.log?.warn('scoreboard connection lost', { address: this.address, error: this.error });
      this.error ??= 'the connection closed';
      this.setState('unreachable');
      this.scheduleRetry();
    });
  }

  // UDP: listens on the port (one socket for every feed and test on it) for
  // this box's datagrams. They don't line up with frames; the reader copes.
  listen() {
    const subscription = this.service.udp.subscribe(this.port, this.host, {
      listening: () => {
        this.connectedAt = this.service.now();
        this.lastDataAt = null;
        this.error = null;
        this.setState('waiting');
        this.service.log?.info('scoreboard listening', { address: this.address });
      },
      message: (chunk) => {
        this.datagrams += 1;
        this.onData(chunk);
      },
      error: (err) => {
        if (this.subscription !== subscription) return;
        this.subscription = null;
        this.connectedAt = null;
        this.error = describeError(err);
        if (this.closed) return;
        this.service.log?.warn("scoreboard can't listen", { address: this.address, error: this.error });
        this.setState('unreachable');
        this.scheduleRetry();
      },
    });
    this.subscription = subscription;
    this.setState('connecting');
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    const delays = this.service.timing.retryDelaysMs;
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // Every reconnect starts from an empty block: the console doesn't resend.
      // (A UDP feed only retries binding its port, and keeps what it read.)
      if (this.transport === 'tcp') this.reader = new RtdReader();
      this.open();
    }, delay);
    this.retryTimer.unref?.();
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.applyTimer);
    this.retryTimer = null;
    this.applyTimer = null;
    this.clearTimers();
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.destroy();
    }
    if (this.subscription) {
      const subscription = this.subscription;
      this.subscription = null;
      subscription.close();
    }
  }

  // A new game takes over this scoreboard (or the feed only watches for a
  // scheduled game to start: gameId null). A newer game taking over from a
  // live one starts from an empty block: what the console sent for that game
  // must not land in this one. A watch keeps what the console showed for the
  // game that just ended, and the game that starts from it what the console
  // shows now: what of it still shows the game before is held back
  // (ScoreboardService #holdPreviousGame).
  assign(gameId) {
    if (this.gameId === gameId) return;
    const takeover = this.gameId !== null && gameId !== null;
    this.gameId = gameId;
    if (takeover) {
      this.reader = new RtdReader();
      this.datagrams = 0;
    }
    this.volleyballReset = null;
    this.consoleReset = null;
    this.finalHorn = null;
    this.startCheck = null;
    this.previousGame = false;
    this.clearTimers();
    // The scorekeeper chose the scoreboard again after a reset was detected:
    // what it shows is what they want.
    this.resetOverridden = gameId !== null && this.service.resetOverridden(gameId);
  }

  // Reads the scoreboard again when a hold is over, even if the console stays
  // quiet. One timer per hold; a new one replaces it.
  recheckAfter(hold, ms) {
    clearTimeout(this.timers.get(hold));
    const timer = setTimeout(() => {
      this.timers.delete(hold);
      if (!this.closed && this.gameId !== null) this.service.applyReading(this);
    }, ms);
    timer.unref?.();
    this.timers.set(hold, timer);
  }

  clearTimer(hold) {
    clearTimeout(this.timers.get(hold));
    this.timers.delete(hold);
  }

  clearTimers() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  onData(chunk) {
    const applied = this.reader.push(chunk);
    if (applied === 0) return;
    // Only a box that sends real frames resets the backoff: one that accepts
    // and then drops the connection keeps backing off.
    this.attempt = 0;
    const now = this.service.now();
    this.lastDataAt = now;
    if (this.state !== 'receiving') this.setState('receiving');
    this.firstPendingAt ??= now;
    clearTimeout(this.applyTimer);
    const timing = this.service.timing;
    const wait = Math.max(0, Math.min(timing.applyDebounceMs, this.firstPendingAt + timing.applyMaxWaitMs - now));
    this.applyTimer = setTimeout(() => this.apply(), wait);
    this.applyTimer.unref?.();
  }

  apply() {
    this.applyTimer = null;
    this.firstPendingAt = null;
    if (this.closed) return;
    // Watching for a scheduled game: the console sending data starts it.
    if (this.gameId === null) this.service.autoStart(this.address);
    if (this.closed || this.gameId === null) return;
    this.lastReadingAt = this.service.now();
    this.service.applyReading(this);
  }

  // Status changes reach the game pages over SSE; the readings themselves
  // arrive as ordinary game changes.
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.service.feedChanged(this);
  }

  tick(now) {
    const timing = this.service.timing;
    // A final-horn hold that is over ends the game even if the console went
    // quiet after the horn.
    if (this.finalHorn !== null && this.gameId !== null && now - this.finalHorn.since >= timing.finalHornHoldMs) {
      this.service.applyReading(this);
    }
    if (this.closed || this.connectedAt === null) return;
    const since = this.lastDataAt ?? this.connectedAt;
    if (this.state === 'receiving' && now - since > timing.quietAfterMs) this.setState('waiting');
    // A box sending over UDP has no connection to renew: it sends when the
    // console does. Watching for a game to start, a quiet console is just
    // off: the connection is renewed (a box that rebooted would never be heard
    // again otherwise) without calling that a failure or backing off.
    if (this.socket && now - since > timing.reconnectAfterQuietMs) {
      if (this.gameId === null) {
        this.renewing = true;
        this.service.log?.debug('scoreboard quiet while watching; renewing the connection', { address: this.address });
      } else {
        this.service.log?.warn('scoreboard silent; reconnecting', { address: this.address });
        this.error = 'no data from the scoreboard for a while';
      }
      this.socket.destroy();
    }
  }
}

export class ScoreboardService {
  #db;
  #games;
  #config;
  #feeds = new Map(); // address -> Feed
  #assigned = new Map(); // address -> id of the live game the scoreboard drives
  #standby = new Map(); // id of a game waiting behind a newer one -> that game's id
  #held = new Map(); // address -> id of the live game holding the scoreboard (driven, or scored by hand by a person)
  #due = new Map(); // address -> ids of the scheduled games due to start by themselves on it, the one to start first first
  #watched = new Map(); // the part of #due on scoreboards no live game holds: their feeds are open, watching
  #tests = new Map(); // address -> in-flight test promise
  #testsRunning = new Set(); // finish() of each in-flight test
  #onStatus;
  #ticker = null;
  #refreshTimer = null;
  #stopped = false;
  #refreshing = false;
  #refreshAgain = false;
  #timeFormat = null;

  constructor({
    db,
    games,
    config,
    log,
    now = Date.now,
    connect = (options) => net.connect(options),
    createUdpSocket = () => dgram.createSocket({ type: 'udp4' }),
    timing = {},
    onStatus = null,
  }) {
    this.#db = db;
    this.#games = games;
    this.#config = config;
    this.log = log;
    this.now = now;
    this.connect = connect;
    this.udp = new UdpListeners({ createSocket: createUdpSocket });
    this.timing = { ...TIMING, ...timing };
    this.#onStatus = onStatus;
  }

  setStatusListener(listener) {
    this.#onStatus = listener;
  }

  start() {
    this.#stopped = false;
    this.refresh();
    this.#ticker = setInterval(() => {
      const now = this.now();
      for (const feed of [...this.#feeds.values()]) feed.tick(now);
      // Also opens the feeds of games whose time has come, and closes those
      // whose window has passed.
      this.refresh();
      for (const address of [...this.#watched.keys()]) this.autoStart(address);
    }, this.timing.tickMs);
    this.#ticker.unref?.();
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#ticker);
    clearTimeout(this.#refreshTimer);
    this.#ticker = null;
    for (const feed of this.#feeds.values()) feed.close();
    this.#feeds.clear();
    this.#assigned.clear();
    this.#standby.clear();
    this.#held.clear();
    this.#due.clear();
    this.#watched.clear();
    // Tests in flight end with what they have; no socket outlives the service.
    for (const finish of [...this.#testsRunning]) finish();
    this.udp.closeAll();
  }

  // ---- settings ----

  defaultAddress() {
    return this.#db.get('SELECT value FROM settings WHERE key = ?', DEFAULT_ADDRESS_KEY)?.value ?? null;
  }

  setDefaultAddress(value) {
    const address = value === null || (typeof value === 'string' && value.trim() === '') ? null : parseScoreboardAddress(value, 'defaultAddress');
    const previous = this.defaultAddress();
    if (address === null) this.#db.run('DELETE FROM settings WHERE key = ?', DEFAULT_ADDRESS_KEY);
    else {
      this.#db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        DEFAULT_ADDRESS_KEY, address, this.now(),
      );
    }
    this.log?.info('scoreboard default address set', { address });
    const published = this.refresh();
    // Every game on the default shows the address (and a state that depends on it).
    if (address !== previous) {
      const ids = this.#db.all("SELECT id FROM games WHERE scoreboard = 'default' AND status IN ('scheduled', 'live')");
      for (const { id } of ids) if (!published.has(id)) this.statusChanged(id);
    }
    return address;
  }

  // ---- which game the scoreboard drives ----

  eligible(game) {
    return scoreboardEligible(game, this.#config.homeTeam);
  }

  addressFor(game) {
    if (game.scoreboard === 'off') return null;
    if (game.scoreboard === 'default') return this.defaultAddress();
    return game.scoreboard;
  }

  // True while the scoreboard - not the scorekeeper - sets this game's score,
  // clock and period. The scorekeeper can switch the game to manual scoring.
  controls(game) {
    if (game.status !== 'live' || game.scoreboardManual || !this.eligible(game)) return false;
    const address = this.addressFor(game);
    return address !== null && this.#assigned.get(address) === game.id;
  }

  // Recomputes which live game each scoreboard drives, and which scoreboards
  // are watched for a scheduled game to start, and opens or closes the
  // connections to match. Of several live games on one scoreboard the one
  // started last wins (an earlier game someone forgot to end must not take the
  // new game's scores); if that game is scored by hand, nobody gets the feed.
  // A game that loses its scoreboard to a newer one is switched to scoring by
  // hand for good: it must not get the scoreboard back - and the newer game's
  // scores with it - when the newer game ends. Returns the ids whose status
  // was published (all but `quiet`, which the caller publishes itself).
  refresh({ quiet = null } = {}) {
    const published = new Set();
    if (this.#stopped) return published;
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return published;
    }
    this.#refreshing = true;
    try {
      do {
        this.#refreshAgain = false;
        for (const id of this.#reassign()) {
          if (id === quiet || published.has(id)) continue;
          published.add(id);
          this.statusChanged(id);
        }
      } while (this.#refreshAgain);
    } finally {
      this.#refreshing = false;
    }
    return published;
  }

  // One pass of refresh(): returns the ids whose feed status changed.
  #reassign() {
    const winners = new Map();
    const candidates = this.#games.liveGames().filter((game) => this.eligible(game));
    for (const game of candidates) {
      const address = this.addressFor(game);
      if (address === null) continue;
      const best = winners.get(address);
      if (!best || startedLater(game, best)) winners.set(address, game);
    }
    const assigned = new Map();
    const standby = new Map();
    for (const game of candidates) {
      const address = this.addressFor(game);
      if (address === null) continue;
      const winner = winners.get(address);
      if (winner.id !== game.id) standby.set(game.id, winner.id);
      else if (!game.scoreboardManual) assigned.set(address, game.id);
    }

    // Displaced games are scored by hand from now on (this re-enters refresh,
    // which runs again once this pass is done).
    for (const gameId of standby.keys()) {
      const game = candidates.find((candidate) => candidate.id === gameId);
      if (game && !game.scoreboardManual) this.#games.releaseScoreboard(gameId, 'a newer game took the scoreboard');
    }

    // Scheduled games due to start by themselves: their scoreboard is
    // watched while no live game holds it.
    const held = this.#holders(candidates);
    const due = new Map([...this.#dueGames(this.now())].map(([address, games]) => [address, games.map((game) => game.id)]));
    const watched = new Map([...due].filter(([address]) => !held.has(address)));

    const touched = new Set();
    for (const [address, gameId] of this.#assigned) if (assigned.get(address) !== gameId) touched.add(gameId);
    for (const [address, gameId] of assigned) if (this.#assigned.get(address) !== gameId) touched.add(gameId);
    for (const [gameId, winnerId] of standby) if (this.#standby.get(gameId) !== winnerId) touched.add(gameId);
    for (const gameId of this.#standby.keys()) if (!standby.has(gameId)) touched.add(gameId);
    // A due game's message names the live game holding its scoreboard and the
    // game that starts first there: republish it when either changes.
    const dueStates = (dues, holders) => {
      const states = new Map();
      for (const [address, ids] of dues) for (const id of ids) states.set(id, `${holders.get(address) ?? ''}:${ids[0]}`);
      return states;
    };
    const dueBefore = dueStates(this.#due, this.#held);
    const dueAfter = dueStates(due, held);
    for (const [id, state] of dueBefore) if (dueAfter.get(id) !== state) touched.add(id);
    for (const id of dueAfter.keys()) if (!dueBefore.has(id)) touched.add(id);
    this.#assigned = assigned;
    this.#standby = standby;
    this.#held = held;
    this.#due = due;
    this.#watched = watched;

    for (const [address, feed] of this.#feeds) {
      if (!assigned.has(address) && !watched.has(address)) {
        feed.close();
        this.#feeds.delete(address);
        this.log?.info('scoreboard disconnected', { address });
      }
    }
    for (const address of new Set([...assigned.keys(), ...watched.keys()])) {
      const gameId = assigned.get(address) ?? null;
      let feed = this.#feeds.get(address);
      if (!feed) {
        feed = new Feed(this, address);
        this.#feeds.set(address, feed);
        if (gameId === null) this.log?.info('scoreboard watched for a game due to start', { address, gameId: watched.get(address)[0] });
        feed.assign(gameId);
        feed.open();
      } else {
        feed.assign(gameId);
      }
    }
    return touched;
  }

  // The live game holding each scoreboard (the newest): one it drives, or one
  // a person scores by hand - the gym is in use either way; so does a game
  // whose scoreboard was set to Off after the scoreboard read it (it holds the
  // default one). A game the feed itself handed over to scoring by hand (the
  // console was reset for another game, or a newer game took the scoreboard)
  // holds nothing. `live`: the eligible live games.
  #holders(live) {
    const held = new Map();
    for (const game of live) {
      const address = game.scoreboard === 'off' ? (this.#games.readByScoreboard(game.id) ? this.defaultAddress() : null) : this.addressFor(game);
      if (address === null) continue;
      if (game.scoreboardManual && !this.#games.scoreboardManualByPerson(game.id)) continue;
      const other = held.get(address);
      if (!other || startedLater(game, other)) held.set(address, game);
    }
    return new Map([...held].map(([address, game]) => [address, game.id]));
  }

  // Scheduled games due to start by themselves (§11), by scoreboard, the one
  // to start first first (latest scheduled time; tie: lower id): eligible, on
  // a scoreboard, not scored by hand, from their time until
  // AUTO_START_WINDOW_MS after it. A game is passed over for good once a game
  // scheduled no earlier on the same scoreboard has started since its time
  // came (it must not start after that game ends).
  #dueGames(now) {
    const from = now - AUTO_START_WINDOW_MS;
    const started = this.#games.startedScheduledAfter(from).filter((game) => this.eligible(game));
    const due = new Map();
    for (const game of this.#games.scheduledBetween(from, now)) {
      if (!this.eligible(game) || game.scoreboardManual) continue;
      const address = this.addressFor(game);
      if (address === null) continue;
      if (started.some((other) => passesOver(other, game) && this.addressFor(other) === address)) continue;
      if (!due.has(address)) due.set(address, []);
      due.get(address).push(game);
    }
    for (const games of due.values()) games.sort((a, b) => (startsFirst(a, b) ? -1 : 1));
    return due;
  }

  // Called after every game change; coalesced.
  scheduleRefresh() {
    if (this.#stopped || this.#refreshTimer) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      this.refresh();
    }, 50);
    this.#refreshTimer.unref?.();
  }

  // A feed's status changed: the game it drives shows it, or the games it
  // watches for.
  feedChanged(feed) {
    if (feed.gameId !== null) this.statusChanged(feed.gameId);
    else for (const id of this.#watched.get(feed.address) ?? []) this.statusChanged(id);
  }

  statusChanged(gameId) {
    if (gameId === null || gameId === undefined) return;
    try {
      this.#onStatus?.(gameId);
    } catch (err) {
      this.log?.error('scoreboard status listener failed', { err });
    }
  }

  // ---- starting by itself ----

  // Starts the game due on this scoreboard once the console sends data
  // (§11): on the tick, and whenever frames reach a feed watching for a game.
  // The start goes through GameService like a scorekeeper's, so the
  // push-to-start fan-out, SSE and broadcast channels follow as usual.
  // Returns the game started, or null.
  autoStart(address) {
    if (this.#stopped) return null;
    const feed = this.#feeds.get(address);
    const [gameId] = this.#watched.get(address) ?? [];
    if (!feed || feed.gameId !== null || gameId === undefined || !this.#sending(feed)) return null;
    try {
      return this.#games.autoStart(gameId, 'scoreboard', (game) => this.#mayStart(game, address))?.game ?? null;
    } catch (err) {
      this.log?.error('scoreboard could not start a game', { gameId, address, err });
      return null;
    }
  }

  // Inside the start's transaction, with what the database says now: the
  // game is still the one to start on that scoreboard, no live game holds
  // it, and it still sends data.
  #mayStart(game, address) {
    const feed = this.#feeds.get(address);
    if (!feed || feed.closed || feed.gameId !== null || !this.#sending(feed)) return false;
    if (this.#holders(this.#games.liveGames().filter((other) => this.eligible(other))).has(address)) return false;
    return this.#dueGames(this.now()).get(address)?.[0]?.id === game.id;
  }

  // The scoreboard is on: a data frame arrived just now.
  #sending(feed) {
    return feed.lastDataAt !== null && this.now() - feed.lastDataAt <= this.timing.autoStartDataMs;
  }

  // ---- readings ----

  resetOverridden(gameId) {
    return this.#games.scoreboardResetOverridden(gameId);
  }

  applyReading(feed) {
    const game = this.#games.getGame(feed.gameId);
    if (!game || !this.controls(game)) return;
    const reading = feed.reader.reading(game.sport);
    if (this.#holdConsoleReset(feed, game, reading)) return;
    this.#holdPreviousGame(feed, game, reading);
    if (game.sport === 'volleyball') this.#holdVolleyballClear(feed, game, reading);
    let current = game;
    try {
      current = this.#games.applyScoreboard(game.id, reading) ?? game;
    } catch (err) {
      this.log?.warn('scoreboard reading not applied', { gameId: game.id, err: err.message });
    }
    this.#watchFinalHorn(feed, current);
  }

  // The final horn (§11): once the game is over on the scoreboard it ends by
  // itself finalHornHoldMs later. A score change starts the hold again; the
  // game going on (the clock set again, another period, a tie) cancels it.
  #watchFinalHorn(feed, game) {
    if (feed.closed || feed.gameId !== game.id) return;
    const key = this.#overKey(feed, game);
    if (key === null) {
      if (feed.finalHorn === null) return;
      feed.finalHorn = null;
      feed.clearTimer('finalHorn');
      this.log?.info('final horn: the game goes on', { gameId: game.id });
      this.statusChanged(game.id);
      return;
    }
    const now = this.now();
    if (feed.finalHorn?.key !== key) {
      this.log?.info(feed.finalHorn ? 'final horn: the score changed, holding again' : 'final horn: the game ends unless it goes on', { gameId: game.id });
      feed.finalHorn = { key, since: now };
      feed.recheckAfter('finalHorn', this.timing.finalHornHoldMs + 100);
      this.statusChanged(game.id);
      return;
    }
    if (now - feed.finalHorn.since >= this.timing.finalHornHoldMs) this.#endAtFinalHorn(feed, game);
  }

  // What the final-horn hold watches for changes (period and line) while the
  // game is over on the scoreboard, else null. Whether the current period was
  // played comes from the event log; a running hold already knows.
  #overKey(feed, game) {
    const key = JSON.stringify([game.period, game.line]);
    const played = () => feed.finalHorn?.key === key || this.#games.playedInPeriod(game.id, { clock: getSport(game.sport).scoreMode === 'points' });
    return overOnScoreboard(game, played) ? key : null;
  }

  // Ends the game with the score it has: no user, re-checked inside the
  // transaction (still driven by this scoreboard, still over).
  #endAtFinalHorn(feed, game) {
    feed.finalHorn = null;
    feed.clearTimer('finalHorn');
    try {
      this.#games.end(game.id, null, { auto: true, reason: FINAL_HORN_REASON, check: (current) => this.controls(current) && overOnScoreboard(current) });
    } catch (err) {
      this.log?.warn('game not ended at the final horn', { gameId: game.id, err: err.message });
    }
  }

  // The console back at period (or game) 1 with lower scores while this game
  // is further on: the operator set it up for the next game before this one
  // was ended. Nothing of it is applied; if it stays that way the game is
  // handed over to scoring by hand, keeping its score for the scorekeeper to
  // end. While the game is about to end at the final horn, the console being
  // set up for the next game in any order ends it at once, with the score it
  // had then, and never hands it over. Returns true while the reading is held
  // back.
  #holdConsoleReset(feed, game, reading) {
    if (feed.finalHorn !== null && settingUpNext(game, reading)) {
      this.log?.info('scoreboard reset for another game after the final horn; ending the game', { gameId: game.id });
      this.#endAtFinalHorn(feed, game);
      return true;
    }
    let reset = false;
    if (reading.period === 1 && game.period > 0 && !feed.resetOverridden) {
      if (getSport(game.sport).scoreMode === 'sets') reset = reading.home === 0 && reading.away === 0;
      else {
        const scores = computeScores(game);
        const home = reading.home ?? scores.home;
        const away = reading.away ?? scores.away;
        reset = home <= scores.home && away <= scores.away && home + away < scores.home + scores.away;
      }
    }
    if (!reset) {
      feed.consoleReset = null;
      return false;
    }
    const now = this.now();
    if (feed.consoleReset === null) {
      feed.consoleReset = now;
      this.log?.info('scoreboard looks reset for another game; holding', { gameId: game.id });
      feed.recheckAfter('consoleReset', this.timing.consoleResetHoldMs + 100);
    } else if (now - feed.consoleReset >= this.timing.consoleResetHoldMs) {
      this.#games.releaseScoreboard(game.id, CONSOLE_RESET_REASON);
    }
    return true;
  }

  // Right after the start the console may still show the game before (§11):
  // its final, not reset yet - a 6:30 game starts by itself while the 5:00
  // game's final is still up. While this game is at its start (first period,
  // no points), a reading that shows the game before lends this game only its
  // clock; the score and period follow once the console shows this game (it
  // was reset, or play began). Once it has shown 0-0 in the first period the
  // check is done. A scorekeeper who chose Use the scoreboard turned it off:
  // what it shows is what they want.
  #holdPreviousGame(feed, game, reading) {
    const atStart = game.period === 0 && game.line.every((entry) => entry.home === 0 && entry.away === 0);
    let held = false;
    if (atStart && !feed.startCheck?.done) {
      feed.startCheck ??= this.#startCheck(game, feed.address);
      held = !feed.startCheck.chosen && showsPreviousGame(feed.startCheck, reading);
      if (!held && reading.home === 0 && reading.away === 0 && (reading.period ?? 1) === 1) feed.startCheck.done = true;
    }
    if (held) {
      reading.period = null;
      reading.home = null;
      reading.away = null;
    }
    if (held === feed.previousGame) return;
    feed.previousGame = held;
    if (held) this.log?.info('scoreboard still shows the game before; reading only its clock', { gameId: game.id });
    this.statusChanged(game.id);
  }

  // What #holdPreviousGame goes by: whether the scoreboard started the game
  // (nobody saw the console then), whether a person chose the scoreboard for
  // it, and the game before on this scoreboard's last period and score, if
  // there is one: the latest game of the sport that ended there before this
  // one started and got past its first period (one ended or canceled in its
  // first period, e.g. started by mistake, is no final the console still shows).
  #startCheck(game, address) {
    const before = this.#games
      .endedBefore(game.sport, game.startedAt ?? this.now())
      .find((other) => other.id !== game.id && other.period > 0 && this.eligible(other) && this.addressFor(other) === address);
    let previous = null;
    if (before) {
      // Volleyball: the points of the game (set) the console was on.
      const scores = getSport(before.sport).scoreMode === 'sets' ? (before.line[before.period] ?? { home: 0, away: 0 }) : computeScores(before);
      previous = { period: before.period + 1, home: scores.home, away: scores.away };
    }
    return { auto: this.#games.startedByScoreboard(game.id), chosen: this.#games.scoreboardChosenByPerson(game.id), previous, done: false };
  }

  // Volleyball: points cleared to 0-0 in the same game are held, so the set
  // keeps its score when the operator clears the board before moving on. The
  // console's own record of that game wins over 0-0, and neither the match's
  // last set (the game number can't move on past it) nor the set that won the
  // match (about to end at the final horn) is ever cleared.
  #holdVolleyballClear(feed, game, reading) {
    const current = game.line[game.period] ?? { home: 0, away: 0 };
    const sameGame = reading.period === null || reading.period - 1 === game.period;
    const clearing = sameGame && reading.home === 0 && reading.away === 0 && (current.home > 0 || current.away > 0);
    if (!clearing) {
      feed.volleyballReset = null;
      return;
    }
    const recorded = reading.games?.[game.period];
    if (recorded && (recorded.home > 0 || recorded.away > 0)) {
      reading.home = recorded.home;
      reading.away = recorded.away;
      return;
    }
    const now = this.now();
    if (feed.volleyballReset === null) {
      feed.volleyballReset = now;
      // Check again when the hold ends, even if the console stays quiet.
      feed.recheckAfter('volleyballClear', this.timing.volleyballResetHoldMs + 100);
    }
    if (game.period >= lastPeriodIndex(game) || feed.finalHorn !== null || now - feed.volleyballReset < this.timing.volleyballResetHoldMs) {
      reading.home = null;
      reading.away = null;
    }
  }

  // ---- status for the portal and the app ----

  view(game) {
    const setting = game.scoreboard === 'default' || game.scoreboard === 'off' ? game.scoreboard : 'custom';
    const address = this.addressFor(game);
    const eligible = this.eligible(game);
    const view = {
      setting,
      custom: setting === 'custom' ? game.scoreboard : null,
      address,
      eligible,
      manual: game.scoreboardManual,
      controlling: this.controls(game),
      state: 'idle',
      message: '',
      lastReadingAt: null,
    };
    const feed = address === null ? null : this.#feeds.get(address);
    if (!eligible) {
      view.state = 'unavailable';
      view.message = `Only basketball and volleyball games with ${this.#config.homeTeam.name} as the home team can use the scoreboard.`;
    } else if (setting === 'off') {
      view.state = 'off';
      view.message = 'The scoreboard feed is off for this game.';
    } else if (address === null) {
      view.state = 'no-address';
      view.message = 'No scoreboard address is set. An admin can set the default one under System.';
    } else if (game.status === 'scheduled' && game.scoreboardManual) {
      view.state = 'manual';
      view.message = "This game will be scored by hand. The scoreboard isn't read.";
    } else if (game.status === 'scheduled') {
      // Every game that hasn't started is 'idle' (the clients rely on it);
      // the message says when and how it starts.
      view.state = 'idle';
      view.message = this.#startMessage(game, address);
    } else if (game.status !== 'live') {
      view.state = 'idle';
    } else if (this.#standby.has(game.id)) {
      const other = this.#games.getGame(this.#standby.get(game.id));
      view.state = 'standby';
      view.message = `The scoreboard is driving ${other ? describeGame(other) : 'another game'}, which started later.`;
    } else if (game.scoreboardManual) {
      view.state = 'manual';
      view.message = 'Scored by hand. The scoreboard feed is paused for this game.';
    } else if (!feed) {
      view.state = 'connecting';
      view.message = feedMessage('connecting', address, null);
    } else {
      view.state = feed.state;
      view.lastReadingAt = feed.lastReadingAt;
      if (feed.gameId === game.id && feed.finalHorn !== null) view.message = this.#finalHornMessage(game, feed);
      else if (feed.state !== 'receiving') view.message = feedMessage(feed.state, address, feed.error);
      else if (feed.gameId === game.id && feed.previousGame) view.message = previousGameMessage(game);
      else view.message = `${fieldsRead(game)} come from the scoreboard.`;
    }
    return view;
  }

  // A scheduled game on a scoreboard: when it starts by itself, or why not.
  #startMessage(game, address) {
    const now = this.now();
    const byHand = 'Start it by hand if it is played, or cancel it.';
    if (now < game.scheduledAt) return `Starts automatically at ${this.#time(game.scheduledAt)} once the scoreboard at ${address} is on.`;
    if (now >= game.scheduledAt + AUTO_START_WINDOW_MS) {
      return `Won't start by itself any more: its time was more than ${AUTO_START_WINDOW_MS / 3_600_000} hours ago. ${byHand}`;
    }
    const due = this.#due.get(address) ?? [];
    if (!due.includes(game.id)) {
      const other = this.#games
        .startedScheduledAfter(now - AUTO_START_WINDOW_MS)
        .find((started) => this.eligible(started) && passesOver(started, game) && this.addressFor(started) === address);
      if (other) return `Won't start by itself: ${describeGame(other)} started on this scoreboard after this game's time. ${byHand}`;
      // Its time has only just come: the scoreboard is watched from the next refresh.
      return `Starts automatically once the scoreboard is on. ${feedMessage('connecting', address, null)}`;
    }
    const holder = this.#held.get(address);
    if (holder !== undefined) {
      const other = this.#games.getGame(holder);
      return `Starts automatically once ${other ? describeGame(other) : 'the live game on this scoreboard'} has ended: that game is still live on this scoreboard.`;
    }
    const [first] = due;
    if (first !== game.id) {
      const other = this.#games.getGame(first);
      return `Not started automatically: ${other ? describeGame(other) : 'a game'}, scheduled later on this scoreboard, starts instead.`;
    }
    const feed = this.#feeds.get(address);
    if (feed && feed.gameId === null && this.#sending(feed)) return 'The scoreboard is on: starting…';
    const state = !feed || feed.gameId !== null ? 'connecting' : feed.state === 'receiving' ? 'waiting' : feed.state;
    return `Starts automatically once the scoreboard is on. ${feedMessage(state, address, feed?.error ?? null)}`;
  }

  // Says when the game ends, not how long until then: an open page isn't
  // sent the message again as time passes (only when the hold starts over).
  #finalHornMessage(game, feed) {
    const minutes = Math.round(this.timing.finalHornHoldMs / 60_000);
    const after = `${minutes} minute${minutes === 1 ? '' : 's'}`;
    // The end, rounded up to the minute: "by 7:43 PM".
    const by = this.#time(Math.ceil((feed.finalHorn.since + this.timing.finalHornHoldMs) / 60_000) * 60_000);
    if (getSport(game.sport).scoreMode === 'sets') return `Match won: the game ends by itself by ${by}, ${after} after the last point.`;
    return `Final horn: the game ends by itself by ${by}, ${after} after the last score change. Time put back on the clock keeps it going.`;
  }

  // "5:00 PM" in the school's time zone.
  #time(ms) {
    this.#timeFormat ??= new Intl.DateTimeFormat('en-US', { timeZone: this.#config.timeZone, hour: 'numeric', minute: '2-digit' });
    return this.#timeFormat.format(ms).replace(/\s/g, ' ');
  }

  // The open feeds: one per scoreboard a live game reads, and one per
  // scoreboard watched for a scheduled game to start (`watching`, `gameId`
  // = that game).
  status() {
    const entry = (address, gameId, watching) => {
      const feed = this.#feeds.get(address);
      return {
        address,
        gameId,
        watching,
        state: feed?.state ?? 'connecting',
        error: feed?.state === 'unreachable' ? feed.error : null,
        lastReadingAt: feed?.lastReadingAt ?? null,
      };
    };
    const feeds = [...this.#assigned].map(([address, gameId]) => entry(address, gameId, false));
    for (const [address, [gameId]] of this.#watched) if (!this.#assigned.has(address)) feeds.push(entry(address, gameId, true));
    return feeds;
  }

  // ---- "Test connection" ----

  // Listens to a scoreboard for a few seconds and reports what it sends. Uses
  // the feed's connection when a game is already reading this scoreboard, or
  // it is watched for a game to start (the box accepts one connection at a
  // time). Over UDP the test shares the port's socket with any feed on it, so
  // it never disturbs one.
  test(value) {
    const address = parseScoreboardAddress(value);
    const feed = this.#feeds.get(address);
    if (feed) {
      // A feed watching for a scheduled game: gameId is that game.
      const watching = feed.gameId === null;
      const gameId = watching ? (this.#watched.get(address)?.[0] ?? null) : feed.gameId;
      const game = this.#games.getGame(gameId);
      const result = {
        address,
        transport: feed.transport,
        inUse: true,
        gameId,
        watching,
        connected: feed.connectedAt !== null,
        receiving: feed.state === 'receiving',
        error: feed.state === 'unreachable' ? feed.error : null,
        bytes: feed.reader.bytes,
        frames: feed.reader.dataFrames,
        badFrames: feed.reader.badFrames,
        reading: feed.reader.reading(game?.sport ?? 'basketball'),
        listenedMs: feed.connectedAt === null ? 0 : Math.max(0, this.now() - feed.connectedAt),
      };
      if (feed.transport === 'udp') Object.assign(result, { datagrams: feed.datagrams, otherSources: [], firewallHint: firewallHint(feed.host, feed.port) });
      else result.closedByBox = false;
      return Promise.resolve(result);
    }
    let pending = this.#tests.get(address);
    if (!pending) {
      pending = (address.startsWith('udp://') ? this.#listenUdp(address) : this.#listen(address)).finally(() => this.#tests.delete(address));
      this.#tests.set(address, pending);
    }
    return pending;
  }

  #listen(address) {
    const { host, port } = splitScoreboardAddress(address);
    const reader = new RtdReader();
    return new Promise((resolve) => {
      const result = { ...emptyResult(address, 'tcp'), closedByBox: false };
      let settle = null;
      let listenTimer = null;
      let connectedAt = null;
      let done = false;
      const socket = this.connect({ host, port });
      const finish = () => {
        if (done) return;
        done = true;
        this.#testsRunning.delete(finish);
        clearTimeout(overall);
        clearTimeout(settle);
        clearTimeout(listenTimer);
        socket.destroy();
        if (connectedAt !== null) result.listenedMs = Math.max(0, this.now() - connectedAt);
        resolve(readResult(result, reader));
      };
      this.#testsRunning.add(finish);
      const overall = setTimeout(finish, this.timing.connectTimeoutMs + this.timing.testListenMs);
      socket.setTimeout(this.timing.connectTimeoutMs);
      socket.once('connect', () => {
        result.connected = true;
        connectedAt = this.now();
        socket.setTimeout(0);
        clearTimeout(overall);
        listenTimer = setTimeout(finish, this.timing.testListenMs);
        listenTimer.unref?.();
      });
      socket.on('data', (chunk) => {
        if (reader.push(chunk) > 0 && !settle) settle = setTimeout(finish, this.timing.testSettleMs);
      });
      socket.on('timeout', () => {
        result.error = describeError({ code: 'ETIMEDOUT' });
        finish();
      });
      socket.on('error', (err) => {
        result.error = describeError(err);
        if (result.connected && err.code === 'ECONNRESET') result.closedByBox = true;
        finish();
      });
      // Closed before the test was done: the box ended the connection.
      socket.on('close', () => {
        if (!done && result.connected && result.error === null) {
          result.closedByBox = true;
          result.error = describeError({ code: 'ECONNRESET' });
        }
        finish();
      });
    });
  }

  // UDP: listens on the port for the box's datagrams and counts the ones from
  // anyone else (another box, or this one under another IP address).
  #listenUdp(address) {
    const { host, port } = splitScoreboardAddress(address);
    const reader = new RtdReader();
    const others = new Map(); // source IP -> datagrams
    return new Promise((resolve) => {
      const result = { ...emptyResult(address, 'udp'), datagrams: 0, otherSources: [], firewallHint: firewallHint(host, port) };
      let settle = null;
      let listenTimer = null;
      let boundAt = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.#testsRunning.delete(finish);
        clearTimeout(overall);
        clearTimeout(settle);
        clearTimeout(listenTimer);
        subscription.close();
        if (boundAt !== null) result.listenedMs = Math.max(0, this.now() - boundAt);
        result.otherSources = [...others]
          .map(([source, datagrams]) => ({ address: source, datagrams }))
          .sort((a, b) => b.datagrams - a.datagrams)
          .slice(0, OTHER_SOURCES);
        resolve(readResult(result, reader));
      };
      const overall = setTimeout(finish, this.timing.connectTimeoutMs + this.timing.testListenMs);
      const subscription = this.udp.subscribe(port, host, {
        listening: () => {
          result.connected = true;
          boundAt = this.now();
          clearTimeout(overall);
          listenTimer = setTimeout(finish, this.timing.testListenMs);
          listenTimer.unref?.();
        },
        message: (chunk) => {
          result.datagrams += 1;
          if (reader.push(chunk) > 0 && !settle) settle = setTimeout(finish, this.timing.testSettleMs);
        },
        other: (source) => {
          if (others.has(source) || others.size < TRACKED_SOURCES) others.set(source, (others.get(source) ?? 0) + 1);
        },
        error: (err) => {
          result.error = describeError(err);
          finish();
        },
      });
      this.#testsRunning.add(finish);
    });
  }
}

function emptyResult(address, transport) {
  return { address, transport, inUse: false, connected: false, receiving: false, error: null, bytes: 0, frames: 0, badFrames: 0, reading: null, listenedMs: 0 };
}

// What a test's reader got, into its result.
function readResult(result, reader) {
  result.bytes = reader.bytes;
  result.frames = reader.dataFrames;
  result.badFrames = reader.badFrames;
  result.receiving = reader.dataFrames > 0;
  const code = reader.reading('basketball').sportCode;
  result.reading = reader.reading(code !== null && code >= 2000 && code < 3000 ? 'volleyball' : 'basketball');
  return result;
}
