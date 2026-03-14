/**
 * Authentication middleware.
 *
 * Calls userMode.authenticate() to resolve the current user from the request.
 * In single-user mode (AUTH_MODE=none), SingleUserMode always returns the
 * server process user, so all requests pass.
 * In multi-user mode, the JWT cookie is validated and 401 is returned if invalid.
 *
 * Sets `authUser` on the Hono context for downstream route handlers.
 */

import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { AUTH_COOKIE_NAME } from '../lib/auth-constants.js';
import type { AppBindings } from '../app-context.js';

export const authMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const { userMode } = c.get('appContext');

  const authUser = userMode.authenticate(() => getCookie(c, AUTH_COOKIE_NAME));

  if (!authUser) {
    return c.json({ error: 'Unauthorized', message: 'Authentication required' }, 401);
  }

  c.set('authUser', authUser);
  await next();
});
