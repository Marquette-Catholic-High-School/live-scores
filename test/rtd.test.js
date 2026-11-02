import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIELDS, RtdReader, encodeField, encodeFrame, parseClockText } from '../server/rtd.js';

// A real frame from an All Sport 5000 (clock block, items 1-31, clock stopped).
const CAPTURED = Buffer.from('\x1600000000\x010042100000\x0216:0916:09   16:0916:09    s   \x0449\x17', 'latin1');

function block(fields) {
  const text = Buffer.alloc(700, 0x20);
  for (const [item, value] of fields) Buffer.from(value, 'latin1').copy(text, item - 1);
  return text.toString('latin1');
}

describe('RTD reader', () => {
  it('reads a captured frame and checks its checksum', () => {
    const reader = new RtdReader();
    assert.equal(reader.push(CAPTURED), 1);
    assert.equal(reader.badFrames, 0);
    const reading = reader.reading('basketball');
    assert.equal(reading.clockMs, 16 * 60_000 + 9_000);
    assert.equal(reading.clockRunning, false);
    assert.equal(reading.home, null, 'scores are unknown until a frame covers them');
    assert.equal(reading.period, null);
  });

  it('builds frames the same way the console does', () => {
    assert.deepEqual(encodeFrame(0, '16:0916:09   16:0916:09    s   '), CAPTURED);
  });

  it('handles frames split and merged across TCP reads, and garbage between them', () => {
    const stream = Buffer.concat([
      Buffer.from('noise\x17\x04'),
      encodeField(...FIELDS.homeScore, '12', { right: true }),
      encodeField(...FIELDS.guestScore, '9', { right: true }),
      CAPTURED,
      encodeField(...FIELDS.period, '2', { right: true }),
    ]);
    const reader = new RtdReader();
    for (const byte of stream) reader.push(Buffer.from([byte]));
    assert.equal(reader.dataFrames, 4);
    assert.equal(reader.badFrames, 0);
    const reading = reader.reading('basketball');
    assert.equal(reading.home, 12);
    assert.equal(reading.away, 9);
    assert.equal(reading.period, 2);
  });

  it('drops corrupted and cut-off frames and keeps going', () => {
    const good = encodeField(...FIELDS.homeScore, '30', { right: true });
    const corrupted = Buffer.from(encodeField(...FIELDS.guestScore, '99', { right: true }));
    corrupted[corrupted.length - 6] = 0x37; // a data byte changed in transit
    const cut = encodeField(...FIELDS.period, '4', { right: true }).subarray(0, 12);
    const reader = new RtdReader();
    reader.push(Buffer.concat([corrupted, cut, good]));
    assert.equal(reader.badFrames, 2);
    const reading = reader.reading('basketball');
    assert.equal(reading.home, 30);
    assert.equal(reading.away, null);
    assert.equal(reading.period, null);
  });

  it('ignores control frames, frames past the block and runaway data', () => {
    const control = Buffer.from('\x1600000000\x01003010006\x043F\x17', 'latin1');
    const reader = new RtdReader();
    assert.equal(reader.push(control), 0);
    assert.equal(reader.badFrames, 0, 'a valid control frame is not an error');
    assert.equal(reader.push(encodeFrame(1020, 'abcdefgh')), 0);
    assert.equal(reader.badFrames, 1);
    reader.push(Buffer.concat([Buffer.from([0x16]), Buffer.alloc(3000, 0x41)]));
    reader.push(encodeField(...FIELDS.homeScore, '5', { right: true }));
    assert.equal(reader.reading('basketball').home, 5);
  });

  it('reads positions shifted by the console RTD OFFSET setting', () => {
    const reader = new RtdReader();
    // Header 0042105107 = offset 5000 + item 108.
    const data = '  41';
    const head = Buffer.from(`00000000\x010042105107\x02${data}\x04`, 'latin1');
    let sum = 0;
    for (const byte of head) sum = (sum + byte) & 0xff;
    reader.push(Buffer.concat([Buffer.from([0x16]), head, Buffer.from(sum.toString(16).toUpperCase().padStart(2, '0')), Buffer.from([0x17])]));
    assert.equal(reader.reading('basketball').home, 41);
  });

  it('reads a full basketball block', () => {
    const text = block([[1, ' 4:32'], [28, ' '], [108, '  56'], [112, '  48'], [142, ' 3'], [184, '1101']]);
    const reader = new RtdReader();
    reader.push(encodeFrame(0, text));
    assert.deepEqual(reader.reading('basketball'), { clockMs: 272_000, clockRunning: true, home: 56, away: 48, period: 3, sportCode: 1101 });
  });

  it('reads volleyball points, game number and finished games', () => {
    const text = block([[1, '     '], [28, 's'], [108, '  12'], [112, '   8'], [142, ' 3'], [222, '25'], [242, '21'], [224, '19'], [244, '25'], [226, ' 0'], [246, ' 0']]);
    const reader = new RtdReader();
    reader.push(encodeFrame(0, text));
    const reading = reader.reading('volleyball');
    assert.equal(reading.home, 12);
    assert.equal(reading.away, 8);
    assert.equal(reading.period, 3);
    assert.equal(reading.clockMs, null, 'a blank clock is unknown, not 0:00');
    assert.deepEqual(reading.games.slice(0, 3), [{ home: 25, away: 21 }, { home: 19, away: 25 }, { home: 0, away: 0 }]);
  });

  it('parses every main clock format', () => {
    const cases = {
      '12:00': 720_000,
      ' 7:53': 473_000,
      '0:45': 45_000,
      ':59.1': 59_100,
      ': 9.5': 9_500,
      '45.3': 45_300,
      ' 9.5': 9_500,
      '0:00': 0,
      '     ': null,
      '8:60': null,
      'HOME ': null,
    };
    for (const [text, ms] of Object.entries(cases)) assert.equal(parseClockText(text), ms, JSON.stringify(text));
  });
});

describe('RTD reader performance', () => {
  it('stays linear on a flood of SYN bytes', () => {
    const reader = new RtdReader();
    const started = performance.now();
    reader.push(Buffer.alloc(1 << 20, 0x16));
    for (let i = 0; i < 16; i += 1) reader.push(Buffer.alloc(1 << 16, 0x16));
    assert.ok(performance.now() - started < 200, `took ${Math.round(performance.now() - started)} ms`);
    reader.push(encodeField(...FIELDS.homeScore, '7', { right: true }));
    assert.equal(reader.reading('basketball').home, 7, 'recovers afterwards');
  });
});
