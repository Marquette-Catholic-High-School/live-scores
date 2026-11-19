// The school's radio station on AzuraCast (ARCHITECTURE.md §12).
//
// Every RADIO_POLL_SECONDS the server reads the station's public now-playing
// API (GET <RADIO_URL>/api/nowplaying/<RADIO_STATION>): the station is live
// while a broadcaster (an AzuraCast streamer/DJ account) is connected
// (`live.is_live`); music the station plays by itself doesn't count. If the
// station can't be read three times in a row it counts as off the air.
//
// Clients get the status — live or not, the stream, and the game it carries
// (the one an admin switched "on the radio", GameService.radioGame) — from
// GET /api/radio, the board (GET /api/games), every SSE `hello` and an SSE
// `radio` event whenever it changes.
//
// When the station goes live after being off the air for at least
// RADIO_NOTIFY_GAP_MINUTES (a broadcaster whose connection drops and comes
// back doesn't notify twice; neither does a server restart mid-broadcast), one
// notification goes to the FCM_RADIO_TOPIC topic — whether or not a game is on
// the radio. With a game, it names the game and opens it in the app.

import { gameLabel } from './games.js';
import { isPlainObject } from './validate.js';

const FAILURES_BEFORE_OFF_AIR = 3;
const REQUEST_TIMEOUT_MS = 8000;
const LAST_LIVE_KEY = 'radio.lastLiveAt';
const LAST_NOTIFIED_KEY = 'radio.lastNotifiedAt';

export class RadioService {
  #config;
  #radio;
  #db;
  #games;
  #sse;
  #fcm;
  #log;
  #now;
  #fetch;
  #live = false;
  #streamer = null;
  #since = null;
  #checkedAt = null;
  #error = null;
  #failures = 0;
  #published = null;
  #timer = null;
  #polling = null;
  #pending = new Set();
  #lastNotification = null;

  constructor({ config, db, games, sse, fcm, log, now = Date.now, fetch = globalThis.fetch }) {
    this.#config = config;
    this.#radio = config.radio;
    this.#db = db;
    this.#games = games;
    this.#sse = sse;
    this.#fcm = fcm;
    this.#log = log;
    this.#now = now;
    this.#fetch = fetch;
  }

  get configured() {
    return this.#radio.enabled;
  }

  get live() {
    return this.#live;
  }

  start() {
    if (!this.configured || this.#timer) return;
    this.poll();
    this.#timer = setInterval(() => this.poll(), this.#radio.pollSeconds * 1000);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  // Waits (at most `timeoutMs`) for notifications still being sent.
  async flush(timeoutMs = 5000) {
    if (this.#pending.size === 0) return;
    let timer;
    await Promise.race([
      Promise.allSettled([...this.#pending]),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }

  // One check of the station. Overlapping calls share the check in progress.
  poll() {
    if (!this.configured) return Promise.resolve(this.status());
    this.#polling ??= this.#poll().finally(() => {
      this.#polling = null;
    });
    return this.#polling;
  }

  // ---- views ----

  // The status every client gets; null while the radio is turned off (RADIO_URL=off).
  status() {
    if (!this.configured) return null;
    const game = this.#games.radioGame(this.#now());
    return {
      live: this.#live,
      name: this.#radio.name,
      streamUrl: this.#radio.streamUrl,
      playerUrl: this.#radio.playerUrl,
      since: this.#live ? this.#since : null,
      gameId: game?.id ?? null,
    };
  }

  // GET /api/admin/status → radio.
  adminStatus() {
    const notifications = {
      ...this.#fcm.status(),
      topic: this.#config.fcm.topic,
      gapMinutes: this.#radio.notifyGapMinutes,
      lastSentAt: this.#setting(LAST_NOTIFIED_KEY),
      last: this.#lastNotification,
    };
    if (!this.configured) return { configured: false, notifications };
    return {
      ...this.status(),
      configured: true,
      url: this.#radio.url,
      station: this.#radio.station,
      streamer: this.#live ? this.#streamer : null,
      checkedAt: this.#checkedAt,
      error: this.#error,
      notifications,
    };
  }

  // Publishes the status if it changed: after a check, and whenever a game
  // changes (switched on or off the radio, started, ended…).
  refresh() {
    if (!this.configured) return;
    let status;
    try {
      status = this.status();
    } catch (err) {
      this.#log?.error('could not read the radio status', { err });
      return;
    }
    const json = JSON.stringify(status);
    if (json === this.#published) return;
    this.#published = json;
    this.#sse.publishRadio(status);
  }

  // ---- checking the station ----

  async #poll() {
    const { url, station } = this.#radio;
    let reading = null;
    try {
      const res = await this.#fetch(`${url}/api/nowplaying/${encodeURIComponent(station)}`, {
        headers: { accept: 'application/json', 'user-agent': `mchs-live/${this.#config.version}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(this.#httpError(res.status, text));
      let np;
      try {
        np = JSON.parse(text);
      } catch {
        throw new Error('The now-playing response was not JSON.');
      }
      if (!isPlainObject(np)) throw new Error('The now-playing response was not a JSON object.');
      const live = isPlainObject(np.live) ? np.live : {};
      reading = {
        live: live.is_live === true,
        streamer: typeof live.streamer_name === 'string' && live.streamer_name.trim() ? live.streamer_name.trim().slice(0, 100) : null,
        since: Number.isFinite(live.broadcast_start) && live.broadcast_start > 0 ? live.broadcast_start * 1000 : null,
      };
    } catch (err) {
      const message = err?.name === 'TimeoutError' ? 'The station didn’t answer in time.' : err?.message ?? String(err);
      this.#failed(message);
    }
    this.#checkedAt = this.#now();
    if (reading) {
      if (this.#error) this.#log?.info('radio station reachable again');
      this.#failures = 0;
      this.#error = null;
      this.#apply(reading);
    } else if (this.#failures >= FAILURES_BEFORE_OFF_AIR) {
      this.#apply({ live: false, streamer: null, since: null });
    } else {
      this.refresh();
    }
    return this.status();
  }

  #httpError(status, text) {
    let detail = '';
    try {
      const body = JSON.parse(text);
      if (typeof body?.message === 'string') detail = `: ${body.message}`;
    } catch {
      // not JSON
    }
    const hint = status === 404 ? ' AzuraCast has no now-playing info for this station: check RADIO_STATION, and that the station is started (Restart Broadcasting).' : '';
    return `HTTP ${status}${detail}.${hint}`;
  }

  #failed(message) {
    this.#failures += 1;
    if (this.#failures === 1 || message !== this.#error) this.#log?.warn('could not read the radio station', { error: message, failures: this.#failures });
    this.#error = message;
  }

  #apply({ live, streamer, since }) {
    const wasLive = this.#live;
    this.#live = live;
    this.#streamer = live ? streamer : null;
    this.#since = live ? since ?? (wasLive ? this.#since : this.#now()) : null;
    if (live) {
      const now = this.#now();
      const lastLiveAt = this.#setting(LAST_LIVE_KEY);
      this.#setSetting(LAST_LIVE_KEY, now);
      if (!wasLive) {
        const offAirMs = lastLiveAt === null ? Infinity : now - lastLiveAt;
        const gapMs = this.#radio.notifyGapMinutes * 60_000;
        this.#log?.info('radio went live', { streamer, offAirMinutes: Number.isFinite(offAirMs) ? Math.round(offAirMs / 60_000) : null });
        if (offAirMs >= gapMs) this.#notify();
      }
    } else if (wasLive) {
      this.#log?.info('radio went off the air');
    }
    this.refresh();
  }

  // ---- the "we're live" notification ----

  #notify() {
    const game = this.#games.radioGame(this.#now());
    const name = this.#radio.name;
    const message = {
      topic: this.#config.fcm.topic,
      notification: {
        title: `${name} is live`,
        body: game ? `${gameLabel(game)}: ${game.home.name} vs ${game.away.name}. Tap to listen.` : 'Tap to listen live.',
      },
      // Data values must be strings. The app opens `url` when the notification is tapped.
      data: { kind: 'radio', url: game ? `mchs://game/${game.id}` : 'mchs://radio' },
      apns: {
        // A newer "is live" notification replaces the last one.
        headers: { 'apns-priority': '10', 'apns-collapse-id': 'radio-live' },
        payload: { aps: { sound: 'default' } },
      },
    };
    this.#setSetting(LAST_NOTIFIED_KEY, this.#now());
    const sending = this.#fcm.send(message).then((result) => {
      const detail = result.ok
        ? `${message.notification.title} (topic ${message.topic})`
        : `Not sent: ${result.error}`;
      this.#lastNotification = { at: this.#now(), ok: result.ok, detail };
      this.#logPush(game?.id ?? null, result.ok, detail);
      if (result.ok) this.#log?.info('radio notification sent', { topic: message.topic, gameId: game?.id ?? null });
      else this.#log?.warn('radio notification failed', { error: result.error });
    });
    this.#pending.add(sending);
    sending.finally(() => this.#pending.delete(sending));
  }

  #logPush(gameId, ok, detail) {
    try {
      this.#db.run(
        'INSERT INTO push_log (game_id, kind, environment, sent, failed, detail, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
        gameId, 'radio', ok ? 1 : 0, ok ? 0 : 1, detail.slice(0, 500), this.#now(),
      );
    } catch (err) {
      this.#log?.warn('could not write push_log', { err: err.message });
    }
  }

  // ---- settings (timestamps that must survive a restart) ----

  #setting(key) {
    const row = this.#db.get('SELECT value FROM settings WHERE key = ?', key);
    const value = row ? Number(row.value) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  #setSetting(key, value) {
    this.#db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key, String(value), this.#now(),
    );
  }
}
