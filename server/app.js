// Composition root: wires config, database, services, push, scheduler and the
// HTTP server. Used by index.js and by the tests (which inject a clock and a
// fake APNs transport).

import { ApnsClient } from './apns.js';
import { AuthService } from './auth.js';
import { openDatabase } from './db.js';
import { GameService } from './games.js';
import { createHttpServer } from './http.js';
import { createLogger } from './log.js';
import { PushService } from './push.js';
import { RateLimiter } from './ratelimit.js';
import { buildRouter } from './routes/index.js';
import { Scheduler } from './scheduler.js';
import { ScoreboardService } from './scoreboard.js';
import { SseHub } from './sse.js';
import { UserService } from './users.js';

export function createApp({
  config,
  log = createLogger({ level: config.logLevel }),
  now = Date.now,
  apnsTransport,
  apnsKeyPem,
  pushOptions = {},
  sseOptions = {},
  schedulerIntervalMs = 60_000,
  globalRateLimitPerMinute = config.limits.rateLimitPerMinute,
  deviceRateLimitPerMinute = config.limits.deviceRateLimitPerMinute,
  scoreboardOptions = {},
} = {}) {
  const db = openDatabase(config.dbPath);
  const auth = new AuthService({ db, now, log });
  const users = new UserService({ db, now, log });
  const apns = new ApnsClient({
    teamId: config.apns.teamId,
    keyId: config.apns.keyId,
    keyPath: config.apns.keyPath,
    keyPem: apnsKeyPem,
    bundleId: config.apns.bundleId,
    environments: config.apns.environments,
    log: log.child({ component: 'apns' }),
    now,
    transport: apnsTransport,
  });
  const sse = new SseHub({
    now,
    log,
    maxPerIp: config.limits.sseMaxPerIp,
    maxTotal: config.limits.sseMaxConnections,
    isSessionValid: (sessionId) => auth.isSessionValid(sessionId),
    ...sseOptions,
  });
  const games = new GameService({ db, config, now, log });
  const push = new PushService({ db, apns, config, log: log.child({ component: 'push' }), now, store: games, ...pushOptions });
  const scoreboard = new ScoreboardService({ db, games, config, log: log.child({ component: 'scoreboard' }), now, ...scoreboardOptions });
  games.setScoreboard(scoreboard);
  // Feed status changes (connected, unreachable, ...) are part of the game's
  // JSON for signed-in viewers, so they get a new version like any change.
  scoreboard.setStatusListener((gameId) => {
    db.run('UPDATE games SET version = version + 1 WHERE id = ?', gameId);
    const game = games.getGame(gameId);
    if (game) sse.publishGame(game.id, (authenticated) => games.serialize(game, { authenticated }));
  });
  // What decides which game a scoreboard drives, and which scheduled games it
  // is watched for (§11). When it changes, the feed is re-decided before the
  // change is published, so the published game (and the next action's 409
  // check) already reflects it.
  const feedKey = (game) =>
    game
      ? JSON.stringify([game.status, game.scoreboard, game.scoreboardManual, game.sport, game.home.name, game.home.code, game.startedAt, game.scheduledAt])
      : null;

  games.setHooks({
    changed: (before, after) => {
      if (feedKey(before) !== feedKey(after)) scoreboard.refresh({ quiet: after.id });
      sse.publishGame(after.id, (authenticated) => games.serialize(after, { authenticated }));
      push.changed(before, after);
    },
    removed: (game) => {
      scoreboard.refresh();
      sse.publishRemoved(game.id);
      push.forget(game);
    },
    started: (game) => push.start(game),
    ended: (game, options) => push.end(game, options),
  });

  const scheduler = new Scheduler({ games, push, db, log, now, intervalMs: schedulerIntervalMs, environments: config.apns.environments });
  const limiters = {
    global: new RateLimiter({ limit: globalRateLimitPerMinute, windowMs: 60_000, now }),
    devices: new RateLimiter({ limit: deviceRateLimitPerMinute, windowMs: 60_000, now }),
  };
  const startedAt = now();
  const router = buildRouter({ config, db, auth, users, apns, sse, games, push, scoreboard, log, now, startedAt, limiters });
  const server = createHttpServer({ config, log, router, auth, now, globalLimiter: limiters.global });

  let closing = null;

  return {
    config,
    log,
    db,
    auth,
    users,
    apns,
    sse,
    games,
    push,
    scoreboard,
    scheduler,
    server,
    limiters,

    async listen({ port = config.port, host = config.host, startScheduler = true, startScoreboard = startScheduler } = {}) {
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });
      if (startScheduler) scheduler.start();
      if (startScoreboard) scoreboard.start();
      return server.address();
    },

    // Graceful shutdown: stop jobs, end SSE streams, stop accepting requests,
    // let pending pushes go out (bounded), then close APNs sessions and the DB.
    close({ pushFlushTimeoutMs = 5000 } = {}) {
      closing ??= (async () => {
        await scheduler.stop();
        scoreboard.stop();
        sse.closeAll();
        await new Promise((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          const force = setTimeout(() => server.closeAllConnections(), 3000);
          force.unref();
          server.close(() => {
            clearTimeout(force);
            resolve();
          });
          server.closeIdleConnections();
        });
        await push.flush(pushFlushTimeoutMs);
        push.close();
        apns.close();
        db.close();
      })();
      return closing;
    },
  };
}
