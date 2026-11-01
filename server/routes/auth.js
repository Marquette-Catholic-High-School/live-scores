// /api/auth/* — sign in/out for the web portal (cookie) and the iOS app (bearer).

import { clearedSessionCookie, passesCsrfCheck, sessionCookie } from '../auth.js';
import { forbidden } from '../errors.js';

export function registerAuthRoutes(router, { auth }) {
  router.post('/api/auth/login', async (ctx) => {
    const { username, password, client } = ctx.body;
    const result = await auth.login({ username, password, client, ip: ctx.ip, ipKey: ctx.ipKey });
    if (client === 'web') {
      ctx.res.appendHeader('Set-Cookie', sessionCookie(result.token, { secure: ctx.https }));
      return { user: result.user };
    }
    return { token: result.token, user: result.user };
  });

  router.post(
    '/api/auth/logout',
    (ctx) => {
      if (ctx.session) {
        if (!passesCsrfCheck(ctx.req, ctx.session.via)) throw forbidden('Missing X-MCHS-Client header.');
        auth.revokeSession(ctx.session.sessionId);
      }
      if (!ctx.session || ctx.session.via === 'cookie') {
        ctx.res.appendHeader('Set-Cookie', clearedSessionCookie({ secure: ctx.https }));
      }
      return { ok: true };
    },
    { auth: 'optional' },
  );

  router.get('/api/auth/me', (ctx) => ({ user: ctx.user }), { auth: 'user' });

  router.post(
    '/api/auth/password',
    async (ctx) => {
      await auth.changePassword(ctx.user.id, ctx.session.sessionId, ctx.body.currentPassword, ctx.body.newPassword);
      return { ok: true };
    },
    { auth: 'user' },
  );
}
