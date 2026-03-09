/**
 * Authentication routes.
 *
 * These routes are mounted BEFORE the auth middleware in api.ts,
 * so they are accessible without authentication.
 *
 * - POST /api/auth/login  - Authenticate with OS credentials
 * - POST /api/auth/logout - Clear auth cookie
 * - GET  /api/auth/me     - Get current user (no 401, returns null if unauthenticated)
 */

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { LoginRequestSchema } from '@agent-console/shared';
import { vValidator } from '../middleware/validation.js';
import type { AppBindings } from '../app-context.js';

/** Cookie name for the auth token */
const AUTH_COOKIE_NAME = 'auth_token';

/** Cookie max-age in seconds (7 days, matches JWT expiry) */
const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

const auth = new Hono<AppBindings>()
  .post('/login', vValidator(LoginRequestSchema), async (c) => {
    const { userMode } = c.get('appContext');
    const { username, password } = c.req.valid('json');

    const result = await userMode.login(username, password);
    if (!result) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Set httpOnly cookie with the token
    setCookie(c, AUTH_COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: false, // Allow HTTP for local development
      sameSite: 'Lax',
      path: '/',
      maxAge: AUTH_COOKIE_MAX_AGE,
    });

    return c.json({ user: result.user });
  })
  .post('/logout', (c) => {
    deleteCookie(c, AUTH_COOKIE_NAME, { path: '/' });
    return c.json({ success: true });
  })
  .get('/me', (c) => {
    const { userMode } = c.get('appContext');

    // No 401 on failure - returns null if unauthenticated.
    // In single-user mode, always returns the server process user.
    const authUser = userMode.authenticate(() => getCookie(c, AUTH_COOKIE_NAME));

    return c.json({ user: authUser });
  });

export { auth };
