// DOM and formatting helpers shared by every page.
//
// All user-provided text (team names, notes, usernames…) goes into the DOM
// through textContent or attributes — never innerHTML — and dynamic styles
// go through CSSOM (element.style.setProperty), which the strict CSP allows.

// ---- DOM building -------------------------------------------------------------

function appendChildren(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// Keys whose DOM property is read-only or means something else.
const ATTRIBUTE_ONLY = new Set(['role', 'for', 'form', 'list']);

// el('button', { class: 'btn', type: 'button', on: { click } }, 'Label')
//   class: string | array (falsy entries skipped); text: textContent;
//   dataset: {…}; style: { '--custom-prop': value } via setProperty;
//   on: { event: handler }; aria-*/role/for/form/other unknown keys → attributes;
//   known DOM properties (type, value, disabled, hidden, href…) → properties.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') for (const [name, v] of Object.entries(value)) node.style.setProperty(name, v);
    else if (key === 'on') for (const [name, handler] of Object.entries(value)) node.addEventListener(name, handler);
    else if (key.startsWith('aria-') || ATTRIBUTE_ONLY.has(key) || !(key in node)) node.setAttribute(key, value === true ? '' : String(value));
    else node[key] = value;
  }
  appendChildren(node, children);
  return node;
}

export function clear(node, ...children) {
  node.replaceChildren();
  appendChildren(node, children);
  return node;
}

// Puts `nodes` into `parent` in order, moving only nodes that are out of
// place, so CSS animations and keyboard focus survive re-renders.
export function syncChildren(parent, nodes) {
  nodes.forEach((node, index) => {
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
  });
  while (parent.children.length > nodes.length) parent.lastElementChild.remove();
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

let idCounter = 0;
export function uniqueId(prefix = 'id') {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

// Restarts a one-shot CSS animation class.
export function replayClass(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

export function setBusy(button, busy) {
  button.disabled = busy;
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

// ---- team colors --------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FALLBACK_TEAM_COLOR = '#5B6478';

function luminance(hex) {
  const channel = (offset) => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// White or near-black, whichever reads better on the team color.
export function inkFor(hex) {
  const l = luminance(HEX_COLOR.test(hex) ? hex : FALLBACK_TEAM_COLOR);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / 0.0555;
  return onWhite >= onDark ? '#FFFFFF' : '#0B1020';
}

export function applyTeamColor(node, color) {
  const team = HEX_COLOR.test(color ?? '') ? color : FALLBACK_TEAM_COLOR;
  node.style.setProperty('--team', team);
  node.style.setProperty('--team-ink', inkFor(team));
}

export function initials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words.at(-1)][0]];
  return letters.join('').toUpperCase();
}

// ---- dates and times ------------------------------------------------------------
//
// Times are shown and entered in the school's time zone (GET /api/config
// `timeZone`), not the device's, so a 7:00 PM game reads 7:00 PM on a laptop
// set to another zone too. Pages call setTimeZone() once the config is in;
// until then (or if it never comes) the device's zone is used. When the two
// differ, times carry the zone's abbreviation ("7:00 PM CST").

const DAY_MS = 24 * 60 * 60 * 1000;
const DEVICE_TIME_ZONE = new Intl.DateTimeFormat().resolvedOptions().timeZone;
let timeZone = DEVICE_TIME_ZONE;
let formats = buildFormats(timeZone);

function buildFormats(zone) {
  const zoneName = zone === DEVICE_TIME_ZONE ? undefined : 'short';
  const format = (options) => new Intl.DateTimeFormat(undefined, { ...options, timeZone: zone });
  return {
    time: format({ hour: 'numeric', minute: '2-digit', timeZoneName: zoneName }),
    shortDay: format({ weekday: 'short', month: 'short', day: 'numeric' }),
    shortDayYear: format({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    longDay: format({ weekday: 'long', month: 'long', day: 'numeric' }),
    dateTime: format({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: zoneName }),
    zoneName: format({ timeZoneName: 'short' }),
    // Calendar fields (always Western digits, 0–23 h) for day boundaries and form inputs.
    fields: new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }),
  };
}

// Returns whether the zone changed; an unknown zone keeps the current one.
export function setTimeZone(zone) {
  let resolved;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  if (resolved === timeZone) return false;
  timeZone = resolved;
  formats = buildFormats(timeZone);
  return true;
}

export function getTimeZone() {
  return timeZone;
}

export function isDeviceTimeZone() {
  return timeZone === DEVICE_TIME_ZONE;
}

// "CST" / "CDT" (or "GMT-6" where the locale has no abbreviation) at `ms`.
export function timeZoneAbbreviation(ms = Date.now()) {
  return formats.zoneName.formatToParts(ms).find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
}

function zonedFields(ms) {
  const fields = {};
  for (const { type, value } of formats.fields.formatToParts(ms)) fields[type] = Number(value);
  return { year: fields.year, month: fields.month, day: fields.day, hour: fields.hour % 24, minute: fields.minute, second: fields.second };
}

// The zone's offset from UTC at instant `ms`, in milliseconds.
function offsetAt(ms) {
  const f = zonedFields(ms);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - Math.floor(ms / 1000) * 1000;
}

// The instant a wall-clock time (month 1–12) names in the school's zone. A
// time skipped when clocks spring forward is read with the offset before the
// change (2:30 → 3:30 CDT, as a plain Date does); a time repeated when they
// fall back means its first occurrence.
export function zonedTimeToUtc(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(wall - DAY_MS);
  const after = offsetAt(wall + DAY_MS);
  const matches = [wall - before, wall - after].filter((ms) => ms + offsetAt(ms) === wall);
  return matches.length ? Math.min(...matches) : wall - before;
}

export function startOfDay(ms) {
  const f = zonedFields(ms);
  return zonedTimeToUtc(f.year, f.month, f.day, 0, 0);
}

export function endOfDay(ms) {
  const f = zonedFields(ms);
  const next = new Date(Date.UTC(f.year, f.month - 1, f.day + 1));
  return zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0) - 1;
}

export function dayKey(ms) {
  const f = zonedFields(ms);
  return `${f.year}-${f.month}-${f.day}`;
}

export function formatTime(ms) {
  return formats.time.format(ms);
}

// "Today", "Tomorrow", "Yesterday", else "Sat, Nov 2" (long: "Saturday, November 2").
export function formatDay(ms, { long = false, now = Date.now() } = {}) {
  const diff = Math.round((startOfDay(ms) - startOfDay(now)) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (long) return formats.longDay.format(ms);
  return zonedFields(ms).year === zonedFields(now).year ? formats.shortDay.format(ms) : formats.shortDayYear.format(ms);
}

export function formatDayTime(ms, options) {
  return `${formatDay(ms, options)} · ${formatTime(ms)}`;
}

export function formatTimestamp(ms) {
  return formats.dateTime.format(ms);
}

// "2 h 5 min", "45 min", "under a minute".
export function formatDuration(ms) {
  if (ms < 60_000) return 'under a minute';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// <input type="date"> / <input type="time"> values in the school's time zone.
const pad2 = (n) => String(n).padStart(2, '0');

export function toDateInputValue(ms) {
  const f = zonedFields(ms);
  return `${f.year}-${pad2(f.month)}-${pad2(f.day)}`;
}

export function toTimeInputValue(ms) {
  const f = zonedFields(ms);
  return `${pad2(f.hour)}:${pad2(f.minute)}`;
}

export function fromDateTimeInputs(dateValue, timeValue) {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue ?? '');
  const time = /^(\d{2}):(\d{2})/.exec(timeValue ?? '');
  if (!date || !time) return null;
  const ms = zonedTimeToUtc(Number(date[1]), Number(date[2]), Number(date[3]), Number(time[1]), Number(time[2]));
  return Number.isFinite(ms) ? ms : null;
}

// ---- feedback -------------------------------------------------------------------

let toastRegion = null;

export function toast(message, { tone = 'info', timeoutMs } = {}) {
  if (!toastRegion) {
    toastRegion = el('div', { class: 'toasts', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(toastRegion);
  }
  const node = el('div', { class: ['toast', `toast--${tone}`] }, message);
  toastRegion.append(node);
  while (toastRegion.children.length > 3) toastRegion.firstElementChild.remove();
  const dismiss = () => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  };
  setTimeout(dismiss, timeoutMs ?? (tone === 'error' ? 7000 : 4000));
  node.addEventListener('click', dismiss);
}

// A modal <dialog>. `build(body, actions, close)` fills it; resolves with
// whatever `close(value)` is called with (undefined on Esc/backdrop).
// Forms pass closeOnBackdrop: false so a stray tap can't discard typing.
export function openDialog({ title, wide = false, closeOnBackdrop = true, build }) {
  return new Promise((resolve) => {
    const titleId = uniqueId('dialog-title');
    const body = el('div', { class: 'dialog__body' }, el('h2', { class: 'dialog__title', id: titleId, text: title }));
    const actions = el('div', { class: 'dialog__actions' });
    const dialog = el('dialog', { class: ['dialog', wide && 'dialog--wide'], 'aria-labelledby': titleId }, body, actions);
    let result;
    const close = (value) => {
      result = value;
      if (dialog.open) dialog.close();
    };
    dialog.addEventListener('click', (event) => {
      if (closeOnBackdrop && event.target === dialog) close(undefined);
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    build(body, actions, close, dialog);
    document.body.append(dialog);
    dialog.showModal();
    const autofocus = dialog.querySelector('[autofocus]');
    if (autofocus) autofocus.focus();
  });
}

export async function confirmDialog({ title, body = [], confirmLabel = 'OK', cancelLabel = 'Cancel', tone = 'primary' }) {
  const result = await openDialog({
    title,
    build(content, actions, close) {
      for (const paragraph of [].concat(body)) {
        if (paragraph) content.append(typeof paragraph === 'string' ? el('p', { class: 'dialog__text', text: paragraph }) : paragraph);
      }
      actions.append(
        el('button', { type: 'button', class: 'btn btn--lg', text: cancelLabel, autofocus: true, on: { click: () => close(false) } }),
        el('button', {
          type: 'button',
          class: ['btn', 'btn--lg', tone === 'danger' ? 'btn--danger' : tone === 'go' ? 'btn--go' : 'btn--primary'],
          text: confirmLabel,
          on: { click: () => close(true) },
        }),
      );
    },
  });
  return result === true;
}

// ---- page chrome ----------------------------------------------------------------

const CONNECTION_LABELS = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
};

const CONNECTION_TITLES = {
  connecting: 'Connecting to live updates',
  open: 'Receiving live updates',
  reconnecting: 'Connection lost, reconnecting',
  offline: 'You are offline; scores update when you reconnect',
};

export function connectionIndicator() {
  return el(
    'span',
    { class: 'conn', role: 'status', dataset: { state: 'connecting' } },
    el('span', { class: 'conn__dot', 'aria-hidden': 'true' }),
    el('span', { class: 'conn__label', text: CONNECTION_LABELS.connecting }),
  );
}

export function renderConnection(node, state) {
  if (!node) return;
  node.dataset.state = state;
  node.title = CONNECTION_TITLES[state] ?? '';
  const label = node.querySelector('.conn__label');
  if (label) label.textContent = CONNECTION_LABELS[state] ?? state;
}

export function fillSchoolName(name) {
  if (!name) return;
  for (const node of document.querySelectorAll('[data-school-name]')) node.textContent = name;
}

export function errorNotice(message, { retry } = {}) {
  return el(
    'div',
    { class: 'notice notice--error', role: 'alert' },
    el('span', { class: 'notice__text', text: message }),
    retry ? el('button', { type: 'button', class: 'btn btn--sm', text: 'Try again', on: { click: retry } }) : null,
  );
}

export function loadingState(label = 'Loading…') {
  return el('div', { class: 'loading', role: 'status' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', { text: label }));
}

export function emptyState(title, text) {
  return el('div', { class: 'empty' }, el('p', { class: 'empty__title', text: title }), text ? el('p', { class: 'empty__text', text }) : null);
}
