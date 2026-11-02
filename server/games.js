// Game state machine: scheduling, claims, start/end/cancel, scoring actions
// with undo and idempotency, serialization to the Game JSON (§6) and the
// Live Activity attributes/content-state (§8.5).
//
// Every mutation runs synchronously inside one SQLite transaction; side
// effects (SSE, APNs) are triggered through `hooks` after the commit.

import { randomInt } from 'node:crypto';
import { HttpError, badRequest, conflict, forbidden, notFound, tooEarly } from './errors.js';
import { parseScoreboardSetting } from './scoreboard.js';
import {
  defaultOptions,
  getSport,
  maxPeriodIndex,
  periodClockMinutes,
  periodInfo,
  rulesFor,
  volleyballBestOfValues,
} from './sports.js';
import { boolean, integer, oneOf, requireObject, string } from './validate.js';

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_LENGTH = 10;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Overtime may be "unlimited"; this bounds storage if a client misbehaves.
export const MAX_PERIODS = 100;
export const NOTE_MAX_LENGTH = 40;
export const MAX_CLOCK_MS = 3_600_000;
const MAX_SCORE = 9999;
const LOCATION_MAX_LENGTH = 100;
const MIN_SCHEDULED_AT = Date.UTC(2000, 0, 1);
const MAX_SCHEDULED_AT = Date.UTC(2100, 0, 1);

export const UNDOABLE_TYPES = Object.freeze(['score', 'set_score', 'period', 'clock', 'outs', 'note']);
export const ACTION_TYPES = Object.freeze([...UNDOABLE_TYPES, 'undo']);
// What the scoreboard feed sets (§11); the scorekeeper can't change these by
// hand while it drives the game. Notes stay manual.
const SCOREBOARD_TYPES = Object.freeze(['score', 'set_score', 'period', 'clock', 'undo']);
// A running clock may differ this much from the scoreboard before it is reset
// to the scoreboard's time (the console sends whole seconds over a minute).
const CLOCK_RESYNC_MS = 1500;
export const CONSOLE_RESET_REASON = 'the scoreboard was reset for another game';
const ACTION_ID_PATTERN = /^[\x21-\x7e]{8,64}$/;
const SCOPES = ['board', 'all'];
const ALL_SCOPE_LIMIT = 500;
const STATUS_ORDER = { live: 0, scheduled: 1, final: 2, canceled: 2 };

const GAME_SELECT = `
  SELECT g.*, u.display_name AS scorekeeper_name
    FROM games g LEFT JOIN users u ON u.id = g.scorekeeper_id`;

export function newGameId() {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

function rowToGame(row) {
  return {
    id: row.id,
    sport: row.sport,
    home: { name: row.home_name, code: row.home_code, color: row.home_color },
    away: { name: row.away_name, code: row.away_code, color: row.away_color },
    location: row.location,
    scheduledAt: row.scheduled_at,
    status: row.status,
    period: row.period,
    line: JSON.parse(row.line),
    outs: row.outs,
    note: row.note,
    options: JSON.parse(row.options),
    clock: { ms: row.clock_ms, anchor: row.clock_anchor, running: row.clock_running === 1 },
    scorekeeperId: row.scorekeeper_id,
    scorekeeperName: row.scorekeeper_name ?? null,
    scoreboard: row.scoreboard ?? 'default',
    scoreboardManual: row.scoreboard_manual === 1,
    channels: { production: row.channel_production, sandbox: row.channel_sandbox },
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

// The part of a game that scoring actions change (and undo restores).
function scoringSnapshot(game) {
  return {
    period: game.period,
    line: game.line.map((entry) => ({ home: entry.home, away: entry.away })),
    outs: game.outs,
    note: game.note,
    clock: { ...game.clock },
  };
}

function restoreSnapshot(game, snapshot) {
  game.period = snapshot.period;
  game.line = snapshot.line.map((entry) => ({ home: entry.home, away: entry.away }));
  game.outs = snapshot.outs;
  game.note = snapshot.note;
  game.clock = { ...snapshot.clock };
}

function cloneGame(game) {
  return structuredClone(game);
}

export function clockRemainingMs(clock, now) {
  if (clock.ms === null || clock.ms === undefined) return null;
  return clock.running ? Math.max(0, clock.ms - (now - clock.anchor)) : clock.ms;
}

function resetClock(game, now) {
  const minutes = periodClockMinutes(game.sport, game.options, game.period);
  game.clock = minutes > 0 ? { ms: minutes * 60_000, anchor: now, running: false } : { ms: null, anchor: null, running: false };
}

// Brings the clock in line with the game's current options: no clock where
// the period has none, a fresh stopped one where the period gained one. Needed
// after an options edit, and after an undo that restores a clock recorded
// before such an edit.
function alignClockWithOptions(game, now) {
  if (periodClockMinutes(game.sport, game.options, game.period) === 0) game.clock = { ms: null, anchor: null, running: false };
  else if (game.clock.ms === null) resetClock(game, now);
}

function stopClock(game, now) {
  if (game.clock.ms !== null && game.clock.running) {
    game.clock = { ms: clockRemainingMs(game.clock, now), anchor: now, running: false };
  }
}

function lineTotals(line) {
  return line.reduce((sum, entry) => ({ home: sum.home + entry.home, away: sum.away + entry.away }), { home: 0, away: 0 });
}

// Takes `amount` of `team`'s points off line[from], then off the periods
// before it, so a correction made after the period moved on still lands.
// Returns false (line partly changed) if the team doesn't have that many.
function takePoints(line, from, team, amount) {
  let left = amount;
  for (let i = from; i >= 0 && left > 0; i -= 1) {
    const taken = Math.min(line[i][team], left);
    line[i][team] -= taken;
    left -= taken;
  }
  return left === 0;
}

// Team scores per §5: points mode sums the line; sets mode counts sets won
// (completed sets, plus the current one once the game is final).
export function computeScores(game) {
  const sport = getSport(game.sport);
  if (sport.scoreMode === 'sets') {
    const current = game.line[game.period] ?? { home: 0, away: 0 };
    const completed = Math.min(game.status === 'final' ? game.period + 1 : game.period, game.line.length);
    let home = 0;
    let away = 0;
    for (let i = 0; i < completed; i += 1) {
      if (game.line[i].home > game.line[i].away) home += 1;
      else if (game.line[i].away > game.line[i].home) away += 1;
    }
    return { home, away, homeSet: current.home, awaySet: current.away };
  }
  const totals = lineTotals(game.line);
  return { home: totals.home, away: totals.away, homeSet: null, awaySet: null };
}

export function lastPeriodIndex(game) {
  const max = maxPeriodIndex(game.sport, game.options);
  return max === null ? MAX_PERIODS - 1 : Math.min(max, MAX_PERIODS - 1);
}

function currentLineEntry(game) {
  while (game.line.length <= game.period) game.line.push({ home: 0, away: 0 });
  return game.line[game.period];
}

function movePeriod(game, delta, now) {
  const target = game.period + delta;
  if (target < 0) throw conflict('Already at the first period.');
  if (target > lastPeriodIndex(game)) throw conflict('There are no more periods in this game.');
  if (delta > 0) {
    while (game.line.length <= target) game.line.push({ home: 0, away: 0 });
  } else {
    // Drop periods that were only reached by mistake (no points); keep any
    // with points so totals never silently change.
    while (game.line.length > target + 1) {
      const last = game.line[game.line.length - 1];
      if (last.home !== 0 || last.away !== 0) break;
      game.line.pop();
    }
  }
  game.period = target;
  game.outs = 0;
  game.note = '';
  resetClock(game, now);
}

// Points mode: sets a team's game total. An increase goes into the current
// period; a decrease comes off the current period, then the earlier ones, then
// any later ones (left behind when the console stepped the period back), so
// every total the scoreboard shows can be reached.
function setTeamTotal(line, period, team, target) {
  const total = lineTotals(line)[team];
  if (target >= total) {
    line[period][team] += target - total;
    return;
  }
  let left = total - target;
  const order = [];
  for (let i = period; i >= 0; i -= 1) order.push(i);
  for (let i = line.length - 1; i > period; i -= 1) order.push(i);
  for (const i of order) {
    const taken = Math.min(line[i][team], left);
    line[i][team] -= taken;
    left -= taken;
    if (left === 0) break;
  }
}

// Makes the game show what the scoreboard shows (§11): period, score (points
// mode: the totals; sets mode: points in the current game, plus each finished
// game's score as the console recorded it) and the main clock. Values the
// reading doesn't know (null) are left alone. Returns what changed, or null.
function applyScoreboardReading(game, reading, now) {
  const sport = getSport(game.sport);
  const changes = {};
  const known = (value) => value !== null && value !== undefined;

  // The period first: moving resets the clock, which the reading then sets.
  if (known(reading.period)) {
    const target = reading.period - 1;
    if (target !== game.period && target >= 0 && target <= lastPeriodIndex(game)) {
      const step = target > game.period ? 1 : -1;
      while (game.period !== target) movePeriod(game, step, now);
      changes.period = target;
    }
  }

  currentLineEntry(game);
  if (sport.scoreMode === 'sets') {
    const games = Array.isArray(reading.games) ? reading.games : [];
    for (let i = 0; i < game.period && i < games.length; i += 1) {
      const recorded = games[i];
      // 0-0 means the console didn't record that game; keep what was seen live.
      if (!recorded || (recorded.home === 0 && recorded.away === 0) || recorded.home > MAX_SCORE || recorded.away > MAX_SCORE) continue;
      const entry = game.line[i];
      if (entry.home === recorded.home && entry.away === recorded.away) continue;
      entry.home = recorded.home;
      entry.away = recorded.away;
      (changes.games ??= {})[i] = [recorded.home, recorded.away];
    }
    // Points of a game the app isn't showing (the console is past the last
    // set this match allows) must not land in the current set.
    const sameGame = !known(reading.period) || reading.period - 1 === game.period;
    const entry = game.line[game.period];
    for (const [team, value] of [['home', reading.home], ['away', reading.away]]) {
      if (!sameGame || !known(value) || value > MAX_SCORE || entry[team] === value) continue;
      entry[team] = value;
      changes[team] = value;
    }
  } else {
    for (const [team, value] of [['home', reading.home], ['away', reading.away]]) {
      if (!known(value) || value > MAX_SCORE) continue;
      const before = lineTotals(game.line)[team];
      if (value === before) continue;
      setTeamTotal(game.line, game.period, team, value);
      if (lineTotals(game.line)[team] !== before) changes[team] = value;
    }
  }

  if (game.clock.ms !== null && known(reading.clockMs)) {
    const ms = Math.min(reading.clockMs, MAX_CLOCK_MS);
    const running = ms > 0 && (reading.clockRunning ?? game.clock.running);
    const expected = clockRemainingMs(game.clock, now);
    const differs = running !== game.clock.running || (running ? Math.abs(expected - ms) > CLOCK_RESYNC_MS : expected !== ms);
    if (differs) {
      game.clock = { ms, anchor: now, running };
      changes.clock = { ms, running };
    }
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

// ---- input validation -------------------------------------------------------

function validateSportId(value) {
  const sport = string(value, 'sport', { min: 1, max: 32 });
  if (!getSport(sport)) throw badRequest(`Unknown sport "${sport}".`);
  return sport;
}

function validateTeamName(value, field) {
  return string(value, field, { min: 1, max: 40 });
}

function validateTeamCode(value, field) {
  const code = string(value, field, { min: 2, max: 4 }).toUpperCase();
  if (!/^[A-Z0-9]{2,4}$/.test(code)) throw badRequest(`${field} must be 2–4 letters or digits.`);
  return code;
}

function validateColor(value, field) {
  const color = string(value, field, { min: 7, max: 7 }).toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(color)) throw badRequest(`${field} must be a #RRGGBB color.`);
  return color;
}

function validateTeam(value, field, current = null) {
  requireObject(value, field);
  const partial = current !== null;
  const team = partial ? { ...current } : {};
  if (!partial || value.name !== undefined) team.name = validateTeamName(value.name, `${field}.name`);
  if (!partial || value.code !== undefined) team.code = validateTeamCode(value.code, `${field}.code`);
  if (!partial || value.color !== undefined) team.color = validateColor(value.color, `${field}.color`);
  return team;
}

// Millisecond values may arrive as non-integral numbers (Swift Doubles).
function milliseconds(value, field, { min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest(`${field} must be a number of milliseconds.`);
  return integer(Math.round(value), field, { min, max });
}

function validateScheduledAt(value) {
  return milliseconds(value, 'scheduledAt', { min: MIN_SCHEDULED_AT, max: MAX_SCHEDULED_AT });
}

function validateLocation(value) {
  if (value === null) return '';
  return string(value, 'location', { max: LOCATION_MAX_LENGTH });
}

// Merges option input over `base`. Values are always type/range checked;
// options that don't apply to the sport (e.g. bestOf for basketball, a clock
// for baseball) are ignored so a generic form can send every field.
function resolveOptions(sportId, input, base) {
  const sport = getSport(sportId);
  const options = { ...base };
  if (input === undefined || input === null) return options;
  requireObject(input, 'options');
  const hasClock = sport.clock.available;
  if (input.clockEnabled !== undefined && input.clockEnabled !== null) {
    const enabled = boolean(input.clockEnabled, 'options.clockEnabled');
    if (hasClock) options.clockEnabled = enabled;
  }
  if (input.periodMinutes !== undefined && input.periodMinutes !== null) {
    const minutes = integer(input.periodMinutes, 'options.periodMinutes', { min: 1, max: 60 });
    if (hasClock) options.periodMinutes = minutes;
  }
  if (input.overtimeMinutes !== undefined && input.overtimeMinutes !== null) {
    const minutes = integer(input.overtimeMinutes, 'options.overtimeMinutes', { min: 0, max: 30 });
    if (hasClock && sport.overtime) options.overtimeMinutes = minutes;
  }
  if (input.bestOf !== undefined && input.bestOf !== null) {
    const bestOf = integer(input.bestOf, 'options.bestOf', { min: 1, max: 99 });
    if (!volleyballBestOfValues().includes(bestOf)) throw badRequest('options.bestOf must be 3 or 5.');
    if (sport.scoreMode === 'sets') options.bestOf = bestOf;
  }
  return options;
}

function validateActionId(value) {
  if (typeof value !== 'string' || !ACTION_ID_PATTERN.test(value)) {
    throw badRequest('actionId must be 8–64 printable characters (use a UUID).');
  }
  return value;
}

// ---- Live Activity payload pieces (§8.5) -----------------------------------

export function activityAttributes(game) {
  const sport = getSport(game.sport);
  return {
    gameId: game.id,
    sport: game.sport,
    sportName: sport.name,
    symbol: sport.symbol,
    homeName: game.home.name,
    homeCode: game.home.code,
    homeColor: game.home.color,
    awayName: game.away.name,
    awayCode: game.away.code,
    awayColor: game.away.color,
  };
}

// Times are Unix seconds as plain numbers. Optional fields that don't apply
// are omitted (Swift Optionals decode a missing key as nil).
export function activityContentState(game, { note } = {}) {
  const sport = getSport(game.sport);
  const info = periodInfo(game.sport, game.options, game.period);
  const scores = computeScores(game);
  const state = {
    status: game.status,
    homeScore: scores.home,
    awayScore: scores.away,
  };
  if (sport.scoreMode === 'sets') {
    state.homeSetScore = scores.homeSet;
    state.awaySetScore = scores.awaySet;
  }
  state.periodLabel = info.label;
  state.periodShort = info.short;
  state.note = note ?? game.note;
  if (game.clock.ms !== null && game.clock.ms !== undefined) {
    state.clockRemaining = clockRemainingMs(game.clock, game.updatedAt) / 1000;
    if (game.clock.running) state.clockEndsAt = (game.clock.anchor + game.clock.ms) / 1000;
  }
  if (sport.tracksOuts) state.outs = game.outs;
  state.updatedAt = game.updatedAt / 1000;
  return state;
}

// What changed for Lock Screen purposes between two versions of a live game.
// Only a note-only change is low priority (APNs priority 5); score, period,
// status, outs and any clock change are high priority (10).
export function activityChange(before, after) {
  if (!before || !after) return { changed: true, high: true };
  const signature = (game) => {
    const state = activityContentState(game);
    const clock = game.clock.ms === null ? null : game.clock.running ? ['running', game.clock.anchor + game.clock.ms] : ['stopped', game.clock.ms];
    return JSON.stringify([state.status, state.homeScore, state.awayScore, state.homeSetScore, state.awaySetScore, state.periodLabel, state.periodShort, state.outs, clock]);
  };
  const high = signature(before) !== signature(after);
  return { changed: high || before.note !== after.note, high };
}

// ---- service ----------------------------------------------------------------

export class GameService {
  #db;
  #config;
  #now;
  #log;
  #hooks;
  #scoreboard = null;

  constructor({ db, config, now = Date.now, log, hooks = {} }) {
    this.#db = db;
    this.#config = config;
    this.#now = now;
    this.#log = log;
    this.#hooks = hooks;
  }

  setHooks(hooks) {
    this.#hooks = hooks;
  }

  // The scoreboard feed service (§11): decides which games it drives, and
  // describes the feed in game JSON for signed-in viewers.
  setScoreboard(scoreboard) {
    this.#scoreboard = scoreboard;
  }

  #emit(name, ...args) {
    const hook = this.#hooks[name];
    if (!hook) return undefined;
    try {
      return hook(...args);
    } catch (err) {
      this.#log?.error(`game hook "${name}" failed`, { err });
      return undefined;
    }
  }

  // ---- reads ----

  getGame(id) {
    if (typeof id !== 'string') return null;
    const row = this.#db.get(`${GAME_SELECT} WHERE g.id = ?`, id);
    return row ? rowToGame(row) : null;
  }

  #require(id) {
    const game = this.getGame(id);
    if (!game) throw notFound('Game not found.');
    return game;
  }

  // `before` (scope all): a page of the games scheduled before that time.
  list(scope = 'board', { before = null } = {}) {
    oneOf(scope, 'scope', SCOPES);
    const now = this.#now();
    if (scope === 'all') {
      if (before !== null) {
        return this.#db.all(`${GAME_SELECT} WHERE g.scheduled_at < ? ORDER BY g.scheduled_at DESC, g.id LIMIT ${ALL_SCOPE_LIMIT}`, before).map(rowToGame);
      }
      // Keep the most relevant games when there are more than the limit
      // (live ones, then those nearest to now either way) so a season
      // scheduled ahead never pushes tonight's game out; newest first.
      return this.#db
        .all(`${GAME_SELECT} ORDER BY g.status = 'live' DESC, ABS(g.scheduled_at - ?), g.id LIMIT ${ALL_SCOPE_LIMIT}`, now)
        .map(rowToGame)
        .sort((a, b) => b.scheduledAt - a.scheduledAt || (a.id < b.id ? -1 : 1));
    }
    const rows = this.#db.all(
      `${GAME_SELECT}
        WHERE g.status = 'live'
           OR (g.status = 'scheduled' AND g.scheduled_at BETWEEN ? AND ?)
           OR (g.status IN ('final', 'canceled') AND COALESCE(g.ended_at, g.scheduled_at) >= ?)`,
      now - 12 * HOUR_MS, now + 14 * DAY_MS, now - 3 * DAY_MS,
    );
    const games = rows.map(rowToGame);
    games.sort((a, b) => {
      const order = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (order !== 0) return order;
      if (a.status === 'live') return (a.startedAt ?? 0) - (b.startedAt ?? 0);
      if (a.status === 'scheduled') return a.scheduledAt - b.scheduledAt;
      return (b.endedAt ?? b.scheduledAt) - (a.endedAt ?? a.scheduledAt);
    });
    return games;
  }

  liveGameIds() {
    return this.#db.all("SELECT id FROM games WHERE status = 'live'").map((row) => row.id);
  }

  liveGames() {
    return this.#db.all(`${GAME_SELECT} WHERE g.status = 'live'`).map(rowToGame);
  }

  canStartAt(game) {
    return game.scheduledAt - this.#config.startWindowMinutes * 60_000;
  }

  serialize(game, { authenticated = false } = {}) {
    const sport = getSport(game.sport);
    const info = periodInfo(game.sport, game.options, game.period);
    const scores = computeScores(game);
    const json = {
      id: game.id,
      sport: game.sport,
      sportName: sport.name,
      symbol: sport.symbol,
      status: game.status,
      scheduledAt: game.scheduledAt,
      location: game.location,
      home: { ...game.home, score: scores.home, setScore: scores.homeSet },
      away: { ...game.away, score: scores.away, setScore: scores.awaySet },
      period: game.period,
      periodLabel: info.label,
      periodShort: info.short,
      isOvertime: info.isOvertime,
      line: game.line,
      outs: sport.tracksOuts ? game.outs : null,
      note: game.note,
      clock:
        game.clock.ms === null
          ? null
          : {
              running: game.clock.running,
              remainingMs: game.clock.ms,
              anchorAt: game.clock.anchor,
              periodMs: periodClockMinutes(game.sport, game.options, game.period) * 60_000,
            },
      options: {
        clockEnabled: game.options.clockEnabled,
        periodMinutes: game.options.periodMinutes,
        overtimeMinutes: game.options.overtimeMinutes,
        bestOf: game.options.bestOf,
      },
      rules: rulesFor(game.sport, game.options),
    };
    if (authenticated) {
      json.scorekeeper = game.scorekeeperId === null ? null : { id: game.scorekeeperId, name: game.scorekeeperName };
      if (this.#scoreboard) json.scoreboard = this.#scoreboard.view(game);
    }
    json.canStartAt = this.canStartAt(game);
    json.startedAt = game.startedAt;
    json.endedAt = game.endedAt;
    json.updatedAt = game.updatedAt;
    json.version = game.version;
    if (game.status === 'live') json.channels = { production: game.channels.production, sandbox: game.channels.sandbox };
    return json;
  }

  // ---- persistence helpers ----

  #save(game, now) {
    this.#db.run(
      `UPDATE games SET
         sport = ?, home_name = ?, home_code = ?, home_color = ?, away_name = ?, away_code = ?, away_color = ?,
         location = ?, scheduled_at = ?, status = ?, period = ?, line = ?, outs = ?, note = ?, options = ?,
         clock_ms = ?, clock_anchor = ?, clock_running = ?, scorekeeper_id = ?, started_at = ?, ended_at = ?,
         scoreboard = ?, scoreboard_manual = ?, updated_at = ?, version = version + 1
       WHERE id = ?`,
      game.sport, game.home.name, game.home.code, game.home.color, game.away.name, game.away.code, game.away.color,
      game.location, game.scheduledAt, game.status, game.period, JSON.stringify(game.line), game.outs, game.note,
      JSON.stringify(game.options), game.clock.ms, game.clock.anchor, game.clock.running ? 1 : 0, game.scorekeeperId,
      game.startedAt, game.endedAt, game.scoreboard, game.scoreboardManual ? 1 : 0, now, game.id,
    );
    return this.getGame(game.id);
  }

  #recordEvent(gameId, { userId = null, actionId = null, type, data = {}, prevState = null, now }) {
    this.#db.run(
      'INSERT INTO game_events (game_id, user_id, action_id, type, data, prev_state, undone, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      gameId, userId, actionId, type, JSON.stringify(data), prevState === null ? null : JSON.stringify(prevState), now,
    );
  }

  // ---- admin: create / edit / delete / cancel ----

  create(input, user) {
    requireObject(input);
    const sport = validateSportId(input.sport);
    const home = input.home === undefined || input.home === null ? { ...this.#config.homeTeam } : validateTeam(input.home, 'home');
    if (input.away === undefined || input.away === null) throw badRequest('away is required.');
    const away = validateTeam(input.away, 'away');
    const location = input.location === undefined ? '' : validateLocation(input.location);
    if (input.scheduledAt === undefined || input.scheduledAt === null) throw badRequest('scheduledAt is required.');
    const scheduledAt = validateScheduledAt(input.scheduledAt);
    const options = resolveOptions(sport, input.options, defaultOptions(sport));
    const scoreboard = input.scoreboard === undefined ? 'default' : parseScoreboardSetting(input.scoreboard);
    const now = this.#now();

    const game = this.#db.transaction(() => {
      let id;
      do id = newGameId();
      while (this.#db.get('SELECT 1 FROM games WHERE id = ?', id));
      this.#db.run(
        `INSERT INTO games (id, sport, home_name, home_code, home_color, away_name, away_code, away_color, location,
                            scheduled_at, status, period, line, outs, note, options, clock_ms, clock_anchor, clock_running,
                            scoreboard, created_by, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 0, '[]', 0, '', ?, NULL, NULL, 0, ?, ?, ?, ?, 1)`,
        id, sport, home.name, home.code, home.color, away.name, away.code, away.color, location,
        scheduledAt, JSON.stringify(options), scoreboard, user?.id ?? null, now, now,
      );
      return this.getGame(id);
    });
    this.#log?.info('game created', { gameId: game.id, sport, by: user?.id });
    this.#emit('changed', null, game);
    return game;
  }

  update(id, input, user) {
    requireObject(input);
    let before;
    const game = this.#db.transaction(() => {
      before = this.#require(id);
      const next = cloneGame(before);
      // Live Activities carry the sport and team identity in their fixed
      // attributes, so those can't change once the game has started.
      const locked = before.startedAt !== null;
      const lockedError = () => conflict("Teams and sport can't be changed after the game has started.");

      if (input.sport !== undefined) {
        const sport = validateSportId(input.sport);
        if (sport !== before.sport) {
          if (locked) throw lockedError();
          next.sport = sport;
          next.options = defaultOptions(sport);
        }
      }
      for (const side of ['home', 'away']) {
        if (input[side] === undefined) continue;
        const team = validateTeam(input[side], side, before[side]);
        const changed = ['name', 'code', 'color'].some((key) => team[key] !== before[side][key]);
        if (changed && locked) throw lockedError();
        next[side] = team;
      }
      if (input.location !== undefined) next.location = validateLocation(input.location);
      if (input.scheduledAt !== undefined) next.scheduledAt = validateScheduledAt(input.scheduledAt);
      if (input.scoreboard !== undefined) next.scoreboard = parseScoreboardSetting(input.scoreboard);
      if (input.options !== undefined) next.options = resolveOptions(next.sport, input.options, next.options);

      if (next.status === 'live') {
        if (next.period > lastPeriodIndex(next)) {
          throw conflict('The game is already past the last period those options allow.');
        }
        alignClockWithOptions(next, this.#now());
      }

      const unchanged = JSON.stringify({ ...next, version: 0 }) === JSON.stringify({ ...before, version: 0 });
      if (unchanged) return before;
      return this.#save(next, this.#now());
    });
    if (game !== before) {
      this.#log?.info('game updated', { gameId: id, by: user?.id });
      this.#emit('changed', before, game);
    }
    return game;
  }

  remove(id, user) {
    // Live games must be ended or canceled first, so their Live Activities get
    // the end broadcast; the push layer keeps the channels until it is delivered.
    const game = this.#db.transaction(() => {
      const existing = this.#require(id);
      if (existing.status === 'live') throw conflict('End or cancel the game before deleting it.');
      this.#db.run('DELETE FROM games WHERE id = ?', id);
      return existing;
    });
    this.#log?.info('game deleted', { gameId: id, by: user?.id });
    this.#emit('removed', game);
  }

  cancel(id, user) {
    const now = this.#now();
    let before;
    const game = this.#db.transaction(() => {
      before = this.#require(id);
      if (before.status !== 'scheduled' && before.status !== 'live') throw conflict(`This game is already ${before.status}.`);
      const next = cloneGame(before);
      stopClock(next, now);
      next.status = 'canceled';
      next.endedAt = now;
      this.#recordEvent(id, { userId: user?.id, type: 'cancel', data: { wasLive: before.status === 'live' }, now });
      return this.#save(next, now);
    });
    this.#log?.info('game canceled', { gameId: id, by: user?.id, wasLive: before.status === 'live' });
    this.#emit('changed', before, game);
    if (before.status === 'live') this.#emit('ended', game, { canceled: true });
    return game;
  }

  // ---- scorekeeper: claim / release / start / actions / end ----

  claim(id, user, { force = false } = {}) {
    if (force !== undefined && typeof force !== 'boolean') throw badRequest('force must be true or false.');
    let before;
    const game = this.#db.transaction(() => {
      before = this.#require(id);
      if (before.status !== 'scheduled' && before.status !== 'live') throw conflict(`This game is ${before.status}.`);
      if (before.scorekeeperId === user.id) return before;
      if (before.scorekeeperId !== null && !(force && user.role === 'admin')) {
        throw conflict(`${before.scorekeeperName ?? 'Another scorekeeper'} is keeping score for this game.`);
      }
      const next = cloneGame(before);
      next.scorekeeperId = user.id;
      const now = this.#now();
      this.#recordEvent(id, { userId: user.id, type: 'claim', data: { previous: before.scorekeeperId, force: Boolean(force) }, now });
      return this.#save(next, now);
    });
    if (game !== before) this.#emit('changed', before, game);
    return game;
  }

  release(id, user) {
    let before;
    const game = this.#db.transaction(() => {
      before = this.#require(id);
      if (before.scorekeeperId === null) return before;
      const isAdmin = user.role === 'admin';
      if (before.scorekeeperId !== user.id && !isAdmin) throw forbidden('Only the scorekeeper holding this game or an admin can release it.');
      if (before.status === 'live' && !isAdmin) throw conflict('A live game can only be released by an admin.');
      const next = cloneGame(before);
      next.scorekeeperId = null;
      const now = this.#now();
      this.#recordEvent(id, { userId: user.id, type: 'release', data: { previous: before.scorekeeperId }, now });
      return this.#save(next, now);
    });
    if (game !== before) this.#emit('changed', before, game);
    return game;
  }

  #assertHolder(game, user) {
    if (user.role === 'admin' || game.scorekeeperId === user.id) return;
    throw conflict(
      game.scorekeeperId === null
        ? 'Claim this game first.'
        : `${game.scorekeeperName ?? 'Another scorekeeper'} is keeping score for this game.`,
    );
  }

  start(id, user) {
    const now = this.#now();
    let before;
    const game = this.#db.transaction(() => {
      before = this.#require(id);
      if (before.status !== 'scheduled') throw conflict(`This game is already ${before.status}.`);
      if (user.role !== 'admin') {
        if (before.scorekeeperId !== null && before.scorekeeperId !== user.id) this.#assertHolder(before, user);
        const canStartAt = this.canStartAt(before);
        if (now < canStartAt) {
          throw tooEarly(`This game can be started from ${new Date(canStartAt).toISOString()}.`);
        }
      }
      const next = cloneGame(before);
      if (next.scorekeeperId === null) next.scorekeeperId = user.id;
      next.status = 'live';
      next.startedAt = now;
      next.endedAt = null;
      next.period = 0;
      next.line = [{ home: 0, away: 0 }];
      next.outs = 0;
      next.note = '';
      resetClock(next, now);
      this.#recordEvent(id, { userId: user.id, type: 'start', now });
      return this.#save(next, now);
    });
    this.#log?.info('game started', { gameId: id, by: user.id });
    this.#emit('changed', before, game);
    const queued = this.#emit('started', game) ?? 0;
    return { game, queued };
  }

  action(id, user, body) {
    requireObject(body);
    const actionId = validateActionId(body.actionId);
    const type = oneOf(body.type, 'type', ACTION_TYPES);
    const now = this.#now();
    let before = null;
    let duplicate = false;
    let correction = false;

    const game = this.#db.transaction(() => {
      const current = this.#require(id);
      if (this.#db.get('SELECT 1 AS hit FROM game_events WHERE game_id = ? AND action_id = ?', id, actionId)) {
        duplicate = true;
        return current;
      }
      this.#assertHolder(current, user);
      correction = type === 'set_score' && user.role === 'admin' && current.status === 'final';
      if (current.status !== 'live' && !correction) throw conflict('This game is not live.');
      if (SCOREBOARD_TYPES.includes(type) && this.#scoreboard?.controls(current)) {
        throw new HttpError(409, 'scoreboard_active', 'The scoreboard is keeping score for this game. Switch to scoring by hand to change it yourself.');
      }

      before = current;
      const next = cloneGame(current);
      const prevState = scoringSnapshot(current);
      const data = this.#applyAction(next, type, body, now);
      this.#recordEvent(id, { userId: user.id, actionId, type, data, prevState, now });
      return this.#save(next, now);
    });

    if (!duplicate) this.#emit('changed', before, game, { correction });
    return { game, duplicate };
  }

  #applyAction(game, type, body, now) {
    const sport = getSport(game.sport);
    switch (type) {
      case 'score': {
        const team = oneOf(body.team, 'team', ['home', 'away']);
        const points = integer(body.points, 'points', { min: -10, max: 10 });
        if (points === 0) throw badRequest('points must not be 0.');
        const entry = currentLineEntry(game);
        const value = entry[team] + points;
        if (value > MAX_SCORE) throw conflict('That score is too high.');
        if (value >= 0) entry[team] = value;
        // Points mode: a minus beyond this period's points comes off earlier
        // periods (a mistake noticed after the period moved on). A set's
        // points belong to that set.
        else if (sport.scoreMode === 'sets') throw conflict("A set's points can't go below 0.");
        else if (!takePoints(game.line, game.period, team, -points)) throw conflict("A team's score can't go below 0.");
        return { team, points };
      }
      case 'set_score': {
        const home = integer(body.home, 'home', { min: 0, max: MAX_SCORE });
        const away = integer(body.away, 'away', { min: 0, max: MAX_SCORE });
        currentLineEntry(game);
        // Optional `period`: correct that period (or set) instead of the
        // current one, e.g. a mis-recorded first set, or an admin fixing a
        // final game.
        const explicit = body.period !== undefined && body.period !== null;
        const index = explicit ? integer(body.period, 'period', { min: 0, max: game.period }) : game.period;
        const entry = game.line[index];
        if (sport.scoreMode === 'sets') {
          entry.home = home;
          entry.away = away;
        } else {
          // Points mode: home/away are the totals; the difference goes into
          // that period. Without an explicit period, a decrease the current
          // period can't absorb comes off the earlier periods.
          const totals = lineTotals(game.line);
          for (const [team, target] of [['home', home], ['away', away]]) {
            const delta = target - totals[team];
            if (delta >= 0 || entry[team] + delta >= 0) entry[team] += delta;
            else if (explicit || !takePoints(game.line, index, team, -delta)) {
              throw conflict('That total is lower than the points scored in the other periods.');
            }
          }
        }
        return explicit ? { home, away, period: index } : { home, away };
      }
      case 'period': {
        const delta = body.delta;
        if (delta !== 1 && delta !== -1) throw badRequest('delta must be 1 or -1.');
        movePeriod(game, delta, now);
        return { delta, period: game.period };
      }
      case 'clock': {
        const op = oneOf(body.op, 'op', ['start', 'stop', 'set']);
        if (game.clock.ms === null) throw conflict('This period has no game clock.');
        if (op === 'start') {
          if (game.clock.running) throw conflict('The clock is already running.');
          if (game.clock.ms <= 0) throw conflict('The clock is at 0:00. Set it before starting.');
          game.clock = { ms: game.clock.ms, anchor: now, running: true };
        } else if (op === 'stop') {
          if (!game.clock.running) throw conflict('The clock is already stopped.');
          const startedWithMs = game.clock.ms;
          stopClock(game, now);
          // A stop can reach us late (weak gym Wi-Fi, queued retries): honor
          // the time the scorekeeper saw, between what is left now and what
          // was left when the clock last started.
          if (body.remainingMs !== undefined && body.remainingMs !== null) {
            const seen = milliseconds(body.remainingMs, 'remainingMs', { min: 0, max: MAX_CLOCK_MS });
            game.clock.ms = Math.min(Math.max(seen, game.clock.ms), startedWithMs);
          }
        } else {
          const remainingMs = milliseconds(body.remainingMs, 'remainingMs', { min: 0, max: MAX_CLOCK_MS });
          game.clock = { ms: remainingMs, anchor: now, running: game.clock.running };
        }
        return { op, remainingMs: game.clock.ms };
      }
      case 'outs': {
        if (!sport.tracksOuts) throw badRequest(`${sport.name} doesn't track outs.`);
        const delta = body.delta;
        if (delta !== 1 && delta !== -1) throw badRequest('delta must be 1 or -1.');
        if (delta === 1) {
          if (game.outs >= 2) movePeriod(game, 1, now);
          else game.outs += 1;
        } else {
          if (game.outs <= 0) throw conflict('There are no outs to remove.');
          game.outs -= 1;
        }
        return { delta, outs: game.outs, period: game.period };
      }
      case 'note': {
        const text = string(body.text, 'text', { max: NOTE_MAX_LENGTH });
        game.note = text;
        return { text };
      }
      case 'undo': {
        // Never past a scoreboard update: the snapshot from before it would
        // throw away everything the scoreboard set since.
        const event = this.#db.get(
          `SELECT id, type, prev_state FROM game_events
            WHERE game_id = ? AND undone = 0 AND prev_state IS NOT NULL
              AND type IN (${UNDOABLE_TYPES.map(() => '?').join(', ')})
              AND id > COALESCE((SELECT MAX(id) FROM game_events WHERE game_id = ? AND type = 'scoreboard'), 0)
            ORDER BY id DESC LIMIT 1`,
          game.id, ...UNDOABLE_TYPES, game.id,
        );
        if (!event) throw conflict('Nothing to undo.');
        const snapshot = JSON.parse(event.prev_state);
        // The admin may have edited the options (e.g. bestOf) since then.
        if (snapshot.period > lastPeriodIndex(game)) throw conflict("That period no longer exists with this game's options.");
        restoreSnapshot(game, snapshot);
        alignClockWithOptions(game, now);
        this.#db.run('UPDATE game_events SET undone = 1 WHERE id = ?', event.id);
        return { eventId: event.id, undoneType: event.type };
      }
      default:
        throw badRequest(`Unknown action type "${type}".`);
    }
  }

  // ---- scoreboard feed (§11) ----

  // What the scoreboard shows, applied to a live game the feed drives.
  applyScoreboard(id, reading) {
    const now = this.#now();
    let before = null;
    const game = this.#db.transaction(() => {
      const current = this.getGame(id);
      if (!current || current.status !== 'live' || current.scoreboardManual) return null;
      const next = cloneGame(current);
      const changes = applyScoreboardReading(next, reading, now);
      if (!changes) return null;
      before = current;
      this.#recordEvent(id, { type: 'scoreboard', data: changes, now });
      return this.#save(next, now);
    });
    if (game) this.#emit('changed', before, game);
    return game;
  }

  // The feed itself hands a game over to scoring by hand: a newer game took
  // its scoreboard, or the console was reset for another game while this one
  // was still live. `reason` goes into the event log.
  releaseScoreboard(id, reason) {
    let before;
    const game = this.#db.transaction(() => {
      before = this.getGame(id);
      if (!before || before.status !== 'live' || before.scoreboardManual) return null;
      const next = cloneGame(before);
      next.scoreboardManual = true;
      const now = this.#now();
      this.#recordEvent(id, { type: 'scoreboard_mode', data: { manual: true, reason }, now });
      return this.#save(next, now);
    });
    if (game) {
      this.#log?.info('game switched to manual scoring by the scoreboard feed', { gameId: id, reason });
      this.#emit('changed', before, game);
    }
    return game;
  }

  // True when a scorekeeper switched the game back to the scoreboard right
  // after the feed released it because the console was reset (§11).
  scoreboardResetOverridden(id) {
    const [last, previous] = this.#db.all(
      "SELECT user_id, data FROM game_events WHERE game_id = ? AND type = 'scoreboard_mode' ORDER BY id DESC LIMIT 2",
      id,
    );
    if (!last || !previous || last.user_id === null || previous.user_id !== null) return false;
    return JSON.parse(last.data).manual === false && JSON.parse(previous.data).reason === CONSOLE_RESET_REASON;
  }

  // The scorekeeper's switch between the scoreboard and scoring by hand.
  setScoreboardManual(id, user, manual) {
    const value = boolean(manual, 'manual');
    let before;
    const game = this.#db.transaction(() => {
      before = this.#require(id);
      this.#assertHolder(before, user);
      if (before.status !== 'live' && before.status !== 'scheduled') throw conflict(`This game is ${before.status}.`);
      if (before.scoreboardManual === value) return before;
      const next = cloneGame(before);
      next.scoreboardManual = value;
      const now = this.#now();
      this.#recordEvent(id, { userId: user.id, type: 'scoreboard_mode', data: { manual: value }, now });
      return this.#save(next, now);
    });
    if (game !== before) {
      this.#log?.info(value ? 'game switched to manual scoring' : 'game switched to the scoreboard', { gameId: id, by: user.id });
      this.#emit('changed', before, game);
    }
    return game;
  }

  end(id, user, { auto = false } = {}) {
    const now = this.#now();
    let before;
    const game = this.#db.transaction(() => {
      before = this.#require(id);
      if (before.status !== 'live') throw conflict('This game is not live.');
      if (user) this.#assertHolder(before, user);
      const next = cloneGame(before);
      stopClock(next, now);
      next.status = 'final';
      next.endedAt = now;
      next.note = '';
      this.#recordEvent(id, { userId: user?.id ?? null, type: 'end', data: { auto }, now });
      return this.#save(next, now);
    });
    this.#log?.info(auto ? 'game auto-finalized' : 'game ended', { gameId: id, by: user?.id });
    this.#emit('changed', before, game);
    this.#emit('ended', game, { canceled: false });
    return game;
  }

  // Ends live games nobody has changed for AUTO_FINAL_HOURS (forgotten
  // ones); a game still being scored is never ended under the scorekeeper,
  // however long it runs. Returns the ids ended.
  autoFinalize() {
    const cutoff = this.#now() - this.#config.autoFinalHours * HOUR_MS;
    const ended = [];
    for (const { id } of this.#db.all("SELECT id FROM games WHERE status = 'live' AND updated_at <= ?", cutoff)) {
      try {
        this.end(id, null, { auto: true });
        ended.push(id);
      } catch (err) {
        this.#log?.error('auto-final failed', { gameId: id, err });
      }
    }
    return ended;
  }

  // Stores (or clears) a broadcast channel id. A live game's channel ids are
  // part of its JSON, so that bumps the version and notifies clients.
  setChannel(id, environment, channelId) {
    const column = environment === 'production' ? 'channel_production' : 'channel_sandbox';
    const before = this.getGame(id);
    if (!before || before.channels[environment] === channelId) return before;
    const notify = before.status === 'live';
    if (notify) {
      this.#db.run(`UPDATE games SET ${column} = ?, version = version + 1, updated_at = ? WHERE id = ?`, channelId, this.#now(), id);
    } else {
      this.#db.run(`UPDATE games SET ${column} = ? WHERE id = ?`, channelId, id);
    }
    const after = this.getGame(id);
    if (notify) this.#emit('changed', before, after, { channelsOnly: true });
    return after;
  }
}
