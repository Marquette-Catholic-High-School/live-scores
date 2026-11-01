// Server-time estimate and the shared ticker that drives running game clocks.
//
// ARCHITECTURE.md §6: a running clock shows
//   remainingMs − (estimatedServerNow − anchorAt), clamped at 0,
// where estimatedServerNow = Date.now() + (serverTime − receivedAt).
//
// serverTime is stamped before the response or event leaves the server, so
// each sample undershoots the true offset by its delivery time — and a phone
// that froze the tab delivers buffered SSE events many seconds late. So a
// sample only ever raises the estimate. An API response also bounds it from
// above (serverTime − the time the request was sent), which brings it back
// down after the device clock is set forward.

let offsetMs = null;

export function noteServerTime(serverTime, receivedAt = Date.now(), sentAt = null) {
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return;
  const low = serverTime - receivedAt;
  offsetMs = offsetMs === null ? low : Math.max(offsetMs, low);
  if (sentAt !== null && serverTime - sentAt >= low) offsetMs = Math.min(offsetMs, serverTime - sentAt);
}

export function serverNow() {
  return Date.now() + (offsetMs ?? 0);
}

// Remaining milliseconds of a Game JSON `clock` object, or null when the
// current period has no clock.
export function clockRemainingMs(clock, now = serverNow()) {
  if (!clock) return null;
  if (!clock.running) return Math.max(0, clock.remainingMs);
  // Clamped at remainingMs too: if the device clock steps back after the
  // last sync, a running clock must not count up past its stored value.
  return Math.max(0, clock.remainingMs - Math.max(0, now - clock.anchorAt));
}

// m:ss, rounding up so 0:00 appears only when time has actually run out
// (the same convention as the Lock Screen countdown).
export function formatClock(ms) {
  if (ms === null || ms === undefined) return '';
  const totalSeconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function splitClock(ms) {
  const totalSeconds = Math.ceil(Math.max(0, ms ?? 0) / 1000);
  return { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 };
}

// One interval for the whole page; it only runs while something listens.
const TICK_MS = 250;
const listeners = new Set();
let timer = null;

function runTick() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('tick listener failed', err);
    }
  }
}

export function onTick(listener) {
  listeners.add(listener);
  if (timer === null) timer = setInterval(runTick, TICK_MS);
  listener();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

if (typeof document !== 'undefined') {
  // Browsers throttle timers in background tabs; catch up the moment the
  // page is visible again instead of showing a stale clock for a tick.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') runTick();
  });
}
