// /api/users — admin user management.

import { notFound } from '../errors.js';
import { adminUserView } from '../users.js';

function userId(params) {
  if (!/^\d{1,15}$/.test(params.id)) throw notFound('User not found.');
  return Number(params.id);
}

export function registerUserRoutes(router, { users }) {
  router.get('/api/users', () => ({ users: users.list().map(adminUserView) }), { auth: 'admin' });

  router.post(
    '/api/users',
    async (ctx) => {
      const { username, displayName, password, role } = ctx.body;
      return { user: adminUserView(await users.create({ username, displayName, password, role })) };
    },
    { auth: 'admin' },
  );

  router.patch(
    '/api/users/:id',
    async (ctx) => {
      const { displayName, role, disabled, password } = ctx.body;
      const user = await users.update(
        userId(ctx.params),
        { displayName, role, disabled, password },
        { actor: ctx.user, currentSessionId: ctx.session.sessionId },
      );
      return { user: adminUserView(user) };
    },
    { auth: 'admin' },
  );

  router.delete(
    '/api/users/:id',
    (ctx) => {
      users.delete(userId(ctx.params), { actor: ctx.user });
      return { ok: true };
    },
    { auth: 'admin' },
  );
}
