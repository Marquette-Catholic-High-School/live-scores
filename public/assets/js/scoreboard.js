// Public scoreboard (route "/"): Live, Upcoming and Final games, kept live
// over SSE. Cards are created once per game and updated in place so score
// animations and keyboard focus survive updates.

import { api, fetchConfig } from './api.js';
import { clockRemainingMs, formatClock, onTick, serverNow } from './clock.js';
import { finalLabel, hasStarted, isHalfInnings, isSetsMode, leader, updateTeamChip } from './render.js';
import { GameStore, coalesce } from './store.js';
import { connectStream } from './sse.js';
import {
  $, applyTeamColor, dayKey, el, errorNotice, fillSchoolName, formatDay, formatTime, renderConnection, replayClass, setTimeZone, syncChildren,
} from './ui.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Mirrors the server's `scope=board` window (ARCHITECTURE.md §7) so games
// that change outside it over SSE don't appear.
function onBoard(game) {
  const now = serverNow();
  if (game.status === 'live') return true;
  if (game.status === 'scheduled') return game.scheduledAt >= now - 12 * HOUR_MS && game.scheduledAt <= now + 14 * DAY_MS;
  return (game.endedAt ?? game.scheduledAt) >= now - 3 * DAY_MS;
}

const store = new GameStore({ accept: onBoard });
const cards = new Map();
const dayGroups = new Map();

const dom = {
  conn: $('[data-conn]'),
  status: $('[data-status-slot]'),
  loading: $('[data-loading]'),
  empty: $('[data-empty]'),
  live: $('[data-section="live"]'),
  upcoming: $('[data-section="upcoming"]'),
  final: $('[data-section="final"]'),
};

let loaded = false;

// ---- cards ------------------------------------------------------------------

function teamRow(side) {
  const chip = el('span', { class: 'chip' });
  const name = el('span', { class: 'team-row__name' });
  const label = el('span', { class: 'sr-only' });
  const value = el('span', { class: 'team-row__value' });
  const score = el('span', { class: 'team-row__score', 'aria-live': 'polite', 'aria-atomic': 'true' }, label, value);
  const root = el('div', { class: 'team-row', dataset: { side } }, chip, name, score);
  return { root, chip, name, label, value, score };
}

class GameCard {
  constructor(game) {
    this.sport = el('span', { class: 'game-card__sport' });
    this.state = el('span', { class: 'game-card__state' });
    this.rows = { home: teamRow('home'), away: teamRow('away') };
    this.foot = el('div', { class: 'game-card__foot' });
    this.clock = null;
    this.link = el(
      'a',
      { class: 'game-card', href: `/game/${encodeURIComponent(game.id)}` },
      el('div', { class: 'game-card__meta' }, this.sport, this.state),
      el('div', { class: 'game-card__teams' }, this.rows.home.root, this.rows.away.root),
      this.foot,
    );
    this.root = el('li', { class: 'cards__item' }, this.link);
    this.game = null;
    this.update(game);
  }

  update(game) {
    const previous = this.game;
    this.game = game;
    const started = hasStarted(game);
    const winner = game.status === 'final' ? leader(game) : null;
    this.link.dataset.status = game.status;
    this.sport.textContent = game.sportName;

    for (const side of ['home', 'away']) {
      const team = game[side];
      const row = this.rows[side];
      applyTeamColor(row.root, team.color);
      updateTeamChip(row.chip, team);
      row.name.textContent = team.name;
      row.label.textContent = `${team.name} `;
      row.value.textContent = started ? String(team.score) : '';
      row.score.hidden = !started;
      row.root.classList.toggle('is-trailing', winner !== null && winner !== side);
      row.root.classList.toggle('is-winner', winner === side);
      if (previous && started && previous[side].score !== team.score) {
        replayClass(row.value, 'is-bumped');
        replayClass(row.root, 'is-scored');
      }
    }

    this.#renderState(game);
    this.#renderFoot(game);
    this.tick();
  }

  #renderState(game) {
    this.clock = null;
    if (game.status === 'live') {
      const parts = [el('span', { class: 'badge badge--live', text: 'Live' }), el('span', { class: 'game-card__period', text: game.periodShort })];
      if (game.clock) {
        this.clock = el('span', { class: 'game-card__clock' });
        parts.push(this.clock);
      }
      this.state.replaceChildren(...parts);
    } else if (game.status === 'scheduled') {
      this.state.replaceChildren(el('span', { class: 'game-card__time', text: formatTime(game.scheduledAt) }));
    } else {
      this.state.replaceChildren(el('span', { class: ['badge', `badge--${game.status}`], text: finalLabel(game) }));
    }
  }

  #renderFoot(game) {
    const items = [];
    if (game.status === 'live') {
      if (isSetsMode(game)) items.push(el('span', { class: 'game-card__detail', text: `${game.periodLabel}: ${game.home.setScore}–${game.away.setScore}` }));
      if (game.outs !== null && game.outs !== undefined) {
        items.push(el('span', { class: 'game-card__detail', text: `${isHalfInnings(game.rules) ? game.periodLabel : game.periodShort} · ${game.outs} ${game.outs === 1 ? 'out' : 'outs'}` }));
      }
      if (game.note) items.push(el('span', { class: 'note-pill', text: game.note }));
    } else if (game.status !== 'scheduled') {
      items.push(el('span', { text: formatDay(game.endedAt ?? game.scheduledAt) }));
    }
    if (game.location) items.push(el('span', { class: 'game-card__location', text: game.location }));
    this.foot.replaceChildren(...items);
    this.foot.hidden = items.length === 0;
  }

  tick() {
    if (this.clock) this.clock.textContent = formatClock(clockRemainingMs(this.game.clock));
  }
}

function cardFor(game) {
  let card = cards.get(game.id);
  if (!card) {
    card = new GameCard(game);
    cards.set(game.id, card);
  } else if (card.game !== game) {
    card.update(game);
  }
  return card;
}

// ---- sections ---------------------------------------------------------------

function setCount(section, count) {
  const node = section.querySelector('[data-count]');
  if (node) node.textContent = count ? String(count) : '';
}

function renderUpcoming(games) {
  const container = dom.upcoming.querySelector('[data-groups]');
  const byDay = new Map();
  for (const game of games) {
    const key = dayKey(game.scheduledAt);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(game);
  }
  const groups = [];
  for (const [key, dayGames] of byDay) {
    let group = dayGroups.get(key);
    if (!group) {
      const title = el('h3', { class: 'day-group__title' });
      const list = el('ul', { class: 'cards' });
      group = { root: el('section', { class: 'day-group' }, title, list), title, list };
      dayGroups.set(key, group);
    }
    group.title.textContent = formatDay(dayGames[0].scheduledAt, { long: true });
    syncChildren(group.list, dayGames.map((game) => cardFor(game).root));
    groups.push(group.root);
  }
  for (const key of [...dayGroups.keys()]) if (!byDay.has(key)) dayGroups.delete(key);
  syncChildren(container, groups);
}

function render() {
  const games = store.all();
  for (const id of [...cards.keys()]) if (!store.get(id)) cards.delete(id);

  const live = games.filter((g) => g.status === 'live').sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const upcoming = games.filter((g) => g.status === 'scheduled').sort((a, b) => a.scheduledAt - b.scheduledAt);
  const done = games
    .filter((g) => g.status === 'final' || g.status === 'canceled')
    .sort((a, b) => (b.endedAt ?? b.scheduledAt) - (a.endedAt ?? a.scheduledAt));

  syncChildren(dom.live.querySelector('[data-list]'), live.map((game) => cardFor(game).root));
  renderUpcoming(upcoming);
  syncChildren(dom.final.querySelector('[data-list]'), done.map((game) => cardFor(game).root));

  dom.live.hidden = live.length === 0;
  dom.upcoming.hidden = upcoming.length === 0;
  dom.final.hidden = done.length === 0;
  setCount(dom.live, live.length);
  setCount(dom.upcoming, upcoming.length);
  setCount(dom.final, done.length);
  dom.loading.hidden = loaded;
  dom.empty.hidden = !loaded || games.length > 0;

  const liveCount = live.length;
  document.title = liveCount ? `(${liveCount} live) ${baseTitle}` : baseTitle;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// ---- data -------------------------------------------------------------------

let baseTitle = document.title;
let retryTimer = null;
let failures = 0;

// Times are shown in the school's time zone, so the first snapshot waits for
// the config (or for it to fail: then the device's zone is used). Cards drawn
// before that from a stream event are redrawn once the zone is known.
const configReady = fetchConfig()
  .then((config) => {
    fillSchoolName(config.schoolName);
    baseTitle = `Live Scores · ${config.schoolName}`;
    if (setTimeZone(config.timeZone)) for (const card of cards.values()) card.update(card.game);
    scheduleRender();
  })
  .catch(() => {});

const resync = coalesce(async () => {
  clearTimeout(retryTimer);
  const requestedAt = Date.now();
  try {
    const [{ games }] = await Promise.all([api('/api/games?scope=board'), configReady]);
    store.replaceAll(games, requestedAt);
    loaded = true;
    failures = 0;
    dom.status.replaceChildren();
  } catch (err) {
    failures += 1;
    const delay = Math.min(30_000, 2000 * 2 ** Math.min(failures - 1, 4));
    dom.status.replaceChildren(errorNotice(`Couldn’t load the scores: ${err.message}`, { retry: () => resync() }));
    retryTimer = setTimeout(() => resync(), delay);
  }
  scheduleRender();
});

store.subscribe(scheduleRender);

connectStream({
  onHello: () => resync(),
  onPoll: () => resync(),
  onGame: (game) => store.upsert(game),
  onRemoved: (id) => store.remove(id),
  onState: (state) => renderConnection(dom.conn, state),
});
resync();

onTick(() => {
  for (const card of cards.values()) if (card.clock) card.tick();
});
// Day labels ("Today", "Tomorrow") and the board window move with time.
setInterval(() => {
  store.refilter();
  render();
}, 60_000);
