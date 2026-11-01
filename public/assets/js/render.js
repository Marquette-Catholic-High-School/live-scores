// Game rendering shared by the scoreboard, the game page and the scorekeeper
// console. Everything sport-specific comes from `game.rules` (the server's
// SPORTS entry, ARCHITECTURE.md §5), so a new sport needs no client change.

import { applyTeamColor, el } from './ui.js';

export const SIDES = ['home', 'away'];
// The server never stores more periods than this (see games.js MAX_PERIODS).
const SERVER_MAX_PERIOD_INDEX = 99;

export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export function isSetsMode(game) {
  return game.rules?.scoreMode === 'sets';
}

// Sports played in half-innings (baseball) list their regulation periods as
// alternating ▲/▼ entries; their line score groups two periods per inning.
export function isHalfInnings(rules) {
  const periods = rules?.periods ?? [];
  return periods.length >= 2 && periods.length % 2 === 0
    && periods.every((period, index) => period.short.startsWith(index % 2 === 0 ? '▲' : '▼'));
}

export function maxPeriodIndex(rules) {
  const regulation = rules.periods.length;
  if (!rules.overtime) return regulation - 1;
  if (rules.overtime.max === null || rules.overtime.max === undefined) return SERVER_MAX_PERIOD_INDEX;
  return Math.min(SERVER_MAX_PERIOD_INDEX, regulation - 1 + rules.overtime.max);
}

const OVERTIME_NAMINGS = new Set(['prefix', 'suffix', 'innings']);

// How overtime periods are numbered: "OT, 2OT" (prefix), "OT1, OT2" (suffix)
// or by continuing the half-innings (innings). The server says so in
// `rules.overtime.naming`. Without it (an older server) it is inferred:
// half-innings continue as innings, the current period's label decides when
// that is an overtime, else limited overtime (soccer) is OT1, OT2 and
// unlimited overtime (basketball, football) OT, 2OT.
function overtimeNaming(game) {
  const { overtime, periods } = game.rules;
  if (OVERTIME_NAMINGS.has(overtime?.naming)) return overtime.naming;
  if (isHalfInnings(game.rules)) return 'innings';
  if (!overtime) return 'prefix';
  if (game.isOvertime) {
    const n = game.period - periods.length + 1;
    if (game.periodShort === `${overtime.short}${n}`) return 'suffix';
    return 'prefix';
  }
  return overtime.max === null || overtime.max === undefined ? 'prefix' : 'suffix';
}

// { label, short, isOvertime } for any period index, or null past the end.
export function periodInfoAt(game, index) {
  if (index === game.period) return { label: game.periodLabel, short: game.periodShort, isOvertime: game.isOvertime };
  const { rules } = game;
  const regulation = rules.periods.length;
  if (index < 0 || index > maxPeriodIndex(rules)) return null;
  if (index < regulation) return { ...rules.periods[index], isOvertime: false };
  const naming = overtimeNaming(game);
  if (naming === 'innings') {
    const inning = Math.floor(index / 2) + 1;
    const top = index % 2 === 0;
    return { label: `${top ? 'Top' : 'Bottom'} ${ordinal(inning)}`, short: `${top ? '▲' : '▼'}${inning}`, isOvertime: true };
  }
  const n = index - regulation + 1;
  const { label, short } = rules.overtime;
  if (naming === 'suffix') return { label: `${label} ${n}`, short: `${short}${n}`, isOvertime: true };
  return { label: n === 1 ? label : `${ordinal(n)} ${label}`, short: n === 1 ? short : `${n}${short}`, isOvertime: true };
}

export function hasStarted(game) {
  return game.startedAt !== null && game.startedAt !== undefined;
}

// "Final", "Final/OT", "Final/2OT", "Final/8" (extra innings), "Canceled".
export function finalLabel(game) {
  if (game.status === 'canceled') return 'Canceled';
  if (!game.isOvertime) return 'Final';
  if (overtimeNaming(game) === 'innings') return `Final/${Math.floor(game.period / 2) + 1}`;
  return `Final/${game.periodShort}`;
}

export function statusLabel(game) {
  switch (game.status) {
    case 'live': return 'Live';
    case 'scheduled': return 'Upcoming';
    default: return finalLabel(game);
  }
}

export function statusBadge(game) {
  return el('span', { class: ['badge', `badge--${game.status}`], text: statusLabel(game) });
}

export function matchup(game) {
  return `${game.home.code} vs ${game.away.code}`;
}

export function scoreLine(game) {
  return `${game.home.code} ${game.home.score} – ${game.away.score} ${game.away.code}`;
}

// Winner of a finished game, or null for a tie / unfinished game.
export function leader(game) {
  if (game.home.score === game.away.score) return null;
  return game.home.score > game.away.score ? 'home' : 'away';
}

export function setsToWin(game) {
  return Math.floor(game.rules.periods.length / 2) + 1;
}

export function teamChip(team, { large = false } = {}) {
  const chip = el('span', { class: ['chip', large && 'chip--lg'], text: team.code });
  applyTeamColor(chip, team.color);
  return chip;
}

export function updateTeamChip(chip, team) {
  chip.textContent = team.code;
  applyTeamColor(chip, team.color);
}

export function outsIndicator() {
  const dots = [el('span', { class: 'outs__dot' }), el('span', { class: 'outs__dot' })];
  const root = el('span', { class: 'outs', role: 'img' }, dots);
  return {
    root,
    update(outs) {
      dots.forEach((dot, index) => dot.classList.toggle('is-on', outs > index));
      root.setAttribute('aria-label', `${outs} ${outs === 1 ? 'out' : 'outs'}`);
    },
  };
}

function inningCell(line, inning, side) {
  const top = line[inning * 2];
  const bottom = line[inning * 2 + 1];
  // The away team bats in the top half, the home team in the bottom half.
  const reached = side === 'away' ? Boolean(top) : Boolean(bottom) || (top?.home ?? 0) > 0;
  if (!reached) return '';
  return String((top?.[side] ?? 0) + (bottom?.[side] ?? 0));
}

// Score-by-period table (innings for baseball, sets for volleyball).
export function lineScoreTable(game) {
  const { rules, line } = game;
  const live = game.status === 'live';
  const halfInnings = isHalfInnings(rules);
  const sets = isSetsMode(game);
  const columns = [];

  if (halfInnings) {
    const innings = Math.max(rules.periods.length / 2, Math.ceil(line.length / 2));
    for (let inning = 0; inning < innings; inning += 1) {
      columns.push({
        head: String(inning + 1),
        title: `${ordinal(inning + 1)} inning`,
        current: live && Math.floor(game.period / 2) === inning,
        cell: (side) => ({ text: inningCell(line, inning, side) }),
      });
    }
  } else {
    const count = Math.max(rules.periods.length, line.length);
    for (let index = 0; index < count; index += 1) {
      const info = periodInfoAt(game, index);
      const completedSet = sets && index < line.length && (index < game.period || game.status === 'final');
      columns.push({
        head: info?.short ?? String(index + 1),
        title: info?.label ?? '',
        current: live && index === game.period,
        cell: (side) => {
          if (index >= line.length) return { text: '' };
          const other = side === 'home' ? 'away' : 'home';
          return { text: String(line[index][side]), won: completedSet && line[index][side] > line[index][other] };
        },
      });
    }
  }

  const rows = halfInnings ? ['away', 'home'] : SIDES;
  const totalHead = sets ? 'Sets' : halfInnings ? 'R' : 'T';
  const totalTitle = sets ? 'Sets won' : halfInnings ? 'Runs' : 'Total';
  const caption = sets ? 'Points by set' : halfInnings ? 'Runs by inning' : 'Score by period';

  const table = el(
    'table',
    { class: 'linescore' },
    el('caption', { class: 'sr-only', text: caption }),
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { scope: 'col', class: 'linescore__team' }, el('span', { class: 'sr-only', text: 'Team' })),
        columns.map((column) => el('th', { scope: 'col', class: column.current && 'is-current' }, el('abbr', { title: column.title || null, text: column.head }))),
        el('th', { scope: 'col', class: 'linescore__total' }, el('abbr', { title: totalTitle, text: totalHead })),
      ),
    ),
    el(
      'tbody',
      {},
      rows.map((side) => {
        const team = game[side];
        return el(
          'tr',
          {},
          el('th', { scope: 'row', class: 'linescore__team' }, el('span', { class: 'linescore__teamwrap' }, teamChip(team), el('span', { class: 'linescore__name', text: team.name }))),
          columns.map((column) => {
            const cell = column.cell(side);
            return el('td', { class: [column.current && 'is-current', cell.won && 'is-won'] }, cell.text);
          }),
          el('td', { class: 'linescore__total' }, String(team.score)),
        );
      }),
    ),
  );
  return el('div', { class: 'linescore-wrap' }, table);
}
