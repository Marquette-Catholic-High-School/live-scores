// Reader for the Daktronics All Sport 5000 "Enhanced RTD" (real-time data)
// stream, as a Lantronix serial-to-Ethernet box forwards it (ARCHITECTURE.md
// §11). Only the fields live scores use are read: score, main clock and
// period (volleyball: points in the current game, game number, and each
// finished game's score).
//
// The console keeps its sport data as one fixed-width ASCII block and sends
// it in frames, each carrying a piece of the block at an offset - the clock
// every second, other fields when they change, and the whole block when the
// clock stops:
//
//   SYN "00000000" SOH header [STX data] EOT checksum ETB
//
// The header "004210NNNN" gives the 0-based position of `data` in the block
// (Daktronics numbers fields from 1, so field N starts at N - 1). The checksum
// is the sum of the bytes after SYN up to and including EOT, mod 256, as two
// uppercase hex digits. Other headers are control frames and carry no data.
// Sources: Daktronics ED-12483 and the AS5-Basketball / AS5-Volleyball data
// definitions; several independent open-source parsers agree on every field.

const SYN = 0x16;
const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const ETB = 0x17;

export const BLOCK_SIZE = 1024;
// A full block is under 700 bytes; anything much longer is not a frame.
const MAX_FRAME_BYTES = 2048;
// "00421" + 5 digits. The console's RTD OFFSET setting adds 5000, 10000 or
// 15000 to every position; the remainder is the position in the block.
const DATA_HEADER = /^00421(\d{5})$/;
const OFFSET_STEP = 5000;

// 1-based field positions and lengths (ED-12483 §4 Basketball, §19 Volleyball;
// the clock, score and period fields are the same in both).
export const FIELDS = Object.freeze({
  clock: [1, 5], // "mm:ss", or "ss.t" under a minute
  clockAlt: [6, 8], // "mm:ss.t"
  clockStopped: [28, 1], // "s" = stopped, " " = running
  homeScore: [108, 4],
  guestScore: [112, 4],
  period: [142, 2], // basketball: period; volleyball: game number
  sportCode: [184, 4], // undocumented, only in full blocks: 1xxx basketball, 2xxx volleyball
  // Volleyball: score of game N at 222 + 2(N-1) (home) and 242 + 2(N-1) (guest).
  volleyballGameHome: [222, 2],
  volleyballGameGuest: [242, 2],
});
export const VOLLEYBALL_GAMES = 9;

// Parses the main clock text into milliseconds, or null if it isn't a time.
// Handles "12:00", " 7:53", "0:45", ":59.1", ": 9.5" (the console can blank
// leading zeros) and "45.3" (tenths under a minute).
export function parseClockText(text) {
  if (typeof text !== 'string') return null;
  const value = text.replace(/ /g, '');
  let match = /^(\d{0,2}):(\d{1,2})(?:\.(\d))?$/.exec(value);
  if (match) {
    const seconds = Number(match[2]);
    if (seconds > 59) return null;
    return (Number(match[1] || 0) * 60 + seconds) * 1000 + Number(match[3] || 0) * 100;
  }
  match = /^(\d{1,2})\.(\d)$/.exec(value);
  if (match) return Number(match[1]) * 1000 + Number(match[2]) * 100;
  return null;
}

function parseNumber(text) {
  if (text === null) return null;
  const value = text.trim();
  return /^\d{1,4}$/.test(value) ? Number(value) : null;
}

// One scoreboard's data block, built up from frames. Positions no frame has
// written since the reader was created are unknown: after connecting, the
// console sends only what changes until the next full block, so an unwritten
// score must never be read as 0.
export class RtdReader {
  #pending = Buffer.alloc(0);
  #block = Buffer.alloc(BLOCK_SIZE, 0x20);
  #known = new Uint8Array(BLOCK_SIZE);
  frames = 0;
  dataFrames = 0;
  badFrames = 0;
  bytes = 0;

  // Feeds raw bytes in any chunking; returns how many data frames were applied.
  push(chunk) {
    this.bytes += chunk.length;
    let buffer = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    let applied = 0;
    for (;;) {
      const start = buffer.indexOf(SYN);
      if (start === -1) {
        buffer = Buffer.alloc(0);
        break;
      }
      const end = buffer.indexOf(ETB, start + 1);
      if (end === -1) {
        // Only a frame starting at the last SYN can still complete. Keeping
        // just that keeps this linear however much garbage arrives.
        const last = buffer.lastIndexOf(SYN);
        if (last > start) this.badFrames += 1;
        buffer = buffer.subarray(last);
        if (buffer.length > MAX_FRAME_BYTES) {
          this.badFrames += 1;
          buffer = Buffer.alloc(0);
        }
        break;
      }
      // A SYN before the ETB means the earlier frame was cut off.
      const restart = buffer.lastIndexOf(SYN, end);
      if (restart > start) this.badFrames += 1;
      if (this.#frame(buffer.subarray(restart + 1, end))) applied += 1;
      buffer = buffer.subarray(end + 1);
    }
    this.#pending = Buffer.from(buffer);
    return applied;
  }

  // body = the bytes between SYN and ETB.
  #frame(body) {
    const eot = body.length - 3;
    if (eot < 1 || body[eot] !== EOT) {
      this.badFrames += 1;
      return false;
    }
    let sum = 0;
    for (let i = 0; i <= eot; i += 1) sum = (sum + body[i]) & 0xff;
    if (body.subarray(eot + 1).toString('latin1') !== sum.toString(16).toUpperCase().padStart(2, '0')) {
      this.badFrames += 1;
      return false;
    }
    const soh = body.indexOf(SOH);
    if (soh === -1 || soh > eot) {
      this.badFrames += 1;
      return false;
    }
    this.frames += 1;
    const stx = body.indexOf(STX, soh + 1);
    const headerEnd = stx === -1 || stx > eot ? eot : stx;
    const header = body.subarray(soh + 1, headerEnd).toString('latin1');
    const match = DATA_HEADER.exec(header);
    if (!match || headerEnd === eot) return false;
    const offset = Number(match[1]) % OFFSET_STEP;
    const data = body.subarray(stx + 1, eot);
    if (offset + data.length > BLOCK_SIZE) {
      this.badFrames += 1;
      return false;
    }
    data.copy(this.#block, offset);
    this.#known.fill(1, offset, offset + data.length);
    this.dataFrames += 1;
    return true;
  }

  // Text of the field at 1-based `item`, or null while any of it is unknown.
  field(item, length) {
    const start = item - 1;
    for (let i = start; i < start + length; i += 1) if (!this.#known[i]) return null;
    return this.#block.toString('latin1', start, start + length);
  }

  // What the scoreboard shows now. Every value is null while unknown.
  reading(sport) {
    const text = (name) => this.field(...FIELDS[name]);
    const clock = text('clock');
    let clockMs = parseClockText(clock);
    if (clockMs === null && clock !== null) clockMs = parseClockText(text('clockAlt'));
    const stopped = text('clockStopped');
    const reading = {
      clockMs,
      clockRunning: stopped === 's' ? false : stopped === ' ' ? true : null,
      home: parseNumber(text('homeScore')),
      away: parseNumber(text('guestScore')),
      period: parseNumber(text('period')),
      sportCode: parseNumber(text('sportCode')),
    };
    if (reading.period === 0) reading.period = null;
    if (sport === 'volleyball') {
      reading.games = [];
      for (let n = 0; n < VOLLEYBALL_GAMES; n += 1) {
        const home = parseNumber(this.field(FIELDS.volleyballGameHome[0] + 2 * n, 2));
        const away = parseNumber(this.field(FIELDS.volleyballGameGuest[0] + 2 * n, 2));
        reading.games.push(home === null || away === null ? null : { home, away });
      }
    }
    return reading;
  }
}

// ---- building frames (tests, and the simulator script) ----------------------

// One data frame carrying `data` at 0-based block position `offset`.
export function encodeFrame(offset, data) {
  const head = Buffer.from(`00000000\x01004210${String(offset).padStart(4, '0')}\x02${data}\x04`, 'latin1');
  let sum = 0;
  for (const byte of head) sum = (sum + byte) & 0xff;
  return Buffer.concat([Buffer.from([SYN]), head, Buffer.from(sum.toString(16).toUpperCase().padStart(2, '0'), 'latin1'), Buffer.from([ETB])]);
}

// A frame setting the field at 1-based `item` (padded or cut to `length`).
export function encodeField(item, length, value, { right = false } = {}) {
  const text = String(value);
  const padded = right ? text.padStart(length, ' ').slice(-length) : text.padEnd(length, ' ').slice(0, length);
  return encodeFrame(item - 1, padded);
}
