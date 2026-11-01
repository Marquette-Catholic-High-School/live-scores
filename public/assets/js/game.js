// Single-game scoreboard (route "/game/:id"), sized for a phone or a
// projector, kept live over SSE (/api/stream?game=<id>).

import { ApiError, api, fetchConfig, gameApiPath } from './api.js';
import { clockRemainingMs, formatClock, onTick, serverNow } from './clock.js';
import {
  finalLabel, hasStarted, isSetsMode, leader, lineScoreTable, matchup, outsIndicator, scoreLine, setsToWin, statusLabel,
} from './render.js';
import { connectStream } from './sse.js';
import {
  $, applyTeamColor, el, emptyState, errorNotice, fillSchoolName, formatDay, formatDayTime, formatDuration, formatTime, loadingState,
  renderConnection, replayClass, setTimeZone,
} from './ui.js';

// The server serves this page for any "/game/<segment>", including ones with
// broken percent-encoding that decodeURIComponent rejects; those are simply
// not a game id.
function pathGameId() {
  try {
    return decodeURIComponent(location.pathname.slice('/game/'.length));
  } catch {
    return '';
  }
}

const gameId = pathGameId();
const mount = $('[data-board]');
const connNode = $('[data-conn]');
const fullscreenButton = $('[data-fullscreen]');

let game = null;
let board = null;
let stream = null;
let gone = false;
let schoolName = 'Marquette Catholic';

// ---- board ------------------------------------------------------------------

function teamPanel(side) {
  const code = el('span', { class: 'board__code' });
  const name = el('span', { class: 'board__name' });
  const label = el('span', { class: 'sr-only' });
  const value = el('span', { class: 'board__value' });
  const score = el('span', { class: 'board__score', 'aria-live': 'polite', 'aria-atomic': 'true' }, label, value);
  const sub = el('span', { class: 'board__sub' });
  const root = el(
    'section',
    { class: 'board__team', dataset: { side }, 'aria-label': side === 'home' ? 'Home team' : 'Away team' },
    el('span', { class: 'board__side', text: side === 'home' ? 'Home' : 'Away' }),
    code,
    name,
    score,
    sub,
  );
  return { root, code, name, label, value, score, sub };
}

function setPips(node, won, needed) {
  const pips = Array.from({ length: needed }, (_, index) => el('span', { class: ['pip', index < won && 'is-on'] }));
  node.replaceChildren(el('span', { class: 'pips', role: 'img', 'aria-label': `Sets won: ${won}` }, pips), el('span', { class: 'board__sublabel', text: 'Sets' }));
}

function buildBoard() {
  const sport = el('p', { class: 'board__sport' });
  const where = el('p', { class: 'board__where' });
  const status = el('span', { class: 'badge' });
  const period = el('span', { class: 'board__period' });
  const clock = el('span', { class: 'board__clock' });
  const outs = outsIndicator();
  outs.root.classList.add('outs--lg');
  const note = el('span', { class: 'note-pill note-pill--lg' });
  const countdown = el('span', { class: 'board__countdown' });
  const home = teamPanel('home');
  const away = teamPanel('away');
  const mid = el('div', { class: 'board__mid' }, status, period, clock, outs.root, note, countdown);
  const line = el('div', { class: 'board__line' });
  const updated = el('p', { class: 'board__updated' });
  const root = el(
    'article',
    { class: 'board' },
    el('header', { class: 'board__meta' }, sport, where),
    el('div', { class: 'board__main' }, home.root, mid, away.root),
    line,
    updated,
  );
  return { root, sport, where, status, period, clock, outs, note, countdown, teams: { home, away }, line, updated, lineKey: '' };
}

function render(previous) {
  if (!board) {
    board = buildBoard();
    mount.replaceChildren(board.root);
  }
  const started = hasStarted(game);
  const live = game.status === 'live';
  const sets = isSetsMode(game);
  const winner = game.status === 'final' ? leader(game) : null;

  board.root.dataset.status = game.status;
  board.sport.textContent = game.sportName;
  board.where.textContent = [game.location, game.status === 'scheduled' ? null : formatDay(game.startedAt ?? game.scheduledAt, { long: true })]
    .filter(Boolean)
    .join(' · ');

  for (const side of ['home', 'away']) {
    const team = game[side];
    const panel = board.teams[side];
    applyTeamColor(panel.root, team.color);
    panel.code.textContent = team.code;
    panel.name.textContent = team.name;
    panel.root.classList.toggle('is-trailing', winner !== null && winner !== side);
    // Volleyball: while live the big number is the current set's points and
    // the pips are sets won; once final it is sets won.
    const big = sets && live ? team.setScore : team.score;
    panel.label.textContent = sets && live ? `${team.name}, this set: ` : `${team.name}: `;
    panel.value.textContent = started ? String(big ?? 0) : '';
    panel.score.hidden = !started;
    if (sets && started) setPips(panel.sub, team.score, setsToWin(game));
    else panel.sub.replaceChildren();
    panel.sub.hidden = !(sets && started);
    if (previous && started && (previous[side].score !== team.score || previous[side].setScore !== team.setScore)) {
      replayClass(panel.value, 'is-bumped');
    }
  }

  board.status.className = `badge badge--${game.status} badge--lg`;
  board.status.textContent = game.status === 'scheduled' ? formatDay(game.scheduledAt) : statusLabel(game);
  board.period.textContent = live ? game.periodLabel : game.status === 'scheduled' ? formatTime(game.scheduledAt) : '';
  board.period.hidden = board.period.textContent === '';
  board.period.classList.toggle('board__period--time', game.status === 'scheduled');
  board.clock.hidden = !(live && game.clock);
  board.clock.classList.toggle('is-stopped', Boolean(game.clock && !game.clock.running));
  board.outs.root.hidden = !(live && game.outs !== null && game.outs !== undefined);
  if (!board.outs.root.hidden) board.outs.update(game.outs);
  board.note.textContent = game.note;
  board.note.hidden = !(live && game.note);
  board.countdown.hidden = game.status !== 'scheduled';

  const lineKey = JSON.stringify([game.version, game.status]);
  if (started && lineKey !== board.lineKey) {
    board.line.replaceChildren(lineScoreTable(game));
    board.lineKey = lineKey;
  }
  board.line.hidden = !started;
  board.updated.textContent = live ? `Updated ${formatTime(game.updatedAt)}` : '';

  document.title = titleFor(game);
  tick();
}

function titleFor(g) {
  if (g.status === 'live') return `${scoreLine(g)} · ${g.periodShort} | ${schoolName} Live`;
  // A game canceled before it started has no score to show.
  if (g.status === 'final' || g.status === 'canceled') return `${finalLabel(g)}: ${hasStarted(g) ? scoreLine(g) : matchup(g)} | ${schoolName} Live`;
  return `${g.home.code} vs ${g.away.code} · ${formatDayTime(g.scheduledAt)} | ${schoolName} Live`;
}

function tick() {
  if (!board || !game) return;
  if (game.status === 'live' && game.clock) board.clock.textContent = formatClock(clockRemainingMs(game.clock));
  if (game.status === 'scheduled') {
    const until = game.scheduledAt - serverNow();
    board.countdown.textContent = until > 0 ? `Starts in ${formatDuration(until)}` : 'Starting soon';
  }
}

// Final for this page view: the game is gone, so a request or event still in
// flight must not bring the board back.
function showMessage(title, text) {
  gone = true;
  clearTimeout(retryTimer);
  stream?.close();
  stream = null;
  board = null;
  mount.replaceChildren(
    el('div', { class: 'board-message' }, emptyState(title, text), el('a', { class: 'btn btn--primary', href: '/', text: 'See all scores' })),
  );
  renderConnection(connNode, 'offline');
}

// ---- data -------------------------------------------------------------------

function apply(next) {
  if (gone || !next || next.id !== gameId) return;
  if (game && game.version >= next.version) return;
  const previous = game;
  game = next;
  render(previous);
}

let retryTimer = null;
let loading = null;
// Settles once the config (school name and time zone) is in or has failed;
// the board isn't drawn before, so its times never flip zones.
let configReady = null;

async function load() {
  if (gone) return false;
  if (loading) return loading;
  clearTimeout(retryTimer);
  loading = (async () => {
    try {
      const [{ game: fresh }] = await Promise.all([api(gameApiPath(gameId)), configReady]);
      apply(fresh);
      $('[data-board-error]')?.remove();
      return true;
    } catch (err) {
      if (gone) return false;
      if (err instanceof ApiError && err.status === 404) {
        showMessage('Game not found', 'It may have been removed, or the link is wrong.');
        return false;
      }
      if (!board) mount.replaceChildren(errorNotice(`Couldn’t load this game: ${err.message}`, { retry: () => load() }));
      else if (!$('[data-board-error]')) {
        const notice = errorNotice(`Couldn’t refresh: ${err.message}`);
        notice.dataset.boardError = '';
        mount.prepend(notice);
      }
      retryTimer = setTimeout(load, 5000);
      return true;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function setupFullscreen() {
  if (!fullscreenButton || !document.fullscreenEnabled) return;
  fullscreenButton.hidden = false;
  let wakeLock = null;
  const sync = async () => {
    const active = Boolean(document.fullscreenElement);
    document.documentElement.classList.toggle('is-fullscreen', active);
    fullscreenButton.textContent = active ? 'Exit full screen' : 'Full screen';
    fullscreenButton.setAttribute('aria-pressed', String(active));
    // A projected scoreboard must not go to sleep.
    if (active && 'wakeLock' in navigator && !wakeLock) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } catch {
        wakeLock = null;
      }
    } else if (!active && wakeLock) {
      await wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  };
  fullscreenButton.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && document.fullscreenElement) sync();
  });
}

async function main() {
  mount.replaceChildren(loadingState('Loading game…'));
  setupFullscreen();
  configReady = fetchConfig()
    .then((config) => {
      schoolName = config.schoolName;
      fillSchoolName(config.schoolName);
      setTimeZone(config.timeZone);
      if (game) document.title = titleFor(game);
    })
    .catch(() => {});

  if (!gameId || gameId.includes('/')) {
    showMessage('Game not found', 'The link is incomplete or broken.');
    return;
  }
  const exists = await load();
  if (!exists) return;
  stream = connectStream({
    gameId,
    onHello: () => load(),
    onPoll: () => load(),
    onGame: apply,
    onRemoved: (id) => {
      if (id === gameId) showMessage('This game was removed', 'It is no longer on the schedule.');
    },
    onState: (state) => renderConnection(connNode, state),
  });
  onTick(tick);
}

main();
