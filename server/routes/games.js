// Game endpoints for scorekeepers (claim/release/start/actions/end) and
// admins (create/edit/delete/cancel).

export function registerGameRoutes(router, { games }) {
  const view = (game) => games.serialize(game, { authenticated: true });

  // ---- scorekeeper (any signed-in user) ----

  router.post('/api/games/:id/claim', (ctx) => ({ game: view(games.claim(ctx.params.id, ctx.user, { force: ctx.body.force ?? false })) }), {
    auth: 'user',
  });

  router.post('/api/games/:id/release', (ctx) => ({ game: view(games.release(ctx.params.id, ctx.user)) }), { auth: 'user' });

  router.post(
    '/api/games/:id/start',
    (ctx) => {
      const { game, queued } = games.start(ctx.params.id, ctx.user);
      return { game: view(game), push: { queued } };
    },
    { auth: 'user' },
  );

  router.post(
    '/api/games/:id/actions',
    (ctx) => {
      const { game, duplicate } = games.action(ctx.params.id, ctx.user, ctx.body);
      return duplicate ? { game: view(game), duplicate: true } : { game: view(game) };
    },
    { auth: 'user' },
  );

  router.post('/api/games/:id/end', (ctx) => ({ game: view(games.end(ctx.params.id, ctx.user)) }), { auth: 'user' });

  // Score this game by hand ({ manual: true }) or let the scoreboard drive it again (§11).
  // The reply reads the game again: the feed may have switched it straight back
  // (a newer game holds its scoreboard).
  router.post(
    '/api/games/:id/scoreboard',
    (ctx) => {
      const game = games.setScoreboardManual(ctx.params.id, ctx.user, ctx.body.manual);
      return { game: view(games.getGame(game.id) ?? game) };
    },
    { auth: 'user' },
  );

  // ---- admin ----

  router.post('/api/games', (ctx) => ({ game: view(games.create(ctx.body, ctx.user)) }), { auth: 'admin' });

  router.patch('/api/games/:id', (ctx) => ({ game: view(games.update(ctx.params.id, ctx.body, ctx.user)) }), { auth: 'admin' });

  router.delete(
    '/api/games/:id',
    (ctx) => {
      games.remove(ctx.params.id, ctx.user);
      return { ok: true };
    },
    { auth: 'admin' },
  );

  router.post('/api/games/:id/cancel', (ctx) => ({ game: view(games.cancel(ctx.params.id, ctx.user)) }), { auth: 'admin' });
}
