// The box score (ARCHITECTURE.md §13): each team's roster as the scorekeeper
// typed it in, every player's points and personal fouls, team fouls per
// quarter, bonus and team timeouts. Only sports with `box` rules
// (basketball) have one. For games the scoreboard feed drives (§11) the board
// supplies team fouls, timeouts left, bonus and the timeout in progress.
//
// Rules (NFHS, which IHSA plays): team fouls count per quarter and reset each
// quarter, overtime continuing the 4th quarter's count; a team is in the
// bonus at the opponent's 5th team foul of the quarter; each team gets 5
// timeouts a game and 1 more per overtime; 5 personal fouls foul a player
// out. The numbers come from the sport's `box` rules and the game's options.
//
// Stored on the game as two JSON columns: `roster` (who plays: identities
// only) and `box` (what they did, plus the team counts). Undo restores `box`
// from its snapshot and never touches `roster`, so it never removes a player
// added since.

import { randomInt } from 'node:crypto';
import { badRequest, conflict } from './errors.js';
import { getSport, periodCount } from './sports.js';
import { oneOf, string } from './validate.js';

export const SIDES = Object.freeze(['home', 'away']);
export const MAX_PLAYERS = 30;
export const PLAYER_NAME_MAX_LENGTH = 40;
const MAX_PLAYER_POINTS = 999;
const MAX_PLAYER_FOULS = 10;
const MAX_TEAM_FOULS = 99;
const MAX_TIMEOUTS = 99;
const PLAYER_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PLAYER_ID_LENGTH = 6;
const PLAYER_ID_PATTERN = /^[a-z0-9]{1,16}$/;
// "0" to "99", and "00" (a different jersey from "0").
const NUMBER_PATTERN = /^\d{1,2}$/;

export function boxRules(sportId) {
  return getSport(sportId)?.box ?? null;
}

const zeroes = () => ({ home: 0, away: 0 });
const count = (value, max) => (Number.isInteger(value) && value >= 0 ? Math.min(value, max) : 0);

export function emptyRoster() {
  return { home: [], away: [] };
}

export function emptyBox() {
  return { players: {}, fouls: [], timeoutsLeft: null, timeout: null, boardBonus: null };
}

// Stored JSON -> roster, keeping only well-formed players.
export function parseRoster(text) {
  let value;
  try {
    value = JSON.parse(text ?? 'null');
  } catch {
    value = null;
  }
  const roster = emptyRoster();
  if (!value || typeof value !== 'object') return roster;
  for (const side of SIDES) {
    if (!Array.isArray(value[side])) continue;
    for (const player of value[side]) {
      if (!player || typeof player.id !== 'string' || typeof player.number !== 'string' || typeof player.name !== 'string') continue;
      roster[side].push({ id: player.id, number: player.number, name: player.name });
    }
  }
  return roster;
}

// Stored JSON -> box, every key present and well-typed.
export function parseBox(text) {
  let value;
  try {
    value = JSON.parse(text ?? 'null');
  } catch {
    value = null;
  }
  const box = emptyBox();
  if (!value || typeof value !== 'object') return box;
  if (value.players && typeof value.players === 'object') {
    for (const [id, stats] of Object.entries(value.players)) {
      if (!stats || typeof stats !== 'object') continue;
      box.players[id] = { points: count(stats.points, MAX_PLAYER_POINTS), fouls: count(stats.fouls, MAX_PLAYER_FOULS) };
    }
  }
  if (Array.isArray(value.fouls)) {
    box.fouls = value.fouls.map((entry) => ({ home: count(entry?.home, MAX_TEAM_FOULS), away: count(entry?.away, MAX_TEAM_FOULS) }));
  }
  if (value.timeoutsLeft && typeof value.timeoutsLeft === 'object') {
    box.timeoutsLeft = { home: count(value.timeoutsLeft.home, MAX_TIMEOUTS), away: count(value.timeoutsLeft.away, MAX_TIMEOUTS) };
  }
  if (SIDES.includes(value.timeout)) box.timeout = value.timeout;
  if (value.boardBonus && typeof value.boardBonus === 'object') {
    box.boardBonus = { home: value.boardBonus.home === true, away: value.boardBonus.away === true };
  }
  return box;
}

// ---- derived values -----------------------------------------------------------

export function timeoutsAllowed(game) {
  const rules = boxRules(game.sport);
  if (!rules) return 0;
  return Number.isInteger(game.options.timeouts) ? game.options.timeouts : rules.timeouts;
}

export function timeoutsLeft(game) {
  if (game.box.timeoutsLeft) return { ...game.box.timeoutsLeft };
  const allowed = timeoutsAllowed(game);
  return { home: allowed, away: allowed };
}

// The periods whose team fouls count now: the current quarter, or in
// overtime the 4th quarter and every overtime so far.
function foulSpan(game) {
  const regulation = periodCount(game.sport, game.options);
  const from = game.period >= regulation ? regulation - 1 : game.period;
  return { from, to: game.period };
}

function foulEntry(game) {
  while (game.box.fouls.length <= game.period) game.box.fouls.push(zeroes());
  return game.box.fouls[game.period];
}

// Team fouls that count now (this quarter; overtime continues the 4th).
export function teamFouls(game) {
  const { from, to } = foulSpan(game);
  const totals = zeroes();
  for (let i = from; i <= to; i += 1) {
    const entry = game.box.fouls[i];
    if (!entry) continue;
    totals.home += entry.home;
    totals.away += entry.away;
  }
  return totals;
}

// bonus.home: the home team shoots bonus free throws (the away team has
// reached the bonus fouls). The board's own indicators win while it drives
// the game: its console may be set to another threshold.
export function bonus(game) {
  const rules = boxRules(game.sport);
  if (!rules) return { home: false, away: false };
  if (game.box.boardBonus && !game.scoreboardManual) return { ...game.box.boardBonus };
  const fouls = teamFouls(game);
  return { home: fouls.away >= rules.bonusFouls, away: fouls.home >= rules.bonusFouls };
}

// "Timeout · MCHS" while a team's timeout is on (live games only).
export function timeoutLabel(game) {
  if (game.status !== 'live' || !boxRules(game.sport) || !game.box.timeout) return null;
  return `Timeout · ${game[game.box.timeout].code}`;
}

// The box in game JSON (§6), or null for sports without one.
export function serializeBox(game) {
  const rules = boxRules(game.sport);
  if (!rules) return null;
  const players = {};
  for (const side of SIDES) {
    players[side] = game.roster[side].map((player) => {
      const stats = game.box.players[player.id] ?? { points: 0, fouls: 0 };
      return { id: player.id, number: player.number, name: player.name, points: stats.points, fouls: stats.fouls, fouledOut: stats.fouls >= rules.foulOut };
    });
  }
  return {
    players,
    fouls: teamFouls(game),
    bonus: bonus(game),
    timeoutsLeft: timeoutsLeft(game),
    timeout: game.status === 'live' ? game.box.timeout : null,
  };
}

// ---- lifecycle ------------------------------------------------------------------

// A game starting: fresh counts (the roster typed in before the game stays).
export function startBox(game) {
  if (!boxRules(game.sport)) return emptyBox();
  const allowed = timeoutsAllowed(game);
  return { players: {}, fouls: [zeroes()], timeoutsLeft: { home: allowed, away: allowed }, timeout: null, boardBonus: null };
}

// One step of the period (movePeriod): team fouls get the new period's entry
// (stepping back drops entries that were only reached by mistake), each
// overtime gives every team its extra timeouts (taken back when stepping
// back out of it), and a timeout in progress ends.
export function boxPeriodStep(game, from, to) {
  const rules = boxRules(game.sport);
  if (!rules) return;
  const box = game.box;
  if (to > from) {
    while (box.fouls.length <= to) box.fouls.push(zeroes());
  } else {
    while (box.fouls.length > to + 1) {
      const last = box.fouls[box.fouls.length - 1];
      if (last.home !== 0 || last.away !== 0) break;
      box.fouls.pop();
    }
  }
  const regulation = periodCount(game.sport, game.options);
  const overtime = to > from ? to >= regulation : from >= regulation;
  if (overtime && rules.overtimeTimeouts > 0) {
    const left = timeoutsLeft(game);
    const step = to > from ? rules.overtimeTimeouts : -rules.overtimeTimeouts;
    box.timeoutsLeft = {
      home: Math.min(MAX_TIMEOUTS, Math.max(0, left.home + step)),
      away: Math.min(MAX_TIMEOUTS, Math.max(0, left.away + step)),
    };
  }
  box.timeout = null;
}

// The admin changed the timeouts per game of a live game: the difference
// applies to what each team has left.
export function timeoutsOptionChanged(game, before) {
  if (!boxRules(game.sport) || !game.box.timeoutsLeft) return;
  const delta = timeoutsAllowed(game) - timeoutsAllowed(before);
  if (delta === 0) return;
  for (const side of SIDES) game.box.timeoutsLeft[side] = Math.min(MAX_TIMEOUTS, Math.max(0, game.box.timeoutsLeft[side] + delta));
}

// ---- validation -------------------------------------------------------------------

export function requireBox(game) {
  const rules = boxRules(game.sport);
  if (!rules) throw badRequest(`${getSport(game.sport).name} doesn't keep a box score.`);
  return rules;
}

function teamName(game, side) {
  return game[side].name;
}

function findPlayer(game, side, value) {
  if (typeof value !== 'string' || !PLAYER_ID_PATTERN.test(value)) throw badRequest('player must be a player id from the roster.');
  const player = game.roster[side].find((entry) => entry.id === value);
  if (!player) throw conflict(`That player isn't on ${teamName(game, side)}'s roster.`);
  return player;
}

// A jersey number as text ("0"–"99", "00"), never a JSON number: 0 and 00 differ.
function validateNumber(value) {
  return string(value, 'number', { min: 1, max: 10, pattern: NUMBER_PATTERN, patternMessage: 'number must be 0–99 (00 allowed).' });
}

function validateName(value) {
  return string(value, 'name', { min: 1, max: PLAYER_NAME_MAX_LENGTH });
}

function newPlayerId(game) {
  const taken = new Set([...game.roster.home, ...game.roster.away].map((player) => player.id));
  let id;
  do {
    id = '';
    for (let i = 0; i < PLAYER_ID_LENGTH; i += 1) id += PLAYER_ID_ALPHABET[randomInt(PLAYER_ID_ALPHABET.length)];
  } while (taken.has(id));
  return id;
}

function stats(game, playerId) {
  return (game.box.players[playerId] ??= { points: 0, fouls: 0 });
}

const label = (player) => `#${player.number} ${player.name}`;

// ---- actions (games.js #applyAction) ---------------------------------------------

// `roster`: {op: 'add', team, number, name} | {op: 'edit', team, player,
// number?, name?} | {op: 'remove', team, player}. Numbers are unique per team.
export function applyRoster(game, body) {
  requireBox(game);
  const op = oneOf(body.op, 'op', ['add', 'edit', 'remove']);
  const team = oneOf(body.team, 'team', SIDES);
  const roster = game.roster[team];
  const numberTaken = (number, except = null) => roster.some((player) => player.number === number && player.id !== except);
  if (op === 'add') {
    const number = validateNumber(body.number);
    const name = validateName(body.name);
    if (roster.length >= MAX_PLAYERS) throw conflict(`${teamName(game, team)}'s roster is full (${MAX_PLAYERS} players).`);
    if (numberTaken(number)) throw conflict(`#${number} is already on ${teamName(game, team)}'s roster.`);
    const player = { id: newPlayerId(game), number, name };
    roster.push(player);
    return { op, team, player: player.id, number, name };
  }
  const player = findPlayer(game, team, body.player);
  if (op === 'edit') {
    const number = body.number === undefined ? player.number : validateNumber(body.number);
    const name = body.name === undefined ? player.name : validateName(body.name);
    if (numberTaken(number, player.id)) throw conflict(`#${number} is already on ${teamName(game, team)}'s roster.`);
    player.number = number;
    player.name = name;
    return { op, team, player: player.id, number, name };
  }
  const recorded = game.box.players[player.id];
  if (recorded && (recorded.points > 0 || recorded.fouls > 0)) {
    throw conflict(`${label(player)} has points or fouls in this game. Change the name or number instead.`);
  }
  game.roster[team] = roster.filter((entry) => entry.id !== player.id);
  delete game.box.players[player.id];
  return { op, team, player: player.id };
}

// Points for a player (with or without the team's, which the caller adds).
export function creditPoints(game, team, playerId, points) {
  requireBox(game);
  const player = findPlayer(game, team, playerId);
  const entry = stats(game, player.id);
  const value = entry.points + points;
  if (value < 0) throw conflict(`${label(player)} doesn't have that many points.`);
  if (value > MAX_PLAYER_POINTS) throw conflict('That is too many points for one player.');
  entry.points = value;
  return player.id;
}

// `foul` {team, player?, delta: 1 | -1}: a personal foul (the player's) and a
// team foul. While the board drives the game it keeps the team fouls, so
// only the player's change and a player is required.
export function applyFoul(game, body, { boardControls = false } = {}) {
  requireBox(game);
  const team = oneOf(body.team, 'team', SIDES);
  const delta = body.delta === undefined ? 1 : body.delta;
  if (delta !== 1 && delta !== -1) throw badRequest('delta must be 1 or -1.');
  const hasPlayer = body.player !== undefined && body.player !== null;
  if (!hasPlayer && boardControls) throw conflict('The scoreboard keeps the team fouls for this game. Pick the player who fouled.');
  let playerId = null;
  if (hasPlayer) {
    const player = findPlayer(game, team, body.player);
    const entry = stats(game, player.id);
    const value = entry.fouls + delta;
    if (value < 0) throw conflict(`${label(player)} has no fouls to take back.`);
    if (value > MAX_PLAYER_FOULS) throw conflict(`${label(player)} already has ${MAX_PLAYER_FOULS} fouls.`);
    entry.fouls = value;
    playerId = player.id;
  }
  if (!boardControls) {
    const entry = foulEntry(game);
    const value = entry[team] + delta;
    if (value < 0) throw conflict(`${teamName(game, team)} has no team fouls to take back this period.`);
    if (value > MAX_TEAM_FOULS) throw conflict('That is too many team fouls.');
    entry[team] = value;
    // Counted by hand now: the board's last bonus reading no longer applies.
    game.box.boardBonus = null;
  }
  return { team, player: playerId, delta, teamFouls: teamFouls(game)[team] };
}

// `timeout` {op: 'call', team} | {op: 'end'}. Calling one takes one of the
// team's timeouts; it ends when the clock starts, the period changes, or by
// `end`. Stopping a running clock is the caller's (games.js).
export function applyTimeout(game, body) {
  requireBox(game);
  const op = body.op === undefined ? 'call' : oneOf(body.op, 'op', ['call', 'end']);
  if (op === 'end') {
    if (!game.box.timeout) throw conflict('No timeout is on.');
    const team = game.box.timeout;
    game.box.timeout = null;
    return { op, team };
  }
  const team = oneOf(body.team, 'team', SIDES);
  if (game.box.timeout === team) throw conflict(`${teamName(game, team)}'s timeout is already on.`);
  const left = timeoutsLeft(game);
  if (left[team] <= 0) throw conflict(`${teamName(game, team)} has no timeouts left.`);
  left[team] -= 1;
  game.box.timeoutsLeft = left;
  game.box.timeout = team;
  return { op, team, timeoutsLeft: left[team] };
}

// The scoreboard no longer drives the game: the bonus is counted from the
// team fouls again.
export function boardReleased(game) {
  if (boxRules(game.sport)) game.box.boardBonus = null;
}

// The game clock started: a timeout in progress is over.
export function clockStarted(game) {
  if (boxRules(game.sport)) game.box.timeout = null;
}

// ---- the scoreboard feed (§11) ----------------------------------------------------

// Sets the team fouls that count now to `value`: the difference goes into
// the current period; a decrease the current period can't absorb comes off
// the earlier periods that count (overtime: the 4th quarter and earlier
// overtimes).
function setTeamFouls(game, side, value) {
  const current = teamFouls(game)[side];
  const entry = foulEntry(game);
  if (value >= current) {
    entry[side] += value - current;
    return;
  }
  let left = current - value;
  const { from, to } = foulSpan(game);
  for (let i = to; i >= from && left > 0; i -= 1) {
    const period = game.box.fouls[i];
    if (!period) continue;
    const taken = Math.min(period[side], left);
    period[side] -= taken;
    left -= taken;
  }
}

// What the board shows of the box (rtd.js reading): team fouls, timeouts
// left, its bonus indicators and the timeout in progress. Unknown values
// (null) are left alone. Adds what changed to `changes`.
export function applyBoardBox(game, reading, changes) {
  if (!boxRules(game.sport)) return;
  const known = (value) => value !== null && value !== undefined;
  for (const side of SIDES) {
    const fouls = reading[`${side}Fouls`];
    if (known(fouls) && fouls <= MAX_TEAM_FOULS && teamFouls(game)[side] !== fouls) {
      setTeamFouls(game, side, fouls);
      (changes.fouls ??= {})[side] = fouls;
    }
    const left = reading[`${side}TimeoutsLeft`];
    if (known(left) && left <= MAX_TIMEOUTS && timeoutsLeft(game)[side] !== left) {
      game.box.timeoutsLeft = { ...timeoutsLeft(game), [side]: left };
      (changes.timeoutsLeft ??= {})[side] = left;
    }
  }
  if (known(reading.homeBonus) && known(reading.awayBonus)) {
    const next = { home: reading.homeBonus, away: reading.awayBonus };
    const current = game.box.boardBonus;
    if (!current || current.home !== next.home || current.away !== next.away) {
      game.box.boardBonus = next;
      changes.bonus = next;
    }
  }
  if (known(reading.homeTimeout) && known(reading.awayTimeout)) {
    const team = reading.homeTimeout ? 'home' : reading.awayTimeout ? 'away' : null;
    if (team !== game.box.timeout) {
      game.box.timeout = team;
      changes.timeout = team;
    }
  }
}

// Live Activity content-state fields (§8.5), or null for sports without a box.
export function activityBox(game) {
  if (!boxRules(game.sport)) return null;
  const fouls = teamFouls(game);
  const inBonus = bonus(game);
  return { homeFouls: fouls.home, awayFouls: fouls.away, homeBonus: inBonus.home, awayBonus: inBonus.away };
}
