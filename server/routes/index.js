import { Router } from '../http.js';
import { registerAdminRoutes } from './admin.js';
import { registerAuthRoutes } from './auth.js';
import { registerGameRoutes } from './games.js';
import { registerPublicRoutes } from './public.js';
import { registerUserRoutes } from './users.js';

export function buildRouter(deps) {
  const router = new Router();
  registerAuthRoutes(router, deps);
  registerPublicRoutes(router, deps);
  registerGameRoutes(router, deps);
  registerUserRoutes(router, deps);
  registerAdminRoutes(router, deps);
  return router;
}
