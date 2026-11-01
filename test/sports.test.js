import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SPORTS,
  allRules,
  defaultOptions,
  maxPeriodIndex,
  ordinal,
  periodClockMinutes,
  periodCount,
  periodInfo,
  rulesFor,
} from '../server/sports.js';

describe('sports', () => {
  it('formats ordinals', () => {
    const expected = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 11: '11th', 12: '12th', 13: '13th', 21: '21st', 22: '22nd', 23: '23rd', 101: '101st', 111: '111th' };
    for (const [n, text] of Object.entries(expected)) assert.equal(ordinal(Number(n)), text);
  });

  it('names basketball/football overtime OT, 2OT, 3OT', () => {
    const options = defaultOptions('basketball');
    assert.deepEqual(periodInfo('basketball', options, 0), { label: '1st Quarter', short: 'Q1', isOvertime: false });
    assert.deepEqual(periodInfo('basketball', options, 3), { label: '4th Quarter', short: 'Q4', isOvertime: false });
    assert.deepEqual(periodInfo('basketball', options, 4), { label: 'Overtime', short: 'OT', isOvertime: true });
    assert.deepEqual(periodInfo('football', defaultOptions('football'), 5), { label: '2nd Overtime', short: '2OT', isOvertime: true });
    assert.deepEqual(periodInfo('football', defaultOptions('football'), 6), { label: '3rd Overtime', short: '3OT', isOvertime: true });
    assert.equal(maxPeriodIndex('basketball', options), null);
  });

  it('names soccer overtime OT1, OT2 and caps it', () => {
    const options = defaultOptions('soccer');
    assert.deepEqual(periodInfo('soccer', options, 1), { label: '2nd Half', short: '2H', isOvertime: false });
    assert.equal(periodInfo('soccer', options, 2).short, 'OT1');
    assert.equal(periodInfo('soccer', options, 3).short, 'OT2');
    assert.equal(maxPeriodIndex('soccer', options), 3);
  });

  it('generates volleyball sets from bestOf', () => {
    assert.equal(periodCount('volleyball', { bestOf: 5 }), 5);
    assert.equal(maxPeriodIndex('volleyball', { bestOf: 5 }), 4);
    assert.equal(maxPeriodIndex('volleyball', { bestOf: 3 }), 2);
    assert.deepEqual(periodInfo('volleyball', { bestOf: 5 }, 4), { label: 'Set 5', short: 'S5', isOvertime: false });
    assert.equal(rulesFor('volleyball', { bestOf: 5 }).periods.length, 5);
    assert.equal(rulesFor('volleyball', { bestOf: 3 }).periods.length, 3);
    assert.equal(SPORTS.volleyball.defaults.bestOf, 3);
  });

  it('names baseball half-innings and extra innings', () => {
    const options = defaultOptions('baseball');
    assert.deepEqual(periodInfo('baseball', options, 0), { label: 'Top 1st', short: '▲1', isOvertime: false });
    assert.deepEqual(periodInfo('baseball', options, 1), { label: 'Bottom 1st', short: '▼1', isOvertime: false });
    assert.deepEqual(periodInfo('baseball', options, 13), { label: 'Bottom 7th', short: '▼7', isOvertime: false });
    assert.deepEqual(periodInfo('baseball', options, 14), { label: 'Top 8th', short: '▲8', isOvertime: true });
    assert.equal(maxPeriodIndex('baseball', options), null);
    assert.equal(SPORTS.baseball.periods.length, 14);
  });

  it('computes per-period clock minutes', () => {
    const football = defaultOptions('football');
    assert.equal(periodClockMinutes('football', football, 0), 12);
    assert.equal(periodClockMinutes('football', football, 4), 0, 'football overtime has no clock');
    assert.equal(periodClockMinutes('basketball', defaultOptions('basketball'), 4), 4);
    assert.equal(periodClockMinutes('basketball', { ...defaultOptions('basketball'), clockEnabled: false }, 0), 0);
    assert.equal(periodClockMinutes('baseball', defaultOptions('baseball'), 0), 0);
  });

  it('has defaults per sport', () => {
    assert.deepEqual(defaultOptions('basketball'), { clockEnabled: true, periodMinutes: 8, overtimeMinutes: 4, bestOf: null });
    assert.deepEqual(defaultOptions('volleyball'), { clockEnabled: false, periodMinutes: null, overtimeMinutes: null, bestOf: 3 });
    assert.deepEqual(defaultOptions('baseball'), { clockEnabled: false, periodMinutes: null, overtimeMinutes: null, bestOf: null });
  });

  it('exposes every sport with its id', () => {
    const rules = allRules();
    assert.deepEqual(Object.keys(rules).sort(), ['baseball', 'basketball', 'football', 'soccer', 'volleyball']);
    for (const [id, entry] of Object.entries(rules)) {
      assert.equal(entry.id, id);
      for (const key of ['name', 'symbol', 'scoreMode', 'periods', 'overtime', 'scoring', 'clock', 'notes']) assert.ok(key in entry, `${id}.${key}`);
    }
    assert.equal(rules.baseball.tracksOuts, true);
  });

  it('tells clients how overtime is numbered', () => {
    const rules = allRules();
    assert.deepEqual(
      Object.fromEntries(Object.entries(rules).map(([id, entry]) => [id, entry.overtime?.naming ?? null])),
      { basketball: 'prefix', football: 'prefix', soccer: 'suffix', volleyball: null, baseball: 'innings' },
    );
    assert.deepEqual(rules.basketball.overtime, { label: 'Overtime', short: 'OT', max: null, naming: 'prefix' });
    assert.deepEqual(rules.soccer.overtime, { label: 'Overtime', short: 'OT', max: 2, naming: 'suffix' });
    assert.deepEqual(rules.baseball.overtime, { label: 'Extra Innings', short: 'XI', max: null, naming: 'innings' });
    assert.equal(rulesFor('football', defaultOptions('football')).overtime.naming, 'prefix');
  });
});
