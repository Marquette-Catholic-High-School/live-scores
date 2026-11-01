// Periodic jobs (every 60 s): auto-final forgotten live games, finish push
// work a restart or an APNs outage interrupted, delete broadcast channels
// 6 h after a game ended, and housekeeping (ARCHITECTURE.md §4, §8.3).

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PUSH_LOG_RETENTION_MS = 30 * DAY_MS;
const INVALID_DEVICE_RETENTION_MS = 30 * DAY_MS;
const UNSERVED_DEVICE_RETENTION_MS = 30 * DAY_MS;

export class Scheduler {
  #games;
  #push;
  #db;
  #log;
  #now;
  #intervalMs;
  #environments;
  #timer = null;
  #firstRun = null;
  #running = null;

  // `environments`: the APNs environments served; devices registered for
  // another one are deleted once idle for 30 days.
  constructor({ games, push, db, log, now = Date.now, intervalMs = 60_000, environments = ['production', 'sandbox'] }) {
    this.#games = games;
    this.#push = push;
    this.#db = db;
    this.#log = log;
    this.#now = now;
    this.#intervalMs = intervalMs;
    this.#environments = environments;
  }

  start({ initialDelayMs = 5000 } = {}) {
    if (this.#timer) return;
    this.#firstRun = setTimeout(() => this.tick(), initialDelayMs);
    this.#firstRun.unref();
    this.#timer = setInterval(() => this.tick(), this.#intervalMs);
    this.#timer.unref();
  }

  // Runs every job once. Overlapping calls share the run in progress.
  tick() {
    this.#running ??= this.#run().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #run() {
    const summary = { autoFinal: [], push: null, channelsDeleted: 0, pushLogDeleted: 0, sessionsDeleted: 0, devicesDeleted: 0 };
    try {
      summary.autoFinal = this.#games.autoFinalize();
    } catch (err) {
      this.#log?.error('auto-final job failed', { err });
    }

    try {
      summary.push = await this.#push.resume();
    } catch (err) {
      this.#log?.error('push resume job failed', { err });
    }

    try {
      summary.channelsDeleted = await this.#push.deleteDueChannels();
    } catch (err) {
      this.#log?.error('channel cleanup job failed', { err });
    }

    try {
      const now = this.#now();
      summary.pushLogDeleted = Number(this.#db.run('DELETE FROM push_log WHERE created_at < ?', now - PUSH_LOG_RETENTION_MS).changes);
      summary.sessionsDeleted = Number(this.#db.run('DELETE FROM sessions WHERE expires_at <= ?', now).changes);
      summary.devicesDeleted = Number(
        this.#db.run('DELETE FROM devices WHERE invalid_at IS NOT NULL AND invalid_at < ?', now - INVALID_DEVICE_RETENTION_MS).changes,
      );
      summary.devicesDeleted += Number(
        this.#db.run(
          `DELETE FROM devices WHERE environment NOT IN (${this.#environments.map(() => '?').join(', ')}) AND updated_at < ?`,
          ...this.#environments, now - UNSERVED_DEVICE_RETENTION_MS,
        ).changes,
      );
    } catch (err) {
      this.#log?.error('housekeeping job failed', { err });
    }

    const push = summary.push ?? {};
    if (summary.autoFinal.length || push.starts || push.resynced || push.ends || summary.channelsDeleted || summary.pushLogDeleted || summary.sessionsDeleted || summary.devicesDeleted) {
      this.#log?.info('scheduler run', summary);
    }
    return summary;
  }

  async stop() {
    clearTimeout(this.#firstRun);
    clearInterval(this.#timer);
    this.#timer = null;
    this.#firstRun = null;
    if (this.#running) await this.#running.catch(() => {});
  }
}
