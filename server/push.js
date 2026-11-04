// Live Activity push flows (ARCHITECTURE.md §8): push-to-start fan-out when a
// game starts, coalesced broadcast updates while it is live, the end
// broadcast, and broadcast-channel lifecycle. Nothing here throws into the
// caller: failures are logged and recorded in push_log.
//
// What must survive a restart lives in SQLite: per-game APNs timestamps and
// push-to-start progress (push_progress), end broadcasts not yet delivered
// (pending_ends) and channels waiting to be deleted (channel_cleanup). The
// scheduler calls resume() and deleteDueChannels() to finish them.

import { performance } from 'node:perf_hooks';
import { CHANNEL_GONE_REASONS, INVALID_TOKEN_REASONS, SETUP_ERROR_REASONS, describeFailure, setupHint } from './apns.js';
import { activityAttributes, activityChange, activityContentState, gameLabel } from './games.js';

const ENVIRONMENTS = ['production', 'sandbox'];
const START_CONCURRENCY = 100;
// Devices claimed per step of a fan-out; the claim is persisted before any of
// them is sent, so a crash skips at most this many rather than resending.
const START_BLOCK = 100;
const STALE_AFTER_SEC = 30 * 60;
const STALE_AFTER_CLOCK_SEC = 10 * 60;
const DISMISS_AFTER_SEC = 2 * 60 * 60;
const STORED_MESSAGE_TTL_SEC = 8 * 60 * 60;
const MAX_UPDATE_INTERVAL_MS = 60_000;
const UPDATE_INTERVAL_STEP_MS = 1000;
const CHANNEL_DELETE_RETRY_MS = 10 * 60_000;
export const CHANNEL_RETENTION_MS = 6 * 60 * 60_000;
// iOS ends every Live Activity after 8 h, so an end older than that is moot.
const END_GIVE_UP_MS = 8 * 60 * 60_000;
const END_RETRY_MS = 60_000;
const FLUSH_MAX_FORCED_SENDS = 3;
const START_STATUS_CHECK_EVERY = 50;
const DETAIL_MAX_LENGTH = 500;
// Network failures where the request certainly never reached APNs.
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_TRANSPORT_CLOSED',
  'NGHTTP2_REFUSED_STREAM',
  'ERR_HTTP2_GOAWAY_SESSION',
  'ERR_HTTP2_INVALID_SESSION',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInvalidToken(result) {
  return result.status === 410 || (result.status === 400 && INVALID_TOKEN_REASONS.has(result.reason));
}

function isTransient(result) {
  return result.status === 429 || result.status >= 500 || (result.status === 0 && result.network === true);
}

function summarize(counts) {
  return [...counts.entries()].map(([reason, n]) => `${reason}×${n}`).join(', ');
}

const channelColumn = (environment) => (environment === 'production' ? 'channel_production' : 'channel_sandbox');

export class PushService {
  #db;
  #apns;
  #config;
  #log;
  #now;
  #store;
  #retryDelaysMs;
  #startRetryDelayMs;
  #channelRetryDelaysMs;
  #startSettleMs;
  #timestamps = new Map();
  #channelCreations = new Map();
  #updates = new Map();
  #starts = new Map();
  #ends = new Set();
  #known = new Set();
  #inflight = new Set();
  #closed = false;

  // `store` provides getGame(id) and setChannel(id, env, channelId|null).
  constructor({
    db,
    apns,
    config,
    log,
    now = Date.now,
    store,
    retryDelaysMs = [1000, 3000, 10_000],
    startRetryDelayMs = 1000,
    channelRetryDelaysMs = [1000, 3000, 10_000, 30_000],
    startSettleMs = 5000,
  }) {
    this.#db = db;
    this.#apns = apns;
    this.#config = config;
    this.#log = log;
    this.#now = now;
    this.#store = store;
    this.#retryDelaysMs = retryDelaysMs;
    this.#startRetryDelayMs = startRetryDelayMs;
    this.#channelRetryDelaysMs = channelRetryDelaysMs;
    this.#startSettleMs = startSettleMs;
  }

  get enabled() {
    return this.#apns.configured && !this.#closed;
  }

  get #environments() {
    return this.#config.apns.environments;
  }

  get #baseIntervalMs() {
    return this.#config.apns.minUpdateIntervalMs;
  }

  // Devices a push-to-start would go to right now.
  recipientCount() {
    if (!this.#apns.configured) return 0;
    const envs = this.#environments;
    return this.#db.get(
      `SELECT COUNT(*) AS n FROM devices
        WHERE environment IN (${envs.map(() => '?').join(', ')})
          AND enabled = 1 AND activities_enabled = 1 AND invalid_at IS NULL`,
      ...envs,
    ).n;
  }

  #track(promise) {
    const tracked = promise.catch((err) => this.#log?.error('push flow failed', { err }));
    this.#inflight.add(tracked);
    tracked.finally(() => this.#inflight.delete(tracked));
    return tracked;
  }

  #record(gameId, kind, environment, sent, failed, detail) {
    try {
      this.#db.run(
        'INSERT INTO push_log (game_id, kind, environment, sent, failed, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        gameId, kind, environment, sent, failed, String(detail ?? '').slice(0, DETAIL_MAX_LENGTH), this.#now(),
      );
    } catch (err) {
      this.#log?.warn('could not write push_log', { err: err.message });
    }
  }

  // Writes push state; a failure (the game was just deleted, or the database
  // is closing) is logged, never thrown into a push flow.
  #write(sql, ...params) {
    try {
      this.#db.run(sql, ...params);
    } catch (err) {
      this.#log?.warn('could not save push state', { err: err.message });
    }
  }

  #reportFailure(context, gameId, environment, result) {
    const fields = { gameId, environment, status: result.status, reason: result.reason, error: result.error };
    if (SETUP_ERROR_REASONS.has(result.reason) || CHANNEL_GONE_REASONS.has(result.reason)) {
      this.#log?.error(`APNs ${context} failed: setup problem`, { ...fields, hint: setupHint(result.reason) });
    } else {
      this.#log?.warn(`APNs ${context} failed`, fields);
    }
  }

  // aps.timestamp must strictly increase per game and environment, across
  // restarts too, so the last one sent is persisted.
  #nextTimestamp(gameId, environment) {
    const key = `${gameId}:${environment}`;
    let last = this.#timestamps.get(key);
    if (last === undefined) {
      last = this.#db.get('SELECT last_timestamp FROM push_progress WHERE game_id = ? AND environment = ?', gameId, environment)?.last_timestamp ?? 0;
    }
    const timestamp = Math.max(Math.floor(this.#now() / 1000), last + 1);
    this.#timestamps.set(key, timestamp);
    this.#write(
      `INSERT INTO push_progress (game_id, environment, last_timestamp) VALUES (?, ?, ?)
       ON CONFLICT (game_id, environment) DO UPDATE SET last_timestamp = excluded.last_timestamp`,
      gameId, environment, timestamp,
    );
    return timestamp;
  }

  // Stale 30 min after the update — or, while a clock runs, 10 min after it
  // reaches 0:00, since a running clock produces no pushes.
  #staleDate(game) {
    const nowSec = Math.floor(this.#now() / 1000);
    let stale = nowSec + STALE_AFTER_SEC;
    if (game.clock.ms !== null && game.clock.running) {
      stale = Math.max(stale, Math.ceil((game.clock.anchor + game.clock.ms) / 1000) + STALE_AFTER_CLOCK_SEC);
    }
    return stale;
  }

  #broadcastExpiration() {
    if (this.#config.apns.channelStoragePolicy === 0) return 0;
    return Math.floor(this.#now() / 1000) + STORED_MESSAGE_TTL_SEC;
  }

  // ---- channels ----

  // Creates the game's channel for `environment` unless it already has one.
  // Concurrent callers share one creation so a channel is never leaked.
  #ensureChannel(gameId, environment) {
    const key = `${gameId}:${environment}`;
    const pending = this.#channelCreations.get(key);
    if (pending) return pending;
    const game = this.#store.getGame(gameId);
    if (!game) return Promise.resolve(null);
    if (game.channels[environment]) return Promise.resolve(game.channels[environment]);

    const creation = (async () => {
      const result = await this.#apns.createChannel(environment, this.#config.apns.channelStoragePolicy);
      if (this.#closed) {
        if (result.ok) this.#scheduleChannelDeletion(environment, result.channelId, gameId, this.#now());
        return null;
      }
      if (!result.ok) {
        this.#record(gameId, 'channel', environment, 0, 1, `create failed: ${describeFailure(result)}`);
        this.#reportFailure('channel create', gameId, environment, result);
        return null;
      }
      this.#record(gameId, 'channel', environment, 1, 0, `created ${result.channelId}`);
      const current = this.#store.getGame(gameId);
      if (!current || current.status !== 'live') {
        // The game ended or was deleted meanwhile: nobody can be subscribed.
        this.#scheduleChannelDeletion(environment, result.channelId, gameId, this.#now());
        return null;
      }
      this.#store.setChannel(gameId, environment, result.channelId);
      this.#log?.info('broadcast channel created', { gameId, environment, channelId: result.channelId });
      return result.channelId;
    })().finally(() => this.#channelCreations.delete(key));
    this.#channelCreations.set(key, creation);
    return creation;
  }

  #scheduleChannelDeletion(environment, channelId, gameId, deleteAfter) {
    this.#write(
      'INSERT OR IGNORE INTO channel_cleanup (environment, channel_id, game_id, delete_after) VALUES (?, ?, ?, ?)',
      environment, channelId, gameId, deleteAfter,
    );
  }

  // Deletes channels whose time has come (6 h after their game ended), but
  // never one whose end broadcast is still pending. Failures are retried on a
  // later run. Returns the number deleted.
  async deleteDueChannels() {
    if (!this.#apns.configured) return 0;
    const due = this.#db.all(
      `SELECT * FROM channel_cleanup c
        WHERE c.delete_after <= ?
          AND NOT EXISTS (SELECT 1 FROM pending_ends p WHERE p.environment = c.environment AND p.channel_id = c.channel_id)
        ORDER BY c.delete_after`,
      this.#now(),
    );
    let deleted = 0;
    for (const row of due) {
      if (this.#closed) break;
      const result = await this.#apns.deleteChannel(row.environment, row.channel_id);
      if (result.ok || CHANNEL_GONE_REASONS.has(result.reason)) {
        this.#write('DELETE FROM channel_cleanup WHERE environment = ? AND channel_id = ?', row.environment, row.channel_id);
        const holders = this.#db.all(`SELECT id FROM games WHERE ${channelColumn(row.environment)} = ?`, row.channel_id);
        for (const { id } of holders) this.#store.setChannel(id, row.environment, null);
        this.#record(row.game_id, 'channel', row.environment, 1, 0, result.ok ? `deleted ${row.channel_id}` : `already gone (${result.reason})`);
        deleted += 1;
      } else {
        this.#write(
          'UPDATE channel_cleanup SET delete_after = ? WHERE environment = ? AND channel_id = ?',
          this.#now() + CHANNEL_DELETE_RETRY_MS, row.environment, row.channel_id,
        );
        this.#record(row.game_id, 'channel', row.environment, 0, 1, `delete failed: ${describeFailure(result)}`);
        this.#reportFailure('channel delete', row.game_id, row.environment, result);
      }
    }
    return deleted;
  }

  // ---- start ----

  // Kicks off the push-to-start flow; returns the number of devices queued.
  // The fan-out covers the devices registered at this moment and its progress
  // is persisted, so a restart resumes it without sending anyone a second one.
  start(game) {
    if (!this.enabled) return 0;
    const queued = this.recipientCount();
    this.#known.add(game.id);
    for (const environment of this.#environments) {
      this.#write(
        `INSERT INTO push_progress (game_id, environment, start_pending, start_cursor, start_until)
         VALUES (?, ?, 1, 0, (SELECT COALESCE(MAX(id), 0) FROM devices))
         ON CONFLICT (game_id, environment) DO UPDATE SET
           start_pending = 1, start_cursor = 0, start_until = excluded.start_until`,
        game.id, environment,
      );
      this.#runStart(game.id, environment, { first: true });
    }
    return queued;
  }

  // One fan-out per game and environment at a time.
  #runStart(gameId, environment, options = {}) {
    const key = `${gameId}:${environment}`;
    if (this.#starts.has(key)) return this.#starts.get(key);
    const run = { gameId, environment, abort: null, handedOut: null, promise: null };
    this.#starts.set(key, run);
    run.promise = this.#track(this.#startEnvironment(run, options)).finally(() => {
      if (this.#starts.get(key) === run) this.#starts.delete(key);
    });
    return run;
  }

  #startPayload(game, channelId, environment) {
    return {
      aps: {
        timestamp: this.#nextTimestamp(game.id, environment),
        event: 'start',
        'content-state': activityContentState(game),
        'attributes-type': 'GameActivityAttributes',
        attributes: activityAttributes(game),
        'input-push-channel': channelId,
        'stale-date': this.#staleDate(game),
        alert: {
          title: `${game.home.code} vs ${game.away.code} is live`,
          body: `${gameLabel(game)} · Follow the score on your Lock Screen`,
        },
      },
    };
  }

  async #startEnvironment(run, { first = false } = {}) {
    const { gameId, environment } = run;
    const live = () => {
      const game = this.#store.getGame(gameId);
      return game && game.status === 'live' ? game : null;
    };

    // Without a channel no device can be started; a transient failure must
    // not cost the whole environment its Live Activities (§8.1.3).
    let channelId = await this.#ensureChannel(gameId, environment);
    for (const delay of first ? this.#channelRetryDelaysMs : []) {
      if (channelId || run.abort || this.#closed || !live()) break;
      await sleep(delay);
      if (run.abort || this.#closed || !live()) break;
      channelId = await this.#ensureChannel(gameId, environment);
    }
    if (this.#closed) return;
    if (!channelId) {
      if (first) {
        const retry = live() ? ' (retried every minute and on the next update)' : '';
        this.#record(gameId, 'start', environment, 0, 0, `skipped: no broadcast channel${retry}`);
      }
      return;
    }
    if (run.abort) return;

    let game = live();
    const progress = this.#db.get('SELECT * FROM push_progress WHERE game_id = ? AND environment = ?', gameId, environment);
    if (!game || !progress?.start_pending) return;

    let cursor = progress.start_cursor;
    let block = [];
    let exhausted = false;
    const take = () => {
      if (block.length === 0 && !exhausted) {
        block = this.#db.all(
          `SELECT id, token FROM devices
            WHERE environment = ? AND enabled = 1 AND activities_enabled = 1 AND invalid_at IS NULL
              AND id > ? AND id <= ?
            ORDER BY id LIMIT ?`,
          environment, cursor, progress.start_until, START_BLOCK,
        );
        if (block.length === 0) exhausted = true;
        else {
          cursor = block.at(-1).id;
          this.#write('UPDATE push_progress SET start_cursor = ? WHERE game_id = ? AND environment = ?', cursor, gameId, environment);
        }
      }
      const device = block.shift() ?? null;
      if (device) run.handedOut = device.id;
      return device;
    };

    let payload = this.#startPayload(game, channelId, environment);
    let version = game.version;
    let index = 0;
    let sent = 0;
    let failed = 0;
    const reasons = new Map();
    const count = (reason) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

    // Later devices get the latest state, and nobody gets a start for a game
    // that has already ended (end() also aborts the run directly).
    const refresh = () => {
      game = live();
      if (!game) run.abort ??= 'game not live';
      else if (game.version !== version) {
        version = game.version;
        payload = this.#startPayload(game, channelId, environment);
      }
    };
    const stopped = () => run.abort !== null || this.#closed;

    const worker = async () => {
      for (;;) {
        if (stopped()) return;
        const device = take();
        if (!device) return;
        index += 1;
        if (index % START_STATUS_CHECK_EVERY === 0) refresh();
        if (stopped()) return;
        let result = await this.#apns.pushToStart(environment, device.token, payload);
        if (!result.ok && (result.status === 429 || result.status >= 500 || NOT_SENT_CODES.has(result.reason))) {
          await sleep(this.#startRetryDelayMs);
          if (stopped()) return;
          result = await this.#apns.pushToStart(environment, device.token, payload);
        }
        if (result.ok) {
          sent += 1;
          continue;
        }
        failed += 1;
        count(result.status ? `${result.status} ${result.reason ?? ''}`.trim() : result.reason);
        if (this.#closed) return;
        if (isInvalidToken(result)) {
          this.#write('UPDATE devices SET invalid_at = ?, last_error = ? WHERE token = ?', this.#now(), result.reason ?? String(result.status), device.token);
        } else if (SETUP_ERROR_REASONS.has(result.reason) && !run.abort) {
          run.abort = result.reason;
          this.#reportFailure('push-to-start', gameId, environment, result);
        }
      }
    };
    await Promise.all(Array.from({ length: START_CONCURRENCY }, worker));

    // On shutdown close() saved the cursor; the next process resumes there.
    if (this.#closed) return;
    this.#write('UPDATE push_progress SET start_pending = 0 WHERE game_id = ? AND environment = ?', gameId, environment);
    if (run.abort) count(`stopped (${run.abort})`);
    if (sent === 0 && failed === 0 && !run.abort) count(first ? 'no devices' : 'nothing left');
    this.#record(gameId, 'start', environment, sent, failed, summarize(reasons));
    this.#log?.info('push-to-start finished', { gameId, environment, sent, failed, stopped: run.abort ?? undefined });
  }

  // ---- updates ----

  // Called after every committed change. Broadcasts only live→live changes
  // that alter what the Lock Screen shows; start/end have their own flows.
  changed(before, after) {
    if (!this.enabled || !before || !after) return;
    if (before.status !== 'live' || after.status !== 'live') return;
    const { changed, high } = activityChange(before, after);
    if (!changed) return;
    this.#known.add(after.id);
    this.#markDirty(after.id, high);
  }

  #markDirty(gameId, high) {
    let state = this.#updates.get(gameId);
    if (!state) {
      state = { intervalMs: this.#baseIntervalMs, lastSentAt: -Infinity, timer: null, sending: null, dirty: new Set(), high: false };
      this.#updates.set(gameId, state);
    }
    for (const environment of this.#environments) state.dirty.add(environment);
    state.high ||= high;
    this.#pump(gameId, state);
  }

  // Leading + trailing coalescing: send now if the interval has passed,
  // otherwise once it has (with whatever the latest state is by then).
  #pump(gameId, state) {
    if (this.#closed || state.sending || state.timer || state.dirty.size === 0) return;
    const wait = state.lastSentAt + state.intervalMs - performance.now();
    if (wait > 0) {
      state.timer = setTimeout(() => {
        state.timer = null;
        this.#pump(gameId, state);
      }, wait);
      return;
    }
    state.sending = this.#track(this.#sendUpdate(gameId, state)).finally(() => {
      state.sending = null;
      if (this.#updates.get(gameId) === state) this.#pump(gameId, state);
    });
  }

  async #sendUpdate(gameId, state) {
    const environments = [...state.dirty];
    const high = state.high;
    state.dirty.clear();
    state.high = false;
    state.lastSentAt = performance.now();

    let retry = false;
    let succeeded = false;
    await Promise.all(
      environments.map(async (environment) => {
        const initial = this.#store.getGame(gameId);
        if (!initial || initial.status !== 'live') return;
        let channelId = initial.channels[environment];
        if (!channelId) {
          channelId = await this.#ensureChannel(gameId, environment);
          // A start fan-out that never got a channel can go out now.
          if (channelId) this.#resumeStart(gameId, environment);
        }
        if (!channelId) return;
        const game = this.#store.getGame(gameId);
        if (!game || game.status !== 'live') return;

        const priority = high ? 10 : 5;
        const payload = {
          aps: {
            timestamp: this.#nextTimestamp(gameId, environment),
            event: 'update',
            'content-state': activityContentState(game),
            'stale-date': this.#staleDate(game),
          },
        };
        const result = await this.#apns.broadcast(environment, channelId, payload, { priority, expirationSec: this.#broadcastExpiration() });
        if (result.ok) {
          succeeded = true;
          this.#record(gameId, 'update', environment, 1, 0, `v${game.version} priority ${priority}`);
          return;
        }
        this.#record(gameId, 'update', environment, 0, 1, describeFailure(result));
        this.#reportFailure('broadcast update', gameId, environment, result);
        if (isTransient(result)) {
          retry = true;
          state.dirty.add(environment);
          state.high ||= high;
        } else if (CHANNEL_GONE_REASONS.has(result.reason)) {
          // Recreated on the next update.
          this.#store.setChannel(gameId, environment, null);
        }
      }),
    );

    if (retry) {
      state.intervalMs = Math.min(MAX_UPDATE_INTERVAL_MS, Math.max(state.intervalMs * 2, UPDATE_INTERVAL_STEP_MS));
    } else if (succeeded) {
      state.intervalMs = Math.max(this.#baseIntervalMs, state.intervalMs - UPDATE_INTERVAL_STEP_MS);
    }
    const game = this.#store.getGame(gameId);
    if (!game || game.status !== 'live') {
      if (state.timer) clearTimeout(state.timer);
      state.dirty.clear();
      if (this.#updates.get(gameId) === state) this.#updates.delete(gameId);
    }
  }

  // Current per-game update interval (exposed for status/tests).
  updateIntervalMs(gameId) {
    return this.#updates.get(gameId)?.intervalMs ?? this.#baseIntervalMs;
  }

  #resumeStart(gameId, environment) {
    if (this.#closed || !this.#environments.includes(environment)) return;
    const row = this.#db.get('SELECT start_pending FROM push_progress WHERE game_id = ? AND environment = ?', gameId, environment);
    if (row?.start_pending) this.#runStart(gameId, environment);
  }

  // ---- end ----

  end(game, { canceled = false } = {}) {
    if (!this.enabled) return;
    const state = this.#updates.get(game.id);
    const intervalMs = state?.intervalMs ?? this.#baseIntervalMs;
    if (state) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.dirty.clear();
      this.#updates.delete(game.id);
    }
    // A device started after the end broadcast would never get it, so stop
    // the fan-out now and send the end once its last requests are back.
    const starts = [];
    for (const environment of ENVIRONMENTS) {
      const run = this.#starts.get(`${game.id}:${environment}`);
      if (!run) continue;
      run.abort ??= `game ${game.status}`;
      starts.push(run.promise);
    }
    // Saved right away, so neither a restart nor deleting the game loses it.
    for (const environment of ENVIRONMENTS) {
      const channelId = game.channels[environment];
      if (channelId) this.#queueEnd(game, environment, channelId, canceled);
    }
    this.#track(this.#runEnd(game.id, { previous: state?.sending ?? null, starts, intervalMs }));
  }

  #queueEnd(game, environment, channelId, canceled) {
    const now = this.#now();
    const payload = {
      aps: {
        timestamp: this.#nextTimestamp(game.id, environment),
        event: 'end',
        'content-state': activityContentState(game, canceled ? { note: 'Canceled' } : {}),
        'dismissal-date': Math.floor(now / 1000) + DISMISS_AFTER_SEC,
      },
    };
    this.#write(
      `INSERT OR REPLACE INTO pending_ends (game_id, environment, channel_id, payload, detail, created_at, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      game.id, environment, channelId, JSON.stringify(payload), canceled ? 'canceled' : 'final', now, now,
    );
    this.#scheduleChannelDeletion(environment, channelId, game.id, (game.endedAt ?? now) + CHANNEL_RETENTION_MS);
  }

  async #runEnd(gameId, { previous, starts, intervalMs }) {
    if (previous) await previous;
    if (starts.length) {
      await Promise.all(starts);
      // Let devices started by the last in-flight pushes join the channel.
      await sleep(this.#startSettleMs);
    }
    const rows = this.#db.all('SELECT * FROM pending_ends WHERE game_id = ?', gameId);
    await Promise.all(rows.map((row) => this.#deliverEnd(row, { intervalMs })));
  }

  // The end must reach every Lock Screen: transient and setup failures are
  // retried here, then by the scheduler every minute until it is delivered
  // or iOS has ended the activity anyway.
  async #deliverEnd(row, { delays = this.#retryDelaysMs, intervalMs = this.#baseIntervalMs } = {}) {
    const key = `${row.game_id}:${row.environment}`;
    if (this.#ends.has(key)) return;
    this.#ends.add(key);
    try {
      const payload = JSON.parse(row.payload);
      for (let attempt = 0; ; attempt += 1) {
        if (this.#closed) return;
        const result = await this.#apns.broadcast(row.environment, row.channel_id, payload, { priority: 10, expirationSec: this.#broadcastExpiration() });
        if (this.#closed) return;
        if (result.ok) {
          this.#write('DELETE FROM pending_ends WHERE game_id = ? AND environment = ?', row.game_id, row.environment);
          this.#record(row.game_id, 'end', row.environment, 1, 0, row.detail);
          return;
        }
        const retryable = isTransient(result) || SETUP_ERROR_REASONS.has(result.reason);
        if (!retryable || this.#now() - row.created_at >= END_GIVE_UP_MS) {
          this.#write('DELETE FROM pending_ends WHERE game_id = ? AND environment = ?', row.game_id, row.environment);
          this.#record(row.game_id, 'end', row.environment, 0, 1, describeFailure(result));
          this.#reportFailure('broadcast end', row.game_id, row.environment, result);
          if (CHANNEL_GONE_REASONS.has(result.reason) && this.#store.getGame(row.game_id)?.channels[row.environment] === row.channel_id) {
            this.#store.setChannel(row.game_id, row.environment, null);
          }
          return;
        }
        if (attempt < delays.length) {
          // A throttled channel's backed-off interval applies to the end too.
          await sleep(Math.max(delays[attempt], result.status === 429 ? intervalMs : 0));
          continue;
        }
        this.#write(
          'UPDATE pending_ends SET next_attempt_at = ? WHERE game_id = ? AND environment = ?',
          this.#now() + END_RETRY_MS, row.game_id, row.environment,
        );
        if (delays.length) {
          this.#record(row.game_id, 'end', row.environment, 0, 1, `${describeFailure(result)} (retrying every minute)`);
          this.#reportFailure('broadcast end', row.game_id, row.environment, result);
        }
        return;
      }
    } finally {
      this.#ends.delete(key);
    }
  }

  // The game row is gone: drop local state. Its channels are deleted by the
  // scheduler once any end broadcast still pending for them has gone out.
  forget(game) {
    const state = this.#updates.get(game.id);
    if (state?.timer) clearTimeout(state.timer);
    this.#updates.delete(game.id);
    for (const environment of ENVIRONMENTS) {
      const run = this.#starts.get(`${game.id}:${environment}`);
      if (run) run.abort ??= 'game deleted';
      const channelId = game.channels[environment];
      if (channelId) this.#scheduleChannelDeletion(environment, channelId, game.id, (game.endedAt ?? this.#now()) + CHANNEL_RETENTION_MS);
      this.#timestamps.delete(`${game.id}:${environment}`);
    }
    this.#known.delete(game.id);
  }

  // ---- recovery (scheduler, every minute) ----

  // Finishes what a restart, a crash or an APNs outage interrupted:
  // unfinished push-to-start fan-outs of live games, one fresh update for
  // live games this process hasn't pushed yet (the last change before a
  // restart may never have gone out), and end broadcasts not yet delivered.
  async resume() {
    const summary = { starts: 0, resynced: 0, ends: 0 };
    if (!this.enabled) return summary;
    const pendingStarts = this.#db.all(
      `SELECT p.game_id, p.environment FROM push_progress p JOIN games g ON g.id = p.game_id
        WHERE p.start_pending = 1 AND g.status = 'live'`,
    );
    for (const row of pendingStarts) {
      if (!this.#environments.includes(row.environment) || this.#starts.has(`${row.game_id}:${row.environment}`)) continue;
      this.#runStart(row.game_id, row.environment);
      summary.starts += 1;
    }
    for (const { id } of this.#db.all("SELECT id FROM games WHERE status = 'live'")) {
      if (this.#known.has(id)) continue;
      this.#known.add(id);
      this.#markDirty(id, true);
      summary.resynced += 1;
    }
    const ends = [];
    for (const row of this.#db.all('SELECT * FROM pending_ends WHERE next_attempt_at <= ?', this.#now())) {
      if (this.#ends.has(`${row.game_id}:${row.environment}`)) continue;
      ends.push(this.#track(this.#deliverEnd(row, { delays: [] })));
    }
    summary.ends = ends.length;
    await Promise.all(ends);
    // Never leak a channel: any ended game's channel gets a cleanup entry.
    for (const environment of ENVIRONMENTS) {
      const column = channelColumn(environment);
      this.#write(
        `INSERT OR IGNORE INTO channel_cleanup (environment, channel_id, game_id, delete_after)
         SELECT ?, ${column}, id, COALESCE(ended_at, updated_at) + ? FROM games
          WHERE status IN ('final', 'canceled') AND ${column} IS NOT NULL`,
        environment, CHANNEL_RETENTION_MS,
      );
    }
    return summary;
  }

  // ---- shutdown ----

  // Sends pending trailing updates immediately (bypassing the interval) and
  // waits, bounded, until nothing is left to send or in flight.
  async flush(timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    const forced = new Map();
    for (;;) {
      for (const [gameId, state] of this.#updates) {
        if (state.dirty.size === 0 || state.sending || (forced.get(gameId) ?? 0) >= FLUSH_MAX_FORCED_SENDS) continue;
        forced.set(gameId, (forced.get(gameId) ?? 0) + 1);
        clearTimeout(state.timer);
        state.timer = null;
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
    for (const state of this.#updates.values()) if (state.timer) clearTimeout(state.timer);
    this.#updates.clear();
    // Fan-outs stop taking devices; the next process resumes right after the
    // last device handed out (whose push may have gone out).
    for (const run of this.#starts.values()) {
      run.abort ??= 'shutdown';
      if (run.handedOut !== null) {
        this.#write('UPDATE push_progress SET start_cursor = ? WHERE game_id = ? AND environment = ?', run.handedOut, run.gameId, run.environment);
      }
    }
  }
}
