// Scorekeeper console (route "/keeper", one game at "/keeper?game=<id>").
// Phone-first: huge tap targets, every scoring tap queued with its own
// actionId and retried until the server has it, the screen kept awake while
// a game is open, and SSE keeping several devices in sync.

import { mountAccountMenu } from './account.js';
import { ApiError, api, fetchConfig, fetchSession, gameApiPath, loginUrl } from './api.js';
import { clockRemainingMs, formatClock, onTick, serverNow, splitClock } from './clock.js';
import { ActionQueue } from './queue.js';
import {
  SIDES, boxScore, displayNote, finalLabel, hasStarted, isHalfInnings, isSetsMode, lineScoreTable, matchup, maxPeriodIndex, outsIndicator,
  periodInfoAt, scoreLine, scoreboardFields, startsByItself, statusBadge, teamChip, teamStats, updateTeamChip,
} from './render.js';
import { connectStream } from './sse.js';
import { GameStore, coalesce } from './store.js';
import {
  $, applyTeamColor, clear, confirmDialog, el, emptyState, endOfDay, errorNotice, fillSchoolName, formatDay, formatDayTime, formatDuration,
  formatTime, loadingState, openDialog, renderConnection, setBusy, setTimeZone, syncChildren, toast,
} from './ui.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_MS = 3_600_000;
// A scheduled game on a scoreboard starts by itself once the scoreboard is
// on, from its start time until this much later (server/scoreboard.js
// AUTO_START_WINDOW_MS).
const AUTO_START_WINDOW_MS = 3 * 60 * 60 * 1000;

const dom = {
  main: $('[data-keeper]'),
  conn: $('[data-conn]'),
  account: $('[data-account]'),
  adminLink: $('[data-admin-link]'),
};

const store = new GameStore();
let user = null;
let config = { schoolName: 'Marquette Catholic', apnsEnabled: false, startWindowMinutes: 120 };
let view = null;
let loaded = false;
let listError = null;

const ACTION_NAMES = {
  score: 'A score change',
  set_score: 'A score correction',
  period: 'A period change',
  clock: 'A clock change',
  outs: 'An outs change',
  note: 'A note',
  undo: 'An undo',
  player_points: 'A player’s points',
  foul: 'A foul',
  timeout: 'A timeout',
  roster: 'A roster change',
};

// Jersey numbers: "0"–"99", and "00" (server/box.js).
const PLAYER_NUMBER = /^\d{1,2}$/;

// What the scoreboard sets while it drives a game (ARCHITECTURE.md §11): the
// server refuses these then (409 scoreboard_active) and their controls are
// locked. Notes, Start and End game stay with the scorekeeper, and so do the
// players' points and fouls in a box score (§13; the board keeps the team
// fouls, timeouts and bonus).
const FEED_ACTION_TYPES = new Set(['score', 'set_score', 'period', 'clock', 'undo', 'timeout']);

const FEED_STATE_LABELS = {
  connecting: 'Connecting',
  unreachable: 'Can’t reach',
  waiting: 'No data',
  receiving: 'Receiving',
  manual: 'By hand',
  standby: 'Other game',
};

// Taps still waiting to be sent are kept in this tab's sessionStorage, so a
// reload or the browser discarding the tab (iOS Safari never shows the
// beforeunload prompt) doesn't lose them. They are resent with their
// actionIds, so any the server already has are not applied twice.
const PENDING_KEY = 'mchs-keeper-pending';

function savePending(items) {
  try {
    if (items.length) sessionStorage.setItem(PENDING_KEY, JSON.stringify({ userId: user?.id ?? null, items }));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage full or disabled: the queue still works for this page view.
  }
}

function restorePending() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  if (!saved) return;
  // Taps made by someone else who used this tab are theirs, not this user's.
  const restored = saved.userId === user.id ? queue.restore(saved.items) : 0;
  if (restored === 0) savePending([]);
  else toast(`Sending ${restored} scoring ${restored === 1 ? 'change' : 'changes'} made before the page reloaded.`, { timeoutMs: 6000 });
}

// Taps queued before this device knew the scoreboard had taken over a game
// (offline, or restored after a reload) are refused one after another. Like
// any refused tap they are dropped; they are reported in one message.
const FEED_REFUSAL_REPORT_MS = 600;
const feedRefusals = new Map(); // gameId -> { count, timer }

function reportFeedRefusal(error, item, dropped) {
  let entry = feedRefusals.get(item.gameId);
  if (!entry) {
    entry = { count: 0, timer: null };
    feedRefusals.set(item.gameId, entry);
    refreshGame(item.gameId);
  }
  entry.count += 1 + dropped;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    feedRefusals.delete(item.gameId);
    const what = entry.count === 1 ? `${ACTION_NAMES[item.body.type] ?? 'A change'} wasn’t saved` : `${entry.count} changes weren’t saved`;
    toast(`${what}: ${error.message}`, { tone: 'error', timeoutMs: 9000 });
  }, FEED_REFUSAL_REPORT_MS);
}

const queue = new ActionQueue({
  onApplied: (result) => store.upsert(result.game),
  persist: savePending,
  onRejected: (error, item, dropped) => {
    if (error.code === 'scoreboard_active') {
      reportFeedRefusal(error, item, dropped);
      return;
    }
    const later = dropped > 0 ? ` ${dropped} later ${dropped === 1 ? 'change was' : 'changes were'} discarded — check the score.` : '';
    toast(`${ACTION_NAMES[item.body.type] ?? 'A change'} wasn’t saved: ${error.message}${later}`, { tone: 'error', timeoutMs: 9000 });
    refreshGame(item.gameId);
  },
});

function handleCommandError(err) {
  if (err instanceof ApiError && err.status === 401) {
    location.assign(loginUrl());
    return;
  }
  toast(err.message, { tone: 'error' });
}

async function refreshGame(id) {
  try {
    const { game } = await api(gameApiPath(id));
    store.upsert(game);
    return game;
  } catch {
    return store.get(id);
  }
}

// Claim/release/start/end are plain commands (no actionId); their buttons
// stay busy until the server answers.
async function command(button, id, suffix, body) {
  if (button) setBusy(button, true);
  try {
    const result = await api(gameApiPath(id, suffix), { method: 'POST', body });
    store.upsert(result.game);
    return result;
  } catch (err) {
    handleCommandError(err);
    return null;
  } finally {
    if (button) setBusy(button, false);
  }
}

// A short buzz on Android confirms a tap landed (iOS has no Vibration API).
function haptic() {
  if (typeof navigator.vibrate === 'function' && navigator.userActivation?.isActive !== false) navigator.vibrate(12);
}

// ---- screen wake lock -----------------------------------------------------------

const wake = { lock: null, wanted: false, pending: false };

async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || !wake.wanted || wake.lock || wake.pending || document.visibilityState !== 'visible') return;
  wake.pending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!wake.wanted) {
      await lock.release();
      return;
    }
    wake.lock = lock;
    lock.addEventListener('release', () => {
      if (wake.lock === lock) wake.lock = null;
    });
  } catch {
    // Denied (battery saver, unsupported context): the page still works.
  } finally {
    wake.pending = false;
  }
}

function setWakeLock(wanted) {
  wake.wanted = wanted;
  if (wanted) acquireWakeLock();
  else if (wake.lock) {
    const lock = wake.lock;
    wake.lock = null;
    lock.release().catch(() => {});
  }
}

// The browser drops the lock whenever the page is hidden; take it again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquireWakeLock();
});

// ---- routing --------------------------------------------------------------------

function routeGameId() {
  return new URLSearchParams(location.search).get('game');
}

function navigate(id, { replace = false } = {}) {
  const url = id ? `/keeper?game=${encodeURIComponent(id)}` : '/keeper';
  const state = id ? { game: id, fromList: !replace } : {};
  if (replace) history.replaceState(state, '', url);
  else history.pushState(state, '', url);
  route();
}

function goBack() {
  if (history.state?.fromList) history.back();
  else navigate(null, { replace: true });
}

function route() {
  view?.destroy();
  const id = routeGameId();
  view = id ? new ConsoleView(id) : new ListView();
  dom.main.replaceChildren(view.root);
  view.update();
  window.scrollTo(0, 0);
}

let updateQueued = false;
function scheduleUpdate() {
  if (updateQueued) return;
  updateQueued = true;
  requestAnimationFrame(() => {
    updateQueued = false;
    view?.update();
  });
}

// ---- list view ------------------------------------------------------------------

function listSection(title) {
  const list = el('ul', { class: 'klist' });
  const count = el('span', { class: 'section__count' });
  const root = el('section', { class: 'section', hidden: true }, el('div', { class: 'section__head' }, el('h2', { class: 'section__title', text: title }), count), list);
  return { root, list, count };
}

function holderText(game) {
  if (game.status === 'final' || game.status === 'canceled') return game.scorekeeper ? `Scored by ${game.scorekeeper.name}` : null;
  if (!game.scorekeeper) return 'Unclaimed';
  return game.scorekeeper.id === user.id ? 'You’re keeping score' : `${game.scorekeeper.name} is keeping score`;
}

class GameRow {
  constructor(game) {
    this.root = el('li', { class: 'krow' });
    this.version = null;
    this.render(game);
  }

  render(game) {
    if (this.version === game.version) return;
    this.version = game.version;
    const started = hasStarted(game);
    const mine = game.scorekeeper?.id === user.id;
    const admin = user.role === 'admin';
    const open = game.status === 'live' || game.status === 'scheduled';

    const team = (side) => el(
      'span',
      { class: 'krow__team' },
      teamChip(game[side]),
      el('span', { class: 'krow__name', text: game[side].name }),
      started ? el('span', { class: 'krow__score', text: String(game[side].score) }) : null,
    );
    const when = game.status === 'live'
      ? `${game.periodLabel}`
      : game.status === 'scheduled' ? formatDayTime(game.scheduledAt) : formatDay(game.endedAt ?? game.scheduledAt);

    const link = el(
      'a',
      {
        class: 'krow__main',
        href: `/keeper?game=${encodeURIComponent(game.id)}`,
        on: {
          click: (event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            navigate(game.id);
          },
        },
      },
      el('span', { class: 'krow__top' }, el('span', { class: 'krow__sport', text: game.sportName }), statusBadge(game)),
      el('span', { class: 'krow__teams' }, team('home'), team('away')),
      el(
        'span',
        { class: 'krow__meta' },
        el('span', { text: when }),
        game.location ? el('span', { text: game.location }) : null,
        holderText(game) ? el('span', { class: ['krow__holder', mine && 'is-mine'], text: holderText(game) }) : null,
      ),
    );

    const actions = [];
    if (open && !game.scorekeeper) {
      actions.push(el('button', {
        type: 'button',
        class: 'btn btn--primary btn--lg',
        text: 'Claim',
        'aria-label': `Claim ${matchup(game)}`,
        on: {
          click: async (event) => {
            const result = await command(event.currentTarget, game.id, '/claim', {});
            if (result) {
              toast(`You’re keeping score for ${matchup(result.game)}.`, { tone: 'success' });
              navigate(game.id);
            }
          },
        },
      }));
    } else if (open && (mine || admin)) {
      actions.push(el('a', {
        class: 'btn btn--primary btn--lg',
        href: link.href,
        text: game.status === 'live' ? 'Score' : 'Open',
        on: { click: (event) => { event.preventDefault(); navigate(game.id); } },
      }));
      if (mine && (game.status === 'scheduled' || admin)) {
        actions.push(el('button', {
          type: 'button',
          class: 'btn btn--lg',
          text: 'Release',
          'aria-label': `Release ${matchup(game)}`,
          on: { click: (event) => command(event.currentTarget, game.id, '/release', {}) },
        }));
      }
    } else if (!open) {
      actions.push(el('a', { class: 'btn btn--lg', href: link.href, text: 'View', on: { click: (event) => { event.preventDefault(); navigate(game.id); } } }));
    }

    this.root.dataset.status = game.status;
    this.root.classList.toggle('is-mine', mine && open);
    clear(this.root, link, actions.length ? el('div', { class: 'krow__actions' }, actions) : null);
  }
}

class ListView {
  constructor() {
    this.rows = new Map();
    this.status = el('div', { class: 'status-slot' });
    this.loading = loadingState('Loading games…');
    this.sections = {
      live: listSection('Live now'),
      today: listSection('Today'),
      upcoming: listSection('Upcoming'),
      recent: listSection('Recently finished'),
    };
    this.empty = emptyState('No games on the schedule', 'Games appear here once an admin adds them.');
    this.root = el(
      'div',
      { class: 'keeper-list' },
      el('div', { class: 'page-head' }, el('h1', { class: 'page-title', text: 'Games' }), el('p', { class: 'page-sub', text: 'Claim a game to keep score. Only one person can score a game at a time.' })),
      this.status,
      this.loading,
      Object.values(this.sections).map((section) => section.root),
      this.empty,
    );
    document.title = `Scorekeeper · ${config.schoolName} Live Scores`;
    this.stopTick = null;
  }

  update() {
    const now = serverNow();
    const todayEnd = endOfDay(now);
    const games = store.all();
    const groups = {
      live: games.filter((g) => g.status === 'live').sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
      today: games.filter((g) => g.status === 'scheduled' && g.scheduledAt <= todayEnd && g.scheduledAt >= now - DAY_MS).sort((a, b) => a.scheduledAt - b.scheduledAt),
      upcoming: games.filter((g) => g.status === 'scheduled' && g.scheduledAt > todayEnd).sort((a, b) => a.scheduledAt - b.scheduledAt).slice(0, 60),
      recent: games
        .filter((g) => (g.status === 'final' || g.status === 'canceled') && (g.endedAt ?? g.scheduledAt) >= now - 2 * DAY_MS)
        .sort((a, b) => (b.endedAt ?? b.scheduledAt) - (a.endedAt ?? a.scheduledAt)),
    };

    const shown = new Set();
    let total = 0;
    for (const [key, list] of Object.entries(groups)) {
      const section = this.sections[key];
      const nodes = list.map((game) => {
        shown.add(game.id);
        let row = this.rows.get(game.id);
        if (!row) {
          row = new GameRow(game);
          this.rows.set(game.id, row);
        } else row.render(game);
        return row.root;
      });
      syncChildren(section.list, nodes);
      section.root.hidden = list.length === 0;
      section.count.textContent = list.length ? String(list.length) : '';
      total += list.length;
    }
    for (const id of [...this.rows.keys()]) if (!shown.has(id)) this.rows.delete(id);

    this.loading.hidden = loaded || listError !== null;
    this.empty.hidden = !loaded || total > 0;
    this.status.replaceChildren(listError ? errorNotice(`Couldn’t load the games: ${listError.message}`, { retry: () => resync() }) : '');
  }

  destroy() {}
}

// ---- console view -----------------------------------------------------------------

// A score correction (set_score) for a period or set the scorekeeper picks,
// the current one by default. Points mode: each team's total, the difference
// going into the picked period; for the current period the server takes a
// decrease it can't cover off the earlier periods, so `period` is left out
// then. Sets mode: the picked set's points.
//
// While the form is open, scores keep landing (this device's pad, another
// device). Inputs the user hasn't touched follow the game, and what is sent
// is the user's change applied to the latest score, so a correction never
// takes back a score it didn't show. It waits for this device's unsent score
// changes, whose effect on the totals isn't known until they land.
function scoreFixForm({ sets, final, onSubmit }) {
  const inputs = {};
  const fields = SIDES.map((side) => {
    inputs[side] = el('input', { class: 'input input--score', type: 'number', inputmode: 'numeric', min: 0, max: 9999, step: 1, required: true });
    inputs[side].addEventListener('input', () => dirty.add(side));
    const chip = el('span', { class: 'chip' });
    const label = el('label', { class: 'field fix-field' }, el('span', { class: 'field__label' }, chip, el('span', { class: 'fix-field__name' })), inputs[side]);
    return { side, label, chip };
  });
  const period = el('select', { class: 'select' });
  const periodField = el('label', { class: 'field fix-form__period' }, el('span', { class: 'field__label', text: sets ? 'Set' : 'Add the difference to' }), period);
  const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg', text: final ? 'Correct final score' : 'Apply' });
  const waiting = el('p', { class: 'control__hint', text: 'Waiting for score changes to be saved…', hidden: true });
  const form = el('form', { class: 'fix-form', novalidate: true }, periodField, fields.map((f) => f.label), submit);
  let game = null;
  let blocked = false;
  // What each input showed before the user edited it; the change sent is
  // measured from here.
  const shown = {};
  const dirty = new Set();

  // The value an input shows for the latest game: the total (points mode)
  // or the picked set's points.
  const current = (side, index) => (sets ? (game.line[index] ?? { home: 0, away: 0 })[side] : game[side].score);

  // Points mode: a period other than the current one can't go below 0, so
  // the total can't drop below what the other periods hold.
  const syncLimits = () => {
    const index = Number(period.value);
    for (const side of SIDES) {
      const entry = game.line[index] ?? { home: 0, away: 0 };
      inputs[side].min = index === game.period && !sets ? 0 : Math.max(0, shown[side] - entry[side]);
    }
  };

  const fill = (side, index) => {
    shown[side] = current(side, index);
    inputs[side].value = String(shown[side]);
  };

  const syncOptions = () => {
    const selected = period.value;
    const options = [];
    for (let index = game.period; index >= 0; index -= 1) {
      const label = periodInfoAt(game, index)?.label ?? String(index + 1);
      options.push(el('option', { value: String(index), text: index === game.period ? `${label} (${final ? 'last' : 'current'})` : label }));
    }
    period.replaceChildren(...options);
    period.value = selected !== '' && Number(selected) <= game.period ? selected : String(game.period);
    periodField.hidden = game.period === 0;
  };

  period.addEventListener('change', () => {
    // Sets mode shows the picked set's points.
    if (sets) {
      dirty.clear();
      for (const side of SIDES) fill(side, Number(period.value));
    }
    syncLimits();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (blocked || !form.reportValidity()) return;
    const index = Number(period.value);
    const value = (side) => Math.max(0, current(side, index) + Number(inputs[side].value) - shown[side]);
    onSubmit(value('home'), value('away'), !sets && index === game.period ? null : index);
  });
  const summaryText = sets ? 'Correct a set’s points' : final ? 'Correct the final score' : 'Correct the total score';
  const hintText = [
    final && 'Admins only. Updates the scoreboard; no notification is sent.',
    sets
      ? 'Sets the points of the set you pick.'
      : `Enter each team’s correct total; the difference goes into the period you pick. Taking away more than the ${final ? 'last period has' : 'current period has (here or with −1)'} comes off the earlier periods.`,
  ].filter(Boolean).join(' ');
  const details = el(
    'details',
    { class: 'disclosure' },
    el('summary', { class: 'disclosure__summary', text: summaryText }),
    el('div', { class: 'disclosure__body' }, el('p', { class: 'control__hint', text: hintText }), form, waiting),
  );
  return {
    details,
    prefill(latest) {
      game = latest;
      dirty.clear();
      period.value = '';
      for (const field of fields) {
        const team = game[field.side];
        updateTeamChip(field.chip, team);
        field.label.querySelector('.fix-field__name').textContent = team.name;
      }
      syncOptions();
      for (const side of SIDES) fill(side, Number(period.value));
      syncLimits();
      waiting.hidden = !blocked;
    },
    // A new version of the game, or this device's unsent changes, while the
    // form is open.
    sync(latest, unsentScoreChanges) {
      blocked = unsentScoreChanges;
      submit.disabled = blocked;
      waiting.hidden = !blocked || !details.open;
      if (!details.open || !game) return;
      game = latest;
      syncOptions();
      for (const side of SIDES) if (!dirty.has(side)) fill(side, Number(period.value));
      syncLimits();
    },
    close() {
      details.open = false;
    },
  };
}

class ConsoleView {
  constructor(id) {
    this.id = id;
    this.game = null;
    this.ui = null;
    this.rulesKey = '';
    this.destroyed = false;
    // Box score (§13): the player tapped on each team's pad, credited with the
    // next points or foul tapped there.
    this.selected = { home: null, away: null };
    this.root = el('div', { class: 'console' }, loadingState('Loading game…'));
    this.cleanups = [queue.subscribe(() => this.renderPending()), onTick(() => this.tick())];
    const cached = store.get(id);
    if (cached) this.setGame(cached);
    this.fetch();
  }

  async fetch() {
    try {
      const { game } = await api(gameApiPath(this.id));
      store.upsert(game);
      // The user may have left this game while the request was in flight;
      // rendering a destroyed view would take the wake lock again.
      if (this.destroyed) return;
      this.setGame(store.get(this.id) ?? game);
    } catch (err) {
      if (this.destroyed) return;
      if (err instanceof ApiError && err.status === 404) {
        toast('That game doesn’t exist anymore.', { tone: 'error' });
        navigate(null, { replace: true });
      } else if (err instanceof ApiError && err.status === 401) {
        location.assign(loginUrl());
      } else if (!this.game) {
        this.root.replaceChildren(errorNotice(`Couldn’t load this game: ${err.message}`, { retry: () => this.fetch() }));
      }
    }
  }

  update() {
    const latest = store.get(this.id);
    if (latest && (!this.game || latest.version > this.game.version)) this.setGame(latest);
  }

  destroy() {
    this.destroyed = true;
    for (const cleanup of this.cleanups) cleanup();
    setWakeLock(false);
  }

  setGame(game) {
    const previous = this.game;
    this.game = game;
    // The pads carry the team names and colors, and a tap scores for a side
    // (home/away), so they are rebuilt when an admin edits or swaps the
    // teams before the game (teams are locked once it is live).
    const teams = SIDES.map((side) => [game[side].name, game[side].code, game[side].color]);
    const rulesKey = JSON.stringify([game.sport, game.rules, teams]);
    if (!this.ui || rulesKey !== this.rulesKey) {
      const teamsChanged = previous && JSON.stringify(teams) !== JSON.stringify(SIDES.map((side) => [previous[side].name, previous[side].code, previous[side].color]));
      if (teamsChanged) toast(`The teams were changed: ${game.home.name} (home) vs ${game.away.name} (away).`, { timeoutMs: 8000 });
      this.rulesKey = rulesKey;
      this.build();
    }
    this.render(previous);
  }

  canScore() {
    return user.role === 'admin' || this.game.scorekeeper?.id === user.id;
  }

  // The scoreboard sets the score, clock and period right now.
  feedLocked() {
    return this.game.status === 'live' && Boolean(this.game.scoreboard?.controlling);
  }

  // ---- building ----

  build() {
    const game = this.game;
    const { rules } = game;
    const sets = isSetsMode(game);
    const hasBox = Boolean(rules.box && game.box);
    const ui = {};
    this.ui = ui;

    ui.title = el('h1', { class: 'console__title' });
    ui.syncLabel = el('span', { class: 'sync__label' });
    ui.sync = el('span', { class: 'sync', role: 'status', dataset: { state: 'idle' } }, el('span', { class: 'sync__icon', 'aria-hidden': 'true' }), ui.syncLabel);
    ui.syncAction = el('span', { class: 'sync__action' });
    ui.syncWrap = el('span', { class: 'console__sync' }, ui.sync, ui.syncAction);
    const toolbar = el(
      'div',
      { class: 'console__toolbar' },
      el('button', { type: 'button', class: 'btn btn--ghost btn--sm console__back', text: '‹ Games', on: { click: goBack } }),
      ui.title,
      ui.syncWrap,
    );

    ui.summary = {};
    const summaryTeam = (side) => {
      const chip = el('span', { class: 'chip' });
      const name = el('span', { class: 'summary__name' });
      const value = el('span', { class: 'summary__value' });
      const pending = el('span', { class: 'pending-tag', hidden: true });
      const sub = el('span', { class: 'summary__sub' });
      const root = el(
        'div',
        { class: ['summary__team', `summary__team--${side}`] },
        el('span', { class: 'summary__label' }, chip, name),
        el('span', { class: 'summary__scoreline', 'aria-live': 'polite', 'aria-atomic': 'true' }, value, pending),
        sub,
      );
      ui.summary[side] = { root, chip, name, value, pending, sub };
      return root;
    };
    ui.sumStatus = el('span', { class: 'badge' });
    ui.sumPeriod = el('span', { class: 'summary__period' });
    ui.sumClock = el('span', { class: 'summary__clock' });
    ui.sumOuts = outsIndicator();
    ui.sumNote = el('span', { class: 'note-pill' });
    const head = el(
      'div',
      { class: 'console__head' },
      toolbar,
      el(
        'div',
        { class: 'summary' },
        summaryTeam('home'),
        el('div', { class: 'summary__mid' }, ui.sumStatus, ui.sumPeriod, ui.sumClock, ui.sumOuts.root, ui.sumNote),
        summaryTeam('away'),
      ),
    );

    ui.holder = el('div', { class: 'holder' });

    // Scoreboard feed (ARCHITECTURE.md §11)
    ui.feedState = el('span', { class: 'control__state' });
    ui.feedText = el('p', { class: 'feed__text', 'aria-live': 'polite' });
    ui.feedHint = el('p', {
      class: 'control__hint',
      text: hasBox
        ? 'Players’ points and fouls, notes and End game stay with you. If the scoreboard is down or wrong, score by hand.'
        : 'Notes and End game stay with you. If the scoreboard is down or wrong, score by hand.',
    });
    ui.feedManual = el('button', { type: 'button', class: 'btn', text: 'Score by hand', on: { click: (event) => this.setFeedManual(event.currentTarget, true) } });
    ui.feedAuto = el('button', { type: 'button', class: 'btn btn--primary', text: 'Use the scoreboard', on: { click: (event) => this.setFeedManual(event.currentTarget, false) } });
    ui.feedActions = el('div', { class: 'feed__actions' }, ui.feedManual, ui.feedAuto);
    ui.feed = el('section', { class: 'control feed' }, el('h2', { class: 'control__title' }, 'Scoreboard', ui.feedState), ui.feedText, ui.feedHint, ui.feedActions);
    // Controls the scoreboard takes over while it drives the game.
    ui.feedLocks = [];
    const feedLock = (node) => {
      const lock = el('fieldset', { class: 'feed-lock' }, node);
      ui.feedLocks.push(lock);
      return lock;
    };

    // Pre-game
    ui.start = el('button', { type: 'button', class: 'btn btn--go btn--xl btn--block', text: 'Start game', on: { click: () => this.start() } });
    ui.startHint = el('p', { class: 'control__hint control__hint--center' });
    ui.startLead = el('p', { class: 'control__lead' });
    ui.pregame = el(
      'section',
      { class: 'control control--pregame' },
      el('h2', { class: 'control__title', text: 'Before the game' }),
      ui.startLead,
      ui.start,
      ui.startHint,
    );

    // Scoring pads
    ui.pads = {};
    ui.padButtons = {};
    ui.padBox = hasBox ? {} : null;
    const pad = (side) => {
      const team = game[side];
      const buttons = rules.scoring.map((entry) => {
        const showPoints = entry.label !== `+${entry.points}`;
        return el(
          'button',
          {
            type: 'button',
            class: 'score-btn',
            'aria-label': `${entry.label}${showPoints ? ` (+${entry.points})` : ''} for ${team.name}`,
            on: { click: () => this.score(side, entry.points) },
          },
          el('span', { class: 'score-btn__label', text: entry.label }),
          showPoints ? el('span', { class: 'score-btn__points', text: `+${entry.points}` }) : null,
        );
      });
      const minus = el(
        'button',
        { type: 'button', class: 'score-btn score-btn--minus', 'aria-label': `Take one point away from ${team.name}`, on: { click: () => this.score(side, -1) } },
        el('span', { class: 'score-btn__label', text: '−1' }),
        el('span', { class: 'score-btn__points', text: 'Fix' }),
      );
      const box = hasBox ? this.buildPadBox(side, team) : null;
      const root = el(
        'section',
        { class: 'pad', 'aria-label': `${team.name} scoring` },
        el('div', { class: 'pad__head' }, teamChip(team), el('span', { class: 'pad__name', text: team.name }), el('span', { class: 'pad__side', text: side === 'home' ? 'Home' : 'Away' })),
        box?.roster ?? null,
        el('div', { class: 'pad__buttons' }, buttons, minus),
        box?.row ?? null,
      );
      applyTeamColor(root, team.color);
      ui.pads[side] = root;
      ui.padButtons[side] = [...buttons, minus];
      if (box) ui.padBox[side] = box;
      return root;
    };

    const controls = [];

    // Clock
    if (rules.clock?.available) {
      ui.clockDisplay = el('div', { class: 'clock-display' });
      ui.clockState = el('span', { class: 'control__state' });
      ui.clockToggle = el('button', { type: 'button', class: 'btn btn--xl clock-toggle', on: { click: () => this.toggleClock() } });
      ui.clockSetOpen = el('button', { type: 'button', class: 'btn btn--xl', text: 'Set time', on: { click: () => this.openClockSet() } });
      ui.clockMin = el('input', { class: 'input input--clock', type: 'number', inputmode: 'numeric', min: 0, max: 60, step: 1, required: true, 'aria-label': 'Minutes' });
      ui.clockSec = el('input', { class: 'input input--clock', type: 'number', inputmode: 'numeric', min: 0, max: 59, step: 1, required: true, 'aria-label': 'Seconds' });
      ui.clockForm = el(
        'form',
        { class: 'clock-set', hidden: true, novalidate: true },
        el('div', { class: 'clock-set__inputs' }, ui.clockMin, el('span', { class: 'clock-set__colon', 'aria-hidden': 'true', text: ':' }), ui.clockSec),
        el('div', { class: 'clock-set__actions' },
          el('button', { type: 'button', class: 'btn btn--lg', text: 'Cancel', on: { click: () => this.closeClockSet() } }),
          el('button', { type: 'submit', class: 'btn btn--primary btn--lg', text: 'Set clock' })),
      );
      ui.clockForm.addEventListener('submit', (event) => {
        event.preventDefault();
        this.setClock();
      });
      ui.clockBody = el('div', { class: 'clock-body' }, ui.clockDisplay, el('div', { class: 'clock-actions' }, ui.clockToggle, ui.clockSetOpen), ui.clockForm);
      ui.noClock = el('p', { class: 'control__hint', text: 'No game clock this period.' });
      ui.clock = el('section', { class: 'control control--clock' }, el('h2', { class: 'control__title' }, 'Game clock', ui.clockState), ui.clockBody, ui.noClock);
      controls.push(feedLock(ui.clock));
    }

    // Period
    const periodWord = sets ? 'Set' : isHalfInnings(rules) ? 'Inning' : 'Period';
    ui.prevLabel = el('span', { class: 'period-btn__label' });
    ui.nextLabel = el('span', { class: 'period-btn__label' });
    ui.prev = el('button', { type: 'button', class: 'btn btn--lg period-btn', on: { click: () => this.period(-1) } }, el('span', { class: 'period-btn__dir', text: '‹ Back' }), ui.prevLabel);
    ui.next = el('button', { type: 'button', class: 'btn btn--lg btn--primary period-btn', on: { click: () => this.period(1) } }, el('span', { class: 'period-btn__dir', text: 'Next ›' }), ui.nextLabel);
    ui.periodNow = el('div', { class: 'period-now' });
    controls.push(feedLock(el('section', { class: 'control' }, el('h2', { class: 'control__title', text: periodWord }), el('div', { class: 'period-row' }, ui.prev, ui.periodNow, ui.next))));

    // Outs (baseball)
    if (rules.tracksOuts) {
      ui.outs = outsIndicator();
      ui.outs.root.classList.add('outs--lg');
      ui.outMinus = el('button', { type: 'button', class: 'btn btn--lg', text: '− Out', 'aria-label': 'Remove an out', on: { click: () => this.outs(-1) } });
      ui.outPlusHint = el('span', { class: 'period-btn__label' });
      ui.outPlus = el('button', { type: 'button', class: 'btn btn--lg btn--primary period-btn', 'aria-label': 'Add an out', on: { click: () => this.outs(1) } }, el('span', { class: 'period-btn__dir', text: '+ Out' }), ui.outPlusHint);
      controls.push(el('section', { class: 'control' }, el('h2', { class: 'control__title', text: 'Outs' }), el('div', { class: 'outs-row' }, ui.outMinus, ui.outs.root, ui.outPlus)));
    }

    // Notes
    // A sport may come without preset notes; the custom note still works.
    // With a box score, team timeouts (on the pads) replace the Timeout note.
    const notes = (rules.notes ?? []).filter((text) => !(hasBox && text === 'Timeout'));
    ui.noteChips = notes.map((text) => el('button', { type: 'button', class: 'chip-btn', 'aria-pressed': 'false', text, on: { click: () => this.note(this.game.note === text ? '' : text) } }));
    ui.noteClear = el('button', { type: 'button', class: 'chip-btn chip-btn--clear', text: 'Clear note', on: { click: () => this.note('') } });
    ui.noteInput = el('input', { class: 'input', type: 'text', maxLength: 40, placeholder: 'Custom note', autocomplete: 'off', enterKeyHint: 'send', 'aria-label': 'Custom note, up to 40 characters' });
    const noteForm = el('form', { class: 'inline-form' }, ui.noteInput, el('button', { type: 'submit', class: 'btn btn--lg', text: 'Show' }));
    noteForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = ui.noteInput.value.trim();
      if (!text) return;
      this.note(text);
      ui.noteInput.value = '';
      ui.noteInput.blur();
    });
    controls.push(el(
      'section',
      { class: 'control' },
      el('h2', { class: 'control__title', text: 'Status note' }),
      el('div', { class: 'chips' }, ui.noteChips, ui.noteClear),
      noteForm,
    ));

    // Corrections
    ui.undo = el('button', { type: 'button', class: 'btn btn--lg btn--block', text: 'Undo last change', on: { click: () => this.undo() } });
    ui.fix = scoreFixForm({ sets, final: false, onSubmit: (home, away, period) => this.setScore(home, away, period) });
    ui.fix.details.addEventListener('toggle', () => {
      if (ui.fix.details.open) ui.fix.prefill(this.game);
    });
    // A disabled fieldset doesn't stop a <summary> from opening its form.
    ui.fixSummary = ui.fix.details.querySelector('summary');
    ui.fixSummary.addEventListener('click', (event) => {
      if (this.feedLocked()) event.preventDefault();
    });
    controls.push(feedLock(el('section', { class: 'control' }, el('h2', { class: 'control__title', text: 'Corrections' }), ui.undo, ui.fix.details)));

    // End
    ui.end = el('button', { type: 'button', class: 'btn btn--danger btn--xl btn--block', text: 'End game', on: { click: () => this.end() } });
    ui.endHint = el('p', { class: 'control__hint control__hint--center' });
    controls.push(el('section', { class: 'control control--end' }, ui.end, ui.endHint));

    ui.fieldset = el('fieldset', { class: 'console__fieldset' }, el('legend', { class: 'sr-only', text: 'Scoring controls' }),
      el('div', { class: 'console__scoring' }, hasBox
        // The pads stay open while the scoreboard runs the game: their
        // buttons credit players then (renderPadBox locks the rest).
        ? el('div', { class: 'pads' }, pad('home'), pad('away'))
        : feedLock(el('div', { class: 'pads' }, pad('home'), pad('away'))), el('div', { class: 'console__controls' }, controls)));
    ui.scoring = ui.fieldset;

    // Final / canceled
    ui.finalTitle = el('h2', { class: 'control__title' });
    ui.finalText = el('p', { class: 'control__lead' });
    ui.finalFix = scoreFixForm({ sets, final: true, onSubmit: (home, away, period) => this.setScore(home, away, period) });
    ui.finalFix.details.addEventListener('toggle', () => {
      if (ui.finalFix.details.open) ui.finalFix.prefill(this.game);
    });
    ui.final = el('section', { class: 'control' }, ui.finalTitle, ui.finalText, ui.finalFix.details);

    ui.line = el('section', { class: 'console__line', 'aria-label': 'Line score' });
    ui.lineKey = '';
    ui.roster = hasBox ? this.buildRoster() : null;
    ui.boxScore = hasBox ? el('section', { class: 'console__box', 'aria-label': 'Box score' }) : null;
    ui.boxKey = '';

    // Rosters: under Start before the game, under the pads during it.
    this.root.replaceChildren(...[head, ui.holder, ui.feed, ui.pregame, ui.scoring, ui.roster, ui.final, ui.line, ui.boxScore].filter(Boolean));
  }

  // A team pad's box score part (§13): its players to tap before points or a
  // foul, then Foul, the team's fouls and bonus, and Timeout.
  buildPadBox(side, team) {
    const players = el('div', { class: 'pad__players', role: 'group', 'aria-label': `${team.name} players` });
    const hint = el('p', { class: 'pad__hint', 'aria-live': 'polite' });
    const foul = el('button', { type: 'button', class: 'btn btn--lg pad__foul', text: 'Foul', on: { click: () => this.foul(side, 1) } });
    const foulFix = el('button', { type: 'button', class: 'btn btn--lg', text: '−1', on: { click: () => this.foul(side, -1) } });
    const stats = el('div', { class: 'pad__stats' });
    const timeout = el('button', { type: 'button', class: 'btn btn--lg pad__timeout', on: { click: () => this.timeout(side) } });
    const row = el('div', { class: 'pad__box' }, el('div', { class: 'pad__fouls' }, foul, foulFix), stats, timeout);
    return { roster: el('div', { class: 'pad__roster' }, players, hint), row, players, hint, foul, foulFix, stats, timeout, chips: new Map(), key: null };
  }

  // Rosters (§13): typed in before the game, fixed or added to during it.
  buildRoster() {
    const game = this.game;
    const ui = this.ui;
    ui.rosterTeams = {};
    const team = (side) => {
      const t = game[side];
      const list = el('ul', { class: 'roster__list' });
      const number = el('input', {
        class: 'input roster__number', type: 'text', inputmode: 'numeric', maxLength: 2, placeholder: '#', autocomplete: 'off', 'aria-label': `${t.name} player number`,
      });
      const name = el('input', {
        class: 'input roster__name', type: 'text', maxLength: 40, placeholder: 'Player name', autocomplete: 'off', enterKeyHint: 'done', 'aria-label': `${t.name} player name`,
      });
      const form = el('form', { class: 'roster__add', novalidate: true }, number, name, el('button', { type: 'submit', class: 'btn btn--primary', text: 'Add' }));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        this.addPlayer(side, number, name);
      });
      for (const input of [number, name]) input.addEventListener('input', () => input.setCustomValidity(''));
      const root = el('div', { class: 'roster__team' }, el('h3', { class: 'roster__title' }, teamChip(t), el('span', { text: t.name })), list, form);
      ui.rosterTeams[side] = { list, number, name, form, key: null };
      return root;
    };
    ui.rosterHint = el('p', { class: 'control__hint' });
    const details = el('details', { class: 'control roster' }, el('summary', { class: 'roster__summary' }, el('h2', { class: 'control__title', text: 'Rosters' })), ui.rosterHint, el('div', { class: 'roster__teams' }, team('home'), team('away')));
    ui.rosterTouched = false;
    details.querySelector('summary').addEventListener('click', () => {
      ui.rosterTouched = true;
    });
    return details;
  }

  // ---- rendering ----

  render(previous) {
    const game = this.game;
    const ui = this.ui;
    const live = game.status === 'live';
    const sets = isSetsMode(game);
    const started = hasStarted(game);

    ui.title.textContent = game.sportName;
    document.title = `${matchup(game)} · Scorekeeper`;

    for (const side of SIDES) {
      const team = game[side];
      const s = ui.summary[side];
      updateTeamChip(s.chip, team);
      s.name.textContent = team.name;
      if (game.box && live) {
        s.sub.replaceChildren(teamStats(game, side, { compact: true }));
        s.sub.hidden = false;
      } else {
        s.sub.textContent = sets && started ? `Sets ${team.score}` : '';
        s.sub.hidden = !(sets && started);
      }
    }
    ui.sumStatus.className = `badge badge--${game.status}`;
    ui.sumStatus.textContent = live ? 'Live' : game.status === 'scheduled' ? 'Upcoming' : finalLabel(game);
    ui.sumPeriod.textContent = live ? game.periodLabel : game.status === 'scheduled' ? formatDayTime(game.scheduledAt) : '';
    ui.sumPeriod.hidden = ui.sumPeriod.textContent === '';
    ui.sumClock.hidden = !(live && game.clock);
    ui.sumClock.classList.toggle('is-stopped', Boolean(game.clock && !game.clock.running));
    ui.sumOuts.root.hidden = !(live && game.outs !== null && game.outs !== undefined);
    if (!ui.sumOuts.root.hidden) ui.sumOuts.update(game.outs);
    const note = displayNote(game);
    ui.sumNote.textContent = note;
    ui.sumNote.hidden = !(live && note);
    ui.sumNote.classList.toggle('note-pill--timeout', Boolean(live && game.box?.timeout));

    ui.pregame.hidden = game.status !== 'scheduled';
    ui.scoring.hidden = !live;
    ui.final.hidden = !(game.status === 'final' || game.status === 'canceled');

    this.renderHolder();
    this.renderFeed();
    if (game.status === 'scheduled') this.renderPregame();
    if (live) this.renderScoring();
    if (!ui.final.hidden) this.renderFinal();

    const lineKey = `${game.version}`;
    if (started && ui.lineKey !== lineKey) {
      ui.line.replaceChildren(lineScoreTable(game));
      ui.lineKey = lineKey;
    }
    ui.line.hidden = !started;
    if (ui.boxScore) {
      const boxKey = `${game.version}`;
      if (ui.boxKey !== boxKey) {
        const table = boxScore(game);
        ui.boxScore.replaceChildren(...(table ? [el('h2', { class: 'console__box-title', text: 'Box score' }), table] : []));
        ui.boxKey = boxKey;
      }
      ui.boxScore.hidden = !(started && ui.boxScore.childElementCount > 0);
    }

    setWakeLock(live || game.status === 'scheduled');
    if (previous && previous.status !== game.status) window.scrollTo({ top: 0 });
    this.renderPending();
    this.tick();
  }

  renderHolder() {
    const game = this.game;
    const ui = this.ui;
    const holder = game.scorekeeper;
    const mine = holder?.id === user.id;
    const admin = user.role === 'admin';
    if (game.status !== 'live' && game.status !== 'scheduled') {
      ui.holder.hidden = true;
      return;
    }
    ui.holder.hidden = false;
    let text;
    const buttons = [];
    if (!holder) {
      text = game.status === 'live' ? 'Nobody is keeping score for this live game.' : 'Nobody has claimed this game yet.';
      buttons.push(el('button', {
        type: 'button',
        class: 'btn btn--primary',
        text: 'Claim game',
        on: { click: (event) => command(event.currentTarget, game.id, '/claim', {}) },
      }));
    } else if (mine) {
      text = 'You’re keeping score.';
      if (game.status === 'scheduled' || admin) {
        buttons.push(el('button', { type: 'button', class: 'btn', text: 'Release', on: { click: (event) => command(event.currentTarget, game.id, '/release', {}) } }));
      }
    } else {
      text = admin ? `${holder.name} is keeping score.` : `${holder.name} is keeping score. Ask them or an admin to release it if you need to take over.`;
      if (admin) buttons.push(el('button', { type: 'button', class: 'btn btn--primary', text: 'Take over', on: { click: (event) => this.takeOver(event.currentTarget) } }));
    }
    ui.holder.dataset.state = mine ? 'mine' : holder ? 'other' : 'none';
    clear(ui.holder, el('p', { class: 'holder__text', text }), buttons.length ? el('div', { class: 'holder__actions' }, buttons) : null);
  }

  // Shown while the game will use, or uses, a scoreboard. Updated in place so
  // the message is announced only when it changes.
  renderFeed() {
    const game = this.game;
    const ui = this.ui;
    const feed = game.scoreboard;
    const before = game.status === 'scheduled';
    ui.feed.hidden = !((before || game.status === 'live') && feed?.eligible && feed.setting !== 'off' && feed.address !== null);
    if (ui.feed.hidden) return;
    // Before the start the server's message says the scoreboard will be read,
    // even for a game already switched to scoring by hand.
    const state = before ? (feed.manual ? 'manual' : 'idle') : feed.state;
    const text = before && feed.manual ? 'This game will be scored by hand. The scoreboard isn’t read.' : feed.message;
    const canSwitch = this.canScore();
    ui.feed.dataset.state = state;
    ui.feedState.textContent = FEED_STATE_LABELS[state] ?? '';
    ui.feedState.hidden = ui.feedState.textContent === '';
    if (ui.feedText.textContent !== text) ui.feedText.textContent = text;
    ui.feedHint.hidden = !(canSwitch && feed.controlling);
    ui.feedManual.hidden = !(canSwitch && !feed.manual && (feed.controlling || before));
    // A game a newer live game took the scoreboard from stays scored by hand
    // until that game ends (§11): the server would release it again.
    ui.feedAuto.hidden = !(canSwitch && feed.manual && state !== 'standby');
    ui.feedActions.hidden = ui.feedManual.hidden && ui.feedAuto.hidden;
  }

  renderPregame() {
    const game = this.game;
    const ui = this.ui;
    const admin = user.role === 'admin';
    const otherHolder = game.scorekeeper && game.scorekeeper.id !== user.id;
    const now = serverNow();
    const locked = !admin && now < game.canStartAt;
    let hint;
    if (otherHolder && !admin) hint = `${game.scorekeeper.name} will start this game.`;
    else if (locked) {
      const day = formatDay(game.canStartAt, { now });
      hint = `Unlocks at ${formatTime(game.canStartAt)}${day === 'Today' ? '' : ` ${day.toLowerCase() === 'tomorrow' ? 'tomorrow' : `on ${day}`}`} — in ${formatDuration(game.canStartAt - now)}. Scheduled for ${formatDayTime(game.scheduledAt)}.`;
    } else if (admin && now < game.canStartAt) hint = `Scheduled for ${formatDayTime(game.scheduledAt)}. As an admin you can start it early.`;
    else hint = `Scheduled for ${formatDayTime(game.scheduledAt)}.`;
    if (ui.startHint.textContent !== hint) ui.startHint.textContent = hint;
    // A game the scoreboard starts by itself (§11) needs no tap.
    const how = startsByItself(game.scoreboard)
      ? 'The scoreboard starts this game by itself once it’s on and the start time has come. Tap Start game only to start it yourself.'
      : 'Tap Start game when play begins.';
    const lead = `${how} The game goes live on the web, in the MCHS app and on the Lock Screen of every iPhone with Live Activities on.`;
    if (ui.startLead.textContent !== lead) ui.startLead.textContent = lead;
    if (!ui.start.hasAttribute('aria-busy')) ui.start.disabled = Boolean(otherHolder && !admin) || locked;
  }

  renderScoring() {
    const game = this.game;
    const ui = this.ui;
    const { rules } = game;
    ui.fieldset.disabled = !this.canScore();
    const locked = this.feedLocked();
    for (const lock of ui.feedLocks) lock.disabled = locked;
    ui.fixSummary.setAttribute('aria-disabled', String(locked));
    if (locked) {
      this.closeClockSet();
      ui.fix.close();
    }

    if (ui.clock) {
      ui.clock.hidden = !game.options.clockEnabled;
      ui.clockBody.hidden = !game.clock;
      ui.noClock.hidden = Boolean(game.clock);
      if (!game.clock) this.closeClockSet();
    }

    const prev = periodInfoAt(game, game.period - 1);
    const next = periodInfoAt(game, game.period + 1);
    ui.prevLabel.textContent = prev?.label ?? '—';
    ui.nextLabel.textContent = next?.label ?? 'No more';
    ui.prev.disabled = game.period <= 0;
    ui.next.disabled = game.period >= maxPeriodIndex(rules);
    ui.prev.setAttribute('aria-label', prev ? `Back to ${prev.label}` : 'Back');
    ui.next.setAttribute('aria-label', next ? `Next: ${next.label}` : 'No more periods');
    ui.periodNow.replaceChildren(el('span', { class: 'period-now__short', text: game.periodShort }), el('span', { class: 'period-now__label', text: game.periodLabel }));

    if (ui.outs) {
      ui.outs.update(game.outs);
      ui.outMinus.disabled = game.outs <= 0;
      ui.outPlusHint.textContent = game.outs >= 2 ? `3rd out → ${next?.label ?? 'next'}` : `${game.outs + 1} ${game.outs + 1 === 1 ? 'out' : 'outs'}`;
    }

    for (const chip of ui.noteChips) chip.setAttribute('aria-pressed', String(chip.textContent === game.note));
    ui.noteClear.disabled = !game.note;

    if (ui.padBox) for (const side of SIDES) this.renderPadBox(side);
  }

  // A pad's players (rebuilt when the roster changes), which one is tapped,
  // the team's fouls, bonus and timeouts. While the scoreboard runs the game
  // the points buttons and Foul credit the tapped player only.
  renderPadBox(side) {
    const game = this.game;
    const ui = this.ui;
    const pad = ui.padBox?.[side];
    if (!pad || !game.box) return;
    const locked = this.feedLocked();
    const players = game.box.players[side];
    const key = JSON.stringify(players.map((p) => [p.id, p.number, p.name]));
    if (pad.key !== key) {
      pad.key = key;
      pad.chips.clear();
      pad.players.replaceChildren(...players.map((player) => {
        const chip = el(
          'button',
          { type: 'button', class: 'player-chip', 'aria-pressed': 'false', on: { click: () => this.select(side, player.id) } },
          el('span', { class: 'player-chip__number', text: `#${player.number}` }),
          el('span', { class: 'player-chip__name', text: shortName(player.name) }),
          el('span', { class: 'player-chip__fouls' }),
        );
        pad.chips.set(player.id, chip);
        return chip;
      }));
    }
    if (this.selected[side] && !players.some((p) => p.id === this.selected[side])) this.selected[side] = null;
    const selected = this.selected[side];
    for (const player of players) {
      const chip = pad.chips.get(player.id);
      chip.setAttribute('aria-pressed', String(selected === player.id));
      chip.classList.toggle('is-out', player.fouledOut);
      chip.querySelector('.player-chip__fouls').textContent = player.fouls > 0 ? `${player.fouls}F` : '';
      chip.setAttribute('aria-label', `#${player.number} ${player.name}: ${player.points} ${player.points === 1 ? 'point' : 'points'}, ${player.fouls} ${player.fouls === 1 ? 'foul' : 'fouls'}${player.fouledOut ? ', fouled out' : ''}`);
    }
    pad.players.hidden = players.length === 0;
    const picked = players.find((p) => p.id === selected);
    let hint;
    if (players.length === 0) hint = locked ? 'Add players under Rosters to credit their points and fouls.' : 'Add players under Rosters to credit points and fouls to them.';
    else if (picked) hint = `#${picked.number} ${picked.name}: tap points or Foul.`;
    else hint = locked ? 'The scoreboard keeps the team score. Tap a player, then their points or Foul.' : 'Tap a player first to credit them, or just tap points.';
    if (pad.hint.textContent !== hint) pad.hint.textContent = hint;

    for (const button of ui.padButtons[side]) button.disabled = locked && !selected;
    pad.foul.disabled = locked && !selected;
    pad.foulFix.disabled = locked && !selected;
    pad.foul.setAttribute('aria-label', picked ? `Foul on #${picked.number} ${picked.name}` : `Team foul on ${game[side].name}`);
    pad.foulFix.setAttribute('aria-label', picked ? `Take a foul back from #${picked.number} ${picked.name}` : `Take a team foul back from ${game[side].name}`);

    const box = game.box;
    const left = box.timeoutsLeft[side];
    const fouls = box.fouls[side];
    pad.stats.replaceChildren(...[
      el('span', { class: 'pad__stat', text: `${fouls} team ${fouls === 1 ? 'foul' : 'fouls'}` }),
      box.bonus[side] ? el('span', { class: 'bonus-badge', text: 'Bonus' }) : null,
      locked ? el('span', { class: 'pad__stat', text: `${left} ${left === 1 ? 'timeout' : 'timeouts'} left` }) : null,
      locked ? el('span', { class: 'pad__stat pad__stat--source', text: 'From the scoreboard' }) : null,
    ].filter(Boolean));
    pad.timeout.hidden = locked;
    const on = box.timeout === side;
    pad.timeout.textContent = on ? 'End timeout' : `Timeout · ${left} left`;
    pad.timeout.classList.toggle('btn--stop', on);
    pad.timeout.disabled = !on && left <= 0;
    pad.timeout.setAttribute('aria-label', on ? `End ${game[side].name}’s timeout` : `Timeout ${game[side].name}, ${left} left`);
  }

  // Rosters: who may change them, and the players with any still being saved.
  renderRoster() {
    const game = this.game;
    const ui = this.ui;
    if (!ui?.roster || !game.box) return;
    const open = game.status === 'scheduled' || game.status === 'live';
    ui.roster.hidden = !open;
    if (!open) return;
    // Open before the game (that's when they're typed in), closed once it's
    // live, unless the scorekeeper opened or closed it themselves.
    if (!ui.rosterTouched) ui.roster.open = game.status === 'scheduled';
    const editable = this.canScore();
    const hint = editable
      ? 'Type in each team’s players before the game. During it, tap a player on the team’s pad before their points or foul.'
      : game.scorekeeper ? `Only ${game.scorekeeper.name} or an admin can change the rosters.` : 'Claim the game to type in the rosters.';
    if (ui.rosterHint.textContent !== hint) ui.rosterHint.textContent = hint;
    const pending = queue.pendingFor(this.id).filter((item) => item.body.type === 'roster');
    for (const side of SIDES) {
      const team = ui.rosterTeams[side];
      const players = game.box.players[side];
      const adds = pending.filter((item) => item.body.op === 'add' && item.body.team === side);
      const key = JSON.stringify([players.map((p) => [p.id, p.number, p.name, p.points, p.fouls]), adds.map((item) => [item.body.number, item.body.name]), editable]);
      team.form.hidden = !editable;
      if (team.key === key) continue;
      team.key = key;
      const rows = players.map((player) => el(
        'li',
        { class: 'roster__player' },
        el('span', { class: 'roster__num', text: `#${player.number}` }),
        el('span', { class: 'roster__pname', text: player.name }),
        editable ? el('button', { type: 'button', class: 'btn btn--sm btn--ghost', text: 'Edit', 'aria-label': `Edit #${player.number} ${player.name}`, on: { click: () => this.editPlayer(side, player) } }) : null,
        // Players with points or fouls stay (the server refuses): fix them instead.
        editable && player.points === 0 && player.fouls === 0
          ? el('button', { type: 'button', class: 'btn btn--sm btn--ghost', text: 'Remove', 'aria-label': `Remove #${player.number} ${player.name}`, on: { click: () => this.rosterAction({ op: 'remove', team: side, player: player.id }) } })
          : null,
      ));
      for (const item of adds) {
        rows.push(el('li', { class: 'roster__player is-pending' }, el('span', { class: 'roster__num', text: `#${item.body.number}` }), el('span', { class: 'roster__pname', text: item.body.name }), el('span', { class: 'pending-tag', text: 'Saving…' })));
      }
      if (rows.length === 0) rows.push(el('li', { class: 'roster__empty', text: 'No players yet.' }));
      team.list.replaceChildren(...rows);
    }
  }

  renderFinal() {
    const game = this.game;
    const ui = this.ui;
    ui.finalTitle.textContent = game.status === 'final' ? finalLabel(game) : 'Canceled';
    ui.finalText.textContent = game.status === 'final'
      ? `${scoreLine(game)}. The final score was sent to Lock Screens.`
      : 'This game was canceled.';
    ui.finalFix.details.hidden = !(game.status === 'final' && user.role === 'admin');
  }

  // Score taps waiting to be sent are shown on top of the server's score so
  // the scorekeeper sees each tap land, even on a slow connection.
  renderPending() {
    const ui = this.ui;
    const game = this.game;
    if (!ui || !game) return;
    const pending = queue.pendingFor(this.id);
    const sets = isSetsMode(game);
    this.renderRoster();
    const unsentScoreChanges = pending.some((item) => ['score', 'set_score', 'undo'].includes(item.body.type));
    ui.fix.sync(game, unsentScoreChanges);
    ui.finalFix.sync(game, unsentScoreChanges);
    for (const side of SIDES) {
      const delta = pending.reduce((sum, item) => (item.body.type === 'score' && item.body.team === side ? sum + item.body.points : sum), 0);
      const base = sets && game.status === 'live' ? game[side].setScore ?? 0 : game[side].score;
      const s = ui.summary[side];
      s.value.parentElement.hidden = !hasStarted(game);
      s.value.textContent = String(Math.max(0, base + delta));
      s.value.classList.toggle('is-pending', delta !== 0);
      s.pending.hidden = delta === 0;
      s.pending.textContent = delta > 0 ? `+${delta}` : String(delta);
    }

    const state = pending.length === 0 && queue.status !== 'blocked' ? 'idle' : queue.status;
    ui.sync.dataset.state = state;
    // Problems get a full-width row so the message and Retry fit on a phone.
    ui.syncWrap.classList.toggle('is-alert', state === 'retrying' || state === 'offline' || state === 'blocked');
    const n = pending.length;
    const waiting = `${n} ${n === 1 ? 'change' : 'changes'} waiting`;
    ui.syncLabel.textContent = {
      idle: 'All changes saved',
      sending: 'Saving…',
      retrying: `Can’t reach the server · ${waiting}`,
      offline: `Offline · ${waiting}`,
      blocked: `Signed out · ${waiting}`,
    }[state] ?? 'Saving…';
    if (state === 'blocked') {
      ui.syncAction.replaceChildren(
        el('a', { class: 'btn btn--sm', href: loginUrl('/keeper'), target: '_blank', rel: 'noopener', text: 'Sign in' }),
        el('button', { type: 'button', class: 'btn btn--sm', text: 'Retry', on: { click: () => queue.retryNow() } }),
      );
    } else if (state === 'retrying' || state === 'offline') {
      ui.syncAction.replaceChildren(el('button', { type: 'button', class: 'btn btn--sm', text: 'Retry now', on: { click: () => queue.retryNow() } }));
    } else {
      ui.syncAction.replaceChildren();
    }

    if (ui.clockToggle && game.clock) {
      const running = this.expectedClockRunning();
      const remaining = this.displayRemainingMs();
      const starting = running && !game.clock.running;
      ui.clockToggle.textContent = running ? 'Stop clock' : 'Start clock';
      ui.clockToggle.classList.toggle('btn--stop', running);
      ui.clockToggle.classList.toggle('btn--go', !running);
      ui.clockToggle.disabled = !running && remaining <= 0 && !pending.some((item) => item.body.type === 'clock' && item.body.op === 'set');
      // A Start only takes effect when it reaches the server.
      ui.clockState.textContent = starting ? 'Starting…' : running ? 'Running' : 'Stopped';
      ui.clockState.dataset.running = String(running && !starting);
    }

    if (ui.end && game.status === 'live') {
      ui.end.disabled = n > 0;
      ui.endHint.textContent = n > 0 ? 'Waiting for changes to be saved before the game can end…' : 'Sends the final score to every Lock Screen.';
    }
  }

  tick() {
    const game = this.game;
    const ui = this.ui;
    if (!ui || !game) return;
    if (game.status === 'live' && game.clock) {
      const remaining = this.displayRemainingMs();
      const text = formatClock(remaining);
      if (ui.sumClock.textContent !== text) ui.sumClock.textContent = text;
      if (ui.clockDisplay && ui.clockDisplay.textContent !== text) {
        ui.clockDisplay.textContent = text;
        if (game.clock.running && remaining <= 0) this.renderPending();
      }
    }
    if (game.status === 'scheduled') this.renderPregame();
  }

  // ---- actions ----

  enqueue(action) {
    if (!this.game || this.game.status !== 'live' || !this.canScore()) return;
    if (this.feedLocked() && FEED_ACTION_TYPES.has(action.type)) return;
    queue.enqueue(this.id, action);
  }

  score(side, points) {
    haptic();
    const player = this.takeSelected(side);
    // The scoreboard keeps the team score: only the player's points (§13).
    if (this.game.box && this.feedLocked()) {
      if (player) this.enqueue({ type: 'player_points', team: side, player, points });
      return;
    }
    this.enqueue(player ? { type: 'score', team: side, points, player } : { type: 'score', team: side, points });
  }

  // ---- box score (§13) ----

  select(side, playerId) {
    haptic();
    this.selected[side] = this.selected[side] === playerId ? null : playerId;
    this.renderPadBox(side);
  }

  // The player tapped on a pad, now used up by the points or foul tapped.
  takeSelected(side) {
    const player = this.selected[side];
    if (!player) return null;
    this.selected[side] = null;
    this.renderPadBox(side);
    return player;
  }

  foul(side, delta) {
    haptic();
    const player = this.takeSelected(side);
    if (this.feedLocked() && !player) return;
    this.enqueue(player ? { type: 'foul', team: side, player, delta } : { type: 'foul', team: side, delta });
  }

  timeout(side) {
    haptic();
    if (this.game.box?.timeout === side) {
      this.enqueue({ type: 'timeout', op: 'end' });
      return;
    }
    // A timeout stops the clock; the time shown now is where it stops.
    const action = { type: 'timeout', op: 'call', team: side };
    if (this.expectedClockRunning()) action.remainingMs = Math.round(this.displayRemainingMs());
    this.enqueue(action);
  }

  // Before the game too, unlike scoring (enqueue).
  rosterAction(body) {
    const game = this.game;
    if (!game || !this.canScore() || (game.status !== 'scheduled' && game.status !== 'live')) return;
    queue.enqueue(this.id, { type: 'roster', ...body });
  }

  addPlayer(side, numberInput, nameInput) {
    const number = numberInput.value.trim();
    const name = nameInput.value.trim();
    const taken = this.game.box.players[side].some((p) => p.number === number)
      || queue.pendingFor(this.id).some((item) => item.body.type === 'roster' && item.body.op === 'add' && item.body.team === side && item.body.number === number);
    numberInput.setCustomValidity(!PLAYER_NUMBER.test(number) ? 'Enter a number from 0 to 99.' : taken ? `#${number} is already on the roster.` : '');
    if (!numberInput.reportValidity()) return;
    nameInput.setCustomValidity(name ? '' : 'Enter the player’s name.');
    if (!nameInput.reportValidity()) return;
    this.rosterAction({ op: 'add', team: side, number, name });
    numberInput.value = '';
    nameInput.value = '';
    numberInput.focus();
  }

  async editPlayer(side, player) {
    const team = this.game[side];
    const result = await openDialog({
      title: `Edit #${player.number} ${player.name}`,
      closeOnBackdrop: false,
      build: (body, actions, close) => {
        const number = el('input', { class: 'input', type: 'text', inputmode: 'numeric', maxLength: 2, value: player.number, autocomplete: 'off', required: true });
        const name = el('input', { class: 'input', type: 'text', maxLength: 40, value: player.name, autocomplete: 'off', required: true, autofocus: true });
        const form = el(
          'form',
          { class: 'stack', novalidate: true },
          el('label', { class: 'field' }, el('span', { class: 'field__label', text: 'Number' }), number),
          el('label', { class: 'field' }, el('span', { class: 'field__label', text: 'Name' }), name),
        );
        const save = () => {
          const value = { number: number.value.trim(), name: name.value.trim() };
          const taken = this.game.box.players[side].some((p) => p.number === value.number && p.id !== player.id);
          number.setCustomValidity(!PLAYER_NUMBER.test(value.number) ? 'Enter a number from 0 to 99.' : taken ? `#${value.number} is already on ${team.name}’s roster.` : '');
          if (!number.reportValidity()) return;
          name.setCustomValidity(value.name ? '' : 'Enter the player’s name.');
          if (!name.reportValidity()) return;
          close(value);
        };
        for (const input of [number, name]) input.addEventListener('input', () => input.setCustomValidity(''));
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          save();
        });
        body.append(form);
        actions.append(
          el('button', { type: 'button', class: 'btn btn--lg', text: 'Cancel', on: { click: () => close(undefined) } }),
          el('button', { type: 'button', class: 'btn btn--lg btn--primary', text: 'Save', on: { click: save } }),
        );
      },
    });
    if (!result || (result.number === player.number && result.name === player.name)) return;
    this.rosterAction({ op: 'edit', team: side, player: player.id, number: result.number, name: result.name });
  }

  period(delta) {
    this.enqueue({ type: 'period', delta });
  }

  outs(delta) {
    haptic();
    this.enqueue({ type: 'outs', delta });
  }

  note(text) {
    this.enqueue({ type: 'note', text });
  }

  undo() {
    this.enqueue({ type: 'undo' });
  }

  // The clock button reflects the state after taps still waiting to be sent.
  // A timeout waiting to be sent stops it too (§13).
  expectedClockRunning() {
    const stopsOrStarts = (body) => (body.type === 'clock' && body.op !== 'set') || (body.type === 'timeout' && body.op === 'call');
    const pendingClock = queue.pendingFor(this.id).filter((item) => stopsOrStarts(item.body));
    if (pendingClock.length) {
      const last = pendingClock.at(-1).body;
      return last.type === 'clock' && last.op === 'start';
    }
    return Boolean(this.game.clock?.running);
  }

  // The clock as the scorekeeper set it: a Stop still waiting to be sent
  // holds it at the time it was tapped, and a Set of a stopped clock shows
  // the new time, instead of the server's clock running on.
  displayRemainingMs() {
    let running = Boolean(this.game.clock?.running);
    let held = null;
    for (const { body, meta } of queue.pendingFor(this.id)) {
      if (body.type === 'timeout' && body.op === 'call') {
        if (running) held = Number.isFinite(body.remainingMs) ? body.remainingMs : null;
        running = false;
        continue;
      }
      if (body.type !== 'clock') continue;
      if (body.op === 'start') {
        running = true;
        held = null;
      } else if (body.op === 'stop') {
        running = false;
        // A Stop queued by the previous portal version (restored after a
        // reload) kept the tapped time in meta.
        const stoppedAt = body.remainingMs ?? meta?.remainingMs;
        held = Number.isFinite(stoppedAt) ? stoppedAt : null;
      } else if (!running) {
        held = body.remainingMs;
      }
    }
    return held ?? clockRemainingMs(this.game.clock);
  }

  toggleClock() {
    haptic();
    if (this.expectedClockRunning()) {
      // The Stop carries the time shown when it was tapped: the server stops
      // the clock there even if the Stop waited in the queue (weak Wi-Fi,
      // offline) while the clock ran on.
      this.enqueue({ type: 'clock', op: 'stop', remainingMs: Math.round(this.displayRemainingMs()) });
    } else {
      this.enqueue({ type: 'clock', op: 'start' });
    }
  }

  openClockSet() {
    const { minutes, seconds } = splitClock(this.displayRemainingMs());
    this.ui.clockMin.value = String(minutes);
    this.ui.clockSec.value = String(seconds).padStart(2, '0');
    this.ui.clockForm.hidden = false;
    this.ui.clockSetOpen.hidden = true;
    this.ui.clockMin.focus();
    this.ui.clockMin.select();
  }

  closeClockSet() {
    if (!this.ui?.clockForm) return;
    this.ui.clockForm.hidden = true;
    this.ui.clockSetOpen.hidden = false;
  }

  setClock() {
    const { clockMin, clockSec } = this.ui;
    const minutes = Number(clockMin.value);
    const seconds = Number(clockSec.value);
    clockMin.setCustomValidity(Number.isInteger(minutes) && minutes >= 0 && minutes <= 60 ? '' : 'Minutes must be 0–60.');
    clockSec.setCustomValidity(Number.isInteger(seconds) && seconds >= 0 && seconds <= 59 ? '' : 'Seconds must be 0–59.');
    if (!clockMin.reportValidity() || !clockSec.reportValidity()) return;
    const remainingMs = (minutes * 60 + seconds) * 1000;
    if (remainingMs > MAX_CLOCK_MS) {
      clockSec.setCustomValidity('The clock can be set to at most 60:00.');
      clockSec.reportValidity();
      return;
    }
    this.enqueue({ type: 'clock', op: 'set', remainingMs });
    this.closeClockSet();
  }

  // period: the period or set to correct; null for the current one.
  setScore(home, away, period = null) {
    const game = this.game;
    const action = period === null ? { type: 'set_score', home, away } : { type: 'set_score', home, away, period };
    if (game.status === 'final') {
      if (user.role !== 'admin') return;
      queue.enqueue(this.id, action);
      this.ui.finalFix.close();
      return;
    }
    this.enqueue(action);
    this.ui.fix.close();
  }

  // Score by hand (manual) or let the scoreboard drive the game again.
  async setFeedManual(button, manual) {
    const game = this.game;
    const live = game.status === 'live';
    if (!manual && live && queue.pendingFor(this.id).length) {
      toast('Wait until every change is saved, then switch to the scoreboard.', { tone: 'error' });
      return;
    }
    const fields = scoreboardFields(game.rules, game.options.clockEnabled);
    // The scoreboard also starts a scheduled game, and ends a live one at the
    // final horn or once the match is won (a game without a clock is ended
    // by hand), but not while it is scored by hand (§11).
    const sets = isSetsMode(game);
    const endsByItself = sets || Boolean(game.rules.clock?.available && game.options.clockEnabled);
    const activities = config.apnsEnabled
      ? 'Every iPhone with the MCHS app then gets a Live Activity on its Lock Screen showing this game’s score, unless Live Activities are turned off in the app.'
      : null;
    const now = serverNow();
    let ok = true;
    if (manual) {
      let also = null;
      if (!live && startsByItself(game.scoreboard)) also = 'It also won’t start by itself: tap Start game when play begins.';
      else if (live && endsByItself) also = `It also won’t end by itself ${sets ? 'once the match is won' : 'at the final horn'}: tap End game.`;
      ok = await confirmDialog({
        title: 'Score this game by hand?',
        body: [`The scoreboard won’t update this game’s ${fields} until you switch back with “Use the scoreboard”.`, also],
        confirmLabel: 'Score by hand',
      });
    } else if (live) {
      ok = await confirmDialog({
        title: 'Use the scoreboard?',
        body: [`The ${fields} follow the scoreboard again. What you entered by hand is replaced by what the scoreboard shows.`],
        confirmLabel: 'Use the scoreboard',
      });
    } else if (now < game.scheduledAt + AUTO_START_WINDOW_MS) {
      // Back on the scoreboard, a scheduled game starts by itself: right
      // away once its time has come and the scoreboard is already on.
      ok = await confirmDialog({
        title: 'Use the scoreboard?',
        body: now < game.scheduledAt
          ? [`This game then starts by itself once the scoreboard is on and its start time has come (${formatDayTime(game.scheduledAt)}).`, activities]
          : ['This game then starts by itself as soon as the scoreboard is on, right away if it’s on now. The start can’t be undone.', activities],
        confirmLabel: 'Use the scoreboard',
      });
    }
    if (!ok) return;
    const ui = this.ui;
    const result = await command(button, game.id, '/scoreboard', { manual });
    if (!result) return;
    // Say what came back: a newer live game that took the scoreboard in the
    // meantime keeps this one scored by hand (§11).
    const feed = result.game.scoreboard;
    const switched = manual || (feed?.manual === false && feed.state !== 'standby');
    if (switched) toast(manual ? 'Scoring by hand.' : 'Using the scoreboard.', { tone: 'success' });
    else toast(feed?.state === 'standby' ? `Still scored by hand. ${feed.message}` : 'This game is still scored by hand.', { tone: 'error' });
    if (this.destroyed) return;
    // The button pressed makes way for the other one; keep the focus there.
    this.update();
    const other = manual ? ui.feedAuto : ui.feedManual;
    if (this.ui === ui && !other.hidden) other.focus();
  }

  async takeOver(button) {
    const game = this.game;
    const ok = await confirmDialog({
      title: 'Take over scoring?',
      body: [`${game.scorekeeper?.name ?? 'Another scorekeeper'} is keeping score for ${matchup(game)}. If you take over, they can no longer score it.`],
      confirmLabel: 'Take over',
    });
    if (!ok) return;
    const result = await command(button, game.id, '/claim', { force: true });
    if (result) toast(`You’re now keeping score for ${matchup(result.game)}.`, { tone: 'success' });
  }

  async start() {
    const game = this.game;
    const ui = this.ui;
    const body = [
      'The game goes live right away. Every iPhone with the MCHS app gets a Live Activity on its Lock Screen showing this game’s score, unless Live Activities are turned off in the app.',
      'Start only when play is about to begin. This can’t be undone.',
    ];
    if (!config.apnsEnabled) body.push('Live Activities aren’t set up on this server yet, so only the scoreboard and the app’s Scores screen will show the game.');
    const ok = await confirmDialog({ title: `Start ${matchup(game)}?`, body, confirmLabel: 'Start game', tone: 'go' });
    if (!ok) return;

    setBusy(ui.start, true);
    try {
      const result = await api(gameApiPath(game.id, '/start'), { method: 'POST' });
      store.upsert(result.game);
      const queued = result.push?.queued ?? 0;
      let message = `${matchup(result.game)} is live.`;
      if (config.apnsEnabled) {
        message += queued > 0
          ? ` Starting the Live Activity on ${queued} ${queued === 1 ? 'iPhone' : 'iPhones'}.`
          : ' No iPhones have Live Activities turned on yet.';
      }
      toast(message, { tone: 'success', timeoutMs: 6000 });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'too_early') {
        toast(`Too early: this game can be started from ${formatTime(game.canStartAt)}.`, { tone: 'error' });
      } else if (err instanceof ApiError && (err.transient || err.status === 409)) {
        // The start may have gone through before the connection failed, or
        // another device started it.
        const fresh = await refreshGame(game.id);
        if (fresh?.status === 'live') toast(`${matchup(fresh)} is live.`, { tone: 'success' });
        else handleCommandError(err);
      } else {
        handleCommandError(err);
      }
    } finally {
      setBusy(ui.start, false);
      if (this.ui === ui && this.game.status === 'scheduled') this.renderPregame();
    }
  }

  async end() {
    const game = this.game;
    if (queue.pendingFor(this.id).length) {
      toast('Wait until every change is saved, then end the game.', { tone: 'error' });
      return;
    }
    const ok = await confirmDialog({
      title: 'End the game?',
      body: [
        `The final score — ${scoreLine(game)} — goes to every Lock Screen, and the game moves to Final.`,
        user.role === 'admin' ? 'Scoring can’t be resumed afterwards (admins can still correct the final score).' : 'Scoring can’t be resumed afterwards.',
      ],
      confirmLabel: 'End game',
      tone: 'danger',
    });
    if (!ok) return;
    const ui = this.ui;
    setBusy(ui.end, true);
    try {
      const { game: ended } = await api(gameApiPath(game.id, '/end'), { method: 'POST' });
      store.upsert(ended);
      toast(`Final: ${scoreLine(ended)}.`, { tone: 'success' });
    } catch (err) {
      if (err instanceof ApiError && (err.transient || err.status === 409)) {
        const fresh = await refreshGame(game.id);
        if (fresh?.status === 'final') toast(`Final: ${scoreLine(fresh)}.`, { tone: 'success' });
        else handleCommandError(err);
      } else {
        handleCommandError(err);
      }
    } finally {
      setBusy(ui.end, false);
      if (this.ui === ui) this.renderPending();
    }
  }
}

// ---- data -----------------------------------------------------------------------

let resyncTimer = null;
let resyncFailures = 0;

const resync = coalesce(async () => {
  clearTimeout(resyncTimer);
  const requestedAt = Date.now();
  try {
    const { games } = await api('/api/games?scope=all');
    store.replaceAll(games, requestedAt);
    loaded = true;
    listError = null;
    resyncFailures = 0;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      if (queue.size === 0) location.replace(loginUrl());
      return;
    }
    listError = err;
    resyncFailures += 1;
    resyncTimer = setTimeout(() => resync(), Math.min(30_000, 2000 * 2 ** Math.min(resyncFailures - 1, 4)));
  }
  scheduleUpdate();
});

// The stream's viewer is fixed when it connects. One that reconnected while
// this browser was signed out (session revoked, signed out in another tab)
// carries the public Game JSON without `scorekeeper`; storing that would make
// every game look unclaimed and lock the scoring pad. Such events are skipped
// and the session is checked instead (at most every 10 s).
const SESSION_CHECK_INTERVAL_MS = 10_000;
let stream = null;
let lastSessionCheckAt = 0;

async function checkStreamSession() {
  let current;
  try {
    current = await fetchSession();
  } catch {
    return; // Server unreachable; the next public event checks again.
  }
  if (!current) {
    // Taps still waiting keep the page open; the queue shows "Signed out".
    if (queue.size === 0) location.replace(loginUrl());
  } else if (current.id !== user.id || current.role !== user.role) {
    location.reload();
  } else {
    stream?.restart();
  }
}

function onStreamGame(game) {
  if (Object.hasOwn(game, 'scorekeeper')) {
    store.upsert(game);
    return;
  }
  if (Date.now() - lastSessionCheckAt < SESSION_CHECK_INTERVAL_MS) return;
  lastSessionCheckAt = Date.now();
  checkStreamSession();
}

function onRemoved(id) {
  store.remove(id);
  if (view instanceof ConsoleView && view.id === id) {
    toast('This game was deleted by an admin.', { tone: 'error' });
    navigate(null, { replace: true });
  }
}

async function confirmLeaveWithPending() {
  if (queue.size === 0) return true;
  const ok = await confirmDialog({
    title: 'Changes are still being sent',
    body: [`${queue.size} scoring ${queue.size === 1 ? 'change hasn’t' : 'changes haven’t'} reached the server yet. Signing out now loses them.`],
    confirmLabel: 'Sign out anyway',
    tone: 'danger',
  });
  if (ok) savePending([]);
  return ok;
}

async function main() {
  dom.main.replaceChildren(loadingState('Loading…'));
  try {
    const [session, serverConfig] = await Promise.all([fetchSession(), fetchConfig().catch(() => null)]);
    user = session;
    if (serverConfig) {
      config = serverConfig;
      setTimeZone(config.timeZone);
    }
  } catch (err) {
    dom.main.replaceChildren(errorNotice(`Couldn’t reach the server: ${err.message}`, { retry: main }));
    return;
  }
  if (!user) {
    location.replace(loginUrl());
    return;
  }

  fillSchoolName(config.schoolName);
  restorePending();
  mountAccountMenu(dom.account, user, { current: 'keeper', beforeSignOut: confirmLeaveWithPending });
  if (dom.adminLink) dom.adminLink.hidden = user.role !== 'admin';

  store.subscribe(scheduleUpdate);
  window.addEventListener('popstate', route);
  window.addEventListener('online', () => queue.retryNow());
  window.addEventListener('beforeunload', (event) => {
    if (queue.size > 0) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  stream = connectStream({
    onHello: () => resync(),
    // In a game's console, polling refreshes just that game (the list is large).
    onPoll: () => (view instanceof ConsoleView ? refreshGame(view.id) : resync()),
    onGame: onStreamGame,
    onRemoved,
    onState: (state) => renderConnection(dom.conn, state),
  });
  resync();
  route();
}

main();

// "Jordan Smith" → "Smith": what fits on a player chip.
function shortName(name) {
  const words = name.trim().split(/\s+/);
  return words.length > 1 ? words.at(-1) : name;
}
