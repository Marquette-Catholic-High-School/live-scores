// Admin console (route "/admin"): schedule games, manage scorekeeper
// accounts and check the push setup. Tabs: #games, #users, #system.

import { mountAccountMenu } from './account.js';
import { ApiError, api, fetchConfig, fetchSession, gameApiPath, loginUrl } from './api.js';
import { formatClock, serverNow } from './clock.js';
import { hasStarted, matchup, scoreboardFields, statusBadge, teamChip } from './render.js';
import { connectStream } from './sse.js';
import { GameStore, coalesce } from './store.js';
import {
  $, confirmDialog, el, emptyState, errorNotice, fillSchoolName, formatDay, formatTime, formatTimestamp, fromDateTimeInputs, getTimeZone, initials,
  isDeviceTimeZone, loadingState, openDialog, renderConnection, setBusy, setTimeZone, syncChildren, timeZoneAbbreviation, toDateInputValue,
  toTimeInputValue, toast, uniqueId,
} from './ui.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// GET /api/games?scope=all returns at most this many games (the ones nearest
// to now, live ones first); `&before=` pages back from there.
const ALL_SCOPE_LIMIT = 500;
const DEFAULT_AWAY_COLOR = '#4B5563';
const BEST_OF = [3, 5];
// The sports the Daktronics scoreboard feed can drive (server/scoreboard.js).
const SCOREBOARD_SPORTS = ['basketball', 'volleyball'];
// Scoreboard feed states (ARCHITECTURE.md §11) as the games list and the
// System tab name them; the others (unavailable, off, idle) aren't shown.
const FEED_STATES = {
  'no-address': 'no address set',
  standby: 'used by a later game',
  manual: 'scored by hand',
  connecting: 'connecting',
  unreachable: 'can’t reach it',
  waiting: 'no data',
  receiving: 'receiving',
};

const dom = {
  main: $('[data-admin]'),
  conn: $('[data-conn]'),
  account: $('[data-account]'),
};

let user = null;
let config = null;
let sports = {};
// GET /api/admin/scoreboard: the default scoreboard address (for the game
// form) and the live feeds (System tab).
let scoreboardSettings = null;
const store = new GameStore();

async function loadScoreboardSettings() {
  scoreboardSettings = await api('/api/admin/scoreboard');
  return scoreboardSettings;
}

function handleError(err, prefix = '') {
  if (err instanceof ApiError && err.status === 401) {
    location.assign(loginUrl());
    return;
  }
  toast(`${prefix}${err.message}`, { tone: 'error' });
}

// ---- form helpers -------------------------------------------------------------

function field(label, input, { hint, className } = {}) {
  return el(
    'label',
    { class: ['field', className] },
    el('span', { class: 'field__label', text: label }),
    input,
    hint ? el('span', { class: 'field__hint', text: hint }) : null,
  );
}

function textInput(props = {}) {
  return el('input', { class: 'input', type: 'text', autocomplete: 'off', ...props });
}

function numberInput(props = {}) {
  return el('input', { class: 'input', type: 'number', inputmode: 'numeric', step: 1, ...props });
}

function select(options, props = {}) {
  return el('select', { class: 'select', ...props }, options.map(([value, label]) => el('option', { value, text: label })));
}

// A color picker paired with its #RRGGBB value.
function colorInput(value) {
  const input = el('input', { class: 'color-input', type: 'color', value: value.toLowerCase() });
  const hex = el('span', { class: 'color-field__hex', text: value.toUpperCase() });
  input.addEventListener('input', () => { hex.textContent = input.value.toUpperCase(); });
  return { input, root: el('span', { class: 'color-field' }, input, hex), get value() { return input.value.toUpperCase(); } };
}

// 12 characters from an unambiguous alphabet (≈70 bits), grouped for reading aloud.
function generatePassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const limit = 256 - (256 % alphabet.length);
  const chars = [];
  while (chars.length < 12) {
    for (const byte of crypto.getRandomValues(new Uint8Array(24))) {
      if (byte < limit && chars.length < 12) chars.push(alphabet[byte % alphabet.length]);
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

function suggestCode(name) {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return letters.slice(0, 3);
}

function suggestUsername(name) {
  return name.trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').slice(0, 32);
}

async function copyText(text, fallbackNode) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.', { tone: 'success' });
  } catch {
    // No clipboard access (plain HTTP, permissions): select it for manual copy.
    const range = document.createRange();
    range.selectNodeContents(fallbackNode);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast('Press Copy (⌘C / Ctrl+C) to copy the selected text.');
  }
}

function credentialsDialog({ title, intro, username, password }) {
  return openDialog({
    title,
    build(body, actions, close) {
      const text = `Username: ${username}\nPassword: ${password}`;
      const box = el('pre', { class: 'credentials', text });
      body.append(
        el('p', { class: 'dialog__text', text: intro }),
        box,
        el('p', { class: 'field__hint', text: 'The password isn’t shown again. They can change it after signing in (account menu → Change password).' }),
      );
      actions.append(
        el('button', { type: 'button', class: 'btn btn--lg', text: 'Copy', on: { click: () => copyText(`${text}\nSign in at ${location.origin}/login`, box) } }),
        el('button', { type: 'button', class: 'btn btn--primary btn--lg', text: 'Done', autofocus: true, on: { click: () => close(true) } }),
      );
    },
  });
}

// ---- games ----------------------------------------------------------------------

function teamFieldset(legend, team, { locked, autoCode }) {
  const name = textInput({ required: true, maxLength: 40, value: team?.name ?? '', placeholder: autoCode ? 'Opponent name' : '' });
  const code = textInput({ required: true, minLength: 2, maxLength: 4, pattern: '[A-Za-z0-9]{2,4}', value: team?.code ?? '', class: 'input input--code', autocapitalize: 'characters' });
  const color = colorInput(team?.color ?? DEFAULT_AWAY_COLOR);
  let codeEdited = Boolean(team?.code);
  code.addEventListener('input', () => {
    codeEdited = code.value !== '';
    code.value = code.value.toUpperCase();
  });
  name.addEventListener('input', () => {
    if (autoCode && !codeEdited) code.value = suggestCode(name.value);
  });
  for (const input of [name, code, color.input]) input.disabled = locked;
  const root = el(
    'fieldset',
    { class: 'fieldset' },
    el('legend', { text: legend }),
    el('div', { class: 'form-grid form-grid--team' },
      field('Name', name, { className: 'field--wide' }),
      field('Short code', code, { hint: '2–4 letters' }),
      el('div', { class: 'field' }, el('span', { class: 'field__label', text: 'Color' }), color.root)),
  );
  color.input.setAttribute('aria-label', `${legend} color`);
  return { root, value: () => ({ name: name.value.trim(), code: code.value.trim().toUpperCase(), color: color.value }) };
}

function gameFormDialog(game = null) {
  const editing = game !== null;
  const locked = editing && hasStarted(game);
  return openDialog({
    title: editing ? `Edit ${matchup(game)}` : 'New game',
    closeOnBackdrop: false,
    wide: true,
    build(body, actions, close) {
      const sportIds = Object.keys(sports);
      const sport = select(sportIds.map((id) => [id, sports[id].name]), { required: true, disabled: locked });
      sport.value = game?.sport ?? sportIds[0];

      // New games default to 6:00 PM tomorrow, school time.
      const when = game?.scheduledAt ?? fromDateTimeInputs(toDateInputValue(serverNow() + DAY_MS), '18:00');
      const date = el('input', { class: 'input', type: 'date', required: true, value: toDateInputValue(when) });
      const time = el('input', { class: 'input', type: 'time', required: true, step: 60, value: toTimeInputValue(when) });
      const shownWhen = [date.value, time.value];
      const venue = textInput({ maxLength: 100, value: game?.location ?? '', placeholder: 'e.g. MCHS Gym' });

      const home = teamFieldset('Home team', game?.home ?? config.homeTeam, { locked, autoCode: false });
      const away = teamFieldset('Away team', game?.away ?? null, { locked, autoCode: !editing });

      const clockOn = el('input', { type: 'checkbox', class: 'checkbox__input' });
      const periodMinutes = numberInput({ min: 1, max: 60, required: true });
      const overtimeMinutes = numberInput({ min: 0, max: 30, required: true });
      const overtimeField = field('Overtime minutes', overtimeMinutes, { hint: '0 = no clock in overtime' });
      const clockFields = el('div', { class: 'form-grid' }, field('Minutes per period', periodMinutes), overtimeField);
      const clockSet = el(
        'fieldset',
        { class: 'fieldset' },
        el('legend', { text: 'Game clock' }),
        el('label', { class: 'checkbox' }, clockOn, el('span', { text: 'Show a running game clock' })),
        clockFields,
      );
      const bestOf = select(BEST_OF.map((n) => [String(n), `Best of ${n} sets`]));
      const setsSet = el('fieldset', { class: 'fieldset' }, el('legend', { text: 'Match format' }), field('Sets', bestOf));

      // Hidden fields (a sport without a clock or without overtime) are
      // disabled too: a required field the admin can't see would otherwise
      // block the submit without any visible error.
      const syncClockFields = () => {
        const off = clockSet.hidden || !clockOn.checked;
        periodMinutes.disabled = off;
        overtimeMinutes.disabled = off || overtimeField.hidden;
      };
      clockOn.addEventListener('change', syncClockFields);

      // Option fields depend on the sport; defaults come from /api/sports.
      const applySport = ({ keepGameOptions }) => {
        const rules = sports[sport.value];
        const options = keepGameOptions && game ? game.options : null;
        const hasClock = Boolean(rules.clock?.available);
        clockSet.hidden = !hasClock;
        if (hasClock) {
          clockOn.checked = options ? Boolean(options.clockEnabled) : Boolean(rules.clock.defaultEnabled);
          periodMinutes.value = String(options?.periodMinutes ?? rules.clock.periodMinutes);
          overtimeField.hidden = !rules.overtime;
          overtimeMinutes.value = String(options?.overtimeMinutes ?? rules.clock.overtimeMinutes ?? 0);
        }
        syncClockFields();
        const sets = rules.scoreMode === 'sets';
        setsSet.hidden = !sets;
        if (sets) bestOf.value = String(options?.bestOf ?? rules.defaults?.bestOf ?? BEST_OF[0]);
      };
      applySport({ keepGameOptions: true });
      sport.addEventListener('change', () => applySport({ keepGameOptions: sport.value === game?.sport }));

      // The Daktronics scoreboard feed (ARCHITECTURE.md §11): the default
      // scoreboard, another one, or off. Sent as "default" | "off" | address.
      const feedName = uniqueId('scoreboard');
      const feedChoice = (value, label) => {
        const input = el('input', { type: 'radio', class: 'checkbox__input', name: feedName, value });
        const text = el('span', { text: label });
        return { input, text, root: el('label', { class: 'checkbox' }, input, text) };
      };
      const feedChoices = { default: feedChoice('default', 'Use the default scoreboard'), custom: feedChoice('custom', 'Another scoreboard'), off: feedChoice('off', 'Off') };
      const feedAddress = textInput({ class: 'input input--mono', maxLength: 60, value: game?.scoreboard?.custom ?? '', placeholder: 'e.g. 10.20.1.51', autocapitalize: 'none' });
      feedAddress.setAttribute('spellcheck', 'false');
      const feedAddressField = field('IP address of its Lantronix box', feedAddress, { hint: 'Port 10001 unless you add another, e.g. 10.20.1.51:3001.', className: 'choices__more' });
      const feedHomeHint = el('p', { class: 'field__hint', text: `The scoreboard is only used when ${config.homeTeam.name} is the home team.` });
      const feedHint = el('p', { class: 'field__hint' });
      const feedSet = el(
        'fieldset',
        { class: 'fieldset' },
        el('legend', { text: 'Scoreboard' }),
        feedHint,
        el('div', { class: 'choices' }, feedChoices.default.root, feedChoices.custom.root, feedAddressField, feedChoices.off.root),
        feedHomeHint,
      );
      const shownFeed = game?.scoreboard ? (game.scoreboard.setting === 'custom' ? game.scoreboard.custom : game.scoreboard.setting) : 'default';
      (feedChoices[game?.scoreboard?.setting] ?? feedChoices.default).input.checked = true;
      const feedValue = () => {
        const choice = Object.values(feedChoices).find((c) => c.input.checked)?.input.value ?? 'default';
        return choice === 'custom' ? feedAddress.value.trim() : choice;
      };
      const syncFeedDefault = () => {
        feedChoices.default.text.textContent = scoreboardSettings
          ? `Use the default scoreboard (${scoreboardSettings.defaultAddress ?? 'none set yet'})`
          : 'Use the default scoreboard';
      };
      // Only basketball and volleyball, and only with the school's team at
      // home (its name or code, as the server compares them). The hint says
      // what the scoreboard sets for the sport and clock chosen.
      const syncFeed = () => {
        feedSet.hidden = !SCOREBOARD_SPORTS.includes(sport.value);
        feedHint.textContent = `While the game is live, its ${scoreboardFields(sports[sport.value], clockOn.checked)} come from the gym’s Daktronics scoreboard.`;
        const custom = feedChoices.custom.input.checked;
        feedAddressField.hidden = !custom;
        feedAddress.disabled = feedSet.hidden || !custom;
        feedAddress.required = !feedAddress.disabled;
        const team = home.value();
        const ours = config.homeTeam;
        const atHome = team.code === ours.code.toUpperCase() || team.name.toLowerCase() === ours.name.trim().toLowerCase();
        feedHomeHint.hidden = atHome || feedChoices.off.input.checked;
      };
      syncFeedDefault();
      syncFeed();
      loadScoreboardSettings().then(syncFeedDefault, () => {});
      sport.addEventListener('change', syncFeed);
      clockOn.addEventListener('change', syncFeed);
      home.root.addEventListener('input', syncFeed);
      feedChoices.default.input.addEventListener('change', syncFeed);
      feedChoices.off.input.addEventListener('change', syncFeed);
      feedChoices.custom.input.addEventListener('change', () => {
        syncFeed();
        feedAddress.focus();
      });

      // Times are read in the school's time zone; say which, and say so
      // plainly when this device is set to another zone (the abbreviation,
      // CST or CDT, depends on the date entered).
      const timeHintText = () => (isDeviceTimeZone()
        ? `${getTimeZone()} time`
        : `${getTimeZone()} time (${timeZoneAbbreviation(fromDateTimeInputs(date.value, time.value) ?? when)}), not this device’s time zone`);
      const timeField = field('Start time', time, { hint: timeHintText() });
      const syncTimeHint = () => { timeField.querySelector('.field__hint').textContent = timeHintText(); };
      date.addEventListener('input', syncTimeHint);
      time.addEventListener('input', syncTimeHint);

      const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
      const formId = uniqueId('game-form');
      const form = el(
        'form',
        { class: 'stack', novalidate: true, id: formId },
        locked ? el('p', { class: 'notice notice--info', text: 'This game has started, so its sport and teams are locked (Live Activities already show them).' }) : null,
        el('div', { class: 'form-grid' }, field('Sport', sport), field('Date', date), timeField),
        field('Location', venue),
        home.root,
        away.root,
        clockSet,
        setsSet,
        feedSet,
        error,
      );
      const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg', text: editing ? 'Save changes' : 'Create game', form: formId });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (!form.reportValidity()) return;
        const scheduledAt = fromDateTimeInputs(date.value, time.value);
        if (scheduledAt === null) {
          error.textContent = 'Enter a valid date and start time.';
          error.hidden = false;
          return;
        }
        const rules = sports[sport.value];
        const payload = { location: venue.value.trim(), options: {} };
        // An edit sends the start time only when it was changed: the inputs
        // hold whole minutes (and the first of a repeated fall-back hour), so
        // re-sending them could move a game that wasn't meant to move.
        if (!editing || date.value !== shownWhen[0] || time.value !== shownWhen[1]) payload.scheduledAt = scheduledAt;
        if (!locked) {
          payload.sport = sport.value;
          payload.home = home.value();
          payload.away = away.value();
        }
        if (rules.clock?.available) {
          payload.options.clockEnabled = clockOn.checked;
          if (clockOn.checked) {
            payload.options.periodMinutes = Number(periodMinutes.value);
            if (rules.overtime) payload.options.overtimeMinutes = Number(overtimeMinutes.value);
          }
        }
        if (rules.scoreMode === 'sets') payload.options.bestOf = Number(bestOf.value);
        if (!feedSet.hidden && (!editing || feedValue() !== shownFeed)) payload.scoreboard = feedValue();

        setBusy(submit, true);
        try {
          const result = editing
            ? await api(gameApiPath(game.id), { method: 'PATCH', body: payload })
            : await api('/api/games', { method: 'POST', body: payload });
          store.upsert(result.game);
          close(result.game);
          toast(editing ? 'Game updated.' : `${matchup(result.game)} added to the schedule.`, { tone: 'success' });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) location.assign(loginUrl());
          error.textContent = err.message;
          error.hidden = false;
        } finally {
          setBusy(submit, false);
        }
      });

      body.append(form);
      actions.append(el('button', { type: 'button', class: 'btn btn--lg', text: 'Cancel', on: { click: () => close(null) } }), submit);
    },
  });
}

const GAME_FILTERS = [
  ['upcoming', 'Upcoming'],
  ['live', 'Live'],
  ['past', 'Past'],
  ['all', 'All'],
];

class GamesPanel {
  constructor(root) {
    this.root = root;
    this.filter = 'upcoming';
    this.loaded = false;
    this.error = null;
    // The game each row shows: the store holds a new object for every change
    // (a new version; feed status changes get one too).
    this.rowGames = new Map();
    this.rows = new Map();
    this.filterButtons = GAME_FILTERS.map(([value, label]) => el('button', {
      type: 'button',
      text: label,
      'aria-pressed': String(value === this.filter),
      on: { click: () => this.setFilter(value) },
    }));
    this.list = el('ul', { class: 'rows' });
    this.status = el('div', { class: 'status-slot' });
    this.loading = loadingState('Loading games…');
    this.empty = emptyState('No games here', 'Use “New game” to add one to the schedule.');
    // Set by resyncGames: the scope=all snapshot was full, so older games
    // may exist. olderBefore: the oldest scheduledAt loaded from the server
    // (snapshot or older pages); olderDone once a page came back short.
    this.snapshotFull = false;
    this.olderBefore = null;
    this.olderDone = false;
    this.olderButton = el('button', { type: 'button', class: 'btn', text: 'Show older games', on: { click: () => this.loadOlder() } });
    this.more = el('div', { class: 'list-more', hidden: true }, this.olderButton);
    root.append(
      el(
        'div',
        { class: 'panel-head' },
        el('div', {}, el('h2', { class: 'panel-title', text: 'Games' }), el('p', { class: 'page-sub', text: 'Schedule games. Scorekeepers claim them in the scorekeeper console.' })),
        el('button', { type: 'button', class: 'btn btn--primary btn--lg', text: '+ New game', on: { click: () => gameFormDialog() } }),
      ),
      el('div', { class: 'segmented', role: 'group', 'aria-label': 'Show games' }, this.filterButtons),
      this.status,
      this.loading,
      this.list,
      this.empty,
      this.more,
    );
  }

  activate() {}

  setFilter(value) {
    this.filter = value;
    GAME_FILTERS.forEach(([key], index) => this.filterButtons[index].setAttribute('aria-pressed', String(key === value)));
    this.render();
  }

  visibleGames() {
    const games = store.all();
    switch (this.filter) {
      case 'upcoming': return games.filter((g) => g.status === 'scheduled').sort((a, b) => a.scheduledAt - b.scheduledAt);
      case 'live': return games.filter((g) => g.status === 'live').sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      case 'past': return games.filter((g) => g.status === 'final' || g.status === 'canceled').sort((a, b) => b.scheduledAt - a.scheduledAt);
      default: return games.sort((a, b) => b.scheduledAt - a.scheduledAt);
    }
  }

  render() {
    const games = this.visibleGames();
    const nodes = games.map((game) => {
      let row = this.rows.get(game.id);
      if (!row) {
        row = el('li', { class: 'arow' });
        this.rows.set(game.id, row);
      }
      if (this.rowGames.get(game.id) !== game) {
        this.fillRow(row, game);
        this.rowGames.set(game.id, game);
      }
      return row;
    });
    for (const id of [...this.rows.keys()]) {
      if (!store.get(id)) {
        this.rows.delete(id);
        this.rowGames.delete(id);
      }
    }
    syncChildren(this.list, nodes);
    this.loading.hidden = this.loaded || this.error !== null;
    this.empty.hidden = !this.loaded || games.length > 0;
    this.more.hidden = !(this.loaded && this.snapshotFull && this.olderBefore !== null && !this.olderDone && (this.filter === 'past' || this.filter === 'all'));
    this.status.replaceChildren(this.error ? errorNotice(`Couldn’t load the games: ${this.error.message}`, { retry: () => resyncGames() }) : '');
  }

  fillRow(row, game) {
    const started = hasStarted(game);
    const open = game.status === 'scheduled' || game.status === 'live';
    const holder = game.scorekeeper;
    const mine = holder?.id === user.id;
    const team = (side) => el('span', { class: 'arow__team' }, teamChip(game[side]), el('span', { text: game[side].name }), started ? el('strong', { class: 'arow__score', text: String(game[side].score) }) : null);
    const feed = game.status === 'live' ? game.scoreboard : null;
    const feedState = feed ? FEED_STATES[feed.state] : undefined;

    const actions = [
      el('button', { type: 'button', class: 'btn btn--sm', text: 'Edit', on: { click: () => gameFormDialog(game) } }),
      el('a', { class: 'btn btn--sm', href: `/keeper?game=${encodeURIComponent(game.id)}`, text: game.status === 'live' ? 'Score' : 'Console' }),
    ];
    if (open && !holder) {
      actions.push(el('button', { type: 'button', class: 'btn btn--sm', text: 'Claim', on: { click: (event) => this.claim(event.currentTarget, game, false) } }));
    } else if (open && !mine) {
      actions.push(el('button', { type: 'button', class: 'btn btn--sm', text: 'Take over', on: { click: (event) => this.claim(event.currentTarget, game, true) } }));
    }
    if (open && holder) {
      actions.push(el('button', { type: 'button', class: 'btn btn--sm', text: 'Release', on: { click: (event) => this.release(event.currentTarget, game) } }));
    }
    if (open) actions.push(el('button', { type: 'button', class: 'btn btn--sm btn--danger-ghost', text: 'Cancel game', on: { click: (event) => this.cancel(event.currentTarget, game) } }));
    actions.push(el('button', {
      type: 'button',
      class: 'btn btn--sm btn--danger-ghost',
      text: 'Delete',
      disabled: game.status === 'live',
      title: game.status === 'live' ? 'End or cancel the game before deleting it' : null,
      on: { click: (event) => this.remove(event.currentTarget, game) },
    }));

    row.dataset.status = game.status;
    row.replaceChildren(
      el('div', { class: 'arow__when' }, el('strong', { text: formatDay(game.scheduledAt) }), el('span', { text: formatTime(game.scheduledAt) })),
      el(
        'div',
        { class: 'arow__main' },
        el('div', { class: 'arow__teams' }, team('home'), el('span', { class: 'arow__vs', text: 'vs' }), team('away')),
        el(
          'div',
          { class: 'arow__meta' },
          statusBadge(game),
          el('span', { text: game.sportName }),
          game.location ? el('span', { text: game.location }) : null,
          el('span', { class: 'arow__holder', text: holder ? `Scorekeeper: ${mine ? 'you' : holder.name}` : open ? 'Unclaimed' : 'No scorekeeper' }),
          feedState ? el('span', { class: ['arow__feed', (feed.state === 'unreachable' || feed.state === 'waiting') && 'is-warn'], title: feed.message, text: `Scoreboard: ${feedState}` }) : null,
        ),
      ),
      el('div', { class: 'arow__actions' }, actions),
    );
  }

  // The next page back from the oldest game loaded.
  async loadOlder() {
    setBusy(this.olderButton, true);
    try {
      // Includes the oldest start time loaded (+1 ms): games sharing it may
      // not all have fit on the last page. The ones already here come back
      // again and are upserted by id.
      const { games } = await api(`/api/games?scope=all&before=${this.olderBefore + 1}`);
      const fresh = games.filter((g) => store.get(g.id) === null);
      for (const game of games) store.upsert(game);
      const oldest = Math.min(this.olderBefore, ...games.map((g) => g.scheduledAt));
      // A full page with nothing new means more than a page of games share
      // one start time; stop rather than ask for the same page again.
      this.olderDone = games.length < ALL_SCOPE_LIMIT || (fresh.length === 0 && oldest === this.olderBefore);
      this.olderBefore = oldest;
      if (fresh.length === 0) toast('There are no older games.');
    } catch (err) {
      handleError(err, 'Couldn’t load older games: ');
    } finally {
      setBusy(this.olderButton, false);
      this.render();
    }
  }

  async claim(button, game, force) {
    if (force) {
      const ok = await confirmDialog({
        title: 'Take over this game?',
        body: [`${game.scorekeeper?.name ?? 'Another scorekeeper'} is keeping score for ${matchup(game)}. Taking over assigns it to you; they can no longer score it. Release it afterwards to let someone else claim it.`],
        confirmLabel: 'Take over',
      });
      if (!ok) return;
    }
    await this.post(button, game, '/claim', { force }, force ? 'You’re now the scorekeeper.' : 'Claimed.');
  }

  release(button, game) {
    return this.post(button, game, '/release', {}, 'Released. Any scorekeeper can claim it now.');
  }

  async cancel(button, game) {
    const ok = await confirmDialog({
      title: `Cancel ${matchup(game)}?`,
      body: game.status === 'live'
        ? ['The game is live. It ends immediately, Lock Screens show it as Canceled and the Live Activity goes away.']
        : ['It stays on the schedule marked Canceled.'],
      confirmLabel: 'Cancel game',
      cancelLabel: 'Keep game',
      tone: 'danger',
    });
    if (ok) await this.post(button, game, '/cancel', {}, 'Game canceled.');
  }

  async remove(button, game) {
    const ok = await confirmDialog({
      title: `Delete ${matchup(game)}?`,
      body: ['The game and its scoring history are removed permanently. To keep it visible as called off, cancel it instead.'],
      confirmLabel: 'Delete game',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(button, true);
    try {
      await api(gameApiPath(game.id), { method: 'DELETE' });
      store.remove(game.id);
      toast('Game deleted.', { tone: 'success' });
    } catch (err) {
      handleError(err);
      if (button.isConnected) setBusy(button, false);
      // 409: it went live meanwhile (a live game can't be deleted); show it
      // as it is now, which disables Delete.
      if (err instanceof ApiError && err.status === 409) {
        api(gameApiPath(game.id)).then(({ game: fresh }) => store.upsert(fresh), () => {});
      }
    }
  }

  async post(button, game, suffix, body, message) {
    setBusy(button, true);
    try {
      const result = await api(gameApiPath(game.id, suffix), { method: 'POST', body });
      store.upsert(result.game);
      toast(message, { tone: 'success' });
    } catch (err) {
      handleError(err);
    } finally {
      if (button.isConnected) setBusy(button, false);
    }
  }
}

// ---- users ----------------------------------------------------------------------

function passwordInput() {
  const input = textInput({ required: true, minLength: 8, maxLength: 1024, autocomplete: 'new-password', class: 'input input--mono' });
  input.setAttribute('spellcheck', 'false');
  const generate = el('button', { type: 'button', class: 'btn', text: 'Generate', on: { click: () => { input.value = generatePassword(); input.setCustomValidity(''); } } });
  return { input, root: el('span', { class: 'input-with-button' }, input, generate) };
}

function userFormDialog() {
  return openDialog({
    title: 'Add a person',
    closeOnBackdrop: false,
    build(body, actions, close) {
      const displayName = textInput({ required: true, maxLength: 60, autocomplete: 'off', placeholder: 'e.g. Coach Smith', autofocus: true });
      const username = textInput({ required: true, minLength: 3, maxLength: 32, pattern: '[a-z0-9._\\-]{3,32}', autocapitalize: 'none', class: 'input input--mono' });
      username.setAttribute('spellcheck', 'false');
      const role = select([['scorekeeper', 'Scorekeeper — keeps score'], ['admin', 'Admin — also schedules games and manages accounts']]);
      const password = passwordInput();
      password.input.value = generatePassword();
      let usernameEdited = false;
      displayName.addEventListener('input', () => {
        if (!usernameEdited) username.value = suggestUsername(displayName.value);
      });
      username.addEventListener('input', () => {
        usernameEdited = username.value !== '';
        username.value = username.value.toLowerCase();
      });

      const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
      const formId = uniqueId('user-form');
      const form = el(
        'form',
        { class: 'stack', novalidate: true, id: formId },
        field('Name', displayName, { hint: 'Shown to other scorekeepers, e.g. “Coach Smith”.' }),
        field('Username', username, { hint: '3–32 characters: lowercase letters, digits, “.”, “_” or “-”.' }),
        field('Role', role),
        field('Password', password.root, { hint: 'At least 8 characters. You’ll see it once to share it.' }),
        error,
      );
      const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg', text: 'Add person', form: formId });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (!form.reportValidity()) return;
        setBusy(submit, true);
        try {
          const { user: created } = await api('/api/users', {
            method: 'POST',
            body: { username: username.value.trim(), displayName: displayName.value.trim(), password: password.input.value, role: role.value },
          });
          close(created);
          usersPanel.load();
          credentialsDialog({
            title: `${created.displayName} can sign in`,
            intro: `Share these sign-in details with ${created.displayName}.`,
            username: created.username,
            password: password.input.value,
          });
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        } finally {
          setBusy(submit, false);
        }
      });
      body.append(form);
      actions.append(el('button', { type: 'button', class: 'btn btn--lg', text: 'Cancel', on: { click: () => close(null) } }), submit);
    },
  });
}

function resetPasswordDialog(target) {
  return openDialog({
    title: `New password for ${target.displayName}`,
    closeOnBackdrop: false,
    build(body, actions, close) {
      const password = passwordInput();
      password.input.value = generatePassword();
      const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
      const formId = uniqueId('reset-form');
      const form = el(
        'form',
        { class: 'stack', novalidate: true, id: formId },
        el('p', { class: 'dialog__text', text: 'They are signed out on every device and need the new password to sign in again.' }),
        field('New password', password.root, { hint: 'At least 8 characters.' }),
        error,
      );
      const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--lg', text: 'Set password', form: formId });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (!form.reportValidity()) return;
        setBusy(submit, true);
        try {
          await api(`/api/users/${target.id}`, { method: 'PATCH', body: { password: password.input.value } });
          close(true);
          credentialsDialog({
            title: 'Password changed',
            intro: `Share the new password with ${target.displayName}.`,
            username: target.username,
            password: password.input.value,
          });
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        } finally {
          setBusy(submit, false);
        }
      });
      body.append(form);
      actions.append(el('button', { type: 'button', class: 'btn btn--lg', text: 'Cancel', on: { click: () => close(false) } }), submit);
    },
  });
}

class UsersPanel {
  constructor(root) {
    this.root = root;
    this.users = null;
    this.list = el('ul', { class: 'rows' });
    this.status = el('div', { class: 'status-slot' });
    this.loading = loadingState('Loading people…');
    root.append(
      el(
        'div',
        { class: 'panel-head' },
        el('div', {}, el('h2', { class: 'panel-title', text: 'Scorekeepers' }), el('p', { class: 'page-sub', text: 'Everyone who can sign in. Admins can also schedule games and manage accounts.' })),
        el('button', { type: 'button', class: 'btn btn--primary btn--lg', text: '+ Add person', on: { click: () => userFormDialog() } }),
      ),
      this.status,
      this.loading,
      this.list,
    );
  }

  activate() {
    this.load();
  }

  async load() {
    try {
      const { users } = await api('/api/users');
      this.users = users;
      this.status.replaceChildren();
      this.render();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        location.assign(loginUrl());
        return;
      }
      this.status.replaceChildren(errorNotice(`Couldn’t load people: ${err.message}`, { retry: () => this.load() }));
    } finally {
      this.loading.hidden = true;
    }
  }

  render() {
    const sorted = [...this.users].sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.displayName.localeCompare(b.displayName));
    this.list.replaceChildren(...sorted.map((person) => this.row(person)));
  }

  row(person) {
    const self = person.id === user.id;
    const admin = person.role === 'admin';
    const actions = [
      el('button', { type: 'button', class: 'btn btn--sm', text: 'Reset password', on: { click: () => resetPasswordDialog(person) } }),
      el('button', {
        type: 'button',
        class: 'btn btn--sm',
        text: admin ? 'Make scorekeeper' : 'Make admin',
        disabled: self,
        title: self ? 'You can’t change your own role' : null,
        on: { click: (event) => this.changeRole(event.currentTarget, person) },
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--sm',
        text: person.disabled ? 'Enable' : 'Disable',
        disabled: self,
        title: self ? 'You can’t disable your own account' : null,
        on: { click: (event) => this.toggleDisabled(event.currentTarget, person) },
      }),
      el('button', {
        type: 'button',
        class: 'btn btn--sm btn--danger-ghost',
        text: 'Delete',
        disabled: self,
        title: self ? 'You can’t delete your own account' : null,
        on: { click: (event) => this.remove(event.currentTarget, person) },
      }),
    ];
    return el(
      'li',
      { class: ['urow', person.disabled && 'is-disabled'] },
      el('span', { class: 'avatar avatar--lg', 'aria-hidden': 'true', text: initials(person.displayName) }),
      el(
        'div',
        { class: 'urow__main' },
        el('div', { class: 'urow__name' },
          el('strong', { text: person.displayName }),
          el('span', { class: ['badge', admin ? 'badge--admin' : 'badge--scheduled'], text: admin ? 'Admin' : 'Scorekeeper' }),
          person.disabled ? el('span', { class: 'badge badge--canceled', text: 'Disabled' }) : null,
          self ? el('span', { class: 'badge badge--mine', text: 'You' }) : null),
        el('div', { class: 'urow__meta' }, el('span', { class: 'mono', text: person.username }), el('span', { text: `Added ${formatDay(person.createdAt)}` })),
      ),
      el('div', { class: 'urow__actions' }, actions),
    );
  }

  async patch(button, person, body, message) {
    setBusy(button, true);
    try {
      await api(`/api/users/${person.id}`, { method: 'PATCH', body });
      toast(message, { tone: 'success' });
      await this.load();
    } catch (err) {
      handleError(err);
      if (button.isConnected) setBusy(button, false);
    }
  }

  async changeRole(button, person) {
    const toAdmin = person.role !== 'admin';
    const ok = await confirmDialog({
      title: toAdmin ? `Make ${person.displayName} an admin?` : `Make ${person.displayName} a scorekeeper?`,
      body: toAdmin ? ['Admins can schedule and delete games and manage everyone’s accounts.'] : ['They keep scoring games but can no longer schedule games or manage accounts.'],
      confirmLabel: toAdmin ? 'Make admin' : 'Make scorekeeper',
    });
    if (ok) await this.patch(button, person, { role: toAdmin ? 'admin' : 'scorekeeper' }, 'Role changed.');
  }

  async toggleDisabled(button, person) {
    if (!person.disabled) {
      const ok = await confirmDialog({
        title: `Disable ${person.displayName}?`,
        body: ['They are signed out everywhere and can’t sign in until you enable the account again.'],
        confirmLabel: 'Disable',
        tone: 'danger',
      });
      if (!ok) return;
    }
    await this.patch(button, person, { disabled: !person.disabled }, person.disabled ? 'Account enabled.' : 'Account disabled.');
  }

  async remove(button, person) {
    const ok = await confirmDialog({
      title: `Delete ${person.displayName}?`,
      body: ['The account is removed permanently. Games they kept score for stay on the schedule. To keep the account for later, disable it instead.'],
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(button, true);
    try {
      await api(`/api/users/${person.id}`, { method: 'DELETE' });
      toast('Deleted.', { tone: 'success' });
      await this.load();
    } catch (err) {
      handleError(err);
      if (button.isConnected) setBusy(button, false);
    }
  }
}

// ---- system ---------------------------------------------------------------------

const ENVIRONMENT_NAMES = { production: 'Production', sandbox: 'Sandbox' };
const ENVIRONMENT_HINTS = { production: 'App Store and TestFlight', sandbox: 'Builds run from Xcode' };
const PUSH_KINDS = { start: 'Start', update: 'Update', end: 'End', channel: 'Channel' };
const SYSTEM_REFRESH_MS = 30_000;

function keyValues(pairs) {
  return el('dl', { class: 'kv' }, pairs.filter(Boolean).map(([key, value]) => [el('dt', { text: key }), el('dd', {}, value)]));
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function checkItem(ok, ...text) {
  return el(
    'li',
    { class: ['check-list__item', ok ? 'is-ok' : 'is-failed'] },
    el('span', { class: 'check-list__icon', 'aria-hidden': 'true', text: ok ? '✓' : '✕' }),
    el('span', {}, ...text),
  );
}

// What a scoreboard test read (POST /api/admin/scoreboard/test). The sport
// code is only sent with a full block, e.g. when the clock stops.
function scoreboardReading(reading) {
  const notYet = 'Not received yet';
  const code = reading.sportCode;
  const sport = code === null ? null : code >= 1000 && code < 2000 ? 'Basketball' : code >= 2000 && code < 3000 ? 'Volleyball' : `Other (code ${code})`;
  const running = reading.clockRunning === null ? '' : reading.clockRunning ? ', running' : ', stopped';
  return keyValues([
    ['Clock', reading.clockMs === null ? notYet : `${formatClock(reading.clockMs)}${running}`],
    ['Score', reading.home === null && reading.away === null ? notYet : `Home ${reading.home ?? '—'}, guest ${reading.away ?? '—'}`],
    [sport === 'Volleyball' ? 'Set' : sport === 'Basketball' ? 'Period' : 'Period or set', reading.period === null ? notYet : String(reading.period)],
    ['Sport', sport ?? 'Not known yet (sent when the clock stops)'],
  ]);
}

// The Daktronics scoreboard feed (ARCHITECTURE.md §11): the default address
// of the gym's Lantronix box, a connection test and the live feeds. Built
// once and kept across the status refreshes, so typing isn't interrupted.
class ScoreboardCard {
  constructor() {
    this.saved = null;
    this.badge = el('span', { class: 'badge' });
    this.input = textInput({ class: 'input input--mono', maxLength: 60, placeholder: 'e.g. 10.20.1.50', autocapitalize: 'none' });
    this.input.setAttribute('spellcheck', 'false');
    this.saveButton = el('button', { type: 'submit', class: 'btn btn--primary', text: 'Save' });
    this.clearButton = el('button', { type: 'button', class: 'btn', text: 'Clear', disabled: true, on: { click: () => this.clear() } });
    this.testButton = el('button', { type: 'button', class: 'btn', text: 'Test connection', on: { click: () => this.test() } });
    this.error = el('p', { class: 'form-error', role: 'alert', hidden: true });
    this.testResults = el('div', { class: 'check-results', 'aria-live': 'polite' });
    this.feeds = el('div', {}, loadingState('Loading…'));
    const form = el(
      'form',
      { class: 'stack', novalidate: true },
      field('Default scoreboard address', this.input, { hint: 'The IP address of the scoreboard’s Lantronix box on the school network. Port 10001 unless the box was set up differently (e.g. 10.20.1.50:3001).' }),
      el('div', { class: 'card__actions' }, this.saveButton, this.clearButton, this.testButton),
      this.error,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.save();
    });
    this.root = el(
      'section',
      { class: 'card' },
      el('div', { class: 'card__head' }, el('h3', { class: 'card__title', text: 'Daktronics scoreboard' }), this.badge),
      el('p', { class: 'card__text', text: `While a basketball or volleyball game with ${config.homeTeam.name} at home is live, its score, clock and period (for volleyball, the points and set) come from the gym’s scoreboard. The server only reads from the box, and the box accepts one connection at a time.` }),
      form,
      this.testResults,
      el('h4', { class: 'card__subtitle', text: 'Live feeds' }),
      this.feeds,
    );
  }

  async load() {
    try {
      this.show(await loadScoreboardSettings());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        location.assign(loginUrl());
        return;
      }
      this.feeds.replaceChildren(errorNotice(`Couldn’t load the scoreboard settings: ${err.message}`, { retry: () => this.load() }));
    }
  }

  // An address being typed is kept, unless it was just saved.
  show(settings, { saved = false } = {}) {
    scoreboardSettings = settings;
    if (saved || this.input.value.trim() === (this.saved ?? '')) this.input.value = settings.defaultAddress ?? '';
    this.saved = settings.defaultAddress;
    this.badge.className = `badge ${this.saved ? 'badge--ok' : 'badge--canceled'}`;
    this.badge.textContent = this.saved ? 'Set up' : 'Not set up';
    if (!this.clearButton.hasAttribute('aria-busy')) this.clearButton.disabled = this.saved === null;
    this.feeds.replaceChildren(this.feedTable(settings.feeds));
  }

  feedTable(feeds) {
    if (feeds.length === 0) return el('p', { class: 'field__hint', text: 'No live game is reading a scoreboard right now.' });
    return el('div', { class: 'table-wrap' }, el(
      'table',
      { class: 'table' },
      el('thead', {}, el('tr', {}, ['Address', 'Game', 'State', 'Last reading'].map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, feeds.map((feed) => {
        const game = store.get(feed.gameId);
        return el(
          'tr',
          { class: feed.state === 'unreachable' ? 'is-failed' : null },
          el('td', { class: 'mono', text: feed.address }),
          el('td', {}, el('a', { href: `/keeper?game=${encodeURIComponent(feed.gameId)}`, text: game ? matchup(game) : feed.gameId })),
          el('td', { class: 'wrap' }, el('span', { class: 'table__main', text: capitalize(FEED_STATES[feed.state] ?? feed.state) }), feed.error ? el('span', { class: 'table__sub', text: feed.error }) : null),
          el('td', { text: feed.lastReadingAt ? formatTimestamp(feed.lastReadingAt) : '—' }),
        );
      })),
    ));
  }

  async patch(button, defaultAddress, message) {
    this.error.hidden = true;
    setBusy(button, true);
    try {
      this.show(await api('/api/admin/scoreboard', { method: 'PATCH', body: { defaultAddress } }), { saved: true });
      toast(message, { tone: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) location.assign(loginUrl());
      this.error.textContent = err.message;
      this.error.hidden = false;
    } finally {
      setBusy(button, false);
      if (button === this.clearButton) button.disabled = this.saved === null;
    }
  }

  save() {
    const address = this.input.value.trim();
    if (address === '') return this.clear();
    return this.patch(this.saveButton, address, 'Default scoreboard saved.');
  }

  async clear() {
    if (this.saved === null) {
      this.input.value = '';
      return;
    }
    const ok = await confirmDialog({
      title: 'Clear the default scoreboard?',
      body: ['Games set to use the default scoreboard won’t read one until an address is saved again.'],
      confirmLabel: 'Clear',
    });
    if (ok) await this.patch(this.clearButton, null, 'Default scoreboard cleared.');
  }

  // Listens to the scoreboard for a few seconds (up to about 10).
  async test() {
    const address = this.input.value.trim() || this.saved;
    if (!address) {
      this.testResults.replaceChildren(el('p', { class: 'notice notice--warn', text: 'Enter the scoreboard’s IP address first.' }));
      this.input.focus();
      return;
    }
    setBusy(this.testButton, true);
    this.testResults.replaceChildren(loadingState(`Listening to the scoreboard at ${address}… This takes up to 10 seconds.`));
    try {
      const { result } = await api('/api/admin/scoreboard/test', { method: 'POST', body: { address }, timeoutMs: 30_000 });
      this.testResults.replaceChildren(this.testReport(result));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        location.assign(loginUrl());
        return;
      }
      this.testResults.replaceChildren(errorNotice(`The test didn’t finish: ${err.message}`));
    } finally {
      setBusy(this.testButton, false);
    }
    this.load();
  }

  testReport(result) {
    const where = el('span', { class: 'mono', text: result.address });
    const checks = [result.connected ? checkItem(true, 'Connected to ', where, '.') : checkItem(false, 'Couldn’t connect to ', where, `: ${result.error ?? 'no answer'}.`)];
    if (result.connected && result.receiving) {
      checks.push(checkItem(true, `Scoreboard data is coming in (${result.frames} ${result.frames === 1 ? 'update' : 'updates'}).`));
    } else if (result.connected && result.frames > 0) {
      // A live game's connection that has gone quiet.
      checks.push(checkItem(false, 'No new data lately. Check that the scoreboard console is on.'));
    } else if (result.connected && result.bytes > 0) {
      checks.push(checkItem(false, 'Data came in, but it isn’t scoreboard data. Check the box’s serial settings.'));
    } else if (result.connected) {
      checks.push(checkItem(false, 'No data came in. Check that the scoreboard console is on and connected to the box.'));
    }
    const game = result.gameId ? store.get(result.gameId) : null;
    return el(
      'div',
      { class: 'stack' },
      result.inUse ? el('p', { class: 'notice notice--info', text: `In use by a live game (${game ? matchup(game) : result.gameId}). This is what that game’s connection has read.` }) : null,
      el('ul', { class: 'check-list' }, checks),
      result.frames > 0 ? scoreboardReading(result.reading) : null,
    );
  }
}

class SystemPanel {
  constructor(root) {
    this.root = root;
    this.timer = null;
    this.active = false;
    this.content = el('div', { class: 'stack stack--lg' }, loadingState('Loading status…'));
    this.scoreboard = new ScoreboardCard();
    this.pushes = el('section', { class: 'card', hidden: true });
    this.refreshButton = el('button', { type: 'button', class: 'btn', text: 'Refresh', on: { click: () => this.load() } });
    this.checkResults = el('div', { class: 'check-results', 'aria-live': 'polite' });
    root.append(
      el(
        'div',
        { class: 'panel-head' },
        el('div', {}, el('h2', { class: 'panel-title', text: 'System' }), el('p', { class: 'page-sub', text: 'Lock Screen push setup, registered iPhones, the gym scoreboard and recent pushes.' })),
        this.refreshButton,
      ),
      el('div', { class: 'stack stack--lg' }, this.content, this.scoreboard.root, this.pushes),
    );
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.active) this.load();
    });
  }

  activate() {
    this.active = true;
    this.load();
  }

  deactivate() {
    this.active = false;
    clearTimeout(this.timer);
  }

  async load() {
    clearTimeout(this.timer);
    setBusy(this.refreshButton, true);
    this.scoreboard.load();
    try {
      const status = await api('/api/admin/status');
      this.render(status);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        location.assign(loginUrl());
        return;
      }
      this.content.replaceChildren(errorNotice(`Couldn’t load the status: ${err.message}`, { retry: () => this.load() }));
      this.pushes.hidden = true;
    } finally {
      setBusy(this.refreshButton, false);
      if (this.active) this.timer = setTimeout(() => { if (document.visibilityState === 'visible') this.load(); }, SYSTEM_REFRESH_MS);
    }
  }

  async check(button) {
    setBusy(button, true);
    this.checkResults.replaceChildren(loadingState('Creating and deleting a test channel with Apple…'));
    try {
      const { results } = await api('/api/admin/apns-check', { method: 'POST', timeoutMs: 60_000 });
      const entries = Object.entries(results);
      this.checkResults.replaceChildren(el(
        'ul',
        { class: 'check-list' },
        entries.map(([environment, result]) => el(
          'li',
          { class: ['check-list__item', result.ok ? 'is-ok' : 'is-failed'] },
          el('span', { class: 'check-list__icon', 'aria-hidden': 'true', text: result.ok ? '✓' : '✕' }),
          el('span', {}, el('strong', { text: ENVIRONMENT_NAMES[environment] ?? environment }), ' — ', result.ok ? 'OK, broadcast channels work.' : result.error ?? 'Failed.'),
        )),
      ));
    } catch (err) {
      this.checkResults.replaceChildren(errorNotice(`The check didn’t finish: ${err.message}`));
    } finally {
      setBusy(button, false);
    }
  }

  render(status) {
    const { apns, devices, recentPushes, sseClients } = status;
    const checkButton = el('button', { type: 'button', class: 'btn btn--primary', text: 'Check APNs', on: { click: (event) => this.check(event.currentTarget) } });

    const apnsCard = el(
      'section',
      { class: 'card' },
      el('div', { class: 'card__head' }, el('h3', { class: 'card__title', text: 'Apple Push Notifications' }),
        el('span', { class: ['badge', apns.configured ? 'badge--ok' : 'badge--canceled'], text: apns.configured ? 'Configured' : 'Not configured' })),
      apns.configured
        ? el('p', { class: 'card__text', text: 'Starting a game sends a Live Activity to every iPhone with Sports Updates on; every score change updates them.' })
        : el('p', { class: 'notice notice--warn', text: `Live Activities are off (${String(apns.error ?? 'the APNs key, Key ID or Team ID is missing').replace(/\.$/, '')}). Scores still update on the web and in the app.` }),
      keyValues([
        ['Team ID', el('span', { class: 'mono', text: apns.teamId ?? '—' })],
        ['Key ID', el('span', { class: 'mono', text: apns.keyId ?? '—' })],
        ['Bundle ID', el('span', { class: 'mono', text: apns.bundleId ?? '—' })],
        ['Environments', apns.environments?.length ? apns.environments.join(', ') : '—'],
      ]),
      el('div', { class: 'card__actions' }, checkButton, el('span', { class: 'field__hint', text: 'Creates and deletes a test broadcast channel in each environment.' })),
      this.checkResults,
    );

    const deviceRows = Object.entries(devices).map(([environment, counts]) => el(
      'tr',
      {},
      el('th', { scope: 'row' }, el('span', { class: 'table__main', text: ENVIRONMENT_NAMES[environment] ?? environment }), ENVIRONMENT_HINTS[environment] ? el('span', { class: 'table__sub', text: ENVIRONMENT_HINTS[environment] }) : null),
      el('td', { class: 'num', text: String(counts.enabled) }),
      el('td', { class: 'num', text: String(counts.total) }),
      el('td', { class: 'num', text: String(counts.invalid) }),
    ));
    const devicesCard = el(
      'section',
      { class: 'card' },
      el('h3', { class: 'card__title', text: 'Registered iPhones' }),
      el('div', { class: 'table-wrap' }, el(
        'table',
        { class: 'table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Environment' }), el('th', { scope: 'col', class: 'num', text: 'Receiving' }), el('th', { scope: 'col', class: 'num', text: 'Total' }), el('th', { scope: 'col', class: 'num', text: 'Invalid' }))),
        el('tbody', {}, deviceRows),
      )),
      el('p', { class: 'field__hint', text: '“Receiving” counts iPhones with Sports Updates and Live Activities turned on. Invalid tokens are removed after 30 days.' }),
    );

    const stats = el(
      'div',
      { class: 'stat-grid' },
      el('div', { class: 'stat' }, el('span', { class: 'stat__label', text: 'Live viewers now' }), el('span', { class: 'stat__value', text: String(sseClients) })),
      el('div', { class: 'stat' }, el('span', { class: 'stat__label', text: 'Live games' }), el('span', { class: 'stat__value', text: String(store.all().filter((g) => g.status === 'live').length) })),
      el('div', { class: 'stat' }, el('span', { class: 'stat__label', text: 'Server version' }), el('span', { class: 'stat__value stat__value--sm', text: config.version ?? '—' })),
    );

    const pushTable = recentPushes.length
      ? el('div', { class: 'table-wrap' }, el(
        'table',
        { class: 'table' },
        el('thead', {}, el('tr', {}, ['When', 'Kind', 'Environment', 'Game', 'Sent', 'Failed', 'Detail'].map((h) => el('th', { scope: 'col', class: h === 'Sent' || h === 'Failed' ? 'num' : null, text: h })))),
        el('tbody', {}, recentPushes.map((row) => {
          const game = row.gameId ? store.get(row.gameId) : null;
          return el(
            'tr',
            { class: row.failed > 0 ? 'is-failed' : null },
            el('td', { text: formatTimestamp(row.createdAt) }),
            el('td', { text: PUSH_KINDS[row.kind] ?? row.kind }),
            el('td', { text: row.environment ?? '—' }),
            el('td', {}, row.gameId ? el('a', { href: `/game/${encodeURIComponent(row.gameId)}`, text: game ? matchup(game) : row.gameId }) : '—'),
            el('td', { class: 'num', text: String(row.sent) }),
            el('td', { class: 'num', text: String(row.failed) }),
            el('td', { class: 'wrap', text: row.detail || '' }),
          );
        })),
      ))
      : emptyState('No pushes yet', 'Pushes appear here once a game starts.');

    this.content.replaceChildren(stats, el('div', { class: 'card-grid' }, apnsCard, devicesCard));
    // The scoreboard card sits between these, untouched by the refresh.
    this.pushes.replaceChildren(el('h3', { class: 'card__title', text: 'Recent pushes' }), pushTable);
    this.pushes.hidden = false;
  }
}

// ---- tabs and boot --------------------------------------------------------------

const panels = {};
const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(name, { focus = false } = {}) {
  if (!panels[name]) name = 'games';
  for (const tab of tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const [key, panel] of Object.entries(panels)) {
    panel.root.hidden = key !== name;
    if (key !== name) panel.deactivate?.();
  }
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  panels[name].activate();
}

function setupTabs() {
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      let target = null;
      if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
      else if (event.key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === 'Home') target = tabs[0];
      else if (event.key === 'End') target = tabs.at(-1);
      if (target) {
        event.preventDefault();
        selectTab(target.dataset.tab, { focus: true });
      }
    });
  });
  window.addEventListener('hashchange', () => selectTab(location.hash.slice(1)));
}

let gamesPanel;
let usersPanel;
let resyncTimer = null;
let resyncFailures = 0;

const resyncGames = coalesce(async () => {
  clearTimeout(resyncTimer);
  const requestedAt = Date.now();
  try {
    const { games } = await api('/api/games?scope=all');
    // A full snapshot holds only the games nearest to now (and every live
    // one, however old): older pages and games beyond its span stay.
    const full = games.length >= ALL_SCOPE_LIMIT;
    const times = games.filter((g) => g.status !== 'live').map((g) => g.scheduledAt);
    const [from, to] = [Math.min(...times), Math.max(...times)];
    store.replaceAll(games, requestedAt, full ? (game) => game.status === 'live' || (game.scheduledAt > from && game.scheduledAt < to) : undefined);
    gamesPanel.snapshotFull = full;
    if (full && Number.isFinite(from)) gamesPanel.olderBefore = Math.min(gamesPanel.olderBefore ?? from, from);
    gamesPanel.loaded = true;
    gamesPanel.error = null;
    resyncFailures = 0;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      location.assign(loginUrl());
      return;
    }
    gamesPanel.error = err;
    resyncFailures += 1;
    resyncTimer = setTimeout(() => resyncGames(), Math.min(30_000, 2000 * 2 ** Math.min(resyncFailures - 1, 4)));
  }
  scheduleRender();
});

// A stream that reconnected while signed out carries the public Game JSON
// (no `scorekeeper`), which would show every game as unclaimed. Skip those
// events and check the session instead, at most every 10 s.
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
  if (!current) location.assign(loginUrl());
  else if (current.id !== user.id || current.role !== user.role) location.reload();
  else stream?.restart();
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

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    gamesPanel.render();
  });
}

async function main() {
  try {
    [user, config] = await Promise.all([fetchSession(), fetchConfig()]);
  } catch (err) {
    dom.main.replaceChildren(errorNotice(`Couldn’t reach the server: ${err.message}`, { retry: () => location.reload() }));
    return;
  }
  if (!user) {
    location.replace(loginUrl());
    return;
  }
  fillSchoolName(config.schoolName);
  setTimeZone(config.timeZone);
  document.title = `Admin · ${config.schoolName} Live Scores`;
  mountAccountMenu(dom.account, user, { current: 'admin' });
  if (user.role !== 'admin') {
    dom.main.replaceChildren(el(
      'div',
      { class: 'board-message' },
      emptyState('Admins only', 'Your account can keep score but can’t schedule games or manage accounts.'),
      el('a', { class: 'btn btn--primary', href: '/keeper', text: 'Open the scorekeeper console' }),
    ));
    return;
  }

  try {
    ({ sports } = await api('/api/sports'));
  } catch (err) {
    dom.main.replaceChildren(errorNotice(`Couldn’t load the sports list: ${err.message}`, { retry: () => location.reload() }));
    return;
  }

  gamesPanel = new GamesPanel($('[data-panel="games"]'));
  usersPanel = new UsersPanel($('[data-panel="users"]'));
  panels.games = gamesPanel;
  panels.users = usersPanel;
  panels.system = new SystemPanel($('[data-panel="system"]'));
  $('[data-admin-app]').hidden = false;
  $('[data-admin-loading]')?.remove();

  store.subscribe(scheduleRender);
  stream = connectStream({
    onHello: () => resyncGames(),
    onPoll: () => resyncGames(),
    onGame: onStreamGame,
    onRemoved: (id) => store.remove(id),
    onState: (state) => renderConnection(dom.conn, state),
  });
  resyncGames();
  setupTabs();
  selectTab(location.hash.slice(1) || 'games');
}

main();
