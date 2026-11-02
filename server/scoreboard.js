// Daktronics scoreboard feeds (ARCHITECTURE.md §11). While a basketball or
// volleyball game with the school's team at home is live, the server reads the
// scoreboard's RTD stream from its Lantronix box (a TCP server, by default on
// port 10001) and keeps the game's score, clock and period in step with it.
//
// Read-only: nothing is ever written to the box - the Lantronix passes every
// byte straight into the console. The box accepts one TCP connection at a
// time, so the server connects only while a game needs the feed, shares that
// connection with "Test connection", and reconnects with backoff.

import net from 'node:net';
import { badRequest } from './errors.js';
import { CONSOLE_RESET_REASON, computeScores, lastPeriodIndex } from './games.js';
import { getSport } from './sports.js';
import { RtdReader } from './rtd.js';

export const SCOREBOARD_SPORTS = Object.freeze(['basketball', 'volleyball']);
export const DEFAULT_SCOREBOARD_PORT = 10001;
const DEFAULT_ADDRESS_KEY = 'scoreboard.defaultAddress';

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
});
// Longest valid input: a bracketed full IPv6 address with a port.
const MAX_ADDRESS_LENGTH = 64;

// "10.20.1.50", "10.20.1.50:10001", "fe80::5", "[fe80::5]:10001" ->
// "10.20.1.50:10001" / "[fe80::5]:10001". IP addresses only: the box is on the
// school network and has no DNS name.
export function parseScoreboardAddress(value, field = 'address') {
  const invalid = () => badRequest(`${field} must be an IP address such as 10.20.1.50 or 10.20.1.50:10001 (not a name).`);
  if (typeof value !== 'string' || value.trim().length > MAX_ADDRESS_LENGTH) throw invalid();
  const text = value.trim();
  let host = text;
  let port = DEFAULT_SCOREBOARD_PORT;
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
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw badRequest(`${field} has an invalid port (1-65535).`);
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
  return family === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function splitAddress(address) {
  const match = /^\[(.+)\]:(\d+)$/.exec(address) ?? /^([^:]+):(\d+)$/.exec(address);
  return { host: match[1], port: Number(match[2]) };
}

// A game's per-game setting as stored: 'default', 'off', or a normalized address.
export function parseScoreboardSetting(value) {
  if (value === null || value === 'default') return 'default';
  if (value === 'off') return 'off';
  return parseScoreboardAddress(value, 'scoreboard');
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

function describeError(err) {
  switch (err?.code) {
    case 'ECONNREFUSED':
      return 'connection refused (wrong port, or another system is already connected - the box accepts one connection at a time)';
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

// One open (or retrying) connection to a scoreboard box.
class Feed {
  constructor(service, address) {
    this.service = service;
    this.address = address;
    this.state = 'connecting';
    this.error = null;
    this.socket = null;
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
  }

  open() {
    if (this.closed || this.socket) return;
    const { host, port } = splitAddress(this.address);
    const timing = this.service.timing;
    const socket = this.service.connect({ host, port });
    this.socket = socket;
    this.setState('connecting');
    socket.setTimeout(timing.connectTimeoutMs);
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.setKeepAlive(true, 15_000);
      this.connectedAt = this.service.now();
      this.lastDataAt = null;
      this.error = null;
      this.setState('waiting');
      this.service.log?.info('scoreboard connected', { address: this.address });
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
      this.service.log?.warn('scoreboard connection lost', { address: this.address, error: this.error });
      this.error ??= 'the connection closed';
      this.setState('unreachable');
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    const delays = this.service.timing.retryDelaysMs;
    const delay = delays[Math.min(this.attempt, delays.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // Every reconnect starts from an empty block: the console doesn't resend.
      this.reader = new RtdReader();
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
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.destroy();
    }
  }

  // A new game takes over this scoreboard: what the console sent for the
  // previous one must not land in the new game.
  assign(gameId) {
    if (this.gameId === gameId) return;
    this.gameId = gameId;
    this.reader = new RtdReader();
    this.volleyballReset = null;
    this.consoleReset = null;
    // The scorekeeper chose the scoreboard again after a reset was detected:
    // what it shows is what they want.
    this.resetOverridden = this.service.resetOverridden(gameId);
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
    if (this.closed || this.gameId === null) return;
    this.lastReadingAt = this.service.now();
    this.service.applyReading(this);
  }

  // Status changes reach the game pages over SSE; the readings themselves
  // arrive as ordinary game changes.
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.service.statusChanged(this.gameId);
  }

  tick(now) {
    const timing = this.service.timing;
    if (!this.socket || this.connectedAt === null) return;
    const since = this.lastDataAt ?? this.connectedAt;
    if (this.state === 'receiving' && now - since > timing.quietAfterMs) this.setState('waiting');
    if (now - since > timing.reconnectAfterQuietMs) {
      this.service.log?.warn('scoreboard silent; reconnecting', { address: this.address });
      this.error = 'no data from the scoreboard for a while';
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
  #tests = new Map(); // address -> in-flight test promise
  #onStatus;
  #ticker = null;
  #refreshTimer = null;
  #stopped = false;
  #refreshing = false;
  #refreshAgain = false;

  constructor({ db, games, config, log, now = Date.now, connect = (options) => net.connect(options), timing = {}, onStatus = null }) {
    this.#db = db;
    this.#games = games;
    this.#config = config;
    this.log = log;
    this.now = now;
    this.connect = connect;
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
      for (const feed of this.#feeds.values()) feed.tick(now);
      this.refresh();
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

  // Recomputes which live game each scoreboard drives and opens or closes the
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
      if (!best || (game.startedAt ?? 0) > (best.startedAt ?? 0) || ((game.startedAt ?? 0) === (best.startedAt ?? 0) && game.id > best.id)) {
        winners.set(address, game);
      }
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

    const touched = new Set();
    for (const [address, gameId] of this.#assigned) if (assigned.get(address) !== gameId) touched.add(gameId);
    for (const [address, gameId] of assigned) if (this.#assigned.get(address) !== gameId) touched.add(gameId);
    for (const [gameId, winnerId] of standby) if (this.#standby.get(gameId) !== winnerId) touched.add(gameId);
    for (const gameId of this.#standby.keys()) if (!standby.has(gameId)) touched.add(gameId);
    this.#assigned = assigned;
    this.#standby = standby;

    for (const [address, feed] of this.#feeds) {
      if (!assigned.has(address)) {
        feed.close();
        this.#feeds.delete(address);
        this.log?.info('scoreboard disconnected', { address });
      }
    }
    for (const [address, gameId] of assigned) {
      let feed = this.#feeds.get(address);
      if (!feed) {
        feed = new Feed(this, address);
        this.#feeds.set(address, feed);
        feed.assign(gameId);
        feed.open();
      } else {
        feed.assign(gameId);
      }
    }
    return touched;
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

  statusChanged(gameId) {
    if (gameId === null || gameId === undefined) return;
    try {
      this.#onStatus?.(gameId);
    } catch (err) {
      this.log?.error('scoreboard status listener failed', { err });
    }
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
    if (game.sport === 'volleyball') this.#holdVolleyballClear(feed, game, reading);
    try {
      this.#games.applyScoreboard(game.id, reading);
    } catch (err) {
      this.log?.warn('scoreboard reading not applied', { gameId: game.id, err: err.message });
    }
  }

  // The console back at period (or game) 1 with lower scores while this game
  // is further on: the operator set it up for the next game before this one
  // was ended. Nothing of it is applied; if it stays that way the game is
  // handed over to scoring by hand, keeping its score for the scorekeeper to
  // end. Returns true while the reading is held back.
  #holdConsoleReset(feed, game, reading) {
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
      setTimeout(() => feed.apply(), this.timing.consoleResetHoldMs + 100).unref?.();
    } else if (now - feed.consoleReset >= this.timing.consoleResetHoldMs) {
      this.#games.releaseScoreboard(game.id, CONSOLE_RESET_REASON);
    }
    return true;
  }

  // Volleyball: points cleared to 0-0 in the same game are held, so the set
  // keeps its score when the operator clears the board before moving on. The
  // console's own record of that game wins over 0-0, and the match's last
  // set is never cleared (the game number can't move on past it).
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
      setTimeout(() => feed.apply(), this.timing.volleyballResetHoldMs + 100).unref?.();
    }
    if (game.period >= lastPeriodIndex(game) || now - feed.volleyballReset < this.timing.volleyballResetHoldMs) {
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
    } else if (game.status !== 'live') {
      view.state = 'idle';
      view.message = game.status === 'scheduled' ? `Reads the scoreboard at ${address} once the game starts.` : '';
    } else if (this.#standby.has(game.id)) {
      const other = this.#games.getGame(this.#standby.get(game.id));
      view.state = 'standby';
      view.message = `The scoreboard is driving ${other ? `${other.home.name} vs ${other.away.name}` : 'another game'}, which started later.`;
    } else if (game.scoreboardManual) {
      view.state = 'manual';
      view.message = 'Scored by hand. The scoreboard feed is paused for this game.';
    } else if (!feed) {
      view.state = 'connecting';
      view.message = `Connecting to the scoreboard at ${address}…`;
    } else {
      view.state = feed.state;
      view.lastReadingAt = feed.lastReadingAt;
      view.message = {
        connecting: `Connecting to the scoreboard at ${address}…`,
        unreachable: `Can't reach the scoreboard at ${address}: ${feed.error ?? 'connection failed'}. Retrying.`,
        waiting: `Connected to ${address}, waiting for data from the scoreboard console.`,
        receiving: `${fieldsRead(game)} come from the scoreboard.`,
      }[feed.state];
    }
    return view;
  }

  status() {
    return [...this.#assigned].map(([address, gameId]) => {
      const feed = this.#feeds.get(address);
      return {
        address,
        gameId,
        state: feed?.state ?? 'connecting',
        error: feed?.state === 'unreachable' ? feed.error : null,
        lastReadingAt: feed?.lastReadingAt ?? null,
      };
    });
  }

  // ---- "Test connection" ----

  // Listens to a scoreboard for a few seconds and reports what it sends. Uses
  // the feed's connection when a game is already reading this scoreboard (the
  // box accepts one connection at a time).
  test(value) {
    const address = parseScoreboardAddress(value);
    const feed = this.#feeds.get(address);
    if (feed) {
      const game = this.#games.getGame(feed.gameId);
      return Promise.resolve({
        address,
        inUse: true,
        gameId: feed.gameId,
        connected: feed.connectedAt !== null,
        receiving: feed.state === 'receiving',
        error: feed.state === 'unreachable' ? feed.error : null,
        bytes: feed.reader.bytes,
        frames: feed.reader.dataFrames,
        badFrames: feed.reader.badFrames,
        reading: feed.reader.reading(game?.sport ?? 'basketball'),
      });
    }
    let pending = this.#tests.get(address);
    if (!pending) {
      pending = this.#listen(address).finally(() => this.#tests.delete(address));
      this.#tests.set(address, pending);
    }
    return pending;
  }

  #listen(address) {
    const { host, port } = splitAddress(address);
    const reader = new RtdReader();
    return new Promise((resolve) => {
      const result = { address, inUse: false, connected: false, receiving: false, error: null, bytes: 0, frames: 0, badFrames: 0, reading: null };
      let settle = null;
      let done = false;
      const socket = this.connect({ host, port });
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(overall);
        clearTimeout(settle);
        socket.destroy();
        result.bytes = reader.bytes;
        result.frames = reader.dataFrames;
        result.badFrames = reader.badFrames;
        result.receiving = reader.dataFrames > 0;
        const code = reader.reading('basketball').sportCode;
        result.reading = reader.reading(code !== null && code >= 2000 && code < 3000 ? 'volleyball' : 'basketball');
        resolve(result);
      };
      const overall = setTimeout(finish, this.timing.connectTimeoutMs + this.timing.testListenMs);
      socket.setTimeout(this.timing.connectTimeoutMs);
      socket.once('connect', () => {
        result.connected = true;
        socket.setTimeout(0);
        clearTimeout(overall);
        setTimeout(finish, this.timing.testListenMs).unref?.();
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
        finish();
      });
      socket.on('close', finish);
    });
  }
}
