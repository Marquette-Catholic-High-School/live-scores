// Android Live Update pushes (ARCHITECTURE.md §8.6): what push.js does for
// iPhones over APNs, done for the Android app over Firebase Cloud Messaging.
// Every game start, coalesced update and end is ONE data message to the topics
// the app subscribes to: "live-games" (fans following every game) and
// "game-<id>" (fans following that game). It carries the two objects the Live
// Activity pushes carry (§8.5), built by the same functions, as JSON text.
//
// Off unless FCM_GAME_PUSH=1 and Firebase is set up (fcm.js). Nothing here
// throws into the caller: failures are logged and recorded in push_log, with
// "android" where the APNs rows have their environment. An end Firebase hasn't
// taken yet is kept in pending_ends (environment "android") and retried by the
// scheduler (resume()), across restarts too.

import { performance } from 'node:perf_hooks';
import { activityAttributes, activityChange, activityContentState } from './games.js';

// What push_log and pending_ends have in place of an APNs environment.
export const ANDROID = 'android';
export const ALL_GAMES_TOPIC = 'live-games';
export const gameTopic = (gameId) => `game-${gameId}`;

// How long Firebase keeps a message for a phone it can't reach right now. A
// start or an update is soon out of date; the end must still arrive, or the
// game's Live Update would stay up.
const LIVE_TTL = '120s';
const END_TTL = '7200s';
const MAX_UPDATE_INTERVAL_MS = 60_000;
const UPDATE_INTERVAL_STEP_MS = 1000;
// As for iPhones (§8.3): an end nobody could send for this long is dropped.
const END_GIVE_UP_MS = 8 * 60 * 60_000;
const END_RETRY_MS = 60_000;
const FLUSH_MAX_FORCED_SENDS = 3;
const DETAIL_MAX_LENGTH = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Unix ms when the game's running clock reaches 0:00; null while it is stopped
// (or the period has none).
function runningClockEnd(game) {
  return game.clock.ms !== null && game.clock.running ? game.clock.anchor + game.clock.ms : null;
}

// The content state the iPhones get (§8.5), with one difference: a running
// clock that has reached 0:00 is sent as stopped at 0:00. A notification's
// timer counts on below zero, and whether `clockEndsAt` has passed would
// otherwise depend on each phone's own clock.
function contentState(game, now, options) {
  const state = activityContentState(game, options);
  const end = runningClockEnd(game);
  if (end !== null && end <= now) {
    state.clockRemaining = 0;
    delete state.clockEndsAt;
  }
  return state;
}

// The FCM HTTP v1 `message` for one game event ('start' | 'update' | 'end').
// `collapse` adds a collapse key, so a phone that was offline gets only the
// game's latest message; Firebase delays collapsible messages sent as often as
// a game's updates are, which is why it is off unless FCM_GAME_COLLAPSE=1.
export function gameMessage(game, event, { now = Date.now(), canceled = false, collapse = false } = {}) {
  const topic = gameTopic(game.id);
  return {
    condition: `'${ALL_GAMES_TOPIC}' in topics || '${topic}' in topics`,
    android: {
      priority: 'HIGH',
      ...(collapse ? { collapse_key: topic } : {}),
      ttl: event === 'end' ? END_TTL : LIVE_TTL,
    },
    // Data values must be strings: the two objects travel as JSON text.
    data: {
      kind: 'game',
      event,
      attributes: JSON.stringify(activityAttributes(game)),
      state: JSON.stringify(contentState(game, now, canceled ? { note: 'Canceled' } : {})),
    },
  };
}

export class AndroidPushService {
  #db;
  #fcm;
  #config;
  #log;
  #now;
  #store;
  #retryDelaysMs;
  #games = new Map();
  #ends = new Set();
  #known = new Set();
  #inflight = new Set();
  #closed = false;

  // `store` provides getGame(id).
  constructor({ db, fcm, config, log, now = Date.now, store, retryDelaysMs = [1000, 3000, 10_000] }) {
    this.#db = db;
    this.#fcm = fcm;
    this.#config = config;
    this.#log = log;
    this.#now = now;
    this.#store = store;
    this.#retryDelaysMs = retryDelaysMs;
  }

  // Game pushes are switched on and Firebase is set up: what GET /api/config
  // reports as `androidLiveUpdates`.
  get configured() {
    return this.#config.android.gamePush && this.#fcm.configured;
  }

  get enabled() {
    return this.configured && !this.#closed;
  }

  // The same interval as the APNs updates (§8.2).
  get #baseIntervalMs() {
    return this.#config.apns.minUpdateIntervalMs;
  }

  // GET /api/admin/status → android. `error`: switched on, but Firebase isn't set up.
  status() {
    if (this.configured) return { enabled: true, projectId: this.#fcm.projectId };
    return this.#config.android.gamePush ? { enabled: false, projectId: null, error: this.#fcm.error } : { enabled: false, projectId: null };
  }

  #track(promise) {
    const tracked = promise.catch((err) => this.#log?.error('android push flow failed', { err }));
    this.#inflight.add(tracked);
    tracked.finally(() => this.#inflight.delete(tracked));
    return tracked;
  }

  #record(gameId, kind, sent, failed, detail) {
    try {
      this.#db.run(
        'INSERT INTO push_log (game_id, kind, environment, sent, failed, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        gameId, kind, ANDROID, sent, failed, String(detail ?? '').slice(0, DETAIL_MAX_LENGTH), this.#now(),
      );
    } catch (err) {
      this.#log?.warn('could not write push_log', { err: err.message });
    }
  }

  // A failure (the database is closing) is logged, never thrown into a push flow.
  #write(sql, ...params) {
    try {
      this.#db.run(sql, ...params);
    } catch (err) {
      this.#log?.warn('could not save push state', { err: err.message });
    }
  }

  #reportFailure(event, gameId, result) {
    const fields = { gameId, status: result.status ?? undefined, error: result.error };
    if (result.setup) this.#log?.error(`FCM game ${event} failed: Firebase refused the service account`, fields);
    else this.#log?.warn(`FCM game ${event} failed`, fields);
  }

  #message(game, event, options) {
    return gameMessage(game, event, { collapse: this.#config.android.collapse, ...options });
  }

  // No retries inside the client: the flows below retry themselves, an update
  // with whatever the state is by then.
  #send(message) {
    return this.#fcm.send(message, { retryDelaysMs: [] });
  }

  // ---- start and updates ----

  // The game's first message. It is sent like an update (one message at a
  // time per game), so a change made while it is on its way goes out after it.
  start(game) {
    if (!this.enabled) return;
    this.#known.add(game.id);
    const state = this.#state(game.id);
    state.event = 'start';
    this.#markDirty(game.id, state);
  }

  // Called after every committed change: the same live→live changes the APNs
  // updates cover (§8.2). The fixed attributes travel with every message, so
  // an edited label reaches phones with the next one.
  changed(before, after) {
    if (!this.enabled || !before || !after) return;
    if (before.status !== 'live' || after.status !== 'live') return;
    if (!activityChange(before, after).changed) return;
    this.#known.add(after.id);
    this.#markDirty(after.id);
  }

  #state(gameId) {
    let state = this.#games.get(gameId);
    if (!state) {
      state = {
        event: 'update',
        intervalMs: this.#baseIntervalMs,
        lastSentAt: -Infinity,
        timer: null,
        sending: null,
        dirty: false,
        urgent: false,
        // Unix ms until which the phones believe the clock runs: what the last
        // message Firebase took said. Null: stopped, or no clock.
        runningUntil: null,
        clockTimer: null,
      };
      this.#games.set(gameId, state);
    }
    return state;
  }

  #drop(gameId, state) {
    clearTimeout(state.timer);
    clearTimeout(state.clockTimer);
    state.timer = null;
    state.clockTimer = null;
    state.dirty = false;
    if (this.#games.get(gameId) === state) this.#games.delete(gameId);
  }

  #markDirty(gameId, state = this.#state(gameId)) {
    state.dirty = true;
    this.#pump(gameId, state);
  }

  // Leading + trailing coalescing, as for the APNs updates: send now if the
  // interval has passed, otherwise once it has (with whatever the latest state
  // is by then). An urgent update doesn't wait, unless Firebase is being
  // backed off from.
  #pump(gameId, state) {
    if (this.#closed || state.sending || !state.dirty) return;
    const urgent = state.urgent && state.intervalMs <= this.#baseIntervalMs;
    const wait = urgent ? 0 : state.lastSentAt + state.intervalMs - performance.now();
    if (wait > 0) {
      state.timer ??= setTimeout(() => {
        state.timer = null;
        this.#pump(gameId, state);
      }, wait);
      return;
    }
    clearTimeout(state.timer);
    state.timer = null;
    state.sending = this.#track(this.#sendUpdate(gameId, state)).finally(() => {
      state.sending = null;
      if (this.#games.get(gameId) !== state) return;
      this.#watchClock(gameId, state);
      this.#pump(gameId, state);
    });
  }

  async #sendUpdate(gameId, state) {
    state.dirty = false;
    state.urgent = false;
    state.lastSentAt = performance.now();
    const game = this.#store.getGame(gameId);
    if (!game || game.status !== 'live') {
      this.#drop(gameId, state);
      return;
    }
    const event = state.event;
    const now = this.#now();
    const result = await this.#send(this.#message(game, event, { now }));
    if (this.#closed) return;
    if (result.ok) {
      if (event === 'start') {
        state.event = 'update';
        // As with APNs, the game's first update isn't held back by its start.
        state.lastSentAt = -Infinity;
      }
      const end = runningClockEnd(game);
      state.runningUntil = end !== null && end > now ? end : null;
      state.intervalMs = Math.max(this.#baseIntervalMs, state.intervalMs - UPDATE_INTERVAL_STEP_MS);
      this.#record(gameId, event, 1, 0, `v${game.version}`);
    } else {
      this.#record(gameId, event, 0, 1, result.error);
      this.#reportFailure(event, gameId, result);
      if (result.transient) {
        // Sent again, at a slower pace, like a throttled APNs update (§8.4).
        state.dirty = true;
        state.intervalMs = Math.min(MAX_UPDATE_INTERVAL_MS, Math.max(state.intervalMs * 2, UPDATE_INTERVAL_STEP_MS));
      }
    }
    // The game ended or was deleted meanwhile: the end flow has taken over.
    const current = this.#store.getGame(gameId);
    if (!current || current.status !== 'live' || this.#games.get(gameId) !== state) this.#drop(gameId, state);
  }

  // The server makes no change when a clock runs out, but a notification's
  // timer counts on below 0:00. So the moment the clock the phones know about
  // (`state.runningUntil`) gets there, an update goes out without waiting for
  // the interval: the clock stopped at 0:00, or whatever happened to it since
  // that hasn't been sent yet. Runs after every send, and from its own timer.
  #watchClock(gameId, state) {
    clearTimeout(state.clockTimer);
    state.clockTimer = null;
    if (state.runningUntil === null || this.#closed || this.#games.get(gameId) !== state) return;
    const left = state.runningUntil - this.#now();
    if (left > 0) {
      state.clockTimer = setTimeout(() => this.#watchClock(gameId, state), left);
      state.clockTimer.unref();
      return;
    }
    // A message on its way may already say so: this runs again once it is back.
    if (state.sending) return;
    state.runningUntil = null;
    state.urgent = true;
    this.#markDirty(gameId, state);
  }

  // Current per-game update interval (exposed for status/tests).
  updateIntervalMs(gameId) {
    return this.#games.get(gameId)?.intervalMs ?? this.#baseIntervalMs;
  }

  // ---- end ----

  end(game, { canceled = false } = {}) {
    if (!this.enabled) return;
    const state = this.#games.get(game.id);
    const previous = state?.sending ?? null;
    if (state) this.#drop(game.id, state);
    // Saved right away, so neither a restart nor deleting the game loses it.
    const now = this.#now();
    const row = {
      game_id: game.id,
      payload: JSON.stringify(this.#message(game, 'end', { now, canceled })),
      detail: canceled ? 'canceled' : 'final',
      created_at: now,
    };
    this.#write(
      `INSERT OR REPLACE INTO pending_ends (game_id, environment, channel_id, payload, detail, created_at, next_attempt_at)
       VALUES (?, ?, '', ?, ?, ?, ?)`,
      row.game_id, ANDROID, row.payload, row.detail, now, now,
    );
    this.#track(this.#deliverEnd(row, { after: previous }));
  }

  // The end must reach the phones, or the game's Live Update stays up:
  // transient failures and setup errors are retried here, then by the
  // scheduler every minute, until Firebase takes the message or 8 h have
  // passed. `after`: an update still on its way, which the end must follow
  // (the game is claimed first, so the scheduler can't send it sooner).
  async #deliverEnd(row, { delays = this.#retryDelaysMs, after = null } = {}) {
    if (this.#ends.has(row.game_id)) return;
    this.#ends.add(row.game_id);
    try {
      if (after) await after;
      const message = JSON.parse(row.payload);
      const forget = () => this.#write('DELETE FROM pending_ends WHERE game_id = ? AND environment = ?', row.game_id, ANDROID);
      for (let attempt = 0; ; attempt += 1) {
        if (this.#closed) return;
        const result = await this.#send(message);
        if (this.#closed) return;
        if (result.ok) {
          forget();
          this.#record(row.game_id, 'end', 1, 0, row.detail);
          return;
        }
        if (!(result.transient || result.setup) || this.#now() - row.created_at >= END_GIVE_UP_MS) {
          forget();
          this.#record(row.game_id, 'end', 0, 1, result.error);
          this.#reportFailure('end', row.game_id, result);
          return;
        }
        if (attempt < delays.length) {
          await sleep(delays[attempt]);
          continue;
        }
        this.#write(
          'UPDATE pending_ends SET next_attempt_at = ? WHERE game_id = ? AND environment = ?',
          this.#now() + END_RETRY_MS, row.game_id, ANDROID,
        );
        if (delays.length) {
          this.#record(row.game_id, 'end', 0, 1, `${result.error} (retrying every minute)`);
          this.#reportFailure('end', row.game_id, result);
        }
        return;
      }
    } finally {
      this.#ends.delete(row.game_id);
    }
  }

  // The game row is gone: drop local state. An end still pending for it is
  // delivered all the same (it holds the whole message).
  forget(game) {
    const state = this.#games.get(game.id);
    if (state) this.#drop(game.id, state);
    this.#known.delete(game.id);
  }

  // ---- recovery (scheduler, every minute) ----

  // Finishes what a restart or a Firebase outage interrupted: one fresh update
  // for live games this process hasn't pushed yet (the last change before a
  // restart may never have gone out; it also restarts the watch on a running
  // clock), and ends not yet delivered.
  async resume() {
    const summary = { resynced: 0, ends: 0 };
    if (!this.enabled) {
      // Left over from when game pushes were on: nothing will send them.
      if (!this.#closed) this.#write('DELETE FROM pending_ends WHERE environment = ? AND created_at <= ?', ANDROID, this.#now() - END_GIVE_UP_MS);
      return summary;
    }
    for (const { id } of this.#db.all("SELECT id FROM games WHERE status = 'live'")) {
      if (this.#known.has(id)) continue;
      this.#known.add(id);
      this.#markDirty(id);
      summary.resynced += 1;
    }
    const ends = [];
    for (const row of this.#db.all('SELECT * FROM pending_ends WHERE environment = ? AND next_attempt_at <= ?', ANDROID, this.#now())) {
      if (this.#ends.has(row.game_id)) continue;
      ends.push(this.#track(this.#deliverEnd(row, { delays: [] })));
    }
    summary.ends = ends.length;
    await Promise.all(ends);
    return summary;
  }

  // ---- shutdown ----

  // Sends pending trailing updates immediately (bypassing the interval) and
  // waits, bounded, until nothing is left to send or in flight.
  async flush(timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    const forced = new Map();
    for (;;) {
      for (const [gameId, state] of this.#games) {
        if (!state.dirty || state.sending || (forced.get(gameId) ?? 0) >= FLUSH_MAX_FORCED_SENDS) continue;
        forced.set(gameId, (forced.get(gameId) ?? 0) + 1);
        state.lastSentAt = -Infinity;
        this.#pump(gameId, state);
      }
      const remaining = deadline - performance.now();
      if (this.#inflight.size === 0 || remaining <= 0) return;
      let timer;
      await Promise.race([
        Promise.race([...this.#inflight]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, remaining);
        }),
      ]);
      clearTimeout(timer);
    }
  }

  close() {
    this.#closed = true;
    for (const state of this.#games.values()) {
      clearTimeout(state.timer);
      clearTimeout(state.clockTimer);
    }
    this.#games.clear();
  }
}
