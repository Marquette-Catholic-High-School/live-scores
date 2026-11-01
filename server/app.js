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

  games.setHooks({
    changed: (before, after) => {
      sse.publishGame(after.id, (authenticated) => games.serialize(after, { authenticated }));
      push.changed(before, after);
    },
    removed: (game) => {
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
  const router = buildRouter({ config, db, auth, users, apns, sse, games, push, log, now, startedAt, limiters });
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
    scheduler,
    server,
    limiters,

    async listen({ port = config.port, host = config.host, startScheduler = true } = {}) {
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve();
        });
      });
      if (startScheduler) scheduler.start();
      return server.address();
    },

    // Graceful shutdown: stop jobs, end SSE streams, stop accepting requests,
    // let pending pushes go out (bounded), then close APNs sessions and the DB.
    close({ pushFlushTimeoutMs = 5000 } = {}) {
      closing ??= (async () => {
        await scheduler.stop();
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
