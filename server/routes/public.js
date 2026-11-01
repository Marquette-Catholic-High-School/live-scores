// Public endpoints: config, sports, games, SSE stream, health, device registration.

import { badRequest, notFound, unauthorized } from '../errors.js';
import { allRules } from '../sports.js';
import { boolean, oneOf, string } from '../validate.js';

const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{32,512}$/;
const KEEP_INVALID = "devices.invalid_at IS NOT NULL AND devices.last_error = 'BadDeviceToken' AND devices.environment = excluded.environment";

function deviceToken(value, field) {
  const token = string(value, field, { min: 32, max: 512 }).toLowerCase();
  if (!DEVICE_TOKEN_PATTERN.test(token)) throw badRequest(`${field} must be a hex string of 32–512 characters.`);
  return token;
}

export function registerPublicRoutes(router, { config, db, games, sse, apns, limiters, now, startedAt }) {
  router.get('/api/config', () => ({
    schoolName: config.schoolName,
    homeTeam: { ...config.homeTeam },
    startWindowMinutes: config.startWindowMinutes,
    timeZone: config.timeZone,
    apnsEnabled: apns.configured,
    version: config.version,
  }));

  router.get('/api/sports', () => ({ sports: allRules() }));

  router.get(
    '/api/games',
    (ctx) => {
      const scope = oneOf(ctx.query.get('scope') ?? 'board', 'scope', ['board', 'all']);
      if (scope === 'all' && !ctx.user) throw unauthorized();
      // scope=all&before=<unix ms>: the page of games scheduled before that.
      const beforeParam = ctx.query.get('before');
      if (beforeParam !== null && (scope !== 'all' || !/^\d{1,15}$/.test(beforeParam))) {
        throw badRequest('before must be a time in unix milliseconds (scope=all only).');
      }
      const before = beforeParam === null ? null : Number(beforeParam);
      const authenticated = Boolean(ctx.user);
      return { games: games.list(scope, { before }).map((game) => games.serialize(game, { authenticated })) };
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/games/:id',
    (ctx) => {
      const game = games.getGame(ctx.params.id);
      if (!game) throw notFound('Game not found.');
      return { game: games.serialize(game, { authenticated: Boolean(ctx.user) }) };
    },
    { auth: 'optional' },
  );

  router.get(
    '/api/stream',
    (ctx) => {
      const gameId = ctx.query.get('game');
      if (gameId !== null && !games.getGame(gameId)) throw notFound('Game not found.');
      sse.open(ctx.req, ctx.res, { ip: ctx.ipKey, gameId, authenticated: Boolean(ctx.user), sessionId: ctx.session?.sessionId ?? null });
    },
    { auth: 'optional', raw: true },
  );

  router.get('/api/health', () => {
    db.ping();
    return {
      ok: true,
      version: config.version,
      uptimeSec: Math.floor((now() - startedAt) / 1000),
      db: 'ok',
      apns: apns.status(),
      sseClients: sse.size,
    };
  });

  router.post(
    '/api/devices',
    (ctx) => {
      const body = ctx.body;
      const token = deviceToken(body.token, 'token');
      const environment = oneOf(body.environment, 'environment', ['production', 'sandbox']);
      const enabled = boolean(body.enabled, 'enabled');
      const activitiesEnabled = body.activitiesEnabled === undefined || body.activitiesEnabled === null
        ? true
        : boolean(body.activitiesEnabled, 'activitiesEnabled');
      const appVersion = body.appVersion === undefined || body.appVersion === null ? '' : string(body.appVersion, 'appVersion', { max: 32 });
      let previousToken = null;
      if (body.previousToken !== undefined && body.previousToken !== null && body.previousToken !== '') {
        previousToken = deviceToken(body.previousToken, 'previousToken');
      }

      const timestamp = now();
      // Re-registering clears invalid_at (APNs says a token reported gone may
      // come back), except for a token APNs rejected as malformed for this
      // same environment: that never becomes valid, and re-registering junk
      // tokens must not put them back into every push-to-start fan-out.
      db.transaction(() => {
        db.run(
          `INSERT INTO devices (token, environment, enabled, activities_enabled, app_version, created_at, updated_at, invalid_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT(token) DO UPDATE SET
             environment = excluded.environment,
             enabled = excluded.enabled,
             activities_enabled = excluded.activities_enabled,
             app_version = excluded.app_version,
             updated_at = excluded.updated_at,
             invalid_at = CASE WHEN ${KEEP_INVALID} THEN devices.invalid_at ELSE NULL END,
             last_error = CASE WHEN ${KEEP_INVALID} THEN devices.last_error ELSE NULL END`,
          token, environment, enabled ? 1 : 0, activitiesEnabled ? 1 : 0, appVersion, timestamp, timestamp,
        );
        if (previousToken && previousToken !== token) db.run('DELETE FROM devices WHERE token = ?', previousToken);
      });
      return { ok: true };
    },
    { limiter: limiters.devices },
  );
}
