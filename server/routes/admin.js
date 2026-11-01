// /api/admin/* — push diagnostics for the admin console.

const ENVIRONMENTS = ['production', 'sandbox'];

function pushLogView(row) {
  return {
    id: row.id,
    gameId: row.game_id,
    kind: row.kind,
    environment: row.environment,
    sent: row.sent,
    failed: row.failed,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export function registerAdminRoutes(router, { config, db, apns, sse }) {
  router.get(
    '/api/admin/status',
    () => {
      const devices = {};
      for (const environment of ENVIRONMENTS) {
        const row = db.get(
          `SELECT
             COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN enabled = 1 AND activities_enabled = 1 AND invalid_at IS NULL THEN 1 ELSE 0 END), 0) AS enabled,
             COALESCE(SUM(CASE WHEN invalid_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS invalid
           FROM devices WHERE environment = ?`,
          environment,
        );
        devices[environment] = { enabled: row.enabled, total: row.total, invalid: row.invalid };
      }
      const apnsStatus = {
        configured: apns.configured,
        environments: [...config.apns.environments],
        teamId: config.apns.teamId ?? null,
        keyId: config.apns.keyId ?? null,
        bundleId: config.apns.bundleId,
      };
      if (!apns.configured) apnsStatus.error = apns.error;
      return {
        apns: apnsStatus,
        devices,
        recentPushes: db.all('SELECT * FROM push_log ORDER BY id DESC LIMIT 50').map(pushLogView),
        sseClients: sse.size,
      };
    },
    { auth: 'admin' },
  );

  router.post('/api/admin/apns-check', async () => ({ results: await apns.check(config.apns.channelStoragePolicy) }), { auth: 'admin' });
}
